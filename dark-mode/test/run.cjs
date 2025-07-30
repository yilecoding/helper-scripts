/*
 * dark-mode 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node dark-mode/test/run.cjs
 *
 * 页面都用 page.route 挂在假域名下（https://example.com/...），不访问外网。
 * 用 https 假域名而不是 harness 的 127.0.0.1 静态服务：站点开关以 hostname 为键，
 * 想测的就是真实域名下的行为。拦截要写正则 —— glob 写法对跨源的子域名不好使。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'dark-mode.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://example.com'
const FILTER = 'invert(1) hue-rotate(180deg)'

const t = h.createRunner('dark-mode')

/** 新开一个页面（独立 context，GM 存储互不影响），把假域名的请求映射到 fixtures。 */
async function open(browser, file, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, timezoneId: 'Asia/Shanghai' })
    page.on('console', (m) => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(/^https:\/\/([\w-]+\.)*example\.com\//, (route) => {
        const url = new URL(route.request().url())
        const fp = path.join(FIXTURES, path.basename(url.pathname))
        if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    // 假时钟要在脚本之前装：init script 按注册顺序执行，后装的话脚本已经拿到了真的 setInterval
    if (opts.clock) await page.clock.install({ time: opts.clock })
    await h.install(page, SCRIPT, opts)
    if (opts.beforeGoto) await opts.beforeGoto(page)
    await page.goto((opts.site || SITE) + '/' + file)
    return page
}

/** 元素的计算 filter（选择器找不到时抛错，免得断言在 undefined 上「意外通过」）。 */
function filterOf(page, sel) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (!el) throw new Error('找不到元素 ' + sel)
        return getComputedStyle(el).filter
    }, sel)
}

/**
 * 视口里某个点最终画出来的颜色 [r, g, b]：截 1×1 的图，在页面里用离屏 canvas 解码。
 * 离屏 canvas 的像素不受页面 CSS filter 影响，不用另开页面。
 */
async function pixel(page, x, y) {
    const buf = await page.screenshot({ clip: { x, y, width: 1, height: 1 } })
    const rgba = await page.evaluate(async (src) => {
        const img = new Image()
        img.src = src
        await img.decode()
        const c = document.createElement('canvas')
        c.width = c.height = 1
        const g = c.getContext('2d')
        g.drawImage(img, 0, 0)
        return Array.from(g.getImageData(0, 0, 1, 1).data)
    }, 'data:image/png;base64,' + buf.toString('base64'))
    return rgba.slice(0, 3)
}

/** 存储里的值（harness 把 GM 存储放在页面 localStorage 的 __gm: 前缀下）。 */
function stored(page, key) {
    return page.evaluate((k) => {
        const raw = localStorage.getItem('__gm:' + k)
        return raw === null ? undefined : JSON.parse(raw)
    }, key)
}

/** 下一个 prompt 回答 answer（null = 点取消）。 */
function answerPrompt(page, answer) {
    page.once('dialog', (d) => (answer === null ? d.dismiss() : d.accept(answer)))
}

/** 等脚本量完页面背景（load 之后还会再量一次，所以等 load），返回它的判断。 */
async function detected(page) {
    await page.waitForLoadState('load')
    await page.waitForFunction(() => {
        const s = document.getElementById('dark-mode-userscript')
        return s && s.dataset.pageDark !== 'null'
    })
    return page.evaluate(() => document.getElementById('dark-mode-userscript').dataset.pageDark === 'true')
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)

    await t.test('开启后 <html> 的计算样式带反色 filter', async () => {
        const page = await open(browser, 'light.html')
        t.eq(await filterOf(page, 'html'), FILTER)
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('图片 / 视频 / 画布 / iframe / svg 里的位图被反转回来，svg 图标本身不反', async () => {
        const page = await open(browser, 'light.html')
        for (const sel of ['#photo', '#clip', '#board', '#frame', '#svgimg']) {
            t.eq(await filterOf(page, sel), FILTER, sel)
        }
        t.eq(await filterOf(page, '#icon'), 'none', 'svg 图标跟着文字一起反色')
        await page.close()
    })

    await t.test('document-start 注入：页面第一段脚本执行时（DOMContentLoaded 之前）filter 已生效', async () => {
        const page = await open(browser, 'light.html')
        await page.waitForFunction(() => window.__dclFilter !== undefined)
        t.eq(await page.evaluate(() => window.__earlyFilter), FILTER)
        t.eq(await page.evaluate(() => window.__dclFilter), FILTER)
        await page.close()
    })

    await t.test('实际画面：白底变黑、正文下方的空白区也是黑的（根背景显式设白）', async () => {
        const page = await open(browser, 'light.html')
        const top = await pixel(page, 700, 10)
        const below = await pixel(page, 400, 560)
        t.assert(top.every((v) => v < 30), `顶部应为黑色，实际 ${top}`)
        t.assert(below.every((v) => v < 30), `正文下方空白应为黑色，实际 ${below}`)
        await page.close()
    })

    await t.test('position: fixed 的元素滚动后仍贴着视口（filter 在 html 上不改变包含块）', async () => {
        const page = await open(browser, 'fixed.html')
        const rects = () => page.evaluate(() => ['#topbar', '#fab'].map((s) => {
            const r = document.querySelector(s).getBoundingClientRect()
            return [Math.round(r.top), Math.round(r.bottom)]
        }))
        const before = await rects()
        await page.evaluate(() => window.scrollTo(0, 1200))
        t.eq(await page.evaluate(() => window.scrollY), 1200)
        t.eq(await rects(), before)
        t.eq(before, [[0, 49], [540, 580]])
        await page.close()
    })

    await t.test('对照：同样的 filter 加在 body 上，固定栏会跟着页面滚走（上一条用例不是空测）', async () => {
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
        await page.goto('data:text/html,' + encodeURIComponent(fs.readFileSync(path.join(FIXTURES, 'fixed.html'), 'utf8')))
        await page.addStyleTag({ content: `body { filter: ${FILTER} }` })
        await page.evaluate(() => window.scrollTo(0, 1200))
        const top = await page.evaluate(() => document.querySelector('#topbar').getBoundingClientRect().top)
        t.eq(top, -1200)
        await page.close()
    })

    await t.test('亮度 / 对比度 / 棕褐色：读存储拼进整页 filter，媒体元素只做反色', async () => {
        const page = await open(browser, 'light.html', { values: { settings: { brightness: 85, contrast: 110, sepia: 20 } } })
        t.eq(await filterOf(page, 'html'), `${FILTER} brightness(0.85) contrast(1.1) sepia(0.2)`)
        t.eq(await filterOf(page, '#photo'), FILTER)
        await page.close()
    })

    await t.test('存储里的色调值越界 / 不是数字时夹回范围或用默认值', async () => {
        const page = await open(browser, 'light.html', { values: { settings: { brightness: 5, contrast: 'abc', sepia: 300 } } })
        t.eq(await filterOf(page, 'html'), `${FILTER} brightness(0.3) sepia(1)`)
        await page.close()
    })

    await t.test('亮色页面量完背景后仍然反转', async () => {
        const page = await open(browser, 'light.html')
        t.eq(await detected(page), false)
        t.eq(await filterOf(page, 'html'), FILTER)
        await page.close()
    })

    await t.test('暗色站点（body 铺深色）被识别，撤掉反转', async () => {
        const page = await open(browser, 'dark.html')
        t.eq(await detected(page), true)
        t.eq(await filterOf(page, 'html'), 'none')
        const bg = await pixel(page, 400, 300)
        t.eq(bg, [30, 30, 30], '画面就是页面自己的 #1e1e1e，没有被反成浅色')
        await page.close()
    })

    await t.test('暗色 SPA（body 透明，#app 铺深色）也能识别', async () => {
        const page = await open(browser, 'dark-app.html')
        t.eq(await detected(page), true)
        t.eq(await filterOf(page, 'html'), 'none')
        await page.close()
    })

    await t.test('声明 color-scheme: light dark 且不铺背景：系统暗色时不反，系统亮色时反', async () => {
        for (const [scheme, dark] of [['dark', true], ['light', false]]) {
            const p = await open(browser, 'scheme.html', { beforeGoto: (pg) => pg.emulateMedia({ colorScheme: scheme }) })
            t.eq(await detected(p), dark, '系统 ' + scheme)
            t.eq(await filterOf(p, 'html'), dark ? 'none' : FILTER, '系统 ' + scheme)
            await p.close()
        }
    })

    await t.test('声明 light dark 但自己铺白底：系统暗色时照样反转', async () => {
        const page = await open(browser, 'scheme-white.html', { beforeGoto: (pg) => pg.emulateMedia({ colorScheme: 'dark' }) })
        t.eq(await detected(page), false)
        t.eq(await filterOf(page, 'html'), FILTER)
        await page.close()
    })

    await t.test('CSS 只声明 color-scheme: dark：不论系统主题都不反', async () => {
        const page = await open(browser, 'scheme-dark-only.html', { beforeGoto: (pg) => pg.emulateMedia({ colorScheme: 'light' }) })
        t.eq(await detected(page), true)
        await page.close()
    })

    await t.test('带 background-image: url() 的元素（行内样式 / 样式表）反转回来，渐变和零尺寸的不动', async () => {
        const page = await open(browser, 'bg.html')
        await detected(page)
        t.eq(await filterOf(page, '#inline'), FILTER)
        t.eq(await filterOf(page, '#banner'), FILTER)
        t.eq(await filterOf(page, '#gradient'), 'none', '纯渐变跟着页面一起反')
        t.eq(await page.evaluate(() => document.getElementById('hidden').classList.contains('dm-revert-bg')), false, 'display:none 的不打标')
        await page.close()
    })

    await t.test('动态插入的背景图元素、后来才设上背景图的元素都会被处理（节流后）', async () => {
        const page = await open(browser, 'bg.html')
        await detected(page)
        await page.evaluate(() => {
            const wrap = document.createElement('section')
            wrap.innerHTML = '<div><div id="added" class="lazy-bg" style="width:50px;height:50px"></div></div>'
            document.getElementById('slot').appendChild(wrap)
            document.getElementById('later').style.backgroundImage = "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E')"
            document.getElementById('hidden').style.display = 'block'
            document.getElementById('hidden').style.height = '20px'
        })
        await page.waitForFunction(() => document.querySelectorAll('.dm-revert-bg').length >= 5, null, { timeout: 2000 })
        for (const sel of ['#added', '#later', '#hidden']) t.eq(await filterOf(page, sel), FILTER, sel)

        // 背景图被去掉后类名也撤掉
        await page.evaluate(() => { document.getElementById('later').style.backgroundImage = 'none' })
        await page.waitForFunction(() => !document.getElementById('later').classList.contains('dm-revert-bg'), null, { timeout: 2000 })
        t.eq(await filterOf(page, '#later'), 'none')
        await page.close()
    })

    await t.test('一直在变的页面也按节流间隔扫，不会被无限推迟；自己加类名不会触发死循环', async () => {
        const page = await open(browser, 'bg.html')
        await detected(page)
        const found = await page.evaluate(() => new Promise((resolve) => {
            const slot = document.getElementById('slot')
            const start = performance.now()
            const el = document.createElement('div')
            el.className = 'lazy-bg'
            el.style.cssText = 'width:10px;height:10px'
            slot.appendChild(el)
            // 每 50ms 改一次 DOM，防抖的话永远等不到
            const iv = setInterval(() => { slot.dataset.n = String(performance.now()); slot.appendChild(document.createTextNode('.')) }, 50)
            const poll = setInterval(() => {
                if (el.classList.contains('dm-revert-bg')) { clearInterval(iv); clearInterval(poll); resolve(performance.now() - start) }
                else if (performance.now() - start > 2000) { clearInterval(iv); clearInterval(poll); resolve(-1) }
            }, 20)
        }))
        t.assert(found > 0 && found < 600, `持续变化时也应在节流间隔内处理，实际 ${found}ms`)
        // 静下来以后不应再有扫描（用一个计数的 MutationObserver 看类名有没有被反复改）
        const churn = await page.evaluate(() => new Promise((resolve) => {
            let n = 0
            new MutationObserver((rs) => { n += rs.length }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] })
            setTimeout(() => resolve(n), 800)
        }))
        t.eq(churn, 0)
        await page.close()
    })

    await t.test('跟随系统：系统亮色时不开，emulateMedia 切到暗色立刻开，切回亮色立刻关', async () => {
        const page = await open(browser, 'light.html', {
            values: { settings: { mode: 'system' } },
            beforeGoto: (pg) => pg.emulateMedia({ colorScheme: 'light' }),
        })
        await detected(page)
        t.eq(await filterOf(page, 'html'), 'none')
        await page.emulateMedia({ colorScheme: 'dark' })
        await page.waitForFunction(() => getComputedStyle(document.documentElement).filter !== 'none', null, { timeout: 2000 })
        t.eq(await filterOf(page, 'html'), FILTER)
        t.eq(await filterOf(page, '#photo'), FILTER)
        await page.emulateMedia({ colorScheme: 'light' })
        await page.waitForFunction(() => getComputedStyle(document.documentElement).filter === 'none', null, { timeout: 2000 })
        await page.close()
    })

    await t.test('跟随系统、系统已是暗色：document-start 就开着（DOMContentLoaded 前）', async () => {
        const page = await open(browser, 'light.html', {
            values: { settings: { mode: 'system' } },
            beforeGoto: (pg) => pg.emulateMedia({ colorScheme: 'dark' }),
        })
        t.eq(await page.evaluate(() => window.__earlyFilter), FILTER)
        await page.close()
    })

    await t.test('站点强制关优先于全局「总是」', async () => {
        const page = await open(browser, 'light.html', { values: { 'site:example.com': 'off', settings: { mode: 'always' } } })
        t.eq(await page.evaluate(() => window.__earlyFilter), 'none', '一开始就没开，不会先黑一下')
        await detected(page)
        t.eq(await filterOf(page, 'html'), 'none')
        await page.close()
    })

    await t.test('站点设置按 hostname 区分：别的子域名不受影响', async () => {
        const page = await open(browser, 'light.html', { site: 'https://www.example.com', values: { 'site:example.com': 'off' } })
        await detected(page)
        t.eq(await filterOf(page, 'html'), FILTER)
        await page.close()
    })

    await t.test('站点强制开优先于全局（跟随系统 + 系统亮色），也压过「页面本来就暗」', async () => {
        const opts = {
            values: { 'site:example.com': 'on', settings: { mode: 'system' } },
            beforeGoto: (pg) => pg.emulateMedia({ colorScheme: 'light' }),
        }
        const page = await open(browser, 'light.html', opts)
        await detected(page)
        t.eq(await filterOf(page, 'html'), FILTER)
        await page.close()
        const dark = await open(browser, 'dark.html', opts)
        t.eq(await detected(dark), true)
        t.eq(await filterOf(dark, 'html'), FILTER)
        await dark.close()
    })

    await t.test('定时模式 19:00–07:00：晚上开、白天关、跨过 07:00 时自动关', async () => {
        const at = async (time) => {
            const page = await open(browser, 'light.html', {
                values: { settings: { mode: 'schedule', schedule: { from: '19:00', to: '07:00' } } },
                clock: new Date(`2026-10-29T${time}+08:00`),
            })
            await detected(page)
            return page
        }
        for (const [time, on] of [['20:00:00', true], ['02:30:00', true], ['12:00:00', false], ['19:00:00', true], ['07:00:00', false]]) {
            const page = await at(time)
            t.eq(await filterOf(page, 'html'), on ? FILTER : 'none', time)
            await page.close()
        }
        const page = await at('06:59:00')
        t.eq(await filterOf(page, 'html'), FILTER)
        await page.clock.runFor('01:30')
        t.eq(await filterOf(page, 'html'), 'none', '过了 07:00 之后最多一个检查周期就关')
        await page.close()
    })

    await t.test('存储里的模式 / 时间不合法时用默认值', async () => {
        const page = await open(browser, 'light.html', {
            values: { settings: { mode: 'weird', schedule: { from: '25:00', to: 'x' } }, 'site:example.com': 'maybe' },
        })
        await detected(page)
        t.eq(await filterOf(page, 'html'), FILTER, '默认 always')
        await page.close()
    })

    await t.test('菜单：文字带当前状态，状态变了跟着变', async () => {
        const page = await open(browser, 'light.html')
        await detected(page)
        t.eq((await h.gm(page)).menu, [
            '切换本站暗色（Alt+Shift+D）：现在开',
            '全局模式…（总是开）',
            '亮度 / 对比度 / 棕褐色…（100 / 100 / 0）',
        ])
        await h.menu(page, '切换本站暗色')
        t.eq(await filterOf(page, 'html'), 'none')
        t.eq((await h.gm(page)).menu, [
            '切换本站暗色（Alt+Shift+D）：现在关',
            '本站恢复跟随全局（现在强制关）',
            '全局模式…（总是开）',
            '亮度 / 对比度 / 棕褐色…（100 / 100 / 0）',
        ])
        await h.menu(page, '本站恢复跟随全局')
        t.eq(await filterOf(page, 'html'), FILTER)
        t.eq(await stored(page, 'site:example.com'), undefined)
        await page.close()
    })

    await t.test('Alt+Shift+D 切换本站并记住（刷新后保持）；再按一次回到跟随全局而不是强制开', async () => {
        const page = await open(browser, 'light.html')
        await detected(page)
        await page.keyboard.press('Alt+Shift+KeyD')
        t.eq(await filterOf(page, 'html'), 'none')
        t.eq(await stored(page, 'site:example.com'), 'off')
        await page.reload()
        t.eq(await page.evaluate(() => window.__earlyFilter), 'none', '刷新后一开始就是关的')
        await detected(page)
        await page.keyboard.press('Alt+Shift+KeyD')
        t.eq(await filterOf(page, 'html'), FILTER)
        t.eq(await stored(page, 'site:example.com'), undefined, '翻回来正好等于全局结果，存回 auto')
        // 只按 Alt+D / Shift+D 不触发
        await page.keyboard.press('Alt+KeyD')
        await page.keyboard.press('Shift+KeyD')
        t.eq(await filterOf(page, 'html'), FILTER)
        await page.close()
    })

    await t.test('暗色站点上按快捷键 = 强制开（反转它）', async () => {
        const page = await open(browser, 'dark.html')
        t.eq(await detected(page), true)
        await page.keyboard.press('Alt+Shift+KeyD')
        t.eq(await filterOf(page, 'html'), FILTER)
        t.eq(await stored(page, 'site:example.com'), 'on')
        await page.close()
    })

    await t.test('菜单「全局模式」：prompt 输入 2 切到跟随系统；输入 3 和时间段切到定时；取消不改', async () => {
        const page = await open(browser, 'light.html', { beforeGoto: (pg) => pg.emulateMedia({ colorScheme: 'light' }) })
        await detected(page)
        answerPrompt(page, '2')
        await h.menu(page, '全局模式')
        t.eq((await stored(page, 'settings')).mode, 'system')
        t.eq(await filterOf(page, 'html'), 'none', '系统是亮色，立刻关掉')
        answerPrompt(page, '3 20:30-6:15')
        await h.menu(page, '全局模式')
        const s = await stored(page, 'settings')
        t.eq([s.mode, s.schedule], ['schedule', { from: '20:30', to: '06:15' }], '时间补零存')
        t.assert((await h.gm(page)).menu.includes('全局模式…（定时 20:30-06:15）'))
        answerPrompt(page, null)
        await h.menu(page, '全局模式')
        t.eq((await stored(page, 'settings')).mode, 'schedule')
        await page.close()
    })

    await t.test('菜单「亮度 / 对比度 / 棕褐色」：prompt 改完立刻生效，越界值夹回范围', async () => {
        const page = await open(browser, 'light.html')
        await detected(page)
        answerPrompt(page, '80, 120 500')
        await h.menu(page, '亮度')
        t.eq(await filterOf(page, 'html'), `${FILTER} brightness(0.8) contrast(1.2) sepia(1)`)
        t.assert((await h.gm(page)).menu.includes('亮度 / 对比度 / 棕褐色…（80 / 120 / 100）'))
        await page.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
