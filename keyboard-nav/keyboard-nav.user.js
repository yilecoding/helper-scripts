// ==UserScript==
// @name         键盘浏览
// @name:zh-CN   键盘浏览
// @name:en      Keyboard Nav — Vimium-style Keyboard Browsing
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.09.13.2
// @description  Vimium 风格的轻量键盘浏览：j/k 小步、d/u 半屏、h/l 横向滚动，自动找到页面真正在滚的区域（body 不滚、内部 div 滚的站点也行）。焦点在输入框里、带 Ctrl/Alt/Meta 的组合键一律不拦。
// @description:zh-CN  Vimium 风格的轻量键盘浏览：j/k 小步、d/u 半屏、h/l 横向滚动，自动找到页面真正在滚的区域（body 不滚、内部 div 滚的站点也行）。焦点在输入框里、带 Ctrl/Alt/Meta 的组合键一律不拦。
// @description:en  Lightweight Vimium-style keyboard browsing: j/k, d/u (half page) and h/l scrolling that finds the area that actually scrolls (works on sites where an inner div scrolls instead of the page). Keys typed into inputs and Ctrl/Alt/Meta combos are never intercepted.
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
            const opt = { [axis === 'y' ? 'top' : 'left']: v, behavior: 'instant' };
            if (el === root()) window.scrollTo(opt);
            else el.scrollTo(opt);
        }

        /** 半屏：按容器自己的可视高度算，不是窗口高度。 */
        function viewSize(el, axis) {
            if (el === root()) return axis === 'y' ? window.innerHeight : window.innerWidth;
            return axis === 'y' ? el.clientHeight : el.clientWidth;
        }

        /** delta 可以是函数：拿到滚动容器后再算（半屏要知道容器多高）。 */
        function by(axis, delta) {
            const probe = typeof delta === 'function' ? 1 : Math.sign(delta) || 1;
            const el = target(axis, probe);
            if (!el) return;
            const d = typeof delta === 'function' ? delta(el) : delta;
            setPos(el, axis, Math.max(0, Math.min(maxPos(el, axis), pos(el, axis) + d)));
        }

        window.addEventListener('mousedown', (e) => {
            activated = (e.composedPath && e.composedPath()[0]) || e.target;
        }, true);

        return { by, viewSize };
    })();

    // =========================================================================
    // 命令
    // =========================================================================

    const half = (sign) => (el) => sign * Math.round(Scroll.viewSize(el, 'y') / 2);

    const COMMANDS = {
        j: () => Scroll.by('y', CONFIG.scrollStep),
        k: () => Scroll.by('y', -CONFIG.scrollStep),
        h: () => Scroll.by('x', -CONFIG.scrollStep),
        l: () => Scroll.by('x', CONFIG.scrollStep),
        d: () => Scroll.by('y', half(1)),
        u: () => Scroll.by('y', half(-1)),
    };

    // =========================================================================
    // 按键分发
    // =========================================================================

    function onKeyDown(e) {
        // 输入法组字中（中文输入法下按 j 是在打拼音）
        if (e.isComposing || e.keyCode === 229) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        // keydown 的 target 被 shadow DOM 重定向成 host，composedPath()[0] 才是真正的输入框
        const target = (e.composedPath && e.composedPath()[0]) || e.target;
        if (isEditable(target) || isEditable(deepActiveElement())) return;

        const cmd = COMMANDS[e.key];
        if (!cmd) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        try {
            cmd();
        } catch (err) {
            console.error(TAG, e.key, err);
        }
    }

    // 捕获阶段挂在 window 上、document-start 就注册：排在页面自己的 keydown 监听前面
    window.addEventListener('keydown', onKeyDown, true);
})();
