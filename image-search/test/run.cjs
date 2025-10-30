/*
 * image-search 测试。
 *
 * 运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node image-search/test/run.cjs
 *
 * 页面和图片都走 page.route（正则匹配）模拟真实域名，不访问外网：
 *   https://site.example/<file>          → fixtures/<file>
 *   https://img.example/<W>x<H>/<name>   → 现场生成的 W×H 纯色 PNG
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')
const { png } = require('./png.cjs')

const SCRIPT = path.join(__dirname, '..', 'image-search.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const HOST = '#__image-search-host'

const t = h.createRunner('image-search')
let browser

function servePng(route, pathname) {
    const m = pathname.match(/^\/(\d+)x(\d+)\//)
    if (!m) return route.fulfill({ status: 404, body: 'not found' })
    return route.fulfill({ status: 200, contentType: 'image/png', body: png(+m[1], +m[2]) })
}

async function routes(page) {
    await page.route(/^https:\/\/site\.example\//, (route) => {
        const pathname = decodeURIComponent(new URL(route.request().url()).pathname)
        if (/^\/\d+x\d+\//.test(pathname)) return servePng(route, pathname)
        const file = path.join(FIXTURES, pathname)
        if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' })
        return route.fulfill({ path: file })
    })
    await page.route(/^https:\/\/img\.example\//, route => servePng(route, new URL(route.request().url()).pathname))
}

/** 新开一页、注入脚本、打开 fixture。 */
async function openPage(fixture, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    await h.install(page, SCRIPT, opts)
    await routes(page)
    await page.goto('https://site.example/' + fixture)
    return page
}

/** 在菜单的 shadow root 里执行 fn(root, arg)。 */
function inMenu(page, fn, arg) {
    return page.evaluate(([src, hostSel, a]) => {
        const host = document.querySelector(hostSel)
        if (!host) throw new Error('菜单没有打开')
        return new Function('root', 'arg', `return (${src})(root, arg)`)(host.shadowRoot, a)
    }, [fn.toString(), HOST, arg])
}

const isOpen = page => page.evaluate(sel => !!document.querySelector(sel), HOST)

/** 元素中心（或偏移 dx/dy）的视口坐标。 */
async function pointOf(page, sel, dx, dy) {
    const box = await page.locator(sel).boundingBox()
    if (!box) throw new Error('找不到元素 ' + sel)
    return { x: box.x + (dx ?? box.width / 2), y: box.y + (dy ?? box.height / 2) }
}

async function altRightClick(page, sel, dx, dy) {
    const p = await pointOf(page, sel, dx, dy)
    await page.keyboard.down('Alt')
    await page.mouse.click(p.x, p.y, { button: 'right' })
    await page.keyboard.up('Alt')
    return p
}

/** 菜单里列出的引擎 id 与当前的图片地址。 */
const menuState = page => inMenu(page, (root) => {
    const pop = root.querySelector('.pop')
    return { url: pop.dataset.url, engines: [...root.querySelectorAll('[data-engine]')].map(b => b.dataset.engine) }
})
const clickEngine = (page, id) => inMenu(page, (root, i) => root.querySelector(`[data-engine="${i}"]`).click(), id)

const DEFAULT_ENGINES = ['lens', 'bing', 'yandex', 'baidu', 'saucenao', 'tineye', 'iqdb', 'ascii2d', 'tracemoe']

async function main() {
    const env = await h.setup(FIXTURES)
    browser = env.browser

    console.log('触发与关闭')
    await t.test('Alt + 右键图片弹出菜单，列出默认启用的引擎', async () => {
        const page = await openPage('basic.html')
        await altRightClick(page, '#a')
        t.assert(await isOpen(page), '菜单应当打开')
        t.eq(await menuState(page), { url: 'https://img.example/400x300/a.png', engines: DEFAULT_ENGINES })
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('不按 Alt 的右键、Alt + 右键文字都不弹菜单，也不拦页面自己的右键处理', async () => {
        const page = await openPage('basic.html')
        const p = await pointOf(page, '#a')
        await page.mouse.click(p.x, p.y, { button: 'right' })
        t.assert(!(await isOpen(page)), '普通右键不应当弹菜单')
        await altRightClick(page, '#text')
        t.assert(!(await isOpen(page)), '文字上不应当弹菜单')
        t.eq(await page.evaluate(() => window.pageContextMenus), 2, '页面自己的 oncontextmenu 应当照常收到两次')
        await page.close()
    })

    await t.test('页面屏蔽右键时 Alt + 右键照样弹菜单，而且页面的处理器收不到这一次', async () => {
        const page = await openPage('basic.html')
        await altRightClick(page, '#a')
        t.assert(await isOpen(page), '菜单应当打开')
        t.eq(await page.evaluate(() => window.pageContextMenus), 0)
        await page.close()
    })

    await t.test('点引擎：GM_openInTab 收到该引擎的地址，菜单关闭', async () => {
        const page = await openPage('basic.html')
        await altRightClick(page, '#a')
        await clickEngine(page, 'saucenao')
        const gm = await h.gm(page)
        t.eq(gm.opened.map(o => o.url), ['https://saucenao.com/search.php?url=https%3A%2F%2Fimg.example%2F400x300%2Fa.png'])
        t.eq(gm.opened[0].options.active, true, '单个引擎在前台打开')
        t.assert(!(await isOpen(page)), '点完应当关闭菜单')
        await page.close()
    })

    await t.test('Esc 关闭；点菜单里面不关，点外面关', async () => {
        const page = await openPage('basic.html')
        await altRightClick(page, '#a')
        await page.keyboard.press('Escape')
        t.assert(!(await isOpen(page)), 'Esc 应当关闭')

        const p = await altRightClick(page, '#a')
        await page.mouse.click(p.x + 20, p.y + 15)   // 菜单左上角就在鼠标处，往里点一下标题
        t.assert(await isOpen(page), '点菜单里面不应当关闭')
        await page.mouse.click(700, 600)
        t.assert(!(await isOpen(page)), '点外面应当关闭')
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
