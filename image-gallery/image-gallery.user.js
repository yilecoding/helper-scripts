// ==UserScript==
// @name         网页图片查看与批量下载
// @name:zh-CN   网页图片查看与批量下载
// @name:en      Image Gallery — View & Batch Download Page Images
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.05.21.2
// @description  收集当前网页里的所有图片，在全屏网格里浏览、放大查看，勾选后批量下载。快捷键 Alt+Shift+I 或脚本菜单打开。
// @description:zh-CN  收集当前网页里的所有图片，在全屏网格里浏览、放大查看，勾选后批量下载。快捷键 Alt+Shift+I 或脚本菜单打开。
// @description:en  Collect every image on the current page into a full-screen gallery: browse, zoom in, and batch download the ones you pick. Open with Alt+Shift+I or the userscript menu.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @license      CC BY-NC-SA
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/image-gallery/image-gallery.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/image-gallery/image-gallery.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 统一日志前缀，控制台过滤「图片画廊」即可只看本脚本的输出。 */
    const TAG = '[图片画廊]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        /*
         * 快捷键按 KeyboardEvent.code 匹配，不按 key。
         * macOS 上按住 Option 时 e.key 会变成「ˆ」之类的特殊字符，按 key 判断永远对不上。
         */
        hotkey: { alt: true, shift: true, ctrl: false, meta: false, code: 'KeyI' },
        zIndex: 2147483646,

        /*
         * 懒加载库把真图地址藏在这些属性里，src 只是占位图（常见是 1×1 的 data: gif）。
         * 按顺序取第一个有值的。
         */
        lazyAttrs: [
            'data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-actualsrc',
            'data-original-src', 'data-echo', 'lazy-src',
        ],
        lazySrcsetAttrs: ['data-srcset', 'data-lazy-srcset'],
    };

    const HOST_ID = '__image-gallery-host';

    // =========================================================================
    // 收集
    // =========================================================================

    /**
     * 转成绝对地址、去掉 #hash，作为去重的键。不是图片能用的协议一律丢掉。
     * query 保留：很多图床靠 query 区分尺寸/版本（?w=800、?x-oss-process=…），去掉会合并成同一张。
     */
    function normalizeUrl(raw) {
        if (!raw) return null;
        raw = raw.trim();
        if (!raw) return null;
        try {
            const u = new URL(raw, document.baseURI);
            if (!/^(https?|data|blob):$/.test(u.protocol)) return null;
            u.hash = '';
            return u.href;
        } catch (e) {
            return null;
        }
    }

    /**
     * 解析 srcset，返回 [{ url, w, x }]。没有描述符的候选按 1x 算。
     * 按「逗号 + 空白」切分，Cloudinary 那种 URL 里带逗号的（w_200,h_100）不会被切断。
     */
    function parseSrcset(srcset) {
        const out = [];
        for (const part of srcset.split(/,\s+/)) {
            const [url, desc = '1x'] = part.trim().split(/\s+/);
            if (!url) continue;
            const m = desc.match(/^([\d.]+)([wx])$/i);
            out.push({
                url,
                w: m && m[2].toLowerCase() === 'w' ? parseFloat(m[1]) : 0,
                x: m && m[2].toLowerCase() === 'x' ? parseFloat(m[1]) : 1,
            });
        }
        return out;
    }

    /** 多个 srcset 合在一起挑分辨率最高的。w 描述符一律压过 x（有宽度的才是真实尺寸）。 */
    function bestFromSrcsets(srcsets) {
        let best = null;
        let bestScore = -1;
        for (const s of srcsets) {
            if (!s) continue;
            for (const c of parseSrcset(s)) {
                const score = c.w ? 1e6 + c.w : c.x;
                if (score > bestScore) {
                    best = c.url;
                    bestScore = score;
                }
            }
        }
        return best;
    }

    /**
     * 一个 <img> 只取一张：<picture><source> + srcset 里最大的 > 懒加载属性 > currentSrc > src。
     * 懒加载属性里的 data: 是占位图，跳过。
     */
    function pickImgUrl(img) {
        const srcsets = [];
        const pic = img.parentElement;
        if (pic && pic.tagName === 'PICTURE') {
            for (const s of pic.children) {
                if (s.tagName !== 'SOURCE') continue;
                srcsets.push(s.getAttribute('srcset'));
                for (const a of CONFIG.lazySrcsetAttrs) srcsets.push(s.getAttribute(a));
            }
        }
        srcsets.push(img.getAttribute('srcset'));
        for (const a of CONFIG.lazySrcsetAttrs) srcsets.push(img.getAttribute(a));
        const best = bestFromSrcsets(srcsets);
        if (best) return best;

        for (const a of CONFIG.lazyAttrs) {
            const v = img.getAttribute(a);
            if (v && !v.trim().startsWith('data:')) return v;
        }
        return img.currentSrc || img.getAttribute('src');
    }

    function collect() {
        const seen = new Set();
        const items = [];
        const add = (raw, source, el) => {
            const url = normalizeUrl(raw);
            if (!url || seen.has(url)) return;
            seen.add(url);
            items.push({ url, source, el });
        };
        for (const img of document.querySelectorAll('img')) add(pickImgUrl(img), 'img', img);
        return items;
    }

    // =========================================================================
    // 浮层
    // =========================================================================

    /*
     * 浮层挂在 shadow DOM 里：页面的全局样式（img { max-width: 50% }、* { box-sizing } 之类）
     * 一条都进不来，我们的样式也不会漏到页面上。
     */
    const STYLE = `
        :host { all: initial; }
        .overlay {
            position: fixed; inset: 0; z-index: ${CONFIG.zIndex};
            display: flex; flex-direction: column;
            background: rgba(18, 18, 20, .96); color: #eee;
            font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        .bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid #333; }
        .bar .title { font-weight: 600; margin-right: auto; }
        button {
            font: inherit; color: #eee; background: #2c2c30; border: 1px solid #444;
            border-radius: 6px; padding: 4px 12px; cursor: pointer;
        }
        button:hover { background: #3a3a40; }
        .body { flex: 1; overflow: auto; padding: 16px; }
        .list { margin: 0; padding: 0; list-style: none; }
        .list li { padding: 2px 0; word-break: break-all; }
    `;

    const Gallery = (() => {
        let host = null;
        let root = null;

        function isOpen() {
            return !!host && host.isConnected;
        }

        function render(items) {
            root.querySelector('.count').textContent = `${items.length} 张`;
            const list = root.querySelector('.list');
            list.textContent = '';
            for (const it of items) {
                const li = document.createElement('li');
                li.dataset.url = it.url;
                li.textContent = it.url;
                list.appendChild(li);
            }
        }

        function open() {
            if (isOpen()) return;
            host = document.createElement('div');
            host.id = HOST_ID;
            root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `
                <style>${STYLE}</style>
                <div class="overlay" role="dialog" aria-label="图片画廊">
                    <div class="bar">
                        <span class="title">图片画廊</span>
                        <span class="count"></span>
                        <button type="button" class="close" title="关闭（Esc）">关闭</button>
                    </div>
                    <div class="body"><ul class="list"></ul></div>
                </div>`;
            root.querySelector('.close').addEventListener('click', close);
            document.documentElement.appendChild(host);
            const items = collect();
            console.log(TAG, `收集到 ${items.length} 张图片`);
            render(items);
        }

        function close() {
            if (host) host.remove();
            host = null;
            root = null;
        }

        function toggle() {
            isOpen() ? close() : open();
        }

        /** 浮层打开时由它处理按键；返回 true 表示已处理。 */
        function onKey(e) {
            if (e.key === 'Escape') {
                close();
                return true;
            }
            return false;
        }

        return { open, close, toggle, isOpen, onKey };
    })();

    // =========================================================================
    // 入口
    // =========================================================================

    function matchHotkey(e) {
        const k = CONFIG.hotkey;
        return e.code === k.code && e.altKey === k.alt && e.shiftKey === k.shift
            && e.ctrlKey === k.ctrl && e.metaKey === k.meta;
    }

    /*
     * 捕获阶段监听 window：页面自己的快捷键（比如很多站点把 Esc、方向键绑给了轮播图）
     * 在冒泡阶段才处理，我们先拿到并 stopPropagation，浮层打开期间页面收不到这些按键。
     */
    window.addEventListener('keydown', (e) => {
        if (matchHotkey(e)) {
            e.preventDefault();
            e.stopPropagation();
            Gallery.toggle();
            return;
        }
        if (Gallery.isOpen() && Gallery.onKey(e)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    GM_registerMenuCommand('打开图片画廊（Alt+Shift+I）', () => Gallery.open());
})();
