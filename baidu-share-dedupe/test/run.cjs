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

/** 填来源、目标后点扫描核对，等按钮恢复（扫描结束，成功或失败）。目标默认 /存档。 */
async function scan(page, source, target = '/存档') {
    if (source !== undefined) await panel(page, '[data-ref=source]').fill(source)
    if (target !== undefined) await panel(page, '[data-ref=target]').fill(target)
    await panel(page, '[data-act=scan]').click()
    await page.waitForFunction(() => {
        const b = document.querySelector('#baidu-share-dedupe').shadowRoot.querySelector('[data-act=scan]')
        return !b.disabled
    })
    return status(page)
}

const calls = (page, p) => page.pan.calls.filter((c) => c.path === p)

/** 统计格四个数字。 */
const stats = (page) => Promise.all(['n-source', 'n-existing', 'n-missing', 'n-batches'].map((r) => panel(page, `[data-ref=${r}]`).textContent()))

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

    console.log('读分享文件夹')
    await t.test('分页读到底：250 个文件分 3 页', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(250))
        const page = await open(SHARE_URL, { pan })
        t.eq(await scan(page, '/照片'), '核对完成：待转存 250 个，分 1 批')
        const lists = calls(page, '/share/list')
        t.eq(lists.map((c) => c.query.page), ['1', '2', '3'])
        t.eq(lists[0].query.shorturl, SURL)
        t.eq(lists[0].query.dir, '/照片')
        t.eq(lists[0].query.shareid, pan.shareid)
        t.eq(lists[0].query.uk, pan.uk)
        t.eq(h.errors(page).length, 0)
        await page.close()
    })
    await t.test('/ 和空白用 root=1 列分享最外层', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(3)).addShare('/视频', FakePan.files(1))
        const page = await open(SHARE_URL, { pan })
        await panel(page, '[data-ref=source]').fill('  ')
        await scan(page)
        t.eq(calls(page, '/share/list').length, 1)
        const q = calls(page, '/share/list')[0].query
        t.eq([q.root, q.dir], ['1', undefined])
        await page.close()
    })
    await t.test('路径前后多余的斜杠会被去掉', async () => {
        const pan = new FakePan().addShare('/a/b', FakePan.files(2))
        const page = await open(SHARE_URL, { pan })
        await scan(page, ' a/b/ ')
        t.eq(calls(page, '/share/list')[0].query.dir, '/a/b')
        await page.close()
    })
    await t.test('提取码 Cookie（BDCLND）作为 sekey 带上', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(1))
        const page = await open(SHARE_URL, { pan })
        await page.context().addCookies([{ name: 'BDCLND', value: encodeURIComponent('k+e/y='), domain: 'pan.baidu.com', path: '/' }])
        await scan(page, '/照片')
        t.eq(calls(page, '/share/list')[0].query.sekey, 'k+e/y=')
        await page.close()
    })
    await t.test('页面上没有 bdstoken 时问一次接口', async () => {
        const pan = new FakePan({ bdstoken: '' }).addShare('/照片', FakePan.files(1))
        const page = await open(SHARE_URL, { pan })
        t.eq(await scan(page, '/照片'), '核对完成：待转存 1 个，分 1 批')
        t.eq(calls(page, '/api/gettemplatevariable').length, 1)
        await page.close()
    })

    console.log('核对')
    await t.test('按文件名 + 大小核对：已存在的跳过，统计和批次', async () => {
        const pan = new FakePan()
            .addShare('/照片', FakePan.files(1203))
            .addDisk('/存档', FakePan.files(1203).slice(0, 200))
            .addDisk('/存档', [['别的文件.txt', 5]])
        const page = await open(SHARE_URL, { pan })
        t.eq(await scan(page, '/照片'), '核对完成：待转存 1003 个，分 3 批')
        t.eq(await stats(page), ['1203', '200', '1003', '3'])
        await page.close()
    })
    await t.test('目标文件夹超过 1000 个时翻页读全', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(1100)).addDisk('/存档', FakePan.files(1050))
        const page = await open(SHARE_URL, { pan })
        t.eq(await scan(page, '/照片'), '核对完成：待转存 50 个，分 1 批')
        const lists = calls(page, '/api/list')
        t.eq(lists.map((c) => [c.query.dir, c.query.page, c.query.num]), [['/存档', '1', '1000'], ['/存档', '2', '1000']])
        await page.close()
    })
    await t.test('全部已存在', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(3)).addDisk('/存档', FakePan.files(3))
        const page = await open(SHARE_URL, { pan })
        t.eq(await scan(page, '/照片'), '核对完成：分享的 3 个文件都已在目标文件夹里')
        t.eq(await stats(page), ['3', '3', '0', '0'])
        await page.close()
    })
    await t.test('同名但大小不同：停下，不转存', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(3)).addDisk('/存档', [['IMG-0002.jpg', 1]])
        const page = await open(SHARE_URL, { pan })
        const msg = await scan(page, '/照片')
        t.assert(msg.includes('同名但大小不同的文件：IMG-0002.jpg（分享 1001 字节，目标 1 字节）'), msg)
        t.eq(await stats(page), ['–', '–', '–', '–'])
        await page.close()
    })
    await t.test('目标里有同名文件夹 / 分享里有重名文件：停下', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(2)).addDisk('/存档/IMG-0001.jpg', [])
        const page = await open(SHARE_URL, { pan })
        t.assert((await scan(page, '/照片')).includes('同名文件夹：IMG-0001.jpg'), await status(page))
        const pan2 = new FakePan().addShare('/照片', [['a.jpg', 1], ['a.jpg', 1]])
        const p2 = await open(SHARE_URL, { pan: pan2 })
        t.assert((await scan(p2, '/照片')).includes('重名文件：a.jpg'), await status(p2))
        await page.close()
        await p2.close()
    })
    await t.test('目标没填 / 填了根目录：提示先填', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(1))
        const page = await open(SHARE_URL, { pan })
        t.assert((await scan(page, '/照片', '')).includes('请填写保存到我的网盘的哪个文件夹'), await status(page))
        t.eq(calls(page, '/share/list').length, 0)
        await page.close()
    })

    console.log('出错时')
    await t.test('页面没有分享信息（还没输提取码）', async () => {
        const page = await open(SHARE_URL, { yunData: null })
        t.assert((await scan(page, '/照片')).includes('页面上没找到分享信息'), await status(page))
        t.eq(await panel(page, '[data-ref=status]').getAttribute('data-tone'), 'bad')
        t.assert(await panel(page, '[data-act=scan]').isEnabled(), '出错后扫描按钮恢复')
        await page.close()
    })
    await t.test('未登录（errno -6）给出人话提示', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(1)).fail('/share/list', -6)
        const page = await open(SHARE_URL, { pan })
        t.assert((await scan(page, '/照片')).includes('未登录或登录已失效'), await status(page))
        await page.close()
    })
    await t.test('文件夹不存在 / 空文件夹', async () => {
        const pan = new FakePan().addShare('/空', [])
        const page = await open(SHARE_URL, { pan })
        t.assert((await scan(page, '/没有')).includes('文件夹不存在'), await status(page))
        t.assert((await scan(page, '/空')).includes('是空的'), await status(page))
        await page.close()
    })
    await t.test('翻页出现重复文件就停，不冒漏文件的险', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(150))
        const rows = pan.share.get('/照片')
        rows.splice(100, 0, { ...rows[0], server_filename: 'IMG-0001.jpg' })   // 第 2 页开头又出现第 1 页的 fs_id
        const page = await open(SHARE_URL, { pan })
        t.assert((await scan(page, '/照片')).includes('重复文件'), await status(page))
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
