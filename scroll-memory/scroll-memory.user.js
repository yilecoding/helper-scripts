// ==UserScript==
// @name         阅读位置记忆|长文/小说/文档关掉回来自动回到上次读到的地方
// @name:zh-CN   阅读位置记忆|长文/小说/文档关掉回来自动回到上次读到的地方
// @name:en      Scroll Memory — come back to where you stopped reading
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.11.21.4
// @description  长文章、小说、文档读到一半关掉，回来时自动回到上次的位置。
// @description:zh-CN  长文章、小说、文档读到一半关掉，回来时自动回到上次的位置。
// @description:en  Remembers how far you read on long articles, novels and docs, and takes you back there next time.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @license      CC BY-NC-SA
// @run-at       document-end
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/scroll-memory/scroll-memory.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/scroll-memory/scroll-memory.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「阅读位置」只看本脚本。 */
    const TAG = '[阅读位置]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        /*
         * 页面键 = origin + pathname + 白名单里的 query。
         * 只有「决定是哪一页内容」的参数才参与：?page=3、?chapter=12、?id=…；
         * utm_*、from、spm 这类跟踪参数不在白名单里，自然不参与。
         */
        queryWhitelist: ['page', 'p', 'pn', 'id', 'tid', 'aid', 'cid', 'bid', 'chapter', 'chapterid', 'article', 'doc', 'v'],

        recordDebounceMs: 600,   // 滚动停止多久后记录
        minScreens: 2,           // 页面总长超过几屏才记录
        minScrolledScreens: 1,   // 滚过几屏才记录（只看了开头不值得记）

        /*
         * 恢复前等内容稳定：页面高度连续 stableMs 不变，或最多等 maxWaitMs。
         * 太早跳，后面的图片 / 异步内容一撑开，位置就又不对了。
         */
        stableMs: 500,
        maxWaitMs: 5000,

        /** 'prompt'：浮出「跳回上次位置 · 取消」；'jump'：直接跳。菜单里可切换，存在 sm:settings。 */
        restoreMode: 'prompt',
        promptMs: 12000,         // 提示条多久没人理就自己收起
        /*
         * 当前位置离目标不到这么多屏，就当作「浏览器已经按像素还原过了」，
         * 不弹提示，直接按锚点悄悄校准（刷新时 Chrome 会先按 scrollY 还原，再被晚到的内容推开一点）。
         */
        nearScreens: 0.5,
    };

    // =========================================================================
    // 存储
    //
    // GM 存储按脚本全局共享（不是按站点），所以键里带完整的页面键：
    //   sm:p:<pageKey>   一个页面的阅读位置 Record
    //   sm:settings      { mode?: 'prompt' | 'jump', disabled: { [origin]: 1 } }
    // 一页一个键：每次滚动停下只写这一页，不用把所有页面整块读写一遍。
    // =========================================================================

    const PREFIX = 'sm:p:';

    const Store = {
        get(key) {
            const v = GM_getValue(PREFIX + key, null);
            return v && typeof v === 'object' ? v : null;
        },
        set(key, rec) { GM_setValue(PREFIX + key, rec); },
        remove(key) { GM_deleteValue(PREFIX + key); },
        settings() {
            const v = GM_getValue('sm:settings', null);
            const s = v && typeof v === 'object' ? v : {};
            return { mode: s.mode === 'jump' || s.mode === 'prompt' ? s.mode : CONFIG.restoreMode, disabled: s.disabled || {} };
        },
        saveSettings(s) { GM_setValue('sm:settings', s); },
    };

    let settings = Store.settings();

    // =========================================================================
    // 页面键
    // =========================================================================

    function pageKey(loc = location) {
        const url = new URL(loc.href);
        const keep = [];
        for (const [k, v] of url.searchParams) {
            if (CONFIG.queryWhitelist.includes(k.toLowerCase())) keep.push([k, v]);
        }
        // 参数顺序不同（?page=2&id=1 / ?id=1&page=2）是同一页
        keep.sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
        const query = keep.length ? '?' + new URLSearchParams(keep).toString() : '';
        return url.origin + url.pathname + query;
    }

    // =========================================================================
    // 滚动容器
    //
    // 统一成同一套接口：top / setTop / view / height / max / viewTop（视口上沿在屏幕上的 y）/ root。
    // el 为 null 表示 window（document.scrollingElement）。
    // =========================================================================

    function makeScroller(el) {
        const box = () => el || document.scrollingElement || document.documentElement;
        return {
            el,
            /** 锚点的选择器路径从这里开始算。 */
            root: () => el || document.body,
            top: () => box().scrollTop,
            setTop(y) {
                if (el) el.scrollTo({ top: y, behavior: 'instant' });
                else window.scrollTo({ top: y, behavior: 'instant' });
            },
            view: () => box().clientHeight,
            height: () => box().scrollHeight,
            max: () => Math.max(0, box().scrollHeight - box().clientHeight),
            /** 可视区在屏幕上的矩形（clientTop 扣掉边框）。 */
            rect() {
                if (!el) return { top: 0, left: 0, width: document.documentElement.clientWidth, height: window.innerHeight };
                const r = el.getBoundingClientRect();
                return { top: r.top + el.clientTop, left: r.left + el.clientLeft, width: el.clientWidth, height: el.clientHeight };
            },
        };
    }

    let scroller = makeScroller(null);

    // =========================================================================
    // 锚点
    //
    // 只存 scrollY 不够：图片懒加载、字号变化、广告插入都会让像素位置漂移。
    // 存视口顶部附近的一个「块」元素：
    //   path  选择器路径（从最近的稳定 id 祖先或滚动容器开始算）
    //   tag / fp / i  标签、文本指纹（前 40 字，或图片文件名）、同标签序号 —— 路径对不上时按指纹找
    //   off / eh      视口上沿在元素里的偏移、元素当时的高度 —— 元素变高变矮时按比例换算
    // =========================================================================

    /** 视口上沿往下依次探测的位置：最上面几像素常被吸顶栏占着。 */
    const PROBE_Y = [8, 40, 80, 140, 220, 320];
    const PROBE_X = [0.5, 0.35, 0.65];
    const FP_LEN = 40;
    const FP_MIN = 6;

    /**
     * SPA 组件库生成的 id 每次渲染都不一样，拿来当路径起点等于没存。
     * 认出来就跳过，继续往上找。
     */
    const RANDOM_ID = [
        /[:«»]/,                                    // React useId
        /\d{4,}/,                                   // 长数字串：ember1234、mui-38291
        /[0-9a-f]{8}-[0-9a-f]{4}-/i,                // uuid
        /(^|[^0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}($|[^0-9a-z])/i,
        /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[\w-]{8,}$/, // nanoid
    ];

    function stableId(el) {
        const id = el.id;
        return id && !RANDOM_ID.some((re) => re.test(id)) ? id : '';
    }

    function normText(el) {
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /** 文本指纹：前 40 字；没什么字的（配图、分隔线）用图片文件名；都没有就是 null（只能靠路径）。 */
    function fingerprint(el) {
        const text = normText(el);
        if (text.length >= FP_MIN) return text.slice(0, FP_LEN);
        const img = el.tagName === 'IMG' ? el : el.querySelector('img');
        const src = img && (img.getAttribute('src') || '');
        if (src) return 'img:' + src.split(/[?#]/)[0].split('/').slice(-2).join('/');
        return null;
    }

    function pathOf(el, root) {
        const parts = [];
        for (let n = el; n && n !== root && n !== document.documentElement; n = n.parentElement) {
            const id = stableId(n);
            if (id) return ['#' + CSS.escape(id), ...parts].join(' > ');
            const tag = n.tagName.toLowerCase();
            let k = 1;
            for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) k++;
            parts.unshift(tag + ':nth-of-type(' + k + ')');
        }
        return [':scope', ...parts].join(' > ');
    }

    /** 元素或祖先是 fixed / sticky：吸顶栏、浮动广告，滚动时不跟着内容走，不能当锚点。 */
    function isFloating(el) {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            const pos = getComputedStyle(n).position;
            if (pos === 'fixed' || pos === 'sticky') return true;
        }
        return false;
    }

    /**
     * 屏幕上 (x, y) 处的块级元素。
     * elementFromPoint 打到段落间的空隙时拿到的是整个正文容器 —— 太大的元素往下钻到跨过 y 的那个子元素；
     * 打到 <em>/<a> 这类行内元素往上爬到所在的块。
     */
    function blockAt(x, y, sc) {
        let el = document.elementFromPoint(x, y);
        if (!el || el === document.documentElement) return null;
        const root = sc.root();
        // 打到容器本身（段落间隙）也算：下面会往里钻
        if (!root.contains(el) || el.closest(UI_TAG) || isFloating(el)) return null;
        const limit = sc.view() * 0.8;
        while (el.children.length && el.getBoundingClientRect().height > limit) {
            let next = null;
            for (const c of el.children) {
                const r = c.getBoundingClientRect();
                if (r.height > 0 && r.bottom > y) { next = c; break; }
            }
            if (!next) break;
            el = next;
        }
        while (el !== root && el.parentElement && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
        return el === root ? null : el;
    }

    function describe(el, sc) {
        const r = el.getBoundingClientRect();
        const root = sc.root();
        const tag = el.tagName.toLowerCase();
        return {
            path: pathOf(el, root),
            tag,
            fp: fingerprint(el),
            i: Array.prototype.indexOf.call(root.getElementsByTagName(tag), el),
            off: Math.round(sc.rect().top - r.top),
            eh: Math.round(r.height),
        };
    }

    /** 视口顶部附近第一个有文本指纹的块；都没有指纹就退而求其次要第一个块。 */
    function captureAnchor(sc) {
        const r = sc.rect();
        let fallback = null;
        for (const dy of PROBE_Y) {
            if (dy >= r.height) break;
            for (const fx of PROBE_X) {
                const el = blockAt(r.left + r.width * fx, r.top + dy, sc);
                if (!el) continue;
                const a = describe(el, sc);
                if (a.fp) return a;
                fallback = fallback || a;
            }
        }
        return fallback;
    }

    // =========================================================================
    // 记录
    // =========================================================================

    /** 自己的 UI 宿主元素标签（提示条 / 按钮挂在它的 shadow DOM 里）。 */
    const UI_TAG = 'scroll-memory-ui';

    let currentKey = pageKey();
    let timer = 0;

    function snapshot() {
        const sc = scroller;
        const view = sc.view();
        const height = sc.height();
        const top = sc.top();
        if (height <= view * CONFIG.minScreens) return null;
        if (top <= view * CONFIG.minScrolledScreens) return null;
        const max = sc.max();
        return {
            t: Date.now(),
            p: +(max > 0 ? top / max : 0).toFixed(4),
            y: Math.round(top),
            h: height,
            a: captureAnchor(sc),
        };
    }

    function record() {
        clearTimeout(timer);
        timer = 0;
        const rec = snapshot();
        if (rec) Store.set(currentKey, rec);
    }

    function onScroll() {
        // 等待恢复期间的滚动是浏览器自己的恢复、页面加载撑开的，不是在读：不记，免得覆盖掉要恢复的那条
        if (phase === 'waiting') return;
        clearTimeout(timer);
        timer = setTimeout(record, CONFIG.recordDebounceMs);
    }

    /** 防抖期间关标签：最后一次滚动还没落盘。pagehide / 切后台时补一次（GM_setValue 是同步写）。 */
    function flush() {
        if (timer) record();
    }

    // =========================================================================
    // 恢复
    // =========================================================================

    /** 'idle' | 'waiting'（等内容稳定，准备恢复） */
    let phase = 'idle';
    /** 等待恢复期间用户自己动过（滚轮 / 触摸 / 翻页键 / 拖滚动条）：那就不打扰了。 */
    let userMoved = false;

    function queryPath(path, root) {
        try {
            return path.startsWith(':scope') ? root.querySelector(path) : document.querySelector(path);
        } catch (e) {
            return null;
        }
    }

    /** 路径对不上（前面插了段落、改版）时按指纹找：同标签、指纹相同，取序号离记录时最近的那个。 */
    function findByFingerprint(a, root) {
        let best = null;
        let bestDist = Infinity;
        const list = root.getElementsByTagName(a.tag);
        for (let i = 0; i < list.length; i++) {
            const dist = Math.abs(i - a.i);
            if (dist >= bestDist) continue;
            if (fingerprint(list[i]) === a.fp) {
                best = list[i];
                bestDist = dist;
            }
        }
        return best;
    }

    /**
     * 算出要滚到哪：路径命中且指纹一致 → 指纹搜索 → 进度百分比。
     * 返回 { top, via }。
     */
    function locate(rec, sc) {
        const a = rec.a;
        const root = sc.root();
        let el = null;
        let via = 'percent';
        if (a) {
            el = queryPath(a.path, root);
            if (el && a.fp && fingerprint(el) !== a.fp) el = null;
            if (el) via = 'path';
            else if (a.fp) {
                el = findByFingerprint(a, root);
                if (el) via = 'text';
            }
        }
        let top;
        if (el) {
            const r = el.getBoundingClientRect();
            // 视口上沿落在元素内部时按比例换算：字号变了、图片撑高了，读到的还是同一行附近
            let off = a.off;
            if (a.off >= 0 && a.off <= a.eh && a.eh > 0) off = (a.off / a.eh) * r.height;
            top = sc.top() + r.top - sc.rect().top + off;
        } else {
            top = rec.p * sc.max();
        }
        return { top: Math.max(0, Math.min(sc.max(), Math.round(top))), via };
    }

    /** 页面高度连续 stableMs 不变（或等满 maxWaitMs）后回调。 */
    function waitStable(sc, done) {
        const start = Date.now();
        let last = sc.height();
        let changedAt = start;
        const iv = setInterval(() => {
            const now = Date.now();
            const h = sc.height();
            if (h !== last) {
                last = h;
                changedAt = now;
            }
            if (now - changedAt >= CONFIG.stableMs || now - start >= CONFIG.maxWaitMs) {
                clearInterval(iv);
                done();
            }
        }, 100);
    }

    function jumpTo(rec, why) {
        const { top, via } = locate(rec, scroller);
        scroller.setTop(top);
        console.log(TAG, why, { via, top, percent: Math.round(rec.p * 100) });
    }

    /**
     * 这次加载该不该由脚本来恢复。
     * - 前进 / 后退（back_forward）：交给浏览器。同一会话里浏览器自己记着像素位置，bfcache 命中时
     *   连脚本都不会重跑；没命中时浏览器也会按 history.scrollRestoration = 'auto' 还原。
     *   再插一手就是两边抢着滚。
     * - 带 #锚点 打开：用户要看的就是那一节。
     * - 普通打开时页面已经不在顶部：脚本跑起来之前用户已经滚了。
     * - 刷新（reload）照常恢复：浏览器按像素还原了也会被晚到的内容推开，下面按「离目标近不近」区分。
     */
    function skipReason() {
        const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        const type = nav ? nav.type : 'navigate';
        if (type === 'back_forward') return '前进/后退，交给浏览器';
        const hash = decodeURIComponent(location.hash.slice(1));
        if (hash && (document.getElementById(hash) || document.getElementsByName(hash)[0])) return '带 #锚点 打开';
        if (type === 'navigate' && scroller.top() > 0) return '用户已经滚动';
        return '';
    }

    function restore(key) {
        const rec = Store.get(key);
        if (!rec) return;
        const skip = skipReason();
        if (skip) return console.log(TAG, '不恢复：' + skip);
        phase = 'waiting';
        userMoved = false;
        waitStable(scroller, () => {
            phase = 'idle';
            if (key !== currentKey) return;
            if (userMoved) return console.log(TAG, '不恢复：等待期间用户自己滚动了');
            const { top } = locate(rec, scroller);
            const cur = scroller.top();
            if (cur > 0 && Math.abs(cur - top) < scroller.view() * CONFIG.nearScreens) return jumpTo(rec, '浏览器已大致还原，按锚点校准');
            if (settings.mode === 'jump') return jumpTo(rec, '已恢复到上次位置');
            UI.prompt(Math.round(rec.p * 100), () => {
                if (key === currentKey) jumpTo(rec, '已跳回上次位置');
            });
        });
    }

    /** 用户主动滚动的信号。scroll 事件本身分不出是用户、浏览器还原还是内容撑开，所以看输入事件。 */
    const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' ', 'Spacebar']);

    function onIntent(e) {
        if (e.type === 'keydown') {
            if (!SCROLL_KEYS.has(e.key)) return;
            const t = e.target;
            if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        }
        // 按在滚动条上：target 是滚动容器本身（window 的滚动条是 <html>）
        if (e.type === 'mousedown' && e.target !== document.documentElement && e.target !== scroller.el) return;
        userMoved = true;
    }

    // =========================================================================
    // UI（shadow DOM，宿主挂在 <html> 下，页面样式进不来）
    // =========================================================================

    const CSS_TEXT = `
        :host { all: initial; }
        .prompt {
            position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
            display: flex; align-items: center; gap: 4px;
            padding: 6px 8px; border-radius: 999px;
            background: rgba(32, 33, 36, .92); color: #fff;
            font: 14px/1.4 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
            box-shadow: 0 4px 16px rgba(0, 0, 0, .25);
        }
        .prompt[hidden] { display: none; }
        button {
            all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; color: inherit;
        }
        button:hover, button:focus-visible { background: rgba(255, 255, 255, .16); }
        .jump { font-weight: 600; }
        .sep { opacity: .5; }
    `;

    const UI = {
        host: null,
        root: null,
        promptTimer: 0,
        ensure() {
            if (this.host && this.host.isConnected) return this.root;
            const host = document.createElement(UI_TAG);
            // 内联 !important：页面写 `* { display: none }` 一类的规则也盖不过
            host.style.cssText = 'all: initial !important; display: block !important; position: fixed !important; '
                + 'top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important;';
            const root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>${CSS_TEXT}</style>
                <div class="prompt" hidden role="status">
                    <button class="jump" type="button"></button><span class="sep">·</span><button class="cancel" type="button">取消</button>
                </div>`;
            document.documentElement.appendChild(host);
            this.host = host;
            this.root = root;
            return root;
        },
        prompt(percent, onJump) {
            const root = this.ensure();
            const box = root.querySelector('.prompt');
            const jump = root.querySelector('.jump');
            jump.textContent = '跳回上次位置（' + percent + '%）';
            jump.onclick = () => { this.hidePrompt(); onJump(); };
            root.querySelector('.cancel').onclick = () => this.hidePrompt();
            box.hidden = false;
            clearTimeout(this.promptTimer);
            this.promptTimer = setTimeout(() => this.hidePrompt(), CONFIG.promptMs);
        },
        hidePrompt() {
            clearTimeout(this.promptTimer);
            if (this.root) this.root.querySelector('.prompt').hidden = true;
        },
    };

    function boot() {
        // 捕获阶段：内层容器的 scroll 不冒泡，但捕获能收到
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
        for (const type of ['wheel', 'touchmove', 'keydown', 'mousedown']) window.addEventListener(type, onIntent, { capture: true, passive: true });
        console.log(TAG, '已启动', currentKey);
        restore(currentKey);
    }

    try {
        boot();
    } catch (e) {
        console.error(TAG, '启动失败', e);
    }
})();
