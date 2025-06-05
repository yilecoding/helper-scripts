// ==UserScript==
// @name         划词翻译｜选中即译 · 中英自动互译
// @name:zh-CN   划词翻译｜选中即译 · 中英自动互译
// @name:en      Translate Selection | Select-to-Translate, Auto Chinese ⇄ English
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.06.05.8
// @description  选中文字后旁边浮出小图标，点一下就翻译；按住 Alt 选中或按 Alt+T 直接翻译。中文译成英文、其他语言译成中文。
// @description:zh-CN  选中文字后旁边浮出小图标，点一下就翻译；按住 Alt 选中或按 Alt+T 直接翻译。中文译成英文、其他语言译成中文。
// @description:en  Select text and a small icon pops up next to it — click to translate. Hold Alt while selecting, or press Alt+T, to translate instantly. Chinese is translated to English, everything else to Chinese.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setClipboard
// @connect      translate.googleapis.com
// @connect      api.mymemory.translated.net
// @license      CC BY-NC-SA
// @run-at       document-end
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/translate-selection/translate-selection.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/translate-selection/translate-selection.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「划词翻译」即可只看本脚本的日志。 */
    const TAG = '[划词翻译]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        iconSize: 24,        // 浮动图标边长（px）
        iconOffset: 6,       // 图标离选区末端的距离（px）
        minLength: 1,        // 选中少于这么多字（去掉首尾空白后）不出图标
        directModifier: 'altKey',   // 按住它选中直接翻译、不出图标。可改 'ctrlKey' / 'shiftKey' / 'metaKey'，'' 关闭
        /*
         * 快捷键：翻译当前选区。按物理键位 e.code 匹配而不是 e.key ——
         * macOS 上 Option+T 的 e.key 是「†」，按 e.key 永远匹配不上。
         */
        hotkey: 'Alt+KeyT',

        targetLang: 'zh-CN',    // 非中文译成什么
        chineseTarget: 'en',    // 中文译成什么（只在 targetLang 本身是中文时生效）
        cardWidth: 340,      // 结果卡片宽度（px）
        sourcePreview: 80,   // 卡片顶部回显原文，超过这么多字截断
        dictTerms: 6,        // 选中单词时每个词性最多列几个释义

        timeoutMs: 8000,     // 单个接口超时，超时就换下一个
        maxLength: 5000,     // 选区超过这么多字只翻译前面这些，并在卡片里提示
        cacheSize: 100,      // 内存 LRU 缓存条数，同一段文字 + 同一目标语言不重复请求
        closeScrollDistance: 400,   // 卡片打开后页面滚动超过这么多（px）就自动关掉

        /** 卡片里「切换目标语言」下拉的选项。 */
        languages: [
            ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
            ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['ru', 'Русский'],
        ],
    };

    /*
     * CONFIG 的任何一项都能被 GM 存储里的 settings 覆盖（菜单里改的设置也存在这里），
     * 改脚本源码会在自动更新时被覆盖，存储里的不会。
     */
    const S = Object.assign({}, CONFIG, GM_getValue('settings', {}));

    // =========================================================================
    // 宿主节点：所有 UI 都挂在一个 shadow root 里，页面样式进不来、我们的也出不去
    // =========================================================================

    const UI = (() => {
        let host = null;
        let root = null;

        const CSS = `
            :host { all: initial; }
            .icon, .card {
                --bg: #fff; --fg: #1f2937; --muted: #6b7280; --faint: #9ca3af; --line: #e5e7eb;
                --accent: #2563eb; --accent-hover: #1d4ed8; --warn: #b45309; --err: #dc2626; --btn: #f3f4f6;
            }
            @media (prefers-color-scheme: dark) {
                .icon, .card {
                    --bg: #1f2937; --fg: #e5e7eb; --muted: #9ca3af; --faint: #6b7280; --line: #374151;
                    --accent: #60a5fa; --accent-hover: #93c5fd; --warn: #fbbf24; --err: #f87171; --btn: #374151;
                }
            }
            .icon {
                position: absolute; box-sizing: border-box;
                display: flex; align-items: center; justify-content: center;
                border-radius: 50%; cursor: pointer; user-select: none;
                font: 600 13px/1 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
                color: #fff; background: #2563eb;
                box-shadow: 0 2px 6px rgba(0, 0, 0, .25);
            }
            .icon:hover { background: #1d4ed8; }

            .card {
                position: absolute; box-sizing: border-box; padding: 10px 12px;
                font: 14px/1.55 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
                color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
                text-align: left; white-space: normal; word-break: break-word;
            }
            .src { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
            .dst { font-size: 15px; white-space: pre-wrap; max-height: 320px; overflow: auto; }
            .dict { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--line); font-size: 13px; }
            .dict .row { margin: 2px 0; }
            .dict .pos { display: inline-block; min-width: 3.2em; color: var(--accent); font-style: italic; }
            .note { margin-top: 6px; color: var(--warn); font-size: 12px; }
            .loading { color: var(--muted); }
            .error { color: var(--err); }
            .error button {
                margin-left: 8px; font: inherit; color: var(--accent); background: none;
                border: 0; padding: 0; cursor: pointer; text-decoration: underline;
            }
            .bar { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
            .bar button, .bar select {
                font-family: inherit; font-size: 12px; line-height: 1.6; color: var(--fg); background: var(--btn);
                border: 1px solid var(--line); border-radius: 4px; padding: 1px 8px; cursor: pointer;
            }
            .bar button:hover { border-color: var(--accent); }
            .meta { margin-left: auto; color: var(--faint); font-size: 11px; white-space: nowrap; }
        `;

        function ensure() {
            // 页面（尤其 SPA）可能整块替换 body，所以挂在 <html> 下，并且每次用前检查还在不在
            if (host && host.isConnected) return root;
            host = document.createElement('translate-selection-host');
            host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;';
            root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = CSS;
            root.appendChild(style);
            document.documentElement.appendChild(host);
            return root;
        }

        /** 事件是不是发生在我们自己的 UI 上（shadow DOM 里的事件冒泡到 document 时 target 被重定向成 host）。 */
        function owns(e) {
            return !!host && e.composedPath().includes(host);
        }

        return { ensure, owns };
    })();

    // =========================================================================
    // 读取选区
    // =========================================================================

    /** 支持 selectionStart/End 的 input 类型。email/number 读 selectionStart 会直接抛异常。 */
    const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'tel', ''];

    /** document.activeElement 只到 shadow host 为止，输入框在 Web Component 里时要一层层钻进去。 */
    function deepActiveElement() {
        let a = document.activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        return a;
    }

    function isTextField(el) {
        if (!el) return false;
        if (el.tagName === 'TEXTAREA') return true;
        return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.includes((el.getAttribute('type') || '').toLowerCase());
    }

    /**
     * 当前选区 → { text, anchor: {x, y, top} }，坐标是文档坐标（含滚动）。
     * 没有有效选区返回 null。
     *
     * input/textarea 里的选区 window.getSelection() 靠不住：Chrome 下 toString() 倒是能返回
     * 选中的字，但 isCollapsed 是 true、Range 没有任何 rect（实测），密码框还会返回「•••••」。
     * 所以输入框单独走 selectionStart/End 取文本，位置退而用输入框本身；密码框不处理。
     */
    function readSelection(mouse) {
        const sx = window.scrollX;
        const sy = window.scrollY;
        const active = deepActiveElement();

        if (isTextField(active)) {
            const { selectionStart: s, selectionEnd: e } = active;
            if (s != null && e != null && e > s) {
                const text = active.value.slice(s, e);
                if (text.trim().length < S.minLength) return null;
                const r = active.getBoundingClientRect();
                // 横向尽量跟着鼠标，但不能跑出输入框
                const x = mouse ? Math.min(Math.max(mouse.clientX, r.left), r.right) : r.right;
                return { text, anchor: { x: x + sx, y: r.bottom + sy, top: r.top + sy } };
            }
        }

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
        const text = sel.toString();
        if (text.trim().length < S.minLength) return null;

        const range = sel.getRangeAt(0);
        // 三击选整段时 Range 的终点落在下一个块的开头，最后一个 rect 宽度为 0，跳过这种
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        if (!rects.length) {
            if (!mouse) return null;
            return { text, anchor: { x: mouse.clientX + sx, y: mouse.clientY + sy, top: mouse.clientY + sy } };
        }
        const last = rects[rects.length - 1];
        return { text, anchor: { x: last.right + sx, y: last.bottom + sy, top: rects[0].top + sy } };
    }

    // =========================================================================
    // 浮动图标
    // =========================================================================

    const Icon = (() => {
        let el = null;
        let pending = null;   // 出图标那一刻的选区快照；点图标时页面选区可能已经变了

        function show(info) {
            const root = UI.ensure();
            if (!el) {
                el = document.createElement('div');
                el.className = 'icon';
                el.textContent = '译';
                el.title = '翻译选中文字';
                // mousedown 默认行为会清掉页面选区，拦住它
                el.addEventListener('mousedown', (e) => e.preventDefault());
                el.addEventListener('click', () => {
                    const info = pending;
                    hide();
                    if (info) onTrigger(info);
                });
            }
            if (!el.isConnected) root.appendChild(el);
            pending = info;

            const size = S.iconSize;
            const maxX = window.scrollX + document.documentElement.clientWidth - size - 2;
            const x = Math.min(info.anchor.x + S.iconOffset, maxX);
            const y = info.anchor.y + S.iconOffset;
            Object.assign(el.style, {
                left: `${x}px`, top: `${y}px`, width: `${size}px`, height: `${size}px`, display: 'flex',
            });
        }

        function hide() {
            pending = null;
            if (el) el.style.display = 'none';
        }

        let onTrigger = () => {};
        return { show, hide, onClick: (fn) => { onTrigger = fn; } };
    })();


    // =========================================================================
    // 翻译方向
    // =========================================================================

    /**
     * 文本是不是以中文为主。
     *
     * 不能按「字符」比：拉丁字母一个词五六个字母，「我们用 React 和 TypeScript 写前端」
     * 汉字 7 个、字母 15 个，按字符数会判成英文、再被「译成中文」原样返回。
     * 所以汉字按字数、拉丁/西里尔按词数比，大致是同一量级的「语义单位」。
     * 有假名就是日文（日文里的汉字也是 Han），按非中文处理。
     */
    function isMostlyChinese(text) {
        const han = (text.match(/\p{Script=Han}/gu) || []).length;
        if (!han) return false;
        const kana = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
        const hangul = (text.match(/\p{Script=Hangul}/gu) || []).length;
        const words = (text.match(/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]+/gu) || []).length;
        return han >= kana + hangul + words;
    }

    function pickTarget(text) {
        const tl = S.targetLang;
        if (/^zh/i.test(tl) && isMostlyChinese(text)) return S.chineseTarget;
        return tl;
    }

    /**
     * 按 UTF-16 长度截断，但不切开代理对（emoji、生僻字）。
     * 留下半个代理对的话 encodeURIComponent 会直接抛 URIError，请求根本发不出去。
     */
    function cut(text, n) {
        if (text.length <= n) return text;
        const code = text.charCodeAt(n - 1);
        return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
    }

    // =========================================================================
    // 网络
    // =========================================================================

    /**
     * GM_xmlhttpRequest 的 Promise 包装（跨域必须走它，页面的 fetch 会被 CORS 拦）。
     *
     * 超时自己计时，不只依赖 GM 的 timeout/ontimeout：
     * 不同管理器对它的支持不一致，有的根本不触发 ontimeout，请求就永远挂着、卡片一直「翻译中」。
     */
    function request({ method = 'GET', url, data, headers }) {
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (fn, arg) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                fn(arg);
            };
            const req = GM_xmlhttpRequest({
                method, url, data, headers,
                timeout: S.timeoutMs,
                onload: (r) => {
                    if (r.status >= 200 && r.status < 300) finish(resolve, r.responseText);
                    else finish(reject, new Error(`HTTP ${r.status}`));
                },
                onerror: () => finish(reject, new Error('网络错误')),
                ontimeout: () => finish(reject, new Error('请求超时')),
            });
            const timer = setTimeout(() => {
                try { req && req.abort && req.abort(); } catch (e) { /* 已结束 */ }
                finish(reject, new Error('请求超时'));
            }, S.timeoutMs);
        });
    }

    // =========================================================================
    // 翻译接口
    // =========================================================================

    /**
     * Google 网页版用的免费接口（client=gtx）。返回是一个嵌套数组，不是 JSON 对象：
     *   [0] 分段译文：[[译文, 原文, …], …]，长文本会按句切成多段，要拼起来
     *   [1] 词典（dt=bd），只有选中的是单个词/短语时才有，否则是 null：
     *       [[词性, [释义, …], [[释义, [反查词, …], null, 权重], …], 原形, 词性编号], …]
     *       释义已按常用程度排好序，取前几个即可
     *   [2] 识别出的源语言
     */
    const Google = {
        name: 'Google 翻译',

        /*
         * 长文本改 POST：q 放在 URL 里，4000 个汉字编码后 3 万多字符，接口直接回 400（实测）。
         * 同一个地址 POST 表单 q=… 是能用的，其余参数照旧放在 URL 上。
         */
        maxGetLength: 1800,

        async translate(text, tl) {
            const base = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto'
                + `&tl=${encodeURIComponent(tl)}&dt=t&dt=bd`;
            const q = encodeURIComponent(text);
            const data = JSON.parse(await request(q.length <= this.maxGetLength
                ? { url: `${base}&q=${q}` }
                : {
                    method: 'POST',
                    url: base,
                    data: `q=${q}`,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                }));
            if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('返回格式无法识别');
            const translation = data[0].map((seg) => (seg && seg[0]) || '').join('');
            if (!translation) throw new Error('没有译文');
            const dict = (Array.isArray(data[1]) ? data[1] : [])
                .filter((e) => Array.isArray(e) && typeof e[0] === 'string' && Array.isArray(e[1]) && e[1].length)
                .map((e) => ({ pos: e[0], terms: e[1].slice(0, S.dictTerms) }));
            return { text: translation, dict, src: data[2] || '', tl, engine: this.name };
        },
    };

    /**
     * MyMemory，备用。两个坑：
     *   - 出错时 HTTP 状态照样是 200，错误码在 body 的 responseStatus（还是字符串 "403"），
     *     错误信息塞在 translatedText 里 —— 不检查就会把
     *     「QUERY LENGTH LIMIT EXCEEDED…」当成译文显示出来。
     *   - 单次最多 500 字，超了直接报上面那个错，所以先截断。
     */
    const MyMemory = {
        name: 'MyMemory',
        maxLength: 500,

        async translate(text, tl) {
            const truncated = text.length > this.maxLength;
            const q = cut(text, this.maxLength);
            // 不支持 auto，要写 autodetect；目标语言用 zh-CN 这种 RFC3066 写法即可
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}`
                + `&langpair=autodetect|${encodeURIComponent(tl)}`;
            const data = JSON.parse(await request({ url }));
            const status = Number(data && data.responseStatus);
            if (status !== 200) throw new Error((data && data.responseDetails) || `状态码 ${data && data.responseStatus}`);
            if (data.quotaFinished) throw new Error('今日免费额度已用完');
            const translation = data.responseData && data.responseData.translatedText;
            if (!translation) throw new Error('没有译文');
            return {
                text: translation,
                dict: [],
                src: data.responseData.detectedLanguage || '',
                tl,
                engine: this.name,
                note: truncated ? `备用接口单次最多 ${this.maxLength} 字，只译了前 ${this.maxLength} 字` : '',
            };
        },
    };

    const ENGINES = [Google, MyMemory];

    /** 按顺序试，前一个失败（网络错误 / 超时 / 格式不对）就换下一个；全挂了把每个的原因都报出来。 */
    async function translateUncached(text, tl) {
        const errors = [];
        for (const engine of ENGINES) {
            try {
                const result = await engine.translate(text, tl);
                if (errors.length) console.warn(TAG, '已降级到', engine.name, errors);
                return result;
            } catch (e) {
                errors.push(`${engine.name}：${e.message}`);
            }
        }
        throw new Error(errors.join('；'));
    }

    /** 最近最少使用淘汰。Map 的迭代顺序就是插入顺序，命中时删了重插就挪到了最新。 */
    const Cache = (() => {
        const map = new Map();
        return {
            get(key) {
                if (!map.has(key)) return undefined;
                const v = map.get(key);
                map.delete(key);
                map.set(key, v);
                return v;
            },
            set(key, v) {
                map.delete(key);
                map.set(key, v);
                while (map.size > S.cacheSize) map.delete(map.keys().next().value);
            },
            delete: (key) => map.delete(key),
        };
    })();

    /**
     * 带缓存的翻译。缓存的是 Promise 而不是结果：连点两次、或者结果还没回来又触发同一段，
     * 也只发一次请求。失败的要从缓存里删掉，否则同一段文字以后永远是那个失败。
     */
    function translate(text, tl) {
        const key = `${tl}\u0000${text}`;
        let p = Cache.get(key);
        if (!p) {
            p = translateUncached(text, tl);
            Cache.set(key, p);
            p.catch(() => Cache.delete(key));
        }
        return p;
    }

    // =========================================================================
    // 结果卡片
    // =========================================================================

    /** 接口返回的词性是英文全称（不带 hl 参数时），缩写成词典里常见的样子。 */
    const POS = {
        noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', pronoun: 'pron.',
        preposition: 'prep.', conjunction: 'conj.', interjection: 'int.', article: 'art.',
        abbreviation: 'abbr.', prefix: 'pref.', suffix: 'suf.', phrase: 'phr.',
        'auxiliary verb': 'aux.', numeral: 'num.', particle: 'part.',
    };

    /**
     * 朗读。voice 要自己挑：不指定的话浏览器用系统默认嗓音，
     * 中文系统念英文是一股「中文口音」，英文系统念中文干脆不出声。
     * getVoices() 首次调用常常是空数组（异步加载），空就只设 lang，交给浏览器兜底。
     */
    function speak(text, lang) {
        const synth = window.speechSynthesis;
        if (!synth) return false;
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        const voices = synth.getVoices() || [];
        const norm = (l) => (l || '').toLowerCase().replace('_', '-');
        const want = norm(lang);
        const base = want.split('-')[0];
        u.voice = voices.find((v) => norm(v.lang) === want)
            || voices.find((v) => norm(v.lang).split('-')[0] === base)
            || null;
        synth.speak(u);
        return true;
    }

    const Card = (() => {
        let el = null;
        let anchor = null;
        let openedAt = null;   // 打开时的滚动位置，滚出太远就关

        function h(tag, cls, text) {
            const n = document.createElement(tag);
            if (cls) n.className = cls;
            if (text != null) n.textContent = text;
            return n;
        }

        function preview(text) {
            const t = text.replace(/\s+/g, ' ').trim();
            return t.length > S.sourcePreview ? t.slice(0, S.sourcePreview) + '…' : t;
        }

        /**
         * 默认放在选区下方；下方放不下而上方放得下就翻到选区上方。
         * 卡片高度要等内容渲染后才知道，所以「翻译中」和出结果后各算一次。
         */
        function place() {
            const vw = document.documentElement.clientWidth;
            const vh = document.documentElement.clientHeight;
            const width = Math.min(S.cardWidth, vw - 16);
            el.style.width = `${width}px`;
            el.style.display = 'block';
            const minX = window.scrollX + 8;
            const maxX = window.scrollX + vw - width - 8;
            const x = Math.max(minX, Math.min(anchor.x - width / 2, maxX));

            const height = el.offsetHeight;
            const below = anchor.y + 8;
            const above = anchor.top - 8 - height;
            const fitsBelow = below + height <= window.scrollY + vh - 8;
            const fitsAbove = above >= window.scrollY + 8;
            const y = !fitsBelow && fitsAbove ? above : below;
            el.dataset.side = y === below ? 'below' : 'above';
            Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
        }

        function open(info) {
            const root = UI.ensure();
            if (!el) el = h('div', 'card');
            if (!el.isConnected) root.appendChild(el);
            if (info.text.length > S.maxLength) {
                info = { ...info, text: cut(info.text, S.maxLength), fullLength: info.text.length };
            }
            anchor = info.anchor;
            openedAt = { x: window.scrollX, y: window.scrollY };
            run(info, pickTarget(info.text));
        }

        async function run(info, tl) {
            const token = {};
            el.__token = token;   // 连续触发时只认最后一次的结果，旧请求晚到不能覆盖新卡片
            el.replaceChildren(h('div', 'src', preview(info.text)), h('div', 'dst loading', '翻译中…'));
            place();
            let result;
            try {
                result = await translate(info.text, tl);
            } catch (e) {
                if (el.__token !== token) return;
                console.warn(TAG, '翻译失败', e);
                const err = h('div', 'dst error', `翻译失败：${e.message}`);
                const retry = h('button', null, '重试');
                retry.addEventListener('click', () => run(info, tl));
                err.appendChild(retry);
                el.replaceChildren(h('div', 'src', preview(info.text)), err, toolbar(info, tl, null));
                place();
                return;
            }
            if (el.__token !== token) return;
            const parts = [h('div', 'src', preview(info.text)), h('div', 'dst', result.text)];
            if (result.dict && result.dict.length) {
                const dict = h('div', 'dict');
                for (const { pos, terms } of result.dict) {
                    const row = h('div', 'row');
                    row.append(h('span', 'pos', POS[pos] || pos), h('span', 'terms', terms.join('；')));
                    dict.appendChild(row);
                }
                parts.push(dict);
            }
            if (info.fullLength) parts.push(h('div', 'note', `选中了 ${info.fullLength} 字，只翻译了前 ${info.text.length} 字`));
            if (result.note) parts.push(h('div', 'note', result.note));
            parts.push(toolbar(info, tl, result));
            el.replaceChildren(...parts);
            place();
        }

        /** 底栏：复制 · 朗读 · 目标语言 · 来源。result 为 null（失败）时只留语言切换。 */
        function toolbar(info, tl, result) {
            const bar = h('div', 'bar');
            if (result) {
                const copy = h('button', 'copy', '复制');
                copy.title = '复制译文';
                copy.addEventListener('click', () => {
                    GM_setClipboard(result.text, 'text');
                    copy.textContent = '已复制';
                    setTimeout(() => { copy.textContent = '复制'; }, 1200);
                });
                const say = h('button', 'speak', '朗读');
                say.title = '朗读译文';
                say.addEventListener('click', () => {
                    if (!speak(result.text, result.tl)) say.textContent = '不支持朗读';
                });
                bar.append(copy, say);
            }

            const select = h('select', 'lang');
            select.title = '换一种目标语言重新翻译';
            const langs = S.languages.some(([code]) => code === tl) ? S.languages : [[tl, tl], ...S.languages];
            for (const [code, label] of langs) {
                const o = h('option', null, label);
                o.value = code;
                o.selected = code === tl;
                select.appendChild(o);
            }
            select.addEventListener('change', () => run(info, select.value));
            bar.appendChild(select);

            if (result) bar.appendChild(h('span', 'meta', `${result.engine} · ${result.src || 'auto'} → ${result.tl}`));
            return bar;
        }

        function close() {
            if (el) {
                el.__token = null;
                el.style.display = 'none';
            }
            if (window.speechSynthesis) window.speechSynthesis.cancel();
        }

        function isOpen() {
            return !!el && el.isConnected && el.style.display !== 'none';
        }

        function onScroll() {
            if (!isOpen() || !openedAt) return;
            const d = Math.max(Math.abs(window.scrollY - openedAt.y), Math.abs(window.scrollX - openedAt.x));
            if (d > S.closeScrollDistance) close();
        }

        return { open, close, isOpen, onScroll };
    })();

    // =========================================================================
    // 事件
    // =========================================================================

    function onMouseUp(e) {
        if (e.button !== 0 || UI.owns(e)) return;
        // mouseup 那一刻选区可能还没定下来（比如在已有选区里单击，是 mouseup 之后才清空），推迟一拍再读
        const mouse = { clientX: e.clientX, clientY: e.clientY };
        const direct = !!S.directModifier && e[S.directModifier];
        setTimeout(() => {
            const info = readSelection(mouse);
            if (!info) return Icon.hide();
            if (direct) {
                Icon.hide();
                Card.open(info);
            } else {
                Icon.show(info);
            }
        }, 0);
    }

    /** 'Alt+KeyT' → 判定函数。修饰键要求精确匹配，Ctrl+Alt+T 不算 Alt+T。 */
    function parseHotkey(spec) {
        if (!spec) return () => false;
        const parts = spec.split('+');
        const code = parts.pop();
        const mods = new Set(parts.map((p) => p.toLowerCase()));
        return (e) => e.code === code
            && e.altKey === mods.has('alt')
            && e.ctrlKey === mods.has('ctrl')
            && e.shiftKey === mods.has('shift')
            && e.metaKey === mods.has('meta');
    }

    const isHotkey = parseHotkey(S.hotkey);

    function onMouseDown(e) {
        if (UI.owns(e)) return;
        Icon.hide();
        Card.close();
    }

    function onKeyDown(e) {
        if (isHotkey(e)) {
            const info = readSelection(null);
            if (!info) return;
            // 在输入框里按 Alt+T，不拦的话 macOS 会顺手输入一个「†」
            e.preventDefault();
            e.stopPropagation();
            Icon.hide();
            Card.open(info);
            return;
        }
        if (e.key !== 'Escape') return;
        Icon.hide();
        if (Card.isOpen()) Card.close();
    }

    function boot() {
        Icon.onClick((info) => Card.open(info));
        document.addEventListener('mouseup', onMouseUp, true);
        document.addEventListener('mousedown', onMouseDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        // 不用捕获：只关心整页滚动，卡片里译文区自己的滚动不算
        window.addEventListener('scroll', Card.onScroll, { passive: true });
        console.log(TAG, '已加载');
    }

    boot();
})();
