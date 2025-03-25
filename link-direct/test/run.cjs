'use strict'
/*
 * 外链直达的测试。运行：
 *   NODE_PATH=/path/to/node_modules node link-direct/test/run.cjs
 */
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

    /** 逐个比对 data-expect，返回不一致的列表。 */
    function mismatches(page, selector = 'a[data-expect]') {
        return page.$$eval(selector, as => as.map(a => {
            const exp = a.dataset.expect === 'keep' ? new URL(a.getAttribute('href'), location.href).href : new URL(a.dataset.expect).href
            return { text: a.textContent, actual: a.href, expected: exp }
        }).filter(x => x.actual !== x.expected))
    }

    await t.test('规则解析：静态链接按 data-expect 改写', async () => {
        const page = await open('rules.html')
        t.eq(await mismatches(page), [])
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    t.done()
    await close()
})()
