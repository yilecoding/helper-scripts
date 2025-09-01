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

const t = h.createRunner('auto-pager')

/**
 * URL → fixture：/a/list?page=2 → list-2.html；没有 page 参数 → list.html（不存在再试 list-1.html）。
 * /post/abc.html 这种直接按文件名找。
 */
function fixtureFor(url) {
    const u = new URL(url)
    const name = path.basename(u.pathname).replace(/\.html$/, '') || 'index'
    const page = u.searchParams.get('page')
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

    await t.test('「下一篇 / 下一章 / Next post」和 WordPress 的 rel=next 文章导航都不算下一页', async () => {
        t.eq(await detected('/post/article.html'), null)
    })

    await t.test('javascript: / 跨域 / mailto / disabled / 只有 hash 的链接被跳过', async () => {
        t.eq(await detected('/forum/bad'), { how: '文字匹配', url: SITE + '/forum/bad?page=2' })
    })

    t.done()
    await close()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
