// ==UserScript==
// @name         文章自动目录
// @name:zh-CN   文章自动目录
// @name:en      Article TOC — Floating Table of Contents for Any Long Article
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.06.13.1
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
        const ROOT_SELECTORS = ['article', 'main', '[role="main"]'];

        function headingText(h) {
            return (h.textContent || '').replace(/\s+/g, ' ').trim();
        }

        function collect(root) {
            return Array.from(root.querySelectorAll(HEADING_SEL))
                .map((el) => ({ el, rawLevel: Number(el.tagName[1]), text: headingText(el) }))
                .filter((h) => h.text);
        }

        function findRoot() {
            for (const sel of ROOT_SELECTORS) {
                const el = document.querySelector(sel);
                if (el && collect(el).length >= CONFIG.minHeadings) return el;
            }
            return document.body;
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
        const root = Content.findRoot();
        const headings = Content.collect(root);
        if (headings.length < CONFIG.minHeadings) {
            Panel.unmount();
            console.log(TAG, `标题只有 ${headings.length} 个，不显示目录`);
            return;
        }
        const tree = buildTree(headings);
        Panel.render(tree, jumpTo);
        console.log(TAG, `已生成目录：${headings.length} 个标题`);
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
