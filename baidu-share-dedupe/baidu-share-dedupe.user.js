// ==UserScript==
// @name         百度网盘分享批量转存｜非会员自动分批、按文件名和大小去重、可续跑
// @name:zh-CN   百度网盘分享批量转存｜非会员自动分批、按文件名和大小去重、可续跑
// @name:en      Baidu Netdisk Share Batch Saver — Auto-batched, Deduplicated, Resumable
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2026.10.29.1
// @description  在百度网盘分享页把整个文件夹转存到自己的网盘：自动拆成每批 500 个（非会员单次上限），先和目标文件夹按文件名 + 大小核对，已有的跳过；每批转存后核对到齐再继续，中途停了重新扫描就能续跑。
// @description:zh-CN  在百度网盘分享页把整个文件夹转存到自己的网盘：自动拆成每批 500 个（非会员单次上限），先和目标文件夹按文件名 + 大小核对，已有的跳过；每批转存后核对到齐再继续，中途停了重新扫描就能续跑。
// @description:en  Saves a whole folder from a Baidu Netdisk share link into your own netdisk: splits it into batches of 500 (the per-transfer limit for non-members), compares against the target folder by file name and size so existing files are skipped, verifies each batch before the next, and resumes after a rescan if stopped.
// @author       壹樂（V：ita1125）
// @match        https://pan.baidu.com/s/*
// @match        https://pan.baidu.com/share/*
// @noframes
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
                        <div class="status" data-ref="status">准备就绪</div>
                        <details class="logbox"><summary>运行日志</summary><pre class="log" data-ref="log"></pre></details>
                    </div>
                </section>`;
            document.documentElement.appendChild(this.host);
            this.$('[data-act=fold]').addEventListener('click', () => this.fold());
            this.$('[data-act=close]').addEventListener('click', () => this.toggle());
        },

        $(selector) {
            return this.root.querySelector(selector);
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
    // 启动
    // =========================================================================

    const SURL = shareKey(location);
    if (!SURL || document.getElementById('baidu-share-dedupe')) return;
    Panel.mount();
    GM_registerMenuCommand('📦 显示 / 隐藏转存面板', () => Panel.toggle());
})();
