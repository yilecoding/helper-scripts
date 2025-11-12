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

/** 8 bit 单声道静音 WAV。<video> 也能放纯音频，用它当「正在播放的视频」，不用带二进制 fixture。 */
function silentWav(seconds) {
    const rate = 8000
    const n = rate * seconds
    const buf = Buffer.alloc(44 + n, 0x80) // 8 bit PCM 的静音是 0x80
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8)
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34)
    buf.write('data', 36); buf.writeUInt32LE(n, 40)
    return buf
}
const WAV = silentWav(30)

/** 任意 https 假域名的请求都用 fixtures 应答：路径对应文件名，`/` 回 index.html。 */
async function serveFixtures(route) {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('.wav')) return route.fulfill({ contentType: 'audio/wav', body: WAV })
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
        // 没覆盖时要回落到真实值，不能写死 'visible'：刷新 / 关页面时浏览器会派发真的
        // visibilitychange(hidden)，写死的话脚本读到「可见」，把它当成切回来，将卸载的页面又抢走租约，
        // 刷新出来的新页面要等租约过期才能计时（测试里实际撞到过，是测试替身的错，不是脚本的）
        const realVis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get
        const vis = () => window.__vis || realVis.call(document)
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: vis })
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => vis() !== 'visible' })
        const real = Document.prototype.hasFocus
        document.hasFocus = () => (window.__focus === undefined ? real.call(document) : window.__focus)
        // window.__crash = true 之后关页面，模拟崩溃：先于脚本注册的捕获监听把卸载相关事件全吞掉
        const swallow = e => { if (window.__crash) e.stopImmediatePropagation() }
        for (const type of ['pagehide', 'blur']) window.addEventListener(type, swallow, true)
        document.addEventListener('visibilitychange', swallow, true)
    })
    if (opts.time !== null) {
        // 装上就停住：不停的话页面加载期间假时钟按真实速度走，脚本启动时刻每次不同，秒数对不齐
        const time = opts.time || T0
        await context.clock.install({ time: time - 1000 })
        await context.clock.pauseAt(time)
    }
    return context
}

/**
 * 在 context 里开页面（没给就新建一个）。返回的 page 带 __logs（控制台输出）。
 * 假时钟是停着的，只有 runFor 才会走，用例里的秒数是确定的。
 */
async function open(url, opts = {}) {
    const context = opts.context || (await newContext(opts))
    const page = await context.newPage()
    page.__logs = []
    page.on('console', m => page.__logs.push(m.text()))
    await h.install(page, SCRIPT, { values: opts.values })
    await page.goto(url)
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

/** 持续「在用」ms 毫秒：每分钟动一下鼠标，不触发空闲判定。 */
async function use(page, ms) {
    for (let left = ms, i = 0; left > 0; left -= 60000, i++) {
        await page.mouse.move(100 + (i % 2) * 50, 100)
        await run(page, Math.min(60000, left))
    }
}

/** 遮罩 / 提醒条（shadow DOM 是 open 的，locator 能穿进去）。 */
const overlay = page => page.locator('site-timer-ui .overlay')
const toast = page => page.locator('site-timer-ui .toast')

/** 开始播放并等到真的在播（paused=false 不够，要等 playing）。 */
async function play(page, sel = '#v') {
    await page.$eval(sel, v => new Promise((resolve, reject) => {
        v.addEventListener('playing', resolve, { once: true })
        v.play().catch(reject)
    }))
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

    console.log('媒体')
    await t.test('有声音的视频在播：没有输入也算', async () => {
        const page = await open(SITE + 'video.html')
        await play(page)
        await run(page, 10 * 60000)
        await pagehide(page)
        near(await stored(page), 600)
        await page.context().close()
    })
    await t.test('静音视频不顶替空闲判定', async () => {
        const page = await open(SITE + 'video.html')
        await page.$eval('#v', v => { v.muted = true })
        await play(page)
        await run(page, 10 * 60000)
        await pagehide(page)
        near(await stored(page), 300)
        await page.context().close()
    })
    await t.test('窗口失焦但视频在播（副屏看视频）照算；标签页切走不算；暂停后回到空闲判定', async () => {
        const page = await open(SITE + 'video.html')
        await play(page)
        await setFocus(page, false)
        await run(page, 60000)
        await pagehide(page)
        near(await stored(page), 60, '失焦 + 播放')
        await setVisible(page, false)
        await run(page, 60000)
        near(await stored(page), 60, '切走后不算')
        await setVisible(page, true)
        await page.$eval('#v', v => v.pause())
        await run(page, 60000)
        await pagehide(page)
        near(await stored(page), 60, '失焦 + 暂停')
        await page.context().close()
    })

    console.log('跨天与睡眠')
    await t.test('跨本地零点：一段时间切到两天', async () => {
        const page = await open(SITE, { time: new Date('2026-10-29T23:59:30+08:00').getTime() })
        await run(page, 60000)
        await pagehide(page)
        near(await stored(page, '2026-10-29'), 30, '零点前')
        near(await stored(page, '2026-10-30'), 30, '零点后')
        await page.context().close()
    })
    await t.test('睡眠（定时器停了几小时）：醒来那一跳不计入，之后照常', async () => {
        const page = await open(SITE + 'video.html')
        await play(page) // 有声视频在播，醒来时仍算「在用」，只有跳变检测能挡住
        await run(page, 10000)
        await page.clock.fastForward(2 * 3600000) // 跳过去，期间到期的定时器最多触发一次 = 醒来后的第一次 tick
        await run(page, 10000)
        await pagehide(page)
        near(await stored(page), 20)
        t.assert(page.__logs.some(l => l.includes('判定为睡眠')), page.__logs.join('\n'))
        await page.context().close()
    })
    await t.test('睡眠后先来的是切走事件（锁屏）：同样不计入', async () => {
        const page = await open(SITE)
        await run(page, 10000)
        await page.clock.setSystemTime(T0 + 10000 + 3 * 3600000) // 只改时间，一个定时器都不触发
        await setVisible(page, false)
        near(await stored(page), 10)
        await page.context().close()
    })

    console.log('多标签')
    /** 同一个 context 里开两个同源标签页：GM 存储（localStorage）和假时钟都共享，和真实的多标签一样。 */
    async function twoTabs(url = SITE) {
        const context = await newContext()
        const a = await open(url, { context })
        const b = await open(url, { context })
        return { context, a, b }
    }
    await t.test('同站两个标签都可见且聚焦：只算一份', async () => {
        const { context, a, b } = await twoTabs()
        await run(a, 60000)
        await pagehide(a)
        await pagehide(b)
        near(await stored(a), 60)
        await context.close()
    })
    await t.test('持有租约的标签页切走：另一个立即接手，总时长连续', async () => {
        const { context, a, b } = await twoTabs()
        await run(a, 30000)
        await setVisible(a, false) // a 先开、先拿到租约
        await run(a, 30000)
        await pagehide(b)
        near(await stored(a), 60, '交接时不丢也不重')
        await setVisible(b, false)
        await setVisible(a, true)
        await run(a, 30000)
        await pagehide(a)
        near(await stored(a), 90, '再交回来')
        await context.close()
    })
    await t.test('持有者崩溃（来不及 pagehide）：租约过期后另一个接手', async () => {
        const { context, a, b } = await twoTabs()
        await run(a, 20000) // 15 秒时 a 落过一次盘
        await a.evaluate(() => { window.__crash = true })
        await a.close() // 卸载事件被吞掉，租约和没落盘的时长都留不下来
        await run(b, 60000)
        await pagehide(b)
        // a 在 20 秒时最后一次续约，35 秒过期，b 接手算到 80 秒：a 落盘的 15 + b 的 45；
        // a 没落盘的 5 秒随崩溃丢了。等租约过期的这 15 秒也没算 —— 不能两边都算
        near(await stored(b), 60)
        await context.close()
    })
    await t.test('竞争：租约被别的标签页覆盖后立即停算', async () => {
        const page = await open(SITE)
        await run(page, 10000)
        // 模拟另一个标签页同时抢租约、并且它的写入后到（存储收敛成它的 id）
        await page.evaluate(k => localStorage.setItem('__gm:' + k, JSON.stringify({ id: 'other-tab', ts: Date.now() })), 'lease:' + DOMAIN)
        await run(page, 10000)
        await pagehide(page)
        near(await stored(page), 10, '被抢之后的 10 秒不算')
        const lease = await page.evaluate(k => JSON.parse(localStorage.getItem('__gm:' + k)), 'lease:' + DOMAIN)
        t.eq(lease.id, 'other-tab', '不能把别人的租约删掉')
        await page.context().close()
    })

    console.log('每日上限')
    await t.test('剩 5 分钟时右下角提醒一次，关掉后不再弹', async () => {
        const page = await open(SITE, { values: { limits: { [DOMAIN]: 10 } } })
        await use(page, 4 * 60000)
        t.eq(await toast(page).count(), 0, '还剩 6 分钟时不提醒')
        await use(page, 61000)
        t.assert((await toast(page).innerText()).includes('今天还剩 5 分钟'), await toast(page).innerText())
        await page.click('site-timer-ui .toast [data-act=close]')
        await use(page, 60000)
        t.eq(await toast(page).count(), 0, '同一个上限只提醒一次')
        await page.reload()
        await use(page, 10000)
        t.eq(await toast(page).count(), 0, '刷新后也不再提醒')
        await page.context().close()
    })
    await t.test('到上限：全屏遮罩、暂停视频、停止计时；遮罩期间页面再起播也压回去', async () => {
        const page = await open(SITE + 'video.html', { values: { limits: { [DOMAIN]: 1 } } })
        await play(page)
        await play(page, '#a')
        await run(page, 61000)
        await overlay(page).waitFor()
        t.assert((await overlay(page).innerText()).includes('今日已用 1 分钟'), await overlay(page).innerText())
        t.eq(await page.$$eval('video, audio', ms => ms.map(m => m.paused)), [true, true], '视频音频都暂停')
        await page.$eval('#v', v => v.play().catch(() => {}))
        await page.waitForFunction(() => document.querySelector('#v').paused)
        await run(page, 60000)
        near(await stored(page), 60, '遮罩期间不计时')
        t.eq(await page.evaluate(() => document.documentElement.style.overflow), 'hidden', '页面不能滚')
        await page.context().close()
    })
    await t.test('「再给 5 分钟」：收起遮罩、恢复计时，5 分钟后再遮；每天最多 3 次', async () => {
        const page = await open(SITE + 'video.html', { values: { limits: { [DOMAIN]: 1 } } })
        await play(page)
        await run(page, 61000)
        await overlay(page).waitFor()
        t.assert((await page.locator('site-timer-ui [data-act=extend]').innerText()).includes('还能 3 次'))
        for (let i = 1; i <= 3; i++) {
            await page.click('site-timer-ui [data-act=extend]')
            t.eq(await overlay(page).count(), 0, `第 ${i} 次再给后收起`)
            t.eq(await page.evaluate(() => document.documentElement.style.overflow), '', '恢复滚动')
            await play(page)
            await run(page, 4 * 60000)
            t.eq(await overlay(page).count(), 0, '再给的 5 分钟还没用完')
            t.eq(await toast(page).count(), 0, '再给的 5 分钟里不弹「还剩 5 分钟」')
            await run(page, 61000)
            await overlay(page).waitFor()
            t.assert((await overlay(page).innerText()).includes(`今日已用 ${1 + 5 * i} 分钟`), await overlay(page).innerText())
        }
        t.assert(await page.locator('site-timer-ui [data-act=extend]').isDisabled(), '用完 3 次后按钮禁用')
        await page.reload()
        await overlay(page).waitFor()
        t.assert(await page.locator('site-timer-ui [data-act=extend]').isDisabled(), '刷新后次数仍在')
        await page.context().close()
    })
    await t.test('「今天不再提醒」：收起后接着计时不再遮，刷新也不遮；第二天恢复', async () => {
        const page = await open(SITE, {
            time: new Date('2026-10-29T23:00:00+08:00').getTime(),
            values: {
                limits: { [DOMAIN]: 30 },
                [`t:${TODAY}:${DOMAIN}`]: 40 * 60000,
                [`t:2026-10-30:${DOMAIN}`]: 40 * 60000, // 预置第二天也已超限，零点一过就该遮
            },
        })
        await overlay(page).waitFor() // 已经超了：一打开就遮
        await page.click('site-timer-ui [data-act=quiet]')
        t.eq(await overlay(page).count(), 0)
        await use(page, 5 * 60000)
        t.eq(await overlay(page).count(), 0, '不再遮')
        await page.reload()
        await use(page, 10000)
        t.eq(await overlay(page).count(), 0, '刷新后也不遮')
        await pagehide(page)
        near(await stored(page), 40 * 60 + 5 * 60 + 10, '照常计时')
        await use(page, 55 * 60000) // 过零点
        await overlay(page).waitFor()
        t.assert((await overlay(page).innerText()).includes('今日已用 40 分钟'), '第二天按第二天的用量重新遮')
        await page.context().close()
    })
    await t.test('菜单设上限：输入分钟数保存，留空取消；改了上限立即生效', async () => {
        const page = await open(SITE, { values: { [`t:${TODAY}:${DOMAIN}`]: 20 * 60000 } })
        t.assert((await h.gm(page)).menu.some(m => m.includes('给当前站点设上限（example.com）')))
        // 多个 once 监听会一起收到同一个对话框，按顺序排队应答
        const answers = []
        page.on('dialog', d => answers.shift()(d))
        answers.push(d => d.accept('15'))
        await h.menu(page, '给当前站点设上限')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:limits'))), { [DOMAIN]: 15 })
        await overlay(page).waitFor()
        answers.push(d => d.accept(''))
        await h.menu(page, '给当前站点设上限')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:limits'))), {})
        t.eq(await overlay(page).count(), 0, '取消上限后收起遮罩')
        answers.push(d => d.accept('abc'), d => d.accept()) // 第二个是「不是有效的分钟数」
        await h.menu(page, '给当前站点设上限')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:limits'))), {}, '非法输入不保存')
        t.eq(h.errors(page).map(String), [])
        await page.context().close()
    })

    await env.close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
