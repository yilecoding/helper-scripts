// ==UserScript==
// @name         键盘浏览
// @name:zh-CN   键盘浏览
// @name:en      Keyboard Nav — Vimium-style Keyboard Browsing
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.09.17.7
// @description  Vimium 风格的轻量键盘浏览：j/k、d/u、h/l、gg/G 平滑滚动（自动找到真正在滚的区域，长按连续不卡，支持 5j 数字前缀）；f/F 链接提示（当前页 / 新标签打开，能提示到 open shadow DOM 里的按钮，最短无冲突标签，被遮挡的不出提示，输入框聚焦、其余派发真实点击）；H/L 后退前进、r 刷新、yy 复制网址、gi 聚焦输入框。焦点在输入框里、带 Ctrl/Alt/Meta 的组合键一律不拦。
// @description:zh-CN  Vimium 风格的轻量键盘浏览：j/k、d/u、h/l、gg/G 平滑滚动（自动找到真正在滚的区域，长按连续不卡，支持 5j 数字前缀）；f/F 链接提示（当前页 / 新标签打开，能提示到 open shadow DOM 里的按钮，最短无冲突标签，被遮挡的不出提示，输入框聚焦、其余派发真实点击）；H/L 后退前进、r 刷新、yy 复制网址、gi 聚焦输入框。焦点在输入框里、带 Ctrl/Alt/Meta 的组合键一律不拦。
// @description:en  Lightweight Vimium-style keyboard browsing: smooth j/k, d/u, h/l and gg/G scrolling that finds the area that actually scrolls (stutter-free while a key is held, count prefixes like 5j); f/F show link hints (open in place or in a new tab, reaching into open shadow DOM, shortest prefix-free labels, covered elements skipped, inputs get focus, everything else gets a real click sequence); H/L back/forward, r reload, yy copy URL, gi focus the first input. Keys typed into inputs and Ctrl/Alt/Meta combos are never intercepted.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_openInTab
// @grant        GM_setClipboard
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
        hintChars: 'sadfjklewcmpgh',    // 链接提示标签用的字母，靠前的更常用
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
    // 界面：脚本自己的浮层都放在 shadow DOM 里，页面样式进不来、我们的样式也漏不出去
    // =========================================================================

    const UI_ATTR = 'data-kbnav-ui';

    function createLayer(id, css) {
        const host = document.createElement('div');
        host.id = id;
        host.setAttribute(UI_ATTR, '');
        host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
        const root = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = css;
        root.appendChild(style);
        (document.body || document.documentElement).appendChild(host);
        return root;
    }

    /** 右下角的小提示条（「已复制」之类），过几秒自己消失。 */
    const Toast = (() => {
        let root = null;
        let timer = 0;
        const CSS = `
            .toast {
                position: fixed; right: 16px; bottom: 16px; max-width: 60vw; padding: 6px 12px;
                border-radius: 6px; background: rgba(32, 33, 36, .92); color: #fff;
                font: 13px/1.5 system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0, 0, 0, .3);
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
        `;
        function show(text, ms = 2000) {
            if (!root || !root.host.isConnected) root = createLayer('kbnav-toast', CSS);
            root.querySelector('.toast')?.remove();
            const el = document.createElement('div');
            el.className = 'toast';
            el.textContent = text;
            root.appendChild(el);
            clearTimeout(timer);
            timer = setTimeout(() => el.remove(), ms);
        }
        return { show };
    })();

    // =========================================================================
    // 链接提示
    // =========================================================================

    /**
     * 最短、互不为前缀的标签：把字母表当成一棵树，每次把最浅的叶子展开成下一层，
     * 直到叶子数够用。展开过的节点不再当标签，所以任何标签都不是另一个的前缀 ——
     * 输完一个标签就能立刻触发，不用等超时。
     */
    function hintLabels(n, chars) {
        if (n <= 0) return [];
        const queue = [''];
        let head = 0;
        while (queue.length - head < n || queue.length === 1) {
            const p = queue[head++];
            for (const c of chars) queue.push(p + c);
        }
        return queue.slice(head, head + n);
    }

    const Hints = (() => {
        const CLICKABLE = [
            'a[href]', 'area[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', 'label',
            '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=switch]', '[role=tab]',
            '[role=menuitem]', '[role=option]', '[onclick]', '[contenteditable=""]', '[contenteditable=true]',
            // tabindex=-1 是框架给容器打的「可编程聚焦」标记（整块正文、弹窗外壳），不是可点击的东西
            '[tabindex]:not([tabindex^="-"])',
        ].join(',');

        const CSS = `
            .hint {
                position: fixed; padding: 1px 4px; border-radius: 3px;
                font: bold 12px/1.2 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .5px;
                text-transform: uppercase; color: #302505; white-space: nowrap;
                background: linear-gradient(#fff7c4, #ffd76e); border: 1px solid #c38a22;
                box-shadow: 0 2px 4px rgba(0, 0, 0, .3);
            }
            .hint .typed { color: #b58a21; }
            .hint.hidden { display: none; }
        `;

        let state = null;   // { newTab, hints: [{ el, label, node }], typed, root }

        function isDisabled(el) {
            return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
        }

        /** 点击点所在的那一层：元素在 shadow DOM 里时要用它自己的 root 查，document 只能查到 host。 */
        function hitTest(el, x, y) {
            const root = el.getRootNode();
            const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
            return !!hit && (hit === el || el.contains(hit));
        }

        /**
         * 第一块在视口里、而且真的露在最上面的矩形。折行的链接有多块矩形，任何一块能点到就行。
         * 被遮挡的判断用 elementFromPoint：透明遮罩、弹窗背后、被 overflow 裁掉的部分都会打到别的元素上。
         * 只查中心不够 —— 卡片角上的「×」可能正好压在链接中心，所以再试两个角附近的点。
         */
        function visibleRect(el) {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            for (const r of el.getClientRects()) {
                const left = Math.max(r.left, 0);
                const top = Math.max(r.top, 0);
                const right = Math.min(r.right, vw);
                const bottom = Math.min(r.bottom, vh);
                if (right - left < 3 || bottom - top < 3) continue;
                const points = [
                    [(left + right) / 2, (top + bottom) / 2],
                    [left + 2, top + 2],
                    [right - 2, bottom - 2],
                ];
                if (points.some(([x, y]) => hitTest(el, x, y))) return { left, top, right, bottom };
            }
            return null;
        }

        /**
         * 按文档顺序收集，遇到 open shadow root 就钻进去（Web Components 做的按钮、工具栏）。
         * closed shadow root 从外面拿不到，只能放弃。
         */
        function candidates() {
            const out = [];
            const walk = (root) => {
                for (const el of root.querySelectorAll('*')) {
                    if (el.hasAttribute(UI_ATTR)) continue;
                    if (el.matches(CLICKABLE)) out.push(el);
                    if (el.shadowRoot) walk(el.shadowRoot);
                }
            };
            walk(document);
            return out;
        }

        /** 能在新标签打开的地址；javascript: 链接和 SVG 里的 <a>（href 不是字符串）不算。 */
        function linkUrl(el) {
            if (!(el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement)) return null;
            return el.href && !/^javascript:/i.test(el.href) ? el.href : null;
        }

        function collect(linksOnly) {
            const out = [];
            const seen = new Set();
            for (const el of candidates()) {
                if (isDisabled(el)) continue;
                if (linksOnly && !linkUrl(el)) continue;
                const st = getComputedStyle(el);
                if (st.visibility === 'hidden' || st.visibility === 'collapse') continue;
                const rect = visibleRect(el);
                if (!rect) continue;
                // 包着可见控件的 <label>：控件自己有提示，label 再来一个就重复了
                if (el.tagName === 'LABEL' && el.control && seen.has(el.control)) continue;
                // <a><button>…</button></a> 这类同一块区域嵌套两层的，只留外层
                const prev = out[out.length - 1];
                if (prev && prev.el.contains(el) && sameBox(prev.rect, rect)) continue;
                out.push({ el, rect });
                seen.add(el);
            }
            // label 在控件前面时上面的判断还没见到控件，这里补一遍
            return out.filter((h) => !(h.el.tagName === 'LABEL' && h.el.control && seen.has(h.el.control)));
        }

        function sameBox(a, b) {
            return Math.abs(a.left - b.left) < 4 && Math.abs(a.top - b.top) < 4
                && Math.abs(a.right - b.right) < 4 && Math.abs(a.bottom - b.bottom) < 4;
        }

        function start(newTab) {
            exit();
            const found = collect(newTab);
            if (!found.length) return;
            const labels = hintLabels(found.length, CONFIG.hintChars);
            const root = createLayer('kbnav-hints', CSS);
            const hints = found.map(({ el, rect }, i) => {
                const node = document.createElement('div');
                node.className = 'hint';
                node.dataset.label = labels[i];
                node.style.left = Math.min(rect.left, window.innerWidth - 40) + 'px';
                node.style.top = Math.min(rect.top, window.innerHeight - 20) + 'px';
                root.appendChild(node);
                return { el, label: labels[i], node };
            });
            state = { newTab, hints, typed: '', root };
            render();
            window.addEventListener('scroll', onScroll, true);
            window.addEventListener('resize', exit, true);
            window.addEventListener('blur', exit, true);
            window.addEventListener('mousedown', exit, true);
        }

        function exit() {
            if (!state) return;
            state.root.host.remove();
            state = null;
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', exit, true);
            window.removeEventListener('blur', exit, true);
            window.removeEventListener('mousedown', exit, true);
        }

        function render() {
            for (const h of state.hints) {
                const match = h.label.startsWith(state.typed);
                h.node.classList.toggle('hidden', !match);
                if (!match) continue;
                h.node.textContent = '';
                const typed = document.createElement('span');
                typed.className = 'typed';
                typed.textContent = state.typed;
                h.node.append(typed, h.label.slice(state.typed.length));
            }
        }

        /** 提示开着时页面滚了（平滑滚动的尾巴、页面自己滚）：跟着元素挪，挪出视口的藏起来。 */
        let scrollRaf = 0;
        function onScroll() {
            if (scrollRaf) return;
            scrollRaf = requestAnimationFrame(() => {
                scrollRaf = 0;
                if (!state) return;
                for (const h of state.hints) {
                    const r = h.el.getClientRects()[0];
                    const out = !r || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
                    h.node.style.visibility = out ? 'hidden' : '';
                    if (out) continue;
                    h.node.style.left = Math.min(Math.max(r.left, 0), window.innerWidth - 40) + 'px';
                    h.node.style.top = Math.min(Math.max(r.top, 0), window.innerHeight - 20) + 'px';
                }
            });
        }

        /** 提示模式下的按键：全部吃掉，只认标签字母、Backspace、Esc。 */
        function onKey(e) {
            if (e.ctrlKey || e.altKey || e.metaKey) {
                exit();
                return false;
            }
            const key = e.key;
            if (key === 'Escape') {
                exit();
            } else if (key === 'Backspace') {
                state.typed = state.typed.slice(0, -1);
                render();
            } else if (key.length === 1 && CONFIG.hintChars.includes(key.toLowerCase())) {
                const typed = state.typed + key.toLowerCase();
                const hit = state.hints.find((h) => h.label === typed);
                if (hit) {
                    const newTab = state.newTab;
                    exit();
                    activate(hit.el, newTab);
                } else if (state.hints.some((h) => h.label.startsWith(typed))) {
                    state.typed = typed;
                    render();
                }
                // 不是任何标签的前缀：当作按错，忽略
            }
            return true;
        }

        return { start, exit, onKey, linkUrl, get active() { return !!state; } };
    })();

    // =========================================================================
    // 激活元素：输入框聚焦，其余派发一套真实的点击事件
    // =========================================================================

    /**
     * 只调 el.click() 不够：很多组件（下拉菜单、React 的 onMouseDown 按钮、拖拽库）只认 mousedown/pointerdown，
     * 光有 click 没反应。按真实点击的顺序派发 pointer/mouse 全套，坐标给元素中心。
     */
    function simulateClick(el) {
        const r = el.getBoundingClientRect();
        const base = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
        };
        const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        el.dispatchEvent(new PointerEvent('pointerover', pointer));
        el.dispatchEvent(new MouseEvent('mouseover', base));
        el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
        const down = el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, detail: 1 }));
        // 合成的 mousedown 没有默认行为，真实点击会在这一步把焦点给元素（页面 preventDefault 了就不给）
        if (down && typeof el.focus === 'function') el.focus({ preventScroll: true });
        el.dispatchEvent(new PointerEvent('pointerup', pointer));
        el.dispatchEvent(new MouseEvent('mouseup', { ...base, detail: 1 }));
        el.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
    }

    function activate(el, newTab) {
        const url = newTab && Hints.linkUrl(el);
        if (url) {
            // 后台打开、插在当前标签右边，和中键点链接的习惯一致
            GM_openInTab(url, { active: false, insert: true, setParent: true });
            return;
        }
        if (isEditable(el)) {
            el.focus();
            return;
        }
        simulateClick(el);
    }

    // =========================================================================
    // gi：聚焦第 n 个输入框
    // =========================================================================

    /** 页面上能打字的输入框（含 open shadow DOM 里的），按文档顺序；不可见、禁用、只读的跳过。 */
    function textInputs() {
        const out = [];
        const walk = (root) => {
            for (const el of root.querySelectorAll('*')) {
                if (el.hasAttribute(UI_ATTR)) continue;
                if (el.tagName !== 'SELECT' && isEditable(el) && usable(el)) out.push(el);
                if (el.shadowRoot) walk(el.shadowRoot);
            }
        };
        const usable = (el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0
            && getComputedStyle(el).visibility === 'visible';
        walk(document);
        // contenteditable 的子元素也是 isContentEditable，只留最外层
        return out.filter((el) => !(el.parentElement && el.parentElement.isContentEditable));
    }

    function focusInput(n) {
        const list = textInputs();
        if (!list.length) return Toast.show('页面上没有输入框');
        const el = list[Math.min(n, list.length) - 1];
        el.focus();
        // 把光标放到末尾，接着已有内容往下打
        if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
            try {
                el.setSelectionRange(el.value.length, el.value.length);
            } catch (e) { /* email / number 等类型不支持选区 */ }
        }
    }

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
        { keys: 'f', group: '链接', desc: '链接提示：在当前页打开 / 点击', run: () => Hints.start(false) },
        { keys: 'F', group: '链接', desc: '链接提示：在新标签打开', run: () => Hints.start(true) },
        { keys: 'gi', group: '链接', desc: '聚焦第一个输入框（3gi 第三个）', run: (n) => focusInput(n) },
        { keys: 'H', group: '页面', desc: '后退', run: (n) => history.go(-n) },
        { keys: 'L', group: '页面', desc: '前进', run: (n) => history.go(n) },
        { keys: 'r', group: '页面', desc: '刷新', run: () => location.reload() },
        { keys: 'yy', group: '页面', desc: '复制当前网址', run: copyUrl },
    ];

    function copyUrl() {
        GM_setClipboard(location.href, 'text');
        Toast.show('已复制：' + location.href);
    }

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
        if (Hints.active) {
            if (Hints.onKey(e)) consume(e);
            return;
        }
        if (e.ctrlKey || e.altKey || e.metaKey) return Keys.reset();
        // keydown 的 target 被 shadow DOM 重定向成 host，composedPath()[0] 才是真正的输入框
        const target = (e.composedPath && e.composedPath()[0]) || e.target;
        if (isEditable(target) || isEditable(deepActiveElement())) return Keys.reset();

        const result = e.repeat ? Keys.feedRepeat(e.key) : Keys.feed(e.key);
        // 数字前缀记下但不拦：YouTube 这类站点的数字键照常生效
        if (!result || result === 'count') return;
        consume(e);
    }

    function consume(e) {
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
