// ==UserScript==
// @name         页面二维码
// @name:zh-CN   页面二维码
// @name:en      Page QR Code — Send the Current Page, a Link or Any Text to Your Phone
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.08.16.1
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

        return { gfMul, rsGenerator, rsEncode };
    })();
    // ---- QR-ENCODER-END ----

    console.debug(TAG, '已加载');
})();
