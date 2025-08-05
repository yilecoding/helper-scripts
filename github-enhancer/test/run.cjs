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

const REPO_JSON = { id: 1, full_name: 'octo/demo', size: 2048, default_branch: 'main', created_at: '2020-01-02T20:04:05Z', private: false }

/** 模拟 API：/repos/octo/demo 返回 REPO_JSON，其余 404。extra(d) 返回非空时优先。 */
function api(extra) {
    return async (d) => {
        const r = extra && (await extra(d))
        if (r) return r
        if (d.url === 'https://api.github.com/repos/octo/demo') return { status: 200, responseText: JSON.stringify(REPO_JSON) }
        return { status: 404, responseText: '{"message":"Not Found"}' }
    }
}

const repoRequests = (page) => page.requests.filter((d) => d.url === 'https://api.github.com/repos/octo/demo').length

/** 仓库信息条：{ state, text, items, afterTitle }，不存在返回 null。 */
function repoInfo(page) {
    return page.evaluate(() => {
        const node = document.getElementById('ghe-repo-info')
        if (!node) return null
        const items = {}
        node.querySelectorAll('.ghe-item').forEach((i) => { items[i.dataset.k] = i.querySelector('b').textContent })
        const title = document.getElementById('repo-title-component')
        return { state: node.dataset.state, text: node.textContent, items, afterTitle: !!title && title.nextElementSibling === node, count: document.querySelectorAll('#ghe-repo-info').length }
    })
}

async function waitRepoInfo(page, state = 'ready') {
    await page.waitForFunction((s) => {
        const n = document.getElementById('ghe-repo-info')
        return n && n.dataset.state === s
    }, state)
    return repoInfo(page)
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

    console.log('仓库信息')

    const REPO_ROUTES = { '/octo/demo': 'repo-react.html' }

    await t.test('仓库首页显示大小（KB 换算）、默认分支、创建日期（本地时区），挂在仓库名后面', async () => {
        const page = await open(browser, GH + '/octo/demo', { routes: REPO_ROUTES, xhr: api() })
        const info = await waitRepoInfo(page)
        // 2048 KB = 2.0 MB；2020-01-02T20:04:05Z 在 +08:00 已经是 1 月 3 日
        t.eq(info.items, { size: '2.0 MB', branch: 'main', created: '2020-01-03' })
        t.assert(info.afterTitle, '应插在 #repo-title-component 后面')
        t.eq(page.requests[0].headers.Accept, 'application/vnd.github+json')
        await closePage(page)
    })

    await t.test('缓存命中不再请求：刷新、同仓库内换目录都只请求过一次', async () => {
        const page = await open(browser, GH + '/octo/demo', { routes: REPO_ROUTES, xhr: api() })
        await waitRepoInfo(page)
        await page.reload()
        await waitRepoInfo(page)
        await page.evaluate(() => {
            history.pushState({}, '', '/octo/demo/tree/main/src')
            document.dispatchEvent(new Event('turbo:load'))
        })
        await lastContext(page, 3)
        await page.waitForTimeout(300)
        const info = await repoInfo(page)
        t.eq(info.count, 1)
        t.eq(info.state, 'ready')
        t.eq(repoRequests(page), 1)
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:cache:repo:octo/demo')))
        t.eq(stored.data, { size: 2048, default_branch: 'main', created_at: '2020-01-02T20:04:05Z' })
        await closePage(page)
    })

    await t.test('缓存超过 1 小时就重新请求', async () => {
        const stale = { at: Date.now() - 61 * 60 * 1000, data: { size: 1, default_branch: 'old', created_at: '2000-01-01T00:00:00Z' } }
        const page = await open(browser, GH + '/octo/demo', { routes: REPO_ROUTES, xhr: api(), values: { 'cache:repo:octo/demo': stale } })
        const info = await waitRepoInfo(page)
        t.eq(info.items.branch, 'main')
        t.eq(repoRequests(page), 1)
        await closePage(page)
    })

    await t.test('未过期的缓存直接用', async () => {
        const fresh = { at: Date.now() - 10 * 60 * 1000, data: { size: 3 * 1024 * 1024, default_branch: 'trunk', created_at: '2000-01-01T00:00:00Z' } }
        const page = await open(browser, GH + '/octo/demo', { routes: REPO_ROUTES, xhr: api(), values: { 'cache:repo:octo/demo': fresh } })
        const info = await waitRepoInfo(page)
        t.eq(info.items, { size: '3.00 GB', branch: 'trunk', created: '2000-01-01' })
        t.eq(repoRequests(page), 0)
        await closePage(page)
    })

    await t.test('请求失败显示错误和重试，重试成功后正常显示', async () => {
        let fail = true
        const page = await open(browser, GH + '/octo/demo', {
            routes: REPO_ROUTES,
            xhr: api(() => (fail ? { status: 500, responseText: '{"message":"Server Error"}' } : null)),
        })
        const info = await waitRepoInfo(page, 'error')
        t.assert(info.text.includes('HTTP 500'), info.text)
        fail = false
        await page.click('#ghe-repo-info button')
        t.eq((await waitRepoInfo(page)).items.branch, 'main')
        await closePage(page)
    })

    await t.test('issue 页不显示仓库信息，也不发请求', async () => {
        const page = await open(browser, GH + '/octo/demo/issues/1', { xhr: api() })
        await lastContext(page)
        await page.waitForTimeout(300)
        t.eq(await repoInfo(page), null)
        t.eq(page.requests.length, 0)
        await closePage(page)
    })

    await close()
    t.done()
})()
