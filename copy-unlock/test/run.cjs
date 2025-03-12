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

    await close()
    t.done()
})()
