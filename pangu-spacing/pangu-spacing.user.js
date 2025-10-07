// ==UserScript==
// @name         中英文自动加空格（盘古之白）
// @name:zh-CN   中英文自动加空格（盘古之白）
// @name:en      Pangu Spacing — Auto Space Between CJK and Latin Text
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.10.07.2
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
        /** 这些元素整棵子树都不处理。 */
        skipSelector: 'code, pre, kbd, samp, script, style, textarea, input, svg, math',
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

    function spacing(text) {
        if (!text || !HAS_CJK.test(text)) return text;
        let s = text;
        for (const r of RULES) s = s.replace(r.re, r.to);
        return s;
    }

    // node 里测试规则用：没有 document 就只导出纯函数，不往下跑
    if (typeof document === 'undefined') {
        if (typeof module === 'object' && module) module.exports = { spacing, RULES };
        return;
    }

    function log(...args) {
        if (CONFIG.debug) console.log(TAG, ...args);
    }

    // =========================================================================
    // DOM：遍历文字节点
    // =========================================================================

    function processTree(root) {
        let changed = 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                if (n.nodeType === Node.ELEMENT_NODE) {
                    return n.matches(CONFIG.skipSelector) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const v = n.nodeValue;
            const next = spacing(v);
            // 只改 nodeValue：不碰 innerHTML，页面的事件绑定、框架持有的节点引用都还在
            if (next !== v) {
                n.nodeValue = next;
                changed++;
            }
        }
        return changed;
    }

    if (document.body) log('处理了', processTree(document.body), '个文字节点');
})();
