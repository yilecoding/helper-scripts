// ==UserScript==
// @name         GitHub 增强
// @name:zh-CN   GitHub 增强
// @name:en      GitHub Enhancer
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.08.04.1
// @description  GitHub 页面增强：解析当前仓库 / 分支 / 路径上下文，适配 Turbo 换页。
// @description:zh-CN  GitHub 页面增强：解析当前仓库 / 分支 / 路径上下文，适配 Turbo 换页。
// @description:en  GitHub enhancements: parses the current repository / ref / path context and follows Turbo navigation.
// @author       壹樂（V：ita1125）
// @match        https://github.com/*
// @noframes
// @grant        unsafeWindow
// @license      CC BY-NC-SA
// @run-at       document-end
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/github-enhancer/github-enhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/github-enhancer/github-enhancer.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「GitHub增强」只看本脚本。 */
    const TAG = '[GitHub增强]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        applyDebounce: 150,     // 导航事件 / DOM 变化后等这么久再统一注入一次
    };

    /**
     * github.com 下第一段路径是这些时不是仓库（/settings/profile、/orgs/x/teams……）。
     * 用户名不能取这些名字，所以命中就可以断定不是 owner。
     */
    const RESERVED_OWNERS = new Set([
        'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories',
        'dashboard', 'enterprise', 'events', 'explore', 'features', 'github-copilot', 'issues', 'join',
        'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing',
        'pulls', 'readme', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sponsors',
        'stars', 'team', 'topics', 'trending', 'users', 'watching',
    ]);

    /** 路径第三段是这些时，后面跟的是「ref + 文件路径」。 */
    const REF_KINDS = new Set(['tree', 'blob', 'blame', 'edit', 'raw', 'commits']);

    const FULL_SHA = /^[0-9a-f]{40}$/i;

    // =========================================================================
    // 页面上下文：owner / repo / 页面类型 / ref / 路径
    // =========================================================================

    const Context = (() => {
        function decode(seg) {
            try {
                return decodeURIComponent(seg);
            } catch (e) {
                return seg;
            }
        }

        /**
         * 只从 URL 解析，不碰 DOM。
         *
         * /owner/repo/tree/feature/x/src 这种地址本身是有歧义的：分支名可以带 `/`，
         * 光看 URL 分不清是「feature 分支下的 x/src」还是「feature/x 分支下的 src」。
         * 这里先按「第一段是 ref」猜，`exact: false` 标出来，交给 resolve 消歧。
         * 只有一段（/tree/main）、整段是 40 位 SHA、或者没有 ref 时才算确定。
         */
        function parse(pathname) {
            const segs = pathname.split('/').filter(Boolean).map(decode);
            if (segs.length < 2) return null;
            const [owner, repo, kind, ...rest] = segs;
            if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
            const ctx = { owner, repo, type: kind || 'root', ref: null, path: '', refPath: '', sha: null, exact: true };

            if (!kind) return ctx;

            if (REF_KINDS.has(kind)) {
                if (!rest.length) return ctx; // /owner/repo/tree：等同仓库首页
                ctx.refPath = rest.join('/');
                ctx.ref = rest[0];
                ctx.path = rest.slice(1).join('/');
                if (FULL_SHA.test(rest[0])) ctx.sha = rest[0].toLowerCase();
                else ctx.exact = rest.length === 1;
                return ctx;
            }

            if (kind === 'commit' && rest[0]) {
                // /commit/<sha>.diff、.patch 也是同一个提交
                const sha = rest[0].replace(/\.(diff|patch)$/, '');
                ctx.ref = sha;
                if (FULL_SHA.test(sha)) ctx.sha = sha.toLowerCase();
                return ctx;
            }

            if (kind === 'pull' && rest[1] === 'commits' && rest[2] && FULL_SHA.test(rest[2])) {
                ctx.ref = ctx.sha = rest[2].toLowerCase();
                return ctx;
            }

            if (kind === 'releases' && rest[0] === 'tag' && rest.length > 1) {
                // tag 名也能带 `/`，但这里 tag 后面没有文件路径，剩下的整段就是 tag 名
                ctx.type = 'release';
                ctx.ref = rest.slice(1).join('/');
                return ctx;
            }

            return ctx;
        }

        function key(ctx) {
            return ctx ? `${ctx.owner}/${ctx.repo}|${ctx.type}|${ctx.ref || ''}|${ctx.path}` : '';
        }

        return { parse, key };
    })();

    // =========================================================================
    // 导航监听
    // =========================================================================

    /**
     * GitHub 是 Turbo + React 混合的 SPA，换页有好几条路：
     *   - Turbo Drive：turbo:load / turbo:render（整页换 body）
     *   - Turbo Frame：turbo:frame-load（只换 repo-content-turbo-frame 一块）
     *   - 老页面的 pjax：pjax:end
     *   - React 代码视图自己的路由：只调 history.pushState，不发任何事件
     *   - 前进后退：popstate
     * 全部汇总成一次防抖后的 apply；另外 MutationObserver 兜底 ——
     * React 在路由事件之后才把新内容渲染出来，事件触发那一刻 DOM 还是旧的。
     */
    const Nav = (() => {
        let timer = 0;
        let handler = () => {};

        function schedule() {
            clearTimeout(timer);
            timer = setTimeout(() => handler(), CONFIG.applyDebounce);
        }

        /**
         * 改的是 unsafeWindow.history：在沙箱里运行时，window.history 是沙箱那份，
         * 页面自己调的 pushState 走不到这里。通知走 DOM 事件（跨 world 可见）。
         */
        function hookHistory() {
            const hist = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).history;
            for (const name of ['pushState', 'replaceState']) {
                const orig = hist[name];
                if (typeof orig !== 'function' || orig.__ghe) continue;
                const wrapped = function (...args) {
                    const ret = orig.apply(this, args);
                    window.dispatchEvent(new Event('ghe:locationchange'));
                    return ret;
                };
                wrapped.__ghe = true;
                try {
                    hist[name] = wrapped;
                } catch (e) {
                    console.warn(TAG, '挂钩 history 失败，只靠 DOM 变化兜底', e);
                }
            }
        }

        function start(fn) {
            handler = fn;
            hookHistory();
            for (const ev of ['turbo:load', 'turbo:render', 'turbo:frame-load', 'pjax:end']) {
                document.addEventListener(ev, schedule);
            }
            window.addEventListener('popstate', schedule);
            window.addEventListener('ghe:locationchange', schedule);
            // 观察 <html> 而不是 <body>：Turbo Drive 换页会把整个 <body> 换成新元素，
            // 挂在旧 body 上的观察者从此再也收不到任何变化
            new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
        }

        return { start, schedule };
    })();

    // =========================================================================
    // 主流程
    // =========================================================================

    let lastKey = null;

    function apply() {
        const ctx = Context.parse(location.pathname);
        const key = Context.key(ctx);
        if (key !== lastKey) {
            lastKey = key;
            // 调试用：上下文一变就打一条，测试也靠它核对解析结果
            console.debug(TAG, '上下文', JSON.stringify(ctx));
        }
    }

    function boot() {
        try {
            apply();
        } catch (e) {
            console.error(TAG, '启动失败', e);
        }
        Nav.start(() => {
            try {
                apply();
            } catch (e) {
                console.error(TAG, '注入失败', e);
            }
        });
    }

    boot();
})();
