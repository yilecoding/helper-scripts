// ==UserScript==
// @name         通用暗色模式
// @name:zh-CN   通用暗色模式
// @name:en      Dark Mode for Any Site
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.07.25.1
// @description  任意网站一键暗色：整页反色再把图片、视频、画布、iframe 反转回来，页面渲染前注入，不闪白。
// @description:zh-CN  任意网站一键暗色：整页反色再把图片、视频、画布、iframe 反转回来，页面渲染前注入，不闪白。
// @description:en  Dark mode for any website: inverts the page and flips images, videos, canvases and iframes back, injected before the page renders so there is no white flash.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_addStyle
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
    };

    const STYLE_ID = 'dark-mode-userscript';
    const FILTER = 'invert(1) hue-rotate(180deg)';

    // =========================================================================
    // 样式
    // =========================================================================

    function buildCss() {
        return `
/*
 * filter 加在 <html> 而不是 <body>：除根元素外，带 filter 的元素会成为 position: fixed 后代的
 * 包含块，加在 body 上所有固定栏都会跟着页面滚走。
 */
html {
    filter: ${FILTER} !important;
    /* 透明的根背景透出来的是浏览器画布，画布不吃 filter，反转后还是白的 */
    background-color: #fff;
}
${CONFIG.revertSelector} {
    filter: ${FILTER} !important;
}
`;
    }

    const Style = (() => {
        let el = null;

        function mount() {
            el = GM_addStyle(buildCss());
            el.id = STYLE_ID;
        }

        return { mount, get el() { return el; } };
    })();

    // =========================================================================
    // 启动
    // =========================================================================

    try {
        Style.mount();
    } catch (e) {
        console.error(TAG, '注入样式失败', e);
    }
})();
