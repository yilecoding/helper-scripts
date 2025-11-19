// ==UserScript==
// @name         阅读位置记忆|长文/小说/文档关掉回来自动回到上次读到的地方
// @name:zh-CN   阅读位置记忆|长文/小说/文档关掉回来自动回到上次读到的地方
// @name:en      Scroll Memory — come back to where you stopped reading
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.11.19.2
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
    };

    // =========================================================================
    // 存储
    //
    // GM 存储按脚本全局共享（不是按站点），所以键里带完整的页面键：
    //   sm:p:<pageKey>   一个页面的阅读位置 Record
    //   sm:settings      { disabled: { [origin]: 1 } }
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
    };

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

    /** 自己的 UI 宿主元素标签（后面的提示条 / 按钮挂在它的 shadow DOM 里）。 */
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
        clearTimeout(timer);
        timer = setTimeout(record, CONFIG.recordDebounceMs);
    }

    /** 防抖期间关标签：最后一次滚动还没落盘。pagehide / 切后台时补一次（GM_setValue 是同步写）。 */
    function flush() {
        if (timer) record();
    }

    function boot() {
        // 捕获阶段：内层容器的 scroll 不冒泡，但捕获能收到
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
        console.log(TAG, '已启动', currentKey);
    }

    try {
        boot();
    } catch (e) {
        console.error(TAG, '启动失败', e);
    }
})();
