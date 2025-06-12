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

/**
 * 模拟一次拖选：先 mousedown（和真实操作一样，会关掉已开的卡片），
 * 再用 Range 选中元素的全部文字，最后在选区末端派发 mouseup（可带 altKey）。
 */
async function selectText(page, selector, { alt = false } = {}) {
    await page.evaluate(({ selector, alt }) => {
        const el = document.querySelector(selector)
        const r0 = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r0.left, clientY: r0.top, altKey: alt }))
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.right, clientY: r.bottom, altKey: alt }))
    }, { selector, alt })
}

/** 往页面末尾塞一段长文本（第 5000 个 UTF-16 码元正好是一个 emoji 的前半个），返回它的长度。 */
async function addLongText(page) {
    return page.evaluate(() => {
        const sentence = 'The quick brown fox jumps over the lazy dog. '   // 45 字
        const text = sentence.repeat(111) + 'abcd' + '😀' + sentence.repeat(30).trimEnd()  // 4995 + 4 = 4999，emoji 占 4999-5000
        // 末尾不留空格：块末尾的空白不渲染，Selection.toString() 里也没有，长度会差 1
        const p = document.createElement('p')
        p.id = 'long'
        p.textContent = text
        document.body.insertBefore(p, document.body.firstChild)
        return text.length
    })
}

/** 在输入框里选中 [start, end)，然后在输入框上派发 mouseup（和真实拖选一样，焦点在输入框里）。 */
async function selectInField(page, selector, start, end) {
    await page.evaluate(({ selector, start, end }) => {
        const el = document.querySelector(selector)
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 }))
        el.focus()
        el.setSelectionRange(start, end)
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + 120, clientY: r.top + 10 }))
    }, { selector, start, end })
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

    await t.test('缓存命中：同一段再翻译不再发请求', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['近年来机器翻译进步很大。', 'x']]) }) })
        for (let i = 0; i < 2; i++) {
            await selectText(page, '#en')
            await page.click(ICON)
            await page.waitForSelector(DST)
            t.eq(await page.textContent(DST), '近年来机器翻译进步很大。')
            await page.mouse.click(700, 600)   // 点外面关掉卡片
            await page.waitForSelector(CARD, { state: 'hidden' })
        }
        t.eq(requests.length, 1)
        await page.close()
    })

    await t.test('LRU：超过容量淘汰最久没用的那条', async () => {
        const { page, requests } = await open(env, {
            values: { settings: { cacheSize: 2 } },
            xhr: () => ({ responseText: googleBody([['x', 'y']]) }),
        })
        for (const sel of ['#en', '#zh', '#en', '#word', '#en', '#zh']) {
            await selectText(page, sel)
            await page.click(ICON)
            await page.waitForSelector(DST)
        }
        // #en 第二次命中（被挪到最新）；#word 进来时挤掉的是 #zh；所以 #en 第三次命中、#zh 第二次要重新请求
        t.eq(requests.map(d => query(d).get('q').slice(0, 7)), ['Machine', '今天天气很好，', 'serendi', '今天天气很好，'])
        await page.close()
    })

    await t.test('失败的结果不进缓存', async () => {
        let fail = true
        const { page, requests } = await open(env, {
            xhr: () => (fail ? { status: 500, responseText: '' } : { responseText: googleBody([['好', 'good']]) }),
        })
        await selectText(page, '#word')
        await page.click(ICON)
        await page.waitForSelector(CARD + ' .error')
        fail = false
        await selectText(page, '#word')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(requests.length, 3)
        await page.close()
    })

    await t.test('超长选区截断到 5000 字并提示；长文本走 POST；不切开 emoji', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['很长的译文', 'x']]) }) })
        const total = await addLongText(page)
        t.assert(total > 5000, `长文本应超过 5000 字，实际 ${total}`)
        await selectText(page, '#long')
        await page.click(ICON)
        await page.waitForSelector(DST)
        const d = requests[0]
        t.eq(d.method, 'POST')
        t.eq(query(d).get('q'), null)
        t.eq(query(d).get('tl'), 'zh-CN')
        const q = new URLSearchParams(d.data).get('q')
        t.eq(q.length, 4999)        // 第 5000 个码元是半个 emoji，整个丢掉
        t.assert(q.endsWith('abcd'), q.slice(-10))
        t.eq(await page.textContent(CARD + ' .note'), `选中了 ${total} 字，只翻译了前 4999 字`)
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('降级到 MyMemory 时按 500 字截断并提示', async () => {
        const { page, requests } = await open(env, {
            xhr: d => (isGoogle(d) ? { status: 500, responseText: '' } : { responseText: myMemoryBody('一部分译文') }),
        })
        await addLongText(page)
        await selectText(page, '#long')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(query(requests[1]).get('q').length, 500)
        const notes = await page.$$eval(CARD + ' .note', ns => ns.map(n => n.textContent))
        t.assert(notes.some(n => n.includes('500')), JSON.stringify(notes))
        await page.close()
    })

    await t.test('Esc 关闭卡片', async () => {
        const { page } = await open(env, { xhr: () => ({ responseText: googleBody([['好', 'good']]) }) })
        await selectText(page, '#word')
        await page.click(ICON)
        await page.waitForSelector(DST)
        await page.keyboard.press('Escape')
        await page.waitForSelector(CARD, { state: 'hidden' })
        await page.close()
    })

    await t.test('页面滚动一点不关，滚太远才关', async () => {
        const { page } = await open(env, { xhr: () => ({ responseText: googleBody([['好', 'good']]) }) })
        await selectText(page, '#word')
        await page.click(ICON)
        await page.waitForSelector(DST)
        await page.evaluate(() => window.scrollBy(0, 100))
        await page.waitForTimeout(100)
        t.assert(await page.isVisible(CARD), '滚 100px 卡片应还在')
        await page.evaluate(() => window.scrollBy(0, 500))
        await page.waitForSelector(CARD, { state: 'hidden' })
        await page.close()
    })

    await t.test('复制按钮把译文写进剪贴板', async () => {
        const { page } = await open(env, { xhr: () => ({ responseText: googleBody([['近年来机器翻译进步很大。', 'x']]) }) })
        await selectText(page, '#en')
        await page.click(ICON)
        await page.click(CARD + ' button.copy')
        t.eq((await h.gm(page)).clipboard, { text: '近年来机器翻译进步很大。', type: 'text' })
        t.eq(await page.textContent(CARD + ' button.copy'), '已复制')
        await page.close()
    })

    await t.test('朗读按目标语言挑 voice', async () => {
        const page = await env.browser.newPage()
        // 在脚本之前把 speechSynthesis 换成记录器，并提供几个假嗓音。
        // Utterance 也要换：真的 utterance.voice 只接受 SpeechSynthesisVoice 实例，赋假对象会抛 TypeError
        await page.addInitScript(() => {
            window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.lang = ''; this.voice = null } }
            window.__spoken = []
            const voices = [
                { name: 'Google US English', lang: 'en-US' },
                { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
                { name: 'Google 日本語', lang: 'ja-JP' },
            ]
            speechSynthesis.getVoices = () => voices
            speechSynthesis.speak = u => window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice && u.voice.name })
        })
        const requests = []
        await h.install(page, SCRIPT, {
            xhr: d => {
                requests.push(d)
                const tl = query(d).get('tl')
                return { responseText: googleBody([[tl === 'en' ? 'The weather is nice today.' : '今日はいい天気です。', 'x']], { src: 'zh-CN' }) }
            },
        })
        await page.goto(env.base + '/index.html')
        await selectText(page, '#zh')
        await page.click(ICON)
        await page.click(CARD + ' button.speak')
        // 换成日文重译后再念一次
        await page.selectOption(CARD + ' select.lang', 'ja')
        await page.waitForFunction(() => {
            const host = document.querySelector('translate-selection-host')
            const d = host && host.shadowRoot.querySelector('.dst:not(.loading)')
            return d && d.textContent.includes('天気')
        })
        await page.click(CARD + ' button.speak')
        t.eq(await page.evaluate(() => window.__spoken), [
            { text: 'The weather is nice today.', lang: 'en', voice: 'Google US English' },
            { text: '今日はいい天気です。', lang: 'ja', voice: 'Google 日本語' },
        ])
        await page.close()
    })

    await t.test('切换目标语言重新请求，下拉框显示当前语言', async () => {
        const { page, requests } = await open(env, {
            xhr: d => ({ responseText: googleBody([[query(d).get('tl') === 'ja' ? '機械翻訳' : '机器翻译', 'x']]) }),
        })
        await selectText(page, '#en')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(await page.$eval(CARD + ' select.lang', s => s.value), 'zh-CN')
        await page.selectOption(CARD + ' select.lang', 'ja')
        await page.waitForFunction(() => {
            const d = document.querySelector('translate-selection-host').shadowRoot.querySelector('.dst:not(.loading)')
            return d && d.textContent === '機械翻訳'
        })
        t.eq(requests.map(d => query(d).get('tl')), ['zh-CN', 'ja'])
        t.eq(await page.$eval(CARD + ' select.lang', s => s.value), 'ja')
        t.assert(await page.isVisible(CARD), '操作下拉框不应关掉卡片')
        await page.close()
    })

    await t.test('靠近视口底部时卡片翻到选区上方', async () => {
        const { page } = await open(env, { xhr: () => ({ responseText: googleBody([['这一段在页面最底部。', 'x']]) }) })
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        await selectText(page, '#bottom')
        await page.click(ICON)
        await page.waitForSelector(DST)
        const card = await page.locator(CARD).boundingBox()
        const sel = await page.evaluate(() => document.querySelector('#bottom').getBoundingClientRect().toJSON())
        t.assert(card.y + card.height <= sel.top + 1, `卡片应在选区上方：card=${JSON.stringify(card)} sel.top=${sel.top}`)
        const vh = await page.evaluate(() => document.documentElement.clientHeight)
        t.assert(card.y >= 0 && card.y + card.height <= vh, '卡片应完整留在视口里')
        await page.close()
    })

    await t.test('跟随系统暗色模式', async () => {
        const { page } = await open(env, { xhr: () => ({ responseText: googleBody([['好', 'good']]) }) })
        await selectText(page, '#word')
        await page.click(ICON)
        await page.waitForSelector(DST)
        const bg = () => page.$eval(CARD, el => getComputedStyle(el).backgroundColor)
        t.eq(await bg(), 'rgb(255, 255, 255)')
        await page.emulateMedia({ colorScheme: 'dark' })
        t.eq(await bg(), 'rgb(31, 41, 55)')
        await page.close()
    })

    await t.test('按住 Alt 选中直接翻译，不出图标', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['近年来机器翻译进步很大。', 'x']]) }) })
        await selectText(page, '#en', { alt: true })
        await page.waitForSelector(DST)
        t.eq(await page.textContent(DST), '近年来机器翻译进步很大。')
        t.assert(!(await page.isVisible(ICON)), '直接翻译时不该再出图标')
        t.eq(requests.length, 1)
        await page.close()
    })

    await t.test('快捷键 Alt+T 翻译当前选区', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['今天天气很好。', 'x']]) }) })
        // 键盘选中（不经过 mouseup），所以不会有图标，只能靠快捷键
        await page.evaluate(() => {
            const r = document.createRange()
            r.selectNodeContents(document.querySelector('#zh'))
            getSelection().removeAllRanges()
            getSelection().addRange(r)
        })
        await page.keyboard.press('Control+Alt+KeyT')   // 修饰键不对不触发
        await page.waitForTimeout(100)
        t.eq(requests.length, 0)
        await page.keyboard.press('Alt+KeyT')
        await page.waitForSelector(DST)
        t.eq(query(requests[0]).get('q'), '今天天气很好，我们去公园散步吧。')
        t.eq(query(requests[0]).get('tl'), 'en')
        await page.close()
    })

    await t.test('输入框里的选区：取选中部分，图标在输入框下方', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['敏捷的棕色狐狸', 'x']]) }) })
        await selectInField(page, '#inp', 4, 19)
        await page.waitForSelector(ICON, { state: 'visible' })
        const icon = await page.locator(ICON).boundingBox()
        const box = await page.locator('#inp').boundingBox()
        t.assert(icon.y >= box.y + box.height && icon.y < box.y + box.height + 20, `图标应紧贴输入框下沿：${JSON.stringify({ icon, box })}`)
        t.assert(icon.x >= box.x && icon.x <= box.x + box.width + 10, '图标横向应在输入框范围内')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(query(requests[0]).get('q'), 'quick brown fox')
        t.eq(await page.textContent(DST), '敏捷的棕色狐狸')
        // 点图标不应让输入框失焦、丢选区
        t.eq(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]), ['inp', 4, 19])
        await page.close()
    })

    await t.test('textarea 里的中文选区按中文 → 英文；快捷键也能用', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['Chinese in a text box', 'x']], { src: 'zh-CN' }) }) })
        await page.focus('#ta')
        await page.evaluate(() => document.querySelector('#ta').setSelectionRange(2, 12))
        await page.keyboard.press('Alt+KeyT')
        await page.waitForSelector(DST)
        t.eq(query(requests[0]).get('q'), '一段在文本框里的中文')
        t.eq(query(requests[0]).get('tl'), 'en')
        t.eq(await page.$eval('#ta', el => el.value), '这是一段在文本框里的中文。')   // 快捷键没往文本框里打字
        await page.close()
    })

    await t.test('密码框里的选区不处理', async () => {
        const { page } = await open(env)
        await selectInField(page, '#pwd', 0, 6)
        await page.waitForTimeout(200)
        t.assert(!(await page.isVisible(ICON)), '密码框不该出图标')
        await page.close()
    })

    await t.test('菜单注册了三项命令，文字带当前状态', async () => {
        const { page } = await open(env)
        t.eq((await h.gm(page)).menu, ['✅ 选中后显示翻译图标', '🌐 设置目标语言（当前：zh-CN）', '⛔ 在 127.0.0.1 上禁用'])
        await page.close()
    })

    await t.test('菜单关掉图标模式：选中不出图标，Alt 选中照样翻译，设置持久化', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['好', 'good']]) }) })
        await h.menu(page, '显示翻译图标')
        t.eq((await h.gm(page)).menu[0], '⬜ 选中后显示翻译图标')
        await selectText(page, '#word')
        await page.waitForTimeout(200)
        t.assert(!(await page.isVisible(ICON)), '关了图标模式不该出图标')
        await selectText(page, '#word', { alt: true })
        await page.waitForSelector(DST)
        t.eq(requests.length, 1)
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:settings'))), { showIcon: false })
        // 刷新后仍然是关的
        await page.reload()
        t.eq((await h.gm(page)).menu[0], '⬜ 选中后显示翻译图标')
        await selectText(page, '#word')
        await page.waitForTimeout(200)
        t.assert(!(await page.isVisible(ICON)), '刷新后图标模式应仍是关的')
        await page.close()
    })

    await t.test('菜单设置目标语言：无效代码被拒，有效的立即生效并持久化', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['x', 'y']]) }) })
        // 弹窗按出现顺序处理：prompt 填 answers 里的下一个值，alert 记下内容
        const answers = ['日语', 'ja']
        const alerts = []
        page.on('dialog', d => (d.type() === 'prompt' ? d.accept(answers.shift()) : (alerts.push(d.message()), d.dismiss())))
        await h.menu(page, '设置目标语言')
        t.assert(alerts.length === 1 && alerts[0].includes('不是有效的语言代码'), JSON.stringify(alerts))
        t.eq((await h.gm(page)).menu[1], '🌐 设置目标语言（当前：zh-CN）')
        await h.menu(page, '设置目标语言')
        t.eq((await h.gm(page)).menu[1], '🌐 设置目标语言（当前：ja）')
        await selectText(page, '#en')
        await page.click(ICON)
        await page.waitForSelector(DST)
        // 目标语言不是中文时，中文也译成它
        await selectText(page, '#zh')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(requests.map(d => query(d).get('tl')), ['ja', 'ja'])
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:settings'))), { targetLang: 'ja' })
        await page.close()
    })

    await t.test('站点黑名单：禁用后选中 / Alt / 快捷键都不响应，启用后恢复', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['好', 'good']]) }) })
        await h.menu(page, '上禁用')
        t.eq((await h.gm(page)).menu[2], '▶️ 在 127.0.0.1 上启用')
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:blacklist'))), ['127.0.0.1'])
        await selectText(page, '#word')
        await selectText(page, '#word', { alt: true })
        await page.keyboard.press('Alt+KeyT')
        await page.waitForTimeout(200)
        t.assert(!(await page.isVisible(ICON)), '禁用后不该出图标')
        t.eq(requests.length, 0)
        await h.menu(page, '上启用')
        await selectText(page, '#word')
        await page.waitForSelector(ICON, { state: 'visible' })
        t.eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:blacklist'))), [])
        await page.close()
    })

    await t.test('黑名单里的站点加载时就不挂监听', async () => {
        const { page } = await open(env, { values: { blacklist: ['127.0.0.1'] } })
        await selectText(page, '#word')
        await page.waitForTimeout(200)
        t.assert(!(await page.isVisible(ICON)), '黑名单站点不该出图标')
        t.eq((await h.gm(page)).menu[2], '▶️ 在 127.0.0.1 上启用')
        await page.close()
    })

    await t.test('三击选整段：末尾换行不带进请求，和拖选同一段共用缓存', async () => {
        const { page, requests } = await open(env, { xhr: () => ({ responseText: googleBody([['近年来机器翻译进步很大。', 'x']]) }) })
        await page.click('#en', { clickCount: 3 })   // 真实三击，Selection.toString() 末尾会带 "\n\n"
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(query(requests[0]).get('q'), 'Machine translation has improved a lot in recent years.')
        await selectText(page, '#en')
        await page.click(ICON)
        await page.waitForSelector(DST)
        t.eq(requests.length, 1)
        await page.close()
    })

    await t.test('先发的请求晚回来，不会覆盖后一次的卡片', async () => {
        const { page } = await open(env, {
            xhr: async d => {
                const slow = query(d).get('q').startsWith('Machine')
                if (slow) await new Promise(r => setTimeout(r, 600))
                return { responseText: googleBody([[slow ? '旧的' : '新的', 'x']]) }
            },
        })
        await selectText(page, '#en')
        await page.click(ICON)
        await selectText(page, '#word')
        await page.click(ICON)
        await page.waitForSelector(DST)
        await page.waitForTimeout(800)
        t.eq(await page.textContent(DST), '新的')
        await page.close()
    })

    await env.close()
    t.done()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
