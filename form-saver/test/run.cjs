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

    await env.close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
