// ==UserScript==
// @name         贵州省网络研修专题｜完成后切换下一门课
// @name:zh-CN   贵州省网络研修专题｜完成后切换下一门课
// @name:en      Guizhou Online Training｜Next Course After Completion
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2026.11.11.3
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
    const ROOT_ID = 'gzwy-course-autonext-panel';
    const POLL_MS = 2000;
    const KEEPALIVE_KEY = 'gzwy-course-autonext-keepalive';
    const KEEPALIVE_MS = 5000;
    const COMPLETION_TIMEOUT_MS = 10 * 60000;
    const TOPIC_ID = '28c0ade8b77e42ac821863d958ade8c8';
    let enabled = GM_getValue(ENABLED_KEY, false) === true;
    let keepAlive = GM_getValue(KEEPALIVE_KEY, false) === true;
    let handedOff = false;
    let endedForCurrentCourse = false;
    let processing = false;
    let readyTarget = null;
    let currentCourseId = '';
    let lastRefresh = 0;

    function routeInfo() {
        const route = PAGE.location.hash || '';
        const isTopic = route.includes('/pc/nc/pagespecial/specialDetail') &&
            new URLSearchParams(route.split('?')[1] || '').get('id') === TOPIC_ID;
        const isPlayer = route.includes('/pc/nc/pagecourse/coursePlayer');
        const courseId = isPlayer ? new URLSearchParams(route.split('?')[1] || '').get('id') || '' : '';
        return { isTopic, isPlayer, courseId };
    }

    let routeState = routeInfo();
    if (!routeState.isTopic && !routeState.isPlayer) return;
    currentCourseId = routeState.courseId;
    const isTopicPage = routeState.isTopic;

    PAGE.addEventListener('hashchange', () => {
        const nextRoute = routeInfo();
        if (nextRoute.isPlayer && nextRoute.courseId && nextRoute.courseId !== currentCourseId) {
            currentCourseId = nextRoute.courseId;
            endedForCurrentCourse = false;
            readyTarget = null;
            lastRefresh = 0;
            setStatus('已进入《' + currentCourseId + '》，继续按平台进度学习。');
            console.info(TAG, '已识别当前课程路由', currentCourseId);
        }
    });

    function findCourseListVm(win) {
        try {
            const doc = win.document;
            const seen = new Set();
            const stack = [];
            const add = vm => { if (vm && !seen.has(vm)) { seen.add(vm); stack.push(vm); } };
            doc.querySelectorAll('*').forEach(node => add(node.__vue__));
            const app = doc.getElementById('app');
            if (app) add(app.__vue__);

            while (stack.length) {
                const vm = stack.pop();
                if (Array.isArray(vm.lists) && typeof vm.clickEnter === 'function' &&
                    vm.lists.some(group => Array.isArray(group.subList))) return vm;
                if (Array.isArray(vm.$children)) vm.$children.forEach(add);
            }
        } catch (error) {
            console.debug(TAG, '无法读取专题页课程列表', error);
        }
        return null;
    }

    function findPlayerVm() {
        const seen = new Set();
        const stack = [];
        const add = vm => { if (vm && !seen.has(vm)) { seen.add(vm); stack.push(vm); } };
        PAGE.document.querySelectorAll('*').forEach(node => add(node.__vue__));
        const app = PAGE.document.getElementById('app');
        if (app) add(app.__vue__);
        while (stack.length) {
            const vm = stack.pop();
            const children = vm.chapterInfo && vm.chapterInfo.children;
            if (String(vm.queryiId || '') === currentCourseId && vm.curPlayItem && Array.isArray(children)) return vm;
            if (Array.isArray(vm.$children)) vm.$children.forEach(add);
        }
        return null;
    }

    function isLastCoursewareAtEnd() {
        const vm = findPlayerVm();
        const children = vm && vm.chapterInfo && vm.chapterInfo.children;
        if (!vm || !Array.isArray(children) || !children.length || !vm.curPlayItem) return false;
        const index = children.findIndex(item => String(item.id) === String(vm.curPlayItem.id));
        return index >= 0 && index === children.length - 1;
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

    function completionRefresher(vm) {
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

    function button(label, callback, className) {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = label;
        el.className = className || '';
        el.addEventListener('click', callback);
        return el;
    }

    function openNext(vm, target) {
        if (!enabled || !target || !vm || typeof vm.clickEnter !== 'function') return;
        try {
            const item = target.item;
            // 与用户手动点击「进入」走同一套站点逻辑：时间、报名、前置条件、人脸验证。
            callNativeEnter(vm, target);
            // 本页的课已学完：停掉保活，避免站点绕回第一段后在旧标签页里继续播。
            handedOff = true;
            const actions = document.querySelector('#' + ROOT_ID + ' [data-actions]');
            if (actions) actions.replaceChildren(button('重新打开：' + (item.name || '下一门课程'), () => openNext(vm, target), 'primary'));
            setStatus('已交给平台打开《' + (item.name || '下一门课程') + '》。本页已停止播放；若浏览器拦截了新标签页，请允许弹窗后点下方按钮重试。', 'info');
            console.info(TAG, '已调用专题页原生课程入口', item.name || item.businessId);
        } catch (error) {
            console.error(TAG, '进入下一门失败', error);
            setStatus('打开下一门失败。请确认专题页仍开着，再试一次。', 'error');
        }
    }

    async function checkCompletion() {
        if (!enabled || !endedForCurrentCourse || processing || readyTarget) return;
        processing = true;
        setStatus('视频已结束，正在等平台同步课程完成状态…');

        const opener = PAGE.opener;
        if (!opener || opener.closed) {
            setStatus('找不到仍打开的专题页。请从专题页进入课程，并保留专题页窗口。', 'error');
            processing = false;
            return;
        }

        const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
        while (Date.now() < deadline && enabled && endedForCurrentCourse) {
            const vm = findCourseListVm(opener);
            if (!vm) {
                setStatus('专题页课程列表尚未加载，正在等待…');
                await new Promise(resolve => setTimeout(resolve, POLL_MS));
                continue;
            }

            const rows = courseRows(vm);
            if (!rows.some(row => String(row.item.businessId) === currentCourseId)) {
                setStatus('专题页列表中找不到当前课程，请确认课程由这个专题页打开。', 'error');
                break;
            }
            const now = Date.now();
            const refresh = completionRefresher(vm);
            if (refresh && now - lastRefresh >= 6000) {
                try { refresh(); lastRefresh = now; } catch (error) { console.debug(TAG, '刷新专题进度失败', error); }
            }
            await new Promise(resolve => setTimeout(resolve, POLL_MS));

            const refreshedVm = findCourseListVm(opener) || vm;
            const refreshedRows = courseRows(refreshedVm);
            const currentIndex = refreshedRows.findIndex(row => String(row.item.businessId) === currentCourseId);
            if (currentIndex < 0) continue;
            const current = refreshedRows[currentIndex];
            if (progressOf(current.item) < 100) {
                setStatus('平台当前记录进度 ' + progressOf(current.item) + '%，完成后会继续检查。');
                continue;
            }

            const nextPending = refreshedRows.slice(currentIndex + 1).find(row => progressOf(row.item) < 100);
            if (!nextPending) {
                setStatus('专题列表中没有尚未完成的下一门课程。', 'success');
                break;
            }
            if (nextPending.item.typeValue !== 'course') {
                setStatus('下一项是“' + (nextPending.item.typeText || nextPending.item.typeValue || '非课程项目') + '”，请按平台要求手动完成。');
                break;
            }
            if (!canEnter(refreshedVm, nextPending.item)) {
                setStatus('下一门课程当前未开放或不满足平台前置条件，请先按平台提示处理。');
                break;
            }

            // 走平台原生入口，避免跳过它的课程时间和前置条件判定。
            openNext(refreshedVm, nextPending);
            break;
        }

        if (!readyTarget && enabled && endedForCurrentCourse && Date.now() >= deadline) {
            setStatus('暂未收到课程完成状态。请等平台进度更新，或检查是否还有未完成的课程内容。');
        }
        processing = false;
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

    function keepAliveTick() {
        const media = document.querySelector('video,audio');
        if (handedOff) {
            if (enabled && media && !media.paused) media.pause();
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
        if (endedForCurrentCourse || !media || !media.paused || media.ended) return;
        Promise.resolve(media.play()).catch(() => {
            // 没有用户手势时浏览器只允许静音自动播放。
            media.muted = true;
            return media.play();
        }).catch(error => console.debug(TAG, '续播失败', error));
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
            enabled = checkbox.checked;
            GM_setValue(ENABLED_KEY, enabled);
            if (enabled) {
                setStatus('已开启。课程会按平台实际完成进度切换。');
                if (endedForCurrentCourse) checkCompletion();
            } else {
                readyTarget = null;
                host.querySelector('[data-actions]').replaceChildren();
                setStatus('已暂停自动切课。');
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
            host.querySelector('[data-actions]').append(button('开始学习第一门未完成课程', startFirstCourse, 'primary'));
            setStatus(enabled ? '已开启。点「开始学习」进入第一门未完成课程。' : '先开启自动续课，再点「开始学习」进入第一门未完成课程。');
        } else {
            setStatus(enabled ? '已开启。正在等待当前课程播放结束。' : '请先开启；只在课程自然播放结束并被平台记为完成后切换。');
        }
    }

    function startFirstCourse() {
        const vm = findCourseListVm(PAGE);
        if (!vm) {
            setStatus('专题课程列表还在加载，请稍等后再点。');
            return;
        }
        const firstPending = courseRows(vm).find(row => progressOf(row.item) < 100);
        if (!firstPending) {
            setStatus('专题列表中没有未完成课程。', 'success');
            return;
        }
        if (firstPending.item.typeValue !== 'course') {
            setStatus('下一项是“' + (firstPending.item.typeText || firstPending.item.typeValue || '非课程项目') + '”，请先按平台要求处理。');
            return;
        }
        if (!canEnter(vm, firstPending.item)) {
            setStatus('第一门未完成课程当前未开放或不满足平台前置条件，请先按平台提示处理。');
            return;
        }
        enabled = true;
        GM_setValue(ENABLED_KEY, true);
        const checkbox = document.querySelector('#' + ROOT_ID + ' [data-enabled]');
        if (checkbox) checkbox.checked = true;
        setStatus('正在调用平台入口打开《' + (firstPending.item.name || '第一门课程') + '》…');
        try {
            callNativeEnter(vm, firstPending);
        } catch (error) {
            console.error(TAG, '开始课程失败', error);
            setStatus('未能打开课程。请确认登录和报名状态后重试。', 'error');
        }
    }

    function watchMedia(media) {
        if (!(media instanceof HTMLMediaElement) || media.dataset.gzwyAutoNextBound) return;
        media.dataset.gzwyAutoNextBound = '1';
        media.addEventListener('ended', () => {
            // 课程内的资源仍由网站原生连播；仅在最后一个资源自然结束时检查专题下一门。
            if (!isLastCoursewareAtEnd()) {
                setStatus('本段已结束，平台正在继续当前课程。');
                return;
            }
            endedForCurrentCourse = true;
            checkCompletion();
        }, true);
    }

    function start() {
        renderPanel();
        if (isTopicPage) {
            console.info(TAG, '专题页已就绪；点击「开始学习第一门未完成课程」。');
            return;
        }
        installVisibilityShield();
        setInterval(keepAliveTick, KEEPALIVE_MS);
        document.querySelectorAll('video,audio').forEach(watchMedia);
        new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (node.matches && node.matches('video,audio')) watchMedia(node);
            if (node.querySelectorAll) node.querySelectorAll('video,audio').forEach(watchMedia);
        }))).observe(document.documentElement, { childList: true, subtree: true });
        console.info(TAG, '已启动；课程进度和导航均由平台原生逻辑处理。');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
