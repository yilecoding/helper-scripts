/*
 * article-toc 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node article-toc/test/run.cjs
 *
 * 页面都用 page.route 挂在假域名下（https://blog.example.com/...），不访问外网。
 * 用 https 假域名而不是 harness 的 127.0.0.1 静态服务：
 * 「按站点记住状态」以 hostname 为键，想测的就是真实域名下的行为。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'article-toc.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://blog.example.com'

const t = h.createRunner('article-toc')

/** 新开一个页面（独立 context，GM 存储互不影响），把假域名的请求映射到 fixtures。 */
async function open(browser, file, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('console', (m) => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(SITE + '/**', (route) => {
        const url = new URL(route.request().url())
        // SPA 的深链接（/docs/b 之类）一律回落到同一个 html，和真实 SPA 服务器的行为一致
        const name = url.pathname.endsWith('.html') ? path.basename(url.pathname) : (opts.fallback || file)
        const fp = path.join(FIXTURES, name)
        if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    await h.install(page, SCRIPT, opts)
    await page.goto(SITE + '/' + file)
    return page
}

/** 目录有没有渲染出来。 */
function hasToc(page) {
    return page.evaluate(() => !!document.getElementById('article-toc-host'))
}

/** 等目录出现（脚本在 load 之后才跑）。 */
async function waitToc(page) {
    await page.waitForFunction(() => {
        const host = document.getElementById('article-toc-host')
        return host && host.shadowRoot && host.shadowRoot.querySelector('.item')
    })
}

/** 把目录读成 [{ text, children }] 树，直接按渲染出来的嵌套 <ul> 读，测的是用户看到的结构。 */
function readTree(page) {
    return page.evaluate(() => {
        const walk = (ul) => Array.from(ul.children).map((li) => {
            const sub = li.querySelector(':scope > ul')
            const node = { text: li.querySelector(':scope > .item').textContent }
            if (sub) node.children = walk(sub)
            return node
        })
        const sr = document.getElementById('article-toc-host').shadowRoot
        return walk(sr.querySelector('.list > ul'))
    })
}

/** 点目录项（Playwright 的 CSS 选择器会穿透 open shadow root）。 */
function clickItem(page, text) {
    return page.locator('#article-toc-host .item').filter({ hasText: new RegExp('^' + text + '$') }).click()
}

/** 等平滑滚动停下来：连续几次采样 scrollY 不变。 */
async function waitScrollIdle(page) {
    let last = -1
    let same = 0
    for (let i = 0; i < 60 && same < 3; i++) {
        const y = await page.evaluate(() => window.scrollY)
        same = y === last ? same + 1 : 0
        last = y
        await page.waitForTimeout(80)
    }
}

/** 页面里某个标题（按文字找）相对视口的 top。 */
function headingTop(page, text) {
    return page.evaluate((text) => {
        const el = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).find((h) => h.textContent.trim() === text)
        return el.getBoundingClientRect().top
    }, text)
}

/** 当前高亮的目录项文字（没有则 null）。 */
function activeItem(page) {
    return page.evaluate(() => {
        const el = document.getElementById('article-toc-host').shadowRoot.querySelector('.item.active')
        return el ? el.textContent : null
    })
}

/** 把某个标题滚到距视口顶部 offset 像素处（瞬间滚动），再等两帧让 rAF 里的计算跑完。 */
async function scrollHeadingTo(page, text, offset) {
    await page.evaluate(({ text, offset }) => {
        const el = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).find((h) => h.textContent.trim() === text)
        window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - offset, behavior: 'instant' })
    }, { text, offset })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** 面板（或折叠后的小按钮）的状态与位置。 */
function dockState(page) {
    return page.evaluate(() => {
        const sr = document.getElementById('article-toc-host').shadowRoot
        const dock = sr.querySelector('.dock')
        const shown = (sel) => getComputedStyle(sr.querySelector(sel)).display !== 'none'
        const r = dock.getBoundingClientRect()
        return { collapsed: dock.classList.contains('collapsed'), panel: shown('.panel'), fab: shown('.fab'), top: r.top, right: window.innerWidth - r.right }
    })
}

/** 进度条：{ shown, ratio }。 */
function progressState(page) {
    return page.evaluate(() => {
        const sr = document.getElementById('article-toc-host').shadowRoot
        const wrap = sr.querySelector('.progress')
        const m = /scaleX\(([\d.]+)\)/.exec(sr.querySelector('.progress .bar').style.transform)
        return { shown: getComputedStyle(wrap).display !== 'none', ratio: m ? Number(m[1]) : 0 }
    })
}

async function nextFrames(page) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** 目录项文字列表（没有目录时为 null）。 */
function itemTexts(page) {
    return page.evaluate(() => {
        const host = document.getElementById('article-toc-host')
        return host ? Array.from(host.shadowRoot.querySelectorAll('.item')).map((b) => b.textContent) : null
    })
}

/** 轮询直到目录变成期望的样子（重建有防抖，不能立刻断言）。 */
async function waitItems(page, expected, timeout = 3000) {
    const end = Date.now() + timeout
    let got
    while (Date.now() < end) {
        got = await itemTexts(page)
        if (JSON.stringify(got) === JSON.stringify(expected)) return
        await page.waitForTimeout(50)
    }
    t.eq(got, expected, '目录没有更新到期望的样子')
}

/** 等脚本跑完（load 之后），用于断言「没有目录」这种否定结论前。 */
async function settle(page, ms = 300) {
    await page.waitForLoadState('load')
    await page.waitForTimeout(ms)
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)
    console.log('article-toc')

    await t.test('层级归一化：只用 h2/h4 的页面当成 1/2 级，生成嵌套树', async () => {
        const page = await open(browser, 'levels.html')
        await waitToc(page)
        t.eq(await readTree(page), [
            { text: '第一章 起步', children: [{ text: '1.1 安装' }, { text: '1.2 配置' }] },
            { text: '第二章 进阶', children: [{ text: '2.1 插件' }] },
            { text: '第三章 附录' },
        ])
        const depths = await page.evaluate(() => Array.from(
            document.getElementById('article-toc-host').shadowRoot.querySelectorAll('.item'),
        ).map((b) => Number(b.dataset.depth)))
        t.eq(depths, [1, 2, 2, 1, 2, 1], '缩进深度')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('跳级标题只深一层，空标题被忽略', async () => {
        const page = await open(browser, 'skip.html')
        await waitToc(page)
        t.eq(await readTree(page), [
            {
                text: '总标题',
                children: [
                    { text: '直接跳到 h3' },
                    { text: '回到 h2', children: [{ text: 'h2 下的 h3' }] },
                    { text: '另一个 h2' },
                ],
            },
        ])
        await page.close()
    })

    await t.test('侧栏 / 评论区 / 页脚 / 文内旁注 / 不可见的标题被排除', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        const texts = await page.evaluate(() => Array.from(
            document.getElementById('article-toc-host').shadowRoot.querySelectorAll('.item'),
        ).map((b) => b.textContent))
        t.eq(texts, ['如何写一个用户脚本', '准备工作', '安装 Tampermonkey', '新建脚本', '元数据', '调试技巧', '日志', '发布'])
        await page.close()
    })

    await t.test('没有 article/main 时按标题密度推断正文，侧栏和评论按类名排除', async () => {
        const page = await open(browser, 'nocontainer.html')
        await waitToc(page)
        t.eq(await readTree(page), [
            { text: '一、背景', children: [{ text: '1. 现状' }] },
            { text: '二、方案', children: [{ text: '1. 设计' }, { text: '2. 实现' }] },
            { text: '三、总结' },
        ])
        await page.close()
    })

    await t.test('点击跳转：标题停在固定导航栏下方，而不是被它盖住', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        const idsBefore = await page.evaluate(() => document.querySelectorAll('[id]').length)
        await clickItem(page, '调试技巧')
        await waitScrollIdle(page)
        const top = await headingTop(page, '调试技巧')
        t.assert(top >= 56 && top <= 56 + 24, `标题 top=${top}，应在 56px 的顶栏下方附近`)
        // 不改 hash、不给页面元素加 id
        t.eq(await page.evaluate(() => location.hash), '')
        t.eq(await page.evaluate(() => document.querySelectorAll('[id]').length), idsBefore, '页面上的 id 数量不变')
        await page.close()
    })

    await t.test('点击跳转：页面顶部时还没吸住的 sticky 导航栏也要扣掉', async () => {
        const page = await open(browser, 'sticky.html')
        await waitToc(page)
        await clickItem(page, '第三节')
        await waitScrollIdle(page)
        const top = await headingTop(page, '第三节')
        t.assert(top >= 50 && top <= 50 + 24, `标题 top=${top}，应在 50px 的吸顶栏下方附近`)
        await page.close()
    })

    await t.test('滚动联动：阅读线（顶栏下方）以上的最后一个标题高亮', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        // 标题刚好在顶栏下方 → 它是当前章节
        await scrollHeadingTo(page, '元数据', 60)
        t.eq(await activeItem(page), '元数据')
        // 标题还被顶栏挡着一点、正文已经在读 → 仍算它
        await scrollHeadingTo(page, '调试技巧', 30)
        t.eq(await activeItem(page), '调试技巧')
        // 读到长章节中间，视口里一个标题都没有 → 仍是这一节
        await scrollHeadingTo(page, '日志', -300)
        t.eq(await activeItem(page), '日志')
        // 下一个标题在视口里但还没到阅读线 → 不提前切
        await scrollHeadingTo(page, '发布', 200)
        t.eq(await activeItem(page), '日志')
        await page.close()
    })

    await t.test('点击跳转后高亮停在被点的那一项，滚动途中不闪', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        const seen = []
        await page.exposeFunction('__recordActive', (t) => seen.push(t))
        await page.evaluate(() => {
            const list = document.getElementById('article-toc-host').shadowRoot.querySelector('.list')
            new MutationObserver(() => {
                const a = list.querySelector('.item.active')
                window.__recordActive(a ? a.textContent : null)
            }).observe(list, { subtree: true, attributes: true, attributeFilter: ['class'] })
        })
        await clickItem(page, '日志')
        await waitScrollIdle(page)
        await page.waitForTimeout(300)
        t.eq(await activeItem(page), '日志')
        t.eq(Array.from(new Set(seen.filter(Boolean))), ['日志'], '途中高亮过的项')
        await page.close()
    })

    await t.test('长目录：当前项自动滚进目录列表的可视区，页面本身不被带着滚', async () => {
        const page = await open(browser, 'long.html')
        await waitToc(page)
        await scrollHeadingTo(page, '第 70 节', 0)
        const y = await page.evaluate(() => window.scrollY)
        t.eq(await activeItem(page), '第 70 节')
        const vis = await page.evaluate(() => {
            const sr = document.getElementById('article-toc-host').shadowRoot
            const list = sr.querySelector('.list').getBoundingClientRect()
            const item = sr.querySelector('.item.active').getBoundingClientRect()
            return { inside: item.top >= list.top && item.bottom <= list.bottom, scrolled: sr.querySelector('.list').scrollTop }
        })
        t.assert(vis.scrolled > 0, '目录列表应该滚动过')
        t.assert(vis.inside, '高亮项应在目录列表可视区内')
        t.eq(await page.evaluate(() => window.scrollY), y, '页面滚动位置不应被改动')
        await page.close()
    })

    await t.test('折叠状态刷新后保留，按站点存在 GM 里', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        t.eq((await dockState(page)).collapsed, false)
        await page.locator('#article-toc-host .collapse').click()
        let st = await dockState(page)
        t.eq([st.collapsed, st.panel, st.fab], [true, false, true], '折叠后只剩小按钮')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:site:blog.example.com')).collapsed), true)

        await page.reload()
        await waitToc(page)
        st = await dockState(page)
        t.eq([st.collapsed, st.panel, st.fab], [true, false, true], '刷新后仍是折叠的')

        await page.locator('#article-toc-host .fab').click()
        await page.reload()
        await waitToc(page)
        t.eq((await dockState(page)).collapsed, false, '展开后刷新仍是展开的')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('拖动面板：位置按站点记住，刷新后还在原处；拖动不会误触发折叠按钮的展开', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        const before = await dockState(page)
        t.eq([before.top, before.right], [80, 16], '默认位置')
        const head = await page.locator('#article-toc-host .head').boundingBox()
        await page.mouse.move(head.x + 40, head.y + 10)
        await page.mouse.down()
        await page.mouse.move(head.x - 160, head.y + 110, { steps: 8 })
        await page.mouse.up()
        const after = await dockState(page)
        t.eq([after.top, after.right], [180, 216], '拖动后的位置')

        await page.reload()
        await waitToc(page)
        const reloaded = await dockState(page)
        t.eq([reloaded.top, reloaded.right], [180, 216], '刷新后的位置')

        // 折叠成小按钮后拖动：只移动，不展开
        await page.locator('#article-toc-host .collapse').click()
        const fab = await page.locator('#article-toc-host .fab').boundingBox()
        await page.mouse.move(fab.x + 10, fab.y + 10)
        await page.mouse.down()
        await page.mouse.move(fab.x + 10, fab.y + 210, { steps: 8 })
        await page.mouse.up()
        const moved = await dockState(page)
        t.eq([moved.collapsed, moved.top], [true, 380], '小按钮被拖走、仍折叠')
        await page.close()
    })

    await t.test('存下来的位置超出当前窗口时夹回视口内', async () => {
        const page = await open(browser, 'blog.html', { values: { 'site:blog.example.com': { collapsed: false, pos: { top: 5000, right: 9000 } } } })
        await waitToc(page)
        const st = await dockState(page)
        t.assert(st.top <= 800 - 40 && st.right <= 1280 - 260 && st.right >= 0, `位置 ${JSON.stringify(st)} 应在视口内`)
        await page.close()
    })

    await t.test('阅读进度条：按正文容器算，正文底部进入视口就是 100%，下面的页脚不算', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        await nextFrames(page)
        let p = await progressState(page)
        t.eq([p.shown, p.ratio], [true, 0], '页面顶部')
        await scrollHeadingTo(page, '调试技巧', 60)
        p = await progressState(page)
        t.assert(p.ratio > 0.3 && p.ratio < 0.9, `读到中间，进度 ${p.ratio}`)
        // 正文底部刚进入视口：页面还没到底（下面还有页脚），进度已经满了
        await page.evaluate(() => {
            const r = document.querySelector('article').getBoundingClientRect()
            window.scrollTo({ top: window.scrollY + r.bottom - window.innerHeight, behavior: 'instant' })
        })
        await nextFrames(page)
        t.assert(await page.evaluate(() => window.scrollY + innerHeight < document.documentElement.scrollHeight - 50), '页面应该还没到底')
        t.eq((await progressState(page)).ratio, 1, '正文读完')
        await page.close()
    })

    await t.test('进度条可关：设置里关掉后不显示', async () => {
        const page = await open(browser, 'blog.html', { values: { settings: { progressBar: false } } })
        await waitToc(page)
        t.eq((await progressState(page)).shown, false)
        await page.close()
    })

    await t.test('SPA：pushState 换页后目录更新，后退（popstate）再换回来', async () => {
        const page = await open(browser, 'docs/a', { fallback: 'spa.html' })
        await waitToc(page)
        t.eq(await itemTexts(page), ['A 第一节', 'A 第二节', 'A 第三节'])
        await page.evaluate(() => window.go('/docs/b'))
        await waitItems(page, ['B 概览', 'B 安装', 'B 配置', 'B 常见问题'])
        await page.goBack()
        await waitItems(page, ['A 第一节', 'A 第二节', 'A 第三节'])
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('SPA：内容晚于路由到达、标题变少时收起目录、复用元素只改文字', async () => {
        const page = await open(browser, 'docs/a', { fallback: 'spa.html' })
        await waitToc(page)
        await page.evaluate(() => window.goLater('/docs/b'))
        await waitItems(page, ['B 概览', 'B 安装', 'B 配置', 'B 常见问题'])
        await page.evaluate(() => window.go('/docs/short'))
        await waitItems(page, null)
        await page.evaluate(() => window.go('/docs/a'))
        await waitItems(page, ['A 第一节', 'A 第二节', 'A 第三节'])
        await page.evaluate(() => window.retitle())
        await waitItems(page, ['改名 1', '改名 2', '改名 3'])
        await page.close()
    })

    await t.test('SPA：只改 hash 的 replaceState（滚动监听库常这么干）不触发重建', async () => {
        const page = await open(browser, 'docs/a', { fallback: 'spa.html' })
        await waitToc(page)
        await page.evaluate(() => {
            window.__list = document.getElementById('article-toc-host').shadowRoot.querySelector('.list > ul')
            for (let i = 0; i < 5; i++) history.replaceState(null, '', '#sec' + i)
        })
        await page.waitForTimeout(800)
        t.eq(await page.evaluate(() => window.__list === document.getElementById('article-toc-host').shadowRoot.querySelector('.list > ul')), true, '目录列表没有被重绘')
        await page.close()
    })

    await t.test('菜单：隐藏/显示目录（按站点记住），文字随状态变化', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        t.eq((await h.gm(page)).menu, ['隐藏目录（本站）', '关闭阅读进度条', '开启伪标题识别（本站）'])
        await h.menu(page, '隐藏目录')
        const dockHidden = () => page.evaluate(() => getComputedStyle(
            document.getElementById('article-toc-host').shadowRoot.querySelector('.dock')).display === 'none')
        t.eq(await dockHidden(), true, '隐藏后面板不显示')
        t.eq((await h.gm(page)).menu[0], '显示目录（本站）')
        await page.reload()
        await waitToc(page)
        t.eq(await dockHidden(), true, '刷新后仍隐藏')
        await h.menu(page, '显示目录')
        t.eq(await dockHidden(), false, '重新显示')
        await page.close()
    })

    await t.test('菜单：开关阅读进度条（全局设置）', async () => {
        const page = await open(browser, 'blog.html')
        await waitToc(page)
        t.eq((await progressState(page)).shown, true)
        await h.menu(page, '关闭阅读进度条')
        t.eq((await progressState(page)).shown, false)
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:settings')).progressBar), false)
        t.eq((await h.gm(page)).menu[1], '开启阅读进度条')
        await h.menu(page, '开启阅读进度条')
        t.eq((await progressState(page)).shown, true)
        await page.close()
    })

    await t.test('伪标题识别：默认关；菜单打开后整段加粗的小标题进目录，强调句/引用不算', async () => {
        const page = await open(browser, 'pseudo.html')
        await settle(page)
        t.eq(await hasToc(page), false, '只有两个真标题，默认不显示')
        await h.menu(page, '开启伪标题识别')
        await waitToc(page)
        t.eq(await readTree(page), [
            { text: '一、背景', children: [{ text: '1. 现状' }, { text: '2. 问题' }] },
            { text: '二、方案', children: [{ text: '1. 设计' }] },
        ])
        await page.reload()
        await waitToc(page)
        t.eq((await itemTexts(page)).length, 5, '按站点记住，刷新后仍开着')
        await h.menu(page, '关闭伪标题识别')
        await waitItems(page, null)
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('边界：<main><header> 里的文章标题不被当成站点头排除', async () => {
        const page = await open(browser, 'bottom.html')
        await waitToc(page)
        t.eq((await itemTexts(page))[0], '文章标题')
        await page.close()
    })

    await t.test('边界：结尾几节太短、滚不到阅读线 —— 点哪节高亮哪节，滚到底高亮最后一节', async () => {
        const page = await open(browser, 'bottom.html')
        await waitToc(page)
        await clickItem(page, '第四节')
        await waitScrollIdle(page)
        await page.waitForTimeout(400)   // 等跳转锁释放，看重新计算后的结果
        t.eq(await activeItem(page), '第四节', '点了第四节')
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
        await nextFrames(page)
        await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
        await nextFrames(page)
        t.eq(await activeItem(page), '第五节', '滚到底')
        await page.close()
    })

    await t.test('边界：正文在内层滚动容器里（window 不滚）—— 跳转、高亮、进度都对', async () => {
        const page = await open(browser, 'inner.html')
        await waitToc(page)
        await clickItem(page, '第四节')
        await page.waitForFunction(() => {
            const el = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent === '第四节')
            return Math.abs(el.getBoundingClientRect().top - 58) < 3
        }, null, { timeout: 3000 })
        await page.waitForTimeout(400)
        t.eq(await page.evaluate(() => window.scrollY), 0, 'window 没动')
        t.eq(await activeItem(page), '第四节')
        const p = (await progressState(page)).ratio
        t.assert(p > 0.5 && p < 1, `进度 ${p}`)
        await page.close()
    })

    await t.test('边界：面板拖到屏幕下方时列表不伸出视口；窗口缩小再放大，面板回到原处', async () => {
        const page = await open(browser, 'long.html')
        await waitToc(page)
        const head = await page.locator('#article-toc-host .head').boundingBox()
        await page.mouse.move(head.x + 40, head.y + 10)
        await page.mouse.down()
        await page.mouse.move(head.x - 860, head.y + 610, { steps: 10 })
        await page.mouse.up()
        const panel = () => page.evaluate(() => {
            const r = document.getElementById('article-toc-host').shadowRoot.querySelector('.panel').getBoundingClientRect()
            return { bottom: r.bottom, right: window.innerWidth - r.right }
        })
        const dragged = await panel()
        t.assert(dragged.bottom <= 800, `面板底部 ${dragged.bottom} 不应超出 800 的视口`)
        t.eq(dragged.right, 16 + 900)

        await page.setViewportSize({ width: 800, height: 800 })
        await page.waitForTimeout(100)
        t.eq((await panel()).right, 800 - 260, '窄窗口里被夹到左边缘')
        await page.setViewportSize({ width: 1280, height: 800 })
        await page.waitForTimeout(100)
        t.eq((await panel()).right, 916, '放大回来回到拖动时的位置')
        await page.close()
    })

    await t.test('少于 3 个标题不显示目录', async () => {
        const page = await open(browser, 'few.html')
        await settle(page)
        t.eq(await hasToc(page), false)
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
