// ==UserScript==
// @name         网页复制限制解除｜解除禁止选中、禁止右键、复制版权尾巴
// @name:zh-CN   网页复制限制解除｜解除禁止选中、禁止右键、复制版权尾巴
// @name:en      Copy Unlock | Re-enable Text Selection, Right-Click & Clean Copy
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.03.13.2
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

    injectStyle();
    log('已启用', HOST);
})();
