// ==UserScript==
// @name         网站使用时长统计与限制
// @name:zh-CN   网站使用时长统计与限制
// @name:en      Site Timer — Track and Limit Time Spent on Websites
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.11.12.6
// @description  统计每个网站「真正在用」的时间（标签页可见、窗口聚焦、最近有操作，播放中的视频也算），按主域名归并，同一站点开多个标签只算一份；可给站点设每日上限，快到时提醒、超时全屏遮罩；统计面板看今天 / 近 7 天排行，导出 CSV。
// @description:zh-CN  统计每个网站「真正在用」的时间（标签页可见、窗口聚焦、最近有操作，播放中的视频也算），按主域名归并，同一站点开多个标签只算一份；可给站点设每日上限，快到时提醒、超时全屏遮罩；统计面板看今天 / 近 7 天排行，导出 CSV。
// @description:en  Tracks the time you actually spend on each website (tab visible, window focused, recent input, or a video playing), grouped by registrable domain and counted once no matter how many tabs are open. Set a daily limit per site to get a heads-up near the end and a full-screen block when time is up. A stats panel ranks sites for today and the last 7 days and exports CSV.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @license      CC BY-NC-SA
// @run-at       document-end
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/site-timer/site-timer.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/site-timer/site-timer.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「使用时长」只看本脚本。 */
    const TAG = '[使用时长]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        tickMs: 1000,           // 计时粒度：每秒看一次「现在算不算在用」
        flushMs: 15000,         // 内存里攒的时长最多攒这么久才落盘
        idleMinutes: 5,         // 这么久没有键盘 / 鼠标 / 滚动 / 触摸就算离开了
        leaseRenewMs: 5000,     // 计时的标签页每隔这么久续一次租约
        leaseTtlMs: 15000,      // 租约这么久没续就算持有者没了（崩溃、被冻结），别的标签页可以接手
        maxGapMs: 30000,        // 两次 tick 之间隔了这么久：电脑睡过了（或页面被冻结），这段不算
        warnMinutes: 5,         // 离上限还剩这么多分钟时右下角提醒一次
        extendMinutes: 5,       // 遮罩上「再给 N 分钟」
        maxExtends: 3,          // 每个站点每天最多再给几次
        toastMs: 10000,         // 提醒条显示多久
    };

    // =========================================================================
    // 主域名
    // =========================================================================

    /**
     * 多段公共后缀的小表。不是完整的 Public Suffix List（那份有上万条），只收常见的：
     * 表里没有的一律按「最后两段」处理，所以单段后缀（.com、.cn、.io）不用列。
     *
     * 第二组是「每个子域名都是别人的站」的托管平台：alice.github.io 和 bob.github.io
     * 不是同一个网站，归并成 github.io 会把所有人的博客算到一起。
     */
    const MULTI_SUFFIXES = new Set([
        // 国家/地区二级后缀
        'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
        'com.hk', 'org.hk', 'edu.hk', 'gov.hk', 'com.tw', 'org.tw', 'edu.tw', 'gov.tw', 'com.mo',
        'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
        'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
        'co.kr', 'or.kr', 'ac.kr',
        'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz',
        'com.sg', 'edu.sg', 'com.my', 'co.in', 'co.id', 'co.th', 'com.vn',
        'com.br', 'com.mx', 'com.ar', 'com.tr', 'co.za', 'com.ru',
        // 托管平台（私有后缀）
        'github.io', 'gitlab.io', 'gitee.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
        'web.app', 'firebaseapp.com', 'herokuapp.com', 'appspot.com', 'blogspot.com', 'azurewebsites.net',
        'onrender.com', 'fly.dev', 'glitch.me', 'surge.sh', 'neocities.org', 'readthedocs.io',
    ]);

    /**
     * hostname → 主域名（注册域名）：www.example.com.cn / m.example.com.cn → example.com.cn，
     * alice.github.io 保持原样。IP、localhost 这类没有「主域名」概念的原样返回。
     */
    function mainDomain(hostname) {
        const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
        if (!host || host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
        const labels = host.split('.');
        if (labels.length <= 2) return host;
        // 从长到短试后缀，命中就再往前带一段
        for (let i = 1; i < labels.length - 1; i++) {
            const suffix = labels.slice(i).join('.');
            if (MULTI_SUFFIXES.has(suffix)) return labels.slice(i - 1).join('.');
        }
        return labels.slice(-2).join('.');
    }

    // =========================================================================
    // 存储
    // =========================================================================

    /**
     * 键的设计：时长按「天 + 站点」一个键（t:2026-10-29:example.com → 毫秒）。
     * 不把一天的所有站点放进一个对象：不同站点的标签页会同时读改写同一个键，
     * GM 存储没有事务，后写的会把先写的覆盖掉。一站一键的话，同一时刻只有一个标签页
     * 会写它（见租约），读改写是安全的。
     */
    const Store = {
        timeKey: (day, domain) => `t:${day}:${domain}`,
        getTime(day, domain) {
            return GM_getValue(this.timeKey(day, domain), 0);
        },
        addTime(day, domain, ms) {
            GM_setValue(this.timeKey(day, domain), this.getTime(day, domain) + ms);
        },

        /** 每日上限：{ 站点: 分钟 }。全局一个键，只在用户设置时写，不存在并发写。 */
        getLimits() {
            return GM_getValue('limits', {});
        },
        setLimit(domain, minutes) {
            const limits = this.getLimits();
            if (minutes > 0) limits[domain] = minutes;
            else delete limits[domain];
            GM_setValue('limits', limits);
        },

        /** 当天的限制状态：再给了几次、是否「今天不再提醒」、已对哪个上限提醒过。和时长一样按天 + 站点一个键。 */
        flagKey: (day, domain) => `f:${day}:${domain}`,
        getFlags(day, domain) {
            return { extends: 0, quiet: false, warned: 0, ...GM_getValue(this.flagKey(day, domain), {}) };
        },
        setFlags(day, domain, flags) {
            GM_setValue(this.flagKey(day, domain), flags);
        },
    };

    /** 本地日期 YYYY-MM-DD。按本地零点切天，不用 toISOString（那是 UTC，东八区早上 8 点前会算到前一天）。 */
    function dayKey(ts) {
        const d = new Date(ts);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    // =========================================================================
    // 活跃判定
    // =========================================================================

    const Activity = {
        lastInput: Date.now(),

        /** 从「不在用」变成「在用」时调，见 Timer.resume。 */
        onWake: null,

        init() {
            const mark = () => {
                this.lastInput = Date.now();
                if (this.onWake) this.onWake();
            };
            // scroll 不冒泡，挂在捕获阶段才能收到内层滚动容器的滚动
            for (const type of ['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart', 'scroll']) {
                window.addEventListener(type, mark, { capture: true, passive: true });
            }
            // 切回来、点回窗口本身就是「在用」，不等下一次输入
            document.addEventListener('visibilitychange', () => { if (!document.hidden) mark(); });
            window.addEventListener('focus', mark);
            // 媒体事件不冒泡，同样挂捕获；开始播放不算「输入」，只唤醒计时
            document.addEventListener('playing', () => { if (this.onWake) this.onWake(); }, true);
        },

        /**
         * 标签页可见，并且：窗口聚焦且最近有输入，或者有带声音的媒体在播放。
         *
         * 放视频时不碰键鼠是常态，所以媒体播放顶替空闲判定；也顶替焦点判定 ——
         * 副屏放着视频、主屏在别的窗口打字，这段时间确实在看这个站。
         * 静音的不算：信息流里自动播放的静音视频、页面背景视频会让空闲永远不触发。
         */
        isActive(now) {
            if (document.visibilityState !== 'visible') return false;
            if (document.hasFocus() && now - this.lastInput <= CONFIG.idleMinutes * 60000) return true;
            return this.mediaPlaying();
        },

        mediaPlaying() {
            for (const m of document.querySelectorAll('video, audio')) {
                if (!m.paused && !m.ended && !m.muted && m.volume > 0) return true;
            }
            return false;
        },
    };

    // =========================================================================
    // 多标签租约
    // =========================================================================

    /**
     * 同一站点开多个标签页，时间只能算一份：GM 存储里每个站点一份租约 { id, ts }，
     * 拿着租约的标签页才计时、才写这个站点的时长键。
     *
     * 竞争：GM_setValue 在别的标签页里是异步可见的（Tampermonkey 经后台页转发），
     * 两个标签页可能同时看到「没人持有」、同时写入，各自以为拿到了。所以规则是
     * 「两头都确认」：一段时间只有在开头和结尾读到的租约都是自己时才算。同时写入的两方，
     * 存储收敛后只剩一个 id，输的一方下一次 tick 就读到别人的 id，那一段不算。
     * 代价是接手后第一秒要等确认（resume 时抢到的从抢到那一刻算起，不丢）。
     *
     * 不在用（切走、失焦、空闲、卸载）就主动释放，别的标签页下一次 tick 就能接手，
     * 不用等 leaseTtlMs；只有崩溃这种来不及释放的情况才靠过期。
     */
    const Lease = {
        id: Math.random().toString(36).slice(2) + Date.now().toString(36),
        key: () => `lease:${DOMAIN}`,

        /** 拿到或续上租约，返回现在是不是我持有。 */
        acquire(now) {
            const cur = GM_getValue(this.key(), null);
            const mine = cur && cur.id === this.id;
            // 系统时间被往回调过时 ts 在未来，用绝对值，免得一份「未来的租约」永远不过期
            if (cur && !mine && Math.abs(now - cur.ts) < CONFIG.leaseTtlMs) return false;
            if (!mine || now - cur.ts >= CONFIG.leaseRenewMs) GM_setValue(this.key(), { id: this.id, ts: now });
            return true;
        },

        /** 读一下现在是不是我（不写）。 */
        held() {
            const cur = GM_getValue(this.key(), null);
            return !!cur && cur.id === this.id;
        },

        release() {
            if (this.held()) GM_deleteValue(this.key());
        },
    };

    // =========================================================================
    // 计时
    // =========================================================================

    /**
     * 每秒 tick 一次：上一次 tick 到现在这段，如果两端都「在用且持有租约」就记进内存，
     * 攒够 flushMs 或页面要隐藏 / 卸载 / 交出租约时才写存储。
     */
    const Timer = {
        pending: new Map(),     // day → ms，还没落盘的
        lastTick: 0,
        lastFlush: 0,
        counting: false,        // 上一刻是否「在用且持有租约」

        start() {
            this.lastTick = this.lastFlush = Date.now();
            setInterval(() => this.tick(), CONFIG.tickMs);
            Activity.onWake = () => this.resume();
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) this.stop();
            });
            // 失焦：先把失焦前这段记上；还在放视频的话接着算
            window.addEventListener('blur', () => { this.stop(); this.resume(); });
            // pagehide 比 beforeunload / unload 可靠：bfcache、移动端切走都会触发
            window.addEventListener('pagehide', () => this.stop());
            window.addEventListener('pageshow', () => this.resume());
            this.resume();
        },

        /**
         * 切回来 / 点回窗口 / 空闲后第一次输入：从这一刻起算，不等下一次 tick，
         * 否则每次切换都丢最多 1 秒，一天切几百次就是几分钟。
         * 已经在算的时候不能重置 lastTick，否则把上次 tick 到现在这段丢了。
         */
        resume() {
            if (this.counting || Limit.blocked) return;
            const now = Date.now();
            if (!Activity.isActive(now) || !Lease.acquire(now)) return;
            this.counting = true;
            this.lastTick = now;
        },

        tick() {
            const now = Date.now();
            // 遮罩挡着的时候用不了这个站，不算
            const counting = !Limit.blocked && Activity.isActive(now) && Lease.acquire(now);
            if (counting && this.counting) this.add(this.lastTick, now);
            if (this.counting && !counting) {
                // 刚停下：可能是不在用了，也可能是租约被别的标签页抢走 —— 都先把攒的写掉
                this.flush();
                Lease.release();
            }
            this.counting = counting;
            this.lastTick = now;
            if (now - this.lastFlush >= CONFIG.flushMs) this.flush();
            Limit.check(now);
        },

        /** 今天在本站已用的毫秒数：已落盘的 + 自己内存里还没落盘的。 */
        usedMs(day) {
            return Store.getTime(day, DOMAIN) + (this.pending.get(day) || 0);
        },

        /** 页面隐藏 / 失焦 / 卸载：先把这一段补记上（事件可能夹在两次 tick 之间），再落盘、交出租约。 */
        stop() {
            const now = Date.now();
            if (this.counting && Lease.held()) this.add(this.lastTick, now);
            this.counting = false;
            this.lastTick = now;
            this.flush();
            Lease.release();
        },

        /**
         * 记一段 [from, to)。跨本地零点的按零点切开分别记到两天。
         *
         * 睡眠：合上盖子时定时器不跑，醒来后第一次 tick（或者先来的 blur / visibilitychange）
         * 看到的「上次 tick」是几小时前。正常 tick 间隔是 1 秒，所以间隔突然超过 maxGapMs
         * 就整段丢掉。判定放在这里而不是 tick 里：醒来后先触发的往往是锁屏解锁带来的
         * 失焦 / 可见性事件，走的是 stop()，不经过 tick。
         * 系统时间往回调（to < from）同样整段丢掉。
         */
        add(from, to) {
            if (to <= from) return;
            if (to - from > CONFIG.maxGapMs) {
                console.info(TAG, `间隔 ${Math.round((to - from) / 1000)} 秒，判定为睡眠 / 冻结，不计入`);
                return;
            }
            while (from < to) {
                const midnight = new Date(from);
                midnight.setHours(24, 0, 0, 0);     // 下一个本地零点；夏令时那天也对
                const end = Math.min(to, midnight.getTime());
                const day = dayKey(from);
                this.pending.set(day, (this.pending.get(day) || 0) + (end - from));
                from = end;
            }
        },

        flush() {
            this.lastFlush = Date.now();
            for (const [day, ms] of this.pending) Store.addTime(day, DOMAIN, Math.round(ms));
            this.pending.clear();
        },
    };

    // =========================================================================
    // 界面（shadow DOM）
    // =========================================================================

    /**
     * 提醒条、遮罩、统计面板都挂在同一个宿主元素的 shadow root 里：页面样式进不来，
     * 我们的样式也漏不出去。宿主挂在 <html> 下而不是 <body>，有的站点会整体替换 body。
     */
    const UI = {
        host: null,
        root: null,

        mount() {
            if (!this.host) {
                this.host = document.createElement('site-timer-ui');
                this.root = this.host.attachShadow({ mode: 'open' });
                this.root.innerHTML = `<style>${UI_CSS}</style>`;
            }
            if (!this.host.isConnected) document.documentElement.appendChild(this.host);
            return this.root;
        },

        el(html) {
            const t = document.createElement('template');
            t.innerHTML = html.trim();
            return t.content.firstElementChild;
        },
    };

    const UI_CSS = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .toast, .overlay, .card { font: 14px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; }
        .toast {
            position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; max-width: 320px;
            display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px;
            background: #fff8e1; border: 1px solid #f0c36d; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.15);
        }
        .toast button { all: unset; cursor: pointer; color: #8a6d3b; font-size: 16px; line-height: 1; }
        .overlay {
            position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
            background: rgba(20, 22, 26, .92); backdrop-filter: blur(6px);
        }
        .overlay .card { background: #fff; border-radius: 12px; padding: 28px 32px; width: min(420px, calc(100vw - 32px)); text-align: center; }
        .overlay h2 { margin: 0 0 8px; font-size: 22px; }
        .overlay p { margin: 0 0 20px; color: #59636e; }
        .actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
        .btn { all: unset; cursor: pointer; padding: 8px 14px; border-radius: 6px; border: 1px solid #d1d9e0; background: #f6f8fa; }
        .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
        .btn[disabled] { opacity: .45; cursor: not-allowed; }
    `;

    // =========================================================================
    // 每日上限
    // =========================================================================

    const Limit = {
        blocked: false,
        overlay: null,
        toast: null,
        savedOverflow: null,

        init() {
            // 遮罩期间页面自己再起播（自动连播、快捷键）也压回去；play 不冒泡，挂捕获
            document.addEventListener('play', e => {
                if (this.blocked && e.target instanceof HTMLMediaElement) e.target.pause();
            }, true);
            // 遮罩期间吞掉页面的键盘快捷键（空格翻页、播放器快捷键）；遮罩自己的按钮照常
            window.addEventListener('keydown', e => {
                if (this.blocked && e.target !== UI.host) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            }, true);
        },

        /** 今天本站的有效上限（毫秒，含「再给」的）；没设上限返回 0。 */
        limitMs(flags) {
            const minutes = Store.getLimits()[DOMAIN];
            return minutes ? (minutes + flags.extends * CONFIG.extendMinutes) * 60000 : 0;
        },

        /** 每次 tick 和设置变化后调：决定显示 / 收起遮罩，以及要不要提醒。 */
        check(now) {
            if (document.visibilityState !== 'visible') return;
            const day = dayKey(now);
            const flags = Store.getFlags(day, DOMAIN);
            const limit = this.limitMs(flags);
            // 没设上限、今天不再提醒、或者别的标签页里加了时间 / 改了上限 / 过了零点：收起
            if (!limit || flags.quiet) return this.unblock();
            const used = Timer.usedMs(day);
            if (used >= limit) return this.block(used, flags);
            this.unblock();
            if (limit - used <= CONFIG.warnMinutes * 60000 && flags.warned !== limit) {
                flags.warned = limit;   // 按上限值记：同一个上限只提醒一次，改了上限会重新提醒
                Store.setFlags(day, DOMAIN, flags);
                this.showToast(Math.ceil((limit - used) / 60000), Store.getLimits()[DOMAIN]);
            }
        },

        showToast(left, limitMin) {
            const root = UI.mount();
            if (this.toast) this.toast.remove();
            this.toast = UI.el(`<div class="toast" role="status">
                <div><b>${DOMAIN}</b> 今天还剩 <b>${left}</b> 分钟（每日上限 ${limitMin} 分钟）</div>
                <button type="button" data-act="close" title="关闭">×</button></div>`);
            const toast = this.toast;
            toast.querySelector('[data-act=close]').onclick = () => toast.remove();
            root.appendChild(toast);
            setTimeout(() => toast.remove(), CONFIG.toastMs);
        },

        block(used, flags) {
            const root = UI.mount();
            const usedMin = Math.floor(used / 60000);
            const left = CONFIG.maxExtends - flags.extends;
            if (!this.overlay) {
                this.overlay = UI.el(`<div class="overlay" role="dialog" aria-modal="true"><div class="card">
                    <h2></h2><p></p><div class="actions">
                    <button type="button" class="btn primary" data-act="extend"></button>
                    <button type="button" class="btn" data-act="quiet">今天不再提醒</button>
                    </div></div></div>`);
                this.overlay.querySelector('[data-act=extend]').onclick = () => this.extend();
                this.overlay.querySelector('[data-act=quiet]').onclick = () => this.quiet();
                root.appendChild(this.overlay);
            }
            this.overlay.querySelector('h2').textContent = `今日已用 ${usedMin} 分钟`;
            this.overlay.querySelector('p').textContent = `${DOMAIN} 的每日上限是 ${Store.getLimits()[DOMAIN]} 分钟` +
                (flags.extends ? `，已经再给过 ${flags.extends} 次` : '') + '。';
            const btn = this.overlay.querySelector('[data-act=extend]');
            btn.textContent = `再给 ${CONFIG.extendMinutes} 分钟（今天还能 ${left} 次）`;
            btn.disabled = left <= 0;
            if (this.blocked) return;

            this.blocked = true;
            if (this.toast) this.toast.remove();
            console.info(TAG, `已达上限，今日已用 ${usedMin} 分钟`);
            for (const m of document.querySelectorAll('video, audio')) if (!m.paused) m.pause();
            // 全屏的视频在 top layer 里，盖在任何 z-index 之上，遮罩会被它挡住
            if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
            this.savedOverflow = document.documentElement.style.overflow;
            document.documentElement.style.overflow = 'hidden';
            Timer.stop();
        },

        unblock() {
            if (!this.blocked) return;
            this.blocked = false;
            this.overlay.remove();
            this.overlay = null;
            document.documentElement.style.overflow = this.savedOverflow;
            Timer.resume();
        },

        extend() {
            const day = dayKey(Date.now());
            const flags = Store.getFlags(day, DOMAIN);
            if (flags.extends >= CONFIG.maxExtends) return;
            flags.extends++;
            flags.warned = this.limitMs(flags);    // 刚给的 5 分钟本来就在「最后 5 分钟」里，不再弹提醒
            Store.setFlags(day, DOMAIN, flags);
            this.check(Date.now());
        },

        quiet() {
            const day = dayKey(Date.now());
            Store.setFlags(day, DOMAIN, { ...Store.getFlags(day, DOMAIN), quiet: true });
            this.check(Date.now());
        },

        /** 菜单：给当前站点设上限。 */
        prompt() {
            const cur = Store.getLimits()[DOMAIN] || '';
            const input = window.prompt(`${DOMAIN} 每天最多用多少分钟？\n留空或填 0 取消上限。`, cur);
            if (input === null) return;
            const minutes = input.trim() === '' ? 0 : Number(input);
            if (!Number.isFinite(minutes) || minutes < 0) {
                window.alert(`「${input}」不是有效的分钟数`);
                return;
            }
            Store.setLimit(DOMAIN, Math.round(minutes));
            console.info(TAG, minutes > 0 ? `${DOMAIN} 每日上限 ${Math.round(minutes)} 分钟` : `${DOMAIN} 取消上限`);
            this.check(Date.now());
        },
    };

    // =========================================================================
    // 启动
    // =========================================================================

    const DOMAIN = mainDomain(location.hostname);
    if (!DOMAIN) return;
    console.info(TAG, '站点', DOMAIN);
    Activity.init();
    Limit.init();
    Timer.start();
    Limit.check(Date.now());
    GM_registerMenuCommand(`给当前站点设上限（${DOMAIN}）`, () => Limit.prompt());
})();
