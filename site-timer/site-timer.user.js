// ==UserScript==
// @name         网站使用时长统计与限制
// @name:zh-CN   网站使用时长统计与限制
// @name:en      Site Timer — Track and Limit Time Spent on Websites
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.11.10.2
// @description  统计每个网站「真正在用」的时间（标签页可见、窗口聚焦、最近有操作，播放中的视频也算），按主域名归并，同一站点开多个标签只算一份；可给站点设每日上限，快到时提醒、超时全屏遮罩；统计面板看今天 / 近 7 天排行，导出 CSV。
// @description:zh-CN  统计每个网站「真正在用」的时间（标签页可见、窗口聚焦、最近有操作，播放中的视频也算），按主域名归并，同一站点开多个标签只算一份；可给站点设每日上限，快到时提醒、超时全屏遮罩；统计面板看今天 / 近 7 天排行，导出 CSV。
// @description:en  Tracks the time you actually spend on each website (tab visible, window focused, recent input, or a video playing), grouped by registrable domain and counted once no matter how many tabs are open. Set a daily limit per site to get a heads-up near the end and a full-screen block when time is up. A stats panel ranks sites for today and the last 7 days and exports CSV.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
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
        },

        /** 标签页可见、窗口聚焦、最近有输入。 */
        isActive(now) {
            if (document.visibilityState !== 'visible') return false;
            if (!document.hasFocus()) return false;
            return now - this.lastInput <= CONFIG.idleMinutes * 60000;
        },
    };

    // =========================================================================
    // 计时
    // =========================================================================

    /**
     * 每秒 tick 一次：上一次 tick 到现在这段，如果两端都处于「在用」状态就记进内存，
     * 攒够 flushMs 或页面要隐藏 / 卸载时才写存储。
     */
    const Timer = {
        pending: new Map(),     // day → ms，还没落盘的
        lastTick: 0,
        lastFlush: 0,
        wasActive: false,

        start() {
            this.lastTick = this.lastFlush = Date.now();
            this.wasActive = Activity.isActive(this.lastTick);
            setInterval(() => this.tick(), CONFIG.tickMs);
            Activity.onWake = () => this.resume();
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) this.stop();
            });
            window.addEventListener('blur', () => this.stop());
            // pagehide 比 beforeunload / unload 可靠：bfcache、移动端切走都会触发
            window.addEventListener('pagehide', () => this.stop());
            window.addEventListener('pageshow', () => this.resume());
        },

        /**
         * 切回来 / 点回窗口 / 空闲后第一次输入：从这一刻起算，不等下一次 tick 确认，
         * 否则每次切换都丢最多 1 秒，一天切几百次就是几分钟。
         * 已经在算的时候不能重置 lastTick，否则把上次 tick 到现在这段丢了。
         */
        resume() {
            if (this.wasActive) return;
            const now = Date.now();
            if (!Activity.isActive(now)) return;
            this.wasActive = true;
            this.lastTick = now;
        },

        tick() {
            const now = Date.now();
            const active = Activity.isActive(now);
            // 只算「上一刻和这一刻都在用」的区间：刚变活跃的那一秒不算，宁少勿多
            if (active && this.wasActive) this.add(this.lastTick, now);
            this.wasActive = active;
            this.lastTick = now;
            if (now - this.lastFlush >= CONFIG.flushMs) this.flush();
        },

        /** 页面隐藏 / 失焦 / 卸载：先把这一段补记上（事件可能夹在两次 tick 之间），再落盘。 */
        stop() {
            const now = Date.now();
            if (this.wasActive) this.add(this.lastTick, now);
            this.wasActive = false;
            this.lastTick = now;
            this.flush();
        },

        add(from, to) {
            if (to <= from) return;
            const day = dayKey(from);
            this.pending.set(day, (this.pending.get(day) || 0) + (to - from));
        },

        flush() {
            this.lastFlush = Date.now();
            for (const [day, ms] of this.pending) Store.addTime(day, DOMAIN, Math.round(ms));
            this.pending.clear();
        },
    };

    // =========================================================================
    // 启动
    // =========================================================================

    const DOMAIN = mainDomain(location.hostname);
    if (!DOMAIN) return;
    console.info(TAG, '站点', DOMAIN);
    Activity.init();
    Timer.start();
})();
