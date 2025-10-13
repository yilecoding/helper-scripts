// ==UserScript==
// @name         中英文自动加空格（盘古之白）
// @name:zh-CN   中英文自动加空格（盘古之白）
// @name:en      Pangu Spacing — Auto Space Between CJK and Latin Text
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.10.13.6
// @description  在网页里的中日韩文字与英文字母、数字之间自动加上空格（盘古之白），只改文字节点，不动页面结构。
// @description:zh-CN  在网页里的中日韩文字与英文字母、数字之间自动加上空格（盘古之白），只改文字节点，不动页面结构。
// @description:en  Automatically inserts a space between CJK characters and Latin letters / digits on any web page. Only text nodes are touched; the page structure is left alone.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        none
// @license      CC BY-NC-SA
// @run-at       document-idle
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/pangu-spacing/pangu-spacing.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/pangu-spacing/pangu-spacing.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「盘古」只看本脚本。 */
    const TAG = '[盘古之白]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        debug: false,
        /*
         * 这些元素整棵子树都不处理。
         * select / option / datalist 也得跳：<option> 没写 value 时，提交的值就是它的文字，
         * 加个空格等于改了表单数据。
         */
        skipSelector: [
            'code', 'pre', 'kbd', 'samp', 'script', 'style', 'noscript', 'template',
            'textarea', 'input', 'select', 'option', 'datalist',
            'svg', 'math', 'iframe', 'object', 'canvas',
            '[contenteditable]:not([contenteditable="false"])',
        ].join(', '),
        /** 行内 code / kbd / samp 两侧也按规则加空格（加在外面的文字上，code 里面不动）。 */
        spaceAroundCode: true,
        idleTimeout: 1000,      // 空闲回调最多等这么久（ms），页面一直忙也要处理
        sliceMs: 12,            // 没有空闲时间可用时（超时回调、不支持 requestIdleCallback），每片最多跑这么久
        batchSize: 200,         // 每处理这么多项看一次时间
        maxReverts: 3,          // 同一个文字节点被页面改回原样这么多次，就不再处理它
        /** 额外跳过的选择器（站点自己的代码块类名之类），逗号分隔。 */
        extraSkipSelector: '',
    };

    // =========================================================================
    // 文本规则（纯函数，不碰 DOM，node 里可以直接测）
    // =========================================================================

    /*
     * CJK 字符集。刻意不含：
     *   　-〿 的标点（、。「」等）—— 全角标点旁不加空格，靠的就是它们不在这里
     *   ・ 片假名中点「・」—— 是标点
     *   ㌀-㏿ 兼容字符（㎡ ㎏）—— 是单位，「100㎡」不该拆开
     *   ＀-￯ 全角 ASCII 与全角标点
     * 扩展 B 及以后在补充平面，要配 u 标志用 \u{...} 写。
     */
    const C = [
        '\\u2e80-\\u2eff\\u2f00-\\u2fdf',          // 部首
        '\\u3005\\u3007\\u3021-\\u3029',           // 々 〇 苏州码子
        '\\u3040-\\u309f\\u30a0-\\u30fa\\u30fc-\\u30ff\\u31f0-\\u31ff', // 平假名、片假名（不含・）
        '\\u3100-\\u312f\\u31a0-\\u31bf',          // 注音
        '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff', // 扩展 A、基本区、兼容表意
        '\\uff66-\\uff9f',                        // 半角片假名
        '\\u1100-\\u11ff\\u3130-\\u318f\\uac00-\\ud7af', // 韩文字母、谚文音节
        '\\u{20000}-\\u{2fa1f}\\u{30000}-\\u{323af}', // 扩展 B–H、兼容补充
    ].join('');

    /** 「字母数字」：ASCII 字母数字 + 拉丁扩展、希腊、西里尔字母（café、α、Москва 和英文同等对待）。 */
    const A = 'A-Za-z0-9\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u024f\\u0370-\\u03ff\\u0400-\\u04ff';

    const HAS_CJK = new RegExp(`[${C}]`, 'u');
    const IS_CJK = new RegExp(`^[${C}]$`, 'u');
    const WORD = new RegExp(`^[${C}${A}]$`, 'u');

    /**
     * 有序规则表：按顺序对整段文字做 replace。每条规则只在两个非空白字符之间插入一个空格，
     * 不删、不换别的字符 —— 这样「已有空格不重复加」天然成立，跨节点判断也能靠对齐找出插入位置。
     */
    const RULES = [
        /*
         * 微博式话题「#话题#」整体当一个词，两侧挨着文字就加空格。必须排在单个 # 的规则前面。
         * 前面不能紧跟字母数字：「C#和F#都」里第一个 # 是 C# 的后缀，不是话题开头，
         * 不挡的话「#和F#」会被当成话题。
         */
        {
            name: '#话题#',
            re: new RegExp(`(?<![${A}#])#[^#\\s]*[${C}][^#\\s]*#`, 'gu'),
            to: (m, off, s) => wrap(m, off, s, WORD),
        },
        { name: 'CJK + 字母数字', re: new RegExp(`([${C}])(?=[${A}])`, 'gu'), to: '$1 ' },
        { name: '字母数字 + CJK', re: new RegExp(`([${A}])(?=[${C}])`, 'gu'), to: '$1 ' },
        /*
         * 后缀符号跟着前面的词走：「100%」「C++」「C#」「30°」「25℃」是一个整体，
         * 空格加在符号后面，不加在符号和数字/字母之间。
         */
        { name: '后缀符号 + CJK', re: new RegExp(`([${A}][+#%°℃]+)(?=[${C}])`, 'gu'), to: '$1 ' },
        /*
         * 前缀符号跟着后面的词走：「#标签」「@用户」「$100」，空格加在符号前面。
         * $ 只认后面跟数字的（「$PATH」是变量名，前面多半就是英文）。
         */
        { name: 'CJK + #标签 / @用户', re: new RegExp(`([${C}])(?=[#@][${A}${C}])`, 'gu'), to: '$1 ' },
        { name: 'CJK + $金额', re: new RegExp(`([${C}])(?=\\$\\d)`, 'gu'), to: '$1 ' },
        /*
         * 半角括号：外侧挨着 CJK 加空格，内侧不加 —— 「用(括号)」→「用 (括号)」。
         * 全角括号（）本身带留白，不在规则里，所以不会被加空格。
         * 方括号不管：「文字[1]」这类引注标记习惯紧贴正文。
         */
        { name: 'CJK + (', re: new RegExp(`([${C}])(?=\\()`, 'gu'), to: '$1 ' },
        { name: ') + CJK', re: new RegExp(`\\)(?=[${C}])`, 'gu'), to: ') ' },
        /*
         * 半角双引号要配对才知道哪个是开、哪个是闭：「说"hello"然后」两侧都加，引号里面不加。
         * 单引号不处理：和英文撇号（it's）分不开。
         */
        {
            name: '"引号"',
            re: /"[^"\n]+"/g,
            to: (m, off, s) => wrap(m, off, s, IS_CJK),
        },
        /*
         * 字母数字后面的半角标点再接 CJK：「Hello,世界」→「Hello, 世界」。
         * 只认前面是字母数字的 —— CJK 后面跟半角标点（「中文,」）是标点误用，不归这里管。
         */
        { name: '半角标点 + CJK', re: new RegExp(`([${A}][.,!?;:]+)(?=[${C}])`, 'gu'), to: '$1 ' },
    ];

    /**
     * 一个整体（话题、引号对）两侧：邻居字符命中 re 就补一个空格。
     * 邻居按码点取，不能 s[off - 1]：扩展 B 的字是代理对，单取一半永远不匹配。
     */
    function wrap(m, off, s, re) {
        const before = off > 0 ? Array.from(s.slice(Math.max(0, off - 2), off)).pop() : '';
        const cp = s.codePointAt(off + m.length);
        const after = cp === undefined ? '' : String.fromCodePoint(cp);
        return (re.test(before) ? ' ' : '') + m + (re.test(after) ? ' ' : '');
    }

    /*
     * 内部不能动的片段：URL、邮箱、文件路径、版本号、时间。
     * URL 的路径/查询/锚点里允许出现 CJK（维基链接、搜索链接很常见），一直吃到空白、全角标点、
     * 引号括号为止 —— 「…/wiki/C++教程」要是不当一个整体，会被拆成「C++ 教程」，链接就坏了。
     * 代价是「访问https://a.com/了解更多」后面那半句被当成 URL 的一部分、不加空格；
     * 宁可少加一个空格，不可把链接加坏。
     * 文件路径只认 ASCII 段：「/usr/local/bin下」里的「下」是正文。
     */
    const STOP = '\\s<>"\'()\\[\\]{}\\u3000-\\u303f\\uff00-\\uffef\\u2018-\\u201f\\u2026\\u2014';
    const URL_TAIL = `(?::\\d+)?(?:[/?#][^${STOP}]*)?`;
    const PROTECT = new RegExp([
        `[A-Za-z][A-Za-z0-9+.-]*://[A-Za-z0-9.-]+${URL_TAIL}`,              // 带协议的 URL
        `\\bwww\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+${URL_TAIL}`,          // www. 开头的网址
        '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+',             // 邮箱
        '(?:~|\\.{1,2})?(?:/[\\w.@+-]+){2,}/?|~/[\\w.@+/-]*',               // Unix 路径（至少两段）、~/xxx
        '\\b[A-Za-z]:\\\\[\\w.\\\\-]*',                                    // Windows 路径
        '\\b[vV]?\\d+(?:\\.\\d+){1,3}(?:-[0-9A-Za-z.]+)?(?:\\+[0-9A-Za-z.]+)?', // 版本号、小数、IP
        '\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b',                                // 时间
    ].join('|'), 'gu');

    /**
     * 占位符：U+FDD0 是 Unicode 保证不会出现在正常文本里的「非字符」。
     * 不用私用区（\ue000 起）—— 图标字体把图标塞在那里，页面文字里真会有。
     */
    const HOLD = '\ufdd0';

    /**
     * 只把片段的「内部」换成占位符，首尾字符留在原处：片段两侧该不该加空格，
     * 照常由首尾字符和邻居按规则决定（「v1.2.3发布」→ 3 和「发」之间照加），
     * 内部一个字都不会被规则看到。
     */
    function hold(text, held) {
        if (text.includes(HOLD)) return text;
        return text.replace(PROTECT, (m) => {
            const cps = Array.from(m);
            if (cps.length < 3) return m;
            held.push(cps.slice(1, -1).join(''));
            return cps[0] + HOLD + cps[cps.length - 1];
        });
    }

    function applyRules(s) {
        for (const r of RULES) s = s.replace(r.re, r.to);
        return s;
    }

    function spacing(text) {
        if (!text || !HAS_CJK.test(text)) return text;
        const held = [];
        let s = applyRules(hold(text, held));
        if (held.length) {
            let i = 0;
            s = s.replace(/\ufdd0/g, () => held[i++]);
        }
        return s;
    }

    /** 跨节点判断时两侧各取多少字符做上下文：要够装下一个 URL，又不至于每次都跑整段。 */
    const JUNCTION_WINDOW = 128;

    /**
     * 两段相邻文字（分属两个节点）拼起来时，交界处要不要加空格。
     * 做法是拼起来跑一遍同一张规则表，再逐字对齐找插入位置 —— 规则只会插空格，
     * 所以输出 = 原文 + 若干空格，能对齐出每个空格插在哪。不为跨节点另写一套规则。
     * 保护片段两侧分开算：节点边界本身就说明链接文字到此为止，
     * 「<a>https://a.com/x</a>中文」不能把后面的中文也吃进 URL。
     */
    function junction(left, right) {
        const L = left.slice(-JUNCTION_WINDOW);
        const R = right.slice(0, JUNCTION_WINDOW);
        if (!L || !R || /\s$/.test(L) || /^\s/.test(R)) return false;
        if (!HAS_CJK.test(L + R)) return false;
        const hl = hold(L, []);
        const joined = hl + hold(R, []);
        const out = applyRules(joined);
        if (out === joined) return false;
        for (let i = 0, j = 0; j < out.length; j++) {
            if (out[j] === joined[i]) i++;
            else if (i === hl.length) return true;  // out[j] 是插进来的空格，正好在交界处
            else if (i > hl.length) return false;
        }
        return false;
    }

    // node 里测试规则用：没有 document 就只导出纯函数，不往下跑
    if (typeof document === 'undefined') {
        if (typeof module === 'object' && module) module.exports = { spacing, junction, RULES };
        return;
    }

    function log(...args) {
        if (CONFIG.debug) console.log(TAG, ...args);
    }

    // =========================================================================
    // DOM：跳过规则
    // =========================================================================

    const Skip = (() => {
        let selector = CONFIG.skipSelector;

        /** 用户选择器写错了不能让整个脚本挂掉：校验一遍，坏的丢掉并提示。 */
        function setExtra(extra) {
            selector = CONFIG.skipSelector;
            if (!extra || !extra.trim()) return true;
            try {
                document.createDocumentFragment().querySelector(extra);
            } catch (e) {
                console.warn(TAG, '跳过选择器写错了，已忽略：', extra);
                return false;
            }
            selector += ', ' + extra;
            return true;
        }

        /** 元素自己要不要整棵跳过。 */
        function self(el) {
            // isContentEditable 兜住 designMode 和继承来的可编辑状态（属性选择器只看得到元素自己）
            return el.matches(selector) || el.isContentEditable;
        }

        /** 节点在不在某个被跳过的子树里（从节点往上找）。 */
        function inside(node) {
            const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (!el) return true;
            return !!el.closest(selector) || el.isContentEditable;
        }

        setExtra(CONFIG.extraSkipSelector);
        return { self, inside, setExtra };
    })();

    // =========================================================================
    // DOM：收集与处理
    // =========================================================================

    /*
     * 行内元素：它两侧的文字在视觉上连成一行，交界处要按规则判断。
     * 不在表里的元素（块级、br、img、button、sup/sub、ruby、q…）都当断点：
     * sup 是脚注角标，「文字<sup>1</sup>」不该加空格；q 自己会画引号；button 有自己的边框。
     */
    const INLINE = new Set([
        'A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS',
        'LABEL', 'MARK', 'NOBR', 'S', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'TIME', 'TT', 'U', 'VAR',
    ]);
    /**
     * 被跳过、但仍然算「一个词」的行内元素：里面不动，两侧的文字照样和它比较。
     * 「使用<code>npm</code>安装」→「使用 <code>npm</code> 安装」，空格加在 code 外面。
     */
    const ATOM = new Set(['CODE', 'KBD', 'SAMP']);
    /**
     * 空格落在里面会被看见的元素：下划线、删除线、底色会把空格也画出来。
     * 跨节点的空格优先加在不被这些元素包着的那一侧。
     */
    const DECORATED = new Set(['A', 'ABBR', 'DEL', 'INS', 'MARK', 'S', 'STRIKE', 'U']);

    /** 收集结果里的断点：两侧不再做交界判断。 */
    const BREAK = null;

    /**
     * 把 root 下的文字节点按文档顺序收集成序列：文字节点 / 断点 / 原子元素。
     * 先收集、后处理：收集只读、很快，处理可以分批放进空闲时间。
     */
    function collect(root) {
        const items = [];
        const walk = (node) => {
            for (let c = node.firstChild; c; c = c.nextSibling) {
                if (c.nodeType === Node.TEXT_NODE) {
                    if (c.nodeValue) items.push(c);
                } else if (c.nodeType === Node.ELEMENT_NODE) {
                    if (Skip.self(c)) {
                        items.push(CONFIG.spaceAroundCode && ATOM.has(c.tagName) ? c : BREAK);
                        continue;
                    }
                    const inline = INLINE.has(c.tagName);
                    if (!inline) items.push(BREAK);
                    walk(c);
                    if (!inline) items.push(BREAK);
                }
            }
        };
        if (root.nodeType === Node.TEXT_NODE) items.push(root);
        else walk(root);
        return items;
    }

    /*
     * 自己写过的节点记下「改之前 / 改之后」：
     *   - MutationObserver 收到 characterData，值等于我们写的 → 是自己触发的，忽略（防无限循环）
     *   - 值又变回改之前 → 页面把它改回去了（框架重渲染、或者页面自己在守着这段文字）。
     *     被改回去几次就认输、不再碰这个节点，不和页面来回拉锯
     * WeakMap / WeakSet：节点被页面删掉后跟着回收，不拖住内存。
     */
    const written = new WeakMap();
    const surrendered = new WeakSet();

    function write(node, value) {
        const rec = written.get(node);
        written.set(node, { before: rec && rec.after === node.nodeValue ? rec.before : node.nodeValue, after: value, reverts: rec ? rec.reverts : 0 });
        // 只改 nodeValue：不碰 innerHTML，页面的事件绑定、框架持有的节点引用都还在
        node.nodeValue = value;
    }

    /** 观察到文字节点变化：是不是我们自己写的。顺带记下「被页面改回去」的次数。 */
    function isOwnWrite(node) {
        const rec = written.get(node);
        if (!rec) return false;
        if (node.nodeValue === rec.after) return true;
        if (node.nodeValue === rec.before && ++rec.reverts >= CONFIG.maxReverts) {
            surrendered.add(node);
            log('页面反复把这段文字改回去，不再处理：', rec.before);
        }
        return false;
    }

    function processText(node) {
        if (surrendered.has(node)) return false;
        const v = node.nodeValue;
        const next = spacing(v);
        if (next === v) return false;
        write(node, next);
        return true;
    }

    /** 从文字节点往上到 stop（不含）的「代价」：每层 1，带装饰的元素 100。 */
    function sideCost(node, stop) {
        let cost = 0;
        for (let el = node.parentElement; el && el !== stop; el = el.parentElement) {
            cost += DECORATED.has(el.tagName) ? 100 : 1;
        }
        return cost;
    }

    function commonAncestor(a, b) {
        const seen = new Set();
        for (let el = a.parentElement; el; el = el.parentElement) seen.add(el);
        for (let el = b.parentElement; el; el = el.parentElement) if (seen.has(el)) return el;
        return null;
    }

    /**
     * 两个相邻项之间要空格时，空格放哪边：
     *   - 一边是原子元素（code）：只能放在文字那边
     *   - 两边都是文字：放在离共同祖先更「浅」、且不在下划线/删除线里的那边，
     *     「中文<b>English</b>」放在「中文」末尾，「<a>链接</a>中文」放在「中文」开头；
     *     一样深就放左边末尾
     */
    function join(prev, cur) {
        const prevText = prev.nodeType === Node.TEXT_NODE;
        const curText = cur.nodeType === Node.TEXT_NODE;
        if (!prevText && !curText) return;
        if (!junction(prevText ? prev.nodeValue : prev.textContent, curText ? cur.nodeValue : cur.textContent)) return;
        let left = prevText;
        if (prevText && curText) {
            const top = commonAncestor(prev, cur);
            left = sideCost(prev, top) <= sideCost(cur, top);
        }
        const target = left ? prev : cur;
        if (surrendered.has(target)) return;
        if (left) write(prev, prev.nodeValue + ' ');
        else write(cur, ' ' + cur.nodeValue);
    }

    /** 处理 items[from, to)，state.prev 跨批次保留，分批不影响交界判断。 */
    function runItems(items, from, to, state) {
        for (let i = from; i < to; i++) {
            const item = items[i];
            if (item === BREAK || !item.isConnected) {
                state.prev = null;
                continue;
            }
            if (item.nodeType === Node.TEXT_NODE) processText(item);
            if (state.prev) join(state.prev, item);
            state.prev = item;
        }
    }

    // =========================================================================
    // 调度：空闲时间分批处理
    // =========================================================================

    /** 节点所在的「块」：交界判断不跨块，所以处理一个变化只需要重跑它所在的块。 */
    function blockOf(node) {
        let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        while (el && el !== document.body && (INLINE.has(el.tagName) || ATOM.has(el.tagName))) el = el.parentElement;
        return el;
    }

    const Queue = (() => {
        const roots = new Set();
        let job = null;          // { items, i, state }
        let scheduled = false;

        const idle = typeof requestIdleCallback === 'function'
            ? (fn) => requestIdleCallback(fn, { timeout: CONFIG.idleTimeout })
            : (fn) => setTimeout(() => fn(null), 16);

        function schedule() {
            if (scheduled) return;
            scheduled = true;
            idle(work);
        }

        function add(node) {
            const root = blockOf(node);
            if (!root) return;
            roots.add(root);
            schedule();
        }

        /** 祖先已经在队列里，等祖先处理时一起覆盖。 */
        function covered(root) {
            for (let a = root.parentElement; a; a = a.parentElement) if (roots.has(a)) return true;
            return false;
        }

        function nextJob() {
            for (const root of roots) {
                roots.delete(root);
                if (!root.isConnected || covered(root) || Skip.inside(root)) continue;
                return { items: collect(root), i: 0, state: { prev: null } };
            }
            return null;
        }

        /*
         * 每片最多处理 batchSize 项，片与片之间看还有没有空闲时间：
         * 大页面首次处理（几万个文字节点）摊到多个空闲回调里，不占着主线程。
         * 等太久（idleTimeout）浏览器会强制回调，这时 timeRemaining() 是 0，按 sliceMs 自己限时。
         */
        function work(deadline) {
            scheduled = false;
            const start = performance.now();
            const hasTime = () => (deadline && !deadline.didTimeout
                ? deadline.timeRemaining() > 1
                : performance.now() - start < CONFIG.sliceMs);
            do {
                if (!job) job = nextJob();
                if (!job) break;
                const end = Math.min(job.i + CONFIG.batchSize, job.items.length);
                runItems(job.items, job.i, end, job.state);
                job.i = end;
                if (job.i >= job.items.length) job = null;
            } while (hasTime());
            if (job || roots.size) schedule();
        }

        return { add };
    })();

    // =========================================================================
    // 动态内容
    // =========================================================================

    function observe() {
        const mo = new MutationObserver((records) => {
            // 同一个节点一批里可能有好几条记录（我们写一次、页面改回去一次），按节点去重，
            // 否则「被改回去」会一次记两回
            const texts = new Set();
            for (const r of records) {
                if (r.type === 'characterData') {
                    texts.add(r.target);
                    continue;
                }
                for (const n of r.addedNodes) {
                    if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.ELEMENT_NODE) Queue.add(n);
                }
                // 删掉中间的元素后，两边的文字可能变成相邻，要重新判断交界
                if (r.removedNodes.length) Queue.add(r.target);
            }
            for (const n of texts) if (!isOwnWrite(n)) Queue.add(n);
        });
        mo.observe(document.body, { childList: true, characterData: true, subtree: true });
        return mo;
    }

    if (document.body) {
        Queue.add(document.body);
        observe();
    }
})();
