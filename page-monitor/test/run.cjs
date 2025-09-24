/*
 * page-monitor 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node page-monitor/test/run.cjs
 *
 * 页面挂在假域名 https://shop.example.com/... 下（page.route 用正则拦截），不访问外网。
 * 「服务器」是下面的 site 对象：页面导航（route）和脚本的 GM_xmlhttpRequest（harness 的 xhr 选项）
 * 都从它取内容，测试里改 site.files 就等于「服务器上的页面变了」。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'page-monitor.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const ORIGIN = 'https://shop.example.com'
const HOST = '#page-monitor-host'

const t = h.createRunner('page-monitor')

function fixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

/** 假服务器：pathname → html。每个用例自己建一个，互不影响。 */
function createSite(files = {}) {
    const site = { files: { ...files }, requests: [] }
    site.serve = (url) => {
        const u = new URL(url)
        const body = site.files[u.pathname + u.search] ?? site.files[u.pathname]
        return body === undefined ? { status: 404, responseText: 'not found' } : { status: 200, responseText: body }
    }
    return site
}

/**
 * 在 context 里开一个页面、装脚本、打开 url。
 * 同一个 context 里的页面共享 localStorage，也就共享 harness 的 GM 存储（用来测多标签）。
 */
async function open(context, site, pathname, opts = {}) {
    const page = await context.newPage()
    page.on('console', (m) => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(/^https:\/\/shop\.example\.com\//, (route) => {
        const r = site.serve(route.request().url())
        route.fulfill({ status: r.status, contentType: 'text/html; charset=utf-8', body: r.responseText })
    })
    await h.install(page, SCRIPT, {
        values: opts.values,
        xhr: opts.xhr || ((d) => { site.requests.push(d.url); return site.serve(d.url) }),
    })
    if (opts.clock) await page.clock.install({ time: opts.clock })
    await page.goto(ORIGIN + pathname)
    await page.waitForLoadState('load')
    return page
}

/** GM 存储里的全部监控项（harness 把 GM 值存在 localStorage 的 __gm: 前缀下）。 */
function monitors(page) {
    return page.evaluate(() => Object.keys(localStorage)
        .filter((k) => k.startsWith('__gm:mon:'))
        .map((k) => JSON.parse(localStorage.getItem(k)))
        .sort((a, b) => a.createdAt - b.createdAt))
}

function inHost(page, sel) {
    return page.locator(`${HOST} ${sel}`)
}

/** 走一遍拾取：菜单 → 悬停 → 点击，停在确认条上。 */
async function pick(page, selector) {
    await h.menu(page, '选取要监控的区域')
    await page.hover(selector)
    await page.click(selector)
    await inHost(page, '[data-act="cancel"]').waitFor()
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)
    console.log('page-monitor')

    await t.test('有稳定 id 的元素：选择器就是 #id，保存时文字快照作为基线', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/item/42')
        await pick(page, '#stock')
        t.eq(await inHost(page, '.sel').textContent(), '#stock')
        await inHost(page, '[data-act="save-fetch"]').click()
        const [m] = await monitors(page)
        t.eq(m.selector, '#stock')
        t.eq(m.baseline, '有货')
        t.eq(m.url, ORIGIN + '/item/42')
        t.eq(m.mode, 'fetch')
        t.eq(m.interval, 300)
        t.eq(await page.locator(`${HOST} [data-role="picker"]`).count(), 0, '保存后退出拾取模式')
        t.eq(h.errors(page).map(String), [])
        await ctx.close()
    })

    await t.test('随机 id（哈希串、React useId）被跳过，改用类名 + 路径，且能唯一定位回原元素', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/item/42')

        await pick(page, '.price')
        const priceSel = await inHost(page, '.sel').textContent()
        t.eq(priceSel, 'span.price', '类名已经唯一，不加序号')
        t.assert(!priceSel.includes('a8f3k2x9q1b7'), `不应使用随机 id：${priceSel}`)
        t.eq(await page.evaluate((s) => document.querySelector(s) === document.querySelector('.price') && document.querySelectorAll(s).length, priceSel), 1)
        await inHost(page, '[data-act="cancel"]').click()

        await pick(page, '.status')
        const statusSel = await inHost(page, '.sel').textContent()
        t.assert(!statusSel.includes(':r3:') && !statusSel.includes('r3'), `不应使用 React useId：${statusSel}`)
        t.eq(await page.evaluate((s) => document.querySelectorAll(s).length === 1 && document.querySelector(s).textContent, statusSel), '工单状态：处理中')
        await inHost(page, '[data-act="cancel"]').click()

        // 列表项没有类名、没有 id：靠 :nth-of-type
        await pick(page, '.notices li:nth-child(2)')
        const liSel = await inHost(page, '.sel').textContent()
        t.assert(liSel.includes(':nth-of-type(2)'), liSel)
        t.eq(await page.evaluate((s) => document.querySelector(s).textContent, liSel), '公告二：满减活动进行中')
        await ctx.close()
    })

    await t.test('拾取模式：点链接不跳转；↑ 扩到父元素；Esc 退出且不留下高亮', async () => {
        const site = createSite({ '/item/42': fixture('shop.html'), '/promo': '<title>活动</title>' })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/item/42')
        await pick(page, '.notices a')
        t.eq(page.url(), ORIGIN + '/item/42', '链接没有被点开')
        t.eq(await inHost(page, '.text').textContent(), '满减活动')

        await page.keyboard.press('ArrowUp')
        t.eq(await inHost(page, '.text').textContent(), '公告二：满减活动进行中')
        await inHost(page, '[data-act="parent"]').click()
        t.eq(await inHost(page, '.text').textContent(), '公告一：周末正常发货 公告二：满减活动进行中 公告三：新品预告', '块级元素之间补空格，不粘在一起')
        await inHost(page, '[data-act="save-fetch"]').click()
        t.eq((await monitors(page))[0].selector, 'ul.notices')

        await h.menu(page, '选取要监控的区域')
        await page.hover('h1')
        await page.keyboard.press('Escape')
        t.eq(await page.locator(`${HOST} .hl`).count(), 0)
        t.eq(await page.locator(`${HOST} [data-role="picker"]`).count(), 0)
        // 退出后点击恢复正常
        await page.click('.notices a')
        await page.waitForURL(ORIGIN + '/promo')
        await ctx.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
