/*
 * article-toc 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node article-toc/test/run.cjs
 *
 * 页面都用 page.route 挂在假域名下（https://blog.example.com/...），不访问外网。
 * 用 https 假域名而不是 harness 的 127.0.0.1 静态服务：
 * 「按站点记住状态」以 hostname 为键，想测的就是真实域名下的行为。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'article-toc.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://blog.example.com'

const t = h.createRunner('article-toc')

/** 新开一个页面（独立 context，GM 存储互不影响），把假域名的请求映射到 fixtures。 */
async function open(browser, file, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('console', (m) => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(SITE + '/**', (route) => {
        const url = new URL(route.request().url())
        // SPA 的深链接（/docs/b 之类）一律回落到同一个 html，和真实 SPA 服务器的行为一致
        const name = url.pathname.endsWith('.html') ? path.basename(url.pathname) : (opts.fallback || file)
        const fp = path.join(FIXTURES, name)
        if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    await h.install(page, SCRIPT, opts)
    await page.goto(SITE + '/' + file)
    return page
}

/** 目录有没有渲染出来。 */
function hasToc(page) {
    return page.evaluate(() => !!document.getElementById('article-toc-host'))
}

/** 等目录出现（脚本在 load 之后才跑）。 */
async function waitToc(page) {
    await page.waitForFunction(() => {
        const host = document.getElementById('article-toc-host')
        return host && host.shadowRoot && host.shadowRoot.querySelector('.item')
    })
}

/** 把目录读成 [{ text, children }] 树，直接按渲染出来的嵌套 <ul> 读，测的是用户看到的结构。 */
function readTree(page) {
    return page.evaluate(() => {
        const walk = (ul) => Array.from(ul.children).map((li) => {
            const sub = li.querySelector(':scope > ul')
            const node = { text: li.querySelector(':scope > .item').textContent }
            if (sub) node.children = walk(sub)
            return node
        })
        const sr = document.getElementById('article-toc-host').shadowRoot
        return walk(sr.querySelector('.list > ul'))
    })
}

/** 点目录项（Playwright 的 CSS 选择器会穿透 open shadow root）。 */
function clickItem(page, text) {
    return page.locator('#article-toc-host .item').filter({ hasText: new RegExp('^' + text + '$') }).click()
}

/** 等平滑滚动停下来：连续几次采样 scrollY 不变。 */
async function waitScrollIdle(page) {
    let last = -1
    let same = 0
    for (let i = 0; i < 60 && same < 3; i++) {
        const y = await page.evaluate(() => window.scrollY)
        same = y === last ? same + 1 : 0
        last = y
        await page.waitForTimeout(80)
    }
}

/** 页面里某个标题（按文字找）相对视口的 top。 */
function headingTop(page, text) {
    return page.evaluate((text) => {
        const el = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).find((h) => h.textContent.trim() === text)
        return el.getBoundingClientRect().top
    }, text)
}

/** 等脚本跑完（load 之后），用于断言「没有目录」这种否定结论前。 */
async function settle(page, ms = 300) {
    await page.waitForLoadState('load')
    await page.waitForTimeout(ms)
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)
    console.log('article-toc')

    await t.test('层级归一化：只用 h2/h4 的页面当成 1/2 级，生成嵌套树', async () => {
        const page = await open(browser, 'levels.html')
        await waitToc(page)
        t.eq(await readTree(page), [
            { text: '第一章 起步', children: [{ text: '1.1 安装' }, { text: '1.2 配置' }] },
            { text: '第二章 进阶', children: [{ text: '2.1 插件' }] },
            { text: '第三章 附录' },
        ])
        const depths = await page.evaluate(() => Array.from(
            document.getElementById('article-toc-host').shadowRoot.querySelectorAll('.item'),
        ).map((b) => Number(b.dataset.depth)))
        t.eq(depths, [1, 2, 2, 1, 2, 1], '缩进深度')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('跳级标题只深一层，空标题被忽略', async () => {
        const page = await open(browser, 'skip.html')
        await waitToc(page)
        t.eq(await readTree(page), [
            {
                text: '总标题',
                children: [
                    { text: '直接跳到 h3' },
                    { text: '回到 h2', children: [{ text: 'h2 下的 h3' }] },
                    { text: '另一个 h2' },
                ],
            },
        ])
        await page.close()
    })

    await t.test('侧栏 / 评论区 / 页脚 / 文内旁注 / 不可见的标题被排除', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        const texts = await page.evaluate(() => Array.from(
            document.getElementById('article-toc-host').shadowRoot.querySelectorAll('.item'),
        ).map((b) => b.textContent))
        t.eq(texts, ['如何写一个用户脚本', '准备工作', '安装 Tampermonkey', '新建脚本', '元数据', '调试技巧', '日志', '发布'])
        await page.close()
    })

    await t.test('没有 article/main 时按标题密度推断正文，侧栏和评论按类名排除', async () => {
        const page = await open(browser, 'nocontainer.html')
        await waitToc(page)
        t.eq(await readTree(page), [
            { text: '一、背景', children: [{ text: '1. 现状' }] },
            { text: '二、方案', children: [{ text: '1. 设计' }, { text: '2. 实现' }] },
            { text: '三、总结' },
        ])
        await page.close()
    })

    await t.test('点击跳转：标题停在固定导航栏下方，而不是被它盖住', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        const idsBefore = await page.evaluate(() => document.querySelectorAll('[id]').length)
        await clickItem(page, '调试技巧')
        await waitScrollIdle(page)
        const top = await headingTop(page, '调试技巧')
        t.assert(top >= 56 && top <= 56 + 24, `标题 top=${top}，应在 56px 的顶栏下方附近`)
        // 不改 hash、不给页面元素加 id
        t.eq(await page.evaluate(() => location.hash), '')
        t.eq(await page.evaluate(() => document.querySelectorAll('[id]').length), idsBefore, '页面上的 id 数量不变')
        await page.close()
    })

    await t.test('点击跳转：页面顶部时还没吸住的 sticky 导航栏也要扣掉', async () => {
        const page = await open(browser, 'sticky.html')
        await waitToc(page)
        await clickItem(page, '第三节')
        await waitScrollIdle(page)
        const top = await headingTop(page, '第三节')
        t.assert(top >= 50 && top <= 50 + 24, `标题 top=${top}，应在 50px 的吸顶栏下方附近`)
        await page.close()
    })

    await t.test('少于 3 个标题不显示目录', async () => {
        const page = await open(browser, 'few.html')
        await settle(page)
        t.eq(await hasToc(page), false)
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
