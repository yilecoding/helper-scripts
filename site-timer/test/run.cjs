/*
 * site-timer 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node site-timer/test/run.cjs
 *
 * 页面都用 context.route 挂在假域名下（https://www.example.com.cn/ 之类），不访问外网：
 * 主域名归并以 hostname 为输入，想测的就是真实域名下的行为。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'site-timer.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')

const t = h.createRunner('site-timer')
let env

/** 任意 https 假域名的请求都用 fixtures 应答：路径对应文件名，`/` 回 index.html。 */
async function serveFixtures(route) {
    const url = new URL(route.request().url())
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname)
    const fp = path.join(FIXTURES, name)
    if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
}

/** 测试里的「现在」：东八区 2026-10-29 10:00。context 都设成 Asia/Shanghai，按本地零点切天才可预期。 */
const T0 = new Date('2026-10-29T10:00:00+08:00').getTime()
const TODAY = '2026-10-29'
const DOMAIN = 'example.com'
const SITE = 'https://www.example.com/'

/**
 * 新 context：假域名路由 + 可控的可见性 / 焦点 + 假时钟（opts.time，传 null 不装）。
 *
 * 可见性和焦点在 headless 里永远是 visible / true，没法真的切走，只能在页面上覆盖：
 * document.visibilityState / hidden / hasFocus 都读 window.__vis / __focus，再手动派发事件。
 * 脚本每次 tick 都重新读这几个值，所以覆盖读数和派发事件两件事都要做。
 */
async function newContext(opts = {}) {
    const context = await env.browser.newContext({ timezoneId: 'Asia/Shanghai' })
    await context.route(/^https:\/\//, serveFixtures)
    await context.addInitScript(() => {
        const vis = () => window.__vis || 'visible'
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: vis })
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => vis() !== 'visible' })
        const real = Document.prototype.hasFocus
        document.hasFocus = () => (window.__focus === undefined ? real.call(document) : window.__focus)
    })
    if (opts.time !== null) await context.clock.install({ time: opts.time || T0 })
    return context
}

/**
 * 在 context 里开页面（没给就新建一个）。返回的 page 带 __logs（控制台输出）。
 * 装了假时钟的话，打开后把时间停在当前时刻：之后只有 runFor 才会走，用例里的秒数是确定的。
 */
async function open(url, opts = {}) {
    const context = opts.context || (await newContext(opts))
    const page = await context.newPage()
    page.__logs = []
    page.on('console', m => page.__logs.push(m.text()))
    await h.install(page, SCRIPT, { values: opts.values })
    await page.goto(url)
    if (opts.time !== null) await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1))
    return page
}

/** 推进假时钟（触发期间到期的所有定时器）。 */
const run = (page, ms) => page.clock.runFor(ms)

function setVisible(page, visible) {
    return page.evaluate(v => {
        window.__vis = v ? 'visible' : 'hidden'
        document.dispatchEvent(new Event('visibilitychange'))
    }, visible)
}

function setFocus(page, focused) {
    return page.evaluate(f => {
        window.__focus = f
        window.dispatchEvent(new Event(f ? 'focus' : 'blur'))
    }, focused)
}

function pagehide(page) {
    return page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
}

/** 模拟 GM 存储里某天某站点已落盘的毫秒数。 */
function stored(page, day = TODAY, domain = DOMAIN) {
    return page.evaluate(k => JSON.parse(localStorage.getItem('__gm:' + k) || '0'), `t:${day}:${domain}`)
}

/** 毫秒数约等于 sec 秒（tick 是 1 秒粒度，允许差 1 秒）。 */
function near(ms, sec, msg) {
    t.assert(Math.abs(ms - sec * 1000) <= 1000, `${msg || ''} 期望约 ${sec}s，实际 ${ms / 1000}s`)
}

async function main() {
    env = await h.setup(FIXTURES)

    console.log('元数据')
    await t.test('@grant 与实际用到的 GM_* 一一对应', async () => {
        const src = fs.readFileSync(SCRIPT, 'utf8')
        const meta = h.parseMeta(src)
        const body = src.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '')
        const used = [...new Set(body.match(/\bGM_\w+/g) || [])].sort()
        t.eq(meta.grant.filter(g => g !== 'none').sort(), used)
    })
    await t.test('头部字段齐全', async () => {
        const meta = h.parseMeta(fs.readFileSync(SCRIPT, 'utf8'))
        for (const k of ['name', 'name:en', 'description', 'description:en', 'namespace', 'version', 'author', 'license', 'homepageURL', 'supportURL', 'updateURL', 'downloadURL']) {
            t.assert(meta[k], '缺少 @' + k)
        }
        t.assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(meta.version[0]), '版本号格式')
        t.eq(meta.namespace[0], 'https://github.com/yilecoding/helper-scripts')
        t.eq(meta.author[0], '壹樂（V：ita1125）')
        t.eq(meta.license[0], 'CC BY-NC-SA')
        t.eq(meta.updateURL[0], 'https://raw.githubusercontent.com/yilecoding/helper-scripts/main/site-timer/site-timer.user.js')
        t.eq(meta.downloadURL[0], meta.updateURL[0])
        t.assert(!/@require/.test(fs.readFileSync(SCRIPT, 'utf8')), '不能 @require 外部脚本')
    })

    console.log('主域名归并')
    const cases = [
        ['https://www.example.com/', 'example.com'],
        ['https://m.example.com/', 'example.com'],
        ['https://news.sub.example.com/', 'example.com'],
        ['https://www.example.com.cn/', 'example.com.cn'],
        ['https://m.example.com.cn/', 'example.com.cn'],
        ['https://example.com.cn/', 'example.com.cn'],
        ['https://bbs.example.edu.cn/', 'example.edu.cn'],
        ['https://news.bbc.co.uk/', 'bbc.co.uk'],
        ['https://alice.github.io/', 'alice.github.io'],
        ['https://bob.github.io/', 'bob.github.io'],
        ['https://docs.alice.github.io/', 'alice.github.io'],
        ['https://my-app.vercel.app/', 'my-app.vercel.app'],
        ['https://WWW.Example.COM./', 'example.com'],
    ]
    await t.test('www. / m. / 子域名归到主域名，二级后缀和托管平台单独算', async () => {
        const context = await newContext({ time: null })
        const got = []
        for (const [url] of cases) {
            const page = await open(url, { context, time: null })
            got.push([url, (page.__logs.find(l => l.startsWith('[使用时长] 站点')) || '').replace('[使用时长] 站点 ', '')])
            await page.close()
        }
        t.eq(got, cases)
        await context.close()
    })
    await t.test('IP 地址原样返回', async () => {
        const page = await open(env.base + '/index.html', { time: null })
        t.assert(page.__logs.includes('[使用时长] 站点 127.0.0.1'), page.__logs.join('\n'))
        t.eq(h.errors(page).map(String), [])
        await page.context().close()
    })

    console.log('计时')
    await t.test('可见且聚焦才计时：切走、失焦期间不算', async () => {
        const page = await open(SITE)
        await run(page, 20000)
        await setVisible(page, false)
        near(await stored(page), 20, '切走时落盘')
        await run(page, 30000)
        await setVisible(page, true)
        await run(page, 10000)
        await setFocus(page, false)
        near(await stored(page), 30, '失焦时落盘')
        await run(page, 30000)
        near(await stored(page), 30, '失焦期间不算')
        await setFocus(page, true)
        await run(page, 5000)
        await pagehide(page)
        near(await stored(page), 35)
        t.eq(h.errors(page).map(String), [])
        await page.context().close()
    })
    await t.test('空闲判定：5 分钟没有输入就停，一动鼠标恢复', async () => {
        const page = await open(SITE)
        await run(page, 10 * 60000)
        await pagehide(page)
        near(await stored(page), 300, '只算到最后一次输入后 5 分钟')
        await page.mouse.move(100, 100)
        await page.mouse.move(120, 140)
        await run(page, 60000)
        await pagehide(page)
        near(await stored(page), 360, '恢复后')
        await page.keyboard.press('ArrowDown')
        await run(page, 4 * 60000)
        await page.mouse.wheel(0, 200)
        await run(page, 4 * 60000)
        await pagehide(page)
        near(await stored(page), 360 + 480, '持续有输入就一直算')
        await page.context().close()
    })
    await t.test('写入频率：内存累加，满 15 秒才落盘；pagehide / 刷新立即落盘', async () => {
        const page = await open(SITE)
        await run(page, 10000)
        t.eq(await stored(page), 0, '10 秒时还没写')
        await run(page, 6000)
        near(await stored(page), 15, '15 秒时写一次')
        await run(page, 5000)
        near(await stored(page), 15, '下一个 15 秒之前不再写')
        await page.reload()
        near(await stored(page), 21, '刷新前落盘')
        await page.context().close()
    })

    await env.close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
