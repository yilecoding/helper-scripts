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
    // 转存后的等待（每 3 秒查一次）用假时钟快进，测试不真等
    if (opts.clock) await page.clock.install()
    await h.install(page, SCRIPT, opts)
    await page.goto(url)
    // 等来源预填（可能要读一次分享最外层）结束，之后的调用记录从零算
    if (opts.ready !== false) {
        await page.locator('#baidu-share-dedupe[data-ready]').waitFor({ state: 'attached' })
        pan.calls = []
    }
    return page
}

/** 面板 shadow DOM 里的元素（Playwright 的 CSS 选择器默认穿透 open shadow root）。 */
const panel = (page, sel, opts) => page.locator('#baidu-share-dedupe').locator(sel, opts)
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

/** 扫描按钮恢复可用 = 当前操作结束。 */
const idle = (page) => page.evaluate(() => !document.querySelector('#baidu-share-dedupe').shadowRoot.querySelector('[data-act=scan]').disabled)

/**
 * 点开始转存，假时钟一秒一秒往前拨，直到结束。
 * onTick(i) 每拨一次调用一次（用来在中途点停止之类）。
 */
async function run(page, onTick) {
    await panel(page, '[data-act=run]').click()
    for (let i = 0; i < 2000 && !(await idle(page)); i++) {
        if (onTick) await onTick(i)
        await page.clock.runFor(1000)
    }
    t.assert(await idle(page), '转存没有结束')
    return status(page)
}

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
        const page = await open('https://pan.baidu.com/disk/home', { ready: false })
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
    await t.test('页面上没有 bdstoken 时问一次接口（之后复用）', async () => {
        const pan = new FakePan({ bdstoken: '' }).addShare('/照片', FakePan.files(1))
        const page = await open(SHARE_URL, { pan, ready: false })
        await page.locator('#baidu-share-dedupe[data-ready]').waitFor({ state: 'attached' })
        t.eq(await scan(page, '/照片'), '核对完成：待转存 1 个，分 1 批')
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

    console.log('分批转存')
    await t.test('1203 个分 3 批（500 / 500 / 203），每批到齐再下一批', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(1203))
        const page = await open(SHARE_URL, { pan, clock: true })
        t.assert(await panel(page, '[data-act=run]').isDisabled(), '没扫描前不能转存')
        await scan(page, '/照片')
        t.assert(await panel(page, '[data-act=run]').isEnabled(), '扫描后可以转存')
        t.eq(await run(page), '完成：分享的 1203 个文件都已在 /存档')
        t.eq(pan.transferred.map((x) => x.length), [500, 500, 203])
        t.eq(pan.disk.get('/存档').length, 1203)
        t.eq(await stats(page), ['1203', '1203', '0', '0'])
        t.eq(await panel(page, '[data-ref=progress-pct]').textContent(), '100%')
        t.assert(await panel(page, '[data-act=run]').isDisabled(), '做完后转存按钮变灰')
        const tr = calls(page, '/share/transfer')[0]
        t.eq([tr.method, tr.query.shareid, tr.query.from, tr.query.bdstoken, tr.form.path], ['POST', pan.shareid, pan.uk, 'tok123', '/存档'])
        t.eq(h.errors(page).length, 0)
        await page.close()
    })
    await t.test('fs_id 原样转发（超过 2^53 也不丢精度）', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(2))
        const page = await open(SHARE_URL, { pan, clock: true })
        await scan(page, '/照片')
        await run(page)
        const want = '[' + pan.share.get('/照片').map((e) => e.fs_id).sort().join(',') + ']'
        const got = calls(page, '/share/transfer')[0].form.fsidlist
        t.eq('[' + got.slice(1, -1).split(',').sort().join(',') + ']', want)
        t.assert(BigInt(got.slice(1, -1).split(',')[0]) > BigInt(Number.MAX_SAFE_INTEGER), 'fs_id 确实超过安全整数')
        await page.close()
    })
    await t.test('转存后文件晚到：多查几次等到齐', async () => {
        const pan = new FakePan({ lag: 3 }).addShare('/照片', FakePan.files(600))
        const page = await open(SHARE_URL, { pan, clock: true })
        await scan(page, '/照片')
        t.eq(await run(page), '完成：分享的 600 个文件都已在 /存档')
        t.eq(pan.transferred.map((x) => x.length), [500, 100])
        await page.close()
    })
    await t.test('返回成功但没到齐：等约 1 分钟后停下；重新扫描只补缺的', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(10))
        pan.drop = 2
        const page = await open(SHARE_URL, { pan, clock: true })
        await scan(page, '/照片')
        const msg = await run(page)
        t.assert(msg.includes('第 1 批接口返回成功，但等了约 60 秒目标文件夹里还没到齐'), msg)
        t.eq(await scan(page), '核对完成：待转存 2 个，分 1 批')
        t.eq(await run(page), '完成：分享的 10 个文件都已在 /存档')
        t.eq(pan.transferred.map((x) => x.length), [10, 2])
        await page.close()
    })
    await t.test('转存接口报错：停下并显示原因', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(3)).fail('/share/transfer', 12, '转存失败示例')
        const page = await open(SHARE_URL, { pan, clock: true })
        await scan(page, '/照片')
        const msg = await run(page)
        t.assert(msg.includes('转存失败示例（errno 12）'), msg)
        t.assert(await panel(page, '[data-act=run]').isEnabled(), '还有待转存，可以再点')
        await page.close()
    })

    console.log('停止与续跑')
    await t.test('转存中点停止：这一批做完后停下，不标红；重新扫描续跑', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(1203))
        const page = await open(SHARE_URL, { pan, clock: true })
        await scan(page, '/照片')
        let clicked = false
        const msg = await run(page, async () => {
            if (clicked) return
            t.assert(await panel(page, '[data-act=stop]').isVisible(), '转存中显示停止按钮')
            t.assert(await panel(page, '[data-act=run]').isHidden(), '转存中隐藏开始按钮')
            t.assert(await panel(page, '[data-ref=target]').isDisabled(), '转存中不能改文件夹')
            if (pan.transferred.length === 1) {
                await panel(page, '[data-act=stop]').click()
                clicked = true
            }
        })
        t.assert(msg.startsWith('已停止'), msg)
        t.eq(await panel(page, '[data-ref=status]').getAttribute('data-tone'), null)
        t.eq(pan.transferred.length, 1)
        t.assert(await panel(page, '[data-act=stop]').isHidden(), '结束后停止按钮收起')
        t.eq(await scan(page), '核对完成：待转存 703 个，分 2 批')
        t.eq(await run(page), '完成：分享的 1203 个文件都已在 /存档')
        t.eq(pan.transferred.map((x) => x.length), [500, 500, 203])
        await page.close()
    })
    await t.test('扫描后改了文件夹：要重新扫描才能转存', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(3))
        const page = await open(SHARE_URL, { pan })
        await scan(page, '/照片')
        t.assert(await panel(page, '[data-act=run]').isEnabled())
        await panel(page, '[data-ref=target]').fill('/别处')
        t.assert(await panel(page, '[data-act=run]').isDisabled(), '改了目标后转存按钮变灰')
        t.eq(await status(page), '文件夹改了，请重新扫描核对')
        t.eq(await stats(page), ['–', '–', '–', '–'])
        await page.close()
    })

    console.log('默认值')
    await t.test('来源取分享页地址里的路径（hash 和 ?path= 两种）', async () => {
        const pan = new FakePan().addShare('/照片/2024', FakePan.files(1)).addShare('/视频', [])
        let page = await open(SHARE_URL + '#list/path=%2F%E7%85%A7%E7%89%87%2F2024', { pan })
        t.eq(await panel(page, '[data-ref=source]').inputValue(), '/照片/2024')
        t.eq(calls(page, '/share/list').length, 0)
        await page.close()
        page = await open(SHARE_URL + '?path=%2F%E8%A7%86%E9%A2%91', { pan })
        t.eq(await panel(page, '[data-ref=source]').inputValue(), '/视频')
        await page.close()
    })
    await t.test('在最外层且只有一个文件夹：自动选它；有多个就不选', async () => {
        const pan = new FakePan().addShare('/9.28原图', FakePan.files(3))
        let page = await open(SHARE_URL, { pan })
        t.eq(await panel(page, '[data-ref=source]').inputValue(), '/9.28原图')
        await page.close()
        pan.addShare('/另一个', [])
        page = await open(SHARE_URL, { pan })
        t.eq(await panel(page, '[data-ref=source]').inputValue(), '')
        await page.close()
    })
    await t.test('切换分享里的文件夹（hashchange）跟着变；自己改过就不再动', async () => {
        const pan = new FakePan().addShare('/a', []).addShare('/b', [])
        const page = await open(SHARE_URL, { pan })
        await page.evaluate(() => { location.hash = '#list/path=%2Fa' })
        await page.waitForFunction(() => document.querySelector('#baidu-share-dedupe').shadowRoot.querySelector('[data-ref=source]').value === '/a')
        await panel(page, '[data-ref=source]').fill('/自己填的')
        await page.evaluate(() => { location.hash = '#list/path=%2Fb' })
        await page.waitForTimeout(200)
        t.eq(await panel(page, '[data-ref=source]').inputValue(), '/自己填的')
        await page.close()
    })
    await t.test('目标文件夹记住上次扫描成功的', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(1)).addDisk('/我的资源', [])
        let page = await open(SHARE_URL, { pan })
        await scan(page, '/照片', '/我的资源/')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:lastTarget'))), '/我的资源')
        await page.close()
        page = await open(SHARE_URL, { pan, values: { lastTarget: '/我的资源' } })
        t.eq(await panel(page, '[data-ref=target]').inputValue(), '/我的资源')
        await page.close()
    })

    console.log('选文件夹')
    /** 选择器里当前列出的条目文字，等「正在读取」消失。 */
    async function pickerItems(page, kind) {
        const box = panel(page, `[data-picker=${kind}]`)
        await page.waitForFunction((k) => !document.querySelector('#baidu-share-dedupe').shadowRoot
            .querySelector(`[data-picker=${k}] .folders`).textContent.includes('正在读取'), kind)
        return box.locator('.folders > *').allTextContents()
    }
    const crumbs = (page, kind) => panel(page, `[data-picker=${kind}] .crumbs button:not(.x)`).allTextContents()

    await t.test('浏览分享：进子文件夹、面包屑、上一级、选用', async () => {
        const pan = new FakePan().addShare('/照片/2024', FakePan.files(2)).addShare('/照片', [['说明.txt', 3]]).addShare('/视频', [])
        const page = await open(SHARE_URL, { pan })
        await panel(page, '[data-pick=source]').click()
        t.eq(await pickerItems(page, 'source'), ['照片', '视频'])
        await panel(page, '[data-picker=source] .folders button', { hasText: '照片' }).first().click()
        t.eq(await pickerItems(page, 'source'), ['上一级', '2024'])
        t.eq(await crumbs(page, 'source'), ['分享', '照片'])
        await panel(page, '[data-picker=source] .folders button.up').click()
        t.eq(await pickerItems(page, 'source'), ['照片', '视频'])
        await panel(page, '[data-picker=source] .folders button', { hasText: '照片' }).first().click()
        await panel(page, '[data-picker=source] .folders button', { hasText: '2024' }).click()
        t.eq(await pickerItems(page, 'source'), ['上一级', '这里没有子文件夹'])
        await panel(page, '[data-picker=source] .crumbs button', { hasText: '照片' }).click()
        t.eq(await pickerItems(page, 'source'), ['上一级', '2024'])
        await panel(page, '[data-picker=source] .pick-foot button').click()
        t.eq(await panel(page, '[data-ref=source]').inputValue(), '/照片')
        t.assert(await panel(page, '[data-picker=source]').isHidden(), '选完收起')
        t.eq(h.errors(page).length, 0)
        await page.close()
    })
    await t.test('分享的最外层是分享者的完整路径：用条目自带的 path，上一级回到最外层', async () => {
        const pan = new FakePan()
        pan.share.get('/').push({ fs_id: '9007199254799999', server_filename: '照片', size: 0, isdir: 1, path: '/资料/2024/照片' })
        pan.share.set('/资料/2024/照片', [])
        pan.addShare('/资料/2024/照片', FakePan.files(3))
        const page = await open(SHARE_URL, { pan })
        await panel(page, '[data-pick=source]').click()
        await pickerItems(page, 'source')
        await panel(page, '[data-picker=source] .folders button', { hasText: '照片' }).click()
        t.eq(await pickerItems(page, 'source'), ['上一级', '这里没有子文件夹'])
        t.eq(calls(page, '/share/list').at(-1).query.dir, '/资料/2024/照片')
        await panel(page, '[data-picker=source] .folders button.up').click()
        t.eq(await pickerItems(page, 'source'), ['照片'])
        t.eq(calls(page, '/share/list').at(-1).query.root, '1')
        await panel(page, '[data-picker=source] .folders button', { hasText: '照片' }).click()
        await pickerItems(page, 'source')
        await panel(page, '[data-picker=source] .pick-foot button').click()
        t.eq(await scan(page), '核对完成：待转存 3 个，分 1 批')
        await page.close()
    })
    await t.test('浏览我的网盘并选用；选完要重新核对', async () => {
        const pan = new FakePan().addShare('/照片', FakePan.files(2)).addDisk('/我的资源/照片', [])
        const page = await open(SHARE_URL, { pan })
        await scan(page, '/照片')
        t.assert(await panel(page, '[data-act=run]').isEnabled())
        await panel(page, '[data-pick=target]').click()
        t.eq(await pickerItems(page, 'target'), ['存档', '我的资源'])
        t.eq(await crumbs(page, 'target'), ['我的网盘'])
        await panel(page, '[data-picker=target] .folders button', { hasText: '我的资源' }).click()
        await panel(page, '[data-picker=target] .folders button', { hasText: '照片' }).click()
        t.eq(await panel(page, '[data-picker=target] .pick-foot span').textContent(), '/我的资源/照片')
        await panel(page, '[data-picker=target] .pick-foot button').click()
        t.eq(await panel(page, '[data-ref=target]').inputValue(), '/我的资源/照片')
        t.assert(await panel(page, '[data-act=run]').isDisabled(), '换了目标要重新核对')
        await page.close()
    })
    await t.test('同时只开一个选择器；再点浏览收起；读取失败显示原因', async () => {
        const pan = new FakePan().fail('/api/list', -6)
        const page = await open(SHARE_URL, { pan })
        await panel(page, '[data-pick=source]').click()
        await pickerItems(page, 'source')
        await panel(page, '[data-pick=target]').click()
        t.assert(await panel(page, '[data-picker=source]').isHidden(), '开目标时收起来源')
        t.assert((await pickerItems(page, 'target'))[0].includes('读取失败：/api/list：未登录或登录已失效'))
        await panel(page, '[data-pick=target]').click()
        t.assert(await panel(page, '[data-picker=target]').isHidden(), '再点一次收起')
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
        const pan = new FakePan().addShare('/照片', FakePan.files(1))
        const page = await open(SHARE_URL, { pan })
        pan.fail('/share/list', -6)
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
