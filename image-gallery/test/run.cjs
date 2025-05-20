/*
 * image-gallery 测试。
 *
 * 运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node image-gallery/test/run.cjs
 *
 * 页面和图片都走 page.route 模拟真实域名，不访问外网：
 *   https://shop.example/<file>         → fixtures/<file>
 *   https://img.example/<W>x<H>/<name>  → 现场生成的 W×H 纯色 PNG
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')
const { png } = require('./png.cjs')

const SCRIPT = path.join(__dirname, '..', 'image-gallery.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const HOST = '#__image-gallery-host'

const t = h.createRunner('image-gallery')
let browser

async function routes(page) {
    await page.route('https://shop.example/**', (route) => {
        const file = path.join(FIXTURES, new URL(route.request().url()).pathname)
        if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' })
        return route.fulfill({ path: file })
    })
    await page.route('https://img.example/**', (route) => {
        const m = new URL(route.request().url()).pathname.match(/^\/(\d+)x(\d+)\//)
        if (!m) return route.fulfill({ status: 404, body: 'not found' })
        return route.fulfill({ status: 200, contentType: 'image/png', body: png(+m[1], +m[2]) })
    })
}

/** 新开一页、注入脚本、打开 fixture。 */
async function openPage(fixture, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await h.install(page, SCRIPT, opts)
    await routes(page)
    await page.goto('https://shop.example/' + fixture)
    return page
}

/** 在画廊的 shadow root 里执行 fn(root, arg)。 */
function inGallery(page, fn, arg) {
    return page.evaluate(([src, hostSel, a]) => {
        const host = document.querySelector(hostSel)
        if (!host) throw new Error('画廊没有打开')
        return new Function('root', 'arg', `return (${src})(root, arg)`)(host.shadowRoot, a)
    }, [fn.toString(), HOST, arg])
}

const isOpen = page => page.evaluate(sel => !!document.querySelector(sel), HOST)
const listedUrls = page => inGallery(page, root => [...root.querySelectorAll('[data-url]')].map(el => el.dataset.url))

async function main() {
    const env = await h.setup(FIXTURES)
    browser = env.browser

    console.log('入口')
    await t.test('注册了菜单命令，菜单能打开画廊', async () => {
        const page = await openPage('basic.html')
        const gm = await h.gm(page)
        t.eq(gm.menu, ['打开图片画廊（Alt+Shift+I）'])
        await h.menu(page, '打开图片画廊')
        t.assert(await isOpen(page), '菜单点了之后画廊应当打开')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('Alt+Shift+I 打开，Esc 关闭，再按一次快捷键又能打开', async () => {
        const page = await openPage('basic.html')
        await page.keyboard.press('Alt+Shift+KeyI')
        t.assert(await isOpen(page), '快捷键应当打开画廊')
        await page.keyboard.press('Escape')
        t.assert(!(await isOpen(page)), 'Esc 应当关闭画廊')
        await page.keyboard.press('Alt+Shift+KeyI')
        t.assert(await isOpen(page), '再次快捷键应当重新打开')
        await page.close()
    })

    await t.test('列出页面里的 <img>，重复的只算一次', async () => {
        const page = await openPage('basic.html')
        await h.menu(page, '打开图片画廊')
        t.eq(await listedUrls(page), [
            'https://img.example/400x300/a.png',
            'https://img.example/640x480/b.png',
            'https://img.example/800x600/c.png',
        ])
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
