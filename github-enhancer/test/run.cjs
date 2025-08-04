/*
 * github-enhancer 测试。
 *
 * 运行：NODE_PATH=<装了 playwright 的 node_modules> node github-enhancer/test/run.cjs
 *
 * 不访问外网：
 *   - https://github.com/... 的文档请求用 page.route（正则 —— glob 匹配不了带 query 的 URL）
 *     按 pathname 返回 fixtures 里的页面；其余请求一律 abort。
 *   - api.github.com 走 GM_xmlhttpRequest，由 harness 的 opts.xhr 模拟，不发真实请求。
 * harness 的注入对任何 URL 都生效，所以可以直接 goto 真实的 github.com 地址。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'github-enhancer.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const GH = 'https://github.com'
const TAG = '[GitHub增强]'

const t = h.createRunner('github-enhancer')

/**
 * 打开一个 github.com 地址。
 * opts.routes  { pathname: fixture 文件名 }，没列到的用 opts.fixture（默认 plain.html）
 * opts.xhr     模拟 API：(details) => { status, responseText, responseHeaders }；默认全部 404
 * opts.values  GM 存储初始值
 * 每次新开一个 context：GM 存储（localStorage）互不影响。时区固定成上海，绝对时间断言才稳定。
 */
async function open(browser, url, opts = {}) {
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', locale: 'zh-CN' })
    const page = await context.newPage()
    page.logs = []
    page.requests = []
    page.on('console', (m) => {
        const text = m.text()
        if (text.startsWith(TAG)) page.logs.push(text)
        if (m.type() === 'error') console.log('      [page error]', text)
    })
    await page.route(/.*/, (r) => r.abort())
    await page.route(/^https:\/\/github\.com\//, (r) => {
        const u = new URL(r.request().url())
        const file = (opts.routes || {})[decodeURIComponent(u.pathname)] || opts.fixture || 'plain.html'
        r.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(FIXTURES, file)) })
    })
    await h.install(page, SCRIPT, {
        values: opts.values,
        xhr: async (d) => {
            page.requests.push(d)
            if (opts.xhr) return opts.xhr(d)
            return { status: 404, responseText: '{"message":"Not Found"}' }
        },
    })
    await page.goto(url)
    return page
}

/** 最近一次打出来的上下文（脚本每次上下文变化打一条 debug 日志）。 */
async function lastContext(page, n = 1) {
    await page.waitForFunction(() => true)
    for (let i = 0; i < 50; i++) {
        const ctxLogs = page.logs.filter((l) => l.startsWith(TAG + ' 上下文 '))
        if (ctxLogs.length >= n) return JSON.parse(ctxLogs[ctxLogs.length - 1].slice((TAG + ' 上下文 ').length))
        await page.waitForTimeout(50)
    }
    throw new Error('没有等到上下文日志')
}

async function closePage(page) {
    t.eq(h.errors(page).map(String), [], '页面里不该有未捕获异常')
    await page.context().close()
}

/** 只挑断言关心的字段。 */
function pick(ctx, keys = ['owner', 'repo', 'type', 'ref', 'path', 'sha', 'exact']) {
    if (!ctx) return ctx
    return Object.fromEntries(keys.map((k) => [k, ctx[k]]))
}

;(async () => {
    const { browser, close } = await h.setup(FIXTURES)

    console.log('URL 上下文解析')

    const cases = [
        ['/octo/demo', { owner: 'octo', repo: 'demo', type: 'root', ref: null, path: '', sha: null, exact: true }],
        ['/octo/demo/tree/main', { owner: 'octo', repo: 'demo', type: 'tree', ref: 'main', path: '', sha: null, exact: true }],
        ['/octo/demo/tree/main/src/lib', { owner: 'octo', repo: 'demo', type: 'tree', ref: 'main', path: 'src/lib', sha: null, exact: false }],
        // 分支名带 `/`：URL 本身有歧义，只按第一段猜，并标记 exact: false
        ['/octo/demo/tree/feature/x/path', { owner: 'octo', repo: 'demo', type: 'tree', ref: 'feature', path: 'x/path', sha: null, exact: false }],
        ['/octo/demo/blob/main/src/a%20b.js', { owner: 'octo', repo: 'demo', type: 'blob', ref: 'main', path: 'src/a b.js', sha: null, exact: false }],
        ['/octo/demo/blob/0123456789abcdef0123456789ABCDEF01234567/README.md', { owner: 'octo', repo: 'demo', type: 'blob', ref: '0123456789abcdef0123456789ABCDEF01234567', path: 'README.md', sha: '0123456789abcdef0123456789abcdef01234567', exact: true }],
        ['/octo/demo/commit/0123456789abcdef0123456789abcdef01234567', { owner: 'octo', repo: 'demo', type: 'commit', ref: '0123456789abcdef0123456789abcdef01234567', path: '', sha: '0123456789abcdef0123456789abcdef01234567', exact: true }],
        ['/octo/demo/commit/0123456789abcdef0123456789abcdef01234567.diff', { owner: 'octo', repo: 'demo', type: 'commit', ref: '0123456789abcdef0123456789abcdef01234567', path: '', sha: '0123456789abcdef0123456789abcdef01234567', exact: true }],
        ['/octo/demo/pull/12/commits/0123456789abcdef0123456789abcdef01234567', { owner: 'octo', repo: 'demo', type: 'pull', ref: '0123456789abcdef0123456789abcdef01234567', path: '', sha: '0123456789abcdef0123456789abcdef01234567', exact: true }],
        ['/octo/demo/releases/tag/release/v1.0', { owner: 'octo', repo: 'demo', type: 'release', ref: 'release/v1.0', path: '', sha: null, exact: true }],
        ['/octo/demo/issues/3', { owner: 'octo', repo: 'demo', type: 'issues', ref: null, path: '', sha: null, exact: true }],
    ]
    for (const [p, want] of cases) {
        await t.test(`解析 ${p}`, async () => {
            const page = await open(browser, GH + p)
            t.eq(pick(await lastContext(page)), want)
            await closePage(page)
        })
    }

    for (const p of ['/', '/octo', '/settings/profile', '/orgs/octo/teams', '/notifications']) {
        await t.test(`非仓库页 ${p} 的上下文是 null`, async () => {
            const page = await open(browser, GH + p)
            t.eq(await lastContext(page), null)
            await closePage(page)
        })
    }

    console.log('导航')

    await t.test('pushState / turbo:load / popstate 后重新解析上下文', async () => {
        const page = await open(browser, GH + '/octo/demo')
        t.eq((await lastContext(page, 1)).type, 'root')
        await page.evaluate(() => history.pushState({}, '', '/octo/demo/blob/main/a.js'))
        t.eq(pick(await lastContext(page, 2), ['type', 'ref', 'path']), { type: 'blob', ref: 'main', path: 'a.js' })
        // Turbo 换页：模拟它先改地址（绕开挂钩）、再发 turbo:load
        await page.evaluate(() => {
            History.prototype.replaceState.call(history, {}, '', '/octo/demo/issues')
            document.dispatchEvent(new Event('turbo:load'))
        })
        t.eq((await lastContext(page, 3)).type, 'issues')
        await page.goBack({ waitUntil: 'commit' }).catch(() => {})
        t.eq((await lastContext(page, 4)).type, 'root')
        await closePage(page)
    })

    await close()
    t.done()
})()
