'use strict'

const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'gzwy-course-autonext.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const TOPIC_URL = '/topic.html#/pc/nc/pagespecial/specialDetail?id=28c0ade8b77e42ac821863d958ade8c8'
const PANEL = '#gzwy-course-autonext-panel'
const K = { enabled: 'gzwy-course-autonext-enabled', keepAlive: 'gzwy-course-autonext-keepalive', active: 'gzwy-course-autonext-active' }

;(async () => {
    const env = await h.setup(FIXTURES)
    const t = h.createRunner('gzwy-course-autonext')
    const { assert, eq } = t

    const gmActive = page => page.evaluate(() => JSON.parse(localStorage.getItem('__gm:gzwy-course-autonext-active') || '""'))
    const status = page => page.$eval(PANEL + ' [data-status]', el => el.textContent)
    const nudge = page => page.evaluate(() => { window.dispatchEvent(new CustomEvent('gzwy-course-autonext-check')) })

    // 专题页：rows 是 [businessId, progress, typeValue?]；refreshTo 给出 initData 之后的进度。
    async function openTopic(values, rows, options = {}) {
        const context = await env.browser.newContext()
        const page = await context.newPage()
        await h.install(page, SCRIPT, { values: { [K.enabled]: false, [K.keepAlive]: false, [K.active]: '', ...values } })
        await page.goto(env.base + TOPIC_URL)
        await page.evaluate(({ rows, refreshTo, projectSignature }) => {
            const make = list => list.map(([businessId, progress, typeValue]) => ({
                businessId, name: '课程 ' + businessId, progress, playState: true,
                typeValue: typeValue || 'course', typeText: typeValue === 'exam' ? '考试' : '课程',
            }))
            const group = { classId: 'class-1', subList: make(rows) }
            window.__entered = []
            window.__refreshed = 0
            const enter = item => window.__entered.push(item.businessId)
            // 项目版与站点 dsf-pc.js 的检查一致：第二个参数不是课程行时提示「不在学习时间范围」。
            const clickEnter = projectSignature
                ? function (e, t, s, a, i, n, o) {
                    if (!t || !t.playState) { window.__toast = '不在学习时间范围'; return }
                    window.__call = { groupFirst: e === vm.lists[0], classId: s, groupFourth: a === vm.lists[0], index: i, previous: n, flag: o === undefined ? null : o }
                    enter(t)
                }
                : function (item) { enter(item) }
            const vm = {
                lists: [group], showClick: true, clickEnter,
                $options: { methods: { clickEnter } },
                $parent: {
                    initData() {
                        window.__refreshed++
                        if (refreshTo) vm.lists = [{ classId: 'class-1', subList: make(refreshTo) }]
                    },
                },
            }
            document.body.__vue__ = vm
        }, { rows, refreshTo: options.refreshTo || null, projectSignature: options.projectSignature === true })
        await page.waitForSelector(PANEL)
        return { context, page }
    }

    // 播放页：rates 是各课件的 finishedRate。
    async function openPlayer(values, rates) {
        const context = await env.browser.newContext()
        const page = await context.newPage()
        await h.install(page, SCRIPT, { values: { [K.enabled]: true, [K.keepAlive]: false, [K.active]: 'c1', ...values } })
        await page.goto(env.base + '/player.html#/pc/nc/pagecourse/coursePlayer?id=c1')
        await page.evaluate(rates => {
            const children = rates.map((finishedRate, index) => ({ id: 'w' + index, finishedRate }))
            // 与真实站点一致：最后一段播完后站点已把当前课件绕回第一段，只能看完成度。
            document.body.__vue__ = { queryiId: 'c1', curPlayItem: children[0], chapterInfo: { children } }
            window.__nudged = 0; window.__played = 0; window.__paused = 0; window.__moved = 0; window.__visibility = 0
            const opener = { closed: false, CustomEvent, dispatchEvent(event) { if (event.type === 'gzwy-course-autonext-check') window.__nudged++ } }
            Object.defineProperty(window, 'opener', { configurable: true, value: opener })
            // fixture 的 video 没有片源，一直是 paused，用假的 play() 计数。
            const video = document.getElementById('lesson')
            video.play = () => { window.__played++; return Promise.resolve() }
            document.onmousemove = () => { window.__moved++ }
            document.addEventListener('visibilitychange', () => { window.__visibility++ })
            document.dispatchEvent(new Event('visibilitychange'))
        }, rates)
        await page.waitForSelector(PANEL)
        return { context, page }
    }

    // ---------- 专题页 ----------

    await t.test('点开始：进入第一门未完成课程并记为正在学', async () => {
        const { context, page } = await openTopic({}, [['c1', 100], ['c2', 0], ['c3', 0]])
        try {
            await page.click(PANEL + ' [data-actions] button')
            eq(JSON.stringify(await page.evaluate(() => window.__entered)), '["c2"]')
            eq(await gmActive(page), 'c2')
            eq(await page.$eval(PANEL + ' [data-enabled]', input => input.checked), true)
            assert((await status(page)).includes('课程 c2'), '状态里没有课程名')
            assert((await h.errors(page)).length === 0, '专题页有未捕获异常')
        } finally { await context.close() }
    })

    await t.test('项目版 clickEnter（7 个形参）按 group, item, classId… 的顺序调用', async () => {
        const { context, page } = await openTopic({}, [['c1', 100], ['c2', 0]], { projectSignature: true })
        try {
            await page.click(PANEL + ' [data-actions] button')
            eq(await page.evaluate(() => window.__toast || null), null)
            eq(JSON.stringify(await page.evaluate(() => window.__entered)), '["c2"]')
            eq(JSON.stringify(await page.evaluate(() => window.__call)),
                JSON.stringify({ groupFirst: true, classId: 'class-1', groupFourth: true, index: 1, previous: 100, flag: null }))
        } finally { await context.close() }
    })

    await t.test('正在学的课程刷新后记满 100%：自动进入下一门', async () => {
        const { context, page } = await openTopic({ [K.enabled]: true, [K.active]: 'c2' },
            [['c1', 100], ['c2', 60], ['c3', 0]], { refreshTo: [['c1', 100], ['c2', 100], ['c3', 0]] })
        try {
            await nudge(page)
            await page.waitForFunction(() => window.__entered.length > 0, null, { timeout: 8000 })
            eq(JSON.stringify(await page.evaluate(() => window.__entered)), '["c3"]')
            eq(await gmActive(page), 'c3')
            assert(await page.evaluate(() => window.__refreshed) >= 1, '没有刷新专题列表')
            assert((await h.errors(page)).length === 0, '专题页有未捕获异常')
        } finally { await context.close() }
    })

    await t.test('正在学的课程还没记满：不切，状态显示当前进度', async () => {
        const { context, page } = await openTopic({ [K.enabled]: true, [K.active]: 'c2' }, [['c1', 100], ['c2', 60], ['c3', 0]])
        try {
            await nudge(page)
            await page.waitForFunction(sel => document.querySelector(sel).textContent.includes('60%'), PANEL + ' [data-status]', { timeout: 8000 })
            eq(JSON.stringify(await page.evaluate(() => window.__entered)), '[]')
            eq(await gmActive(page), 'c2')
        } finally { await context.close() }
    })

    await t.test('开关关闭时不切', async () => {
        const { context, page } = await openTopic({ [K.enabled]: false, [K.active]: 'c1' }, [['c1', 100], ['c2', 0]])
        try {
            await nudge(page)
            await page.waitForTimeout(4000)
            eq(JSON.stringify(await page.evaluate(() => window.__entered)), '[]')
        } finally { await context.close() }
    })

    await t.test('下一项是考试：不进入，停止盯进度', async () => {
        const { context, page } = await openTopic({ [K.enabled]: true, [K.active]: 'c1' }, [['c1', 100], ['c2', 0, 'exam'], ['c3', 0]])
        try {
            await nudge(page)
            await page.waitForFunction(sel => document.querySelector(sel).textContent.includes('考试'), PANEL + ' [data-status]', { timeout: 8000 })
            eq(JSON.stringify(await page.evaluate(() => window.__entered)), '[]')
            eq(await gmActive(page), '')
        } finally { await context.close() }
    })

    await t.test('全部学完：提示没有未完成课程', async () => {
        const { context, page } = await openTopic({ [K.enabled]: true, [K.active]: 'c2' }, [['c1', 100], ['c2', 100]])
        try {
            await nudge(page)
            await page.waitForFunction(sel => document.querySelector(sel).textContent.includes('没有未完成课程'), PANEL + ' [data-status]', { timeout: 8000 })
            eq(await gmActive(page), '')
        } finally { await context.close() }
    })

    await t.test('「重新打开」按钮再次进入正在学的课程', async () => {
        const { context, page } = await openTopic({}, [['c1', 0], ['c2', 0]])
        try {
            await page.click(PANEL + ' [data-actions] button')
            await page.click(PANEL + ' [data-actions] button')
            eq(JSON.stringify(await page.evaluate(() => window.__entered)), '["c1","c1"]')
        } finally { await context.close() }
    })

    // ---------- 播放页 ----------

    await t.test('课件全部记满：通知专题页检查（当前课件已被站点绕回第一段）', async () => {
        const { context, page } = await openPlayer({}, [100, 100, 100])
        try {
            await page.waitForFunction(() => window.__nudged > 0, null, { timeout: 9000 })
            assert((await status(page)).includes('全部完成'), '状态没有提示课件已完成')
            assert((await h.errors(page)).length === 0, '播放页有未捕获异常')
        } finally { await context.close() }
    })

    await t.test('还有课件没记满 / 开关关闭：不通知', async () => {
        const a = await openPlayer({}, [100, 60])
        const b = await openPlayer({ [K.enabled]: false }, [100, 100])
        try {
            await a.page.waitForTimeout(6500)
            eq(await a.page.evaluate(() => window.__nudged), 0)
            eq(await b.page.evaluate(() => window.__nudged), 0)
        } finally { await a.context.close(); await b.context.close() }
    })

    await t.test('专题页已切到别的课程：本页停播、不再保活', async () => {
        const { context, page } = await openPlayer({ [K.active]: 'c2' }, [100, 100])
        try {
            await page.waitForFunction(sel => document.querySelector(sel).textContent.includes('已停止播放'), PANEL + ' [data-status]', { timeout: 9000 })
            await page.waitForTimeout(5500)
            eq(await page.evaluate(() => window.__played), 0)
            eq(await page.evaluate(() => window.__nudged), 0)
        } finally { await context.close() }
    })

    await t.test('后台保活开启：拦下 visibilitychange、重置无操作计时、暂停后续播', async () => {
        const { context, page } = await openPlayer({ [K.keepAlive]: true }, [100, 60])
        try {
            await page.waitForFunction(() => window.__played > 0 && window.__moved > 0, null, { timeout: 9000 })
            eq(await page.evaluate(() => window.__visibility), 0)
            eq(await page.evaluate(() => document.hidden), false)
            assert((await h.errors(page)).length === 0, '播放页有未捕获异常')
        } finally { await context.close() }
    })

    await t.test('后台保活关闭：不拦事件、不续播', async () => {
        const { context, page } = await openPlayer({}, [100, 60])
        try {
            await page.waitForTimeout(6500)
            eq(await page.evaluate(() => window.__played), 0)
            eq(await page.evaluate(() => window.__moved), 0)
            eq(await page.evaluate(() => window.__visibility), 1)
        } finally { await context.close() }
    })

    await t.test('平台弹出验证/答题窗口时保活不续播', async () => {
        const { context, page } = await openPlayer({ [K.keepAlive]: true }, [100, 60])
        try {
            await page.evaluate(() => {
                const dialog = document.createElement('div')
                dialog.className = 'el-dialog__wrapper'
                dialog.textContent = '扫一扫人脸识别'
                document.body.append(dialog)
            })
            await page.waitForFunction(sel => document.querySelector(sel).textContent.includes('手动处理'), PANEL + ' [data-status]', { timeout: 9000 })
            await page.evaluate(() => { window.__played = 0 })
            await page.waitForTimeout(5500)
            eq(await page.evaluate(() => window.__played), 0)
        } finally { await context.close() }
    })

    await t.test('「是否继续学习」弹窗自动点确认', async () => {
        const { context, page } = await openPlayer({ [K.keepAlive]: true }, [100, 60])
        try {
            await page.evaluate(() => {
                const box = document.createElement('div')
                box.className = 'el-message-box__wrapper'
                box.innerHTML = '<p>您已学习30分钟了,是否继续学习？</p><div class="el-message-box__btns"><button class="el-button">取消</button><button class="el-button el-button--primary">确定</button></div>'
                box.querySelector('.el-button--primary').addEventListener('click', () => { window.__confirmed = true; box.remove() })
                document.body.append(box)
            })
            await page.waitForFunction(() => window.__confirmed === true, null, { timeout: 9000 })
        } finally { await context.close() }
    })

    await env.close()
    t.done()
})().catch(error => { console.error(error); process.exitCode = 1 })
