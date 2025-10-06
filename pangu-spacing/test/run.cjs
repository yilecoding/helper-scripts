/*
 * pangu-spacing 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node pangu-spacing/test/run.cjs
 *
 * 两部分：
 *   1. 文本规则：脚本没有 document 时只导出纯函数，直接在 node 里用 vm 加载、批量比对输入 → 期望输出
 *   2. DOM：页面用 page.route 挂在假域名 https://example.com/ 下（正则匹配），不访问外网
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'pangu-spacing.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://example.com'

const t = h.createRunner('pangu-spacing')

/** 在 node 里加载脚本，拿到导出的纯函数。 */
function loadPure() {
    const sandbox = { module: { exports: {} }, console }
    vm.runInNewContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: SCRIPT })
    return sandbox.module.exports
}

/** 输入 → 期望输出。期望与输入相同的是反例（不该动）。 */
const CASES = [
    // CJK 与字母数字
    ['今天用React写组件', '今天用 React 写组件'],
    ['共有3个', '共有 3 个'],
    ['2026年10月29日', '2026 年 10 月 29 日'],
    ['Hello世界', 'Hello 世界'],
    ['中文English中文', '中文 English 中文'],
    ['在café里', '在 café 里'],
    ['希腊字母α和β', '希腊字母 α 和 β'],
    ['来自Москва的', '来自 Москва 的'],
    // 已有空格
    ['已经有 English 空格', '已经有 English 空格'],
    ['中文 English', '中文 English'],
    // 日文、韩文
    ['日本語のテキストとEnglish', '日本語のテキストと English'],
    ['カタカナTest', 'カタカナ Test'],
    ['한국어English', '한국어 English'],
    ['Seoul서울', 'Seoul 서울'],
    // 扩展区（补充平面）
    ['𠀀字与A', '𠀀字与 A'],
    // 没有 CJK 的整段不动
    ['plain English text', 'plain English text'],
]

async function main() {
    console.log('文本规则')
    const pure = loadPure()
    for (const [input, expected] of CASES) {
        await t.test(`${input} → ${expected}`, () => t.eq(pure.spacing(input), expected))
    }
    await t.test('幂等：处理两遍和一遍一样', () => {
        for (const [input] of CASES) t.eq(pure.spacing(pure.spacing(input)), pure.spacing(input), input)
    })

    const { browser, close } = await h.setup(FIXTURES)

    /** 新开页面（独立 context），把 example.com 的请求映射到 fixtures。 */
    async function open(file, opts = {}) {
        const page = await browser.newPage()
        await page.route(/^https:\/\/example\.com\//, (route) => {
            const url = new URL(route.request().url())
            const name = path.basename(url.pathname) || file
            const fp = path.join(FIXTURES, name)
            if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
            route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
        })
        await h.install(page, SCRIPT, opts)
        await page.goto(`${SITE}/${file}`)
        await page.waitForLoadState('load')
        return page
    }

    const text = (page, sel) => page.$eval(sel, (el) => el.textContent)

    console.log('\nDOM')
    await t.test('页面上的文字被处理，pre / code 不动', async () => {
        const page = await open('basic.html')
        await page.waitForFunction(() => document.getElementById('p1').textContent.includes(' React '))
        t.eq(await text(page, '#p1'), '今天用 React 写了 2 个组件')
        t.eq(await text(page, '#p2'), '已经有空格的 English 不变')
        t.eq(await text(page, '#pre'), '代码里的x=1不动')
        t.eq(await text(page, '#p3 code'), 'npm包')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
