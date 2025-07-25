/*
 * dark-mode 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node dark-mode/test/run.cjs
 *
 * 页面都用 page.route 挂在假域名下（https://example.com/...），不访问外网。
 * 用 https 假域名而不是 harness 的 127.0.0.1 静态服务：站点开关以 hostname 为键，
 * 想测的就是真实域名下的行为。拦截要写正则 —— glob 写法对跨源的子域名不好使。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'dark-mode.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://example.com'
const FILTER = 'invert(1) hue-rotate(180deg)'

const t = h.createRunner('dark-mode')

/** 新开一个页面（独立 context，GM 存储互不影响），把假域名的请求映射到 fixtures。 */
async function open(browser, file, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    page.on('console', (m) => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(/^https:\/\/([\w-]+\.)*example\.com\//, (route) => {
        const url = new URL(route.request().url())
        const fp = path.join(FIXTURES, path.basename(url.pathname))
        if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    await h.install(page, SCRIPT, opts)
    await page.goto((opts.site || SITE) + '/' + file)
    return page
}

/** 元素的计算 filter（选择器找不到时抛错，免得断言在 undefined 上「意外通过」）。 */
function filterOf(page, sel) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (!el) throw new Error('找不到元素 ' + sel)
        return getComputedStyle(el).filter
    }, sel)
}

/**
 * 视口里某个点最终画出来的颜色 [r, g, b]：截 1×1 的图，在页面里用离屏 canvas 解码。
 * 离屏 canvas 的像素不受页面 CSS filter 影响，不用另开页面。
 */
async function pixel(page, x, y) {
    const buf = await page.screenshot({ clip: { x, y, width: 1, height: 1 } })
    const rgba = await page.evaluate(async (src) => {
        const img = new Image()
        img.src = src
        await img.decode()
        const c = document.createElement('canvas')
        c.width = c.height = 1
        const g = c.getContext('2d')
        g.drawImage(img, 0, 0)
        return Array.from(g.getImageData(0, 0, 1, 1).data)
    }, 'data:image/png;base64,' + buf.toString('base64'))
    return rgba.slice(0, 3)
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)

    await t.test('开启后 <html> 的计算样式带反色 filter', async () => {
        const page = await open(browser, 'light.html')
        t.eq(await filterOf(page, 'html'), FILTER)
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('图片 / 视频 / 画布 / iframe / svg 里的位图被反转回来，svg 图标本身不反', async () => {
        const page = await open(browser, 'light.html')
        for (const sel of ['#photo', '#clip', '#board', '#frame', '#svgimg']) {
            t.eq(await filterOf(page, sel), FILTER, sel)
        }
        t.eq(await filterOf(page, '#icon'), 'none', 'svg 图标跟着文字一起反色')
        await page.close()
    })

    await t.test('document-start 注入：页面第一段脚本执行时（DOMContentLoaded 之前）filter 已生效', async () => {
        const page = await open(browser, 'light.html')
        await page.waitForFunction(() => window.__dclFilter !== undefined)
        t.eq(await page.evaluate(() => window.__earlyFilter), FILTER)
        t.eq(await page.evaluate(() => window.__dclFilter), FILTER)
        await page.close()
    })

    await t.test('实际画面：白底变黑、正文下方的空白区也是黑的（根背景显式设白）', async () => {
        const page = await open(browser, 'light.html')
        const top = await pixel(page, 700, 10)
        const below = await pixel(page, 400, 560)
        t.assert(top.every((v) => v < 30), `顶部应为黑色，实际 ${top}`)
        t.assert(below.every((v) => v < 30), `正文下方空白应为黑色，实际 ${below}`)
        await page.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
