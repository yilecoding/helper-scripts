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

    await t.test('URL 是 GBK 编码（解出 �）时退到搜索框', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=%C4%E3%BA%C3', { value: '你好' })
        t.eq(await linkKw(page, 'google', 'q'), '你好')
        await page.close()
    })

    await t.test('URL 里没有关键词时退到搜索框（input / textarea）', async () => {
        const p1 = await open(browser, 'https://www.baidu.com/s?ie=utf-8&tn=x', { value: ' 来自 输入框 ' })
        t.eq(await linkKw(p1, 'bing', 'q'), '来自 输入框')
        await p1.close()
        const p2 = await open(browser, 'https://www.google.com/search?q=', { value: 'textarea & 词' })
        t.eq(await linkKw(p2, 'baidu', 'wd'), 'textarea & 词')
        await p2.close()
    })

    await t.test('搜索框晚渲染（SPA）也能等到', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?tn=late', {
            html: `<!doctype html><html><body><script>
                setTimeout(() => { const i = document.createElement('input'); i.id = 'kw'; i.value = '晚到的词'; document.body.appendChild(i) }, 800)
            </script></body></html>`,
        })
        t.eq(await bar(page), null)
        await page.waitForFunction(() => document.getElementById('search-switcher'), null, { timeout: 3000 })
        t.eq(await linkKw(page, 'google', 'q'), '晚到的词')
        await page.close()
    })

    await t.test('URL 里有词时以 URL 为准，不读搜索框', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=url', { value: '框里改了没提交' })
        t.eq(await linkKw(page, 'google', 'q'), 'url')
        await page.close()
    })

    await t.test('Alt+数字切换引擎（按显示顺序，Alt+0 是第 10 个）', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=' + encodeURIComponent('快捷 键'))
        const links = await bar(page)
        t.eq(links[1].id, 'google')
        t.eq(await shadowEval(page, (root) => root.querySelector('a[data-engine="google"]').title), 'Alt+2')
        await Promise.all([page.waitForURL('https://www.google.com/**'), page.keyboard.press('Alt+2')])
        t.eq(new URL(page.url()).searchParams.get('q'), '快捷 键')
        await Promise.all([page.waitForURL('https://www.zhihu.com/**'), page.keyboard.press('Alt+0')])
        t.eq(links[9].id, 'zhihu')
        t.eq(new URL(page.url()).searchParams.get('q'), '快捷 键')
        await page.close()
    })

    await t.test('输入框 / textarea / contenteditable 聚焦时 Alt+数字不触发', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=stay', {
            html: '<!doctype html><html><body><input id="kw" value="stay"><textarea id="ta"></textarea><div id="ce" contenteditable="true">x</div><button id="btn">b</button></body></html>',
        })
        for (const sel of ['#kw', '#ta', '#ce']) {
            await page.focus(sel)
            await page.keyboard.press('Alt+2')
            await page.waitForTimeout(200)
            t.assert(page.url().startsWith('https://www.baidu.com/s?wd=stay'), `${sel} 里按 Alt+2 跳走了`)
        }
        // 焦点在按钮上不算打字，应该照常触发
        await page.focus('#btn')
        await Promise.all([page.waitForURL('https://www.google.com/**'), page.keyboard.press('Alt+2')])
        await page.close()
    })

    await t.test('不带 Alt、或 Ctrl+Alt（AltGr）时不触发', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=stay')
        for (const k of ['2', 'Control+Alt+2', 'Alt+Shift+2']) {
            await page.keyboard.press(k)
            await page.waitForTimeout(150)
            t.assert(page.url().startsWith('https://www.baidu.com/'), `${k} 不该触发`)
        }
        await page.close()
    })

    const editor = {
        textarea: (page) => page.locator('#search-switcher-editor textarea'),
        error: (page) => page.locator('#search-switcher-editor .err').textContent(),
        isOpen: (page) => page.evaluate(() => !!document.getElementById('search-switcher-editor')),
        click: (page, act) => page.locator(`#search-switcher-editor button[data-act="${act}"]`).click(),
    }
    const stored = (page) => page.evaluate(() => {
        const raw = localStorage.getItem('__gm:engines')
        return raw === null ? null : JSON.parse(raw)
    })

    await t.test('菜单：编辑引擎列表 / 恢复默认引擎', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=x')
        const gm = await h.gm(page)
        t.eq(gm.menu, ['编辑引擎列表', '恢复默认引擎', '切换布局（侧边竖排 / 顶部横条）'])
        await h.menu(page, '编辑引擎列表')
        const list = JSON.parse(await editor.textarea(page).inputValue())
        t.eq(list.length, 14)
        t.eq(list[0], { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=%s', group: '网页' })
        await editor.click(page, 'cancel')
        t.eq(await editor.isOpen(page), false)
        await page.close()
    })

    const CUSTOM = [
        { id: 'google', name: '谷歌', url: 'https://www.google.com.hk/search?q=%s', group: '网页' },
        { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=%s' },
        { name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s', group: '视频' },
        { name: 'MDN', url: 'https://developer.mozilla.org/zh-CN/search?q=%s' },
    ]

    await t.test('自定义引擎：保存后立即生效，刷新后仍在', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=' + encodeURIComponent('a&b c'))
        await h.menu(page, '编辑引擎列表')
        await editor.textarea(page).fill(JSON.stringify(CUSTOM, null, 2))
        await editor.click(page, 'save')
        t.eq(await editor.isOpen(page), false, '保存成功应当关闭浮层')
        const check = async () => {
            const links = await bar(page)
            t.eq(links.map((l) => l.name), ['谷歌', '百度', 'YouTube', 'MDN'])
            t.eq(links.map((l) => l.id), ['google', 'baidu', 'custom-1', 'custom-2'])
            t.eq(links[0].href, 'https://www.google.com.hk/search?q=a%26b%20c')
            t.eq(keywordIn(links[2].href, 'search_query'), 'a&b c')
            t.eq(links.find((l) => l.current).id, 'baidu', '内置引擎改了名/模板，识别规则还在')
            const groups = await shadowEval(page, (root) => Array.from(root.querySelectorAll('.label')).map((l) => l.textContent))
            t.eq(groups, ['网页', '视频', '自定义'], '分组按首次出现排序；没写 group 的自定义项归「自定义」')
        }
        await check()
        await page.reload()
        await check()
        t.eq((await stored(page)).list.length, 4)
        t.eq((await stored(page)).known.length, 14, '保存时记下当时认识的内置 id')
        t.eq(h.errors(page).length, 0)
        await page.close()
    })

    await t.test('非法输入被拒绝：浮层不关、存储不变、给出原因', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=x')
        await h.menu(page, '编辑引擎列表')
        const cases = [
            ['[{"name": "坏", "url": "https://x.com/?q=%s",}]', /JSON 格式错误/],
            ['{"name": "x"}', /最外层必须是数组/],
            ['[]', /至少要保留一个引擎/],
            ['[{"url": "https://x.com/?q=%s"}]', /第 1 项：缺少 name/],
            ['[{"name": "a", "url": "https://a.com/?q=%s"}, {"name": "b", "url": "https://b.com/"}]', /第 2 项（b）：url 里要有 %s/],
            ['[{"name": "xss", "url": "javascript:alert(1)//%s"}]', /http:\/\/ 或 https:\/\//],
            ['[{"name": "a", "url": "https://a.com/?q=%s", "grp": "网页"}]', /不认识的字段 grp/],
            ['[{"id": "baidu", "name": "a", "url": "https://a.com/?q=%s"}, {"id": "baidu", "name": "b", "url": "https://b.com/?q=%s"}]', /id「baidu」重复/],
        ]
        for (const [text, re] of cases) {
            await editor.textarea(page).fill(text)
            await editor.click(page, 'save')
            const msg = await editor.error(page)
            t.assert(re.test(msg), `输入 ${text}\n      期望错误 ${re}，实际「${msg}」`)
            t.eq(await editor.isOpen(page), true)
        }
        t.eq(await stored(page), null, '非法输入不该写进存储')
        t.eq((await bar(page)).length, 14)
        await page.close()
    })

    await t.test('恢复默认：清掉存储，刷新后也是默认', async () => {
        /*
         * 不用 install 的 opts.values 预置：harness 在每次导航时都会把「缺失的」初始值补回去，
         * 删掉之后一刷新又回来了，测不了「删除后刷新」。改成直接写存储再刷新。
         */
        const page = await open(browser, 'https://www.baidu.com/s?wd=x')
        await page.evaluate((v) => localStorage.setItem('__gm:engines', JSON.stringify(v)), { list: CUSTOM, known: [] })
        await page.reload()
        t.eq((await bar(page)).length, 4 + 12, '预置的自定义列表生效（known 为空 = 其余 12 个内置都算新来的，追加在后）')
        await h.menu(page, '编辑引擎列表')
        await editor.click(page, 'reset')
        t.eq(JSON.parse(await editor.textarea(page).inputValue()).length, 14, '编辑框也跟着回到默认')
        t.eq((await bar(page)).length, 14)
        t.eq(await stored(page), null)
        await editor.click(page, 'cancel')
        await page.reload()
        t.eq((await bar(page)).length, 14)
        await page.close()
    })

    await t.test('菜单「恢复默认引擎」要先确认（顺带：老版本存的裸数组照样能读）', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=x', { values: { engines: CUSTOM } })
        t.eq((await bar(page)).length, 4)
        page.once('dialog', (d) => d.dismiss())
        await h.menu(page, '恢复默认引擎')
        t.eq((await bar(page)).length, 4, '取消确认不该清')
        page.once('dialog', (d) => d.accept())
        await h.menu(page, '恢复默认引擎')
        t.eq((await bar(page)).length, 14)
        await page.close()
    })

    await t.test('存储被改坏时回落默认，不让切换栏消失', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=x', { values: { engines: [{ name: 1 }] } })
        t.eq((await bar(page)).length, 14)
        await page.close()
    })

    await t.test('编辑框里打字不被页面的全局快捷键抢走（如按 / 聚焦搜索框）', async () => {
        const page = await open(browser, 'https://www.google.com/search?q=x', {
            html: `<!doctype html><html><body><textarea name="q">x</textarea><script>
                document.addEventListener('keydown', (e) => {
                    const t = e.target
                    if (e.key === '/' && t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') {
                        e.preventDefault(); document.querySelector('textarea[name=q]').focus()
                    }
                })
            </script></body></html>`,
        })
        await h.menu(page, '编辑引擎列表')
        await editor.textarea(page).fill('')
        await page.keyboard.type('[{"name":"a","url":"https://a.com/s?q=%s"}]')
        t.eq(await editor.textarea(page).inputValue(), '[{"name":"a","url":"https://a.com/s?q=%s"}]')
        await page.keyboard.press('Alt+1')
        t.eq(page.url(), 'https://www.google.com/search?q=x', '编辑框里按 Alt+数字也不该跳')
        await page.keyboard.press('Escape')
        t.eq(await editor.isOpen(page), false, 'Esc 关闭')
        await page.close()
    })

    await t.test('隐藏内置引擎：不显示、编辑框里还在、快捷键序号跳过它', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=x')
        await h.menu(page, '编辑引擎列表')
        const list = JSON.parse(await editor.textarea(page).inputValue())
        list.find((e) => e.id === 'google').hidden = true
        list.find((e) => e.id === 'yandex').hidden = true
        await editor.textarea(page).fill(JSON.stringify(list))
        await editor.click(page, 'save')
        const ids = (await bar(page)).map((l) => l.id)
        t.eq(ids.length, 12)
        t.assert(!ids.includes('google') && !ids.includes('yandex'), '隐藏的还在显示')
        t.eq(await shadowEval(page, (root) => root.querySelector('a[data-engine="bing"]').title), 'Alt+2', 'google 隐藏后 bing 排第 2')
        await page.reload()
        t.eq((await bar(page)).length, 12)
        await h.menu(page, '编辑引擎列表')
        const again = JSON.parse(await editor.textarea(page).inputValue())
        t.eq(again.length, 14)
        t.eq(again.find((e) => e.id === 'google'), { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', group: '网页', hidden: true })
        t.eq('hidden' in again.find((e) => e.id === 'bing'), false, '没隐藏的不写 hidden 字段')
        await editor.textarea(page).fill(JSON.stringify(again.map((e) => ({ ...e, hidden: true }))))
        await editor.click(page, 'save')
        t.assert(/不能全部隐藏/.test(await editor.error(page)))
        await editor.textarea(page).fill('[{"name":"a","url":"https://a.com/?q=%s","hidden":"yes"}]')
        await editor.click(page, 'save')
        t.assert(/hidden 只能是 true 或 false/.test(await editor.error(page)))
        await page.close()
    })

    await t.test('删掉的内置引擎不会回来；新版本新增的内置引擎自动追加', async () => {
        const all = (await (async () => {
            const p = await open(browser, 'https://www.baidu.com/s?wd=x')
            await h.menu(p, '编辑引擎列表')
            const v = JSON.parse(await editor.textarea(p).inputValue())
            await p.close()
            return v
        })())
        // 模拟：用户在「还没有抖音」的旧版本里保存过，并且删掉了 Yandex
        const list = all.filter((e) => e.id !== 'douyin' && e.id !== 'yandex')
        const known = all.map((e) => e.id).filter((id) => id !== 'douyin')
        const page = await open(browser, 'https://www.baidu.com/s?wd=x', { values: { engines: { list, known } } })
        const ids = (await bar(page)).map((l) => l.id)
        t.eq(ids.includes('yandex'), false, '用户删掉的 Yandex 回来了')
        t.eq(ids[ids.length - 1], 'douyin', '新增的抖音应当追加在末尾')
        await page.close()
    })

    await t.test('菜单切换布局，刷新后保持', async () => {
        const page = await open(browser, 'https://www.baidu.com/s?wd=x')
        const cls = () => shadowEval(page, (root) => root.querySelector('.bar').className)
        t.assert(/\bside\b/.test(await cls()))
        await h.menu(page, '切换布局')
        t.assert(/\btop\b/.test(await cls()), '切换后应当是顶部横条')
        await page.reload()
        t.assert(/\btop\b/.test(await cls()), '刷新后应当保持')
        await h.menu(page, '切换布局')
        t.assert(/\bside\b/.test(await cls()))
        await page.close()
    })

    await close()
    t.done()
})()
