// ==UserScript==
// @name         阅读位置记忆|长文/小说/文档关掉回来自动回到上次读到的地方
// @name:zh-CN   阅读位置记忆|长文/小说/文档关掉回来自动回到上次读到的地方
// @name:en      Scroll Memory — come back to where you stopped reading
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.11.26.10
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
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        unsafeWindow
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
        /*
         * 跳回去之后的这段时间里继续盯着锚点：内容还在上方插（懒加载图片撑开、广告晚到）就跟着纠正。
         * Chrome / Firefox 有 scroll anchoring 会自己补偿，Safari 和关掉了 overflow-anchor 的站没有。
         * 用户一动（滚轮 / 触摸 / 按键）立即停手。
         */
        followMs: 3000,

        doneProgress: 0.95,      // 读到这里算读完，删掉记录（下次从头开始）
        ttlDays: 30,             // 记录最后一次访问后保留几天
        maxEntries: 300,         // 总条数上限，超了先删最久没访问的
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
        keys() { return GM_listValues().filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length)); },
    };

    /**
     * 启动时扫一遍全部记录：过期的删掉，超出条数上限的从最久没访问的删起（LRU）。
     * t 在记录和每次回访时更新，所以「最近用过」的不会被挤掉。
     * 几百条记录的读取都在 Tampermonkey 的内存缓存里，开销可以忽略。
     */
    function sweep() {
        const now = Date.now();
        const ttl = CONFIG.ttlDays * 86400e3;
        const alive = [];
        for (const key of Store.keys()) {
            const rec = Store.get(key);
            if (!rec || typeof rec.t !== 'number' || now - rec.t > ttl) Store.remove(key);
            // 正在打开的这页马上就要「用」了，按现在算 —— 否则它恰好最旧时会在恢复前被挤掉
            else alive.push([key, key === currentKey ? now : rec.t]);
        }
        if (alive.length <= CONFIG.maxEntries) return;
        alive.sort((a, b) => a[1] - b[1]);
        for (const [key] of alive.slice(0, alive.length - CONFIG.maxEntries)) Store.remove(key);
    }

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
        // hash 路由（#/post/1、#!/post/1）是「哪一页」；普通的 #第三节 只是页内跳转，不算
        const hash = /^#!?\//.test(url.hash) ? url.hash : '';
        return url.origin + url.pathname + query + hash;
    }

    // =========================================================================
    // 滚动容器
    //
    // 统一成同一套接口：top / setTop / view / height / max / rect（可视区在屏幕上的矩形）/ root。
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

    /** 能当「主滚动容器」的元素：够大（代码块、侧栏小菜单不算）、确实能滚。 */
    function isMainScroller(el) {
        if (!el || el.nodeType !== 1 || el === document.documentElement) return false;
        /*
         * body 只有在 html 的 overflow 不是 visible 时才是自己的滚动容器；
         * 否则 body 的 overflow 会「传播」给视口，滚的其实是 window。
         * html { overflow: hidden } body { height: 100%; overflow: auto } 这种写法下 window.scrollY 永远是 0，
         * 只认 window 就一条都记不下来。
         */
        if (el === document.body && getComputedStyle(document.documentElement).overflowY === 'visible') return false;
        if (el.clientHeight < window.innerHeight * 0.4 || el.clientWidth < window.innerWidth * 0.3) return false;
        if (el.scrollHeight <= el.clientHeight + 1) return false;
        return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
    }

    function windowRange() {
        const doc = document.scrollingElement || document.documentElement;
        const hidden = (n) => !!n && getComputedStyle(n).overflowY === 'hidden';
        // 后台 / 文档站常见写法：html, body { height: 100%; overflow: hidden }，正文在内层 div 里滚
        if (hidden(document.documentElement) || hidden(document.body)) return 0;
        return Math.max(0, doc.scrollHeight - doc.clientHeight);
    }

    /**
     * 找主滚动容器：从视口中间几个点往上找第一个能滚的大元素，和 window 比谁的可滚距离长。
     * 只是开局的猜测；之后用户真正滚了哪个容器，onScroll 会改过来。
     */
    function findScroller() {
        let best = null;
        let bestRange = windowRange();
        const seen = new Set();
        for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.3], [0.5, 0.7], [0.3, 0.5], [0.7, 0.5]]) {
            for (let n = document.elementFromPoint(window.innerWidth * fx, window.innerHeight * fy); n && n !== document.documentElement; n = n.parentElement) {
                if (seen.has(n)) break;
                seen.add(n);
                if (n.closest(UI_TAG)) break;
                if (isMainScroller(n)) {
                    const range = n.scrollHeight - n.clientHeight;
                    if (range > bestRange) {
                        best = n;
                        bestRange = range;
                    }
                    break;
                }
            }
        }
        return makeScroller(best);
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
        const max = sc.max();
        // 读到底了：这篇读完了，记录删掉（不存锚点，省一次探测）
        if (max > 0 && top / max > CONFIG.doneProgress) return { done: true };
        if (top <= view * CONFIG.minScrolledScreens) return null;
        return {
            t: Date.now(),
            p: +(max > 0 ? top / max : 0).toFixed(4),
            y: Math.round(top),
            h: height,
            // 内层容器的路径；null = window
            c: sc.el ? (sc.el === document.body ? 'body' : pathOf(sc.el, document.body)) : null,
            a: captureAnchor(sc),
        };
    }

    /*
     * 滚动中每 150ms 拍一张快照（带当时的页面键）。SPA 换页时 DOM 可能已经换成新页，
     * 那一刻再算锚点就算到新页上了 —— 所以换页时写的是换页前拍好的这张。
     */
    let pending = null;
    let snapTimer = 0;

    function write(p) {
        if (!p || !p.rec) return;
        if (p.rec.done) {
            if (Store.get(p.key)) console.log(TAG, '读到底了，删除记录', p.key);
            Store.remove(p.key);
        } else {
            Store.set(p.key, p.rec);
        }
    }

    function record() {
        clearTimeout(timer);
        timer = 0;
        write({ key: currentKey, rec: snapshot() });
        pending = null;
    }

    /** 这次 scroll 是不是主滚动容器上的；顺带把「主容器」改成用户真正在滚的那个。 */
    function adoptScroller(target) {
        // SPA 换页把整个容器换掉了
        if (scroller.el && !scroller.el.isConnected) scroller = findScroller();
        if (target === document || target === document.documentElement || (target === document.body && !isMainScroller(target))) {
            if (scroller.el && windowRange() > scroller.max()) scroller = makeScroller(null);
            return !scroller.el;
        }
        if (target === scroller.el) return true;
        // 代码块、侧栏、下拉框里的滚动不算读到哪了
        if (!isMainScroller(target)) return false;
        if (scroller.el || target.scrollHeight - target.clientHeight > windowRange()) {
            scroller = makeScroller(target);
            return true;
        }
        return false;
    }

    function onScroll(e) {
        if (!active) return;
        const main = adoptScroller(e.target);
        // 进度在任何阶段都跟着滚动走
        if (main) scheduleFab();
        // 等待恢复期间的滚动是浏览器自己的恢复、页面加载撑开的，不是在读：不记，免得覆盖掉要恢复的那条
        if (phase === 'waiting') return;
        // history 挂钩失效时（页面在隔离环境里改不动）的兜底：滚动时顺手比一下 URL
        if (location.href !== lastHref) onRoute(false);
        if (!main) return;
        if (!snapTimer) {
            snapTimer = setTimeout(() => {
                snapTimer = 0;
                pending = { key: currentKey, rec: snapshot() };
            }, 150);
        }
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

    /**
     * 页面高度连续 stableMs 不变（或等满 maxWaitMs）后回调 done(scroller)。
     * 滚动容器每次重新取：SPA 的正文容器可能还没渲染出来（取不到时算「还在变」），
     * 等到了也可能是空的、要等接口回来才撑开。
     */
    let waitTimer = 0;

    function waitStable(getScroller, done) {
        clearInterval(waitTimer);
        const start = Date.now();
        let last = NaN;
        let changedAt = start;
        const iv = waitTimer = setInterval(() => {
            const now = Date.now();
            const sc = getScroller();
            const h = sc ? sc.height() : NaN;
            if (h !== last) {
                last = h;
                changedAt = now;
            }
            const stable = sc && now - changedAt >= CONFIG.stableMs;
            if (stable || now - start >= CONFIG.maxWaitMs) {
                clearInterval(iv);
                done(sc);
            }
        }, 100);
    }

    /** 记录里存的滚动容器；路径失效（容器外面多套了一层）就重新找。还没渲染出来返回 null。 */
    function scrollerFor(rec) {
        if (!rec.c) return makeScroller(null);
        const el = queryPath(rec.c, document.body);
        if (el && isMainScroller(el)) return makeScroller(el);
        const found = findScroller();
        return found.el ? found : null;
    }

    let followTimer = 0;

    function jumpTo(rec, why) {
        const { top, via } = locate(rec, scroller);
        scroller.setTop(top);
        console.log(TAG, why, { via, top, percent: Math.round(rec.p * 100) });
        follow(rec);
    }

    function follow(rec) {
        clearInterval(followTimer);
        userMoved = false;
        const start = Date.now();
        followTimer = setInterval(() => {
            if (userMoved || !active || Date.now() - start > CONFIG.followMs) return clearInterval(followTimer);
            const { top } = locate(rec, scroller);
            if (Math.abs(top - scroller.top()) > 2) scroller.setTop(top);
        }, 150);
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
    /**
     * #后面指向的元素。先按原样找，再按解码后的找（中文锚点 #%E7%AC%AC...）。
     * 解码要兜住：#100% 这种解不开的百分号会让 decodeURIComponent 抛 URIError，整个恢复跟着挂掉。
     */
    function hashTarget() {
        const raw = location.hash.slice(1);
        if (!raw) return null;
        let decoded = raw;
        try {
            decoded = decodeURIComponent(raw);
        } catch (e) { /* 用原样 */ }
        for (const id of new Set([raw, decoded])) {
            const el = document.getElementById(id) || document.getElementsByName(id)[0];
            if (el) return el;
        }
        return null;
    }

    function skipReason() {
        const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        const type = nav ? nav.type : 'navigate';
        if (type === 'back_forward') return '前进/后退，交给浏览器';
        if (hashTarget()) return '带 #锚点 打开';
        if (type === 'navigate' && scroller.top() > 0) return '用户已经滚动';
        return '';
    }

    /** spa = true：SPA 换页（pushState），页面加载时的导航类型和 scrollTop 都不说明问题。 */
    function restore(key, spa) {
        const rec = Store.get(key);
        if (!rec) return;
        // 回访也算「用过」：LRU 按这个时间挤，30 天过期也从这里重新算
        Store.set(key, { ...rec, t: Date.now() });
        const skip = spa ? '' : skipReason();
        if (skip) return console.log(TAG, '不恢复：' + skip);
        phase = 'waiting';
        userMoved = false;
        waitStable(() => scrollerFor(rec), (sc) => {
            phase = 'idle';
            if (key !== currentKey) return;
            if (!sc) return console.log(TAG, '不恢复：找不到记录时的滚动容器', rec.c);
            scroller = sc;
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

        .fab {
            position: fixed; right: 20px; bottom: 28px;
            display: flex; flex-direction: column; align-items: center;
            border-radius: 20px; overflow: hidden;
            background: rgba(32, 33, 36, .78); color: #fff;
            font: 12px/1 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
            box-shadow: 0 2px 10px rgba(0, 0, 0, .2);
            opacity: 0; pointer-events: none; transform: translateY(8px);
            transition: opacity .2s, transform .2s;
        }
        .fab.show { opacity: 1; pointer-events: auto; transform: none; }
        .fab button { width: 40px; height: 34px; padding: 0; border-radius: 0; text-align: center; font-size: 16px; }
        .fab .pct { padding: 2px 0 4px; font-variant-numeric: tabular-nums; opacity: .85; }
        @media (prefers-reduced-motion: reduce) { .fab { transition: none; } }
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
                </div>
                <div class="fab" aria-hidden="true">
                    <button class="top" type="button" title="回到顶部" aria-label="回到顶部">↑</button>
                    <span class="pct"></span>
                    <button class="bottom" type="button" title="到底部" aria-label="到底部">↓</button>
                </div>`;
            // 按钮滚的是「当前」主容器：SPA 换页、换了容器之后也对
            root.querySelector('.fab .top').onclick = () => smoothTo(0);
            root.querySelector('.fab .bottom').onclick = () => smoothTo(scroller.max());
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
        destroy() {
            clearTimeout(this.promptTimer);
            if (this.host) this.host.remove();
            this.host = null;
            this.root = null;
        },
        /** 回到顶部 / 底部按钮：滚过半屏才出现，中间显示阅读进度。 */
        updateFab() {
            const max = scroller.max();
            const top = scroller.top();
            const show = max > scroller.view() * 0.5 && top > scroller.view() * 0.5;
            if (!show && !this.root) return; // 还没出现过就别为它建 DOM
            const fab = this.ensure().querySelector('.fab');
            fab.classList.toggle('show', show);
            fab.setAttribute('aria-hidden', String(!show));
            fab.querySelector('.pct').textContent = Math.round(max > 0 ? (top / max) * 100 : 0) + '%';
        },
    };

    function smoothTo(y) {
        const el = scroller.el || window;
        el.scrollTo({ top: y, behavior: 'smooth' });
    }

    let fabFrame = 0;
    function scheduleFab() {
        if (fabFrame) return;
        fabFrame = requestAnimationFrame(() => {
            fabFrame = 0;
            UI.updateFab();
        });
    }

    // =========================================================================
    // SPA：URL 变了就先存旧页、再恢复新页
    // =========================================================================

    const ROUTE_EVENT = 'scroll-memory:route';
    let lastHref = location.href;

    /**
     * fromHistory = true：popstate（前进 / 后退）。和整页的前进后退一样交给浏览器 / 路由自己还原，
     * 很多路由（React Router 的 ScrollRestoration、Vue Router 的 savedPosition）本来就会做。
     */
    function onRoute(fromHistory) {
        if (location.href === lastHref) return;
        lastHref = location.href;
        const key = pageKey();
        if (key === currentKey) return; // 只是跟踪参数 / 页内锚点变了
        // 旧页还没落盘的那次滚动：写换页前拍好的快照，不在新 DOM 上重算
        if (pending && pending.key === currentKey && timer) write(pending);
        reset();
        currentKey = key;
        if (!active) return;
        if (fromHistory) return console.log(TAG, '不恢复：SPA 前进/后退，交给浏览器 / 路由', key);
        restore(key, true);
    }

    /**
     * 包一层 pushState / replaceState，调用后发一个 DOM 事件。
     * 改的是页面的 history（unsafeWindow）：沙箱里的 window.history 和页面的不一定是同一个对象，
     * 改了沙箱那份，页面路由调的照样是原版。事件走 DOM，不管脚本跑在哪个 world 都收得到。
     */
    function hookHistory() {
        try {
            const hist = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).history;
            for (const name of ['pushState', 'replaceState']) {
                const orig = hist[name];
                if (typeof orig !== 'function' || orig.__scrollMemory) continue;
                const wrapped = function (...args) {
                    const ret = orig.apply(this, args);
                    window.dispatchEvent(new Event(ROUTE_EVENT));
                    return ret;
                };
                wrapped.__scrollMemory = true;
                hist[name] = wrapped;
            }
        } catch (e) {
            console.warn(TAG, 'history 挂钩失败，只靠滚动时比 URL 兜底', e);
        }
        /*
         * popstate 不只在前进后退时触发：点 <a href="#/b"> 这种页内跳转也会触发。
         * 有 Navigation API（Chromium）就看 navigationType 是不是 traverse；
         * 没有就退回猜：popstate 当前进后退，只有 hashchange 的当新打开。
         */
        let navType = '';
        try {
            const nav = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).navigation;
            if (nav) nav.addEventListener('navigate', (e) => { navType = e.navigationType; });
        } catch (e) { /* 没有就算了 */ }
        window.addEventListener(ROUTE_EVENT, () => onRoute(false));
        window.addEventListener('popstate', () => onRoute(navType ? navType === 'traverse' : true));
        window.addEventListener('hashchange', () => onRoute(navType ? navType === 'traverse' : false));
    }

    /** 丢掉进行中的记录 / 恢复（换页、停用时）。 */
    function reset() {
        clearTimeout(timer);
        timer = 0;
        clearTimeout(snapTimer);
        snapTimer = 0;
        pending = null;
        clearInterval(waitTimer);
        clearInterval(followTimer);
        phase = 'idle';
        UI.hidePrompt();
    }

    // =========================================================================
    // 菜单
    // =========================================================================

    /** 本站开着时为 true。停用后监听器还挂着，但什么都不做。 */
    let active = false;

    function clearPage() {
        reset();
        Store.remove(currentKey);
        console.log(TAG, '已清除本页记忆', currentKey);
    }

    function toggleSite() {
        const origin = location.origin;
        settings = Store.settings();
        if (settings.disabled[origin]) {
            delete settings.disabled[origin];
            Store.saveSettings(settings);
            active = true;
            scroller = findScroller();
            scheduleFab();
            console.log(TAG, '已在本站启用');
        } else {
            settings.disabled[origin] = 1;
            Store.saveSettings(settings);
            active = false;
            reset();
            UI.destroy();
            // 停用 = 不想让这个站留下阅读痕迹：本站已存的一并删掉
            for (const key of Store.keys()) if (key.startsWith(origin + '/')) Store.remove(key);
            console.log(TAG, '已在本站停用，并删除本站的记录');
        }
        Menu.refresh();
    }

    function toggleMode() {
        settings = Store.settings();
        settings.mode = settings.mode === 'jump' ? 'prompt' : 'jump';
        Store.saveSettings(settings);
        Menu.refresh();
    }

    function clearAll() {
        if (!window.confirm('删除所有网站上记住的阅读位置？')) return;
        reset();
        for (const key of Store.keys()) Store.remove(key);
        console.log(TAG, '已清除全部记忆');
    }

    /** 菜单项文字带状态（开关、恢复方式），状态变了整组重新注册。 */
    const Menu = {
        ids: [],
        refresh() {
            const items = [];
            if (active) items.push(['清除本页记忆', clearPage]);
            items.push([active ? '在本站停用' : '在本站启用', toggleSite]);
            items.push(['恢复方式：' + (settings.mode === 'jump' ? '直接跳回（点击切换为先提示）' : '先提示（点击切换为直接跳回）'), toggleMode]);
            items.push(['清除全部记忆', clearAll]);
            for (const id of this.ids) GM_unregisterMenuCommand(id);
            this.ids = items.map(([caption, fn]) => GM_registerMenuCommand(caption, fn));
        },
    };

    function boot() {
        sweep();
        active = !settings.disabled[location.origin];
        Menu.refresh();
        // 捕获阶段：内层容器的 scroll 不冒泡，但捕获能收到
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
        for (const type of ['wheel', 'touchmove', 'keydown', 'mousedown']) window.addEventListener(type, onIntent, { capture: true, passive: true });
        hookHistory();
        if (!active) return console.log(TAG, '本站已停用');
        scroller = findScroller();
        console.log(TAG, '已启动', currentKey);
        restore(currentKey);
    }

    try {
        boot();
    } catch (e) {
        console.error(TAG, '启动失败', e);
    }
})();
