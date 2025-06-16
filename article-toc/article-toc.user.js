// ==UserScript==
// @name         文章自动目录
// @name:zh-CN   文章自动目录
// @name:en      Article TOC — Floating Table of Contents for Any Long Article
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.06.16.2
// @description  给任意长文章页面生成浮动目录：自动识别正文、按页面实际使用的标题层级生成嵌套目录，点击跳转。
// @description:zh-CN  给任意长文章页面生成浮动目录：自动识别正文、按页面实际使用的标题层级生成嵌套目录，点击跳转。
// @description:en  Adds a floating table of contents to any long article: detects the main content, builds a nested outline from the heading levels the page actually uses, and jumps to a section on click.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
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
    };

    const HOST_ID = 'article-toc-host';
    const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';

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
        .panel {
            position: fixed; z-index: 2147483646;
            width: ${CONFIG.panelWidth}px; max-height: 70vh;
            display: flex; flex-direction: column;
            box-sizing: border-box;
            font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
            color: #1f2328; background: rgba(255, 255, 255, .96);
            border: 1px solid rgba(0, 0, 0, .12); border-radius: 8px;
            box-shadow: 0 6px 24px rgba(0, 0, 0, .12);
        }
        .head {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 10px; border-bottom: 1px solid rgba(0, 0, 0, .08);
            font-weight: 600; user-select: none;
        }
        .head .count { color: #8b949e; font-weight: 400; }
        .list { overflow: auto; padding: 4px 0; margin: 0; }
        ul { list-style: none; margin: 0; padding: 0; }
        .item {
            display: block; width: 100%; box-sizing: border-box;
            padding: 3px 10px; border: 0; border-left: 2px solid transparent;
            background: none; color: inherit; font: inherit; text-align: left;
            cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .item:hover { background: rgba(0, 0, 0, .05); }
        @media (prefers-color-scheme: dark) {
            .panel { color: #e6edf3; background: rgba(22, 27, 34, .96); border-color: rgba(255, 255, 255, .15); }
            .head { border-color: rgba(255, 255, 255, .1); }
            .item:hover { background: rgba(255, 255, 255, .08); }
        }
    `;

    const Panel = (() => {
        let host = null;
        let shadow = null;

        function mount() {
            if (host && host.isConnected) return;
            host = document.createElement('div');
            host.id = HOST_ID;
            // 挂在 <html> 下而不是 <body>：有些 SPA 会整个替换 body 的内容
            document.documentElement.appendChild(host);
            // open 模式只是为了调试和测试能看到内部；样式隔离 open/closed 一样
            shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = `<style>${STYLE}</style>
                <div class="panel" part="panel">
                    <div class="head"><span>目录</span><span class="count"></span></div>
                    <div class="list"></div>
                </div>`;
            const panel = shadow.querySelector('.panel');
            panel.style.top = CONFIG.panelTop + 'px';
            panel.style.right = CONFIG.panelRight + 'px';
        }

        function unmount() {
            if (host) host.remove();
            host = shadow = null;
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

        return { render, unmount };
    })();

    // =========================================================================
    // 跳转
    // =========================================================================

    function jumpTo(node) {
        node.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // =========================================================================
    // 启动
    // =========================================================================

    function build() {
        const { root, via } = Content.findRoot();
        const headings = Content.collect(root);
        if (headings.length < CONFIG.minHeadings) {
            Panel.unmount();
            console.log(TAG, `标题只有 ${headings.length} 个，不显示目录`);
            return;
        }
        const tree = buildTree(headings);
        Panel.render(tree, jumpTo);
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
