// ==UserScript==
// @name         贵州省网络研修专题｜完成后切换下一门课
// @name:zh-CN   贵州省网络研修专题｜完成后切换下一门课
// @name:en      Guizhou Online Training｜Next Course After Completion
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2026.11.11.5
// @description  从专题页一键进入第一门未完成课程；课程完成后通过平台原生入口打开下一门；可选后台保活。
// @description:zh-CN 从专题页一键进入第一门未完成课程；课程完成后通过平台原生入口打开下一门；可选后台保活。
// @description:en  Start the first unfinished course from the topic page, then use the platform's native entry for the next course after completion.
// @author       壹樂（V：ita1125）
// @match        http://gzwy.gov.cn/page.html*
// @match        https://gzwy.gov.cn/page.html*
// @match        http://www.gzwy.gov.cn/page.html*
// @match        https://www.gzwy.gov.cn/page.html*
// @icon         http://www.gzwy.gov.cn/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @license      MIT
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/gzwy-course-autonext/gzwy-course-autonext.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/gzwy-course-autonext/gzwy-course-autonext.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const TAG = '[专题续课]';
    const PAGE = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    const ENABLED_KEY = 'gzwy-course-autonext-enabled';
    const KEEPALIVE_KEY = 'gzwy-course-autonext-keepalive';
    // 专题页正在学的课程 businessId；播放页据此判断自己是不是已经被换下去了。
    const ACTIVE_KEY = 'gzwy-course-autonext-active';
    const ROOT_ID = 'gzwy-course-autonext-panel';
    const NUDGE_EVENT = 'gzwy-course-autonext-check';
    const TICK_MS = 5000;
    const TOPIC_POLL_MS = 60000;
    const REFRESH_WAIT_MS = 2500;
    const NUDGE_GAP_MS = 20000;
    const TOPIC_ID = '28c0ade8b77e42ac821863d958ade8c8';
    let enabled = GM_getValue(ENABLED_KEY, false) === true;
    let keepAlive = GM_getValue(KEEPALIVE_KEY, false) === true;
    let activeId = String(GM_getValue(ACTIVE_KEY, '') || '');
    let currentCourseId = '';
    // 专题页
    let advancing = false;
    // 播放页
    let handedOff = false;
    let courseDone = false;
    let lastNudge = 0;

    function routeInfo() {
        const route = PAGE.location.hash || '';
        const isTopic = route.includes('/pc/nc/pagespecial/specialDetail') &&
            new URLSearchParams(route.split('?')[1] || '').get('id') === TOPIC_ID;
        const isPlayer = route.includes('/pc/nc/pagecourse/coursePlayer');
        const courseId = isPlayer ? new URLSearchParams(route.split('?')[1] || '').get('id') || '' : '';
        return { isTopic, isPlayer, courseId };
    }

    const routeState = routeInfo();
    if (!routeState.isTopic && !routeState.isPlayer) return;
    currentCourseId = routeState.courseId;
    const isTopicPage = routeState.isTopic;

    PAGE.addEventListener('hashchange', () => {
        const nextRoute = routeInfo();
        if (nextRoute.isPlayer && nextRoute.courseId && nextRoute.courseId !== currentCourseId) {
            currentCourseId = nextRoute.courseId;
            handedOff = false;
            courseDone = false;
            lastNudge = 0;
            console.info(TAG, '已识别当前课程路由', currentCourseId);
        }
    });

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function findVm(win, match) {
        try {
            const doc = win.document;
            const seen = new Set();
            const stack = [];
            const add = vm => { if (vm && !seen.has(vm)) { seen.add(vm); stack.push(vm); } };
            doc.querySelectorAll('*').forEach(node => add(node.__vue__));
            while (stack.length) {
                const vm = stack.pop();
                if (match(vm)) return vm;
                if (Array.isArray(vm.$children)) vm.$children.forEach(add);
            }
        } catch (error) {
            console.debug(TAG, '读取页面组件失败', error);
        }
        return null;
    }

    // 用功能特征识别 Vue 实例，不依赖压缩后的组件名。
    function findCourseListVm() {
        return findVm(PAGE, vm => Array.isArray(vm.lists) && typeof vm.clickEnter === 'function' &&
            vm.lists.some(group => Array.isArray(group.subList)));
    }

    function findPlayerVm() {
        return findVm(PAGE, vm => String(vm.queryiId || '') === currentCourseId && vm.curPlayItem &&
            vm.chapterInfo && Array.isArray(vm.chapterInfo.children));
    }

    function courseRows(vm) {
        const rows = [];
        (vm.lists || []).forEach(group => (group.subList || []).forEach((item, index) => {
            rows.push({ item, group, index });
        }));
        return rows;
    }

    function progressOf(item) {
        const value = Number(item && item.progress);
        return Number.isFinite(value) ? value : 0;
    }

    function nameOf(row) {
        return (row && row.item && row.item.name) || '未命名课程';
    }

    // 贵州站点用项目版组件覆盖了通用组件，clickEnter 的参数表不同：
    //   项目版（dsf-pc.js）：clickEnter(group, item, classId, group, index, previousProgress, isStudentFlag)
    //   通用版（dsf-nc.pc.js）：clickEnter(item, classId, group, index, previousProgress)
    // 按形参个数区分，调用方式与页面「进入」按钮的模板保持一致。
    function usesProjectSignature(vm) {
        const methods = vm.$options && vm.$options.methods;
        const fn = (methods && methods.clickEnter) || vm.clickEnter;
        return fn.length >= 6;
    }

    function canEnter(vm, item) {
        if (usesProjectSignature(vm)) return vm.isstudent == 1 || (!!vm.showClick && !!item.playState);
        return !!vm.showClick && !!item.playState;
    }

    // 与用户手动点击「进入」走同一套站点逻辑：时间、报名、前置条件、人脸验证。
    function callNativeEnter(vm, row) {
        const { item, group, index } = row;
        const previousProgress = index > 0 ? group.subList[index - 1].progress : null;
        if (usesProjectSignature(vm)) {
            if (vm.isstudent == 1) vm.clickEnter(group, item, group.classId, group, index, previousProgress, 1);
            else vm.clickEnter(group, item, group.classId, group, index, previousProgress);
        } else {
            vm.clickEnter(item, group.classId, group, index, previousProgress);
        }
    }

    function listRefresher(vm) {
        if (typeof vm.initData === 'function') return () => vm.initData();
        const parent = vm.$parent;
        if (parent && typeof parent.initData === 'function') return () => parent.initData();
        return null;
    }

    function setStatus(message, kind) {
        const status = document.querySelector('#' + ROOT_ID + ' [data-status]');
        if (!status) return;
        status.textContent = message;
        status.dataset.kind = kind || 'info';
    }

    function setActions(...buttons) {
        const actions = document.querySelector('#' + ROOT_ID + ' [data-actions]');
        if (actions) actions.replaceChildren(...buttons);
    }

    function button(label, callback, className) {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = label;
        el.className = className || '';
        el.addEventListener('click', callback);
        return el;
    }

    function setEnabled(value) {
        enabled = value;
        GM_setValue(ENABLED_KEY, value);
        const checkbox = document.querySelector('#' + ROOT_ID + ' [data-enabled]');
        if (checkbox) checkbox.checked = value;
    }

    function setActive(id) {
        activeId = id;
        GM_setValue(ACTIVE_KEY, id);
    }

    // ---- 专题页：盯着课程列表，当前课程记满 100% 就打开下一门 ----

    function startButton() {
        return button('开始学习第一门未完成课程', startFirstCourse, 'primary');
    }

    function reopenButton(row) {
        return button('重新打开：' + nameOf(row), () => {
            const vm = findCourseListVm();
            const fresh = vm && courseRows(vm).find(item => String(item.item.businessId) === String(row.item.businessId));
            if (fresh) enterCourse(vm, fresh);
        });
    }

    function stopWatching(message, kind) {
        setActive('');
        setActions(startButton());
        setStatus(message, kind);
    }

    function enterCourse(vm, row) {
        try {
            callNativeEnter(vm, row);
        } catch (error) {
            console.error(TAG, '打开课程失败', error);
            setStatus('未能打开《' + nameOf(row) + '》。请确认登录和报名状态后重试。', 'error');
            return false;
        }
        setActive(String(row.item.businessId));
        setActions(reopenButton(row));
        setStatus('已打开《' + nameOf(row) + '》，本页会盯着进度，到 100% 自动进入下一门。没看到新标签页就允许弹出式窗口后点下方按钮。');
        console.info(TAG, '已调用专题页原生课程入口', nameOf(row));
        return true;
    }

    // 返回第一门未完成课程；不能进入时给出原因并返回 null。
    function pickNext(vm, rows) {
        const next = rows.find(row => progressOf(row.item) < 100);
        if (!next) {
            stopWatching('专题列表中没有未完成课程了。', 'success');
            return null;
        }
        if (next.item.typeValue !== 'course') {
            stopWatching('下一项是“' + (next.item.typeText || next.item.typeValue || '非课程项目') + '”，请按平台要求手动完成后再点开始。');
            return null;
        }
        if (!canEnter(vm, next.item)) {
            stopWatching('《' + nameOf(next) + '》当前未开放或不满足平台前置条件，请先按平台提示处理。');
            return null;
        }
        return next;
    }

    function startFirstCourse() {
        const vm = findCourseListVm();
        if (!vm) {
            setStatus('专题课程列表还在加载，请稍等后再点。');
            return;
        }
        const next = pickNext(vm, courseRows(vm));
        if (!next) return;
        setEnabled(true);
        enterCourse(vm, next);
    }

    async function advance() {
        if (!enabled || !activeId || advancing) return;
        advancing = true;
        try {
            let vm = findCourseListVm();
            if (!vm) return;
            const refresh = listRefresher(vm);
            if (refresh) {
                try { refresh(); } catch (error) { console.debug(TAG, '刷新专题进度失败', error); }
                await sleep(REFRESH_WAIT_MS);
                vm = findCourseListVm() || vm;
            }
            if (!enabled || !activeId) return;
            const rows = courseRows(vm);
            const current = rows.find(row => String(row.item.businessId) === activeId);
            if (!current) {
                stopWatching('专题列表里找不到正在学的课程，已停止。请重新点开始。', 'error');
                return;
            }
            if (progressOf(current.item) < 100) {
                setStatus('正在学《' + nameOf(current) + '》，平台记录 ' + progressOf(current.item) + '%。到 100% 自动进入下一门。');
                return;
            }
            const next = pickNext(vm, rows);
            if (next) enterCourse(vm, next);
        } finally {
            advancing = false;
        }
    }

    function startTopic() {
        setInterval(advance, TOPIC_POLL_MS);
        // 播放页发现课件全部看完时会来催一次，不用等下一轮定时检查。
        PAGE.addEventListener(NUDGE_EVENT, () => { advance(); });
        if (enabled && activeId) {
            setStatus('继续盯着上次打开的课程进度…');
            advance();
        }
        console.info(TAG, '专题页已就绪；点击「开始学习第一门未完成课程」。');
    }

    // ---- 播放页：课件看完后催专题页检查；被换下去后停播 ----

    // 不能用「最后一段播完」来判断：站点的结束回调先执行，会立刻把当前课件绕回第一段。
    function allCoursewareFinished() {
        const vm = findPlayerVm();
        const children = vm && vm.chapterInfo && vm.chapterInfo.children;
        return Array.isArray(children) && children.length > 0 &&
            children.every(item => Number(item.finishedRate) >= 100);
    }

    function nudgeTopic() {
        const now = Date.now();
        if (now - lastNudge < NUDGE_GAP_MS) return;
        lastNudge = now;
        try {
            const opener = PAGE.opener;
            if (opener && !opener.closed) opener.dispatchEvent(new opener.CustomEvent(NUDGE_EVENT));
        } catch (error) {
            console.debug(TAG, '通知专题页失败，等专题页自己的定时检查', error);
        }
    }

    function checkCourse() {
        if (!enabled) return;
        const active = String(GM_getValue(ACTIVE_KEY, '') || '');
        if (active && active !== currentCourseId) {
            if (!handedOff) {
                handedOff = true;
                setStatus('专题页已切到下一门，本页已停止播放。', 'success');
                console.info(TAG, '本课已被换下');
                // 脚本打开的标签页才关得掉；关不掉就留着，只是不再播放。
                if (keepAlive) setTimeout(() => { try { PAGE.close(); } catch (error) { /* 留着即可 */ } }, 1500);
            }
            return;
        }
        handedOff = false;
        courseDone = allCoursewareFinished();
        if (courseDone) {
            setStatus('本课课件已全部完成，等专题页核对进度后进入下一门。请保留专题页标签页。');
            nudgeTopic();
        }
    }

    // ---- 后台保活（默认关闭，只在播放页生效）----
    // 站点播放器有两处会让挂后台的课停下来：
    //   1. initPlayerTabStop：visibilitychange 且 document.hidden 时暂停播放器；
    //   2. 无操作提醒：document.onmousemove 超过设定分钟数没触发，就暂停并弹「是否继续学习」。
    // 人脸核验、随堂测验等弹窗不处理，出现时停下来等人工操作。
    function installVisibilityShield() {
        const doc = PAGE.document;
        const proto = PAGE.Document.prototype;
        const shield = (name, value) => {
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc || !desc.get) return;
            try {
                Object.defineProperty(doc, name, {
                    configurable: true,
                    get: () => (keepAlive && !handedOff ? value : desc.get.call(doc)),
                });
            } catch (error) { console.debug(TAG, '无法接管 ' + name, error); }
        };
        shield('hidden', false);
        shield('webkitHidden', false);
        shield('visibilityState', 'visible');
        shield('webkitVisibilityState', 'visible');
        ['visibilitychange', 'webkitvisibilitychange'].forEach(type => doc.addEventListener(type, event => {
            if (keepAlive && !handedOff) event.stopImmediatePropagation();
        }, true));
    }

    function isShown(el) {
        return getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    }

    function playerTick() {
        checkCourse();
        const media = document.querySelector('video,audio');
        if (handedOff) {
            if (media && !media.paused) media.pause();
            return;
        }
        if (!keepAlive) return;

        // 等同于动了一下鼠标：重置站点的无操作计时。
        const poke = PAGE.document.onmousemove;
        if (typeof poke === 'function') {
            try { poke.call(PAGE.document, new MouseEvent('mousemove')); } catch (error) { console.debug(TAG, '重置无操作计时失败', error); }
        }

        const box = Array.from(document.querySelectorAll('.el-message-box__wrapper')).find(isShown);
        if (box) {
            const confirm = box.textContent.includes('是否继续学习') && box.querySelector('.el-message-box__btns .el-button--primary');
            if (confirm) { confirm.click(); console.info(TAG, '已确认「是否继续学习」'); }
            else setStatus('平台弹出了提示窗口，请手动处理。');
            return;
        }
        if (Array.from(document.querySelectorAll('.el-dialog__wrapper')).some(isShown)) {
            setStatus('平台弹出了验证或答题窗口，请手动处理，处理完会继续播放。');
            return;
        }
        // 课件全看完后站点会从头循环播放，不去打断它，也不必再续播。
        if (courseDone || !media || !media.paused || media.ended) return;
        Promise.resolve(media.play()).catch(() => {
            // 没有用户手势时浏览器只允许静音自动播放。
            media.muted = true;
            return media.play();
        }).catch(error => console.debug(TAG, '续播失败', error));
    }

    function startPlayer() {
        installVisibilityShield();
        setInterval(playerTick, TICK_MS);
        // 一段播完后平台会回写完成度，稍等再查一次，比等下一轮定时检查快。
        document.addEventListener('ended', () => setTimeout(checkCourse, 3000), true);
        console.info(TAG, '已启动；课程进度和导航均由平台原生逻辑处理。');
    }

    function renderPanel() {
        if (document.getElementById(ROOT_ID)) return;
        const host = document.createElement('section');
        host.id = ROOT_ID;
        host.innerHTML = '<div class="title">专题续课</div>' +
            '<label class="switch"><input type="checkbox" data-enabled><span>课程完成后进入下一门</span></label>' +
            '<label class="switch"><input type="checkbox" data-keepalive><span>后台保活（切到后台不暂停、自动续播）</span></label>' +
            '<div class="status" data-status></div><div class="actions" data-actions></div>';
        const style = document.createElement('style');
        style.textContent =
            '#' + ROOT_ID + '{position:fixed;z-index:2147483646;right:18px;bottom:18px;width:300px;box-sizing:border-box;padding:14px 16px;background:#fff;border:1px solid #dcdfe6;border-radius:10px;box-shadow:0 4px 18px #0002;color:#303133;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
            '#' + ROOT_ID + ' .title{font-size:15px;font-weight:700;margin-bottom:8px}' +
            '#' + ROOT_ID + ' .switch{display:flex;align-items:center;gap:8px;cursor:pointer}' +
            '#' + ROOT_ID + ' .switch input{accent-color:#409eff}' +
            '#' + ROOT_ID + ' .status{margin-top:8px;color:#606266;font-size:12px}' +
            '#' + ROOT_ID + ' .status[data-kind="success"]{color:#67c23a}' +
            '#' + ROOT_ID + ' .status[data-kind="error"]{color:#f56c6c}' +
            '#' + ROOT_ID + ' .actions:empty{display:none}' +
            '#' + ROOT_ID + ' button{margin-top:10px;padding:7px 10px;border:1px solid #409eff;border-radius:5px;background:#fff;color:#409eff;cursor:pointer}' +
            '#' + ROOT_ID + ' button.primary{background:#409eff;color:#fff}';
        document.documentElement.append(style, host);
        const checkbox = host.querySelector('[data-enabled]');
        checkbox.checked = enabled;
        checkbox.addEventListener('change', () => {
            setEnabled(checkbox.checked);
            if (isTopicPage) {
                if (enabled) setStatus(activeId ? '已开启，继续盯着课程进度。' : '已开启。点「开始学习」进入第一门未完成课程。');
                else setStatus('已暂停自动切课。');
                if (enabled) advance();
            } else {
                setStatus(enabled ? '已开启。课件全部完成后由专题页进入下一门。' : '已暂停自动切课。');
            }
        });
        const keepBox = host.querySelector('[data-keepalive]');
        keepBox.checked = keepAlive;
        keepBox.addEventListener('change', () => {
            keepAlive = keepBox.checked;
            GM_setValue(KEEPALIVE_KEY, keepAlive);
            if (isTopicPage) setStatus(keepAlive ? '后台保活已开启，对之后打开的课程页生效。' : '后台保活已关闭，对之后打开的课程页生效。');
            else setStatus(keepAlive ? '后台保活已开启：切到后台不暂停，暂停后会自动续播。' : '后台保活已关闭。');
        });
        if (isTopicPage) {
            setActions(startButton());
            setStatus(enabled ? '已开启。点「开始学习」进入第一门未完成课程。' : '点「开始学习」进入第一门未完成课程，之后自动一门接一门。');
        } else {
            setStatus(enabled ? '已开启。课件全部完成后由专题页进入下一门。' : '请先开启；课程被平台记为完成后才切换。');
        }
    }

    function start() {
        renderPanel();
        if (isTopicPage) startTopic();
        else startPlayer();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
