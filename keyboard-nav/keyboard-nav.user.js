// ==UserScript==
// @name         键盘浏览
// @name:zh-CN   键盘浏览
// @name:en      Keyboard Nav — Vimium-style Keyboard Browsing
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.09.16.4
// @description  Vimium 风格的轻量键盘浏览：j/k 小步、d/u 半屏、h/l 横向、gg/G 顶部底部，平滑滚动、长按连续滚动不卡，支持数字前缀（5j），自动找到页面真正在滚的区域（body 不滚、内部 div 滚的站点也行）。焦点在输入框里、带 Ctrl/Alt/Meta 的组合键一律不拦。
// @description:zh-CN  Vimium 风格的轻量键盘浏览：j/k 小步、d/u 半屏、h/l 横向、gg/G 顶部底部，平滑滚动、长按连续滚动不卡，支持数字前缀（5j），自动找到页面真正在滚的区域（body 不滚、内部 div 滚的站点也行）。焦点在输入框里、带 Ctrl/Alt/Meta 的组合键一律不拦。
// @description:en  Lightweight Vimium-style keyboard browsing: j/k, d/u (half page), h/l and gg/G scrolling with smooth, stutter-free continuous scrolling while a key is held, count prefixes (5j) that finds the area that actually scrolls (works on sites where an inner div scrolls instead of the page). Keys typed into inputs and Ctrl/Alt/Meta combos are never intercepted.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        none
// @license      CC BY-NC-SA
// @run-at       document-start
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/keyboard-nav/keyboard-nav.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/keyboard-nav/keyboard-nav.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「键盘浏览」只看本脚本。 */
    const TAG = '[键盘浏览]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        scrollStep: 60,         // j/k 一下滚多少像素
        sequenceTimeout: 1500,  // 多键序列（gg、yy）和数字前缀，两键之间最多等这么久
        maxCount: 999,          // 数字前缀上限，手滑按出 99999j 也不至于卡死
        smooth: true,           // 平滑滚动（系统开了「减少动态效果」时自动关）
        smoothFactor: 0.25,     // 平滑滚动每 16.7ms 追上剩余距离的这么多比例
    };

    // =========================================================================
    // 焦点判断
    // =========================================================================

    /** 这些 input 不接收文字输入，焦点在上面时照样响应快捷键。 */
    const NON_TEXT_INPUTS = new Set([
        'button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden',
    ]);

    /** 真正的焦点元素：document.activeElement 停在 shadow host 上，要钻进 shadowRoot 找。 */
    function deepActiveElement() {
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        return el;
    }

    function isEditable(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el.getAttribute('type') || '').toLowerCase());
        return false;
    }

    // =========================================================================
    // 滚动
    // =========================================================================

    /**
     * 滚动目标 = 「当前可滚动的主区域」。很多站点（后台、文档站、聊天应用）body 不滚，
     * 滚的是内部某个 div，对 window 滚动毫无反应。
     *
     * 选法和浏览器方向键一致：最近点击过的元素往上找第一个还能往这个方向滚的容器；
     * 没点过（或点的地方滚不动）就从视口中央的元素往上找，取可见面积最大的那个。
     */
    const Scroll = (() => {
        let activated = null;   // 最近一次鼠标按下的元素

        const root = () => document.scrollingElement || document.documentElement;
        const prop = (axis) => (axis === 'y' ? 'overflowY' : 'overflowX');

        function rootScrollable(axis) {
            const r = root();
            const room = axis === 'y' ? r.scrollHeight - r.clientHeight : r.scrollWidth - r.clientWidth;
            if (room < 1) return false;
            // body 的 overflow 只有 html 是 visible 时才会传给视口：body{overflow:hidden} 也能锁住整页
            const html = getComputedStyle(document.documentElement)[prop(axis)];
            if (html === 'hidden' || html === 'clip') return false;
            if (html === 'visible' && document.body) {
                const body = getComputedStyle(document.body)[prop(axis)];
                if (body === 'hidden' || body === 'clip') return false;
            }
            return true;
        }

        function scrollable(el, axis) {
            if (el === root()) return rootScrollable(axis);
            const room = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
            if (room < 1) return false;
            const v = getComputedStyle(el)[prop(axis)];
            return v === 'auto' || v === 'scroll' || v === 'overlay';
        }

        function pos(el, axis) {
            if (el === root()) return axis === 'y' ? window.scrollY : window.scrollX;
            return axis === 'y' ? el.scrollTop : el.scrollLeft;
        }

        function maxPos(el, axis) {
            return axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
        }

        function canMove(el, axis, dir) {
            const p = pos(el, axis);
            return dir < 0 ? p > 0 : p < maxPos(el, axis) - 1;
        }

        /** 视口里能看到的面积：比 scrollHeight 更接近「哪块是主区域」。 */
        function visibleArea(el) {
            if (el === root()) return window.innerWidth * window.innerHeight;
            const r = el.getBoundingClientRect();
            const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
            const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
            return w > 0 && h > 0 ? w * h : 0;
        }

        /** 父元素，穿过 shadow root 到 host。 */
        function parentOf(el) {
            if (el.parentElement) return el.parentElement;
            const r = el.getRootNode && el.getRootNode();
            return r && r.host ? r.host : null;
        }

        function ancestors(el, axis) {
            const out = [];
            for (let n = el; n; n = parentOf(n)) {
                if (n === document.documentElement || n === document.body) continue;
                if (scrollable(n, axis)) out.push(n);
            }
            if (rootScrollable(axis)) out.push(root());
            return out;
        }

        /** 视口中央的元素，钻进 open shadow root 找到最深的那个。 */
        function centerElement() {
            const x = window.innerWidth / 2;
            const y = window.innerHeight / 2;
            let el = document.elementFromPoint(x, y);
            while (el && el.shadowRoot) {
                const inner = el.shadowRoot.elementFromPoint(x, y);
                if (!inner || inner === el) break;
                el = inner;
            }
            return el;
        }

        function target(axis, dir) {
            if (activated && activated.isConnected) {
                const list = ancestors(activated, axis);
                const hit = list.find((el) => canMove(el, axis, dir));
                if (hit) return hit;
            }
            const center = centerElement();
            let list = center ? ancestors(center, axis) : [];
            if (!list.length) list = rootScrollable(axis) ? [root()] : scanAll(axis);
            if (!list.length) return null;
            const movable = list.filter((el) => canMove(el, axis, dir));
            const pool = movable.length ? movable : list;
            return pool.reduce((a, b) => (visibleArea(b) > visibleArea(a) ? b : a));
        }

        /** 兜底：视口中央压着的是一层不滚的遮罩之类，全页找可见面积最大的滚动容器。 */
        function scanAll(axis) {
            let best = null;
            let bestArea = 0;
            for (const el of document.querySelectorAll('body *')) {
                const area = visibleArea(el);
                if (area > bestArea && scrollable(el, axis)) {
                    best = el;
                    bestArea = area;
                }
            }
            return best ? [best] : [];
        }

        function setPos(el, axis, v) {
            // 'instant' 而不是 'auto'：页面 CSS 写了 scroll-behavior: smooth 时 'auto' 也会变成平滑滚动
            const opt = { [axis === 'y' ? 'top' : 'left']: v, behavior: 'instant' };
            if (el === root()) window.scrollTo(opt);
            else el.scrollTo(opt);
        }

        // ---------------------------------------------------------------------
        // 平滑滚动
        //
        // 不用 scrollBy({ behavior: 'smooth' })：动画途中再调一次，原生实现从「当前位置」重新算，
        // 实测快速连按两下 j 只滚了 120 而不是 180；长按时每个重复 keydown 都把动画打断重来，一顿一顿。
        // 这里给每个（容器, 方向）记一个目标位置，新按键只往目标上累加，rAF 每帧追剩余距离的一部分 ——
        // 长按时目标匀速前移、动画一直追着跑，就是连续的匀速滚动。
        // ---------------------------------------------------------------------

        const anims = [];   // { el, axis, target, last }
        let raf = 0;
        let lastFrame = 0;
        const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

        const animOf = (el, axis) => anims.find((a) => a.el === el && a.axis === axis);

        function animateTo(el, axis, target) {
            if (!CONFIG.smooth || (reduceMotion && reduceMotion.matches)) {
                setPos(el, axis, target);
                return;
            }
            let a = animOf(el, axis);
            if (!a) anims.push((a = { el, axis, target, last: null }));
            a.target = target;
            if (!raf) {
                lastFrame = performance.now();
                raf = requestAnimationFrame(frame);
            }
        }

        function frame(now) {
            // 按时间算比例：120Hz 屏上每帧追得少一点，整体速度和 60Hz 一样
            const dt = Math.min(Math.max(now - lastFrame, 1), 100);
            lastFrame = now;
            const k = 1 - Math.pow(1 - CONFIG.smoothFactor, dt / 16.7);
            for (let i = anims.length - 1; i >= 0; i--) {
                const a = anims[i];
                const cur = pos(a.el, a.axis);
                // 动画途中用户自己滚了（滚轮、拖滚动条）：让给用户，不往回拽
                const hijacked = a.last !== null && Math.abs(cur - a.last) > 2;
                const diff = a.target - cur;
                if (hijacked || !a.el.isConnected || Math.abs(diff) < 1) {
                    if (!hijacked && a.el.isConnected) setPos(a.el, a.axis, a.target);
                    anims.splice(i, 1);
                    continue;
                }
                const move = Math.abs(diff * k) < 1 ? Math.sign(diff) : diff * k;
                setPos(a.el, a.axis, cur + move);
                a.last = pos(a.el, a.axis);
                // 设了没动（内容在动画途中变短了之类）：别空转
                if (a.last === cur) anims.splice(i, 1);
            }
            raf = anims.length ? requestAnimationFrame(frame) : 0;
        }

        /** 动画中的目标位置优先：连按时在上一次的目标上累加，而不是在半路的当前位置上。 */
        function basePos(el, axis) {
            const a = animOf(el, axis);
            return a ? a.target : pos(el, axis);
        }

        const clamp = (el, axis, v) => Math.max(0, Math.min(maxPos(el, axis), v));

        /** 滚到某一端：pos 为 0 是开头，Infinity 是末尾。 */
        function to(axis, p) {
            const el = target(axis, p === 0 ? -1 : 1);
            if (el) animateTo(el, axis, clamp(el, axis, p));
        }

        /** delta 可以是函数：拿到滚动容器后再算（半屏要知道容器多高）。 */
        function by(axis, delta) {
            const probe = typeof delta === 'function' ? 1 : Math.sign(delta) || 1;
            const el = target(axis, probe);
            if (!el) return;
            const d = typeof delta === 'function' ? delta(el) : delta;
            animateTo(el, axis, clamp(el, axis, basePos(el, axis) + d));
        }

        /** 半屏：按容器自己的可视高度算，不是窗口高度。 */
        function viewSize(el, axis) {
            if (el === root()) return axis === 'y' ? window.innerHeight : window.innerWidth;
            return axis === 'y' ? el.clientHeight : el.clientWidth;
        }

        window.addEventListener('mousedown', (e) => {
            activated = (e.composedPath && e.composedPath()[0]) || e.target;
        }, true);

        return { by, to, viewSize };
    })();

    // =========================================================================
    // 命令
    // =========================================================================

    const half = (sign, n) => (el) => sign * n * Math.round(Scroll.viewSize(el, 'y') / 2);

    /**
     * 命令表。keys 是按键序列（区分大小写，Shift+g 就是 G）；run 收到数字前缀（没有时为 1）；
     * repeat 表示长按时自动重复的 keydown 也执行 —— 只给滚动用，长按 f 不该开一堆提示。
     */
    const COMMANDS = [
        { keys: 'j', group: '滚动', desc: '向下滚动', repeat: true, run: (n) => Scroll.by('y', n * CONFIG.scrollStep) },
        { keys: 'k', group: '滚动', desc: '向上滚动', repeat: true, run: (n) => Scroll.by('y', -n * CONFIG.scrollStep) },
        { keys: 'h', group: '滚动', desc: '向左滚动', repeat: true, run: (n) => Scroll.by('x', -n * CONFIG.scrollStep) },
        { keys: 'l', group: '滚动', desc: '向右滚动', repeat: true, run: (n) => Scroll.by('x', n * CONFIG.scrollStep) },
        { keys: 'd', group: '滚动', desc: '向下半屏', repeat: true, run: (n) => Scroll.by('y', half(1, n)) },
        { keys: 'u', group: '滚动', desc: '向上半屏', repeat: true, run: (n) => Scroll.by('y', half(-1, n)) },
        { keys: 'gg', group: '滚动', desc: '滚到顶部', run: () => Scroll.to('y', 0) },
        { keys: 'G', group: '滚动', desc: '滚到底部', run: () => Scroll.to('y', Infinity) },
    ];

    const BINDINGS = new Map(COMMANDS.map((c) => [c.keys, c]));
    /** 所有多键序列的真前缀（g、y …）：按下后要等下一个键。 */
    const PREFIXES = new Set(COMMANDS.flatMap((c) => Array.from(c.keys).slice(0, -1).map((_, i) => c.keys.slice(0, i + 1))));

    function run(cmd, n) {
        try {
            cmd.run(n);
        } catch (err) {
            console.error(TAG, cmd.keys, err);
        }
    }

    // =========================================================================
    // 按键分发
    // =========================================================================

    const Keys = (() => {
        let pending = '';   // 多键序列已按下的部分
        let count = '';     // 数字前缀
        let timer = 0;

        function reset() {
            pending = '';
            count = '';
            clearTimeout(timer);
        }

        function arm() {
            clearTimeout(timer);
            timer = setTimeout(reset, CONFIG.sequenceTimeout);
        }

        /**
         * 喂一个键，返回 'run' | 'wait' | 'count' | null（不认识，放给页面）。
         * 序列断了（g 后面跟了个 j）就丢掉前缀，把这个键当单键重新解释 —— 不然 gj 会把 j 吞掉。
         */
        function feed(key) {
            if (!pending && /^[0-9]$/.test(key) && (count || key !== '0')) {
                count = String(Math.min(Number(count + key), CONFIG.maxCount));
                arm();
                return 'count';
            }
            const seq = pending + key;
            const cmd = BINDINGS.get(seq);
            if (cmd) {
                const n = count ? Number(count) : 1;
                reset();
                run(cmd, n);
                return 'run';
            }
            if (PREFIXES.has(seq)) {
                pending = seq;
                arm();
                return 'wait';
            }
            if (pending) {
                const keepCount = count;
                reset();
                count = keepCount;
                return feed(key);
            }
            reset();
            return null;
        }

        /** 长按产生的重复 keydown：只有单键滚动命令跟着重复，其余已绑定的键吞掉不处理。 */
        function feedRepeat(key) {
            const cmd = BINDINGS.get(key);
            if (!pending && cmd && cmd.repeat) {
                run(cmd, 1);
                return 'run';
            }
            return cmd || PREFIXES.has(key) ? 'wait' : null;
        }

        return { feed, feedRepeat, reset };
    })();

    /**
     * 吃掉了 keydown 的键，配套的 keypress / keyup 也不给页面：
     * 有的站点在 keyup 或 keypress 上绑快捷键，只拦 keydown 会两边一起触发。
     */
    const swallowed = new Set();

    function onKeyDown(e) {
        // 输入法组字中（中文输入法下按 j 是在打拼音）
        if (e.isComposing || e.keyCode === 229) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return Keys.reset();
        // keydown 的 target 被 shadow DOM 重定向成 host，composedPath()[0] 才是真正的输入框
        const target = (e.composedPath && e.composedPath()[0]) || e.target;
        if (isEditable(target) || isEditable(deepActiveElement())) return Keys.reset();

        const result = e.repeat ? Keys.feedRepeat(e.key) : Keys.feed(e.key);
        // 数字前缀记下但不拦：YouTube 这类站点的数字键照常生效
        if (!result || result === 'count') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        swallowed.add(e.code);
    }

    function onKeyPressOrUp(e) {
        if (!swallowed.has(e.code)) return;
        if (e.type === 'keyup') swallowed.delete(e.code);
        e.preventDefault();
        e.stopImmediatePropagation();
    }

    window.addEventListener('keypress', onKeyPressOrUp, true);
    window.addEventListener('keyup', onKeyPressOrUp, true);
    // 捕获阶段挂在 window 上、document-start 就注册：排在页面自己的 keydown 监听前面
    window.addEventListener('keydown', onKeyDown, true);
})();
