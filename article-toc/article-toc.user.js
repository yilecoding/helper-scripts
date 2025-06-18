// ==UserScript==
// @name         文章自动目录
// @name:zh-CN   文章自动目录
// @name:en      Article TOC — Floating Table of Contents for Any Long Article
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.06.18.6
// @description  给任意长文章页面生成浮动目录：自动识别正文、按页面实际使用的标题层级生成嵌套目录，点击跳转。
// @description:zh-CN  给任意长文章页面生成浮动目录：自动识别正文、按页面实际使用的标题层级生成嵌套目录，点击跳转。
// @description:en  Adds a floating table of contents to any long article: detects the main content, builds a nested outline from the heading levels the page actually uses, and jumps to a section on click.
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
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/article-toc/article-toc.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/article-toc/article-toc.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「文章目录」只看本脚本。 */
    const TAG = '[文章目录]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        minHeadings: 3,         // 少于这么多个标题不显示目录（短文、列表页不需要）
        panelWidth: 260,
        panelTop: 80,           // 默认位置：距视口顶部
        panelRight: 16,         // 默认位置：距视口右侧
        maxTextLength: 80,      // 目录项文字截断长度
        jumpGap: 8,             // 跳转后标题距顶栏底部的留白
    };

    const HOST_ID = 'article-toc-host';
    const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';

    // =========================================================================
    // 存储（GM，按站点）
    // =========================================================================

    /**
     * 面板位置、折叠状态按站点（hostname）存：不同站点的版式不同，
     * 在 A 站拖到左下角躲开它的悬浮按钮，不该影响 B 站。
     */
    const Store = (() => {
        const siteKey = 'site:' + location.hostname;

        function site() {
            return { collapsed: false, pos: null, ...GM_getValue(siteKey, {}) };
        }

        function saveSite(patch) {
            GM_setValue(siteKey, { ...site(), ...patch });
        }

        /** 全局设置：和站点版式无关的个人偏好。 */
        function settings() {
            return { progressBar: true, ...GM_getValue('settings', {}) };
        }

        function saveSettings(patch) {
            GM_setValue('settings', { ...settings(), ...patch });
        }

        return { site, saveSite, settings, saveSettings };
    })();

    // =========================================================================
    // 正文与标题
    // =========================================================================

    const Content = (() => {
        /*
         * 正文容器候选，按优先级排。站点/框架约定的正文类名最精确，放前面；
         * article/main 次之（有的站把评论、相关推荐也包在 main 里）；
         * #content/.content 太泛，垫底。
         * 每个选择器取「有效标题最多」的那个命中，而不是第一个：
         * 列表页、GitHub issue 这类页面一屏有几十个 article/.markdown-body。
         */
        const ROOT_SELECTORS = [
            '[itemprop="articleBody"]',
            '.markdown-body', '.entry-content', '.post-content', '.article-content', '.article-body',
            '.post-body', '.rich_media_content', '#js_content', '.Post-RichText', '#article_content',
            '.theme-default-content', '.prose',
            'article', 'main', '[role="main"]',
            '#content', '.content',
        ];
        const MAX_CANDIDATES = 50;

        /** 这些容器里的标题不属于正文结构（站点导航、侧栏、页脚、文内旁注）。 */
        const EXCLUDE_SEL = [
            'nav', 'aside', 'footer', 'dialog',
            '[role="navigation"]', '[role="complementary"]', '[role="contentinfo"]', '[role="banner"]',
            '[aria-hidden="true"]',
        ].join(',');
        /**
         * 类名/ID 按「词」匹配，不做子串匹配：
         * 子串匹配下 .commentary-free、#sidebar-toggle-off 之类会误伤，
         * 而 post-comments / side-bar / widget-area 这种连字符写法又必须认出来。
         */
        const EXCLUDE_NAME = /(?:^|[\s_-])(?:comments?|comment-list|respond|disqus|replies|sidebar|side-?bar|widgets?|related|recommend(?:ed|s)?|footer|breadcrumbs?|toc|table-of-contents)(?:$|[\s_-])/i;

        function nameOf(el) {
            return `${el.id || ''} ${el.getAttribute('class') || ''}`;
        }

        /**
         * 只看 heading 和 root 之间的祖先：root 本身或它外面的容器叫什么无所谓
         * （比如正文就在 <main class="layout has-sidebar"> 里）。
         */
        function isExcluded(el, root) {
            for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
                if (a.matches(EXCLUDE_SEL)) return true;
                // <header> 只排除站点头；<article><header><h1>标题</h1></header> 是正文的一部分
                if (a.tagName === 'HEADER' && !a.closest('article')) return true;
                if (EXCLUDE_NAME.test(nameOf(a))) return true;
            }
            return false;
        }

        /**
         * 不可见的标题：display:none（含折叠的 <details>）、visibility:hidden，
         * 以及 1×1 的「仅读屏可见」标题 —— 它们在视觉上不存在，跳过去也看不到东西。
         */
        function isVisible(el) {
            const rects = el.getClientRects();
            if (!rects.length) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 1 && r.height <= 1) return false;
            return getComputedStyle(el).visibility !== 'hidden';
        }

        /** 标题里常带「#」「¶」锚点链接，算文字时去掉。 */
        function headingText(el) {
            let text = el.textContent || '';
            if (el.querySelector('a.anchor, a.headerlink, .header-anchor, [aria-hidden="true"]')) {
                const clone = el.cloneNode(true);
                clone.querySelectorAll('a.anchor, a.headerlink, .header-anchor, [aria-hidden="true"]').forEach((n) => n.remove());
                text = clone.textContent || '';
            }
            return text.replace(/\s+/g, ' ').replace(/^[#¶§\s]+|[#¶§\s]+$/g, '').trim();
        }

        function collect(root) {
            const out = [];
            for (const el of root.querySelectorAll(HEADING_SEL)) {
                if (isExcluded(el, root) || !isVisible(el)) continue;
                const text = headingText(el);
                if (text) out.push({ el, rawLevel: Number(el.tagName[1]), text });
            }
            return out;
        }

        /**
         * 找不到语义化容器时，按「标题最密集的祖先」推断：
         * 取包含至少 60% 有效标题的祖先里最深的一个。
         * 只取「最多」会一路取到 body；只取「最深」会被某个只有两三个标题的小块骗走。
         */
        function inferRoot() {
            const all = collect(document.body);
            if (all.length < CONFIG.minHeadings) return document.body;
            const need = Math.max(CONFIG.minHeadings, Math.ceil(all.length * 0.6));
            const counts = new Map();
            for (const h of all) {
                for (let a = h.el.parentElement; a && a !== document.body; a = a.parentElement) {
                    counts.set(a, (counts.get(a) || 0) + 1);
                }
            }
            let best = document.body;
            let bestDepth = 0;
            for (const [el, n] of counts) {
                if (n < need) continue;
                let d = 0;
                for (let a = el; a; a = a.parentElement) d++;
                if (d > bestDepth) { best = el; bestDepth = d; }
            }
            return best;
        }

        function findRoot() {
            for (const sel of ROOT_SELECTORS) {
                const candidates = Array.from(document.querySelectorAll(sel)).slice(0, MAX_CANDIDATES);
                let best = null;
                let bestCount = 0;
                for (const el of candidates) {
                    const n = collect(el).length;
                    if (n > bestCount) { best = el; bestCount = n; }
                }
                if (best && bestCount >= CONFIG.minHeadings) return { root: best, via: sel };
            }
            return { root: inferRoot(), via: '标题密度推断' };
        }

        return { findRoot, collect };
    })();

    /**
     * 层级归一化 + 建树。
     *
     * 归一化按「页面实际用到的层级」排名，而不是 tagName 减一：
     * 很多站点正文只用 h2/h4（h1 留给站名，h3 被主题拿去做别的），
     * 直接按 tag 缩进会凭空多出空的一层。
     *
     * 建树用栈：遇到比栈顶浅或同级的就出栈。这样即使出现跳级
     * （1 级后面直接跟 3 级），3 级也只会挂在 1 级下面，缩进只深一层。
     */
    function buildTree(headings) {
        const ranks = Array.from(new Set(headings.map((h) => h.rawLevel))).sort((a, b) => a - b);
        const roots = [];
        const stack = [];
        const flat = headings.map((h, index) => {
            const node = { ...h, index, level: ranks.indexOf(h.rawLevel) + 1, children: [] };
            while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
            (stack.length ? stack[stack.length - 1].children : roots).push(node);
            node.depth = stack.length + 1;
            stack.push(node);
            return node;
        });
        return { roots, flat };
    }

    // =========================================================================
    // 面板（shadow DOM 隔离页面样式）
    // =========================================================================

    const STYLE = `
        :host { all: initial; }
        .dock {
            position: fixed; z-index: 2147483646;
            font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
            color: #1f2328;
        }
        .panel, .fab {
            box-sizing: border-box;
            background: rgba(255, 255, 255, .96);
            border: 1px solid rgba(0, 0, 0, .12); border-radius: 8px;
            box-shadow: 0 6px 24px rgba(0, 0, 0, .12);
        }
        .panel { width: ${CONFIG.panelWidth}px; max-height: 70vh; display: flex; flex-direction: column; }
        .head {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 6px 6px 10px; border-bottom: 1px solid rgba(0, 0, 0, .08);
            font-weight: 600; user-select: none; cursor: move; touch-action: none;
        }
        .head .count { color: #8b949e; font-weight: 400; flex: 1; }
        .head button {
            border: 0; background: none; color: inherit; font: inherit; cursor: pointer;
            width: 22px; height: 22px; border-radius: 4px; padding: 0; line-height: 22px;
        }
        .head button:hover { background: rgba(0, 0, 0, .08); }
        .fab {
            display: none; padding: 6px 10px; color: inherit; font: inherit; font-weight: 600;
            cursor: pointer; user-select: none; touch-action: none;
        }
        .dock.collapsed .panel { display: none; }
        .dock.collapsed .fab { display: block; }
        .dock.dragging { opacity: .85; }
        /* 进度条不接收指针事件：既不挡页面顶栏的点击，也不会被 topInset() 当成顶栏 */
        .progress {
            position: fixed; z-index: 2147483647; top: 0; left: 0; right: 0; height: 3px;
            pointer-events: none;
        }
        .progress[hidden] { display: none; }
        .progress .bar {
            height: 100%; background: #0969da;
            transform: scaleX(0); transform-origin: 0 50%;
        }
        /* position: relative 让条目的 offsetTop 相对列表计算，见 setActive() */
        .list { position: relative; overflow: auto; padding: 4px 0; margin: 0; overscroll-behavior: contain; }
        ul { list-style: none; margin: 0; padding: 0; }
        .item {
            display: block; width: 100%; box-sizing: border-box;
            padding: 3px 10px; border: 0; border-left: 2px solid transparent;
            background: none; color: inherit; font: inherit; text-align: left;
            cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .item:hover { background: rgba(0, 0, 0, .05); }
        .item.active { color: #0969da; border-left-color: #0969da; background: rgba(9, 105, 218, .08); font-weight: 600; }
        @media (prefers-color-scheme: dark) {
            .dock { color: #e6edf3; }
            .panel, .fab { background: rgba(22, 27, 34, .96); border-color: rgba(255, 255, 255, .15); }
            .head button:hover { background: rgba(255, 255, 255, .1); }
            .head { border-color: rgba(255, 255, 255, .1); }
            .item:hover { background: rgba(255, 255, 255, .08); }
            .item.active { color: #58a6ff; border-left-color: #58a6ff; background: rgba(88, 166, 255, .12); }
            .progress .bar { background: #58a6ff; }
        }
    `;

    const Panel = (() => {
        let host = null;
        let shadow = null;
        let dock = null;

        function mount() {
            if (host && host.isConnected) return;
            host = document.createElement('div');
            host.id = HOST_ID;
            // 挂在 <html> 下而不是 <body>：有些 SPA 会整个替换 body 的内容
            document.documentElement.appendChild(host);
            // open 模式只是为了调试和测试能看到内部；样式隔离 open/closed 一样
            shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = `<style>${STYLE}</style>
                <div class="progress" hidden><div class="bar"></div></div>
                <div class="dock">
                    <div class="panel">
                        <div class="head">
                            <span>目录</span><span class="count"></span>
                            <button type="button" class="collapse" title="折叠目录">−</button>
                        </div>
                        <div class="list"></div>
                    </div>
                    <div class="fab" role="button" tabindex="0" title="展开目录（可拖动）">☰ 目录</div>
                </div>`;
            dock = shadow.querySelector('.dock');
            shadow.querySelector('.progress').hidden = !Store.settings().progressBar;
            const site = Store.site();
            dock.classList.toggle('collapsed', !!site.collapsed);
            place(site.pos);

            shadow.querySelector('.collapse').addEventListener('click', () => setCollapsed(true));
            const fab = shadow.querySelector('.fab');
            fab.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(false); }
            });
            draggable(shadow.querySelector('.head'), null);
            draggable(fab, () => setCollapsed(false));
            window.addEventListener('resize', onResize, { passive: true });
        }

        function onResize() {
            if (dock) place(currentPos());
        }

        function currentPos() {
            return { top: parseFloat(dock.style.top), right: parseFloat(dock.style.right) };
        }

        /**
         * 位置存「距右边、距顶部」而不是 left/top：面板本来就靠右，
         * 换个窗口宽度（或者 Retina 外接屏来回切）它应该还贴着右边，
         * 存 left 的话窗口变窄就跑出屏幕、变宽就漂到中间。
         * 每次落位都夹到视口内，防止存下来的位置在小窗口里看不见、也拖不回来。
         */
        function place(pos) {
            const p = pos || { top: CONFIG.panelTop, right: CONFIG.panelRight };
            const rect = dock.getBoundingClientRect();
            const w = rect.width || CONFIG.panelWidth;
            const maxRight = Math.max(0, window.innerWidth - w);
            const maxTop = Math.max(0, window.innerHeight - 40);
            dock.style.right = Math.round(Math.min(Math.max(0, p.right), maxRight)) + 'px';
            dock.style.top = Math.round(Math.min(Math.max(0, p.top), maxTop)) + 'px';
        }

        /**
         * 拖动。按下后移动超过 4px 才算拖动，否则当成点击（onTap）——
         * 折叠后的小按钮既要能点开、又要能拖走，两件事靠这个阈值区分。
         * 用 pointer capture：拖快了指针离开元素也不会丢事件。
         */
        function draggable(handle, onTap) {
            handle.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || e.target.closest('button')) return;
                const start = { x: e.clientX, y: e.clientY, ...currentPos() };
                let moved = false;
                handle.setPointerCapture(e.pointerId);
                const move = (ev) => {
                    const dx = ev.clientX - start.x;
                    const dy = ev.clientY - start.y;
                    if (!moved && Math.hypot(dx, dy) < 4) return;
                    moved = true;
                    dock.classList.add('dragging');
                    place({ top: start.top + dy, right: start.right - dx });
                };
                const up = () => {
                    handle.removeEventListener('pointermove', move);
                    handle.removeEventListener('pointerup', up);
                    handle.removeEventListener('pointercancel', up);
                    dock.classList.remove('dragging');
                    if (moved) Store.saveSite({ pos: currentPos() });
                    else if (onTap) onTap();
                };
                handle.addEventListener('pointermove', move);
                handle.addEventListener('pointerup', up);
                handle.addEventListener('pointercancel', up);
            });
        }

        function setCollapsed(collapsed) {
            dock.classList.toggle('collapsed', collapsed);
            Store.saveSite({ collapsed });
            // 宽度变了（面板 ↔ 小按钮），重新夹一次，免得展开后右边出界
            place(currentPos());
            if (!collapsed) reveal();
        }

        function unmount() {
            if (host) host.remove();
            window.removeEventListener('resize', onResize);
            host = shadow = dock = null;
        }

        function renderList(nodes) {
            const ul = document.createElement('ul');
            for (const node of nodes) {
                const li = document.createElement('li');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'item';
                btn.dataset.index = node.index;
                btn.dataset.depth = node.depth;
                btn.style.paddingLeft = 10 + (node.depth - 1) * 14 + 'px';
                btn.title = node.text;
                btn.textContent = node.text.length > CONFIG.maxTextLength
                    ? node.text.slice(0, CONFIG.maxTextLength) + '…'
                    : node.text;
                li.appendChild(btn);
                if (node.children.length) li.appendChild(renderList(node.children));
                ul.appendChild(li);
            }
            return ul;
        }

        function render(tree, onPick) {
            mount();
            shadow.querySelector('.count').textContent = `(${tree.flat.length})`;
            const list = shadow.querySelector('.list');
            list.replaceChildren(renderList(tree.roots));
            list.onclick = (e) => {
                const btn = e.target.closest('.item');
                if (btn) onPick(tree.flat[Number(btn.dataset.index)]);
            };
        }

        /**
         * 高亮当前章节，并把它滚进目录列表的可视区。
         * 不能用 btn.scrollIntoView()：它会连带滚动所有祖先滚动容器，
         * 包括页面本身 —— 用户正读着，页面被目录拽着跳。只动列表自己的 scrollTop。
         */
        function setActive(index) {
            if (!shadow) return;
            const list = shadow.querySelector('.list');
            const prev = list.querySelector('.item.active');
            const btn = index >= 0 ? list.querySelector(`.item[data-index="${index}"]`) : null;
            if (prev === btn) return;
            if (prev) { prev.classList.remove('active'); prev.removeAttribute('aria-current'); }
            if (!btn) return;
            btn.classList.add('active');
            btn.setAttribute('aria-current', 'true');
            reveal();
        }

        /** 折叠时列表 display:none，量不出尺寸；所以展开时要再调一次。 */
        function reveal() {
            const list = shadow.querySelector('.list');
            const btn = list.querySelector('.item.active');
            if (!btn || !list.clientHeight) return;
            const top = btn.offsetTop;
            const bottom = top + btn.offsetHeight;
            if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
                list.scrollTop = top - (list.clientHeight - btn.offsetHeight) / 2;
            }
        }

        /** 用 transform 而不是 width：每帧都可能更新，transform 不触发布局。 */
        function setProgress(ratio) {
            if (!shadow) return;
            shadow.querySelector('.progress .bar').style.transform = `scaleX(${ratio.toFixed(4)})`;
        }

        function showProgress(on) {
            if (shadow) shadow.querySelector('.progress').hidden = !on;
        }

        return { render, unmount, setActive, setProgress, showProgress };
    })();

    // =========================================================================
    // 布局：顶部遮挡 + 滚动容器
    // =========================================================================

    const Layout = (() => {
        /**
         * 视口顶部被固定/吸顶元素挡住的高度（像素）。
         *
         * 两种来源都要找：
         *   - 视口最上沿那一排点下面的 fixed/sticky 祖先 —— 当前就挡着的；
         *   - 浅层 DOM 里 top 很小的 sticky 元素 —— 页面在顶部时它还在横幅下面、
         *     没「吸」住，等跳转滚下去它才贴到顶上。只看当前视口会漏掉它，
         *     跳过去标题正好被它盖住。
         * 叠在一起的多条（公告条 + 导航栏）按首尾相接累加。
         */
        function topInset() {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const seen = new Set();
            const bars = [];
            const consider = (el) => {
                for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
                    if (seen.has(a)) return;
                    seen.add(a);
                    if (a.id === HOST_ID) return;
                    const cs = getComputedStyle(a);
                    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
                    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
                    const r = a.getBoundingClientRect();
                    // 窄的是侧边悬浮按钮，太高的是遮罩/整页容器，都不是顶栏
                    if (r.width < vw * 0.5 || r.height <= 0 || r.height > vh * 0.4) continue;
                    let top = r.top;
                    if (cs.position === 'sticky') {
                        top = parseFloat(cs.top);
                        if (Number.isNaN(top)) continue;   // top: auto 的 sticky 不会吸顶
                    }
                    bars.push({ top, bottom: top + r.height });
                }
            };
            for (const x of [0.1, 0.5, 0.9]) {
                for (const el of document.elementsFromPoint(vw * x, 2)) consider(el);
            }
            const shallow = document.querySelectorAll('body > *, body > * > *, body > * > * > *');
            for (let i = 0; i < shallow.length && i < 300; i++) consider(shallow[i]);

            bars.sort((a, b) => a.top - b.top);
            let bottom = 0;
            for (const b of bars) {
                if (b.top <= bottom + 4) bottom = Math.max(bottom, b.bottom);
            }
            return Math.min(bottom, vh * 0.5);
        }

        /**
         * 正文所在的滚动容器。多数页面滚的是 window，
         * 但不少文档站/后台把正文放在 overflow:auto 的 div 里，window 根本不动。
         */
        function scrollerOf(el) {
            for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
                const oy = getComputedStyle(a).overflowY;
                if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && a.scrollHeight > a.clientHeight + 1) return a;
            }
            return null;
        }

        /** 「阅读线」：被顶栏挡住的部分以下 + 一点留白。跳转后标题就停在这条线上。 */
        function readingLine(scroller) {
            const top = scroller ? Math.max(0, scroller.getBoundingClientRect().top) : 0;
            return Math.max(topInset(), top) + CONFIG.jumpGap;
        }

        /**
         * 跳到某个标题。不用 location.hash / scrollIntoView：
         *   - 标题多半没有 id，给页面元素加 id 可能和站点自己的 id 撞上；
         *     改 hash 还会触发 SPA 路由（hash 路由的站直接切页）。
         *   - scrollIntoView 不知道顶栏有多高，标题会停在导航栏底下。
         * 所以直接拿着元素引用算出距离，自己滚。
         */
        function scrollToEl(el) {
            const scroller = scrollerOf(el);
            const delta = el.getBoundingClientRect().top - readingLine(scroller);
            const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            (scroller || window).scrollBy({ top: delta, behavior: reduce ? 'auto' : 'smooth' });
        }

        return { topInset, scrollerOf, readingLine, scrollToEl };
    })();

    // =========================================================================
    // 滚动联动：高亮当前章节
    // =========================================================================

    /*
     * 用节流（rAF）的 scroll 计算，不用 IntersectionObserver：
     *   - 「当前章节」= 阅读线以上的最后一个标题。读到一个长章节中间时，
     *     视口里一个标题都没有，IO 不会报任何东西，得自己记账推断；
     *     而直接比较 getBoundingClientRect().top 天然就是对的。
     *   - 阅读线跟着顶栏高度走（顶栏会收起/展开），IO 的 rootMargin
     *     建好就固定了，要变只能重建 observer。
     *   - 成本：每帧最多一次，读 N 个标题的位置；中间没有写 DOM，只触发一次布局。
     *     几百个标题也在 1ms 级。
     * scroll 用捕获阶段挂在 document 上：内层容器滚动的 scroll 事件不冒泡，
     * 但捕获阶段能收到，这样不用先判断滚的是 window 还是哪个 div。
     */
    const Spy = (() => {
        let tree = null;
        let root = null;
        let scroller = null;
        let raf = 0;
        let line = 0;
        // 「已过期」用 -Infinity 表示，不能用 0：performance.now() 从页面导航开始计时，
        // 脚本跑起来时可能才过了两三百毫秒，0 会被当成「刚算过」，阅读线就一直是 0
        let lineAt = -Infinity;
        let locked = false;
        let lockStart = 0;
        let lockTimer = 0;

        /** 顶栏高度要读一圈 computed style，缓存 500ms，不必每帧都算。 */
        function readingLine() {
            const now = performance.now();
            if (now - lineAt > 500) {
                line = Layout.readingLine(scroller);
                lineAt = now;
            }
            return line + 4;   // 跳转后标题正好落在线上，留点浮点误差
        }

        function compute() {
            raf = 0;
            if (!tree) return;
            const y = readingLine();
            // 进度条在跳转途中也要跟着走，只有高亮被锁
            Panel.setProgress(progress(y));
            if (locked) return;
            let index = -1;
            for (const node of tree.flat) {
                if (node.el.getBoundingClientRect().top <= y) index = node.index;
                else break;
            }
            Panel.setActive(index);
        }

        /**
         * 阅读进度按正文算，不按整页 scrollHeight：
         * 正文下面常挂着几屏评论和推荐，按整页算的话读完正文才走到一半。
         * 0 = 正文顶部刚到阅读线，1 = 正文底部进入视口底边。
         */
        function progress(lineY) {
            const r = root.getBoundingClientRect();
            const top = lineY - CONFIG.jumpGap;
            const span = r.height - (window.innerHeight - top);
            if (span <= 0) return 1;
            return Math.min(1, Math.max(0, (top - r.top) / span));
        }

        function schedule() {
            if (!raf) raf = requestAnimationFrame(compute);
        }

        function release() {
            locked = false;
            schedule();
        }

        /**
         * 点击跳转期间锁住高亮：平滑滚动途中会依次扫过中间的章节，
         * 不锁的话高亮会一路闪过去。滚动停下 150ms 后解锁，最多锁 3 秒。
         */
        function lockTo(index) {
            Panel.setActive(index);
            locked = true;
            lockStart = performance.now();
            clearTimeout(lockTimer);
            lockTimer = setTimeout(release, 1000);
        }

        function onScroll() {
            if (locked) {
                clearTimeout(lockTimer);
                lockTimer = setTimeout(release, performance.now() - lockStart > 3000 ? 0 : 150);
            }
            schedule();
        }

        function onResize() {
            lineAt = -Infinity;
            schedule();
        }

        function start(next, contentRoot) {
            tree = next;
            root = contentRoot;
            scroller = tree.flat.length ? Layout.scrollerOf(tree.flat[0].el) : null;
            lineAt = -Infinity;
            document.addEventListener('scroll', onScroll, { capture: true, passive: true });
            window.addEventListener('resize', onResize, { passive: true });
            schedule();
        }

        function stop() {
            tree = null;
            document.removeEventListener('scroll', onScroll, { capture: true });
            window.removeEventListener('resize', onResize);
        }

        return { start, stop, lockTo };
    })();

    // =========================================================================
    // 启动
    // =========================================================================

    function build() {
        const { root, via } = Content.findRoot();
        const headings = Content.collect(root);
        if (headings.length < CONFIG.minHeadings) {
            Spy.stop();
            Panel.unmount();
            console.log(TAG, `标题只有 ${headings.length} 个，不显示目录`);
            return;
        }
        const tree = buildTree(headings);
        Panel.render(tree, (node) => {
            Spy.lockTo(node.index);
            Layout.scrollToEl(node.el);
        });
        Spy.start(tree, root);
        console.log(TAG, `已生成目录：${headings.length} 个标题，正文容器来自 ${via}`);
    }

    function boot() {
        if (!document.body || document.getElementById(HOST_ID)) return;
        try {
            build();
        } catch (e) {
            console.error(TAG, '启动失败', e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
