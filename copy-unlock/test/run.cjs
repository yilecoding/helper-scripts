/*
 * copy-unlock 测试。运行：
 *   NODE_PATH=/path/to/node_modules node copy-unlock/test/run.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'copy-unlock.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')

;(async () => {
    const { browser, base, close } = await h.setup(FIXTURES)
    const t = h.createRunner('copy-unlock')

    /**
     * 新开一个带剪贴板权限的上下文，装好脚本再打开 fixture。
     * opts.url：按真实域名打开（脚本按 hostname 选站点规则），用 route 把 fixture 当作该地址的响应，不访问外网。
     */
    async function open(fixture, opts = {}) {
        const url = opts.url || base + '/' + fixture
        const ctx = await browser.newContext()
        await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin })
        if (opts.url) {
            const body = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8')
            await ctx.route(new URL(url).origin + '/**', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body }))
        }
        const page = await ctx.newPage()
        await h.install(page, SCRIPT, { values: opts.values })
        await page.goto(url)
        return page
    }

    await t.test('普通页面加载无异常', async () => {
        const page = await open('plain.html')
        t.eq(await page.textContent('#text'), '没有任何限制的普通页面。')
        t.eq(h.errors(page).map(String), [])
        await page.context().close()
    })

    const selection = page => page.evaluate(() => getSelection().toString().trim())
    const userSelect = (page, sel) => page.$eval(sel, el => getComputedStyle(el).userSelect)

    await t.test('CSS 禁止选中：三击能选中段落，选区不透明', async () => {
        const page = await open('no-select.html')
        await page.click('#p1', { clickCount: 3 })
        t.eq(await selection(page), '第一段正文，整页被 CSS 禁止选中。')
        const bg = await page.$eval('#p1', el => getComputedStyle(el, '::selection').backgroundColor)
        t.assert(bg !== 'rgba(0, 0, 0, 0)', '::selection 仍是透明：' + bg)
        await page.context().close()
    })

    await t.test('CSS 层不改按钮和输入框', async () => {
        const page = await open('no-select.html')
        t.eq(await userSelect(page, '#btn'), 'none')
        t.eq(await userSelect(page, '#input'), 'none')
        t.eq(await userSelect(page, '#p2'), 'text')
        await page.context().close()
    })

    /** 键盘 Ctrl+C，然后从系统剪贴板读回 { text, html }。 */
    async function copyByKeyboard(page) {
        await page.evaluate(() => navigator.clipboard.writeText('__empty__'))
        await page.keyboard.press('Control+C')
        return page.evaluate(async () => {
            const out = {}
            for (const item of await navigator.clipboard.read()) {
                for (const type of item.types) out[type] = await (await item.getType(type)).text()
            }
            return { text: out['text/plain'], html: out['text/html'] }
        })
    }
    const attrs = (page, sel) => page.$eval(sel, el => el.getAttributeNames().sort())

    await t.test('内联属性：限制属性被移除，正常的 onmousedown 保留', async () => {
        const page = await open('inline-attrs.html')
        t.eq(await attrs(page, 'body'), [])
        t.eq(await attrs(page, '#p1'), ['id'])
        t.eq(await attrs(page, '#p2'), ['id'])
        t.eq(await attrs(page, '#track'), ['href', 'id', 'onmousedown'])
        await page.context().close()
    })

    await t.test('内联属性：异步插入的节点和后来重挂的属性也被清掉', async () => {
        const page = await open('inline-attrs.html')
        await page.waitForFunction(() => window.__rendered)
        await page.evaluate(() => new Promise(r => setTimeout(r, 0)))
        t.eq(await attrs(page, '#p3'), ['id'])
        t.eq(await attrs(page, '#p1'), ['id'])
        await page.click('#p3', { clickCount: 3 })
        t.eq((await copyByKeyboard(page)).text.trim(), '异步插入的段落')
        await page.context().close()
    })

    await t.test('脚本限制：selectstart 被拦也能选中，Ctrl+C 复制不带尾巴', async () => {
        const page = await open('events.html')
        await page.click('#p1', { clickCount: 3 })
        t.eq(await selection(page), '第一段正文，限制全靠页面脚本。')
        const { text } = await copyByKeyboard(page)
        t.eq(text.trim(), '第一段正文，限制全靠页面脚本。')
        t.assert(!text.includes('著作权'), '剪贴板里有版权尾巴：' + text)
        await page.context().close()
    })

    await t.test('脚本限制：Ctrl+A 全选可用', async () => {
        const page = await open('events.html')
        await page.click('#p2')
        await page.keyboard.press('Control+A')
        const sel = await selection(page)
        t.assert(sel.includes('第一段正文') && sel.includes('第二段正文'), '全选没生效：' + sel)
        await page.context().close()
    })

    await t.test('脚本限制：右键不再弹页面自己的菜单', async () => {
        const page = await open('events.html')
        await page.click('#p1', { button: 'right' })
        t.eq(await page.$eval('#menu', el => el.hidden), true)
        await page.context().close()
    })

    await t.test('可编辑区不截：编辑器自己的 copy/keydown 监听照常触发', async () => {
        const page = await open('events.html')
        await page.click('#editor')
        await page.keyboard.press('Control+A')
        // 不用 Ctrl+C：页面 document 上的 keydown 拦截在编辑区里仍生效（这是放行的代价），
        // 这里只验证 copy 事件能到达编辑器自己的监听
        await page.evaluate(() => document.execCommand('copy'))
        t.eq(await page.evaluate(() => [!!window.__editorSelectAll, !!window.__editorCopy]), [true, true])
        await page.context().close()
    })

    /** 用 Range 精确选中某元素里的一段文字（三击会连带选到块尾换行）。 */
    const selectText = (page, sel, start, end) => page.$eval(sel, (el, [start, end]) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        const texts = []
        for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n)
        const range = document.createRange()
        let pos = 0
        for (const n of texts) {
            const len = n.data.length
            if (start >= pos && start <= pos + len && !range.__s) { range.setStart(n, start - pos); range.__s = 1 }
            if (end >= pos && end <= pos + len) { range.setEnd(n, end - pos); break }
            pos += len
        }
        getSelection().removeAllRanges()
        getSelection().addRange(range)
    }, [start, end])

    await t.test('复制去掉干扰字和零宽字符，HTML 里也没有', async () => {
        const page = await open('interference.html')
        await page.click('#novel', { clickCount: 3 })
        const { text, html } = await copyByKeyboard(page)
        t.eq(text.trim(), '他推开门，屋里一片漆黑。')
        t.assert(!/[盗版必究\u200b]/.test(html), 'HTML 里有干扰字：' + html)
        // 复制之后正文要原样还原
        t.eq(await page.$$eval('[data-copy-unlock-hide]', els => els.length), 0)
        t.eq(await page.$eval('#novel .x', el => getComputedStyle(el).display), 'inline')
        await page.context().close()
    })

    await t.test('渐变文字、emoji 连接符保留；链接改成绝对地址', async () => {
        const page = await open('interference.html')
        await page.click('#grad', { clickCount: 3 })
        t.eq((await copyByKeyboard(page)).text.trim(), '渐变标题文字')
        await page.click('#emoji', { clickCount: 3 })
        const { text, html } = await copyByKeyboard(page)
        t.eq(text.trim(), '一家人👨\u200d👩\u200d👧下一章')
        t.assert(html.includes(`href="${base}/chapter/2.html"`), '链接不是绝对地址：' + html)
        await page.context().close()
    })

    await t.test('只选中代码块的一部分，HTML 仍包在 <pre> 里', async () => {
        const page = await open('interference.html')
        await selectText(page, '#code', 0, 30)
        const { text, html } = await copyByKeyboard(page)
        t.eq(text, 'def main():\n    print("hello")')
        t.assert(/^<pre>/.test(html), 'HTML 没有 <pre>：' + html)
        await page.context().close()
    })

    const HOST = new URL(base).hostname
    /** 触发菜单命令并等页面刷新完。 */
    const menuAndReload = async (page, caption) => {
        await Promise.all([page.waitForEvent('load'), h.menu(page, caption)])
    }

    /** 不走键盘（页面会拦 Ctrl+C），用 Range 选中元素后 execCommand('copy')，读回剪贴板文本。 */
    async function copyElementByCommand(page, sel) {
        await page.evaluate(() => navigator.clipboard.writeText('__empty__'))
        await page.$eval(sel, el => {
            getSelection().selectAllChildren(el)
            document.execCommand('copy')
        })
        return page.evaluate(() => navigator.clipboard.readText())
    }

    await t.test('本站停用后完全不干预：选不中、右键被页面接管、复制带尾巴', async () => {
        const values = { sites: { [HOST]: { disabled: true } } }
        const page = await open('events.html', { values })
        t.eq((await h.gm(page)).menu, [`⛔ 本站已停用（${HOST}），点击启用`])
        await page.click('#p1', { clickCount: 3 })
        t.eq(await selection(page), '')
        await page.click('#p1', { button: 'right' })
        t.eq(await page.$eval('#menu', el => el.hidden), false)
        t.assert((await copyElementByCommand(page, '#p1')).includes('著作权归作者所有'), '停用后页面的尾巴应该照旧')
        await page.context().close()

        const page2 = await open('no-select.html', { values })
        t.eq(await userSelect(page2, '#p1'), 'none')
        await page2.context().close()
        const page3 = await open('inline-attrs.html', { values })
        t.eq(await page3.getAttribute('body', 'oncopy'), 'return false')
        await page3.context().close()
    })

    await t.test('菜单：停用 → 刷新后页面限制回来；再启用恢复', async () => {
        const page = await open('events.html')
        t.eq((await h.gm(page)).menu, [`✅ 本站已启用（${HOST}），点击停用`, '🖱 右键：已解锁，点击改回页面自己的右键'])
        t.eq(await copyElementByCommand(page, '#p1'), '第一段正文，限制全靠页面脚本。')

        await menuAndReload(page, '点击停用')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:sites'))), { [HOST]: { disabled: true } })
        t.assert((await copyElementByCommand(page, '#p1')).includes('著作权归作者所有'), '停用后页面的尾巴应该照旧')

        await menuAndReload(page, '点击启用')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:sites'))), {})
        t.eq(await copyElementByCommand(page, '#p1'), '第一段正文，限制全靠页面脚本。')
        await page.context().close()
    })

    await t.test('菜单：右键改回页面自己的 → 页面菜单能弹，复制仍解锁', async () => {
        const page = await open('events.html')
        await menuAndReload(page, '右键：已解锁')
        t.eq((await h.gm(page)).menu[1], '🖱 右键：未解锁，点击解锁')
        await page.click('#p1', { button: 'right' })
        t.eq(await page.$eval('#menu', el => el.hidden), false)
        await page.click('#p1', { clickCount: 3 })
        t.eq((await copyByKeyboard(page)).text.trim(), '第一段正文，限制全靠页面脚本。')
        await page.context().close()
    })

    const CSDN = 'https://blog.csdn.net/someone/article/details/123'

    await t.test('CSDN：「登录后复制」按钮改成直接复制，不弹登录', async () => {
        const page = await open('csdn.html', { url: CSDN })
        t.eq(await page.getAttribute('.hljs-button', 'data-title'), '复制')
        await page.click('.hljs-button')
        t.eq((await h.gm(page)).clipboard, {
            text: 'import os\nprint(os.getcwd())\nfor i in range(3):\n    print(i)\n',
            type: 'text',
        })
        t.eq(await page.getAttribute('.hljs-button', 'data-title'), '已复制')
        t.eq(await page.$eval('#login', el => el.hidden), true)
        await page.context().close()
    })

    await t.test('CSDN：点代码块不弹登录、折叠的代码块展开、复制不带版权声明', async () => {
        const page = await open('csdn.html', { url: CSDN })
        t.eq(await page.getAttribute('#pre1 code', 'onclick'), null)
        await page.click('#pre1 code', { position: { x: 5, y: 5 } })
        t.eq(await page.$eval('#login', el => el.hidden), true)
        t.eq(await page.$eval('.hide-preCode-box', el => getComputedStyle(el).display), 'none')
        t.eq(await page.$eval('#pre1', el => el.scrollHeight <= el.clientHeight), true)
        const text = await copyElementByCommand(page, '#para')
        t.eq(text, '正文段落。')
        await page.context().close()
    })

    await t.test('站点规则：在线文档默认不解锁右键，其他照常解锁', async () => {
        const page = await open('events.html', { url: 'https://docs.qq.com/doc/abc' })
        t.eq((await h.gm(page)).menu[1], '🖱 右键：未解锁，点击解锁')
        await page.click('#p1', { button: 'right' })
        t.eq(await page.$eval('#menu', el => el.hidden), false)
        t.eq(await copyElementByCommand(page, '#p1'), '第一段正文，限制全靠页面脚本。')
        // 规则默认是「不解锁」，用户点解锁要落盘；再点回去等于默认值，不落盘
        await menuAndReload(page, '点击解锁')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:sites'))), { 'docs.qq.com': { contextMenu: true } })
        await menuAndReload(page, '改回页面自己的右键')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:sites'))), {})
        await page.context().close()
    })

    await t.test('高特异性 !important、内联 !important 的禁选也能解开', async () => {
        const page = await open('specificity.html')
        await page.waitForFunction(() => window.__done)
        await page.evaluate(() => new Promise(r => setTimeout(r, 0)))
        t.eq(await userSelect(page, '#code'), 'text')
        t.eq(await userSelect(page, '#inline'), 'text')
        t.eq(await userSelect(page, '#later'), 'text')
        // 只摘掉 user-select，同一个 style 里别的声明不动
        t.eq(await page.$eval('#inline', el => el.style.color), 'rgb(51, 51, 51)')
        await page.click('#code', { clickCount: 3 })
        t.eq(await selection(page), 'echo hello')
        await page.context().close()
    })

    await close()
    t.done()
})()
