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

    console.log('合并单元格')

    const csvGrid = async (fixture, opts) => {
        const { page, downloads } = await open(fixture, opts)
        await h.menu(page, '导出页面上所有表格')
        const [d] = await downloads.waitFor(1)
        return { page, name: d.name, grid: parseDelimited(text(d.buf), ',') }
    }

    await t.test('rowspan/colspan 混合：逐格展开，thead → tbody → tfoot，rowspan 不越过 tbody', async () => {
        const { page, name, grid } = await csvGrid('complex.html')
        t.eq(name, '课程表.csv', 'caption 作为文件名')
        const expected = [
            ['时间', '周一', '周一', '周二'],
            ['时间', '上', '下', '周二'],
            ['第1节', '语文', '语文', '数学'],
            ['第2节', '语文', '语文', '英语'],
            ['第3节', '物理', '化学', '英语'],
            ['合计：4 节', '合计：4 节', '合计：4 节', '合计：4 节'],
        ]
        t.eq(grid.length, expected.length, '行数')
        for (let r = 0; r < expected.length; r++) {
            for (let c = 0; c < expected[r].length; c++) {
                t.eq(grid[r][c], expected[r][c], `第 ${r} 行第 ${c} 列`)
            }
            t.eq(grid[r].length, 4, `第 ${r} 行列数`)
        }
        await page.close()
    })

    await t.test('mergeFill=first：合并区只有左上角有值', async () => {
        const { page, grid } = await csvGrid('complex.html', { values: { mergeFill: 'first' } })
        t.eq(grid, [
            ['时间', '周一', '', '周二'],
            ['', '上', '下', ''],
            ['第1节', '语文', '', '数学'],
            ['第2节', '', '', '英语'],
            ['第3节', '物理', '化学', ''],
            ['合计：4 节', '', '', ''],
        ])
        await page.close()
    })

    await t.test('菜单切换填充方式：菜单名跟着变，之后的导出按新方式填', async () => {
        const { page, downloads } = await open('complex.html')
        t.assert((await h.gm(page)).menu.some(m => m.includes('每一格都填')), '默认是每一格都填')
        await h.menu(page, '合并单元格')
        const gm = await h.gm(page)
        t.assert(gm.menu.some(m => m.includes('只填第一格')), '切换后菜单名更新：' + gm.menu)
        t.eq(gm.menu.filter(m => m.includes('合并单元格')).length, 1, '旧菜单项要注销')
        await h.menu(page, '导出页面上所有表格')
        const [d] = await downloads.waitFor(1)
        t.eq(parseDelimited(text(d.buf), ',')[0], ['时间', '周一', '', '周二'])
        await page.close()
    })

    console.log('工具条')

    const BAR = 'table-export-toolbar .bar'
    const btn = action => `table-export-toolbar button[data-action="${action}"]`
    const barVisible = page => page.locator(BAR).isVisible()

    await t.test('悬停数据表浮出工具条，复制 TSV 调用 GM_setClipboard', async () => {
        const { page } = await open('toolbar.html')
        t.eq(await barVisible(page), false, '初始不显示')
        await page.hover('#data td >> nth=0')
        await page.locator(BAR).waitFor({ state: 'visible', timeout: 2000 })
        const bar = await page.locator(BAR).boundingBox()
        const table = await page.locator('#data').boundingBox()
        t.assert(bar.y + bar.height <= table.y + 1, `工具条在表格上沿外侧：bar=${JSON.stringify(bar)} table=${JSON.stringify(table)}`)
        t.assert(Math.abs(bar.x + bar.width - (table.x + table.width)) < 2, '右对齐')
        await page.click(btn('copy-tsv'))
        const gm = await h.gm(page)
        t.eq(gm.clipboard, { text: '名称\t数量\t操作\n苹果\t3\t点我\n香蕉\t5\t-', type: 'text' })
        t.eq(await page.locator(btn('copy-tsv')).textContent(), '✓', '点击后有反馈')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('工具条点下载 CSV 触发下载', async () => {
        const { page, downloads } = await open('toolbar.html')
        await page.hover('#data td >> nth=0')
        await page.click(btn('download-csv'))
        const [d] = await downloads.waitFor(1)
        t.eq(d.name, '工具条-表格1.csv')
        t.eq(parseDelimited(text(d.buf), ','), [['名称', '数量', '操作'], ['苹果', '3', '点我'], ['香蕉', '5', '-']])
        await page.close()
    })

    await t.test('工具条不挡表格：右上角单元格照样能点', async () => {
        const { page } = await open('toolbar.html')
        await page.hover('#data td >> nth=0')
        await page.locator(BAR).waitFor({ state: 'visible', timeout: 2000 })
        await page.click('#act', { timeout: 2000 })
        t.eq(await page.getAttribute('#act', 'data-n'), '1')
        t.eq(await barVisible(page), true, '点表格时工具条还在')
        await page.close()
    })

    await t.test('overflow:hidden 容器里的宽表：工具条贴着可见区域右边，不被裁掉、页面样式进不来', async () => {
        const { page } = await open('toolbar.html')
        await page.hover('#wide td >> nth=0')
        await page.locator(BAR).waitFor({ state: 'visible', timeout: 2000 })
        const bar = await page.locator(BAR).boundingBox()
        const clip = await page.locator('#clip').boundingBox()
        t.assert(bar.x + bar.width <= clip.x + clip.width + 1, `工具条应落在容器可见范围内：bar=${JSON.stringify(bar)} clip=${JSON.stringify(clip)}`)
        t.assert(bar.x >= clip.x, '左边也不越界')
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x: bar.x + bar.width - 5, y: bar.y + bar.height / 2 })
        t.eq(hit, 'TABLE-EXPORT-TOOLBAR', '按钮所在的点真的命中工具条（没被盖住）')
        t.eq(await page.evaluate(() => document.querySelector('table-export-toolbar').parentElement.tagName), 'HTML')
        const style = await page.locator(btn('copy-tsv')).evaluate(b => ({ bg: getComputedStyle(b).backgroundColor, size: getComputedStyle(b).fontSize }))
        t.assert(style.bg !== 'rgb(255, 0, 0)' && style.size !== '30px', '页面的 button 样式不该漏进来：' + JSON.stringify(style))
        await page.close()
    })

    await t.test('布局表格上不出工具条；移出表格后工具条收起', async () => {
        const { page } = await open('toolbar.html')
        await page.hover('#single-col td >> nth=0')
        await page.waitForTimeout(400)
        t.eq(await barVisible(page), false, '单列表格不出工具条')
        await page.hover('#data td >> nth=0')
        await page.locator(BAR).waitFor({ state: 'visible', timeout: 2000 })
        await page.hover('#away')
        await page.locator(BAR).waitFor({ state: 'hidden', timeout: 2000 })
        await page.close()
    })

    console.log('Markdown / JSON')

    async function hoverAndClick(page, cellSel, action) {
        await page.hover(cellSel)
        await page.click(btn(action))
    }

    await t.test('Markdown：多行表头合成一行，| 转义为 \\|，换行变 <br>', async () => {
        const { page } = await open('formats.html')
        await hoverAndClick(page, '#fmt td >> nth=0', 'copy-md')
        t.eq((await h.gm(page)).clipboard.text, [
            '| 名称 | 名称 |  | 说明 |',
            '| --- | --- | --- | --- |',
            '| 管道 | a\\|b | x | ls \\| grep foo |',
            '| 多行 | 001 |  | 第一行<br>第二行 |',
        ].join('\n'))
        await page.close()

        const p2 = (await open('complex.html')).page
        await hoverAndClick(p2, '#complex td >> nth=0', 'copy-md')
        const md = (await h.gm(p2)).clipboard.text.split('\n')
        t.eq(md[0], '| 时间 | 周一/上 | 周一/下 | 周二 |', '两行 thead 合成一行表头')
        t.eq(md.length, 2 + 4, '表头之后是 tbody 3 行 + tfoot 1 行')
        await p2.close()
    })

    await t.test('JSON：表头当键（重复键加后缀、空键补列名），值保留字符串，不带 BOM', async () => {
        const { page, downloads } = await open('formats.html')
        await hoverAndClick(page, '#fmt td >> nth=0', 'download-json')
        const [d] = await downloads.waitFor(1)
        t.eq(d.name, '命令速查.json')
        t.assert(d.buf[0] === 0x5b, 'JSON 开头不能有 BOM，应直接是 [')
        t.eq(JSON.parse(d.buf.toString('utf8')), [
            { 名称: '管道', 名称_2: 'a|b', 列3: 'x', 说明: 'ls | grep foo' },
            { 名称: '多行', 名称_2: '001', 列3: '', 说明: '第一行\n第二行' },
        ])
        await page.close()

        const r = await open('complex.html', { values: { mergeFill: 'first' } })
        await hoverAndClick(r.page, '#complex td >> nth=0', 'download-json')
        const [d2] = await r.downloads.waitFor(1)
        const rows = JSON.parse(d2.buf.toString('utf8'))
        t.eq(Object.keys(rows[0]), ['时间', '周一/上', '周一/下', '周二'], '只填第一格模式下表头键也不能丢')
        t.eq(rows[0], { 时间: '第1节', '周一/上': '语文', '周一/下': '', 周二: '数学' })
        await r.page.close()
    })

    console.log('ARIA 表格')

    await t.test('div + role=grid：识别、aria-colspan 展开、columnheader 行当表头、嵌套子表的行不混进来', async () => {
        const { page } = await open('aria.html')
        await page.hover('#grid [role="gridcell"] >> nth=0')
        await page.click(btn('copy-tsv'))
        const grid = parseDelimited((await h.gm(page)).clipboard.text, '\t')
        t.eq(grid.length, 4, '外层 4 行（子表的 2 行不算）')
        t.eq(grid.slice(0, 3), [['工号', '姓名', '部门'], ['001', '张三', '研发'], ['002', '李四（外派）', '李四（外派）']])
        t.eq(grid[3][0], '003', 'rowheader 也是单元格')
        t.assert(grid[3][1].startsWith('王五'), '嵌套子表所在的格：' + grid[3][1])
        t.eq(grid[3][2], '财务', '子表的格不能挤占外层的列')

        await page.close()
    })

    await t.test('ARIA 表格：导出全部按文档顺序，aria-label / aria-labelledby 当文件名，纯 div 不算', async () => {
        const { page, downloads } = await open('aria.html')
        await h.menu(page, '导出页面上所有表格')
        await downloads.waitFor(3)
        await page.waitForTimeout(800)
        t.eq(downloads.map(d => d.name), ['员工名单.csv', 'ARIA 表格-表格2.csv', '部门预算.csv'])
        t.eq(parseDelimited(text(downloads[1].buf), ','), [['子1', '子2'], ['子3', '子4']])
        t.eq(parseDelimited(text(downloads[2].buf), ','), [['部门', '预算'], ['研发', '100']])
        await page.close()
    })

    await t.test('ARIA 表格 JSON：没有 columnheader 时第一行当键', async () => {
        const { page, downloads } = await open('aria.html')
        await hoverAndClick(page, '#budget [role="cell"] >> nth=0', 'download-json')
        const [d] = await downloads.waitFor(1)
        t.eq(JSON.parse(d.buf.toString('utf8')), [{ 部门: '研发', 预算: '100' }])
        await page.close()
    })

    console.log('隐藏行列')

    await t.test('跳过 display:none 的行、列、行组，rowspan 跨过隐藏行落到下一可见行（与浏览器渲染一致）', async () => {
        const { page } = await open('hidden.html')
        await hoverAndClick(page, '#hidden td >> nth=0', 'copy-tsv')
        const grid = parseDelimited((await h.gm(page)).clipboard.text, '\t')
        t.eq(grid, [
            ['名称', '状态', '备注'],
            ['甲', '正常', '一'],
            ['甲', '正常', '三'],
            ['丙', '正常', '五'],
        ])
        // 和浏览器实际画出来的位置对一下：「三」所在的格和「备注」表头在同一列
        const x = await page.evaluate(() => {
            const cell = [...document.querySelectorAll('#hidden td')].find(td => td.innerText === '三')
            const head = [...document.querySelectorAll('#hidden th')].find(th => th.innerText === '备注')
            return [cell.getBoundingClientRect().left, head.getBoundingClientRect().left]
        })
        t.eq(x[0], x[1], '渲染结果里「三」确实在备注列')
        await page.close()
    })

    await t.test('ARIA 表格的隐藏行同样跳过', async () => {
        const { page } = await open('hidden.html')
        await hoverAndClick(page, '#aria-hidden [role="gridcell"] >> nth=0', 'copy-tsv')
        t.eq((await h.gm(page)).clipboard.text, '键\t值\na\t1\nc\t3')
        await page.close()
    })

    console.log('导出全部')

    async function openFrames() {
        const r = await open('frames.html')
        await r.page.frameLocator('#child').locator('#orders').waitFor()
        await r.page.waitForFunction(() => document.querySelector('#child').contentWindow.__gm)
        return r
    }

    await t.test('合并为一个 JSON：含同源 iframe 里的表，只下载一个文件', async () => {
        const { page, downloads } = await openFrames()
        await h.menu(page, '合并为一个 JSON')
        const [d] = await downloads.waitFor(1)
        await page.waitForTimeout(800)
        t.eq(downloads.length, 1)
        t.eq(d.name, '后台首页-全部表格.json')
        const data = JSON.parse(d.buf.toString('utf8'))
        t.eq(data.title, '后台首页')
        t.eq(data.tables.map(x => x.name), ['今日概览', '待处理订单'])
        t.eq(data.tables[1].header, ['单号', '金额'])
        t.eq(data.tables[1].rows, [{ 单号: 'D-1', 金额: '9.9' }, { 单号: 'D-2', 金额: '19.9' }])
        await page.close()
    })

    await t.test('逐个 CSV：每张表一个文件；菜单只在顶层注册一次', async () => {
        const { page, downloads } = await openFrames()
        const childMenu = await page.frame({ url: /frame-child/ }).evaluate(() => window.__gm.menu.filter(Boolean).length)
        t.eq(childMenu, 0, 'iframe 里不注册菜单')
        t.eq((await h.gm(page)).menu.filter(m => m.includes('导出页面上所有表格')).length, 2)
        await h.menu(page, '逐个 CSV')
        await downloads.waitFor(2)
        t.eq(downloads.map(d => d.name), ['今日概览.csv', '待处理订单.csv'])
        await page.close()
    })

    await t.test('iframe 里的表格也有工具条', async () => {
        const { page } = await openFrames()
        const child = page.frame({ url: /frame-child/ })
        await child.hover('#orders td >> nth=0')
        await child.click('table-export-toolbar button[data-action="copy-md"]')
        const clip = await child.evaluate(() => window.__gm.clipboard)
        t.eq(clip.text.split('\n')[0], '| 单号 | 金额 |')
        await page.close()
    })

    console.log('边界情况')

    async function openDynamic() {
        const r = await open('dynamic.html')
        await r.page.locator('#tall').waitFor()
        return r
    }

    await t.test('SPA 晚渲染的表格：悬停照样出工具条', async () => {
        const { page } = await openDynamic()
        await page.hover('#tall td >> nth=0')
        await page.locator(BAR).waitFor({ state: 'visible', timeout: 2000 })
        await page.close()
    })

    await t.test('滚动越过表格上沿：工具条贴在视口顶部、仍在表格范围内', async () => {
        const { page } = await openDynamic()
        await page.hover('#tall td >> nth=0')
        await page.locator(BAR).waitFor({ state: 'visible', timeout: 2000 })
        await page.mouse.wheel(0, 1500)
        await page.waitForTimeout(300)
        const bar = await page.locator(BAR).boundingBox()
        const table = await page.locator('#tall').boundingBox()
        t.assert(table.y < 0, '前提：表格上沿已经滚出视口')
        t.assert(bar && bar.y >= 0 && bar.y < 10, '工具条贴在视口顶部：' + JSON.stringify(bar))
        await page.close()
    })

    await t.test('表格被移除 / 尺寸变化：工具条跟着收起 / 重新对齐', async () => {
        const { page } = await openDynamic()
        await page.hover('#tall td >> nth=0')
        await page.locator(BAR).waitFor({ state: 'visible', timeout: 2000 })
        // 列变宽（比如异步加载了长文本），右边缘外移
        await page.evaluate(() => { document.querySelector('#tall th').style.width = '600px' })
        await page.waitForTimeout(200)
        const bar = await page.locator(BAR).boundingBox()
        const table = await page.locator('#tall').boundingBox()
        t.assert(Math.abs(bar.x + bar.width - (table.x + table.width)) < 2, `表格变宽后重新右对齐：bar=${JSON.stringify(bar)} table=${JSON.stringify(table)}`)
        // SPA 切路由把表格整个卸掉
        await page.evaluate(() => document.querySelector('#tall').remove())
        await page.locator(BAR).waitFor({ state: 'hidden', timeout: 2000 })
        await page.close()
    })

    await t.test('大表（5000 行）上移动鼠标不卡：mouseover 处理平均 < 2ms', async () => {
        const { page } = await openDynamic()
        await page.evaluate(() => render('huge', 5000, 10))
        await page.hover('#huge td >> nth=0')
        await page.locator(BAR).waitFor({ state: 'visible', timeout: 3000 })
        const avg = await page.evaluate(() => {
            const cells = document.querySelectorAll('#huge td')
            const t0 = performance.now()
            for (let i = 0; i < 50; i++) cells[i * 7].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
            return (performance.now() - t0) / 50
        })
        t.assert(avg < 2, `平均 ${avg.toFixed(2)}ms`)
        await page.close()
    })

    await close()
    t.done()
})().catch(e => {
    console.error(e)
    process.exit(1)
})
