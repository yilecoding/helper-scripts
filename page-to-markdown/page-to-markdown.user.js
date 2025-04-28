// ==UserScript==
// @name         网页正文转 Markdown|一键复制 / 下载干净的 Markdown
// @name:zh-CN   网页正文转 Markdown|一键复制 / 下载干净的 Markdown
// @name:en      Page to Markdown | Copy or download the article as clean Markdown
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.04.28.7
// @description  把文章页的正文一键转成干净的 Markdown，复制到剪贴板或下载为 .md 文件。
// @description:zh-CN  把文章页的正文一键转成干净的 Markdown，复制到剪贴板或下载为 .md 文件。
// @description:en  Turn the main article of any web page into clean Markdown — copy it to the clipboard or download it as a .md file.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_download
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
        frontMatter: true,  // 顶部加 YAML front-matter（title / url / author / date / captured）
        titleHeading: true, // 正文里没有 h1 时在开头补一个 `# 标题`
        maxNameLen: 80,     // 下载文件名最长字符数（不含 .md）
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
            case 'CODE': case 'KBD': case 'SAMP': case 'TT':
                return codeSpan(el.textContent);
            case 'DEL': case 'S': case 'STRIKE':
                return wrap(inlineChildren(el, ctx), '~~');
            case 'SUP': case 'SUB': {
                const t = inlineChildren(el, ctx).trim();
                return t ? `<${tag.toLowerCase()}>${t}</${tag.toLowerCase()}>` : '';
            }
            case 'IMG':
                return renderImage(el);
            case 'A':
                return renderLink(el, ctx);
            default: {
                const inner = inlineChildren(el, ctx);
                // 块元素被压进行内（链接卡片里的 <h3><p>）时，前后补空格，别把字粘在一起
                return BLOCK_TAGS.has(tag) ? ' ' + inner + ' ' : inner;
            }
        }
    }

    /** 括号和空格编码掉：维基百科那种 `Foo_(bar)` 的地址放进 `(...)` 里会提前截断。 */
    function fmtUrl(u) {
        return u.replace(/[()\s<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    }

    function fmtTitle(t) {
        t = (t || '').replace(/\s+/g, ' ').trim();
        return t ? ` "${t.replace(/["\\]/g, '\\$&')}"` : '';
    }

    function renderLink(el, ctx) {
        const text = inlineChildren(el, ctx).trim();
        const href = el.getAttribute('href');
        if (!href || /^(javascript|data|vbscript):/i.test(href.trim())) return text;
        if (!text) return '';
        const url = absUrl(href);
        if (normText(el) === url && /^https?:/i.test(url)) return `<${url}>`;
        return `[${text}](${fmtUrl(url)}${fmtTitle(el.getAttribute('title'))})`;
    }

    /*
     * 懒加载图片：真地址在 data-src 一类属性里，src 是 1×1 占位图（往往是 data: URI）。
     * 所以先看 data-*，再看 srcset（取最大的那张），最后才是 src。
     */
    const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-original-src', 'data-url', 'data-lazyload'];

    function bestFromSrcset(srcset) {
        let best = null;
        let bestW = -1;
        // URL 里可能有逗号（cloudinary 的 w_100,h_100），不能按裸逗号切：
        // URL 贪婪吃到空白为止，只有它后面（或描述符后面）的逗号才是分隔符
        const re = /\s*([^\s,]\S*)(?:\s+([\d.]+)([wx]))?\s*(?:,|$)/g;
        let m;
        while ((m = re.exec(srcset)) && m[0]) {
            const w = m[2] ? parseFloat(m[2]) * (m[3] === 'x' ? 1000 : 1) : 0;
            if (w > bestW) { best = m[1]; bestW = w; }
        }
        return best;
    }

    function imageSrc(img) {
        for (const a of LAZY_ATTRS) {
            const v = img.getAttribute(a);
            if (v && !/^data:/i.test(v.trim())) return absUrl(v.trim());
        }
        const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset');
        if (srcset) {
            const best = bestFromSrcset(srcset);
            if (best) return absUrl(best);
        }
        const src = (img.getAttribute('src') || '').trim();
        if (!src || (/^data:/i.test(src) && src.length < 200)) return ''; // 占位小图
        return /^data:/i.test(src) ? src : absUrl(src);
    }

    function renderImage(img) {
        const src = imageSrc(img);
        if (!src) return '';
        const alt = (img.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().replace(/[[\]\\]/g, '\\$&');
        return `![${alt}](${fmtUrl(src)}${fmtTitle(img.getAttribute('title'))})`;
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
            case 'PRE': return renderCodeBlock(el);
            case 'TABLE': return renderTable(el, ctx);
            case 'A': return finishInline(renderLink(el, ctx)); // 包着块元素的链接（卡片）压成一行
            case 'BLOCKQUOTE': {
                const inner = renderChildren(el, ctx).join('\n\n');
                return inner ? inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n') : '';
            }
        }
        return renderChildren(el, ctx).join('\n\n');
    }

    /** 内容里有反引号就用更长的围栏，且贴边的反引号要用空格隔开。 */
    function codeSpan(text) {
        text = text.replace(/\s+/g, ' ');
        if (!text.trim()) return text;
        const longest = Math.max(0, ...(text.match(/`+/g) || []).map(r => r.length));
        const fence = '`'.repeat(longest + 1);
        const pad = /^`|`$/.test(text) ? ' ' : '';
        return fence + pad + text + pad + fence;
    }

    /*
     * 行号。各家高亮器把行号塞进 <pre> 的方式都不一样，textContent 会把它们和代码拼在一起：
     *   Prism line-numbers   <code> 里多一个 span.line-numbers-rows（空 span，但删掉更稳）
     *   highlightjs-line-numbers  table.hljs-ln，每行 td.hljs-ln-numbers + td.hljs-ln-code
     *   CSDN                 <pre> 里多一个 ul.pre-numbering
     *   Hexo / Pygments      外层 table，td.gutter / td.linenos 是一整个装行号的 <pre>
     */
    const GUTTER_SELECTOR = [
        '.line-numbers-rows', '.hljs-ln-numbers', '.pre-numbering', 'td.gutter', 'td.linenos',
        '.linenodiv', 'span.linenos', 'span.lineno', '.line-number', '.code-line-number',
    ].join(',');

    /** <pre> 的文本：<br> 和逐行的块元素（div/p/li/tr）都要变成换行，只取 textContent 会把行粘在一起。 */
    function preText(pre) {
        let out = '';
        const walk = node => {
            for (const c of node.childNodes) {
                if (c.nodeType === 3) {
                    out += c.data;
                } else if (c.nodeType === 1) {
                    if (c.tagName === 'BR') { out += '\n'; continue; }
                    if (c.matches(GUTTER_SELECTOR) || SKIP_TAGS.has(c.tagName)) continue;
                    walk(c);
                    if (/^(DIV|P|LI|TR)$/.test(c.tagName) && out && !out.endsWith('\n')) out += '\n';
                }
            }
        };
        walk(pre);
        return out.replace(/\u00a0/g, ' ').replace(/^\n+|\s+$/g, '');
    }

    const LANG_STOP = new Set([
        'hljs', 'highlight', 'highlighter-rouge', 'line-numbers', 'linenums', 'prettyprint', 'notranslate',
        'code', 'source', 'sourcecode', 'codehilite', 'wrap', 'nowrap', 'copyable', 'block', 'pre', 'default',
    ]);
    const LANG_NONE = new Set(['none', 'nohighlight', 'plaintext', 'plain', 'text', 'txt']);

    function langFromEl(el) {
        const attr = el.getAttribute('data-lang') || el.getAttribute('data-language');
        if (attr) return attr;
        const cls = typeof el.className === 'string' ? el.className : '';
        if (!cls) return '';
        const m = cls.match(/(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/) || cls.match(/brush:\s*([\w+#-]+)/);
        if (m) return m[1];
        // `hljs python`、`highlight js`、`sourceCode python`：标记类旁边那个就是语言
        if (/(^|\s)(hljs|highlight|sourceCode)(\s|$)/.test(cls)) {
            const tok = cls.split(/\s+/).find(t => t && !LANG_STOP.has(t.toLowerCase()) && !/^hljs-/.test(t) && /^[a-z][\w+#.-]{0,19}$/i.test(t));
            if (tok) return tok;
        }
        return '';
    }

    function detectLang(pre) {
        const cands = [pre.querySelector('code'), pre];
        // 往上找几层：Hexo 的语言在 figure.highlight 上，中间隔着 table/tbody/tr/td
        for (let p = pre.parentElement, i = 0; p && i < 5; p = p.parentElement, i++) cands.push(p);
        for (const el of cands) {
            if (!el) continue;
            const lang = langFromEl(el).toLowerCase();
            if (lang) return LANG_NONE.has(lang) ? '' : lang;
        }
        return '';
    }

    function renderCodeBlock(pre) {
        const code = preText(pre);
        if (!code.trim()) return '';
        const longest = Math.max(0, ...(code.match(/`{3,}/g) || []).map(r => r.length));
        const fence = longest >= CONFIG.fence.length ? '`'.repeat(longest + 1) : CONFIG.fence;
        return `${fence}${detectLang(pre)}\n${code}\n${fence}`;
    }

    /*
     * GFM 表格。单元格里的 `|` 必须转义成 `\|` —— 连行内代码里的也要，因为 GFM 是先按 `|` 切列
     * 再解析行内语法的；换行只能写成 <br>，否则整行表格断掉。
     * 带 <pre>、嵌套表格或只有一列的表格多半是排版用的（Hexo 代码块、老站布局），直接展开内容。
     */
    function renderTable(table, ctx) {
        const rows = [...table.rows];
        if (!rows.length) return '';
        const isLayout = table.querySelector('pre, table') || rows.every(r => r.cells.length <= 1);
        if (isLayout) return renderChildren(table, ctx).join('\n\n');

        const grid = [];
        const align = [];
        for (const tr of rows) {
            const cells = [];
            for (const td of tr.cells) {
                if (grid.length === 0) align[cells.length] = cellAlign(td);
                cells.push(cellText(td, ctx));
                const span = Math.min(parseInt(td.getAttribute('colspan'), 10) || 1, 50);
                for (let i = 1; i < span; i++) cells.push('');
            }
            grid.push(cells);
        }
        const cols = Math.max(...grid.map(r => r.length));
        const line = cells => '| ' + Array.from({ length: cols }, (_, i) => cells[i] || '').join(' | ') + ' |';
        const sep = Array.from({ length: cols }, (_, i) => {
            const a = align[i];
            return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
        });
        // 没有 thead 也只能拿第一行当表头，GFM 表格必须有表头
        return [line(grid[0]), '| ' + sep.join(' | ') + ' |', ...grid.slice(1).map(line)].join('\n');
    }

    function cellAlign(td) {
        const a = (td.getAttribute('align') || td.style.textAlign || '').toLowerCase();
        return /^(left|center|right)$/.test(a) ? a : '';
    }

    function cellText(td, ctx) {
        return renderChildren(td, ctx).join('\n')
            .replace(/\\\n/g, '<br>')
            .replace(/\n+/g, '<br>')
            .replace(/\|/g, '\\|')
            .trim();
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
        // 页面作者已经用唯一的 <article> 标出了正文时信它：正文短、表格多的页面，
        // 最高分常常落在 article 里的某个单元格上，兄弟合并又捞不回分数低的表格和列表
        const art = top.closest('article, [itemprop="articleBody"]');
        if (art && art !== top && doc.querySelectorAll('article').length <= 1 && !unlikely(art) && linkDensity(art) < 0.5) {
            top = art;
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
        for (const el of root.querySelectorAll(GUTTER_SELECTOR)) el.remove();
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
    // 输出：front-matter / 文件名 / 下载
    // =========================================================================

    /** JSON-LD 里的 Article（可能套在数组或 @graph 里）。 */
    function jsonLdArticle() {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            let data;
            try { data = JSON.parse(s.textContent); } catch (e) { continue; }
            const stack = [data];
            while (stack.length) {
                const o = stack.pop();
                if (!o || typeof o !== 'object') continue;
                if (Array.isArray(o)) { stack.push(...o); continue; }
                if (o['@graph']) stack.push(o['@graph']);
                const type = [].concat(o['@type'] || []).join(' ');
                if (/Article|BlogPosting|Report|Posting/.test(type) || o.headline) return o;
            }
        }
        return {};
    }

    function ldAuthor(a) {
        if (!a) return '';
        if (typeof a === 'string') return a;
        if (Array.isArray(a)) return a.map(ldAuthor).filter(Boolean).join(', ');
        return a.name || '';
    }

    function pageMeta() {
        const pick = sel => {
            const el = document.querySelector(sel);
            if (!el) return '';
            return (el.getAttribute('content') || el.getAttribute('datetime') || el.textContent || '').replace(/\s+/g, ' ').trim();
        };
        const ld = jsonLdArticle();
        // article:author 经常是作者主页 URL，不是名字
        const ogAuthor = pick('meta[property="article:author"]');
        return {
            title: pick('meta[property="og:title"]') || (typeof ld.headline === 'string' ? ld.headline : '') ||
                document.title.trim() || pick('h1'),
            url: location.href,
            author: pick('meta[name="author"]') || ldAuthor(ld.author) || (/^https?:/.test(ogAuthor) ? '' : ogAuthor) ||
                pick('[itemprop="author"] [itemprop="name"]') || pick('[rel="author"]'),
            date: pick('meta[property="article:published_time"]') || ld.datePublished ||
                pick('meta[itemprop="datePublished"]') || pick('meta[name="publishdate"]') || pick('meta[name="pubdate"]') ||
                pick('meta[name="date"]') || pick('time[datetime]'),
        };
    }

    /** 本地时间带时区偏移，toISOString() 是 UTC，读起来差 8 小时。 */
    function localIso(d = new Date()) {
        const pad = n => String(Math.abs(n)).padStart(2, '0');
        const off = -d.getTimezoneOffset();
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
            `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
    }

    /** 一律加双引号：标题里的 `: `、`#`、开头的 `[` 都会让不加引号的 YAML 解析出错。 */
    function yamlStr(s) {
        return '"' + String(s).replace(/[\u0000-\u001f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }

    /** hasH1 看 DOM 而不是在 Markdown 里搜 `# `：代码块里的 shell 注释也是 `# ` 开头。 */
    function buildDocument(body, meta, hasH1) {
        let out = body.trim();
        if (CONFIG.titleHeading && meta.title && !hasH1) {
            out = '# ' + escapeText(meta.title.replace(/\s+/g, ' ')) + '\n\n' + out;
        }
        if (CONFIG.frontMatter) {
            const fm = ['---', `title: ${yamlStr(meta.title)}`, `url: ${yamlStr(meta.url)}`];
            if (meta.author) fm.push(`author: ${yamlStr(meta.author)}`);
            if (meta.date) fm.push(`date: ${yamlStr(meta.date)}`);
            fm.push(`captured: ${yamlStr(localIso())}`, '---');
            out = fm.join('\n') + '\n\n' + out;
        }
        return out + '\n';
    }

    /** Windows 非法字符、控制字符、首尾的点和空格、保留设备名（CON、NUL…）都要处理。 */
    function safeFileName(s) {
        let n = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
            .replace(/^[.\s]+|[.\s]+$/g, '');
        // 按码点截断，别把 emoji 的代理对切成半个
        if ([...n].length > CONFIG.maxNameLen) n = [...n].slice(0, CONFIG.maxNameLen).join('').replace(/[.\s]+$/, '');
        if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n += '_';
        return n || 'page';
    }

    /*
     * 先走 GM_download，失败再退回 <a download>。
     * Tampermonkey 的 GM_download 受「下载」设置里的扩展名白名单约束（.md 未必在内），被拒是回调 onerror
     * 而不是抛异常，所以退路挂在 onerror 和 catch 两处（未在真实 Tampermonkey 上实测被拒的情形）。
     * Blob URL 延迟回收：GM_download 是异步取数据的，立即 revoke 会下载到空文件。
     */
    function downloadText(text, name) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        const viaAnchor = () => {
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
        };
        if (typeof GM_download === 'function') {
            try {
                GM_download({
                    url, name,
                    onerror: e => {
                        console.warn(TAG, 'GM_download 失败，改用 <a download>：', e && (e.error || e));
                        viaAnchor();
                    },
                });
                return;
            } catch (e) {
                console.warn(TAG, 'GM_download 不可用：', e);
            }
        }
        viaAnchor();
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

    /** 转换并输出。action: 'copy' | 'download'。 */
    function output(root, action) {
        const body = htmlToMarkdown(root);
        if (!body.trim()) {
            toast('没有提取到内容');
            return;
        }
        const meta = pageMeta();
        const md = buildDocument(body, meta, !!root.querySelector('h1'));
        if (action === 'download') {
            const name = safeFileName(meta.title) + '.md';
            downloadText(md, name);
            toast(`已下载 ${name}`);
        } else {
            GM_setClipboard(md, 'text');
            toast(`已复制 Markdown（${md.length} 字）`);
        }
        console.log(TAG, action, md.length, '字');
    }

    function convertPage(action) {
        try {
            output(cloneForConvert(findContent()), action);
        } catch (e) {
            console.error(TAG, e);
            toast('转换失败：' + e.message);
        }
    }

    GM_registerMenuCommand('复制正文为 Markdown', () => convertPage('copy'));
    GM_registerMenuCommand('下载正文为 Markdown', () => convertPage('download'));
})();
