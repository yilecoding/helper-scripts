// ==UserScript==
// @name         网页变化监控
// @name:zh-CN   网页变化监控
// @name:en      Page Monitor — Watch Any Part of a Page for Changes
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.10.01.8
// @description  选中页面上的一块区域（价格、库存、公告、成绩、工单状态），内容变化时通知你。
// @description:zh-CN  选中页面上的一块区域（价格、库存、公告、成绩、工单状态），内容变化时通知你。
// @description:en  Pick any part of a page (price, stock, notice, grades, ticket status) and get notified when it changes.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @connect      self
// @license      CC BY-NC-SA
// @run-at       document-idle
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/page-monitor/page-monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/page-monitor/page-monitor.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「网页监控」只看本脚本。 */
    const TAG = '[网页监控]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        defaultInterval: 300,   // 秒。新监控项的检查间隔
        minInterval: 30,        // 秒。再短就是在给对方服务器施压了
        maxTextLength: 4000,    // 快照文字上限（存 GM，历史里每条存新旧两份）
        previewLength: 60,      // 列表 / 提示里显示的文字长度
        tickMs: 5000,           // 调度器多久看一次「谁到点了」
        requestTimeout: 20000,  // 抓取超时（毫秒）
        historySize: 20,        // 每个监控项保留最近多少条变化
        diffMaxCells: 1500000,  // 逐词 diff 的 LCS 表上限（词数之积），超了退化成整段替换
        observeDebounce: 1000,  // 本页观察：DOM 安静这么久再取文字比较（毫秒）
        observeMaxWait: 5000,   // 本页观察：持续变化时最多拖这么久也要比较一次
        leaseConfirmMs: 300,    // 认领一次检查后等这么久再读回来确认，别的标签同时认领时以最后写入的为准
        maxBackoff: 3600,       // 秒。连续失败时间隔翻倍，最多拉长到这么久（间隔本身更长的不受影响）
        failNotifyAfter: 3,     // 连续失败这么多次发一条通知：选择器失效了用户不开面板也该知道
    };

    const HOST_ID = 'page-monitor-host';
    /** 本标签页的身份，认领检查时写进存储。 */
    const TAB_ID = Math.random().toString(36).slice(2, 10);

    // =========================================================================
    // 存储：每个监控项一个键（mon:<id>）
    // =========================================================================

    /**
     * 不把所有监控项存成一个数组：同一 URL 开着几个标签时，每个标签都在写自己检查的那一项，
     * 整个数组读改写会互相覆盖（A 标签写回的数组里带着 B 标签改之前的旧值）。
     * 一项一个键，各写各的。
     */
    const Store = (() => {
        const PREFIX = 'mon:';

        function all() {
            return GM_listValues()
                .filter((k) => k.startsWith(PREFIX))
                .map((k) => GM_getValue(k, null))
                .filter(Boolean)
                .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
        }

        function get(id) {
            return GM_getValue(PREFIX + id, null);
        }

        function save(mon) {
            GM_setValue(PREFIX + mon.id, mon);
            return mon;
        }

        function patch(id, fields) {
            const cur = get(id);
            if (!cur) return null;
            return save({ ...cur, ...fields });
        }

        function remove(id) {
            GM_deleteValue(PREFIX + id);
        }

        return { all, get, save, patch, remove };
    })();

    /** 监控项按「去掉 hash 的 URL」归属页面：hash 多半是锚点或前端路由的小状态。 */
    function pageUrl(href = location.href) {
        const u = new URL(href);
        u.hash = '';
        return u.href;
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // =========================================================================
    // 文本
    // =========================================================================

    const Text = (() => {
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG']);
        const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

        /**
         * 不用 innerText：抓取型检查拿到的是 DOMParser 解析出来的文档，没有布局，
         * innerText 在那里退化成 textContent（连 <script> 的内容都算进去）。
         * 基线是在活页面上取的、比较时是在解析文档上取的，两边必须走同一套规则，
         * 否则第一次检查就报「变了」。所以自己走一遍 DOM：跳过脚本样式，块级元素前后补空格
         * （压缩过的 HTML 里 <li>A</li><li>B</li> 中间没有空白，textContent 会粘成「AB」）。
         */
        function of(el) {
            const parts = [];
            (function walk(node) {
                for (let n = node.firstChild; n; n = n.nextSibling) {
                    if (n.nodeType === 3) parts.push(n.data);
                    else if (n.nodeType === 1) {
                        if (SKIP.has(n.tagName) || n.id === HOST_ID) continue;
                        const block = BLOCK.test(n.tagName);
                        if (block) parts.push(' ');
                        walk(n);
                        if (block) parts.push(' ');
                    }
                }
            })(el);
            return parts.join('');
        }

        function normalize(text) {
            return String(text || '').replace(/\s+/g, ' ').trim().slice(0, CONFIG.maxTextLength);
        }

        function preview(text, n = CONFIG.previewLength) {
            const s = normalize(text);
            return s.length > n ? s.slice(0, n - 1) + '…' : s;
        }

        return { of, normalize, preview };
    })();

    // =========================================================================
    // 比较规则：噪声、关键词、数字阈值
    // =========================================================================

    const Rules = (() => {
        /**
         * 噪声：每行一个正则，匹配到的部分在比较前删掉（「更新于 09:12」「浏览 1234 次」）。
         * 写成 /…/i 带标志也行。只在比较时去掉，存储和显示的仍是原文。
         */
        function parseNoise(src) {
            const list = [];
            const errors = [];
            for (const line of String(src || '').split('\n')) {
                const raw = line.trim();
                if (!raw) continue;
                const m = /^\/(.+)\/([a-z]*)$/.exec(raw);
                try {
                    const flags = m ? m[2].replace(/g/g, '') + 'g' : 'g';
                    list.push(new RegExp(m ? m[1] : raw, flags));
                } catch (e) {
                    errors.push(`${raw}：${e.message}`);
                }
            }
            return { list, errors };
        }

        /** 比较用的文字：去噪声后再折叠一次空白（删掉中间一段会留下两个空格）。 */
        function clean(text, mon) {
            let s = Text.normalize(text);
            for (const re of parseNoise(mon.noise).list) s = s.replace(re, ' ');
            return Text.normalize(s);
        }

        /**
         * 取文字里的第一个数字。千分位逗号只认「逗号后正好三位」，
         * 免得把「3,4 号楼」读成 34。负号兼容全角减号。
         */
        function firstNumber(text) {
            const m = /[-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-−]?\d+(?:\.\d+)?/.exec(text || '');
            return m ? Number(m[0].replace(/,/g, '').replace('−', '-')) : null;
        }

        /** 阈值写法：「10」= 变化至少 10；「5%」= 变化至少 5%。空 = 不限。 */
        function parseThreshold(src) {
            const m = /^\s*(\d+(?:\.\d+)?)\s*(%?)\s*$/.exec(String(src || ''));
            if (!m) return null;
            return { value: Number(m[1]), percent: !!m[2] };
        }

        /**
         * 这次变化要不要通知。ref 是「上次通知时的文字」而不是上次检查的：
         * 价格每次跌 1 块、阈值 5 块时，和上次检查比永远不够 5，和上次通知比才会在累计够 5 时响。
         */
        function shouldNotify(mon, refText, newText) {
            const kw = mon.keyword || {};
            const word = (kw.text || '').trim().toLowerCase();
            if (word && kw.mode !== 'any') {
                const has = clean(newText, mon).toLowerCase().includes(word);
                if (kw.mode === 'contains' && !has) return { ok: false, reason: `不含「${kw.text}」` };
                if (kw.mode === 'excludes' && has) return { ok: false, reason: `含有「${kw.text}」` };
            }
            const thr = parseThreshold(mon.threshold);
            if (thr) {
                const a = firstNumber(clean(refText, mon));
                const b = firstNumber(clean(newText, mon));
                // 数字出现或消失（「缺货」↔「¥99」）本身就值得说一声
                if (a !== null && b !== null) {
                    const diff = Math.abs(b - a);
                    const enough = thr.percent ? (a === 0 ? diff > 0 : (diff / Math.abs(a)) * 100 >= thr.value) : diff >= thr.value;
                    if (!enough) return { ok: false, reason: `数字变化 ${a} → ${b} 未达阈值 ${mon.threshold}` };
                }
            }
            return { ok: true };
        }

        return { parseNoise, clean, firstNumber, parseThreshold, shouldNotify };
    })();

    // =========================================================================
    // 逐词 diff（LCS）
    // =========================================================================

    const Diff = (() => {
        /**
         * 分词：英文单词 / 数字（带小数点、千分位）算一个词，汉字一个字一个词，空白一段算一个词，
         * 其余符号一个一个算。中文没有空格，按「词」切需要词典，按字切对「周末 → 今日」这种短改动已经够看。
         */
        const TOKEN = /[A-Za-z0-9_]+(?:[.,][0-9]+)*|\s+|[^]/gu;

        function tokens(s) {
            return String(s || '').match(TOKEN) || [];
        }

        function push(out, type, text) {
            const last = out[out.length - 1];
            if (last && last.type === type) last.text += text;
            else out.push({ type, text });
        }

        /**
         * 先剥掉相同的头尾（监控的文字通常只改一小段，剥完 LCS 表就很小），
         * 中间段用 LCS 表从后往前填、从前往后走。相同长度时先删后加，读起来是「旧 → 新」。
         */
        function words(oldText, newText) {
            const a = tokens(oldText);
            const b = tokens(newText);
            let start = 0;
            while (start < a.length && start < b.length && a[start] === b[start]) start++;
            let endA = a.length;
            let endB = b.length;
            while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

            const out = [];
            if (start) push(out, 'eq', a.slice(0, start).join(''));
            const x = a.slice(start, endA);
            const y = b.slice(start, endB);
            const n = x.length;
            const m = y.length;
            if (n * m > CONFIG.diffMaxCells) {
                if (n) push(out, 'del', x.join(''));
                if (m) push(out, 'ins', y.join(''));
            } else if (n || m) {
                const w = m + 1;
                const dp = new Uint32Array((n + 1) * w);
                for (let i = n - 1; i >= 0; i--) {
                    for (let j = m - 1; j >= 0; j--) {
                        dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
                    }
                }
                let i = 0;
                let j = 0;
                while (i < n && j < m) {
                    if (x[i] === y[j]) { push(out, 'eq', x[i]); i++; j++; }
                    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) push(out, 'del', x[i++]);
                    else push(out, 'ins', y[j++]);
                }
                while (i < n) push(out, 'del', x[i++]);
                while (j < m) push(out, 'ins', y[j++]);
            }
            if (endA < a.length) push(out, 'eq', a.slice(endA).join(''));
            return out;
        }

        return { words };
    })();

    // =========================================================================
    // 稳定选择器
    // =========================================================================

    const Selector = (() => {
        /** 框架 / 组件库自动生成的 id 前缀：每次渲染都可能变。 */
        const GENERATED_ID = /^(?:ember\d|ext-gen|yui_|ui-id-|react-|radix-|headlessui-|mui-|rc[-_]|el-id-|vue-|ng-|j_id|__next|gwt-)/i;
        /** 状态类名：悬停、选中、展开时才有，刷新后就不一定在了。 */
        const STATE_CLASS = /^(?:is-|has-|js-)|^(?:active|current|selected|hover|focus|focused|open|opened|show|shown|visible|hidden|in|on|checked|disabled|loading|loaded|fade|collapsed|expanded)$/i;

        /** 一串字符里「字母和数字交替」的次数，随机串交替得多，正常单词几乎不交替。 */
        function alternations(s) {
            let n = 0;
            for (let i = 1; i < s.length; i++) {
                if (/\d/.test(s[i]) !== /\d/.test(s[i - 1])) n++;
            }
            return n;
        }

        /**
         * 疑似随机：哈希串、UUID、带冒号的 React useId（:r1:）、长数字流水号、框架前缀。
         * 宁可错杀：错杀的代价只是选择器长一点，放过一个随机 id 的代价是下次刷新就找不到元素。
         */
        function looksRandom(s) {
            if (!s || s.length > 40) return true;
            if (/[:\s]/.test(s)) return true;
            if (GENERATED_ID.test(s)) return true;
            if (/\d{4,}/.test(s)) return true;
            if (/[0-9a-f]{8,}/i.test(s) && /\d/.test(s) && /[a-f]/i.test(s)) return true;
            if (alternations(s) >= 3) return true;
            return false;
        }

        function stableClasses(el) {
            return Array.from(el.classList)
                .filter((c) => !looksRandom(c) && !STATE_CLASS.test(c))
                // CSS Modules / styled-components / emotion：Price_value__3xYz1、sc-bdVaJa、css-1a2b3c
                .filter((c) => !/__[\w-]{4,}$|^sc-|^css-|^jsx-/.test(c))
                .slice(0, 2);
        }

        function uniqueIn(doc, sel, el) {
            try {
                const hit = doc.querySelectorAll(sel);
                return hit.length === 1 && hit[0] === el;
            } catch (e) {
                return false;
            }
        }

        function idSel(el) {
            const id = el.getAttribute('id');
            if (!id || looksRandom(id)) return null;
            const sel = '#' + CSS.escape(id);
            return uniqueIn(el.ownerDocument, sel, el) ? sel : null;
        }

        /**
         * 兄弟里有同标签同类名的才加 :nth-of-type。类名已经能区分开的就不加序号：
         * 序号是最脆的部分，前面插一个同类元素就全错位。
         */
        function step(el) {
            const tag = el.tagName.toLowerCase();
            const classes = stableClasses(el);
            let s = tag + classes.map((c) => '.' + CSS.escape(c)).join('');
            const parent = el.parentElement;
            if (parent) {
                const twins = Array.from(parent.children).filter((c) => c !== el && c.tagName === el.tagName
                    && classes.every((k) => c.classList.contains(k)));
                if (twins.length) {
                    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
                    s += `:nth-of-type(${same.indexOf(el) + 1})`;
                }
            }
            return s;
        }

        /**
         * 自己有稳定 id 就用 id；否则从元素往上逐级拼「标签 + 稳定类名 + :nth-of-type」，
         * 遇到有稳定 id 的祖先就停下，以它为根。每拼一级就试一次唯一性，够唯一就不再往上，
         * 路径越短，页面结构小改时越不容易失效。
         */
        function of(el) {
            const own = idSel(el);
            if (own) return own;
            const doc = el.ownerDocument;
            const parts = [];
            for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
                if (cur !== el) {
                    const anchor = idSel(cur);
                    if (anchor) {
                        const sel = anchor + ' > ' + parts.join(' > ');
                        if (uniqueIn(doc, sel, el)) return sel;
                    }
                }
                if (cur.tagName === 'BODY' || cur.tagName === 'HTML') {
                    parts.unshift(cur.tagName.toLowerCase());
                    break;
                }
                parts.unshift(step(cur));
                const sel = parts.join(' > ');
                if (uniqueIn(doc, sel, el)) return sel;
            }
            return parts.join(' > ');
        }

        return { of, looksRandom };
    })();

    // =========================================================================
    // 界面（shadow DOM）：拾取高亮、确认条、提示
    // =========================================================================

    const CSS_TEXT = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .ui { font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; }
        .hl {
            position: fixed; z-index: 2147483646; pointer-events: none; display: none;
            border: 2px solid #2563eb; background: rgba(37, 99, 235, .12); border-radius: 3px;
            transition: all .05s;
        }
        .hl.picked { border-color: #16a34a; background: rgba(22, 163, 74, .14); }
        .bar {
            position: fixed; z-index: 2147483647; left: 50%; bottom: 16px; transform: translateX(-50%);
            max-width: min(640px, calc(100vw - 32px)); padding: 10px 12px; border-radius: 10px;
            background: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.18); border: 1px solid #d0d7de;
        }
        .bar .tip { color: #57606a; }
        .bar .sel { font: 12px/1.4 ui-monospace, Consolas, monospace; color: #0550ae; word-break: break-all; margin: 4px 0; }
        .bar .text { color: #1f2328; margin: 4px 0 8px; max-height: 4.5em; overflow: hidden; word-break: break-all; }
        .bar .row { display: flex; gap: 6px; flex-wrap: wrap; }
        button {
            font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid #d0d7de;
            background: #f6f8fa; color: #1f2328; cursor: pointer;
        }
        button:hover { background: #eef1f4; }
        button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
        button:disabled { opacity: .5; cursor: default; }
        .toast {
            position: fixed; z-index: 2147483647; right: 16px; bottom: 60px; padding: 8px 12px; border-radius: 8px;
            background: #1f2328; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.2); max-width: 360px;
        }
        .badge {
            position: fixed; z-index: 2147483645; right: 16px; bottom: 16px; height: 28px; padding: 0 10px;
            border-radius: 14px; border: 1px solid #d0d7de; background: #fff; color: #57606a; cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,.12); display: flex; align-items: center; gap: 4px; font-size: 12px;
        }
        .badge.unread { background: #dc2626; border-color: #dc2626; color: #fff; }
        .badge.failing { background: #fff8c5; border-color: #d4a72c; color: #7d4e00; }
        .panel {
            position: fixed; z-index: 2147483646; right: 16px; top: 16px; width: 400px; max-width: calc(100vw - 32px);
            max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: #fff;
            border: 1px solid #d0d7de; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.2);
        }
        .panel .head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #eaeef2; }
        .panel .head .title { font-weight: 600; flex: 1; }
        .panel .list { overflow: auto; padding: 4px 0; }
        .panel .empty { padding: 16px; color: #57606a; text-align: center; }
        .item { padding: 8px 10px; border-bottom: 1px solid #f0f2f4; }
        .item.off { opacity: .6; }
        .item .name { display: flex; gap: 6px; align-items: baseline; }
        .item .name a { color: #0969da; text-decoration: none; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .item .tag { font-size: 11px; padding: 0 6px; border-radius: 8px; background: #eef1f4; color: #57606a; white-space: nowrap; }
        .item .tag.new { background: #dc2626; color: #fff; }
        .item .sel { font: 11px/1.4 ui-monospace, Consolas, monospace; color: #57606a; word-break: break-all; }
        .item .value { margin: 4px 0; word-break: break-all; }
        .item .meta { font-size: 12px; color: #57606a; }
        .item .err { font-size: 12px; color: #cf222e; word-break: break-all; }
        .item .ctl { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 6px; font-size: 12px; }
        .item .ctl input[type=number] { width: 64px; font: inherit; padding: 1px 4px; }
        .item button { padding: 1px 8px; font-size: 12px; }
        button.danger { color: #cf222e; }
        .rules { margin-top: 6px; padding: 8px; border-radius: 6px; background: #f6f8fa; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
        .rules textarea, .rules input, .rules select { font: 12px/1.4 ui-monospace, Consolas, monospace; padding: 2px 4px; border: 1px solid #d0d7de; border-radius: 4px; }
        .rules textarea { width: 100%; resize: vertical; }
        .rules .line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .rules .hint { color: #57606a; }
        .history { margin-top: 6px; max-height: 260px; overflow: auto; border-top: 1px dashed #d0d7de; }
        .hist { padding: 6px 0; border-bottom: 1px dashed #eaeef2; }
        .hist .muted { color: #9a6700; }
        .diff { word-break: break-all; white-space: pre-wrap; }
        .diff del { background: #ffebe9; color: #82071e; text-decoration: line-through; }
        .diff ins { background: #dafbe1; color: #116329; text-decoration: none; }
    `;

    const UI = (() => {
        let host = null;
        let root = null;

        function ensure() {
            if (host && host.isConnected) return root;
            host = document.createElement('div');
            host.id = HOST_ID;
            root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = CSS_TEXT;
            const ui = document.createElement('div');
            ui.className = 'ui';
            root.append(style, ui);
            document.documentElement.appendChild(host);
            return root;
        }

        function layer() {
            return ensure().querySelector('.ui');
        }

        function el(tag, attrs = {}, children = []) {
            const n = document.createElement(tag);
            for (const [k, v] of Object.entries(attrs)) {
                if (k === 'text') n.textContent = v;
                else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
                else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
            }
            for (const c of [].concat(children)) if (c) n.append(c);
            return n;
        }

        let toastTimer = 0;
        function toast(text, ms = 3000) {
            const l = layer();
            let t = l.querySelector('.toast');
            if (!t) l.append((t = el('div', { class: 'toast' })));
            t.textContent = text;
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => t.remove(), ms);
        }

        function isOwn(node) {
            return !!host && (node === host || host.contains(node));
        }

        return { layer, el, toast, isOwn };
    })();

    // =========================================================================
    // 拾取模式
    // =========================================================================

    const Picker = (() => {
        let active = false;
        let hovered = null;
        let picked = null;
        let hl = null;
        let bar = null;

        function place(target) {
            if (!target) {
                hl.style.display = 'none';
                return;
            }
            const r = target.getBoundingClientRect();
            Object.assign(hl.style, {
                display: 'block', left: r.left - 2 + 'px', top: r.top - 2 + 'px',
                width: r.width + 4 + 'px', height: r.height + 4 + 'px',
            });
        }

        function pickable(node) {
            return node && node.nodeType === 1 && !UI.isOwn(node) && node !== document.documentElement && node !== document.body;
        }

        function renderBar() {
            bar.textContent = '';
            if (!picked) {
                bar.append(UI.el('div', { class: 'tip', text: '移动鼠标选择要监控的区域，点击选中 · ↑ 扩到父元素 · Esc 退出' }));
                return;
            }
            const text = Text.normalize(Text.of(picked));
            bar.append(
                UI.el('div', { class: 'sel', text: Selector.of(picked) }),
                UI.el('div', { class: 'text', text: text ? Text.preview(text, 200) : '（这块区域没有文字，监控不到变化）' }),
                UI.el('div', { class: 'row' }, [
                    UI.el('button', { 'data-act': 'parent', text: '↑ 父元素', onclick: () => expand() }),
                    UI.el('button', { 'data-act': 'repick', text: '重新选', onclick: () => { picked = null; hl.classList.remove('picked'); renderBar(); } }),
                    UI.el('button', {
                        'data-act': 'save-fetch', class: 'primary', text: '定时抓取检查', disabled: !text,
                        title: '页面开着时按间隔在后台重新抓这个网址，不刷新、不打扰当前页面',
                        onclick: () => save('fetch'),
                    }),
                    UI.el('button', {
                        'data-act': 'save-observe', text: '在本页内观察', disabled: !text,
                        title: '内容由 JS 渲染、抓 HTML 拿不到时用：直接盯着当前页面上的这块元素',
                        onclick: () => save('observe'),
                    }),
                    UI.el('button', { 'data-act': 'cancel', text: '取消', onclick: () => stop() }),
                ]),
            );
        }

        function expand() {
            const cur = picked || hovered;
            const up = cur && cur.parentElement;
            if (!pickable(up)) return;
            if (picked) {
                picked = up;
                renderBar();
            } else hovered = up;
            place(up);
        }

        function save(mode) {
            const el = picked;
            const text = Text.normalize(Text.of(el));
            const mon = Store.save({
                id: newId(),
                url: pageUrl(),
                title: document.title || location.hostname,
                selector: Selector.of(el),
                mode,
                interval: CONFIG.defaultInterval,
                enabled: true,
                baseline: text,
                lastValue: text,
                createdAt: Date.now(),
            });
            console.info(TAG, '新增监控', mon.selector, Text.preview(text));
            stop();
            UI.toast('已开始监控：' + Text.preview(text, 30));
            Panel.refresh();
            if (mode === 'fetch') Checker.calibrate(mon.id);
            else Observer.sync();
            return mon;
        }

        // 拾取期间吞掉页面的点击类事件：点的是链接 / 按钮时不能真的跳转或触发站点逻辑
        function swallow(e) {
            if (UI.isOwn(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }

        function onMove(e) {
            if (picked || UI.isOwn(e.target)) return;
            const t = e.target;
            if (!pickable(t) || t === hovered) return;
            hovered = t;
            place(t);
        }

        function onClick(e) {
            if (UI.isOwn(e.target)) return;
            swallow(e);
            if (picked) return;
            const t = pickable(e.target) ? e.target : hovered;
            if (!t) return;
            picked = t;
            hl.classList.add('picked');
            place(t);
            renderBar();
        }

        function onKey(e) {
            if (e.key === 'Escape') {
                swallow(e);
                stop();
            } else if (e.key === 'ArrowUp') {
                swallow(e);
                expand();
            }
        }

        function onScroll() {
            place(picked || hovered);
        }

        const SWALLOW = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'];

        function start() {
            if (active) return;
            active = true;
            hovered = picked = null;
            const layer = UI.layer();
            hl = UI.el('div', { class: 'hl' });
            bar = UI.el('div', { class: 'bar', 'data-role': 'picker' });
            layer.append(hl, bar);
            renderBar();
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('click', onClick, true);
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('scroll', onScroll, true);
            SWALLOW.forEach((t) => document.addEventListener(t, swallow, true));
        }

        function stop() {
            if (!active) return;
            active = false;
            hl.remove();
            bar.remove();
            hovered = picked = null;
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onScroll, true);
            SWALLOW.forEach((t) => document.removeEventListener(t, swallow, true));
        }

        return { start, stop, isActive: () => active };
    })();

    // =========================================================================
    // 抓取与比较
    // =========================================================================

    /**
     * GM_xmlhttpRequest 的 Promise 包装。超时自己计时：
     * 不同管理器对 timeout/ontimeout 的支持不一致，不兜底的话请求可能永远挂着。
     * 默认带 cookie（不设 anonymous），成绩、工单这类要登录的页面才抓得到。
     */
    function request(url) {
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (fn, arg) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                fn(arg);
            };
            const req = GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
                timeout: CONFIG.requestTimeout,
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) finish(resolve, r.responseText || '');
                    else finish(reject, new Error(`HTTP ${r.status}`));
                },
                onerror: () => finish(reject, new Error('网络错误')),
                ontimeout: () => finish(reject, new Error('请求超时')),
            });
            const timer = setTimeout(() => {
                try { req && req.abort && req.abort(); } catch (e) { /* 已结束 */ }
                finish(reject, new Error('请求超时'));
            }, CONFIG.requestTimeout + 1000);
        });
    }

    /** 抓 mon.url，按选择器取出规范化后的文字。找不到元素就抛错，不当成「变成了空」。 */
    async function fetchText(mon) {
        const html = await request(mon.url);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        let el = null;
        try {
            el = doc.querySelector(mon.selector);
        } catch (e) {
            throw new Error('选择器无效：' + mon.selector);
        }
        if (!el) throw new Error('抓到的页面里找不到这个元素（页面改版、登录失效，或内容由 JS 渲染）');
        return Text.normalize(Text.of(el));
    }

    const Notify = (() => {
        function failing(mon) {
            if (typeof GM_notification !== 'function') return;
            GM_notification({
                title: '网页监控失效：' + Text.preview(mon.title, 30),
                text: `连续 ${mon.failCount} 次检查失败：${mon.error}`,
                onclick: () => { window.focus(); Panel.open(); },
            });
        }

        function change(mon, oldText, newText) {
            const title = '网页变化：' + Text.preview(mon.title, 30);
            const text = `${Text.preview(oldText, 40) || '（空）'}\n→ ${Text.preview(newText, 80) || '（空）'}`;
            if (typeof GM_notification !== 'function') return;
            GM_notification({
                title,
                text,
                // 抓取型的标签页内容是旧的（脚本不刷新它），点通知开一个新标签看最新内容；
                // 本页观察的变化就在这个标签页上，回到它就行
                onclick: () => {
                    if (mon.mode === 'observe' && pageUrl() === mon.url) window.focus();
                    else GM_openInTab(mon.url, { active: true, setParent: true });
                },
            });
        }
        return { change, failing };
    })();

    const Checker = (() => {
        /** 每次都从存储里重新读：别的标签、面板操作随时可能改了它。 */
        function apply(id, text) {
            const mon = Store.get(id);
            if (!mon) return null;
            const now = Date.now();
            const ok = { lastCheck: now, status: 'ok', error: '', failCount: 0 };
            if (text === mon.lastValue) return Store.patch(id, ok);
            // 只有空白 / 噪声变了：更新显示用的原文，不算变化
            if (Rules.clean(text, mon) === Rules.clean(mon.lastValue, mon)) return Store.patch(id, { ...ok, lastValue: text });

            const ref = mon.notifiedValue !== undefined ? mon.notifiedValue : mon.baseline;
            const verdict = Rules.shouldNotify(mon, ref, text);
            const entry = { t: now, old: mon.lastValue, new: text, notified: verdict.ok };
            if (!verdict.ok) entry.reason = verdict.reason;
            Store.patch(id, {
                ...ok,
                lastValue: text, lastChange: now,
                history: [entry, ...(mon.history || [])].slice(0, CONFIG.historySize),
                ...(verdict.ok ? { notifiedValue: text, unread: (mon.unread || 0) + 1 } : {}),
            });
            console.info(TAG, '检测到变化', mon.selector, Text.preview(mon.lastValue), '→', Text.preview(text),
                verdict.ok ? '' : `（不通知：${verdict.reason}）`);
            if (verdict.ok) Notify.change(mon, mon.lastValue, text);
            return Store.get(id);
        }

        /** 失败不吞：状态和原因写进存储（面板、角标显示），连续失败计数用来退避。 */
        function fail(id, err) {
            const mon = Store.get(id);
            if (!mon) return null;
            const failCount = (mon.failCount || 0) + 1;
            const error = String((err && err.message) || err);
            console.warn(TAG, '检查失败', mon.selector, `第 ${failCount} 次`, error);
            const next = Store.patch(id, { lastCheck: Date.now(), status: 'error', error, failCount });
            if (failCount === CONFIG.failNotifyAfter) Notify.failing(next);
            return next;
        }

        async function check(id) {
            const mon = Store.get(id);
            if (!mon) return null;
            let result;
            try {
                result = apply(id, mon.mode === 'observe' ? Observer.read(mon) : await fetchText(mon));
            } catch (e) {
                result = fail(id, e);
            }
            Panel.refresh();
            return result;
        }

        /**
         * 新建后马上抓一次，把基线换成「抓下来的版本」。活页面上看到的文字和服务器直出的 HTML
         * 不一定一样（站点脚本改过、懒加载补过），不校准的话第一次定时检查就会报一个假变化。
         */
        async function calibrate(id) {
            const mon = Store.get(id);
            if (!mon) return null;
            let result;
            try {
                const text = await fetchText(mon);
                result = Store.patch(id, { baseline: text, lastValue: text, lastCheck: Date.now(), status: 'ok', error: '', failCount: 0 });
            } catch (e) {
                result = fail(id, e);
            }
            Panel.refresh();
            return result;
        }

        return { check, calibrate, apply, fail };
    })();

    // =========================================================================
    // 本页观察：MutationObserver
    // =========================================================================

    /**
     * 观察整个 body 而不是只观察那个元素：SPA 重渲染时常把整块节点换掉，
     * 盯着旧元素的观察器就再也收不到东西了。每次安静下来以后按选择器重新找元素取文字，
     * 换没换节点都无所谓。面板宿主挂在 <html> 下，不在 body 里，自己的重绘不会触发它。
     */
    const Observer = (() => {
        let mo = null;
        let timer = 0;
        let firstAt = 0;

        function watched() {
            return Scheduler.mine().filter((m) => m.enabled && m.mode === 'observe');
        }

        /** 取当前页上的文字。找不到元素抛错（面板上显示），不当成「变成了空」。 */
        function read(mon) {
            if (pageUrl() !== mon.url) throw new Error('只能在该页面上观察');
            let el;
            try {
                el = document.querySelector(mon.selector);
            } catch (e) {
                throw new Error('选择器无效：' + mon.selector);
            }
            if (!el) throw new Error('本页找不到这个元素（页面改版，或还没渲染出来）');
            return Text.normalize(Text.of(el));
        }

        function evaluate() {
            timer = 0;
            firstAt = 0;
            let changed = false;
            for (const mon of watched()) {
                let text;
                try {
                    text = read(mon);
                } catch (e) {
                    if (mon.status !== 'error' || mon.error !== e.message) { Checker.fail(mon.id, e); changed = true; }
                    continue;
                }
                // 空文字多半是「还没渲染出来」（骨架屏、加载中被清空），等下一次变化
                if (!text) continue;
                if (text !== mon.lastValue || mon.status !== 'ok') { Checker.apply(mon.id, text); changed = true; }
            }
            if (changed) Panel.refresh();
        }

        function schedule() {
            const now = Date.now();
            if (!firstAt) firstAt = now;
            clearTimeout(timer);
            const wait = Math.min(CONFIG.observeDebounce, Math.max(0, firstAt + CONFIG.observeMaxWait - now));
            timer = setTimeout(evaluate, wait);
        }

        /** 按当前存储决定开不开观察器：有启用的观察项才开，免得在每个页面上都挂一个全量观察。 */
        function sync() {
            const need = watched().length > 0;
            if (need && !mo && document.body) {
                mo = new MutationObserver(schedule);
                mo.observe(document.body, { childList: true, subtree: true, characterData: true });
                schedule();
            } else if (!need && mo) {
                mo.disconnect();
                mo = null;
                clearTimeout(timer);
                timer = firstAt = 0;
            }
        }

        return { sync, read };
    })();

    // =========================================================================
    // 调度：只检查「本页」的监控项
    // =========================================================================

    /**
     * 只有打开着该 URL 的标签页才检查它：这是用户脚本的天然限制（没有常驻后台），
     * 也是刻意的 —— 让任意标签页都去抓全部监控项，开十个标签就是十份请求在抢。
     */
    const Scheduler = (() => {
        const running = new Set();

        /** 连续失败时按 2 的幂退避：对方在限流或宕机时，越催越糟。 */
        function wait(mon) {
            const n = Math.min(mon.failCount || 0, 10);
            return Math.min(mon.interval * 2 ** n, Math.max(mon.interval, CONFIG.maxBackoff)) * 1000;
        }

        function nextAt(mon) {
            return (mon.lastCheck || mon.createdAt || 0) + wait(mon);
        }

        function due(mon, now) {
            return now >= nextAt(mon);
        }

        /**
         * 租约：同一个 URL 开着几个标签时，谁先到点谁认领 —— 把「上次检查时间」写成现在、
         * 署上自己的名字。别的标签再看就是「刚检查过」，跳过。
         * 认领后等一小会儿再读回来确认：真实的管理器里 GM 存储跨标签同步是异步的，
         * 两个标签可能在同一瞬间都以为自己先到；等同步完，名字被覆盖掉的那个让出。
         */
        function claim(mon, now) {
            running.add(mon.id);
            Store.patch(mon.id, { lastCheck: now, checker: TAB_ID });
            setTimeout(() => {
                const cur = Store.get(mon.id);
                if (!cur || cur.checker !== TAB_ID || !cur.enabled) {
                    running.delete(mon.id);
                    return;
                }
                Checker.check(mon.id).finally(() => running.delete(mon.id));
            }, CONFIG.leaseConfirmMs);
        }

        function mine() {
            const url = pageUrl();
            return Store.all().filter((m) => m.url === url);
        }

        function tick() {
            // 别的标签页检查完写进存储的结果，这边靠定时重绘看到
            Panel.refresh();
            Observer.sync();
            const now = Date.now();
            for (const mon of mine()) {
                if (!mon.enabled || mon.mode !== 'fetch' || running.has(mon.id) || !due(mon, now)) continue;
                claim(mon, now);
            }
        }

        function start() {
            const loop = () => {
                try {
                    tick();
                } catch (e) {
                    console.error(TAG, '调度出错', e);
                }
                setTimeout(loop, CONFIG.tickMs);
            };
            // 首轮随机错开：同时打开（或恢复会话）的几个标签不要在同一刻到点
            setTimeout(loop, Math.random() * CONFIG.tickMs);
        }

        return { start, mine, nextAt };
    })();

    // =========================================================================
    // 面板与角标
    // =========================================================================

    function fmtTime(ts) {
        if (!ts) return '—';
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        return new Date().toDateString() === d.toDateString() ? time : `${d.getMonth() + 1}-${p(d.getDate())} ${time}`;
    }

    const Panel = (() => {
        let panel = null;
        let badge = null;
        const armed = new Set();     // 点过一次「删除」、等确认的监控项
        let fresh = new Set();       // 打开面板时还未读的：未读数已清零，但这次打开期间仍标出来
        const drafts = new Map();    // 正在编辑规则的监控项 → 草稿。定时重绘不能把没保存的输入冲掉
        const showHistory = new Set();

        function statusOf(mon) {
            if (!mon.enabled) return { text: '已暂停' };
            if (mon.status === 'error') {
                const n = mon.failCount || 1;
                const next = mon.mode === 'fetch' ? ` · 下次约 ${fmtTime(Scheduler.nextAt(mon))}` : '';
                return { text: `连续失败 ${n} 次${next}`, error: mon.error || '检查失败' };
            }
            if (!mon.lastCheck) return { text: '等待首次检查' };
            return { text: '正常' };
        }

        function saveInterval(id, minutes) {
            const sec = Math.max(CONFIG.minInterval, Math.round((Number(minutes) || 0) * 60));
            Store.patch(id, { interval: sec });
            render();
        }

        async function checkNow(id, btn) {
            btn.disabled = true;
            btn.textContent = '检查中…';
            const before = Store.get(id);
            const after = await Checker.check(id);
            if (!after) return;
            if (after.status === 'error') UI.toast('检查失败：' + after.error);
            else UI.toast(after.lastValue !== before.lastValue ? '检测到变化' : '没有变化');
        }

        function editRules(mon) {
            if (drafts.has(mon.id)) drafts.delete(mon.id);
            else {
                drafts.set(mon.id, {
                    noise: mon.noise || '',
                    kwMode: (mon.keyword && mon.keyword.mode) || 'any',
                    kwText: (mon.keyword && mon.keyword.text) || '',
                    threshold: mon.threshold || '',
                    error: '',
                });
            }
            render();
        }

        function saveRules(id) {
            const d = drafts.get(id);
            const { errors } = Rules.parseNoise(d.noise);
            if (errors.length) d.error = '噪声正则有误：' + errors.join('；');
            else if (d.threshold.trim() && !Rules.parseThreshold(d.threshold)) d.error = '阈值写数字（如 10）或百分比（如 5%）';
            else {
                Store.patch(id, {
                    noise: d.noise.trim(),
                    keyword: { mode: d.kwMode, text: d.kwText.trim() },
                    threshold: d.threshold.trim(),
                });
                drafts.delete(id);
            }
            render();
        }

        function rulesView(mon) {
            const d = drafts.get(mon.id);
            const bind = (key) => (e) => { d[key] = e.target.value; };
            const select = UI.el('select', { 'data-field': 'kw-mode', onchange: bind('kwMode') }, [
                UI.el('option', { value: 'any', text: '任何变化都通知' }),
                UI.el('option', { value: 'contains', text: '变化后包含关键词才通知' }),
                UI.el('option', { value: 'excludes', text: '变化后不含关键词才通知' }),
            ]);
            select.value = d.kwMode;
            const noise = UI.el('textarea', {
                'data-field': 'noise', rows: 2, placeholder: '例：更新于 \\d+:\\d+\n/浏览 \\d+ 次/i',
                oninput: bind('noise'),
            });
            noise.value = d.noise;
            return UI.el('div', { class: 'rules', 'data-role': 'rules' }, [
                UI.el('label', { text: '忽略的噪声（每行一个正则，比较前删掉）' }),
                noise,
                UI.el('div', { class: 'line' }, [
                    select,
                    UI.el('input', { 'data-field': 'kw-text', placeholder: '关键词', value: d.kwText, oninput: bind('kwText') }),
                ]),
                UI.el('div', { class: 'line' }, [
                    UI.el('span', { text: '数字变化至少' }),
                    UI.el('input', { 'data-field': 'threshold', placeholder: '10 或 5%', value: d.threshold, oninput: bind('threshold') }),
                    UI.el('span', { class: 'hint', text: '取文字里第一个数字（如价格）' }),
                ]),
                d.error ? UI.el('div', { class: 'err', 'data-role': 'rule-error', text: d.error }) : null,
                UI.el('div', { class: 'line' }, [
                    UI.el('button', { 'data-act': 'save-rules', class: 'primary', text: '保存规则', onclick: () => saveRules(mon.id) }),
                    UI.el('button', { 'data-act': 'cancel-rules', text: '取消', onclick: () => editRules(mon) }),
                ]),
            ]);
        }

        function diffView(oldText, newText) {
            const box = UI.el('div', { class: 'diff', 'data-role': 'diff' });
            for (const op of Diff.words(oldText, newText)) {
                box.append(op.type === 'eq' ? op.text : UI.el(op.type, { text: op.text }));
            }
            return box;
        }

        function historyView(mon) {
            const list = mon.history || [];
            return UI.el('div', { class: 'history', 'data-role': 'history' },
                list.length
                    ? list.map((h) => UI.el('div', { class: 'hist' }, [
                        UI.el('div', { class: 'meta' }, [
                            fmtTime(h.t),
                            h.notified ? null : UI.el('span', { class: 'muted', text: ` · 未通知（${h.reason || '不满足条件'}）` }),
                        ]),
                        diffView(h.old, h.new),
                    ]))
                    : [UI.el('div', { class: 'meta', text: '还没有检测到变化' })]);
        }

        function toggleHistory(id) {
            if (showHistory.has(id)) showHistory.delete(id);
            else showHistory.add(id);
            render();
        }

        function rulesSummary(mon) {
            const parts = [];
            const n = Rules.parseNoise(mon.noise).list.length;
            if (n) parts.push(`忽略 ${n} 条噪声`);
            const kw = mon.keyword || {};
            if (kw.text && kw.mode === 'contains') parts.push(`含「${kw.text}」才通知`);
            if (kw.text && kw.mode === 'excludes') parts.push(`不含「${kw.text}」才通知`);
            if (mon.threshold) parts.push(`数字变化 ≥ ${mon.threshold}`);
            return parts.join(' · ');
        }

        function remove(id) {
            if (!armed.has(id)) {
                armed.add(id);
                render();
                return;
            }
            armed.delete(id);
            Store.remove(id);
            Observer.sync();
            render();
        }

        function itemView(mon, here) {
            const st = statusOf(mon);
            const isHere = here.has(mon.id);
            return UI.el('div', { class: 'item' + (mon.enabled ? '' : ' off'), 'data-id': mon.id }, [
                UI.el('div', { class: 'name' }, [
                    UI.el('a', { href: mon.url, target: '_blank', rel: 'noopener', title: mon.url, text: mon.title || mon.url }),
                    mon.unread || fresh.has(mon.id) ? UI.el('span', { class: 'tag new', text: '有新变化' }) : null,
                    UI.el('span', { class: 'tag', text: mon.mode === 'observe' ? '本页观察' : '抓取' }),
                ]),
                UI.el('div', { class: 'sel', text: mon.selector }),
                UI.el('div', { class: 'value', 'data-role': 'value', text: Text.preview(mon.lastValue, 160) || '（空）' }),
                UI.el('div', { class: 'meta' }, [
                    `上次检查 ${fmtTime(mon.lastCheck)} · 上次变化 ${fmtTime(mon.lastChange)}`,
                    st.text ? ` · ${st.text}` : null,
                ]),
                st.error ? UI.el('div', { class: 'err', 'data-role': 'error', text: st.error }) : null,
                rulesSummary(mon) ? UI.el('div', { class: 'meta', 'data-role': 'rules-summary', text: rulesSummary(mon) }) : null,
                UI.el('div', { class: 'ctl' }, [
                    UI.el('label', {}, [
                        UI.el('input', {
                            type: 'checkbox', 'data-act': 'toggle', checked: mon.enabled,
                            onchange: (e) => { Store.patch(mon.id, { enabled: e.target.checked }); Observer.sync(); render(); },
                        }),
                        ' 启用',
                    ]),
                    UI.el('label', {}, [
                        '每 ',
                        UI.el('input', {
                            type: 'number', 'data-field': 'interval', min: CONFIG.minInterval / 60, step: 0.5,
                            value: +(mon.interval / 60).toFixed(2),
                            onchange: (e) => saveInterval(mon.id, e.target.value),
                        }),
                        ' 分钟',
                    ]),
                    UI.el('button', {
                        'data-act': 'check', text: '立即检查',
                        // 只在该页面上检查：抓别的站要额外的跨域授权，也不该替用户去碰没打开的站
                        disabled: !isHere, title: isHere ? null : '在该页面打开时才能检查',
                        onclick: (e) => checkNow(mon.id, e.target),
                    }),
                    UI.el('button', { 'data-act': 'history', text: `历史 ${(mon.history || []).length}`, onclick: () => toggleHistory(mon.id) }),
                    UI.el('button', { 'data-act': 'rules', text: '规则', onclick: () => editRules(mon) }),
                    UI.el('button', {
                        'data-act': 'delete', class: 'danger', text: armed.has(mon.id) ? '确认删除' : '删除',
                        onclick: () => remove(mon.id),
                    }),
                ]),
                drafts.has(mon.id) ? rulesView(mon) : null,
                showHistory.has(mon.id) ? historyView(mon) : null,
            ]);
        }

        function render() {
            renderBadge();
            if (!panel) return;
            const list = panel.querySelector('.list');
            const all = Store.all();
            const here = new Set(Scheduler.mine().map((m) => m.id));
            // 当前页的排前面
            all.sort((a, b) => here.has(b.id) - here.has(a.id));
            panel.querySelector('.title').textContent = `网页监控（${all.length}）`;
            list.textContent = '';
            if (!all.length) list.append(UI.el('div', { class: 'empty', text: '还没有监控项。点「选取区域」在本页选一块。' }));
            for (const mon of all) list.append(itemView(mon, here));
        }

        function renderBadge() {
            const mine = Scheduler.mine();
            if (!mine.length) {
                if (badge) badge.remove();
                badge = null;
                return;
            }
            if (!badge) {
                badge = UI.el('div', { class: 'badge', 'data-role': 'badge', title: '网页监控', onclick: () => toggle() });
                UI.layer().append(badge);
            }
            const unread = mine.reduce((n, m) => n + (m.unread || 0), 0);
            const failing = mine.filter((m) => m.enabled && m.status === 'error').length;
            badge.classList.toggle('unread', unread > 0);
            badge.classList.toggle('failing', !unread && failing > 0);
            badge.textContent = unread ? `● ${unread} 处变化` : failing ? `! ${failing} 项检查失败` : `◎ 监控中 ${mine.length}`;
        }

        /** 打开面板就算「看过了」，清掉未读。 */
        function markRead() {
            for (const mon of Store.all()) if (mon.unread) Store.patch(mon.id, { unread: 0 });
        }

        function open() {
            if (!panel) {
                panel = UI.el('div', { class: 'panel', 'data-role': 'panel' }, [
                    UI.el('div', { class: 'head' }, [
                        UI.el('span', { class: 'title' }),
                        UI.el('button', { 'data-act': 'pick', text: '选取区域', onclick: () => { close(); Picker.start(); } }),
                        UI.el('button', { 'data-act': 'close', text: '×', onclick: () => close() }),
                    ]),
                    UI.el('div', { class: 'list' }),
                ]);
                UI.layer().append(panel);
            }
            fresh = new Set(Store.all().filter((m) => m.unread).map((m) => m.id));
            markRead();
            render();
        }

        function close() {
            if (panel) panel.remove();
            panel = null;
            armed.clear();
            fresh.clear();
            drafts.clear();
            showHistory.clear();
        }

        function toggle() {
            if (panel) close();
            else open();
        }

        /**
         * 定时重绘时，焦点在输入框里就先不动：整块重建会把输入框连同焦点一起换掉，
         * 光标和打到一半的字都会丢（没保存的规则另有草稿兜着）。
         */
        function refresh() {
            const active = panel && panel.getRootNode().activeElement;
            if (active && panel.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
                renderBadge();
                return;
            }
            render();
        }

        return { open, close, toggle, refresh };
    })();

    // =========================================================================
    // 启动
    // =========================================================================

    function boot() {
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('选取要监控的区域', () => Picker.start());
            GM_registerMenuCommand('监控面板', () => Panel.toggle());
        }
        Panel.refresh();
        Observer.sync();
        Scheduler.start();
    }

    boot();
})();
