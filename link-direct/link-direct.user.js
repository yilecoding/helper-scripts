// ==UserScript==
// @name         外链直达｜跳过知乎/掘金/CSDN 等站点的「即将离开」中转页
// @name:zh-CN   外链直达｜跳过知乎/掘金/CSDN 等站点的「即将离开」中转页
// @name:en      Link Direct | Skip "You are leaving…" redirect pages on Zhihu, Juejin, CSDN and more
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.03.25.1
// @description  把页面上指向中转页（link.zhihu.com、link.juejin.cn、link.csdn.net……）的外链直接改成真实地址，点了就到，不再停在「安全提醒」页。
// @description:zh-CN  把页面上指向中转页（link.zhihu.com、link.juejin.cn、link.csdn.net……）的外链直接改成真实地址，点了就到，不再停在「安全提醒」页。
// @description:en  Rewrites outbound links that go through redirect/interstitial pages (link.zhihu.com, link.juejin.cn, link.csdn.net…) to their real destination, so a click takes you straight there.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        none
// @license      CC BY-NC-SA
// @run-at       document-start
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/link-direct/link-direct.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/link-direct/link-direct.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

(function () {
    'use strict';

    /** 统一日志前缀，控制台过滤框输入「外链直达」即可只看本脚本的日志。 */
    const TAG = '[外链直达]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        debug: false,  // true 时每改一个链接打一行日志
    };

    // =========================================================================
    // 规则表
    // =========================================================================

    /*
     * 每条规则：
     *   name   展示用
     *   hosts  中转页的 hostname（精确匹配，不含端口）
     *   path   pathname 正则
     *   params 按顺序尝试的 query 参数名，取第一个有值的
     */
    const RULES = [
        { name: '知乎', hosts: ['link.zhihu.com'], path: /^\/?$/, params: ['target'] },
        { name: '掘金', hosts: ['link.juejin.cn'], path: /^\/?$/, params: ['target'] },
        { name: 'CSDN', hosts: ['link.csdn.net'], path: /^\/?$/, params: ['target'] },
    ];

    /** hostname → 规则列表。绝大多数链接的 host 不在表里，一次 Map 查询就能放过。 */
    const RULES_BY_HOST = new Map();
    for (const rule of RULES) {
        for (const h of rule.hosts) {
            if (!RULES_BY_HOST.has(h)) RULES_BY_HOST.set(h, []);
            RULES_BY_HOST.get(h).push(rule);
        }
    }

    // =========================================================================
    // 解析
    // =========================================================================

    function findRule(url) {
        const list = RULES_BY_HOST.get(url.hostname);
        if (!list) return null;
        return list.find(r => r.path.test(url.pathname)) || null;
    }

    /**
     * 中转链接 → 真实地址；不是中转链接或取不到就返回 null。
     * href 必须是绝对地址（传 a.href 而不是 getAttribute('href')）。
     */
    function resolve(href) {
        let url;
        try { url = new URL(href); } catch (e) { return null; }
        const rule = findRule(url);
        if (!rule) return null;
        for (const p of rule.params) {
            const v = url.searchParams.get(p);
            if (v) return { rule, target: v };
        }
        return null;
    }

    // =========================================================================
    // 宿主页：改写 <a href>
    // =========================================================================

    const done = new WeakSet();
    let rewritten = 0;

    function fixAnchor(a) {
        const r = resolve(a.href);
        if (!r) return false;
        if (CONFIG.debug) console.log(TAG, `[${r.rule.name}]`, a.href, '→', r.target);
        a.href = r.target;
        if (!done.has(a)) { done.add(a); rewritten++; }
        return true;
    }

    function scan(root) {
        for (const a of root.querySelectorAll('a[href]')) fixAnchor(a);
    }

    function boot() {
        scan(document);
        console.log(TAG, `已改写 ${rewritten} 个链接`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
