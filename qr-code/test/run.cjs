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

    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
