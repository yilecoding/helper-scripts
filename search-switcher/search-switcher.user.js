// ==UserScript==
// @name         搜索引擎一键切换
// @name:zh-CN   搜索引擎一键切换
// @name:en      Search Engine Switcher
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.06.27.3
// @description  在搜索结果页放一条引擎切换栏，带着同一个关键词一键跳到别的引擎：百度 / Google / Bing / DuckDuckGo / 搜狗 / 360 / Yandex，GitHub / Stack Overflow，知乎 / B站 / 抖音 / 微信 / 小红书。
// @description:zh-CN  在搜索结果页放一条引擎切换栏，带着同一个关键词一键跳到别的引擎：百度 / Google / Bing / DuckDuckGo / 搜狗 / 360 / Yandex，GitHub / Stack Overflow，知乎 / B站 / 抖音 / 微信 / 小红书。
// @description:en  Adds an engine switcher bar to search result pages: jump with the same query to Baidu / Google / Bing / DuckDuckGo / Sogou / 360 / Yandex, GitHub / Stack Overflow, Zhihu / Bilibili / Douyin / WeChat (Sogou) / Xiaohongshu.
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
// @match        https://github.com/search*
// @match        https://stackoverflow.com/search*
// @match        https://www.zhihu.com/search*
// @match        https://search.bilibili.com/*
// @match        https://www.douyin.com/search/*
// @match        https://weixin.sogou.com/weixin*
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
        layout: 'side',        // 'side' 贴左侧竖排 | 'top' 顶部横条
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
     *   pathKey 关键词在路径里的（抖音），正则第 1 组
     *   input   搜索框选择器（后面 URL 里取不到时兜底用）
     *   group   分组，切换栏按分组首次出现的顺序排
     * 没有 hosts 的引擎只作跳转目标，不在它的页面上注入（见小红书）。
     */
    const ENGINES = [
        {
            id: 'baidu', name: '百度', group: '网页', url: 'https://www.baidu.com/s?wd=%s',
            // m.baidu.com 用的是 word 不是 wd
            hosts: /^(www|m)\.baidu\.com$/, path: /^\/s$/, params: ['wd', 'word'], input: '#kw',
        },
        {
            id: 'google', name: 'Google', group: '网页', url: 'https://www.google.com/search?q=%s',
            hosts: /^www\.google\.(com|com\.hk|com\.tw|co\.jp|co\.uk|co\.kr|de|fr|ca|com\.au|com\.sg)$/,
            path: /^\/search$/, params: ['q'], input: 'textarea[name="q"], input[name="q"]',
        },
        {
            id: 'bing', name: 'Bing', group: '网页', url: 'https://www.bing.com/search?q=%s',
            hosts: /^(www|cn)\.bing\.com$/, path: /^\/search$/, params: ['q'], input: '#sb_form_q',
        },
        {
            id: 'ddg', name: 'DuckDuckGo', group: '网页', url: 'https://duckduckgo.com/?q=%s',
            // DDG 的结果页就是根路径带 ?q=，首页也是根路径 —— 区分靠有没有关键词
            hosts: /^duckduckgo\.com$/, path: /^\/$/, params: ['q'], input: 'input[name="q"]',
        },
        {
            id: 'sogou', name: '搜狗', group: '网页', url: 'https://www.sogou.com/web?query=%s',
            hosts: /^www\.sogou\.com$/, path: /^\/(web|sogou)$/, params: ['query'], input: '#upquery',
        },
        {
            id: 'so360', name: '360', group: '网页', url: 'https://www.so.com/s?q=%s',
            hosts: /^www\.so\.com$/, path: /^\/s$/, params: ['q'], input: '#keyword',
        },
        {
            id: 'yandex', name: 'Yandex', group: '网页', url: 'https://yandex.com/search/?text=%s',
            hosts: /^(yandex\.(com|ru)|ya\.ru)$/, path: /^\/search\/?$/, params: ['text'], input: 'input[name="text"]',
        },
        {
            id: 'github', name: 'GitHub', group: '技术', url: 'https://github.com/search?q=%s&type=repositories',
            hosts: /^github\.com$/, path: /^\/search$/, params: ['q'], input: '#query-builder-test',
        },
        {
            id: 'so', name: 'Stack Overflow', group: '技术', url: 'https://stackoverflow.com/search?q=%s',
            hosts: /^stackoverflow\.com$/, path: /^\/search$/, params: ['q'], input: 'input[name="q"]',
        },
        {
            id: 'zhihu', name: '知乎', group: '视频社区', url: 'https://www.zhihu.com/search?type=content&q=%s',
            hosts: /^www\.zhihu\.com$/, path: /^\/search$/, params: ['q'], input: 'input[type="search"]',
        },
        {
            id: 'bilibili', name: 'B站', group: '视频社区', url: 'https://search.bilibili.com/all?keyword=%s',
            // /all /video /bangumi /upuser … 都是结果页的不同页签
            hosts: /^search\.bilibili\.com$/, path: /^\/[a-z]*\/?$/, params: ['keyword'], input: 'input.search-input-el',
        },
        {
            /*
             * 关键词在路径里：/search/<关键词>?type=general。
             * 路径不是表单编码，+ 就是加号不是空格 —— 不能丢给 URLSearchParams 解。
             */
            id: 'douyin', name: '抖音', group: '视频社区', url: 'https://www.douyin.com/search/%s',
            hosts: /^www\.douyin\.com$/, path: /^\/search\/[^/]+\/?$/, params: [], pathKey: /^\/search\/([^/]+)/,
            input: 'input[data-e2e="searchbar-input"]',
        },
        {
            id: 'weixin', name: '微信', group: '视频社区', url: 'https://weixin.sogou.com/weixin?type=2&query=%s',
            hosts: /^weixin\.sogou\.com$/, path: /^\/weixin$/, params: ['query'], input: '#query',
        },
        {
            /*
             * 只作跳转目标。小红书网页版搜索要登录，未登录打开结果页是登录弹窗，
             * 结果页结构没法在不登录的前提下核实，所以不往它的页面里注入（不加 @match）。
             * search_result?keyword= 这个地址格式登录后可用。
             */
            id: 'xhs', name: '小红书', group: '视频社区',
            url: 'https://www.xiaohongshu.com/search_result?keyword=%s&source=web_search_result_notes',
        },
    ];

    // =========================================================================
    // 关键词：解析与构造
    // =========================================================================

    function engineOf(loc) {
        return ENGINES.find((e) => e.hosts && e.hosts.test(loc.hostname) && e.path.test(loc.pathname)) || null;
    }

    function keywordFromUrl(engine, loc) {
        const q = new URLSearchParams(loc.search);
        for (const name of engine.params) {
            const v = (q.get(name) || '').trim();
            if (v) return v;
        }
        if (engine.pathKey) {
            const m = loc.pathname.match(engine.pathKey);
            if (m) {
                try {
                    return decodeURIComponent(m[1]).trim();
                } catch (e) {
                    // 残缺的 %xx 会抛 URIError，当没取到
                }
            }
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
            --bg: #fff; --fg: #333; --muted: #999; --line: #e5e5e5; --hover: #f0f2f5;
            --accent: #2468f2; --accent-fg: #fff;
            position: fixed; z-index: 2147483000;
            display: flex; gap: 2px; padding: 6px 4px;
            font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            color: var(--fg); background: var(--bg); border: 1px solid var(--line);
            box-shadow: 0 2px 10px rgba(0, 0, 0, .12);
            opacity: .92; transition: opacity .15s;
        }
        .bar:hover { opacity: 1; }
        .bar.dark {
            --bg: #26282c; --fg: #e3e3e3; --muted: #8a8d93; --line: #3c3f44; --hover: #34373c;
            --accent: #8ab4f8; --accent-fg: #1a1b1e;
            box-shadow: 0 2px 10px rgba(0, 0, 0, .5);
        }

        .side {
            left: 0; top: 50%; transform: translateY(-50%); flex-direction: column;
            border-left: 0; border-radius: 0 8px 8px 0; max-height: 90vh; overflow-y: auto;
        }
        .side .group + .group { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--line); }
        .side .label { padding: 0 10px; }

        .top {
            top: 0; left: 50%; transform: translateX(-50%); flex-direction: row; align-items: center;
            border-top: 0; border-radius: 0 0 8px 8px; padding: 3px 6px; max-width: 96vw; overflow-x: auto;
        }
        .top .group { display: flex; align-items: center; gap: 2px; }
        .top .group + .group { margin-left: 4px; padding-left: 6px; border-left: 1px solid var(--line); }
        .top .label { padding: 0 4px 0 0; }

        .label { font-size: 11px; color: var(--muted); user-select: none; white-space: nowrap; }
        a {
            display: block; padding: 3px 10px; border-radius: 5px;
            color: var(--fg); text-decoration: none; white-space: nowrap;
        }
        a:hover { background: var(--hover); }
        a[aria-current="page"] { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
    `;

    /** 按 group 分组，组的顺序 = 该组第一次出现的位置。 */
    function groupBy(engines) {
        const map = new Map();
        for (const e of engines) {
            const g = e.group || '其他';
            if (!map.has(g)) map.set(g, []);
            map.get(g).push(e);
        }
        return map;
    }

    /**
     * 页面是不是深色。看页面自己的背景色，不只看系统偏好：
     * Google / Bing 的深色模式是站内开关，和 prefers-color-scheme 无关；
     * 反过来系统是深色、站点照样白底的情况也很常见。
     * body 透明就看 <html>，都读不出来（透明 / 颜色写法不认识）才退回系统偏好。
     */
    function pageIsDark() {
        for (const el of [document.body, document.documentElement]) {
            if (!el) continue;
            const m = getComputedStyle(el).backgroundColor.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
            if (!m || (m[4] !== undefined && Number(m[4]) === 0)) continue;
            const lum = (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255;
            return lum < 0.5;
        }
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

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

        function render(keyword, current) {
            if (!host) mount();
            root.textContent = '';
            const style = document.createElement('style');
            style.textContent = CSS;
            const bar = document.createElement('nav');
            bar.className = `bar ${CONFIG.layout === 'top' ? 'top' : 'side'}${pageIsDark() ? ' dark' : ''}`;
            bar.setAttribute('aria-label', '切换搜索引擎');
            for (const [group, engines] of groupBy(ENGINES)) {
                const sec = document.createElement('div');
                sec.className = 'group';
                const label = document.createElement('div');
                label.className = 'label';
                label.textContent = group;
                sec.appendChild(label);
                for (const e of engines) {
                    const a = document.createElement('a');
                    a.dataset.engine = e.id;
                    a.textContent = e.name;
                    a.href = buildUrl(e.url, keyword);
                    // 关键词会出现在 Referer 里带给下一家，没必要
                    a.rel = 'noreferrer';
                    if (CONFIG.openInNewTab) a.target = '_blank';
                    if (current && e.id === current.id) a.setAttribute('aria-current', 'page');
                    sec.appendChild(a);
                }
                bar.appendChild(sec);
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
        Bar.render(keyword, engine);
        console.log(TAG, `当前 ${engine.name}，关键词「${keyword}」`);
    }

    try {
        boot();
    } catch (e) {
        console.error(TAG, '启动失败', e);
    }
})();
