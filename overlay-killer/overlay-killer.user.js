// ==UserScript==
// @name         弹窗遮罩清理
// @name:zh-CN   弹窗遮罩清理
// @name:en      Overlay Killer — Cookie Banners, Login Walls & Read-More Folds
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.10.27.8
// @description  自动处理 Cookie 同意弹窗（优先点「拒绝全部 / 仅必要」，从不点「接受全部」）、「打开 App 阅读」「登录后查看全文」遮罩，并恢复被锁住的页面滚动；展开「阅读全文」折叠。不误伤视频全屏、图片灯箱和你自己点开的对话框。可按站点停用，可查看并撤销本页处理记录。
// @description:zh-CN  自动处理 Cookie 同意弹窗（优先点「拒绝全部 / 仅必要」，从不点「接受全部」）、「打开 App 阅读」「登录后查看全文」遮罩，并恢复被锁住的页面滚动；展开「阅读全文」折叠。不误伤视频全屏、图片灯箱和你自己点开的对话框。可按站点停用，可查看并撤销本页处理记录。
// @description:en  Automatically deals with cookie consent banners (prefers "Reject all / Necessary only", never clicks "Accept all"), "open in app" and "log in to read more" overlays, restores locked page scrolling, and expands "read more" folds. Leaves fullscreen video, image lightboxes and dialogs you opened yourself alone. Can be disabled per site; lists what it did on the page and can undo the last action.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @license      CC BY-NC-SA
// @run-at       document-end
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/overlay-killer/overlay-killer.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/overlay-killer/overlay-killer.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「弹窗清理」只看本脚本。 */
    const TAG = '[弹窗清理]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        debug: false,
        consentRecheck: 1500,   // 点了拒绝后等这么久，横幅还在就直接隐藏（CMP 自己的脚本坏了 / 被拦了）
        overlayCoverage: 0.6,   // 遮罩至少盖住视口的这么大比例
        overlayThreshold: 6,    // 遮罩打分的及格线，见 scoreOverlay()
        throttle: 300,          // DOM 变化后最多每这么久扫一次
        userGrace: 1500,        // 用户点击 / 按回车后这么久内出现的弹窗，算用户自己打开的
    };

    const log = (...a) => CONFIG.debug && console.log(TAG, ...a);

    /** 处理过的元素打这个属性，值是处理方式；再次扫描时跳过。 */
    const MARK = 'data-overlay-killer';

    // =========================================================================
    // 站点设置：按 hostname 存在 GM 存储里
    // =========================================================================

    const HOST = location.hostname;
    const STORE_KEY = 'sites';

    /** { [hostname]: { disabled?: boolean } } */
    function hostSettings() {
        const all = GM_getValue(STORE_KEY, {}) || {};
        return all[HOST] || {};
    }

    function saveHostSettings(patch) {
        const all = GM_getValue(STORE_KEY, {}) || {};
        const next = { ...(all[HOST] || {}), ...patch };
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
        if (Object.keys(next).length) all[HOST] = next;
        else delete all[HOST];
        GM_setValue(STORE_KEY, all);
    }

    // =========================================================================
    // 改样式：都记下原值，撤销时原样放回
    // =========================================================================

    /**
     * 内联写 !important。返回撤销函数 —— 恢复的是「原来的内联值和优先级」，
     * 原来没有内联值就删掉，让样式表重新生效。
     */
    function setImportant(el, prop, value) {
        const oldValue = el.style.getPropertyValue(prop);
        const oldPriority = el.style.getPropertyPriority(prop);
        el.style.setProperty(prop, value, 'important');
        return () => {
            if (oldValue) el.style.setProperty(prop, oldValue, oldPriority);
            else el.style.removeProperty(prop);
        };
    }

    /** 隐藏元素并打标记，返回撤销函数。 */
    function hide(el, how) {
        const restore = setImportant(el, 'display', 'none');
        el.setAttribute(MARK, how);
        return () => {
            restore();
            el.setAttribute(MARK, 'undone');
        };
    }

    // =========================================================================
    // 用户自己打开的弹窗不动
    // =========================================================================

    /*
     * 判据：弹窗第一次被扫到时，距离用户最近一次真实的点击 / 回车 / 空格不到 CONFIG.userGrace。
     * 扫描本身有最多 throttle 的延迟，所以宽限要比它长得多。
     * 只认 isTrusted：脚本自己 .click() 拒绝按钮、站点用代码派发的事件都不算。
     * 这样判下来的元素打上 user 标记，之后再出现也不动（关了再开是同一个元素）；
     * 菜单里「清理当前页」是用户明确要清，那时忽略这个标记。
     */
    let lastUserAction = -Infinity;
    let manual = false;

    function onUserAction(e) {
        if (!e.isTrusted) return;
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;  // 打字不算
        lastUserAction = Date.now();
    }
    window.addEventListener('pointerdown', onUserAction, true);
    window.addEventListener('keydown', onUserAction, true);

    /** 是用户刚打开的就打上 user 标记并返回 true。 */
    function spareForUser(els) {
        if (manual || Date.now() - lastUserAction >= CONFIG.userGrace) return false;
        els.forEach(el => el.setAttribute(MARK, 'user'));
        log('用户刚操作过，不动', els);
        return true;
    }

    /** 已处理过的，或者用户自己打开的（手动清理时不算后者）。 */
    function handled(el) {
        const m = el.closest(`[${MARK}]`);
        return !!m && !(manual && m.getAttribute(MARK) === 'user');
    }

    // =========================================================================
    // 处理记录：菜单里列出来，可撤销
    // =========================================================================

    /** { kind, label, time, undo?: () => void, undone?: boolean } —— 点了拒绝按钮的没有 undo */
    const records = [];

    function record(kind, label, undo) {
        records.push({ kind, label, time: Date.now(), undo });
        log(kind, label);
        if (panelHost) renderPanel();
    }

    /** 撤销最近一条还能撤销的。点过的拒绝按钮撤不回来（CMP 已经记下了），跳过它。 */
    function undoLast() {
        const r = [...records].reverse().find(x => x.undo && !x.undone);
        if (!r) return null;
        r.undo();
        r.undone = true;
        return r;
    }

    function undoAll() {
        for (const r of [...records].reverse()) {
            if (r.undo && !r.undone) {
                r.undo();
                r.undone = true;
            }
        }
    }

    // =========================================================================
    // 处理记录面板（shadow DOM，不受页面样式影响）
    // =========================================================================

    const PANEL_ID = 'overlay-killer-panel';
    const KIND_NAMES = { cookie: 'Cookie', overlay: '遮罩', app: 'App 引导', expand: '折叠' };
    let panelHost = null;
    let panelNote = '';

    function showPanel(note = '') {
        panelNote = note;
        if (!panelHost) {
            panelHost = document.createElement('div');
            panelHost.id = PANEL_ID;
            // 自己的面板也是 fixed 浮层，打上标记免得被自己当成横幅处理
            panelHost.setAttribute(MARK, 'self');
            panelHost.attachShadow({ mode: 'open' });
            document.documentElement.appendChild(panelHost);
        }
        renderPanel();
    }

    function closePanel() {
        if (panelHost) panelHost.remove();
        panelHost = null;
    }

    function renderPanel() {
        const root = panelHost.shadowRoot;
        root.innerHTML = `
            <style>
                :host { all: initial; }
                .box { position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 340px; max-height: 60vh; overflow: auto;
                       background: #fff; color: #222; font: 13px/1.5 system-ui, sans-serif; border-radius: 8px;
                       box-shadow: 0 4px 24px rgba(0,0,0,.25); padding: 12px 14px; }
                h3 { margin: 0 0 8px; font-size: 14px; }
                ol { margin: 0; padding-left: 20px; }
                li.undone { color: #999; text-decoration: line-through; }
                .kind { color: #1677ff; margin-right: 4px; }
                .fixed { color: #999; }
                .note { color: #d46b08; margin: 0 0 8px; }
                .empty { color: #999; }
                .bar { margin-top: 10px; display: flex; gap: 8px; justify-content: flex-end; }
                button { font: inherit; padding: 2px 10px; cursor: pointer; }
            </style>
            <div class="box">
                <h3>本页处理记录（${records.length}）</h3>
                <p class="note"></p>
                <ol></ol>
                <div class="bar"><button class="undo">撤销最近一次</button><button class="close">关闭</button></div>
            </div>`;
        const note = root.querySelector('.note');
        if (panelNote) note.textContent = panelNote;
        else note.remove();
        const list = root.querySelector('ol');
        if (!records.length) list.outerHTML = '<p class="empty">还没有处理任何东西</p>';
        for (const r of records) {
            const li = document.createElement('li');
            if (r.undone) li.className = 'undone';
            const kind = document.createElement('span');
            kind.className = 'kind';
            kind.textContent = `[${KIND_NAMES[r.kind] || r.kind}]`;
            li.append(kind, r.label);
            if (!r.undo) {
                const fixed = document.createElement('span');
                fixed.className = 'fixed';
                fixed.textContent = '（不可撤销）';
                li.append(fixed);
            }
            list.appendChild(li);
        }
        root.querySelector('.undo').onclick = () => {
            const r = undoLast();
            showPanel(r ? `已撤销：${r.label}` : '没有可以撤销的了');
        };
        root.querySelector('.close').onclick = closePanel;
    }

    // =========================================================================
    // 可见性与按钮文字
    // =========================================================================

    /** 渲染出来了且不是 visibility:hidden。opacity 不看：不少横幅先 opacity:0 再淡入。 */
    function isShown(el) {
        if (!el || !el.isConnected || !el.getClientRects().length) return false;
        return getComputedStyle(el).visibility !== 'hidden';
    }

    function textOf(el) {
        return (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }

    /*
     * 「拒绝 / 仅必要」按钮的文字。只认短文字（按钮），长段落里出现这些词不算。
     * ACCEPT_ALL 是保险：选择器或文字命中了，但按钮上写的是「接受全部」，一律不点 ——
     * CMP 改版时把 id 挪给别的按钮的事情发生过不止一次。
     */
    const REJECT_RE = /^(?:reject|decline|deny|refuse|disagree)(?: all| all cookies| cookies)?$|necessary only|only (?:necessary|essential|required)|(?:essential|required) only|use necessary|continue without (?:accepting|agreeing)|拒绝|不同意|仅(?:限|接受|允许|使用)?必要|只(?:接受|允许|使用)?必要|仅(?:限|接受|允许)?必需/i;
    const ACCEPT_ALL_RE = /accept all|allow all|agree to all|accept cookies|^accept$|^agree$|^ok$|^got it$|接受全部|全部接受|接受所有|允许全部|允许所有|全部同意|同意全部|^同意$|^接受$|^我知道了$/i;

    const BUTTON_SEL = 'button, a, [role="button"], input[type="button"], input[type="submit"]';

    function looksLikeReject(el) {
        const text = textOf(el);
        if (!text || text.length > 40) return false;
        return REJECT_RE.test(text) && !ACCEPT_ALL_RE.test(text);
    }

    // =========================================================================
    // Cookie 同意：已知的同意管理平台（CMP）
    // =========================================================================

    /*
     * 原则：能拒绝就拒绝（「拒绝全部」「仅必要」），没有拒绝按钮才隐藏横幅；从不点「接受全部」。
     * 隐藏横幅 ≈ 没有表态：多数 CMP 在用户表态前只放必要 Cookie（GDPR 要求的就是这个），
     * 而点「接受」是替用户做了一个他没做的同意。
     *
     * 字段：
     *   detect  横幅本体，可见才算在弹（很多 CMP 表态后只是把它 display:none，节点还在）
     *   reject  拒绝 / 仅必要按钮；没写或找不到时在横幅里按文字找一遍
     *   hide    找不到拒绝按钮时要隐藏的元素（默认就是 detect）；遮罩层也写进来
     *   shadow  横幅在这个宿主的 open shadow root 里
     *
     * 选择器都来自各家公开的接入文档和常见页面结构，没有逐个在真实站点上实测。
     */
    const CMPS = [
        {
            name: 'OneTrust',
            detect: '#onetrust-banner-sdk',
            reject: '#onetrust-reject-all-handler',
            hide: '#onetrust-consent-sdk',
        },
        {
            name: 'Cookiebot',
            detect: '#CybotCookiebotDialog',
            reject: '#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
            hide: '#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay',
        },
        {
            // 「DISAGREE」和「MORE OPTIONS」都是 button[mode=secondary]，只能按文字分
            name: 'Quantcast Choice',
            detect: '#qc-cmp2-container .qc-cmp2-summary-buttons, #qc-cmp2-ui',
            hide: '#qc-cmp2-container',
        },
        {
            name: 'Didomi',
            detect: '#didomi-notice, #didomi-popup',
            reject: '#didomi-notice-disagree-button, .didomi-continue-without-agreeing',
            hide: '#didomi-host',
        },
        {
            name: 'Usercentrics',
            shadow: '#usercentrics-root, #usercentrics-cmp-ui',
            detect: '[data-testid="uc-default-banner"], [data-testid="uc-banner-content"], #uc-center-container, .cmp',
            reject: '[data-testid="uc-deny-all-button"], #deny',
        },
        {
            name: 'TrustArc',
            detect: '#truste-consent-track, .truste_box_overlay',
            reject: '#truste-consent-required',
            hide: '#truste-consent-track, .truste_overlay, .truste_box_overlay',
        },
        {
            // 按钮在跨域 iframe 里点不到，只能隐藏
            name: 'Sourcepoint',
            detect: '[id^="sp_message_container_"]',
        },
        {
            name: 'CookieYes',
            detect: '.cky-consent-container',
            reject: '.cky-btn-reject',
            hide: '.cky-consent-container, .cky-overlay',
        },
        {
            name: 'Complianz',
            detect: '.cmplz-cookiebanner',
            reject: '.cmplz-btn.cmplz-deny',
        },
        {
            name: 'Osano',
            detect: '.osano-cm-dialog',
            reject: '.osano-cm-denyAll, .osano-cm-deny',
        },
        {
            name: 'cookieconsent',
            detect: '.cc-window',
            reject: '.cc-deny',
        },
        {
            name: 'Klaro',
            detect: '.klaro .cookie-notice, .klaro .cookie-modal',
            reject: '.cn-decline',
        },
    ];

    /** 在 document 和（如果有）CMP 的 shadow root 里找。 */
    function scopesOf(rule) {
        if (!rule.shadow) return [document];
        return [...document.querySelectorAll(rule.shadow)].map(h => h.shadowRoot).filter(Boolean);
    }

    function queryAll(scopes, sel) {
        return sel ? scopes.flatMap(s => [...s.querySelectorAll(sel)]) : [];
    }

    /** 横幅里按文字找拒绝按钮。 */
    function findRejectByText(root) {
        return [...root.querySelectorAll(BUTTON_SEL)].find(b => isShown(b) && looksLikeReject(b)) || null;
    }

    /**
     * 处理一个同意横幅：有拒绝按钮就点，没有就隐藏。
     * 点了以后 CMP 自己会收起横幅；过一会儿还在，说明它的脚本没接住，再隐藏。
     */
    function handleConsent(name, banner, rejectBtn, hideTargets) {
        if (rejectBtn) {
            const text = textOf(rejectBtn);
            banner.setAttribute(MARK, 'rejected');
            rejectBtn.click();
            record('cookie', `${name}：点了「${text}」`);
            setTimeout(() => {
                if (isShown(banner)) hideConsent(name, hideTargets, '点了拒绝但横幅没收起，已隐藏');
            }, CONFIG.consentRecheck);
            return;
        }
        hideConsent(name, hideTargets, '没有拒绝按钮，已隐藏横幅');
    }

    function hideConsent(name, targets, why) {
        const undos = targets.filter(isShown).map(el => hide(el, 'consent'));
        if (!undos.length) return;
        // 带全屏遮罩的 CMP（Quantcast、Cookiebot 的弹窗模式）会锁滚动，用户表态后才由它自己解开
        undos.push(...unlockScroll());
        record('cookie', `${name}：${why}`, () => undos.forEach(u => u()));
    }

    function cookieCmp() {
        for (const rule of CMPS) {
            const scopes = scopesOf(rule);
            const banner = queryAll(scopes, rule.detect).find(isShown);
            if (!banner || handled(banner)) continue;
            // shadow DOM 里的横幅没法从外面隐藏（样式隔离），隐藏宿主
            const hosts = rule.shadow ? [...document.querySelectorAll(rule.shadow)] : [];
            if (hosts.some(handled)) continue;
            // 用户在页脚点了「Cookie 设置」重新打开的，不能替他点拒绝
            if (spareForUser(rule.shadow ? hosts : [banner])) continue;
            const rejectBtn = queryAll(scopes, rule.reject).find(b => isShown(b) && !ACCEPT_ALL_RE.test(textOf(b)))
                || findRejectByText(banner);
            const hideTargets = rule.shadow ? hosts : queryAll(scopes, rule.hide || rule.detect);
            if (rule.shadow) hosts.forEach(h => h.setAttribute(MARK, 'consent'));
            handleConsent(rule.name, banner, rejectBtn, hideTargets);
        }
    }

    // =========================================================================
    // 通用兜底：贴在视口顶部 / 底部的固定横幅
    // =========================================================================

    const COOKIE_RE = /cookie|gdpr|consent|隐私|个人信息/i;
    const APP_RE = /打开\s*app|app\s*内\s*(?:打开|阅读|查看)|下载\s*app|打开客户端|客户端内(?:打开|查看)|open (?:in|the) app|get the app|use the app/i;

    /**
     * 元素所在的最外层 fixed / sticky 祖先。横幅的可点区域往往是里面的某个子元素，
     * 要处理的是整条横幅。
     */
    function fixedRoot(el) {
        let found = null;
        for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
            const pos = getComputedStyle(a).position;
            if (pos === 'fixed' || pos === 'sticky') found = a;
        }
        return found;
    }

    /**
     * 用 elementsFromPoint 在视口边缘取点，不遍历整棵 DOM：
     * 能被打到的才是用户看得到的，比挨个算 computed style 便宜得多。
     * 卡片式横幅常离边缘十几像素，所以每边取两行。
     */
    function edgeCandidates() {
        const vw = innerWidth, vh = innerHeight;
        const found = new Set();
        for (const fx of [0.05, 0.25, 0.5, 0.75, 0.95]) {
            for (const y of [2, 40, vh - 40, vh - 3]) {
                for (const el of document.elementsFromPoint(vw * fx, y)) {
                    const root = fixedRoot(el);
                    if (root) found.add(root);
                }
            }
        }
        return [...found];
    }

    function edgeBars() {
        const vh = innerHeight;
        for (const bar of edgeCandidates()) {
            if (handled(bar) || bar.querySelector(`[${MARK}]`)) continue;
            const r = bar.getBoundingClientRect();
            // 太高的是遮罩，交给遮罩那一步；不贴边的是页面中间的浮层
            if (r.height > vh * 0.6) continue;
            if (r.top > 50 && r.bottom < vh - 50) continue;
            const text = textOf(bar);
            if (text.length < 8 || text.length > 1500) continue;
            const isCookie = COOKIE_RE.test(text) && bar.querySelector(BUTTON_SEL);
            if (!isCookie && !APP_RE.test(text)) continue;
            if (spareForUser([bar])) continue;
            if (isCookie) {
                handleConsent('Cookie 横幅', bar, findRejectByText(bar), [bar]);
            } else {
                const undo = hide(bar, 'app');
                record('app', `「打开 App」引导条：${text.slice(0, 20)}`, undo);
            }
        }
    }

    // =========================================================================
    // 恢复被锁住的滚动
    // =========================================================================

    /**
     * 弹窗锁滚动的三种写法：
     *   1. html / body 上 overflow: hidden
     *   2. body { position: fixed; top: -<滚动位置>px } —— iOS 上 overflow 锁不住，
     *      所以很多弹窗库（body-scroll-lock 之类）这么干，关弹窗时再把滚动位置还回去
     *   3. touch-action: none —— 移动端禁手势
     * 只解 y 方向：overflow-x: hidden 常是站点防横向滚动条的正常写法。
     * 返回撤销函数数组。
     */
    function unlockScroll() {
        const undos = [];
        let restoreY = null;
        for (const el of [document.documentElement, document.body]) {
            if (!el) continue;
            const s = getComputedStyle(el);
            if (s.overflowY === 'hidden' || s.overflowY === 'clip') undos.push(setImportant(el, 'overflow-y', 'auto'));
            if (s.position === 'fixed') {
                const top = parseFloat(s.top);
                if (top < 0) restoreY = -top;
                undos.push(setImportant(el, 'position', 'static'));
            }
            if (s.touchAction === 'none') undos.push(setImportant(el, 'touch-action', 'auto'));
        }
        if (restoreY !== null) {
            // 站点常给 html 写 scroll-behavior: smooth，不指定 instant 的话要滚好一会儿才到
            window.scrollTo({ top: restoreY, behavior: 'instant' });
        }
        return undos;
    }

    function scrollLocked() {
        return [document.documentElement, document.body].some(el => {
            if (!el) return false;
            const s = getComputedStyle(el);
            return s.overflowY === 'hidden' || s.overflowY === 'clip' || s.position === 'fixed';
        });
    }

    // =========================================================================
    // 遮罩：盖住大半个视口的半透明固定层
    // =========================================================================

    /** 「登录后查看」「打开 App」这类遮罩上的字。 */
    const WALL_RE = /登录|登陆|注册|打开\s*app|下载\s*app|客户端|继续阅读|阅读全文|查看全文|查看更多|会员|扫码|sign ?in|log ?in|sign ?up|subscribe|订阅|open (?:in|the) app|continue reading/i;
    const LIGHTBOX_RE = /lightbox|fancybox|photoswipe|pswp|viewer|gallery|lg-outer|mfp-|zoom|preview|carousel/i;

    /** 背景色的不透明度，乘上元素自身的 opacity。 */
    function bgAlpha(el) {
        const s = getComputedStyle(el);
        const m = s.backgroundColor.match(/rgba?\(([^)]+)\)/);
        if (!m) return 0;
        const parts = m[1].split(/[,\s/]+/).filter(Boolean);
        const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
        return a * parseFloat(s.opacity);
    }

    function zIndexOf(el) {
        const z = parseInt(getComputedStyle(el).zIndex, 10);
        return Number.isNaN(z) ? 0 : z;
    }

    /** 和视口相交的面积占视口的比例。 */
    function coverage(el) {
        const r = el.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        return (w * h) / (innerWidth * innerHeight);
    }

    /**
     * 这些即使长得像遮罩也不动：
     *   - 全屏（Fullscreen API）和「网页全屏」的播放器：里面有占了大半个视口的 <video>
     *   - 图片灯箱：类名像灯箱，或里面有占了三成视口以上的图片
     *   - 原生 <dialog>：站点自己的模态框，走浏览器 top layer
     */
    function isProtected(el) {
        const fs = document.fullscreenElement;
        if (fs && (fs === el || fs.contains(el) || el.contains(fs))) return true;
        if (el.tagName === 'DIALOG' || el.querySelector('dialog[open]')) return true;
        for (const v of el.querySelectorAll('video')) if (coverage(v) > 0.5) return true;
        for (const img of el.querySelectorAll('img, picture, canvas')) if (coverage(img) > 0.3) return true;
        const names = [el, ...el.querySelectorAll('*')].slice(0, 300);
        return names.some(n => LIGHTBOX_RE.test(`${n.id} ${n.getAttribute('class') || ''}`));
    }

    /**
     * 打分，满分 10，及格线 CONFIG.overlayThreshold：
     *   盖住视口 ≥95% +2，≥60% +1（不到 60% 直接不算）
     *   半透明背景（自身或铺满它的子元素）+3，毛玻璃 backdrop-filter +2
     *   z-index ≥1000 +2，≥10 +1
     *   页面滚动被锁 +1；文字像登录墙 / 打开 App +1
     *   文字超过 3000 字 −3：那是正文，不是遮罩（有的站整个 app 外壳就是 fixed 全屏）
     * 纯白不透明、z-index 不高、也没有「登录」字样的全屏层到不了及格线 ——
     * 那多半是 SPA 的外壳或站点自己的全屏页面。
     */
    function scoreOverlay(el, text) {
        const cov = coverage(el);
        if (cov < CONFIG.overlayCoverage) return 0;
        let score = 1 + (cov >= 0.95 ? 2 : 1);
        const layers = [el, ...[...el.children].filter(c => coverage(c) >= cov * 0.9)];
        const alpha = Math.max(...layers.map(bgAlpha));
        if (alpha > 0.05 && alpha < 0.95) score += 3;
        else if (layers.some(l => (getComputedStyle(l).backdropFilter || 'none') !== 'none')) score += 2;
        const z = zIndexOf(el);
        if (z >= 1000) score += 2;
        else if (z >= 10) score += 1;
        if (scrollLocked()) score += 1;
        if (WALL_RE.test(text)) score += 1;
        if (text.length > 3000) score -= 3;
        return score;
    }

    /** 视口里取 5 个点，收集命中元素的所有 fixed 祖先（不只最外层：有的站整个外壳就是 fixed）。 */
    function overlayCandidates() {
        const found = new Set();
        for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
            for (const el of document.elementsFromPoint(innerWidth * fx, innerHeight * fy)) {
                for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
                    if (getComputedStyle(a).position === 'fixed') found.add(a);
                }
            }
        }
        return [...found];
    }

    /**
     * 遮罩上面的弹窗本体。两种摆法：
     *   - 和遮罩是兄弟节点，z-index 更高：在兄弟里找 fixed/absolute、比遮罩小的
     *   - 挂在别处、居中盖在遮罩上：视口中心命中的、在遮罩之上的 fixed 层
     * 弹窗是遮罩的子元素的情况不用管，隐藏遮罩就一起没了。
     */
    function companionsOf(mask) {
        const out = new Set();
        const z = zIndexOf(mask);
        for (const sib of mask.parentElement ? mask.parentElement.children : []) {
            if (sib === mask || !isShown(sib) || handled(sib)) continue;
            const pos = getComputedStyle(sib).position;
            if ((pos === 'fixed' || pos === 'absolute') && zIndexOf(sib) >= z && coverage(sib) < 0.9 && coverage(sib) > 0) out.add(sib);
        }
        for (const el of document.elementsFromPoint(innerWidth / 2, innerHeight / 2)) {
            if (el === mask || mask.contains(el)) break;  // 往下就是遮罩和被它盖住的页面了
            const root = fixedRoot(el);
            if (root && root !== mask && !root.contains(mask) && !handled(root) && coverage(root) < 0.9) out.add(root);
        }
        return [...out];
    }

    function overlays() {
        const done = [];
        for (const el of overlayCandidates()) {
            if (handled(el) || done.some(d => d.contains(el) || el.contains(d))) continue;
            if (!isShown(el) || isProtected(el)) continue;
            const companions = companionsOf(el);
            const text = [el, ...companions].map(textOf).join(' ');
            const score = scoreOverlay(el, text);
            log('遮罩候选', score, el);
            if (score < CONFIG.overlayThreshold) continue;
            if (spareForUser([el, ...companions])) continue;
            const undos = [el, ...companions].map(x => hide(x, 'overlay'));
            undos.push(...unlockScroll());
            record('overlay', `遮罩：${text.slice(0, 30) || '（无文字）'}`, () => undos.forEach(u => u()));
            done.push(el);
        }
    }

    // =========================================================================
    // 折叠全文：max-height / height + overflow: hidden + 渐变 + 「展开全文」按钮
    // =========================================================================

    /*
     * 站点规则：通用识别认不出、或者按钮文字不固定的站。
     *   hosts   域名，匹配本域及子域
     *   expand  被截断的正文容器
     *   remove  展开按钮、渐变遮挡
     * 都没在真实站点上实测过：CSDN 的结构参照了公开的去限制脚本，知乎、百度知道是按类名推测的。
     * 选择器不命中时没有副作用，通用识别照常兜底。
     */
    const SITES = [
        {
            name: 'CSDN',
            hosts: ['csdn.net'],
            // 未登录 / 仅粉丝可见：<div id="article_content" style="height: 2000px; overflow: hidden">，
            // 下面 .hide-article-box 里是渐变和「阅读全文」/「关注博主即可阅读全文」
            expand: '#article_content',
            remove: '.hide-article-box',
        },
        {
            name: '知乎',
            hosts: ['zhihu.com'],
            expand: '.RichContent--collapsed .RichContent-inner',
            remove: '.RichContent--collapsed .ContentItem-expandButton',
        },
        {
            name: '百度知道',
            hosts: ['zhidao.baidu.com'],
            expand: '.best-text, .answer-text',
            remove: '.wgt-best-mask, .wgt-answers-mask, .wgt-best-showbtn',
        },
    ];

    const SITE = SITES.find(r => r.hosts.some(h => HOST === h || HOST.endsWith('.' + h))) || null;

    /*
     * 按钮文字整句匹配，不做包含匹配：「查看更多评论」「展开全部回复」是翻页 / 加载评论，
     * 旁边恰好有个截断容器时会被当成展开按钮。允许「登录后」「关注博主即可」这类前缀。
     */
    const MORE_RE = /^(?:(?:登录|关注.{0,4}?)(?:后|即可))?(?:展开|(?:展开|阅读|查看|显示)(?:阅读)?(?:全文|全部|更多))$|^继续阅读$|^(?:read|show|see) more$|^continue reading$|^expand$/i;

    function moreText(el) {
        return textOf(el).replace(/[>›»∨⌄▼▽↓︾…。.:：]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    /** 渐变遮挡画在伪元素上时，给宿主打这个属性，统一用一条样式藏掉。 */
    const FADE = MARK + '-fade';
    let fadeStyle = null;

    function hidePseudoFade(el) {
        if (!fadeStyle) {
            fadeStyle = document.createElement('style');
            fadeStyle.textContent = `[${FADE}]::before, [${FADE}]::after { display: none !important; }`;
            (document.head || document.documentElement).appendChild(fadeStyle);
        }
        el.setAttribute(FADE, '');
        return () => el.removeAttribute(FADE);
    }

    function hasGradient(el, pseudo) {
        return /gradient/.test(getComputedStyle(el, pseudo).backgroundImage);
    }

    /** 内容被截掉了一截：overflow 不让看，实际内容比框高，且确实是正文（有一定字数）。 */
    function isTruncated(el) {
        if (el === document.body || el === document.documentElement) return false;
        const s = getComputedStyle(el);
        const clamped = s.webkitLineClamp && s.webkitLineClamp !== 'none';
        if (!clamped && s.overflowY !== 'hidden' && s.overflowY !== 'clip') return false;
        if (s.position === 'fixed') return false;
        if (el.scrollHeight <= el.clientHeight + 40 && !clamped) return false;
        return textOf(el).length >= 100;
    }

    /** 解除截断，返回撤销函数。 */
    function unclamp(el) {
        const undos = [
            setImportant(el, 'max-height', 'none'),
            setImportant(el, 'height', 'auto'),
            setImportant(el, 'overflow-y', 'visible'),
        ];
        const s = getComputedStyle(el);
        if (s.webkitLineClamp && s.webkitLineClamp !== 'none') undos.push(setImportant(el, '-webkit-line-clamp', 'unset'));
        if (hasGradient(el, '::after') || hasGradient(el, '::before')) undos.push(hidePseudoFade(el));
        el.setAttribute(MARK, 'expanded');
        return () => {
            undos.forEach(u => u());
            el.setAttribute(MARK, 'undone');
        };
    }

    /**
     * 按钮对应的截断容器：按钮可能在容器里面（绝对定位在底部），也可能在容器后面。
     * 从按钮往上走几层，每层看自己和前面最多 3 个兄弟（中间常隔着一条渐变）。
     * 不看后面的兄弟：那是下一篇文章 / 下一个回答，按钮不会管到它。
     */
    function truncatedNear(btn) {
        let a = btn;
        for (let i = 0; i < 5 && a && a !== document.body; i++, a = a.parentElement) {
            if (isTruncated(a)) return a;
            let sib = a.previousElementSibling;
            for (let j = 0; j < 3 && sib; j++, sib = sib.previousElementSibling) {
                if (isTruncated(sib)) return sib;
            }
        }
        return null;
    }

    /** 按钮往外扩到「只装着这个按钮」的那层包装（常常就是渐变条本身）。 */
    function buttonWrapper(btn, container) {
        let w = btn;
        const text = textOf(btn);
        while (w.parentElement && !w.parentElement.contains(container) && textOf(w.parentElement) === text) w = w.parentElement;
        return w;
    }

    /** 容器里和旁边绝对定位的渐变条。 */
    function fadesNear(container) {
        const pool = [...container.children, ...(container.parentElement ? container.parentElement.children : [])];
        return pool.filter(el => el !== container && !handled(el) && isShown(el)
            && getComputedStyle(el).position === 'absolute' && hasGradient(el) && textOf(el).length < 20);
    }

    /** 文字里带「展开」「全文」之类的节点，用 XPath 找，比遍历所有元素便宜。 */
    function moreButtons() {
        const lower = "translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')";
        const words = ['展开', '全文', '全部', '更多', '继续阅读'].map(w => `contains(., '${w}')`)
            .concat(['read', 'show more', 'see more', 'expand'].map(w => `contains(${lower}, '${w}')`));
        const xp = `//body//text()[${words.join(' or ')}]`;
        const snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out = new Set();
        for (let i = 0; i < snap.snapshotLength; i++) {
            const p = snap.snapshotItem(i).parentElement;
            if (!p || p.closest('script, style, noscript')) continue;
            const btn = p.closest(BUTTON_SEL) || p;
            if (MORE_RE.test(moreText(btn)) && isShown(btn) && !handled(btn)) out.add(btn);
        }
        return [...out];
    }

    function expandFolds() {
        if (SITE) expandSite(SITE);
        for (const btn of moreButtons()) {
            const box = truncatedNear(btn);
            if (!box || handled(box)) continue;
            const undos = [unclamp(box), hide(buttonWrapper(btn, box), 'expand')];
            for (const f of fadesNear(box)) undos.push(hide(f, 'expand'));
            record('expand', `展开全文：${moreText(btn)}`, () => undos.forEach(u => u()));
        }
    }

    function expandSite(rule) {
        const undos = [];
        for (const el of document.querySelectorAll(rule.expand)) {
            if (!handled(el) && isTruncated(el)) undos.push(unclamp(el));
        }
        if (!undos.length) return;
        for (const el of document.querySelectorAll(rule.remove)) {
            if (!handled(el) && isShown(el)) undos.push(hide(el, 'expand'));
        }
        record('expand', `${rule.name}：展开全文`, () => undos.forEach(u => u()));
    }

    // =========================================================================
    // 主流程
    // =========================================================================

    /** 依次跑各个处理步骤；每一步各自 try，一步出错不影响别的。 */
    const STEPS = [cookieCmp, overlays, edgeBars, expandFolds];

    function clean() {
        for (const step of STEPS) {
            try {
                step();
            } catch (e) {
                console.error(TAG, step.name, e);
            }
        }
    }

    // =========================================================================
    // 时机：document-end 一次，之后靠 MutationObserver 接住延迟弹出的
    // =========================================================================

    /*
     * 不少弹窗是进页面几秒后才出来的（「读了 3 秒弹登录」），也有的只是切 class / style 显示出来，
     * 所以 class/style/hidden/open 属性变化也要看。
     * 节流而不是防抖：信息流页面 DOM 一直在变，防抖会一直拖着不跑。
     */
    let observer = null;
    let timer = null;
    let lastRun = -Infinity;
    let started = false;

    function run() {
        timer = null;
        lastRun = Date.now();
        clean();
        // 自己改的 style / 标记属性也会进队列，丢掉，免得自己触发自己
        if (observer) observer.takeRecords();
    }

    function schedule() {
        if (timer) return;
        timer = setTimeout(run, Math.max(0, lastRun + CONFIG.throttle - Date.now()));
    }

    function start() {
        if (started) return;
        started = true;
        run();
        observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'open'],
        });
        // document-end 时图片、字体还没到，版面可能还会变
        if (document.readyState !== 'complete') window.addEventListener('load', schedule, { once: true });
    }

    function stop() {
        started = false;
        if (observer) observer.disconnect();
        observer = null;
        clearTimeout(timer);
        timer = null;
    }

    // =========================================================================
    // 菜单
    // =========================================================================

    let menuIds = [];

    function registerMenu() {
        menuIds.forEach(id => GM_unregisterMenuCommand(id));
        menuIds = [];
        const add = (caption, fn) => menuIds.push(GM_registerMenuCommand(caption, fn));
        if (hostSettings().disabled) add(`⛔ 本站已停用（${HOST}），点击启用`, () => setDisabled(false));
        else add(`✅ 本站已启用（${HOST}），点击停用`, () => setDisabled(true));
        add('🧹 清理当前页', manualClean);
        add('📋 本页处理记录', () => showPanel());
        add('↩ 撤销最近一次', () => {
            const r = undoLast();
            showPanel(r ? `已撤销：${r.label}` : '没有可以撤销的了');
        });
    }

    /** 停用时把本页做过的都撤回去，页面回到装脚本之前的样子；启用时立刻扫一遍。不用刷新。 */
    function setDisabled(disabled) {
        saveHostSettings({ disabled: disabled || undefined });
        if (disabled) {
            stop();
            undoAll();
        } else {
            start();
        }
        registerMenu();
    }

    /** 手动清理：不管用户刚点过什么，也不管本站是否停用，只跑这一次。 */
    function manualClean() {
        const before = records.length;
        manual = true;
        try {
            clean();
        } finally {
            manual = false;
        }
        if (observer) observer.takeRecords();
        const n = records.length - before;
        showPanel(n ? `这次处理了 ${n} 项` : '没找到需要处理的弹窗或折叠');
    }

    registerMenu();
    if (hostSettings().disabled) {
        log('本站已停用', HOST);
        return;
    }
    start();
})();
