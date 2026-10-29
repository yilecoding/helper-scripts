/*
 * baidu-share-dedupe 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node baidu-share-dedupe/test/run.cjs
 *
 * 不访问外网，也不碰真实网盘：https://pan.baidu.com 下的请求全部用 page.route 接住，
 * 分享页回 fixtures/share.html（把 yunData 填进去），接口由 fake-pan.cjs 里的假网盘回答。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')
const { FakePan } = require('./fake-pan.cjs')

const SCRIPT = path.join(__dirname, '..', 'baidu-share-dedupe.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SHARE_HTML = fs.readFileSync(path.join(FIXTURES, 'share.html'), 'utf8')
const SURL = 'TestShareKey_01'
const SHARE_URL = 'https://pan.baidu.com/s/1' + SURL

const t = h.createRunner('baidu-share-dedupe')
let env

/**
 * 新开一个页面，pan.baidu.com 的请求交给假网盘。
 * opts.pan      FakePan 实例（默认新建一个空的）
 * opts.yunData  写进分享页的 window.yunData；null 表示不写
 */
async function open(url, opts = {}) {
    const pan = opts.pan || new FakePan()
    const page = await env.browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.pan = pan
    await page.route(/^https:\/\/pan\.baidu\.com\//, async (route) => {
        const req = route.request()
        const u = new URL(req.url())
        if (/^\/(s\/|share\/init|disk\/)/.test(u.pathname)) {
            const yunData = opts.yunData === undefined ? pan.yunData() : opts.yunData
            const script = yunData ? 'window.yunData = ' + JSON.stringify(yunData) : ''
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: SHARE_HTML.replace('/*YUNDATA*/', script) })
        }
        const r = await pan.handle(req.method(), u, req.postData() || '')
        route.fulfill({ status: r.status || 200, contentType: 'application/json; charset=utf-8', body: r.body })
    })
    await h.install(page, SCRIPT, opts)
    await page.goto(url)
    return page
}

/** 面板 shadow DOM 里的元素（Playwright 的 CSS 选择器默认穿透 open shadow root）。 */
const panel = (page, sel) => page.locator('#baidu-share-dedupe').locator(sel)
const status = (page) => panel(page, '[data-ref=status]').textContent()

async function main() {
    env = await h.setup(FIXTURES)

    console.log('元数据')
    await t.test('@grant 与实际用到的 GM_* 一一对应', async () => {
        const src = fs.readFileSync(SCRIPT, 'utf8')
        const meta = h.parseMeta(src)
        const body = src.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '')
        const used = [...new Set(body.match(/\bGM_\w+/g) || [])].sort()
        t.eq(meta.grant.filter(g => g !== 'none' && g !== 'unsafeWindow').sort(), used)
    })
    await t.test('头部字段齐全', async () => {
        const meta = h.parseMeta(fs.readFileSync(SCRIPT, 'utf8'))
        for (const k of ['name', 'name:en', 'description', 'description:en', 'namespace', 'version', 'author', 'license', 'homepageURL', 'supportURL', 'updateURL', 'downloadURL']) {
            t.assert(meta[k], '缺少 @' + k)
        }
        t.assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(meta.version[0]), '版本号格式')
        t.eq(meta.namespace[0], 'https://github.com/yilecoding/helper-scripts')
        t.eq(meta.author[0], '壹樂（V：ita1125）')
        t.eq(meta.license[0], 'MIT')
        t.eq(meta.updateURL[0], 'https://raw.githubusercontent.com/yilecoding/helper-scripts/main/baidu-share-dedupe/baidu-share-dedupe.user.js')
        t.eq(meta.downloadURL[0], meta.updateURL[0])
        t.assert(!/@require/.test(fs.readFileSync(SCRIPT, 'utf8')), '不能 @require 外部脚本')
    })

    console.log('只在分享页出现')
    await t.test('/s/1xxx 分享页显示面板', async () => {
        const page = await open(SHARE_URL)
        await panel(page, '.panel').waitFor()
        t.eq(await status(page), '准备就绪')
        t.eq(h.errors(page).length, 0)
        await page.close()
    })
    await t.test('/share/init?surl= 提取码页也显示', async () => {
        const page = await open('https://pan.baidu.com/share/init?surl=' + SURL)
        await panel(page, '.panel').waitFor()
        await page.close()
    })
    await t.test('自己的网盘首页不显示', async () => {
        const page = await open('https://pan.baidu.com/disk/home')
        await page.waitForTimeout(300)
        t.eq(await page.locator('#baidu-share-dedupe').count(), 0)
        t.eq((await h.gm(page)).menu.length, 0)
        await page.close()
    })
    await t.test('收起 / 展开，菜单和 ✕ 显示 / 隐藏', async () => {
        const page = await open(SHARE_URL)
        await panel(page, '[data-act=fold]').click()
        t.assert(await panel(page, '.body').isHidden(), '收起后正文隐藏')
        t.eq(await panel(page, '[data-act=fold]').getAttribute('title'), '展开')
        await panel(page, '[data-act=fold]').click()
        t.assert(await panel(page, '.body').isVisible(), '展开后正文显示')
        await h.menu(page, '显示 / 隐藏转存面板')
        t.assert(await panel(page, '.panel').isHidden(), '菜单隐藏面板')
        await h.menu(page, '显示 / 隐藏转存面板')
        t.assert(await panel(page, '.panel').isVisible(), '菜单再显示')
        await panel(page, '[data-act=close]').click()
        t.assert(await panel(page, '.panel').isHidden(), '✕ 隐藏面板')
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exitCode = 1
    if (env) env.close()
})
