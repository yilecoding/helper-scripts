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

/**
 * 新开一个页面（独立 context，GM 存储互不影响），把假域名的请求映射到 fixtures。
 * 路径是 *.html 就取同名文件；其余（SPA 深链接）回落到 opts.fallback。
 */
async function open(browser, url, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('console', (m) => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
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
        if (Math.abs(top - offset) <= tol) return
        await page.waitForTimeout(100)
    }
    throw new Error(`第 ${n} 段应在 ${offset}，实际 ${top}`)
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
        const page = await open(browser, '/long.html')
        await scrollParaTo(page, 30, -20)
        const before = (await records(page))[SITE + '/long.html']
        await page.goto(SITE + '/long.html?drift=700')
        await waitParaAt(page, 30, -20)
        const y = await page.evaluate(() => window.scrollY)
        t.assert(y - before.y > 700, `像素位置应随插入内容下移：之前 ${before.y}，现在 ${y}`)
        await page.close()
    })

    await t.test('恢复：刷新时浏览器先按像素还原，内容漂移后脚本按锚点纠正', async () => {
        const page = await open(browser, '/long.html?drift=700')
        await page.waitForTimeout(500)
        await scrollParaTo(page, 45, -35)
        await page.reload()
        await waitParaAt(page, 45, -35)
        await page.close()
    })

    await t.test('恢复：字号变大，偏移按段落高度等比换算', async () => {
        const page = await open(browser, '/long.html')
        await scrollParaTo(page, 30, -40)
        const h0 = await page.evaluate(() => Array.from(document.querySelectorAll('p')).find((p) => p.textContent.startsWith('第 30 段。')).offsetHeight)
        await page.goto(SITE + '/long.html?font=27')
        const h1 = await page.evaluate(() => Array.from(document.querySelectorAll('p')).find((p) => p.textContent.startsWith('第 30 段。')).offsetHeight)
        await waitParaAt(page, 30, -Math.round(40 * h1 / h0), { tol: 3 })
        await page.close()
    })

    await t.test('恢复：改版后锚点全对不上，按进度百分比兜底', async () => {
        const page = await open(browser, '/long.html')
        await scrollWin(page, 4000)
        const rec = (await records(page))[SITE + '/long.html']
        await page.goto(SITE + '/long.html?rewrite=1')
        await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 7000 })
        const p = await page.evaluate(() => window.scrollY / (document.documentElement.scrollHeight - innerHeight))
        t.assert(Math.abs(p - rec.p) < 0.002, `进度 ${p} 应接近 ${rec.p}`)
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
