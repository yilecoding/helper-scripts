// ==UserScript==
// @name         网页复制限制解除｜解除禁止选中、禁止右键、复制版权尾巴
// @name:zh-CN   网页复制限制解除｜解除禁止选中、禁止右键、复制版权尾巴
// @name:en      Copy Unlock | Re-enable Text Selection, Right-Click & Clean Copy
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.03.13.3
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

    injectStyle();
    watchDom();
    log('已启用', HOST);
})();
