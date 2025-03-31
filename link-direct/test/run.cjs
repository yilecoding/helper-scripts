'use strict'
/*
 * 外链直达的测试。运行：
 *   NODE_PATH=/path/to/node_modules node link-direct/test/run.cjs
 */
const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'link-direct.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')

;(async () => {
    const { browser, base, close } = await h.setup(FIXTURES)
    const t = h.createRunner('link-direct')

    async function open(file, opts) {
        const page = await browser.newPage()
        await h.install(page, SCRIPT, opts)
        await page.goto(base + '/' + file)
        return page
    }

    /**
     * 逐个比对 data-expect，返回不一致的列表。
     * data-expect="keep" 要和「改写前」的 href 比 —— 改写后 getAttribute('href') 也变了，
     * 所以先在一个不装脚本的页面里把原始 href 读出来。
     */
    async function mismatches(page, selector = 'a[data-expect]') {
        const raw = await browser.newPage()
        await raw.goto(page.url())
        const original = await raw.$$eval(selector, as => as.map(a => a.href))
        await raw.close()
        const actual = await page.$$eval(selector, as => as.map(a => ({ text: a.textContent, href: a.href, expect: a.dataset.expect })))
        return actual
            .map((a, i) => ({ text: a.text, actual: a.href, expected: a.expect === 'keep' ? original[i] : new URL(a.expect).href }))
            .filter(x => x.actual !== x.expected)
    }

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
