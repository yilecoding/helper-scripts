/*
 * 划词翻译的端到端测试。不访问外网：所有翻译接口的返回都由 xhr 模拟，格式照真实接口构造。
 *
 * 运行：
 *   NODE_PATH=/path/to/node_modules node translate-selection/test/run.cjs
 */
'use strict'

const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'translate-selection.user.js')
const ICON = 'translate-selection-host .icon'

/** 新开一个页面并装好脚本。xhr 不传时所有请求都返回 500。返回 { page, requests }。 */
async function open(env, { xhr, values } = {}) {
    const page = await env.browser.newPage()
    const requests = []
    await h.install(page, SCRIPT, {
        values,
        xhr: async details => {
            requests.push(details)
            return xhr ? xhr(details) : { status: 500, responseText: '' }
        },
    })
    await page.goto(env.base + '/index.html')
    return { page, requests }
}

/** 用 Range 选中元素的全部文字，然后在选区末端派发 mouseup（可带 altKey）。 */
async function selectText(page, selector, { alt = false } = {}) {
    await page.evaluate(({ selector, alt }) => {
        const el = document.querySelector(selector)
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.right, clientY: r.bottom, altKey: alt }))
    }, { selector, alt })
}

async function main() {
    const env = await h.setup(path.join(__dirname, 'fixtures'))
    const t = h.createRunner('translate-selection')

    await t.test('选中文字后在选区末端旁出现图标', async () => {
        const { page } = await open(env)
        await selectText(page, '#en')
        await page.waitForSelector(ICON, { state: 'visible' })
        const icon = await page.locator(ICON).boundingBox()
        const end = await page.evaluate(() => {
            const r = document.createRange()
            r.selectNodeContents(document.querySelector('#en'))
            const rects = r.getClientRects()
            const last = rects[rects.length - 1]
            return { right: last.right, bottom: last.bottom }
        })
        t.assert(Math.abs(icon.x - end.right) < 20 && Math.abs(icon.y - end.bottom) < 20,
            `图标应贴着选区末端，实际 ${JSON.stringify(icon)}，末端 ${JSON.stringify(end)}`)
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('真实鼠标双击选词也会出图标，点空白处图标消失', async () => {
        const { page } = await open(env)
        await page.dblclick('#word')
        await page.waitForSelector(ICON, { state: 'visible' })
        await page.mouse.click(600, 700)
        await page.waitForSelector(ICON, { state: 'hidden' })
        await page.close()
    })

    await t.test('点图标不会清掉页面选区', async () => {
        const { page } = await open(env)
        await selectText(page, '#en')
        await page.click(ICON)
        t.eq(await page.evaluate(() => window.getSelection().toString()), 'Machine translation has improved a lot in recent years.')
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
