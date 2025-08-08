// ==UserScript==
// @name         网页元素屏蔽
// @name:zh-CN   网页元素屏蔽
// @name:en      Element Hider — Pick and Hide Annoying Page Elements
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.08.08.1
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

    Styler.apply();
})();
