// ==UserScript==
// @name         网页图片查看与批量下载
// @name:zh-CN   网页图片查看与批量下载
// @name:en      Image Gallery — View & Batch Download Page Images
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.05.27.9
// @description  收集当前网页里的所有图片，在全屏网格里浏览、放大查看，勾选后批量下载。快捷键 Alt+Shift+I 或脚本菜单打开。
// @description:zh-CN  收集当前网页里的所有图片，在全屏网格里浏览、放大查看，勾选后批量下载。快捷键 Alt+Shift+I 或脚本菜单打开。
// @description:en  Collect every image on the current page into a full-screen gallery: browse, zoom in, and batch download the ones you pick. Open with Alt+Shift+I or the userscript menu.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      *
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

        /*
         * 背景图要对每个元素读 getComputedStyle，元素数上万的页面（长评论区、无限滚动）
         * 会卡住一下。超过这个数就不再查背景图，<img> 和链接照常收集。
         */
        bgScanLimit: 8000,

        /** 宽或高小于这个值的算图标/占位图，不进画廊。 */
        minWidth: 100,
        minHeight: 100,
        probeConcurrency: 8,   // 同时预加载探测尺寸的图片数
        probeTimeout: 10000,   // 单张探测超时（毫秒），超时按加载失败处理

        /** 查看器缩放范围与每格滚轮的缩放倍率（触控板的细碎 delta 按比例折算）。 */
        minScale: 0.05,
        maxScale: 20,
        wheelZoomPerNotch: 1.2,

        downloadConcurrency: 3,   // 同时下载数。太多容易被图床限流，也会让浏览器的下载栏刷屏
        downloadTimeout: 60000,
        fallbackExt: 'jpg',       // 实在推不出扩展名时用它
        headTimeout: 8000,        // URL 看不出扩展名时发 HEAD 问 content-type 的超时
    };

    /** 链接直接指向图片文件的判据（按 pathname 的扩展名，不看 query）。 */
    const IMG_EXT_RE = /\.(jpe?g|jfif|pjpeg|png|apng|gif|webp|avif|bmp|svg|ico|tiff?|heic|heif)$/i;

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
     *
     * 不能简单按「逗号 + 空白」切：压缩过的 HTML 里逗号后面常常没有空格（a.jpg 1x,b.jpg 2x），
     * 那样整串会被当成一个候选。按规范的做法来：URL 是一段不含空白的字符（可以带逗号，
     * Cloudinary 的 c_fill,w_800 就是），URL 末尾的逗号才是分隔符；描述符读到下一个括号外的逗号为止。
     */
    function parseSrcset(srcset) {
        const out = [];
        const s = srcset;
        const n = s.length;
        let i = 0;
        while (i < n) {
            while (i < n && /[\s,]/.test(s[i])) i++;
            if (i >= n) break;
            let start = i;
            while (i < n && !/\s/.test(s[i])) i++;
            let url = s.slice(start, i);
            let desc = '';
            if (/,$/.test(url)) {
                url = url.replace(/,+$/, '');
            } else {
                start = i;
                let depth = 0;
                while (i < n && !(s[i] === ',' && depth <= 0)) {
                    if (s[i] === '(') depth++;
                    else if (s[i] === ')') depth--;
                    i++;
                }
                desc = s.slice(start, i).trim();
            }
            if (!url) continue;
            const m = /(?:^|\s)([\d.]+)([wx])(?:\s|$)/i.exec(desc);
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

    function isImageLink(href) {
        const url = normalizeUrl(href);
        if (!url) return false;
        if (url.startsWith('data:')) return /^data:image\//i.test(url);
        try {
            return IMG_EXT_RE.test(new URL(url).pathname);
        } catch (e) {
            return false;
        }
    }

    /** 从 background-image 的计算值里抠出所有 url(...)，渐变之类的直接忽略。 */
    function backgroundUrls(value) {
        const out = [];
        if (!value || value === 'none') return out;
        const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
        let m;
        while ((m = re.exec(value))) out.push(m[2]);
        return out;
    }

    /**
     * 「可见」= 有布局盒子、不是 visibility:hidden、不在 display:none 的祖先下。
     * 只对已经确认有背景图的元素调用 —— 读布局比读样式贵，先用 backgroundImage 筛掉绝大多数元素。
     */
    function isVisible(el, cs) {
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        if (el.checkVisibility && !el.checkVisibility()) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    /**
     * 一次遍历收齐三类来源：<img>、指向图片的 <a href>、可见元素的 CSS 背景图。
     * 遇到 open shadow root 就排进队列接着扫（closed 的从外面拿不到，没办法）。
     * 自己的浮层整棵跳过，不然画廊里的缩略图会被当成页面图片再收一遍。
     */
    function collect() {
        const seen = new Set();
        const items = [];
        const add = (raw, source, el) => {
            const url = normalizeUrl(raw);
            if (!url || seen.has(url)) return;
            seen.add(url);
            items.push({ url, source, el });
        };

        let bgBudget = CONFIG.bgScanLimit;
        const roots = [document];
        while (roots.length) {
            const walker = document.createTreeWalker(roots.shift(), NodeFilter.SHOW_ELEMENT, {
                acceptNode: el => (el.id === HOST_ID ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
            });
            for (let el = walker.nextNode(); el; el = walker.nextNode()) {
                if (el.shadowRoot) roots.push(el.shadowRoot);
                const tag = el.tagName;
                if (tag === 'IMG') {
                    add(pickImgUrl(el), 'img', el);
                } else if (tag === 'A') {
                    const href = el.getAttribute('href');
                    if (href && isImageLink(href)) add(href, 'link', el);
                }
                if (bgBudget-- > 0) {
                    const cs = getComputedStyle(el);
                    const urls = backgroundUrls(cs.backgroundImage);
                    if (urls.length && isVisible(el, cs)) for (const u of urls) add(u, 'background', el);
                }
            }
        }
        if (bgBudget < 0) console.warn(TAG, `元素超过 ${CONFIG.bgScanLimit} 个，其余元素没有检查背景图`);
        return items;
    }

    // =========================================================================
    // 尺寸探测
    // =========================================================================

    /**
     * 页面上已经加载好的 <img> 直接读 naturalWidth，不再发请求。
     * 注意要核对 currentSrc：我们挑的可能是 srcset 里最大的那张，而浏览器实际加载的是小的，
     * 那时 naturalWidth 是小图的尺寸，不能拿来用。
     */
    function knownSize(item) {
        const el = item.el;
        if (!el || el.tagName !== 'IMG' || !el.complete || !el.naturalWidth) return null;
        if (normalizeUrl(el.currentSrc || el.src) !== item.url) return null;
        return { w: el.naturalWidth, h: el.naturalHeight };
    }

    /** 用一个游离的 Image 预加载，拿真实像素尺寸。失败/超时返回 null。 */
    function probeSize(url) {
        return new Promise((resolve) => {
            const img = new Image();
            let done = false;
            const finish = (v) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                img.onload = img.onerror = null;
                resolve(v);
            };
            const timer = setTimeout(() => {
                img.src = '';
                finish(null);
            }, CONFIG.probeTimeout);
            img.onload = () => finish({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => finish(null);
            img.decoding = 'async';
            img.src = url;
        });
    }

    /** 固定并发跑完 tasks（返回 Promise 的函数数组）。 */
    async function pool(tasks, concurrency) {
        let next = 0;
        const worker = async () => {
            while (next < tasks.length) await tasks[next++]();
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    }

    /**
     * 给每一项补上 w/h，并去掉加载失败的和小图。onProgress(done, total) 用来刷进度。
     * 加载成功但尺寸是 0（没写 width/height 的 SVG）的保留，标成尺寸未知，不参与小图过滤。
     */
    async function measure(items, onProgress) {
        let done = 0;
        const total = items.length;
        await pool(items.map(item => async () => {
            const size = knownSize(item) || (await probeSize(item.url));
            item.failed = !size;
            if (size) Object.assign(item, size);
            onProgress && onProgress(++done, total);
        }), CONFIG.probeConcurrency);
        return items.filter((it) => {
            if (it.failed) return false;
            if (!it.w || !it.h) return true;
            return it.w >= CONFIG.minWidth && it.h >= CONFIG.minHeight;
        });
    }

    function sizeLabel(it) {
        return it.w && it.h ? `${it.w}×${it.h}` : '尺寸未知';
    }

    // =========================================================================
    // 下载
    // =========================================================================

    const EXT_ALIAS = { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', pjpeg: 'jpg', pjp: 'jpg', tif: 'tiff', apng: 'png', 'svg+xml': 'svg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico' };
    const KNOWN_EXT = new Set(['jpg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tiff', 'heic', 'heif']);

    /** 归一成常见扩展名；不认识的返回 null（不能把 .php、.aspx 这类当扩展名用）。 */
    function normExt(ext) {
        if (!ext) return null;
        ext = String(ext).toLowerCase();
        ext = EXT_ALIAS[ext] || ext;
        return KNOWN_EXT.has(ext) ? ext : null;
    }

    function extFromMime(mime) {
        const m = /^\s*image\/([\w.+-]+)/i.exec(mime || '');
        return m ? normExt(m[1]) : null;
    }

    /** 图床常用来指定输出格式的 query 参数（微信公众号是 wx_fmt，imgix/Contentful 是 fm）。 */
    const FORMAT_PARAMS = ['format', 'fm', 'wx_fmt', 'ext', 'type'];

    /**
     * 从 URL 推扩展名：data: 看 MIME → 路径最后一段的扩展名 → query 里的格式参数。
     * 又拍云 / 阿里云 OSS 的处理参数挂在文件名后面（a.jpg!thumb、a.jpg@100w），先切掉。
     */
    function extFromUrl(url) {
        if (url.startsWith('data:')) return extFromMime(url.slice(5));
        let u;
        try {
            u = new URL(url);
        } catch (e) {
            return null;
        }
        let last = u.pathname.split('/').pop() || '';
        try {
            last = decodeURIComponent(last);
        } catch (e) { /* 坏的 % 编码，按原样用 */ }
        last = last.split(/[!@]/)[0];
        const m = /\.([a-z0-9]{2,5})$/i.exec(last);
        const fromPath = m && normExt(m[1]);
        if (fromPath) return fromPath;
        for (const p of FORMAT_PARAMS) {
            const v = normExt(u.searchParams.get(p));
            if (v) return v;
        }
        return null;
    }

    /** Windows / macOS / Linux 文件名都不允许或很麻烦的字符一律换成 _。 */
    function sanitizeName(s) {
        return String(s).replace(/[\\/:*?"<>|\x00-\x1f\x7f\s]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 80);
    }

    function siteName() {
        return sanitizeName(location.hostname.replace(/^www\./i, '')) || 'local';
    }

    /** 不带扩展名的文件名主干：<站点>_<序号>，序号按总数补零，方便按名字排序。 */
    function fileBase(site, index, total) {
        const width = Math.max(3, String(total).length);
        return `${site}_${String(index).padStart(width, '0')}`;
    }

    /**
     * URL 里看不出格式（/image/123、render.php?id=7）时，发一个 HEAD 读 content-type。
     * 走 GM_xmlhttpRequest 才能跨域读响应头（所以要 @connect *）；不支持 HEAD 的服务器、
     * 没授权、超时都返回 null，由调用方兜底。
     */
    function extFromHead(url) {
        if (!/^https?:/i.test(url)) return Promise.resolve(null);
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    method: 'HEAD',
                    url,
                    timeout: CONFIG.headTimeout,
                    onload: (r) => {
                        const m = /^content-type:\s*([^\r\n;]+)/im.exec((r && r.responseHeaders) || '');
                        resolve(r && r.status < 400 && m ? extFromMime(m[1]) : null);
                    },
                    onerror: () => resolve(null),
                    ontimeout: () => resolve(null),
                });
            } catch (e) {
                resolve(null);
            }
        });
    }

    /** 文件名定下来的 job 直接用；没定的先推扩展名（必要时问服务器）。 */
    async function resolveName(job) {
        if (job.name) return job.name;
        const ext = extFromUrl(job.url) || (await extFromHead(job.url)) || CONFIG.fallbackExt;
        job.name = `${job.base}.${ext}`;
        return job.name;
    }

    /** 把 GM_download 的回调包成 Promise。同步抛错（没授权、参数不对）也算失败。 */
    function gmDownload(url, name) {
        return new Promise((resolve, reject) => {
            try {
                GM_download({
                    url,
                    name,
                    saveAs: false,
                    timeout: CONFIG.downloadTimeout,
                    onload: () => resolve(),
                    onerror: e => reject(new Error((e && (e.error || e.details)) || '下载失败')),
                    ontimeout: () => reject(new Error('超时')),
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * 跑一批下载任务。job = { url, base, name, status, error }，status: pending → active → done / failed。
     * 重试时把失败的 job 原样再传进来，文件名保持不变。
     * onUpdate(stats) 每次状态变化都会调，stats.peak 是同时在下载的最大数。
     */
    async function runDownloads(jobs, onUpdate) {
        const stats = { total: jobs.length, done: 0, failed: 0, active: 0, peak: 0 };
        const tick = () => onUpdate && onUpdate({ ...stats });
        tick();
        await pool(jobs.map(job => async () => {
            job.status = 'active';
            stats.active++;
            stats.peak = Math.max(stats.peak, stats.active);
            tick();
            try {
                await gmDownload(job.url, await resolveName(job));
                job.status = 'done';
                job.error = '';
                stats.done++;
            } catch (e) {
                job.status = 'failed';
                job.error = (e && e.message) || String(e);
                stats.failed++;
                console.warn(TAG, '下载失败', job.url, job.error);
            }
            stats.active--;
            tick();
        }), CONFIG.downloadConcurrency);
        return stats;
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
        * { box-sizing: border-box; }
        .overlay {
            position: fixed; inset: 0; z-index: ${CONFIG.zIndex};
            display: flex; flex-direction: column;
            background: rgba(18, 18, 20, .96); color: #eee;
            font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        .bar {
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
            padding: 10px 16px; border-bottom: 1px solid #333;
        }
        .bar .title { font-weight: 600; }
        .bar .spacer { flex: 1; }
        .bar label { display: inline-flex; align-items: center; gap: 6px; color: #bbb; }
        .bar input[type=range] { width: 140px; }
        button, select {
            font: inherit; color: #eee; background: #2c2c30; border: 1px solid #444;
            border-radius: 6px; padding: 4px 12px; cursor: pointer;
        }
        button:hover { background: #3a3a40; }
        button:disabled { opacity: .45; cursor: default; }
        .status, .count { color: #aaa; }
        .body { flex: 1; overflow: auto; padding: 16px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
        .card {
            position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; cursor: zoom-in;
            border: 2px solid transparent;
            /* 棋盘格底，透明 PNG 看得出边界 */
            background: #2a2a2e repeating-conic-gradient(#333 0 25%, #2a2a2e 0 50%) 0 0 / 16px 16px;
        }
        .card.selected { border-color: #4a90d9; }
        .card img { width: 100%; height: 100%; object-fit: contain; display: block; }
        .card .check {
            position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; margin: 0; cursor: pointer;
            accent-color: #4a90d9;
        }
        .card .size {
            position: absolute; right: 6px; bottom: 6px; padding: 0 6px; border-radius: 4px;
            background: rgba(0, 0, 0, .65); font-size: 12px; pointer-events: none;
        }
        .empty { color: #888; text-align: center; padding: 60px 0; }
        .download { background: #2f6db5; border-color: #3b7fd0; }
        .download:hover { background: #3b7fd0; }
        .dl { padding: 6px 16px; border-bottom: 1px solid #333; color: #ccc; }
        .dl[hidden] { display: none; }
        .dl progress { width: 200px; vertical-align: middle; margin-right: 8px; }
        .dl .retry { margin-left: 12px; }
        .dl .retry[hidden] { display: none; }
        .failed { margin: 6px 0 0; padding: 0 0 0 18px; max-height: 120px; overflow: auto; color: #e88; }
        .failed li { word-break: break-all; }
        .failed a { color: #9cf; }

        .viewer { position: absolute; inset: 0; background: #0b0b0c; overflow: hidden; }
        .viewer[hidden] { display: none; }
        .stage { position: absolute; inset: 0; cursor: grab; touch-action: none; }
        .stage.dragging { cursor: grabbing; }
        /* 图片中心钉在舞台中心（负 margin 在 JS 里按原始尺寸设），transform-origin 也是中心，缩放旋转都绕它 */
        .view-img {
            position: absolute; left: 50%; top: 50%; max-width: none; max-height: none;
            user-select: none; -webkit-user-drag: none; pointer-events: none;
        }
        .view-bar {
            position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; gap: 10px;
            padding: 10px 16px; background: linear-gradient(rgba(0,0,0,.7), transparent);
        }
        .view-bar .info { flex: 1; color: #ccc; word-break: break-all; }
        .nav {
            position: absolute; top: 50%; transform: translateY(-50%); font-size: 28px; padding: 8px 14px;
            background: rgba(0,0,0,.4); border: none;
        }
        .nav.prev { left: 12px; }
        .nav.next { right: 12px; }
    `;

    const SORTS = {
        dom: { label: '页面顺序', cmp: (a, b) => a.order - b.order },
        'area-desc': { label: '面积从大到小', cmp: (a, b) => b.w * b.h - a.w * a.h || a.order - b.order },
        'area-asc': { label: '面积从小到大', cmp: (a, b) => a.w * a.h - b.w * b.h || a.order - b.order },
    };

    const Gallery = (() => {
        let host = null;
        let root = null;
        /** 每次打开 +1。探测是异步的，关掉又重开时旧的那轮结果要丢掉。 */
        let generation = 0;

        const state = {
            items: [],            // 探测、过滤后的全部图片
            selected: new Set(),  // 勾选的 url
            minSide: 0,           // 尺寸滑块：宽和高都 ≥ 它才显示
            sort: 'dom',
            downloading: false,
            jobs: [],             // 最近一轮的下载任务，失败的留着重试
        };

        const $ = sel => root.querySelector(sel);

        /*
         * 查看器状态。图片画在舞台中心，屏幕坐标 = 舞台中心 + (tx, ty) + 旋转(缩放(图内坐标))。
         * mode: 'fit' 适应窗口 / 'original' 原始尺寸 / 'free' 用户缩放过。
         */
        const view = { open: false, list: [], index: 0, scale: 1, rot: 0, tx: 0, ty: 0, mode: 'fit' };

        function isOpen() {
            return !!host && host.isConnected;
        }

        /** 当前显示的（过了尺寸滑块、排好序的）。全选 / 反选 / 下载都只作用于它们。 */
        function visibleItems() {
            return state.items
                .filter(it => !it.w || !it.h || Math.min(it.w, it.h) >= state.minSide)
                .sort(SORTS[state.sort].cmp);
        }

        function selectedVisible() {
            return visibleItems().filter(it => state.selected.has(it.url));
        }

        function renderCounts() {
            const shown = visibleItems();
            const picked = shown.filter(it => state.selected.has(it.url)).length;
            const ov = $('.overlay');
            ov.dataset.total = state.items.length;
            ov.dataset.shown = shown.length;
            ov.dataset.selected = picked;
            const btn = $('.download');
            btn.textContent = `下载选中（${picked}）`;
            btn.disabled = !picked || state.downloading;
            $('.count').textContent = shown.length === state.items.length
                ? `共 ${shown.length} 张，已选 ${picked} 张`
                : `显示 ${shown.length} / ${state.items.length} 张，已选 ${picked} 张`;
        }

        function renderGrid() {
            const grid = $('.grid');
            grid.textContent = '';
            const shown = visibleItems();
            if (!shown.length) {
                const p = document.createElement('div');
                p.className = 'empty';
                p.textContent = state.items.length ? '没有符合尺寸条件的图片' : '这个页面上没有找到图片';
                grid.appendChild(p);
            }
            for (const it of shown) {
                const card = document.createElement('div');
                card.className = 'card';
                card.dataset.url = it.url;
                card.dataset.w = it.w || 0;
                card.dataset.h = it.h || 0;
                const on = state.selected.has(it.url);
                card.classList.toggle('selected', on);

                const check = document.createElement('input');
                check.type = 'checkbox';
                check.className = 'check';
                check.checked = on;
                check.title = '勾选';

                const img = document.createElement('img');
                img.loading = 'lazy';
                img.decoding = 'async';
                img.alt = '';
                img.src = it.url;

                const size = document.createElement('span');
                size.className = 'size';
                size.textContent = sizeLabel(it);

                card.append(img, check, size);
                grid.appendChild(card);
            }
            renderCounts();
        }

        function setupSlider() {
            const slider = $('.min-side');
            const floor = Math.min(CONFIG.minWidth, CONFIG.minHeight);
            const sides = state.items.filter(it => it.w && it.h).map(it => Math.min(it.w, it.h));
            slider.min = floor;
            slider.max = Math.max(floor, ...sides);
            slider.step = 10;
            slider.value = state.minSide = floor;
            $('.min-side-value').textContent = `${floor}px`;
        }

        // ---------------------------------------------------------------------
        // 查看器
        // ---------------------------------------------------------------------

        function stageRect() {
            return $('.stage').getBoundingClientRect();
        }

        /** 适应窗口的缩放比：旋转 90° 时宽高互换；小图不放大。 */
        function fitScale(it) {
            const r = stageRect();
            const turned = view.rot % 180 !== 0;
            const w = (turned ? it.h : it.w) || r.width;
            const h = (turned ? it.w : it.h) || r.height;
            return Math.min(1, (r.width * 0.95) / w, (r.height * 0.95) / h);
        }

        function applyView() {
            const it = view.list[view.index];
            const img = $('.view-img');
            img.style.transform = `translate(${view.tx}px, ${view.ty}px) rotate(${view.rot}deg) scale(${view.scale})`;
            const v = $('.viewer');
            Object.assign(v.dataset, {
                index: view.index, url: it.url, mode: view.mode, rot: view.rot,
                scale: +view.scale.toFixed(4), tx: +view.tx.toFixed(2), ty: +view.ty.toFixed(2),
            });
            $('.view-bar .info').textContent =
                `${view.index + 1} / ${view.list.length} · ${sizeLabel(it)} · ${Math.round(view.scale * 100)}% · ${it.url}`;
        }

        function fit() {
            view.mode = 'fit';
            view.scale = fitScale(view.list[view.index]);
            view.tx = view.ty = 0;
            applyView();
        }

        function showAt(index) {
            const n = view.list.length;
            view.index = ((index % n) + n) % n;
            view.rot = 0;
            const it = view.list[view.index];
            const img = $('.view-img');
            img.src = it.url;
            // 尺寸未知（没写宽高的 SVG）就让浏览器按默认尺寸画，居中靠 JS 读到的 natural 尺寸补
            const w = it.w || img.naturalWidth || 300;
            const h = it.h || img.naturalHeight || 150;
            Object.assign(img.style, { width: `${w}px`, height: `${h}px`, marginLeft: `${-w / 2}px`, marginTop: `${-h / 2}px` });
            fit();
        }

        function openViewer(index) {
            view.list = visibleItems();
            if (!view.list.length) return;
            view.open = true;
            $('.viewer').hidden = false;
            showAt(index);
        }

        function closeViewer() {
            view.open = false;
            $('.viewer').hidden = true;
            $('.view-img').removeAttribute('src');
        }

        /** 以舞台坐标 (mx, my) 为中心缩放到 next：鼠标下的那个图内点缩放前后不动。 */
        function zoomAt(next, mx, my) {
            next = Math.min(CONFIG.maxScale, Math.max(CONFIG.minScale, next));
            const r = stageRect();
            const px = mx - r.width / 2;
            const py = my - r.height / 2;
            const k = next / view.scale;
            view.tx = px - (px - view.tx) * k;
            view.ty = py - (py - view.ty) * k;
            view.scale = next;
            view.mode = 'free';
            applyView();
        }

        function rotate(deg) {
            view.rot = (view.rot + deg + 360) % 360;
            if (view.mode === 'fit') fit();
            else applyView();
        }

        function bindViewer() {
            const stage = $('.stage');
            stage.addEventListener('wheel', (e) => {
                e.preventDefault();
                const r = stageRect();
                // deltaMode 1 是按行（Firefox 鼠标滚轮），折成像素再算
                const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
                const factor = Math.pow(CONFIG.wheelZoomPerNotch, -dy / 100);
                zoomAt(view.scale * factor, e.clientX - r.left, e.clientY - r.top);
            }, { passive: false });

            let drag = null;
            stage.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
                stage.setPointerCapture(e.pointerId);
                stage.classList.add('dragging');
            });
            stage.addEventListener('pointermove', (e) => {
                if (!drag) return;
                view.tx = drag.tx + e.clientX - drag.x;
                view.ty = drag.ty + e.clientY - drag.y;
                if (view.mode === 'fit') view.mode = 'free';
                applyView();
            });
            const endDrag = () => {
                drag = null;
                stage.classList.remove('dragging');
            };
            stage.addEventListener('pointerup', endDrag);
            stage.addEventListener('pointercancel', endDrag);

            stage.addEventListener('dblclick', (e) => {
                if (view.mode === 'original') return fit();
                const r = stageRect();
                zoomAt(1, e.clientX - r.left, e.clientY - r.top);
                view.mode = 'original';
                applyView();
            });

            $('.viewer .prev').addEventListener('click', () => showAt(view.index - 1));
            $('.viewer .next').addEventListener('click', () => showAt(view.index + 1));
            $('.viewer .rotate').addEventListener('click', () => rotate(90));
            $('.viewer .back').addEventListener('click', closeViewer);
        }

        function onViewerKey(e) {
            switch (e.key) {
                case 'Escape': closeViewer(); return true;
                case 'ArrowLeft': showAt(view.index - 1); return true;
                case 'ArrowRight': showAt(view.index + 1); return true;
                case 'r': case 'R': rotate(e.shiftKey ? -90 : 90); return true;
                case '0': fit(); return true;
                default: return false;
            }
        }

        function onResize() {
            if (view.open && view.mode === 'fit') fit();
        }

        // ---------------------------------------------------------------------
        // 下载
        // ---------------------------------------------------------------------

        function renderDownload(st) {
            const box = $('.dl');
            box.hidden = false;
            Object.assign(box.dataset, { total: st.total, done: st.done, failed: st.failed, peak: st.peak, active: st.active });
            const finished = st.done + st.failed;
            box.querySelector('progress').max = st.total || 1;
            box.querySelector('progress').value = finished;
            box.querySelector('.dl-text').textContent = finished < st.total
                ? `下载中 ${finished}/${st.total}${st.failed ? `，失败 ${st.failed}` : ''}`
                : `下载完成：成功 ${st.done}${st.failed ? `，失败 ${st.failed}` : ''}`;
        }

        function renderFailed() {
            const failed = state.jobs.filter(j => j.status === 'failed');
            const list = $('.failed');
            list.textContent = '';
            for (const j of failed) {
                const li = document.createElement('li');
                li.dataset.url = j.url;
                const a = document.createElement('a');
                a.href = j.url;
                a.target = '_blank';
                a.rel = 'noreferrer';
                a.textContent = j.name || j.url;
                li.append(a, `：${j.error}`);
                list.appendChild(li);
            }
            const retry = $('.retry');
            retry.hidden = !failed.length;
            retry.disabled = state.downloading;
            retry.textContent = `重试失败的（${failed.length}）`;
        }

        async function runJobs(jobs) {
            state.downloading = true;
            renderCounts();
            renderFailed();
            $('.dl').dataset.state = 'running';
            const gen = generation;
            const st = await runDownloads(jobs, (s) => {
                if (gen === generation && root) renderDownload(s);
            });
            if (gen !== generation || !root) return;
            state.downloading = false;
            $('.dl').dataset.state = 'finished';
            renderCounts();
            renderFailed();
            console.log(TAG, `下载结束：成功 ${st.done}，失败 ${st.failed}`);
        }

        function downloadSelected() {
            const picked = selectedVisible();
            if (!picked.length || state.downloading) return;
            const site = siteName();
            state.jobs = picked.map((it, i) => ({ url: it.url, base: fileBase(site, i + 1, picked.length), status: 'pending' }));
            return runJobs(state.jobs);
        }

        function retryFailed() {
            const failed = state.jobs.filter(j => j.status === 'failed');
            if (!failed.length || state.downloading) return;
            return runJobs(failed);
        }

        function setStatus(text, st) {
            $('.status').textContent = text;
            if (st) $('.overlay').dataset.state = st;
        }

        function setSelected(url, on) {
            on ? state.selected.add(url) : state.selected.delete(url);
        }

        function bind() {
            $('.close').addEventListener('click', close);
            $('.select-all').addEventListener('click', () => {
                for (const it of visibleItems()) state.selected.add(it.url);
                renderGrid();
            });
            $('.invert').addEventListener('click', () => {
                for (const it of visibleItems()) setSelected(it.url, !state.selected.has(it.url));
                renderGrid();
            });
            $('.min-side').addEventListener('input', (e) => {
                state.minSide = +e.target.value;
                $('.min-side-value').textContent = `${state.minSide}px`;
                renderGrid();
            });
            $('.sort').addEventListener('change', (e) => {
                state.sort = e.target.value;
                renderGrid();
            });
            $('.download').addEventListener('click', downloadSelected);
            $('.retry').addEventListener('click', retryFailed);
            $('.grid').addEventListener('click', (e) => {
                if (e.target.classList.contains('check')) return;
                const card = e.target.closest('.card');
                if (!card) return;
                openViewer(visibleItems().findIndex(it => it.url === card.dataset.url));
            });
            bindViewer();
            // 勾选框只改这一张卡片，不整格重绘（重绘会丢滚动位置，也会让懒加载的缩略图重新请求）
            $('.grid').addEventListener('change', (e) => {
                if (!e.target.classList.contains('check')) return;
                const card = e.target.closest('.card');
                setSelected(card.dataset.url, e.target.checked);
                card.classList.toggle('selected', e.target.checked);
                renderCounts();
            });
        }

        function open() {
            if (isOpen()) return;
            host = document.createElement('div');
            host.id = HOST_ID;
            root = host.attachShadow({ mode: 'open' });
            const sortOptions = Object.entries(SORTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
            root.innerHTML = `
                <style>${STYLE}</style>
                <div class="overlay" role="dialog" aria-label="图片画廊">
                    <div class="bar">
                        <span class="title">图片画廊</span>
                        <span class="count"></span>
                        <span class="status"></span>
                        <span class="spacer"></span>
                        <label>最小边 <input type="range" class="min-side"> <span class="min-side-value"></span></label>
                        <label>排序 <select class="sort">${sortOptions}</select></label>
                        <button type="button" class="select-all">全选</button>
                        <button type="button" class="invert">反选</button>
                        <button type="button" class="download" disabled>下载选中（0）</button>
                        <button type="button" class="close" title="关闭（Esc）">关闭</button>
                    </div>
                    <div class="dl" hidden>
                        <progress></progress><span class="dl-text"></span>
                        <button type="button" class="retry" hidden></button>
                        <ul class="failed"></ul>
                    </div>
                    <div class="body"><div class="grid"></div></div>
                    <div class="viewer" hidden>
                        <div class="stage"><img class="view-img" alt="" draggable="false"></div>
                        <div class="view-bar">
                            <span class="info"></span>
                            <button type="button" class="rotate" title="旋转（R）">旋转</button>
                            <button type="button" class="back" title="返回网格（Esc）">返回</button>
                        </div>
                        <button type="button" class="nav prev" title="上一张（←）">‹</button>
                        <button type="button" class="nav next" title="下一张（→）">›</button>
                    </div>
                </div>`;
            bind();
            document.documentElement.appendChild(host);
            window.addEventListener('resize', onResize);
            scan();
        }

        async function scan() {
            const gen = ++generation;
            Object.assign(state, { items: [], selected: new Set(), minSide: 0, sort: 'dom', downloading: false, jobs: [] });
            const found = collect();
            found.forEach((it, i) => { it.order = i; });
            console.log(TAG, `收集到 ${found.length} 个候选地址`);
            setStatus(`探测尺寸 0/${found.length}…`, 'scanning');
            const items = await measure(found, (done, total) => {
                if (gen === generation && root) setStatus(`探测尺寸 ${done}/${total}…`);
            });
            if (gen !== generation || !root) return;
            console.log(TAG, `过滤后剩 ${items.length} 张（去掉小图 / 加载失败 ${found.length - items.length} 个）`);
            state.items = items;
            setupSlider();
            setStatus('', 'ready');
            renderGrid();
        }

        function close() {
            generation++;
            view.open = false;
            window.removeEventListener('resize', onResize);
            if (host) host.remove();
            host = null;
            root = null;
        }

        function toggle() {
            isOpen() ? close() : open();
        }

        /** 浮层打开时由它处理按键；返回 true 表示已处理。 */
        function onKey(e) {
            if (view.open) return onViewerKey(e);
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
