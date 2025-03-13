/*
 * copy-unlock 测试。运行：
 *   NODE_PATH=/path/to/node_modules node copy-unlock/test/run.cjs
 */
'use strict'

const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'copy-unlock.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')

;(async () => {
    const { browser, base, close } = await h.setup(FIXTURES)
    const t = h.createRunner('copy-unlock')

    /** 新开一个带剪贴板权限的上下文，装好脚本再打开 fixture。 */
    async function open(fixture, opts = {}) {
        const ctx = await browser.newContext()
        await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
        const page = await ctx.newPage()
        await h.install(page, SCRIPT, { values: opts.values })
        await page.goto(base + '/' + fixture)
        return page
    }

    await t.test('普通页面加载无异常', async () => {
        const page = await open('plain.html')
        t.eq(await page.textContent('#text'), '没有任何限制的普通页面。')
        t.eq(h.errors(page).map(String), [])
        await page.context().close()
    })

    const selection = page => page.evaluate(() => getSelection().toString().trim())
    const userSelect = (page, sel) => page.$eval(sel, el => getComputedStyle(el).userSelect)

    await t.test('CSS 禁止选中：三击能选中段落，选区不透明', async () => {
        const page = await open('no-select.html')
        await page.click('#p1', { clickCount: 3 })
        t.eq(await selection(page), '第一段正文，整页被 CSS 禁止选中。')
        const bg = await page.$eval('#p1', el => getComputedStyle(el, '::selection').backgroundColor)
        t.assert(bg !== 'rgba(0, 0, 0, 0)', '::selection 仍是透明：' + bg)
        await page.context().close()
    })

    await t.test('CSS 层不改按钮和输入框', async () => {
        const page = await open('no-select.html')
        t.eq(await userSelect(page, '#btn'), 'none')
        t.eq(await userSelect(page, '#input'), 'none')
        t.eq(await userSelect(page, '#p2'), 'text')
        await page.context().close()
    })

    /** 键盘 Ctrl+C，然后从系统剪贴板读回 { text, html }。 */
    async function copyByKeyboard(page) {
        await page.evaluate(() => navigator.clipboard.writeText('__empty__'))
        await page.keyboard.press('Control+C')
        return page.evaluate(async () => {
            const out = {}
            for (const item of await navigator.clipboard.read()) {
                for (const type of item.types) out[type] = await (await item.getType(type)).text()
            }
            return { text: out['text/plain'], html: out['text/html'] }
        })
    }
    const attrs = (page, sel) => page.$eval(sel, el => el.getAttributeNames().sort())

    await t.test('内联属性：限制属性被移除，正常的 onmousedown 保留', async () => {
        const page = await open('inline-attrs.html')
        t.eq(await attrs(page, 'body'), [])
        t.eq(await attrs(page, '#p1'), ['id'])
        t.eq(await attrs(page, '#p2'), ['id'])
        t.eq(await attrs(page, '#track'), ['href', 'id', 'onmousedown'])
        await page.context().close()
    })

    await t.test('内联属性：异步插入的节点和后来重挂的属性也被清掉', async () => {
        const page = await open('inline-attrs.html')
        await page.waitForFunction(() => window.__rendered)
        await page.evaluate(() => new Promise(r => setTimeout(r, 0)))
        t.eq(await attrs(page, '#p3'), ['id'])
        t.eq(await attrs(page, '#p1'), ['id'])
        await page.click('#p3', { clickCount: 3 })
        t.eq((await copyByKeyboard(page)).text.trim(), '异步插入的段落')
        await page.context().close()
    })

    await close()
    t.done()
})()
