// ==UserScript==
// @name         表单草稿自动保存|评论/工单/帖子写到一半不怕丢
// @name:zh-CN   表单草稿自动保存|评论/工单/帖子写到一半不怕丢
// @name:en      Form Saver — auto-save drafts of what you type, restore after crash/close
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.07.10.3
// @description  在任意网页自动保存输入框/文本框/下拉框/富文本的草稿，误关标签、页面崩溃、提交失败跳走后回来，角落提示一键恢复。不保存密码、卡号、验证码等敏感字段；草稿 7 天过期。
// @description:zh-CN  在任意网页自动保存输入框/文本框/下拉框/富文本的草稿，误关标签、页面崩溃、提交失败跳走后回来，角落提示一键恢复。不保存密码、卡号、验证码等敏感字段；草稿 7 天过期。
// @description:en  Auto-saves drafts of inputs, textareas, selects and contenteditable editors on any page. Closed the tab, the page crashed or a submit failed? Come back and restore with one click. Never stores passwords, card numbers or one-time codes; drafts expire after 7 days.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
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
    /** 按钮类 input 没有「内容」可存。 */
    const NON_DATA_TYPES = new Set(['button', 'submit', 'reset', 'image']);

    function isField(el) {
        return el instanceof Element && el.matches(FIELD_SELECTOR);
    }

    /** text：value 字符串；check：checkbox 的 checked；radio：整组选中项的 value；multi：多选 select 的值数组。 */
    function kindOf(el) {
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
            default: return el.value;
        }
    }

    /**
     * 「没被用户动过」：文本为空或等于页面给的默认值；勾选/下拉等于初始状态。
     * 这种状态既不值得存（存了也恢复不出新东西），也是恢复时「可以安全填入」的判据。
     */
    function isPristine(el) {
        switch (kindOf(el)) {
            case 'check': return el.checked === el.defaultChecked;
            case 'radio': {
                const group = el.name ? radioGroup(el) : [el];
                return group.every(r => r.checked === r.defaultChecked);
            }
            case 'multi': return [...el.options].every(o => o.selected === o.defaultSelected);
            default:
                if (el.tagName === 'SELECT') return el.selectedIndex === defaultIndex(el);
                return el.value === '' || el.value === el.defaultValue;
        }
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

    function formIdOf(form) {
        if (!form) return 'doc';
        if (form.id) return 'form#' + form.id;
        if (form.getAttribute('name')) return 'form[' + form.getAttribute('name') + ']';
        return 'form:' + [...document.forms].indexOf(form);
    }

    /**
     * 字段的稳定标识：所在表单 + 字段自身。字段自身依次用 name、id、结构路径。
     * 同名的多个非 radio 字段（tags[] 这种）用同名中的序号区分。
     */
    function fieldKey(el) {
        const form = el.form || null;
        const scopeRoot = form || document.body;
        let own;
        if (el.name) {
            own = '[name=' + el.name + ']';
            if (el.type !== 'radio') {
                const same = [...scopeRoot.querySelectorAll(FIELD_SELECTOR)].filter(f => f.name === el.name && f.type !== 'radio');
                if (same.length > 1) own += ':' + same.indexOf(el);
            }
        } else if (el.id) {
            own = '#' + el.id;
        } else {
            own = '@' + cssPath(el, scopeRoot);
        }
        return formIdOf(form) + ' ' + own;
    }

    function labelOf(el) {
        const txt = el.getAttribute('aria-label') || el.placeholder
            || (el.labels && el.labels[0] && el.labels[0].textContent)
            || el.name || el.id || el.tagName.toLowerCase();
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
    /** 待落盘的字段 → 编辑时所在的页面键（SPA 里防抖期间路由可能已经变了） */
    const dirty = new Map();
    let flushTimer = 0;

    function onEdit(e) {
        const el = e.target;
        if (!shouldSave(el)) return;
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
            if (isPristine(el) || looksLikeCardNumber(value)) {
                delete draft.fields[fk];
            } else if (typeof value === 'string' && value.length > CONFIG.maxValueLength) {
                console.warn(TAG, '字段太长，不保存', fk, value.length);
            } else {
                draft.fields[fk] = { v: value, k: kindOf(el), l: labelOf(el), t: now };
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
        Store.save(origin, bucket);
    }

    // =========================================================================
    // 启动
    // =========================================================================

    function boot() {
        settings = Store.settings();
        if (settings.disabled[location.origin]) {
            console.log(TAG, '本站已停用');
            return;
        }
        rememberPasswords(document);
        // 捕获阶段：页面自己 stopPropagation 也挡不住我们
        document.addEventListener('focusin', (e) => { if (e.target.type === 'password') shouldSave(e.target); }, true);
        document.addEventListener('input', onEdit, true);
        document.addEventListener('change', onEdit, true);
        console.log(TAG, '已启动', pageKey(settings));
    }

    try {
        boot();
    } catch (e) {
        console.error(TAG, '启动失败', e);
    }
})();
