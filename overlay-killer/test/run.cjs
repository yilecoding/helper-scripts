/*
 * overlay-killer 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node overlay-killer/test/run.cjs
 *
 * 页面都用 page.route 挂在假域名 https://example.com/ 下，不访问外网。
 * 用 https 假域名而不是 harness 的 127.0.0.1：「本站停用」以 hostname 为键，
 * 站点规则表也按域名匹配，想测的就是真实域名下的行为。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'overlay-killer.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://example.com'

const t = h.createRunner('overlay-killer')

/**
 * 新开一个独立 context（GM 存储互不影响），把假域名的请求映射到 fixtures。
 * 路由用正则：harness 的注入对任何 URL 都生效，用 glob 写 'https://example.com/**' 也行，
 * 但换成别的域名（csdn 等）时正则更不容易写错。
 * opts.site   换一个域名打开
 * opts.clock  打开前装上 page.clock（测延迟弹出用）
 */
async function open(browser, file, opts = {}) {
    const site = opts.site || SITE
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    page.on('console', m => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    const origin = new RegExp('^' + site.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '/')
    await page.route(origin, route => {
        const name = path.basename(new URL(route.request().url()).pathname) || file
        const fp = path.join(FIXTURES, name)
        if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    if (opts.clock) await page.clock.install()
    await h.install(page, SCRIPT, opts)
    await page.goto(site + '/' + file)
    return page
}

/** 元素是否可见（display/visibility 都算）。 */
function visible(page, sel) {
    return page.$eval(sel, el => {
        const s = getComputedStyle(el)
        return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0
    })
}

/** 脚本是 document-end 跑的；等 load 之后再多等一轮，让 MutationObserver 的节流也走完。 */
async function settle(page, ms = 600) {
    await page.waitForLoadState('load')
    await page.waitForTimeout(ms)
}

;(async () => {
    const { browser, close } = await h.setup(FIXTURES)

    await t.test('普通页面：固定顶栏、悬浮按钮不受影响，无异常', async () => {
        const page = await open(browser, 'plain.html')
        await settle(page)
        t.assert(await visible(page, '#nav'), '顶栏被隐藏了')
        t.assert(await visible(page, '#fab'), '悬浮按钮被隐藏了')
        t.eq(await page.$$eval('[data-overlay-killer]', els => els.length), 0)
        t.eq(h.errors(page).map(String), [])
        await page.context().close()
    })

    // ---------------------------------------------------------------- Cookie 同意：CMP

    const choice = page => page.evaluate(() => window.__choice)

    await t.test('OneTrust：点「Reject All」，不点接受，也不点设置', async () => {
        const page = await open(browser, 'onetrust.html')
        await settle(page)
        t.eq(await choice(page), 'reject')
        t.assert(!(await visible(page, '#onetrust-banner-sdk')), '横幅还在')
        await page.context().close()
    })

    await t.test('OneTrust 没有拒绝按钮：隐藏横幅，接受和设置都不点', async () => {
        const page = await open(browser, 'onetrust-noreject.html')
        await settle(page)
        t.eq(await choice(page), null)
        t.assert(!(await visible(page, '#onetrust-consent-sdk')), '横幅没隐藏')
        t.eq(await page.$eval('#onetrust-consent-sdk', el => el.getAttribute('data-overlay-killer')), 'consent')
        await page.context().close()
    })

    await t.test('Quantcast：没有专用 id，按文字点「DISAGREE」，不点「MORE OPTIONS」', async () => {
        const page = await open(browser, 'quantcast.html')
        await settle(page)
        t.eq(await choice(page), 'disagree')
        await page.context().close()
    })

    await t.test('Usercentrics：在 shadow root 里点拒绝', async () => {
        const page = await open(browser, 'usercentrics.html')
        await settle(page)
        t.eq(await choice(page), 'uc-deny-all-button')
        await page.context().close()
    })

    // ---------------------------------------------------------------- Cookie 同意：通用兜底

    await t.test('自建 Cookie 卡片（不是 CMP）：按文字点「仅必要」，不点「接受全部」', async () => {
        const page = await open(browser, 'banner-cookie.html')
        await settle(page)
        t.eq(await choice(page), 'necessary')
        await page.context().close()
    })

    await t.test('只有「我知道了」的 Cookie 横幅被隐藏、没被点；「打开 App」引导条被隐藏', async () => {
        const page = await open(browser, 'banner-hide.html')
        await settle(page)
        t.eq(await choice(page), null)
        t.assert(!(await visible(page, '#top-tip')), 'Cookie 横幅还在')
        t.assert(!(await visible(page, '#app-bar')), 'App 引导条还在')
        await page.context().close()
    })

    await close()
    t.done()
})()
