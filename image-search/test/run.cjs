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

    console.log('取图片地址')
    const SOURCES = {
        '#srcset': 'https://img.example/1600x1200/l.png',
        '#packed': 'https://img.example/300x300/3x.png',
        '#pic': 'https://img.example/1200x900/p-large.webp',
        '#lazy': 'https://img.example/640x480/lazy.png',
        '#bg': 'https://img.example/500x300/bg.png',
        '#covered': 'https://img.example/400x300/under.png',
        '#rel': 'https://site.example/300x200/rel.png',
        '#shadow': 'https://img.example/350x250/in-shadow.png',
        '#comma': 'https://img.example/c_fill,w_1600/x.png',
    }
    for (const [sel, want] of Object.entries(SOURCES)) {
        await t.test(`${sel} → ${want.replace(/^https:\/\/[^/]+/, '')}`, async () => {
            const page = await openPage('sources.html')
            await altRightClick(page, sel)
            t.assert(await isOpen(page), '菜单应当打开')
            t.eq((await menuState(page)).url, want)
            await page.close()
        })
    }

    await t.test('整页底纹（body 背景）不算图片', async () => {
        const page = await openPage('sources.html')
        await altRightClick(page, '#blank')
        t.assert(!(await isOpen(page)), '空白处不应当弹菜单')
        await page.close()
    })

    console.log('引擎地址 / 全部打开 / 定位')
    // 浏览器规范化之后的地址：路径里的中文、空格转义，query 里的中文转义，#part 被去掉
    const WEIRD = 'https://img.example/300x200/%E5%9B%BE%E7%89%87%20a&b%23c.png?size=%E5%A4%A7&v=1'
    /** 从各引擎的地址里把图片地址取回来，取回来的必须和原地址一字不差。 */
    const EXTRACT = {
        lens: u => u.searchParams.get('url'),
        bing: u => u.searchParams.get('q').replace(/^imgurl:/, ''),
        yandex: u => u.searchParams.get('url'),
        baidu: u => u.searchParams.get('queryImageUrl'),
        sogou: u => u.searchParams.get('query'),
        saucenao: u => u.searchParams.get('url'),
        tineye: u => u.searchParams.get('url'),
        iqdb: u => u.searchParams.get('url'),
        ascii2d: u => decodeURIComponent(u.pathname.replace(/^\/search\/url\//, '')),
        tracemoe: u => u.searchParams.get('url'),
    }

    await t.test('每个引擎的地址：含中文、&、# 的图片地址编码正确，能原样取回', async () => {
        const page = await openPage('edge.html')
        for (const id of DEFAULT_ENGINES) {
            await altRightClick(page, '#weird')
            t.eq((await menuState(page)).url, WEIRD, '菜单里的图片地址')
            await clickEngine(page, id)
        }
        const opened = (await h.gm(page)).opened.map(o => new URL(o.url))
        t.eq(opened.length, DEFAULT_ENGINES.length)
        opened.forEach((u, i) => {
            const id = DEFAULT_ENGINES[i]
            t.eq(EXTRACT[id](u), WEIRD, `${id} 取回的地址`)
            t.eq(u.hash, '', `${id} 的地址不应当带 #（图片地址里的 # 必须被编码）`)
        })
        // 关键几个的原始字符串也钉死，防止「编码两次再解码两次」这种对称错误蒙混过关
        t.eq(opened[0].href, 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(WEIRD))
        t.eq(opened[DEFAULT_ENGINES.indexOf('ascii2d')].href, 'https://ascii2d.net/search/url/' + encodeURIComponent(WEIRD))
        t.eq(opened[1].href, 'https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:' + encodeURIComponent(WEIRD))
        await page.close()
    })

    await t.test('全部打开：每个启用的引擎各开一个后台标签，顺序和菜单一致', async () => {
        const page = await openPage('basic.html')
        await altRightClick(page, '#a')
        t.eq(await inMenu(page, root => root.querySelector('.all').textContent), `全部打开（${DEFAULT_ENGINES.length}）`)
        await inMenu(page, root => root.querySelector('.all').click())
        const opened = (await h.gm(page)).opened
        t.eq(opened.length, DEFAULT_ENGINES.length)
        t.eq(opened.map(o => new URL(o.url).hostname), [
            'lens.google.com', 'www.bing.com', 'yandex.com', 'graph.baidu.com', 'saucenao.com',
            'tineye.com', 'iqdb.org', 'ascii2d.net', 'trace.moe',
        ])
        t.assert(opened.every(o => o.options.active === false), '全部打开应当是后台标签')
        t.assert(!(await isOpen(page)), '点完应当关闭菜单')
        await page.close()
    })

    const popRect = page => inMenu(page, (root) => {
        const pop = root.querySelector('.pop')
        const r = pop.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, flipX: !!pop.dataset.flipX, flipY: !!pop.dataset.flipY }
    })

    await t.test('菜单左上角在鼠标处；贴右下角时翻到鼠标左上方，不出视口', async () => {
        const page = await openPage('edge.html')
        const p1 = await altRightClick(page, '#tl', 30, 30)
        const r1 = await popRect(page)
        t.eq([r1.left, r1.top, r1.flipX, r1.flipY], [p1.x, p1.y, false, false])

        await page.keyboard.press('Escape')
        const p2 = await altRightClick(page, '#br', 100, 80)
        const r2 = await popRect(page)
        t.assert(r2.flipX && r2.flipY, '应当两个方向都翻转')
        t.eq([r2.right, r2.bottom], [p2.x, p2.y], '翻转后右下角对着鼠标')
        t.assert(r2.left >= 8 && r2.top >= 8, `不应当出视口：${JSON.stringify(r2)}`)
        await page.close()
    })

    await t.test('页面滚动时关闭菜单', async () => {
        const page = await openPage('edge.html')
        await page.evaluate(() => { document.body.style.height = '3000px' })
        await altRightClick(page, '#tl')
        await page.mouse.wheel(0, 300)
        await page.waitForFunction(sel => !document.querySelector(sel), HOST)
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
