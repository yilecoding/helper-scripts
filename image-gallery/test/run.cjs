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

const counts = page => inGallery(page, (root) => {
    const d = root.querySelector('.overlay').dataset
    return { total: +d.total, shown: +d.shown, selected: +d.selected }
})
const names = urls => urls.map(u => u.split('/').pop())
const click = (page, sel) => inGallery(page, (root, s) => root.querySelector(s).click(), sel)

/** 改 <input type=range> / <select> 的值并派发事件，和用户拖动一样。 */
const setControl = (page, sel, value, type = 'input') => inGallery(page, (root, [s, v, ty]) => {
    const el = root.querySelector(s)
    el.value = v
    el.dispatchEvent(new Event(ty, { bubbles: true }))
}, [sel, value, type])

const viewer = page => inGallery(page, (root) => {
    const v = root.querySelector('.viewer')
    if (v.hidden) return null
    const d = v.dataset
    return { index: +d.index, url: d.url.split('/').pop(), mode: d.mode, rot: +d.rot, scale: +d.scale, tx: +d.tx, ty: +d.ty }
})
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps

/** 点「下载选中」并等这一轮跑完，返回进度条上的统计。 */
async function download(page) {
    await click(page, '.download')
    await page.waitForFunction((sel) => {
        const dl = document.querySelector(sel).shadowRoot.querySelector('.dl')
        return dl.dataset.state === 'finished'
    }, HOST, { timeout: 15000 })
    return inGallery(page, (root) => {
        const d = root.querySelector('.dl').dataset
        return { total: +d.total, done: +d.done, failed: +d.failed, peak: +d.peak }
    })
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

    console.log('画廊网格')
    await t.test('网格展示正确数量，每张标尺寸；页面全局样式进不来', async () => {
        const page = await openPage('gallery.html')
        await openGallery(page)
        t.eq(await counts(page), { total: 6, shown: 6, selected: 0 })
        const card = await inGallery(page, (root) => {
            const c = root.querySelector('.card[data-url$="g2.png"]')
            return { size: c.querySelector('.size').textContent, imgBorder: getComputedStyle(c.querySelector('img')).borderTopWidth }
        })
        t.eq(card, { size: '1600×1200', imgBorder: '0px' })
        await page.close()
    })

    await t.test('勾选 / 全选 / 反选', async () => {
        const page = await openPage('gallery.html')
        await openGallery(page)
        await click(page, '.card[data-url$="g1.png"] .check')
        await click(page, '.card[data-url$="g3.png"] .check')
        t.eq((await counts(page)).selected, 2)
        await click(page, '.invert')
        t.eq((await counts(page)).selected, 4)
        t.assert(!(await inGallery(page, root => root.querySelector('.card[data-url$="g1.png"] .check').checked)), '反选后 g1 应当取消')
        await click(page, '.select-all')
        t.eq((await counts(page)).selected, 6)
        await page.close()
    })

    await t.test('尺寸滑块按最小边过滤，全选只作用于显示的', async () => {
        const page = await openPage('gallery.html')
        await openGallery(page)
        const range = await inGallery(page, root => ({ min: root.querySelector('.min-side').min, max: root.querySelector('.min-side').max }))
        t.eq(range, { min: '100', max: '1200' })
        await setControl(page, '.min-side', '500')
        t.eq(names(await listedUrls(page)), ['g2.png', 'g3.png', 'g5.png'])
        await click(page, '.select-all')
        t.eq(await counts(page), { total: 6, shown: 3, selected: 3 })
        await setControl(page, '.min-side', '100')
        t.eq(await counts(page), { total: 6, shown: 6, selected: 3 })
        await page.close()
    })

    await t.test('按面积排序', async () => {
        const page = await openPage('gallery.html')
        await openGallery(page)
        await setControl(page, '.sort', 'area-desc', 'change')
        t.eq(names(await listedUrls(page)), ['g2.png', 'g3.png', 'g4.png', 'g5.png', 'g6.png', 'g1.png'])
        await setControl(page, '.sort', 'area-asc', 'change')
        t.eq(names(await listedUrls(page)), ['g1.png', 'g6.png', 'g5.png', 'g4.png', 'g3.png', 'g2.png'])
        await setControl(page, '.sort', 'dom', 'change')
        t.eq(names(await listedUrls(page)), ['g1.png', 'g2.png', 'g3.png', 'g4.png', 'g5.png', 'g6.png'])
        await page.close()
    })

    console.log('查看器')
    await t.test('点缩略图进入大图，适应窗口；←/→ 切换并循环', async () => {
        const page = await openPage('gallery.html')
        await openGallery(page)
        await click(page, '.card[data-url$="g2.png"] img')
        let v = await viewer(page)
        // 舞台 1280×800，留 5% 边：min(1216/1600, 760/1200)
        t.eq([v.index, v.url, v.mode, v.rot, v.tx, v.ty], [1, 'g2.png', 'fit', 0, 0, 0])
        t.assert(near(v.scale, 760 / 1200, 1e-3), `适应窗口的比例不对：${v.scale}`)
        await page.keyboard.press('ArrowRight')
        t.eq((await viewer(page)).url, 'g3.png')
        await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('ArrowLeft')
        t.eq((await viewer(page)).url, 'g1.png')
        await page.keyboard.press('ArrowLeft')
        t.eq((await viewer(page)).url, 'g6.png', '第一张再往前应当回到最后一张')
        await page.keyboard.press('ArrowRight')
        t.eq((await viewer(page)).index, 0)
        // 小图适应窗口时不放大
        t.eq((await viewer(page)).scale, 1)
        await page.close()
    })

    await t.test('滚轮以鼠标位置为中心缩放：鼠标下的图内点不动', async () => {
        const page = await openPage('gallery.html')
        await openGallery(page)
        await click(page, '.card[data-url$="g2.png"] img')
        const before = await viewer(page)
        const m = { x: 900, y: 250 } // 舞台中心是 (640, 400)
        const local = v => [(m.x - 640 - v.tx) / v.scale, (m.y - 400 - v.ty) / v.scale]
        await page.mouse.move(m.x, m.y)
        await page.mouse.wheel(0, -100)
        await page.waitForTimeout(50)
        const after = await viewer(page)
        t.assert(near(after.scale, before.scale * 1.2, 1e-3), `一格滚轮应当放大 1.2 倍：${before.scale} → ${after.scale}`)
        t.eq(after.mode, 'free')
        const [a, b] = [local(before), local(after)]
        t.assert(near(a[0], b[0], 0.05) && near(a[1], b[1], 0.05), `鼠标下的图内坐标变了：${a} → ${b}`)
        await page.mouse.wheel(0, 200)
        await page.waitForTimeout(50)
        t.assert(near((await viewer(page)).scale, before.scale / 1.2, 1e-3), '往回滚两格应当缩小')
        await page.close()
    })

    await t.test('拖拽平移、R 旋转、双击在适应 / 原始尺寸间切换、Esc 先退查看器再关画廊', async () => {
        const page = await openPage('gallery.html')
        await openGallery(page)
        await click(page, '.card[data-url$="g2.png"] img')
        await page.mouse.move(600, 400)
        await page.mouse.down()
        await page.mouse.move(650, 380, { steps: 3 })
        await page.mouse.up()
        let v = await viewer(page)
        t.eq([v.tx, v.ty], [50, -20])

        await page.keyboard.press('r')
        v = await viewer(page)
        t.eq(v.rot, 90)
        await page.keyboard.press('Shift+R')
        t.eq((await viewer(page)).rot, 0)

        await page.keyboard.press('0') // 回到适应窗口
        await page.keyboard.press('r')
        v = await viewer(page)
        // 适应模式下旋转 90° 宽高互换重新适应：min(1216/1200, 760/1600)
        t.eq([v.mode, v.rot], ['fit', 90])
        t.assert(near(v.scale, 760 / 1600, 1e-3), `旋转后适应比例不对：${v.scale}`)

        await page.mouse.dblclick(640, 400)
        v = await viewer(page)
        t.eq([v.mode, v.scale], ['original', 1])
        await page.mouse.dblclick(640, 400)
        v = await viewer(page)
        t.eq([v.mode, v.tx, v.ty], ['fit', 0, 0])

        await page.keyboard.press('Escape')
        t.eq(await viewer(page), null)
        t.assert(await isOpen(page), '第一次 Esc 只退出查看器')
        await page.keyboard.press('Escape')
        t.assert(!(await isOpen(page)), '第二次 Esc 关闭画廊')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    console.log('批量下载')
    await t.test('只下载勾选且显示的；文件名 = 站点_序号.扩展名；并发不超过 3', async () => {
        const page = await openPage('gallery.html')
        await openGallery(page)
        t.assert(await inGallery(page, root => root.querySelector('.download').disabled), '没勾选时下载按钮应当禁用')
        await click(page, '.select-all')
        await setControl(page, '.min-side', '150') // 隐藏 g6（120×400）
        const st = await download(page)
        t.eq(st, { total: 5, done: 5, failed: 0, peak: 3 })
        const gm = await h.gm(page)
        t.eq(gm.downloads.map(d => [d.url.split('/').pop(), d.name]), [
            ['g1.png', 'shop.example_001.png'],
            ['g2.png', 'shop.example_002.png'],
            ['g3.png', 'shop.example_003.png'],
            ['g4.png', 'shop.example_004.png'],
            ['g5.png', 'shop.example_005.png'],
        ])
        await page.close()
    })

    await t.test('扩展名：大小写 / query 格式参数 / 图床后缀 / 编码文件名 / data: MIME / 推不出时兜底', async () => {
        const page = await openPage('download.html')
        await openGallery(page)
        await click(page, '.select-all')
        await download(page)
        const gm = await h.gm(page)
        t.eq(gm.downloads.map(d => d.name), [
            'shop.example_001.jpg',
            'shop.example_002.webp',
            'shop.example_003.png',
            'shop.example_004.jpg',
            'shop.example_005.gif',
            'shop.example_006.jpg', // render.php：.php 不是图片扩展名，兜底 jpg
            'shop.example_007.png', // data:image/png
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
