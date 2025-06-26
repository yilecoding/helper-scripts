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

    await close()
    t.done()
})()
