// ==UserScript==
// @name         阅读位置记忆|长文/小说/文档关掉回来自动回到上次读到的地方
// @name:zh-CN   阅读位置记忆|长文/小说/文档关掉回来自动回到上次读到的地方
// @name:en      Scroll Memory — come back to where you stopped reading
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.11.18.1
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
    // 滚动状态
    // =========================================================================

    function metrics() {
        const el = document.scrollingElement || document.documentElement;
        const top = el.scrollTop;
        const view = el.clientHeight;
        const height = el.scrollHeight;
        const max = Math.max(0, height - view);
        return { top, view, height, max, progress: max > 0 ? top / max : 0 };
    }

    // =========================================================================
    // 记录
    // =========================================================================

    let currentKey = pageKey();
    let timer = 0;

    function snapshot() {
        const m = metrics();
        if (m.height <= m.view * CONFIG.minScreens) return null;
        if (m.top <= m.view * CONFIG.minScrolledScreens) return null;
        return { t: Date.now(), p: +m.progress.toFixed(4), y: Math.round(m.top), h: m.height };
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
