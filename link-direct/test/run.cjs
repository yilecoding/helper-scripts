'use strict'
/*
 * 外链直达的测试。运行：
 *   NODE_PATH=/path/to/node_modules node link-direct/test/run.cjs
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'link-direct.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')

;(async () => {
    const { browser, base, close } = await h.setup(FIXTURES)
    const t = h.createRunner('link-direct')

    /**
     * 测试不访问外网：除了本地 fixtures 服务，所有请求都回一个占位页。
     * 挂在 context 上而不是 page 上，window.open 弹出的新页也一样被拦。
     */
    async function stubExternal(page) {
        await page.context().route(url => !url.href.startsWith(base), route => route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><meta charset="utf-8"><title>stub</title><p>stub: ' + route.request().url() + '</p>',
        }))
    }

    async function open(file, opts) {
        const page = await browser.newPage()
        await stubExternal(page)
        await h.install(page, SCRIPT, opts)
        await page.goto(base + '/' + file)
        return page
    }

    /** 直接打开一个（被占位的）外部地址，比如中转页本身。 */
    async function openUrl(url, opts) {
        const page = await browser.newPage()
        await stubExternal(page)
        await h.install(page, SCRIPT, opts)
        await page.goto(url).catch(() => {})   // 立即 replace 时 goto 可能报 aborted，以最终 URL 为准
        return page
    }

    /**
     * 逐个比对 data-expect，返回不一致的列表。
     * data-expect="keep" 要和「改写前」的 href 比 —— 改写后 getAttribute('href') 也变了，
     * 所以先在一个不装脚本的页面里把原始 href 读出来。
     */
    async function mismatches(page, selector = 'a[data-expect]', attr = 'expect') {
        const raw = await browser.newPage()
        await raw.goto(page.url())
        const original = await raw.$$eval(selector, as => as.map(a => a.href))
        await raw.close()
        const actual = await page.$$eval(selector, (as, attr) => as.map(a => ({ text: a.textContent, href: a.href, expect: a.dataset[attr] })), attr)
        return actual
            .map((a, i) => ({ text: a.text, actual: a.href, expected: a.expect === 'keep' ? original[i] : new URL(a.expect).href }))
            .filter(x => x.actual !== x.expected)
    }

    /*
     * 脚本有语法错误时 harness 不会报出来：注入失败只是一条 pageerror，页面照常打开，
     * 后面的用例全挂在「链接没被改写」上，看不出根因。先单独编译一遍。
     */
    await t.test('脚本能编译', async () => {
        new vm.Script(`(function () {\n${fs.readFileSync(SCRIPT, 'utf8')}\n})`, { filename: SCRIPT })
    })

    await t.test('规则解析：静态链接按 data-expect 改写', async () => {
        const page = await open('rules.html')
        t.eq(await mismatches(page), [])
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('规则表里每条规则的首个 host 在 fixtures 里都有样本', async () => {
        const src = fs.readFileSync(SCRIPT, 'utf8')
        const fixture = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.html')).map(f => fs.readFileSync(path.join(FIXTURES, f), 'utf8')).join('\n')
        const firstHosts = [...src.matchAll(/hosts: \['([^']+)'/g)].map(m => m[1])
        t.assert(firstHosts.length >= 20, '规则表没读出来：' + firstHosts.length)
        t.eq(firstHosts.filter(host => !fixture.includes('://' + host + '/') && !fixture.includes('://' + host + '?')), [])
    })

    await t.test('多重编码 / base64 / 中转套中转', async () => {
        const page = await open('encoding.html')
        t.eq(await mismatches(page), [])
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('未编码的目标：& # + 不被外层 URL 解析吃掉', async () => {
        const page = await open('raw.html')
        t.eq(await mismatches(page), [])
        await page.close()
    })

    await t.test('动态插入的链接、后改的 href 都会被改写', async () => {
        const page = await open('dynamic.html')
        const href = id => page.$eval('#' + id, a => a.href)
        t.eq(await href('static'), 'https://example.com/static')

        await page.evaluate(() => window.addOne())
        await page.evaluate(() => window.addBlock())
        await page.evaluate(() => window.swapHref())
        // MutationObserver 回调是微任务，等一轮即可
        await page.waitForFunction(() => document.getElementById('static2').href.startsWith('https://example.com/swapped'), null, { timeout: 2000 })
        t.eq(await href('one'), 'https://example.com/one')
        t.eq(await href('deep'), 'https://example.com/deep')
        t.eq(await href('deep2'), 'https://example.com/deep2')
        t.eq(await href('static2'), 'https://example.com/swapped')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('点击兜底：mousedown 临时改 href 的站点，点击仍然直达', async () => {
        const page = await open('click.html')
        await Promise.all([page.waitForURL('https://example.com/mdown', { timeout: 3000 }), page.click('#mdown')])
        await page.close()
    })

    await t.test('点击兜底：Shadow DOM 里的链接在点击时改写', async () => {
        const page = await open('click.html')
        const inner = page.locator('#card >> #inner')   // locator 自动穿透 open shadow root
        t.assert((await inner.getAttribute('href')).startsWith('https://link.zhihu.com/'), '点击前不该已被改写（否则这条用例测不到兜底）')
        await Promise.all([page.waitForURL('https://example.com/shadow', { timeout: 3000 }), inner.click()])
        await page.close()
    })

    await t.test('点击兜底：站点 window.open(中转地址) 被换成真实地址', async () => {
        const page = await open('click.html')
        const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#wopen')])
        await popup.waitForLoadState()
        t.eq(popup.url(), 'https://example.com/wopen')
        await page.close()
    })

    for (const [name, from, to] of [
        ['知乎', 'https://link.zhihu.com/?target=https%3A//example.com/land?a=1', 'https://example.com/land?a=1'],
        ['QQ middlem', 'https://c.pc.qq.com/middlem.html?pfurl=https%3A%2F%2Fexample.com%2Fqq&pfuin=1', 'https://example.com/qq'],
        ['Bing base64', 'https://www.bing.com/ck/a?!&&p=x&u=a1' + Buffer.from('https://example.com/bing').toString('base64url') + '&ntb=1', 'https://example.com/bing'],
    ]) {
        await t.test(`中转页自动跳转：${name}`, async () => {
            const page = await openUrl(from)
            await page.waitForURL(to, { timeout: 3000 })
            // replace 不留历史：后退应回到打开前的 about:blank，而不是中转页
            await page.goBack().catch(() => {})
            t.eq(page.url(), 'about:blank')
            await page.close()
        })
    }

    for (const [name, url] of [
        ['javascript: 目标', 'https://link.zhihu.com/?target=javascript%3Aalert(document.domain)'],
        ['SegmentFault 只有 enc', 'https://link.segmentfault.com/?enc=AbCdEf%3D%3D.xyz'],
    ]) {
        await t.test(`中转页不跳转：${name}`, async () => {
            const page = await openUrl(url)
            await page.waitForTimeout(500)
            t.eq(page.url(), url)
            t.assert(await page.title() === 'stub', '应该停在站点自己的中转页上')
            await page.close()
        })
    }

    await t.test('去追踪参数：默认只去 utm_*，其余参数编码原样保留', async () => {
        const page = await open('tracking.html')
        t.eq(await mismatches(page), [])
        await page.close()
    })

    await t.test('去追踪参数：开关关掉（GM 存储）时不去', async () => {
        const page = await open('tracking.html', { values: { stripTracking: false } })
        t.eq(await mismatches(page, 'a[data-raw]', 'raw'), [])
        await page.close()
    })

    await t.test('菜单：计数 + 去追踪参数开关可切换并持久化', async () => {
        const page = await open('rules.html')
        const expected = await page.$$eval('a[data-expect]:not([data-expect="keep"])', as => as.length)
        await page.waitForFunction(n => window.__gm.menu.some(m => m && m.caption.includes(`已处理 ${n} 个链接`)), expected, { timeout: 2000 })

        let dialog = ''
        page.once('dialog', d => { dialog = d.message(); d.dismiss() })
        await h.menu(page, '已处理')
        t.assert(dialog.includes(`${expected} 个`) && dialog.includes('知乎：2'), '计数弹窗内容不对：' + dialog)

        t.assert((await h.gm(page)).menu.some(c => c.startsWith('✅ 去追踪参数')), '默认应为开')
        await h.menu(page, '去追踪参数')
        const menu = (await h.gm(page)).menu
        t.assert(menu.some(c => c.startsWith('⬜ 去追踪参数')), '切换后应为关：' + menu.join(' | '))
        t.eq(menu.length, 2, '重注册后菜单项数量不该变')
        t.eq(await page.evaluate(() => localStorage.getItem('__gm:stripTracking')), 'false')
        await page.evaluate(() => localStorage.removeItem('__gm:stripTracking'))
        await page.close()
    })

    await t.test('边界：contenteditable 里的链接不改写（含后插入的、点击时）', async () => {
        const page = await open('edge.html')
        t.eq(await page.$eval('#outside', a => a.href), 'https://example.com/draft')
        await page.evaluate(() => window.typeLink())
        await page.click('#in-editor')   // 点击兜底也不该动编辑器里的链接
        await page.waitForTimeout(100)
        t.assert((await page.$eval('#in-editor', a => a.href)).startsWith('https://link.zhihu.com/'), '编辑器里的链接被改了')
        t.assert((await page.$eval('#typed', a => a.href)).startsWith('https://link.juejin.cn/'), '编辑器里后插入的链接被改了')
        await page.close()
    })

    await t.test('边界：iframe 里照常改写，但只有顶层页面注册菜单', async () => {
        const page = await open('edge.html')
        const frame = page.frame({ url: /rules\.html$/ })
        await frame.waitForLoadState()
        t.eq(await frame.$eval('a', a => a.href), 'https://github.com/foo/bar')
        t.eq(await frame.evaluate(() => window.__gm.menu.length), 0)
        await page.waitForFunction(() => window.__gm.menu.filter(Boolean).length === 2, null, { timeout: 2000 })
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('安全：javascript:/data:/相对地址等目标被拒绝，链接保持原样', async () => {
        const page = await open('unsafe.html')
        t.eq(await mismatches(page), [])
        const hrefs = await page.$$eval('a', as => as.map(a => a.href))
        t.assert(hrefs.every(x => /^https?:/.test(x)), '出现了非 http(s) 的 href：' + hrefs.join(' '))
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    t.done()
    await close()
})()
