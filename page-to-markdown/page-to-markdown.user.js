// ==UserScript==
// @name         网页正文转 Markdown|一键复制 / 下载干净的 Markdown
// @name:zh-CN   网页正文转 Markdown|一键复制 / 下载干净的 Markdown
// @name:en      Page to Markdown | Copy or download the article as clean Markdown
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.04.22.1
// @description  把文章页的正文一键转成干净的 Markdown，复制到剪贴板或下载为 .md 文件。
// @description:zh-CN  把文章页的正文一键转成干净的 Markdown，复制到剪贴板或下载为 .md 文件。
// @description:en  Turn the main article of any web page into clean Markdown — copy it to the clipboard or download it as a .md file.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @license      CC BY-NC-SA
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/page-to-markdown/page-to-markdown.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/page-to-markdown/page-to-markdown.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    const TAG = '[正文转MD]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        bullet: '-',        // 无序列表标记
        fence: '```',       // 代码块围栏
        toastMs: 2500,      // 提示条停留时间
    };

    // =========================================================================
    // HTML → Markdown
    // =========================================================================

    const BLOCK_TAGS = new Set([
        'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CENTER', 'DD', 'DETAILS', 'DIALOG', 'DIV',
        'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5',
        'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'MENU', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
        'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
    ]);
    const BLOCK_SELECTOR = [...BLOCK_TAGS].join(',').toLowerCase();
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);

    /** 硬换行先用占位符，等整段拼完再决定是 `\` 换行还是分段（见 finishInline）。 */
    const BR = '';

    function isBlock(el) {
        return BLOCK_TAGS.has(el.tagName) || !!el.querySelector(BLOCK_SELECTOR);
    }

    function escapeText(s) {
        return s
            .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
            .replace(/[*_`]/g, '\\$&');
    }

    function textOf(node) {
        return escapeText(node.data.replace(/\s+/g, ' '));
    }

    /** 把首尾空白挪到标记外面：`<b> 粗 </b>` → ` **粗** `，否则 `** 粗 **` 不生效。 */
    function wrap(s, open, close = open) {
        const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
        if (!m[2]) return s;
        return m[1] + open + m[2] + close + m[3];
    }

    function absUrl(u) {
        if (!u) return '';
        try {
            return new URL(u, document.baseURI).href;
        } catch (e) {
            return u;
        }
    }

    function renderInline(el, ctx) {
        const tag = el.tagName;
        if (SKIP_TAGS.has(tag)) return '';
        switch (tag) {
            case 'BR':
                return BR;
            case 'STRONG': case 'B':
                return wrap(inlineChildren(el, ctx), '**');
            case 'EM': case 'I':
                return wrap(inlineChildren(el, ctx), '*');
            case 'A': {
                const text = inlineChildren(el, ctx).trim();
                const href = el.getAttribute('href');
                if (!href || /^javascript:/i.test(href)) return text;
                if (!text) return '';
                return `[${text}](${absUrl(href)})`;
            }
            default:
                return inlineChildren(el, ctx);
        }
    }

    function inlineChildren(el, ctx) {
        let out = '';
        for (const n of el.childNodes) {
            if (n.nodeType === 3) out += textOf(n);
            else if (n.nodeType === 1) out += renderInline(n, ctx);
        }
        return out;
    }

    /** 一段行内内容收尾：合并空白、处理换行占位符。 */
    function finishInline(s) {
        s = s.replace(/ {2,}/g, ' ')
            .replace(/ * */g, BR)
            .replace(/^+|+$/g, '');
        // 连续两个以上 <br> 当分段用（不少中文站用 <br><br> 代替 <p>）
        s = s.replace(/{2,}/g, '\n\n').replace(//g, '\\\n');
        return s.trim();
    }

    /** 渲染子节点为若干块，连续的行内节点拼成一段。 */
    function renderChildren(parent, ctx) {
        const out = [];
        let buf = '';
        const flush = () => {
            const t = finishInline(buf);
            if (t) out.push(t);
            buf = '';
        };
        for (const n of parent.childNodes) {
            if (n.nodeType === 3) {
                buf += textOf(n);
            } else if (n.nodeType === 1 && !SKIP_TAGS.has(n.tagName)) {
                if (isBlock(n)) {
                    flush();
                    const b = renderBlock(n, ctx);
                    if (b) out.push(b);
                } else {
                    buf += renderInline(n, ctx);
                }
            }
        }
        flush();
        return out;
    }

    function renderBlock(el, ctx) {
        const tag = el.tagName;
        if (/^H[1-6]$/.test(tag)) {
            const text = finishInline(inlineChildren(el, ctx)).replace(/\\?\n+/g, ' ');
            return text ? '#'.repeat(+tag[1]) + ' ' + text : '';
        }
        if (tag === 'HR') return '---';
        return renderChildren(el, ctx).join('\n\n');
    }

    function htmlToMarkdown(root) {
        const ctx = {};
        return renderChildren(root, ctx).join('\n\n').trim() + '\n';
    }

    // =========================================================================
    // 界面：提示条
    // =========================================================================

    function toast(msg) {
        const box = document.createElement('div');
        box.textContent = msg;
        box.setAttribute('data-p2md-toast', '');
        Object.assign(box.style, {
            position: 'fixed', top: '16px', right: '16px', zIndex: 2147483647,
            padding: '8px 14px', background: 'rgba(30,30,30,.92)', color: '#fff',
            font: '13px/1.5 system-ui, sans-serif', borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,.3)', pointerEvents: 'none',
        });
        document.documentElement.appendChild(box);
        setTimeout(() => box.remove(), CONFIG.toastMs);
    }

    // =========================================================================
    // 入口
    // =========================================================================

    function pickRoot() {
        return document.querySelector('article') || document.querySelector('main') || document.body;
    }

    function copyMarkdown() {
        const md = htmlToMarkdown(pickRoot());
        GM_setClipboard(md, 'text');
        toast(`已复制 Markdown（${md.length} 字）`);
        console.log(TAG, '已复制', md.length, '字');
    }

    GM_registerMenuCommand('复制正文为 Markdown', copyMarkdown);
})();
