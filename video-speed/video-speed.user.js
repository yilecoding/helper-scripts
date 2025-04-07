// ==UserScript==
// @name         通用视频倍速控制
// @name:zh-CN   通用视频倍速控制
// @name:en      Video Speed Control (any site)
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.04.07.4
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
            preferred: 'KeyG', // 切到常用倍速，再按切回之前的速度
            rewind: 'KeyQ',
            forward: 'KeyE',
        },

        preferredRate: 2.0,
        seekSeconds: 5,
        step: 0.25,       // 加速 / 减速步长
        minRate: 0.1,
        maxRate: 16,      // Chrome 允许的上限就是 16，再大直接抛 NotSupportedError
    };

    // =========================================================================
    // 媒体元素登记
    // =========================================================================

    const Media = (() => {
        const known = new Set();
        /** 媒体元素 → 最近一次被用户点到 / 被我们操作的时间。WeakMap，元素被回收时自动消失。 */
        const touched = new WeakMap();

        function track(el) {
            if (known.has(el)) return;
            known.add(el);
        }

        const isMedia = node => node.nodeType === 1 && (node.tagName === 'VIDEO' || node.tagName === 'AUDIO');

        /**
         * 深度收集：连同 open shadow DOM 一起找。
         * document.querySelectorAll 不会穿进 shadow root，Web Components 封装的播放器
         * （<xx-player> 里面套 <video>）用普通选择器永远找不到。
         * closed shadow root 拿不到（el.shadowRoot 是 null），这是平台限制。
         */
        function collect(root) {
            if (isMedia(root)) track(root);
            if (root.shadowRoot) collect(root.shadowRoot);
            for (const el of root.querySelectorAll('*')) {
                if (isMedia(el)) track(el);
                if (el.shadowRoot) collect(el.shadowRoot);
            }
        }

        function scan() {
            if (document.documentElement) collect(document.documentElement);
        }

        /** 当前还在文档里的媒体元素。被页面移除的顺手清掉，免得 Set 只增不减。 */
        function list() {
            for (const el of known) if (!el.isConnected) known.delete(el);
            return Array.from(known);
        }

        function touch(el) {
            touched.set(el, performance.now());
        }

        const isPlaying = el => !el.paused && !el.ended;

        /** 在视口里露出来的面积。被 visibility:hidden / opacity:0 藏起来的算 0。 */
        function visibleArea(el) {
            if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return 0;
            const r = el.getBoundingClientRect();
            const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
            const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
            return w > 0 && h > 0 ? w * h : 0;
        }

        /**
         * 「当前视频」：正在播放的 > 最近交互过的 > 视口里露出面积最大的。
         * 播放优先：页面角落里静音自动播放的预告片面积再小，用户真正在看的那个也一定在播；
         * 都在播（主视频 + 静音广告）时再看用户点过哪个，都没点过才比面积。
         * 既不在播、没点过、也看不见的（预加载的下一集、display:none 的）不参与。
         */
        function current() {
            scan();
            const scored = list()
                .map(el => ({ el, playing: isPlaying(el) ? 1 : 0, touched: touched.get(el) || 0, area: visibleArea(el) }))
                .filter(c => c.playing || c.touched || c.area > 0);
            scored.sort((a, b) => b.playing - a.playing || b.touched - a.touched || b.area - a.area);
            return scored.length ? scored[0].el : null;
        }

        /*
         * 「点过哪个」用坐标判定而不是看事件路径：多数播放器在 <video> 上面盖了一层控制条 / 遮罩，
         * 点击落在遮罩上，事件路径里根本没有 <video>。
         */
        window.addEventListener('pointerdown', e => {
            for (const el of list()) {
                const r = el.getBoundingClientRect();
                if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) touch(el);
            }
        }, true);

        return { scan, list, current, touch };
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

    /** 按 G 切到常用倍速之前的速度，再按 G 时切回它。 */
    let rateBeforePreferred = 1;

    function togglePreferred(media) {
        const cur = media.playbackRate;
        if (Math.abs(cur - CONFIG.preferredRate) > 1e-6) {
            rateBeforePreferred = cur;
            return setRate(media, CONFIG.preferredRate);
        }
        return setRate(media, rateBeforePreferred === CONFIG.preferredRate ? 1 : rateBeforePreferred);
    }

    /** 快进快退。duration 在直播流里是 Infinity、元数据没到时是 NaN，这两种情况不钳上限。 */
    function seek(media, delta) {
        let t = media.currentTime + delta;
        if (t < 0) t = 0;
        if (Number.isFinite(media.duration) && t > media.duration) t = media.duration;
        media.currentTime = t;
    }

    const ACTIONS = {
        faster: media => setRate(media, stepRate(media.playbackRate, +1)),
        slower: media => setRate(media, stepRate(media.playbackRate, -1)),
        reset: media => setRate(media, 1),
        preferred: togglePreferred,
        rewind: media => seek(media, -CONFIG.seekSeconds),
        forward: media => seek(media, CONFIG.seekSeconds),
    };

    /** 按住不放时浏览器会连发 keydown（e.repeat）。加减速、快进快退连发是想要的，切换类的不是。 */
    const NO_REPEAT = new Set(['reset', 'preferred']);

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
        Media.touch(media);   // 连续按键时锁定同一个，不会因为面积变化中途换人

        e.preventDefault();
        e.stopImmediatePropagation();
        swallowed.add(e.code);
        if (e.repeat && NO_REPEAT.has(action)) return;
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
