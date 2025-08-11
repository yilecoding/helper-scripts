/*
 * element-hider 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node element-hider/test/run.cjs
 *
 * 页面用 page.route 挂在假域名下（https://www.example.com/... 等），不访问外网。
 * 规则按 hostname / 主域名存，想测的就是真实域名下的行为，所以不用 harness 的 127.0.0.1 静态服务。
 * 路由用正则：字符串 glob 对子域名的写法不直观，正则一眼能看出匹配哪些。
 *
 * harness 的 GM 存储按源隔离（真实环境全局共享）：「www 上存的主域名规则在 news 上生效」
 * 这种跨子域名的场景测不了，只能在各自的源上预置规则来测作用域判断。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'element-hider.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://www.example.com'

const t = h.createRunner('element-hider')

/** 新开一个页面（独立 context，GM 存储互不影响），把 *.example.com 的请求映射到 fixtures。 */
async function open(browser, file, opts = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('console', m => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(/^https:\/\/([a-z0-9-]+\.)*example\.com\//, route => {
        const url = new URL(route.request().url())
        const fp = path.join(FIXTURES, path.basename(url.pathname) || file)
        if (!fs.existsSync(fp) || !fp.endsWith('.html')) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    await h.install(page, SCRIPT, opts)
    await page.goto((opts.origin || SITE) + '/' + file)
    return page
}

/** 元素的 computed display（找不到为 null）。 */
function display(page, sel) {
    return page.evaluate(s => {
        const el = document.querySelector(s)
        return el ? getComputedStyle(el).display : null
    }, sel)
}

function rule(selector) {
    return { selector, created: 1 }
}

/** 鼠标移到元素中心（拾取靠真实的 mousemove → elementFromPoint）。 */
async function hover(page, sel) {
    const b = await page.locator(sel).first().boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
}

/** 悬停高亮框：{ label, 对应元素的矩形是否吻合 }。没有框为 null。 */
function hoverBox(page) {
    return page.evaluate(() => {
        const host = document.querySelector('element-hider-ui')
        const box = host && host.shadowRoot.querySelector('.box.hover')
        if (!box) return null
        const n = v => Math.round(parseFloat(v))
        return { label: box.querySelector('.label').textContent, left: n(box.style.left), top: n(box.style.top), width: n(box.style.width) }
    })
}

function rect(page, sel) {
    return page.evaluate(s => {
        const r = document.querySelector(s).getBoundingClientRect()
        return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) }
    }, sel)
}

/** 界面里某个浮层（.tip / .confirm ...）在不在。 */
function shown(page, cls) {
    return page.evaluate(c => {
        const host = document.querySelector('element-hider-ui')
        return !!(host && host.shadowRoot.querySelector('.' + c))
    }, cls)
}

/** 确认面板上的选择器。 */
function confirmSelector(page) {
    return page.evaluate(() => {
        const el = document.querySelector('element-hider-ui').shadowRoot.querySelector('.confirm .sel')
        return el.value !== undefined ? el.value : el.textContent
    })
}

/** 本源 GM 存储里的某个键（harness 存在 localStorage 的 __gm: 前缀下）。 */
function gmValue(page, key) {
    return page.evaluate(k => JSON.parse(localStorage.getItem('__gm:' + k)), key)
}

/** 走一遍拾取：进入 → 悬停 → 点击，停在确认面板。 */
async function pick(page, sel) {
    await h.menu(page, '拾取')
    await hover(page, sel)
    await page.mouse.down()
    await page.mouse.up()
}

async function main() {
    const { browser, close } = await h.setup(FIXTURES)

    console.log('生效')
    await t.test('预置规则：DOMContentLoaded 之前样式已生效（不闪烁）', async () => {
        const page = await open(browser, 'basic.html', { values: { 'rules:www.example.com': [rule('#top-ad')] } })
        const early = await page.evaluate(() => window.__early)
        t.eq(early, { state: 'loading', display: 'none' })
        t.eq(await display(page, '#site-header'), 'block', '没命中的不受影响')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('动态插入的匹配元素也被隐藏', async () => {
        const page = await open(browser, 'basic.html', { values: { 'rules:www.example.com': [rule('.ad-banner')] } })
        await page.waitForFunction(() => window.__lateInserted)
        t.eq(await display(page, '#late-ad'), 'none')
        await page.close()
    })

    await t.test('作用域：主域名规则在子域名生效，别的站点的规则不生效', async () => {
        const page = await open(browser, 'basic.html', {
            origin: 'https://news.example.com',
            values: {
                'rules:*.example.com': [rule('#top-ad')],
                'rules:www.example.com': [rule('#site-header')],
            },
        })
        t.eq(await display(page, '#top-ad'), 'none', '*.example.com 的规则')
        t.eq(await display(page, '#site-header'), 'block', 'www 的规则不该管 news')
        await page.close()
    })

    await t.test('一条坏规则不连累其他规则', async () => {
        const page = await open(browser, 'basic.html', {
            values: { 'rules:www.example.com': [rule('div:unknown-pseudo'), rule('a/*'), rule('#top-ad')] },
        })
        t.eq(await display(page, '#top-ad'), 'none')
        t.eq(await display(page, '.news'), 'block', '未闭合注释没有吞掉后面的东西，也没有误伤')
        await page.close()
    })

    console.log('拾取')
    await t.test('菜单进入拾取：悬停高亮、点击选中，页面收不到点击、链接不跳转', async () => {
        const page = await open(browser, 'pick.html')
        await h.menu(page, '拾取')
        t.assert(await shown(page, 'tip'), '有拾取提示条')
        await hover(page, '#inline-link')
        const box = await hoverBox(page)
        t.assert(box && box.label.startsWith('a#inline-link'), JSON.stringify(box))
        t.eq({ left: box.left, top: box.top, width: box.width }, await rect(page, '#inline-link'), '高亮框贴着元素')
        await page.mouse.down()
        await page.mouse.up()
        await page.waitForTimeout(100)
        t.eq(page.url(), SITE + '/pick.html', '链接没有跳转')
        t.eq(await page.evaluate(() => [window.__pageClicks, window.__pageDowns]), [0, 0], '页面的点击 / mousedown 监听没收到')
        t.eq(await shown(page, 'tip'), false, '选中后退出拾取')
        t.eq(await confirmSelector(page), '#inline-link')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('快捷键进入；滚轮往上选父级、↓ 原路返回、再 ↓ 进子级；Esc 退出', async () => {
        const page = await open(browser, 'pick.html')
        await page.keyboard.press('Alt+Shift+H')
        t.assert(await shown(page, 'tip'), '快捷键进入拾取')
        await hover(page, '.promo-link img')
        t.assert((await hoverBox(page)).label.startsWith('img.sc-dkPtRN'))
        await page.mouse.wheel(0, -100)
        t.assert((await hoverBox(page)).label.startsWith('a.promo-link'), '滚轮上 → 父级')
        await page.keyboard.press('ArrowUp')
        t.assert((await hoverBox(page)).label.startsWith('div.widget.sc-gsDKAQ'), '↑ → 再上一级')
        t.eq(await page.evaluate(() => window.scrollY), 0, '滚轮没有滚动页面')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        t.assert((await hoverBox(page)).label.startsWith('img'), '原路回到最初的元素')
        await page.keyboard.press('Escape')
        t.eq(await shown(page, 'tip'), false)
        t.eq(await hoverBox(page), null, 'Esc 后高亮清掉')
        await page.mouse.click(5, 5)
        t.eq(await shown(page, 'confirm'), false, '退出后点击不再拾取')
        await page.close()
    })

    await t.test('选父级后点击：生成的选择器指向父级，只匹配它', async () => {
        const page = await open(browser, 'pick.html')
        await h.menu(page, '拾取')
        await hover(page, '.promo-link img')
        await page.mouse.wheel(0, -100)
        await page.mouse.wheel(0, -100)
        await page.mouse.down()
        await page.mouse.up()
        const sel = await confirmSelector(page)
        t.eq(sel, 'div.side > div.widget:nth-of-type(2)')
        t.eq(await page.evaluate(s => document.querySelectorAll(s).length, sel), 1)
        await page.close()
    })

    await t.test('确认隐藏：元素消失、规则入库；刷新后在 DOMContentLoaded 之前就已隐藏', async () => {
        const page = await open(browser, 'basic.html')
        await pick(page, '#top-ad')
        t.eq(await confirmSelector(page), '#top-ad')
        await page.locator('element-hider-ui [data-act=hide]').click()
        t.eq(await display(page, '#top-ad'), 'none')
        t.eq((await gmValue(page, 'rules:www.example.com')).map(r => r.selector), ['#top-ad'])
        await page.reload()
        t.eq(await page.evaluate(() => window.__early), { state: 'loading', display: 'none' })
        await page.close()
    })

    console.log('随机 id / 类名判据')
    await t.test('真实风格样例：生成的判为随机，人写的判为稳定', async () => {
        const random = [
            // CSS-in-JS
            'css-1x2y3z', 'css-dev-only-do-not-override-1x2y3z', 'css-9kq1ab-Button', 'sc-bdVaJa', 'sc-1a2b3c4d-0',
            'kZRDVx', 'iVXCSc', 'hGkUyx', 'bCDiOn', 'c-dhzjXW', 'c-PJLV', 'jss123', 'makeStyles-root-12',
            'svelte-1xyz2ab', 'astro-J7PV25F6',
            // CSS Modules
            'Header_title__3xYz1', 'styles_button__1hiof570', 'Button__root___2X3yZ', '_3xYz1aBc', 'title-module--title--3xYz1',
            // id
            ':r1:', '«r2»', '_r_3_', 'radix-:r3:', 'ember123', 'mui-38291', 'react-select-2-input', 'j_id12',
            '12345', '8f14e45f-ceea-4e7a-9f3c-1b2c3d4e5f60', 'div-gpt-ad-1690000000000-0', 'a3f9c01bd2', 'V1StGXR8Z5jdHi6B',
            'x-1a2b3c',
        ]
        const stable = [
            'ad-banner', 'sidebar', 'promo-box', 'card__title', 'btn--primary', 'MuiButton-root', 'ant-btn', 'navBarItem',
            'userName', 'NavBar', 'col-md-6', 'mt-4', 'grid-cols-12', 'v2-header', 'top-ad', 'promo_box', 'header', 'h1',
            'main-content', 'ad_slot_top', 'comments', 'gpt-slot', 'feed-item', 'is-sticky', 'hover:bg-red-500', 'w-1/2',
            'video-card', 'bili-video-card', 'Post', 'RichText', 'Card-section',
        ]
        const page = await open(browser, 'basic.html', { values: { debug: true } })
        const got = await page.evaluate(list => list.map(s => window.__elementHider.looksRandom(s)), [...random, ...stable])
        const wrong = [...random, ...stable].filter((s, i) => got[i] !== i < random.length)
        t.eq(wrong, [], '判错的样例')
        await page.close()
    })

    console.log('选择器生成')
    await t.test('稳定属性优先，随机类名 / id 被跳过，生成结果只匹配目标', async () => {
        const page = await open(browser, 'gen.html', { values: { debug: true } })
        const gen = sel => page.evaluate(s => {
            const el = document.querySelector(s)
            const out = window.__elementHider.selectorFor(el)
            const all = [...document.querySelectorAll(out)]
            return { sel: out, onlyTarget: all.length === 1 && all[0] === el }
        }, sel)
        t.eq(await gen('.promo-box'), { sel: 'div.promo-box', onlyTarget: true })
        t.eq(await gen('[data-testid]'), { sel: '[data-testid="close-ad"]', onlyTarget: true })
        t.eq(await gen('[aria-label]'), { sel: 'button[aria-label="关闭弹窗"]', onlyTarget: true })
        t.eq(await gen('a[href="https://github.com/yilecoding"]'), { sel: 'a[href="https://github.com/yilecoding"]', onlyTarget: true })
        t.eq(await gen('#div-gpt-ad-1690000000001-0'), { sel: 'div.slots > div.gpt-slot:nth-of-type(2)', onlyTarget: true })
        t.eq(await gen('aside ._9kLm2nOp'), { sel: '#sidebar > div:nth-of-type(2)', onlyTarget: true })
        t.eq(await gen('aside .jss123'), { sel: '#sidebar > div:nth-of-type(3) > span', onlyTarget: true })
        t.eq(await gen('body > div:last-child span'), { sel: 'body > div:nth-of-type(3) > div > span', onlyTarget: true })
        await page.close()
    })

    await t.test('广告联盟链接：生成 href 前缀规则，匹配同类广告、不碰站内链接', async () => {
        const page = await open(browser, 'gen.html', { values: { debug: true } })
        const r = await page.evaluate(() => {
            const sel = window.__elementHider.selectorFor(document.querySelector('a[href*="id=2"]'))
            return { sel, texts: [...document.querySelectorAll(sel)].map(a => a.textContent) }
        })
        t.eq(r, { sel: 'a[href^="https://ads.adnet.example/"]', texts: ['广告一', '广告二', '广告三'] })
        await page.close()
    })

    await t.test('选择器合法性：非法的给出原因而不是抛错', async () => {
        const page = await open(browser, 'basic.html', { values: { debug: true } })
        const r = await page.evaluate(() => ['div', 'div[', '.a{}', 'a/*', '', 'div:has(> img)'].map(s => window.__elementHider.selectorError(s)))
        t.eq(r.map(Boolean), [false, true, true, true, true, false])
        await page.close()
    })

    await t.test('主域名：常见二级后缀取三段，IP / localhost 原样', async () => {
        const page = await open(browser, 'basic.html', { values: { debug: true } })
        const hosts = ['www.example.com', 'example.com', 'a.b.example.co.uk', 'news.sina.com.cn', 'localhost', '192.168.1.10']
        const r = await page.evaluate(list => list.map(x => window.__elementHider.mainDomain(x)), hosts)
        t.eq(r, ['example.com', 'example.com', 'example.co.uk', 'sina.com.cn', 'localhost', '192.168.1.10'])
        await page.close()
    })

    await close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
