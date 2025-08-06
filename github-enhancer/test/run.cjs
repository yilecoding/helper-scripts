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
 * opts.transform  (html, url) => html，返回前改一下 fixture
 * opts.harness 透传给 h.install 的其他选项（failDownloads 之类）
 * 路由挂在 context 上而不是 page 上：脚本用 target=_blank 打开的新标签也要被拦住。
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
    page.blocked = []
    await context.route(/.*/, (r) => {
        page.blocked.push(r.request().url())
        r.abort()
    })
    await context.route(/^https:\/\/github\.com\//, (r) => {
        const u = new URL(r.request().url())
        const file = (opts.routes || {})[decodeURIComponent(u.pathname)] || opts.fixture || 'plain.html'
        let html = fs.readFileSync(path.join(FIXTURES, file), 'utf8')
        if (opts.transform) html = opts.transform(html, u)
        r.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
    })
    await h.install(page, SCRIPT, {
        ...opts.harness,
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

const REPO_ROUTES = { '/octo/demo': 'repo-react.html' }
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

    console.log('分支名带 / 的消歧')

    const refsApi = (heads, tags = []) => api((d) => {
        const m = d.url.match(/\/git\/matching-refs\/(heads|tags)\/(.+)$/)
        if (!m) return null
        const pool = m[1] === 'heads' ? heads.map((n) => 'refs/heads/' + n) : tags.map((n) => 'refs/tags/' + n)
        const prefix = 'refs/' + m[1] + '/' + decodeURIComponent(m[2])
        return { status: 200, responseText: JSON.stringify(pool.filter((r) => r.startsWith(prefix)).map((ref) => ({ ref }))) }
    })
    const refRequests = (page) => page.requests.filter((d) => d.url.includes('/git/matching-refs/')).map((d) => d.url.replace('https://api.github.com/repos/octo/demo/git/matching-refs/', ''))

    await t.test('React 页：嵌入数据给出 feature/x 和 SHA，不调 API', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/feature/x/src', { routes: { '/octo/demo/tree/feature/x/src': 'tree-react.html' }, xhr: api() })
        t.eq(pick(await lastContext(page), ['type', 'ref', 'path', 'sha', 'exact', 'source']), { type: 'tree', ref: 'feature/x', path: 'src', sha: '2222222222222222222222222222222222222222', exact: true, source: 'embedded' })
        t.eq(refRequests(page), [])
        await closePage(page)
    })

    await t.test('React 内部路由换目录后嵌入数据过期：改用分支按钮；按钮也没了就用已知分支，仍不调 API', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/feature/x/src', { routes: { '/octo/demo/tree/feature/x/src': 'tree-react.html' }, xhr: api() })
        await lastContext(page, 1)
        await page.evaluate(() => history.pushState({}, '', '/octo/demo/tree/feature/x/src/lib'))
        const ctx = await lastContext(page, 2)
        // 嵌入数据里的 SHA 是老页面的，不能沿用
        t.eq(pick(ctx, ['ref', 'path', 'sha', 'source']), { ref: 'feature/x', path: 'src/lib', sha: null, source: 'picker' })
        await page.evaluate(() => {
            document.querySelector('button.ref-selector-class').remove()
            document.querySelector('[data-testid="breadcrumbs-repo-link"]').remove()
            history.pushState({}, '', '/octo/demo/blob/feature/x/src/lib/a.js')
        })
        t.eq(pick(await lastContext(page, 3), ['type', 'ref', 'path', 'source']), { type: 'blob', ref: 'feature/x', path: 'src/lib/a.js', source: 'known' })
        t.eq(refRequests(page), [])
        await closePage(page)
    })

    await t.test('旧版页面：面包屑的仓库根链接消歧', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/feature/x/src', {
            routes: { '/octo/demo/tree/feature/x/src': 'tree-legacy.html' },
            xhr: api(),
            transform: (html) => html.replace(' data-menu-button>', '>'),
        })
        t.eq(pick(await lastContext(page), ['ref', 'path', 'exact', 'source']), { ref: 'feature/x', path: 'src', exact: true, source: 'breadcrumb' })
        await closePage(page)
    })

    await t.test('旧版页面：#branch-select-menu 的分支名消歧', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/feature/x/src', { routes: { '/octo/demo/tree/feature/x/src': 'tree-legacy.html' }, xhr: api() })
        t.eq(pick(await lastContext(page), ['ref', 'path', 'exact', 'source']), { ref: 'feature/x', path: 'src', exact: true, source: 'picker' })
        await closePage(page)
    })

    await t.test('页面上没有线索：用 matching-refs API 挑按分段对得上的最长分支', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/feature/x/path', { xhr: refsApi(['feature-old', 'feature/x', 'feature/xy', 'main']) })
        t.eq(pick(await lastContext(page), ['ref', 'path', 'exact', 'refType', 'source']), { ref: 'feature/x', path: 'path', exact: true, refType: 'branch', source: 'known' })
        t.eq(refRequests(page), ['heads/feature'])
        // 同一分支下换页：不再查
        await page.evaluate(() => history.pushState({}, '', '/octo/demo/blob/feature/x/path/b.md'))
        t.eq(pick(await lastContext(page, 2), ['ref', 'path']), { ref: 'feature/x', path: 'path/b.md' })
        t.eq(refRequests(page), ['heads/feature'])
        await closePage(page)
    })

    await t.test('分支里没有就查 tag', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/release/v2/docs', { xhr: refsApi([], ['release/v1', 'release/v2']) })
        t.eq(pick(await lastContext(page), ['ref', 'path', 'refType']), { ref: 'release/v2', path: 'docs', refType: 'tag' })
        t.eq(refRequests(page), ['heads/release', 'tags/release'])
        await closePage(page)
    })

    await t.test('/tree/main/src/lib 这种普通分支：API 确认是 main', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/main/src/lib', { xhr: refsApi(['main', 'main-old']) })
        t.eq(pick(await lastContext(page), ['ref', 'path', 'exact']), { ref: 'main', path: 'src/lib', exact: true })
        await closePage(page)
    })

    await t.test('API 失败：退回「第一段是 ref」的猜测，标记 source: guess', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/feature/x/path', { xhr: api() })
        t.eq(pick(await lastContext(page), ['ref', 'path', 'exact', 'source']), { ref: 'feature', path: 'x/path', exact: false, source: 'guess' })
        await closePage(page)
    })

    console.log('文件列表按钮')

    /** 每行的按钮：[{ name, buttons: [文字] }]，只列有按钮的行。 */
    function rowButtons(page) {
        return page.evaluate(() => Array.from(document.querySelectorAll('.ghe-row-actions')).map((box) => {
            const row = box.closest('tr, [role="row"]')
            const a = row.querySelector('.react-directory-row-name-cell-large-screen a, [role="rowheader"] a')
            return { name: a.textContent.trim(), buttons: Array.from(box.querySelectorAll('button')).map((b) => b.textContent) }
        }))
    }

    async function clickRowButton(page, name, text) {
        await page.evaluate(({ name, text }) => {
            const box = Array.from(document.querySelectorAll('.ghe-row-actions')).find((b) => {
                const row = b.closest('tr, [role="row"]')
                return row.querySelector('.react-directory-row-name-cell-large-screen a, [role="rowheader"] a').textContent.trim() === name
            })
            Array.from(box.querySelectorAll('button')).find((b) => b.textContent === text).click()
        }, { name, text })
    }

    const waitRows = (page) => page.waitForSelector('.ghe-row-actions')

    await t.test('React 仓库首页：文件给「下载」、目录给「检出命令」，每行一组', async () => {
        const page = await open(browser, GH + '/octo/demo', { routes: REPO_ROUTES, xhr: api() })
        await waitRows(page)
        t.eq(await rowButtons(page), [
            { name: 'docs', buttons: ['检出命令'] },
            { name: 'src', buttons: ['检出命令'] },
            { name: 'README.md', buttons: ['下载'] },
            { name: 'a b.txt', buttons: ['下载'] },
        ])
        await clickRowButton(page, 'README.md', '下载')
        await clickRowButton(page, 'a b.txt', '下载')
        t.eq((await h.gm(page)).downloads, [
            { url: 'https://raw.githubusercontent.com/octo/demo/main/README.md', name: 'README.md' },
            { url: 'https://raw.githubusercontent.com/octo/demo/main/a%20b.txt', name: 'a b.txt' },
        ])
        await clickRowButton(page, 'src', '检出命令')
        t.eq((await h.gm(page)).clipboard, {
            text: 'git clone --filter=blob:none --sparse --depth 1 --branch main https://github.com/octo/demo.git && cd demo && git sparse-checkout set src',
            type: 'text',
        })
        await closePage(page)
    })

    await t.test('React 目录页（分支 feature/x）：raw 链接与命令用完整分支名；子模块和「..」行不加按钮', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/feature/x/src', { routes: { '/octo/demo/tree/feature/x/src': 'tree-react.html' }, xhr: api() })
        await waitRows(page)
        t.eq(await rowButtons(page), [
            { name: 'lib', buttons: ['检出命令'] },
            { name: 'index.js', buttons: ['下载'] },
            { name: '日志 #1.md', buttons: ['下载'] },
        ])
        await clickRowButton(page, 'index.js', '下载')
        await clickRowButton(page, '日志 #1.md', '下载')
        t.eq((await h.gm(page)).downloads, [
            { url: 'https://raw.githubusercontent.com/octo/demo/feature/x/src/index.js', name: 'index.js' },
            { url: 'https://raw.githubusercontent.com/octo/demo/feature/x/src/%E6%97%A5%E5%BF%97%20%231.md', name: '日志 #1.md' },
        ])
        await clickRowButton(page, 'lib', '检出命令')
        t.eq((await h.gm(page)).clipboard.text,
            'git clone --filter=blob:none --sparse --depth 1 --branch feature/x https://github.com/octo/demo.git && cd demo && git sparse-checkout set src/lib')
        await closePage(page)
    })

    await t.test('旧版文件列表（div[role=row]）：同样加按钮，上级目录行不加', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/feature/x/src', { routes: { '/octo/demo/tree/feature/x/src': 'tree-legacy.html' }, xhr: api() })
        await waitRows(page)
        t.eq(await rowButtons(page), [
            { name: 'lib', buttons: ['检出命令'] },
            { name: 'index.js', buttons: ['下载'] },
        ])
        await closePage(page)
    })

    await t.test('旧版仓库首页没有嵌入数据：按「根目录 + 文件名」从链接倒推出 ref', async () => {
        const page = await open(browser, GH + '/octo/demo', {
            routes: { '/octo/demo': 'tree-legacy.html' },
            xhr: api(),
            // 改造成根目录：文件名链接直接挂在 feature/x 下，没有分支按钮和面包屑
            transform: (html) => html.replace(' data-menu-button>', '>').replace('class="js-repo-root', 'class="x').replace(/\/src\//g, '/'),
        })
        t.eq(pick(await lastContext(page), ['type', 'ref']), { type: 'root', ref: null })
        await waitRows(page)
        await clickRowButton(page, 'lib', '检出命令')
        t.eq((await h.gm(page)).clipboard.text,
            'git clone --filter=blob:none --sparse --depth 1 --branch feature/x https://github.com/octo/demo.git && cd demo && git sparse-checkout set lib')
        await clickRowButton(page, 'index.js', '下载')
        t.eq((await h.gm(page)).downloads[0].url, 'https://raw.githubusercontent.com/octo/demo/feature/x/index.js')
        await closePage(page)
    })

    await t.test('消歧彻底失败（guess）时 raw 链接仍然正确（ref/path 拼回去不变）', async () => {
        const page = await open(browser, GH + '/octo/demo/tree/feature/x/src', {
            routes: { '/octo/demo/tree/feature/x/src': 'tree-legacy.html' },
            xhr: api(),
            transform: (html) => html.replace(' data-menu-button>', '>').replace('class="js-repo-root', 'class="x'),
        })
        t.eq((await lastContext(page)).source, 'guess')
        await waitRows(page)
        await clickRowButton(page, 'index.js', '下载')
        t.eq((await h.gm(page)).downloads[0].url, 'https://raw.githubusercontent.com/octo/demo/feature/x/src/index.js')
        await closePage(page)
    })

    await t.test('ref 是 SHA 时 sparse 命令改成先不检出再 checkout；路径带空格和引号会被转义', async () => {
        const sha = '5555555555555555555555555555555555555555'
        const page = await open(browser, GH + `/octo/demo/tree/${sha}/src`, {
            routes: { [`/octo/demo/tree/${sha}/src`]: 'tree-legacy.html' },
            xhr: api(),
            transform: (html) => html.replace(/feature\/x/g, sha).replace('>lib<', ">it's dir<").replace('/src/lib"', '/src/it%27s%20dir"').replace('title="lib"', `title="it's dir"`),
        })
        await waitRows(page)
        await clickRowButton(page, "it's dir", '检出命令')
        t.eq((await h.gm(page)).clipboard.text,
            `git clone --filter=blob:none --sparse --no-checkout https://github.com/octo/demo.git && cd demo && git sparse-checkout set 'src/it'\\''s dir' && git checkout ${sha}`)
        await closePage(page)
    })

    await t.test('GM_download 失败时退回用浏览器打开 raw 链接', async () => {
        const page = await open(browser, GH + '/octo/demo', { routes: REPO_ROUTES, xhr: api(), harness: { failDownloads: /README/ } })
        await waitRows(page)
        const popup = page.context().waitForEvent('page')
        await clickRowButton(page, 'README.md', '下载')
        await popup
        await page.waitForTimeout(200)
        t.assert(page.blocked.includes('https://raw.githubusercontent.com/octo/demo/main/README.md'), JSON.stringify(page.blocked))
        await closePage(page)
    })

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

    console.log('限流与 token')

    /** 本地（上海）时区的 HH:mm，和脚本的格式一致。 */
    const hhmm = (sec) => new Date(sec * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })

    await t.test('403 + x-ratelimit-remaining: 0 显示限流和恢复时间；到点前刷新不再请求', async () => {
        const reset = Math.floor(Date.now() / 1000) + 1800
        const page = await open(browser, GH + '/octo/demo', {
            routes: REPO_ROUTES,
            xhr: () => ({
                status: 403,
                responseText: '{"message":"API rate limit exceeded for 1.2.3.4."}',
                responseHeaders: `x-ratelimit-limit: 60\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: ${reset}\r\n`,
            }),
        })
        let info = await waitRepoInfo(page, 'ratelimit')
        t.assert(info.text.includes('已限流') && info.text.includes(hhmm(reset)), info.text)
        t.assert(info.text.includes('token'), '没设 token 时提示可以设置 token')
        await page.reload()
        info = await waitRepoInfo(page, 'ratelimit')
        t.assert(info.text.includes(hhmm(reset)), info.text)
        t.eq(repoRequests(page), 1)
        await closePage(page)
    })

    await t.test('403 但没有限流头（没权限）不当成限流', async () => {
        const page = await open(browser, GH + '/octo/demo', {
            routes: REPO_ROUTES,
            xhr: () => ({ status: 403, responseText: '{"message":"Repository access blocked"}', responseHeaders: 'x-ratelimit-remaining: 55\r\n' }),
        })
        const info = await waitRepoInfo(page, 'error')
        t.assert(info.text.includes('HTTP 403'), info.text)
        t.eq(await page.evaluate(() => localStorage.getItem('__gm:ratelimit')), null)
        await closePage(page)
    })

    await t.test('次级限流：429 + retry-after 也显示恢复时间', async () => {
        const page = await open(browser, GH + '/octo/demo', {
            routes: REPO_ROUTES,
            xhr: () => ({ status: 429, responseText: '{"message":"secondary rate limit"}', responseHeaders: 'retry-after: 120\r\n' }),
        })
        const info = await waitRepoInfo(page, 'ratelimit')
        t.assert(info.text.includes('已限流'), info.text)
        await closePage(page)
    })

    await t.test('404 且没设 token：提示可能是私有仓库', async () => {
        const page = await open(browser, GH + '/octo/demo', { routes: REPO_ROUTES })
        const info = await waitRepoInfo(page, 'error')
        t.assert(info.text.includes('私有仓库'), info.text)
        await closePage(page)
    })

    await t.test('存了 token 时请求带 Authorization: Bearer', async () => {
        const page = await open(browser, GH + '/octo/demo', { routes: REPO_ROUTES, xhr: api(), values: { token: 'ghp_saved' } })
        await waitRepoInfo(page)
        t.eq(page.requests[0].headers.Authorization, 'Bearer ghp_saved')
        await closePage(page)
    })

    await t.test('菜单设置 token：存下来、清掉限流记录、立即按新身份重新加载；清除 token 后不再带头', async () => {
        const reset = Math.floor(Date.now() / 1000) + 1800
        const page = await open(browser, GH + '/octo/demo', {
            routes: REPO_ROUTES,
            xhr: api((d) => (d.headers.Authorization ? null : { status: 403, responseText: '{}', responseHeaders: `x-ratelimit-remaining: 0\r\nx-ratelimit-reset: ${reset}` })),
        })
        await waitRepoInfo(page, 'ratelimit')
        t.assert((await h.gm(page)).menu.includes('设置 GitHub token'))
        page.once('dialog', (dlg) => dlg.accept('  ghp_from_menu  '))
        await h.menu(page, '设置 GitHub token')
        const info = await waitRepoInfo(page)
        t.eq(info.items.branch, 'main')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:token'))), 'ghp_from_menu')
        t.eq(await page.evaluate(() => localStorage.getItem('__gm:ratelimit')), null)
        t.eq(page.requests[page.requests.length - 1].headers.Authorization, 'Bearer ghp_from_menu')
        await h.menu(page, '清除 GitHub token')
        t.eq(await page.evaluate(() => localStorage.getItem('__gm:token')), null)
        await closePage(page)
    })

    await t.test('设置 token 时点取消什么都不改', async () => {
        const page = await open(browser, GH + '/octo/demo', { routes: REPO_ROUTES, xhr: api(), values: { token: 'ghp_keep' } })
        await waitRepoInfo(page)
        page.once('dialog', (dlg) => dlg.dismiss())
        await h.menu(page, '设置 GitHub token')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:token'))), 'ghp_keep')
        await closePage(page)
    })

    await close()
    t.done()
})()
