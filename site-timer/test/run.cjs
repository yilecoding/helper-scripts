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

/**
 * 新开一个 context + 页面。opts.context 给了就在那个 context 里开（多标签同源共享 GM 存储）。
 * 返回的 page 带 __logs（控制台输出）。
 */
async function open(url, opts = {}) {
    const context = opts.context || (await env.browser.newContext({ timezoneId: 'Asia/Shanghai' }))
    if (!opts.context) await context.route(/^https:\/\//, serveFixtures)
    const page = await context.newPage()
    page.__logs = []
    page.on('console', m => page.__logs.push(m.text()))
    await h.install(page, SCRIPT, { values: opts.values })
    await page.goto(url)
    return page
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
        const context = await env.browser.newContext()
        await context.route(/^https:\/\//, serveFixtures)
        const got = []
        for (const [url] of cases) {
            const page = await open(url, { context })
            got.push([url, (page.__logs.find(l => l.startsWith('[使用时长] 站点')) || '').replace('[使用时长] 站点 ', '')])
            await page.close()
        }
        t.eq(got, cases)
        await context.close()
    })
    await t.test('IP 地址原样返回', async () => {
        const page = await open(env.base + '/index.html')
        t.assert(page.__logs.includes('[使用时长] 站点 127.0.0.1'), page.__logs.join('\n'))
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
