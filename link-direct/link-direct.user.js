// ==UserScript==
// @name         外链直达｜跳过知乎/掘金/CSDN 等站点的「即将离开」中转页
// @name:zh-CN   外链直达｜跳过知乎/掘金/CSDN 等站点的「即将离开」中转页
// @name:en      Link Direct | Skip "You are leaving…" redirect pages on Zhihu, Juejin, CSDN and more
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.03.28.3
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
        // —— 国内社区 / 博客 ——
        { name: '知乎', hosts: ['link.zhihu.com'], path: /^\/?$/, params: ['target'] },
        { name: '掘金', hosts: ['link.juejin.cn'], path: /^\/?$/, params: ['target'] },
        { name: 'CSDN', hosts: ['link.csdn.net'], path: /^\/?$/, params: ['target'] },
        { name: '简书', hosts: ['www.jianshu.com'], path: /^\/go-wild\/?$/, params: ['url'] },
        { name: 'Gitee', hosts: ['gitee.com'], path: /^\/link\/?$/, params: ['target'] },
        { name: '开源中国', hosts: ['www.oschina.net'], path: /^\/action\/GoToLink\/?$/i, params: ['url'] },
        { name: '爱发电', hosts: ['afdian.com', 'afdian.net', 'ifdian.net'], path: /^\/link\/?$/, params: ['target'] },
        { name: '少数派', hosts: ['sspai.com'], path: /^\/link\/?$/, params: ['target'] },
        { name: 'InfoQ', hosts: ['www.infoq.cn', 'xie.infoq.cn'], path: /^\/link\/?$/, params: ['target'] },
        { name: '力扣', hosts: ['leetcode.cn'], path: /^\/link\/?$/, params: ['target'] },
        { name: '链滴', hosts: ['link.ld246.com'], path: /^\/forward\/?$/, params: ['goto'] },
        { name: '豆瓣', hosts: ['www.douban.com'], path: /^\/link2\/?$/, params: ['url'] },
        { name: '百度贴吧', hosts: ['tieba.baidu.com'], path: /^\/mo\/q\/checkurl\/?$/, params: ['url'] },
        { name: '微博', hosts: ['weibo.cn'], path: /^\/sinaurl\/?$/, params: ['u', 'toasturl'] },
        /*
         * SegmentFault 的 enc 参数是服务端加密的，前端解不开。
         * 部分链接同时带明文 url 参数，有就用；只有 enc 的就不处理，交给站点自己跳。
         */
        { name: 'SegmentFault', hosts: ['link.segmentfault.com'], path: /^\/?$/, params: ['url'] },

        // —— 腾讯系 ——
        // QQ / TIM 聊天里的链接：middlem.html 用 pfurl，ios.html / pc.html 用 url
        { name: 'QQ', hosts: ['c.pc.qq.com'], path: /^\/(middlem|ios|pc)\.html$/, params: ['pfurl', 'url'] },
        { name: '腾讯文档', hosts: ['docs.qq.com'], path: /^\/scenario\/link\.html$/, params: ['url'] },
        { name: '微信开放社区', hosts: ['developers.weixin.qq.com'], path: /^\/community\/middlepage\/href\/?$/, params: ['href'] },
        { name: 'QQ 邮箱', hosts: ['mail.qq.com', 'wx.mail.qq.com'], path: /^\/cgi-bin\/readtemplate\/?$/, params: ['gourl'] },

        // —— 文档 / 办公 ——
        { name: '语雀', hosts: ['www.yuque.com'], path: /^\/r\/goto\/?$/, params: ['url'] },
        { name: '金山文档', hosts: ['www.kdocs.cn'], path: /^\/office\/link\/?$/, params: ['target'] },

        // —— 海外 ——
        // Google 搜索结果里是 /url?url=…&sa=…，其它产品（Gmail、文档）里多是 /url?q=…
        { name: 'Google', hosts: ['www.google.com', 'www.google.com.hk', 'google.com'], path: /^\/url\/?$/, params: ['q', 'url'] },
        { name: 'YouTube', hosts: ['www.youtube.com', 'm.youtube.com', 'youtube.com'], path: /^\/redirect\/?$/, params: ['q'] },
        { name: 'Steam', hosts: ['steamcommunity.com'], path: /^\/linkfilter\/?$/, params: ['url', 'u'] },
        { name: 'Facebook', hosts: ['l.facebook.com', 'lm.facebook.com'], path: /^\/l\.php$/, params: ['u'] },
        { name: 'Instagram', hosts: ['l.instagram.com'], path: /^\/?$/, params: ['u'] },
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

    /**
     * 目标地址只放行 http/https，并返回规范化后的绝对地址。
     *
     * 中转参数完全由链接作者控制。不校验的话，target=javascript:… 会被我们亲手
     * 写进 href —— 原本站点的中转页会拦下它，经过脚本反而成了能点的 XSS。
     * 相对地址（/foo、//evil.com）同理拒绝：中转参数里出现它们本身就不正常。
     */
    function sanitize(raw) {
        let u;
        try { u = new URL(raw); } catch (e) { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.href;
    }

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
            if (!v) continue;
            const target = sanitize(v.trim());
            if (!target) {
                console.warn(TAG, `[${rule.name}] 拒绝非 http(s) 目标：`, v);
                return null;
            }
            return { rule, target };
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
