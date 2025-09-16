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

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
