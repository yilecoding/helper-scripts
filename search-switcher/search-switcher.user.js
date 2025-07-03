// ==UserScript==
// @name         搜索引擎一键切换
// @name:zh-CN   搜索引擎一键切换
// @name:en      Search Engine Switcher
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.07.03.8
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
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
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
        layout: 'side',        // 'side' 贴左侧竖排 | 'top' 顶部横条。菜单里切换会存进 GM，优先于这里
        openInNewTab: false,   // true = 切换时总是开新标签（不按 Ctrl 也开）
        pollInterval: 1000,    // 地址轮询间隔（毫秒），事件漏掉时的兜底
        hotkeys: true,         // Alt+1…9 / Alt+0 切到第 1…9 / 10 个引擎（输入框里不响应）
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
    const BUILTIN = [
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
        return BUILTIN.find((e) => e.hosts && e.hosts.test(loc.hostname) && e.path.test(loc.pathname)) || null;
    }

    /**
     * hash 优先于 search：不刷新页面换关键词时，有的站只改 hash（/s?wd=旧#wd=新），
     * 这时 search 里留着的是上一个词。hash 里没有 = 的（#top、#ip=…以外的锚点）不当参数读。
     */
    function keywordFromUrl(engine, loc) {
        const sources = [];
        if (loc.hash.includes('=')) sources.push(new URLSearchParams(loc.hash.slice(1)));
        sources.push(new URLSearchParams(loc.search));
        for (const q of sources) {
            for (const name of engine.params) {
                const v = (q.get(name) || '').trim();
                // 含 U+FFFD 说明原文不是 UTF-8（老链接里的 GBK 编码，如 wd=%C4%E3%BA%C3）：
                // URLSearchParams 不报错，静默解成一串 �，拿去搜就是乱码。当没取到，交给搜索框兜底
                if (v && !v.includes('\uFFFD')) return v;
            }
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

    /** URL 里取不到时，读结果页搜索框里的词（页面自己把 GBK 解对了、或者是 POST 来的）。 */
    function keywordFromInput(engine) {
        if (!engine.input) return '';
        const el = document.querySelector(engine.input);
        return el && typeof el.value === 'string' ? el.value.trim() : '';
    }

    function currentKeyword(engine) {
        return keywordFromUrl(engine, location) || keywordFromInput(engine);
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
    // 自定义引擎列表（存 GM，菜单里编辑）
    // =========================================================================

    /*
     * 存的是用户编辑后的完整列表 + 保存时认识的内置 id：{ list: [{ id?, name, url, group?, hidden? }], known: [id…] }
     *   带内置 id 的项 = 那个内置引擎，可改名 / 改模板 / 改分组 / 调顺序，结果页识别规则仍用内置的
     *   不带 id 的项   = 自定义引擎，只作跳转目标（脚本只在 @match 的站点上运行，管不到它的页面）
     *   hidden: true  = 留在列表里但不显示（想再用改回 false 即可，不用重抄地址）
     *   删掉一项       = 也不显示，而且不会再自己回来
     * 不存「和默认的差异」：差异格式没法表达调顺序，用户也看不懂。
     *
     * known 的用处：脚本以后新增的内置引擎不在用户存过的 list 里，
     * 光看 list 分不清「用户删掉的」和「那时还没有的」。不在 known 里的才是新来的，追加到末尾。
     */
    const STORE_KEY = 'engines';
    const BUILTIN_BY_ID = new Map(BUILTIN.map((e) => [e.id, e]));
    const EDITABLE_KEYS = ['id', 'name', 'url', 'group', 'hidden'];

    /** 给编辑框看的形状：只留可编辑的字段。 */
    function toEditable(list) {
        return list.map((e) => {
            const o = {};
            for (const k of EDITABLE_KEYS) if (e[k] !== undefined && e[k] !== false) o[k] = e[k];
            return o;
        });
    }

    /**
     * 校验并规范化。返回 { list } 或 { error }（中文，指出第几项）。
     * url 必须是 http(s)：这个值会原样进 <a href>，javascript: 在这里放过去就是一个点了会执行的链接。
     */
    function validateEngines(data) {
        if (!Array.isArray(data)) return { error: '最外层必须是数组 [ … ]' };
        if (!data.length) return { error: '至少要保留一个引擎（想恢复默认请点「恢复默认」）' };
        if (data.length > 50) return { error: '最多 50 个引擎' };
        const ids = new Set();
        const list = [];
        for (let i = 0; i < data.length; i++) {
            const item = data[i];
            const at = `第 ${i + 1} 项`;
            if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: `${at}：必须是 { … } 对象` };
            const unknown = Object.keys(item).filter((k) => !EDITABLE_KEYS.includes(k));
            if (unknown.length) return { error: `${at}：不认识的字段 ${unknown.join(', ')}（可用：${EDITABLE_KEYS.join(', ')}）` };
            const name = typeof item.name === 'string' ? item.name.trim() : '';
            if (!name) return { error: `${at}：缺少 name` };
            if (name.length > 20) return { error: `${at}：name 太长（最多 20 字）` };
            const url = typeof item.url === 'string' ? item.url.trim() : '';
            if (!/^https?:\/\//i.test(url)) return { error: `${at}（${name}）：url 必须以 http:// 或 https:// 开头` };
            if (!url.includes('%s')) return { error: `${at}（${name}）：url 里要有 %s 表示关键词的位置` };
            try {
                new URL(url.replace(/%s/g, 'test'));
            } catch (e) {
                return { error: `${at}（${name}）：url 不是合法地址` };
            }
            if (item.group !== undefined && (typeof item.group !== 'string' || !item.group.trim() || item.group.length > 10)) {
                return { error: `${at}（${name}）：group 要是 1～10 字的文字` };
            }
            if (item.id !== undefined && (typeof item.id !== 'string' || !/^[\w-]{1,32}$/.test(item.id))) {
                return { error: `${at}（${name}）：id 只能是字母数字下划线横线` };
            }
            if (item.id !== undefined && ids.has(item.id)) return { error: `${at}（${name}）：id「${item.id}」重复了` };
            if (item.id !== undefined) ids.add(item.id);
            if (item.hidden !== undefined && typeof item.hidden !== 'boolean') {
                return { error: `${at}（${name}）：hidden 只能是 true 或 false（不带引号）` };
            }
            list.push({
                id: item.id, name, url,
                group: item.group === undefined ? undefined : item.group.trim(),
                hidden: item.hidden === true || undefined,
            });
        }
        if (list.every((e) => e.hidden)) return { error: '不能全部隐藏，至少留一个显示的' };
        // 自定义项补一个不撞车的 id（切换栏的 data-engine / 高亮要用）
        let n = 0;
        for (const e of list) {
            if (e.id !== undefined) continue;
            do n++; while (ids.has(`custom-${n}`));
            e.id = `custom-${n}`;
            ids.add(e.id);
        }
        return { list };
    }

    /** 规范化后的列表 → 引擎对象：内置 id 继承识别规则，名称 / 模板 / 分组用用户的。 */
    function resolveEngines(list) {
        return list.map((e) => {
            const base = BUILTIN_BY_ID.get(e.id);
            const hidden = !!e.hidden;
            if (base) return { ...base, name: e.name, url: e.url, group: e.group || base.group, hidden };
            return { id: e.id, name: e.name, url: e.url, group: e.group || '自定义', hidden };
        });
    }

    function saveEngines(list) {
        GM_setValue(STORE_KEY, { list, known: BUILTIN.map((e) => e.id) });
    }

    function loadEngines() {
        let saved = GM_getValue(STORE_KEY, null);
        if (saved === null) return BUILTIN;
        // 2025.07.02.7 存的是裸数组，那时的内置引擎和现在一样
        if (Array.isArray(saved)) saved = { list: saved, known: BUILTIN.map((e) => e.id) };
        const r = validateEngines(saved && saved.list);
        if (r.error) {
            // 存储被改坏：不让整条栏消失，回落默认
            console.warn(TAG, '已保存的引擎列表无效，使用默认：', r.error);
            return BUILTIN;
        }
        const known = new Set(Array.isArray(saved.known) ? saved.known : []);
        const have = new Set(r.list.map((e) => e.id));
        const added = BUILTIN.filter((e) => !have.has(e.id) && !known.has(e.id));
        if (added.length) console.log(TAG, '新增的内置引擎：', added.map((e) => e.name).join('、'));
        return resolveEngines(r.list).concat(added);
    }

    let engines = loadEngines();

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

    /**
     * 布局。菜单切换的结果存 GM：直接改脚本里的 CONFIG 会在自动更新时被覆盖掉。
     */
    function layout() {
        const v = GM_getValue('layout', CONFIG.layout);
        return v === 'top' ? 'top' : 'side';
    }

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
        }

        function render(keyword, current) {
            if (!host) mount();
            // 挂在 <html> 下而不是 <body>：结果页是 SPA 时 body 内容会被整块重渲染。
            // 每次都检查一遍，万一还是被页面摘掉了就挂回去
            if (!host.isConnected) document.documentElement.appendChild(host);
            // 不能用 host.hidden：shadow 里的 :host { all: initial } 是作者样式，
            // 优先级高过 UA 的 [hidden] { display: none }，hidden 属性会失效
            host.style.removeProperty('display');
            root.textContent = '';
            const style = document.createElement('style');
            style.textContent = CSS;
            const bar = document.createElement('nav');
            bar.className = `bar ${layout()}${pageIsDark() ? ' dark' : ''}`;
            bar.setAttribute('aria-label', '切换搜索引擎');
            let n = 0;
            for (const [group, items] of groupBy(engines.filter((e) => !e.hidden))) {
                const sec = document.createElement('div');
                sec.className = 'group';
                const label = document.createElement('div');
                label.className = 'label';
                label.textContent = group;
                sec.appendChild(label);
                for (const e of items) {
                    const a = document.createElement('a');
                    a.dataset.engine = e.id;
                    a.textContent = e.name;
                    a.href = buildUrl(e.url, keyword);
                    // 关键词会出现在 Referer 里带给下一家，没必要
                    a.rel = 'noreferrer';
                    if (CONFIG.openInNewTab) a.target = '_blank';
                    if (current && e.id === current.id) a.setAttribute('aria-current', 'page');
                    n++;
                    if (CONFIG.hotkeys && n <= 10) a.title = `Alt+${n % 10}`;
                    sec.appendChild(a);
                }
                bar.appendChild(sec);
            }
            root.append(style, bar);
        }

        function hide() {
            if (host) host.style.setProperty('display', 'none', 'important');
        }

        /** 第 n 个链接（显示顺序，从 1 数）。栏收起时没有。 */
        function link(n) {
            if (!host || host.style.display === 'none') return null;
            return root.querySelectorAll('a[data-engine]')[n - 1] || null;
        }

        return { render, hide, link };
    })();

    // =========================================================================
    // 编辑浮层
    // =========================================================================

    const EDITOR_CSS = `
        :host { all: initial; }
        .mask {
            --bg: #fff; --fg: #222; --muted: #777; --line: #d9d9d9; --field: #fafafa;
            --accent: #2468f2; --accent-fg: #fff; --danger: #d93025;
            position: fixed; inset: 0; z-index: 2147483001; display: flex; align-items: center; justify-content: center;
            background: rgba(0, 0, 0, .35);
            font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        .mask.dark {
            --bg: #26282c; --fg: #e3e3e3; --muted: #9a9da3; --line: #44474d; --field: #1e1f22;
            --accent: #8ab4f8; --accent-fg: #1a1b1e; --danger: #f28b82;
        }
        .dialog {
            width: min(720px, 94vw); max-height: 90vh; display: flex; flex-direction: column; gap: 8px;
            padding: 16px; border-radius: 10px; background: var(--bg); color: var(--fg);
            box-shadow: 0 10px 40px rgba(0, 0, 0, .3); box-sizing: border-box;
        }
        h2 { margin: 0; font-size: 16px; }
        .hint { margin: 0; color: var(--muted); }
        code { font-family: ui-monospace, Consolas, monospace; }
        textarea {
            flex: 1; min-height: 320px; resize: vertical; box-sizing: border-box; padding: 8px;
            font: 12px/1.5 ui-monospace, Consolas, "Courier New", monospace;
            color: var(--fg); background: var(--field); border: 1px solid var(--line); border-radius: 6px;
        }
        .err { min-height: 1.5em; color: var(--danger); white-space: pre-wrap; }
        .btns { display: flex; gap: 8px; }
        .spacer { flex: 1; }
        button {
            padding: 5px 14px; border-radius: 6px; border: 1px solid var(--line); cursor: pointer;
            background: transparent; color: var(--fg); font: inherit;
        }
        button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
    `;

    const Editor = (() => {
        let host = null;
        let textarea = null;
        let err = null;

        function close() {
            if (host) host.remove();
            host = null;
        }

        function fill(list) {
            textarea.value = JSON.stringify(toEditable(list), null, 2);
            err.textContent = '';
        }

        function save() {
            let data;
            try {
                data = JSON.parse(textarea.value);
            } catch (e) {
                err.textContent = 'JSON 格式错误：' + e.message;
                return false;
            }
            const r = validateEngines(data);
            if (r.error) {
                err.textContent = r.error;
                return false;
            }
            saveEngines(r.list);
            engines = resolveEngines(r.list);
            refresh();
            console.log(TAG, `已保存 ${r.list.length} 个引擎`);
            close();
            return true;
        }

        function open() {
            if (host) return;
            host = document.createElement('div');
            host.id = 'search-switcher-editor';
            const root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = EDITOR_CSS;

            const mask = document.createElement('div');
            mask.className = 'mask' + (pageIsDark() ? ' dark' : '');
            const dialog = document.createElement('div');
            dialog.className = 'dialog';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-label', '编辑引擎列表');

            const h2 = document.createElement('h2');
            h2.textContent = '编辑引擎列表';
            const hint = document.createElement('p');
            hint.className = 'hint';
            // 不用 innerHTML：Google 等站点开了 Trusted Types，给 innerHTML 赋字符串会直接抛错。
            // 反引号里的是 <code>，其余是普通文字
            const HINT = '每项 `name` 名称、`url` 搜索地址（`%s` 代表关键词）、`group` 分组。'
                + '带 `id` 的是内置引擎；不用的加 `"hidden": true` 隐藏（删掉也行，但以后想加回来得重抄地址）；顺序即显示顺序。';
            HINT.split('`').forEach((part, i) => {
                if (i % 2) {
                    const c = document.createElement('code');
                    c.textContent = part;
                    hint.appendChild(c);
                } else {
                    hint.appendChild(document.createTextNode(part));
                }
            });
            textarea = document.createElement('textarea');
            textarea.spellcheck = false;
            err = document.createElement('div');
            err.className = 'err';
            err.setAttribute('role', 'alert');

            const btns = document.createElement('div');
            btns.className = 'btns';
            const mk = (text, act, cls) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = text;
                b.dataset.act = act;
                if (cls) b.className = cls;
                return b;
            };
            const spacer = document.createElement('span');
            spacer.className = 'spacer';
            btns.append(mk('恢复默认', 'reset'), spacer, mk('取消', 'cancel'), mk('保存', 'save', 'primary'));
            btns.addEventListener('click', (e) => {
                const act = e.target.dataset && e.target.dataset.act;
                if (act === 'save') save();
                else if (act === 'cancel') close();
                else if (act === 'reset') {
                    resetEngines();
                    fill(engines);
                }
            });

            dialog.append(h2, hint, textarea, err, btns);
            mask.appendChild(dialog);
            mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
            /*
             * 键盘事件不许冒出 shadow DOM。冒出去之后 target 被重定向成宿主 div，
             * 页面的全局快捷键（Google / GitHub 的「/」聚焦搜索框之类）认不出这是在打字，
             * 往 url 里敲一个 / 焦点就被抢走了。
             */
            for (const type of ['keydown', 'keypress', 'keyup']) {
                dialog.addEventListener(type, (e) => {
                    e.stopPropagation();
                    if (type === 'keydown' && e.key === 'Escape') close();
                });
            }
            root.append(style, mask);
            document.documentElement.appendChild(host);
            fill(engines);
            textarea.focus();
        }

        return { open, close, save };
    })();

    function resetEngines() {
        GM_deleteValue(STORE_KEY);
        engines = BUILTIN;
        refresh();
        console.log(TAG, '已恢复默认引擎列表');
    }

    // =========================================================================
    // 启动
    // =========================================================================

    /** 按当前地址刷新切换栏：换了关键词就更新链接，离开结果页就收起。 */
    let shown = '';
    function update() {
        const engine = engineOf(location);
        const keyword = engine ? currentKeyword(engine) : '';
        if (!keyword) {
            if (shown) console.log(TAG, '离开结果页，收起切换栏');
            shown = '';
            Bar.hide();
            return;
        }
        const sig = engine.id + '\n' + keyword;
        if (sig === shown) return;
        shown = sig;
        Bar.render(keyword, engine);
        console.log(TAG, `当前 ${engine.name}，关键词「${keyword}」`);
    }

    /** 引擎列表变了：强制重画（update 在关键词没变时会跳过）。 */
    function refresh() {
        shown = '';
        update();
    }

    /*
     * 地址变化监听。百度 / Google / Bing / GitHub 换关键词都可能不刷新页面（pushState / hash）。
     *
     * 不去改写 history.pushState：Tampermonkey 给有 @grant 的脚本用的是隔离的 JS 环境，
     * 在那里替换 pushState 拦不到页面自己的调用（DOM 共享，JS 对象不共享）。
     * 事件则是两边都收得到的：
     *   Navigation API 的 currententrychange   pushState / replaceState / hash 都会触发（Chromium 系）
     *   popstate / hashchange                 前进后退、改 hash
     * 再加一个低频轮询兜底（没有 Navigation API 的浏览器靠它；只比一次字符串，开销可忽略）。
     */
    function watchUrl(onChange) {
        let last = location.href;
        const check = () => {
            if (location.href === last) return;
            last = location.href;
            onChange();
        };
        if (window.navigation && typeof window.navigation.addEventListener === 'function') {
            window.navigation.addEventListener('currententrychange', check);
        }
        window.addEventListener('popstate', check);
        window.addEventListener('hashchange', check);
        setInterval(check, CONFIG.pollInterval);
    }

    // =========================================================================
    // 快捷键
    // =========================================================================

    /** 正在往里打字的元素：Alt+数字在这些地方要留给输入（输入法、特殊字符）。 */
    function isTyping(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag !== 'INPUT') return false;
        return !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(el.type);
    }

    function onKeydown(e) {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
        /*
         * 用 e.code 不用 e.key：macOS 上 Option+1 的 key 是「¡」，Option+2 是「™」……
         * 只有物理键位 Digit1 / Numpad1 是稳定的。
         */
        const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
        if (!m) return;
        /*
         * 焦点在 shadow DOM 里时 e.target 被重定向成宿主元素（不是 input），
         * 要看 composedPath()[0] 才是真正获得焦点的那个元素。
         */
        const origin = (e.composedPath && e.composedPath()[0]) || e.target;
        if (isTyping(origin) || isTyping(document.activeElement)) return;
        const a = Bar.link(Number(m[1]) || 10);
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        // 走 <a> 自己的 click：target / rel 等原生行为都保留
        a.click();
    }

    function boot() {
        GM_registerMenuCommand('编辑引擎列表', () => Editor.open());
        GM_registerMenuCommand('恢复默认引擎', () => {
            if (window.confirm('恢复默认引擎列表？自定义的引擎会被清掉。')) resetEngines();
        });
        GM_registerMenuCommand('切换布局（侧边竖排 / 顶部横条）', () => {
            GM_setValue('layout', layout() === 'top' ? 'side' : 'top');
            refresh();
        });
        update();
        watchUrl(update);
        // 捕获阶段注册：结果页自己的快捷键处理常在冒泡阶段 stopPropagation
        if (CONFIG.hotkeys) window.addEventListener('keydown', onKeydown, true);
        /*
         * 关键词只能从搜索框取、而搜索框是 SPA 晚一步渲染的，第一次 update 会扑空。
         * 地址不变就不会再触发 update，所以补几次延迟重试。
         * 不放进轮询里每秒读：那样首页上边打字切换栏边冒出来。
         */
        for (const ms of [500, 1500, 3000]) setTimeout(() => { if (!shown) update(); }, ms);
    }

    try {
        boot();
    } catch (e) {
        console.error(TAG, '启动失败', e);
    }
})();
