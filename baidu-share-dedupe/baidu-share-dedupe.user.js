// ==UserScript==
// @name         百度网盘分享批量转存｜非会员自动分批、按文件名和大小去重、可续跑
// @name:zh-CN   百度网盘分享批量转存｜非会员自动分批、按文件名和大小去重、可续跑
// @name:en      Baidu Netdisk Share Batch Saver — Auto-batched, Deduplicated, Resumable
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2026.10.29.7
// @description  在百度网盘分享页把整个文件夹转存到自己的网盘：自动拆成每批 500 个（非会员单次上限），先和目标文件夹按文件名 + 大小核对，已有的跳过；每批转存后核对到齐再继续，中途停了重新扫描就能续跑。
// @description:zh-CN  在百度网盘分享页把整个文件夹转存到自己的网盘：自动拆成每批 500 个（非会员单次上限），先和目标文件夹按文件名 + 大小核对，已有的跳过；每批转存后核对到齐再继续，中途停了重新扫描就能续跑。
// @description:en  Saves a whole folder from a Baidu Netdisk share link into your own netdisk: splits it into batches of 500 (the per-transfer limit for non-members), compares against the target folder by file name and size so existing files are skipped, verifies each batch before the next, and resumes after a rescan if stopped.
// @author       壹樂（V：ita1125）
// @match        https://pan.baidu.com/s/*
// @match        https://pan.baidu.com/share/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @license      MIT
// @run-at       document-idle
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/baidu-share-dedupe/baidu-share-dedupe.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/baidu-share-dedupe/baidu-share-dedupe.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「分享转存」只看本脚本。 */
    const TAG = '[分享转存]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        batchSize: 500,         // 每批转存多少个：非会员单次转存上限是 500
        sharePageSize: 100,     // 分享目录每页条数（网页版分享页就是 100）
        diskPageSize: 1000,     // 自己网盘目录每页条数（接口上限 1000）
        verifyDelayMs: 3000,    // 转存成功后隔这么久查一次目标文件夹，看这批到齐没有
        verifyTries: 20,        // 最多查这么多次（约 1 分钟）还没到齐就停下
        maxPages: 1000,         // 翻这么多页还没完就当接口异常，停下来别死循环
    };

    /** 网页版固定带的几个公共参数。 */
    const WEB_PARAMS = { app_id: 250528, channel: 'chunlei', clienttype: 0, web: 1 };

    // =========================================================================
    // 分享链接
    // =========================================================================

    /**
     * 当前页面的分享短链（接口里的 shorturl）。两种地址：
     *   /s/1AbCdEf…          → AbCdEf…（去掉开头的 1）
     *   /share/init?surl=AbC… → AbC…（输提取码的页面）
     * 不是分享页返回空串。
     */
    function shareKey(loc) {
        const m = /^\/s\/1([\w-]+)/.exec(loc.pathname);
        if (m) return m[1];
        if (/^\/share\/(init|link)\b/.test(loc.pathname)) return new URL(loc.href).searchParams.get('surl') || '';
        return '';
    }

    // =========================================================================
    // 接口
    // =========================================================================

    /**
     * fs_id 是 19 位左右的整数，超过 Number.MAX_SAFE_INTEGER，JSON.parse 会把末几位变成 0，
     * 转存时就会指向别的文件（或报文件不存在）。解析前先把它变成字符串。
     */
    function parseJSON(raw) {
        return JSON.parse(raw.replace(/("fs_id"\s*:\s*)(\d+)/g, '$1"$2"'));
    }

    /** 常见 errno 的人话说明；其余照接口的 show_msg 显示。 */
    const ERRNO_HINT = {
        '-6': '未登录或登录已失效，请先在这个浏览器登录百度网盘',
        '-9': '文件夹不存在',
    };

    /** 同源请求（带登录 Cookie）。errno 非 0 抛错，错误信息带上接口名方便排查。 */
    async function request(endpoint, query, form) {
        const url = new URL(endpoint, location.origin);
        for (const [key, value] of Object.entries(query || {})) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        const response = await fetch(url, {
            method: form ? 'POST' : 'GET',
            credentials: 'include',
            headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {},
            body: form ? new URLSearchParams(form) : undefined,
        });
        if (!response.ok) throw new Error(endpoint + '：HTTP ' + response.status);
        let data;
        try {
            data = parseJSON(await response.text());
        } catch (e) {
            throw new Error(endpoint + '：返回的不是 JSON，可能要先过验证码或重新登录');
        }
        const errno = Number(data.errno ?? data.errNo ?? 0);
        if (errno !== 0) {
            const err = new Error(endpoint + '：' + (ERRNO_HINT[errno] || data.show_msg || data.errmsg || data.error_msg || '出错了') + '（errno ' + errno + '）');
            err.errno = errno;
            throw err;
        }
        return data;
    }

    function cookie(name) {
        const item = document.cookie.split('; ').find((x) => x.startsWith(name + '='));
        return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
    }

    /**
     * 分享页把 shareid / 分享者 uk / bdstoken 放在全局变量里：老版是 window.yunData，
     * 新版是 window.locals（有的是普通对象，有的带 get()）。都试一遍。
     */
    function pageVar(key) {
        const w = unsafeWindow;
        if (w.yunData && w.yunData[key] != null) return w.yunData[key];
        const locals = w.locals;
        if (locals) {
            if (typeof locals.get === 'function') {
                const v = locals.get(key);
                if (v != null) return v;
            }
            if (locals[key] != null) return locals[key];
        }
        return null;
    }

    let cachedInfo = null;

    /** { shareid, uk, token }。bdstoken 页面上没有时问一次接口。成功后记住，选文件夹和扫描共用。 */
    async function shareInfo() {
        if (!cachedInfo) cachedInfo = await readShareInfo();
        return cachedInfo;
    }

    async function readShareInfo() {
        const shareid = pageVar('shareid') ?? pageVar('share_id');
        const uk = pageVar('share_uk') ?? pageVar('shareUk') ?? pageVar('uk');
        if (!shareid || !uk) throw new Error('页面上没找到分享信息。如果还没输提取码，先输提取码进入分享页；已经进入的话刷新一下再试');
        let token = pageVar('bdstoken') || '';
        if (!token) {
            const data = await request('/api/gettemplatevariable', { clienttype: 0, app_id: 250528, fields: '["bdstoken"]' });
            token = (data.result && data.result.bdstoken) || data.bdstoken || '';
        }
        if (!token) throw new Error('没取到 bdstoken，请确认这个浏览器已经登录百度网盘');
        return { shareid: String(shareid), uk: String(uk), token };
    }

    // =========================================================================
    // 读目录
    // =========================================================================

    /** 接口里的一行 → { id, name, size, isdir }。 */
    function normalize(row) {
        return {
            id: String(row.fs_id ?? row.fsid ?? ''),
            name: row.server_filename || row.filename || '',
            size: Number(row.size ?? row.file_size ?? -1),
            isdir: Number(row.isdir || 0) === 1,
            path: row.path || '',
        };
    }

    /**
     * 一页一页读到底。一页不满就是最后一页。
     * 翻页时出现重复的 fs_id 说明分页错位了（接口缓存、排序不稳定），继续读可能漏文件，直接停。
     */
    async function readAll(label, fetchPage, pageSize, quiet) {
        const files = [];
        const ids = new Set();
        for (let page = 1; page <= CONFIG.maxPages; page++) {
            const data = await fetchPage(page);
            const rows = data.list || data.records || [];
            if (!Array.isArray(rows)) throw new Error(label + '第 ' + page + ' 页没有文件列表');
            for (const row of rows) {
                const file = normalize(row);
                if (!file.id || !file.name) throw new Error(label + '第 ' + page + ' 页有文件信息不完整');
                if (ids.has(file.id)) throw new Error(label + '翻页时出现重复文件，为防漏文件已停止，请稍后重试');
                ids.add(file.id);
                files.push(file);
            }
            if (!quiet) Panel.say(label + '：已读取 ' + files.length + ' 项', 'busy');
            if (rows.length < pageSize) return files;
        }
        throw new Error(label + '超过 ' + CONFIG.maxPages + ' 页，已停止');
    }

    /** '/a/b/' → '/a/b'，'' → '/'。 */
    function cleanPath(value) {
        return '/' + String(value || '').trim().replace(/^\/+|\/+$/g, '');
    }

    /** 分享里的一个文件夹。'/' 是分享的最外层，要用 root=1 列。 */
    function readShareDir(info, dir, quiet) {
        const sekey = cookie('BDCLND') || pageVar('sekey') || '';
        const where = dir === '/' ? { root: 1 } : { dir };
        return readAll('分享文件夹', (page) => request('/share/list', {
            ...WEB_PARAMS, shareid: info.shareid, uk: info.uk, shorturl: SURL, sekey, ...where,
            page, num: CONFIG.sharePageSize, order: 'name', desc: 0,
        }), CONFIG.sharePageSize, quiet);
    }

    /** 自己网盘里的一个文件夹。quiet：转存后反复核对时不刷状态行。 */
    function readDiskDir(dir, quiet) {
        return readAll('目标文件夹', (page) => request('/api/list', {
            clienttype: 0, web: 1, dir, order: 'name', desc: 0, num: CONFIG.diskPageSize, page,
        }), CONFIG.diskPageSize, quiet);
    }

    // =========================================================================
    // 核对
    // =========================================================================

    /**
     * 按文件名 + 大小核对来源和目标：
     *   目标里没有同名的      → 待转存
     *   同名且大小相同        → 已存在，跳过
     *   同名但大小不同 / 是文件夹 → 停下来。转存过去百度会自动改名（xxx(1).jpg），
     *                             悄悄多出一份比漏掉更难发现，交给人判断。
     * 来源自己有重名也停：按名字核对时分不清是哪一个。
     */
    function compare(source, target) {
        const byName = new Map(target.map((file) => [file.name, file]));
        const seen = new Set();
        const missing = [];
        let existing = 0;
        for (const file of source) {
            if (file.isdir) throw new Error('分享文件夹里有子文件夹「' + file.name + '」，目前只处理当前文件夹里的文件');
            if (seen.has(file.name)) throw new Error('分享文件夹里有重名文件：' + file.name);
            seen.add(file.name);
            const found = byName.get(file.name);
            if (!found) missing.push(file);
            else if (found.isdir || found.size !== file.size) {
                throw new Error('目标里已有同名' + (found.isdir ? '文件夹' : '但大小不同的文件') + '：' + file.name
                    + (found.isdir ? '' : '（分享 ' + file.size + ' 字节，目标 ' + found.size + ' 字节）') + '。为避免重复或覆盖已停止');
            } else existing++;
        }
        return { missing, existing };
    }

    // =========================================================================
    // 转存
    // =========================================================================

    /** 把一批文件（来自分享）转存到目标文件夹。fsidlist 里的 id 是原样的字符串，不经过 Number。 */
    function transfer(info, files, targetDir) {
        return request('/share/transfer', {
            ...WEB_PARAMS, shareid: info.shareid, from: info.uk, bdstoken: info.token,
        }, {
            fsidlist: '[' + files.map((file) => file.id).join(',') + ']',
            path: targetDir,
        });
    }

    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // =========================================================================
    // 默认值
    // =========================================================================

    /**
     * 分享页当前打开的文件夹。分享页在地址里记路径，见过两种写法：
     *   /s/1xxx#list/path=%2F照片%2F2024    （老版，hash）
     *   /s/1xxx?path=%2F照片%2F2024         （新版，query）
     * 都没有（或在最外层）返回空串。
     */
    function browsingPath(loc) {
        const url = new URL(loc.href);
        let raw = url.searchParams.get('path');
        if (!raw) {
            const m = /[#&/]path=([^&]*)/.exec(url.hash);
            if (m) {
                try { raw = decodeURIComponent(m[1]); } catch (e) { raw = ''; }
            }
        }
        const dir = raw ? cleanPath(raw) : '/';
        return dir === '/' ? '' : dir;
    }

    const Defaults = {
        /** 用户自己改过来源就不再自动填。 */
        sourceTouched: false,

        init() {
            const target = GM_getValue('lastTarget', '');
            if (target) Panel.$('[data-ref=target]').value = target;
            Panel.$('[data-ref=source]').addEventListener('input', (e) => { if (e.isTrusted) this.sourceTouched = true; });
            window.addEventListener('hashchange', () => this.fillSource());
            // 预填完成后在宿主元素上打个标记（测试靠它等预填结束）
            this.fillSource().finally(() => { Panel.host.dataset.ready = '1'; });
        },

        /**
         * 来源：地址里有路径就用；在最外层的话，最外层只有一个文件夹（最常见的分享方式）就直接选它。
         * 只是预填，读不到不报错。
         */
        async fillSource() {
            if (this.sourceTouched || Job.running) return;
            const set = (dir) => {
                const input = Panel.$('[data-ref=source]');
                if (this.sourceTouched || input.value === dir) return;
                input.value = dir;
                input.dispatchEvent(new Event('input'));
            };
            const here = browsingPath(location);
            if (here) return set(here);
            try {
                const top = await readShareDir(await shareInfo(), '/', true);
                if (top.length === 1 && top[0].isdir) set(top[0].path || '/' + top[0].name);
            } catch (e) {
                console.info(TAG, '没能预填来源：', e.message);
            }
        },

        /** 扫描成功后记住目标文件夹，下次打开别的分享直接用。 */
        rememberTarget(dir) {
            GM_setValue('lastTarget', dir);
        },
    };

    // =========================================================================
    // 面板
    // =========================================================================

    const UI_CSS = `
        :host { all: initial; }
        :host([hidden]), [hidden] { display: none !important; }
        * { box-sizing: border-box; }
        .panel {
            --blue: #06a7ff; --blue-d: #0590dd; --blue-l: #e8f6ff;
            --ink: #1f2933; --sub: #6b7785; --line: #e6ebf1; --bg: #f7f9fc;
            --ok: #12b76a; --warn: #f79009; --bad: #f04438;
            position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
            width: 392px; max-width: calc(100vw - 40px); max-height: calc(100vh - 40px); overflow: auto;
            background: #fff; color: var(--ink); border-radius: 16px;
            box-shadow: 0 12px 40px rgba(15, 35, 70, .18), 0 0 0 1px rgba(15, 35, 70, .06);
            font: 13px/1.55 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        .head {
            display: flex; align-items: center; gap: 10px; padding: 14px 14px 12px 16px;
            background: linear-gradient(135deg, #06a7ff 0%, #3b7cff 100%); color: #fff;
            border-radius: 16px 16px 0 0; position: sticky; top: 0; z-index: 1;
        }
        .panel.folded .head { border-radius: 16px; }
        .logo {
            flex: none; width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center;
            background: rgba(255,255,255,.22); font-size: 17px;
        }
        .title { flex: 1; min-width: 0; }
        .title b { display: block; font-size: 15px; letter-spacing: .3px; }
        .title small { display: block; font-size: 11.5px; opacity: .85; }
        .icon {
            all: unset; flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
            cursor: pointer; font-size: 15px; color: #fff; transition: background .15s;
        }
        .icon:hover { background: rgba(255,255,255,.2); }
        .body { padding: 14px 16px 16px; }
        .status {
            display: flex; align-items: flex-start; gap: 8px; padding: 9px 11px; border-radius: 10px;
            background: var(--bg); color: var(--ink);
        }
        .status::before { content: ""; flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--sub); }
        .status[data-tone=busy]::before { background: var(--blue); animation: pulse 1.2s ease-in-out infinite; }
        .status[data-tone=ok] { background: #ecfdf3; }
        .status[data-tone=ok]::before { background: var(--ok); }
        .status[data-tone=bad] { background: #fef3f2; color: #b42318; }
        .status[data-tone=bad]::before { background: var(--bad); }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .3 } }
        .field { display: block; margin-bottom: 10px; }
        .field > span { display: block; margin-bottom: 4px; color: var(--sub); font-size: 12px; }
        .row { display: flex; gap: 6px; }
        input {
            flex: 1; min-width: 0; height: 32px; padding: 0 10px; font: inherit; color: var(--ink);
            border: 1px solid var(--line); border-radius: 8px; background: #fff; outline: none; transition: border-color .15s, box-shadow .15s;
        }
        input:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(6,167,255,.15); }
        input:disabled { background: var(--bg); color: var(--sub); }
        .btn {
            all: unset; box-sizing: border-box; height: 32px; padding: 0 14px; border-radius: 8px; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center; gap: 4px; white-space: nowrap;
            font-size: 13px; font-weight: 500; border: 1px solid var(--line); background: #fff; color: var(--ink);
            transition: background .15s, border-color .15s, opacity .15s;
        }
        .btn:hover { background: var(--bg); }
        .btn.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
        .btn.primary:hover { background: var(--blue-d); }
        .btn.danger { color: var(--bad); }
        .btn[disabled] { opacity: .45; cursor: not-allowed; pointer-events: none; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 2px 0 10px; }
        .stat { padding: 8px 6px 7px; border-radius: 10px; background: var(--bg); text-align: center; }
        .stat b { display: block; font-size: 17px; line-height: 1.2; font-variant-numeric: tabular-nums; }
        .stat span { font-size: 11px; color: var(--sub); }
        .stat.todo b { color: var(--blue); }
        .stat.done b { color: var(--ok); }
        .progress { margin: 0 0 10px; }
        .bar { height: 6px; border-radius: 99px; background: var(--line); overflow: hidden; }
        .bar i { display: block; height: 100%; width: 0; border-radius: inherit; background: linear-gradient(90deg, #06a7ff, #3b7cff); transition: width .4s ease; }
        .progress small { display: flex; justify-content: space-between; margin-top: 4px; color: var(--sub); font-size: 11.5px; font-variant-numeric: tabular-nums; }
        .btn.sm { height: 32px; padding: 0 11px; font-size: 12.5px; }
        .picker {
            margin-top: 6px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
            box-shadow: 0 4px 14px rgba(15,35,70,.08);
        }
        .crumbs {
            display: flex; align-items: center; gap: 2px; flex-wrap: wrap; padding: 7px 8px; background: var(--bg);
            border-bottom: 1px solid var(--line); font-size: 12px;
        }
        .crumbs button { all: unset; cursor: pointer; padding: 1px 5px; border-radius: 5px; color: var(--blue-d); }
        .crumbs button:hover { background: var(--blue-l); }
        .crumbs .here { color: var(--ink); font-weight: 600; cursor: default; background: none !important; }
        .crumbs i { color: #b6c0cc; font-style: normal; }
        .crumbs .x { margin-left: auto; color: var(--sub); }
        .folders { max-height: 188px; overflow: auto; padding: 4px; }
        .folders button {
            all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%;
            padding: 6px 8px; border-radius: 7px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .folders button:hover { background: var(--blue-l); }
        .folders button::before { content: "📁"; flex: none; }
        .folders .up::before { content: "↩"; color: var(--sub); }
        .folders .hint { padding: 10px 8px; color: var(--sub); font-size: 12px; }
        .folders .hint.bad { color: var(--bad); }
        .pick-foot { display: flex; align-items: center; gap: 8px; padding: 8px; border-top: 1px solid var(--line); }
        .pick-foot span { flex: 1; min-width: 0; color: var(--sub); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .actions { display: flex; gap: 8px; margin-top: 12px; }
        .actions .btn { flex: 1; }
        details.logbox { margin-top: 12px; }
        details.logbox summary { cursor: pointer; color: var(--sub); font-size: 12px; user-select: none; }
        .log {
            max-height: 160px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 6px 0 0; padding: 8px 10px;
            background: #0f1b2d; color: #c9d6e8; border-radius: 10px; font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace;
        }
        .log:empty::before { content: "暂无日志"; color: #6b7785; }
    `;

    const Panel = {
        host: null,
        root: null,

        mount() {
            this.host = document.createElement('div');
            this.host.id = 'baidu-share-dedupe';
            this.root = this.host.attachShadow({ mode: 'open' });
            this.root.innerHTML = `<style>${UI_CSS}</style>
                <section class="panel">
                    <header class="head">
                        <div class="logo">📦</div>
                        <div class="title"><b>分享批量转存</b><small>每批 500 个 · 按文件名和大小去重 · 可续跑</small></div>
                        <button class="icon" data-act="fold" title="收起">▾</button>
                        <button class="icon" data-act="close" title="隐藏（菜单里可再打开）">✕</button>
                    </header>
                    <div class="body">
                        <div class="field"><span>分享里的文件夹</span>
                            <div class="row"><input data-ref="source" placeholder="/ 表示分享的最外层"><button class="btn sm" data-pick="source">浏览</button></div>
                            <div class="picker" data-picker="source" hidden></div>
                        </div>
                        <div class="field"><span>保存到我的网盘</span>
                            <div class="row"><input data-ref="target" placeholder="例如 /我的资源/照片"><button class="btn sm" data-pick="target">浏览</button></div>
                            <div class="picker" data-picker="target" hidden></div>
                        </div>
                        <div class="stats">
                            <div class="stat"><b data-ref="n-source">–</b><span>分享文件</span></div>
                            <div class="stat done"><b data-ref="n-existing">–</b><span>已存在</span></div>
                            <div class="stat todo"><b data-ref="n-missing">–</b><span>待转存</span></div>
                            <div class="stat"><b data-ref="n-batches">–</b><span>批次</span></div>
                        </div>
                        <div class="progress" data-ref="progress" hidden>
                            <div class="bar"><i data-ref="bar"></i></div>
                            <small><span data-ref="progress-text"></span><span data-ref="progress-pct"></span></small>
                        </div>
                        <div class="status" data-ref="status">准备就绪</div>
                        <div class="actions">
                            <button class="btn" data-act="scan">扫描核对</button>
                            <button class="btn primary" data-act="run" disabled>开始转存</button>
                            <button class="btn danger" data-act="stop" hidden>停止</button>
                        </div>
                        <details class="logbox"><summary>运行日志</summary><pre class="log" data-ref="log"></pre></details>
                    </div>
                </section>`;
            document.documentElement.appendChild(this.host);
            this.$('[data-act=fold]').addEventListener('click', () => this.fold());
            this.$('[data-act=close]').addEventListener('click', () => this.toggle());
            this.$('[data-act=scan]').addEventListener('click', () => Job.action(() => Job.scan()));
            this.$('[data-act=run]').addEventListener('click', () => Job.action(() => Job.run()));
            this.$('[data-act=stop]').addEventListener('click', () => Job.requestStop());
            // 扫描之后改了文件夹，之前的核对结果就不算数了
            for (const ref of ['source', 'target']) {
                this.$('[data-ref=' + ref + ']').addEventListener('input', () => Job.invalidate());
                this.$('[data-pick=' + ref + ']').addEventListener('click', () => Picker.open(ref));
            }
        },

        $(selector) {
            return this.root.querySelector(selector);
        },

        el(html) {
            const t = document.createElement('template');
            t.innerHTML = html.trim();
            return t.content.firstElementChild;
        },

        fold() {
            const body = this.$('.body');
            body.hidden = !body.hidden;
            this.$('.panel').classList.toggle('folded', body.hidden);
            const btn = this.$('[data-act=fold]');
            btn.textContent = body.hidden ? '▴' : '▾';
            btn.title = body.hidden ? '展开' : '收起';
        },

        toggle() {
            this.host.hidden = !this.host.hidden;
        },

        /** 统计格。传 null 清空成「–」。 */
        /** 进度条：目标里已有 done 个（共 total 个）。 */
        progress(done, total) {
            this.$('[data-ref=progress]').hidden = false;
            const pct = total ? Math.floor(done / total * 100) : 0;
            this.$('[data-ref=bar]').style.width = pct + '%';
            this.$('[data-ref=progress-text]').textContent = '已在目标文件夹 ' + done + ' / ' + total;
            this.$('[data-ref=progress-pct]').textContent = pct + '%';
        },

        /** 操作中：扫描 / 转存变灰，停止按钮出现；结束后按 canRun 决定转存按钮。 */
        busy(on, canRun) {
            this.$('[data-act=scan]').disabled = on;
            this.$('[data-act=run]').disabled = on || !canRun;
            this.$('[data-act=run]').hidden = on;
            const stop = this.$('[data-act=stop]');
            stop.hidden = !on;
            stop.disabled = false;
            for (const ref of ['source', 'target']) {
                this.$('[data-ref=' + ref + ']').disabled = on;
                this.$('[data-pick=' + ref + ']').disabled = on;
            }
            if (on) Picker.close();
        },

        stats(n) {
            const set = (ref, v) => { this.$('[data-ref=' + ref + ']').textContent = v == null ? '–' : String(v); };
            set('n-source', n && n.source);
            set('n-existing', n && n.existing);
            set('n-missing', n && n.missing);
            set('n-batches', n && Math.ceil(n.missing / CONFIG.batchSize));
        },

        /**
         * 状态行显示最新一条，日志里带时间留底。
         * tone：busy 进行中 / ok 完成 / bad 出错，不传是普通提示。
         */
        say(message, tone) {
            const status = this.$('[data-ref=status]');
            status.textContent = message;
            if (tone) status.dataset.tone = tone;
            else delete status.dataset.tone;
            const log = this.$('[data-ref=log]');
            log.textContent += new Date().toLocaleTimeString() + ' ' + message + '\n';
            log.scrollTop = log.scrollHeight;
            console.info(TAG, message);
        },
    };

    // =========================================================================
    // 扫描
    // =========================================================================

    // =========================================================================
    // 选文件夹
    // =========================================================================

    /**
     * 两个选择器：分享里的（source）和自己网盘的（target）。
     *
     * 「上一级」靠面包屑栈而不是从路径往上截：分享的最外层条目，路径是分享者网盘里的完整路径
     * （比如 /资料/2024/照片），往上截出来的 /资料/2024 不在分享范围里，列不出来。
     */
    const Picker = {
        kind: null,
        trail: [],      // [{ dir, label }]，第一项是根

        el() {
            return Panel.$('[data-picker=' + this.kind + ']');
        },

        open(kind) {
            if (this.kind === kind && !this.el().hidden) return this.close();
            this.close();
            this.kind = kind;
            this.trail = [{ dir: '/', label: kind === 'source' ? '分享' : '我的网盘' }];
            this.el().hidden = false;
            this.show();
        },

        close() {
            if (this.kind) this.el().hidden = true;
            this.kind = null;
        },

        enter(dir, label) {
            this.trail.push({ dir, label });
            this.show();
        },

        back(index) {
            this.trail = this.trail.slice(0, index + 1);
            this.show();
        },

        /** 当前文件夹里的子文件夹。 */
        async folders(dir) {
            const rows = this.kind === 'source'
                ? await readShareDir(await shareInfo(), dir, true)
                : await readDiskDir(dir, true);
            return rows.filter((row) => row.isdir)
                .map((row) => ({ name: row.name, dir: row.path || (dir === '/' ? '' : dir) + '/' + row.name }));
        },

        async show() {
            const kind = this.kind;
            const trail = this.trail.slice();
            const here = trail[trail.length - 1];
            const box = this.el();
            box.replaceChildren(Panel.el(`<div class="crumbs"></div>`), Panel.el(`<div class="folders"><div class="hint">正在读取…</div></div>`),
                Panel.el(`<div class="pick-foot"><span></span><button class="btn primary sm">选用这个文件夹</button></div>`));
            const crumbs = box.querySelector('.crumbs');
            trail.forEach((step, i) => {
                if (i) crumbs.append(Panel.el('<i>/</i>'));
                const b = Panel.el(i === trail.length - 1 ? '<button class="here"></button>' : '<button></button>');
                b.textContent = step.label;
                b.addEventListener('click', () => { if (i < trail.length - 1) this.back(i); });
                crumbs.append(b);
            });
            const x = Panel.el('<button class="x" title="关闭">✕</button>');
            x.addEventListener('click', () => this.close());
            crumbs.append(x);
            box.querySelector('.pick-foot span').textContent = here.dir;
            box.querySelector('.pick-foot button').addEventListener('click', () => this.choose(here.dir));

            const list = box.querySelector('.folders');
            let folders;
            try {
                folders = await this.folders(here.dir);
            } catch (error) {
                if (this.kind !== kind || this.trail[this.trail.length - 1] !== here) return;
                list.replaceChildren(Panel.el('<div class="hint bad"></div>'));
                list.firstChild.textContent = '读取失败：' + error.message;
                return;
            }
            // 读的时候用户已经点去别处了
            if (this.kind !== kind || this.trail[this.trail.length - 1] !== here) return;
            list.replaceChildren();
            if (trail.length > 1) {
                const up = Panel.el('<button class="up">上一级</button>');
                up.addEventListener('click', () => this.back(trail.length - 2));
                list.append(up);
            }
            for (const f of folders) {
                const b = Panel.el('<button></button>');
                b.textContent = f.name;
                b.title = f.dir;
                b.addEventListener('click', () => this.enter(f.dir, f.name));
                list.append(b);
            }
            if (!folders.length) list.append(Panel.el('<div class="hint">这里没有子文件夹</div>'));
        },

        choose(dir) {
            const input = Panel.$('[data-ref=' + this.kind + ']');
            input.value = dir;
            input.dispatchEvent(new Event('input'));
            this.close();
        },
    };

    /** 用户点了停止。和出错分开：不算失败，不标红。 */
    class Stopped extends Error {}

    const Job = {
        running: false,

        /** 同一时间只跑一件事；出错显示在状态行，按钮恢复。 */
        async action(fn) {
            if (this.running) return;
            this.running = true;
            this.stopping = false;
            Panel.busy(true);
            try {
                await fn();
            } catch (error) {
                if (error instanceof Stopped) Panel.say('已停止。重新点「扫描核对」再「开始转存」即可续跑，已存的会跳过');
                else {
                    Panel.say('停止：' + error.message, 'bad');
                    console.error(TAG, error);
                }
            } finally {
                this.running = false;
                Panel.busy(false, !!(this.plan && this.plan.missing > 0));
            }
        },

        stopping: false,

        /** 停止不打断正在发的请求：当前这批转存会先完成，下一步开始前停下。 */
        requestStop() {
            if (!this.running || this.stopping) return;
            this.stopping = true;
            Panel.$('[data-act=stop]').disabled = true;
            Panel.say('正在停止：已发出的这一批会先完成…', 'busy');
        },

        /** 每个可以停下的点调用一次。 */
        checkStop() {
            if (this.stopping) throw new Stopped();
        },

        invalidate() {
            if (!this.plan || this.running) return;
            this.plan = null;
            Panel.stats(null);
            Panel.$('[data-act=run]').disabled = true;
            Panel.say('文件夹改了，请重新扫描核对');
        },

        /** 扫描结果：{ info, sourceDir, targetDir, source }，转存时用。 */
        plan: null,

        async scan() {
            this.plan = null;
            Panel.stats(null);
            const sourceDir = cleanPath(Panel.$('[data-ref=source]').value);
            const targetDir = cleanPath(Panel.$('[data-ref=target]').value);
            if (targetDir === '/') throw new Error('请填写保存到我的网盘的哪个文件夹（不能直接存到根目录）');
            Panel.say('正在读取分享信息…', 'busy');
            const info = await shareInfo();
            const source = await readShareDir(info, sourceDir);
            if (!source.length) throw new Error('分享文件夹 ' + sourceDir + ' 是空的，请核对路径');
            const target = await readDiskDir(targetDir);
            const diff = compare(source, target);
            this.plan = { info, sourceDir, targetDir, source, missing: diff.missing.length };
            Defaults.rememberTarget(targetDir);
            Panel.stats({ source: source.length, existing: diff.existing, missing: diff.missing.length });
            Panel.progress(diff.existing, source.length);
            Panel.say(diff.missing.length
                ? '核对完成：待转存 ' + diff.missing.length + ' 个，分 ' + Math.ceil(diff.missing.length / CONFIG.batchSize) + ' 批'
                : '核对完成：分享的 ' + source.length + ' 个文件都已在目标文件夹里', 'ok');
        },

        /**
         * 一批一批转存。每批之前重新读一遍目标文件夹再核对 —— 只信目标里实际有什么，
         * 不信「上一批返回成功」：转存接口偶尔返回成功但文件晚到或没到。
         * 每批转存后等到这批文件都出现在目标里再进下一批，到不齐就停，重新扫描即可续跑。
         */
        async run() {
            const plan = this.plan;
            if (!plan) throw new Error('请先扫描核对');
            const total = plan.source.length;
            for (let batch = 1; ; batch++) {
                this.checkStop();
                const diff = compare(plan.source, await readDiskDir(plan.targetDir));
                plan.missing = diff.missing.length;
                Panel.stats({ source: total, existing: diff.existing, missing: diff.missing.length });
                Panel.progress(diff.existing, total);
                if (!diff.missing.length) {
                    Panel.say('完成：分享的 ' + total + ' 个文件都已在 ' + plan.targetDir, 'ok');
                    return;
                }
                this.checkStop();
                const files = diff.missing.slice(0, CONFIG.batchSize);
                Panel.say('第 ' + batch + ' 批：转存 ' + files.length + ' 个（还差 ' + diff.missing.length + ' 个）', 'busy');
                await transfer(plan.info, files, plan.targetDir);
                await this.verify(files, plan.targetDir, batch);
                Panel.say('第 ' + batch + ' 批已到齐', 'busy');
            }
        },

        /** 隔一会儿查一次目标文件夹，直到这批文件都在（名字和大小都对得上）。 */
        async verify(files, targetDir, batch) {
            for (let i = 0; i < CONFIG.verifyTries; i++) {
                await pause(CONFIG.verifyDelayMs);
                this.checkStop();
                const byName = new Map((await readDiskDir(targetDir, true)).map((file) => [file.name, file]));
                if (files.every((file) => byName.has(file.name) && byName.get(file.name).size === file.size)) return;
            }
            throw new Error('第 ' + batch + ' 批接口返回成功，但等了约 ' + Math.round(CONFIG.verifyTries * CONFIG.verifyDelayMs / 1000)
                + ' 秒目标文件夹里还没到齐。稍后重新扫描核对即可续跑，已到的会跳过');
        },
    };

    // =========================================================================
    // 启动
    // =========================================================================

    const SURL = shareKey(location);
    if (!SURL || document.getElementById('baidu-share-dedupe')) return;
    Panel.mount();
    Defaults.init();
    GM_registerMenuCommand('📦 显示 / 隐藏转存面板', () => Panel.toggle());
})();
