/*
 * search-switcher 测试。
 *
 * 运行：NODE_PATH=<装了 playwright 的 node_modules> node search-switcher/test/run.cjs
 *
 * 不访问外网：所有请求都被 page.route 拦下，文档请求按域名返回 fixtures 里的模拟结果页，
 * 其余（图片、脚本……）一律 abort。harness 的注入对任何 URL 都生效，
 * 所以 https://www.baidu.com/s?wd=… 这样的真实地址可以直接 goto。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'search-switcher.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const t = h.createRunner('search-switcher')

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function fixtureFor(hostname) {
    if (/baidu\.com$/.test(hostname)) return 'baidu.html'
    if (/^www\.google\./.test(hostname)) return 'google.html'
    return 'generic.html'
}

/**
 * 打开一个「真实地址」的模拟页。
 * opts.value   搜索框里预填的值
 * opts.html    直接指定页面 HTML（覆盖 fixtures）
 * opts.values  GM 存储初始值
 * opts.script  换一份脚本（改了 CONFIG 的副本）
 * opts.init    额外的 init script（在用户脚本之前跑，用来改造页面环境）
 */
async function open(browser, url, opts = {}) {
    const page = await browser.newPage()
    // 挂在 context 上而不是 page 上：Ctrl+点击开出来的新标签也要被拦住
    await page.context().route('**/*', (route) => {
        const req = route.request()
        if (req.resourceType() !== 'document') return route.abort()
        const u = new URL(req.url())
        const html = opts.html || fs.readFileSync(path.join(FIXTURES, fixtureFor(u.hostname)), 'utf8')
        return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: html.replace('{{value}}', escapeHtml(opts.value || '')),
        })
    })
    await h.install(page, opts.script || SCRIPT, { values: opts.values })
    if (opts.init) await page.addInitScript(opts.init)
    await page.goto(url)
    return page
}

/** 读切换栏：[{ id, name, href }]，栏不存在返回 null。 */
function bar(page) {
    return page.evaluate(() => {
        const host = document.getElementById('search-switcher')
        if (!host || !host.shadowRoot) return null
        return Array.from(host.shadowRoot.querySelectorAll('a[data-engine]')).map((a) => ({
            id: a.dataset.engine,
            name: a.textContent,
            href: a.getAttribute('href'),
            current: a.getAttribute('aria-current') === 'page',
        }))
    })
}

/** 从切换栏里某个引擎的链接上，按该引擎的参数名把关键词解回来。 */
function keywordIn(href, param) {
    return new URL(href).searchParams.get(param)
}

/** 改了 CONFIG 某几项的脚本副本，写到系统临时目录（不进仓库）。 */
function scriptWith(config) {
    let src = fs.readFileSync(SCRIPT, 'utf8')
    for (const [k, v] of Object.entries(config)) {
        const re = new RegExp(`(\\n\\s+${k}: )[^,\\n]+,`)
        if (!re.test(src)) throw new Error(`CONFIG 里没有 ${k}`)
        src = src.replace(re, (_, head) => `${head}${JSON.stringify(v)},`)
    }
    const file = path.join(os.tmpdir(), `search-switcher-${process.pid}-${Object.keys(config).join('-')}.user.js`)
    fs.writeFileSync(file, src)
    return file
}

function shadowEval(page, fn, arg) {
    return page.evaluate(([src, arg]) => new Function('root', 'arg', `return (${src})(root, arg)`)(
        document.getElementById('search-switcher').shadowRoot, arg), [fn.toString(), arg])
}

;(async () => {
    const { browser, close } = await h.setup(FIXTURES)

    await t.test('百度结果页出现切换栏，每个链接带着同一个关键词', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=' + encodeURIComponent('油泼面 做法'))
        const links = await bar(page)
        t.assert(links, '切换栏没出现')
        const byId = Object.fromEntries(links.map((l) => [l.id, l.href]))
        t.eq(byId.google, 'https://www.google.com/search?q=%E6%B2%B9%E6%B3%BC%E9%9D%A2%20%E5%81%9A%E6%B3%95')
        t.eq(keywordIn(byId.bing, 'q'), '油泼面 做法')
        t.eq(keywordIn(byId.sogou, 'query'), '油泼面 做法')
        t.eq(keywordIn(byId.yandex, 'text'), '油泼面 做法')
        t.eq(h.errors(page).length, 0, '页面有未捕获异常')
        await page.close()
    })

    await t.test('Google 结果页（google.com.hk）出现切换栏', async () => {
        const page = await open(browser, 'https://www.google.com.hk/search?q=rust+async&hl=zh-CN')
        const links = await bar(page)
        t.assert(links, '切换栏没出现')
        const baidu = links.find((l) => l.id === 'baidu')
        t.eq(keywordIn(baidu.href, 'wd'), 'rust async', '+ 应当按空格解析')
        await page.close()
    })

    await t.test('m.baidu.com 用 word 参数', async () => {
        const page = await open(browser, 'https://m.baidu.com/s?word=%E5%A4%A9%E6%B0%94')
        const links = await bar(page)
        t.eq(keywordIn(links.find((l) => l.id === 'google').href, 'q'), '天气')
        await page.close()
    })

    await t.test('不是结果页 / 没有关键词时不出现', async () => {
        const page = await open(browser, 'https://duckduckgo.com/')
        t.eq(await bar(page), null)
        await page.close()
    })

    /*
     * 每个内置引擎的往返：百度结果页上取到它的链接 → 打开那个链接（模拟页）
     * → 在那一页上解析出的关键词再拼回百度链接 → 必须和原词一致。
     * 一圈下来覆盖了「它的 URL 构造」和「它的关键词解析」两头。
     */
    const NASTY = [
        '中文 关键词',
        'a&b=c',
        'C# 入门',
        'C++ 模板',
        '100% #tag ?x=1',
        '$& $1 $$ 美元',
        'a+b c/d',
    ]

    await t.test('每个内置引擎的关键词解析与 URL 构造（特殊字符往返）', async () => {
        const page = await open(browser, 'about:blank')
        const injected = new Set()
        for (const kw of NASTY) {
            await page.goto('https://www.baidu.com/s?wd=' + encodeURIComponent(kw))
            const links = await bar(page)
            t.assert(links, `百度页上没有切换栏：${kw}`)
            for (const l of links) {
                if (l.id === 'xhs') continue
                await page.goto(l.href)
                const there = await bar(page)
                t.assert(there, `${l.name} 的结果页上没有切换栏（${l.href}）`)
                injected.add(l.id)
                const back = there.find((x) => x.id === 'baidu').href
                t.eq(keywordIn(back, 'wd'), kw, `${l.name} 往返`)
            }
        }
        t.eq(injected.size, 13, '应当有 13 个引擎可注入')
        await page.close()
    })

    await t.test('URL 构造：特殊字符按 encodeURIComponent 编码', async () => {
        const page = await open(browser, 'https://www.bing.com/search?q=' + encodeURIComponent('C++ & C#'))
        const byId = Object.fromEntries((await bar(page)).map((l) => [l.id, l.href]))
        t.eq(byId.baidu, 'https://www.baidu.com/s?wd=C%2B%2B%20%26%20C%23')
        t.eq(byId.douyin, 'https://www.douyin.com/search/C%2B%2B%20%26%20C%23')
        t.eq(byId.github, 'https://github.com/search?q=C%2B%2B%20%26%20C%23&type=repositories')
        t.eq(byId.xhs, 'https://www.xiaohongshu.com/search_result?keyword=C%2B%2B%20%26%20C%23&source=web_search_result_notes')
        await page.close()
    })

    await t.test('抖音：关键词在路径里，路径中的 + 是加号', async () => {
        const page = await open(browser, 'https://www.douyin.com/search/C++%20%E6%95%99%E7%A8%8B?type=general')
        const links = await bar(page)
        t.eq(keywordIn(links.find((l) => l.id === 'baidu').href, 'wd'), 'C++ 教程')
        await page.close()
    })

    await t.test('分组：网页 / 技术 / 视频社区', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=x')
        const groups = await page.evaluate(() =>
            Array.from(document.getElementById('search-switcher').shadowRoot.querySelectorAll('.group')).map((g) => ({
                label: g.querySelector('.label').textContent,
                n: g.querySelectorAll('a').length,
            })),
        )
        t.eq(groups, [{ label: '网页', n: 7 }, { label: '技术', n: 2 }, { label: '视频社区', n: 5 }])
        await page.close()
    })

    await t.test('当前引擎高亮，且只高亮它一个', async () => {
        const page = await open(browser, 'https://cn.bing.com/search?q=hello')
        const cur = (await bar(page)).filter((l) => l.current).map((l) => l.id)
        t.eq(cur, ['bing'])
        const bg = await shadowEval(page, (root) => getComputedStyle(root.querySelector('a[aria-current]')).backgroundColor)
        t.eq(bg, 'rgb(36, 104, 242)', '高亮色')
        await page.close()
    })

    await t.test('亮 / 暗色：按页面背景色判断', async () => {
        const light = await open(browser, 'https://www.google.com/search?q=x')
        t.eq(await shadowEval(light, (root) => root.querySelector('.bar').classList.contains('dark')), false)
        await light.close()
        const dark = await open(browser, 'https://www.google.com/search?q=x', {
            html: '<!doctype html><html><body style="background:#202124;color:#e8eaed"><textarea name="q">x</textarea></body></html>',
        })
        t.eq(await shadowEval(dark, (root) => root.querySelector('.bar').classList.contains('dark')), true)
        await dark.close()
    })

    await t.test('默认贴左侧竖排；CONFIG.layout = top 时是顶部横条', async () => {
        const side = await open(browser, 'https://www.baidu.com/s?wd=x')
        const r1 = await shadowEval(side, (root) => {
            const b = root.querySelector('.bar').getBoundingClientRect()
            return { left: b.left, tall: b.height > b.width }
        })
        t.eq(r1, { left: 0, tall: true })
        await side.close()
        const top = await open(browser, 'https://www.baidu.com/s?wd=x', { script: scriptWith({ layout: 'top' }) })
        const r2 = await shadowEval(top, (root) => {
            const b = root.querySelector('.bar').getBoundingClientRect()
            return { top: b.top, wide: b.width > b.height }
        })
        t.eq(r2, { top: 0, wide: true })
        await top.close()
    })

    await t.test('链接是真正的 <a href>：Ctrl+点击开新标签，原页不动', async () => {
        /*
         * 只断言「开了新页 + 新页请求的地址对」，不等新页加载完：
         * Playwright 1.62 里跨站的新标签被 route.fulfill 接管后永远停在 about:blank
         * （同站的、或 route.continue 的都正常），和脚本无关。
         */
        const page = await open(browser, 'https://www.baidu.com/s?wd=' + encodeURIComponent('新标签'))
        const popup = page.context().waitForEvent('page')
        const req = page.context().waitForEvent('request', (r) => r.url().startsWith('https://www.google.com/'))
        await page.locator('#search-switcher a[data-engine="google"]').click({ modifiers: ['Control'] })
        await popup
        t.eq(new URL((await req).url()).searchParams.get('q'), '新标签')
        t.assert(page.url().startsWith('https://www.baidu.com/s?'), '原页被跳走了')
        await page.close()
    })

    await t.test('普通点击在当前页跳转', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=abc')
        await Promise.all([page.waitForURL('https://www.so.com/**'), page.locator('#search-switcher a[data-engine="so360"]').click()])
        t.eq(new URL(page.url()).searchParams.get('q'), 'abc')
        t.eq((await bar(page)).find((l) => l.current).id, 'so360', '跳过去之后高亮跟着变')
        await page.close()
    })

    /** 切换栏是否可见（host 被 display:none 收起时 bar() 仍能读到链接）。 */
    const visible = (page) => page.evaluate(() => {
        const host = document.getElementById('search-switcher')
        return !!host && host.getClientRects().length > 0 &&
            host.shadowRoot.querySelector('.bar').getBoundingClientRect().width > 0
    })
    const linkKw = async (page, id, param) => keywordIn((await bar(page)).find((l) => l.id === id).href, param)

    await t.test('pushState 换关键词后链接更新（不刷新页面）', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=first')
        await page.evaluate(() => history.pushState({}, '', '/s?wd=' + encodeURIComponent('第二个 词&x')))
        await page.waitForFunction(() => document.getElementById('search-switcher').shadowRoot
            .querySelector('a[data-engine="google"]').href.includes('x'))
        t.eq(await linkKw(page, 'google', 'q'), '第二个 词&x')
        t.eq(await linkKw(page, 'bilibili', 'keyword'), '第二个 词&x')
        await page.evaluate(() => history.replaceState({}, '', '/s?wd=third'))
        await page.waitForTimeout(50)
        t.eq(await linkKw(page, 'google', 'q'), 'third', 'replaceState 也要跟上')
        t.eq(h.errors(page).length, 0)
        await page.close()
    })

    await t.test('只改 hash 换关键词（/s?wd=旧#wd=新）', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=old')
        await page.evaluate(() => { location.hash = 'wd=' + encodeURIComponent('新 词') })
        await page.waitForTimeout(50)
        t.eq(await linkKw(page, 'bing', 'q'), '新 词')
        await page.evaluate(() => { location.hash = 'top' })
        await page.waitForTimeout(50)
        t.eq(await linkKw(page, 'bing', 'q'), 'old', '普通锚点不当参数，回落到 search')
        await page.close()
    })

    await t.test('SPA 离开结果页时收起，后退回来再出现', async () => {
        const page = await open(browser, 'https://github.com/search?q=playwright&type=repositories')
        t.eq(await visible(page), true)
        await page.evaluate(() => history.pushState({}, '', '/microsoft/playwright'))
        await page.waitForTimeout(50)
        t.eq(await visible(page), false, '仓库页上不该还挂着切换栏')
        await page.goBack()
        await page.waitForTimeout(50)
        t.eq(await visible(page), true, '后退回结果页应当重新出现')
        t.eq(await linkKw(page, 'so', 'q'), 'playwright')
        await page.close()
    })

    await t.test('没有 Navigation API 时靠轮询兜底', async () => {
        const page = await open(browser, 'https://www.google.com/search?q=a', {
            init: () => Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }),
        })
        t.eq(await page.evaluate(() => window.navigation), undefined)
        await page.evaluate(() => history.pushState({}, '', '/search?q=polled'))
        await page.waitForFunction(() => document.getElementById('search-switcher').shadowRoot
            .querySelector('a[data-engine="baidu"]').href.endsWith('polled'), null, { timeout: 3000 })
        await page.close()
    })

    await close()
    t.done()
})()
