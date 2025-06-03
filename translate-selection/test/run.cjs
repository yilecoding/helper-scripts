/*
 * 划词翻译的端到端测试。不访问外网：所有翻译接口的返回都由 xhr 模拟，格式照真实接口构造。
 *
 * 运行：
 *   NODE_PATH=/path/to/node_modules node translate-selection/test/run.cjs
 */
'use strict'

const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'translate-selection.user.js')
const ICON = 'translate-selection-host .icon'
const CARD = 'translate-selection-host .card'
const DST = CARD + ' .dst:not(.loading)'

/**
 * 按 translate_a/single 的真实格式构造返回（实测抓过 hello / 你好 / 两句中文）：
 *   [[[译文, 原文, null, null, 10], …], 词典 | null, 源语言, null, null, null, 1, [], [[源语言], null, [1], [源语言]]]
 */
function googleBody(segments, { src = 'en', dict = null } = {}) {
    return JSON.stringify([
        segments.map(([dst, orig]) => [dst, orig, null, null, 10]),
        dict, src, null, null, null, 1, [], [[src], null, [1], [src]],
    ])
}

/**
 * MyMemory 的真实格式（实测）。注意出错时 HTTP 也是 200，
 * responseStatus 是字符串 "403"，错误信息放在 translatedText 里。
 */
function myMemoryBody(text, { status = 200, detected = 'en', details = '' } = {}) {
    return JSON.stringify({
        responseData: status === 200 ? { translatedText: text, match: 0.85, detectedLanguage: detected } : { translatedText: details },
        quotaFinished: status === 200 ? false : null,
        mtLangSupported: null,
        responseDetails: details,
        responseStatus: status === 200 ? 200 : String(status),
        responderId: null,
        exception_code: null,
        matches: [],
    })
}

const isMyMemory = d => d.url.startsWith('https://api.mymemory.translated.net/get')
const isGoogle = d => d.url.startsWith('https://translate.googleapis.com/translate_a/single')
const query = d => new URL(d.url).searchParams

/** 新开一个页面并装好脚本。xhr 不传时所有请求都返回 500。返回 { page, requests }。 */
async function open(env, { xhr, values } = {}) {
    const page = await env.browser.newPage()
    const requests = []
    await h.install(page, SCRIPT, {
        values,
        xhr: async details => {
            requests.push(details)
            return xhr ? xhr(details) : { status: 500, responseText: '' }
        },
    })
    await page.goto(env.base + '/index.html')
    return { page, requests }
}

/** 用 Range 选中元素的全部文字，然后在选区末端派发 mouseup（可带 altKey）。 */
async function selectText(page, selector, { alt = false } = {}) {
    await page.evaluate(({ selector, alt }) => {
        const el = document.querySelector(selector)
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.right, clientY: r.bottom, altKey: alt }))
    }, { selector, alt })
}

async function main() {
    const env = await h.setup(path.join(__dirname, 'fixtures'))
    const t = h.createRunner('translate-selection')

    await t.test('选中文字后在选区末端旁出现图标', async () => {
        const { page } = await open(env)
        await selectText(page, '#en')
        await page.waitForSelector(ICON, { state: 'visible' })
        const icon = await page.locator(ICON).boundingBox()
        const end = await page.evaluate(() => {
            const r = document.createRange()
            r.selectNodeContents(document.querySelector('#en'))
            const rects = r.getClientRects()
            const last = rects[rects.length - 1]
            return { right: last.right, bottom: last.bottom }
        })
        t.assert(Math.abs(icon.x - end.right) < 20 && Math.abs(icon.y - end.bottom) < 20,
            `图标应贴着选区末端，实际 ${JSON.stringify(icon)}，末端 ${JSON.stringify(end)}`)
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('真实鼠标双击选词也会出图标，点空白处图标消失', async () => {
        const { page } = await open(env)
        await page.dblclick('#word')
        await page.waitForSelector(ICON, { state: 'visible' })
        await page.mouse.click(600, 700)
        await page.waitForSelector(ICON, { state: 'hidden' })
        await page.close()
    })

    await t.test('点图标不会清掉页面选区', async () => {
        const { page } = await open(env)
        await selectText(page, '#en')
        await page.click(ICON)
        t.eq(await page.evaluate(() => window.getSelection().toString()), 'Machine translation has improved a lot in recent years.')
        await page.close()
    })

    await t.test('点图标后请求 Google 接口，参数正确，卡片显示译文', async () => {
        const { page, requests } = await open(env, {
            xhr: d => ({ responseText: googleBody([['近年来机器翻译进步很大。', 'Machine translation has improved a lot in recent years.']]) }),
        })
        await selectText(page, '#en')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(requests.length, 1)
        const d = requests[0]
        t.assert(isGoogle(d), d.url)
        t.eq(d.method, 'GET')
        const q = query(d)
        t.eq(q.get('client'), 'gtx')
        t.eq(q.get('sl'), 'auto')
        t.eq(q.get('tl'), 'zh-CN')
        t.eq(q.getAll('dt'), ['t', 'bd'])
        t.eq(q.get('q'), 'Machine translation has improved a lot in recent years.')
        t.eq(await page.textContent(DST), '近年来机器翻译进步很大。')
        t.eq(await page.textContent(CARD + ' .src'), 'Machine translation has improved a lot in recent years.')
        t.assert((await page.textContent(CARD + ' .meta')).includes('Google'))
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('多段译文按顺序拼接', async () => {
        const { page } = await open(env, {
            xhr: () => ({ responseText: googleBody([['The weather is nice today. ', '今天天气很好，'], ["Let's go for a walk in the park.", '我们去公园散步吧。']], { src: 'zh-CN' }) }),
        })
        await selectText(page, '#zh')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(await page.textContent(DST), "The weather is nice today. Let's go for a walk in the park.")
        await page.close()
    })

    for (const [sel, tl, why] of [
        ['#zh', 'en', '中文 → 英文'],
        ['#en', 'zh-CN', '英文 → 中文'],
        ['#ja', 'zh-CN', '日文（汉字 + 假名）→ 中文'],
        ['#mixed', 'en', '中文里夹英文术语仍按中文 → 英文'],
        ['#zhword', 'en', '中文单词 → 英文'],
    ]) {
        await t.test(`方向判断：${why}`, async () => {
            const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['x', 'y']]) }) })
            await selectText(page, sel)
            await page.click(ICON)
            await page.waitForSelector(DST)
            t.eq(query(requests[0]).get('tl'), tl)
            t.assert((await page.textContent(CARD + ' .meta')).endsWith('→ ' + tl))
            await page.close()
        })
    }

    await t.test('选中单词时渲染词典释义（词性缩写 + 释义）', async () => {
        // 结构照 q=run 的真实返回裁剪：每个词性一项，第三列是带反查词和权重的明细
        const dict = [
            ['verb', ['运行', '执行', '跑', '经营', '奔跑', '办', '跑步', '管理'], [['运行', ['run', 'move'], null, 0.597], ['执行', ['execute', 'run'], null, 0.078]], 'run', 2],
            ['noun', ['跑', '运转', '奔跑'], [['跑', ['run'], null, 0.1]], 'run', 1],
            ['unknown-pos', ['某义'], [], 'run', 99],
        ]
        const { page } = await open(env, { xhr: () => ({ responseText: googleBody([['跑步', 'run']], { dict }) }) })
        await selectText(page, '#run')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(await page.textContent(DST), '跑步')
        const rows = await page.$$eval(CARD + ' .dict .row', rs => rs.map(r => [r.querySelector('.pos').textContent, r.querySelector('.terms').textContent]))
        t.eq(rows, [
            ['v.', '运行；执行；跑；经营；奔跑；办'],   // 截到 dictTerms = 6 个
            ['n.', '跑；运转；奔跑'],
            ['unknown-pos', '某义'],                  // 不认识的词性原样显示
        ])
        await page.close()
    })

    await t.test('句子（dict 为 null）不显示词典区', async () => {
        const { page } = await open(env, { xhr: () => ({ responseText: googleBody([['偶然性', 'serendipity']]) }) })
        await selectText(page, '#word')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(await page.$$(CARD + ' .dict'), [])
        await page.close()
    })

    await t.test('接口失败时卡片显示错误和重试，而不是空白', async () => {
        let fail = true
        const { page, requests } = await open(env, {
            xhr: () => (fail ? { status: 503, responseText: '' } : { responseText: googleBody([['好', 'good']]) }),
        })
        await selectText(page, '#word')
        await page.click(ICON)
        await page.waitForSelector(CARD + ' .error')
        const msg = await page.textContent(CARD + ' .error')
        t.assert(msg.includes('Google 翻译：HTTP 503') && msg.includes('MyMemory：HTTP 503'), msg)
        fail = false
        await page.click(CARD + ' .error button')
        await page.waitForSelector(DST)
        t.eq(await page.textContent(DST), '好')
        t.eq(requests.length, 3)
        await page.close()
    })

    await t.test('Google 失败时降级到 MyMemory，参数正确', async () => {
        const { page, requests } = await open(env, {
            xhr: d => (isGoogle(d) ? { status: 429, responseText: '' } : { responseText: myMemoryBody('机器翻译近年来进步很大。') }),
        })
        await selectText(page, '#en')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(requests.map(d => (isGoogle(d) ? 'google' : isMyMemory(d) ? 'mymemory' : d.url)), ['google', 'mymemory'])
        const q = query(requests[1])
        t.eq(q.get('q'), 'Machine translation has improved a lot in recent years.')
        t.eq(q.get('langpair'), 'autodetect|zh-CN')
        t.eq(await page.textContent(DST), '机器翻译近年来进步很大。')
        t.assert((await page.textContent(CARD + ' .meta')).startsWith('MyMemory'))
        await page.close()
    })

    await t.test('Google 超时（一直不返回）也会降级', async () => {
        const { page, requests } = await open(env, {
            values: { settings: { timeoutMs: 300 } },
            xhr: d => (isGoogle(d) ? new Promise(() => {}) : { responseText: myMemoryBody('你好') }),
        })
        await selectText(page, '#word')
        await page.click(ICON)
        await page.waitForSelector(DST, { timeout: 3000 })
        t.eq(await page.textContent(DST), '你好')
        t.eq(requests.length, 2)
        await page.close()
    })

    await t.test('MyMemory 在 HTTP 200 里返回的错误不会被当成译文', async () => {
        const details = "'XX' IS AN INVALID TARGET LANGUAGE . EXAMPLE: LANGPAIR=EN|IT USING 2 LETTER ISO OR RFC3066 LIKE ZH-CN."
        const { page } = await open(env, {
            xhr: d => (isGoogle(d) ? { status: 500, responseText: '' } : { responseText: myMemoryBody('', { status: 403, details }) }),
        })
        await selectText(page, '#en')
        await page.click(ICON)
        await page.waitForSelector(CARD + ' .error')
        t.assert((await page.textContent(CARD + ' .error')).includes('INVALID TARGET LANGUAGE'))
        t.eq(await page.$$(CARD + ' .dst:not(.error):not(.loading)'), [])
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
