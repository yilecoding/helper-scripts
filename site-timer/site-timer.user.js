// ==UserScript==
// @name         网站使用时长统计与限制
// @name:zh-CN   网站使用时长统计与限制
// @name:en      Site Timer — Track and Limit Time Spent on Websites
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.11.07.1
// @description  统计每个网站「真正在用」的时间（标签页可见、窗口聚焦、最近有操作，播放中的视频也算），按主域名归并，同一站点开多个标签只算一份；可给站点设每日上限，快到时提醒、超时全屏遮罩；统计面板看今天 / 近 7 天排行，导出 CSV。
// @description:zh-CN  统计每个网站「真正在用」的时间（标签页可见、窗口聚焦、最近有操作，播放中的视频也算），按主域名归并，同一站点开多个标签只算一份；可给站点设每日上限，快到时提醒、超时全屏遮罩；统计面板看今天 / 近 7 天排行，导出 CSV。
// @description:en  Tracks the time you actually spend on each website (tab visible, window focused, recent input, or a video playing), grouped by registrable domain and counted once no matter how many tabs are open. Set a daily limit per site to get a heads-up near the end and a full-screen block when time is up. A stats panel ranks sites for today and the last 7 days and exports CSV.
// @author       壹樂（V：ita1125）
// @match        http://*/*
// @match        https://*/*
// @noframes
// @grant        none
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

    const CONFIG = {};

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
    // 启动
    // =========================================================================

    const DOMAIN = mainDomain(location.hostname);
    if (!DOMAIN) return;
    console.info(TAG, '站点', DOMAIN);
})();
