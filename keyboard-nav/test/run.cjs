/*
 * keyboard-nav 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node keyboard-nav/test/run.cjs
 *
 * 页面都用 page.route 挂在假域名 https://example.com/ 下（其余请求一律 abort），不访问外网。
 * 路由用正则：harness 的注入对任何 URL 都生效，假域名只是为了让 hostname 像真实站点。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'keyboard-nav.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://example.com'
const STEP = 60

const t = h.createRunner('keyboard-nav')

/** 新开一个页面（独立 context，GM 存储互不影响），把假域名的请求映射到 fixtures。 */
async function open(browser, file, opts = {}) {
    const site = opts.site || SITE
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    page.on('console', (m) => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(/^https?:\/\//, (r) => r.abort())
    const re = new RegExp('^' + site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/')
    await page.route(re, (route) => {
        const url = new URL(route.request().url())
        const fp = path.join(FIXTURES, path.basename(url.pathname) || file)
        if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    await h.install(page, SCRIPT, opts)
    await page.goto(site + '/' + file)
    await page.waitForLoadState('load')
    return page
}

/** 等滚动停下来：连续几次采样位置不变。sel 为空时看 window。 */
async function waitScrollIdle(page, sel) {
    let last = null
    let same = 0
    for (let i = 0; i < 100 && same < 4; i++) {
        const pos = await scrollPos(page, sel)
        same = JSON.stringify(pos) === JSON.stringify(last) ? same + 1 : 0
        last = pos
        await page.waitForTimeout(50)
    }
    return last
}

function scrollPos(page, sel) {
    return page.evaluate((sel) => {
        if (!sel) return { x: window.scrollX, y: window.scrollY }
        const el = document.querySelector(sel)
        return { x: el.scrollLeft, y: el.scrollTop }
    }, sel)
}

async function press(page, keys) {
    for (const k of keys) await page.keyboard.press(k)
}

/** 当前显示的提示：[{ label, left, top }]（隐藏的不算）。 */
function hints(page) {
    return page.evaluate(() => {
        const host = document.getElementById('kbnav-hints')
        if (!host) return []
        return Array.from(host.shadowRoot.querySelectorAll('.hint:not(.hidden)')).map((n) => ({
            label: n.dataset.label,
            left: parseFloat(n.style.left),
            top: parseFloat(n.style.top),
        }))
    })
}

/** 每个匹配元素的提示标签（按位置对应：提示放在元素可见部分的左上角），没有提示的是 null。 */
async function hintsFor(page, sel) {
    const list = await hints(page)
    const boxes = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el) => {
        const r = el.getClientRects()[0]
        if (!r) return null
        return { left: Math.min(Math.max(r.left, 0), innerWidth - 40), top: Math.min(Math.max(r.top, 0), innerHeight - 20) }
    }), sel)
    return boxes.map((b) => {
        if (!b) return null
        const hit = list.find((x) => Math.abs(x.left - b.left) < 1 && Math.abs(x.top - b.top) < 1)
        return hit ? hit.label : null
    })
}

/** shadow DOM 里的元素：path 是一串选择器，每一级进入上一级的 shadowRoot。返回它的提示标签。 */
async function hintForPath(page, path) {
    const list = await hints(page)
    const b = await page.evaluate((path) => {
        let el = document.querySelector(path[0])
        for (const sel of path.slice(1)) el = el.shadowRoot.querySelector(sel)
        const r = el.getClientRects()[0]
        return { left: r.left, top: r.top }
    }, path)
    const hit = list.find((x) => Math.abs(x.left - b.left) < 1 && Math.abs(x.top - b.top) < 1)
    return hit ? hit.label : null
}

async function typeLabel(page, label) {
    for (const c of label) await page.keyboard.press(c)
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)
    console.log('keyboard-nav')

    await t.test('j 向下、k 向上滚动一步', async () => {
        const page = await open(browser, 'long.html')
        await press(page, ['j'])
        t.eq((await waitScrollIdle(page)).y, STEP)
        await press(page, ['j', 'j'])
        t.eq((await waitScrollIdle(page)).y, STEP * 3)
        await press(page, ['k'])
        t.eq((await waitScrollIdle(page)).y, STEP * 2)
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('焦点在输入框里按 j 不滚动，字照常输入', async () => {
        const page = await open(browser, 'long.html')
        await page.focus('#q')
        await press(page, ['j', 'k'])
        t.eq((await waitScrollIdle(page)).y, 0)
        t.eq(await page.inputValue('#q'), 'jk')
        await page.close()
    })

    await t.test('带 Alt / Ctrl 的组合键和没绑定的键不拦，页面照常收到', async () => {
        const page = await open(browser, 'long.html')
        await press(page, ['Alt+j', 'Control+k', 'x'])
        t.eq((await waitScrollIdle(page)).y, 0)
        const keys = (await page.evaluate(() => window.__pageKeys)).filter((k) => k.key.length === 1)
        t.eq(keys.map((k) => k.key), ['j', 'k', 'x'])
        t.assert(keys.every((k) => !k.prevented), '放行的键不该被 preventDefault')
        // 绑定了的键被脚本吃掉，页面收不到
        await press(page, ['j'])
        t.eq((await page.evaluate(() => window.__pageKeys)).filter((k) => k.key === 'j').length, 1)
        await page.close()
    })

    await t.test('d / u 按窗口高度滚半屏', async () => {
        const page = await open(browser, 'long.html')
        await press(page, ['d'])
        t.eq((await waitScrollIdle(page)).y, 350)
        await press(page, ['d', 'u'])
        t.eq((await waitScrollIdle(page)).y, 350)
        await page.close()
    })

    await t.test('body 不滚、内部 div 滚：j/k/d 滚的是视口中央那个最大的滚动容器', async () => {
        const page = await open(browser, 'inner.html')
        await press(page, ['j', 'j'])
        t.eq((await waitScrollIdle(page, '#main')).y, STEP * 2)
        t.eq((await scrollPos(page, '#side')).y, 0, '侧栏不动')
        t.eq((await scrollPos(page)).y, 0, 'window 不动')
        // 半屏按 #main 自己的高度算（700 - 50 顶栏）
        await press(page, ['d'])
        t.eq((await waitScrollIdle(page, '#main')).y, STEP * 2 + 325)
        await press(page, ['k'])
        t.eq((await waitScrollIdle(page, '#main')).y, STEP + 325)
        await page.close()
    })

    await t.test('h / l 横向滚动', async () => {
        const page = await open(browser, 'inner.html')
        await press(page, ['l', 'l'])
        t.eq((await waitScrollIdle(page, '#main')).x, STEP * 2)
        await press(page, ['h'])
        t.eq((await waitScrollIdle(page, '#main')).x, STEP)
        await page.close()
    })

    await t.test('点过侧栏之后 j 滚侧栏（和浏览器方向键一样跟着最近点击的区域）', async () => {
        const page = await open(browser, 'inner.html')
        await page.click('#side .item:nth-child(3)')
        await press(page, ['j'])
        t.eq((await waitScrollIdle(page, '#side')).y, STEP)
        t.eq((await scrollPos(page, '#main')).y, 0)
        // 侧栏滚到底以后不卡住，回落到视口中央的主区域
        await page.evaluate(() => { const s = document.getElementById('side'); s.scrollTop = s.scrollHeight })
        await press(page, ['j'])
        t.eq((await waitScrollIdle(page, '#main')).y, STEP, '侧栏到底后 j 交给主区域')
        await page.close()
    })

    await t.test('gg 到顶、G 到底（整页和内部 div 都对）', async () => {
        const page = await open(browser, 'long.html')
        await press(page, ['Shift+G'])
        const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)
        t.eq((await waitScrollIdle(page)).y, max)
        await press(page, ['g', 'g'])
        t.eq((await waitScrollIdle(page)).y, 0)
        await page.close()

        const inner = await open(browser, 'inner.html')
        await press(inner, ['Shift+G'])
        const imax = await inner.evaluate(() => { const m = document.getElementById('main'); return m.scrollHeight - m.clientHeight })
        t.eq((await waitScrollIdle(inner, '#main')).y, imax)
        await press(inner, ['g', 'g'])
        t.eq((await waitScrollIdle(inner, '#main')).y, 0)
        await inner.close()
    })

    await t.test('数字前缀：5j 滚五步、12j 两位数、2d 滚一屏；数字本身照常传给页面', async () => {
        const page = await open(browser, 'long.html')
        await press(page, ['5', 'j'])
        t.eq((await waitScrollIdle(page)).y, STEP * 5)
        await press(page, ['1', '2', 'j'])
        t.eq((await waitScrollIdle(page)).y, STEP * 17)
        await press(page, ['2', 'k'])
        t.eq((await waitScrollIdle(page)).y, STEP * 15)
        await press(page, ['g', 'g', '2', 'd'])
        t.eq((await waitScrollIdle(page)).y, 700)
        const digits = (await page.evaluate(() => window.__pageKeys)).filter((k) => /\d/.test(k.key))
        t.eq(digits.map((k) => k.key).join(''), '51222')
        t.assert(digits.every((k) => !k.prevented))
        await page.close()
    })

    await t.test('序列断了按单键处理（g 后按 j 照样滚），超时后前缀作废', async () => {
        const page = await open(browser, 'long.html')
        await press(page, ['g', 'j'])
        t.eq((await waitScrollIdle(page)).y, STEP)
        await press(page, ['Shift+G', 'g'])
        await page.waitForTimeout(1700)
        await press(page, ['g'])
        const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)
        t.eq((await waitScrollIdle(page)).y, max, '两次 g 隔了超时，不算 gg')
        await page.close()
    })

    await t.test('吃掉的键 keyup 也不给页面，放行的键 keyup 照常', async () => {
        const page = await open(browser, 'long.html')
        await press(page, ['j', 'x', 'g', 'g'])
        t.eq(await page.evaluate(() => window.__pageKeyups), ['x'])
        await page.close()
    })

    await t.test('平滑滚动：快速连按不丢距离（原生 smooth 会丢），中途每帧都在动', async () => {
        const page = await open(browser, 'long.html')
        const frames = await page.evaluate(() => new Promise((resolve) => {
            const ys = []
            const tick = () => { ys.push(scrollY); if (ys.length < 40) requestAnimationFrame(tick); else resolve(ys) }
            requestAnimationFrame(tick)
            for (let i = 0; i < 3; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', bubbles: true }))
        }))
        t.eq((await waitScrollIdle(page)).y, STEP * 3)
        t.assert(frames.some((y) => y > 0 && y < STEP * 3), '应该有中间位置（是平滑滚动不是瞬移）: ' + frames.join(','))
        await page.close()
    })

    await t.test('长按 j（自动重复的 keydown）连续匀速滚动：单调、不停顿、松手后停在累计位置', async () => {
        const page = await open(browser, 'long.html')
        // 页面自己开了 scroll-behavior: smooth，动画每帧的瞬时设置不能被它变成又一层平滑
        await page.addStyleTag({ content: 'html { scroll-behavior: smooth }' })
        const ys = await page.evaluate(() => new Promise((resolve) => {
            const ys = []
            const send = (repeat) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', repeat, bubbles: true }))
            send(false)
            let n = 0
            const iv = setInterval(() => {
                send(true)
                if (++n === 20) clearInterval(iv)
            }, 33)
            const tick = () => { ys.push(scrollY); if (ys.length < 60) requestAnimationFrame(tick); else resolve(ys) }
            requestAnimationFrame(tick)
        }))
        for (let i = 1; i < ys.length; i++) t.assert(ys[i] >= ys[i - 1], '滚动位置应单调不减: ' + ys.join(','))
        // 第一次动起来之后、到达终点之前，不应该有停住不动的帧
        const start = ys.findIndex((y) => y > 0)
        const end = ys.indexOf(STEP * 21)
        const stopEnd = end === -1 ? ys.length : end
        const stalls = ys.slice(start, stopEnd).filter((y, i, a) => i > 0 && y === a[i - 1]).length
        t.assert(stalls <= 1, `滚动途中停顿了 ${stalls} 帧: ` + ys.join(','))
        t.eq((await waitScrollIdle(page)).y, STEP * 21)
        await page.close()
    })

    await t.test('长按 g / gg 这类非滚动键：重复的 keydown 不触发命令', async () => {
        const page = await open(browser, 'long.html')
        await page.evaluate(() => scrollTo(0, 600))
        await page.evaluate(() => {
            const send = (repeat) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', repeat, bubbles: true }))
            send(false)
            send(true)
            send(true)
        })
        t.eq((await waitScrollIdle(page)).y, 600, '长按 g 不该被当成 gg')
        await page.close()
    })

    await t.test('f：可见可点的元素都有提示，标签互不为前缀且尽量短', async () => {
        const page = await open(browser, 'hints.html')
        await press(page, ['f'])
        const list = await hints(page)
        const visible = await hintsFor(page, '.v')
        t.assert(visible.every(Boolean), '每个 .v 都该有提示: ' + JSON.stringify(visible))
        t.eq(list.length, visible.length, '提示数量 = 可见可点元素数量')
        const labels = list.map((x) => x.label)
        t.eq(new Set(labels).size, labels.length, '标签不重复')
        for (const a of labels) for (const b of labels) {
            if (a !== b) t.assert(!b.startsWith(a), `标签 ${a} 是 ${b} 的前缀`)
        }
        // 30 个元素、14 个字母：单字母用不完时才出双字母
        t.eq(labels.filter((l) => l.length === 1).length, 12)
        t.assert(labels.every((l) => l.length <= 2))
        await page.close()
    })

    // 嵌套同一块的里层（#outer 里的 <a>）和外层位置相同，没法按位置区分；上一条的「数量相等」已经证明它被去重了
    await t.test('被遮挡 / 被裁掉 / 不可见 / 视口外 / 禁用 / tabindex=-1：都不出提示', async () => {
        const page = await open(browser, 'hints.html')
        await press(page, ['f'])
        const hidden = await hintsFor(page, '.x')
        t.eq(hidden, hidden.map(() => null))
        // 有可见控件的 <label for> 不重复出提示
        t.eq(await hintsFor(page, 'label[for=name2]'), [null])
        await page.close()
    })

    await t.test('输入标签触发真实点击序列；提示随即消失', async () => {
        const page = await open(browser, 'hints.html')
        await press(page, ['f'])
        const [label] = await hintsFor(page, '#btn')
        await typeLabel(page, label)
        t.eq(await page.evaluate(() => window.__events), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
        t.eq(await hints(page), [])
        t.eq(await page.evaluate(() => document.activeElement.id), 'btn', '真实点击会让按钮获得焦点')
        await page.close()
    })

    await t.test('输入框：聚焦而不是点击，之后按 j 是打字', async () => {
        const page = await open(browser, 'hints.html')
        await press(page, ['f'])
        const [label] = await hintsFor(page, '#name')
        await typeLabel(page, label)
        t.eq(await page.evaluate(() => document.activeElement.id), 'name')
        await press(page, ['j'])
        t.eq(await page.inputValue('#name'), 'j')
        await page.close()
    })

    await t.test('链接：点击后导航；label 包着隐藏的复选框：点 label 切换复选框', async () => {
        const page = await open(browser, 'hints.html')
        await press(page, ['f'])
        const [cb] = await hintsFor(page, '#cblabel')
        await typeLabel(page, cb)
        t.eq(await page.evaluate(() => document.getElementById('cb').checked), true)
        await press(page, ['f'])
        const [link] = await hintsFor(page, '#links a:nth-child(3)')
        await Promise.all([page.waitForURL(/page2\.html\?n=3$/), typeLabel(page, link)])
        t.eq(await page.title(), '第二页')
        await page.close()
    })

    await t.test('输入过滤、Backspace 撤回、按错的字母忽略、Esc 退出', async () => {
        const page = await open(browser, 'hints.html')
        await press(page, ['f'])
        const all = await hints(page)
        await press(page, ['s'])
        const filtered = await hints(page)
        t.assert(filtered.length > 1 && filtered.length < all.length, '输入 s 后只剩 s 开头的')
        t.assert(filtered.every((x) => x.label.startsWith('s')))
        await press(page, ['z'])   // 不在字母表里
        t.eq((await hints(page)).length, filtered.length)
        await press(page, ['Backspace'])
        t.eq((await hints(page)).length, all.length)
        await press(page, ['Escape'])
        t.eq(await hints(page), [])
        t.eq(await page.evaluate(() => window.__events), [], '退出不点任何东西')
        // 退出后 j 恢复滚动
        await press(page, ['j'])
        t.eq((await waitScrollIdle(page)).y, STEP)
        await page.close()
    })

    await t.test('open shadow DOM（含嵌套两层）里的按钮能提示到、能点；closed shadow root 拿不到', async () => {
        const page = await open(browser, 'shadow.html')
        await press(page, ['f'])
        // plain、js、sbtn、slink、deep —— 5 个；closed 里的按钮不在其中
        t.eq((await hints(page)).length, 5)
        const sbtn = await hintForPath(page, ['#bar', '#sbtn'])
        const deep = await hintForPath(page, ['#bar', '#nested', '#deep'])
        t.assert(sbtn && deep, `shadow 按钮应有提示: ${sbtn} ${deep}`)
        await typeLabel(page, sbtn)
        await press(page, ['f'])
        await typeLabel(page, deep)
        t.eq(await page.evaluate(() => window.__events), ['sbtn', 'deep'])
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('F：只提示能打开的链接（含 shadow 里的），GM_openInTab 后台打开，当前页不动', async () => {
        const page = await open(browser, 'shadow.html')
        await press(page, ['Shift+F'])
        const list = await hints(page)
        t.eq(list.length, 2, '普通链接 + shadow 链接；javascript: 链接和按钮不算')
        const slink = await hintForPath(page, ['#bar', '#slink'])
        await typeLabel(page, slink)
        const gm = await h.gm(page)
        t.eq(gm.opened.map((o) => o.url), [SITE + '/page2.html?shadow'])
        t.eq(gm.opened[0].options.active, false)
        t.eq(page.url(), SITE + '/shadow.html')
        t.eq(await hints(page), [])
        await page.close()
    })

    await t.test('gi 聚焦第一个能打字的输入框（跳过隐藏/禁用/只读/复选框/下拉），光标在末尾；2gi、3gi 依次往后', async () => {
        const page = await open(browser, 'inputs.html')
        await press(page, ['g', 'i'])
        t.eq(await page.evaluate(() => document.activeElement.id), 'a')
        t.eq(await page.evaluate(() => document.activeElement.selectionStart), 4)
        await page.evaluate(() => document.activeElement.blur())
        await press(page, ['2', 'g', 'i'])
        t.eq(await page.evaluate(() => document.activeElement.id), 'b')
        await page.evaluate(() => document.activeElement.blur())
        await press(page, ['9', 'g', 'i'])
        t.eq(await page.evaluate(() => document.activeElement.id), 'c', '超出个数取最后一个')
        await page.close()
    })

    await t.test('yy 复制当前网址（GM_setClipboard），右下角提示', async () => {
        const page = await open(browser, 'long.html')
        await press(page, ['y', 'y'])
        t.eq((await h.gm(page)).clipboard, { text: SITE + '/long.html', type: 'text' })
        const toast = await page.evaluate(() => document.getElementById('kbnav-toast').shadowRoot.querySelector('.toast').textContent)
        t.assert(toast.includes('已复制'), toast)
        await page.close()
    })

    await t.test('H 后退、L 前进、r 刷新', async () => {
        const page = await open(browser, 'long.html')
        await page.goto(SITE + '/page2.html')
        await page.waitForLoadState('load')
        await Promise.all([page.waitForURL(SITE + '/long.html'), press(page, ['Shift+H'])])
        await page.waitForLoadState('load')
        await Promise.all([page.waitForURL(SITE + '/page2.html'), press(page, ['Shift+L'])])
        await page.waitForLoadState('load')
        await page.evaluate(() => { window.__marker = 1 })
        await Promise.all([page.waitForEvent('load'), press(page, ['r'])])
        t.eq(await page.evaluate(() => window.__marker), undefined, '刷新后页面上的变量没了')
        await page.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
