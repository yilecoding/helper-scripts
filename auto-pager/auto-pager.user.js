// ==UserScript==
// @name         自动翻页
// @name:zh-CN   自动翻页
// @name:en      Auto Pager — Load the Next Page When You Scroll to the Bottom
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.09.01.1
// @description  论坛、搜索结果、文章列表滚到底自动加载下一页并拼接到当前页。
// @description:zh-CN  论坛、搜索结果、文章列表滚到底自动加载下一页并拼接到当前页。
// @description:en  Automatically loads the next page of forums, search results and article lists when you scroll near the bottom, and appends it to the current page.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @license      CC BY-NC-SA
// @run-at       document-idle
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/auto-pager/auto-pager.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/auto-pager/auto-pager.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「自动翻页」只看本脚本。 */
    const TAG = '[自动翻页]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        triggerScreens: 2,      // 距页面底部不到这么多屏时加载下一页
    };

    // =========================================================================
    // 存储（GM）
    // =========================================================================

    /** 启用/停用按站点（hostname）存：在某个站上关掉，不该影响别的站。 */
    const Store = (() => {
        const siteKey = 'site:' + location.hostname;

        function site() {
            return { disabled: false, ...GM_getValue(siteKey, {}) };
        }

        function saveSite(patch) {
            GM_setValue(siteKey, { ...site(), ...patch });
        }

        return { site, saveSite };
    })();

    function boot() {
        if (!document.body) return;
        if (Store.site().disabled) {
            console.info(TAG, '本站已停用');
            return;
        }
        console.info(TAG, '启动');
    }

    boot();
})();
