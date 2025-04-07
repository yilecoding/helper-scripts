// ==UserScript==
// @name         通用视频倍速控制
// @name:zh-CN   通用视频倍速控制
// @name:en      Video Speed Control (any site)
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.04.07.1
// @description  任意网站的 HTML5 视频/音频都能用快捷键调速：加速、减速、恢复 1.0、一键切常用倍速、快进快退。站点把速度重置回 1 时自动恢复，按站点记住倍速。
// @description:zh-CN  任意网站的 HTML5 视频/音频都能用快捷键调速：加速、减速、恢复 1.0、一键切常用倍速、快进快退。站点把速度重置回 1 时自动恢复，按站点记住倍速。
// @description:en  Keyboard speed control for any HTML5 video/audio: faster, slower, reset to 1.0, toggle a preferred speed, seek back/forward. Re-applies your speed when the site resets it to 1, and remembers the speed per site.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        none
// @license      CC BY-NC-SA
// @run-at       document-start
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/video-speed/video-speed.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/video-speed/video-speed.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

/*
 * @run-at 是 document-start：键盘监听要在页面自己的监听「之前」注册到捕获阶段，
 * 才轮得到我们先看按键。DOM 相关的启动等 DOMContentLoaded（见文件末尾）。
 */

(function () {
    'use strict';

    /** 统一日志前缀。控制台过滤框输入「倍速」即可只看本脚本。 */
    const TAG = '[倍速控制]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        step: 0.25,       // 加速 / 减速步长
        minRate: 0.1,
        maxRate: 16,      // Chrome 允许的上限就是 16，再大直接抛 NotSupportedError
    };

    // =========================================================================
    // 媒体元素登记
    // =========================================================================

    const Media = (() => {
        const known = new Set();

        function track(el) {
            if (known.has(el)) return;
            known.add(el);
        }

        function scan() {
            for (const el of document.querySelectorAll('video, audio')) track(el);
        }

        /** 当前还在文档里的媒体元素。被页面移除的顺手清掉，免得 Set 只增不减。 */
        function list() {
            for (const el of known) if (!el.isConnected) known.delete(el);
            return Array.from(known);
        }

        return { scan, list };
    })();

    // =========================================================================
    // 启动
    // =========================================================================

    function boot() {
        try {
            Media.scan();
            console.log(TAG, `已启动，${location.hostname || location.protocol}，发现 ${Media.list().length} 个媒体元素`);
        } catch (err) {
            console.error(TAG, '启动失败', err);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
