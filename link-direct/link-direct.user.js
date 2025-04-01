// ==UserScript==
// @name         外链直达｜跳过知乎/掘金/CSDN 等站点的「即将离开」中转页
// @name:zh-CN   外链直达｜跳过知乎/掘金/CSDN 等站点的「即将离开」中转页
// @name:en      Link Direct | Skip "You are leaving…" redirect pages on Zhihu, Juejin, CSDN and more
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.04.01.6
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
     *   decode 可选，参数值 → 地址字符串（站点自己的编码方式，如 Bing 的 a1+base64）
     *
     * 参数值统一还会经过 unwrap()：多重 URL 编码逐层剥，纯 base64 也试着解一次。
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
        // Bing 搜索结果：u=a1<base64url>，a1 是固定前缀
        { name: 'Bing', hosts: ['www.bing.com', 'cn.bing.com'], path: /^\/ck\/a\/?$/, params: ['u'], decode: v => (v.startsWith('a1') ? base64(v.slice(2)) || v : v) },
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

    /** base64 / base64url → UTF-8 字符串；不是合法 base64 返回 null。 */
    function base64(s) {
        if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
        let b = s.replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        try {
            const bin = atob(b);
            const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (e) {
            return null;
        }
    }

    const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

    /**
     * 剥掉多余的编码层。
     *
     * 只在「还没有协议头」时继续 decode：真实地址里本来就可能有 %20、%2F，
     * 已经是 https://… 了还往下解，会把目标地址本身的编码也剥掉，改出一个错的链接。
     * 安全校验在这之后做，所以 javascript%253A… 这种多重编码绕不过去。
     */
    function unwrap(v) {
        for (let i = 0; i < 3 && !HAS_SCHEME.test(v); i++) {
            if (/%[0-9a-f]{2}/i.test(v)) {
                try { v = decodeURIComponent(v); continue; } catch (e) { break; }
            }
            const b = base64(v);
            if (b && /^https?:\/\//i.test(b)) { v = b; continue; }
            break;
        }
        return v;
    }

    function findRule(url) {
        const list = RULES_BY_HOST.get(url.hostname);
        if (!list) return null;
        return list.find(r => r.path.test(url.pathname)) || null;
    }

    /** 中转套中转（Google 结果指向知乎中转页之类）最多往里追这么多层。 */
    const MAX_DEPTH = 3;

    /**
     * 中转链接 → 真实地址；不是中转链接或取不到就返回 null。
     * href 必须是绝对地址（传 a.href 而不是 getAttribute('href')）。
     */
    function resolve(href, depth = 0) {
        let url;
        try { url = new URL(href); } catch (e) { return null; }
        const rule = findRule(url);
        if (!rule) return null;
        for (const p of rule.params) {
            let v = url.searchParams.get(p);
            if (!v) continue;
            if (rule.decode) v = rule.decode(v);
            const target = sanitize(unwrap(v.trim()));
            if (!target) {
                console.warn(TAG, `[${rule.name}] 拒绝非 http(s) 目标：`, v);
                return null;
            }
            const inner = depth < MAX_DEPTH ? resolve(target, depth + 1) : null;
            return inner ? { rule, target: inner.target } : { rule, target };
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

    /**
     * 动态内容：SPA 翻页、评论区懒加载、「展开全文」都是后插进来的。
     * 除了新增节点，还要盯 href 属性本身 —— 有的站点先渲染直链、稍后再把 href
     * 换成中转地址（或者复用同一个 <a> 换内容），只看 childList 会漏掉。
     * 我们自己改 href 也会触发一次属性变更，但改完的地址不再命中规则，不会死循环。
     */
    function observe() {
        new MutationObserver(records => {
            for (const rec of records) {
                if (rec.type === 'attributes') {
                    if (rec.target.tagName === 'A') fixAnchor(rec.target);
                    continue;
                }
                for (const n of rec.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    if (n.tagName === 'A' && n.hasAttribute('href')) fixAnchor(n);
                    if (n.firstElementChild) scan(n);
                }
            }
        }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    }

    /**
     * 点击兜底。两类情况 MutationObserver 管不到：
     *   1. 链接在 Shadow DOM 里 —— observer 和 querySelectorAll 都看不进 shadow root，
     *      但事件的 composedPath() 能拿到里面真正被点的 <a>；
     *   2. 站点在 mousedown 里临时改 href（Google 结果页的老套路）。
     *      真实点击时 observer 会在站点监听器返回后的微任务里改回来（测试里实测如此），
     *      但脚本合成的点击（el.click()）期间微任务不会插队，靠 click 捕获再修一遍。
     * auxclick 是中键「新标签打开」，contextmenu 是右键「复制链接地址」，都要覆盖。
     */
    function onPointer(e) {
        for (const el of e.composedPath()) {
            if (el.tagName === 'A' && el.hasAttribute && el.hasAttribute('href')) { fixAnchor(el); return; }
        }
    }

    /**
     * 站点自己用 window.open(中转地址) 打开新窗口（拦掉了 <a> 的默认行为）时，
     * 改 href 没用，只能在 open 这一层换地址。
     */
    function hookWindowOpen() {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const orig = w.open;
        if (typeof orig !== 'function') return;
        w.open = function (url, ...rest) {
            if (url) {
                let abs = null;
                try { abs = new URL(String(url), location.href).href; } catch (e) { /* 交给原函数报错 */ }
                const r = abs && resolve(abs);
                if (r) {
                    if (CONFIG.debug) console.log(TAG, `[${r.rule.name}] window.open`, abs, '→', r.target);
                    url = r.target;
                }
            }
            return orig.call(this, url, ...rest);
        };
    }

    for (const type of ['mousedown', 'click', 'auxclick', 'contextmenu']) {
        window.addEventListener(type, onPointer, true);
    }
    hookWindowOpen();

    function boot() {
        scan(document);
        observe();
        console.log(TAG, `已改写 ${rewritten} 个链接`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
