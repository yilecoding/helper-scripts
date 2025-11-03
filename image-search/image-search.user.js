// ==UserScript==
// @name         以图搜图
// @name:zh-CN   以图搜图
// @name:en      Image Search — Reverse Image Search from Any Image
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.11.03.5
// @description  在网页图片上按住 Alt 点右键（或鼠标悬停按 S），弹出搜图菜单，一键用 Google Lens / Bing / Yandex / 百度识图 / SauceNAO / TinEye / IQDB / ascii2d / Trace.moe 搜这张图。
// @description:zh-CN  在网页图片上按住 Alt 点右键（或鼠标悬停按 S），弹出搜图菜单，一键用 Google Lens / Bing / Yandex / 百度识图 / SauceNAO / TinEye / IQDB / ascii2d / Trace.moe 搜这张图。
// @description:en  Alt + right-click any image (or hover it and press S) to pop up a reverse image search menu: Google Lens / Bing / Yandex / Baidu / SauceNAO / TinEye / IQDB / ascii2d / Trace.moe.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @grant        GM_download
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

        /*
         * 鼠标悬停在图片上时按这个键（不带修饰键）弹出菜单。设成 '' 关闭。
         * 输入框、可编辑区域里不响应；鼠标下面不是图片时按键原样交给页面。
         */
        hoverKey: 's',

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

    /**
     * 转成绝对地址。#hash 去掉：服务器根本收不到它，带着反而会被搜图引擎当成地址的一部分。
     */
    function normalizeUrl(raw) {
        if (!raw) return null;
        raw = raw.trim();
        if (!raw) return null;
        try {
            const u = new URL(raw, document.baseURI);
            if (!/^(https?|data|blob):$/.test(u.protocol)) return null;
            if (u.protocol !== 'data:') u.hash = '';
            return u.href;
        } catch (e) {
            return null;
        }
    }

    /**
     * 解析 srcset，返回 [{ url, w, x }]。没有描述符的候选按 1x 算。
     *
     * 不能按「逗号 + 空白」切：压缩过的 HTML 里逗号后面常常没有空格（a.jpg 1x,b.jpg 2x）。
     * 也不能按逗号切：Cloudinary 之类的 URL 自带逗号（c_fill,w_800）。按规范来 ——
     * URL 是一段不含空白的字符，URL 末尾的逗号才是分隔符；描述符读到下一个逗号为止。
     */
    function parseSrcset(srcset) {
        const out = [];
        const s = srcset || '';
        let i = 0;
        while (i < s.length) {
            while (i < s.length && /[\s,]/.test(s[i])) i++;
            if (i >= s.length) break;
            let start = i;
            while (i < s.length && !/\s/.test(s[i])) i++;
            let url = s.slice(start, i);
            let desc = '';
            if (url.endsWith(',')) {
                url = url.replace(/,+$/, '');
            } else {
                start = i;
                while (i < s.length && s[i] !== ',') i++;
                desc = s.slice(start, i).trim();
            }
            if (!url) continue;
            const m = /^([\d.]+)([wx])$/i.exec(desc);
            out.push({
                url,
                w: m && m[2].toLowerCase() === 'w' ? parseFloat(m[1]) : 0,
                x: m && m[2].toLowerCase() === 'x' ? parseFloat(m[1]) : 1,
            });
        }
        return out;
    }

    /** 几个 srcset 合起来挑最大的。w 描述符一律压过 x（有宽度的才是真实尺寸）。 */
    function bestFromSrcsets(srcsets) {
        let best = null;
        let bestScore = -1;
        for (const s of srcsets) {
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
     * 一个 <img> 取一张：<picture><source> + srcset 里最大的 > 懒加载属性 > currentSrc > src。
     * currentSrc 是浏览器按屏幕挑的那一张，往往不是最大的，所以排在 srcset 后面。
     * 懒加载属性里的 data: 是占位图，跳过；src 本身是占位图时同理要先看懒加载属性。
     */
    function pickImgUrl(img) {
        const srcsets = [];
        const pic = img.parentElement;
        if (pic && pic.tagName === 'PICTURE') {
            for (const s of pic.children) {
                if (s.tagName !== 'SOURCE') continue;
                for (const a of ['srcset', ...CONFIG.lazySrcsetAttrs]) srcsets.push(s.getAttribute(a));
            }
        }
        for (const a of ['srcset', ...CONFIG.lazySrcsetAttrs]) srcsets.push(img.getAttribute(a));
        const best = bestFromSrcsets(srcsets);
        if (best) return best;

        for (const a of CONFIG.lazyAttrs) {
            const v = img.getAttribute(a);
            if (v && !v.trim().startsWith('data:')) return v;
        }
        return img.currentSrc || img.getAttribute('src');
    }

    /** background-image 计算值里的第一个 url(...)；渐变之类的忽略。 */
    function backgroundUrl(el) {
        const value = getComputedStyle(el).backgroundImage;
        if (!value || value === 'none') return null;
        const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value);
        return m ? m[2] : null;
    }

    /** 单个元素能给出的图片，给不出返回 null。 */
    function imageFromElement(el) {
        let raw = null;
        if (el.tagName === 'IMG') raw = pickImgUrl(el);
        // <html> / <body> 的背景是整页底纹，鼠标在任何空白处都会命中它，不算
        else if (el !== document.documentElement && el !== document.body) raw = backgroundUrl(el);
        const url = normalizeUrl(raw);
        return url ? { url, el } : null;
    }

    /**
     * 鼠标位置下的图片：{ url, el }，没有返回 null。
     *
     * 用 elementsFromPoint 从上往下逐层找，而不是只看事件的 target：Instagram、Pinterest、
     * 各种防盗图的站点都在图片上盖一层透明 div，target 永远是那层壳。
     * open shadow root 要进去再找一遍 —— 从 document 上只能拿到宿主元素。
     */
    function findImageAt(x, y, root = document, depth = 0) {
        for (const el of root.elementsFromPoint(x, y)) {
            if (el.id === HOST_ID) continue;
            if (el.shadowRoot && el.shadowRoot !== root && depth < 5) {
                const inner = findImageAt(x, y, el.shadowRoot, depth + 1);
                if (inner) return inner;
            }
            const found = imageFromElement(el);
            if (found) return found;
        }
        return null;
    }

    // =========================================================================
    // 原图：打开 / 下载
    // =========================================================================

    const IMG_EXT_RE = /^(jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|heif|jfif)$/i;
    const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico' };

    /**
     * data: 地址同步解码成 Blob，不用 fetch(data:)：一来点击处理里同步拿到才能 window.open 不被拦，
     * 二来 fetch(data:) 受页面 CSP 的 connect-src 管。
     */
    function dataUrlToBlob(dataUrl) {
        const m = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(dataUrl);
        if (!m) throw new Error('不是合法的 data: 地址');
        const mime = m[1] || 'application/octet-stream';
        const isBase64 = /;base64/i.test(m[2]);
        const text = isBase64 ? atob(m[3].replace(/\s+/g, '')) : decodeURIComponent(m[3]);
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        return new Blob([bytes], { type: mime });
    }

    /** 下载用的文件名：路径最后一段；看不出扩展名就按 MIME 补，再不行补 jpg。 */
    function fileNameFor(url, mime) {
        let base = 'image';
        let ext = MIME_EXT[(mime || '').toLowerCase()] || '';
        if (/^https?:/.test(url)) {
            let seg = '';
            try {
                seg = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
            } catch (e) { /* 路径里有非法的 % 转义 */ }
            const m = /^(.+?)(?:\.([a-z0-9]{2,5}))?$/i.exec(seg);
            if (m) {
                base = m[1];
                // image.php?id=1 这种，扩展名不是图片格式就不用它
                if (m[2] && IMG_EXT_RE.test(m[2])) ext = m[2].toLowerCase();
                else if (m[2]) base = seg;
            }
        }
        base = base.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 100) || 'image';
        return `${base}.${ext || 'jpg'}`;
    }

    /**
     * http(s) 走 GM_openInTab。data: / blob: 在页面里 window.open 一个 blob: 地址：
     * 顶层导航到 data: 被 Chrome / Firefox 禁了；页面创建的 blob: 交给扩展去开，
     * 各家管理器的表现没有核实过，留在页面里开最稳。
     */
    function openOriginal(url) {
        if (/^https?:/.test(url)) {
            GM_openInTab(url, { active: true, insert: true, setParent: true });
            return;
        }
        const href = url.startsWith('data:') ? URL.createObjectURL(dataUrlToBlob(url)) : url;
        window.open(href, '_blank', 'noopener');
    }

    /** 下载原图。返回 Promise，失败时 reject 一句给人看的原因。 */
    function downloadOriginal(url) {
        if (!/^https?:/.test(url)) {
            // data: / blob: 是页面自己的，<a download> 就能存，不必经过扩展
            try {
                const blob = url.startsWith('data:') ? dataUrlToBlob(url) : null;
                const a = document.createElement('a');
                a.href = blob ? URL.createObjectURL(blob) : url;
                a.download = fileNameFor(url, blob && blob.type);
                document.documentElement.appendChild(a);
                a.click();
                a.remove();
                if (blob) setTimeout(() => URL.revokeObjectURL(a.href), 60000);
                return Promise.resolve();
            } catch (e) {
                return Promise.reject(e.message || String(e));
            }
        }
        return new Promise((resolve, reject) => {
            try {
                GM_download({
                    url,
                    name: fileNameFor(url),
                    onload: () => resolve(),
                    onerror: e => reject((e && (e.details || e.error)) || '未知错误'),
                    ontimeout: () => reject('超时'),
                });
            } catch (e) {
                reject(e.message || String(e));
            }
        });
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
        .sep { margin: 4px 0; border-top: 1px solid #e5e5e5; }
        .status { padding: 6px 12px 2px; color: #555; font-size: 12px; word-break: break-all; }
        .status.error { color: #c62828; }
        @media (prefers-color-scheme: dark) {
            .sep { border-color: #444; }
            .status { color: #bbb; }
            .status.error { color: #ff8a80; }
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

            const engines = ENGINES.filter(e => e.defaultOn);
            for (const engine of engines) {
                const b = this.item(engine.name, () => {
                    GM_openInTab(engine.url(target.url), { active: true, insert: true, setParent: true });
                    this.close();
                });
                b.classList.add('engine');
                b.dataset.engine = engine.id;
                pop.append(b);
            }
            if (engines.length > 1) {
                const all = this.item(`全部打开（${engines.length}）`, () => {
                    // 后台打开：一次弹出八九个前台标签，焦点会停在最后一个上，还得一个个切回来
                    for (const engine of engines) GM_openInTab(engine.url(target.url), { active: false, insert: true, setParent: true });
                    this.close();
                });
                all.classList.add('all');
                pop.append(all);
            }

            const sep = document.createElement('div');
            sep.className = 'sep';
            pop.append(sep);
            const act = (name, label, fn) => {
                const b = this.item(label, fn);
                b.dataset.act = name;
                pop.append(b);
            };
            act('copy', '复制图片地址', () => {
                GM_setClipboard(target.url, 'text');
                this.close();
            });
            act('open', '在新标签打开原图', () => {
                openOriginal(target.url);
                this.close();
            });
            act('download', '下载原图', () => {
                this.setStatus('正在下载…');
                downloadOriginal(target.url).then(
                    () => this.close(),
                    err => this.setStatus('下载失败：' + err + '。可以点「在新标签打开原图」后右键另存。', true),
                );
            });

            const status = document.createElement('div');
            status.className = 'status';
            status.setAttribute('aria-live', 'polite');
            status.hidden = true;
            pop.append(status);

            document.documentElement.appendChild(host);
            this.host = host;
            this.place(pop, x, y);
        },

        item(label, onClick) {
            const b = document.createElement('button');
            b.className = 'item';
            b.setAttribute('role', 'menuitem');
            b.textContent = label;
            b.addEventListener('click', onClick);
            return b;
        },

        /**
         * 左上角放在鼠标处；右边 / 下边放不下就翻到鼠标的另一侧，翻过去还放不下就贴着视口边。
         * 只能先插进文档再量尺寸 —— 菜单项数量随启用的引擎变，高度没法预先算。
         */
        place(pop, x, y) {
            const m = CONFIG.menuMargin;
            const vw = document.documentElement.clientWidth;
            const vh = document.documentElement.clientHeight;
            const { width: w, height: h } = pop.getBoundingClientRect();
            let left = x;
            let top = y;
            if (left + w > vw - m) {
                left = x - w;
                pop.dataset.flipX = '1';
            }
            if (top + h > vh - m) {
                top = y - h;
                pop.dataset.flipY = '1';
            }
            pop.style.left = Math.max(m, Math.min(left, vw - w - m)) + 'px';
            pop.style.top = Math.max(m, Math.min(top, vh - h - m)) + 'px';
        },

        /** 菜单底部的状态行。出错时菜单不关，让用户看得到原因。 */
        setStatus(text, isError = false) {
            if (!this.host) return;
            const el = this.host.shadowRoot.querySelector('.status');
            el.hidden = !text;
            el.textContent = text || '';
            el.classList.toggle('error', isError);
            if (isError) console.warn(TAG, text);
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

    /** 鼠标最后的位置。按 S 时没有鼠标事件可用，只能靠这里记下的坐标找图。 */
    const pointer = { x: 0, y: 0, known: false };
    window.addEventListener('mousemove', (e) => {
        pointer.x = e.clientX;
        pointer.y = e.clientY;
        pointer.known = true;
    }, { capture: true, passive: true });

    /** 焦点在可输入的地方（穿透 shadow DOM 找真正的焦点元素）。 */
    function isEditable(el) {
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        if (!el || el.nodeType !== 1) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') return !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(el.type);
        return false;
    }

    /*
     * 捕获阶段：GitHub 的 S 是「聚焦搜索框」、不少阅读站的 S 是「下一页」，冒泡阶段轮到我们时
     * 页面已经处理过了。但只有鼠标下面确实有图才截下来，否则原样放给页面。
     */
    window.addEventListener('keydown', (e) => {
        if (Menu.isOpen() && e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            Menu.close();
            return;
        }
        if (!CONFIG.hoverKey || e.key.toLowerCase() !== CONFIG.hoverKey) return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.isComposing) return;
        if (!pointer.known || isEditable(document.activeElement)) return;
        const target = findImageAt(pointer.x, pointer.y);
        if (!target) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        Menu.open(target, pointer.x, pointer.y);
    }, true);

    /** 点菜单外面关闭。composedPath 里有宿主元素就是点在菜单里（shadow DOM 里的点击 target 被重定向成宿主）。 */
    window.addEventListener('pointerdown', (e) => {
        if (Menu.isOpen() && !e.composedPath().includes(Menu.host)) Menu.close();
    }, true);

    // 菜单是 fixed 定位在鼠标处的，页面一滚动它就和图片错开了
    window.addEventListener('scroll', () => Menu.close(), { capture: true, passive: true });
    window.addEventListener('resize', () => Menu.close());
    window.addEventListener('blur', () => Menu.close());

    console.log(TAG, '已加载');
})();
