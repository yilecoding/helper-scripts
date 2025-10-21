// ==UserScript==
// @name         弹窗遮罩清理
// @name:zh-CN   弹窗遮罩清理
// @name:en      Overlay Killer — Cookie Banners, Login Walls & Read-More Folds
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.10.21.1
// @description  自动处理 Cookie 同意弹窗（优先点「拒绝全部 / 仅必要」，从不点「接受全部」）、「打开 App 阅读」「登录后查看全文」遮罩，并恢复被锁住的页面滚动；展开「阅读全文」折叠。不误伤视频全屏、图片灯箱和你自己点开的对话框。可按站点停用，可查看并撤销本页处理记录。
// @description:zh-CN  自动处理 Cookie 同意弹窗（优先点「拒绝全部 / 仅必要」，从不点「接受全部」）、「打开 App 阅读」「登录后查看全文」遮罩，并恢复被锁住的页面滚动；展开「阅读全文」折叠。不误伤视频全屏、图片灯箱和你自己点开的对话框。可按站点停用，可查看并撤销本页处理记录。
// @description:en  Automatically deals with cookie consent banners (prefers "Reject all / Necessary only", never clicks "Accept all"), "open in app" and "log in to read more" overlays, restores locked page scrolling, and expands "read more" folds. Leaves fullscreen video, image lightboxes and dialogs you opened yourself alone. Can be disabled per site; lists what it did on the page and can undo the last action.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @license      CC BY-NC-SA
// @run-at       document-end
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/overlay-killer/overlay-killer.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/overlay-killer/overlay-killer.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「弹窗清理」只看本脚本。 */
    const TAG = '[弹窗清理]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        debug: false,
    };

    const log = (...a) => CONFIG.debug && console.log(TAG, ...a);

    /** 处理过的元素打这个属性，值是处理方式；再次扫描时跳过。 */
    const MARK = 'data-overlay-killer';

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

    // =========================================================================
    // 改样式：都记下原值，撤销时原样放回
    // =========================================================================

    /**
     * 内联写 !important。返回撤销函数 —— 恢复的是「原来的内联值和优先级」，
     * 原来没有内联值就删掉，让样式表重新生效。
     */
    function setImportant(el, prop, value) {
        const oldValue = el.style.getPropertyValue(prop);
        const oldPriority = el.style.getPropertyPriority(prop);
        el.style.setProperty(prop, value, 'important');
        return () => {
            if (oldValue) el.style.setProperty(prop, oldValue, oldPriority);
            else el.style.removeProperty(prop);
        };
    }

    /** 隐藏元素并打标记，返回撤销函数。 */
    function hide(el, how) {
        const restore = setImportant(el, 'display', 'none');
        el.setAttribute(MARK, how);
        return () => {
            restore();
            el.setAttribute(MARK, 'undone');
        };
    }

    // =========================================================================
    // 处理记录：菜单里列出来，可撤销
    // =========================================================================

    /** { kind, label, time, undo?: () => void } */
    const records = [];

    function record(kind, label, undo) {
        records.push({ kind, label, time: Date.now(), undo });
        log(kind, label);
    }

    // =========================================================================
    // 主流程
    // =========================================================================

    /** 依次跑各个处理步骤；每一步各自 try，一步出错不影响别的。 */
    const STEPS = [];

    function clean() {
        for (const step of STEPS) {
            try {
                step();
            } catch (e) {
                console.error(TAG, step.name, e);
            }
        }
    }

    const settings = hostSettings();
    if (settings.disabled) {
        log('本站已停用', HOST);
        return;
    }
    clean();
})();
