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
        await h.install(player, SCRIPT, { values: { 'gzwy-course-autonext-enabled': enabled } })
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

    await env.close()
    t.done()
})().catch(error => { console.error(error); process.exitCode = 1 })
