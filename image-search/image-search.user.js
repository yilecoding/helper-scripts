// ==UserScript==
// @name         以图搜图
// @name:zh-CN   以图搜图
// @name:en      Image Search — Reverse Image Search from Any Image
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.10.30.1
// @description  在网页图片上按住 Alt 点右键，弹出搜图菜单，一键用 Google Lens / Bing / Yandex / 百度识图 / SauceNAO / TinEye / IQDB / ascii2d / Trace.moe 搜这张图。
// @description:zh-CN  在网页图片上按住 Alt 点右键，弹出搜图菜单，一键用 Google Lens / Bing / Yandex / 百度识图 / SauceNAO / TinEye / IQDB / ascii2d / Trace.moe 搜这张图。
// @description:en  Alt + right-click any image to pop up a reverse image search menu: Google Lens / Bing / Yandex / Baidu / SauceNAO / TinEye / IQDB / ascii2d / Trace.moe.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_openInTab
// @license      CC BY-NC-SA
// @run-at       document-end
// @noframes
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/image-search/image-search.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/image-search/image-search.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 统一日志前缀，控制台过滤「以图搜图」即可只看本脚本的输出。 */
    const TAG = '[以图搜图]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        zIndex: 2147483647,
        menuMargin: 8,   // 菜单离视口边缘至少留这么多像素，贴边时翻到鼠标另一侧
    };

    const enc = encodeURIComponent;

    /*
     * 引擎表。url(imageUrl) 返回「按地址搜」的结果页地址。
     * 各地址格式的核实情况见 notes.md —— 有几家只能从公开资料确认，本机网络到不了。
     * defaultOn: false 的默认不出现在菜单里（能打开但实测搜不出结果的）。
     */
    const ENGINES = [
        { id: 'lens', name: 'Google Lens', defaultOn: true,
            url: u => 'https://lens.google.com/uploadbyurl?url=' + enc(u) },
        { id: 'bing', name: 'Bing', defaultOn: true,
            url: u => 'https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:' + enc(u) },
        { id: 'yandex', name: 'Yandex', defaultOn: true,
            url: u => 'https://yandex.com/images/search?rpt=imageview&url=' + enc(u) },
        { id: 'baidu', name: '百度识图', defaultOn: true,
            url: u => 'https://graph.baidu.com/pcpage/index?tpl_from=pc&queryImageUrl=' + enc(u) },
        { id: 'sogou', name: '搜狗识图', defaultOn: false,
            url: u => 'https://pic.sogou.com/ris?flag=1&drag=0&query=' + enc(u) },
        { id: 'saucenao', name: 'SauceNAO', defaultOn: true,
            url: u => 'https://saucenao.com/search.php?url=' + enc(u) },
        { id: 'tineye', name: 'TinEye', defaultOn: true,
            url: u => 'https://tineye.com/search?url=' + enc(u) },
        { id: 'iqdb', name: 'IQDB', defaultOn: true,
            url: u => 'https://iqdb.org/?url=' + enc(u) },
        { id: 'ascii2d', name: 'ascii2d', defaultOn: true,
            url: u => 'https://ascii2d.net/search/url/' + enc(u) },
        { id: 'tracemoe', name: 'Trace.moe（动画截图）', defaultOn: true,
            url: u => 'https://trace.moe/?url=' + enc(u) },
    ];

    const HOST_ID = '__image-search-host';

    // =========================================================================
    // 取图片地址
    // =========================================================================

    function normalizeUrl(raw) {
        if (!raw) return null;
        try {
            const u = new URL(raw.trim(), document.baseURI);
            if (!/^(https?|data|blob):$/.test(u.protocol)) return null;
            return u.href;
        } catch (e) {
            return null;
        }
    }

    /** 鼠标位置下的图片：{ url, el }，没有返回 null。 */
    function findImageAt(x, y) {
        for (const el of document.elementsFromPoint(x, y)) {
            if (el.id === HOST_ID) continue;
            if (el.tagName === 'IMG') {
                const url = normalizeUrl(el.currentSrc || el.getAttribute('src'));
                if (url) return { url, el };
            }
        }
        return null;
    }

    // =========================================================================
    // 菜单
    // =========================================================================

    const STYLE = `
        :host { all: initial; }
        .pop {
            position: fixed; z-index: ${CONFIG.zIndex}; box-sizing: border-box;
            min-width: 200px; max-width: 320px; padding: 6px 0;
            background: #fff; color: #222; border: 1px solid #d0d0d0; border-radius: 8px;
            box-shadow: 0 6px 24px rgba(0,0,0,.18);
            font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        .head { padding: 2px 12px 6px; font-weight: 600; }
        .src {
            padding: 0 12px 6px; color: #888; font-size: 11px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .item {
            display: flex; width: 100%; box-sizing: border-box; align-items: baseline; gap: 8px;
            padding: 6px 12px; border: 0; background: none; color: inherit; font: inherit;
            text-align: left; cursor: pointer;
        }
        .item:hover, .item:focus-visible { background: #eef3ff; outline: none; }
        @media (prefers-color-scheme: dark) {
            .pop { background: #2a2a2e; color: #eee; border-color: #444; }
            .item:hover, .item:focus-visible { background: #3a3f55; }
        }
    `;

    const Menu = {
        host: null,
        target: null,

        isOpen() {
            return !!this.host;
        },

        open(target, x, y) {
            this.close();
            this.target = target;
            const host = document.createElement('div');
            host.id = HOST_ID;
            const root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>${STYLE}</style><div class="pop" role="menu"></div>`;
            const pop = root.querySelector('.pop');
            pop.dataset.url = target.url;

            const head = document.createElement('div');
            head.className = 'head';
            head.textContent = '以图搜图';
            const src = document.createElement('div');
            src.className = 'src';
            src.textContent = src.title = target.url;
            pop.append(head, src);

            for (const engine of ENGINES.filter(e => e.defaultOn)) {
                const b = document.createElement('button');
                b.className = 'item engine';
                b.dataset.engine = engine.id;
                b.setAttribute('role', 'menuitem');
                b.textContent = engine.name;
                b.addEventListener('click', () => {
                    GM_openInTab(engine.url(target.url), { active: true, insert: true, setParent: true });
                    this.close();
                });
                pop.append(b);
            }

            document.documentElement.appendChild(host);
            this.host = host;
            pop.style.left = x + 'px';
            pop.style.top = y + 'px';
        },

        close() {
            if (!this.host) return;
            this.host.remove();
            this.host = null;
            this.target = null;
        },
    };

    // =========================================================================
    // 触发
    // =========================================================================

    /*
     * Alt + 右键：左键留给页面（点开灯箱、跟随链接），而 Chrome / Firefox 里 Alt + 左键点链接
     * 是「下载链接目标」，包在 <a> 里的图会被直接下载。右键本来就是浏览器的地盘，
     * 加 Alt 在 Windows / macOS 上没有默认行为。
     * 捕获阶段监听：页面自己屏蔽右键（contextmenu 里 preventDefault + stopPropagation）时也能先拿到。
     */
    window.addEventListener('contextmenu', (e) => {
        if (!e.altKey) return;
        const target = findImageAt(e.clientX, e.clientY);
        if (!target) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        Menu.open(target, e.clientX, e.clientY);
    }, true);

    window.addEventListener('keydown', (e) => {
        if (Menu.isOpen() && e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            Menu.close();
        }
    }, true);

    /** 点菜单外面关闭。composedPath 里有宿主元素就是点在菜单里（shadow DOM 里的点击 target 被重定向成宿主）。 */
    window.addEventListener('pointerdown', (e) => {
        if (Menu.isOpen() && !e.composedPath().includes(Menu.host)) Menu.close();
    }, true);

    console.log(TAG, '已加载');
})();
