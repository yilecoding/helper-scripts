// ==UserScript==
// @name         划词翻译｜选中即译 · 中英自动互译
// @name:zh-CN   划词翻译｜选中即译 · 中英自动互译
// @name:en      Translate Selection | Select-to-Translate, Auto Chinese ⇄ English
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.06.02.2
// @description  选中文字后旁边浮出小图标，点一下就翻译；按住 Alt 选中可直接翻译。中文译成英文、其他语言译成中文。
// @description:zh-CN  选中文字后旁边浮出小图标，点一下就翻译；按住 Alt 选中可直接翻译。中文译成英文、其他语言译成中文。
// @description:en  Select text and a small icon pops up next to it — click to translate. Hold Alt while selecting to translate instantly. Chinese is translated to English, everything else to Chinese.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
// @license      CC BY-NC-SA
// @run-at       document-end
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/translate-selection/translate-selection.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/translate-selection/translate-selection.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「划词翻译」即可只看本脚本的日志。 */
    const TAG = '[划词翻译]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        iconSize: 24,        // 浮动图标边长（px）
        iconOffset: 6,       // 图标离选区末端的距离（px）
        minLength: 1,        // 选中少于这么多字（去掉首尾空白后）不出图标

        targetLang: 'zh-CN', // 目标语言
        cardWidth: 340,      // 结果卡片宽度（px）
        sourcePreview: 80,   // 卡片顶部回显原文，超过这么多字截断
    };

    // =========================================================================
    // 宿主节点：所有 UI 都挂在一个 shadow root 里，页面样式进不来、我们的也出不去
    // =========================================================================

    const UI = (() => {
        let host = null;
        let root = null;

        const CSS = `
            :host { all: initial; }
            .icon {
                position: absolute; box-sizing: border-box;
                display: flex; align-items: center; justify-content: center;
                border-radius: 50%; cursor: pointer; user-select: none;
                font: 600 13px/1 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
                color: #fff; background: #2563eb;
                box-shadow: 0 2px 6px rgba(0, 0, 0, .25);
            }
            .icon:hover { background: #1d4ed8; }

            .card {
                position: absolute; box-sizing: border-box; padding: 10px 12px;
                font: 14px/1.55 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
                color: #1f2937; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
                text-align: left; white-space: normal; word-break: break-word;
            }
            .src { color: #6b7280; font-size: 12px; margin-bottom: 6px; }
            .dst { font-size: 15px; white-space: pre-wrap; max-height: 320px; overflow: auto; }
            .meta { margin-top: 8px; color: #9ca3af; font-size: 11px; }
            .loading { color: #6b7280; }
            .error { color: #dc2626; }
            .error button {
                margin-left: 8px; font: inherit; color: #2563eb; background: none;
                border: 0; padding: 0; cursor: pointer; text-decoration: underline;
            }
        `;

        function ensure() {
            // 页面（尤其 SPA）可能整块替换 body，所以挂在 <html> 下，并且每次用前检查还在不在
            if (host && host.isConnected) return root;
            host = document.createElement('translate-selection-host');
            host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;';
            root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = CSS;
            root.appendChild(style);
            document.documentElement.appendChild(host);
            return root;
        }

        /** 事件是不是发生在我们自己的 UI 上（shadow DOM 里的事件冒泡到 document 时 target 被重定向成 host）。 */
        function owns(e) {
            return !!host && e.composedPath().includes(host);
        }

        return { ensure, owns };
    })();

    // =========================================================================
    // 读取选区
    // =========================================================================

    /** 支持 selectionStart/End 的 input 类型。email/number 读 selectionStart 会直接抛异常。 */
    const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'tel', ''];

    function isTextField(el) {
        if (!el) return false;
        if (el.tagName === 'TEXTAREA') return true;
        return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.includes((el.getAttribute('type') || '').toLowerCase());
    }

    /**
     * 当前选区 → { text, anchor: {x, y, top} }，坐标是文档坐标（含滚动）。
     * 没有有效选区返回 null。
     *
     * input/textarea 里的选区不在 window.getSelection() 里（Firefox 下 toString() 是空串，
     * 也拿不到 Range 的几何信息），只能用 selectionStart/End 取文本，位置退而用输入框本身。
     */
    function readSelection(mouse) {
        const sx = window.scrollX;
        const sy = window.scrollY;
        const active = document.activeElement;

        if (isTextField(active)) {
            const { selectionStart: s, selectionEnd: e } = active;
            if (s != null && e != null && e > s) {
                const text = active.value.slice(s, e);
                if (text.trim().length < CONFIG.minLength) return null;
                const r = active.getBoundingClientRect();
                // 横向尽量跟着鼠标，但不能跑出输入框
                const x = mouse ? Math.min(Math.max(mouse.clientX, r.left), r.right) : r.right;
                return { text, anchor: { x: x + sx, y: r.bottom + sy, top: r.top + sy } };
            }
        }

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
        const text = sel.toString();
        if (text.trim().length < CONFIG.minLength) return null;

        const range = sel.getRangeAt(0);
        // 三击选整段时 Range 的终点落在下一个块的开头，最后一个 rect 宽度为 0，跳过这种
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        if (!rects.length) {
            if (!mouse) return null;
            return { text, anchor: { x: mouse.clientX + sx, y: mouse.clientY + sy, top: mouse.clientY + sy } };
        }
        const last = rects[rects.length - 1];
        return { text, anchor: { x: last.right + sx, y: last.bottom + sy, top: rects[0].top + sy } };
    }

    // =========================================================================
    // 浮动图标
    // =========================================================================

    const Icon = (() => {
        let el = null;
        let pending = null;   // 出图标那一刻的选区快照；点图标时页面选区可能已经变了

        function show(info) {
            const root = UI.ensure();
            if (!el) {
                el = document.createElement('div');
                el.className = 'icon';
                el.textContent = '译';
                el.title = '翻译选中文字';
                // mousedown 默认行为会清掉页面选区，拦住它
                el.addEventListener('mousedown', (e) => e.preventDefault());
                el.addEventListener('click', () => {
                    const info = pending;
                    hide();
                    if (info) onTrigger(info);
                });
            }
            if (!el.isConnected) root.appendChild(el);
            pending = info;

            const size = CONFIG.iconSize;
            const maxX = window.scrollX + document.documentElement.clientWidth - size - 2;
            const x = Math.min(info.anchor.x + CONFIG.iconOffset, maxX);
            const y = info.anchor.y + CONFIG.iconOffset;
            Object.assign(el.style, {
                left: `${x}px`, top: `${y}px`, width: `${size}px`, height: `${size}px`, display: 'flex',
            });
        }

        function hide() {
            pending = null;
            if (el) el.style.display = 'none';
        }

        let onTrigger = () => {};
        return { show, hide, onClick: (fn) => { onTrigger = fn; } };
    })();


    // =========================================================================
    // 网络
    // =========================================================================

    /** GM_xmlhttpRequest 的 Promise 包装（跨域必须走它，页面的 fetch 会被 CORS 拦）。 */
    function request({ method = 'GET', url, data, headers }) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method, url, data, headers,
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) resolve(r.responseText);
                    else reject(new Error(`HTTP ${r.status}`));
                },
                onerror: () => reject(new Error('网络错误')),
            });
        });
    }

    // =========================================================================
    // 翻译接口
    // =========================================================================

    /**
     * Google 网页版用的免费接口（client=gtx）。返回是一个嵌套数组，不是 JSON 对象：
     *   [0] 分段译文：[[译文, 原文, …], …]，长文本会按句切成多段，要拼起来
     *   [2] 识别出的源语言
     */
    const Google = {
        name: 'Google 翻译',

        async translate(text, tl) {
            const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto'
                + `&tl=${encodeURIComponent(tl)}&dt=t&dt=bd&q=${encodeURIComponent(text)}`;
            const data = JSON.parse(await request({ url }));
            if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('返回格式无法识别');
            const translation = data[0].map((seg) => (seg && seg[0]) || '').join('');
            if (!translation) throw new Error('没有译文');
            return { text: translation, src: data[2] || '', tl, engine: this.name };
        },
    };

    async function translate(text, tl) {
        return Google.translate(text, tl);
    }

    // =========================================================================
    // 结果卡片
    // =========================================================================

    const Card = (() => {
        let el = null;

        function h(tag, cls, text) {
            const n = document.createElement(tag);
            if (cls) n.className = cls;
            if (text != null) n.textContent = text;
            return n;
        }

        function preview(text) {
            const t = text.replace(/\s+/g, ' ').trim();
            return t.length > CONFIG.sourcePreview ? t.slice(0, CONFIG.sourcePreview) + '…' : t;
        }

        function place(anchor) {
            const width = Math.min(CONFIG.cardWidth, document.documentElement.clientWidth - 16);
            const minX = window.scrollX + 8;
            const maxX = window.scrollX + document.documentElement.clientWidth - width - 8;
            const x = Math.max(minX, Math.min(anchor.x - width / 2, maxX));
            Object.assign(el.style, { left: `${x}px`, top: `${anchor.y + 8}px`, width: `${width}px`, display: 'block' });
        }

        function open(info) {
            const root = UI.ensure();
            if (!el) el = h('div', 'card');
            if (!el.isConnected) root.appendChild(el);
            el.replaceChildren(h('div', 'src', preview(info.text)), h('div', 'dst loading', '翻译中…'));
            place(info.anchor);
            run(info);
        }

        async function run(info) {
            const token = {};
            el.__token = token;   // 连续触发时只认最后一次的结果，旧请求晚到不能覆盖新卡片
            let result;
            try {
                result = await translate(info.text, CONFIG.targetLang);
            } catch (e) {
                if (el.__token !== token) return;
                console.warn(TAG, '翻译失败', e);
                const err = h('div', 'dst error', `翻译失败：${e.message}`);
                const retry = h('button', null, '重试');
                retry.addEventListener('click', () => open(info));
                err.appendChild(retry);
                el.replaceChildren(h('div', 'src', preview(info.text)), err);
                return;
            }
            if (el.__token !== token) return;
            el.replaceChildren(
                h('div', 'src', preview(info.text)),
                h('div', 'dst', result.text),
                h('div', 'meta', `${result.engine} · ${result.src || 'auto'} → ${result.tl}`),
            );
        }

        function close() {
            if (el) {
                el.__token = null;
                el.style.display = 'none';
            }
        }

        function isOpen() {
            return !!el && el.isConnected && el.style.display !== 'none';
        }

        return { open, close, isOpen };
    })();

    // =========================================================================
    // 事件
    // =========================================================================

    function onMouseUp(e) {
        if (e.button !== 0 || UI.owns(e)) return;
        // mouseup 那一刻选区可能还没定下来（比如在已有选区里单击，是 mouseup 之后才清空），推迟一拍再读
        const mouse = { clientX: e.clientX, clientY: e.clientY };
        setTimeout(() => {
            const info = readSelection(mouse);
            if (!info) return Icon.hide();
            Icon.show(info);
        }, 0);
    }

    function onMouseDown(e) {
        if (UI.owns(e)) return;
        Icon.hide();
        Card.close();
    }

    function boot() {
        Icon.onClick((info) => Card.open(info));
        document.addEventListener('mouseup', onMouseUp, true);
        document.addEventListener('mousedown', onMouseDown, true);
        console.log(TAG, '已加载');
    }

    boot();
})();
