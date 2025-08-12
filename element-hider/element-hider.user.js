// ==UserScript==
// @name         网页元素屏蔽
// @name:zh-CN   网页元素屏蔽
// @name:en      Element Hider — Pick and Hide Annoying Page Elements
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.08.12.5
// @description  点选网页上的广告、浮窗、推荐栏等元素一键隐藏：按站点（或整个主域名）记住规则，页面加载第一刻就用样式表隐藏，不闪烁，对之后动态插入的元素同样生效。
// @description:zh-CN  点选网页上的广告、浮窗、推荐栏等元素一键隐藏：按站点（或整个主域名）记住规则，页面加载第一刻就用样式表隐藏，不闪烁，对之后动态插入的元素同样生效。
// @description:en  Point at an ad, popup or recommendation box and hide it for good: rules are remembered per site (or for the whole registrable domain) and applied as a stylesheet from the very first moment of page load, so there is no flash, and elements inserted later are hidden too.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @license      CC BY-NC-SA
// @run-at       document-start
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/element-hider/element-hider.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/element-hider/element-hider.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

/*
 * @run-at 必须是 document-start：隐藏靠一张样式表，要在页面元素第一次绘制之前就挂上，
 * 否则广告会先闪一下再消失。规则不靠 JS 逐个删元素，之后动态插入的元素天然也被隐藏。
 */

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「元素屏蔽」只看本脚本。 */
    const TAG = '[元素屏蔽]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        debug: false,
        maxSelectorLength: 1000,    // 单条选择器最长字符数，导入时超长的视为非法
        undoMs: 5000,               // 隐藏后「撤销」提示停留多久

        /*
         * 「整个主域名」的作用域需要知道注册域名。不带公共后缀表（太大），
         * 只认常见的二级后缀：命中这些时主域名取后三段，否则取后两段。
         */
        secondLevelSuffixes: [
            'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
            'com.hk', 'com.tw', 'org.tw', 'co.uk', 'org.uk', 'ac.uk',
            'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.au', 'net.au', 'co.nz', 'com.br', 'co.in', 'com.sg',
        ],
    };

    /*
     * 链接指向这些主机时，生成 a[href^="https://主机/"] 这种「同类广告」规则：
     * 允许它匹配多个元素 —— 一页上同一个广告联盟的链接通常不止一条，一起隐藏正是想要的。
     * 别的外链必须精确到选中的那一个，免得点掉一个 GitHub 链接，全页的 GitHub 链接都没了。
     */
    const AD_HOST = /(^|[.-])(ads?|adserver|adservice|adx|adnxs|doubleclick|googlesyndication|googleads|banner|promo|track|tracking|click|affiliate|union|cpro|pos)\d*([.-]|$)/i;

    const HOST = location.hostname;

    function log(...args) {
        if (CONFIG.debug) console.log(TAG, ...args);
    }

    // =========================================================================
    // 作用域：本站（hostname）/ 整个主域名（*.example.com）
    // =========================================================================

    /** 注册域名（不查公共后缀表的近似值）。IP、localhost 这类就是自己。 */
    function mainDomain(host) {
        if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
        const labels = host.split('.');
        const lastTwo = labels.slice(-2).join('.');
        const n = CONFIG.secondLevelSuffixes.includes(lastTwo) ? 3 : 2;
        return labels.slice(-n).join('.');
    }

    const SCOPE_SITE = HOST;
    const SCOPE_DOMAIN = '*.' + mainDomain(HOST);

    // =========================================================================
    // 选择器合法性
    // =========================================================================

    /*
     * 拿 querySelector 当解析器：非法时抛 SyntaxError，不用自己写 CSS 语法检查。
     * 但它对 `a/*` 这种「未闭合注释」是放行的，而样式表里这会把后面的规则全部吞掉；
     * 花括号同理会提前结束规则块。这几个字符在选择器里本来也用不到，直接拒。
     */
    function selectorError(sel) {
        if (typeof sel !== 'string' || !sel.trim()) return '选择器为空';
        if (sel.length > CONFIG.maxSelectorLength) return `选择器过长（超过 ${CONFIG.maxSelectorLength} 个字符）`;
        if (/[{}]|\/\*|\\$/.test(sel)) return '选择器里不能有花括号、注释或结尾的反斜杠';
        try {
            document.createDocumentFragment().querySelector(sel);
        } catch (e) {
            return '选择器语法错误';
        }
        return '';
    }

    // =========================================================================
    // 随机 id / 类名判据
    // =========================================================================

    /*
     * 构建工具生成的类名、组件库的自增 id，下次发版或下次渲染就变了，写进规则等于一次性规则。
     * 判据宁严勿松：误判「稳定」→ 规则悄悄失效；误判「随机」→ 只是退回到结构路径，仍然能用。
     */
    const RANDOM_TOKEN = [
        /^\d/,                                          // 纯数字 / 数字开头（类名本来就不该这样，多半是生成的）
        /\d{4,}/,                                       // 长数字串：ember1234、mui-38291、div-gpt-ad-1690000000000-0
        /^css-(?=[\w-]*\d)/i,                           // emotion / antd cssinjs：css-1x2y3z、css-dev-only-do-not-override-1x2y3z
        /^sc-[\w-]{4,}$/,                               // styled-components 的组件类：sc-bdVaJa、sc-1a2b3c4d-0
        /^(jss|svelte-|astro-|makeStyles-|emotion-|tw-)[\w-]*\d/i,  // JSS / Svelte / Astro 的作用域类
        /^c-[a-zA-Z]*[A-Z][a-zA-Z]*$/,                  // Stitches：c-dhzjXW、c-PJLV
        /^_[\w-]*\d[\w-]*$/,                            // CSS Modules 只留哈希：_3xYz1aBc
        /(__|--)_?(?=[\w-]*\d)[a-zA-Z0-9_]{5,}$/,       // CSS Modules：Header_title__3xYz1、Button__root___2X3yZ、module--x--3xYz1
        /[0-9a-f]{8}-[0-9a-f]{4}-/i,                    // uuid
        // 十六进制串：8 位以上、字母数字都有（a3f9c01bd2）
        /(^|[^0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}($|[^0-9a-z])/i,
        // nanoid 一类：8 位以上的一段，同时有大写、小写、数字
        /(^|[-_])(?=[a-zA-Z0-9]*\d)(?=[a-zA-Z0-9]*[a-z])(?=[a-zA-Z0-9]*[A-Z])[a-zA-Z0-9]{8,}($|[-_])/,
        // 字母数字穿插：1x2y3z、a1b2c3（至少三处字母数字交替）
        /(?:[a-z]\d|\d[a-z]){3,}/i,
        /(^|-)[:«][a-zA-Z0-9]+[:»]$/,                   // React useId：:r1: / «r1» / radix-:r3:（不能只看冒号，Tailwind 的 hover:bg-red-500 也有）
        /^_r_[0-9a-z]+_$/i,                             // React 19.2 的 useId
        /^(ember|ext-gen|yui_|j_id|mui-|react-select-|radix-|headlessui-|downshift-|rc-tabs-|rc_select_)/i,
    ];

    /**
     * styled-components / goober 的哈希类：5~8 个纯字母、大小写乱序（kZRDVx、iVXCSc、hGkUyx）。
     * 和驼峰命名（navBarItem、userName）的区别：驼峰是「小写词 + 若干个首字母大写的词」。
     */
    function looksMixedCaseHash(s) {
        if (!/^[a-zA-Z]{5,8}$/.test(s)) return false;
        if ((s.match(/[A-Z]/g) || []).length < 2) return false;
        return !/^[a-z]{2,}([A-Z][a-z]{2,})+$/.test(s) && !/^([A-Z][a-z]{2,})+$/.test(s);
    }

    function looksRandom(s) {
        return !!s && (RANDOM_TOKEN.some(re => re.test(s)) || looksMixedCaseHash(s));
    }

    /** 状态类：悬停、展开、选中时才有，拾取那一刻在、平时不在。 */
    const STATE_CLASS = /^(is-|has-)?(active|hover|hovered|focus|focused|open|opened|selected|current|show|shown|visible|in|fade|collapsed|expanded|checked|disabled|loading|loaded)$/i;

    // =========================================================================
    // 选择器生成
    // =========================================================================

    const Gen = (() => {
        /** data-testid 这类本来就是给自动化定位用的，最稳；不带标签名。 */
        const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
        /** 语义属性：带标签名用（button[aria-label="关闭"]）。 */
        const SEMANTIC_ATTRS = ['aria-label', 'name', 'alt'];

        const q = s => JSON.stringify(s);   // 属性值加引号，JSON 的转义规则在 CSS 字符串里同样成立
        const tagOf = el => el.localName;

        function count(sel) {
            try {
                return document.querySelectorAll(sel).length;
            } catch (e) {
                return -1;
            }
        }

        function isUniqueFor(sel, el) {
            try {
                const all = document.querySelectorAll(sel);
                return all.length === 1 && all[0] === el;
            } catch (e) {
                return false;
            }
        }

        function stableValue(v) {
            return !!v && v.length <= 60 && !looksRandom(v) && !/[\n\r]/.test(v);
        }

        /** 稳定类名，按在页面上出现的次数从少到多排（越少越能区分）。 */
        function stableClasses(el) {
            const cls = [...el.classList].filter(c => !looksRandom(c) && !STATE_CLASS.test(c));
            const freq = new Map(cls.map(c => [c, count('.' + CSS.escape(c))]));
            return cls.sort((a, b) => freq.get(a) - freq.get(b));
        }

        /**
         * 只描述元素自己的候选选择器，按稳定程度排：
         * 稳定 id → 测试属性 → 语义属性 / 链接 → role → 标签 + 类名。
         * generic: true 表示允许匹配多个（同类广告）。
         */
        function selfCandidates(el) {
            const tag = tagOf(el);
            const out = [];
            if (el.id && !looksRandom(el.id)) out.push({ sel: '#' + CSS.escape(el.id) });
            for (const a of TEST_ATTRS) {
                const v = el.getAttribute(a);
                if (stableValue(v)) out.push({ sel: `[${a}=${q(v)}]` });
            }
            for (const a of SEMANTIC_ATTRS) {
                const v = el.getAttribute(a);
                if (stableValue(v)) out.push({ sel: `${tag}[${a}=${q(v)}]` });
            }
            if (tag === 'a' && el.href) {
                let u = null;
                try { u = new URL(el.href); } catch (e) { /* javascript: 之类 */ }
                if (u && /^https?:$/.test(u.protocol)) {
                    if (u.hostname !== location.hostname && AD_HOST.test(u.hostname)) {
                        out.push({ sel: `a[href^=${q(u.origin + '/')}]`, generic: true });
                    }
                    const raw = el.getAttribute('href');
                    if (raw.length <= 120 && !looksRandom(u.pathname + u.search)) out.push({ sel: `a[href=${q(raw)}]` });
                }
            }
            const role = el.getAttribute('role');
            if (stableValue(role)) out.push({ sel: `${tag}[role=${q(role)}]` });
            const cls = stableClasses(el).slice(0, 2);
            if (cls.length) {
                for (const c of cls) out.push({ sel: tag + '.' + CSS.escape(c) });
                if (cls.length > 1) out.push({ sel: tag + cls.map(c => '.' + CSS.escape(c)).join('') });
            }
            return out;
        }

        /** 路径上的一级：标签 + 最多两个稳定类名，同级有同样的兄弟时加 :nth-of-type。 */
        function step(el) {
            let s = tagOf(el) + stableClasses(el).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
            const parent = el.parentElement;
            if (parent) {
                const same = [...parent.children].filter(c => c.matches(s));
                if (same.length > 1) {
                    const n = [...parent.children].filter(c => c.localName === el.localName).indexOf(el) + 1;
                    s += `:nth-of-type(${n})`;
                }
            }
            return s;
        }

        function accept(c, el) {
            if (c.generic) {
                const n = count(c.sel);
                return n >= 1 && n <= 50 && el.matches(c.sel);
            }
            return isUniqueFor(c.sel, el);
        }

        /**
         * 为元素生成选择器：先看自己能不能单独定位；不能就往上找一个能单独定位的祖先，
         * 用 `>` 连起来的路径从那里走下来；到 body 都没有就从 body 起写全路径。
         */
        function selectorFor(el) {
            if (el === document.documentElement) return 'html';
            if (el === document.body) return 'body';
            for (const c of selfCandidates(el)) if (accept(c, el)) return c.sel;

            const path = [step(el)];
            for (let cur = el.parentElement; cur && cur !== document.documentElement; cur = cur.parentElement) {
                /*
                 * 不带锚点的路径只在开头一级「有类名、没有序号」时才收（div.promo > span）。
                 * div:nth-of-type(3) > span、div.widget:nth-of-type(2) 碰巧唯一也不收：
                 * 页面别处多一个同样的结构就指错，继续往上找有 id / 稳定属性的锚点。
                 */
                if (/[.[#]/.test(path[0]) && !path[0].includes(':nth-of-type') && isUniqueFor(path.join(' > '), el)) {
                    return path.join(' > ');
                }
                if (cur === document.body) break;
                for (const c of selfCandidates(cur)) {
                    if (c.generic) continue;
                    const s = c.sel + ' > ' + path.join(' > ');
                    if (isUniqueFor(c.sel, cur) && isUniqueFor(s, el)) return s;
                }
                path.unshift(step(cur));
            }
            return 'body > ' + path.join(' > ');
        }

        return { selectorFor, count };
    })();

    // =========================================================================
    // 规则存储（GM，按作用域分键：rules:<作用域>）
    // =========================================================================

    /**
     * 每个作用域一个键，而不是所有站点塞进一个大对象：
     * 每次页面加载只读本站相关的两个键；多个标签页同时改不同站点也不会互相覆盖。
     */
    const Store = (() => {
        const key = scope => 'rules:' + scope;

        function get(scope) {
            const list = GM_getValue(key(scope), []);
            return Array.isArray(list) ? list.filter(r => r && typeof r.selector === 'string') : [];
        }

        function set(scope, list) {
            if (list.length) GM_setValue(key(scope), list);
            else GM_deleteValue(key(scope));
        }

        /** 本页生效的规则：本站 + 主域名两个作用域，带上作用域方便管理。 */
        function here() {
            const out = [];
            for (const scope of [SCOPE_SITE, SCOPE_DOMAIN]) {
                for (const r of get(scope)) out.push({ ...r, scope });
            }
            return out;
        }

        function add(scope, selector) {
            const list = get(scope);
            if (list.some(r => r.selector === selector)) return false;
            list.push({ selector, created: Date.now() });
            set(scope, list);
            return true;
        }

        function remove(scope, selector) {
            set(scope, get(scope).filter(r => r.selector !== selector));
        }

        return { get, set, here, add, remove };
    })();

    // =========================================================================
    // 生效：一张样式表
    // =========================================================================

    const Styler = (() => {
        let style = null;

        /*
         * 每条规则单独一行，不合并成 `a, b, c { ... }`：
         * 选择器列表里只要有一个非法（存进来之后浏览器不再支持的伪类之类），整条规则作废，
         * 一条坏规则会让本站所有规则一起失效。
         */
        function css() {
            const lines = [];
            for (const r of Store.here()) {
                if (selectorError(r.selector)) continue;
                lines.push(`${r.selector} { display: none !important; }`);
            }
            return lines.join('\n');
        }

        function apply() {
            const text = css();
            if (!style) {
                // GM_addStyle 在 document-start 时也能挂（<html> 还没出来会等它）；有的管理器不返回元素，自己兜底
                style = GM_addStyle(text) || null;
                if (!style) {
                    style = document.createElement('style');
                    style.textContent = text;
                    (document.head || document.documentElement).appendChild(style);
                }
                style.setAttribute('data-element-hider', '');
            } else {
                style.textContent = text;
            }
            log('样式已更新，规则数', text ? text.split('\n').length : 0);
        }

        return { apply };
    })();

    // =========================================================================
    // 界面宿主（shadow DOM）
    // =========================================================================

    /*
     * 一个铺满视口、自身 pointer-events: none 的宿主：高亮框画在里面，不拦截鼠标，
     * 拾取时 elementFromPoint 打得到下面的页面元素；只有面板、提示条这些要点的东西单独开 pointer-events。
     */
    const UI = (() => {
        let host = null;
        let root = null;
        let boxes = null;
        let tracked = [];       // 正在高亮的元素：滚动 / 缩放时重算位置
        let raf = 0;

        const CSS = `
            :host { all: initial; }
            * { box-sizing: border-box; }
            .boxes, .box { position: fixed; pointer-events: none; }
            .boxes { inset: 0; }
            .box { border: 2px solid #e5484d; background: rgba(229, 72, 77, .18); border-radius: 2px; }
            .box.match { border-color: #f5a524; background: rgba(245, 165, 36, .16); }
            .box .label {
                position: absolute; left: -2px; bottom: 100%; margin-bottom: 2px; padding: 1px 6px; white-space: nowrap;
                font: 12px/18px ui-monospace, Menlo, Consolas, monospace; color: #fff; background: #e5484d; border-radius: 3px;
                max-width: 60vw; overflow: hidden; text-overflow: ellipsis;
            }
            .box.flip .label { bottom: auto; top: 100%; margin: 2px 0 0; }
            .tip {
                position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); pointer-events: none;
                padding: 6px 14px; border-radius: 6px; background: rgba(24, 24, 27, .92); color: #fafafa;
                font: 13px/20px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; white-space: nowrap;
            }
            .toast {
                position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); pointer-events: auto;
                display: flex; align-items: center; gap: 4px; padding: 6px 8px 6px 14px; border-radius: 6px;
                background: rgba(24, 24, 27, .94); color: #fafafa; box-shadow: 0 6px 20px rgba(0, 0, 0, .25);
                font: 13px/20px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; white-space: nowrap;
            }
            .toast button { background: transparent; border-color: transparent; color: #f5a524; font-weight: 600; }
            .card {
                position: fixed; right: 16px; bottom: 16px; width: 420px; max-width: calc(100vw - 32px); pointer-events: auto;
                padding: 12px 14px; border-radius: 8px; background: #fff; color: #18181b; border: 1px solid #e4e4e7;
                box-shadow: 0 8px 28px rgba(0, 0, 0, .18);
                font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
            }
            .card h3 { margin: 0 0 8px; font-size: 14px; }
            .card .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
            .card .grow { flex: 1; }
            .card .info { margin-top: 4px; color: #52525b; }
            .card .info.error { color: #e5484d; }
            .card select { font: inherit; max-width: 220px; }
            .card code, .card textarea {
                font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; word-break: break-all;
            }
            button {
                font: inherit; padding: 3px 10px; border-radius: 5px; cursor: pointer;
                border: 1px solid #d4d4d8; background: #fafafa; color: inherit;
            }
            button.primary { background: #e5484d; border-color: #e5484d; color: #fff; }
            button:disabled { opacity: .5; cursor: not-allowed; }
            @media (prefers-color-scheme: dark) {
                .card { background: #18181b; color: #fafafa; border-color: #3f3f46; }
                .card .info { color: #a1a1aa; }
                .card textarea, .card select { background: #27272a; color: inherit; border: 1px solid #3f3f46; }
                button { background: #27272a; border-color: #3f3f46; }
            }
        `;

        function ensure() {
            if (host && host.isConnected) return root;
            host = document.createElement('element-hider-ui');
            // 内联 !important：用户自己的规则（比如 `html > *`）或页面样式都盖不过，界面不会把自己藏起来
            host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;inset:0!important;'
                + 'z-index:2147483647!important;pointer-events:none!important;';
            root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = CSS;
            boxes = document.createElement('div');
            boxes.className = 'boxes';
            root.append(style, boxes);
            document.documentElement.appendChild(host);
            addEventListener('scroll', schedule, { capture: true, passive: true });
            addEventListener('resize', schedule, { passive: true });
            return root;
        }

        function el(tag, props, children) {
            const n = document.createElement(tag);
            Object.assign(n, props || {});
            for (const c of children || []) n.append(c);
            return n;
        }

        /** 页面坐标处的页面元素：界面自己（面板、提示条）不算。 */
        function pageElementAt(x, y) {
            const t = document.elementFromPoint(x, y);
            return !t || t === host ? null : t;
        }

        function isOwn(e) {
            return !!host && e.composedPath().includes(host);
        }

        function describe(node) {
            const cls = [...node.classList].slice(0, 3).map(c => '.' + c).join('');
            const r = node.getBoundingClientRect();
            return `${node.localName}${node.id ? '#' + node.id : ''}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
        }

        /** 高亮一组元素。kind: 'hover'（拾取中的那个，带标签）/ 'match'（选择器匹配到的）。 */
        function highlight(list, kind) {
            ensure();
            tracked = list.map(node => ({ node, kind }));
            draw();
        }

        function draw() {
            raf = 0;
            if (!boxes) return;
            boxes.textContent = '';
            for (const { node, kind } of tracked) {
                if (!node.isConnected) continue;
                const r = node.getBoundingClientRect();
                const b = el('div', { className: 'box ' + kind });
                b.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
                if (kind === 'hover') {
                    if (r.top < 24) b.classList.add('flip');
                    b.append(el('div', { className: 'label', textContent: describe(node) }));
                }
                boxes.append(b);
            }
        }

        function schedule() {
            if (!raf && tracked.length) raf = requestAnimationFrame(draw);
        }

        function clear() {
            tracked = [];
            if (boxes) boxes.textContent = '';
        }

        /** 挂一个带 class 的浮层（同 class 的旧的先移除），返回它。 */
        function mount(className, children) {
            ensure();
            unmount(className);
            const node = el('div', { className }, children);
            root.append(node);
            return node;
        }

        /* 不能写 root.querySelectorAll(':scope > .x')：shadow root 是 DocumentFragment，:scope 在它上面什么都不匹配 */
        function unmount(className) {
            if (root) [...root.children].filter(n => n.classList.contains(className)).forEach(n => n.remove());
        }

        return { ensure, el, pageElementAt, isOwn, highlight, clear, mount, unmount, get host() { return host; } };
    })();

    // =========================================================================
    // 拾取模式
    // =========================================================================

    const Picker = (() => {
        let active = false;
        let base = null;        // 鼠标下的元素
        let cur = null;         // 当前选中的层级（滚轮 / 方向键会在 base 的祖先间移动）
        let trail = [];         // 往上走过的层级，往下走时原路返回

        function start() {
            if (active) return;
            Confirm.close();
            active = true;
            base = cur = null;
            trail = [];
            UI.mount('tip', [UI.el('span', { textContent: '拾取模式：点击选中 · 滚轮 / ↑↓ 切换父子层级 · Esc 退出' })]);
            log('进入拾取模式');
        }

        function stop() {
            active = false;
            base = cur = null;
            UI.clear();
            UI.unmount('tip');
        }

        function setCurrent(node) {
            cur = node;
            UI.highlight([node], 'hover');
        }

        function up() {
            if (!cur || cur === document.documentElement || !cur.parentElement) return;
            trail.push(cur);
            setCurrent(cur.parentElement);
        }

        function down() {
            if (!cur) return;
            if (trail.length) return setCurrent(trail.pop());
            const child = [...cur.children].find(c => c !== UI.host && c.getBoundingClientRect().width > 0);
            if (child) setCurrent(child);
        }

        function choose() {
            const node = cur;
            stop();
            if (node) Confirm.open(node);
        }

        function onMove(e) {
            if (!active) return;
            const node = UI.pageElementAt(e.clientX, e.clientY);
            if (!node || node === base) return;
            base = node;
            trail = [];
            setCurrent(node);
        }

        /*
         * 拾取时按下的鼠标不能让页面收到：链接会跳转、按钮会提交，mousedown 上挂的菜单会弹出来。
         * 这些监听在 document-start 时就挂在 window 的捕获阶段，比页面自己的任何监听都早，
         * 等进了拾取模式再挂就排在页面的捕获监听后面，拦不住。
         */
        function onPointer(e) {
            if (!active || UI.isOwn(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.type === 'click') {
                if (!cur) onMove(e);
                choose();
            }
        }

        function onWheel(e) {
            if (!active || !cur || UI.isOwn(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.deltaY < 0) up();
            else if (e.deltaY > 0) down();
        }

        function onKey(e) {
            if (!active) return false;
            const act = { Escape: stop, ArrowUp: up, ArrowDown: down, Enter: choose }[e.key];
            if (!act) return false;
            e.preventDefault();
            e.stopImmediatePropagation();
            act();
            return true;
        }

        function install() {
            addEventListener('mousemove', onMove, true);
            for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
                addEventListener(type, onPointer, true);
            }
            addEventListener('wheel', onWheel, { capture: true, passive: false });
        }

        return { start, stop, install, onKey, get active() { return active; } };
    })();

    // =========================================================================
    // 确认面板
    // =========================================================================

    const Confirm = (() => {
        let node = null;        // 拾取到的元素（父级 / 子级按钮在它的祖先链上移动）
        let trail = [];
        let input = null;
        let info = null;
        let hideBtn = null;

        /** 选择器当前匹配到的页面元素；非法时返回 null。界面自己不算。 */
        function matches(sel) {
            if (selectorError(sel)) return null;
            return [...document.querySelectorAll(sel)].filter(n => n !== UI.host);
        }

        /** 输入框每次变化都重算：匹配数、全部高亮、非法提示。 */
        function refresh() {
            const sel = input.value.trim();
            const err = selectorError(sel);
            const list = err ? null : matches(sel);
            info.classList.toggle('error', !!err || !list.length);
            if (err) info.textContent = '⚠ ' + err + '，改好之前不能保存';
            else if (!list.length) info.textContent = '当前选择器没有匹配到任何元素';
            else info.textContent = `当前选择器会匹配 ${list.length} 个元素` + (list.length > 1 ? '（已全部高亮）' : '');
            hideBtn.disabled = !!err || !list || !list.length;
            UI.highlight(list || [], 'match');
        }

        function setNode(n) {
            node = n;
            input.value = Gen.selectorFor(n);
            refresh();
        }

        function button(act, text, primary) {
            const b = UI.el('button', { textContent: text, className: primary ? 'primary' : '' });
            b.dataset.act = act;
            return b;
        }

        function open(picked) {
            trail = [];
            input = UI.el('textarea', { className: 'sel', rows: 2, spellcheck: false });
            input.style.cssText = 'width:100%;resize:vertical;';
            info = UI.el('div', { className: 'info' });
            hideBtn = button('hide', '隐藏', true);
            const upBtn = button('parent', '↑ 父级');
            const downBtn = button('child', '↓ 子级');
            const cancelBtn = button('cancel', '取消');

            const scopeSel = UI.el('select', { className: 'scope' }, [
                UI.el('option', { value: SCOPE_SITE, textContent: '仅本站 ' + SCOPE_SITE }),
                UI.el('option', { value: SCOPE_DOMAIN, textContent: '整个主域名 ' + SCOPE_DOMAIN }),
            ]);
            // 本站就是主域名本身（example.com）时两个选项含义几乎一样，仍然保留：*.example.com 还管所有子域名

            input.addEventListener('input', refresh);
            upBtn.addEventListener('click', () => {
                if (node.parentElement && node !== document.body) {
                    trail.push(node);
                    setNode(node.parentElement);
                }
            });
            downBtn.addEventListener('click', () => {
                if (trail.length) setNode(trail.pop());
            });
            cancelBtn.addEventListener('click', close);
            hideBtn.addEventListener('click', () => save(input.value.trim(), scopeSel.value));

            UI.mount('card confirm', [
                UI.el('h3', { textContent: '隐藏元素' }),
                input,
                info,
                UI.el('div', { className: 'row' }, [upBtn, downBtn, UI.el('span', { className: 'grow' }), scopeSel]),
                UI.el('div', { className: 'row' }, [UI.el('span', { className: 'grow' }), cancelBtn, hideBtn]),
            ]);
            setNode(picked);
        }

        function save(sel, scope) {
            if (selectorError(sel)) return;
            // 先数再隐藏：隐藏之后元素还在，但数字要在提示里告诉用户「刚才藏了几个」
            const n = matches(sel).length;
            const added = Store.add(scope, sel);
            Styler.apply();
            log('已隐藏', scope, sel);
            close();
            Toast.show(added ? `已隐藏 ${n} 个元素` : '这条规则已经存在', added ? () => {
                Store.remove(scope, sel);
                Styler.apply();
            } : null);
        }

        function close() {
            UI.unmount('confirm');
            UI.clear();
            node = null;
        }

        return { open, close };
    })();

    // =========================================================================
    // 撤销提示
    // =========================================================================

    const Toast = (() => {
        let timer = 0;

        /** 底部浮出一条提示，带「撤销」时点了就执行 undo；CONFIG.undoMs 后自动消失。 */
        function show(text, undo) {
            clearTimeout(timer);
            const children = [UI.el('span', { textContent: text })];
            if (undo) {
                const b = UI.el('button', { textContent: '撤销' });
                b.dataset.act = 'undo';
                b.addEventListener('click', () => {
                    undo();
                    hide();
                });
                children.push(UI.el('span', { textContent: ' · ' }), b);
            }
            UI.mount('toast', children);
            timer = setTimeout(hide, CONFIG.undoMs);
        }

        function hide() {
            clearTimeout(timer);
            UI.unmount('toast');
        }

        return { show, hide };
    })();

    // =========================================================================
    // 启动
    // =========================================================================

    Styler.apply();
    Picker.install();

    /*
     * 快捷键按 e.code 认：macOS 上 Alt+Shift+H 的 e.key 是「Ó」，按 e.key 判断永远不触发。
     * 拾取模式里的 Esc / 方向键也在这里分发，同样要抢在页面之前（页面的 Esc 会关它自己的弹窗）。
     */
    addEventListener('keydown', e => {
        if (Picker.onKey(e)) return;
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyH') {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (Picker.active) Picker.stop();
            else Picker.start();
        }
    }, true);

    GM_registerMenuCommand('🎯 拾取要隐藏的元素（Alt+Shift+H）', () => Picker.start());

    /*
     * 调试钩子：GM 存储里 debug 为 true 时，把选择器生成器挂到页面上，
     * 控制台里 __elementHider.selectorFor($0) 就能看某个元素会生成什么。测试也走这里做单测。
     */
    if (GM_getValue('debug', false)) {
        CONFIG.debug = true;
        unsafeWindow.__elementHider = { looksRandom, selectorFor: Gen.selectorFor, selectorError, mainDomain };
    }
})();
