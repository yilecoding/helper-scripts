// ==UserScript==
// @name         网页复制限制解除｜解除禁止选中、禁止右键、复制版权尾巴
// @name:zh-CN   网页复制限制解除｜解除禁止选中、禁止右键、复制版权尾巴
// @name:en      Copy Unlock | Re-enable Text Selection, Right-Click & Clean Copy
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.03.14.5
// @description  解除 CSDN、知乎专栏、各类文库/小说站的「禁止选中 / 禁止右键 / 复制后追加版权尾巴 / 复制要登录」限制。按站点启用/停用，可选是否连右键一起解锁。
// @description:zh-CN  解除 CSDN、知乎专栏、各类文库/小说站的「禁止选中 / 禁止右键 / 复制后追加版权尾巴 / 复制要登录」限制。按站点启用/停用，可选是否连右键一起解锁。
// @description:en  Removes copy restrictions on sites like CSDN, Zhihu and novel/document libraries: re-enables text selection and right-click, strips the copyright footer appended on copy, and lets you copy code without logging in. Per-site on/off switch; right-click unlocking is optional.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_getValue
// @license      CC BY-NC-SA
// @run-at       document-start
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/copy-unlock/copy-unlock.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/copy-unlock/copy-unlock.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

/*
 * @run-at 必须是 document-start：事件层要在 window 的捕获阶段「第一个」注册监听，
 * 才能抢在页面的处理器之前拦住事件。晚一步，页面先注册的捕获监听就拦不住了。
 */

(function () {
    'use strict';

    const TAG = '[复制解锁]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        debug: false,

        /*
         * 不强制可选中的元素。表单控件本来就能选，强行改 user-select 反而会让
         * 按钮双击时选中文字；可编辑区交给编辑器自己管。
         */
        keepSelector: 'input, textarea, select, button, [contenteditable=""], [contenteditable="true"]',

        /** 有的站把 ::selection 设成透明，「能选但看不见」。开着就恢复系统选区色。 */
        fixSelectionColor: true,

        /** 无条件移除的内联属性：这些属性在正文元素上几乎只用来做限制。 */
        stripAttrs: ['oncopy', 'oncut', 'onbeforecopy', 'onselectstart', 'oncontextmenu', 'ondragstart', 'unselectable'],

        /*
         * 只在「看起来是拦截」时才移除的内联属性。onmousedown 之类在链接上常用来
         * 做点击统计/跳转改写，一刀切删掉会把正常功能弄坏。
         */
        stripIfBlocking: ['onmousedown', 'onmouseup', 'onkeydown'],
        blockingPattern: /return\s*false|preventDefault|returnValue\s*=\s*false/i,

        /** 在 window 捕获阶段截住、不让页面看到的事件。 */
        events: ['copy', 'cut', 'selectstart', 'contextmenu', 'dragstart', 'keydown'],

        /** keydown 只截这几个组合键（Ctrl/Cmd + 键），别的快捷键照常给页面。 */
        hotkeys: ['c', 'a', 'x'],

        /** 可编辑区：事件层完全不碰，复制/剪切/快捷键交给编辑器自己处理。 */
        editableSelector: 'input, textarea, select, [contenteditable]:not([contenteditable="false"])',

        /*
         * 复制时去掉的零宽字符（文库/小说站拿它做隐形水印、打断关键词）。
         * 刻意不含 U+200D / U+200C：前者是 emoji 组合序列的连接符（👨‍👩‍👧），
         * 后者是波斯文、印地文等书写系统的正常字符，删了会把正文弄坏。
         */
        zeroWidth: /[\u200B\u2060\uFEFF]/g,
    };

    const log = (...a) => CONFIG.debug && console.log(TAG, ...a);

    // =========================================================================
    // 站点设置：按 hostname 存在 GM 存储里
    // =========================================================================

    const HOST = location.hostname;
    const STORE_KEY = 'sites';

    /** { [hostname]: { disabled?: boolean } } */
    function hostSettings() {
        const all = GM_getValue(STORE_KEY, {}) || {};
        return all[HOST] || {};
    }

    const settings = hostSettings();
    if (settings.disabled) {
        log('本站已停用', HOST);
        return;
    }

    // =========================================================================
    // CSS 层：强制可选中
    // =========================================================================

    function injectStyle() {
        const not = CONFIG.keepSelector.split(',').map(x => `:not(${x.trim()})`).join('');
        let css = `
            html, body, body *${not} {
                -webkit-user-select: text !important;
                user-select: text !important;
            }
        `;
        if (CONFIG.fixSelectionColor) {
            css += `
                ::selection {
                    background-color: Highlight !important;
                    color: HighlightText !important;
                }
            `;
        }
        css += `[${HIDE_ATTR}] { display: none !important; }`;
        const style = document.createElement('style');
        style.textContent = css;
        style.dataset.copyUnlock = '';
        whenRoot(root => root.appendChild(style));
    }

    /*
     * document-start 时 documentElement 可能还是 null（取决于注入时机），
     * 直接 appendChild 会抛错，GM_addStyle 在这一刻也不保证可用。等 <html> 出现再挂。
     */
    function whenRoot(fn) {
        if (document.documentElement) return fn(document.documentElement);
        const mo = new MutationObserver(() => {
            if (!document.documentElement) return;
            mo.disconnect();
            fn(document.documentElement);
        });
        mo.observe(document, { childList: true });
    }

    // =========================================================================
    // 内联属性清理（含之后动态插入 / 动态改写的节点）
    // =========================================================================

    const ALL_ATTRS = [...CONFIG.stripAttrs, ...CONFIG.stripIfBlocking];
    const ATTR_SELECTOR = ALL_ATTRS.map(a => `[${a}]`).join(',');

    function cleanAttr(el, name) {
        const v = el.getAttribute(name);
        if (v === null) return;
        if (CONFIG.stripIfBlocking.includes(name) && !CONFIG.blockingPattern.test(v)) return;
        // 移除内容属性时，对应的 on* 事件处理器也会被一并清掉（HTML 规范行为）
        el.removeAttribute(name);
    }

    function cleanElement(el) {
        for (const name of ALL_ATTRS) cleanAttr(el, name);
    }

    function cleanTree(root) {
        if (root.nodeType !== 1) return;
        if (root.matches(ATTR_SELECTOR)) cleanElement(root);
        for (const el of root.querySelectorAll(ATTR_SELECTOR)) cleanElement(el);
    }

    function watchDom() {
        const mo = new MutationObserver(records => {
            for (const r of records) {
                if (r.type === 'attributes') cleanAttr(r.target, r.attributeName);
                else for (const n of r.addedNodes) cleanTree(n);
            }
        });
        // 从 document 开始观察：解析器插入的节点也会产生记录，不用等 DOMContentLoaded
        mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ALL_ATTRS });
        document.addEventListener('DOMContentLoaded', () => cleanTree(document.documentElement), { once: true });
    }

    // =========================================================================
    // 事件层：window 捕获阶段抢先截住，页面的处理器收不到事件
    // =========================================================================

    /*
     * 为什么是 stopImmediatePropagation 而不是去「撤销」preventDefault：
     * 事件一旦被 preventDefault 就撤不回来；而 `document.oncopy = () => false`、
     * `<body oncopy="return false">` 这类处理器在引擎内部取消默认行为，
     * 改写 Event.prototype.preventDefault 也拦不住。唯一可靠的办法是让它们收不到事件。
     * window 捕获阶段是整条传播路径的起点，document-start 注册保证我们排第一。
     *
     * 代价是页面对这些事件的所有监听都失效，所以可编辑区整块放行：
     * 富文本 / 代码编辑器靠 copy/cut/keydown 维护自己的数据模型，截了就坏。
     */

    /** 事件的真实目标。Shadow DOM 里 e.target 会被重定向到宿主，要看 composedPath。 */
    function realTarget(e) {
        let node = (e.composedPath && e.composedPath()[0]) || e.target;
        if (node && node.nodeType === 3) node = node.parentElement; // selectstart 的目标可能是文本节点
        return node && node.nodeType === 1 ? node : null;
    }

    function inEditable(el) {
        return !!el && (el.isContentEditable || !!el.closest(CONFIG.editableSelector));
    }

    function isCopyHotkey(e) {
        return (e.ctrlKey || e.metaKey) && !e.altKey && CONFIG.hotkeys.includes((e.key || '').toLowerCase());
    }

    function onEvent(e) {
        if (inEditable(realTarget(e))) return;
        if (e.type === 'keydown' && !isCopyHotkey(e)) return;
        e.stopImmediatePropagation();
        if (e.type === 'copy') writeClipboard(e);
    }

    // =========================================================================
    // 复制：自己往 clipboardData 写干净的文本和 HTML
    // =========================================================================

    /*
     * 光截住页面的 copy 监听还不够：小说站/文库会在正文里塞「看不见的干扰字」，
     * 浏览器原生复制照样带出来。实测 Chrome 的 Selection.toString() 会跳过
     * display:none / visibility:hidden，但 font-size:0、color:transparent 的
     * 文字和零宽字符都原样保留。所以在复制瞬间把这类节点临时藏掉，再借浏览器
     * 自己的序列化取文本（换行、空白处理和原生一致），取完立刻还原。
     */
    const HIDE_ATTR = 'data-copy-unlock-hide';

    function isInvisible(el) {
        const cs = getComputedStyle(el);
        // display:none 的文字 toString() 自己会跳过，但 cloneContents() 照样克隆进 HTML
        if (cs.display === 'none' || cs.visibility === 'hidden') return true;
        if (parseFloat(cs.fontSize) === 0) return true;
        // 渐变标题常用 color:transparent + background-clip:text，那是能看见的字
        if (/^rgba\(.*,\s*0\)$|^transparent$/.test(cs.color) && cs.backgroundClip !== 'text' && cs.webkitBackgroundClip !== 'text') return true;
        return false;
    }

    function markInvisible(range) {
        const marked = [];
        const root = range.commonAncestorContainer.nodeType === 1
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        for (let el = walker.currentNode; el; el = walker.nextNode()) {
            if (el === root || !range.intersectsNode(el)) continue;
            if (isInvisible(el)) {
                el.setAttribute(HIDE_ATTR, '');
                marked.push(el);
            }
        }
        return marked;
    }

    /** 片段里的相对链接、图片地址改成绝对地址，粘贴到别处才能用。 */
    function absolutize(frag) {
        for (const el of frag.querySelectorAll('[href], [src]')) {
            for (const name of ['href', 'src']) {
                const v = el.getAttribute(name);
                if (v !== null) try { el.setAttribute(name, new URL(v, location.href).href); } catch (err) { /* 非法 URL 原样留着 */ }
            }
        }
    }

    function rangeToHtml(range) {
        const frag = range.cloneContents();
        for (const el of frag.querySelectorAll(`[${HIDE_ATTR}]`)) el.remove();
        absolutize(frag);
        const box = document.createElement('div');
        // 只选中代码块里的一部分时，片段里没有 <pre>，粘贴后缩进和换行会被折叠
        const node = range.commonAncestorContainer;
        const pre = (node.nodeType === 1 ? node : node.parentElement).closest('pre');
        if (pre) {
            const wrap = document.createElement('pre');
            wrap.appendChild(frag);
            box.appendChild(wrap);
        } else {
            box.appendChild(frag);
        }
        return box.innerHTML;
    }

    function writeClipboard(e) {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
        const ranges = Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i));
        const marked = ranges.flatMap(markInvisible);
        let text, html;
        try {
            text = sel.toString().replace(CONFIG.zeroWidth, '');
            html = ranges.map(rangeToHtml).join('').replace(CONFIG.zeroWidth, '');
        } finally {
            for (const el of marked) el.removeAttribute(HIDE_ATTR);
        }
        if (!text) return; // 选中的全是图片之类：交给浏览器原生复制
        e.clipboardData.setData('text/plain', text);
        e.clipboardData.setData('text/html', html);
        e.preventDefault();
        log('已复制', text.length, '字');
    }

    function hookEvents() {
        for (const type of CONFIG.events) window.addEventListener(type, onEvent, true);
    }

    hookEvents();
    injectStyle();
    watchDom();
    log('已启用', HOST);
})();
