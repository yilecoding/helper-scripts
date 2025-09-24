// ==UserScript==
// @name         网页变化监控
// @name:zh-CN   网页变化监控
// @name:en      Page Monitor — Watch Any Part of a Page for Changes
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.09.24.1
// @description  选中页面上的一块区域（价格、库存、公告、成绩、工单状态），内容变化时通知你。
// @description:zh-CN  选中页面上的一块区域（价格、库存、公告、成绩、工单状态），内容变化时通知你。
// @description:en  Pick any part of a page (price, stock, notice, grades, ticket status) and get notified when it changes.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @license      CC BY-NC-SA
// @run-at       document-idle
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/page-monitor/page-monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/page-monitor/page-monitor.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「网页监控」只看本脚本。 */
    const TAG = '[网页监控]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        defaultInterval: 300,   // 秒。新监控项的检查间隔
        minInterval: 30,        // 秒。再短就是在给对方服务器施压了
        maxTextLength: 4000,    // 快照文字上限（存 GM，历史里每条存新旧两份）
        previewLength: 60,      // 列表 / 提示里显示的文字长度
    };

    const HOST_ID = 'page-monitor-host';

    // =========================================================================
    // 存储：每个监控项一个键（mon:<id>）
    // =========================================================================

    /**
     * 不把所有监控项存成一个数组：同一 URL 开着几个标签时，每个标签都在写自己检查的那一项，
     * 整个数组读改写会互相覆盖（A 标签写回的数组里带着 B 标签改之前的旧值）。
     * 一项一个键，各写各的。
     */
    const Store = (() => {
        const PREFIX = 'mon:';

        function all() {
            return GM_listValues()
                .filter((k) => k.startsWith(PREFIX))
                .map((k) => GM_getValue(k, null))
                .filter(Boolean)
                .sort((a, b) => a.createdAt - b.createdAt);
        }

        function get(id) {
            return GM_getValue(PREFIX + id, null);
        }

        function save(mon) {
            GM_setValue(PREFIX + mon.id, mon);
            return mon;
        }

        function patch(id, fields) {
            const cur = get(id);
            if (!cur) return null;
            return save({ ...cur, ...fields });
        }

        function remove(id) {
            GM_deleteValue(PREFIX + id);
        }

        return { all, get, save, patch, remove };
    })();

    /** 监控项按「去掉 hash 的 URL」归属页面：hash 多半是锚点或前端路由的小状态。 */
    function pageUrl(href = location.href) {
        const u = new URL(href);
        u.hash = '';
        return u.href;
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // =========================================================================
    // 文本
    // =========================================================================

    const Text = (() => {
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG']);
        const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

        /**
         * 不用 innerText：抓取型检查拿到的是 DOMParser 解析出来的文档，没有布局，
         * innerText 在那里退化成 textContent（连 <script> 的内容都算进去）。
         * 基线是在活页面上取的、比较时是在解析文档上取的，两边必须走同一套规则，
         * 否则第一次检查就报「变了」。所以自己走一遍 DOM：跳过脚本样式，块级元素前后补空格
         * （压缩过的 HTML 里 <li>A</li><li>B</li> 中间没有空白，textContent 会粘成「AB」）。
         */
        function of(el) {
            const parts = [];
            (function walk(node) {
                for (let n = node.firstChild; n; n = n.nextSibling) {
                    if (n.nodeType === 3) parts.push(n.data);
                    else if (n.nodeType === 1) {
                        if (SKIP.has(n.tagName) || n.id === HOST_ID) continue;
                        const block = BLOCK.test(n.tagName);
                        if (block) parts.push(' ');
                        walk(n);
                        if (block) parts.push(' ');
                    }
                }
            })(el);
            return parts.join('');
        }

        function normalize(text) {
            return String(text || '').replace(/\s+/g, ' ').trim().slice(0, CONFIG.maxTextLength);
        }

        function preview(text, n = CONFIG.previewLength) {
            const s = normalize(text);
            return s.length > n ? s.slice(0, n - 1) + '…' : s;
        }

        return { of, normalize, preview };
    })();

    // =========================================================================
    // 稳定选择器
    // =========================================================================

    const Selector = (() => {
        /** 框架 / 组件库自动生成的 id 前缀：每次渲染都可能变。 */
        const GENERATED_ID = /^(?:ember\d|ext-gen|yui_|ui-id-|react-|radix-|headlessui-|mui-|rc[-_]|el-id-|vue-|ng-|j_id|__next|gwt-)/i;
        /** 状态类名：悬停、选中、展开时才有，刷新后就不一定在了。 */
        const STATE_CLASS = /^(?:is-|has-|js-)|^(?:active|current|selected|hover|focus|focused|open|opened|show|shown|visible|hidden|in|on|checked|disabled|loading|loaded|fade|collapsed|expanded)$/i;

        /** 一串字符里「字母和数字交替」的次数，随机串交替得多，正常单词几乎不交替。 */
        function alternations(s) {
            let n = 0;
            for (let i = 1; i < s.length; i++) {
                if (/\d/.test(s[i]) !== /\d/.test(s[i - 1])) n++;
            }
            return n;
        }

        /**
         * 疑似随机：哈希串、UUID、带冒号的 React useId（:r1:）、长数字流水号、框架前缀。
         * 宁可错杀：错杀的代价只是选择器长一点，放过一个随机 id 的代价是下次刷新就找不到元素。
         */
        function looksRandom(s) {
            if (!s || s.length > 40) return true;
            if (/[:\s]/.test(s)) return true;
            if (GENERATED_ID.test(s)) return true;
            if (/\d{4,}/.test(s)) return true;
            if (/[0-9a-f]{8,}/i.test(s) && /\d/.test(s) && /[a-f]/i.test(s)) return true;
            if (alternations(s) >= 3) return true;
            return false;
        }

        function stableClasses(el) {
            return Array.from(el.classList)
                .filter((c) => !looksRandom(c) && !STATE_CLASS.test(c))
                // CSS Modules / styled-components / emotion：Price_value__3xYz1、sc-bdVaJa、css-1a2b3c
                .filter((c) => !/__[\w-]{4,}$|^sc-|^css-|^jsx-/.test(c))
                .slice(0, 2);
        }

        function uniqueIn(doc, sel, el) {
            try {
                const hit = doc.querySelectorAll(sel);
                return hit.length === 1 && hit[0] === el;
            } catch (e) {
                return false;
            }
        }

        function idSel(el) {
            const id = el.getAttribute('id');
            if (!id || looksRandom(id)) return null;
            const sel = '#' + CSS.escape(id);
            return uniqueIn(el.ownerDocument, sel, el) ? sel : null;
        }

        /**
         * 兄弟里有同标签同类名的才加 :nth-of-type。类名已经能区分开的就不加序号：
         * 序号是最脆的部分，前面插一个同类元素就全错位。
         */
        function step(el) {
            const tag = el.tagName.toLowerCase();
            const classes = stableClasses(el);
            let s = tag + classes.map((c) => '.' + CSS.escape(c)).join('');
            const parent = el.parentElement;
            if (parent) {
                const twins = Array.from(parent.children).filter((c) => c !== el && c.tagName === el.tagName
                    && classes.every((k) => c.classList.contains(k)));
                if (twins.length) {
                    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
                    s += `:nth-of-type(${same.indexOf(el) + 1})`;
                }
            }
            return s;
        }

        /**
         * 自己有稳定 id 就用 id；否则从元素往上逐级拼「标签 + 稳定类名 + :nth-of-type」，
         * 遇到有稳定 id 的祖先就停下，以它为根。每拼一级就试一次唯一性，够唯一就不再往上，
         * 路径越短，页面结构小改时越不容易失效。
         */
        function of(el) {
            const own = idSel(el);
            if (own) return own;
            const doc = el.ownerDocument;
            const parts = [];
            for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
                if (cur !== el) {
                    const anchor = idSel(cur);
                    if (anchor) {
                        const sel = anchor + ' > ' + parts.join(' > ');
                        if (uniqueIn(doc, sel, el)) return sel;
                    }
                }
                if (cur.tagName === 'BODY' || cur.tagName === 'HTML') {
                    parts.unshift(cur.tagName.toLowerCase());
                    break;
                }
                parts.unshift(step(cur));
                const sel = parts.join(' > ');
                if (uniqueIn(doc, sel, el)) return sel;
            }
            return parts.join(' > ');
        }

        return { of, looksRandom };
    })();

    // =========================================================================
    // 界面（shadow DOM）：拾取高亮、确认条、提示
    // =========================================================================

    const CSS_TEXT = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .ui { font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; }
        .hl {
            position: fixed; z-index: 2147483646; pointer-events: none; display: none;
            border: 2px solid #2563eb; background: rgba(37, 99, 235, .12); border-radius: 3px;
            transition: all .05s;
        }
        .hl.picked { border-color: #16a34a; background: rgba(22, 163, 74, .14); }
        .bar {
            position: fixed; z-index: 2147483647; left: 50%; bottom: 16px; transform: translateX(-50%);
            max-width: min(640px, calc(100vw - 32px)); padding: 10px 12px; border-radius: 10px;
            background: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.18); border: 1px solid #d0d7de;
        }
        .bar .tip { color: #57606a; }
        .bar .sel { font: 12px/1.4 ui-monospace, Consolas, monospace; color: #0550ae; word-break: break-all; margin: 4px 0; }
        .bar .text { color: #1f2328; margin: 4px 0 8px; max-height: 4.5em; overflow: hidden; word-break: break-all; }
        .bar .row { display: flex; gap: 6px; flex-wrap: wrap; }
        button {
            font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid #d0d7de;
            background: #f6f8fa; color: #1f2328; cursor: pointer;
        }
        button:hover { background: #eef1f4; }
        button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
        button:disabled { opacity: .5; cursor: default; }
        .toast {
            position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; padding: 8px 12px; border-radius: 8px;
            background: #1f2328; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.2); max-width: 360px;
        }
    `;

    const UI = (() => {
        let host = null;
        let root = null;

        function ensure() {
            if (host && host.isConnected) return root;
            host = document.createElement('div');
            host.id = HOST_ID;
            root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = CSS_TEXT;
            const ui = document.createElement('div');
            ui.className = 'ui';
            root.append(style, ui);
            document.documentElement.appendChild(host);
            return root;
        }

        function layer() {
            return ensure().querySelector('.ui');
        }

        function el(tag, attrs = {}, children = []) {
            const n = document.createElement(tag);
            for (const [k, v] of Object.entries(attrs)) {
                if (k === 'text') n.textContent = v;
                else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
                else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
            }
            for (const c of [].concat(children)) if (c) n.append(c);
            return n;
        }

        let toastTimer = 0;
        function toast(text, ms = 3000) {
            const l = layer();
            let t = l.querySelector('.toast');
            if (!t) l.append((t = el('div', { class: 'toast' })));
            t.textContent = text;
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => t.remove(), ms);
        }

        function isOwn(node) {
            return !!host && (node === host || host.contains(node));
        }

        return { layer, el, toast, isOwn };
    })();

    // =========================================================================
    // 拾取模式
    // =========================================================================

    const Picker = (() => {
        let active = false;
        let hovered = null;
        let picked = null;
        let hl = null;
        let bar = null;

        function place(target) {
            if (!target) {
                hl.style.display = 'none';
                return;
            }
            const r = target.getBoundingClientRect();
            Object.assign(hl.style, {
                display: 'block', left: r.left - 2 + 'px', top: r.top - 2 + 'px',
                width: r.width + 4 + 'px', height: r.height + 4 + 'px',
            });
        }

        function pickable(node) {
            return node && node.nodeType === 1 && !UI.isOwn(node) && node !== document.documentElement && node !== document.body;
        }

        function renderBar() {
            bar.textContent = '';
            if (!picked) {
                bar.append(UI.el('div', { class: 'tip', text: '移动鼠标选择要监控的区域，点击选中 · ↑ 扩到父元素 · Esc 退出' }));
                return;
            }
            const text = Text.normalize(Text.of(picked));
            bar.append(
                UI.el('div', { class: 'sel', text: Selector.of(picked) }),
                UI.el('div', { class: 'text', text: text ? Text.preview(text, 200) : '（这块区域没有文字，监控不到变化）' }),
                UI.el('div', { class: 'row' }, [
                    UI.el('button', { 'data-act': 'parent', text: '↑ 父元素', onclick: () => expand() }),
                    UI.el('button', { 'data-act': 'repick', text: '重新选', onclick: () => { picked = null; hl.classList.remove('picked'); renderBar(); } }),
                    UI.el('button', { 'data-act': 'save-fetch', class: 'primary', text: '监控这一块', disabled: !text, onclick: () => save('fetch') }),
                    UI.el('button', { 'data-act': 'cancel', text: '取消', onclick: () => stop() }),
                ]),
            );
        }

        function expand() {
            const cur = picked || hovered;
            const up = cur && cur.parentElement;
            if (!pickable(up)) return;
            if (picked) {
                picked = up;
                renderBar();
            } else hovered = up;
            place(up);
        }

        function save(mode) {
            const el = picked;
            const text = Text.normalize(Text.of(el));
            const mon = Store.save({
                id: newId(),
                url: pageUrl(),
                title: document.title || location.hostname,
                selector: Selector.of(el),
                mode,
                interval: CONFIG.defaultInterval,
                enabled: true,
                baseline: text,
                lastValue: text,
                createdAt: Date.now(),
            });
            console.info(TAG, '新增监控', mon.selector, Text.preview(text));
            stop();
            UI.toast('已开始监控：' + Text.preview(text, 30));
            return mon;
        }

        // 拾取期间吞掉页面的点击类事件：点的是链接 / 按钮时不能真的跳转或触发站点逻辑
        function swallow(e) {
            if (UI.isOwn(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }

        function onMove(e) {
            if (picked || UI.isOwn(e.target)) return;
            const t = e.target;
            if (!pickable(t) || t === hovered) return;
            hovered = t;
            place(t);
        }

        function onClick(e) {
            if (UI.isOwn(e.target)) return;
            swallow(e);
            if (picked) return;
            const t = pickable(e.target) ? e.target : hovered;
            if (!t) return;
            picked = t;
            hl.classList.add('picked');
            place(t);
            renderBar();
        }

        function onKey(e) {
            if (e.key === 'Escape') {
                swallow(e);
                stop();
            } else if (e.key === 'ArrowUp') {
                swallow(e);
                expand();
            }
        }

        function onScroll() {
            place(picked || hovered);
        }

        const SWALLOW = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'];

        function start() {
            if (active) return;
            active = true;
            hovered = picked = null;
            const layer = UI.layer();
            hl = UI.el('div', { class: 'hl' });
            bar = UI.el('div', { class: 'bar', 'data-role': 'picker' });
            layer.append(hl, bar);
            renderBar();
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('click', onClick, true);
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('scroll', onScroll, true);
            SWALLOW.forEach((t) => document.addEventListener(t, swallow, true));
        }

        function stop() {
            if (!active) return;
            active = false;
            hl.remove();
            bar.remove();
            hovered = picked = null;
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onScroll, true);
            SWALLOW.forEach((t) => document.removeEventListener(t, swallow, true));
        }

        return { start, stop, isActive: () => active };
    })();

    // =========================================================================
    // 启动
    // =========================================================================

    function boot() {
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('选取要监控的区域', () => Picker.start());
        }
    }

    boot();
})();
