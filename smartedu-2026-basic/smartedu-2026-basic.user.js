// ==UserScript==
// @name         2026年暑期教师研修|国家中小学智慧教育平台|自动连播助手
// @name:zh-CN   2026年暑期教师研修|国家中小学智慧教育平台|自动连播助手
// @name:en      SmartEdu (basic.smartedu.cn) Auto-Play Assistant | China National Smart Education Platform
// @namespace    自动连播 自动答题
// @version      2025.03.06.5
// @description  适配 basic.smartedu.cn（React + Fish + video.js）。加载后弹出课程目录，点一门即开始：自动展开章节、自动播放、播完立即续播下一个、可选学完自动进下一门、课堂练习自动选第一个。支持后台标签页持续播放。课程清单从平台接口自动发现。
// @description:zh-CN  适配 basic.smartedu.cn（React + Fish + video.js）。加载后弹出课程目录，点一门即开始：自动展开章节、自动播放、播完立即续播下一个、可选学完自动进下一门、课堂练习自动选第一个。支持后台标签页持续播放。课程清单从平台接口自动发现。
// @description:en  Auto-play helper for basic.smartedu.cn — China's National Smart Education Platform for Primary & Secondary Schools (国家中小学智慧教育平台 SmartEdu). Built for the 2026 Summer Teacher Training (暑期教师研修): expands chapters, auto-plays videos, jumps to the next lesson the moment one ends, optionally auto-advances to the next course, auto-picks the first answer on in-class quizzes, and keeps playing in a background tab. Course list is auto-discovered from the platform API — no manual course IDs needed.
// @author       壹樂（V：ita1125）
// @match        https://basic.smartedu.cn/*
// @icon         https://basic.smartedu.cn/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @license      CC BY-NC-SA
// @run-at       document-start
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/smartedu-2026-basic/smartedu-2026-basic.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/smartedu-2026-basic/smartedu-2026-basic.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts
// Tampermonkey 已通过上方 @updateURL 自动检查更新，无需手动操作。

/*
 * 两个容易踩的点，先说明：
 *
 * 1. @run-at 是 document-start，不是 document-idle。
 *    后台保活要在平台注册 visibilitychange 监听「之前」抢先伪装，晚了拦不住。
 *    因此 DOM 相关的启动逻辑要等 DOMContentLoaded（见文件末尾）。
 *
 * 2. @match 是整站 basic.smartedu.cn/*，不是只匹配 /teacherTraining/*。
 *    因为这个 SPA 的路由会在参数不合预期时把路径重写成 /，只留 query
 *    （地址栏变成 https://basic.smartedu.cn/?courseId=…）。
 *    只匹配 /teacherTraining/* 的话，脚本在那种情况下压根不会运行。
 *    见 healPath()：检测到这种情况会自己把路径修回来。
 */

(function () {
    'use strict';

    /**
     * 统一日志前缀，所有 console.* 输出都带上它。
     * 调试时在浏览器控制台过滤框输入「研修助手」即可只看本脚本的日志，
     * 不会和页面自己的日志混在一起。
     */
    const TAG = '[研修助手]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        /** 专题 ID。换专题只改这三项。 */
        trainId: 'dc6d78f2-bad8-4d09-b8da-0d758803dbe4', // 2026年"暑期教师研修"专题（基础教育）
        libraryId: 'bb042e69-9a11-49a1-af22-0c3fab2e92b9',
        tag: '2026年“暑期教师研修”专题（基础教育）',

        tickInterval: 4000,  // 心跳间隔（毫秒）
        navDelay: 1500,  // 翻课前延迟，过快会触发平台"多开"提醒
        defaultRate: 2.0,    // 默认倍速，可在面板里改

        /*
         * 后台保活（切标签后继续播）。三个开关对应三个不同的失效原因：
         *   spoofVisibility  平台若监听 visibilitychange 就会暂停 → 伪装成始终可见
         *   workerTicker     后台标签 setInterval 被节流到 1 次/分钟 → 心跳移进 Worker
         *   preferUnmuted    静音页面拿不到 Chrome 的节流豁免 → 用极小音量代替静音
         */
        spoofVisibility: true,
        blockBlurEvents: true,  // 连 window blur/focus 一起拦。个别站点 UI 可能受影响，可关
        workerTicker: true,
        preferUnmuted: true,  // 有声自动播放被拒时会自动回退静音，不会卡死
        volume: 0.01,

        autoAnswer: true,   // 课堂练习自动选第一个（无题库）
        skipDocuments: true,   // 只处理视频，跳过文档
        logMaxLines: 200,

        /*
         * 自愈补偿：长时间运行会变不稳定，靠"该刷新就刷新"兜住。
         *
         * 依据不是猜的：平台每弹一次窗就往 DOM 里留一个不回收的残骸，
         * 实测 [class*="modal"] 能涨到近 300 个；播放器还反复换源，
         * 监听器和内存只增不减。跑一整夜必然越来越沉。
         *
         * 刷新是安全的 —— 进度和运行状态都存在 GM 里，刷新后会自动接着跑。
         */
        reloadEveryNVideos: 5,      // 每看完 N 个视频例行刷新一次。0 = 关闭
        reloadOnErrorStreak: 3,     // 连续 N 轮抛异常就刷新
        stuckTimeoutMs: 180000,     // 播放进度卡住这么久就刷新（3 分钟）
        minReloadGapMs: 60000,      // 两次自动刷新的最小间隔，防刷新循环
        maxReloadsPerSession: 40,   // 单个标签页内自动刷新次数上限
    };

    // =========================================================================
    // 后台保活：必须在最前面执行，抢在平台注册监听之前
    // =========================================================================

    const KeepAlive = (() => {
        const notes = [];

        function spoofVisibility() {
            try {
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
                Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => false });
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
                Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
                document.hasFocus = () => true;
                notes.push('visibility 已伪装');
            } catch (e) {
                notes.push('visibility 伪装失败：' + e.message);
            }

            // 捕获阶段吞掉事件。document-start 时我们是第一个注册的，能拦住后来者。
            const swallow = (e) => { e.stopImmediatePropagation(); };
            const events = ['visibilitychange', 'webkitvisibilitychange'];
            if (CONFIG.blockBlurEvents) events.push('blur', 'focus', 'focusout');
            for (const type of events) {
                document.addEventListener(type, swallow, true);
                window.addEventListener(type, swallow, true);
            }
            notes.push(`已拦截 ${events.length} 类可见性事件`);
        }

        /**
         * 心跳。后台标签里页面的 setInterval 会被节流到 1 次/分钟，
         * 但 Worker 里的定时器不受同样的 intensive throttling，所以把心跳移进去。
         * Worker 建不起来（CSP 等）就回落到普通 setInterval。
         */
        function startTicker(fn, interval) {
            if (CONFIG.workerTicker) {
                try {
                    const src = 'let t;onmessage=(e)=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data)}';
                    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
                    const w = new Worker(url);
                    w.onmessage = () => fn();
                    w.postMessage(interval);
                    setTimeout(() => URL.revokeObjectURL(url), 5000);
                    return 'Worker 心跳';
                } catch (e) {
                    notes.push('Worker 心跳不可用：' + e.message);
                }
            }
            setInterval(fn, interval);
            return '普通定时器心跳（后台会被节流）';
        }

        if (CONFIG.spoofVisibility) spoofVisibility();
        return { startTicker, notes };
    })();

    /*
     * 选择器
     * ✓ 已在实页验证    ? 需在播放页确认（写成候选数组，命中哪个用哪个）
     * 类名带构建哈希的（index-module_xxx_A1b2c）一律不用，发版即变。
     */
    const SEL = {
        chapter: '.fish-collapse-item',             // ✓
        chapterHeader: '.fish-collapse-header',     // ✓
        chapterActive: 'fish-collapse-item-active', // ✓ class 名，非选择器
        resource: '.resource-item',                 // ✓
        resourceActive: '.resource-item-active',    // ✓ 当前正在播放的那一行，无哈希
        /**
         * ✓ 状态图标。状态不在 .status-icon 自己身上，而在它内部的 <i> 上，
         * 读 .status-icon 的 className / title 永远是空字符串。
         *
         * 三种状态均已实测确认（2026-08-11 登录态）：
         *   已学完 <i class="iconfont icon_checkbox_fill"   title="已学完">
         *   进行中 <i class="iconfont icon_processing_fill" title="进行中">  + 一个跳动条形 svg
         *   未开始 <i class="iconfont icon_checkbox_linear" title="未开始">
         *
         * ⚠ 注意「进行中」的 class 里也带 fill。
         * 关键词必须写 checkbox_fill，写成 fill 会把进行中误判成已学完，整门课被跳过。
         */
        statusIcon: '.status-icon',                 // ✓

        /** ✓ 播放器是 video.js。容器 .fish-video / .course-video 不带哈希，用来精确定位，
         *  避免抓到页面上别的 video。 */
        video: ['.fish-video video', '.course-video video', '[class*="course-player"] video', 'video'],
        /** ✓ video.js 的按钮。旧平台的 .xgplayer-* 在这里全无效。 */
        playButton: ['.vjs-big-play-button', '.video-js .vjs-play-control', '[title="Play"]'],

        modal: ['.fish-modal', '[class*="fish-modal"]', '[role="dialog"]', '[class*="modal"]'],           // ?
        quizOption: ['.question-body ul li', '[class*="question"] [class*="option"]', '[class*="answer-item"]'], // ?
        quizSubmit: ['#submit', '[class*="question"] [class*="submit"]'],                                  // ?
        startStudy: ['[class*="start-study"]', '[class*="startStudy"]'],                                   // ?
    };

    /**
     * 判定"已学完"。2026-08-11 实测：平台用 iconfont 的 icon_checkbox_fill + title="已学完"。
     * title 是首要依据（最不容易随改版变），class 关键字是备用。
     */
    const DONE_TEXTS = ['已学完', '已完成', '学习完成', '已学习'];
    const DONE_TOKENS = ['checkbox_fill', 'finish', 'complete', 'done', 'learned', 'studied'];

    /** 2026-08-11 实测抓取。接口不可用时的回落清单。total 含视频与文档，仅作参考。 */
    const FALLBACK_COURSES = [
        { id: '79d28f6c-0b8a-443d-bdda-a78165c462f3', name: '大力弘扬教育家精神', maxPeriod: 2, total: 142 },
        { id: '165d9433-5486-43e4-926e-3f33b92635e4', name: '数智素养提升', maxPeriod: 3, total: 357 },
        { id: 'b2ec4202-c747-4ad2-a1b1-35a6c277c856', name: '科学素养提升', maxPeriod: 1, total: 23 },
        { id: 'ca2a448a-5ff5-4183-92c2-6506f6696228', name: '心理健康教育能力提升', maxPeriod: 1, total: 9 },
        { id: 'a09d7192-d7d6-4451-8828-a96d3a5e66ca', name: '学校美育浸润行动', maxPeriod: -1, total: 30 },
        { id: '6a46308e-17ff-456a-a320-b5bdb494e93d', name: '学科美育教学改革专题培训', maxPeriod: -1, total: 25 },
        { id: 'f120b8f7-1768-440e-ae79-3e79dd0650f2', name: '有效开展每日综合体育活动', maxPeriod: -1, total: 11 },
        { id: '0b69a573-7585-4450-8bae-48d3e3fd5cc1', name: '跨学科实验设计', maxPeriod: -1, total: 18 },
        { id: '12a71d1f-8c22-418e-8ffe-ab0a6741fd74', name: '孤独症教育骨干教师培训', maxPeriod: -1, total: 73 },
        { id: 'c7044ffc-64b4-44b9-a866-0c117ff104d1', name: '融合教育通识课程', maxPeriod: -1, total: 112 },
        { id: '87102185-fa21-4565-ad94-ade986c1c141', name: '面向普教校长与教师的融合教育通识课实录', maxPeriod: -1, total: 41 },
    ];

    // =========================================================================
    // 工具
    // =========================================================================

    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const textOf = (node) => (node ? (node.textContent || '').trim() : '');

    function isVisible(node) {
        if (!node || !node.getClientRects || !node.getClientRects().length) return false;
        const s = getComputedStyle(node);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    }

    /** 按候选选择器依次尝试，可见的优先。写成数组是为了抗改版。 */
    function pick(candidates, root = document) {
        for (const sel of candidates) {
            const all = $$(sel, root);
            const hit = all.find(isVisible) || all[0];
            if (hit) return hit;
        }
        return null;
    }

    function clickAny(candidates, root = document) {
        const node = pick(candidates, root);
        if (!node) return false;
        node.click();
        return true;
    }

    /**
     * 元素是否处于禁用态。
     * 「学习指南」弹窗的「我知道了」会先禁用一段时间（实测显示「12s 后可手动关闭」），
     * 对 disabled 按钮调 click() 不报错也不生效——不排除掉就会误以为已经点成功了。
     */
    function isDisabled(node) {
        if (!node) return false;
        if (node.disabled === true) return true;
        if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') return true;
        const cls = typeof node.className === 'string' ? node.className : '';
        if (/disabled/i.test(cls)) return true;
        const btn = node.closest && node.closest('button');
        return !!(btn && btn !== node && btn.disabled);
    }

    /**
     * 完整模拟一次鼠标点击。
     * 只调 .click() 对某些组件不生效（它们监听的是 mousedown/pointerdown），
     * 而 .click() 又不会报错，很容易误判成"点成功了"。
     */
    function realClick(node) {
        /*
         * 千万不要传 view: window。
         * 油猴沙箱里的 window 是代理对象而非真正的 Window，
         * new MouseEvent({ view: window }) 会抛
         *   Failed to construct 'MouseEvent': Failed to convert value to 'Window'
         * 异常冒泡出去会让整轮 tick 中断，表现为「弹窗一直关不掉」。
         * view 是可选属性，点击处理用不到它。
         *
         * 这个坑只在油猴环境出现——直接往页面里注入脚本测是测不出来的。
         */
        const opts = { bubbles: true, cancelable: true };
        try {
            node.dispatchEvent(new PointerEvent('pointerdown', opts));
            node.dispatchEvent(new MouseEvent('mousedown', opts));
            node.dispatchEvent(new PointerEvent('pointerup', opts));
            node.dispatchEvent(new MouseEvent('mouseup', opts));
        } catch {
            // 构造事件失败不能影响下面的 click()，那才是最后的保底
        }
        node.click();
    }

    /** 按文案找可点元素。按钮文案比 class 稳定得多，改版后仍能命中。 */
    function clickByText(texts, scope = document) {
        const nodes = $$('button, a, .fish-btn, [role="button"], span, div', scope);
        for (const t of texts) {
            const hit = nodes.find((n) => isVisible(n) && textOf(n) === t && !isDisabled(n));
            if (hit) { realClick(hit); return t; }
        }
        return null;
    }

    // =========================================================================
    // 状态（GM 持久化）
    // =========================================================================

    const NS = 'sedu2026:';
    const g = (k, d) => GM_getValue(NS + k, d);
    const s = (k, v) => GM_setValue(NS + k, v);

    const State = {
        /** 是否正在自动连播（点了目录里的课程才为 true） */
        get running() { return g('running', false) === true; },
        set running(v) { s('running', !!v); },
        /** 学完一门是否自动进下一门 */
        get autoChain() { return g('autoChain', true) === true; },
        set autoChain(v) { s('autoChain', !!v); },
        get rate() { return Number(g('rate', CONFIG.defaultRate)) || CONFIG.defaultRate; },
        set rate(v) { s('rate', Number(v) || CONFIG.defaultRate); },
        get courses() { return g('courses', null); },
        set courses(v) { s('courses', v); },
        get panelOpen() { return g('panelOpen', true) === true; },
        set panelOpen(v) { s('panelOpen', !!v); },
        get logOpen() { return g('logOpen', true) === true; },
        set logOpen(v) { s('logOpen', !!v); },

        /**
         * 本脚本亲眼看到"播完"的资源标题，按课程分开记。
         * 新版 DOM 读不到百分比（.status-icon 是空 div），完成判定主要靠这本账。
         */
        watched(courseId) { return g('watched:' + courseId, []) || []; },
        markWatched(courseId, title) {
            if (!title) return;
            const list = this.watched(courseId);
            if (!list.includes(title)) {
                list.push(title);
                s('watched:' + courseId, list);
            }
        },
        /**
         * 平台真实进度快照 {done, total}，每次访问课程页时更新。
         *
         * 为什么要缓存：面板要显示 11 门课的进度，但只有「当前打开的这门」
         * 能从 DOM 读到平台状态。所以每访问一门就把它的真实数字存下来，
         * 逛过的课显示真实进度，没逛过的老实显示「未统计」——
         * 而不是拿本地记账冒充平台进度（本地只认脚本自己看完的，
         * 装脚本之前学的、别的浏览器学的全都算不进去，数字必然偏小）。
         */
        stat(courseId) { return g('stat:' + courseId, null); },
        /** 返回值表示"这次有没有变化"，调用方据此决定要不要重绘面板 */
        setStat(courseId, done, total) {
            const old = this.stat(courseId);
            if (old && old.done === done && old.total === total) return false; // 没变就不写，省得频繁落盘
            s('stat:' + courseId, { done, total });
            return true;
        },

        /** 距上次刷新已看完几个视频，到阈值就例行刷新。见 safeReload */
        get sinceReload() { return Number(g('sinceReload', 0)) || 0; },
        set sinceReload(v) { s('sinceReload', Number(v) || 0); },

        resetProgress() {
            const ids = new Set([...(this.courses || []), ...FALLBACK_COURSES].map((c) => c.id));
            ids.forEach((id) => {
                GM_deleteValue(NS + 'watched:' + id);
                GM_deleteValue(NS + 'stat:' + id);
            });
            this.running = false;
        },
    };

    // =========================================================================
    // 课程清单 / URL
    // =========================================================================

    let COURSES = [];

    async function loadCourses() {
        const cached = State.courses;
        if (cached && cached.length) return cached;

        const base = 'https://s-file-1.ykt.cbern.com.cn/teach';
        try {
            const train = await fetch(`${base}/api_static/trains/${CONFIG.trainId}.json`).then((r) => r.json());
            const ids = train.train_course_ids || [];
            if (!ids.length) throw new Error('train_course_ids 为空');

            const courses = [];
            for (const id of ids) {
                try {
                    const c = await fetch(`${base}/s_course/v2/business_courses/${id}/course_relative_infos/zh-CN.json`)
                        .then((r) => r.json());
                    const d = c.course_detail;
                    const ext = d.ext_info || {};
                    courses.push({
                        id,
                        name: d.name,
                        total: d.total_activity_count,
                        maxPeriod: ext.progress_config && ext.progress_config.max_period,
                    });
                } catch {
                    courses.push(FALLBACK_COURSES.find((f) => f.id === id) || { id, name: id.slice(0, 8) });
                }
            }
            State.courses = courses;
            Log.write(`专题清单已加载：${train.train.title}（${courses.length} 门）`);
            return courses;
        } catch (e) {
            Log.write(`接口拉取课程失败（${e.message}），改用内置清单`);
            State.courses = FALLBACK_COURSES;
            return FALLBACK_COURSES;
        }
    }

    const currentCourseId = () => new URLSearchParams(location.search).get('courseId');

    function courseUrl(course) {
        const q = new URLSearchParams({
            courseId: course.id,
            breadcrumb: CONFIG.tag,
            libraryId: CONFIG.libraryId,
            tag: CONFIG.tag,
        });
        return `https://basic.smartedu.cn/teacherTraining/courseDetail?${q}`;
    }

    const onCoursePage = () => location.pathname.startsWith('/teacherTraining/course');

    /**
     * 自愈：SPA 有时会把路径重写成 /，只留 query（地址栏成了 /?courseId=…）。
     * 这种状态下页面没有课程内容，脚本什么也做不了，所以把路径修回去。
     * sessionStorage 计数防止修不好时无限跳转。
     */
    function healPath() {
        const cid = currentCourseId();
        if (!cid || onCoursePage()) return false;

        const key = 'sedu-heal-' + cid;
        const tries = Number(sessionStorage.getItem(key) || 0);
        if (tries >= 2) {
            Log.write('⚠ 路径自愈已尝试 2 次仍失败，请手动从专题页进入课程');
            return false;
        }
        sessionStorage.setItem(key, String(tries + 1));
        Log.write(`检测到路径被 SPA 重写成 ${location.pathname}，正在修回课程页`);
        location.replace(courseUrl({ id: cid }));
        return true;
    }

    // =========================================================================
    // 页面操作
    // =========================================================================

    /** 折叠的章节不渲染其 .resource-item，必须先全部展开（实测 3 → 9） */
    function expandAllChapters() {
        const collapsed = $$(SEL.chapter).filter((c) => !c.classList.contains(SEL.chapterActive));
        if (!collapsed.length) return false;
        collapsed.forEach((c) => {
            const h = c.querySelector(SEL.chapterHeader);
            if (h) h.click();
        });
        Log.write(`展开 ${collapsed.length} 个章节`);
        return true;
    }

    /** 结构：<div class="resource-item"><div><img>&nbsp;标题</div><div>…status…</div></div> */
    const titleOf = (node) => (textOf(node.firstElementChild) || textOf(node)).replace(/\s+/g, ' ').trim();

    /** 图标文件名带 video- 的是视频（实测 video-c1287471.png） */
    function isVideoResource(node) {
        const img = node.querySelector('img');
        const src = img ? img.getAttribute('src') || '' : '';
        if (/video/i.test(src)) return true;
        if (/doc|pdf|ppt|word|text|file/i.test(src)) return false;
        return true; // 判不出来就当视频试一次
    }

    function listItems() {
        return $$(SEL.resource)
            .map((node) => ({ node, title: titleOf(node), isVideo: isVideoResource(node) }))
            .filter((it) => !CONFIG.skipDocuments || it.isVideo);
    }

    /**
     * 是否已学完。判定顺序：平台状态优先，本地记账兜底。
     *
     * 坑：状态在 .status-icon 的子元素上，不在它自己身上。
     * 读 .status-icon 的 className / title 永远是空的，会导致永远返回 false、
     * 反复重播平台已经打勾的视频。
     */
    function isDone(item, courseId) {
        const icon = item.node.querySelector(SEL.statusIcon);
        if (icon) {
            // ① title="已学完"（首要依据，最不容易随改版变）
            const titled = icon.querySelector('[title]') || icon;
            const title = (titled.getAttribute && titled.getAttribute('title')) || '';
            if (DONE_TEXTS.some((t) => title.includes(t))) return true;

            // ② iconfont class 关键字，如 icon_checkbox_fill（备用）
            const inner = (icon.innerHTML || '').toLowerCase();
            if (DONE_TOKENS.some((t) => inner.includes(t))) return true;
        }
        // ③ 行内出现"已学完"等文案
        if (DONE_TEXTS.some((t) => textOf(item.node).includes(t))) return true;
        // ④ 本地记账：脚本自己看着播完的
        return State.watched(courseId).includes(item.title);
    }

    // =========================================================================
    // 进度探测：后台把每门课都开一遍，读真实进度缓存起来
    // =========================================================================

    /** 统计视频总数与已学完数。titled 用来判断平台状态是否已渲染完。 */
    function countProgress(doc) {
        const rows = $$(SEL.resource, doc);
        const vids = rows.filter((n) => !CONFIG.skipDocuments || isVideoResource(n));
        const done = vids.filter((n) => {
            const i = n.querySelector(`${SEL.statusIcon} [title]`);
            const t = i ? i.getAttribute('title') || '' : '';
            return DONE_TEXTS.some((x) => t.includes(x));
        }).length;
        return { done, total: vids.length, titled: $$(`${SEL.statusIcon} [title]`, doc).length, rows: rows.length };
    }

    const napMs = (ms) => new Promise((r) => setTimeout(r, ms));

    /**
     * 用同源隐藏 iframe 打开一门课，读它的真实进度。拿不准就返回 null。
     *
     * 三个实测要点，改动前务必先看：
     *
     * 1. iframe 不能放到 left:-99999px。
     *    平台的懒渲染（IntersectionObserver）会判定它不可见而完全不渲染，
     *    列表永远是 0 行。必须留在视口内，靠 opacity + z-index 藏起来。
     *
     * 2. 「教师研修」是挂在 teacher.ykt.eduyun.cn 上的微前端（micro-app），启动很慢。
     *    实测 13 秒左右列表和状态才一起出现，超时给少了会白等一场。
     *
     * 3. 必须等到「每一行都有 title」才计数。
     *    未登录时列表照样渲染但状态图标全是空的，这时直接数会得到 done=0；
     *    把这种错值缓存下来，脚本会以为整门课一个没学，从头重刷一遍 ——
     *    比不缓存糟糕得多。宁可返回 null 标「未统计」。
     */
    async function probeCourse(courseId, timeoutMs = 30000) {
        const fr = document.createElement('iframe');
        fr.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:900px;border:0;'
            + 'opacity:0.01;pointer-events:none;z-index:-99999';
        fr.src = courseUrl({ id: courseId });
        document.body.appendChild(fr);

        const deadline = Date.now() + timeoutMs;
        try {
            await new Promise((res) => { fr.onload = res; setTimeout(res, timeoutMs); });
            const doc = fr.contentDocument;
            if (!doc) return null;

            while (Date.now() < deadline) {
                // 章节可能嵌套，每轮都展开一次，新展开的行下一轮才会被计入
                $$(SEL.chapter, doc)
                    .filter((c) => !c.classList.contains(SEL.chapterActive))
                    .forEach((c) => { const h = c.querySelector(SEL.chapterHeader); if (h) h.click(); });

                const st = countProgress(doc);
                if (st.rows && st.titled >= st.rows) return { done: st.done, total: st.total };
                await napMs(1500);
            }
            return null;
        } catch {
            return null;   // iframe 被拦、跨域、渲染失败等，一律当"取不到"
        } finally {
            fr.remove();
        }
    }

    let probing = false;

    /** 依次扫描所有课程。当前这门直接读本页，不用开 iframe。 */
    async function probeAll() {
        if (probing) { Log.write('进度扫描进行中，请稍候'); return; }
        probing = true;

        const cur = currentCourseId();
        Log.write(`开始扫描 ${COURSES.length} 门课的进度（微前端启动慢，每门约 15 秒）`);
        let ok = 0;

        for (let i = 0; i < COURSES.length; i++) {
            const c = COURSES[i];
            let r = null;

            if (c.id === cur) {
                const live = countProgress(document);
                if (live.rows && live.titled >= live.rows) r = { done: live.done, total: live.total };
            } else {
                r = await probeCourse(c.id);
            }

            if (r) {
                State.setStat(c.id, r.done, r.total);
                ok++;
                Log.write(`[${i + 1}/${COURSES.length}] ${c.name} ${r.done}/${r.total}`);
            } else {
                Log.write(`[${i + 1}/${COURSES.length}] ${c.name} 取不到进度（未登录？），保持未统计`);
            }
            Panel.render();
        }

        probing = false;
        Log.write(`扫描完成：${ok}/${COURSES.length} 门取到真实进度`);
        Panel.render();
    }

    /** 当前正在播的是哪一行。平台用 .resource-item-active 标记，比我们自己记的更可靠。 */
    function activeTitle() {
        const node = document.querySelector(SEL.resourceActive);
        return node ? titleOf(node) : '';
    }

    /** 弹窗内容是否课堂练习。答题弹窗必须交给 answerQuiz，不能当提示层关掉。 */
    const isQuizModal = (node) => /课堂练习|单选题|多选题|是非题|判断题/.test(textOf(node));

    /**
     * 取当前真正可见的弹窗。
     *
     * 不能用 pick(SEL.modal)：平台每弹一次窗就往 body 里留一个不删的 .fish-modal-root 残骸，
     * 实测跑一会儿 [class*="modal"] 能累积到 296 个。pick 的「第一个可见的，否则第 0 个」
     * 在这种情况下基本等于随机取一个陈旧节点。
     */
    function visibleModals() {
        const seen = new Set();
        const out = [];
        for (const sel of SEL.modal) {
            for (const node of $$(sel)) {
                if (seen.has(node)) continue;
                seen.add(node);
                if (isVisible(node) && textOf(node)) out.push(node);
            }
        }
        /*
         * 按 DOM 顺序排序后反转 —— 最后插入的排最前。
         * 残骸都堆在 document order 靠前的位置，真正在用户面前的是最新那个。
         * 不反转的话会一直去点一个早就失效的按钮，还每次都返回"成功"，
         * 形成每 700ms 刷一条「关闭弹窗（我知道了）」而弹窗纹丝不动的死循环。
         */
        out.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        return out.reverse();
    }

    /**
     * 平台的多端并发提示：「你已在其他端进入学习，本端自动暂停学习。」
     * 这个不能当普通提示关掉——关掉再播，平台会再暂停，形成拉锯：
     * 实测 14 秒内暂停 4 次，2 倍速的有效速度被拖到 1x 左右，纯属白耗。
     * 正确做法是停下来告诉用户去关掉另一个端。
     */
    const MULTI_END_HINTS = ['其他端', '其它端', '其他设备', '其它设备', '多端', '异地登录'];

    /** 撞上多端提示：停下来，别跟平台拉锯 */
    function onMultiEnd(node) {
        if (!State.running) return;
        State.running = false;
        Log.write('⚠ 平台提示「已在其他端进入学习」，已停止');
        Log.write('   请关掉其他正在学习的标签页 / 手机 / 其他设备，再回来点「开始」');
        Panel.render();
        // 弹窗刚插入时还没渲染完，稍等再点关闭
        setTimeout(() => clickByText(['我知道了', '知道了', '确定'], node), 300);
    }

    /**
     * 盯着 DOM 等多端提示出现。
     *
     * 为什么不能靠心跳轮询：这个弹窗只存活约 1.3 秒，而心跳是 4 秒一次；
     * 更麻烦的是它刚插入 DOM 那一刻 isVisible 还是 false（动画未生效），
     * 轮询即使撞上也会被"不可见就跳过"挡掉。实测轮询漏检率接近 100%。
     */
    function watchMultiEnd() {
        const mo = new MutationObserver((muts) => {
            for (const m of muts) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const cls = node.className;
                    if (typeof cls !== 'string' || !/modal|dialog/i.test(cls)) continue;
                    if (MULTI_END_HINTS.some((t) => textOf(node).includes(t))) onMultiEnd(node);
                }
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    const CLOSE_TEXTS = ['我知道了', '知道了', '确定', '确认', '继续学习', '开始学习', '好的'];

    /**
     * 关掉学习前提示（平台 video_study_config.alert_before_study = true）等确认弹窗。
     *
     * 遍历「所有」可见弹窗逐个点，而不是只点第一个：
     * 页面里堆着大量关不掉的历史残骸，只点一个很可能点在残骸上，
     * 真正挡路的那个永远关不掉。全点一遍最省事也最可靠。
     */
    function dismissModals() {
        let clicked = 0;
        let waiting = false;

        for (const modal of visibleModals()) {
            // 不先排除答题弹窗，会在没选答案时就把题提交掉
            if (isQuizModal(modal)) continue;

            const body = textOf(modal);
            if (MULTI_END_HINTS.some((t) => body.includes(t))) { onMultiEnd(modal); return true; }

            // 「学习指南」这类弹窗带「下次不再提示」，勾上能省掉后面每门课重复等倒计时
            if (body.includes('不再提示')) {
                const box = $$('input[type="checkbox"]', modal).find((c) => !c.checked);
                if (box) { realClick(box); Log.write('已勾选「下次不再提示」'); }
            }

            if (clickByText(CLOSE_TEXTS, modal)) { clicked++; continue; }

            /*
             * 弹窗在但按钮点不动 —— 多半是倒计时未结束
             * （实测「学习指南」写着「12s 后可手动关闭」，按钮此前一直 disabled）。
             */
            if ($$('button, .fish-btn', modal).some((b) => isVisible(b) && isDisabled(b))) {
                waiting = true;
                const m = body.match(/(\d+)\s*s?\s*后可/);
                Log.tick(`弹窗倒计时中${m ? `（剩 ${m[1]}s）` : ''}，等待可关闭`);
            }
        }

        // 用 tick 而非 write：点到残骸时会连点多轮，不去重会把日志刷满
        if (clicked) Log.tick(`关闭弹窗 ×${clicked}`);
        return clicked > 0 || waiting;
    }

    /** 课堂练习：无题库，一律选第一个；多选选前两个 */
    function answerQuiz() {
        if (!CONFIG.autoAnswer) return false;
        const modal = visibleModals().find(isQuizModal);
        if (!modal) return false;

        const body = textOf(modal);
        const options = SEL.quizOption.map((sel) => $$(sel, modal)).find((a) => a.length) || [];
        if (!options.length) { Log.tick('检测到练习但选项未渲染，等待'); return true; }

        const many = /多选题/.test(body);
        options.slice(0, many ? 2 : 1).forEach((o) => o.click());
        Log.write(`自动答题：${many ? '多选取前两项' : '单选取第一项'}`);
        setTimeout(() => {
            if (!clickAny(SEL.quizSubmit, modal) && !clickByText(['提交', '确定'], modal)) {
                Log.write('未找到提交按钮');
            }
        }, 800);
        return true;
    }

    /** 脚本自己点开的那一个。记账用它，不靠猜 DOM 高亮 class。 */
    let currentTitle = '';
    /** 静音回退是否已生效。必须记住，否则下次心跳又设回有声，陷入拒绝→回退死循环。 */
    let mutedFallback = false;
    /** 倍速被平台抢走的次数，>0 说明平台在限速 */
    let rateFightCount = 0;

    function tryPlay(video) {
        const p = video.play();
        if (!p || !p.catch) return;
        p.catch(() => {
            if (!video.muted) {
                mutedFallback = true;
                video.muted = true;
                Log.write('有声自动播放被浏览器拒绝，已回退静音（靠 Worker 心跳兜底）');
                const p2 = video.play();
                if (p2 && p2.catch) p2.catch(() => clickAny(SEL.playButton));
            } else {
                clickAny(SEL.playButton);
            }
        });
    }

    function keepPlaying(courseId) {
        const video = pick(SEL.video);
        if (!video) return null;
        const want = State.rate;

        if (!video.dataset.seduHooked) {
            video.dataset.seduHooked = '1';

            // 实时读 currentTitle，不要闭包捕获：SPA 复用同一个 <video>，
            // 捕获的标题在切换资源后就是旧的，会记错账。
            video.addEventListener('ended', () => advance(courseId));

            /*
             * 倍速会被抢回去：实测设了 2x 之后，4 秒真实时间只走 ~5 秒进度。
             * 监听 ratechange 立即抢回来；判断不等再设，避免自己触发自己死循环。
             */
            video.addEventListener('ratechange', () => {
                if (Math.abs(video.playbackRate - State.rate) > 0.01) {
                    rateFightCount++;
                    video.playbackRate = State.rate;
                    if (rateFightCount === 3) Log.write('⚠ 倍速被反复重置，平台可能限制倍速');
                }
            });
            // 元数据加载完成前设倍速会被覆盖，这两个时机再补一次
            ['loadedmetadata', 'playing'].forEach((ev) =>
                video.addEventListener(ev, () => { video.playbackRate = State.rate; }));

            Log.write(`接管播放器（${Math.round(video.duration || 0)}s）`);
        }

        if (Math.abs(video.playbackRate - want) > 0.01) video.playbackRate = want;
        video.muted = !CONFIG.preferUnmuted || mutedFallback;
        if (!video.muted) video.volume = CONFIG.volume;

        if (video.paused || video.ended) tryPlay(video);
        return video;
    }

    /**
     * 记账 + 切下一个。ended 监听和心跳都会走这里，
     * 两者之间有窗口期（ended 已触发但新视频还没加载完），不去重会连跳两个视频。
     */
    /*
     * 自愈：该刷新就刷新。
     *
     * 三个触发源，对应三种不同的坏掉方式：
     *   例行  看完 N 个视频 → 清掉累积的 DOM 残骸，防患于未然
     *   异常  连续 N 轮抛异常 → 进了脚本自己出不来的状态
     *   停滞  播放进度长时间不动 → 播放器或微前端半死
     *
     * 两道防护避免刷新循环：最小间隔 + 单标签页次数上限。
     * 计数放 sessionStorage：能跨刷新存活，又不会污染下一次会话。
     */
    function safeReload(reason) {
        const now = Date.now();
        const last = Number(sessionStorage.getItem('sedu-reload-at') || 0);
        const count = Number(sessionStorage.getItem('sedu-reload-count') || 0);

        if (count >= CONFIG.maxReloadsPerSession) {
            Log.tick(`已达自动刷新上限（${count} 次），不再自动刷新`);
            return false;
        }
        if (now - last < CONFIG.minReloadGapMs) return false;   // 离上次太近，先忍着

        sessionStorage.setItem('sedu-reload-at', String(now));
        sessionStorage.setItem('sedu-reload-count', String(count + 1));
        State.sinceReload = 0;
        Log.write(`⟳ 刷新页面（第 ${count + 1} 次）：${reason}`);
        setTimeout(() => location.reload(), 800);   // 留点时间让日志落地
        return true;
    }

    /** 播放停滞检测：记住 currentTime 上次变化的时刻 */
    let lastSeenTime = -1;
    let lastProgressAt = Date.now();
    /** 连续抛异常的轮数，完整走完一轮就清零 */
    let errorStreak = 0;

    let lastAdvance = 0;
    function advance(courseId) {
        const now = Date.now();
        if (now - lastAdvance < 3000) return false;
        lastAdvance = now;

        // 优先用平台标记的当前行：万一平台自己切了视频，我们记的 currentTitle 就是旧的
        const t = activeTitle() || currentTitle || document.title;
        State.markWatched(courseId, t);
        Log.write(`播完：${t}`);
        Panel.render();

        // 例行刷新：攒够 N 个就重置页面，别等它慢慢卡死
        State.sinceReload = State.sinceReload + 1;
        if (CONFIG.reloadEveryNVideos > 0
            && State.sinceReload >= CONFIG.reloadEveryNVideos
            && safeReload(`已看完 ${State.sinceReload} 个视频，例行刷新`)) {
            return true;   // 页面就要重载，别再切下一个了
        }

        return playNext(courseId);
    }

    function playNext(courseId) {
        const pending = listItems().filter((it) => !isDone(it, courseId));
        if (!pending.length) return false;
        currentTitle = pending[0].title;
        Log.write(`切换到：${currentTitle}`);
        pending[0].node.click();
        return true;
    }

    /**
     * 当前播的这条如果已经学完，立刻跳到未完成的那条。
     *
     * 必要性：只靠 ended 推进是不够的。进页面时平台会自动恢复上次的播放位置，
     * 如果那条早就学完了，脚本会一路"维持播放"把它整个再播一遍
     * （实测撞上过一个 1:36:50 的已完成视频，2 倍速也要白播 48 分钟）。
     */
    let lastSkip = 0;
    function skipIfDone(courseId) {
        const node = document.querySelector(SEL.resourceActive);
        if (!node) return false;

        const active = { node, title: titleOf(node), isVideo: true };
        if (!isDone(active, courseId)) return false;

        const pending = listItems().filter((it) => !isDone(it, courseId));
        if (!pending.length) return false;
        if (pending[0].title === active.title) return false; // 防御：别把自己跳成自己

        // 平台切换视频需要时间，别每轮心跳都点一次
        const now = Date.now();
        if (now - lastSkip < 5000) return false;
        lastSkip = now;

        Log.write(`跳过已学完：${active.title}`);
        return playNext(courseId);
    }

    // =========================================================================
    // UI
    // =========================================================================

    const COLORS = {
        bg: 'rgba(16,18,24,.95)', line: 'rgba(255,255,255,.10)',
        text: '#d8dee9', dim: '#7c8798', accent: '#5ac8fa', ok: '#4ade80', warn: '#fbbf24',
    };

    /** 脚本仓库，面板里放个入口方便用户 Star / Watch 关注更新。 */
    const REPO_URL = 'https://github.com/yilecoding/helper-scripts';

    /** 面板：课程目录 + 控制 + 日志 */
    const Panel = (() => {
        let root, listBox, headBox, logBox, logBody;
        let logLines = 0, lastMsg = '', lastCount = 0;

        function css(node, styles) { Object.assign(node.style, styles); return node; }

        function build() {
            if (root || !document.body) return;

            root = css(document.createElement('div'), {
                position: 'fixed', top: '80px', right: '16px', zIndex: '2147483647',
                width: '300px', maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column',
                background: COLORS.bg, color: COLORS.text, borderRadius: '10px',
                font: '13px/1.5 -apple-system, "Microsoft YaHei", sans-serif',
                boxShadow: '0 8px 32px rgba(0,0,0,.5)', overflow: 'hidden',
                border: `1px solid ${COLORS.line}`,
            });

            // ── 标题栏 ──
            const bar = css(document.createElement('div'), {
                display: 'flex', alignItems: 'center', gap: '6px', padding: '9px 11px',
                background: 'rgba(255,255,255,.05)', cursor: 'move', userSelect: 'none',
            });
            const title = css(document.createElement('div'), { flex: '1', fontWeight: '600', fontSize: '13px' });
            title.textContent = '研修助手';
            bar.appendChild(title);
            bar.appendChild(iconBtn('★', 'GitHub 仓库：持续更新，欢迎 Star / Watch', () => {
                window.open(REPO_URL, '_blank', 'noopener');
            }));
            bar.appendChild(iconBtn(State.panelOpen ? '－' : '＋', '收起/展开', () => {
                State.panelOpen = !State.panelOpen;
                applyOpen();
            }, 'toggleBtn'));
            root.appendChild(bar);
            makeDraggable(root, bar);

            // ── 折叠区（目录 + 控制 + 日志） ──
            const collapsible = css(document.createElement('div'), {
                display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: '1',
            });
            collapsible.dataset.role = 'body';

            headBox = css(document.createElement('div'), {
                padding: '9px 11px', borderTop: `1px solid ${COLORS.line}`, fontSize: '12px', color: COLORS.dim,
            });
            collapsible.appendChild(headBox);

            // 控制条：自动续学 + 倍速
            const ctl = css(document.createElement('div'), {
                display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                padding: '0 11px 9px', fontSize: '12px',
            });

            const chainLabel = css(document.createElement('label'), {
                display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: COLORS.text,
            });
            const chainBox = document.createElement('input');
            chainBox.type = 'checkbox';
            chainBox.checked = State.autoChain;
            chainBox.addEventListener('change', () => {
                State.autoChain = chainBox.checked;
                Log.write(chainBox.checked ? '已开启：学完自动进下一门' : '已关闭续学：学完这门就停');
            });
            chainLabel.append(chainBox, document.createTextNode('自动续学'));

            const rateLabel = css(document.createElement('label'), {
                display: 'flex', alignItems: 'center', gap: '4px', color: COLORS.text,
            });
            const rateInput = css(document.createElement('input'), {
                width: '48px', background: 'rgba(255,255,255,.07)', color: COLORS.text,
                border: `1px solid ${COLORS.line}`, borderRadius: '4px', padding: '1px 4px', font: 'inherit',
            });
            rateInput.type = 'number';
            rateInput.min = '0.5'; rateInput.max = '4'; rateInput.step = '0.25';
            rateInput.value = String(State.rate);
            rateInput.addEventListener('change', () => {
                const v = Math.min(4, Math.max(0.5, Number(rateInput.value) || 1));
                State.rate = v; rateInput.value = String(v);
                rateFightCount = 0;
                Log.write(`倍速设为 ${v}x`);
            });
            rateLabel.append(document.createTextNode('倍速'), rateInput);

            ctl.append(chainLabel, rateLabel, textBtn('扫描进度', probeAll),
                textBtn('刷新', () => {
                    State.sinceReload = 0;
                    Log.write('手动刷新页面');
                    location.reload();
                }),
                textBtn('诊断', diagnose), textBtn('重置进度', () => {
                State.resetProgress();
                Log.write('已清空本地观看记录');
                render();
            }), textBtn('停止', () => {
                State.running = false;
                Log.write('已停止');
                render();
            }));
            collapsible.appendChild(ctl);

            // 课程目录
            listBox = css(document.createElement('div'), {
                overflowY: 'auto', maxHeight: '46vh', borderTop: `1px solid ${COLORS.line}`,
            });
            collapsible.appendChild(listBox);

            // 日志
            logBox = css(document.createElement('div'), { borderTop: `1px solid ${COLORS.line}` });
            const logHead = css(document.createElement('div'), {
                display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 11px',
                fontSize: '11px', color: COLORS.dim, cursor: 'pointer', userSelect: 'none',
            });
            logHead.append(document.createTextNode('运行日志'));
            const logArrow = css(document.createElement('span'), { marginLeft: 'auto' });
            logArrow.textContent = State.logOpen ? '▾' : '▸';
            logHead.appendChild(logArrow);
            logHead.addEventListener('click', () => {
                State.logOpen = !State.logOpen;
                logArrow.textContent = State.logOpen ? '▾' : '▸';
                logBody.style.display = State.logOpen ? 'block' : 'none';
            });
            logBody = css(document.createElement('div'), {
                maxHeight: '150px', overflowY: 'auto', padding: '0 11px 9px',
                font: '11px/1.55 Consolas, Menlo, monospace', color: COLORS.dim,
                whiteSpace: 'pre-wrap', display: State.logOpen ? 'block' : 'none',
            });
            logBox.append(logHead, logBody);
            collapsible.appendChild(logBox);

            // ── 底部：关注仓库提示 ──
            const footer = css(document.createElement('div'), {
                padding: '7px 11px', borderTop: `1px solid ${COLORS.line}`,
                fontSize: '11px', color: COLORS.dim, textAlign: 'center',
            });
            const footerLink = css(document.createElement('a'), {
                color: COLORS.accent, textDecoration: 'none', cursor: 'pointer',
            });
            footerLink.textContent = '⭐ 脚本持续更新，去 GitHub Star / Watch 一下';
            footerLink.href = REPO_URL;
            footerLink.target = '_blank';
            footerLink.rel = 'noopener';
            footer.appendChild(footerLink);
            collapsible.appendChild(footer);

            root.appendChild(collapsible);
            document.body.appendChild(root);
            applyOpen();
        }

        function applyOpen() {
            if (!root) return;
            const body = root.querySelector('[data-role="body"]');
            const tBtn = root.querySelector('[data-role="toggleBtn"]');
            if (body) body.style.display = State.panelOpen ? 'flex' : 'none';
            if (tBtn) tBtn.textContent = State.panelOpen ? '－' : '＋';
        }

        function iconBtn(label, tip, fn, role) {
            const b = css(document.createElement('button'), {
                cursor: 'pointer', border: `1px solid ${COLORS.line}`, background: 'transparent',
                color: COLORS.dim, borderRadius: '4px', width: '20px', height: '20px',
                lineHeight: '1', font: 'inherit', fontSize: '13px',
            });
            b.textContent = label; b.title = tip;
            if (role) b.dataset.role = role;
            b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
            return b;
        }

        function textBtn(label, fn) {
            const b = css(document.createElement('button'), {
                cursor: 'pointer', border: `1px solid ${COLORS.line}`, background: 'transparent',
                color: COLORS.accent, borderRadius: '4px', padding: '1px 7px', font: 'inherit', fontSize: '11px',
            });
            b.textContent = label;
            b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
            return b;
        }

        /** 拖动。面板固定在右上会挡内容，让它能挪走。 */
        function makeDraggable(box, handle) {
            let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
            handle.addEventListener('mousedown', (e) => {
                dragging = true;
                const r = box.getBoundingClientRect();
                sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
                e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                box.style.left = `${ox + e.clientX - sx}px`;
                box.style.top = `${oy + e.clientY - sy}px`;
                box.style.right = 'auto';
            });
            document.addEventListener('mouseup', () => { dragging = false; });
        }

        /** 重绘头部摘要 + 课程目录 */
        function render() {
            if (!root) return;
            const cid = currentCourseId();

            // 头部摘要。只统计"逛过因而知道真实进度"的课，并明说统计了几门，
            // 避免把没访问过的课当成 0 个，显示出一个偏小又看不出偏小的总数。
            const stats = COURSES.map((c) => State.stat(c.id)).filter(Boolean);
            const done = stats.reduce((n, st) => n + st.done, 0);
            const total = stats.reduce((n, st) => n + st.total, 0);

            headBox.textContent = '';
            const l1 = css(document.createElement('div'), { color: COLORS.text, fontWeight: '600', marginBottom: '2px' });
            l1.textContent = CONFIG.tag;
            const l2 = document.createElement('div');
            l2.textContent = (stats.length
                ? `已完成 ${done}/${total} 个视频（已统计 ${stats.length}/${COURSES.length} 门）`
                : `${COURSES.length} 门课 · 进度待统计`)
                + (State.running ? ' · 运行中' : '');
            headBox.append(l1, l2);

            // 课程目录
            listBox.textContent = '';
            if (!COURSES.length) {
                const empty = css(document.createElement('div'), { padding: '11px', color: COLORS.dim });
                empty.textContent = '课程清单加载中…';
                listBox.appendChild(empty);
                return;
            }

            COURSES.forEach((c, i) => {
                const isCurrent = c.id === cid;
                const stat = State.stat(c.id);

                const row = css(document.createElement('div'), {
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 11px',
                    cursor: 'pointer', borderLeft: `3px solid ${isCurrent ? COLORS.accent : 'transparent'}`,
                    background: isCurrent ? 'rgba(90,200,250,.10)' : 'transparent',
                });
                row.addEventListener('mouseenter', () => {
                    if (!isCurrent) row.style.background = 'rgba(255,255,255,.05)';
                });
                row.addEventListener('mouseleave', () => {
                    if (!isCurrent) row.style.background = 'transparent';
                });

                const idx = css(document.createElement('span'), {
                    color: COLORS.dim, fontSize: '11px', width: '16px', flexShrink: '0',
                });
                idx.textContent = String(i + 1);

                // 允许换行而不是省略号：最长的课程名（"面向普教校长与教师的融合教育通识课实录"）
                // 需要 228px 而行内只有 179px，加宽面板也补不齐，截断了就看不出是哪门课
                const name = css(document.createElement('span'), {
                    flex: '1', fontSize: '12px', color: isCurrent ? COLORS.accent : COLORS.text,
                    lineHeight: '1.35', wordBreak: 'break-all',
                });
                name.textContent = c.name;
                name.title = `${c.name}\n学时上限：${c.maxPeriod === -1 ? '不限' : c.maxPeriod}\n资源数：${c.total ?? '?'}`;

                /*
                 * 进度显示平台真实数字 6/72，不是脚本自己的记账。
                 * 没访问过的课如实写「未统计」——写「未开始」等于断言它是 0，
                 * 而我们其实不知道（用户可能早就学过一半）。
                 */
                const prog = css(document.createElement('span'), {
                    fontSize: '11px', flexShrink: '0', fontVariantNumeric: 'tabular-nums',
                });
                if (stat) {
                    const full = stat.done >= stat.total && stat.total > 0;
                    prog.textContent = `${stat.done}/${stat.total}`;
                    prog.style.color = full ? COLORS.ok : (stat.done ? COLORS.accent : COLORS.dim);
                    if (full) prog.textContent += ' ✓';
                } else {
                    prog.textContent = '未统计';
                    prog.style.color = COLORS.dim;
                }

                const go = css(document.createElement('span'), {
                    fontSize: '11px', color: COLORS.accent, flexShrink: '0',
                });
                go.textContent = isCurrent ? (State.running ? '学习中' : '开始') : '去学';

                row.append(idx, name, prog, go);
                row.addEventListener('click', () => startCourse(c, i));
                listBox.appendChild(row);
            });
        }

        const stamp = () => {
            const d = new Date(), p = (n) => String(n).padStart(2, '0');
            return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        };

        function log(msg, dedup) {
            console.log(TAG, msg);
            build();
            if (!logBody) return;
            if (dedup && msg === lastMsg && logBody.lastChild) {
                lastCount++;
                logBody.lastChild.textContent = `${stamp()} ${msg} ×${lastCount}`;
                return;
            }
            lastMsg = msg; lastCount = 1;
            const line = document.createElement('div');
            line.textContent = `${stamp()} ${msg}`;
            logBody.appendChild(line);
            if (++logLines > CONFIG.logMaxLines) { logBody.removeChild(logBody.firstChild); logLines--; }
            logBody.scrollTop = logBody.scrollHeight;
        }

        return { build, render, log };
    })();

    const Log = {
        write: (m) => Panel.log(m, false),
        tick: (m) => Panel.log(m, true),
    };

    /** 点目录里的课程：同一门就地开始，别的门先跳过去 */
    function startCourse(course, index) {
        State.running = true;
        if (course.id === currentCourseId()) {
            Log.write(`开始学习《${course.name}》`);
            Panel.render();
            tick();
            return;
        }
        Log.write(`前往第 ${index + 1} 门《${course.name}》`);
        setTimeout(() => { location.href = courseUrl(course); }, 300);
    }

    // =========================================================================
    // 诊断
    // =========================================================================

    function diagnose() {
        const brief = (n) => n ? `${n.tagName}.${n.className || ''}#${n.id || ''}`.slice(0, 160) : null;
        const cid = currentCourseId();
        const report = {
            url: location.href,
            onCoursePage: onCoursePage(),
            loggedInGuess: !/登录|注册/.test((document.body.innerText || '').slice(0, 400)),
            keepAlive: {
                hidden: document.hidden, visibilityState: document.visibilityState, notes: KeepAlive.notes,
            },
            playback: { wantRate: State.rate, rateFightCount, mutedFallback },
            selfHeal: {
                本会话自动刷新次数: Number(sessionStorage.getItem('sedu-reload-count') || 0),
                距上次刷新已看: State.sinceReload,
                连续异常轮数: errorStreak,
                停滞秒数: Math.round((Date.now() - lastProgressAt) / 1000),
            },
            videos: $$('video').map((v) => ({
                src: (v.currentSrc || v.src || '').slice(0, 100),
                duration: v.duration, currentTime: v.currentTime,
                paused: v.paused, muted: v.muted, volume: v.volume, rate: v.playbackRate,
                parent: brief(v.parentElement),
            })),
            players: $$('[class*="video-js"],[class*="fish-video"]').slice(0, 8).map(brief),
            chapterCount: $$(SEL.chapter).length,
            itemCount: listItems().length,
            itemSamples: listItems().slice(0, 9).map((it) => ({
                title: it.title, isVideo: it.isVideo, cls: it.node.className,
                statusHTML: (it.node.querySelector(SEL.statusIcon) || {}).outerHTML,
                done: isDone(it, cid),
            })),
            modals: $$('[class*="modal"],[role="dialog"]').filter(isVisible).slice(0, 5)
                .map((m) => ({ cls: m.className, text: textOf(m).slice(0, 200) })),
            buttons: $$('button,.fish-btn').filter(isVisible).slice(0, 30).map(textOf).filter(Boolean),
        };
        const json = JSON.stringify(report, null, 1);
        console.log(TAG, '诊断报告\n' + json);
        Log.write('诊断报告已打印到控制台（F12 → Console）');
        if (navigator.clipboard) {
            navigator.clipboard.writeText(json)
                .then(() => Log.write('已复制到剪贴板，可直接发给作者'))
                .catch(() => {});
        }
    }

    // =========================================================================
    // 主循环
    // =========================================================================

    let navigating = false;
    let ticking = false; // 防重入：ended 处理和心跳可能同时进来

    /**
     * 安排一次快速续跑。
     *
     * 每个"预备动作"（等列表渲染、展开章节、关弹窗、答题）都会 return，
     * 若干等下一次心跳，光启动就要空耗好几个 4 秒：
     *   09:21:11 资源列表未渲染 → 09:21:15 展开章节 → 09:21:19 才轮到翻课判断。
     * 一门早就学完的课看起来就像卡住了。做完预备动作立刻续跑，不等心跳。
     */
    let soonTimer = 0;
    function soon(ms = 700) {
        clearTimeout(soonTimer);
        soonTimer = setTimeout(tick, ms);
    }

    /**
     * 早退保护。
     *
     * tick 开头那几步（关弹窗 / 答题 / 展开章节）一旦返回 true 就会中断本轮，
     * 而它们都有"永远返回 true"的可能：
     *   · 弹窗残骸不会从 DOM 移除，里面的「我知道了」一直可点、点了没反应
     *   · 课堂练习弹窗出现但选项选择器没命中，会一直等下去
     *   · 平台切视频时重新折叠章节，展开动作每轮都触发
     * 任何一种发生，后面的播放维持、跳过已学完、翻课就一次都执行不到，
     * 表现就是"卡住不动、不翻下一个"。
     *
     * 连续超过 limit 轮仍未解决，就放行让后续流程照常跑。
     */
    const stallCounts = {};
    function blocking(key, hit, limit = 3) {
        if (!hit) { stallCounts[key] = 0; return false; }
        stallCounts[key] = (stallCounts[key] || 0) + 1;
        if (stallCounts[key] > limit) {
            Log.tick(`「${key}」连续 ${stallCounts[key]} 轮未解决，先放行继续后续流程`);
            return false;
        }
        return true;
    }

    function tick() {
        if (!State.running || navigating || ticking) return;
        ticking = true;

        try {
            // 三个早退分支全部用 blocking() 包住：
            // 任何一个长期返回 true 都会把整轮流程永久堵死，后面的播放维持、
            // 跳过已学完、翻课逻辑一次都执行不到。
            if (blocking('弹窗', dismissModals())) { soon(); return; }
            if (blocking('课堂练习', answerQuiz())) return;   // 答题有自己的 800ms 提交延时，别催
            if (blocking('展开章节', expandAllChapters())) { soon(); return; } // 展开会重排 DOM，下一轮再操作

            const courseId = currentCourseId();
            if (!courseId || !onCoursePage()) { Log.tick('不在课程页，请从目录选一门课'); return; }

            const idx = COURSES.findIndex((c) => c.id === courseId);
            const course = COURSES[idx] || { id: courseId, name: '未知课程' };

            const items = listItems();
            if (!items.length) { Log.tick('资源列表未渲染，等待'); soon(1000); return; }

            const doneCount = items.filter((it) => isDone(it, courseId)).length;

            /*
             * 把平台真实进度存下来，面板据此显示，而不是拿本地记账充数。
             * 变了才重绘：每轮都重绘会不停重建课程列表，把用户滚动位置弹回顶部。
             */
            if (State.setStat(courseId, doneCount, items.length)) Panel.render();

            // 本门课全部看完
            if (doneCount >= items.length) {
                Panel.render();
                if (!State.autoChain) {
                    State.running = false;
                    Log.write(`《${course.name}》已完成。未开启续学，已停止`);
                    return;
                }
                const nextIdx = idx + 1;
                if (nextIdx >= COURSES.length) {
                    State.running = false;
                    Log.write(`🎉 全部 ${COURSES.length} 门课已完成`);
                    return;
                }
                navigating = true;
                const next = COURSES[nextIdx];
                Log.write(`《${course.name}》完成 → 第 ${nextIdx + 1}/${COURSES.length} 门《${next.name}》`);
                setTimeout(() => { location.href = courseUrl(next); }, CONFIG.navDelay);
                return;
            }

            // 在维持播放之前先问一句：现在播的这条是不是早就学完了？
            if (skipIfDone(courseId)) return;

            const video = keepPlaying(courseId);
            if (!video) {
                if (!playNext(courseId)) {
                    clickByText(['开始学习', '继续学习']) || clickAny(SEL.startStudy);
                    Log.tick('未找到播放器，尝试开始学习');
                }
                return;
            }

            if (video.ended) { advance(courseId); return; }

            /*
             * 停滞检测。只在"本该正常播放"时才算数：
             * 弹窗、答题、多端暂停都会在前面就 return，走到这里说明确实该在播。
             */
            if (video.currentTime !== lastSeenTime) {
                lastSeenTime = video.currentTime;
                lastProgressAt = Date.now();
            } else if (Date.now() - lastProgressAt > CONFIG.stuckTimeoutMs) {
                if (safeReload(`播放停滞超过 ${Math.round(CONFIG.stuckTimeoutMs / 1000)} 秒`)) return;
            }

            // 打印实际 playbackRate，不是期望值 —— 平台会把倍速改回去，打期望值等于自欺欺人
            const rate = video.playbackRate.toFixed(2).replace(/\.?0+$/, '');
            const warn = Math.abs(video.playbackRate - State.rate) > 0.01 ? `（期望 ${State.rate}x）` : '';
            Log.tick(`《${course.name}》${doneCount}/${items.length} · ${Math.round(video.currentTime)}/${Math.round(video.duration || 0)}s · ${rate}x${warn}`);
            errorStreak = 0;   // 本轮完整走到底，说明没卡在半路
        } catch (err) {
            errorStreak++;
            Log.write(`本轮异常已忽略：${err.message}`); // 单轮出错不能让整个循环停掉
            console.error(TAG, err);
            // 连续出错说明不是偶发，脚本自己绕不出来，刷新重来
            if (errorStreak >= CONFIG.reloadOnErrorStreak) safeReload(`连续 ${errorStreak} 轮异常`);
        } finally {
            ticking = false;
        }
    }

    // =========================================================================
    // 启动
    // =========================================================================

    async function boot() {
        try {
            await bootInner();
        } catch (err) {
            // 启动阶段任何一步炸了都要留下明确痕迹，不然面板不弹出时无从下手排查。
            console.error(TAG, '启动失败', err);
            try { Log.write(`⚠ 启动失败：${err.message}`); } catch (_) { /* 连面板都没建出来，控制台报错已经够用 */ }
        }
    }

    async function bootInner() {
        Panel.build();
        Log.write('脚本已就绪');
        KeepAlive.notes.forEach((n) => Log.write('保活：' + n));

        if (/登录|注册/.test((document.body.innerText || '').slice(0, 400))) {
            Log.write('⚠ 看起来未登录，请先登录');
        }

        // 路径被 SPA 吃掉时先修回来，修完这次页面会重载，后面不用继续
        if (healPath()) return;

        COURSES = await loadCourses();
        Panel.render();
        watchMultiEnd(); // 瞬时弹窗必须即时响应，不能等心跳

        if (!onCoursePage()) {
            Log.write('请在右侧目录里点一门课开始');
            State.running = false;
            Panel.render();
            return;
        }

        const cid = currentCourseId();
        const idx = COURSES.findIndex((c) => c.id === cid);
        Log.write(`当前课程：第 ${idx + 1 || '?'}/${COURSES.length} 门《${(COURSES[idx] || {}).name || '未知'}》`);
        Log.write(State.running ? '继续自动播放' : '未在运行 —— 点目录里的「开始」即可');

        // 当前这门课即使没在运行也先统计一次进度，让目录立刻显示真实数字
        if (onCoursePage()) {
            const live = countProgress(document);
            if (live.rows && live.titled >= live.rows) {
                State.setStat(currentCourseId(), live.done, live.total);
                Panel.render();
            }
        }

        /*
         * 一门课的进度都没缓存过 → 后台自动扫一遍，让目录一开始就是真实数字。
         * sessionStorage 打标记，本次浏览器会话只跑一次；
         * 否则每翻一门课都要重扫 11 门，代价太大。
         */
        if (!sessionStorage.getItem('sedu-probed') && !COURSES.some((c) => State.stat(c.id))) {
            sessionStorage.setItem('sedu-probed', '1');
            probeAll();   // 不 await，后台跑，不挡播放
        }

        // 先立刻跑一轮，别干等第一次心跳。
        // 翻课是整页跳转，11 门课就是 11 次页面加载，每次白等 4 秒累计很可观。
        if (State.running) soon(300);

        const mode = KeepAlive.startTicker(tick, CONFIG.tickInterval);
        Log.write(`保活：${mode}`);
    }

    // @run-at 是 document-start，此时还没有 DOM，必须等
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
