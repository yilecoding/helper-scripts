/*
 * qr-code 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node qr-code/test/run.cjs
 *
 * 编码器部分：按源码里的 QR-ENCODER-BEGIN / END 标记把编码器切出来，在 node 里直接跑，
 * 和 ISO/IEC 18004 附录里的公开样例逐个码字比对。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'qr-code.user.js')

const t = h.createRunner('qr-code')

/** 从脚本源码里切出编码器，返回 QR 对象。 */
function loadEncoder() {
    const src = fs.readFileSync(SCRIPT, 'utf8')
    const m = src.match(/\/\/ ---- QR-ENCODER-BEGIN ----\n([\s\S]*?)\n\s*\/\/ ---- QR-ENCODER-END ----/)
    if (!m) throw new Error('源码里找不到 QR-ENCODER-BEGIN / END 标记')
    return vm.runInNewContext(`${m[1]}\nQR`, { TextEncoder }, { filename: 'qr-encoder' })
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')

async function main() {
    const QR = loadEncoder()

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

    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
