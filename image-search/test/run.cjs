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
    // 兜底：没有专门模拟的地址一律中断，保证测试不会碰到外网（后注册的 route 优先）
    await page.route(/.*/, route => route.abort())
    await page.route(/^https:\/\/site\.example\//, (route) => {
        const pathname = decodeURIComponent(new URL(route.request().url()).pathname)
        if (/^\/\d+x\d+\//.test(pathname)) return servePng(route, pathname)
        // 要登录的图：带 session cookie 才给图，否则 200 一个登录页（很多站就是这么干的）
        if (pathname.startsWith('/private/')) {
            if (/(^|;\s*)session=ok/.test(route.request().headers().cookie || '')) return servePng(route, pathname.slice(8))
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<form>请先登录</form>' })
        }
        const file = path.join(FIXTURES, pathname)
        if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' })
        return route.fulfill({ path: file })
    })
    await page.route(/^https:\/\/img\.example\//, route => servePng(route, new URL(route.request().url()).pathname))
    // 内网地址：只让页面上的 <img> 能显示出来，脚本取字节走的是 GM_xmlhttpRequest（由 opts.xhr 模拟）
    await page.route(/^http:\/\/(192\.168\.1\.20|nas|\[fd00::12\])\//, route => route.fulfill({ status: 200, contentType: 'image/png', body: png(10, 10) }))
}

/*
 * harness 把 GM_xmlhttpRequest 的 details 经 exposeFunction 传回 node，Blob 在这一步会被序列化成 {}，
 * 断言不了请求体。这里在页面里把 harness 的桥包一层：data 是 Blob 就先读成字节数组再传。
 */
async function hookXhrBodies(page) {
    await page.evaluate(() => {
        const orig = window.__gmXhrBridge
        window.__gmXhrBridge = async (d) => {
            if (d.data instanceof Blob) d = { ...d, data: Array.from(new Uint8Array(await d.data.arrayBuffer())), dataIsBlob: true }
            return orig(d)
        }
    })
}

/** 从 multipart 请求体里取出某个字段：{ headers, body(Buffer) }。 */
function multipartField(contentType, bytes, name) {
    const boundary = /boundary=(\S+)/.exec(contentType)[1]
    const buf = Buffer.from(bytes)
    const sep = Buffer.from('--' + boundary)
    let pos = buf.indexOf(sep)
    while (pos !== -1) {
        const next = buf.indexOf(sep, pos + sep.length)
        if (next === -1) break
        const part = buf.subarray(pos + sep.length + 2, next - 2)   // 去掉开头的 \r\n 和结尾的 \r\n
        const split = part.indexOf('\r\n\r\n')
        const headers = part.subarray(0, split).toString('utf8')
        if (new RegExp(`name="${name}"`).test(headers)) return { headers, body: part.subarray(split + 4) }
        pos = next
    }
    return null
}

/** 记录 GM_xmlhttpRequest 调用；handler(details) 返回模拟的响应。 */
function xhrLog(handler) {
    const calls = []
    const xhr = async (d) => {
        calls.push(d)
        return handler(d)
    }
    return { calls, xhr }
}

const LENS_RESULT = 'https://www.google.com/search?vsrid=test&udm=26'
/** 默认的 xhr 模拟：内网图返回 PNG（latin1 字符串，脚本按 x-user-defined 解），Lens 上传返回 303。 */
function defaultXhr(d) {
    if (d.method === 'GET') return { status: 200, responseHeaders: 'content-type: image/png\r\n', responseText: png(60, 40).toString('latin1') }
    if (d.url.startsWith('https://lens.google.com/v3/upload')) return { status: 303, responseHeaders: `location: ${LENS_RESULT}\r\n`, responseText: '' }
    return { status: 404, responseText: '' }
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

/** 等上传这一轮跑完（菜单关了，或状态行出错）。 */
async function waitUpload(page) {
    await page.waitForFunction((sel) => {
        const host = document.querySelector(sel)
        if (!host) return true
        const pop = host.shadowRoot.querySelector('.pop')
        return !pop.dataset.busy && host.shadowRoot.querySelector('.status.error:not([hidden])')
    }, HOST, { timeout: 10000 })
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
const clickAct = (page, name) => inMenu(page, (root, n) => root.querySelector(`[data-act="${n}"]`).click(), name)
const statusText = page => inMenu(page, root => {
    const el = root.querySelector('.status')
    return el.hidden ? '' : el.textContent
})
const clickEngine = (page, id) => inMenu(page, (root, i) => root.querySelector(`[data-engine="${i}"]`).click(), id)

const DEFAULT_ENGINES = ['lens', 'bing', 'yandex', 'baidu', 'saucenao', 'tineye', 'iqdb', 'ascii2d', 'tracemoe']
const ALL_ENGINES = ['lens', 'bing', 'yandex', 'baidu', 'sogou', 'saucenao', 'tineye', 'iqdb', 'ascii2d', 'tracemoe']
/** GM 存储里「全部启用」的设置。 */
const ALL_ON = { engines: { enabled: ALL_ENGINES, known: ALL_ENGINES } }

/** 让下一个 prompt 返回 answer（null = 点取消），alert 的内容收进返回的数组。 */
function answerDialogs(page, answer) {
    const alerts = []
    const prompts = []
    page.on('dialog', async (d) => {
        if (d.type() === 'prompt') {
            prompts.push(d.message())
            if (answer === null) await d.dismiss()
            else await d.accept(answer)
        } else {
            alerts.push(d.message())
            await d.accept()
        }
    })
    return { alerts, prompts }
}

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

    console.log('悬停按 S')
    await t.test('鼠标停在图片上按 S 弹出菜单，页面自己的 S 快捷键收不到', async () => {
        const page = await openPage('basic.html')
        const p = await pointOf(page, '#a', 50, 40)
        await page.mouse.move(p.x, p.y)
        await page.keyboard.press('s')
        t.assert(await isOpen(page), '菜单应当打开')
        t.eq((await menuState(page)).url, 'https://img.example/400x300/a.png')
        const r = await inMenu(page, root => root.querySelector('.pop').getBoundingClientRect().toJSON())
        t.eq([r.left, r.top], [p.x, p.y], '菜单在鼠标处')
        t.eq(await page.evaluate(() => window.pageKeys), '')
        await page.close()
    })

    await t.test('鼠标不在图片上、带修饰键时按 S 都原样交给页面', async () => {
        const page = await openPage('basic.html')
        const p = await pointOf(page, '#text')
        await page.mouse.move(p.x, p.y)
        await page.keyboard.press('s')
        t.assert(!(await isOpen(page)), '文字上不应当弹菜单')
        const a = await pointOf(page, '#a')
        await page.mouse.move(a.x, a.y)
        await page.keyboard.press('Shift+S')
        await page.keyboard.press('Control+s')
        t.assert(!(await isOpen(page)), '带修饰键不应当弹菜单')
        t.eq(await page.evaluate(() => window.pageKeys), 'sShiftSControls')
        await page.close()
    })

    await t.test('焦点在输入框里时按 S 是打字，即使鼠标停在图片上', async () => {
        const page = await openPage('basic.html')
        await page.click('#box')
        const a = await pointOf(page, '#a')
        await page.mouse.move(a.x, a.y)
        await page.keyboard.type('ss')
        t.assert(!(await isOpen(page)), '不应当弹菜单')
        t.eq(await page.inputValue('#box'), 'ss')
        await page.close()
    })

    console.log('复制 / 打开 / 下载原图')
    await t.test('复制图片地址', async () => {
        const page = await openPage('basic.html')
        await altRightClick(page, '#a')
        await clickAct(page, 'copy')
        t.eq((await h.gm(page)).clipboard, { text: 'https://img.example/400x300/a.png', type: 'text' })
        t.assert(!(await isOpen(page)), '复制后关闭菜单')
        await page.close()
    })

    await t.test('在新标签打开原图（前台）', async () => {
        const page = await openPage('basic.html')
        await altRightClick(page, '#a')
        await clickAct(page, 'open')
        const opened = (await h.gm(page)).opened
        t.eq(opened.map(o => [o.url, o.options.active]), [['https://img.example/400x300/a.png', true]])
        await page.close()
    })

    await t.test('下载原图：文件名取路径最后一段；.php 这类不当扩展名', async () => {
        const page = await openPage('basic.html')
        await altRightClick(page, '#a')
        await clickAct(page, 'download')
        await page.waitForFunction(sel => !document.querySelector(sel), HOST)
        await altRightClick(page, '#php')
        await clickAct(page, 'download')
        await page.waitForFunction(sel => !document.querySelector(sel), HOST)
        t.eq((await h.gm(page)).downloads, [
            { url: 'https://img.example/400x300/a.png', name: 'a.png' },
            { url: 'https://img.example/200x200/show.php?id=3', name: 'show.php.jpg' },
        ])
        await page.close()
    })

    await t.test('下载失败时菜单不关，状态行写出原因', async () => {
        const page = await openPage('basic.html', { failDownloads: /a\.png/ })
        await altRightClick(page, '#a')
        await clickAct(page, 'download')
        await page.waitForFunction(sel => {
            const st = document.querySelector(sel).shadowRoot.querySelector('.status')
            return st.classList.contains('error')
        }, HOST)
        t.assert((await statusText(page)).startsWith('下载失败：harness: failDownloads'), await statusText(page))
        t.assert(await isOpen(page), '出错时菜单应当留着')
        await page.close()
    })

    await t.test('data: 图片：下载走 <a download>（不经过 GM_download），打开走页面里的 blob: 地址', async () => {
        const page = await openPage('basic.html')
        await altRightClick(page, '#inline')
        const [dl] = await Promise.all([page.waitForEvent('download'), clickAct(page, 'download')])
        t.eq(dl.suggestedFilename(), 'image.png')
        t.eq((await h.gm(page)).downloads, [], '不应当调用 GM_download')

        await altRightClick(page, '#inline')
        const [popup] = await Promise.all([page.waitForEvent('popup'), clickAct(page, 'open')])
        t.assert(popup.url().startsWith('blob:https://site.example/'), popup.url())
        t.eq((await h.gm(page)).opened, [], '不应当调用 GM_openInTab')
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
        const page = await openPage('edge.html', { values: ALL_ON })
        for (const id of ALL_ENGINES) {
            await altRightClick(page, '#weird')
            t.eq((await menuState(page)).url, WEIRD, '菜单里的图片地址')
            await clickEngine(page, id)
        }
        const opened = (await h.gm(page)).opened.map(o => new URL(o.url))
        t.eq(opened.length, ALL_ENGINES.length)
        opened.forEach((u, i) => {
            const id = ALL_ENGINES[i]
            t.eq(EXTRACT[id](u), WEIRD, `${id} 取回的地址`)
            t.eq(u.hash, '', `${id} 的地址不应当带 #（图片地址里的 # 必须被编码）`)
        })
        // 关键几个的原始字符串也钉死，防止「编码两次再解码两次」这种对称错误蒙混过关
        t.eq(opened[0].href, 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(WEIRD))
        t.eq(opened[ALL_ENGINES.indexOf('ascii2d')].href, 'https://ascii2d.net/search/url/' + encodeURIComponent(WEIRD))
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

    console.log('不可公开的图片 → 上传')
    const PRIVATE = {
        '#dataimg': '内嵌的 data: 图片',
        '#blobimg': '页面生成的 blob: 图片',
        '#lan': '内网地址',
        '#nas': '内网地址',
        '#v6': '内网地址',
        '#canvas': 'canvas 画布',
    }

    async function openPrivate(opts = {}) {
        const log = xhrLog(opts.xhr || defaultXhr)
        const page = await openPage('private.html', { xhr: log.xhr })
        await page.waitForFunction(() => window.blobReady && window.taintReady)
        await hookXhrBodies(page)
        return { page, calls: log.calls }
    }

    const engineButtons = page => inMenu(page, root => [...root.querySelectorAll('[data-engine]')].map(b => ({
        id: b.dataset.engine, disabled: b.disabled, reason: b.dataset.reason || '',
    })))
    const menuInfo = page => inMenu(page, (root) => {
        const box = root.querySelector('.mode input')
        const badge = root.querySelector('.badge')
        return {
            mode: root.querySelector('.pop').dataset.mode,
            badge: badge ? badge.textContent : '',
            checked: box.checked,
            locked: box.disabled,
            all: root.querySelector('.all').textContent,
        }
    })

    await t.test('公网图片默认按地址搜，上传开关可以手动打开', async () => {
        const { page } = await openPrivate()
        await altRightClick(page, '#pub')
        t.eq(await menuInfo(page), { mode: 'url', badge: '', checked: false, locked: false, all: '全部打开（9）' })
        t.assert((await engineButtons(page)).every(b => !b.disabled), '按地址搜时所有引擎都可用')
        await page.close()
    })

    for (const [sel, reason] of Object.entries(PRIVATE)) {
        await t.test(`${sel} 识别为不可公开（${reason}），锁定上传模式，不支持上传的引擎置灰并写明原因`, async () => {
            const { page } = await openPrivate()
            await altRightClick(page, sel)
            t.eq(await menuInfo(page), { mode: 'upload', badge: reason, checked: true, locked: true, all: '全部打开（1）' })
            const btns = await engineButtons(page)
            t.eq(btns.filter(b => !b.disabled).map(b => b.id), ['lens'])
            t.assert(btns.filter(b => b.disabled).every(b => b.reason.length > 4), '每个置灰的引擎都要有原因')
            const shown = await inMenu(page, root => root.querySelector('[data-engine="yandex"] .hint').textContent)
            t.eq(shown, 'Yandex 的上传接口实测已停用', '原因要显示在菜单里，不能只放在 title 上')
            await page.close()
        })
    }

    /** 点 Lens 上传，返回 POST 请求里 encoded_image 字段。 */
    async function uploadViaLens(page, calls, sel) {
        await altRightClick(page, sel)
        await clickEngine(page, 'lens')
        await waitUpload(page)
        const post = calls.find(c => c.method === 'POST')
        t.assert(post, '应当有一个 POST 请求')
        t.assert(post.url.startsWith('https://lens.google.com/v3/upload?'), post.url)
        t.assert(post.dataIsBlob, '请求体应当是 Blob')
        const ct = post.headers['Content-Type']
        t.assert(/^multipart\/form-data; boundary=\S+$/.test(ct), ct)
        const field = multipartField(ct, post.data, 'encoded_image')
        t.assert(field, 'multipart 里应当有 encoded_image 文件字段')
        return field
    }

    await t.test('data: 图上传到 Lens：multipart 里是原图字节，结果页在前台打开', async () => {
        const { page, calls } = await openPrivate()
        const field = await uploadViaLens(page, calls, '#dataimg')
        t.assert(/filename="image\.png"/.test(field.headers) && /Content-Type: image\/png/.test(field.headers), field.headers)
        const raw = await page.evaluate(() => document.getElementById('dataimg').src.split(',')[1])
        t.eq(field.body.toString('base64'), raw)
        t.eq((await h.gm(page)).opened.map(o => [o.url, o.options.active]), [[LENS_RESULT, true]])
        t.assert(!(await isOpen(page)), '成功后关闭菜单')
        t.eq(calls.length, 1, 'data: 图不需要另外取字节')
        await page.close()
    })

    await t.test('blob: 图：在页面里 fetch 出字节再上传', async () => {
        const { page, calls } = await openPrivate()
        const field = await uploadViaLens(page, calls, '#blobimg')
        t.assert(field.body.equals(png(32, 24)), '上传的应当是 blob 里的原始字节')
        await page.close()
    })

    await t.test('内网图：GM_xmlhttpRequest 取字节（带本页 Referer），再上传', async () => {
        const { page, calls } = await openPrivate()
        const field = await uploadViaLens(page, calls, '#lan')
        const get = calls[0]
        t.eq([get.method, get.url], ['GET', 'http://192.168.1.20/cam/snap.png'])
        t.eq(get.headers.Referer, 'https://site.example/private.html')
        t.assert(field.body.equals(png(60, 40)), '上传的应当是取回来的字节')
        await page.close()
    })

    await t.test('canvas：转成 PNG 上传', async () => {
        const { page, calls } = await openPrivate()
        const field = await uploadViaLens(page, calls, '#canvas')
        t.eq(field.body.subarray(1, 4).toString(), 'PNG')
        t.eq([field.body.readUInt32BE(16), field.body.readUInt32BE(20)], [140, 100], 'IHDR 里的宽高')
        await page.close()
    })

    await t.test('被跨域图片污染的 canvas：菜单直接说明原因，没有可点的引擎', async () => {
        const { page } = await openPrivate()
        await altRightClick(page, '#tainted')
        t.assert(await isOpen(page), '要弹菜单说明原因，不能当成没找到图')
        const info = await inMenu(page, root => ({
            error: root.querySelector('.status.error').textContent,
            buttons: root.querySelectorAll('button').length,
        }))
        t.eq(info, { error: '这个画布画过跨域图片，浏览器不让读取像素，没法搜', buttons: 0 })
        await page.close()
    })

    await t.test('要登录的同源图：手动切到上传，fetch 带上 cookie 取到真图', async () => {
        const { page, calls } = await openPrivate()
        await altRightClick(page, '#login')
        t.eq((await menuInfo(page)).mode, 'url', '地址本身是公网的')
        await inMenu(page, (root) => {
            const box = root.querySelector('.mode input')
            box.checked = true
            box.dispatchEvent(new Event('change'))
        })
        t.eq((await menuInfo(page)).mode, 'upload')
        t.eq((await engineButtons(page)).find(b => b.id === 'bing').disabled, true, '切换后引擎按钮按上传模式重画')
        await clickEngine(page, 'lens')
        await waitUpload(page)
        const post = calls.find(c => c.method === 'POST')
        t.assert(multipartField(post.headers['Content-Type'], post.data, 'encoded_image').body.equals(png(40, 30)))
        await page.close()
    })

    await t.test('取回来的是登录页（text/html）：报错，不上传', async () => {
        const { page, calls } = await openPrivate({
            xhr: d => ({ status: 200, responseHeaders: 'content-type: text/html; charset=utf-8\r\n', responseText: '<html>login</html>' }),
        })
        await altRightClick(page, '#lan')
        await clickEngine(page, 'lens')
        await waitUpload(page)
        t.eq(await statusText(page), '拿到的不是图片（text/html），可能需要先登录')
        t.eq(calls.filter(c => c.method === 'POST').length, 0)
        t.eq((await h.gm(page)).opened, [])
        await page.close()
    })

    await t.test('引擎返回错误：状态行写明哪个引擎、什么错，菜单不关', async () => {
        const { page } = await openPrivate({ xhr: d => ({ status: 500, responseText: 'oops' }) })
        await altRightClick(page, '#dataimg')
        await clickEngine(page, 'lens')
        await waitUpload(page)
        t.eq(await statusText(page), 'Google Lens 上传失败：HTTP 500')
        t.assert(await isOpen(page))
        t.eq((await h.gm(page)).opened, [])
        await page.close()
    })

    console.log('脚本菜单')
    await t.test('注册了三条菜单命令', async () => {
        const page = await openPage('basic.html')
        t.eq((await h.gm(page)).menu, ['⚙️ 选择 / 排序搜图引擎', '↩️ 恢复默认引擎', '⛔ 在 site.example 上停用'])
        await page.close()
    })

    await t.test('选择 / 排序引擎：填 id 和序号混着来，菜单按填的顺序列出，全部打开跟着变', async () => {
        const page = await openPage('basic.html')
        const d = answerDialogs(page, 'tineye，lens 5 tineye')
        await h.menu(page, '选择 / 排序搜图引擎')
        t.assert(d.prompts[0].includes('5. sogou —— 搜狗识图'), d.prompts[0])
        await altRightClick(page, '#a')
        t.eq((await menuState(page)).engines, ['tineye', 'lens', 'sogou'], '重复的 tineye 只算一次')
        await inMenu(page, root => root.querySelector('.all').click())
        t.eq((await h.gm(page)).opened.map(o => new URL(o.url).hostname), ['tineye.com', 'lens.google.com', 'pic.sogou.com'])
        // 刷新后还在
        await page.reload()
        await altRightClick(page, '#a')
        t.eq((await menuState(page)).engines, ['tineye', 'lens', 'sogou'])
        await page.close()
    })

    await t.test('填错不保存并提示；只剩一个引擎时没有「全部打开」', async () => {
        const page = await openPage('basic.html', { values: { engines: { enabled: ['iqdb'], known: ALL_ENGINES } } })
        const d = answerDialogs(page, 'lens, google')
        await h.menu(page, '选择 / 排序搜图引擎')
        t.eq(d.alerts, ['没有保存：不认识「google」'])
        await altRightClick(page, '#a')
        t.eq((await menuState(page)).engines, ['iqdb'])
        t.eq(await inMenu(page, root => !!root.querySelector('.all')), false)
        await page.close()
    })

    await t.test('清空不保存；恢复默认引擎', async () => {
        const page = await openPage('basic.html', { values: { engines: { enabled: ['iqdb'], known: ALL_ENGINES } } })
        const d = answerDialogs(page, '  ')
        await h.menu(page, '选择 / 排序搜图引擎')
        t.eq(d.alerts, ['没有保存：至少要启用一个引擎'])
        await h.menu(page, '恢复默认引擎')
        await altRightClick(page, '#a')
        t.eq((await menuState(page)).engines, DEFAULT_ENGINES)
        await page.close()
    })

    await t.test('脚本更新加了新引擎：存过设置的用户也能看到它（按 defaultOn 追加到末尾）', async () => {
        // 模拟旧版本存下的设置：known 里没有 tracemoe
        const known = ALL_ENGINES.filter(id => id !== 'tracemoe')
        const page = await openPage('basic.html', { values: { engines: { enabled: ['bing', 'lens'], known } } })
        await altRightClick(page, '#a')
        t.eq((await menuState(page)).engines, ['bing', 'lens', 'tracemoe'])
        await page.close()
    })

    await t.test('本站停用：Alt + 右键和 S 都不再响应，刷新后仍停用；再点一次恢复', async () => {
        const page = await openPage('basic.html')
        await h.menu(page, '在 site.example 上停用')
        t.eq((await h.gm(page)).menu.slice(-1), ['▶️ 在 site.example 上启用'])
        await altRightClick(page, '#a')
        t.assert(!(await isOpen(page)), '停用后 Alt + 右键不应当弹菜单')
        t.eq(await page.evaluate(() => window.pageContextMenus), 1, '停用后右键原样交给页面')
        await page.reload()
        const p = await pointOf(page, '#a')
        await page.mouse.move(p.x, p.y)
        await page.keyboard.press('s')
        t.assert(!(await isOpen(page)), '刷新后仍停用')
        await h.menu(page, '在 site.example 上启用')
        await altRightClick(page, '#a')
        t.assert(await isOpen(page), '恢复后应当能弹菜单')
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
