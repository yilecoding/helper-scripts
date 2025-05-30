/*
 * 生成纯色 PNG（任意宽高），测试里按需造不同尺寸的图片，不用往仓库里塞二进制。
 * 只实现 RGB 8bit、无隔行、每行 filter 0 —— 浏览器能解码就够了。
 */
'use strict'

const zlib = require('zlib')

const CRC_TABLE = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c >>> 0
    }
    return t
})()

function crc32(buf) {
    let c = 0xffffffff
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
}

const cache = new Map()

function png(width, height, rgb = [0x4a, 0x90, 0xd9]) {
    const key = `${width}x${height}:${rgb}`
    if (cache.has(key)) return cache.get(key)
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 2 // RGB
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
    const raw = Buffer.alloc(row.length * height)
    for (let y = 0; y < height; y++) row.copy(raw, y * row.length)
    const out = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ])
    cache.set(key, out)
    return out
}

module.exports = { png }
