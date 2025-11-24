/*
 * scroll-memory 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node scroll-memory/test/run.cjs
 *
 * 页面都用 page.route 挂在假域名下（https://novel.example.com/...），不访问外网。
 * 路由用正则匹配：glob 的 `**` 对带 query 的 URL 不可靠，而这里正要测 ?page= 这类参数。
 * GM 存储在 harness 里按源隔离（localStorage），真实环境是脚本全局共享；
 * 同一个 page 里刷新 / 再 goto 同源 URL 能读回，够测「回来恢复」。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'scroll-memory.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://novel.example.com'
const SITE_RE = /^https:\/\/novel\.example\.com\//

const t = h.createRunner('scroll-memory')

/** 恢复方式设成「直接跳」，测定位本身时不用点提示条。 */
const JUMP = { values: { 'sm:settings': { mode: 'jump' } } }

/**
 * 新开一个页面（独立 context，GM 存储互不影响），把假域名的请求映射到 fixtures。
 * 路径是 *.html 就取同名文件；其余（SPA 深链接）回落到 opts.fallback。
 */
async function open(browser, url, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.__logs = []
    page.on('console', (m) => {
        page.__logs.push(m.text())
        if (m.type() === 'error') console.log('      [page error]', m.text())
    })
    await page.route(SITE_RE, (route) => {
        const u = new URL(route.request().url())
        const name = u.pathname.endsWith('.html') ? path.basename(u.pathname) : opts.fallback
        const fp = name && path.join(FIXTURES, name)
        if (!fp || !fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    await h.install(page, SCRIPT, opts)
    if (url) await page.goto(SITE + url)
    return page
}

/** GM 存储里的阅读记录 { pageKey: Record }。 */
function records(page) {
    return page.evaluate(() => {
        const out = {}
        for (const k of Object.keys(localStorage)) {
            if (k.startsWith('__gm:sm:p:')) out[k.slice('__gm:sm:p:'.length)] = JSON.parse(localStorage.getItem(k))
        }
        return out
    })
}

/** window 瞬间滚到 y，等防抖记录落盘。 */
async function scrollWin(page, y, wait = 800) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), y)
    if (wait) await page.waitForTimeout(wait)
}

/** 「第 n 段」相对视口（或其滚动容器可视区）的 top。 */
function paraTop(page, n) {
    return page.evaluate((n) => {
        const el = Array.from(document.querySelectorAll('p')).find((p) => p.textContent.startsWith('第 ' + n + ' 段。'))
        if (!el) return null // 异步渲染的页面：还没画出来
        const sc = el.closest('.scroll')
        return el.getBoundingClientRect().top - (sc ? sc.getBoundingClientRect().top : 0)
    }, n)
}

/** 把「第 n 段」滚到距视口上沿 offset 像素处（window 或 .scroll 容器），等记录落盘。 */
async function scrollParaTo(page, n, offset, wait = 800) {
    await page.evaluate(({ n, offset }) => {
        const el = Array.from(document.querySelectorAll('p')).find((p) => p.textContent.startsWith('第 ' + n + ' 段。'))
        const sc = el.closest('.scroll')
        const top = el.getBoundingClientRect().top - (sc ? sc.getBoundingClientRect().top : 0)
        if (sc) sc.scrollTo({ top: sc.scrollTop + top - offset, behavior: 'instant' })
        else window.scrollTo({ top: window.scrollY + top - offset, behavior: 'instant' })
    }, { n, offset })
    if (wait) await page.waitForTimeout(wait)
}

/** 轮询直到「第 n 段」停在 offset 处（±tol），超时报出实际位置。 */
async function waitParaAt(page, n, offset, { timeout = 7000, tol = 2 } = {}) {
    const end = Date.now() + timeout
    let top
    while (Date.now() < end) {
        top = await paraTop(page, n)
        if (top !== null && Math.abs(top - offset) <= tol) return
        await page.waitForTimeout(100)
    }
    throw new Error(`第 ${n} 段应在 ${offset}，实际 ${top}`)
}

/** 提示条：{ shown, text }。 */
function promptState(page) {
    return page.evaluate(() => {
        const host = document.querySelector('scroll-memory-ui')
        const box = host && host.shadowRoot.querySelector('.prompt')
        return { shown: !!box && !box.hidden, text: box ? box.querySelector('.jump').textContent : '' }
    })
}

/** 回到顶部 / 底部按钮：{ shown, pct }（还没建 DOM 时 shown=false）。 */
function fabState(page) {
    return page.evaluate(() => {
        const host = document.querySelector('scroll-memory-ui')
        const fab = host && host.shadowRoot.querySelector('.fab')
        if (!fab) return { shown: false, pct: null }
        return { shown: fab.classList.contains('show') && getComputedStyle(fab).pointerEvents !== 'none', pct: fab.querySelector('.pct').textContent }
    })
}

/** 等某个容器（默认 window）的 scrollTop 满足条件。 */
async function waitScroll(page, pred, sel = null, timeout = 4000) {
    await page.waitForFunction(({ pred, sel }) => {
        const y = sel ? document.querySelector(sel).scrollTop : window.scrollY
        const max = sel ? document.querySelector(sel).scrollHeight - document.querySelector(sel).clientHeight
            : document.documentElement.scrollHeight - innerHeight
        return new Function('y', 'max', 'return ' + pred)(y, max)
    }, { pred, sel }, { timeout })
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)

    await t.test('滚动停止后记录位置：进度、像素、时间', async () => {
        const page = await open(browser, '/long.html')
        await scrollWin(page, 3000)
        const recs = await records(page)
        const rec = recs[SITE + '/long.html']
        t.assert(rec, '应该有本页的记录，实际：' + JSON.stringify(Object.keys(recs)))
        t.eq(rec.y, 3000)
        t.assert(rec.p > 0.1 && rec.p < 0.9, `进度 ${rec.p}`)
        t.assert(Date.now() - rec.t < 5000, '时间戳是刚才')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('不记录：页面不到两屏；滚动没超过一屏', async () => {
        const page = await open(browser, '/short.html')
        await scrollWin(page, 600)
        t.eq(await records(page), {}, '短页面不记录')
        await page.goto(SITE + '/long.html')
        await scrollWin(page, 500)
        t.eq(await records(page), {}, '只滚了不到一屏')
        await page.close()
    })

    await t.test('页面键：白名单 query 参与（?page=），跟踪参数不参与（utm_*），参数顺序无关', async () => {
        const page = await open(browser, '/long.html?page=2&utm_source=feed&from=timeline')
        await scrollWin(page, 2000)
        await page.goto(SITE + '/long.html?utm_medium=x&page=3&id=9')
        await scrollWin(page, 2500)
        await page.goto(SITE + '/long.html?id=9&page=3&spm=a.b.c')
        await scrollWin(page, 2600)
        t.eq(Object.keys(await records(page)).sort(), [
            SITE + '/long.html?id=9&page=3',
            SITE + '/long.html?page=2',
        ])
        await page.close()
    })

    await t.test('锚点：视口顶部的段落 —— 路径能找回同一个元素，指纹是开头文字，偏移是视口上沿在段落里的位置', async () => {
        const page = await open(browser, '/long.html')
        await scrollParaTo(page, 30, -20)
        const rec = (await records(page))[SITE + '/long.html']
        t.assert(rec && rec.a, '应有锚点：' + JSON.stringify(rec))
        t.eq(rec.a.tag, 'p')
        t.assert(rec.a.fp.startsWith('第 30 段。'), 'fp: ' + rec.a.fp)
        t.eq(rec.a.off, 20)
        t.assert(rec.a.path.startsWith('#post > '), '路径从最近的稳定 id 起算：' + rec.a.path)
        const found = await page.evaluate((p) => document.querySelector(p).textContent.slice(0, 7), rec.a.path)
        t.eq(found, '第 30 段。')
        await page.close()
    })

    await t.test('锚点：跳过固定顶栏，取它下面露出来的第一段', async () => {
        const page = await open(browser, '/fixed-header.html')
        await scrollParaTo(page, 30, 100)
        const rec = (await records(page))[SITE + '/fixed-header.html']
        t.assert(rec.a.fp.startsWith('第 30 段。'), 'fp: ' + rec.a.fp)
        t.eq(rec.a.off, -100)
        await page.close()
    })

    await t.test('恢复：再次打开，等晚到的广告和公告插进来后，按锚点回到同一段（像素和路径都漂了）', async () => {
        const page = await open(browser, '/long.html', JUMP)
        await scrollParaTo(page, 30, -20)
        const before = (await records(page))[SITE + '/long.html']
        await page.goto(SITE + '/long.html?drift=700')
        await waitParaAt(page, 30, -20)
        const y = await page.evaluate(() => window.scrollY)
        t.assert(y - before.y > 700, `像素位置应随插入内容下移：之前 ${before.y}，现在 ${y}`)
        await page.close()
    })

    await t.test('恢复：刷新时浏览器先按像素还原，内容漂移后脚本按锚点纠正', async () => {
        const page = await open(browser, '/long.html?drift=700', JUMP)
        await page.waitForTimeout(500)
        await scrollParaTo(page, 45, -35)
        await page.reload()
        await waitParaAt(page, 45, -35)
        await page.close()
    })

    await t.test('恢复：字号变大，偏移按段落高度等比换算', async () => {
        const page = await open(browser, '/long.html', JUMP)
        await scrollParaTo(page, 30, -40)
        const h0 = await page.evaluate(() => Array.from(document.querySelectorAll('p')).find((p) => p.textContent.startsWith('第 30 段。')).offsetHeight)
        await page.goto(SITE + '/long.html?font=27')
        const h1 = await page.evaluate(() => Array.from(document.querySelectorAll('p')).find((p) => p.textContent.startsWith('第 30 段。')).offsetHeight)
        await waitParaAt(page, 30, -Math.round(40 * h1 / h0), { tol: 3 })
        await page.close()
    })

    await t.test('恢复：改版后锚点全对不上，按进度百分比兜底', async () => {
        const page = await open(browser, '/long.html', JUMP)
        await scrollWin(page, 4000)
        const rec = (await records(page))[SITE + '/long.html']
        await page.goto(SITE + '/long.html?rewrite=1')
        await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 7000 })
        const p = await page.evaluate(() => window.scrollY / (document.documentElement.scrollHeight - innerHeight))
        t.assert(Math.abs(p - rec.p) < 0.002, `进度 ${p} 应接近 ${rec.p}`)
        await page.close()
    })

    await t.test('提示：默认不直接跳，浮出「跳回上次位置（xx%）· 取消」，点了才跳', async () => {
        const page = await open(browser, '/long.html')
        await scrollParaTo(page, 40, -10)
        const rec = (await records(page))[SITE + '/long.html']
        await page.goto(SITE + '/long.html?drift=500')
        await page.waitForFunction(() => {
            const host = document.querySelector('scroll-memory-ui')
            return host && !host.shadowRoot.querySelector('.prompt').hidden
        }, null, { timeout: 7000 })
        t.eq((await promptState(page)).text, '跳回上次位置（' + Math.round(rec.p * 100) + '%）')
        t.eq(await page.evaluate(() => window.scrollY), 0, '点之前不动')
        await page.locator('scroll-memory-ui .jump').click()
        await waitParaAt(page, 40, -10)
        t.eq((await promptState(page)).shown, false, '点完收起')
        await page.close()
    })

    await t.test('提示：点「取消」收起，不跳', async () => {
        const page = await open(browser, '/long.html')
        await scrollParaTo(page, 40, -10)
        await page.goto(SITE + '/long.html')
        await page.locator('scroll-memory-ui .cancel').click({ timeout: 7000 })
        t.eq((await promptState(page)).shown, false)
        await page.waitForTimeout(300)
        t.eq(await page.evaluate(() => window.scrollY), 0)
        await page.close()
    })

    await t.test('用户在恢复前已经主动滚动：不提示、不跳', async () => {
        for (const opts of [{}, JUMP]) {
            const page = await open(browser, '/long.html', opts)
            await scrollParaTo(page, 40, -10)
            // 广告 1.5 秒后才到，等待期拉长；这期间用户滚了一下滚轮
            await page.goto(SITE + '/long.html?drift=500&delay=1500')
            await page.mouse.move(600, 400)
            await page.mouse.wheel(0, 300)
            await page.waitForTimeout(2800)
            // 广告插在上方时 Chrome 的 scroll anchoring 会把 scrollY 加上去，所以看内容：没被拉到第 40 段
            const top = await paraTop(page, 40)
            t.assert(top > 2000, `没被拉回上次位置：第 40 段在 ${top}`)
            t.assert(await page.evaluate(() => window.scrollY) > 0, '用户滚过')
            t.eq((await promptState(page)).shown, false)
            await page.close()
        }
    })

    await t.test('带 #锚点 打开：用户要看那一节，不恢复', async () => {
        const page = await open(browser, '/long.html', JUMP)
        await scrollParaTo(page, 40, -10)
        await page.goto(SITE + '/long.html#ch2')
        await page.waitForTimeout(1200)
        t.eq(Math.round(await page.evaluate(() => document.getElementById('ch2').getBoundingClientRect().top)), 0)
        t.eq((await promptState(page)).shown, false)
        await page.close()
    })

    await t.test('前进 / 后退：交给浏览器，脚本不提示', async () => {
        const page = await open(browser, '/long.html')
        await scrollParaTo(page, 40, -10)
        await page.goto(SITE + '/short.html')
        page.__logs.length = 0
        await page.goBack()
        await page.waitForTimeout(1500)
        t.eq((await promptState(page)).shown, false)
        // Playwright 的 Chromium 没命中 bfcache，脚本重跑了一遍，导航类型是 back_forward
        t.assert(page.__logs.some((l) => l.includes('不恢复：前进/后退')), '应走「交给浏览器」分支：' + page.__logs.join(' | '))
        // 浏览器自己按像素还原（bfcache 或 scrollRestoration=auto）
        await waitParaAt(page, 40, -10, { timeout: 1000 })
        await page.close()
    })

    await t.test('内层 div 滚动：记录容器路径，回来时等正文异步渲染完、广告插进来后恢复到同一段', async () => {
        const page = await open(browser, '/inner.html', JUMP)
        await page.waitForTimeout(400)
        // 侧栏先滚一下：它也能滚，但太窄，不是正文
        await page.evaluate(() => document.querySelector('.side').scrollTo({ top: 600, behavior: 'instant' }))
        await page.waitForTimeout(800)
        t.eq(await records(page), {}, '侧栏滚动不记录')
        await scrollParaTo(page, 35, -25)
        const rec = (await records(page))[SITE + '/inner.html']
        t.assert(rec && rec.c, '应记下内层容器：' + JSON.stringify(rec))
        t.eq(await page.evaluate((c) => document.body.querySelector(c).className, rec.c), 'scroll')
        t.assert(rec.a.fp.startsWith('第 35 段。'), 'fp: ' + rec.a.fp)
        t.eq(await page.evaluate(() => window.scrollY), 0, 'window 不滚')

        await page.goto(SITE + '/inner.html?drift=600')
        await waitParaAt(page, 35, -25)
        t.assert(await page.evaluate(() => document.querySelector('.scroll').scrollTop) > rec.y + 600, '容器的像素位置跟着下移')
        await page.close()
    })

    await t.test('内层 div 滚动：提示条模式下点「跳回」滚的也是容器', async () => {
        const page = await open(browser, '/inner.html')
        await page.waitForTimeout(400)
        await scrollParaTo(page, 50, 0)
        await page.goto(SITE + '/inner.html')
        await page.locator('scroll-memory-ui .jump').click({ timeout: 7000 })
        await waitParaAt(page, 50, 0)
        await page.close()
    })

    /** SPA：点导航链接（pushState），等新页渲染出来。 */
    async function spaGo(page, text) {
        await page.locator('nav a', { hasText: text }).click()
        await page.waitForFunction((t) => {
            const h1 = document.querySelector('#app h1')
            return h1 && h1.textContent === t.toUpperCase() + ' 篇'
        }, text.replace(/ 篇$/, '').replace(' ', '-'))
    }

    /** 当前视口里「第 n 段」属于哪一篇。 */
    function paraArticle(page, n) {
        return page.evaluate((n) => {
            const el = Array.from(document.querySelectorAll('p')).find((p) => p.textContent.startsWith('第 ' + n + ' 段。'))
            return el && el.textContent.split('：')[0]
        }, n)
    }

    await t.test('SPA：pushState 换页时存旧页（防抖还没到也存，且存的是换页前的锚点），回到旧页时恢复', async () => {
        const page = await open(browser, '/spa/a', { ...JUMP, fallback: 'spa.html' })
        await page.waitForSelector('#app p')
        await scrollParaTo(page, 30, -10, 250) // 还在 600ms 防抖里
        await spaGo(page, 'B 篇')
        let recs = await records(page)
        const a = recs[SITE + '/spa/a']
        t.assert(a && a.a && a.a.fp.includes('A 篇'), '旧页 A 的锚点应在换页前拍好：' + JSON.stringify(a && a.a))
        t.eq(await page.evaluate(() => window.scrollY), 0, '新页从顶部开始（没有 B 的记录）')

        await scrollParaTo(page, 20, -10)
        await spaGo(page, 'A 篇')
        await waitParaAt(page, 30, -10)
        t.eq(await paraArticle(page, 30), '第 30 段。A 篇')
        recs = await records(page)
        t.assert(recs[SITE + '/spa/b'], 'B 也记下了')

        // 带跟踪参数的链接：页面键里没有 utm
        await spaGo(page, 'C 篇')
        await scrollParaTo(page, 25, 0)
        t.assert((await records(page))[SITE + '/spa/c'], '页面键不带 utm：' + Object.keys(await records(page)))
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('SPA：popstate（后退）交给浏览器 / 路由，不恢复', async () => {
        const page = await open(browser, '/spa/a', { ...JUMP, fallback: 'spa.html' })
        await page.waitForSelector('#app p')
        await scrollParaTo(page, 30, -10)
        await spaGo(page, 'B 篇')
        await scrollParaTo(page, 20, -10)
        page.__logs.length = 0
        await page.goBack()
        await page.waitForTimeout(1200)
        t.assert(page.__logs.some((l) => l.includes('不恢复：SPA 前进/后退')), page.__logs.join(' | '))
        t.assert(await records(page).then((r) => r[SITE + '/spa/b']), '离开 B 时存了 B')
        await page.close()
    })

    await t.test('SPA：hash 路由（#/xxx）参与页面键，点链接换页能恢复', async () => {
        const page = await open(browser, '/spa/a', { ...JUMP, fallback: 'spa.html' })
        await page.waitForSelector('#app p')
        await page.locator('nav a', { hasText: 'hash A' }).click()
        await page.waitForFunction(() => document.querySelector('#app h1') && document.querySelector('#app h1').textContent === 'HASH-A 篇')
        await scrollParaTo(page, 40, -10)
        await page.locator('nav a', { hasText: 'hash B' }).click()
        await page.waitForFunction(() => document.querySelector('#app h1') && document.querySelector('#app h1').textContent === 'HASH-B 篇')
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.locator('nav a', { hasText: 'hash A' }).click()
        await waitParaAt(page, 40, -10)
        t.assert((await records(page))[SITE + '/spa/a#/hash-a'], Object.keys(await records(page)).join(', '))
        await page.close()
    })

    await t.test('回到顶部 / 底部按钮：滚动后才出现，显示进度，点了平滑滚到顶 / 底，回到顶部后隐藏', async () => {
        const page = await open(browser, '/long.html')
        await page.waitForTimeout(300)
        t.eq((await fabState(page)).shown, false, '一开始不显示')
        await scrollWin(page, 3000, 200)
        const st = await fabState(page)
        t.assert(st.shown, '滚动后出现')
        const pct = await page.evaluate(() => Math.round(scrollY / (document.documentElement.scrollHeight - innerHeight) * 100) + '%')
        t.eq(st.pct, pct)
        await page.locator('scroll-memory-ui .fab .bottom').click()
        await waitScroll(page, 'Math.abs(y - max) < 2')
        await page.waitForTimeout(100)
        t.eq((await fabState(page)).pct, '100%')
        await page.locator('scroll-memory-ui .fab .top').click()
        await waitScroll(page, 'y === 0')
        await page.waitForTimeout(300)
        t.eq((await fabState(page)).shown, false, '回到顶部后隐藏')
        await page.close()
    })

    await t.test('回到顶部按钮：内层 div 滚动的页面滚的是那个 div', async () => {
        const page = await open(browser, '/inner.html')
        await page.waitForSelector('.scroll p')
        await scrollParaTo(page, 40, 0, 200)
        t.assert((await fabState(page)).shown)
        await page.locator('scroll-memory-ui .fab .top').click()
        await waitScroll(page, 'y === 0', '.scroll')
        await page.close()
    })

    await t.test('没有记录的页面不动', async () => {
        const page = await open(browser, '/long.html')
        await page.waitForTimeout(1200)
        t.eq(await page.evaluate(() => window.scrollY), 0)
        await page.close()
    })

    await t.test('防抖期间离开页面：pagehide 时补记最后一次滚动', async () => {
        const page = await open(browser, '/long.html')
        await scrollWin(page, 2800, 0)
        await page.goto(SITE + '/short.html')
        const rec = (await records(page))[SITE + '/long.html']
        t.assert(rec && rec.y === 2800, '离开前的位置应已记录：' + JSON.stringify(rec))
        await page.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
