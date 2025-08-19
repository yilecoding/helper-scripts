/*
 * qr-code 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node qr-code/test/run.cjs
 *
 * 编码器部分：按源码里的 QR-ENCODER-BEGIN / END 标记把编码器切出来，在 node 里直接跑，
 * 和 ISO/IEC 18004 附录里的公开样例逐个码字比对。
 *
 * 真实解码：生成的矩阵画到 canvas 上，交给 ZXing（html5-qrcode 打包的那份）解码，比对原文。
 * 仓库不带解码器，按顺序找：环境变量 QR_DECODER（html5-qrcode.min.js 的路径）
 * → require.resolve('html5-qrcode/html5-qrcode.min.js') → 下面 DECODER_CANDIDATES。
 * 都找不到时跳过解码用例并打印一行提示（码字级的标准样例照样跑）。
 *
 * 页面都用 page.route 挂在假域名 https://example.com 下，不访问外网。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'qr-code.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://example.com'

const DECODER_CANDIDATES = [
    '/home/yujie_ao/code/avcp/frontend/node_modules/.pnpm/html5-qrcode@2.3.8/node_modules/html5-qrcode/html5-qrcode.min.js',
]

function findDecoder() {
    if (process.env.QR_DECODER) return process.env.QR_DECODER
    try { return require.resolve('html5-qrcode/html5-qrcode.min.js') } catch (e) { /* 没装 */ }
    return DECODER_CANDIDATES.find((p) => fs.existsSync(p)) || null
}

const t = h.createRunner('qr-code')

/** 从脚本源码里切出编码器，返回 QR 对象。 */
function loadEncoder() {
    const src = fs.readFileSync(SCRIPT, 'utf8')
    const m = src.match(/\/\/ ---- QR-ENCODER-BEGIN ----\n([\s\S]*?)\n\s*\/\/ ---- QR-ENCODER-END ----/)
    if (!m) throw new Error('源码里找不到 QR-ENCODER-BEGIN / END 标记')
    return vm.runInNewContext(`${m[1]}\nQR`, { TextEncoder }, { filename: 'qr-encoder' })
}

/** 新开页面，把假域名的请求映射到 fixtures（用正则匹配：glob 对带中文的路径不可靠）。 */
async function open(browser, file = 'page.html', opts = {}) {
    const context = opts.context || (await browser.newContext({ viewport: { width: 1280, height: 800 } }))
    const page = await context.newPage()
    page.on('console', (m) => { if (m.type() === 'error') console.log('      [page error]', m.text()) })
    await page.route(/^https:\/\/example\.com\//, (route) => {
        const url = new URL(route.request().url())
        const name = url.pathname.endsWith('.html') ? path.basename(url.pathname) : file
        const fp = path.join(FIXTURES, name)
        if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
    })
    if (opts.install !== false) await h.install(page, SCRIPT, opts)
    await page.goto(SITE + '/' + file)
    return page
}

/**
 * 往页面里装解码器，返回 decode(modules) → 解出的文字（都失败返回 'ERR:…'）。
 * 先按每模块 4px 画；解不出再换 2px、3px 重画重解 —— ZXing-js 对个别矩阵在某些像素尺寸下
 * 找不到定位图形（同一矩阵与 node-qrcode 的输出逐位相同，换个尺寸就能解，是解码器那边的事），
 * 能解出与原文完全一致的文字本身就证明了编码正确。
 */
async function decoderOn(page, decoderPath) {
    await page.addScriptTag({ path: decoderPath })
    await installCanvasDecoder(page)
    return (modules) => page.evaluate(async (mods) => {
        let out = ''
        for (const scale of [4, 2, 3]) {
            const n = mods.length, quiet = 4
            const c = document.createElement('canvas')
            c.width = c.height = (n + quiet * 2) * scale
            const g = c.getContext('2d')
            g.fillStyle = '#fff'
            g.fillRect(0, 0, c.width, c.height)
            g.fillStyle = '#000'
            mods.forEach((row, r) => row.forEach((v, col) => { if (v) g.fillRect((col + quiet) * scale, (r + quiet) * scale, scale, scale) }))
            out = await window.__decodeCanvas(c)
            if (!out.startsWith('ERR:')) return out
        }
        return out
    }, modules.map((row) => Array.from(row)))
}

/** 解一个 canvas（页面里已经装好解码器）。挂在 window 上，UI 用例直接拿浮层里的 canvas 来解。 */
async function installCanvasDecoder(page) {
    await page.evaluate(() => {
        window.__decodeCanvas = async (canvas) => {
            const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
            const file = new File([blob], 'qr.png', { type: 'image/png' })
            if (!document.getElementById('__reader')) {
                const d = document.createElement('div')
                d.id = '__reader'
                d.style.display = 'none'
                document.body.appendChild(d)
            }
            // 关掉 BarcodeDetector：要测的是 ZXing 这一个确定的解码器
            const q = new window.Html5Qrcode('__reader', { verbose: false, useBarCodeDetectorIfSupported: false, formatsToSupport: [0] })
            try { return await q.scanFile(file, false) } catch (e) { return 'ERR:' + e }
        }
    })
}

const HOST = '#qr-code-userscript-host'

/** 浮层是否打开。 */
function overlayOpen(page) {
    return page.evaluate((sel) => !!document.querySelector(sel), HOST)
}

/** 浮层里的文字信息。 */
function overlayInfo(page) {
    return page.evaluate((sel) => document.querySelector(sel).shadowRoot.querySelector('.info').textContent, HOST)
}

/**
 * 断言浮层里那张图扫出来是 expected。有解码器就真解；没有就退一步：
 * 画布边长应等于 QR.encode(expected) 的尺寸 × 缩放（至少证明画的是那段内容对应的版本）。
 */
async function expectOverlayQr(page, expected, QR, hasDecoder, opts = {}) {
    if (hasDecoder) {
        const out = await page.evaluate((sel) => window.__decodeCanvas(document.querySelector(sel).shadowRoot.querySelector('canvas.qr')), HOST)
        t.eq(out, expected, '浮层二维码解码')
    } else {
        const q = QR.encode(expected, { ecl: opts.ecl || 'M' })
        const w = await page.evaluate((sel) => document.querySelector(sel).shadowRoot.querySelector('canvas.qr').width, HOST)
        t.eq(w % (q.size + 8), 0, '画布边长是 (模块数 + 静区) 的整数倍')
    }
}

/** 打开装好脚本（和解码器，如果有）的测试页。 */
async function openUi(browser, decoderPath, opts = {}) {
    const page = await open(browser, opts.file || 'page.html', opts)
    await page.waitForFunction(() => window.__gm && window.__gm.menu.length > 0)
    if (decoderPath) {
        await page.addScriptTag({ path: decoderPath })
        await installCanvasDecoder(page)
    }
    return page
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')

async function main() {
    const QR = loadEncoder()
    const { browser, close } = await h.setup(FIXTURES)

    console.log('编码器（node）')

    await t.test('GF(256) 乘法：α^7 · α = α^8 = 0x1D（按 0x11D 约简）', async () => {
        t.eq(QR.gfMul(0x80, 2), 0x1d)
        t.eq(QR.gfMul(0, 0x53), 0)
        t.eq(QR.gfMul(1, 0xab), 0xab)
    })

    await t.test('RS 生成多项式 n=7 的系数（α 的幂次）与标准附录 A 一致', async () => {
        // ISO/IEC 18004 附录 A：g(x) = x^7 + α^87 x^6 + α^229 x^5 + α^146 x^4 + α^149 x^3 + α^238 x^2 + α^102 x + α^21
        const exps = [87, 229, 146, 149, 238, 102, 21]
        const alpha = (e) => { let x = 1; for (let i = 0; i < e; i++) x = QR.gfMul(x, 2); return x }
        t.eq(Array.from(QR.rsGenerator(7)), exps.map(alpha))
    })

    await t.test('RS 纠错码字：ISO 附录样例 "01234567" 1-M', async () => {
        const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
        t.eq(hex(QR.rsEncode(data, 10)), 'a5 24 d4 c1 ed 36 c7 87 2c 55')
    })

    await t.test('RS 纠错码字："HELLO WORLD" 1-M（10 个）与 1-Q（13 个）', async () => {
        const m = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
        t.eq(Array.from(QR.rsEncode(m, 10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
        const q = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236]
        t.eq(Array.from(QR.rsEncode(q, 13)), [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16])
    })

    await t.test('数据码字：ISO 样例 "01234567" 1-M（数字模式、终止符、0xEC/0x11 填充）', async () => {
        const r = QR.encodeData('01234567', { ecl: 'M' })
        t.eq([r.version, r.mode], [1, 'numeric'])
        t.eq(hex(r.data), '10 20 0c 56 61 80 ec 11 ec 11 ec 11 ec 11 ec 11')
    })

    await t.test('数据码字："HELLO WORLD" 1-M（字母数字模式）', async () => {
        const r = QR.encodeData('HELLO WORLD', { ecl: 'M' })
        t.eq([r.version, r.mode], [1, 'alphanumeric'])
        t.eq(r.data, [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17])
    })

    await t.test('模式自动选择：纯数字 / 大写字母数字 / 小写或中文走字节', async () => {
        t.eq(QR.chooseMode('0123456789'), 'numeric')
        t.eq(QR.chooseMode('HTTPS://EXAMPLE.COM/A-B'), 'alphanumeric')
        t.eq(QR.chooseMode('https://example.com/'), 'byte')
        t.eq(QR.chooseMode('二维码'), 'byte')
        t.eq(QR.chooseMode(''), 'numeric', '空串取最短的数字模式')
        t.eq(QR.encodeData('二维码').count, 9, '字节模式数的是 UTF-8 字节')
        t.eq(QR.encodeData('Ab', { mode: 'byte' }).mode, 'byte', '可以强制字节模式')
    })

    await t.test('容量与 ISO 表 7 一致', async () => {
        const cases = [
            [1, 'L', 'numeric', 41], [1, 'L', 'alphanumeric', 25], [1, 'L', 'byte', 17],
            [1, 'M', 'numeric', 34], [1, 'H', 'byte', 7], [10, 'M', 'byte', 213],
            [40, 'L', 'numeric', 7089], [40, 'L', 'alphanumeric', 4296], [40, 'L', 'byte', 2953],
            [40, 'M', 'byte', 2331], [40, 'Q', 'byte', 1663], [40, 'H', 'byte', 1273],
        ]
        for (const [v, e, m, n] of cases) t.eq(QR.capacity(v, e, m), n, `${v}-${e} ${m}`)
        // 总码字数：版本 1 = 26，版本 7 = 196，版本 40 = 3706
        t.eq([QR.totalCodewords(1), QR.totalCodewords(7), QR.totalCodewords(40)], [26, 196, 3706])
    })

    await t.test('版本自动选最小：刚好放满与多一个字节', async () => {
        const v = (s, ecl, mode) => QR.encodeData(s, { ecl, mode }).version
        t.eq(v('a'.repeat(17), 'L'), 1)
        t.eq(v('a'.repeat(18), 'L'), 2)
        t.eq(v('1'.repeat(41), 'L'), 1)
        t.eq(v('1'.repeat(42), 'L'), 2)
        t.eq(v('a'.repeat(213), 'M'), 10)
        t.eq(v('a'.repeat(214), 'M'), 11)
        // 版本 9→10 时字节模式的长度字段从 8 位变 16 位：v9-L 能放 230 字节
        t.eq(v('a'.repeat(230), 'L'), 9)
        t.eq(v('a'.repeat(2953), 'L'), 40)
        t.eq(v('', 'M'), 1, '空串也能编（版本 1）')
    })

    await t.test('超出版本 40：抛 TOO_LONG，带容量', async () => {
        let err = null
        try { QR.encodeData('a'.repeat(2954), { ecl: 'L' }) } catch (e) { err = e }
        t.assert(err, '应该抛错')
        t.eq([err.code, err.count, err.capacity, err.mode], ['TOO_LONG', 2954, 2953, 'byte'])
        try { QR.encodeData('中'.repeat(425), { ecl: 'H' }) } catch (e) { err = e }
        t.eq([err.count, err.capacity], [1275, 1273], '中文按 3 字节/字算')
    })

    await t.test('对齐图形坐标与 ISO 附录 E 一致', async () => {
        t.eq(QR.alignmentPositions(1), [])
        t.eq(QR.alignmentPositions(2), [6, 18])
        t.eq(QR.alignmentPositions(7), [6, 22, 38])
        t.eq(QR.alignmentPositions(32), [6, 34, 60, 86, 112, 138])
        t.eq(QR.alignmentPositions(36), [6, 24, 50, 76, 102, 128, 154])
        t.eq(QR.alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170])
    })

    await t.test('分块交织：5-Q 是 2 块 15 + 2 块 16，短块缺的那一列跳过', async () => {
        const data = Array.from({ length: 62 }, (_, i) => i)
        t.eq(QR.dataCodewordCount(5, 'Q'), 62)
        const out = QR.addEccAndInterleave(data, 5, 'Q')
        t.eq(out.length, 134)
        t.eq(out.slice(0, 8), [0, 15, 30, 46, 1, 16, 31, 47])
        t.eq(out.slice(56, 62), [14, 29, 44, 60, 45, 61], '最后一列只有两个长块')
        // 纠错码字也是按列交织：第一列是 4 个块各自的第一个纠错码字
        const ecc0 = [data.slice(0, 15), data.slice(15, 30), data.slice(30, 46), data.slice(46)].map((d) => QR.rsEncode(d, 18)[0])
        t.eq(out.slice(62, 66), ecc0)
    })

    await t.test('格式信息 BCH 与 ISO 表 C.1 一致', async () => {
        t.eq(QR.formatBits('M', 0).toString(2).padStart(15, '0'), '101010000010010')
        t.eq(QR.formatBits('L', 0).toString(2).padStart(15, '0'), '111011111000100')
        t.eq(QR.formatBits('Q', 0).toString(2).padStart(15, '0'), '011010101011111')
        t.eq(QR.formatBits('H', 7).toString(2).padStart(15, '0'), '000100000111011')
        t.eq(QR.formatBits('M', 5).toString(2).padStart(15, '0'), '100000011001110')
    })

    await t.test('版本信息 BCH 与 ISO 表 D.1 一致', async () => {
        t.eq(QR.versionBits(7).toString(16), '7c94')
        t.eq(QR.versionBits(8).toString(16), '85bc')
        t.eq(QR.versionBits(21).toString(16), '15683')
        t.eq(QR.versionBits(40).toString(16), '28c69')
    })

    await t.test('罚分 N1：同色连续 5 个 3 分，每多一个 +1', async () => {
        t.eq(QR.penalty([[1, 1, 1, 1, 1]]), { n1: 3, n2: 0, n3: 0, n4: 100, total: 103 })
        const p = QR.penalty([[1, 1, 1, 1, 1, 1, 1, 0, 0, 0]])
        t.eq([p.n1, p.n4], [5, 40], '连续 7 个 = 5 分；70% 深色偏 20% = 40 分')
        t.eq(QR.penalty([[1, 0, 1, 0, 1, 0, 1, 0]]).total, 0)
    })

    await t.test('罚分 N2：每个同色 2×2 块 3 分，重叠的分别计', async () => {
        const p = QR.penalty([[0, 0, 0], [0, 0, 0], [0, 0, 0]])
        t.eq([p.n1, p.n2, p.n3, p.n4], [0, 12, 0, 100])
        const q = QR.penalty([[1, 1, 0, 1], [1, 1, 1, 0], [0, 1, 0, 1], [1, 0, 1, 0]])
        t.eq(q.n2, 3)
    })

    await t.test('罚分 N3：1:1:3:1:1 两侧各自带 4 个浅色各算 40，符号外按浅色（静区）', async () => {
        t.eq(QR.penalty([[0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]]).n3, 80, '左边 4 个浅色 + 右边静区')
        t.eq(QR.penalty([[1, 0, 1, 1, 1, 0, 1]]).n3, 80, '两侧都是静区')
        const p = QR.penalty([[1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1]])
        t.eq([p.n3, p.n4], [0, 20], '两侧都不够 4 个浅色：不罚；7/11 深色偏 13.6% → 20')
        t.eq(QR.penalty([[0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 0]]).n3, 40, '左边 3 个浅色 + 静区凑够 4 个')
        t.eq(QR.penalty([[1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0]]).n3, 0, '左边只有 3 个浅色、右边紧跟深色')
    })

    await t.test('罚分 N4：深色占比每偏离 50% 满 5% 加 10 分', async () => {
        const line = (dark, total) => [Array.from({ length: total }, (_, i) => (i < dark ? 1 : 0))]
        t.eq(QR.penalty(line(10, 20)).n4, 0)
        t.eq(QR.penalty(line(11, 20)).n4, 10, '55% 正好偏 5%')
        t.eq(QR.penalty(line(13, 20)).n4, 30, '65% 偏 15%')
        t.eq(QR.penalty(line(7, 20)).n4, 30, '35% 同样偏 15%')
        t.eq(QR.penalty(line(0, 20)).n4, 100)
    })

    await t.test('自动掩码 = 8 种里罚分最低的那个（格式信息画上之后算）', async () => {
        for (const [text, ecl] of [['https://example.com/', 'M'], ['HELLO WORLD', 'Q'], ['二维码'.repeat(30), 'H']]) {
            const scores = Array.from({ length: 8 }, (_, k) => QR.penalty(QR.encode(text, { ecl, mask: k }).modules).total)
            const auto = QR.encode(text, { ecl })
            t.eq(scores[auto.mask], Math.min(...scores), `${text.slice(0, 12)} 罚分 ${scores}`)
        }
    })

    await t.test('矩阵结构：三个定位图形、时序图形、暗模块、两份格式信息一致', async () => {
        const q = QR.encode('https://example.com/', { ecl: 'Q' })
        const m = q.modules, n = q.size
        t.eq(n, q.version * 4 + 17)
        const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']
        const block = (r0, c0) => finder.map((_, r) => Array.from(m[r0 + r].slice(c0, c0 + 7)).join(''))
        t.eq(block(0, 0), finder)
        t.eq(block(0, n - 7), finder)
        t.eq(block(n - 7, 0), finder)
        for (let i = 8; i < n - 8; i++) t.eq([m[6][i], m[i][6]], [(i + 1) % 2, (i + 1) % 2], `时序 ${i}`)
        t.eq(m[n - 8][8], 1, '暗模块')
        // 读回两份格式信息（位 14 → 0）
        const a = [], b = []
        for (let i = 0; i <= 5; i++) a[i] = m[i][8]
        a[6] = m[7][8]; a[7] = m[8][8]; a[8] = m[8][7]
        for (let i = 9; i < 15; i++) a[i] = m[8][14 - i]
        for (let i = 0; i < 8; i++) b[i] = m[8][n - 1 - i]
        for (let i = 8; i < 15; i++) b[i] = m[n - 15 + i][8]
        const val = (bits) => bits.reduce((acc, bit, i) => acc | (bit << i), 0)
        t.eq(val(a), QR.formatBits('Q', q.mask))
        t.eq(val(b), QR.formatBits('Q', q.mask))
    })

    const decoderPath = findDecoder()
    if (!decoderPath) {
        console.log('  - 跳过真实解码用例：没找到 html5-qrcode.min.js（设 QR_DECODER 指过去）')
    } else {
        console.log(`\n真实解码（ZXing：${path.basename(path.dirname(decoderPath))}）`)
        const page = await open(browser, 'page.html', { install: false })
        const decode = await decoderOn(page, decoderPath)
        const cases = [
            ['纯数字', '01234567890123456789', {}, 'numeric'],
            ['大写字母数字', 'HTTPS://EXAMPLE.COM/A-B/C?X', {}, 'byte'],
            ['大写字母数字（无 ?）', 'HELLO WORLD $%*+-./:', { ecl: 'H' }, 'alphanumeric'],
            ['URL', 'https://example.com/path/to/page?q=二维码&lang=zh#top', {}, 'byte'],
            ['中文', '扫一扫，把这一页带到手机上。', {}, 'byte'],
            ['中文 + ECI', '扫一扫，把这一页带到手机上。', { eci: true }, 'byte'],
            ['emoji / 西欧字母', 'café ñ 😀', {}, 'byte'],
            ['空串', '', {}, 'numeric'],
            ['版本 40-L 满载', 'x'.repeat(2953), { ecl: 'L' }, 'byte'],
            ['版本 40-H 满载数字', '7'.repeat(3057), { ecl: 'H' }, 'numeric'],
        ]
        for (const [name, text, opts, mode] of cases) {
            await t.test(`解码比对：${name}`, async () => {
                const q = QR.encode(text, opts)
                t.eq(q.mode, mode)
                const out = await decode(q.modules)
                t.assert(out === text, `v${q.version}-${q.ecl} mask ${q.mask}，解出 ${JSON.stringify(String(out).slice(0, 60))}`)
            })
        }
        await t.test('解码比对：8 种掩码 × 4 个纠错等级都能解', async () => {
            for (const ecl of ['L', 'M', 'Q', 'H']) {
                for (let mask = 0; mask < 8; mask++) {
                    const text = `mask ${mask} ecl ${ecl} 二维码`
                    t.eq(await decode(QR.encode(text, { ecl, mask }).modules), text, `${ecl} mask ${mask}`)
                }
            }
        })
        await page.context().close()
    }

    console.log('\n浮层')

    await t.test('菜单打开当前页二维码，扫出来是当前地址', async () => {
        const page = await openUi(browser, decoderPath)
        t.eq((await h.gm(page)).menu, ['当前页面二维码（Alt+Q）'])
        t.eq(await overlayOpen(page), false)
        await h.menu(page, '当前页面二维码')
        t.eq(await overlayOpen(page), true)
        await expectOverlayQr(page, SITE + '/page.html', QR, !!decoderPath)
        t.eq(h.errors(page).map(String), [])
        await page.context().close()
    })

    await t.test('Alt+Q 打开、再按一次关闭；Esc 关闭且不传给页面', async () => {
        const page = await openUi(browser, decoderPath)
        await page.evaluate(() => { window.__pageEsc = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__pageEsc++ }) })
        await page.keyboard.press('Alt+KeyQ')
        t.eq(await overlayOpen(page), true)
        await page.keyboard.press('Alt+KeyQ')
        t.eq(await overlayOpen(page), false, '再按一次关闭')
        await page.keyboard.press('Alt+KeyQ')
        await page.keyboard.press('Escape')
        t.eq(await overlayOpen(page), false, 'Esc 关闭')
        t.eq(await page.evaluate(() => window.__pageEsc), 0, '关浮层的 Esc 不该再触发页面自己的 Esc')
        await page.keyboard.press('Escape')
        t.eq(await page.evaluate(() => window.__pageEsc), 1, '浮层关了以后 Esc 照常给页面')
        await page.context().close()
    })

    await t.test('点浮层外面关闭，点面板里面不关', async () => {
        const page = await openUi(browser, decoderPath)
        await page.keyboard.press('Alt+KeyQ')
        await page.locator(HOST + ' canvas.qr').click()
        t.eq(await overlayOpen(page), true, '点二维码本身不关')
        // 在面板里按下、拖到外面松开（选文字时常见）也不关
        const box = await page.locator(HOST + ' .panel').boundingBox()
        await page.mouse.move(box.x + 20, box.y + 20)
        await page.mouse.down()
        await page.mouse.move(10, 10)
        await page.mouse.up()
        t.eq(await overlayOpen(page), true, '从面板里拖出去松开不关')
        await page.mouse.click(10, 10)
        t.eq(await overlayOpen(page), false)
        await page.context().close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
