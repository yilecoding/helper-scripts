// ==UserScript==
// @name         键盘浏览
// @name:zh-CN   键盘浏览
// @name:en      Keyboard Nav — Vimium-style Keyboard Browsing
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.09.12.1
// @description  Vimium 风格的轻量键盘浏览：j/k 上下滚动。焦点在输入框里、带 Ctrl/Alt/Meta 的组合键一律不拦。
// @description:zh-CN  Vimium 风格的轻量键盘浏览：j/k 上下滚动。焦点在输入框里、带 Ctrl/Alt/Meta 的组合键一律不拦。
// @description:en  Lightweight Vimium-style keyboard browsing: j/k to scroll. Keys typed into inputs and Ctrl/Alt/Meta combos are never intercepted.
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

    function scrollPage(dy) {
        // 'instant' 而不是 'auto'：页面 CSS 写了 scroll-behavior: smooth 时 'auto' 也会变成平滑滚动
        window.scrollBy({ top: dy, behavior: 'instant' });
    }

    // =========================================================================
    // 命令
    // =========================================================================

    const COMMANDS = {
        j: () => scrollPage(CONFIG.scrollStep),
        k: () => scrollPage(-CONFIG.scrollStep),
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
