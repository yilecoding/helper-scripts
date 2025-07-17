/*
 * form-saver 测试。运行：
 *   NODE_PATH=<装了 playwright 的 node_modules> node form-saver/test/run.cjs
 *
 * 页面用 page.route 挂在假域名上（https://forum.test 等），不访问外网。
 * browser.newPage() 每次都是新的 context，localStorage（= 模拟的 GM 存储）互不串。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'form-saver.user.js')
const FIX = path.join(__dirname, 'fixtures')
const t = h.createRunner('form-saver')

let browser

const DEBOUNCE = 1100 // 脚本防抖 800ms + 余量

const PROMPT = 'form-saver-ui .card'

/** 提示条文字（shadow DOM 是 open 的，locator 能穿进去）。 */
async function promptText(page, timeout = 2000) {
    const loc = page.locator(PROMPT)
    try {
        await loc.waitFor({ timeout })
    } catch (e) {
        return null
    }
    return loc.innerText()
}

/** 读模拟 GM 存储里某个站点的草稿桶。 */
function bucket(page, origin) {
    return page.evaluate(k => JSON.parse(localStorage.getItem('__gm:fs:d:' + k) || 'null'), origin)
}

/** 新页面：装脚本，把 origin 下的所有路径都用 fixture 应答；pages 可按 pathname 指定不同 fixture。 */
async function openPage(origin, fixture, opts = {}) {
    const page = await browser.newPage()
    page.__logs = []
    page.on('console', m => page.__logs.push(m.text()))
    const pages = opts.pages || {}
    await page.route(origin + '/**', route => {
        const u = new URL(route.request().url())
        const file = pages[u.pathname] || fixture
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(FIX, file)) })
    })
    await h.install(page, SCRIPT, { values: opts.values })
    await page.goto(origin + (opts.path || '/'))
    return page
}

async function main() {
    const env = await h.setup(FIX)
    browser = env.browser

    console.log('元数据')
    await t.test('@grant 与实际用到的 GM_* 一一对应', async () => {
        const src = fs.readFileSync(SCRIPT, 'utf8')
        const meta = h.parseMeta(src)
        const body = src.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '')
        const used = [...new Set(body.match(/\bGM_\w+/g))].sort()
        t.eq([...meta.grant].sort(), used)
    })
    await t.test('头部字段齐全', async () => {
        const meta = h.parseMeta(fs.readFileSync(SCRIPT, 'utf8'))
        for (const k of ['name', 'name:en', 'description', 'description:en', 'namespace', 'version', 'author', 'license', 'homepageURL', 'supportURL', 'updateURL', 'downloadURL']) {
            t.assert(meta[k], '缺少 @' + k)
        }
        t.assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(meta.version[0]), '版本号格式')
        t.eq(meta.updateURL[0], 'https://raw.githubusercontent.com/yilecoding/helper-scripts/main/form-saver/form-saver.user.js')
        t.eq(meta.downloadURL[0], meta.updateURL[0])
    })

    console.log('启动')
    await t.test('加载无异常，页面键不含 query、含 hash 路由', async () => {
        const page = await openPage('https://forum.test', 'basic.html', { path: '/new?utm_source=x#/draft' })
        await page.waitForTimeout(100)
        t.assert(page.__logs.some(l => l.includes('[草稿保存] 已启动 https://forum.test/new#/draft')), page.__logs.join('\n'))
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })
    await t.test('本站停用时不启动', async () => {
        const page = await openPage('https://forum.test', 'basic.html', {
            values: { 'fs:settings': { disabled: { 'https://forum.test': 1 }, query: {} } },
        })
        await page.waitForTimeout(100)
        t.assert(page.__logs.some(l => l.includes('本站已停用')), page.__logs.join('\n'))
        await page.close()
    })

    console.log('保存')
    await t.test('输入后防抖保存，键 = 表单 + name/id/结构路径', async () => {
        const page = await openPage('https://desk.test', 'fields.html', { path: '/ticket/new' })
        await page.fill('[name=subject]', '打印机坏了')
        await page.fill('#contact', '分机 1234')
        await page.fill('.noname', '三楼')
        await page.fill('[name=note]', '备注')
        await page.selectOption('[name=priority]', 'high')
        await page.selectOption('[name=tags]', ['a', 'c'])
        await page.check('[value=feature]')
        await page.check('[name=urgent]')
        await page.locator('[name="cc[]"]').nth(1).fill('boss@x.test')
        t.eq(await bucket(page, 'https://desk.test'), null, '防抖期间不应落盘')
        await page.waitForTimeout(DEBOUNCE)
        const d = (await bucket(page, 'https://desk.test'))['https://desk.test/ticket/new']
        t.eq(d.title, '工单')
        const v = Object.fromEntries(Object.entries(d.fields).map(([k, f]) => [k, f.v]))
        t.eq(v, {
            'form#ticket [name=subject]': '打印机坏了',
            'form#ticket #contact': '分机 1234',
            'form#ticket @div:1>span:1>input:1': '三楼',
            'form:1 [name=note]': '备注',
            'form#ticket [name=priority]': 'high',
            'form#ticket [name=tags]': ['a', 'c'],
            'form#ticket [name=kind]': 'feature',
            'form#ticket [name=urgent]': true,
            'form#ticket [name=cc[]]:1': 'boss@x.test',
        })
        await page.close()
    })
    await t.test('改回空/默认值就从草稿里删掉，整页都空了删页面', async () => {
        const page = await openPage('https://desk.test', 'fields.html')
        await page.fill('[name=subject]', 'x')
        await page.selectOption('[name=priority]', 'low')
        await page.waitForTimeout(DEBOUNCE)
        t.eq(Object.keys((await bucket(page, 'https://desk.test'))['https://desk.test/'].fields).length, 2)
        await page.fill('[name=subject]', '')
        await page.selectOption('[name=priority]', 'mid')
        await page.waitForTimeout(DEBOUNCE)
        t.eq(await bucket(page, 'https://desk.test'), null)
        await page.close()
    })

    console.log('隐私')
    await t.test('password/hidden/file/cc-*/验证码/卡号 都不存，只存普通字段', async () => {
        const page = await openPage('https://shop.test', 'privacy.html')
        await page.fill('[name=username]', 'alice') // 登录表单整个不存
        await page.fill('[name=pw]', 'hunter2')
        await page.fill('[name=comment]', '请包装好')
        await page.fill('[name=passenger]', '张三')
        await page.click('#toggle') // 「显示密码」：type 变成 text 之后再输入
        await page.fill('#show-pw', 'secret-visible')
        await page.evaluate(() => {
            const h = document.querySelector('[name=token]')
            h.value = 'csrf'
            h.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await page.setInputFiles('[name=avatar]', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
        await page.fill('[name=ccn]', '4111111111111111')
        await page.fill('[name=exp]', '12/30')
        await page.fill('[name=code]', '123456')
        await page.fill('[name=newpass]', 'n3w')
        await page.fill('[name=captcha]', 'abcd')
        await page.fill('[name=v]', '654321')
        await page.fill('[name=bank]', '6222020200112233')
        await page.fill('[name=memo]', '4111 1111 1111 1111') // 值像卡号（过 Luhn）
        await page.waitForTimeout(DEBOUNCE)
        const d = (await bucket(page, 'https://shop.test'))['https://shop.test/']
        t.eq(Object.keys(d.fields).sort(), ['form#checkout [name=comment]', 'form#checkout [name=passenger]'])
        const raw = await page.evaluate(() => JSON.stringify(localStorage))
        for (const secret of ['hunter2', 'alice', 'secret-visible', 'csrf', '4111', '12/30', '123456', 'n3w', 'abcd', '654321', '6222']) {
            t.assert(!raw.includes(secret), '存储里出现了 ' + secret)
        }
        await page.close()
    })
    await t.test('普通字段后来被填成卡号：已存的旧值也删掉', async () => {
        const page = await openPage('https://shop.test', 'privacy.html')
        await page.fill('[name=memo]', '周末送')
        await page.waitForTimeout(DEBOUNCE)
        t.assert((await bucket(page, 'https://shop.test'))['https://shop.test/'].fields['form#checkout [name=memo]'])
        await page.fill('[name=memo]', '4111-1111-1111-1111')
        await page.waitForTimeout(DEBOUNCE)
        t.eq(await bucket(page, 'https://shop.test'), null)
        await page.close()
    })

    console.log('恢复')
    await t.test('输入后刷新：出现提示，点恢复后值回来并派发 input/change', async () => {
        const page = await openPage('https://forum.test', 'basic.html', { path: '/new' })
        t.eq(await promptText(page, 300), null, '没有草稿时不提示')
        await page.fill('[name=title]', '标题一')
        await page.fill('[name=body]', '第一段\n第二段')
        await page.waitForTimeout(DEBOUNCE)
        await page.reload()
        const text = await promptText(page)
        t.assert(text && text.includes('检测到 2 个字段的草稿') && text.includes('刚刚'), String(text))
        t.eq(await page.inputValue('[name=title]'), '', '不自动填')
        await page.click('form-saver-ui [data-act=restore]')
        t.eq(await page.inputValue('[name=title]'), '标题一')
        t.eq(await page.inputValue('[name=body]'), '第一段\n第二段')
        t.eq(await page.getAttribute('[name=body]', 'data-input'), '1')
        t.eq(await page.getAttribute('[name=body]', 'data-change'), '1')
        t.assert((await promptText(page)).includes('已恢复 2 个字段'))
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })
    await t.test('勾选/单选/下拉/多选也能恢复', async () => {
        const page = await openPage('https://desk.test', 'fields.html')
        await page.selectOption('[name=priority]', 'high')
        await page.selectOption('[name=tags]', ['b', 'c'])
        await page.check('[value=feature]')
        await page.check('[name=urgent]')
        await page.waitForTimeout(DEBOUNCE)
        await page.reload()
        t.assert((await promptText(page)).includes('4 个字段'))
        await page.click('form-saver-ui [data-act=restore]')
        t.eq(await page.inputValue('[name=priority]'), 'high')
        t.eq(await page.$eval('[name=tags]', s => [...s.selectedOptions].map(o => o.value)), ['b', 'c'])
        t.eq(await page.isChecked('[value=feature]'), true)
        t.eq(await page.isChecked('[name=urgent]'), true)
        await page.close()
    })
    await t.test('不覆盖已有内容：提示后用户先填了一个字段，恢复只填空的那个', async () => {
        const page = await openPage('https://forum.test', 'basic.html')
        await page.fill('[name=title]', '旧标题')
        await page.fill('[name=body]', '旧正文')
        await page.waitForTimeout(DEBOUNCE)
        await page.reload()
        await promptText(page)
        await page.fill('[name=title]', '新标题')
        await page.click('form-saver-ui [data-act=restore]')
        t.eq(await page.inputValue('[name=title]'), '新标题')
        t.eq(await page.inputValue('[name=body]'), '旧正文')
        t.assert((await promptText(page)).includes('已恢复 1 个字段'))
        await page.close()
    })
    await t.test('不覆盖已有内容：字段已有内容时不计入，全都有内容就不提示', async () => {
        const page = await openPage('https://forum.test', 'basic.html')
        await page.fill('[name=title]', '旧标题')
        await page.fill('[name=body]', '旧正文')
        await page.waitForTimeout(DEBOUNCE)
        // 模拟服务端把正文渲染回来（编辑页 / 提交失败回显）：正文有内容，只剩标题可恢复
        await page.route('https://forum.test/**', r => r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: fs.readFileSync(path.join(FIX, 'basic.html'), 'utf8').replace('</textarea>', '服务端回显</textarea>'),
        }))
        await page.reload()
        t.assert((await promptText(page)).includes('检测到 1 个字段'))
        await page.click('form-saver-ui [data-act=restore]')
        t.eq(await page.inputValue('[name=body]'), '服务端回显')
        await page.route('https://forum.test/**', r => r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: fs.readFileSync(path.join(FIX, 'basic.html'), 'utf8')
                .replace('</textarea>', '服务端回显</textarea>').replace('name="title"', 'name="title" value="回显标题"'),
        }))
        await page.reload()
        t.eq(await promptText(page, 500), null)
        await page.close()
    })
    await t.test('忽略：提示消失、刷新不再提示，但草稿还在', async () => {
        const page = await openPage('https://forum.test', 'basic.html')
        await page.fill('[name=title]', '标题')
        await page.waitForTimeout(DEBOUNCE)
        await page.reload()
        await promptText(page)
        await page.click('form-saver-ui [data-act=dismiss]')
        t.eq(await page.locator(PROMPT).count(), 0)
        await page.reload()
        t.eq(await promptText(page, 500), null)
        t.assert((await bucket(page, 'https://forum.test'))['https://forum.test/'].fields['form#post [name=title]'])
        await page.close()
    })
    await t.test('页面样式隐藏不了提示条', async () => {
        const page = await openPage('https://forum.test', 'basic.html')
        await page.fill('[name=title]', '标题')
        await page.waitForTimeout(DEBOUNCE)
        await page.route('https://forum.test/**', r => r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: fs.readFileSync(path.join(FIX, 'basic.html'), 'utf8')
                .replace('</head>', '<style>form-saver-ui{display:none!important} button{color:red!important}</style></head>'),
        }))
        await page.reload()
        await promptText(page)
        t.assert(await page.locator('form-saver-ui [data-act=restore]').isVisible())
        t.eq(await page.locator('form-saver-ui [data-act=restore]').evaluate(b => getComputedStyle(b).color), 'rgb(255, 255, 255)')
        await page.close()
    })

    console.log('React 受控组件')
    await t.test('fixture 自检：直接 el.value = x 会被受控组件吞掉', async () => {
        const page = await openPage('https://app.test', 'react.html')
        await page.evaluate(() => {
            const el = document.getElementById('title')
            el.value = 'naive'
            el.dispatchEvent(new Event('input', { bubbles: true }))
        })
        t.eq(await page.inputValue('#title'), '', '模拟的 React 应该把值改回 state')
        t.eq(JSON.parse(await page.textContent('#state')).title, '')
        await page.close()
    })
    await t.test('受控输入能被保存（React 会把 defaultValue 同步成当前值）', async () => {
        const page = await openPage('https://app.test', 'react.html')
        await page.fill('#title', 'React 标题')
        await page.fill('#body', 'React 正文')
        await page.waitForTimeout(DEBOUNCE)
        t.eq(await page.evaluate(() => document.getElementById('title').defaultValue), 'React 标题', 'fixture 同步了 defaultValue')
        const d = (await bucket(page, 'https://app.test'))['https://app.test/']
        t.eq(Object.keys((d && d.fields) || {}).sort(), ['form#reply [name=body]', 'form#reply [name=title]'])
        await page.close()
    })
    await t.test('恢复后组件 state 拿到值，重新渲染也不回退', async () => {
        const page = await openPage('https://app.test', 'react.html')
        await page.fill('#title', 'React 标题')
        await page.fill('#body', 'React 正文')
        await page.selectOption('#lang', 'en')
        await page.check('#agree')
        await page.waitForTimeout(DEBOUNCE)
        await page.reload()
        t.assert((await promptText(page)).includes('4 个字段'))
        await page.click('form-saver-ui [data-act=restore]')
        await page.click('#rerender')
        t.eq(JSON.parse(await page.textContent('#state')), { title: 'React 标题', body: 'React 正文', lang: 'en', agree: true })
        t.eq(await page.inputValue('#title'), 'React 标题')
        t.eq(await page.inputValue('#body'), 'React 正文')
        t.eq(await page.isChecked('#agree'), true)
        await page.close()
    })

    console.log('SPA')
    await t.test('随机 id 降级为锚定结构路径：刷新后 id 全变了也能对上', async () => {
        const page = await openPage('https://mail.test', 'spa.html', { path: '/list' })
        await page.click('text=写信')
        await page.fill('textarea', '正文内容')
        await page.fill('[placeholder=主题]', '周报')
        await page.fill('.field:first-child input', 'boss@mail.test')
        await page.waitForTimeout(DEBOUNCE)
        const keys = Object.keys((await bucket(page, 'https://mail.test'))['https://mail.test/compose'].fields).sort()
        t.eq(keys, ['#app @main:1>div:1>input:1', '#app @main:1>div:2>input:1', '#app @main:1>div:3>textarea:1'])
        await page.reload() // 这次 body 最前面多了 cookie 横幅、id 全部重新生成
        t.eq(await promptText(page, 200), null, '字段还没渲染出来时不提示')
        const text = await promptText(page)
        t.assert(text && text.includes('检测到 3 个字段'), String(text))
        await page.click('form-saver-ui [data-act=restore]')
        t.eq(await page.inputValue('textarea'), '正文内容')
        t.eq(await page.inputValue('[placeholder=主题]'), '周报')
        await page.close()
    })
    await t.test('路由切换：离开写信页提示收起，回来再出现', async () => {
        const page = await openPage('https://mail.test', 'spa.html', { path: '/compose' })
        await page.waitForSelector('textarea')
        await page.fill('textarea', '写到一半')
        await page.waitForTimeout(DEBOUNCE)
        await page.click('text=列表')
        await page.reload()
        t.eq(await promptText(page, 600), null, '列表页没有草稿')
        await page.click('text=写信')
        t.assert((await promptText(page)).includes('1 个字段'))
        await page.click('text=列表')
        await page.waitForTimeout(500)
        t.eq(await page.locator(PROMPT).count(), 0, '离开后收起')
        await page.close()
    })
    await t.test('随机 id 判别：稳定的照常用，生成的降级', async () => {
        const stable = ['contact', 'user_email', 'address2', 'reply-box', 'feedback']
        const random = [':r1:', '«r2»', '_r_3_', 'el-id-1024-17', 'mui-38291', 'ember123', 'react-select-2-input',
            '8f14e45f-ceea-4e7a-9f3c-1b2c3d4e5f60', 'a3f9c01bd2', 'V1StGXR8_Z5jdHi6B']
        const ids = [...stable, ...random]
        const page = await browser.newPage()
        await page.route('https://ids.test/**', r => r.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><meta charset="utf-8"><div>' + ids.map(id => `<input id="${id}">`).join('') + '</div>',
        }))
        await h.install(page, SCRIPT)
        await page.goto('https://ids.test/')
        for (const id of ids) await page.fill(`[id="${id}"]`, 'v')
        await page.waitForTimeout(DEBOUNCE)
        const keys = Object.keys((await bucket(page, 'https://ids.test'))['https://ids.test/'].fields)
        const expected = ids.map((id, i) => (stable.includes(id) ? 'doc #' + id : 'doc @div:1>input:' + (i + 1)))
        t.eq(keys.sort(), expected.sort())
        await page.close()
    })

    console.log('富文本')
    await t.test('contenteditable：保存 HTML，刷新后恢复并派发 input', async () => {
        const page = await openPage('https://blog.test', 'rich.html')
        await page.click('#editor')
        await page.keyboard.type('第一行')
        await page.keyboard.press('Enter')
        await page.keyboard.type('second line')
        await page.waitForTimeout(DEBOUNCE)
        const f = (await bucket(page, 'https://blog.test'))['https://blog.test/'].fields['form#comment #editor']
        t.assert(f && f.k === 'rich' && f.l === '评论内容', JSON.stringify(f))
        await page.reload()
        t.assert((await promptText(page)).includes('1 个字段'))
        await page.click('form-saver-ui [data-act=restore]')
        t.eq(await page.$eval('#editor', e => e.innerText.replace(/\n+/g, '|')), '第一行|second line')
        t.assert(await page.evaluate(() => window.__editorInputs >= 1), '要派发 input')
        await page.close()
    })
    await t.test('富文本里的脚本/事件属性/javascript: 链接存之前就洗掉，恢复时不执行', async () => {
        const page = await openPage('https://blog.test', 'rich.html')
        await page.evaluate(() => {
            const ed = document.getElementById('editor')
            ed.innerHTML = '<p><b>粗体</b><a href="javascript:window.__pwned++">链接</a><a href="/ok">好链接</a></p>'
                + '<img src="data:," onerror="window.__pwned++"><script>window.__pwned++<\/script>'
            ed.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await page.waitForTimeout(DEBOUNCE)
        const v = (await bucket(page, 'https://blog.test'))['https://blog.test/'].fields['form#comment #editor'].v
        t.assert(!/onerror|javascript:|<script/i.test(v), v)
        t.assert(v.includes('<b>粗体</b>') && v.includes('href="/ok"'), v)
        // 再往存储里塞一份「被改过」的脏草稿，验证恢复时也会洗
        await page.evaluate(() => {
            const k = '__gm:fs:d:https://blog.test'
            const b = JSON.parse(localStorage.getItem(k))
            b['https://blog.test/'].fields['form#comment #editor'].v = '<p>脏</p><img src="data:," onerror="window.__pwned=100">'
            localStorage.setItem(k, JSON.stringify(b))
        })
        await page.reload()
        await promptText(page)
        await page.click('form-saver-ui [data-act=restore]')
        await page.waitForTimeout(200)
        t.eq(await page.evaluate(() => window.__pwned), 0)
        t.eq(await page.$eval('#editor', e => e.textContent), '脏')
        await page.close()
    })

    console.log('清理')
    const DAY = 86400000
    await t.test('过期：7 天前的草稿启动时删掉（包括别的站点的）', async () => {
        const now = Date.now()
        const f = (v, ago) => ({ v, k: 'text', l: v, t: now - ago })
        const page = await openPage('https://forum.test', 'basic.html', {
            values: {
                'fs:d:https://forum.test': {
                    'https://forum.test/': { t: now - 8 * DAY, fields: { 'form#post [name=title]': f('老', 8 * DAY), 'form#post [name=body]': f('新', DAY) } },
                    'https://forum.test/old': { t: now - 9 * DAY, fields: { 'doc #x': f('很老', 9 * DAY) } },
                },
                'fs:d:https://other.test': { 'https://other.test/': { t: now - 10 * DAY, fields: { 'doc #y': f('别处', 10 * DAY) } } },
            },
        })
        const b = await bucket(page, 'https://forum.test')
        t.eq(Object.keys(b), ['https://forum.test/'])
        t.eq(Object.keys(b['https://forum.test/'].fields), ['form#post [name=body]'])
        t.eq(await bucket(page, 'https://other.test'), null)
        t.assert((await promptText(page)).includes('1 个字段'))
        await page.close()
    })
    await t.test('上限：单站点超过 50 个页面时丢最旧的', async () => {
        const now = Date.now()
        const pages = {}
        for (let i = 0; i < 55; i++) {
            pages['https://forum.test/p' + i] = { t: now - (60 - i) * 60000, fields: { 'doc #a': { v: 'x' + i, k: 'text', l: 'a', t: now - (60 - i) * 60000 } } }
        }
        const page = await openPage('https://forum.test', 'basic.html', { path: '/new', values: { 'fs:d:https://forum.test': pages } })
        await page.fill('[name=title]', '最新')
        await page.waitForTimeout(DEBOUNCE)
        const keys = Object.keys(await bucket(page, 'https://forum.test'))
        t.eq(keys.length, 50)
        t.assert(keys.includes('https://forum.test/new') && keys.includes('https://forum.test/p54'))
        t.assert(!keys.includes('https://forum.test/p5') && keys.includes('https://forum.test/p6'))
        await page.close()
    })
    await t.test('上限：单站点体积超限时丢最旧的页面', async () => {
        const now = Date.now()
        const big = 'x'.repeat(15000)
        const pages = {}
        for (let i = 0; i < 40; i++) {
            pages['https://forum.test/p' + i] = { t: now - (60 - i) * 60000, fields: { 'doc #a': { v: big, k: 'text', l: 'a', t: now - (60 - i) * 60000 } } }
        }
        const page = await openPage('https://forum.test', 'basic.html', { path: '/new', values: { 'fs:d:https://forum.test': pages } })
        await page.fill('[name=body]', big)
        await page.waitForTimeout(DEBOUNCE)
        const b = await bucket(page, 'https://forum.test')
        t.assert(JSON.stringify(b).length <= 512 * 1024, '体积 ' + JSON.stringify(b).length)
        t.assert(b['https://forum.test/new'] && b['https://forum.test/p39'] && !b['https://forum.test/p0'])
        await page.close()
    })
    await t.test('跳转式提交：不立刻删，回到原页面提示「刚提交过」；过了宽限期删掉', async () => {
        const page = await openPage('https://forum.test', 'basic.html', { path: '/new', pages: { '/submit': 'done.html' } })
        await page.fill('[name=title]', '要发的标题')
        await page.fill('[name=body]', '要发的正文')
        await Promise.all([page.waitForURL('**/submit'), page.click('button[type=submit]')]) // 防抖还没到就提交
        const d = (await bucket(page, 'https://forum.test'))['https://forum.test/new']
        t.assert(d && Object.values(d.fields).every(f => f.s), '提交前要先落盘并打上提交标记')
        await page.goto('https://forum.test/new')
        const text = await promptText(page)
        t.assert(text.includes('刚提交过') && text.includes('2 个字段'), text)
        // 一小时后
        await page.evaluate(() => {
            const k = '__gm:fs:d:https://forum.test'
            const b = JSON.parse(localStorage.getItem(k))
            for (const f of Object.values(b['https://forum.test/new'].fields)) f.s -= 2 * 3600000
            localStorage.setItem(k, JSON.stringify(b))
        })
        await page.reload()
        t.eq(await promptText(page, 500), null)
        t.eq(await bucket(page, 'https://forum.test'), null)
        await page.close()
    })
    await t.test('跳转式提交失败（服务端回到空表单）：能恢复；对「刚提交过」点忽略就删掉', async () => {
        const page = await openPage('https://forum.test', 'basic.html', { path: '/new', pages: { '/submit': 'basic.html' } })
        await page.fill('[name=title]', '标题')
        await Promise.all([page.waitForURL('**/submit'), page.click('button[type=submit]')])
        await page.goBack({ waitUntil: 'load' }) // 用户点返回
        await page.reload()
        t.assert((await promptText(page)).includes('刚提交过'))
        await page.click('form-saver-ui [data-act=restore]')
        t.eq(await page.inputValue('[name=title]'), '标题')
        await page.waitForTimeout(DEBOUNCE)
        const f = (await bucket(page, 'https://forum.test'))['https://forum.test/new'].fields['form#post [name=title]']
        t.assert(!f.s, '恢复后重新落盘，不再带提交标记')
        // 再提交一次，这次「成功」了，回来点忽略
        await Promise.all([page.waitForURL('**/submit'), page.click('button[type=submit]')])
        await page.goto('https://forum.test/new')
        await promptText(page)
        await page.click('form-saver-ui [data-act=dismiss]')
        t.eq(await bucket(page, 'https://forum.test'), null)
        await page.close()
    })
    await t.test('页面内提交：表单被清空 = 成功，删草稿', async () => {
        const page = await openPage('https://ajax.test', 'ajax.html')
        await page.fill('[name=title]', 'ok 标题')
        await page.fill('[name=body]', '正文')
        await page.waitForTimeout(DEBOUNCE)
        await page.click('button[type=submit]')
        await page.waitForTimeout(1800)
        t.eq(await page.textContent('#msg'), '已发送')
        t.eq(await bucket(page, 'https://ajax.test'), null)
        await page.close()
    })
    await t.test('页面内提交：内容还在 = 失败，草稿保留并去掉提交标记', async () => {
        const page = await openPage('https://ajax.test', 'ajax.html')
        await page.fill('[name=title]', '坏标题')
        await page.click('button[type=submit]')
        await page.waitForTimeout(4300)
        t.eq(await page.textContent('#msg'), '标题不合格')
        const d = (await bucket(page, 'https://ajax.test'))['https://ajax.test/']
        t.assert(d && d.fields['form#f [name=title]'] && !d.fields['form#f [name=title]'].s, JSON.stringify(d))
        await page.close()
    })
    await t.test('表单 reset：删掉这张表单的草稿', async () => {
        const page = await openPage('https://ajax.test', 'ajax.html')
        await page.fill('[name=title]', '不要了')
        await page.waitForTimeout(DEBOUNCE)
        // 用 reset() 而不是点按钮：点按钮会让输入框失焦发 change，走的是普通防抖保存那条路
        await page.evaluate(() => document.getElementById('f').reset())
        await page.waitForTimeout(100)
        t.eq(await bucket(page, 'https://ajax.test'), null)
        await page.close()
    })
    await t.test('没有 <form> 的聊天框：发送后程序清空输入框，草稿删掉', async () => {
        const page = await openPage('https://chat.test', 'chat.html')
        await page.fill('#box', '你好')
        await page.waitForTimeout(DEBOUNCE)
        t.assert(await bucket(page, 'https://chat.test'))
        await page.press('#box', 'Enter')
        await page.waitForTimeout(600)
        t.eq(await page.textContent('#log'), '你好')
        t.eq(await bucket(page, 'https://chat.test'), null)
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
