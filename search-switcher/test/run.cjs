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
 */
async function open(browser, url, opts = {}) {
    const page = await browser.newPage()
    await page.route('**/*', (route) => {
        const req = route.request()
        if (req.resourceType() !== 'document') return route.abort()
        const u = new URL(req.url())
        const html = opts.html || fs.readFileSync(path.join(FIXTURES, fixtureFor(u.hostname)), 'utf8')
        return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: html.replace('{{value}}', escapeHtml(opts.value || '')),
        })
    })
    await h.install(page, SCRIPT, { values: opts.values })
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
        }))
    })
}

/** 从切换栏里某个引擎的链接上，按该引擎的参数名把关键词解回来。 */
function keywordIn(href, param) {
    return new URL(href).searchParams.get(param)
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

    await close()
    t.done()
})()
