// ==UserScript==
// @name         GitHub 增强
// @name:zh-CN   GitHub 增强
// @name:en      GitHub Enhancer
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.08.06.5
// @description  GitHub 页面增强：仓库页显示仓库大小、默认分支、创建时间（按仓库缓存 1 小时，API 限流时显示恢复时间；可设置 token 提高限额、查看私有仓库）；文件列表每行一键下载单个文件，目录一键复制 git sparse-checkout 命令；分支名带 / 也能正确识别，适配 Turbo 换页。
// @description:zh-CN  GitHub 页面增强：仓库页显示仓库大小、默认分支、创建时间（按仓库缓存 1 小时，API 限流时显示恢复时间；可设置 token 提高限额、查看私有仓库）；文件列表每行一键下载单个文件，目录一键复制 git sparse-checkout 命令；分支名带 / 也能正确识别，适配 Turbo 换页。
// @description:en  GitHub enhancements: shows repository size, default branch and creation date on repository pages (cached per repository for an hour; shows when the API rate limit resets; an optional token raises the limit and unlocks private repositories); adds a one-click download button to every file in the file list and a "copy git sparse-checkout command" button to every directory; handles branch names containing slashes and follows Turbo navigation.
// @author       壹樂（V：ita1125）
// @match        https://github.com/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      api.github.com
// @connect      raw.githubusercontent.com
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
        cacheTtl: 60 * 60 * 1000, // 仓库信息按仓库缓存 1 小时
        requestTimeout: 15000,  // API 请求超时
        apiBase: 'https://api.github.com',
        rawBase: 'https://raw.githubusercontent.com',
        toastMs: 1800,          // 「已复制」提示停留时间
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

        // ---------------------------------------------------------------------
        // ref 消歧
        // ---------------------------------------------------------------------

        /** refPath 是否以 name 开头（按 `/` 分段对齐，feature/xy 不算 feature/x 开头）。 */
        function startsWithRef(refPath, name) {
            return !!name && (refPath === name || refPath.startsWith(name + '/'));
        }

        function decodePath(p) {
            return p.split('/').map(decode).join('/');
        }

        /**
         * React 代码视图的嵌入数据（<react-app> 里的 script[data-target="react-app.embeddedData"]），
         * 里面的 refInfo 有确切的分支名、类型和当前提交 SHA。
         *
         * 坑：它只描述**首次加载**的那一页。之后 React 自己路由换目录，这段 JSON 原样留在 DOM 里，
         * 内容还是老页面的。所以只有 <react-app initial-path> 和当前地址一致时才信它。
         */
        function fromEmbedded() {
            const here = decodePath(location.pathname).replace(/\/$/, '');
            for (const app of document.querySelectorAll('react-app[initial-path]')) {
                if (decodePath(app.getAttribute('initial-path')).replace(/\/$/, '') !== here) continue;
                const script = app.querySelector('script[data-target="react-app.embeddedData"]');
                if (!script) continue;
                let data;
                try {
                    data = JSON.parse(script.textContent);
                } catch (e) {
                    continue;
                }
                const info = findRefInfo(data && data.payload, 0);
                if (info) {
                    return {
                        name: info.name,
                        refType: info.refType || null,
                        sha: FULL_SHA.test(info.currentOid || '') ? info.currentOid.toLowerCase() : null,
                        source: 'embedded',
                    };
                }
            }
            return null;
        }

        /** payload 下各路由的 refInfo 位置不固定（codeViewTreeRoute / codeViewBlobLayoutRoute / …），浅层搜一下。 */
        function findRefInfo(obj, depth) {
            if (!obj || typeof obj !== 'object' || depth > 3) return null;
            if (obj.refInfo && typeof obj.refInfo.name === 'string') return obj.refInfo;
            for (const v of Object.values(obj)) {
                const hit = findRefInfo(v, depth + 1);
                if (hit) return hit;
            }
            return null;
        }

        /**
         * 分支选择按钮。和嵌入数据不同，它跟着 React 重渲染，换目录后仍然是新的。
         *   - React 版：button.ref-selector-class，aria-label 是「<名字> branch」/「<名字> tag」
         *   - 旧版：#branch-select-menu 里的 [data-menu-button]，文字就是名字（太长时 CSS 截断，文字本身是全的）
         * 显示的名字只作候选，必须是 refPath 的分段前缀才采用。
         */
        function fromPicker() {
            const btn = document.querySelector('button.ref-selector-class[aria-label], #ref-picker-repos-header-ref-selector[aria-label]');
            if (btn) {
                const m = btn.getAttribute('aria-label').match(/^(.+) (branch|tag)$/);
                if (m) return { name: m[1], refType: m[2], sha: null, source: 'picker' };
            }
            const legacy = document.querySelector('#branch-select-menu [data-menu-button]');
            if (legacy && legacy.textContent.trim()) return { name: legacy.textContent.trim(), refType: null, sha: null, source: 'picker' };
            return null;
        }

        /**
         * 面包屑最左边「仓库名」那一节链到 /owner/repo/tree/<ref>（ref 后面没有路径），
         * 所以 /tree/ 后面整段就是 ref。React 版是 a[data-testid="breadcrumbs-repo-link"]，
         * 旧版是 #blob-path .js-repo-root 里的链接。
         */
        function fromBreadcrumb(ctx) {
            const a = document.querySelector('a[data-testid="breadcrumbs-repo-link"][href], .js-repo-root a[href]');
            if (!a) return null;
            let target;
            try {
                target = parse(new URL(a.getAttribute('href'), location.origin).pathname);
            } catch (e) {
                return null;
            }
            if (!target || target.type !== 'tree' || !target.refPath) return null;
            if (target.owner.toLowerCase() !== ctx.owner.toLowerCase() || target.repo.toLowerCase() !== ctx.repo.toLowerCase()) return null;
            return { name: target.refPath, refType: null, sha: null, source: 'breadcrumb' };
        }

        /**
         * 本次会话里已经确认存在的 ref（按仓库）。git 里分支 feature 和 feature/x 不能同时存在
         * （refs/heads/feature 是文件就不能再是目录），所以一个已知分支只要是 refPath 的分段前缀，
         * 就一定是这个地址里的分支 —— 同一分支下换目录不用再查。
         */
        const known = new Map();

        function remember(ctx, name, refType) {
            const k = `${ctx.owner}/${ctx.repo}`.toLowerCase();
            const list = known.get(k) || [];
            if (!list.some((r) => r.name === name)) list.push({ name, refType });
            known.set(k, list);
        }

        function fromKnown(ctx) {
            const list = known.get(`${ctx.owner}/${ctx.repo}`.toLowerCase()) || [];
            let best = null;
            for (const r of list) {
                if (startsWithRef(ctx.refPath, r.name) && (!best || r.name.length > best.name.length)) best = r;
            }
            return best && { ...best, sha: null, source: 'known' };
        }

        const lookups = new Map();

        /**
         * API 消歧：git/matching-refs/heads/<第一段> 返回所有以它开头的分支（前缀是字符串前缀，
         * feature 会把 feature-old 也带出来），挑能按分段对上 refPath 的最长那个；分支里没有再查 tag。
         * 同一个「仓库 + 第一段」只查一次。
         */
        function fromApi(ctx) {
            const first = ctx.refPath.split('/')[0];
            const k = `${ctx.owner}/${ctx.repo}|${first}`.toLowerCase();
            if (!lookups.has(k)) {
                const base = `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/git/matching-refs/`;
                const list = (kind) => Api.request(base + kind + '/' + encodeURIComponent(first)).then((r) => {
                    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`HTTP ${r.status}`);
                    return r.json.map((x) => String(x.ref || '').replace(/^refs\/(heads|tags)\//, ''));
                });
                lookups.set(k, (async () => {
                    if (Store.rateLimit()) return [];
                    try {
                        const heads = await list('heads');
                        heads.forEach((name) => remember(ctx, name, 'branch'));
                        if (heads.some((name) => startsWithRef(ctx.refPath, name))) return;
                        const tags = await list('tags');
                        tags.forEach((name) => remember(ctx, name, 'tag'));
                    } catch (e) {
                        // 查不到就按第一段猜；失败不缓存，下次换页再试
                        lookups.delete(k);
                        console.warn(TAG, '分支消歧失败，按第一段猜', e.message);
                    }
                })());
            }
            return lookups.get(k).then(() => fromKnown(ctx));
        }

        function adopt(ctx, found) {
            const out = { ...ctx, ref: found.name, refType: found.refType || null, exact: true, source: found.source };
            out.path = ctx.refPath === found.name ? '' : ctx.refPath.slice(found.name.length + 1);
            if (found.sha) out.sha = found.sha;
            return out;
        }

        /**
         * 把 parse 的猜测落实成确定的 ref / path（以及能顺带拿到的 SHA）：
         *   1. 整段 SHA：不用消歧
         *   2. 嵌入数据（地址一致时）→ 分支选择按钮 → 面包屑的仓库根链接 → 本次会话已知的 ref
         *   3. 都没有：调 API 查以第一段开头的分支 / tag
         *   4. API 也失败：保留「第一段是 ref」的猜测，exact 仍是 false
         * 仓库首页的 URL 里没有 ref，从嵌入数据补上默认分支和 SHA（没有就留空）。
         */
        async function resolve(ctx) {
            if (!ctx) return ctx;
            const emb = fromEmbedded();
            if (ctx.type === 'root') {
                if (!emb) return { ...ctx, source: 'url' };
                remember(ctx, emb.name, emb.refType);
                return { ...ctx, ref: emb.name, refType: emb.refType, sha: emb.sha, source: 'embedded' };
            }
            if (!ctx.refPath || (ctx.sha && FULL_SHA.test(ctx.ref))) return { ...ctx, source: 'url' };
            for (const found of [emb, fromPicker(), fromBreadcrumb(ctx), fromKnown(ctx)]) {
                if (found && startsWithRef(ctx.refPath, found.name)) {
                    remember(ctx, found.name, found.refType);
                    return adopt(ctx, found);
                }
            }
            if (ctx.exact) return { ...ctx, source: 'url' };
            const found = await fromApi(ctx);
            return found ? adopt(ctx, found) : { ...ctx, source: 'guess' };
        }

        return { parse, key, resolve, startsWithRef };
    })();

    // =========================================================================
    // 存储（GM）
    // =========================================================================

    const Store = (() => {
        const CACHE_PREFIX = 'cache:';

        /** 缓存条目带写入时间，过期的当不存在（不主动删，下次写入时覆盖）。 */
        function getCache(key) {
            const entry = GM_getValue(CACHE_PREFIX + key, null);
            if (!entry || typeof entry.at !== 'number' || Date.now() - entry.at > CONFIG.cacheTtl) return null;
            return entry.data;
        }

        function setCache(key, data) {
            GM_setValue(CACHE_PREFIX + key, { at: Date.now(), data });
        }

        /**
         * token 明文存在管理器的脚本存储里（不进页面 localStorage、不同步到页面）。
         * 安全含义见 notes.md：能读这份存储的扩展 / 导出备份都能拿到它，所以建议只给只读权限。
         */
        function token() {
            return GM_getValue('token', '') || '';
        }

        function setToken(value) {
            if (value) GM_setValue('token', value);
            else GM_deleteValue('token');
            // 限流是按「未认证 IP」或「token 所属用户」分别计的，换了身份旧的限流记录就不作数了
            GM_deleteValue('ratelimit');
        }

        /** 限流记录：{ reset: 秒级时间戳, authed }。到点之前不再发请求，免得越限越久。 */
        function rateLimit() {
            const r = GM_getValue('ratelimit', null);
            if (!r || r.authed !== !!token() || r.reset * 1000 <= Date.now()) return null;
            return r;
        }

        function setRateLimit(reset) {
            GM_setValue('ratelimit', { reset, authed: !!token() });
        }

        return { getCache, setCache, token, setToken, rateLimit, setRateLimit };
    })();

    // =========================================================================
    // GitHub API
    // =========================================================================

    const Api = (() => {
        /** 「name: value」一行一个的响应头文本 → 小写键的对象。 */
        function parseHeaders(raw) {
            const out = {};
            for (const line of String(raw || '').split(/\r?\n/)) {
                const i = line.indexOf(':');
                if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            }
            return out;
        }

        /**
         * GM_xmlhttpRequest 的 Promise 包装（api.github.com 跨域，页面 fetch 不带 cookie 也拿不到私有仓库）。
         * 非 2xx 不 reject，把 status 和响应头原样交回去：403 到底是限流还是没权限，要调用方看头判断。
         * 超时自己计时：有的管理器不触发 ontimeout，请求就永远挂着、界面一直「加载中」。
         */
        function request(path, { accept = 'application/vnd.github+json' } = {}) {
            const headers = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
            const token = Store.token();
            if (token) headers.Authorization = `Bearer ${token}`;
            return new Promise((resolve, reject) => {
                let done = false;
                const finish = (fn, arg) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    fn(arg);
                };
                const timer = setTimeout(() => finish(reject, new Error('请求超时')), CONFIG.requestTimeout);
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: CONFIG.apiBase + path,
                    headers,
                    timeout: CONFIG.requestTimeout,
                    onload: (r) => {
                        let json = null;
                        try {
                            json = JSON.parse(r.responseText);
                        } catch (e) { /* 非 JSON（比如 sha 媒体类型）就只给 text */ }
                        finish(resolve, { status: r.status, text: r.responseText, json, headers: parseHeaders(r.responseHeaders) });
                    },
                    onerror: () => finish(reject, new Error('网络错误')),
                    ontimeout: () => finish(reject, new Error('请求超时')),
                });
            });
        }

        /**
         * 限流的两种形态（docs.github.com「Rate limits for the REST API」）：
         *   - 主限流：403 或 429，x-ratelimit-remaining: 0，x-ratelimit-reset 是恢复时刻（秒级时间戳）
         *   - 次级限流：403 或 429，带 retry-after（秒）
         * 403 本身不能当限流：没权限、仓库被封也是 403，要看头。
         */
        function rateLimitReset(r) {
            if (r.status !== 403 && r.status !== 429) return null;
            const h = r.headers;
            if (h['x-ratelimit-remaining'] === '0' && h['x-ratelimit-reset']) return Number(h['x-ratelimit-reset']);
            if (h['retry-after']) return Math.ceil(Date.now() / 1000) + Number(h['retry-after']);
            return null;
        }

        /** 统一的失败结果：{ ok: false, status, message, reset? }。 */
        function failure(r) {
            const reset = rateLimitReset(r);
            if (reset) {
                Store.setRateLimit(reset);
                return { ok: false, status: r.status, rateLimited: true, reset };
            }
            return { ok: false, status: r.status, message: (r.json && r.json.message) || '' };
        }

        const inflight = new Map();

        /**
         * 仓库基本信息。先查缓存；同一仓库并发的请求合并成一个 ——
         * 换页时 turbo:load、pushState、DOM 变化会在几十毫秒内各触发一次注入。
         */
        function repo(owner, name) {
            const key = `repo:${owner}/${name}`.toLowerCase();
            const cached = Store.getCache(key);
            if (cached) return Promise.resolve({ ok: true, data: cached, cached: true });
            if (inflight.has(key)) return inflight.get(key);
            const limited = Store.rateLimit();
            if (limited) return Promise.resolve({ ok: false, rateLimited: true, reset: limited.reset });
            const p = request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)
                .then((r) => {
                    if (r.status === 200 && r.json) {
                        const { size, default_branch, created_at } = r.json;
                        const data = { size, default_branch, created_at };
                        Store.setCache(key, data);
                        return { ok: true, data };
                    }
                    return failure(r);
                })
                .catch((e) => ({ ok: false, status: 0, message: e.message }))
                .finally(() => inflight.delete(key));
            inflight.set(key, p);
            return p;
        }

        return { request, repo, parseHeaders };
    })();

    // =========================================================================
    // 格式化
    // =========================================================================

    const pad = (n) => String(n).padStart(2, '0');

    /** 本地时区的 YYYY-MM-DD（withTime 时带 HH:mm）。 */
    function formatDate(iso, withTime) {
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        return withTime ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
    }

    /** API 的 size 单位是 KB。 */
    function formatSize(kb) {
        if (typeof kb !== 'number' || kb < 0) return '未知';
        if (kb < 1024) return `${kb} KB`;
        if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
        return `${(kb / 1024 / 1024).toFixed(2)} GB`;
    }

    /** 每段单独 encodeURIComponent，保留 `/`。 */
    function encodePath(p) {
        return p.split('/').map(encodeURIComponent).join('/');
    }

    function rawUrl(owner, repo, ref, path) {
        return `${CONFIG.rawBase}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodePath(ref)}/${encodePath(path)}`;
    }

    /** POSIX shell 单引号转义；只含安全字符时不加引号，命令看起来干净些。 */
    function shQuote(s) {
        return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
    }

    /**
     * 只取一个目录的 git 命令：blob:none 部分克隆 + sparse 只检出这个目录。
     * --branch 不接受 SHA，ref 是 SHA 时改成先不检出、设好 sparse 再 checkout 那个提交。
     */
    function sparseCommand(owner, repo, ref, path) {
        const url = `https://github.com/${owner}/${repo}.git`;
        const dir = shQuote(repo);
        if (FULL_SHA.test(ref)) {
            return `git clone --filter=blob:none --sparse --no-checkout ${url} && cd ${dir} && git sparse-checkout set ${shQuote(path)} && git checkout ${ref}`;
        }
        return `git clone --filter=blob:none --sparse --depth 1 --branch ${shQuote(ref)} ${url} && cd ${dir} && git sparse-checkout set ${shQuote(path)}`;
    }

    function copy(text, label) {
        GM_setClipboard(text, 'text');
        toast(`已复制${label}`);
    }

    function toast(msg) {
        let node = document.getElementById('ghe-toast');
        if (!node) {
            node = el('div', { id: 'ghe-toast', role: 'status' });
            document.documentElement.append(node);
        }
        node.textContent = msg;
        node.dataset.show = '1';
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => { delete node.dataset.show; }, CONFIG.toastMs);
    }

    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'text') node.textContent = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v);
        }
        for (const c of [].concat(children)) if (c != null) node.append(c);
        return node;
    }

    // =========================================================================
    // 样式
    // =========================================================================

    /** 颜色走 GitHub 自己的 CSS 变量，深色主题自动跟随；变量不存在时用后面的浅色兜底。 */
    GM_addStyle(`
        .ghe-repo-info { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
            font-size: 12px; line-height: 20px; color: var(--fgColor-muted, #59636e); }
        .ghe-repo-info .ghe-item b { font-weight: 600; color: var(--fgColor-default, #1f2328); }
        .ghe-repo-info[data-state="error"] { color: var(--fgColor-danger, #d1242f); }
        .ghe-repo-info[data-state="ratelimit"] { color: var(--fgColor-attention, #9a6700); }
        .ghe-link-btn { background: none; border: 0; padding: 0; font: inherit; cursor: pointer;
            color: var(--fgColor-accent, #0969da); }
        .ghe-link-btn:hover { text-decoration: underline; }
        .ghe-row-actions { display: inline-flex; gap: 4px; margin-left: 8px; flex-shrink: 0; vertical-align: middle; }
        .ghe-btn { font: 12px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 0 6px;
            border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; cursor: pointer;
            background: var(--bgColor-default, #fff); color: var(--fgColor-muted, #59636e); white-space: nowrap; }
        .ghe-btn:hover { color: var(--fgColor-accent, #0969da); border-color: var(--fgColor-accent, #0969da); }
        #ghe-toast { position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); z-index: 2147483647;
            padding: 6px 14px; border-radius: 6px; font-size: 13px; pointer-events: none; opacity: 0; transition: opacity .2s;
            background: var(--bgColor-emphasis, #25292e); color: var(--fgColor-onEmphasis, #fff); }
        #ghe-toast[data-show] { opacity: 1; }
    `);

    // =========================================================================
    // 功能：仓库信息
    // =========================================================================

    const RepoInfo = (() => {
        const ID = 'ghe-repo-info';
        /** 只在代码视图（首页 / 目录 / 文件）显示，issue、PR 页不需要。 */
        const TYPES = new Set(['root', 'tree', 'blob']);

        /**
         * 挂载点，按顺序找第一个存在的：
         *   - #repo-title-component：React 版仓库头（2025 起）里的「头像 + 仓库名」，插在它后面同一行
         *   - #repository-container-header：旧版服务端渲染的仓库头，插在末尾
         *   - repo-content 的 turbo-frame / pjax 容器：都没有时放在内容区最上面
         */
        const MOUNTS = [
            ['#repo-title-component', 'afterend'],
            ['#repository-container-header', 'beforeend'],
            ['#repo-content-turbo-frame', 'afterbegin'],
            ['#repo-content-pjax-container', 'afterbegin'],
        ];

        function mount(node) {
            for (const [sel, where] of MOUNTS) {
                const anchor = document.querySelector(sel);
                if (anchor) {
                    anchor.insertAdjacentElement(where, node);
                    return true;
                }
            }
            return false;
        }

        function errorText(state) {
            const hasToken = !!Store.token();
            if (state.rateLimited) {
                const when = formatDate(state.reset * 1000, true);
                return hasToken
                    ? `GitHub API 已限流，${when} 后恢复`
                    : `GitHub API 已限流（未设置 token 时每小时 60 次），${when} 后恢复；可在脚本菜单里设置 token`;
            }
            if (state.status === 401) return '仓库信息加载失败：token 无效或已过期（脚本菜单里重新设置）';
            if (state.status === 404) {
                return hasToken
                    ? '仓库信息加载失败：仓库不存在，或 token 无权访问'
                    : '仓库信息加载失败：仓库不存在，或是私有仓库（在脚本菜单里设置 token 后可查看）';
            }
            return `仓库信息加载失败（${state.status ? `HTTP ${state.status}` : state.message || '网络错误'}）`;
        }

        function render(node, state, ctx) {
            node.dataset.state = state.kind;
            node.replaceChildren();
            if (state.kind === 'loading') {
                node.append('仓库信息加载中…');
            } else if (state.kind === 'ready') {
                const { size, default_branch, created_at } = state.data;
                const item = (k, label, value) => el('span', { class: 'ghe-item', 'data-k': k }, [label + ' ', el('b', { text: value })]);
                node.append(
                    item('size', '大小', formatSize(size)),
                    item('branch', '默认分支', default_branch || '未知'),
                    item('created', '创建于', formatDate(created_at) || '未知'),
                );
            } else {
                // 失败要看得见：吞掉的话用户只会以为脚本没装上
                node.append(errorText(state), ' ', el('button', {
                    type: 'button', class: 'ghe-link-btn', text: '重试', onclick: () => load(node, ctx),
                }));
            }
        }

        function load(node, ctx) {
            render(node, { kind: 'loading' }, ctx);
            Api.repo(ctx.owner, ctx.repo).then((r) => {
                // 结果回来时可能已经换到别的仓库了
                if (node.dataset.repo !== `${ctx.owner}/${ctx.repo}`) return;
                const kind = r.ok ? 'ready' : r.rateLimited ? 'ratelimit' : 'error';
                render(node, { kind, ...r }, ctx);
            });
        }

        /** 换了 token：扔掉现有的条，下一轮注入按新身份重新加载。 */
        function reset() {
            const node = document.getElementById(ID);
            if (node) node.remove();
        }

        function apply(ctx) {
            const existing = document.getElementById(ID);
            if (!ctx || !TYPES.has(ctx.type)) {
                if (existing) existing.remove();
                return;
            }
            const repoKey = `${ctx.owner}/${ctx.repo}`;
            // 同一仓库内换目录不重复请求；React 重渲染把它冲掉了才重新挂（走缓存）
            if (existing && existing.dataset.repo === repoKey && existing.isConnected) return;
            if (existing) existing.remove();
            const node = el('div', { id: ID, class: 'ghe-repo-info', 'data-repo': repoKey });
            if (!mount(node)) return; // 找不到挂载点：这一项静默跳过
            load(node, ctx);
        }

        return { apply, reset };
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
    // 功能：文件列表每行的按钮
    // =========================================================================

    const FileRows = (() => {
        const TYPES = new Set(['root', 'tree']);

        /**
         * 两套文件列表，各给出「行」「行里的文件名链接」「按钮挂在哪」：
         *   - React 版（2023 起）：table[aria-labelledby="folders-and-files"] 里的 tr.react-directory-row。
         *     每行有大屏 / 小屏两个文件名单元格（CSS 只显示一个），按钮挂在大屏那个里，
         *     链接也从同一个单元格取，不然一行会算两次。「..」上级目录行不带这个类。
         *   - 旧版（pjax 时代）：div[role="grid"] 里的 div[role="row"].js-navigation-item，
         *     链接是 [role="rowheader"] a.js-navigation-open。
         */
        const LAYOUTS = [
            {
                rows: 'tr.react-directory-row',
                link: '.react-directory-row-name-cell-large-screen .react-directory-filename-cell a[href], .react-directory-filename-cell a[href]',
                mount: '.react-directory-row-name-cell-large-screen .react-directory-filename-column, .react-directory-filename-column',
            },
            {
                rows: '[role="grid"] [role="row"].js-navigation-item',
                link: '[role="rowheader"] a.js-navigation-open[href]',
                mount: '[role="rowheader"]',
            },
        ];

        /**
         * 链接 → { kind, ref, path }。不是本仓库的 blob/tree（子模块链到别的仓库）、
         * 不在当前目录下（「..」上级目录）都返回 null。
         *
         * ref / path 的切法：上下文已经确定 ref 时直接用。仓库首页没有嵌入数据（旧版）时 URL 里没有 ref，
         * 但当前目录确定是根，就用显示的文件名从链接尾部倒推 —— 剩下的前缀就是 ref。
         * 消歧彻底失败（source: guess）时当前目录本身也是猜的，倒推不成立，只能沿用猜测。
         * raw 链接其实不在乎怎么切（ref/path 拼回去是一样的），切错只影响 sparse 命令。
         */
        function itemOf(a, ctx) {
            let u;
            try {
                u = new URL(a.getAttribute('href'), location.origin);
            } catch (e) {
                return null;
            }
            if (u.origin !== location.origin) return null;
            const target = Context.parse(u.pathname);
            if (!target || (target.type !== 'blob' && target.type !== 'tree') || !target.refPath) return null;
            if (target.owner.toLowerCase() !== ctx.owner.toLowerCase() || target.repo.toLowerCase() !== ctx.repo.toLowerCase()) return null;
            const refPath = target.refPath;
            const name = (a.getAttribute('title') || a.textContent || '').trim();
            const tail = (ctx.path ? ctx.path + '/' : '') + name;

            let ref = null;
            if (ctx.ref && Context.startsWithRef(refPath, ctx.ref)) ref = ctx.ref;
            else if (ctx.exact && name && refPath.endsWith('/' + tail)) ref = refPath.slice(0, -tail.length - 1);
            if (!ref || refPath.length <= ref.length + 1) return null;
            const path = refPath.slice(ref.length + 1);
            if (ctx.path && !path.startsWith(ctx.path + '/')) return null;
            return { kind: target.type, ref, path };
        }

        function download(ctx, item) {
            const url = rawUrl(ctx.owner, ctx.repo, item.ref, item.path);
            const name = item.path.split('/').pop();
            // GM_download 能跨域真正「下载」；<a download> 对跨域链接无效，浏览器会直接打开 raw 页面，
            // 只当兜底（管理器禁用了下载 API、扩展名不在白名单里时 GM_download 会失败）
            const fallback = () => {
                const a = el('a', { href: url, download: name, target: '_blank', rel: 'noopener' });
                document.body.append(a);
                a.click();
                a.remove();
            };
            if (typeof GM_download !== 'function') return fallback();
            const token = Store.token();
            GM_download({
                url,
                name,
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                onerror: (e) => {
                    console.warn(TAG, 'GM_download 失败，改用浏览器打开 raw 链接', e);
                    fallback();
                },
            });
        }

        function button(text, title, onClick) {
            return el('button', {
                type: 'button', class: 'ghe-btn', title, text,
                // 旧版的行是 js-navigation-item，点到行里会被当成导航；按钮自己的点击不往外冒
                onclick: (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onClick();
                },
            });
        }

        function actionsFor(ctx, item) {
            if (item.kind === 'blob') {
                return [button('下载', '下载这个文件（raw）', () => download(ctx, item))];
            }
            return [button('检出命令', '复制只检出这个目录的 git sparse-checkout 命令', () => {
                copy(sparseCommand(ctx.owner, ctx.repo, item.ref, item.path), ' sparse-checkout 命令');
            })];
        }

        function apply(ctx) {
            const off = !ctx || !TYPES.has(ctx.type);
            for (const layout of LAYOUTS) {
                for (const row of document.querySelectorAll(layout.rows)) {
                    const old = row.querySelector('.ghe-row-actions');
                    if (off) {
                        if (old) old.remove();
                        continue;
                    }
                    const a = row.querySelector(layout.link);
                    const href = a && a.getAttribute('href');
                    // React 换目录时会复用 <tr> 只改链接：按 href 判断按钮是不是这一行的
                    if (old && old.dataset.href === href) continue;
                    if (old) old.remove();
                    const item = a && itemOf(a, ctx);
                    const mount = item && row.querySelector(layout.mount);
                    if (!mount) continue;
                    mount.append(el('span', { class: 'ghe-row-actions', 'data-href': href }, actionsFor(ctx, item)));
                }
            }
        }

        return { apply };
    })();

    // =========================================================================
    // 菜单
    // =========================================================================

    const Menu = (() => {
        function setToken() {
            const input = prompt(
                '输入 GitHub personal access token。\n'
                + '只存在本机脚本管理器的存储里，只发给 api.github.com 和 raw.githubusercontent.com（下载私有仓库文件）；\n'
                + '建议用只读权限的 fine-grained token。\n'
                + '留空并确定 = 清除。',
                '',
            );
            if (input === null) return; // 取消
            Store.setToken(input.trim());
            RepoInfo.reset();
            Nav.schedule();
        }

        function clearToken() {
            Store.setToken('');
            RepoInfo.reset();
            Nav.schedule();
        }

        function register() {
            if (typeof GM_registerMenuCommand !== 'function') return;
            GM_registerMenuCommand('设置 GitHub token', setToken);
            GM_registerMenuCommand('清除 GitHub token', clearToken);
        }

        return { register };
    })();

    // =========================================================================
    // 主流程
    // =========================================================================

    let lastKey = null;
    let applySeq = 0;

    async function apply() {
        const seq = ++applySeq;
        const ctx = await Context.resolve(Context.parse(location.pathname));
        // 消歧要等 API 时，期间又换了页：老结果作废
        if (seq !== applySeq) return;
        const key = Context.key(ctx);
        if (key !== lastKey) {
            lastKey = key;
            // 调试用：上下文一变就打一条，测试也靠它核对解析结果
            console.debug(TAG, '上下文', JSON.stringify(ctx));
        }
        // 每项独立 try：某一项的选择器在新版页面上失效，不该连累别的功能
        for (const [name, feature] of [['仓库信息', RepoInfo], ['文件列表按钮', FileRows]]) {
            try {
                feature.apply(ctx);
            } catch (e) {
                console.error(TAG, name + '注入失败', e);
            }
        }
    }

    function boot() {
        apply().catch((e) => console.error(TAG, '启动失败', e));
        Nav.start(() => apply().catch((e) => console.error(TAG, '注入失败', e)));
        Menu.register();
    }

    boot();
})();
