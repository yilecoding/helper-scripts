// ==UserScript==
// @name         网页正文转 Markdown|一键复制 / 下载干净的 Markdown
// @name:zh-CN   网页正文转 Markdown|一键复制 / 下载干净的 Markdown
// @name:en      Page to Markdown | Copy or download the article as clean Markdown
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.04.23.3
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
        switch (tag) {
            case 'HR': return '---';
            case 'UL': case 'OL': return renderList(el, ctx);
            case 'LI': return renderListItem(el, CONFIG.bullet, ctx); // 选区里截出来的孤儿 li
            case 'BLOCKQUOTE': {
                const inner = renderChildren(el, ctx).join('\n\n');
                return inner ? inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n') : '';
            }
        }
        return renderChildren(el, ctx).join('\n\n');
    }

    function indent(s, n) {
        const pad = ' '.repeat(n);
        return s.split('\n').map(l => (l ? pad + l : l)).join('\n');
    }

    function renderList(el, ctx) {
        const ordered = el.tagName === 'OL';
        let n = ordered ? parseInt(el.getAttribute('start'), 10) : 1;
        if (!Number.isFinite(n)) n = 1;
        const items = [];
        let lastWidth = 2;
        for (const child of el.children) {
            if (child.tagName === 'LI') {
                const marker = ordered ? `${n++}.` : CONFIG.bullet;
                const item = renderListItem(child, marker, ctx);
                if (item) items.push(item);
                lastWidth = marker.length + 1;
            } else if (child.tagName === 'UL' || child.tagName === 'OL') {
                // 不合规但很常见：<ul><li>a</li><ul>…</ul></ul>，子列表直接挂在 ul 下而不是 li 里
                const sub = renderList(child, ctx);
                if (!sub) continue;
                if (items.length) items[items.length - 1] += '\n' + indent(sub, lastWidth);
                else items.push(sub);
            }
        }
        return items.join('\n');
    }

    /** 续行缩进 = 标记宽度（`- ` 2 格，`10. ` 4 格），少一格子列表就会被当成同级。 */
    function renderListItem(li, marker, ctx) {
        let task = '';
        const cb = li.querySelector('input[type="checkbox"]');
        if (cb && cb.closest('li') === li) {
            task = cb.checked || cb.hasAttribute('checked') ? '[x] ' : '[ ] ';
            cb.remove(); // 操作的是克隆，不影响页面
        }
        const blocks = renderChildren(li, ctx);
        // 宽松列表（li 里有 <p>）项内各块之间空一行，紧凑列表只换行
        const loose = [...li.children].some(c => c.tagName === 'P');
        const body = blocks.join(loose ? '\n\n' : '\n');
        const width = marker.length + 1;
        if (!body) return task ? `${marker} ${task.trim()}` : '';
        return `${marker} ${task}` + indent(body, width).slice(width);
    }

    function htmlToMarkdown(root) {
        const ctx = {};
        return renderChildren(root, ctx).join('\n\n').trim() + '\n';
    }

    // =========================================================================
    // 正文提取（Readability 风格打分）
    // =========================================================================

    /*
     * 思路照 Mozilla Readability：给每个「像段落的」元素打分，分数往上传给父 / 祖父，
     * 得分最高的祖先就是正文容器，再把分数够高的兄弟节点一并带上。
     * 区别：
     *   - 文本长度按「CJK 字符算 2」加权。一个中文字的信息量约等于两三个英文字母，
     *     不加权的话中文段落普遍过不了 25 字的门槛，正文容器反而输给侧栏。
     *   - 逗号把中文的「，、。；」也算上。
     */
    const RE = {
        unlikely: /-ad-|banner|breadcrumb|combx|comment|community|disqus|extra|footer|gdpr|header|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|pagination|pager|popup|modal|share|recommend|subscribe|cookie|toolbar|copyright|navbar|topbar/i,
        maybe: /article|body|column|content|main|post|entry|story|text|blog/i,
        positive: /article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story/i,
        negative: /-ad-|hidden|^hid$|banner|combx|comment|com-|contact|foot|footnote|gdpr|masthead|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|recommend/i,
        // 广告：要求按词边界匹配，否则 header / read / shadow 里的 "ad" 全会误伤
        ad: /(^|[\s_-])(ads?|adv|advert|advertisement|adsbygoogle|sponsored|guanggao)([\s_-]|$)/i,
        comma: /[,，、。；]/g,
        cjk: /[぀-ヿ㐀-鿿豈-﫿가-힯]/g,
    };

    const NOISE_SELECTOR = [
        'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'canvas', 'svg',
        'nav', 'aside', 'footer', 'form', 'button', 'select', 'textarea', 'input:not([type="checkbox"])', 'label', 'dialog',
        '[role="navigation"]', '[role="complementary"]', '[role="dialog"]', '[hidden]',
        '.sr-only', '.visually-hidden', '.screen-reader-text',
        'ins.adsbygoogle', '[id^="div-gpt-ad"]', '[data-ad-slot]', '[data-ad]',
    ].join(',');

    function normText(el) {
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function weightedLen(s) {
        return s.length + (s.match(RE.cjk) || []).length;
    }

    function linkDensity(el) {
        const total = weightedLen(normText(el));
        if (!total) return 0;
        let links = 0;
        for (const a of el.querySelectorAll('a')) links += weightedLen(normText(a));
        return Math.min(1, links / total);
    }

    function classWeight(el) {
        let w = 0;
        for (const s of [el.className, el.id]) {
            if (typeof s !== 'string' || !s) continue;
            if (RE.negative.test(s)) w -= 25;
            if (RE.positive.test(s)) w += 25;
        }
        if (el.tagName === 'ARTICLE' || el.tagName === 'MAIN' || el.getAttribute('itemprop') === 'articleBody') w += 25;
        return w;
    }

    function isUnlikely(el) {
        if (el.tagName === 'BODY' || el.tagName === 'ARTICLE' || el.tagName === 'MAIN') return false;
        if (/^(NAV|ASIDE|FOOTER|FORM|DIALOG)$/.test(el.tagName)) return true;
        const role = el.getAttribute('role');
        if (role && /^(navigation|complementary|dialog|banner|contentinfo)$/.test(role)) return true;
        const s = (typeof el.className === 'string' ? el.className : '') + ' ' + el.id;
        return (RE.unlikely.test(s) && !RE.maybe.test(s)) || RE.ad.test(s);
    }

    /** 元素本身或任一祖先是噪声区（侧栏 / 评论 / 导航…）。带缓存，段落多时不重复爬树。 */
    function makeUnlikelyChecker() {
        const cache = new Map();
        const check = el => {
            if (!el || el === document.body || el === document.documentElement) return false;
            if (cache.has(el)) return cache.get(el);
            const v = isUnlikely(el) || check(el.parentElement);
            cache.set(el, v);
            return v;
        };
        return check;
    }

    function baseScore(el) {
        switch (el.tagName) {
            case 'DIV': case 'SECTION': case 'ARTICLE': case 'MAIN': return 5;
            case 'PRE': case 'TD': case 'BLOCKQUOTE': return 3;
            case 'ADDRESS': case 'OL': case 'UL': case 'DL': case 'DD': case 'DT': case 'LI': case 'FORM': return -3;
            case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': case 'TH': return -5;
            default: return 0;
        }
    }

    /** 返回正文元素数组（最高分容器 + 够格的兄弟节点），找不到时退回 article / main / body。 */
    function findContent(doc = document) {
        const unlikely = makeUnlikelyChecker();
        const scores = new Map();
        const addScore = (el, v) => {
            if (!el || el === doc.documentElement) return;
            if (!scores.has(el)) scores.set(el, baseScore(el) + classWeight(el));
            scores.set(el, scores.get(el) + v);
        };

        // 「段落」：p / pre / td，外加没有块级子元素的 div（很多中文站一段一个 div）
        const paras = [...doc.body.querySelectorAll('p, pre, td, div, section')].filter(el =>
            /^(P|PRE|TD)$/.test(el.tagName) || ![...el.children].some(c => BLOCK_TAGS.has(c.tagName)));
        for (const p of paras) {
            if (unlikely(p) || !p.getClientRects().length) continue;
            const text = normText(p);
            const len = weightedLen(text);
            if (len < 25) continue;
            const score = 1 + (text.match(RE.comma) || []).length + Math.min(Math.floor(len / 100), 3);
            let anc = p.parentElement;
            for (let level = 0; anc && level < 3; level++, anc = anc.parentElement) {
                if (anc === doc.body && level > 0) break;
                addScore(anc, level === 0 ? score : score / (level === 1 ? 2 : level * 3));
            }
        }

        let top = null;
        let topScore = -Infinity;
        for (const [el, s] of scores) {
            const final = s * (1 - linkDensity(el));
            scores.set(el, final);
            if (final > topScore) { top = el; topScore = final; }
        }
        if (!top) {
            const fallback = doc.querySelector('article, [itemprop="articleBody"], main') || doc.body;
            return [fallback];
        }

        // 只有一个孩子的包装层往上提，保证兄弟合并时能看到真正的兄弟
        while (top.parentElement && top.parentElement !== doc.body && top.parentElement.children.length === 1) {
            top = top.parentElement;
        }
        const parent = top.parentElement;
        if (!parent) return [top];

        const threshold = Math.max(10, topScore * 0.2);
        const picked = [];
        for (const sib of parent.children) {
            if (sib === top) { picked.push(sib); continue; }
            if (unlikely(sib)) continue;
            if ((scores.get(sib) || 0) >= threshold) { picked.push(sib); continue; }
            if (sib.tagName === 'P') {
                const len = weightedLen(normText(sib));
                const ld = linkDensity(sib);
                if ((len > 80 && ld < 0.25) || (len > 0 && ld === 0 && /[.。!！?？]$/.test(normText(sib)))) picked.push(sib);
            }
        }
        return picked;
    }

    /*
     * 隐藏元素只能在活的 DOM 上用 getComputedStyle 判断，克隆出来的游离节点拿不到样式。
     * cloneNode(true) 保持结构一致，所以两边 querySelectorAll('*') 的顺序一一对应，
     * 按下标把「隐藏」标记抄到克隆上，再在克隆上做删除。
     */
    function cloneForConvert(els) {
        const wrapEl = document.createElement('div');
        for (const live of els) {
            const clone = live.cloneNode(true);
            const L = [live, ...live.querySelectorAll('*')];
            const C = [clone, ...clone.querySelectorAll('*')];
            if (L.length === C.length) {
                for (let i = 0; i < L.length; i++) {
                    const cs = getComputedStyle(L[i]);
                    if (cs.display === 'none' || cs.visibility === 'hidden') C[i].setAttribute('data-p2md-hidden', '');
                }
            }
            wrapEl.appendChild(clone);
        }
        cleanTree(wrapEl);
        return wrapEl;
    }

    function cleanTree(root) {
        for (const el of root.querySelectorAll('[data-p2md-hidden]')) el.remove();
        for (const el of root.querySelectorAll(NOISE_SELECTOR)) el.remove();
        for (const el of root.querySelectorAll('[aria-hidden="true"]')) {
            // 装饰图标 / 标题锚点常带 aria-hidden；内容大的不删（有站点在弹窗打开时给整个 main 挂它）
            if (normText(el).length < 100 && !el.querySelector('img')) el.remove();
        }
        for (const el of [...root.querySelectorAll('*')]) {
            if (!root.contains(el)) continue; // 祖先已被删
            const s = (typeof el.className === 'string' ? el.className : '') + ' ' + el.id;
            if (RE.ad.test(s) || (RE.unlikely.test(s) && !RE.maybe.test(s))) { el.remove(); continue; }
            // 链接堆（相关文章、标签云）：负权重或纯 div，链接占比高、文字少
            if (/^(DIV|SECTION|UL|OL)$/.test(el.tagName) && (classWeight(el) < 0 || /^(DIV|SECTION)$/.test(el.tagName))) {
                const links = el.querySelectorAll('a').length;
                if (links >= 3 && linkDensity(el) > 0.6 && weightedLen(normText(el)) < 300) el.remove();
            }
        }
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

    function copyMarkdown() {
        const md = htmlToMarkdown(cloneForConvert(findContent()));
        GM_setClipboard(md, 'text');
        toast(`已复制 Markdown（${md.length} 字）`);
        console.log(TAG, '已复制', md.length, '字');
    }

    GM_registerMenuCommand('复制正文为 Markdown', copyMarkdown);
})();
