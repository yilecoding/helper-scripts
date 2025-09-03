/*
 * auto-pager 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node auto-pager/test/run.cjs
 *
 * 页面都用 page.route 挂在假域名下（https://bbs.example.com/...），不访问外网。
 * 用 https 假域名而不是 harness 的 127.0.0.1 静态服务：「同源」「按站点停用」都以真实域名为准，
 * 而且要能按 query（?page=2）分发不同的 fixture、按用例改响应（500、GBK 字节）。
 * 路由必须用正则：glob 匹配不了带 query 的 URL。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'auto-pager.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://bbs.example.com'
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')

const t = h.createRunner('auto-pager')

/**
 * URL → fixture：/a/list?page=2 → list-2.html；没有 page 参数 → list.html（不存在再试 list-1.html）。
 * WordPress 式的目录分页 /blog/page/2/ → blog-2.html，/blog/ → blog-1.html。
 * /post/abc.html 这种直接按文件名找。
 */
function fixtureFor(url) {
    const u = new URL(url)
    const dirPage = /\/([\w-]+)\/page\/(\d+)\/?$/.exec(u.pathname)
    const name = dirPage ? dirPage[1] : path.basename(u.pathname).replace(/\.html$/, '') || 'index'
    const page = dirPage ? dirPage[2] : u.searchParams.get('page')
    const tries = page ? [`${name}-${page}.html`] : [`${name}.html`, `${name}-1.html`]
    for (const f of tries) {
        const fp = path.join(FIXTURES, f)
        if (fs.existsSync(fp)) return fp
    }
    return null
}

/**
 * 新开一个页面（独立 context，GM 存储互不影响），把假域名的请求映射到 fixtures。
 * opts.respond(url) 可以按 URL 接管响应：返回 { status, headers, body } 或 undefined 走默认。
 * 返回的 page 上挂了 logs（本脚本的 console 输出）和 requests（打到假域名的请求 URL）。
 */
async function open(browser, url, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.logs = []
    page.requests = []
    page.on('console', (m) => {
        if (m.text().startsWith('[自动翻页]')) page.logs.push(m.text())
        if (m.type() === 'error') console.log('      [page error]', m.text())
    })
    await page.route(/^https:\/\/bbs\.example\.com\//, async (route) => {
        const reqUrl = route.request().url()
        page.requests.push(reqUrl)
        const custom = opts.respond && (await opts.respond(reqUrl))
        if (custom) return route.fulfill(custom)
        // fixture 里的图片地址都是假的，一律回一个 1×1 的 gif，免得控制台刷 404
        if (/\.(?:png|jpe?g|gif)(?:\?|$)/.test(reqUrl)) return route.fulfill({ contentType: 'image/gif', body: PIXEL })
        const fp = fixtureFor(reqUrl)
        if (!fp) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    await h.install(page, SCRIPT, opts)
    await page.goto(SITE + url)
    return page
}

/** 等脚本跑完（load 之后），用于断言否定结论前。 */
async function settle(page, ms = 300) {
    await page.waitForLoadState('load')
    await page.waitForTimeout(ms)
}

/** 等某条日志出现（包含匹配），返回它。 */
async function waitLog(page, text, timeout = 3000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
        const hit = page.logs.find((l) => l.includes(text))
        if (hit) return hit
        await page.waitForTimeout(30)
    }
    throw new Error(`等不到日志「${text}」，已有：\n        ${page.logs.join('\n        ')}`)
}

/** 滚到页面最底部（瞬间滚动），触发 scroll。 */
async function scrollBottom(page) {
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
}

/** 分隔线：[{ page, text, href }]。 */
function separators(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('.auto-pager-sep')).map((s) => {
        const a = s.querySelector('a')
        return { page: s.dataset.page, text: a.textContent, href: a.href }
    }))
}

/** 等分隔线数量到 n。 */
async function waitSeps(page, n, timeout = 3000) {
    await page.waitForFunction((n) => document.querySelectorAll('.auto-pager-sep').length >= n, n, { timeout })
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)
    console.log('auto-pager')

    await t.test('脚本在普通页面上启动，没有报错', async () => {
        const page = await open(browser, '/list')
        await waitLog(page, '启动')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('本站停用后不启动', async () => {
        const page = await open(browser, '/list', { values: { 'site:bbs.example.com': { disabled: true } } })
        await waitLog(page, '本站已停用')
        t.assert(!page.logs.some((l) => l.endsWith('启动')), '停用了还在启动')
        await page.close()
    })

    /** 打开页面，返回脚本认出的「下一页」日志里的 URL（没认出返回 null）。 */
    async function detected(url) {
        const page = await open(browser, url)
        const line = await Promise.race([waitLog(page, '下一页（'), waitLog(page, '没有找到下一页')])
        t.eq(h.errors(page).map(String), [])
        await page.close()
        const m = /下一页（(.+?)）：(\S+)/.exec(line)
        return m ? { how: m[1], url: m[2] } : null
    }

    await t.test('识别：<link rel="next"> 优先于文字链接', async () => {
        t.eq(await detected('/forum/rel'), { how: 'rel=next', url: SITE + '/forum/rel?page=2' })
    })

    await t.test('识别：文字「下一页 >」（去掉两侧装饰后整段匹配）', async () => {
        t.eq(await detected('/forum/text'), { how: '文字匹配', url: SITE + '/forum/text?page=3' })
    })

    await t.test('识别：只有图标的按钮靠 aria-label / title', async () => {
        t.eq(await detected('/forum/aria'), { how: '文字匹配', url: SITE + '/forum/aria?p=3' })
    })

    await t.test('识别：« ‹ 1 2 3 › » 里取 ›，不取尾页 »', async () => {
        t.eq(await detected('/forum/arrows'), { how: '文字匹配', url: SITE + '/forum/arrows?page=3' })
    })

    await t.test('识别：没有「下一页」字样时按当前页码推断（回复数这种孤立数字不算）', async () => {
        t.eq(await detected('/forum/numbers'), { how: '页码推断', url: SITE + '/forum/numbers?page=3' })
    })

    await t.test('识别：当前页本身是链接时靠 aria-current / .active 认出', async () => {
        t.eq(await detected('/forum/numbers-aria'), { how: '页码推断', url: SITE + '/forum/numbers-aria?page=5' })
    })

    await t.test('「下一篇 / 下一章 / Next post」和 WordPress 的 rel=next 文章导航都不算下一页', async () => {
        t.eq(await detected('/post/article.html'), null)
    })

    await t.test('javascript: / 跨域 / mailto / disabled / 只有 hash 的链接被跳过', async () => {
        t.eq(await detected('/forum/bad'), { how: '文字匹配', url: SITE + '/forum/bad?page=2' })
    })

    await t.test('内容容器：选中帖子列表，不选导航菜单和侧栏「热门」', async () => {
        const page = await open(browser, '/forum/list')
        await waitLog(page, '下一页（')
        await scrollBottom(page)
        t.eq((await waitLog(page, '内容区域：')).split('内容区域：')[1], '#main > div.list')
        await page.close()
    })

    await t.test('内容容器：只在当前页出现的推荐位文字再多也不选（要在下一页里也找得到）', async () => {
        // 页面很短，一打开就离底部不到 2 屏，直接加载
        const page = await open(browser, '/forum/promo')
        t.eq((await waitLog(page, '内容区域：')).split('内容区域：')[1], 'body > ul.threads')
        await waitSeps(page, 1)
        t.eq(await page.evaluate(() => document.querySelectorAll('ul.threads > li.thread').length), 6)
        await page.close()
    })

    await t.test('导入修正：相对链接按下一页转绝对、懒加载图片写回 src、锚点和 javascript: 不动、脚本不搬', async () => {
        const page = await open(browser, '/blog/')
        await waitSeps(page, 1)
        const got = await page.evaluate(() => {
            const arts = Array.from(document.querySelectorAll('.posts > article'))
            const a4 = arts[3]
            const a5 = arts[4]
            const a6 = arts[5]
            return {
                count: arts.length,
                page1Link: arts[0].querySelector('h2 a').href,
                link4: a4.querySelector('h2 a').getAttribute('href'),
                img4: a4.querySelector('img').getAttribute('src'),
                srcset4: a4.querySelector('img').getAttribute('srcset'),
                hash4: a4.querySelector('p a').getAttribute('href'),
                img5: a5.querySelector('img').getAttribute('src'),
                js5: a5.querySelector('p a').getAttribute('href'),
                img6: a6.querySelector('img').getAttribute('src'),
                script6: a6.querySelectorAll('script').length,
                ran: !!window.__ranImportedScript,
            }
        })
        t.eq(got, {
            count: 6,
            page1Link: SITE + '/blog/2026/10/post-1/',
            link4: SITE + '/blog/2026/09/post-4/',
            img4: SITE + '/blog/img/4.png',
            srcset4: SITE + '/blog/img/4.png 1x, ' + SITE + '/blog/img/4@2x.png 2x',
            hash4: '#comments',
            img5: SITE + '/blog/page/2/thumb-5.png',
            js5: 'javascript:void(0)',
            img6: SITE + '/blog/img/6.png',
            script6: 0,
            ran: false,
        })
        await page.close()
    })

    await t.test('分页条换成下一页的：当前页码跟着变，链接是绝对地址', async () => {
        const page = await open(browser, '/blog/')
        await waitSeps(page, 1)
        t.eq((await waitLog(page, '分页条：')).split('分页条：')[1], 'body > nav.navigation.pagination > div.nav-links')
        const pager = await page.evaluate(() => {
            const bars = document.querySelectorAll('.nav-links')
            const bar = bars[0]
            return {
                bars: bars.length,
                current: bar.querySelector('.current').textContent,
                links: Array.from(bar.querySelectorAll('a')).map((a) => a.getAttribute('href')),
            }
        })
        t.eq(pager, { bars: 1, current: '2', links: [SITE + '/blog/', SITE + '/blog/'] })
        await page.close()
    })

    await t.test('没滚到底不加载；滚到底依次追加第 2、3 页，带分隔线和原链接', async () => {
        const page = await open(browser, '/forum/list')
        await waitLog(page, '下一页（')
        await settle(page)
        t.eq(page.requests.filter((u) => u.includes('page=')), [], '首屏不该预加载')
        await scrollBottom(page)
        await waitSeps(page, 1)
        await scrollBottom(page)
        await waitSeps(page, 2)
        t.eq(await separators(page), [
            { page: '2', text: '第 2 页', href: SITE + '/forum/list?page=2' },
            { page: '3', text: '第 3 页', href: SITE + '/forum/list?page=3' },
        ])
        const titles = await page.evaluate(() => Array.from(document.querySelectorAll('#main .list > .item h3')).map((x) => x.textContent))
        t.eq(titles.length, 30)
        t.assert(titles[10].startsWith('第2页 帖子1') && titles[29].startsWith('第3页 帖子10'), titles.join('|'))
        // 分隔线夹在第 1 页最后一项和第 2 页第一项之间
        const order = await page.evaluate(() => {
            const sep = document.querySelector('.auto-pager-sep')
            const head = (el) => /第\d+页 帖子\d+/.exec(el.textContent)[0]
            return [head(sep.previousElementSibling), head(sep.nextElementSibling)]
        })
        t.eq(order, ['第1页 帖子10', '第2页 帖子1'])
        await waitLog(page, '已到最后一页')
        t.eq(await page.evaluate(() => document.querySelector('.pagination .current').textContent), '3', '分页条应换成第 3 页的')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    t.done()
    await close()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
