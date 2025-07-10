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

    await env.close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
