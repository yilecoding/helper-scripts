/*
 * table-export 测试。运行：
 *   NODE_PATH=/path/to/node_modules node table-export/test/run.cjs
 *
 * 下载走的是页面里的 <a download>，不经过 GM_download，
 * 所以用 Playwright 的 download 事件接住真实文件、读字节断言（连 BOM 一起验）。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'table-export.user.js')
const t = h.createRunner('table-export')

/** 解析 CSV/TSV（RFC 4180 引号规则），测试里用来逐格比对。 */
function parseDelimited(text, sep) {
    const rows = []
    let row = [], field = '', i = 0, quoted = false
    while (i < text.length) {
        const c = text[i]
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue }
            if (c === '"') { quoted = false; i++; continue }
            field += c; i++; continue
        }
        if (c === '"' && field === '') { quoted = true; i++; continue }
        if (c === sep) { row.push(field); field = ''; i++; continue }
        if (c === '\r' && text[i + 1] === '\n') i++
        if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
        field += c; i++
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row) }
    return rows
}

/** 收集页面上发生的下载：[{ name, buf }]。 */
function collectDownloads(page) {
    const list = []
    page.on('download', async d => {
        const item = { name: d.suggestedFilename(), buf: null }
        list.push(item)
        item.buf = fs.readFileSync(await d.path())
    })
    list.waitFor = async (n, timeout = 5000) => {
        const end = Date.now() + timeout
        while (Date.now() < end) {
            if (list.length >= n && list.slice(0, n).every(x => x.buf)) return list
            await new Promise(r => setTimeout(r, 50))
        }
        throw new Error(`等 ${n} 个下载超时，实际 ${list.length} 个：${list.map(x => x.name).join(', ')}`)
    }
    return list
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const text = buf => buf.subarray(3).toString('utf8')

;(async () => {
    const { browser, base, close } = await h.setup(path.join(__dirname, 'fixtures'))

    async function open(fixture, opts) {
        const page = await browser.newPage()
        await h.install(page, SCRIPT, opts)
        const downloads = collectDownloads(page)
        await page.goto(`${base}/${fixture}`)
        await page.waitForFunction(() => window.__gm.menu.length > 0)
        return { page, downloads }
    }

    console.log('识别')

    await t.test('布局表格不被识别，只导出数据表', async () => {
        const { page, downloads } = await open('layout.html')
        await h.menu(page, '导出页面上所有表格')
        await downloads.waitFor(2)
        await page.waitForTimeout(1000)   // 确认后面没有多余的下载
        t.eq(downloads.map(d => d.name), ['2026 年第三季度销量.csv', '布局表格混排页-表格2.csv'])
        t.eq(parseDelimited(text(downloads[1].buf), ','), [['姓名', '分数'], ['张三', '90']])
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    console.log('CSV')

    await t.test('CSV：BOM、RFC 4180 转义、<br> 和块级元素变换行、去首尾空白', async () => {
        const { page, downloads } = await open('basic.html')
        await h.menu(page, '导出页面上所有表格')
        const [d] = await downloads.waitFor(1)
        t.eq(d.name, '订单_明细_2026_.csv', '文件名里的非法字符要替换')
        t.assert(d.buf.subarray(0, 3).equals(BOM), '开头必须是 UTF-8 BOM')
        const csv = text(d.buf)
        t.eq(csv.split('\r\n')[1], 'A001,"含逗号,的备注","1,200"')
        t.eq(csv.split('\r\n')[2], 'A002,"他说""你好""",30')
        t.assert(csv.endsWith('\r\n'), '行尾 CRLF')
        t.eq(parseDelimited(csv, ','), [
            ['编号', '备注', '金额'],
            ['A001', '含逗号,的备注', '1,200'],
            ['A002', '他说"你好"', '30'],
            ['A003', '第一行\n第二行', '45'],
            ['A004', '块一\n块二', '中文'],
        ])
        await page.close()
    })

    await close()
    t.done()
})().catch(e => {
    console.error(e)
    process.exit(1)
})
