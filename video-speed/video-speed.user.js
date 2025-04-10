// ==UserScript==
// @name         通用视频倍速控制
// @name:zh-CN   通用视频倍速控制
// @name:en      Video Speed Control (any site)
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.04.10.6
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

        /*
         * 用户手势之后这么久以内发生的 ratechange，算用户在播放器自带菜单里主动改的，
         * 我们跟着改，不再把它拉回去。超出这个窗口的算站点重置。
         */
        userChangeWindowMs: 1000,

        osdMs: 1000,      // 改速提示停留多久后淡出
    };

    // =========================================================================
    // 媒体元素登记
    // =========================================================================

    const Media = (() => {
        const known = new Set();
        /** 媒体元素 → 最近一次被用户点到 / 被我们操作的时间。WeakMap，元素被回收时自动消失。 */
        const touched = new WeakMap();
        const newListeners = [];

        function track(el) {
            if (known.has(el)) return;
            known.add(el);
            for (const fn of newListeners) fn(el);
        }

        /** 新发现一个媒体元素时回调（含启动时已经在页面上的）。 */
        function onNew(fn) {
            newListeners.push(fn);
        }

        /*
         * 动态插入的媒体靠 MutationObserver 发现，好让倍速在它开播前就到位，不用等用户按键。
         * MutationObserver 看不进 shadow root 里面，所以每发现一个 open shadow root 就单独 observe 它。
         */
        const observedRoots = new WeakSet();
        const observer = new MutationObserver(records => {
            for (const rec of records) {
                for (const node of rec.addedNodes) if (node.nodeType === 1) collect(node);
            }
        });

        function observeRoot(root) {
            if (observedRoots.has(root)) return;
            observedRoots.add(root);
            observer.observe(root, { childList: true, subtree: true });
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
            if (root.shadowRoot) collectShadow(root.shadowRoot);
            for (const el of root.querySelectorAll('*')) {
                if (isMedia(el)) track(el);
                if (el.shadowRoot) collectShadow(el.shadowRoot);
            }
        }

        function collectShadow(root) {
            observeRoot(root);
            collect(root);
        }

        function scan() {
            if (document.documentElement) collect(document.documentElement);
        }

        /** document-start 时 documentElement 可能还不存在，直接 observe document 节点本身。 */
        function start() {
            observeRoot(document);
            scan();
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

        return { start, scan, list, current, touch, onNew };
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

    const near = (a, b) => Math.abs(a - b) < 1e-3;

    /**
     * 本页期望的倍速：用户最后一次用快捷键或在播放器菜单里选的。
     * active 为 false 时（用户在这页还没调过速）完全不碰任何媒体——
     * 站点自己设的倍速（比如它记住的 1.5）不是我们该管的。
     */
    const Speed = { desired: 1, active: false };

    /** 把期望倍速写到一个元素上。 */
    function apply(el) {
        if (!Speed.active) return;
        try {
            /*
             * defaultPlaybackRate 也要设：换 src 时浏览器的加载算法会把 playbackRate
             * 重置成 defaultPlaybackRate。Chrome 实测这一步会发 ratechange，能被拉回来，
             * 但中间有一下掉回 1；把 default 也设上，换集时速度根本不掉。
             */
            if (!near(el.defaultPlaybackRate, Speed.desired)) el.defaultPlaybackRate = Speed.desired;
            if (!near(el.playbackRate, Speed.desired)) el.playbackRate = Speed.desired;
        } catch (err) {
            console.warn(TAG, '设置倍速失败', Speed.desired, err);
        }
    }

    /**
     * 用户选定一个新倍速。倍速是整页的，但按键只立即作用于「当前视频」：
     * 页面上其它媒体（静音的预告片、预加载的下一集）在它们下次加载 / 开播时才跟上，
     * 不去动用户没在看的东西。
     */
    function setRate(media, rate) {
        Speed.desired = clampRate(rate);
        Speed.active = true;
        apply(media);
        return media.playbackRate;
    }

    // =========================================================================
    // 站点重置 vs 用户主动修改
    // =========================================================================

    /*
     * 站点把速度改回 1 的几种方式，各要一个钩子：
     *   - 播放器自己的逻辑直接写 playbackRate = 1     → ratechange
     *   - 换集：同一个元素换 src                      → 加载算法重置成 defaultPlaybackRate（见 apply），loadedmetadata 时再补一次
     *   - 换集：整个 <video> 换新的                    → MutationObserver 发现新元素
     *   - 广告结束切回正片、play() 时播放器重设        → play / playing
     *
     * 区分「站点重置」和「用户在播放器菜单里主动改」：看改之前不久有没有用户手势。
     * 手势监听挂在 window 捕获阶段，比播放器的点击处理更早执行，时间戳一定先记上。
     * 但「点下一集」也是手势，播放器顺手把速度设回 1 —— 所以有手势时再等一下，
     * 期间这个元素开始加载新资源（loadstart）的，仍然按站点重置处理。
     */
    let lastGesture = -Infinity;
    const markGesture = () => { lastGesture = performance.now(); };
    for (const type of ['pointerdown', 'pointerup', 'click']) window.addEventListener(type, markGesture, true);
    // keydown 不在这里挂：我们自己的快捷键不能算「用户在播放器里改」，由 onKeyDown 只对放行的键调 markGesture

    const lastLoadStart = new WeakMap();

    function onRateChange(e) {
        const el = e.target;
        if (!Speed.active || near(el.playbackRate, Speed.desired)) return;
        if (performance.now() - lastGesture > CONFIG.userChangeWindowMs) {
            apply(el);   // 站点重置
            return;
        }
        const gestureAt = lastGesture;
        setTimeout(() => {
            if ((lastLoadStart.get(el) || -Infinity) >= gestureAt) return apply(el);   // 用户点的是「下一集」
            if (near(el.playbackRate, Speed.desired)) return;
            Speed.desired = clampRate(el.playbackRate);
            console.log(TAG, `用户在播放器里改了倍速：${Speed.desired}`);
        }, 100);
    }

    Media.onNew(el => {
        el.addEventListener('ratechange', onRateChange);
        el.addEventListener('loadstart', () => lastLoadStart.set(el, performance.now()));
        for (const type of ['loadedmetadata', 'play', 'playing']) el.addEventListener(type, () => apply(el));
        apply(el);
    });

    // =========================================================================
    // OSD：改速时在视频左上角浮出的提示
    // =========================================================================

    const OSD = (() => {
        let box = null;
        let timer = 0;

        /*
         * 样式全部走 element.style（CSSOM），不插 <style>：
         * 站点的 CSP 写了 style-src 时，插进去的 <style> 会被拦，而 CSSOM 赋值不受 CSP 管。
         */
        function ensure() {
            if (box && box.isConnected) return box;
            box = document.createElement('div');
            box.setAttribute('data-video-speed-osd', '');
            box.style.cssText = [
                'position:fixed', 'z-index:2147483647', 'pointer-events:none',
                'padding:4px 10px', 'border-radius:4px', 'background:rgba(0,0,0,.6)', 'color:#fff',
                'font:600 16px/1.4 system-ui,sans-serif', 'opacity:0', 'transition:opacity .3s',
            ].join(';');
            (document.body || document.documentElement).appendChild(box);
            return box;
        }

        function show(media, text) {
            const b = ensure();
            // 音频元素、看不见的视频没有可用的矩形，退到视口左上角
            const r = media.getBoundingClientRect();
            const visible = r.width > 0 && r.height > 0;
            b.style.left = (visible ? Math.max(r.left, 0) : 0) + 8 + 'px';
            b.style.top = (visible ? Math.max(r.top, 0) : 0) + 8 + 'px';
            b.textContent = text;
            b.style.opacity = '1';
            clearTimeout(timer);
            timer = setTimeout(() => { b.style.opacity = '0'; }, CONFIG.osdMs);
        }

        return { show };
    })();

    const fmtRate = r => r.toFixed(2).replace(/0$/, '') + '×';

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

    /** 每个动作返回 OSD 上显示的文字。 */
    const ACTIONS = {
        faster: media => fmtRate(setRate(media, stepRate(media.playbackRate, +1))),
        slower: media => fmtRate(setRate(media, stepRate(media.playbackRate, -1))),
        reset: media => fmtRate(setRate(media, 1)),
        preferred: media => fmtRate(togglePreferred(media)),
        rewind: media => (seek(media, -CONFIG.seekSeconds), `« ${CONFIG.seekSeconds} 秒`),
        forward: media => (seek(media, CONFIG.seekSeconds), `${CONFIG.seekSeconds} 秒 »`),
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
        const action = ACTION_BY_CODE[e.code];
        // 带修饰键的留给浏览器和页面；isComposing / 229 是输入法正在组字
        const plain = !(e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing || e.keyCode === 229);
        const media = action && plain && !isTyping(e) ? Media.current() : null;
        if (!media) {
            markGesture();   // 不是我们的键：可能是用户在用播放器自己的快捷键调速
            return;          // 页面没有媒体也不拦，按键原样还给页面
        }
        Media.touch(media);   // 连续按键时锁定同一个，不会因为面积变化中途换人

        e.preventDefault();
        e.stopImmediatePropagation();
        swallowed.add(e.code);
        if (e.repeat && NO_REPEAT.has(action)) return;
        OSD.show(media, ACTIONS[action](media, e));
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
            Media.start();
            console.log(TAG, `已启动，${location.hostname || location.protocol}，发现 ${Media.list().length} 个媒体元素`);
        } catch (err) {
            console.error(TAG, '启动失败', err);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
