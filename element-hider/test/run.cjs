/*
 * element-hider 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node element-hider/test/run.cjs
 *
 * 页面用 page.route 挂在假域名下（https://www.example.com/... 等），不访问外网。
 * 规则按 hostname / 主域名存，想测的就是真实域名下的行为，所以不用 harness 的 127.0.0.1 静态服务。
 * 路由用正则：字符串 glob 对子域名的写法不直观，正则一眼能看出匹配哪些。
 *
 * harness 的 GM 存储按源隔离（真实环境全局共享）：「www 上存的主域名规则在 news 上生效」
 * 这种跨子域名的场景测不了，只能在各自的源上预置规则来测作用域判断。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'element-hider.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://www.example.com'

const t = h.createRunner('element-hider')

/** 新开一个页面（独立 context，GM 存储互不影响），把 *.example.com 的请求映射到 fixtures。 */
async function open(browser, file, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('console', m => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(/^https:\/\/([a-z0-9-]+\.)*example\.com\//, route => {
        const url = new URL(route.request().url())
        const fp = path.join(FIXTURES, path.basename(url.pathname) || file)
        if (!fs.existsSync(fp) || !fp.endsWith('.html')) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    await h.install(page, SCRIPT, opts)
    await page.goto((opts.origin || SITE) + '/' + file)
    return page
}

/** 元素的 computed display（找不到为 null）。 */
function display(page, sel) {
    return page.evaluate(s => {
        const el = document.querySelector(s)
        return el ? getComputedStyle(el).display : null
    }, sel)
}

function rule(selector) {
    return { selector, created: 1 }
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)

    console.log('生效')
    await t.test('预置规则：DOMContentLoaded 之前样式已生效（不闪烁）', async () => {
        const page = await open(browser, 'basic.html', { values: { 'rules:www.example.com': [rule('#top-ad')] } })
        const early = await page.evaluate(() => window.__early)
        t.eq(early, { state: 'loading', display: 'none' })
        t.eq(await display(page, '#site-header'), 'block', '没命中的不受影响')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('动态插入的匹配元素也被隐藏', async () => {
        const page = await open(browser, 'basic.html', { values: { 'rules:www.example.com': [rule('.ad-banner')] } })
        await page.waitForFunction(() => window.__lateInserted)
        t.eq(await display(page, '#late-ad'), 'none')
        await page.close()
    })

    await t.test('作用域：主域名规则在子域名生效，别的站点的规则不生效', async () => {
        const page = await open(browser, 'basic.html', {
            origin: 'https://news.example.com',
            values: {
                'rules:*.example.com': [rule('#top-ad')],
                'rules:www.example.com': [rule('#site-header')],
            },
        })
        t.eq(await display(page, '#top-ad'), 'none', '*.example.com 的规则')
        t.eq(await display(page, '#site-header'), 'block', 'www 的规则不该管 news')
        await page.close()
    })

    await t.test('一条坏规则不连累其他规则', async () => {
        const page = await open(browser, 'basic.html', {
            values: { 'rules:www.example.com': [rule('div:unknown-pseudo'), rule('a/*'), rule('#top-ad')] },
        })
        t.eq(await display(page, '#top-ad'), 'none')
        t.eq(await display(page, '.news'), 'block', '未闭合注释没有吞掉后面的东西，也没有误伤')
        await page.close()
    })

    await close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
