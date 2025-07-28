// ==UserScript==
// @name         通用暗色模式
// @name:zh-CN   通用暗色模式
// @name:en      Dark Mode for Any Site
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.07.28.3
// @description  任意网站一键暗色：整页反色再把图片、视频、画布、iframe 反转回来，页面渲染前注入，不闪白；自动识别本来就是暗色的站点，不做「暗上加暗」；可调亮度、对比度、棕褐色。
// @description:zh-CN  任意网站一键暗色：整页反色再把图片、视频、画布、iframe 反转回来，页面渲染前注入，不闪白；自动识别本来就是暗色的站点，不做「暗上加暗」；可调亮度、对比度、棕褐色。
// @description:en  Dark mode for any website: inverts the page and flips images, videos, canvases and iframes back, injected before the page renders so there is no white flash. Sites that are already dark are detected and left alone. Adjustable brightness, contrast and sepia.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @license      CC BY-NC-SA
// @run-at       document-start
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/dark-mode/dark-mode.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/dark-mode/dark-mode.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

/*
 * @run-at 是 document-start：样式必须在第一次绘制之前就在，等 DOMContentLoaded 再加，
 * 用户会先看到一屏白页再变黑（「闪白」），夜里比不开还刺眼。
 */

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「暗色模式」只看本脚本。 */
    const TAG = '[暗色模式]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        /*
         * 需要「反转回来」的元素：它们显示的是照片/视频/外部页面，整页反色后会变成底片，
         * 再反一次才是原样。svg 本身不算（图标多是跟着文字颜色走的，就该一起反），
         * 只算 svg 里嵌的位图 <image>。
         */
        revertSelector: 'img, video, canvas, iframe, embed, object, svg image',
        /*
         * 色调默认值（百分比）。叠在反色之后，作用于整页 —— 反转回来的图片也会跟着变暗一点，
         * 夜里看反而更舒服，所以不单独给图片补偿。
         */
        brightness: 100,
        contrast: 100,
        sepia: 0,
        limits: { brightness: [30, 150], contrast: [30, 150], sepia: [0, 100] },
        /*
         * 背景相对亮度（0 黑 ~ 1 白）低于这个值就算暗色站点。
         * 0.2 大约是 #7c7c7c：深灰背景都算暗，浅灰（#ccc 是 0.6）不算。
         */
        darkLuminance: 0.2,
    };

    const STYLE_ID = 'dark-mode-userscript';
    const FILTER = 'invert(1) hue-rotate(180deg)';

    // =========================================================================
    // 存储（GM）
    // =========================================================================

    const Store = (() => {
        function clamp(key, v) {
            const [lo, hi] = CONFIG.limits[key];
            const n = Number(v);
            return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : CONFIG[key];
        }

        /** 全局设置。存的值可能是旧版本 / 手改坏的，读出来一律夹回范围。 */
        function settings() {
            const raw = { brightness: CONFIG.brightness, contrast: CONFIG.contrast, sepia: CONFIG.sepia, ...GM_getValue('settings', {}) };
            return { ...raw, brightness: clamp('brightness', raw.brightness), contrast: clamp('contrast', raw.contrast), sepia: clamp('sepia', raw.sepia) };
        }

        return { settings, clamp };
    })();

    // =========================================================================
    // 样式
    // =========================================================================

    /** 整页 filter：反色 + 色调。等于默认值的项不写，计算样式保持干净，也少一层合成。 */
    function pageFilter(s) {
        const parts = [FILTER];
        if (s.brightness !== 100) parts.push(`brightness(${s.brightness / 100})`);
        if (s.contrast !== 100) parts.push(`contrast(${s.contrast / 100})`);
        if (s.sepia !== 0) parts.push(`sepia(${s.sepia / 100})`);
        return parts.join(' ');
    }

    function buildCss(s) {
        return `
/*
 * filter 加在 <html> 而不是 <body>：除根元素外，带 filter 的元素会成为 position: fixed 后代的
 * 包含块，加在 body 上所有固定栏都会跟着页面滚走。
 */
html {
    filter: ${pageFilter(s)} !important;
    /* 透明的根背景透出来的是浏览器画布，画布不吃 filter，反转后还是白的 */
    background-color: #fff;
}
${CONFIG.revertSelector} {
    filter: ${FILTER} !important;
}
`;
    }

    /**
     * 开关靠 <style media="not all">，不往页面的 <html> 上加属性/类名：
     * 有的框架会整体重写 html 的 class，我们的标记会被冲掉。
     */
    const Style = (() => {
        let el = null;

        function mount() {
            el = GM_addStyle(buildCss(Store.settings()));
            el.id = STYLE_ID;
        }

        function setEnabled(on) {
            if (el) el.media = on ? 'all' : 'not all';
        }

        function enabled() {
            return !!el && el.media !== 'not all';
        }

        /** 暂时关掉样式跑 fn（同步执行，中间不会绘制，不会闪）。 */
        function without(fn) {
            const was = enabled();
            setEnabled(false);
            try {
                return fn();
            } finally {
                setEnabled(was);
            }
        }

        return { mount, setEnabled, enabled, without, get el() { return el; } };
    })();

    // =========================================================================
    // 暗色站点识别
    // =========================================================================

    /**
     * 页面本来就是暗色的，再反一次就变亮了。DOM 就绪后量实际背景色。
     *
     * 量的时候必须先关掉自己的样式：我们给 html 设了白底，开着量，任何页面的根背景都是白的。
     */
    const Detect = (() => {
        function parseColor(str) {
            const m = /rgba?\(([^)]+)\)/.exec(str || '');
            if (!m) return null;
            const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
            return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
        }

        /** WCAG 相对亮度。 */
        function luminance({ r, g, b }) {
            const lin = (v) => {
                v /= 255;
                return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        }

        function opaqueBg(el) {
            const c = el && parseColor(getComputedStyle(el).backgroundColor);
            return c && c.a >= 0.5 ? c : null;
        }

        /**
         * 元素「看起来」的背景：自己透明就往上找。
         * 找到根还是透明时不能直接算「露出画布」：html 背景透明时，body 的背景会被传播到整个画布
         * （CSS 的背景传播规则），短页面里 body 下方那一大片空白其实是 body 的颜色。
         * html 和 body 都透明才是 null（画布颜色看 color-scheme）。
         */
        function effectiveBg(el) {
            for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
                const c = opaqueBg(n);
                if (c) return c;
            }
            return opaqueBg(document.body);
        }

        /**
         * 没有任何元素铺背景时，画布颜色由 color-scheme 决定：只声明 dark → 暗；
         * 声明 light dark 且系统是暗色 → 浏览器自己就把画布画成暗的。
         * 只有页面没铺背景时才看这个 —— 声明了 light dark 却自己铺白底的站点很多（只为了滚动条），
         * 那种照样要反。
         */
        function canvasDark() {
            const tokens = (s) => String(s || '').toLowerCase().split(/\s+/);
            const meta = document.querySelector('meta[name="color-scheme"]');
            const declared = [...tokens(getComputedStyle(document.documentElement).colorScheme), ...tokens(meta && meta.content)];
            if (!declared.includes('dark')) return false;
            if (!declared.includes('light')) return true;
            return matchMedia('(prefers-color-scheme: dark)').matches;
        }

        function isDark(bg) {
            return bg ? luminance(bg) < CONFIG.darkLuminance : canvasDark();
        }

        /**
         * 采样：body 本身 + 视口中间一竖排三个点上的元素。
         * 只看 body 不够 —— SPA 常常 body 透明、由 #app 之类的满屏容器铺底色。
         */
        function samples() {
            const w = innerWidth, h = innerHeight;
            const els = [document.body];
            for (const y of [h / 4, h / 2, (h * 3) / 4]) els.push(document.elementFromPoint(w / 2, y));
            return els.filter(Boolean);
        }

        function measure() {
            return Style.without(() => {
                const votes = samples().map((el) => isDark(effectiveBg(el)));
                const dark = votes.filter(Boolean).length;
                return dark * 2 > votes.length;
            });
        }

        return { measure, luminance, parseColor };
    })();

    // =========================================================================
    // 状态
    // =========================================================================

    const State = {
        /** null = 还没量过（document-start 阶段），先按亮色站点处理 */
        pageDark: null,
    };

    function apply() {
        const on = State.pageDark !== true;
        Style.setEnabled(on);
        if (Style.el) Style.el.dataset.pageDark = String(State.pageDark);
    }

    function detect() {
        if (!document.body) return;
        const dark = Detect.measure();
        if (dark !== State.pageDark) console.log(TAG, dark ? '页面本来就是暗色，不反转' : '页面是亮色，反转');
        State.pageDark = dark;
        apply();
    }

    // =========================================================================
    // 启动
    // =========================================================================

    try {
        Style.mount();
        apply();
    } catch (e) {
        console.error(TAG, '注入样式失败', e);
    }

    /*
     * DOMContentLoaded 先量一次；load 时外部样式表、字体都到了，再量一次 ——
     * 样式表放在 body 末尾或异步加载的站点，DOMContentLoaded 时背景色还不是最终的。
     */
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', detect, { once: true });
    else detect();
    if (document.readyState !== 'complete') window.addEventListener('load', detect, { once: true });
})();
