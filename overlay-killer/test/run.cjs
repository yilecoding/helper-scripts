/*
 * overlay-killer 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node overlay-killer/test/run.cjs
 *
 * 页面都用 page.route 挂在假域名 https://example.com/ 下，不访问外网。
 * 用 https 假域名而不是 harness 的 127.0.0.1：「本站停用」以 hostname 为键，
 * 站点规则表也按域名匹配，想测的就是真实域名下的行为。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'overlay-killer.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://example.com'

const t = h.createRunner('overlay-killer')

/**
 * 新开一个独立 context（GM 存储互不影响），把假域名的请求映射到 fixtures。
 * 路由用正则：harness 的注入对任何 URL 都生效，用 glob 写 'https://example.com/**' 也行，
 * 但换成别的域名（csdn 等）时正则更不容易写错。
 * opts.site   换一个域名打开
 * opts.clock  打开前装上 page.clock（测延迟弹出用）
 */
async function open(browser, file, opts = {}) {
    const site = opts.site || SITE
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await ctx.newPage()
    page.on('console', m => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    const origin = new RegExp('^' + site.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '/')
    await page.route(origin, route => {
        const name = path.basename(new URL(route.request().url()).pathname) || file
        const fp = path.join(FIXTURES, name)
        if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    if (opts.clock) await page.clock.install()
    await h.install(page, SCRIPT, opts)
    await page.goto(site + '/' + file)
    return page
}

/** 元素是否可见（display/visibility 都算）。 */
function visible(page, sel) {
    return page.$eval(sel, el => {
        const s = getComputedStyle(el)
        return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0
    })
}

/** 处理记录面板的文字（没打开时 null）。 */
function panelText(page) {
    return page.evaluate(() => {
        const host = document.getElementById('overlay-killer-panel')
        return host ? host.shadowRoot.querySelector('.box').innerText : null
    })
}

/** 点面板上的按钮（.undo / .close）。 */
function panelClick(page, cls) {
    return page.evaluate(c => {
        document.getElementById('overlay-killer-panel').shadowRoot.querySelector('.' + c).click()
    }, cls)
}

/** 脚本是 document-end 跑的；等 load 之后再多等一轮，让 MutationObserver 的节流也走完。 */
async function settle(page, ms = 600) {
    await page.waitForLoadState('load')
    await page.waitForTimeout(ms)
}

;(async () => {
    const { browser, close } = await h.setup(FIXTURES)

    await t.test('普通页面：固定顶栏、悬浮按钮不受影响，无异常', async () => {
        const page = await open(browser, 'plain.html')
        await settle(page)
        t.assert(await visible(page, '#nav'), '顶栏被隐藏了')
        t.assert(await visible(page, '#fab'), '悬浮按钮被隐藏了')
        t.eq(await page.$$eval('[data-overlay-killer]', els => els.length), 0)
        t.eq(h.errors(page).map(String), [])
        await page.context().close()
    })

    // ---------------------------------------------------------------- Cookie 同意：CMP

    const choice = page => page.evaluate(() => window.__choice)

    await t.test('OneTrust：点「Reject All」，不点接受，也不点设置', async () => {
        const page = await open(browser, 'onetrust.html')
        await settle(page)
        t.eq(await choice(page), 'reject')
        t.assert(!(await visible(page, '#onetrust-banner-sdk')), '横幅还在')
        await page.context().close()
    })

    await t.test('OneTrust 没有拒绝按钮：隐藏横幅，接受和设置都不点', async () => {
        const page = await open(browser, 'onetrust-noreject.html')
        await settle(page)
        t.eq(await choice(page), null)
        t.assert(!(await visible(page, '#onetrust-consent-sdk')), '横幅没隐藏')
        t.eq(await page.$eval('#onetrust-consent-sdk', el => el.getAttribute('data-overlay-killer')), 'consent')
        await page.context().close()
    })

    await t.test('Quantcast：没有专用 id，按文字点「DISAGREE」，不点「MORE OPTIONS」', async () => {
        const page = await open(browser, 'quantcast.html')
        await settle(page)
        t.eq(await choice(page), 'disagree')
        await page.context().close()
    })

    await t.test('Usercentrics：在 shadow root 里点拒绝', async () => {
        const page = await open(browser, 'usercentrics.html')
        await settle(page)
        t.eq(await choice(page), 'uc-deny-all-button')
        await page.context().close()
    })

    // ---------------------------------------------------------------- Cookie 同意：通用兜底

    await t.test('自建 Cookie 卡片（不是 CMP）：按文字点「仅必要」，不点「接受全部」', async () => {
        const page = await open(browser, 'banner-cookie.html')
        await settle(page)
        t.eq(await choice(page), 'necessary')
        await page.context().close()
    })

    await t.test('只有「我知道了」的 Cookie 横幅被隐藏、没被点；「打开 App」引导条被隐藏', async () => {
        const page = await open(browser, 'banner-hide.html')
        await settle(page)
        t.eq(await choice(page), null)
        t.assert(!(await visible(page, '#top-tip')), 'Cookie 横幅还在')
        t.assert(!(await visible(page, '#app-bar')), 'App 引导条还在')
        await page.context().close()
    })

    // ---------------------------------------------------------------- 遮罩与滚动锁

    /** 页面现在能不能滚：试着滚到 y，看 scrollY 有没有跟着走。 */
    const canScrollTo = (page, y) => page.evaluate(y => {
        window.scrollTo({ top: y, behavior: 'instant' })
        return window.scrollY === y
    }, y)

    await t.test('通用遮罩：遮罩和兄弟弹窗都隐藏，body 的 overflow: hidden 解开', async () => {
        const page = await open(browser, 'overlay.html')
        await settle(page)
        t.assert(!(await visible(page, '.mask')), '遮罩还在')
        t.assert(!(await visible(page, '.login-box')), '弹窗还在')
        t.assert(await canScrollTo(page, 500), '页面还是滚不动')
        await page.context().close()
    })

    await t.test('position: fixed + top: -N 的锁法：解开后滚动位置还原到 N，touch-action 恢复', async () => {
        const page = await open(browser, 'overlay-fixed-lock.html')
        await settle(page)
        t.eq(await page.evaluate(() => window.__lockedAt), 1200)
        t.assert(!(await visible(page, '#wrap')), '遮罩还在')
        t.eq(await page.evaluate(() => getComputedStyle(document.body).position), 'static')
        t.eq(await page.evaluate(() => getComputedStyle(document.body).touchAction), 'auto')
        t.eq(await page.evaluate(() => window.scrollY), 1200)
        await page.context().close()
    })

    // ---------------------------------------------------------------- 不误伤

    await t.test('用户点击后打开的模态框（长得和登录墙一样）不处理，过一会儿也不处理', async () => {
        const page = await open(browser, 'user-modal.html')
        await settle(page)
        await page.click('#open')
        await page.waitForTimeout(1000)
        t.assert(await visible(page, '.modal-mask'), '遮罩被隐藏了')
        t.assert(await visible(page, '.modal'), '对话框被隐藏了')
        t.eq(await page.$eval('.modal-mask', el => el.getAttribute('data-overlay-killer')), 'user')
        // 宽限期过了以后 DOM 再变（用户在对话框里打字），也不能再回头把它当遮罩处理
        await page.waitForTimeout(1500)
        await page.fill('#nick', '新昵称')
        await page.evaluate(() => document.body.setAttribute('class', 'modal-open x'))
        await page.waitForTimeout(600)
        t.assert(await visible(page, '.modal'), '宽限期过后对话框被隐藏了')
        t.eq(await page.evaluate(() => getComputedStyle(document.body).overflowY), 'hidden')
        await page.context().close()
    })

    await t.test('图片灯箱（没有用户点击就打开的）不处理', async () => {
        const page = await open(browser, 'lightbox.html')
        await settle(page)
        t.assert(await visible(page, '.pswp'), '灯箱被隐藏了')
        await page.context().close()
    })

    await t.test('网页全屏的播放器不处理', async () => {
        const page = await open(browser, 'web-fullscreen.html')
        await settle(page)
        t.assert(await visible(page, '#player'), '播放器被隐藏了')
        await page.context().close()
    })

    // ---------------------------------------------------------------- 折叠全文

    /** 容器里的内容是否全部露出来了。 */
    const unfolded = (page, sel) => page.$eval(sel, el => el.scrollHeight <= el.clientHeight + 1)

    await t.test('通用折叠：两种写法都展开，按钮和渐变（含 ::after）去掉', async () => {
        const page = await open(browser, 'fold.html')
        await settle(page)
        t.assert(await unfolded(page, '#fold1'), '#fold1 没展开')
        t.assert(!(await visible(page, '.read-more-wrap')), '#fold1 的按钮还在')
        t.assert(!(await visible(page, '#fold1-fade')), '#fold1 的渐变还在')
        t.assert(await unfolded(page, '#fold2'), '#fold2 没展开')
        t.assert(!(await visible(page, '#btn2')), '#fold2 的按钮还在')
        t.eq(await page.$eval('#fold2', el => getComputedStyle(el, '::after').display), 'none')
        await page.context().close()
    })

    await t.test('通用折叠：可滚动代码块、没有展开按钮的截断容器、无关的「查看更多」不动', async () => {
        const page = await open(browser, 'fold.html')
        await settle(page)
        t.assert(!(await unfolded(page, '#code')), '代码块被展开了')
        t.assert(!(await unfolded(page, '#clip')), '没有按钮的容器被展开了')
        t.assert(await visible(page, '#unrelated'), '「查看更多评论」被隐藏了')
        await page.context().close()
    })

    await t.test('站点规则：CSDN（模拟结构）展开 #article_content，去掉 .hide-article-box', async () => {
        const page = await open(browser, 'csdn.html', { site: 'https://blog.csdn.net' })
        await settle(page)
        t.assert(await unfolded(page, '#article_content'), '没展开')
        t.assert(!(await visible(page, '.hide-article-box')), '「阅读全文」框还在')
        await h.menu(page, '本页处理记录')
        t.assert(/CSDN：展开全文/.test(await panelText(page)), '不是站点规则处理的：' + await panelText(page))
        await page.context().close()
    })

    // ---------------------------------------------------------------- 时机

    await t.test('延迟 2 秒弹出的遮罩：弹出前不动，弹出后被处理（page.clock）', async () => {
        const page = await open(browser, 'delayed.html', { clock: true })
        await page.waitForLoadState('load')
        await page.clock.runFor(1500)
        t.eq(await page.$$eval('.mask', els => els.length), 0)
        await page.clock.runFor(1000)
        t.eq(await page.$$eval('.mask', els => els.length), 1)
        t.assert(!(await visible(page, '.mask')), '遮罩还在')
        t.assert(await canScrollTo(page, 500), '页面还是滚不动')
        await page.context().close()
    })

    // ---------------------------------------------------------------- 菜单

    await t.test('本站停用（存储里已停用）：遮罩原样保留，菜单显示「已停用」', async () => {
        const page = await open(browser, 'overlay.html', { values: { sites: { 'example.com': { disabled: true } } } })
        await settle(page)
        t.assert(await visible(page, '.mask'), '停用了还是被处理了')
        t.eq(await page.$$eval('[data-overlay-killer]', els => els.length), 0)
        const menu = (await h.gm(page)).menu
        t.assert(menu.some(m => m.includes('本站已停用（example.com）')), '菜单：' + menu.join(' | '))
        await page.context().close()
    })

    await t.test('菜单停用本站：本页改动全部撤回、刷新后不再处理；再启用立刻处理', async () => {
        const page = await open(browser, 'overlay.html')
        await settle(page)
        t.assert(!(await visible(page, '.mask')), '一开始就没处理')
        await h.menu(page, '点击停用')
        t.assert(await visible(page, '.mask'), '停用后遮罩没恢复')
        t.assert(await visible(page, '.login-box'), '停用后弹窗没恢复')
        t.eq(await page.evaluate(() => getComputedStyle(document.body).overflowY), 'hidden')
        await page.reload()
        await settle(page)
        t.assert(await visible(page, '.mask'), '刷新后又被处理了')
        await h.menu(page, '点击启用')
        t.assert(!(await visible(page, '.mask')), '启用后没有立刻处理')
        const stored = await page.evaluate(() => localStorage.getItem('__gm:sites'))
        t.assert(!stored.includes('example.com'), '启用后存储里还留着本站：' + stored)
        await page.context().close()
    })

    await t.test('处理记录：列出本页处理了什么，撤销最近一次（点过的拒绝标「不可撤销」并跳过）', async () => {
        const page = await open(browser, 'onetrust.html')
        await settle(page)
        // 再弹一个遮罩，记录里就有一条不可撤销的 Cookie 和一条可撤销的遮罩
        await page.evaluate(() => {
            document.body.insertAdjacentHTML('beforeend',
                '<div id="m" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:5000">登录后查看全文</div>')
        })
        await page.waitForTimeout(600)
        t.assert(!(await visible(page, '#m')), '遮罩没处理')
        await h.menu(page, '本页处理记录')
        const text = await panelText(page)
        t.assert(/本页处理记录（2）/.test(text), text)
        t.assert(/\[Cookie\]OneTrust：点了「Reject All」（不可撤销）/.test(text), text)
        t.assert(/\[遮罩\]遮罩：登录后查看全文/.test(text), text)
        await panelClick(page, 'undo')
        t.assert(await visible(page, '#m'), '撤销后遮罩没回来')
        t.assert(/已撤销：遮罩/.test(await panelText(page)), await panelText(page))
        // 撤销过的不会被下一轮扫描再处理掉
        await page.evaluate(() => document.body.classList.add('poke'))
        await page.waitForTimeout(600)
        t.assert(await visible(page, '#m'), '撤销后又被处理了')
        await panelClick(page, 'undo')
        t.assert(/没有可以撤销的了/.test(await panelText(page)), await panelText(page))
        t.eq(await choice(page), 'reject')
        await panelClick(page, 'close')
        t.eq(await panelText(page), null)
        await page.context().close()
    })

    await t.test('手动「清理当前页」：用户自己打开的模态框也清掉', async () => {
        const page = await open(browser, 'user-modal.html')
        await settle(page)
        await page.click('#open')
        await page.waitForTimeout(800)
        t.assert(await visible(page, '.modal'), '自动处理了用户打开的对话框')
        await h.menu(page, '清理当前页')
        t.assert(!(await visible(page, '.modal')), '手动清理没清掉')
        t.assert(!(await visible(page, '.modal-mask')), '手动清理没清掉遮罩')
        t.assert(/这次处理了 1 项/.test(await panelText(page)), await panelText(page))
        await page.context().close()
    })

    await close()
    t.done()
})()
