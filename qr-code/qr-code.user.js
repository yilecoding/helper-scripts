// ==UserScript==
// @name         页面二维码
// @name:zh-CN   页面二维码
// @name:en      Page QR Code — Send the Current Page, a Link or Any Text to Your Phone
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.08.26.9
// @description  把当前页面、链接或一段文字变成二维码，手机一扫就过去。编码器自带、不依赖外部库。
// @description:zh-CN  把当前页面、链接或一段文字变成二维码，手机一扫就过去。编码器自带、不依赖外部库。
// @description:en  Turns the current page, a link or any text into a QR code so you can open it on your phone with one scan. Self-contained encoder, no external libraries.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
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
        hotkey: 'KeyQ',         // 和 Alt 组合；按物理键位（KeyboardEvent.code）匹配
        quietZone: 4,           // 静区宽度（模块数），标准要求至少 4
        displaySize: 240,       // 浮层里二维码的显示边长（CSS 像素）
        exportSize: 1024,       // 下载 / 复制的图片大约多大（像素），实际取模块整数倍
        hoverDelay: 500,        // 按住 Alt 悬停链接多久浮出小二维码（毫秒）
        hoverSize: 140,         // 链接小二维码的显示边长
        hoverHideDelay: 300,    // 鼠标离开链接后多久收起（留时间移到小卡片上去点）
    };

    const HOST_ID = 'qr-code-userscript-host';
    const HOVER_ID = 'qr-code-userscript-hover';

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

        // ---- 格式信息 / 版本信息（BCH） ----

        const FORMAT_ECL = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };   // 注意不是按 L<M<Q<H 的顺序编号

        /** 15 位格式信息：2 位纠错等级 + 3 位掩码，BCH(15,5) 生成多项式 0x537，再异或 0x5412 防全 0。 */
        function formatBits(ecl, mask) {
            const data = (FORMAT_ECL[ecl] << 3) | mask;
            let rem = data;
            for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            return ((data << 10) | rem) ^ 0x5412;
        }

        /** 18 位版本信息（版本 ≥ 7 才有）：6 位版本号 + BCH(18,6) 生成多项式 0x1F25，不异或。 */
        function versionBits(ver) {
            let rem = ver;
            for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
            return (ver << 12) | rem;
        }

        // ---- 矩阵 ----

        const MASKS = [
            (r, c) => (r + c) % 2 === 0,
            (r) => r % 2 === 0,
            (r, c) => c % 3 === 0,
            (r, c) => (r + c) % 3 === 0,
            (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
            (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
            (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
            (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
        ];

        /** 画功能图形，返回 { size, m, fn }：m[行][列] 1 = 深色，fn 标记哪些格是功能图形（数据和掩码都不碰）。 */
        function buildFunctionPatterns(ver) {
            const size = ver * 4 + 17;
            const m = Array.from({ length: size }, () => new Uint8Array(size));
            const fn = Array.from({ length: size }, () => new Uint8Array(size));
            const set = (r, c, dark) => {
                m[r][c] = dark ? 1 : 0;
                fn[r][c] = 1;
            };

            for (let i = 0; i < size; i++) {
                set(6, i, i % 2 === 0);     // 时序图形
                set(i, 6, i % 2 === 0);
            }
            // 三个定位图形连同一圈白色分隔符：以中心为原点，切比雪夫距离 2 和 4 的是白圈
            for (const [cr, cc] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
                for (let dr = -4; dr <= 4; dr++) {
                    for (let dc = -4; dc <= 4; dc++) {
                        const r = cr + dr, c = cc + dc;
                        if (r < 0 || r >= size || c < 0 || c >= size) continue;
                        const d = Math.max(Math.abs(dr), Math.abs(dc));
                        set(r, c, d !== 2 && d !== 4);
                    }
                }
            }
            // 对齐图形：坐标两两组合，和三个定位图形重叠的三个角跳过
            const pos = alignmentPositions(ver);
            const last = pos.length - 1;
            pos.forEach((r, i) => pos.forEach((c, j) => {
                if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
                for (let dr = -2; dr <= 2; dr++) {
                    for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
                }
            }));
            // 先用随便一个值占住格式信息的位置（标成功能格，数据不往里放），选完掩码再写真值
            drawFormat(m, fn, 'M', 0);
            if (ver >= 7) {
                const bits = versionBits(ver);
                for (let i = 0; i < 18; i++) {
                    const bit = (bits >>> i) & 1;
                    const a = size - 11 + (i % 3), b = Math.floor(i / 3);
                    set(b, a, bit);     // 右上：6 行 × 3 列
                    set(a, b, bit);     // 左下：3 行 × 6 列
                }
            }
            return { size, m, fn };
        }

        /** 格式信息两份：左上角绕定位图形一圈；另一份拆成右上（低 8 位）+ 左下（高 7 位）。外加那个固定的暗模块。 */
        function drawFormat(m, fn, ecl, mask) {
            const size = m.length;
            const bits = formatBits(ecl, mask);
            const set = (r, c, i) => {
                m[r][c] = (bits >>> i) & 1;
                fn[r][c] = 1;
            };
            for (let i = 0; i <= 5; i++) set(i, 8, i);
            set(7, 8, 6);
            set(8, 8, 7);
            set(8, 7, 8);
            for (let i = 9; i < 15; i++) set(8, 14 - i, i);
            for (let i = 0; i < 8; i++) set(8, size - 1 - i, i);
            for (let i = 8; i < 15; i++) set(size - 15 + i, 8, i);
            m[size - 8][8] = 1;
            fn[size - 8][8] = 1;
        }

        /**
         * 码字按位从右下角开始、两列一组蛇形往上往下摆，跳过功能格；
         * 第 6 列整列是竖向时序图形，走到那里时整体左移一列。放不满的剩余位保持 0（之后照样被掩码）。
         */
        function placeCodewords(m, fn, codewords) {
            const size = m.length;
            let i = 0;
            for (let right = size - 1; right >= 1; right -= 2) {
                if (right === 6) right = 5;
                const upward = ((right + 1) & 2) === 0;
                for (let v = 0; v < size; v++) {
                    const r = upward ? size - 1 - v : v;
                    for (let j = 0; j < 2; j++) {
                        const c = right - j;
                        if (fn[r][c] || i >= codewords.length * 8) continue;
                        m[r][c] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
                        i++;
                    }
                }
            }
        }

        function applyMask(m, fn, mask) {
            const f = MASKS[mask];
            for (let r = 0; r < m.length; r++) {
                for (let c = 0; c < m.length; c++) if (!fn[r][c] && f(r, c)) m[r][c] ^= 1;
            }
        }

        const N3_A = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
        const N3_B = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];

        /**
         * 标准 7.8.3 的四条罚分：
         *   N1 行/列里同色连续 ≥5 个：3 + (长度 - 5)
         *   N2 每个同色 2×2 块：3（重叠的块分别计）
         *   N3 1:1:3:1:1 的深浅深浅深，任一侧带 4 个浅色：40；符号外是静区，按浅色算
         *   N4 深色占比偏离 50% 每满 5%：10
         */
        function penalty(m) {
            // 按矩形写（行数、列数分开），方便单测拿一行 1×N 的「矩阵」单独测 N1/N3
            const rows = m.length, cols = m[0].length;
            let n1 = 0, n2 = 0, n3 = 0, dark = 0;
            const scan = (line, n) => {
                let run = 1;
                for (let i = 1; i <= n; i++) {
                    if (i < n && line[i] === line[i - 1]) run++;
                    else {
                        if (run >= 5) n1 += run - 2;
                        run = 1;
                    }
                }
                for (let s = -4; s <= n - 7; s++) {
                    let a = true, b = true;
                    for (let k = 0; k < 11 && (a || b); k++) {
                        const i = s + k;
                        const v = i < 0 || i >= n ? 0 : line[i];
                        if (v !== N3_A[k]) a = false;
                        if (v !== N3_B[k]) b = false;
                    }
                    if (a) n3 += 40;
                    if (b) n3 += 40;
                }
            };
            for (let r = 0; r < rows; r++) scan(m[r], cols);
            const col = new Uint8Array(rows);
            for (let c = 0; c < cols; c++) {
                for (let r = 0; r < rows; r++) col[r] = m[r][c];
                scan(col, rows);
            }
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    dark += m[r][c];
                    if (r < rows - 1 && c < cols - 1) {
                        const v = m[r][c];
                        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) n2 += 3;
                    }
                }
            }
            const total = rows * cols;
            const n4 = Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
            return { n1, n2, n3, n4, total: n1 + n2 + n3 + n4 };
        }

        /**
         * 文字 → 二维码矩阵。opts 同 encodeData，另加 mask（0–7，不传就按罚分自动挑）。
         * 返回 { version, ecl, mode, count, eci, mask, size, modules }，modules[行][列] 1 = 深色。
         */
        function encode(text, opts = {}) {
            const d = encodeData(text, opts);
            const codewords = addEccAndInterleave(d.data, d.version, d.ecl);
            const { size, m, fn } = buildFunctionPatterns(d.version);
            placeCodewords(m, fn, codewords);

            let mask = opts.mask;
            if (mask === undefined || mask === null) {
                let best = Infinity;
                for (let k = 0; k < 8; k++) {
                    applyMask(m, fn, k);
                    drawFormat(m, fn, d.ecl, k);    // 格式信息也参与罚分
                    const p = penalty(m).total;
                    if (p < best) {
                        best = p;
                        mask = k;
                    }
                    applyMask(m, fn, k);            // 异或两次复原
                }
            }
            applyMask(m, fn, mask);
            drawFormat(m, fn, d.ecl, mask);
            return { version: d.version, ecl: d.ecl, mode: d.mode, count: d.count, eci: d.eci, mask, size, modules: m };
        }

        return {
            gfMul, rsGenerator, rsEncode,
            alignmentPositions, rawDataModules, totalCodewords, dataCodewordCount,
            chooseMode, makeSegment, encodeData, capacity, addEccAndInterleave,
            formatBits, versionBits, penalty, encode,
        };
    })();
    // ---- QR-ENCODER-END ----

    // =========================================================================
    // 渲染
    // =========================================================================

    /**
     * 画到 canvas 上：白底 + 四周 quietZone 个模块的静区。
     * 每个模块是整数像素（scale），缩放显示交给 CSS 的 image-rendering: pixelated，
     * 否则模块边缘会被插值成灰色，手机在屏幕上扫时更难对焦。
     */
    function renderCanvas(qr, canvas, scale) {
        const q = CONFIG.quietZone;
        const n = qr.size + q * 2;
        canvas.width = canvas.height = n * scale;
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = '#000';
        for (let r = 0; r < qr.size; r++) {
            for (let c = 0; c < qr.size; c++) {
                if (qr.modules[r][c]) g.fillRect((c + q) * scale, (r + q) * scale, scale, scale);
            }
        }
        return canvas;
    }

    /** 导出用的缩放：每模块整数像素，至少 4px。 */
    function exportScale(qr) {
        return Math.max(4, Math.round(CONFIG.exportSize / (qr.size + CONFIG.quietZone * 2)));
    }

    function toBlob(canvas) {
        return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), 'image/png'));
    }

    /**
     * 用 <a download> 存文件，不用 GM_download：blob: 地址是页面这边生成的，
     * 交给扩展去下载在 Firefox 上会拿不到。revoke 要晚一点，同步 revoke 时 Firefox 会下载失败。
     */
    function saveBlob(blob, name, mount) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        mount.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    function fileName() {
        return `qrcode-${location.hostname || 'page'}.png`;
    }

    /** 显示用的缩放：让画布像素至少是显示尺寸的 2 倍（高分屏不糊）。 */
    function displayScale(qr) {
        return Math.max(1, Math.ceil((CONFIG.displaySize * 2) / (qr.size + CONFIG.quietZone * 2)));
    }

    // =========================================================================
    // 存储
    // =========================================================================

    const Store = {
        /** 纠错等级是个人偏好，全局记一个，不按站点分。 */
        ecl() {
            const v = GM_getValue('ecl', CONFIG.defaultEcl);
            return 'LMQH'.includes(v) && v.length === 1 ? v : CONFIG.defaultEcl;
        },
        setEcl(v) {
            GM_setValue('ecl', v);
        },
    };

    // =========================================================================
    // 浮层
    // =========================================================================

    const ECL_HINT = { L: '约 7%', M: '约 15%', Q: '约 25%', H: '约 30%' };
    const MODE_NAME = { numeric: '数字', alphanumeric: '字母数字', byte: '字节' };
    const UNIT = { numeric: '位数字', alphanumeric: '个字符', byte: '字节' };

    const STYLE = `
        :host { all: initial; }
        .backdrop { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.35);
                    display: flex; align-items: center; justify-content: center;
                    font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #222; }
        .panel { background: #fff; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.25);
                 padding: 14px 16px 16px; width: ${CONFIG.displaySize + 32}px; box-sizing: border-box; }
        .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .title { font-weight: 600; }
        .close { all: unset; cursor: pointer; width: 24px; height: 24px; text-align: center; border-radius: 4px; font-size: 18px; line-height: 24px; color: #666; }
        .close:hover { background: #f0f0f0; }
        .stage { position: relative; width: ${CONFIG.displaySize}px; height: ${CONFIG.displaySize}px; }
        canvas.qr { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
        .stage.empty canvas.qr, .stage.over canvas.qr { opacity: .08; }
        .msg { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; text-align: center;
               padding: 16px; color: #555; font-size: 12px; }
        .stage.empty .msg, .stage.over .msg { display: flex; }
        .stage.over .msg { color: #c62828; }
        textarea.text { display: block; width: 100%; box-sizing: border-box; margin-top: 10px; resize: vertical;
                        min-height: 54px; max-height: 200px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px;
                        font: 12px/1.5 ui-monospace, Consolas, monospace; color: #222; background: #fff; }
        textarea.text:focus { outline: none; border-color: #1a73e8; }
        .row { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; gap: 8px; }
        .ecl { display: inline-flex; border: 1px solid #ccc; border-radius: 6px; overflow: hidden; }
        .ecl button { all: unset; cursor: pointer; padding: 1px 9px; font-size: 12px; color: #444; }
        .ecl button + button { border-left: 1px solid #ccc; }
        .ecl button[aria-checked="true"] { background: #1a73e8; color: #fff; }
        .label { color: #888; font-size: 12px; }
        .info { margin-top: 6px; color: #666; font-size: 12px; min-height: 18px; }
        .info.over { color: #c62828; }
        .actions { display: flex; gap: 8px; margin-top: 10px; }
        .actions button { all: unset; cursor: pointer; flex: 1; text-align: center; padding: 5px 0; border-radius: 6px;
                          border: 1px solid #ccc; font-size: 12px; color: #333; }
        .actions button:hover { background: #f5f5f5; }
        .actions button:disabled { cursor: default; opacity: .4; background: none; }
        .toast { margin-top: 6px; font-size: 12px; color: #2e7d32; min-height: 18px; }
        .toast.warn { color: #b26a00; }
    `;

    const Overlay = (() => {
        let host = null;
        let root = null;
        let pending = 0;
        let current = null;     // 当前画着的那个二维码（导出时按它重画大图）

        const $ = (sel) => root.querySelector(sel);

        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();    // 页面自己的弹窗也监听 Esc，别让一次 Esc 关两层
                close();
            }
        }

        function build() {
            host = document.createElement('div');
            host.id = HOST_ID;
            root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `
                <style>${STYLE}</style>
                <div class="backdrop">
                    <div class="panel" role="dialog" aria-label="二维码">
                        <div class="head"><span class="title">扫码在手机上打开</span><button class="close" title="关闭（Esc）">×</button></div>
                        <div class="stage"><canvas class="qr"></canvas><div class="msg"></div></div>
                        <textarea class="text" spellcheck="false" placeholder="输入要生成二维码的内容"></textarea>
                        <div class="row">
                            <span class="label">纠错</span>
                            <span class="ecl" role="radiogroup" aria-label="纠错等级">
                                ${'LMQH'.split('').map((k) => `<button role="radio" data-ecl="${k}" title="能扛${ECL_HINT[k]}污损">${k}</button>`).join('')}
                            </span>
                        </div>
                        <div class="info"></div>
                        <div class="actions">
                            <button class="download" title="保存为 PNG 图片">下载 PNG</button>
                            <button class="copy" title="复制图片，可以直接粘贴到聊天窗口">复制图片</button>
                        </div>
                        <div class="toast" role="status"></div>
                    </div>
                </div>`;
            $('.close').addEventListener('click', close);
            const backdrop = $('.backdrop');
            // 只认直接点在遮罩上的：在面板里按下、拖到外面松开时 click 的 target 是共同祖先（遮罩），不能关
            let downOnBackdrop = false;
            backdrop.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === backdrop; });
            backdrop.addEventListener('click', (e) => {
                if (e.target === backdrop && downOnBackdrop) close();
            });
            $('textarea.text').addEventListener('input', schedule);
            $('.ecl').addEventListener('click', (e) => {
                const b = e.target.closest('button[data-ecl]');
                if (!b) return;
                Store.setEcl(b.dataset.ecl);
                draw();
            });
            $('.download').addEventListener('click', download);
            $('.copy').addEventListener('click', copy);
            // 键盘事件冒出 shadow DOM 时 target 被重定向成宿主 <div>，页面「焦点在输入框里就不处理」的判断
            // 认不出这是在打字：GitHub / YouTube 一类站点的 / 、j、k 快捷键会照常触发，/ 还会被 preventDefault
            // 吃掉、焦点被抢到页面搜索框。在宿主上截住冒泡；Esc、Alt+Q 走的是 window 捕获阶段，不受影响。
            for (const type of ['keydown', 'keypress', 'keyup']) host.addEventListener(type, (e) => e.stopPropagation());
            document.documentElement.appendChild(host);
        }

        function toast(text, warn) {
            const el = $('.toast');
            el.textContent = text;
            el.classList.toggle('warn', !!warn);
        }

        function exportCanvas() {
            return renderCanvas(current, document.createElement('canvas'), exportScale(current));
        }

        async function download() {
            if (!current) return;
            saveBlob(await toBlob(exportCanvas()), fileName(), root);
            toast('已下载 ' + fileName());
        }

        /**
         * 复制图片。ClipboardItem 里直接放 toBlob 的 Promise 而不是先 await 出 Blob：
         * Safari 要求 clipboard.write 在用户手势里同步发起，先 await 一下手势就过期了。
         * 不支持（http 页面没有 navigator.clipboard、老浏览器没有 ClipboardItem）或被拒绝时改为下载。
         */
        async function copy() {
            if (!current) return;
            const canvas = exportCanvas();
            const supported = window.isSecureContext && navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem === 'function';
            if (!supported) {
                saveBlob(await toBlob(canvas), fileName(), root);
                toast('这个页面不能复制图片，已改为下载', true);
                return;
            }
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob(canvas) })]);
                toast('已复制，可以直接粘贴');
            } catch (e) {
                console.warn(TAG, '复制图片失败', e);
                saveBlob(await toBlob(canvas), fileName(), root);
                toast('复制被浏览器拒绝，已改为下载', true);
            }
        }

        /** 输入时合并到下一帧再画：版本 40 编一次要几十毫秒，连打字不能每个键都编。 */
        function schedule() {
            if (pending) return;
            pending = requestAnimationFrame(() => {
                pending = 0;
                if (root) draw();
            });
        }

        function draw() {
            const text = $('textarea.text').value;
            const ecl = Store.ecl();
            const stage = $('.stage');
            const info = $('.info');
            const msg = $('.msg');
            root.querySelectorAll('.ecl button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.ecl === ecl)));
            stage.classList.remove('empty', 'over');
            info.classList.remove('over');
            toast('');
            current = null;
            const setActions = (on) => root.querySelectorAll('.actions button').forEach((b) => { b.disabled = !on; });
            setActions(false);

            if (!text) {
                stage.classList.add('empty');
                msg.textContent = '输入要生成二维码的内容';
                info.textContent = '';
                return null;
            }
            try {
                const qr = QR.encode(text, { ecl });
                renderCanvas(qr, $('canvas.qr'), displayScale(qr));
                const cap = QR.capacity(qr.version, ecl, qr.mode, qr.eci);
                info.textContent = `版本 ${qr.version}（${qr.size}×${qr.size}）· ${MODE_NAME[qr.mode]}模式 · ${qr.count} / ${cap} ${UNIT[qr.mode]}`;
                current = qr;
                setActions(true);
                return qr;
            } catch (e) {
                if (e.code !== 'TOO_LONG') throw e;
                stage.classList.add('over');
                info.classList.add('over');
                msg.textContent = '内容太长，放不进一个二维码';
                info.textContent = `超出版本 40 的容量：${e.count} / ${e.capacity} ${UNIT[e.mode]}（纠错 ${ecl}）。` +
                    (ecl === 'L' ? '删掉一些内容。' : '删掉一些内容，或把纠错等级调低。');
                return null;
            }
        }

        function open(text, notice) {
            if (!host || !host.isConnected) build();
            const ta = $('textarea.text');
            ta.value = text;
            draw();
            if (notice) toast(notice, true);
            ta.focus();
            ta.select();    // 全选：想换内容直接粘贴
            window.addEventListener('keydown', onKey, true);
        }

        function close() {
            window.removeEventListener('keydown', onKey, true);
            if (pending) cancelAnimationFrame(pending);
            pending = 0;
            if (host) host.remove();
            host = root = current = null;
        }

        const isOpen = () => !!(host && host.isConnected);

        return { open, close, isOpen };
    })();

    // =========================================================================
    // 按住 Alt 悬停链接：浮出链接的小二维码
    //
    // 用户脚本拿不到浏览器原生的右键菜单，所以用这个手势代替「右键链接 → 生成二维码」。
    // =========================================================================

    const HOVER_STYLE = `
        :host { all: initial; }
        .card { position: fixed; z-index: 2147483647; background: #fff; border-radius: 8px; padding: 8px;
                box-shadow: 0 4px 18px rgba(0,0,0,.25); cursor: zoom-in; width: ${CONFIG.hoverSize}px;
                font: 11px/1.4 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #555; }
        canvas { display: block; width: ${CONFIG.hoverSize}px; height: ${CONFIG.hoverSize}px; image-rendering: pixelated; }
        .url { margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .hint { color: #999; }
    `;

    const Hover = (() => {
        let link = null;        // 鼠标当前所在的链接
        let timer = 0;
        let hideTimer = 0;
        let host = null;
        let shownFor = null;    // 小卡片是为哪个链接显示的

        /** 能生成二维码的链接：有 href、不是 javascript:。 */
        function usable(a) {
            return a && a.href && !/^javascript:/i.test(a.href);
        }

        function linkFrom(e) {
            for (const el of e.composedPath()) {
                if (el === host) return host;
                if (el instanceof Element && el.tagName === 'A' && el.hasAttribute('href')) return el;
                if (el === document.body) break;
            }
            return null;
        }

        function cancel() {
            clearTimeout(timer);
            timer = 0;
        }

        function arm() {
            cancel();
            if (!usable(link) || shownFor === link || Overlay.isOpen()) return;
            const target = link;
            timer = setTimeout(() => {
                timer = 0;
                if (link === target && target.isConnected) show(target);
            }, CONFIG.hoverDelay);
        }

        function show(a) {
            hide();
            let qr;
            try {
                qr = QR.encode(a.href, { ecl: Store.ecl() });
            } catch (e) {
                console.warn(TAG, '链接太长，生成不了', e);
                return;
            }
            host = document.createElement('div');
            host.id = HOVER_ID;
            const root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>${HOVER_STYLE}</style>
                <div class="card" title="点击放大"><canvas></canvas><div class="url"></div><div class="hint">点击放大 · Esc 关闭</div></div>`;
            renderCanvas(qr, root.querySelector('canvas'), Math.max(1, Math.ceil((CONFIG.hoverSize * 2) / (qr.size + CONFIG.quietZone * 2))));
            root.querySelector('.url').textContent = a.href;
            const card = root.querySelector('.card');
            card.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const href = a.href;
                hide();
                Overlay.open(href);
            });
            card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
            card.addEventListener('mouseleave', scheduleHide);
            document.documentElement.appendChild(host);
            place(card, a);
            shownFor = a;
        }

        /** 放在链接下方，下面放不下就放上方，左右夹在视口里。 */
        function place(card, a) {
            const r = a.getBoundingClientRect();
            const w = card.offsetWidth, h = card.offsetHeight, gap = 6;
            let top = r.bottom + gap;
            if (top + h > innerHeight - 4 && r.top - gap - h >= 4) top = r.top - gap - h;
            const left = Math.min(Math.max(4, r.left), innerWidth - w - 4);
            card.style.top = Math.max(4, top) + 'px';
            card.style.left = Math.max(4, left) + 'px';
        }

        function hide() {
            clearTimeout(hideTimer);
            if (host) host.remove();
            host = null;
            shownFor = null;
        }

        function scheduleHide() {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(hide, CONFIG.hoverHideDelay);
        }

        document.addEventListener('mouseover', (e) => {
            const a = linkFrom(e);
            if (a === host && host) {       // 移到小卡片上：保持
                clearTimeout(hideTimer);
                return;
            }
            if (a === link) return;
            link = a;
            cancel();
            if (shownFor && a !== shownFor) scheduleHide();
            if (a && e.altKey) arm();
        }, true);

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Alt' && !e.repeat && link) arm();
            else if (e.key === 'Escape' && host) {
                e.stopPropagation();
                hide();
            }
        }, true);

        window.addEventListener('keyup', (e) => {
            if (e.key !== 'Alt') return;
            cancel();
            // Windows 上单按 Alt 松开会激活 Firefox 的菜单栏，用过这个手势就别让它跳出来
            if (host) e.preventDefault();
        }, true);

        // 页面滚动后卡片和链接就对不上了，直接收起
        window.addEventListener('scroll', () => { if (host) hide(); }, true);
        window.addEventListener('blur', cancel);

        return { hide, isShown: () => !!host };
    })();

    // =========================================================================
    // 入口：快捷键 / 菜单
    // =========================================================================

    function showPage() {
        Hover.hide();
        Overlay.open(location.href);
    }

    /**
     * 选中的文字。输入框 / 文本框里的选区，Firefox 的 window.getSelection() 拿不到（空串；
     * Chromium 现在能拿到），所以先从 selectionStart/End 截；email、number 之类的 input 读 selectionStart 会抛错。
     * 密码框不读。
     */
    function selectedText() {
        const el = document.activeElement;
        if (el && el.id !== HOST_ID && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|tel)$/i.test(el.type)))) {
            try {
                const s = el.value.slice(el.selectionStart, el.selectionEnd).trim();
                if (s) return s;
            } catch (e) { /* 不支持选区的 input 类型 */ }
        }
        return String(window.getSelection() || '').trim();
    }

    function showSelection() {
        const text = selectedText();
        Hover.hide();
        if (text) Overlay.open(text);
        else Overlay.open(location.href, '没有选中文字，先用当前页地址');
    }

    window.addEventListener('keydown', (e) => {
        // 按 code 不按 key：macOS 上 Option+Q 的 key 是「œ」
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === CONFIG.hotkey && !e.repeat) {
            e.preventDefault();
            if (Overlay.isOpen()) Overlay.close();
            else showPage();
        }
    }, true);

    GM_registerMenuCommand('当前页面二维码（Alt+Q）', showPage);
    GM_registerMenuCommand('选中文字生成二维码', showSelection);

    console.debug(TAG, '已加载');
})();
