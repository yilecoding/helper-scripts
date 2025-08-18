// ==UserScript==
// @name         页面二维码
// @name:zh-CN   页面二维码
// @name:en      Page QR Code — Send the Current Page, a Link or Any Text to Your Phone
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.08.18.2
// @description  把当前页面、链接或一段文字变成二维码，手机一扫就过去。编码器自带、不依赖外部库。
// @description:zh-CN  把当前页面、链接或一段文字变成二维码，手机一扫就过去。编码器自带、不依赖外部库。
// @description:en  Turns the current page, a link or any text into a QR code so you can open it on your phone with one scan. Self-contained encoder, no external libraries.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        none
// @license      CC BY-NC-SA
// @run-at       document-idle
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/qr-code/qr-code.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/qr-code/qr-code.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「页面二维码」只看本脚本。 */
    const TAG = '[页面二维码]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        defaultEcl: 'M',        // 默认纠错等级：M 能扛 15% 污损，对屏幕扫码绰绰有余
    };

    // =========================================================================
    // 二维码编码器（ISO/IEC 18004）
    //
    // 测试按下面两行标记把这一段从源码里切出来，在 node 里直接跑 —— 标记别删，
    // 这一段里也不要引用 DOM / GM_* / 段外的变量。
    // =========================================================================

    // ---- QR-ENCODER-BEGIN ----
    const QR = (() => {
        // ---- GF(256)：本原多项式 x^8 + x^4 + x^3 + x^2 + 1（0x11D），生成元 α = 2 ----

        const EXP = new Uint8Array(512);    // 存两圈，乘法里 log 相加不用再取模
        const LOG = new Uint8Array(256);
        for (let i = 0, x = 1; i < 255; i++) {
            EXP[i] = EXP[i + 255] = x;
            LOG[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11d;
        }

        function gfMul(a, b) {
            return a && b ? EXP[LOG[a] + LOG[b]] : 0;
        }

        /** 生成多项式 g(x) = (x - α^0)(x - α^1)…(x - α^(n-1))，系数从高次到低次，首项 1 省略。 */
        const genCache = new Map();
        function rsGenerator(n) {
            let g = genCache.get(n);
            if (g) return g;
            g = new Uint8Array(n);
            g[n - 1] = 1;               // 从 g(x) = 1 开始（低次在后）
            for (let i = 0, root = 1; i < n; i++) {
                // 乘上 (x - α^i)：GF(2^8) 里减就是加，就是异或
                for (let j = 0; j < n; j++) {
                    g[j] = gfMul(g[j], root) ^ (j + 1 < n ? g[j + 1] : 0);
                }
                root = gfMul(root, 2);
            }
            genCache.set(n, g);
            return g;
        }

        /** 数据码字 × x^n 除以 g(x) 的余式，就是 n 个纠错码字。 */
        function rsEncode(data, n) {
            const g = rsGenerator(n);
            const rem = new Uint8Array(n);
            for (const b of data) {
                const factor = b ^ rem[0];
                rem.copyWithin(0, 1);
                rem[n - 1] = 0;
                for (let j = 0; j < n; j++) rem[j] ^= gfMul(g[j], factor);
            }
            return rem;
        }

        // ---- 版本表 ----

        const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

        // 每块纠错码字数、块数，按 [L, M, Q, H][版本] 排，下标 0 占位。
        // 抄自标准表 9；总码字数由下面的公式算，数据码字数 = 总数 - 块数 × 每块纠错码字数
        const ECC_PER_BLOCK = [
            [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
            [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
            [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
            [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        ];
        const NUM_BLOCKS = [
            [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
            [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
            [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
            [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
        ];

        /** 对齐图形的中心坐标（行列共用）。版本 32 那个「不规则」间距也是这个公式算出来的。 */
        function alignmentPositions(ver) {
            if (ver === 1) return [];
            const n = Math.floor(ver / 7) + 2;
            const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
            const res = [6];
            for (let pos = ver * 4 + 10; res.length < n; pos -= step) res.splice(1, 0, pos);
            return res;
        }

        /** 放得下数据的模块数（扣掉定位、分隔、时序、对齐、格式、版本信息和暗模块），含剩余位。 */
        function rawDataModules(ver) {
            let r = (16 * ver + 128) * ver + 64;
            if (ver >= 2) {
                const n = Math.floor(ver / 7) + 2;
                r -= (25 * n - 10) * n - 55;
                if (ver >= 7) r -= 36;
            }
            return r;
        }

        function totalCodewords(ver) {
            return rawDataModules(ver) >> 3;
        }

        function dataCodewordCount(ver, ecl) {
            const e = ECL_INDEX[ecl];
            return totalCodewords(ver) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];
        }

        // ---- 数据编码 ----

        const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
        const MODES = {
            numeric: { indicator: 0b0001, countBits: [10, 12, 14] },
            alphanumeric: { indicator: 0b0010, countBits: [9, 11, 13] },
            byte: { indicator: 0b0100, countBits: [8, 16, 16] },
        };

        function countBits(mode, ver) {
            return MODES[mode].countBits[ver <= 9 ? 0 : ver <= 26 ? 1 : 2];
        }

        /** 整段文字能用的最省模式。不做分段混排：常见输入（URL、一句话）混排省不了几个字节。 */
        function chooseMode(text) {
            if (/^[0-9]*$/.test(text)) return 'numeric';
            if ([...text].every((c) => ALNUM.includes(c))) return 'alphanumeric';
            return 'byte';
        }

        /**
         * 一段文字按指定模式编成的位串（不含模式指示符和长度字段，那两样随版本变）。
         * 返回 { mode, count, bits }，bits 是 0/1 数组。
         */
        function makeSegment(text, mode) {
            const bits = [];
            const put = (val, len) => {
                for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
            };
            if (mode === 'numeric') {
                if (!/^[0-9]*$/.test(text)) throw new Error('数字模式只能编 0-9');
                for (let i = 0; i < text.length; i += 3) {
                    const chunk = text.slice(i, i + 3);
                    put(parseInt(chunk, 10), chunk.length * 3 + 1);    // 3 位 → 10 bit，2 位 → 7，1 位 → 4
                }
                return { mode, count: text.length, bits };
            }
            if (mode === 'alphanumeric') {
                const idx = [...text].map((c) => ALNUM.indexOf(c));
                if (idx.includes(-1)) throw new Error('字母数字模式只能编 0-9 A-Z 空格 $%*+-./:');
                for (let i = 0; i + 1 < idx.length; i += 2) put(idx[i] * 45 + idx[i + 1], 11);
                if (idx.length % 2) put(idx[idx.length - 1], 6);
                return { mode, count: idx.length, bits };
            }
            const bytes = new TextEncoder().encode(text);   // 字节模式一律 UTF-8，长度字段数的是字节不是字符
            for (const b of bytes) put(b, 8);
            return { mode: 'byte', count: bytes.length, bits };
        }

        /** 某个版本下整个数据位流的长度；长度字段装不下 count 时返回 Infinity。 */
        function streamBits(seg, ver, eci) {
            const cb = countBits(seg.mode, ver);
            if (seg.count >= 1 << cb) return Infinity;
            return (eci ? 12 : 0) + 4 + cb + seg.bits.length;
        }

        /**
         * 文字 → 数据码字（已补齐到该版本的数据容量）。
         * opts: { ecl, mode: 'auto'|'numeric'|'alphanumeric'|'byte', minVersion, eci }
         * eci 只对字节模式生效：在最前面加 ECI 26（UTF-8）声明。
         * 超出版本 40 容量时抛错，err.code = 'TOO_LONG'。
         */
        function encodeData(text, opts = {}) {
            const ecl = opts.ecl || 'M';
            if (!(ecl in ECL_INDEX)) throw new Error('纠错等级只能是 L/M/Q/H');
            const mode = !opts.mode || opts.mode === 'auto' ? chooseMode(text) : opts.mode;
            const seg = makeSegment(text, mode);
            const eci = !!opts.eci && seg.mode === 'byte';

            let ver = Math.max(1, opts.minVersion || 1);
            for (; ver <= 40; ver++) {
                if (streamBits(seg, ver, eci) <= dataCodewordCount(ver, ecl) * 8) break;
            }
            if (ver > 40) {
                const err = new Error(`内容太长：${seg.count} 个${seg.mode === 'byte' ? '字节' : '字符'}，超出版本 40 的容量`);
                err.code = 'TOO_LONG';
                err.count = seg.count;
                err.mode = seg.mode;
                err.capacity = capacity(40, ecl, seg.mode, eci);
                throw err;
            }

            const bits = [];
            const put = (val, len) => {
                for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
            };
            if (eci) {
                put(0b0111, 4);
                put(26, 8);
            }
            put(MODES[seg.mode].indicator, 4);
            put(seg.count, countBits(seg.mode, ver));
            for (const b of seg.bits) bits.push(b);

            const capBits = dataCodewordCount(ver, ecl) * 8;
            put(0, Math.min(4, capBits - bits.length));         // 终止符：最多 4 个 0，放不下就少放
            put(0, (8 - (bits.length % 8)) % 8);                // 补到整字节
            const data = [];
            for (let i = 0; i < bits.length; i += 8) {
                let b = 0;
                for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
                data.push(b);
            }
            for (let pad = 0xec; data.length < capBits / 8; pad ^= 0xec ^ 0x11) data.push(pad);
            return { version: ver, ecl, mode: seg.mode, count: seg.count, eci, data };
        }

        /** 某版本、纠错等级、模式下最多能放多少个字符（字节模式是字节数）。 */
        function capacity(ver, ecl, mode, eci) {
            const avail = dataCodewordCount(ver, ecl) * 8 - (eci ? 12 : 0) - 4 - countBits(mode, ver);
            if (mode === 'numeric') {
                const n = Math.floor(avail / 10) * 3;
                const rest = avail % 10;
                return n + (rest >= 7 ? 2 : rest >= 4 ? 1 : 0);
            }
            if (mode === 'alphanumeric') return Math.floor(avail / 11) * 2 + (avail % 11 >= 6 ? 1 : 0);
            return Math.floor(avail / 8);
        }

        /**
         * 数据码字切块、每块算纠错码字，再按列交织。
         * 短块在前、长块（多一个数据码字）在后；交织时短块缺的那一列直接跳过。
         */
        function addEccAndInterleave(data, ver, ecl) {
            const e = ECL_INDEX[ecl];
            const numBlocks = NUM_BLOCKS[e][ver];
            const eccLen = ECC_PER_BLOCK[e][ver];
            const total = totalCodewords(ver);
            const numShort = numBlocks - (total % numBlocks);
            const shortDataLen = Math.floor(total / numBlocks) - eccLen;

            const blocks = [];
            for (let i = 0, k = 0; i < numBlocks; i++) {
                const len = shortDataLen + (i < numShort ? 0 : 1);
                const d = data.slice(k, k + len);
                k += len;
                blocks.push({ data: d, ecc: rsEncode(d, eccLen) });
            }
            const out = [];
            for (let i = 0; i <= shortDataLen; i++) {
                for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
            }
            for (let i = 0; i < eccLen; i++) {
                for (const b of blocks) out.push(b.ecc[i]);
            }
            return out;
        }

        return {
            gfMul, rsGenerator, rsEncode,
            alignmentPositions, rawDataModules, totalCodewords, dataCodewordCount,
            chooseMode, makeSegment, encodeData, capacity, addEccAndInterleave,
        };
    })();
    // ---- QR-ENCODER-END ----

    console.debug(TAG, '已加载');
})();
