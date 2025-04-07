// ==UserScript==
// @name         通用视频倍速控制
// @name:zh-CN   通用视频倍速控制
// @name:en      Video Speed Control (any site)
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.04.07.2
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
        /*
         * 快捷键，写的是 KeyboardEvent.code（物理键位），不是 e.key。
         * e.key 随键盘布局和输入法变：俄语布局按 X 得到「ч」，中文输入法激活时是「Process」，
         * 用 e.key 的话这些用户一个键都按不出来。code 只认键位，跟布局无关。
         *
         * 默认键避开了常见播放器已经占用的：YouTube 的 K J L F M C I T N P、数字、< >；
         * B 站的 D（弹幕开关）、F、M、[ ]。按住 Shift/Ctrl/Alt/Meta 时一律不响应，
         * 把组合键留给浏览器和页面。
         */
        keys: {
            slower: 'KeyZ',
            faster: 'KeyX',
            reset: 'KeyR',     // 恢复 1.0
        },

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

        /** 快捷键作用的对象。先简单取第一个视频，没有视频再取音频。 */
        function current() {
            scan();
            const all = list();
            return all.find(el => el.tagName === 'VIDEO') || all[0] || null;
        }

        return { scan, list, current };
    })();

    // =========================================================================
    // 倍速
    // =========================================================================

    function clampRate(r) {
        return Math.min(CONFIG.maxRate, Math.max(CONFIG.minRate, Math.round(r * 100) / 100));
    }

    /**
     * 加减一档。对齐到步长网格而不是简单 ±step：
     * 从下限 0.1 加速得到 0.25 而不是 0.35，之后一路都是整档。
     * 1e-9 抵消浮点误差（1.75 / 0.25 可能算成 6.999999…）。
     */
    function stepRate(r, dir) {
        const s = CONFIG.step;
        const next = dir > 0 ? Math.floor(r / s + 1e-9) * s + s : Math.ceil(r / s - 1e-9) * s - s;
        return clampRate(next);
    }

    function setRate(media, rate) {
        rate = clampRate(rate);
        try {
            media.playbackRate = rate;
        } catch (err) {
            console.warn(TAG, '设置倍速失败', rate, err);
        }
        return media.playbackRate;
    }

    // =========================================================================
    // 快捷键
    // =========================================================================

    const ACTIONS = {
        faster: media => setRate(media, stepRate(media.playbackRate, +1)),
        slower: media => setRate(media, stepRate(media.playbackRate, -1)),
        reset: media => setRate(media, 1),
    };

    const ACTION_BY_CODE = {};
    for (const [name, code] of Object.entries(CONFIG.keys)) if (code) ACTION_BY_CODE[code] = name;

    const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

    /**
     * 焦点是否在可输入的地方。
     * 必须用 composedPath()[0]：输入框在 shadow DOM 里时，window 上拿到的 e.target
     * 已经被重定向成 shadow host（一个普通的自定义元素），只看 target 会把打字当成快捷键。
     */
    function isTyping(e) {
        const el = (e.composedPath && e.composedPath()[0]) || e.target;
        if (!el || el.nodeType !== 1) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el.type || '').toLowerCase());
        return false;
    }

    /** 本次按下时被我们处理掉的键。对应的 keyup / keypress 也要吞，有些播放器是在 keyup 上响应的。 */
    const swallowed = new Set();

    function onKeyDown(e) {
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
        if (e.isComposing || e.keyCode === 229) return;   // 输入法组字中
        const action = ACTION_BY_CODE[e.code];
        if (!action || isTyping(e)) return;
        const media = Media.current();
        if (!media) return;   // 页面没有媒体就不拦，按键原样还给页面

        e.preventDefault();
        e.stopImmediatePropagation();
        swallowed.add(e.code);
        ACTIONS[action](media, e);
    }

    function onKeyUpOrPress(e) {
        if (!swallowed.has(e.code)) return;
        if (e.type === 'keyup') swallowed.delete(e.code);
        e.preventDefault();
        e.stopImmediatePropagation();
    }

    /*
     * 捕获阶段挂在 window 上：事件流里最早的一站。
     * 挂在冒泡阶段的话，页面在 document 上调了 stopPropagation 我们就收不到了。
     */
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUpOrPress, true);
    window.addEventListener('keypress', onKeyUpOrPress, true);

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
