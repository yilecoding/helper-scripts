// ==UserScript==
// @name         自动翻页
// @name:zh-CN   自动翻页
// @name:en      Auto Pager — Load the Next Page When You Scroll to the Bottom
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.09.01.2
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

    // =========================================================================
    // 找「下一页」
    // =========================================================================

    /**
     * 输入一个文档（当前页，或 fetch 回来解析出的下一页）和它的 URL，返回 { url, how } 或 null。
     * 顺序：rel=next → 文字 / aria-label / title → （后面再加：分页条页码推断）。
     * 每一步都要过同一套判据：同源 http(s)、不是指回本页、不是「下一篇」那种文章导航。
     */
    const Finder = (() => {
        /** 去掉两侧装饰后整段等于这些词才算（「下一页 >」「Next »」）；「下一页的内容」不算。 */
        const NEXT_WORD = /^(?:下一?页|下一?頁|后一?页|後一?頁|next(?:\s+page)?|older(?:\s+(?:posts?|entries|articles))?)$/i;
        const DECOR = /^[\s«‹<←\[【(（]+|[\s»›>→\]】)）]+$/g;
        /**
         * 只有箭头的链接。Bootstrap 的「« ‹ 1 2 3 › »」里 › 是下一页、» 是尾页，
         * 而 WordPress 等的「上一页 «」「» 下一页」里 » 又是下一页 —— 所以 › 分数高于 »，同时出现时取 ›。
         */
        const ARROW_SCORE = { '›': 2, '>': 2, '»': 1, '>>': 1, '→': 1 };
        /**
         * 「下一篇 / 下一章」是文章之间的导航，自动拼接会把两篇不相干的文章接在一起。
         * WordPress 的 next_post_link 还带着 rel="next"，所以 rel=next 也要过这一关。
         */
        const EXCLUDE = /下一?(?:篇|章|节|節|条|條|个|個|集|话|話|张|張|帖|主题|主題)|上一|前一|prev|previous|newer|next\s+(?:post|article|story|entry|chapter|episode|thread|topic|video)/i;
        /** 文章导航的容器（WordPress 的 post-navigation、各主题的 nav-single / prev-next），里面的链接全不算。 */
        const ARTICLE_NAV = /post-navigation|(?:post|entry|single|article)[_-]nav|nav[_-]single|prev[_-]next/i;

        function textOf(el) {
            return (el.textContent || '').replace(/\s+/g, ' ').trim();
        }

        /** 一段文字像不像「下一页」：0 不像，3 是文字，2/1 是箭头。 */
        function wordScore(text) {
            if (!text) return 0;
            const core = text.replace(DECOR, '').trim();
            if (core) return NEXT_WORD.test(core) ? 3 : 0;
            return ARROW_SCORE[text.replace(/\s+/g, '')] || 0;
        }

        function classAndId(el) {
            return (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
        }

        function excluded(el) {
            const labels = [textOf(el), el.getAttribute('aria-label') || '', el.getAttribute('title') || ''];
            if (labels.some((s) => EXCLUDE.test(s))) return true;
            // 分页条里「不可点」的下一页（最后一页上常见）：自己或父级 disabled
            for (let n = el, i = 0; n && n.nodeType === 1 && i < 6; n = n.parentElement, i++) {
                const ci = classAndId(n);
                if (ARTICLE_NAV.test(ci)) return true;
                if (i < 2 && (/(?:^|\s)disabled(?:\s|$)/.test(ci) || n.getAttribute('aria-disabled') === 'true')) return true;
            }
            return false;
        }

        /** href → 可加载的绝对 URL（去掉 hash）；不同源、非 http(s)、指回本页的返回 null。 */
        function resolve(el, doc, pageUrl) {
            const raw = el.getAttribute('href');
            if (!raw) return null;
            let u;
            try {
                u = new URL(raw, doc.baseURI || pageUrl);
            } catch (e) {
                return null;
            }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
            if (u.origin !== location.origin) return null;
            u.hash = '';
            const self = new URL(pageUrl);
            self.hash = '';
            if (u.href === self.href) return null;
            return u.href;
        }

        function byRel(doc, pageUrl) {
            for (const el of doc.querySelectorAll('link[rel~="next" i][href], a[rel~="next" i][href]')) {
                if (el.tagName === 'A' && excluded(el)) continue;
                const url = resolve(el, doc, pageUrl);
                if (url) return { url, how: 'rel=next' };
            }
            return null;
        }

        function byText(doc, pageUrl) {
            let best = null;
            for (const a of doc.querySelectorAll('a[href]')) {
                const score = Math.max(
                    wordScore(textOf(a)),
                    wordScore(a.getAttribute('aria-label') || ''),
                    wordScore(a.getAttribute('title') || ''),
                );
                if (!score || (best && score <= best.score)) continue;
                if (excluded(a)) continue;
                const url = resolve(a, doc, pageUrl);
                if (url) best = { url, how: '文字匹配', score };
            }
            return best && { url: best.url, how: best.how };
        }

        function find(doc, pageUrl) {
            return byRel(doc, pageUrl) || byText(doc, pageUrl);
        }

        return { find };
    })();

    function boot() {
        if (!document.body) return;
        if (Store.site().disabled) {
            console.info(TAG, '本站已停用');
            return;
        }
        console.info(TAG, '启动');
        const next = Finder.find(document, location.href);
        if (!next) {
            console.info(TAG, '没有找到下一页');
            return;
        }
        console.info(TAG, `下一页（${next.how}）：${next.url}`);
    }

    boot();
})();
