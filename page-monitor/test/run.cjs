/*
 * page-monitor 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node page-monitor/test/run.cjs
 *
 * 页面挂在假域名 https://shop.example.com/... 下（page.route 用正则拦截），不访问外网。
 * 「服务器」是下面的 site 对象：页面导航（route）和脚本的 GM_xmlhttpRequest（harness 的 xhr 选项）
 * 都从它取内容，测试里改 site.files 就等于「服务器上的页面变了」。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'page-monitor.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const ORIGIN = 'https://shop.example.com'
const HOST = '#page-monitor-host'

const t = h.createRunner('page-monitor')

function fixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

/** 假服务器：pathname → html。每个用例自己建一个，互不影响。 */
function createSite(files = {}) {
    const site = { files: { ...files }, requests: [] }
    site.serve = (url) => {
        const u = new URL(url)
        const body = site.files[u.pathname + u.search] ?? site.files[u.pathname]
        return body === undefined ? { status: 404, responseText: 'not found' } : { status: 200, responseText: body }
    }
    return site
}

/**
 * 在 context 里开一个页面、装脚本、打开 url。
 * 同一个 context 里的页面共享 localStorage，也就共享 harness 的 GM 存储（用来测多标签）。
 */
async function open(context, site, pathname, opts = {}) {
    const page = await context.newPage()
    page.on('console', (m) => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(/^https:\/\/shop\.example\.com\//, (route) => {
        const r = site.serve(route.request().url())
        route.fulfill({ status: r.status, contentType: 'text/html; charset=utf-8', body: r.responseText })
    })
    await h.install(page, SCRIPT, {
        values: opts.values,
        xhr: opts.xhr || ((d) => { site.requests.push(d.url); return site.serve(d.url) }),
    })
    if (opts.clock) await page.clock.install({ time: opts.clock })
    await page.goto(ORIGIN + pathname)
    await page.waitForLoadState('load')
    return page
}

/** GM 存储里的全部监控项（harness 把 GM 值存在 localStorage 的 __gm: 前缀下）。 */
function monitors(page) {
    return page.evaluate(() => Object.keys(localStorage)
        .filter((k) => k.startsWith('__gm:mon:'))
        .map((k) => JSON.parse(localStorage.getItem(k)))
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)))
}

function inHost(page, sel) {
    return page.locator(`${HOST} ${sel}`)
}

/** 走一遍拾取：菜单 → 悬停 → 点击，停在确认条上。 */
async function pick(page, selector) {
    await h.menu(page, '选取要监控的区域')
    await page.hover(selector)
    await page.click(selector)
    await inHost(page, '[data-act="cancel"]').waitFor()
}

/** 在 node 这边轮询（页面里的计时器被 page.clock 接管了，不能靠页面里的 waitForFunction）。 */
async function waitFor(fn, msg = '等待超时', timeout = 3000) {
    const end = Date.now() + timeout
    let last
    while (Date.now() < end) {
        last = await fn()
        if (last) return last
        await new Promise((r) => setTimeout(r, 30))
    }
    throw new Error(`${msg}（最后一次：${JSON.stringify(last)}）`)
}

/** 推进页面时钟，再给 xhr 桥（真实异步）一点时间跑完。 */
async function advance(page, ms) {
    await page.clock.runFor(ms)
    await new Promise((r) => setTimeout(r, 150))
}

const T0 = new Date('2026-10-29T09:00:00+08:00')
const MIN = 60 * 1000

/** 拾取并保存一个抓取型监控，等新建后那次校准抓取回来。 */
async function addFetchMonitor(page, site, selector) {
    const before = site.requests.length
    const known = new Set((await monitors(page)).map((m) => m.id))
    await pick(page, selector)
    await inHost(page, '[data-act="save-fetch"]').click()
    await waitFor(() => site.requests.length > before, '新建后应立即抓一次做校准')
    return waitFor(async () => (await monitors(page)).find((m) => !known.has(m.id) && m.lastCheck), '校准结果写回存储')
}

/** 直接写进存储的监控项（省掉拾取那几步），默认盯 /item/42 的 #stock，刚检查过。 */
function seed(id, over = {}) {
    return {
        id, url: ORIGIN + '/item/42', title: '示例商品', selector: '#stock', mode: 'fetch', interval: 300, enabled: true,
        baseline: '有货', lastValue: '有货', createdAt: T0.getTime(), lastCheck: T0.getTime(), ...over,
    }
}

/** 改「服务器」上 /item/42 的某一段文字。 */
function serve(site, replacements) {
    let html = fixture('shop.html')
    for (const [from, to] of replacements) html = html.replace(from, to)
    site.files['/item/42'] = html
}

async function notificationCount(page) {
    return (await h.gm(page)).notifications.length
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)
    console.log('page-monitor')

    await t.test('有稳定 id 的元素：选择器就是 #id，保存时文字快照作为基线', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/item/42')
        await pick(page, '#stock')
        t.eq(await inHost(page, '.sel').textContent(), '#stock')
        await inHost(page, '[data-act="save-fetch"]').click()
        const [m] = await monitors(page)
        t.eq(m.selector, '#stock')
        t.eq(m.baseline, '有货')
        t.eq(m.url, ORIGIN + '/item/42')
        t.eq(m.mode, 'fetch')
        t.eq(m.interval, 300)
        t.eq(await page.locator(`${HOST} [data-role="picker"]`).count(), 0, '保存后退出拾取模式')
        t.eq(h.errors(page).map(String), [])
        await ctx.close()
    })

    await t.test('随机 id（哈希串、React useId）被跳过，改用类名 + 路径，且能唯一定位回原元素', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/item/42')

        await pick(page, '.price')
        const priceSel = await inHost(page, '.sel').textContent()
        t.eq(priceSel, 'span.price', '类名已经唯一，不加序号')
        t.assert(!priceSel.includes('a8f3k2x9q1b7'), `不应使用随机 id：${priceSel}`)
        t.eq(await page.evaluate((s) => document.querySelector(s) === document.querySelector('.price') && document.querySelectorAll(s).length, priceSel), 1)
        await inHost(page, '[data-act="cancel"]').click()

        await pick(page, '.status')
        const statusSel = await inHost(page, '.sel').textContent()
        t.assert(!statusSel.includes(':r3:') && !statusSel.includes('r3'), `不应使用 React useId：${statusSel}`)
        t.eq(await page.evaluate((s) => document.querySelectorAll(s).length === 1 && document.querySelector(s).textContent, statusSel), '工单状态：处理中')
        await inHost(page, '[data-act="cancel"]').click()

        // 列表项没有类名、没有 id：靠 :nth-of-type
        await pick(page, '.notices li:nth-child(2)')
        const liSel = await inHost(page, '.sel').textContent()
        t.assert(liSel.includes(':nth-of-type(2)'), liSel)
        t.eq(await page.evaluate((s) => document.querySelector(s).textContent, liSel), '公告二：满减活动进行中')
        await ctx.close()
    })

    await t.test('拾取模式：点链接不跳转；↑ 扩到父元素；Esc 退出且不留下高亮', async () => {
        const site = createSite({ '/item/42': fixture('shop.html'), '/promo': '<title>活动</title>' })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/item/42')
        await pick(page, '.notices a')
        t.eq(page.url(), ORIGIN + '/item/42', '链接没有被点开')
        t.eq(await inHost(page, '.text').textContent(), '满减活动')

        await page.keyboard.press('ArrowUp')
        t.eq(await inHost(page, '.text').textContent(), '公告二：满减活动进行中')
        await inHost(page, '[data-act="parent"]').click()
        t.eq(await inHost(page, '.text').textContent(), '公告一：周末正常发货 公告二：满减活动进行中 公告三：新品预告', '块级元素之间补空格，不粘在一起')
        await inHost(page, '[data-act="save-fetch"]').click()
        t.eq((await monitors(page))[0].selector, 'ul.notices')

        await h.menu(page, '选取要监控的区域')
        await page.hover('h1')
        await page.keyboard.press('Escape')
        t.eq(await page.locator(`${HOST} .hl`).count(), 0)
        t.eq(await page.locator(`${HOST} [data-role="picker"]`).count(), 0)
        // 退出后点击恢复正常
        await page.click('.notices a')
        await page.waitForURL(ORIGIN + '/promo')
        await ctx.close()
    })

    await t.test('抓取型：间隔没到不抓；服务器内容变了，时钟推进到点后检测到变化并通知，点通知打开该页', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/item/42', { clock: T0 })
        const m = await addFetchMonitor(page, site, '#stock')
        t.eq(site.requests, [ORIGIN + '/item/42'])

        await advance(page, 4 * MIN)
        t.eq(site.requests.length, 1, '4 分钟时还不该抓')
        t.eq((await h.gm(page)).notifications, [])

        site.files['/item/42'] = fixture('shop.html').replace('>有货<', '>缺货<')
        await advance(page, 1 * MIN + 5000)
        t.eq(site.requests.length, 2, '5 分钟到点抓了一次')
        const notes = await waitFor(async () => (await h.gm(page)).notifications.length && (await h.gm(page)).notifications)
        t.eq(notes.length, 1)
        t.assert(notes[0].title.includes('示例商品'), notes[0].title)
        t.eq(notes[0].text, '有货\n→ 缺货')
        const stored = (await monitors(page))[0]
        t.eq([stored.lastValue, stored.baseline], ['缺货', '有货'])
        t.eq(stored.history.map((x) => [x.old, x.new, x.notified]), [['有货', '缺货', true]])
        t.eq(await page.locator('#stock').textContent(), '有货', '不刷新、不改动当前页面')

        // 没再变：下一轮不重复通知
        await advance(page, 5 * MIN + 5000)
        t.eq(site.requests.length, 3)
        t.eq((await h.gm(page)).notifications.length, 1)

        await page.evaluate(() => window.__gm.notifications[0].onclick())
        t.eq((await h.gm(page)).opened.map((o) => o.url), [m.url])
        t.eq(h.errors(page).map(String), [])
        await ctx.close()
    })

    await t.test('抓取型：新建后用服务器直出的 HTML 校准基线，前端补过的文字不会第一次检查就报变化', async () => {
        const site = createSite({ '/r': fixture('rendered.html') })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/r', { clock: T0 })
        await pick(page, '#stock')
        t.eq(await inHost(page, '.text').textContent(), '有货（剩 3 件）', '拾取时看到的是活页面')
        await inHost(page, '[data-act="save-fetch"]').click()
        await waitFor(async () => (await monitors(page))[0]?.lastCheck)
        t.eq((await monitors(page))[0].baseline, '有货')
        await advance(page, 5 * MIN + 5000)
        t.eq(site.requests.length, 2)
        t.eq((await h.gm(page)).notifications, [])
        await ctx.close()
    })

    await t.test('面板：列出全部监控项（本页排前）；暂停后到点不抓；改间隔不足 30 秒按 30 秒；立即检查；两步删除', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const other = {
            id: 'other1', url: ORIGIN + '/item/7', title: '别的商品', selector: '#stock', mode: 'fetch',
            interval: 300, enabled: true, baseline: '有货', lastValue: '有货', createdAt: 1,
        }
        const page = await open(ctx, site, '/item/42', { clock: T0, values: { 'mon:other1': other } })
        t.eq(await inHost(page, '[data-role="badge"]').count(), 0, '本页没有监控项时不显示角标')
        const m = await addFetchMonitor(page, site, '#stock')
        t.eq(await inHost(page, '[data-role="badge"]').textContent(), '◎ 监控中 1')

        await h.menu(page, '监控面板')
        const items = inHost(page, '.item')
        t.eq(await items.evaluateAll((els) => els.map((e) => e.dataset.id)), [m.id, 'other1'])
        t.eq(await inHost(page, '.panel .title').textContent(), '网页监控（2）')
        t.eq(await inHost(page, '[data-id="other1"] [data-act="check"]').isDisabled(), true, '别的页面的监控项不在这里抓')
        const item = (sel) => inHost(page, `[data-id="${m.id}"] ${sel}`)
        t.eq(await item('[data-role="value"]').textContent(), '有货')

        await item('[data-act="toggle"]').uncheck()
        t.eq((await monitors(page)).find((x) => x.id === m.id).enabled, false)
        await advance(page, 10 * MIN)
        t.eq(site.requests.length, 1, '暂停的不抓')
        await item('[data-act="toggle"]').check()

        await item('[data-field="interval"]').fill('0.2')
        await item('[data-field="interval"]').press('Tab')
        t.eq((await monitors(page)).find((x) => x.id === m.id).interval, 30, '按最小间隔 30 秒')
        t.eq(await item('[data-field="interval"]').inputValue(), '0.5')
        await item('[data-field="interval"]').fill('1')
        await item('[data-field="interval"]').press('Tab')
        t.eq((await monitors(page)).find((x) => x.id === m.id).interval, 60)

        site.files['/item/42'] = fixture('shop.html').replace('>有货<', '>仅剩 1 件<')
        await item('[data-act="check"]').click()
        await waitFor(async () => (await h.gm(page)).notifications.length === 1, '立即检查发现变化并通知')
        await waitFor(async () => (await item('[data-role="value"]').textContent()) === '仅剩 1 件', '面板显示新值')
        t.eq(await inHost(page, '.toast').textContent(), '检测到变化')

        await item('[data-act="delete"]').click()
        t.eq(await item('[data-act="delete"]').textContent(), '确认删除', '第一次点只是确认')
        t.eq((await monitors(page)).length, 2)
        await item('[data-act="delete"]').click()
        t.eq((await monitors(page)).map((x) => x.id), ['other1'])
        t.eq(await items.count(), 1)
        t.eq(await inHost(page, '[data-role="badge"]').count(), 0, '本页没有监控项了，角标消失')
        t.eq(h.errors(page).map(String), [])
        await ctx.close()
    })

    await t.test('角标：有变化时显示未读数，点开面板标出变化项并清零', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/item/42', { clock: T0 })
        const m = await addFetchMonitor(page, site, '#stock')
        site.files['/item/42'] = fixture('shop.html').replace('>有货<', '>缺货<')
        await advance(page, 5 * MIN + 5000)
        const badge = inHost(page, '[data-role="badge"]')
        await waitFor(async () => (await badge.textContent()) === '● 1 处变化', '角标显示未读')
        await badge.click()
        t.eq(await inHost(page, `[data-id="${m.id}"] .tag.new`).count(), 1)
        t.eq(await badge.textContent(), '◎ 监控中 1')
        t.eq((await monitors(page))[0].unread, 0)
        await ctx.close()
    })

    await t.test('规范化与噪声：只有空白变了不报；面板里加时间戳噪声正则后，只改时间不报，正文变了才报', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const page = await open(ctx, site, '/item/42', { clock: T0 })
        const m = await addFetchMonitor(page, site, '#notice')
        t.eq(m.baseline, '更新于 09:00 · 今日公告：正常营业')

        serve(site, [['更新于 09:00 · 今日公告', '\n  更新于   09:00\n\t·  今日公告']])
        await advance(page, 5 * MIN + 5000)
        t.eq(site.requests.length, 2)
        t.eq(await notificationCount(page), 0, '空白变化不算')

        await h.menu(page, '监控面板')
        const item = (sel) => inHost(page, `[data-id="${m.id}"] ${sel}`)
        await item('[data-act="rules"]').click()
        await item('[data-field="noise"]').fill('更新于 \\d{2}:\\d{2}\n(')
        await item('[data-act="save-rules"]').click()
        t.assert((await item('[data-role="rule-error"]').textContent()).includes('噪声正则有误'), '无效正则要报出来')
        t.eq((await monitors(page))[0].noise, undefined, '有错不保存')
        await item('[data-field="noise"]').fill('更新于 \\d{2}:\\d{2}')
        await item('[data-act="save-rules"]').click()
        t.eq((await monitors(page))[0].noise, '更新于 \\d{2}:\\d{2}')
        t.eq(await item('[data-role="rules-summary"]').textContent(), '忽略 1 条噪声')

        serve(site, [['09:00', '09:35']])
        await advance(page, 5 * MIN + 5000)
        t.eq(site.requests.length, 3)
        t.eq(await notificationCount(page), 0, '只有时间戳变了')
        t.eq((await monitors(page))[0].lastValue, '更新于 09:35 · 今日公告：正常营业', '显示的原文仍跟着更新')

        serve(site, [['09:00', '10:10'], ['正常营业', '暂停营业']])
        await advance(page, 5 * MIN + 5000)
        await waitFor(async () => (await notificationCount(page)) === 1, '正文变了要通知')
        t.eq(h.errors(page).map(String), [])
        await ctx.close()
    })

    await t.test('关键词：「包含才通知」「不含才通知」；不通知的变化照样记下新值', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const values = {
            'mon:has': seed('has', { keyword: { mode: 'contains', text: '有货' } }),
            'mon:not': seed('not', { keyword: { mode: 'excludes', text: '缺货' } }),
        }
        const page = await open(ctx, site, '/item/42', { clock: T0, values })
        const titles = async () => (await h.gm(page)).notifications.length

        serve(site, [['>有货<', '>缺货<']])
        await advance(page, 5 * MIN + 5000)
        t.eq(site.requests.length, 2)
        t.eq(await titles(), 0, '有货→缺货：两个都不通知')
        const all = await monitors(page)
        t.eq(all.map((x) => [x.lastValue, x.unread || 0]), [['缺货', 0], ['缺货', 0]], '新值照样记下，但不算未读')

        serve(site, [['>有货<', '>到货了，有货<']])
        await advance(page, 5 * MIN + 5000)
        await waitFor(async () => (await titles()) === 2, '缺货→有货：两个都通知')

        serve(site, [['>有货<', '>预售<']])
        await advance(page, 5 * MIN + 5000)
        await waitFor(async () => (await titles()) === 3, '→预售：只有「不含缺货」的通知')
        t.eq((await monitors(page)).map((x) => x.unread), [1, 2])
        await ctx.close()
    })

    await t.test('数字阈值：取第一个数字（千分位），和上次通知时比；绝对值与百分比；数字消失也通知', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const price = { selector: 'span.price', baseline: '¥199.00', lastValue: '¥199.00' }
        const values = {
            'mon:abs': seed('abs', { ...price, threshold: '10' }),
            'mon:pct': seed('pct', { ...price, threshold: '5%' }),
        }
        const page = await open(ctx, site, '/item/42', { clock: T0, values })
        const steps = [
            ['¥195.00', 0],     // 差 4 / 2%
            ['¥189.00', 2],     // 和上次通知（199）比：差 10 / 5.03%
            ['¥185.00', 2],     // 和 189 比：差 4 / 2.1%（逐次累计不算，参照点是上次通知）
            ['¥1,299.00', 4],   // 千分位
            ['暂时缺货', 6],     // 数字没了
        ]
        for (const [text, expected] of steps) {
            serve(site, [['¥199.00', text]])
            await advance(page, 5 * MIN + 5000)
            await waitFor(async () => (await monitors(page)).every((x) => x.lastValue === text), `检查到 ${text}`)
            t.eq(await notificationCount(page), expected, `到 ${text} 时的通知数`)
        }
        await ctx.close()
    })

    await t.test('历史：最多留 20 条（新的在前），面板里逐词 diff 高亮（中文按字、数字和英文按词），未通知的标出原因', async () => {
        const site = createSite({ '/item/42': fixture('shop.html') })
        const ctx = await browser.newContext()
        const old = Array.from({ length: 20 }, (_, i) => ({ t: T0.getTime() - (i + 1) * MIN, old: `旧 ${i + 1}`, new: `旧 ${i}`, notified: true }))
        const values = {
            'mon:p': seed('p', { selector: '#notice', baseline: '更新于 09:00 · 今日公告：正常营业', lastValue: '更新于 09:00 · 今日公告：正常营业', history: old }),
            'mon:s': seed('s', { keyword: { mode: 'contains', text: '有货' } }),
        }
        const page = await open(ctx, site, '/item/42', { clock: T0, values })
        serve(site, [['09:00 · 今日公告：正常营业', '09:30 · 今日公告：暂停营业 Status: In progress'], ['>有货<', '>缺货<']])
        await advance(page, 5 * MIN + 5000)
        await waitFor(async () => (await monitors(page)).every((x) => x.history && x.history[0] && x.history[0].t > T0.getTime()), '两项都记下变化')

        const p = (await monitors(page)).find((x) => x.id === 'p')
        t.eq(p.history.length, 20, '封顶 20 条')
        t.eq(p.history[0].new, '更新于 09:30 · 今日公告：暂停营业 Status: In progress')
        t.eq(p.history[19].old, '旧 19', '最老的一条被挤掉')

        await h.menu(page, '监控面板')
        await inHost(page, '[data-id="p"] [data-act="history"]').click()
        const first = inHost(page, '[data-id="p"] [data-role="diff"]').first()
        t.eq(await first.locator('del').allTextContents(), ['00', '正常'])
        t.eq(await first.locator('ins').allTextContents(), ['30', '暂停', ' Status: In progress'])
        t.eq(await first.textContent(), '更新于 09:0030 · 今日公告：正常暂停营业 Status: In progress', '旧新交错拼起来，eq 部分不重复')

        await inHost(page, '[data-id="s"] [data-act="history"]').click()
        const s = inHost(page, '[data-id="s"] [data-role="history"]')
        t.assert((await s.textContent()).includes('未通知（不含「有货」）'), await s.textContent())
        t.eq(await s.locator('del').allTextContents(), ['有'])
        t.eq(await s.locator('ins').allTextContents(), ['缺'])
        await ctx.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
