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
        const pathname = new URL(route.request().url()).pathname
        // 相对地址的图片（<img src="300x200/a.png">）也落在 shop.example 上
        if (/^\/\d+x\d+\//.test(pathname)) return servePng(route, pathname)
        const file = path.join(FIXTURES, pathname)
        if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' })
        return route.fulfill({ path: file })
    })
    await page.route('https://img.example/**', route => servePng(route, new URL(route.request().url()).pathname))
}

function servePng(route, pathname) {
    const m = pathname.match(/^\/(\d+)x(\d+)\//)
    if (!m) return route.fulfill({ status: 404, body: 'not found' })
    return route.fulfill({ status: 200, contentType: 'image/png', body: png(+m[1], +m[2]) })
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

/** 用菜单打开画廊，等尺寸探测跑完。 */
async function openGallery(page) {
    await h.menu(page, '打开图片画廊')
    await page.waitForFunction(sel => {
        const host = document.querySelector(sel)
        const ov = host && host.shadowRoot.querySelector('.overlay')
        return ov && ov.dataset.state === 'ready'
    }, HOST, { timeout: 15000 })
}

const isOpen = page => page.evaluate(sel => !!document.querySelector(sel), HOST)
const listedUrls = page => inGallery(page, root => [...root.querySelectorAll('[data-url]')].map(el => el.dataset.url))
const listedSizes = page => inGallery(page, root => Object.fromEntries(
    [...root.querySelectorAll('[data-url]')].map(el => [el.dataset.url.replace('https://img.example/', ''), `${el.dataset.w}x${el.dataset.h}`])))

async function main() {
    const env = await h.setup(FIXTURES)
    browser = env.browser

    console.log('入口')
    await t.test('注册了菜单命令，菜单能打开画廊', async () => {
        const page = await openPage('basic.html')
        const gm = await h.gm(page)
        t.eq(gm.menu, ['打开图片画廊（Alt+Shift+I）'])
        await openGallery(page)
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
        await openGallery(page)
        t.eq(await listedUrls(page), [
            'https://img.example/400x300/a.png',
            'https://img.example/640x480/b.png',
            'https://img.example/800x600/c.png',
        ])
        await page.close()
    })

    console.log('收集 <img>')
    await t.test('srcset / <picture> 取最大、懒加载属性、相对地址规范化去重', async () => {
        const page = await openPage('img.html')
        await openGallery(page)
        t.eq(await listedUrls(page), [
            'https://img.example/800x600/s-large.png',
            'https://shop.example/600x400/x2.png',
            'https://img.example/1200x900/p-large.png',
            'https://img.example/500x400/lazy-src.png',
            'https://img.example/510x400/lazy-original.png',
            'https://img.example/520x400/lazy-lazysrc.png',
            'https://img.example/520x400/ls-2.png',
            'https://shop.example/320x240/rel.png',
        ])
        await page.close()
    })

    console.log('收集背景图 / 链接 / shadow DOM')
    await t.test('只收可见元素的背景图，链接按扩展名判断，钻进 open shadow DOM', async () => {
        const page = await openPage('more.html')
        await openGallery(page)
        const urls = await listedUrls(page)
        t.eq([...urls].sort(), [
            'https://img.example/1024x768/link.jpg',
            'https://img.example/700x500/bg-visible.png',
            'https://img.example/710x500/bg-multi.png',
            'https://img.example/730x500/shadow-bg.png',
            'https://img.example/740x500/shadow-img.png',
            'https://img.example/750x500/nested-bg.png',
            'https://img.example/900x700/link-query.png?token=1',
        ])
        await page.close()
    })

    console.log('尺寸与小图过滤')
    await t.test('宽或高 < 100 的、1×1 data: 像素、坏图都被过滤；尺寸是真图的尺寸', async () => {
        const page = await openPage('sizes.html')
        await openGallery(page)
        t.eq(await listedSizes(page), {
            '400x300/big.png': '400x300',
            '100x100/edge.png': '100x100',
            '640x480/lazy.png': '640x480',
            '1500x1000/ss-big.png': '1500x1000',
            '1600x1200/full.png': '1600x1200',
        })
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
