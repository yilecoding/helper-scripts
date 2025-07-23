// ==UserScript==
// @name         表单草稿自动保存|评论/工单/帖子写到一半不怕丢
// @name:zh-CN   表单草稿自动保存|评论/工单/帖子写到一半不怕丢
// @name:en      Form Saver — auto-save drafts of what you type, restore after crash/close
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.07.23.10
// @description  在任意网页自动保存输入框/文本框/下拉框/富文本的草稿，误关标签、页面崩溃、提交失败跳走后回来，角落提示一键恢复。不保存密码、卡号、验证码等敏感字段；草稿 7 天过期。
// @description:zh-CN  在任意网页自动保存输入框/文本框/下拉框/富文本的草稿，误关标签、页面崩溃、提交失败跳走后回来，角落提示一键恢复。不保存密码、卡号、验证码等敏感字段；草稿 7 天过期。
// @description:en  Auto-saves drafts of inputs, textareas, selects and contenteditable editors on any page. Closed the tab, the page crashed or a submit failed? Come back and restore with one click. Never stores passwords, card numbers or one-time codes; drafts expire after 7 days.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @license      CC BY-NC-SA
// @run-at       document-end
// @noframes
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/form-saver/form-saver.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/form-saver/form-saver.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「草稿保存」只看本脚本。 */
    const TAG = '[草稿保存]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        /*
         * 页面键默认只用 origin + pathname，不带 query。
         * 多数站点 query 是跟踪参数（utm_*、from=…），带上会让同一个页面的草稿四分五裂；
         * 但 /viewtopic.php?t=123 这类站点 query 才是「哪一页」。
         * 这里列的 host 默认带 query；其余站点可在菜单里按站点切换。
         */
        queryHosts: [],
        /** 带 query 时丢掉的跟踪参数。末尾 * 表示前缀匹配，其余精确匹配（from 不能吞掉 fromDate）。 */
        trackingParams: ['utm_*', 'spm', 'from', 'fbclid', 'gclid', 'ref', '_t', 'timestamp'],

        debounceMs: 800,         // 停止输入多久后落盘
        maxValueLength: 20000,   // 单个字段超过这么长就不存（多半是粘贴的大段日志/代码，存了也撑爆配额）

        ttlDays: 7,              // 草稿最后一次编辑后保留几天
        maxPagesPerSite: 50,     // 单站点最多保留多少个页面的草稿，超了先丢最旧的
        maxBytesPerSite: 512 * 1024, // 单站点草稿总体积（JSON 字符数）上限
        /*
         * 提交后不立刻删草稿：提交失败（服务器报错、登录过期、校验不过跳回来）时内容还在。
         * 这段时间里回到原页面、字段是空的，提示会写明「刚提交过」；过了这段时间就删。
         * 页面内提交（不跳转）能看到结果：表单被清空 = 成功，立刻删；内容还在 = 失败，取消标记。
         */
        submitGraceMs: 60 * 60 * 1000,
        submitCheckMs: [1500, 4000],
    };

    // =========================================================================
    // 存储
    //
    // GM 存储是按脚本全局共享的（不是按站点），所以键里自带 origin：
    //   fs:d:<origin>   该站点所有页面的草稿 { [pageKey]: Draft }
    //   fs:settings     { disabled: { [origin]: 1 }, query: { [origin]: bool } }
    // 一个站点一个键，读写都是整块的；站点内条数/体积有上限，不会无限长大。
    // =========================================================================

    const Store = {
        bucketKey: (origin) => 'fs:d:' + origin,
        load(origin) {
            const v = GM_getValue(this.bucketKey(origin), null);
            return v && typeof v === 'object' ? v : {};
        },
        save(origin, bucket) {
            if (Object.keys(bucket).length) GM_setValue(this.bucketKey(origin), bucket);
            else GM_deleteValue(this.bucketKey(origin));
        },
        settings() {
            const s = GM_getValue('fs:settings', null) || {};
            s.disabled = s.disabled || {};
            s.query = s.query || {};
            return s;
        },
        saveSettings(s) { GM_setValue('fs:settings', s); },
    };

    // =========================================================================
    // 页面键
    // =========================================================================

    function useQuery(settings) {
        const own = settings.query[location.origin];
        if (typeof own === 'boolean') return own;
        return CONFIG.queryHosts.includes(location.hostname);
    }

    function isTrackingParam(name) {
        const k = name.toLowerCase();
        return CONFIG.trackingParams.some(p => (p.endsWith('*') ? k.startsWith(p.slice(0, -1)) : k === p));
    }

    function pageKey(settings) {
        let key = location.origin + location.pathname;
        if (useQuery(settings)) {
            const params = [...new URLSearchParams(location.search)]
                .filter(([k]) => !isTrackingParam(k))
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
            if (params.length) key += '?' + new URLSearchParams(params).toString();
        }
        // hash 路由（#/a/b、#!/a/b）是 SPA 的「路径」；普通锚点 #section 不是
        if (/^#!?\//.test(location.hash)) key += location.hash.split('?')[0];
        return key;
    }

    // =========================================================================
    // 字段：识别、读值、稳定标识
    // =========================================================================

    const FIELD_SELECTOR = 'input, textarea, select';
    const RICH_SELECTOR = '[contenteditable]:not([contenteditable="false"])';
    /** 按钮类 input 没有「内容」可存。 */
    const NON_DATA_TYPES = new Set(['button', 'submit', 'reset', 'image']);

    /** 可编辑区域只认最外层的那个（编辑宿主）；里面的段落、嵌套的 contenteditable 都是它的内容。 */
    function isRichHost(el) {
        return el instanceof HTMLElement && el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable);
    }

    function isField(el) {
        return el instanceof Element && (el.matches(FIELD_SELECTOR) || isRichHost(el));
    }

    function allFields() {
        return [...document.querySelectorAll(FIELD_SELECTOR + ',' + RICH_SELECTOR)].filter(isField);
    }

    /** text：value 字符串；check：checkbox 的 checked；radio：整组选中项的 value；multi：多选 select 的值数组；rich：清洗过的 HTML。 */
    function kindOf(el) {
        if (isRichHost(el)) return 'rich';
        if (el.type === 'checkbox') return 'check';
        if (el.type === 'radio') return 'radio';
        if (el.tagName === 'SELECT' && el.multiple) return 'multi';
        return 'text';
    }

    function radioGroup(el) {
        const scope = el.form || document;
        return [...scope.querySelectorAll('input[type="radio"]')].filter(r => r.name === el.name && (r.form || null) === (el.form || null));
    }

    function readValue(el) {
        switch (kindOf(el)) {
            case 'check': return el.checked;
            case 'radio': {
                const on = el.name ? radioGroup(el).find(r => r.checked) : (el.checked ? el : null);
                return on ? on.value : null;
            }
            case 'multi': return [...el.selectedOptions].map(o => o.value);
            case 'rich': return cleanHtml(el.innerHTML);
            default: return el.value;
        }
    }

    /** 富文本「没有内容」：没有可见文字，也没有图片之类的嵌入物（编辑器的空状态常是 <p><br></p>）。 */
    function richIsEmpty(el) {
        return !el.textContent.trim() && !el.querySelector('img, video, audio, iframe, hr, table');
    }

    /**
     * 富文本草稿按 HTML 存，恢复时还要塞回页面 —— 必须去掉一切可执行的东西。
     * 存的时候洗一遍，恢复的时候再洗一遍（存储可能被别的脚本改过）。
     * 用 <template> 解析：里面的 <img onerror> 不会被执行、图片也不会被加载。
     */
    function cleanHtml(html) {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        tpl.content.querySelectorAll('script, style, iframe, frame, object, embed, link, meta, base, form, input, textarea, select, button, svg, math, noscript, template')
            .forEach(n => n.remove());
        for (const n of tpl.content.querySelectorAll('*')) {
            for (const a of [...n.attributes]) {
                const name = a.name.toLowerCase();
                const val = a.value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
                if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'contenteditable'
                    || ((name === 'href' || name === 'src' || name === 'action' || name === 'formaction' || name.endsWith(':href'))
                        && /^(javascript|vbscript|data):/.test(val) && !/^data:image\/(png|gif|jpe?g|webp);/.test(val))) {
                    n.removeAttribute(a.name);
                }
            }
        }
        return tpl.innerHTML;
    }

    /** 页面给的初始值（按 DOM 里的 defaultValue/defaultChecked/defaultSelected 算）。 */
    function defaultValueOf(el) {
        switch (kindOf(el)) {
            case 'check': return el.defaultChecked;
            case 'radio': {
                const on = (el.name ? radioGroup(el) : [el]).find(r => r.defaultChecked);
                return on ? on.value : null;
            }
            case 'multi': return [...el.options].filter(o => o.defaultSelected).map(o => o.value);
            // 富文本没有 defaultValue 可回溯，只能「看见时」读当前内容；
            // 第一次见到就已经是 input 事件（内容已经变了），那就当它原来是空的，见 onEdit
            case 'rich': return readValue(el);
            default:
                if (el.tagName === 'SELECT') {
                    const o = el.options[defaultIndex(el)];
                    return o ? o.value : '';
                }
                return el.defaultValue;
        }
    }

    /**
     * 初始值要在「第一次碰到这个字段时」拍快照，不能每次现读 defaultValue。
     *
     * React 受控组件每次渲染都会把 defaultValue（input 的 value 属性、textarea 的 defaultValue）
     * 同步成当前值 —— 于是「当前值 === defaultValue」永远成立，按现读的判断
     * 每个 React 输入框都是「没动过」，一个字也存不下来。
     * focusin / 第一个 input 事件都在捕获阶段先到我们这里，那时 React 还没重新渲染。
     */
    const baseline = new WeakMap();

    function baselineOf(el) {
        const k = kindOf(el) === 'radio' && el.name ? radioGroup(el)[0] || el : el;
        if (!baseline.has(k)) baseline.set(k, defaultValueOf(el));
        return baseline.get(k);
    }

    /**
     * 「没被用户动过」：文本为空或等于初始值；勾选/下拉等于初始状态。
     * 这种状态既不值得存（存了也恢复不出新东西），也是恢复时「可以安全填入」的判据。
     */
    function isPristine(el) {
        if (kindOf(el) === 'rich' && richIsEmpty(el)) return true;
        const v = readValue(el);
        if (kindOf(el) === 'text' && el.tagName !== 'SELECT' && v === '') return true;
        return sameValue(v, baselineOf(el));
    }

    /** 单选 select 的初始选中项：最后一个带 selected 属性的，都没有就是第一个可选项。 */
    function defaultIndex(sel) {
        const opts = [...sel.options];
        for (let i = opts.length - 1; i >= 0; i--) if (opts[i].defaultSelected) return i;
        return opts.findIndex(o => !o.disabled);
    }

    function cssPath(el, root) {
        const parts = [];
        for (let n = el; n && n !== root && n.nodeType === 1; n = n.parentElement) {
            let i = 1;
            for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
            parts.unshift(n.tagName.toLowerCase() + ':' + i);
        }
        return parts.join('>');
    }

    /**
     * SPA 组件库生成的 id/name 每次渲染都不一样，拿来当键等于没存：刷新后对不上任何字段。
     * 认出来就降级到结构路径。宁可多降级：结构路径在同一个页面里同样稳定，只是对改版更敏感。
     */
    const RANDOM_ID = [
        /[:«»]/,                                    // React useId：:r1: / «r1»
        /^_r_[0-9a-z]+_$/i,                         // React 19.2 的 useId
        /\d{4,}/,                                   // 带长数字串：el-id-1024-17、ember1234、mui-38291
        /[0-9a-f]{8}-[0-9a-f]{4}-/i,                // uuid
        // 十六进制串：8 位以上、字母数字都有（a3f9c01b）
        /(^|[^0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}($|[^0-9a-z])/i,
        // nanoid 一类：8 位以上，同时有大写、小写、数字
        /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[\w-]{8,}$/,
        // 组件库自增 id 的前缀
        /^(ember|ext-gen|yui_|mui-|react-select-|el-id-|radix-|headlessui-|downshift-|rc_|rc-|vs\d|v-\d|input-\d|field-\d|uid-|id-\d)/i,
    ];

    function looksRandom(s) {
        return !!s && RANDOM_ID.some(re => re.test(s));
    }

    function stableId(el) {
        return el.id && !looksRandom(el.id) ? el.id : '';
    }

    function stableName(el) {
        const n = el.getAttribute('name');
        return n && !looksRandom(n) ? n : '';
    }

    function formIdOf(form) {
        if (stableId(form)) return 'form#' + form.id;
        if (stableName(form)) return 'form[' + form.getAttribute('name') + ']';
        return 'form:' + [...document.forms].indexOf(form);
    }

    /**
     * 字段所在的「锚」：有 form 用 form；没有就找最近的带稳定 id 的祖先（#app、#root 之类）。
     * 结构路径从锚开始算 —— 从 body 算的话，页面顶上插一条 cookie 横幅，所有路径就全错位了。
     */
    function anchorOf(el) {
        const form = el.form || (isRichHost(el) ? el.closest('form') : null);
        if (form) return { node: form, id: formIdOf(form) };
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            if (stableId(n)) return { node: n, id: '#' + n.id };
        }
        return { node: document.body, id: 'doc' };
    }

    /**
     * 字段的稳定标识：锚 + 字段自身。字段自身依次用 name、id、结构路径（随机的 name/id 跳过）。
     * 同名的多个非 radio 字段（tags[] 这种）用同名中的序号区分。
     */
    function fieldKey(el) {
        const anchor = anchorOf(el);
        const name = stableName(el);
        let own;
        if (name) {
            own = '[name=' + name + ']';
            if (el.type !== 'radio') {
                const same = [...anchor.node.querySelectorAll(FIELD_SELECTOR)].filter(f => f.getAttribute('name') === name && f.type !== 'radio');
                if (same.length > 1) own += ':' + same.indexOf(el);
            }
        } else if (stableId(el)) {
            own = '#' + el.id;
        } else {
            own = '@' + cssPath(el, anchor.node);
        }
        return anchor.id + ' ' + own;
    }

    function labelOf(el) {
        const txt = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-placeholder')
            || (el.labels && el.labels[0] && el.labels[0].textContent)
            || el.getAttribute('name') || el.id || el.tagName.toLowerCase();
        return txt.trim().replace(/\s+/g, ' ').slice(0, 40);
    }

    // =========================================================================
    // 隐私：哪些字段绝不落盘
    // =========================================================================

    const SECRET_TYPES = new Set(['password', 'hidden', 'file']);
    const SECRET_AUTOCOMPLETE = new Set(['one-time-code', 'new-password', 'current-password']);
    /**
     * 按 name/id/autocomplete/placeholder/aria-label/label 文本判断「疑似敏感」。
     * 宁可错杀：漏存一个字段只是少恢复一点，存下一个验证码/卡号就是泄露。
     * pass 不单独匹配（passenger、passport 不是密码）；pin/otp/ssn 要求左侧不是字母（spinner、footprint 不算）。
     */
    const SECRET_HINT = new RegExp([
        'passw', 'passwd', 'passcode', 'passphrase', 'pwd', '(^|[^a-z])pin([^a-z]|$)',
        'cvv', 'cvc', 'csc', 'security.?code', 'card.?(num|no)', 'cc.?(num|no)', 'credit.?card', 'expir',
        '(^|[^a-z])otp', 'one.?time', 'totp', '2fa', 'mfa', 'captcha', 'verif\\w*.?code', 'sms.?code', 'auth.?code',
        '(^|[^a-z])ssn([^a-z]|$)',
        '验证码', '校验码', '动态码', '密码', '口令', '卡号', '信用卡', '银行卡', '安全码', '有效期', '身份证',
    ].join('|'), 'i');

    /**
     * 「显示密码」按钮会把 type=password 改成 text —— 那一刻起按 type 就认不出来了。
     * 所以见过一次 password 的输入框和它所在的表单，永久记作敏感（登录/注册表单整个不存）。
     */
    const seenSecret = new WeakSet();

    function rememberPasswords(root) {
        for (const el of root.querySelectorAll('input[type="password"]')) {
            seenSecret.add(el);
            if (el.form) seenSecret.add(el.form);
        }
    }

    function hintText(el) {
        return [
            el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('aria-label'),
            el.labels && el.labels[0] && el.labels[0].textContent,
        ].filter(Boolean).join(' ');
    }

    function isSecretField(el) {
        if (seenSecret.has(el) || (el.form && seenSecret.has(el.form))) return true;
        if (el.tagName === 'INPUT' && SECRET_TYPES.has(el.type)) return true;
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
        if (ac.some(tok => tok.startsWith('cc-') || SECRET_AUTOCOMPLETE.has(tok))) return true;
        return SECRET_HINT.test(hintText(el));
    }

    /** 值本身像银行卡号（13~19 位数字、过 Luhn 校验）。字段名起得再无害也不存。 */
    function looksLikeCardNumber(value) {
        if (typeof value !== 'string') return false;
        const digits = value.replace(/[\s-]/g, '');
        if (!/^\d{13,19}$/.test(digits)) return false;
        let sum = 0;
        for (let i = 0; i < digits.length; i++) {
            let d = +digits[digits.length - 1 - i];
            if (i % 2) { d *= 2; if (d > 9) d -= 9; }
            sum += d;
        }
        return sum % 10 === 0;
    }

    /** 可存的字段。隐私过滤在这里收口。 */
    function shouldSave(el) {
        if (!isField(el)) return false;
        if (el.disabled || el.readOnly) return false;
        if (el.tagName === 'INPUT' && NON_DATA_TYPES.has(el.type)) return false;
        if (el.type === 'password') {
            seenSecret.add(el);
            if (el.form) seenSecret.add(el.form);
        }
        return !isSecretField(el);
    }

    // =========================================================================
    // 保存：事件委托 + 防抖
    // =========================================================================

    let settings;
    /** 本站停用后置 false：监听器还挂着（撤不干净也没必要），但什么都不做 */
    let active = false;
    /** 待落盘的字段 → 编辑时所在的页面键（SPA 里防抖期间路由可能已经变了） */
    const dirty = new Map();
    /** 这次页面生命周期里存过的字段 → { pk, fk }，用来发现「页面自己把它清空了」 */
    const tracked = new Map();
    let flushTimer = 0;

    function onEdit(e) {
        const el = e.target;
        if (!active || !shouldSave(el)) return;
        if (kindOf(el) === 'rich' && !baseline.has(el)) baseline.set(el, '');
        baselineOf(el);
        dirty.set(el, pageKey(settings));
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, CONFIG.debounceMs);
    }

    function flush() {
        clearTimeout(flushTimer);
        if (!dirty.size) return;
        const origin = location.origin;
        const bucket = Store.load(origin);
        const now = Date.now();
        for (const [el, pk] of dirty) {
            const fk = fieldKey(el);
            const draft = bucket[pk] || { fields: {} };
            const value = readValue(el);
            if (isPristine(el) || looksLikeCardNumber(kindOf(el) === 'rich' ? el.textContent.trim() : value)) {
                delete draft.fields[fk];
            } else if (typeof value === 'string' && value.length > CONFIG.maxValueLength) {
                console.warn(TAG, '字段太长，不保存', fk, value.length);
            } else {
                // 重新写入不带提交标记 s：提交之后又改了，就是一份新草稿
                draft.fields[fk] = { v: value, k: kindOf(el), l: labelOf(el), t: now };
                tracked.set(el, { pk, fk });
            }
            if (Object.keys(draft.fields).length) {
                draft.t = now;
                draft.title = document.title.slice(0, 80);
                bucket[pk] = draft;
            } else {
                delete bucket[pk];
            }
        }
        dirty.clear();
        enforceLimits(bucket);
        Store.save(origin, bucket);
        Menu.refresh();
    }

    // =========================================================================
    // 清理：过期、上限、提交
    // =========================================================================

    function jsonSize(v) {
        return JSON.stringify(v).length;
    }

    /** 先按页数、再按体积，从最久没编辑的页面开始丢。只剩一个页面还超体积，就丢它最旧的字段。 */
    function enforceLimits(bucket) {
        const pages = Object.keys(bucket).sort((a, b) => bucket[a].t - bucket[b].t);
        while (pages.length > CONFIG.maxPagesPerSite) delete bucket[pages.shift()];
        while (pages.length > 1 && jsonSize(bucket) > CONFIG.maxBytesPerSite) delete bucket[pages.shift()];
        if (pages.length === 1 && jsonSize(bucket) > CONFIG.maxBytesPerSite) {
            const d = bucket[pages[0]];
            const keys = Object.keys(d.fields).sort((a, b) => d.fields[a].t - d.fields[b].t);
            while (keys.length && jsonSize(bucket) > CONFIG.maxBytesPerSite) delete d.fields[keys.shift()];
            if (!keys.length) delete bucket[pages[0]];
        }
    }

    /** 过期字段、提交后过了宽限期的字段删掉；返回是否有改动。 */
    function sweepBucket(bucket, now) {
        const ttl = CONFIG.ttlDays * 86400000;
        let changed = false;
        for (const [pk, d] of Object.entries(bucket)) {
            for (const [fk, f] of Object.entries(d.fields || {})) {
                if (now - f.t > ttl || (f.s && now - f.s > CONFIG.submitGraceMs)) {
                    delete d.fields[fk];
                    changed = true;
                }
            }
            if (!d.fields || !Object.keys(d.fields).length) {
                delete bucket[pk];
                changed = true;
            }
        }
        return changed;
    }

    /** 启动时扫一遍所有站点：7 天的承诺不能只在「回到那个站点」时才兑现。 */
    function sweepAll() {
        const now = Date.now();
        for (const key of GM_listValues()) {
            if (!key.startsWith('fs:d:')) continue;
            const origin = key.slice(5);
            const bucket = Store.load(origin);
            if (sweepBucket(bucket, now)) Store.save(origin, bucket);
        }
    }

    function dropFields(pk, fks) {
        if (!fks.length) return;
        const bucket = Store.load(location.origin);
        const d = bucket[pk];
        if (!d) return;
        for (const fk of fks) delete d.fields[fk];
        if (!Object.keys(d.fields).length) delete bucket[pk];
        Store.save(location.origin, bucket);
        Menu.refresh();
    }

    function formFields(form) {
        return allFields().filter(el => (el.form || el.closest('form')) === form && shouldSave(el));
    }

    function onSubmit(e) {
        const form = e.target;
        if (!active || !(form instanceof HTMLFormElement)) return;
        flush();
        const pk = pageKey(settings);
        const els = formFields(form);
        const fks = els.map(fieldKey);
        const bucket = Store.load(location.origin);
        const d = bucket[pk];
        if (!d) return;
        const now = Date.now();
        const marked = fks.filter(fk => d.fields[fk]);
        for (const fk of marked) d.fields[fk].s = now;
        Store.save(location.origin, bucket);
        if (!marked.length) return;
        // 页面没跳走（AJAX 提交）才轮得到这两次检查
        for (const delay of CONFIG.submitCheckMs) {
            setTimeout(() => {
                const live = els.filter(el => el.isConnected);
                if (!live.length) return;
                if (live.every(isPristine)) {
                    dropFields(pk, marked);
                } else if (delay === CONFIG.submitCheckMs[CONFIG.submitCheckMs.length - 1]) {
                    updateDraft(pk, dd => { for (const fk of marked) if (dd.fields[fk]) delete dd.fields[fk].s; });
                }
            }, delay);
        }
    }

    /** 重置按钮：用户明确不要这些内容了。 */
    function onReset(e) {
        const form = e.target;
        if (!active || !(form instanceof HTMLFormElement)) return;
        // reset 事件在字段复位之前触发，等它复位完再看
        setTimeout(() => dropTracked(formFields(form)), 0);
    }

    /**
     * 存过的字段被页面自己清空了（没有 input 事件）—— 发送成功后清输入框是最常见的原因，
     * 不用 <form> 的 SPA 聊天框、评论框只能靠这个发现「已经发出去了」。
     */
    function dropTracked(els) {
        const byPage = new Map();
        for (const el of els) {
            const t = tracked.get(el);
            if (!t || dirty.has(el) || !isPristine(el)) continue;
            tracked.delete(el);
            if (!byPage.has(t.pk)) byPage.set(t.pk, []);
            byPage.get(t.pk).push(t.fk);
        }
        for (const [pk, fks] of byPage) dropFields(pk, fks);
    }

    function checkCleared() {
        for (const el of [...tracked.keys()]) if (!el.isConnected) tracked.delete(el);
        dropTracked([...tracked.keys()]);
    }

    // =========================================================================
    // 恢复
    // =========================================================================

    /** 当前页面上所有可存字段，按字段键索引。radio 整组共用一个键，取组里第一个。 */
    function fieldsByKey() {
        const map = new Map();
        for (const el of allFields()) {
            if (!shouldSave(el)) continue;
            const k = fieldKey(el);
            if (!map.has(k)) map.set(k, el);
        }
        return map;
    }

    /** 恢复只往「空」里填：文本必须是空串（页面预填的内容也算用户已有的），其余必须是初始状态。 */
    function isEmptyForRestore(el) {
        if (kindOf(el) === 'rich') return richIsEmpty(el);
        return kindOf(el) === 'text' && el.tagName !== 'SELECT' ? el.value === '' : isPristine(el);
    }

    function sameValue(a, b) {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    /** 草稿里能填进当前页面的字段：元素存在、当前为空、值确实不同。 */
    function restorable(draft) {
        if (!draft) return [];
        const els = fieldsByKey();
        const out = [];
        for (const [key, field] of Object.entries(draft.fields)) {
            const el = els.get(key);
            if (!el || !isEmptyForRestore(el) || sameValue(readValue(el), field.v)) continue;
            out.push({ key, el, field });
        }
        return out;
    }

    /**
     * 用原型上的原生 setter 写值，而不是 el.value = v。
     *
     * React 会在每个受控 input 实例上装一个 value 属性拦截器（inputValueTracking），
     * 记下「它认为的当前值」。input 事件到来时，React 拿 el.value 和这个记录比，
     * 相同就认为没变、不触发 onChange。直接 el.value = v 会走实例上的拦截器，
     * 把记录也改成 v —— 事件派发出去 React 判定「没变」，state 还是空，
     * 下一次渲染再把输入框改回空。原型 setter 绕过拦截器，记录停在旧值，事件才算数。
     */
    function setNative(el, prop, value) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
            : el.tagName === 'SELECT' ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, prop).set.call(el, value);
    }

    /** Vue 的 v-model 听 input（.lazy 听 change），React 听 input；两个都发。 */
    function fire(el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function applyValue(el, field) {
        switch (field.k) {
            case 'check':
                // click() 走浏览器的激活行为：改 checked 并按顺序派发 click/input/change。
                // React 的 checkbox onChange 挂在 click 上，只发 change 它收不到。
                if (el.checked !== field.v) el.click();
                return;
            case 'radio': {
                const target = (el.name ? radioGroup(el) : [el]).find(r => r.value === field.v);
                if (target && !target.checked) target.click();
                return;
            }
            case 'multi':
                for (const o of el.options) o.selected = field.v.includes(o.value);
                fire(el);
                return;
            case 'rich':
                applyRich(el, cleanHtml(field.v));
                return;
            default:
                setNative(el, 'value', field.v);
                fire(el);
        }
    }

    /**
     * 富文本先走 execCommand('insertHTML')：它像用户粘贴一样经过 beforeinput/input，
     * ProseMirror、Quill 这类自己维护文档模型的编辑器能跟着更新；直接改 innerHTML 它们看不见，
     * 下一次按键就把内容冲掉。execCommand 不可用或没生效，才退回 innerHTML + input 事件。
     */
    function applyRich(el, html) {
        const want = htmlText(html);
        try {
            el.focus();
            const sel = window.getSelection();
            sel.selectAllChildren(el);
            document.execCommand('insertHTML', false, html);
        } catch (e) { /* 走兜底 */ }
        if (el.textContent.trim() !== want) {
            el.innerHTML = html;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    function htmlText(html) {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        return tpl.content.textContent.trim();
    }

    function restoreDraft(draft) {
        const items = restorable(draft);
        for (const { el, field } of items) {
            try {
                applyValue(el, field);
            } catch (e) {
                console.warn(TAG, '恢复失败', field.l, e);
            }
        }
        return items.length;
    }

    function fmtAgo(ts) {
        const m = Math.floor((Date.now() - ts) / 60000);
        if (m < 1) return '刚刚';
        if (m < 60) return m + ' 分钟前';
        if (m < 24 * 60) return Math.floor(m / 60) + ' 小时前';
        return Math.floor(m / 1440) + ' 天前';
    }

    // =========================================================================
    // 界面：shadow DOM 隔离，页面样式进不来、我们的样式也出不去
    // =========================================================================

    const UI = (() => {
        let host = null;
        let box = null;
        let hideTimer = 0;
        let current = '';   // 正在显示的是哪种卡片（'restore:<pageKey>' / 'toast' …），空 = 没显示
        const CSS = `
            :host { all: initial; }
            .card { font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
                color: #1f2328; background: #fff; border: 1px solid #d0d7de; border-radius: 8px;
                box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 10px 12px; max-width: 360px;
                display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
            .msg { flex: 1 1 180px; }
            .muted { color: #656d76; }
            button { font: inherit; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa;
                color: inherit; padding: 3px 10px; cursor: pointer; }
            button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
            button:hover { filter: brightness(.96); }
            .panel { display: block; width: 360px; max-width: calc(100vw - 32px); }
            .panel h3 { font-size: 14px; margin: 0 0 8px; }
            .list { max-height: 50vh; overflow: auto; margin: 0 -4px; }
            .row { display: flex; gap: 8px; align-items: flex-start; padding: 6px 4px; border-top: 1px solid #eaeef2; }
            .row .info { flex: 1; min-width: 0; }
            .row .label { font-weight: 600; }
            .row .preview { color: #656d76; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .row button { padding: 1px 8px; font-size: 12px; }
            .foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; flex-wrap: wrap; }
            @media (prefers-color-scheme: dark) {
                .card { color: #e6edf3; background: #161b22; border-color: #30363d; }
                .muted, .row .preview { color: #8d96a0; }
                .row { border-color: #30363d; }
                button { background: #21262d; border-color: #30363d; }
            }
        `;

        function ensure() {
            if (host && host.isConnected) return;
            host = document.createElement('form-saver-ui');
            // 内联 !important：页面写 form-saver-ui { display: none } 也盖不过
            host.style.cssText = 'all:initial!important;position:fixed!important;right:16px!important;bottom:16px!important;'
                + 'z-index:2147483647!important;display:block!important;';
            const root = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = CSS;
            box = document.createElement('div');
            root.append(style, box);
            document.documentElement.appendChild(host);
        }

        function button(a) {
            const b = el('button', { textContent: a.label, className: a.primary ? 'primary' : '' });
            b.dataset.act = a.id;
            b.addEventListener('click', () => a.run());
            return b;
        }

        function el(tag, props, children) {
            const n = document.createElement(tag);
            Object.assign(n, props || {});
            for (const c of children || []) n.append(c);
            return n;
        }

        /** 只用 textContent 拼内容 —— 草稿是页面里来的文本，不能当 HTML 塞回去。 */
        function show(parts, actions, { autoHide = 0, tag = 'card' } = {}) {
            ensure();
            clearTimeout(hideTimer);
            current = tag;
            box.replaceChildren();
            const card = el('div', { className: 'card' });
            card.append(el('div', { className: 'msg' }, parts));
            for (const a of actions || []) card.append(button(a));
            box.append(card);
            if (autoHide) hideTimer = setTimeout(hide, autoHide);
        }

        function hide() {
            clearTimeout(hideTimer);
            current = '';
            if (box) box.replaceChildren();
        }

        function toast(text) {
            show([text], [], { autoHide: 3000, tag: 'toast' });
        }

        /** 列表面板：rows = [{ label, preview, meta, actions }]，footer = actions。 */
        function panel(title, rows, footer) {
            ensure();
            clearTimeout(hideTimer);
            current = 'panel';
            const list = el('div', { className: 'list' });
            for (const r of rows) {
                const info = el('div', { className: 'info' }, [
                    el('div', { className: 'label', textContent: r.label }),
                    el('div', { className: 'preview', textContent: r.preview, title: r.preview }),
                    el('div', { className: 'muted', textContent: r.meta }),
                ]);
                const row = el('div', { className: 'row' }, [info, ...r.actions.map(button)]);
                row.dataset.key = r.key;
                list.append(row);
            }
            box.replaceChildren(el('div', { className: 'card panel' }, [
                el('h3', { textContent: title }),
                rows.length ? list : el('div', { className: 'muted', textContent: '本页没有草稿' }),
                el('div', { className: 'foot' }, footer.map(button)),
            ]));
        }

        return { show, hide, toast, panel, el, current: () => current };
    })();

    // =========================================================================
    // 恢复提示
    // =========================================================================

    function loadDraft(pk) {
        return Store.load(location.origin)[pk];
    }

    function updateDraft(pk, fn) {
        const bucket = Store.load(location.origin);
        if (!bucket[pk]) return;
        fn(bucket[pk]);
        Store.save(location.origin, bucket);
    }

    /** 这次页面生命周期里用户已经点过恢复/忽略的页面键，不再打扰。 */
    const handled = new Set();
    let shownCount = 0;

    /**
     * 有可恢复的字段、且用户没对这份草稿点过「忽略」，就浮出提示。
     * SPA 里字段是陆续渲染出来的，所以 DOM 变化时会反复调用：数量变了就刷新提示，变成 0 就收起。
     */
    function checkRestore() {
        if (!active || UI.current() === 'panel') return;
        const pk = pageKey(settings);
        const tag = 'restore:' + pk;
        const draft = handled.has(pk) ? null : loadDraft(pk);
        const items = draft && !(draft.dismissedAt && draft.dismissedAt >= draft.t) ? restorable(draft) : [];
        const showing = UI.current() === tag;
        if (!items.length) {
            if (showing || UI.current().startsWith('restore:')) UI.hide();
            return;
        }
        if (showing && shownCount === items.length) return;
        shownCount = items.length;
        const submitted = items.every(it => it.field.s);
        const when = UI.el('span', { className: 'muted', textContent: '（' + fmtAgo(draft.t) + '）' });
        UI.show(
            submitted
                ? ['检测到 ' + items.length + ' 个字段刚提交过的内容', when, '，如果提交没成功，可以恢复']
                : ['检测到 ' + items.length + ' 个字段的草稿', when],
            [
                {
                    id: 'restore', label: '恢复', primary: true, run() {
                        handled.add(pk);
                        const n = restoreDraft(loadDraft(pk));
                        UI.toast(n ? '已恢复 ' + n + ' 个字段' : '没有可恢复的空字段（不会覆盖已填写的内容）');
                    },
                },
                {
                    id: 'dismiss', label: '忽略', run() {
                        handled.add(pk);
                        if (submitted) {
                            // 提交过、又说不要：多半是成功了，删掉
                            dropFields(pk, items.map(it => it.key));
                        } else {
                            // 不删草稿：误点了还能从菜单里找回；只是这份草稿不再自动提示
                            updateDraft(pk, d => { d.dismissedAt = Date.now(); });
                        }
                        UI.hide();
                    },
                },
            ],
            { tag },
        );
    }

    /**
     * SPA：字段晚于脚本渲染、路由换了页面键，都靠 DOM 变化来发现（路由切换必然伴随 DOM 变化，
     * 不用去改 history.pushState）。防抖后统一处理。
     */
    /** 富文本的初始内容趁「还没人动」时拍下来（启动时、DOM 变化后）。 */
    function snapshotRich() {
        for (const el of document.querySelectorAll(RICH_SELECTOR)) if (isRichHost(el)) baselineOf(el);
    }

    function watchDom() {
        let timer = 0;
        let lastKey = pageKey(settings);
        const onChange = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (!active) return;
                rememberPasswords(document);
                snapshotRich();
                checkCleared();
                const pk = pageKey(settings);
                if (pk !== lastKey) {
                    lastKey = pk;
                    flush();
                    Menu.refresh();
                }
                checkRestore();
            }, 300);
        };
        new MutationObserver(onChange).observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('popstate', onChange);
        window.addEventListener('hashchange', onChange);
    }

    // =========================================================================
    // 启动
    // =========================================================================

    // =========================================================================
    // 菜单
    // =========================================================================

    function previewOf(f) {
        switch (f.k) {
            case 'check': return f.v ? '已勾选' : '未勾选';
            case 'multi': return f.v.join('、') || '（全不选）';
            case 'rich': return htmlText(f.v);
            default: return String(f.v).replace(/\s+/g, ' ');
        }
    }

    function showPagePanel() {
        const pk = pageKey(settings);
        const draft = loadDraft(pk);
        const fields = draft ? Object.entries(draft.fields).sort((a, b) => b[1].t - a[1].t) : [];
        const els = fieldsByKey();
        const rows = fields.map(([key, f]) => ({
            key,
            label: f.l,
            preview: previewOf(f).slice(0, 200),
            meta: fmtAgo(f.t) + (f.s ? ' · 已提交过' : '') + (els.has(key) ? '' : ' · 当前页面上找不到这个字段'),
            actions: [
                {
                    id: 'restore-one', label: '恢复', run() {
                        const el = els.get(key);
                        if (!el || !el.isConnected) return UI.toast('当前页面上找不到这个字段');
                        if (!isEmptyForRestore(el)) return UI.toast('「' + f.l + '」已有内容，先清空再恢复');
                        applyValue(el, f);
                        showPagePanel();
                    },
                },
                { id: 'delete-one', label: '删除', run() { dropFields(pk, [key]); showPagePanel(); } },
            ],
        }));
        UI.panel('本页草稿（' + rows.length + '）', rows, [
            {
                id: 'restore-all', label: '全部恢复（只填空字段）', primary: true, run() {
                    handled.add(pk);
                    const n = restoreDraft(loadDraft(pk));
                    UI.toast(n ? '已恢复 ' + n + ' 个字段' : '没有可恢复的空字段');
                },
            },
            { id: 'clear-page', label: '清除本页草稿', run() { dropFields(pk, fields.map(([k]) => k)); handled.add(pk); UI.toast('已清除本页草稿'); } },
            { id: 'close', label: '关闭', run: () => UI.hide() },
        ]);
    }

    function toggleSite() {
        const origin = location.origin;
        if (settings.disabled[origin]) {
            delete settings.disabled[origin];
            Store.saveSettings(settings);
            start();
            UI.toast('已在本站启用草稿保存');
        } else {
            // 停用 = 不想让这个站点的输入被记下来，已有的也一并删掉
            active = false;
            clearTimeout(flushTimer);
            dirty.clear();
            tracked.clear();
            settings.disabled[origin] = 1;
            Store.saveSettings(settings);
            Store.save(origin, {});
            UI.toast('已在本站停用，并删除了本站的草稿');
        }
        Menu.refresh();
    }

    /**
     * 页面键是否带 query 是按站点存的。切换后旧键下的草稿不迁移 —— 迁移规则说不清
     * （一个不带 query 的键该分给哪个带 query 的键？），留着按 7 天过期。
     */
    function toggleQuery() {
        flush();
        const origin = location.origin;
        settings.query[origin] = !useQuery(settings);
        Store.saveSettings(settings);
        UI.toast(settings.query[origin] ? '本站页面按「路径 + 参数」区分草稿' : '本站页面只按路径区分草稿（忽略参数）');
        Menu.refresh();
        checkRestore();
    }

    function clearAll() {
        if (!window.confirm('删除所有网站上保存的全部表单草稿？')) return;
        for (const key of GM_listValues()) if (key.startsWith('fs:d:')) GM_deleteValue(key);
        tracked.clear();
        UI.toast('已清除全部草稿');
        Menu.refresh();
    }

    /** 菜单项的文字带状态（草稿数、开关），所以每次状态变化整组重新注册。 */
    const Menu = {
        ids: [],
        sig: '',
        refresh() {
            const disabled = !!settings.disabled[location.origin];
            const items = [];
            if (!disabled) {
                const draft = loadDraft(pageKey(settings));
                const n = draft ? Object.keys(draft.fields).length : 0;
                items.push(['本页草稿（' + n + '）', showPagePanel]);
                items.push([(useQuery(settings) ? '✓ ' : '') + '本站按 URL 参数区分页面', toggleQuery]);
            }
            items.push([disabled ? '在本站启用草稿保存' : '在本站停用草稿保存', toggleSite]);
            items.push(['清除全部草稿', clearAll]);
            const sig = items.map(([c]) => c).join('|');
            if (sig === this.sig) return; // 每次落盘都会调用，没变化就别重排菜单
            this.sig = sig;
            for (const id of this.ids) GM_unregisterMenuCommand(id);
            this.ids = items.map(([caption, fn]) => GM_registerMenuCommand(caption, fn));
        },
    };

    // =========================================================================
    // 启动
    // =========================================================================

    let started = false;

    function start() {
        active = true;
        if (started) {
            checkRestore();
            return;
        }
        started = true;
        rememberPasswords(document);
        snapshotRich();
        // 捕获阶段：页面自己 stopPropagation 也挡不住我们
        document.addEventListener('focusin', (e) => { if (active && shouldSave(e.target)) baselineOf(e.target); }, true);
        document.addEventListener('input', onEdit, true);
        document.addEventListener('change', onEdit, true);
        document.addEventListener('submit', onSubmit, true);
        document.addEventListener('reset', onReset, true);
        /*
         * 防抖期间刷新/关标签/跳走，最后那几个字还在 dirty 里没落盘 —— 恰恰是最想保住的那几个字。
         * pagehide 覆盖刷新、关闭、导航（也兼容 bfcache，不像 unload 会让页面进不了 bfcache）；
         * 手机上切后台后页面可能直接被杀、连 pagehide 都没有，所以 hidden 时也落一次。
         * GM_setValue 是同步写，来得及。
         */
        window.addEventListener('pagehide', () => { if (active) flush(); });
        document.addEventListener('visibilitychange', () => { if (active && document.visibilityState === 'hidden') flush(); });
        console.log(TAG, '已启动', pageKey(settings));
        checkRestore();
        watchDom();
    }

    function boot() {
        settings = Store.settings();
        sweepAll();
        if (settings.disabled[location.origin]) console.log(TAG, '本站已停用');
        else start();
        Menu.refresh();
    }

    try {
        boot();
    } catch (e) {
        console.error(TAG, '启动失败', e);
    }
})();
