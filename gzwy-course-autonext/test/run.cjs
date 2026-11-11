'use strict'

const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'gzwy-course-autonext.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const CURRENT_ID = 'course-current'
const NEXT_ID = 'course-next'

;(async () => {
    const env = await h.setup(FIXTURES)
    const t = h.createRunner('gzwy-course-autonext')
    const { assert, eq } = t

    async function openCourse(enabled, options = {}) {
        const context = await env.browser.newContext()
        const player = await context.newPage()
        await h.install(player, SCRIPT, { values: { 'gzwy-course-autonext-enabled': enabled, 'gzwy-course-autonext-keepalive': options.keepAlive === true } })
        await player.goto(env.base + '/player.html#/pc/nc/pagecourse/coursePlayer?id=' + CURRENT_ID)
        await player.evaluate(({ currentId, nextId, nextType }) => {
            const next = { businessId: nextId, name: '下一门', typeValue: nextType, typeText: nextType === 'exam' ? '考试' : '课程', progress: 0, playState: true }
            const current = { businessId: currentId, name: '当前课', typeValue: 'course', typeText: '课程', progress: 100, playState: true }
            const group = { classId: 'class-1', subList: [current, next] }
            document.body.__vue__ = {
                lists: [group], showClick: true,
                $parent: { initData() {} },
                clickEnter(item) { window.opener.__entered = item.businessId },
            }
            document.getElementById('app').__vue__ = document.body.__vue__
            const opener = { document, closed: false, __entered: null }
            Object.defineProperty(window, 'opener', { configurable: true, value: opener })
        }, { currentId: CURRENT_ID, nextId: NEXT_ID, nextType: options.nextType || 'course' })
        await player.evaluate(({ currentId, lastResource }) => {
            document.body.__vue__ = {
                queryiId: currentId,
                curPlayItem: { id: lastResource ? 'last-resource' : 'first-resource' },
                chapterInfo: { children: [{ id: 'first-resource' }, { id: 'last-resource' }] },
            }
        }, { currentId: CURRENT_ID, lastResource: options.lastResource !== false })
        return { context, player }
    }

    await t.test('末段自然结束且平台已记满进度时调用专题原生入口', async () => {
        const { context, player } = await openCourse(true)
        try {
            await player.waitForSelector('#gzwy-course-autonext-panel')
            await player.$eval('#lesson', video => video.dispatchEvent(new Event('ended')))
            await player.waitForFunction(() => window.opener.__entered === 'course-next', null, { timeout: 8000 })
            eq(await player.evaluate(() => window.opener.__entered), 'course-next')
            assert((await h.errors(player)).length === 0, '播放页有未捕获异常')
        } finally { await context.close() }
    })

    await t.test('默认关闭时不会自动切课', async () => {
        const { context, player } = await openCourse(false)
        try {
            await player.waitForSelector('#gzwy-course-autonext-panel')
            await player.$eval('#lesson', video => video.dispatchEvent(new Event('ended')))
            await player.waitForTimeout(2500)
            eq(await player.evaluate(() => window.opener.__entered || null), null)
            eq(await player.$eval('#gzwy-course-autonext-panel [data-enabled]', input => input.checked), false)
            assert((await h.errors(player)).length === 0, '播放页有未捕获异常')
        } finally { await context.close() }
    })

    await t.test('当前课程中间段结束时不切到下一门', async () => {
        const { context, player } = await openCourse(true, { lastResource: false })
        try {
            await player.waitForSelector('#gzwy-course-autonext-panel')
            await player.$eval('#lesson', video => video.dispatchEvent(new Event('ended')))
            await player.waitForTimeout(2500)
            eq(await player.evaluate(() => window.opener.__entered || null), null)
        } finally { await context.close() }
    })

    await t.test('专题下一项是考试时不调用课程入口', async () => {
        const { context, player } = await openCourse(true, { nextType: 'exam' })
        try {
            await player.waitForSelector('#gzwy-course-autonext-panel')
            await player.$eval('#lesson', video => video.dispatchEvent(new Event('ended')))
            await player.waitForFunction(() => document.querySelector('#gzwy-course-autonext-panel [data-status]').textContent.includes('考试'))
            eq(await player.evaluate(() => window.opener.__entered || null), null)
        } finally { await context.close() }
    })

    await t.test('专题页显示开始按钮并选择第一门未完成课程', async () => {
        const context = await env.browser.newContext()
        const page = await context.newPage()
        await h.install(page, SCRIPT, { values: { 'gzwy-course-autonext-enabled': false } })
        await page.goto(env.base + '/topic.html#/pc/nc/pagespecial/specialDetail?id=28c0ade8b77e42ac821863d958ade8c8')
        await page.evaluate(() => {
            const completed = { businessId: 'done', name: '已完成', typeValue: 'course', progress: 100, playState: true }
            const pending = { businessId: 'first-pending', name: '第一门未完成', typeValue: 'course', progress: 0, playState: true }
            const group = { classId: 'class-start', subList: [completed, pending] }
            document.body.__vue__ = {
                lists: [group], showClick: true, $parent: { initData() {} },
                clickEnter(item) { window.__selectedCourse = item.businessId },
            }
        })
        try {
            await page.waitForSelector('#gzwy-course-autonext-panel')
            await page.click('#gzwy-course-autonext-panel [data-actions] button')
            eq(await page.evaluate(() => window.__selectedCourse), 'first-pending')
            eq(await page.$eval('#gzwy-course-autonext-panel [data-enabled]', input => input.checked), true)
        } finally { await context.close() }
    })

    await t.test('项目版 clickEnter（7 个形参）按 group, item, classId… 的顺序调用', async () => {
        const context = await env.browser.newContext()
        const page = await context.newPage()
        await h.install(page, SCRIPT, { values: { 'gzwy-course-autonext-enabled': false } })
        await page.goto(env.base + '/topic.html#/pc/nc/pagespecial/specialDetail?id=28c0ade8b77e42ac821863d958ade8c8')
        await page.evaluate(() => {
            const completed = { businessId: 'done', name: '已完成', typeValue: 'course', progress: 100, playState: true }
            const pending = { businessId: 'first-pending', name: '第一门未完成', typeValue: 'course', progress: 0, playState: true }
            const group = { classId: 'class-start', subList: [completed, pending] }
            // 与站点 dsf-pc.js 的检查一致：第二个参数不是课程行时提示「不在学习时间范围」。
            function clickEnter(e, t, s, a, i, n, o) {
                if (!t || !t.playState) { window.__toast = '不在学习时间范围'; return }
                window.__call = { groupFirst: e === group, item: t.businessId, classId: s, groupFourth: a === group, index: i, previous: n, flag: o === undefined ? null : o }
            }
            document.body.__vue__ = {
                lists: [group], showClick: true, $parent: { initData() {} },
                $options: { methods: { clickEnter } }, clickEnter,
            }
        })
        try {
            await page.waitForSelector('#gzwy-course-autonext-panel')
            await page.click('#gzwy-course-autonext-panel [data-actions] button')
            eq(await page.evaluate(() => window.__toast || null), null)
            eq(JSON.stringify(await page.evaluate(() => window.__call)),
                JSON.stringify({ groupFirst: true, item: 'first-pending', classId: 'class-start', groupFourth: true, index: 1, previous: 100, flag: null }))
        } finally { await context.close() }
    })

    // 保活测试：fixture 的 video 没有片源，一直是 paused，用假的 play() 计数。
    async function armKeepAliveProbes(player) {
        await player.waitForSelector('#gzwy-course-autonext-panel')
        await player.evaluate(() => {
            window.__played = 0; window.__moved = 0; window.__visibility = 0
            document.getElementById('lesson').play = () => { window.__played++; return Promise.resolve() }
            document.onmousemove = () => { window.__moved++ }
            document.addEventListener('visibilitychange', () => { window.__visibility++ })
            document.dispatchEvent(new Event('visibilitychange'))
        })
    }

    await t.test('后台保活开启：拦下 visibilitychange、重置无操作计时、暂停后续播', async () => {
        const { context, player } = await openCourse(true, { keepAlive: true })
        try {
            await armKeepAliveProbes(player)
            await player.waitForFunction(() => window.__played > 0 && window.__moved > 0, null, { timeout: 9000 })
            eq(await player.evaluate(() => window.__visibility), 0)
            eq(await player.evaluate(() => document.hidden), false)
            assert((await h.errors(player)).length === 0, '播放页有未捕获异常')
        } finally { await context.close() }
    })

    await t.test('后台保活关闭：不拦事件、不续播', async () => {
        const { context, player } = await openCourse(true, { keepAlive: false })
        try {
            await armKeepAliveProbes(player)
            await player.waitForTimeout(6500)
            eq(await player.evaluate(() => window.__played), 0)
            eq(await player.evaluate(() => window.__moved), 0)
            eq(await player.evaluate(() => window.__visibility), 1)
        } finally { await context.close() }
    })

    await t.test('平台弹出验证/答题窗口时保活不续播', async () => {
        const { context, player } = await openCourse(true, { keepAlive: true })
        try {
            await armKeepAliveProbes(player)
            await player.evaluate(() => {
                const dialog = document.createElement('div')
                dialog.className = 'el-dialog__wrapper'
                dialog.textContent = '扫一扫人脸识别'
                document.body.append(dialog)
                window.__played = 0
            })
            await player.waitForFunction(() => document.querySelector('#gzwy-course-autonext-panel [data-status]').textContent.includes('手动处理'), null, { timeout: 9000 })
            await player.waitForTimeout(5500)
            eq(await player.evaluate(() => window.__played), 0)
        } finally { await context.close() }
    })

    await t.test('「是否继续学习」弹窗自动点确认', async () => {
        const { context, player } = await openCourse(true, { keepAlive: true })
        try {
            await armKeepAliveProbes(player)
            await player.evaluate(() => {
                const box = document.createElement('div')
                box.className = 'el-message-box__wrapper'
                box.innerHTML = '<p>您已学习30分钟了,是否继续学习？</p><div class="el-message-box__btns"><button class="el-button">取消</button><button class="el-button el-button--primary">确定</button></div>'
                box.querySelector('.el-button--primary').addEventListener('click', () => { window.__confirmed = true; box.remove() })
                document.body.append(box)
            })
            await player.waitForFunction(() => window.__confirmed === true, null, { timeout: 9000 })
        } finally { await context.close() }
    })

    await t.test('交给平台打开下一门后，本页停止保活并出现重试按钮', async () => {
        const { context, player } = await openCourse(true, { keepAlive: true })
        try {
            await armKeepAliveProbes(player)
            await player.$eval('#lesson', video => video.dispatchEvent(new Event('ended')))
            await player.waitForFunction(() => window.opener.__entered === 'course-next', null, { timeout: 8000 })
            await player.evaluate(() => { window.__played = 0; window.opener.__entered = null })
            await player.waitForTimeout(5500)
            eq(await player.evaluate(() => window.__played), 0)
            await player.click('#gzwy-course-autonext-panel [data-actions] button')
            eq(await player.evaluate(() => window.opener.__entered), 'course-next')
        } finally { await context.close() }
    })

    await env.close()
    t.done()
})().catch(error => { console.error(error); process.exitCode = 1 })
