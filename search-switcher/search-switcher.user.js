// ==UserScript==
// @name         搜索引擎一键切换
// @name:zh-CN   搜索引擎一键切换
// @name:en      Search Engine Switcher
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.06.26.1
// @description  在搜索结果页放一条引擎切换栏，带着同一个关键词一键跳到百度 / Google / Bing / DuckDuckGo / 搜狗 / 360 / Yandex。
// @description:zh-CN  在搜索结果页放一条引擎切换栏，带着同一个关键词一键跳到百度 / Google / Bing / DuckDuckGo / 搜狗 / 360 / Yandex。
// @description:en  Adds an engine switcher bar to search result pages: jump to Baidu / Google / Bing / DuckDuckGo / Sogou / 360 / Yandex with the same query in one click.
// @author       壹樂（V：ita1125）
// @match        https://www.baidu.com/s*
// @match        https://m.baidu.com/s*
// @match        https://www.google.com/search*
// @match        https://www.google.com.hk/search*
// @match        https://www.google.com.tw/search*
// @match        https://www.google.co.jp/search*
// @match        https://www.google.co.uk/search*
// @match        https://www.google.co.kr/search*
// @match        https://www.google.de/search*
// @match        https://www.google.fr/search*
// @match        https://www.google.ca/search*
// @match        https://www.google.com.au/search*
// @match        https://www.google.com.sg/search*
// @match        https://www.bing.com/search*
// @match        https://cn.bing.com/search*
// @match        https://duckduckgo.com/*
// @match        https://www.sogou.com/web*
// @match        https://www.sogou.com/sogou*
// @match        https://www.so.com/s*
// @match        https://yandex.com/search*
// @match        https://yandex.ru/search*
// @match        https://ya.ru/search*
// @grant        none
// @license      CC BY-NC-SA
// @run-at       document-end
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/search-switcher/search-switcher.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/search-switcher/search-switcher.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 统一日志前缀。控制台过滤框输入「搜索切换」即可只看本脚本的日志。 */
    const TAG = '[搜索切换]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        openInNewTab: false,   // true = 切换时总是开新标签（不按 Ctrl 也开）
    };

    // =========================================================================
    // 引擎表
    // =========================================================================

    /*
     * 每个引擎：
     *   url     搜索 URL 模板，%s 处填 encodeURIComponent 过的关键词
     *   hosts   结果页域名（正则），path 结果页路径（正则）—— 两者都命中才算「在这个引擎的结果页上」
     *   params  从 URL 取关键词的参数名，按顺序取第一个非空的
     *   input   搜索框选择器（后面 URL 里取不到时兜底用）
     */
    const ENGINES = [
        {
            id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=%s',
            // m.baidu.com 用的是 word 不是 wd
            hosts: /^(www|m)\.baidu\.com$/, path: /^\/s$/, params: ['wd', 'word'], input: '#kw',
        },
        {
            id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s',
            hosts: /^www\.google\.(com|com\.hk|com\.tw|co\.jp|co\.uk|co\.kr|de|fr|ca|com\.au|com\.sg)$/,
            path: /^\/search$/, params: ['q'], input: 'textarea[name="q"], input[name="q"]',
        },
        {
            id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s',
            hosts: /^(www|cn)\.bing\.com$/, path: /^\/search$/, params: ['q'], input: '#sb_form_q',
        },
        {
            id: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s',
            // DDG 的结果页就是根路径带 ?q=，首页也是根路径 —— 区分靠有没有关键词
            hosts: /^duckduckgo\.com$/, path: /^\/$/, params: ['q'], input: 'input[name="q"]',
        },
        {
            id: 'sogou', name: '搜狗', url: 'https://www.sogou.com/web?query=%s',
            hosts: /^www\.sogou\.com$/, path: /^\/(web|sogou)$/, params: ['query'], input: '#upquery',
        },
        {
            id: 'so360', name: '360', url: 'https://www.so.com/s?q=%s',
            hosts: /^www\.so\.com$/, path: /^\/s$/, params: ['q'], input: '#keyword',
        },
        {
            id: 'yandex', name: 'Yandex', url: 'https://yandex.com/search/?text=%s',
            hosts: /^(yandex\.(com|ru)|ya\.ru)$/, path: /^\/search\/?$/, params: ['text'], input: 'input[name="text"]',
        },
    ];

    // =========================================================================
    // 关键词：解析与构造
    // =========================================================================

    function engineOf(loc) {
        return ENGINES.find((e) => e.hosts.test(loc.hostname) && e.path.test(loc.pathname)) || null;
    }

    function keywordFromUrl(engine, loc) {
        const q = new URLSearchParams(loc.search);
        for (const name of engine.params) {
            const v = (q.get(name) || '').trim();
            if (v) return v;
        }
        return '';
    }

    /**
     * 填模板。replace 必须传函数：传字符串的话关键词里的 $& / $' / $1
     * 会被当成替换模式展开（encodeURIComponent 不转义 $）。
     */
    function buildUrl(template, keyword) {
        const enc = encodeURIComponent(keyword);
        return template.replace(/%s/g, () => enc);
    }

    // =========================================================================
    // 切换栏
    // =========================================================================

    const CSS = `
        :host { all: initial; }
        .bar {
            position: fixed; z-index: 2147483000; left: 0; top: 50%; transform: translateY(-50%);
            display: flex; flex-direction: column; gap: 2px; padding: 6px 4px;
            font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            background: #fff; border: 1px solid #ddd; border-left: 0; border-radius: 0 8px 8px 0;
            box-shadow: 0 2px 10px rgba(0, 0, 0, .12);
        }
        a {
            display: block; padding: 3px 10px; border-radius: 5px;
            color: #333; text-decoration: none; white-space: nowrap;
        }
        a:hover { background: #f0f2f5; }
    `;

    const Bar = (() => {
        let host = null;
        let root = null;

        function mount() {
            host = document.createElement('div');
            host.id = 'search-switcher';
            root = host.attachShadow({ mode: 'open' });
            // 挂在 <html> 下而不是 <body>：结果页是 SPA 时 body 内容会被整块重渲染
            document.documentElement.appendChild(host);
        }

        function render(keyword) {
            if (!host) mount();
            root.textContent = '';
            const style = document.createElement('style');
            style.textContent = CSS;
            const bar = document.createElement('nav');
            bar.className = 'bar';
            for (const e of ENGINES) {
                const a = document.createElement('a');
                a.dataset.engine = e.id;
                a.textContent = e.name;
                a.href = buildUrl(e.url, keyword);
                // 关键词会出现在 Referer 里带给下一家，没必要
                a.rel = 'noreferrer';
                if (CONFIG.openInNewTab) a.target = '_blank';
                bar.appendChild(a);
            }
            root.append(style, bar);
        }

        return { render };
    })();

    // =========================================================================
    // 启动
    // =========================================================================

    function boot() {
        const engine = engineOf(location);
        if (!engine) return;
        const keyword = keywordFromUrl(engine, location);
        if (!keyword) return;
        Bar.render(keyword);
        console.log(TAG, `当前 ${engine.name}，关键词「${keyword}」`);
    }

    try {
        boot();
    } catch (e) {
        console.error(TAG, '启动失败', e);
    }
})();
