// ==UserScript==
// @name         自动翻页
// @name:zh-CN   自动翻页
// @name:en      Auto Pager — Load the Next Page When You Scroll to the Bottom
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.09.09.10
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
        minItems: 3,            // 内容容器里同类子元素至少这么多个
        minItemText: 8,         // 同类子元素平均字数低于这个的是菜单 / 分页条，不是内容
        itemTextCap: 300,       // 单个子元素最多计这么多字，免得一个超长元素压过一整列
        imageWeight: 40,        // 一张图折合多少字（图片列表没什么文字）
        maxPages: 30,           // 最多拼到第几页（含当前页），防止无尽列表把内存吃光
    };

    const SEP_CLASS = 'auto-pager-sep';
    const STATUS_CLASS = 'auto-pager-status';

    /** 懒加载库把真实地址放在这些属性里（Discuz 用 file / zoomfile，知乎用 data-actualsrc）。 */
    const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-actualsrc', 'data-echo', 'data-url', 'file', 'zoomfile'];

    // =========================================================================
    // 站点规则
    // =========================================================================

    /**
     * 通用识别搞不定或者不放心的站点，在这里写死选择器。字段都可选，没写的那一项照常走通用识别：
     *   name     日志里显示的名字
     *   host     匹配 location.hostname 的正则
     *   url      匹配 location.href 的正则
     *   when     页面上存在这个选择器才算命中（Discuz 这类开源程序部署在无数个域名上，只能按结构认）
     *   next     「下一页」链接的选择器（取第一个能用的）
     *   content  内容容器的选择器（当前页和下一页都按它找）
     *   pager    要跟着换成下一页的分页条（可以命中多个：顶部 + 底部）
     * 第一条全部条件都满足的规则生效。
     */
    const SITE_RULES = [
        {
            name: 'Discuz! 帖子列表',
            when: '#threadlisttableid',
            next: '.pg a.nxt',
            content: '#threadlisttableid',
            pager: '.pg',
        },
        {
            name: 'Discuz! 帖子内容',
            when: '#postlist > div[id^="post_"]',
            next: '.pg a.nxt',
            content: '#postlist',
            pager: '.pg',
        },
        {
            name: 'Bing 搜索',
            host: /(?:^|\.)bing\.com$/,
            url: /\/search\?/,
            next: 'a.sb_pagN',
            content: '#b_results',
            pager: '#b_results > li.b_pag',
        },
        {
            name: '百度搜索',
            host: /(?:^|\.)baidu\.com$/,
            url: /\/s\?/,
            content: '#content_left',
            pager: '#page',
        },
    ];

    function matchRule() {
        return SITE_RULES.find((r) =>
            (!r.host || r.host.test(location.hostname))
            && (!r.url || r.url.test(location.href))
            && (!r.when || document.querySelector(r.when))) || null;
    }

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
     * 顺序：rel=next → 文字 / aria-label / title → 分页条里当前页码的后一个。
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

        const CURRENT_CLASS = /(?:^|\s)(?:current|active|cur|on|selected|thispage|now)(?:\s|$)/i;
        const NUM = /^\d{1,5}$/;

        /** 是不是「当前页码」：不是链接，或者自己 / 上两级带 aria-current、current/active 之类的类名。 */
        function isCurrentMark(el) {
            if (!el.closest('a[href]')) return true;
            for (let n = el, i = 0; n && i < 3; n = n.parentElement, i++) {
                if (n.getAttribute('aria-current') === 'page' || CURRENT_CLASS.test(classAndId(n))) return true;
            }
            return false;
        }

        /**
         * 分页条只有页码没有「下一页」字样时：找到当前页码 N，在同一个分页条里找文字为 N+1 的链接。
         * 「分页条」= 往上 4 级内第一个含 ≥2 个纯数字链接的祖先 —— 列表里的回复数、楼层号
         * 也是不带链接的数字，靠这一条和真正的当前页码区分开。
         */
        function byNumber(doc, pageUrl) {
            for (const el of doc.body.querySelectorAll('*')) {
                if (el.children.length || !NUM.test(textOf(el)) || !isCurrentMark(el)) continue;
                let pager = null;
                for (let n = el.parentElement, i = 0; n && n !== doc.body && i < 4; n = n.parentElement, i++) {
                    const nums = Array.from(n.querySelectorAll('a[href]')).filter((a) => NUM.test(textOf(a).replace(/^\.+\s*/, '')));
                    if (nums.length >= 2) {
                        pager = nums;
                        break;
                    }
                }
                if (!pager) continue;
                const want = String(Number(textOf(el)) + 1);
                const a = pager.find((x) => textOf(x).replace(/^\.+\s*/, '') === want && !excluded(x));
                const url = a && resolve(a, doc, pageUrl);
                if (url) return { url, how: '页码推断' };
            }
            return null;
        }

        function byRule(doc, pageUrl, rule) {
            if (!rule || !rule.next) return null;
            for (const el of doc.querySelectorAll(rule.next)) {
                const url = resolve(el, doc, pageUrl);
                if (url) return { url, how: '站点规则：' + rule.name };
            }
            return null;
        }

        function find(doc, pageUrl, rule) {
            return byRule(doc, pageUrl, rule) || byRel(doc, pageUrl) || byText(doc, pageUrl) || byNumber(doc, pageUrl);
        }

        return { find };
    })();

    // =========================================================================
    // 找「内容容器」
    // =========================================================================

    /**
     * 内容容器 = 子元素里有一大组「同类」元素（同 tag + 同类名）、文字量最多的那个元素，
     * 而且在下一页的同一位置也能找到它。只看当前页会被「当前页独有」的结构骗
     * （置顶公告、本页才有的推荐位），所以要等下一页拿回来两边对照。
     */
    const Content = (() => {
        /** 这些区域里的列表是菜单、侧栏、页脚链接，不是内容。 */
        const SKIP = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]';

        /** 类名里带数字的去掉：WordPress 的 post-123、Discuz 的 normalthread_456 每项都不同。 */
        function cleanClasses(el) {
            return Array.from(el.classList).filter((c) => !/\d/.test(c) && c !== SEP_CLASS).sort();
        }

        function signature(el) {
            return [el.tagName.toLowerCase()].concat(cleanClasses(el)).join('.');
        }

        /** 子元素里数量最多的同类组：{ sig, items }。 */
        function dominantGroup(el) {
            const groups = new Map();
            for (const c of el.children) {
                if (c.tagName === 'SCRIPT' || c.tagName === 'STYLE' || c.classList.contains(SEP_CLASS)) continue;
                const sig = signature(c);
                if (!groups.has(sig)) groups.set(sig, []);
                groups.get(sig).push(c);
            }
            let best = null;
            for (const [sig, items] of groups) if (!best || items.length > best.items.length) best = { sig, items };
            return best;
        }

        function weight(el) {
            const text = (el.textContent || '').replace(/\s+/g, '').length;
            return Math.min(text + el.querySelectorAll('img').length * CONFIG.imageWeight, CONFIG.itemTextCap);
        }

        /** 定位路径：最近的稳定 id 起，往下逐级 tag + 类名；同一选择器命中多个时记下标。 */
        function pathOf(el, doc) {
            const parts = [];
            let n = el;
            for (; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
                // 长串数字的 id 多半是每页不同的自增 id，不能拿来跨页定位
                if (n.id && !/\d{3,}/.test(n.id)) {
                    parts.unshift('#' + CSS.escape(n.id));
                    break;
                }
                parts.unshift([n.tagName.toLowerCase()].concat(cleanClasses(n).map((c) => CSS.escape(c))).join('.'));
            }
            if (!n || n === doc.body) parts.unshift('body');
            const selector = parts.join(' > ');
            return { selector, index: Array.from(doc.querySelectorAll(selector)).indexOf(el) };
        }

        function locate(doc, path) {
            return doc.querySelectorAll(path.selector)[path.index] || null;
        }

        function candidates(doc) {
            const list = [];
            for (const el of doc.body.querySelectorAll('*')) {
                if (el.children.length < CONFIG.minItems || el.closest(SKIP)) continue;
                const g = dominantGroup(el);
                if (!g || g.items.length < CONFIG.minItems) continue;
                const score = g.items.reduce((sum, c) => sum + weight(c), 0);
                if (score / g.items.length < CONFIG.minItemText) continue;
                // 当前页上不可见的（折叠的 tab、隐藏的模板）不算
                if (doc === document && !el.getClientRects().length) continue;
                list.push({ el, sig: g.sig, items: g.items, score });
            }
            return list.sort((a, b) => b.score - a.score);
        }

        /** 在当前页和下一页里都认得出的内容容器：{ el, path, sig } 或 null。 */
        /** 规则写死了容器：只要两边都找得到就用它，不再打分。 */
        function byRule(nextDoc, rule) {
            const el = document.querySelector(rule.content);
            if (!el || !nextDoc.querySelector(rule.content)) return null;
            const g = dominantGroup(el);
            if (!g) return null;
            return { el, path: { selector: rule.content, index: 0 }, sig: g.sig, last: g.items[g.items.length - 1] };
        }

        function detect(nextDoc, rule) {
            if (rule && rule.content) {
                const hit = byRule(nextDoc, rule);
                if (hit) return hit;
                console.warn(TAG, `规则「${rule.name}」的内容选择器 ${rule.content} 没命中，改用通用识别`);
            }
            // 按日期分组的列表（每组一个标题 + 一串帖子）会选中外层：整组搬过来正好也是对的
            for (const c of candidates(document)) {
                const path = pathOf(c.el, document);
                const there = locate(nextDoc, path);
                if (!there || !Array.from(there.children).some((x) => signature(x) === c.sig)) continue;
                return { el: c.el, path, sig: c.sig, last: c.items[c.items.length - 1] };
            }
            return null;
        }

        /** 下一页容器里要搬过来的子元素：第一个到最后一个同类元素之间的全部（表头、页内分页条不要）。 */
        function itemsIn(doc, info) {
            const box = locate(doc, info.path);
            if (!box) return null;
            const kids = Array.from(box.children);
            const first = kids.findIndex((x) => signature(x) === info.sig);
            if (first < 0) return [];
            let last = first;
            kids.forEach((x, i) => { if (signature(x) === info.sig) last = i; });
            return kids.slice(first, last + 1).filter((x) => x.tagName !== 'SCRIPT' && x.tagName !== 'STYLE');
        }

        return { detect, itemsIn, pathOf };
    })();

    // =========================================================================
    // 导入前的修正
    // =========================================================================

    /**
     * 节点从下一页搬到当前页，相对地址会改按当前页解析：/blog/page/2/ 里的 ../../a.html
     * 搬到 /blog/ 下就指到站外的 /a.html 去了。所以导入前按下一页的 <base> 全部转成绝对地址。
     * 纯 #锚点 不动：内容已经在本页了，锚点指向它才对。
     */
    const Fixer = (() => {
        const URL_ATTRS = ['href', 'src', 'action', 'poster', 'data'];
        const SKIP_SCHEME = /^\s*(?:#|javascript:|mailto:|tel:|data:|blob:|about:)/i;

        function abs(raw, base) {
            if (!raw || SKIP_SCHEME.test(raw)) return raw;
            try {
                return new URL(raw.trim(), base).href;
            } catch (e) {
                return raw;
            }
        }

        function absSrcset(raw, base) {
            if (!raw || /data:/i.test(raw)) return raw;
            return raw.split(',').map((part) => {
                const [u, ...desc] = part.trim().split(/\s+/);
                return [abs(u, base)].concat(desc).join(' ');
            }).join(', ');
        }

        /**
         * 懒加载图片：页面上的懒加载脚本只盯着首屏时就在的 <img>，后拼进来的永远停在占位图。
         * 有真实地址就直接写进 src。
         */
        function unlazy(img, base) {
            const attr = LAZY_ATTRS.find((a) => img.getAttribute(a));
            if (attr) {
                const real = abs(img.getAttribute(attr), base);
                if (img.getAttribute('src') !== real) img.setAttribute('src', real);
            }
            const set = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
            if (set) img.setAttribute('srcset', absSrcset(set, base));
        }

        function fix(root, base) {
            const els = [root].concat(Array.from(root.querySelectorAll('*')));
            for (const el of els) {
                for (const a of URL_ATTRS) if (el.hasAttribute(a)) el.setAttribute(a, abs(el.getAttribute(a), base));
                if (el.hasAttribute('srcset')) el.setAttribute('srcset', absSrcset(el.getAttribute('srcset'), base));
                if (el.tagName === 'IMG') unlazy(el, base);
                // DOMParser 出来的 <script> 不会执行，搬过来也只是死节点
                if (el.tagName === 'SCRIPT') el.remove();
            }
            return root;
        }

        return { fix };
    })();

    // =========================================================================
    // 加载与拼接
    // =========================================================================

    const Loader = (() => {
        const state = {
            next: null,         // 下一页 URL
            pageNo: 1,          // 已经拼到第几页
            busy: false,
            done: false,
            failed: null,       // 上一次请求的错误：有它就不再自动加载，等用户点重试
            content: null,      // { el, path, sig, last }：last 是最后插入的节点，下一页接在它后面
            pager: null,        // 分页条的定位路径：拼接后换成下一页的，页码跟着走
            loaded: new Set([stripHash(location.href)]),    // 已经在页面上的 URL（含最终跳转到的）
            rule: null,         // 命中的站点规则
        };

        function stripHash(url) {
            return url.split('#')[0];
        }

        /**
         * res.text() 一律按 UTF-8 解，GBK 的老论坛拿回来全是乱码 —— 连「下一页」三个字都认不出，
         * 翻到第 2 页就断了。编码按浏览器的顺序取：Content-Type 头 → 前 1KB 里的 <meta>
         * （charset= 和 http-equiv 两种写法）→ 当前页自己的编码（同站多半一致）。
         */
        function decode(buf, contentType) {
            let charset = (/charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '') || [])[1];
            if (!charset) {
                const head = new TextDecoder('windows-1252').decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024)));
                charset = (/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head) || [])[1];
            }
            try {
                return new TextDecoder(charset || document.characterSet || 'utf-8').decode(buf);
            } catch (e) {
                // 写错的编码名（如 charset=utf8mb4）TextDecoder 会抛 RangeError
                return new TextDecoder('utf-8').decode(buf);
            }
        }

        async function fetchDoc(url) {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const html = decode(await res.arrayBuffer(), res.headers.get('content-type'));
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const finalUrl = res.url || url;
            // DOMParser 出来的文档 baseURI 是「当前页」，里面的相对链接会按当前页解析 ——
            // 第 2 页的 ?page=3 能碰巧对上，但 ../list/3 这种就错了。补一个 <base> 指向它自己的 URL。
            const base = doc.querySelector('base[href]');
            if (base) base.setAttribute('href', new URL(base.getAttribute('href'), finalUrl).href);
            else {
                const b = doc.createElement('base');
                b.setAttribute('href', finalUrl);
                (doc.head || doc.documentElement).prepend(b);
            }
            return { doc, url: finalUrl };
        }

        /** 分隔线的标签要和列表项匹配：<ul> 里只能放 <li>，<table> 里只能放 <tr> / <tbody>，否则浏览器会把它挤出去。 */
        function makeSeparator(itemTag, pageNo, url) {
            const link = document.createElement('a');
            link.href = url;
            link.textContent = `第 ${pageNo} 页`;
            let sep;
            let inner;
            if (itemTag === 'TR' || itemTag === 'TBODY') {
                const tr = document.createElement('tr');
                inner = tr.appendChild(document.createElement('td'));
                inner.colSpan = 99;
                sep = itemTag === 'TR' ? tr : document.createElement('tbody');
                if (sep !== tr) sep.appendChild(tr);
            } else {
                sep = document.createElement(itemTag === 'LI' ? 'li' : 'div');
                inner = sep;
            }
            sep.className = SEP_CLASS;
            sep.dataset.page = String(pageNo);
            inner.appendChild(link);
            return sep;
        }

        /**
         * 当前页的分页条：页面上（内容区之外）指向下一页的那个链接，往上 4 级内第一个含 ≥2 个链接、
         * 又不包住内容区的祖先。从链接出发而不是按类名找：rel=next 是 <link> 时也一样能用。
         */
        function locatePager(nextUrl) {
            const box = state.content.el;
            for (const a of document.querySelectorAll('a[href]')) {
                if (box.contains(a) || a.href.split('#')[0] !== nextUrl) continue;
                for (let n = a.parentElement, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
                    if (n.contains(box)) break;
                    if (n.querySelectorAll('a[href]').length >= 2) return Content.pathOf(n, document);
                }
            }
            return null;
        }

        /** 同一路径命中多个（顶部 + 底部分页条）就逐个换。下一页没有对应的就留着旧的。 */
        function replacePager(doc) {
            if (!state.pager) return;
            const mine = document.querySelectorAll(state.pager.selector);
            const theirs = doc.querySelectorAll(state.pager.selector);
            mine.forEach((el, i) => {
                if (theirs[i]) el.replaceWith(document.importNode(Fixer.fix(theirs[i], doc.baseURI), true));
            });
        }

        function append(doc, url) {
            const items = Content.itemsIn(doc, state.content);
            if (!items) throw new Error('下一页里找不到内容区域');
            const pageNo = state.pageNo + 1;
            const sep = makeSeparator(state.content.last.tagName, pageNo, url);
            const nodes = [sep].concat(items.map((x) => document.importNode(Fixer.fix(x, doc.baseURI), true)));
            state.content.last.after(...nodes);
            state.content.last = nodes[nodes.length - 1];
            state.pageNo = pageNo;
            replacePager(doc);
            console.info(TAG, `已拼接第 ${pageNo} 页：${items.length} 项`);
        }

        // ---- 状态条：加载中 / 失败可重试 / 结束原因，放在内容区下面，用户看得见 ----

        let statusEl = null;

        /**
         * 内容区还没认出来（第一次加载）时没地方放，先固定在视口底部；认出来以后挪到内容区后面。
         * 内容区是 <tbody> 时要放到整张表后面，<table> 里塞 <div> 会被浏览器挤出去。
         */
        function placeStatus() {
            if (!statusEl) {
                statusEl = document.createElement('div');
                statusEl.className = STATUS_CLASS;
            }
            const box = state.content && state.content.el;
            const anchor = box && (/^(?:TBODY|THEAD|TFOOT|TR)$/.test(box.tagName) ? box.closest('table') : box);
            statusEl.classList.toggle('floating', !anchor);
            if (anchor && anchor.nextSibling !== statusEl) anchor.after(statusEl);
            else if (!anchor && !statusEl.isConnected) document.body.appendChild(statusEl);
        }

        /** kind：loading | error | done | idle。error 带一个「重试」按钮。 */
        function showStatus(kind, text) {
            placeStatus();
            statusEl.dataset.state = kind;
            statusEl.textContent = text || '';
            statusEl.hidden = kind === 'idle';
            if (kind === 'error') {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = '重试';
                btn.addEventListener('click', retry);
                statusEl.append(' ', btn);
            }
        }

        function retry() {
            if (state.busy) return;
            state.failed = null;
            loadNext();
        }

        function finish(reason) {
            state.done = true;
            console.info(TAG, reason);
            showStatus('done', reason);
        }

        /** 错误要说人话：fetch 断网抛的是 TypeError「Failed to fetch」。 */
        function describe(e) {
            if (e instanceof TypeError) return '网络错误';
            return e && e.message ? e.message : String(e);
        }

        /**
         * 下一页 URL 能不能继续加载。有的论坛最后一页的「下一页」绕回第 1 页，
         * 有的页码越界会 302 回最后一页 —— 不记账就是死循环，所以请求前、跳转后各查一次。
         */
        function setNext(url) {
            state.next = null;
            if (!url) return finish('已到最后一页');
            if (state.loaded.has(stripHash(url))) return finish(`下一页指回已加载过的页面（${url}），停止`);
            if (state.pageNo >= CONFIG.maxPages) return finish(`已加载 ${state.pageNo} 页，到达上限`);
            state.next = url;
        }

        async function loadNext() {
            if (state.busy || state.done || !state.next) return;
            state.busy = true;
            const url = state.next;
            showStatus('loading', `正在加载第 ${state.pageNo + 1} 页…`);
            try {
                const { doc, url: finalUrl } = await fetchDoc(url);
                if (state.loaded.has(stripHash(finalUrl))) return finish(`${url} 跳转回已加载过的页面，停止`);
                state.loaded.add(stripHash(url));
                state.loaded.add(stripHash(finalUrl));
                if (!state.content) {
                    state.content = Content.detect(doc, state.rule);
                    if (!state.content) return finish('没认出这一页的内容区域，自动翻页停止');
                    console.info(TAG, `内容区域：${state.content.path.selector}`);
                    state.pager = state.rule && state.rule.pager ? { selector: state.rule.pager } : locatePager(url);
                    if (state.pager) console.info(TAG, `分页条：${state.pager.selector}`);
                }
                append(doc, finalUrl);
                showStatus('idle');
                const next = Finder.find(doc, finalUrl, state.rule);
                setNext(next && next.url);
            } catch (e) {
                // 失败后照常走下面的 check()：还在底部就会立刻再请求，一秒几十次地打服务器。
                // 记下错误，自动加载到此为止，等用户点重试。
                state.failed = e;
                console.warn(TAG, `加载 ${url} 失败`, e);
                showStatus('error', `第 ${state.pageNo + 1} 页加载失败（${describe(e)}）`);
            } finally {
                state.busy = false;
            }
            requestAnimationFrame(check);
        }

        /** 离底部不到 N 屏就加载。拼接完会再查一次：内容太短时一口气补到够长。 */
        function check() {
            if (state.busy || state.done || state.failed || !state.next) return;
            const remain = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
            if (remain < window.innerHeight * CONFIG.triggerScreens) loadNext();
        }

        let ticking = false;
        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                ticking = false;
                check();
            });
        }

        function start(nextUrl, rule) {
            state.rule = rule;
            setNext(nextUrl);
            const style = document.createElement('style');
            // 表格里的分隔线是 <tr>，不能给它 display:block（会脱离表格布局），样式落在 <td> 上
            style.textContent = `div.${SEP_CLASS},li.${SEP_CLASS},.${SEP_CLASS} td{margin:12px 0;padding:6px 0;border-top:2px dashed #c8c8c8;text-align:center;font:13px/1.6 sans-serif;color:#888;list-style:none}`
                + `.${SEP_CLASS} a{color:inherit;text-decoration:none}.${SEP_CLASS} a:hover{text-decoration:underline}`
                + `.${STATUS_CLASS}{margin:12px auto;padding:8px 12px;text-align:center;font:13px/1.6 sans-serif;color:#666;clear:both}`
                + `.${STATUS_CLASS}[hidden]{display:none}`
                + `.${STATUS_CLASS}.floating{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;margin:0;background:#fff;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,.2)}`
                + `.${STATUS_CLASS}[data-state="error"]{color:#c0392b}`
                + `.${STATUS_CLASS} button{margin-left:6px;padding:2px 10px;font:inherit;cursor:pointer}`;
            (document.head || document.documentElement).appendChild(style);
            window.addEventListener('scroll', onScroll, { passive: true });
            window.addEventListener('resize', onScroll, { passive: true });
            check();
        }

        return { start };
    })();

    function boot() {
        if (!document.body) return;
        if (Store.site().disabled) {
            console.info(TAG, '本站已停用');
            return;
        }
        const rule = matchRule();
        console.info(TAG, rule ? `启动（站点规则：${rule.name}）` : '启动');
        const next = Finder.find(document, location.href, rule);
        if (!next) {
            console.info(TAG, '没有找到下一页');
            return;
        }
        console.info(TAG, `下一页（${next.how}）：${next.url}`);
        Loader.start(next.url, rule);
    }

    boot();
})();
