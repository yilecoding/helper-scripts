// ==UserScript==
// @name         通用暗色模式
// @name:zh-CN   通用暗色模式
// @name:en      Dark Mode for Any Site
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.08.01.10
// @description  任意网站一键暗色：整页反色再把图片、视频、画布、iframe、背景图、彩色 emoji 反转回来（含动态插入的），页面渲染前注入，不闪白；自动识别本来就是暗色的站点，不做「暗上加暗」；全局可选总是开 / 跟随系统主题（实时切换）/ 定时开，每个站点可单独强制开或关（Alt+Shift+D）；可调亮度、对比度、棕褐色。
// @description:zh-CN  任意网站一键暗色：整页反色再把图片、视频、画布、iframe、背景图、彩色 emoji 反转回来（含动态插入的），页面渲染前注入，不闪白；自动识别本来就是暗色的站点，不做「暗上加暗」；全局可选总是开 / 跟随系统主题（实时切换）/ 定时开，每个站点可单独强制开或关（Alt+Shift+D）；可调亮度、对比度、棕褐色。
// @description:en  Dark mode for any website: inverts the page and flips images, videos, canvases, iframes, background images and colour emoji back (including ones added later), injected before the page renders so there is no white flash. Sites that are already dark are detected and left alone. Globally: always on, follow the system theme (switches live) or on a schedule; each site can be forced on or off (Alt+Shift+D). Adjustable brightness, contrast and sepia.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
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
         * 0.2 大约是 #7c7c7c：深灰背景都算暗，浅灰（#ccc 约 0.68）不算。
         */
        darkLuminance: 0.2,
        /* 动态插入 / 改了样式的节点攒一批再扫，最多攒这么久（节流，不是防抖：持续变化也要按时扫） */
        scanThrottle: 200,
        /*
         * 全局模式：always 总是开 / system 跟随系统 prefers-color-scheme / schedule 定时（跨午夜）。
         * 默认 always：装这个脚本的人就是想要暗色，系统是亮色的人不少。
         */
        mode: 'always',
        schedule: { from: '19:00', to: '07:00' },
        scheduleCheck: 30 * 1000, // 定时模式多久看一次钟（电脑睡眠醒来后最多晚这么久切换）
        /*
         * 切换本站的快捷键：Alt+Shift+ 这个键，写的是 KeyboardEvent.code（物理键位）。
         * 不用 e.key：macOS 上 Option+Shift+D 得到的 e.key 是「Î」。
         */
        toggleKey: 'KeyD',
    };

    const MODES = ['always', 'system', 'schedule'];
    const SITE_MODES = ['auto', 'on', 'off'];

    const STYLE_ID = 'dark-mode-userscript';
    /** 带背景图的元素打这个类，反转回来 */
    const BG_CLASS = 'dm-revert-bg';
    /** 只装着彩色 emoji 的元素打这个类 */
    const EMOJI_CLASS = 'dm-revert-emoji';
    /** 所有「反转回来」的东西 */
    const REVERTED = `${CONFIG.revertSelector}, .${BG_CLASS}, .${EMOJI_CLASS}`;
    /*
     * 彩色 emoji：默认就按彩色显示的字符（Emoji_Presentation，😀 🇨🇳），或者带 U+FE0F 的（❤️）。
     * 不能用 Extended_Pictographic —— © ® ™ ↔ 都在里面，它们按普通文字的颜色画，
     * 反转回来就成了暗底上的暗字，直接看不见了。
     */
    const EMOJI_CHAR = '(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)';
    const EMOJI_ONLY = new RegExp(`^(?:${EMOJI_CHAR}|\\p{Emoji_Modifier}|\\u200D|\\uFE0F|\\s)+$`, 'u');
    const EMOJI_ANY = new RegExp(EMOJI_CHAR, 'u');
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

        /** 'H:MM' / 'HH:MM' → 补零的 'HH:MM'；不合法返回 fallback。 */
        function validTime(v, fallback) {
            const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v));
            return m ? m[1].padStart(2, '0') + ':' + m[2] : fallback;
        }

        /** 全局设置。存的值可能是旧版本 / 手改坏的，读出来一律夹回范围。 */
        function settings() {
            const raw = {
                brightness: CONFIG.brightness,
                contrast: CONFIG.contrast,
                sepia: CONFIG.sepia,
                mode: CONFIG.mode,
                ...GM_getValue('settings', {}),
            };
            const sch = raw.schedule || {};
            return {
                ...raw,
                brightness: clamp('brightness', raw.brightness),
                contrast: clamp('contrast', raw.contrast),
                sepia: clamp('sepia', raw.sepia),
                mode: MODES.includes(raw.mode) ? raw.mode : CONFIG.mode,
                schedule: { from: validTime(sch.from, CONFIG.schedule.from), to: validTime(sch.to, CONFIG.schedule.to) },
            };
        }

        function saveSettings(patch) {
            GM_setValue('settings', { ...settings(), ...patch });
        }

        /** 站点三态按 hostname 存：auto 跟随全局 / on 强制开 / off 强制关。 */
        const siteKey = 'site:' + location.hostname;

        function site() {
            const v = GM_getValue(siteKey, 'auto');
            return SITE_MODES.includes(v) ? v : 'auto';
        }

        function saveSite(v) {
            if (v === 'auto') GM_deleteValue(siteKey);
            else GM_setValue(siteKey, v);
        }

        /**
         * 上次量出来的「这个站本来是不是暗色」。document-start 时还没有 DOM 可量，
         * 不记的话暗色站点每次打开都会先被反成亮色、DOM 就绪后才变回来（反向的闪白）。
         */
        const darkKey = 'pageDark:' + location.hostname;

        function pageDark() {
            const v = GM_getValue(darkKey, null);
            return typeof v === 'boolean' ? v : null;
        }

        function savePageDark(v) {
            if (pageDark() !== v) GM_setValue(darkKey, v);
        }

        return { settings, saveSettings, site, saveSite, pageDark, savePageDark, clamp, validTime };
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
${REVERTED} {
    filter: ${FILTER} !important;
}
/*
 * 已经反转回来的元素里面的媒体不能再反：背景图横幅里的 logo、卡片背景里的视频，
 * 反两次又成了底片。选择器特异性比上一条高，同为 !important 时它赢。
 */
:is(${REVERTED}) :is(${REVERTED}) {
    filter: none !important;
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

        /** 色调改了以后重写同一个 <style>，开关状态（media）不变。 */
        function refresh() {
            if (el) el.textContent = buildCss(Store.settings());
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

        return { mount, refresh, setEnabled, enabled, without, get el() { return el; } };
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
    // 背景图元素
    // =========================================================================

    /**
     * background-image 没法用选择器选中，只能逐个读计算样式。
     * 只给有尺寸的打标：零尺寸的看不见，没必要；之后它的 style / class 变了会被重新检查。
     */
    const Scanner = (() => {
        let observer = null;
        const subtrees = new Set();   // 新插入的节点：连同后代一起扫
        const singles = new Set();    // 改了 style / class / 子节点的元素：只看它自己
        let timer = null;

        function check(el) {
            /*
             * html / body 上的背景图（老站常见的纹理底）不算：反转回来等于把整页又翻成亮色。
             * 代价是这类纹理图本身是反色的，纹理一般很淡，看不太出来。
             */
            if (el === document.documentElement || el === document.body) return;
            const has = /url\(/.test(getComputedStyle(el).backgroundImage);
            if (has) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) mark(el, BG_CLASS, true);
            } else {
                mark(el, BG_CLASS, false);
            }
            mark(el, EMOJI_CLASS, isEmojiOnly(el));
        }

        /** 只在需要时改 classList：add 一个已有的类也会产生一条 attributes 变更记录。 */
        function mark(el, cls, on) {
            if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
        }

        /**
         * 叶子元素、文字很短、全是 emoji —— 反应按钮、标签前缀那种。
         * 和普通文字混排的 emoji 没法单独反（要拆文本节点包 span，框架会把它当脏 DOM），放弃。
         */
        function isEmojiOnly(el) {
            if (el.childElementCount !== 0) return false;
            const text = el.textContent;
            return text.length > 0 && text.length <= 32 && EMOJI_ONLY.test(text) && EMOJI_ANY.test(text);
        }

        function scanTree(root) {
            if (root.nodeType !== 1) return;
            check(root);
            for (const el of root.querySelectorAll('*')) check(el);
        }

        function flush() {
            timer = null;
            for (const n of subtrees) if (n.isConnected) scanTree(n);
            for (const n of singles) if (n.isConnected && !subtrees.has(n)) check(n);
            subtrees.clear();
            singles.clear();
            // 上面加 / 删类名产生的记录是自己造成的，丢掉，否则每次扫完都会再触发一轮
            if (observer) observer.takeRecords();
        }

        function schedule() {
            if (!timer) timer = setTimeout(flush, CONFIG.scanThrottle);
        }

        function onMutations(records) {
            for (const r of records) {
                if (r.type === 'childList') {
                    r.addedNodes.forEach((n) => n.nodeType === 1 && subtrees.add(n));
                    // 子节点变了，父元素自己是不是「只装 emoji」也可能变了（textContent = '👍'）
                    if (r.target.nodeType === 1) singles.add(r.target);
                } else {
                    singles.add(r.target);
                }
            }
            if (subtrees.size || singles.size) schedule();
        }

        /** 第一次开启时全量扫一遍并开始监听；之后再调只是空操作。暗色站点永远不会走到这里。 */
        function start() {
            if (observer || !document.body) return;
            fullScan();
            observer = new MutationObserver(onMutations);
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class'],
            });
        }

        function fullScan() {
            scanTree(document.documentElement);
        }

        return { start, fullScan, get started() { return !!observer; } };
    })();

    // =========================================================================
    // 状态
    // =========================================================================

    const State = {
        /**
         * 页面本来是不是暗色。document-start 时先用上次在这个站点量到的结果，
         * 没量过（null）就按亮色处理；DOM 就绪后以实测为准。
         */
        pageDark: Store.pageDark(),
    };

    const systemDark = matchMedia('(prefers-color-scheme: dark)');

    function minutes(hhmm) {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
    }

    /** 现在是否在定时区间内。from > to 表示跨午夜（19:00–07:00）；相等视为空区间。 */
    function inSchedule({ from, to }, now = new Date()) {
        const t = now.getHours() * 60 + now.getMinutes();
        const a = minutes(from), b = minutes(to);
        return a < b ? t >= a && t < b : a > b ? t >= a || t < b : false;
    }

    /** 全局模式此刻要不要暗色（不管站点设置和页面本身）。 */
    function globalWants(s) {
        if (s.mode === 'system') return systemDark.matches;
        if (s.mode === 'schedule') return inSchedule(s.schedule);
        return true;
    }

    /**
     * 最终开不开：站点强制开 > 站点强制关 > 全局模式 && 页面本来不是暗色。
     * 强制开连「页面本来就暗」也不管 —— 用户强制开，多半就是因为自动识别判错了。
     */
    function decide() {
        const site = Store.site();
        if (site === 'on') return true;
        if (site === 'off') return false;
        return globalWants(Store.settings()) && State.pageDark !== true;
    }

    function apply() {
        const on = decide();
        Style.setEnabled(on);
        if (Style.el) {
            Style.el.dataset.pageDark = String(State.pageDark);
            Style.el.dataset.site = Store.site();
        }
        if (on) Scanner.start();
        Menu.render();
    }

    function detect() {
        if (!document.body) return;
        const dark = Detect.measure();
        if (dark !== State.pageDark) console.log(TAG, dark ? '页面本来就是暗色，不反转' : '页面是亮色，反转');
        State.pageDark = dark;
        Store.savePageDark(dark);
        apply();
    }

    // =========================================================================
    // 操作（菜单 / 快捷键）
    // =========================================================================

    const MODE_NAMES = { always: '总是开', system: '跟随系统', schedule: '定时' };
    const SITE_NAMES = { auto: '跟随全局', on: '强制开', off: '强制关' };

    /**
     * 切换本站：翻转「现在看到的」状态。翻过去的结果如果正好等于跟随全局的结果，就存回 auto，
     * 而不是留下一个强制值 —— 否则按两下快捷键之后，本站就再也不跟着全局模式 / 定时走了。
     */
    function toggleSite() {
        const target = !Style.enabled();
        const auto = globalWants(Store.settings()) && State.pageDark !== true;
        Store.saveSite(target === auto ? 'auto' : target ? 'on' : 'off');
        apply();
        console.log(TAG, `本站：${SITE_NAMES[Store.site()]}（${target ? '开' : '关'}）`);
    }

    function setSite(v) {
        Store.saveSite(v);
        apply();
    }

    function askMode() {
        const s = Store.settings();
        const cur = s.mode === 'schedule' ? `3 ${s.schedule.from}-${s.schedule.to}` : String(MODES.indexOf(s.mode) + 1);
        const input = prompt('全局模式：\n1 = 总是开\n2 = 跟随系统主题\n3 = 定时，如「3 19:00-07:00」', cur);
        if (input === null) return;
        const m = /^\s*([123])(?:\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2}))?\s*$/.exec(input);
        if (!m) return alert('没看懂：' + input);
        const patch = { mode: MODES[Number(m[1]) - 1] };
        if (m[2]) {
            const from = Store.validTime(m[2], null), to = Store.validTime(m[3], null);
            if (!from || !to) return alert('时间不对：' + input);
            patch.schedule = { from, to };
        }
        Store.saveSettings(patch);
        apply();
    }

    function askTone() {
        const s = Store.settings();
        const input = prompt('亮度 对比度 棕褐色（百分比，空格分隔）\n默认「100 100 0」；亮度调到 80～90 夜里更柔和', `${s.brightness} ${s.contrast} ${s.sepia}`);
        if (input === null) return;
        const nums = input.trim().split(/[\s,，]+/).map(Number);
        if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) return alert('要三个数字：' + input);
        Store.saveSettings({
            brightness: Store.clamp('brightness', nums[0]),
            contrast: Store.clamp('contrast', nums[1]),
            sepia: Store.clamp('sepia', nums[2]),
        });
        Style.refresh();
        Menu.render();
    }

    /**
     * 菜单文字带当前状态，状态变了就重注册。
     * 没有 GM_unregisterMenuCommand 的管理器上重注册会越点越多，那种情况只注册一次、文字不带状态。
     */
    const Menu = (() => {
        const canUnregister = typeof GM_unregisterMenuCommand === 'function';
        let ids = [];
        let last = '';

        /** 每次 apply() 都会调；文字没变就不动（定时模式每 30 秒 apply 一次，别让菜单跟着闪）。 */
        function render() {
            if (typeof GM_registerMenuCommand !== 'function') return;
            if (ids.length && !canUnregister) return;
            const s = Store.settings();
            const site = Store.site();
            const st = (text) => (canUnregister ? text : '');
            const modeText = s.mode === 'schedule' ? `定时 ${s.schedule.from}-${s.schedule.to}` : MODE_NAMES[s.mode];
            const items = [[`切换本站暗色（Alt+Shift+D）${st(`：现在${Style.enabled() ? '开' : '关'}`)}`, toggleSite]];
            if (site !== 'auto' || !canUnregister) {
                items.push([`本站恢复跟随全局${st(`（现在${SITE_NAMES[site]}）`)}`, () => setSite('auto')]);
            }
            items.push([`全局模式…${st(`（${modeText}）`)}`, askMode]);
            items.push([`亮度 / 对比度 / 棕褐色…${st(`（${s.brightness} / ${s.contrast} / ${s.sepia}）`)}`, askTone]);

            const sig = items.map((i) => i[0]).join('\n');
            if (sig === last) return;
            last = sig;
            ids.forEach((id) => GM_unregisterMenuCommand(id));
            ids = items.map(([caption, fn]) => GM_registerMenuCommand(caption, fn));
        }

        return { render };
    })();

    function onKey(e) {
        if (e.code !== CONFIG.toggleKey || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        toggleSite();
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

    // 捕获阶段、document-start 时注册，排在页面自己的快捷键监听前面
    window.addEventListener('keydown', onKey, true);

    /*
     * DOMContentLoaded 先量一次；load 时外部样式表、字体都到了，再量一次 ——
     * 样式表放在 body 末尾或异步加载的站点，DOMContentLoaded 时背景色还不是最终的。
     */
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', detect, { once: true });
    else detect();
    const onLoad = () => {
        detect();
        // 晚到的样式表可能给已有元素加了背景图
        if (Scanner.started) Scanner.fullScan();
    };
    if (document.readyState !== 'complete') window.addEventListener('load', onLoad, { once: true });

    // 系统主题实时切换（跟随系统模式下立刻生效；也影响「声明了 light dark 的页面」算不算暗）
    systemDark.addEventListener('change', () => {
        if (document.body) detect();
        else apply();
    });

    // 定时模式：定期看钟。用短间隔轮询而不是算好下一个整点 setTimeout —— 电脑睡眠时长定时器会被拖后
    setInterval(() => {
        if (Store.settings().mode === 'schedule') apply();
    }, CONFIG.scheduleCheck);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) apply();
    });
})();
