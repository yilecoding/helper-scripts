/*
 * video-speed 测试。运行（仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node video-speed/test/run.cjs
 *
 * 不访问外网：fixtures 由 harness 的本地服务提供，「真实域名」用 page.route 拦截后本地 fulfill。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'video-speed.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')

/**
 * 测试用的「真媒体」：静音 WAV（8 kHz / 8 bit / 单声道），运行时生成、经 route 提供，不进仓库。
 * <video> 也能播纯音频文件（只是没有画面），够测 duration / currentTime / 播放状态。
 */
function silentWav(seconds) {
    const rate = 8000
    const n = rate * seconds
    const buf = Buffer.alloc(44 + n, 0x80)   // 8 bit PCM 的静音是 0x80
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8)
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34)
    buf.write('data', 36); buf.writeUInt32LE(n, 40)
    return buf
}
const WAV = silentWav(60)

/**
 * 必须按 Range 回 206。整包回 200 的话 Chrome 认为服务器不支持分段，
 * seekable 是 [0, 0]，设置 currentTime 会被静默钳回 0（buffered 明明有 60 秒）。
 */
async function serveWav(route) {
    // ?slow=1：元数据晚到，模拟真实网络（换集后 loadedmetadata 要等一会儿才来）
    if (route.request().url().includes('slow=1')) await new Promise(r => setTimeout(r, 600))
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '')
    if (!m) return route.fulfill({ contentType: 'audio/wav', body: WAV, headers: { 'accept-ranges': 'bytes' } })
    const start = +m[1]
    const end = m[2] ? Math.min(+m[2], WAV.length - 1) : WAV.length - 1
    return route.fulfill({
        status: 206,
        contentType: 'audio/wav',
        headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${WAV.length}` },
        body: WAV.subarray(start, end + 1),
    })
}

;(async () => {
    const env = await h.setup(FIXTURES)
    const t = h.createRunner('video-speed')
    const { assert, eq } = t

    /** 每个用例一个独立 context（localStorage 互不串），用完关掉。 */
    async function withPage(file, fn, opts = {}) {
        const context = await env.browser.newContext()
        await context.route(/\/silence\.wav(\?|$)/, serveWav)   // glob 匹配不了带 query 的 URL
        const page = await context.newPage()
        const logs = []
        page.on('console', m => logs.push(m.text()))
        page.logs = logs
        try {
            await h.install(page, SCRIPT, opts)
            await page.goto(file.startsWith('http') ? file : `${env.base}/${file}`)
            await fn(page, context)
            const errs = h.errors(page)
            assert(errs.length === 0, '页面有未捕获异常：' + errs.map(String).join('; '))
        } finally {
            await context.close()
        }
    }

    console.log('元数据')

    await t.test('头部字段齐全', async () => {
        const meta = h.parseMeta(fs.readFileSync(SCRIPT, 'utf8'))
        eq(meta.namespace, ['https://github.com/yilecoding/helper-scripts'])
        eq(meta.author, ['壹樂（V：ita1125）'])
        eq(meta.license, ['CC BY-NC-SA'])
        assert(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(meta.version[0]), 'version 格式：' + meta.version)
        assert(meta['name:en'] && meta['description:en'], '缺英文 name/description')
        const raw = 'https://raw.githubusercontent.com/yilecoding/helper-scripts/main/video-speed/video-speed.user.js'
        eq(meta.updateURL, [raw])
        eq(meta.downloadURL, [raw])
        assert(!meta.require, '不应 @require 外部脚本')
    })

    console.log('启动')

    await t.test('加载无异常，发现页面里的视频', async () => {
        await withPage('basic.html', async page => {
            const line = page.logs.find(l => l.startsWith('[倍速控制] 已启动'))
            assert(line, '没有启动日志：' + page.logs.join(' | '))
            assert(line.includes('发现 1 个媒体元素'), line)
        })
    })

    const rateOf = (page, sel = '#v') => page.$eval(sel, v => v.playbackRate)
    async function press(page, key, times = 1) {
        for (let i = 0; i < times; i++) await page.keyboard.press(key)
    }

    console.log('快捷键调速')

    await t.test('X 加速、Z 减速、R 恢复 1.0', async () => {
        await withPage('basic.html', async page => {
            await press(page, 'x', 3)
            eq(await rateOf(page), 1.75)
            await press(page, 'z')
            eq(await rateOf(page), 1.5)
            await press(page, 'r')
            eq(await rateOf(page), 1)
        })
    })

    await t.test('钳位在 0.1–16，从下限加速对齐到步长网格', async () => {
        await withPage('basic.html', async page => {
            await press(page, 'x', 70)
            eq(await rateOf(page), 16)
            await press(page, 'z', 70)
            eq(await rateOf(page), 0.1)
            await press(page, 'x')
            eq(await rateOf(page), 0.25)
        })
    })

    await t.test('处理掉的键不再漏给页面（keydown 和 keyup 都吞）', async () => {
        await withPage('basic.html', async page => {
            await press(page, 'x')
            await press(page, 'k')
            eq(await page.evaluate(() => siteKeys), ['down:KeyK', 'up:KeyK'])
        })
    })

    await t.test('带修饰键不响应', async () => {
        await withPage('basic.html', async page => {
            await press(page, 'Shift+X')
            await press(page, 'Alt+X')
            eq(await rateOf(page), 1)
        })
    })

    await t.test('输入框 / textarea / contenteditable / shadow DOM 里的输入框不响应', async () => {
        await withPage('basic.html', async page => {
            for (const sel of ['#text', '#area', '#editable', '#sbox >> #inner']) {
                await page.focus(sel)
                await press(page, 'x', 2)
                eq(await rateOf(page), 1, sel + ' 里按键改了倍速')
            }
            eq(await page.$eval('#text', el => el.value), 'xx')
            eq(await page.$eval('#sbox', el => el.shadowRoot.querySelector('input').value), 'xx')
            // 非文本类 input（复选框）不算在打字
            await page.focus('#check')
            await press(page, 'x')
            eq(await rateOf(page), 1.25)
        })
    })

    await t.test('G 切到常用倍速 2.0，再按切回之前的速度', async () => {
        await withPage('basic.html', async page => {
            await press(page, 'x')
            eq(await rateOf(page), 1.25)
            await press(page, 'g')
            eq(await rateOf(page), 2)
            await press(page, 'g')
            eq(await rateOf(page), 1.25)
        })
    })

    await t.test('本来就在 2.0 上按 G：切回 1.0，不会原地不动', async () => {
        await withPage('basic.html', async page => {
            await page.$eval('#v', v => { v.playbackRate = 2 })
            await press(page, 'g')
            eq(await rateOf(page), 1)
        })
    })

    await t.test('按住 G 不放（连发）不会来回闪', async () => {
        await withPage('basic.html', async page => {
            await page.keyboard.down('g')
            // Playwright 对已按下的键再 down 会带 repeat。连发次数取奇数：没拦的话 1+3 次切换正好落回 1.0
            for (let i = 0; i < 3; i++) await page.keyboard.down('g')
            await page.keyboard.up('g')
            eq(await rateOf(page), 2)
        })
    })

    await t.test('Q / E 快退快进 5 秒，钳在 [0, duration]', async () => {
        await withPage('media.html', async page => {
            await page.waitForFunction(() => document.querySelector('#v').readyState >= 1)
            eq(await page.$eval('#v', v => v.duration), 60)
            const now = () => page.$eval('#v', v => Math.round(v.currentTime * 10) / 10)
            await press(page, 'e', 2)
            eq(await now(), 10)
            await press(page, 'q')
            eq(await now(), 5)
            await press(page, 'q', 3)
            eq(await now(), 0)
            await page.$eval('#v', v => { v.currentTime = 58 })
            await press(page, 'e')
            eq(await now(), 60)
        })
    })

    await t.test('页面没有媒体时不拦截按键', async () => {
        await withPage('no-media.html', async page => {
            await press(page, 'x')
            eq(await page.evaluate(() => siteKeys), ['down:KeyX'])
        })
    })

    console.log('当前视频的判定')

    const rates = page => page.$$eval('video', vs => Object.fromEntries(vs.map(v => [v.id, v.playbackRate])))
    const ready = page => page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => v.readyState >= 1))

    await t.test('都没在播：取视口里露出面积最大的（屏外的、display:none 的不算）', async () => {
        await withPage('pick.html', async page => {
            await ready(page)
            await press(page, 'x')
            eq(await rates(page), { big: 1.25, small: 1, hidden: 1, far: 1 })
        })
    })

    await t.test('正在播放的优先于面积大的', async () => {
        await withPage('pick.html', async page => {
            await ready(page)
            await page.$eval('#small', v => v.play())
            await press(page, 'x')
            eq(await rates(page), { big: 1, small: 1.25, hidden: 1, far: 1 })
        })
    })

    await t.test('点过的优先于面积大的；点在盖住视频的控制层上也算', async () => {
        await withPage('pick.html', async page => {
            await ready(page)
            await page.click('#small')
            await press(page, 'x')
            eq(await rates(page), { big: 1, small: 1.25, hidden: 1, far: 1 })
            await page.click('#overlay')
            await press(page, 'x')
            eq(await rates(page), { big: 1.25, small: 1.25, hidden: 1, far: 1 })
        })
    })

    console.log('shadow DOM 与动态插入')

    const shadowRate = (page, sel) => page.$eval(sel, host => shadowVideo(host).playbackRate)

    await t.test('open shadow DOM 里的视频', async () => {
        await withPage('shadow.html', async page => {
            await press(page, 'x')
            eq(await shadowRate(page, '#p1'), 1.25)
        })
    })

    await t.test('加载后插入的两层嵌套 shadow 播放器', async () => {
        await withPage('shadow.html', async page => {
            await page.evaluate(() => {
                document.querySelector('#p1').remove()
                const shell = document.createElement('x-shell')
                shell.id = 'shell'
                document.body.append(shell)
            })
            await press(page, 'x')
            eq(await shadowRate(page, '#shell'), 1.25)
        })
    })

    await t.test('已有 shadow root 里后来才插进去的视频', async () => {
        await withPage('shadow.html', async page => {
            await page.evaluate(() => {
                const root = document.querySelector('#p1').shadowRoot
                root.querySelector('video').remove()
                const v = document.createElement('video')
                v.width = 320; v.height = 180
                root.querySelector('.frame').append(v)
            })
            await press(page, 'x')
            eq(await shadowRate(page, '#p1'), 1.25)
        })
    })

    console.log('站点重置 vs 用户主动修改')

    const settle = page => page.waitForTimeout(250)   // ratechange 是异步派发的，用户改动的判定还要再等 100ms

    await t.test('没调过速时完全不干预站点自己设的倍速', async () => {
        await withPage('keep.html', async page => {
            await page.$eval('#v', v => { v.playbackRate = 1.5 })
            await settle(page)
            eq(await rateOf(page), 1.5)
        })
    })

    await t.test('站点把速度写回 1：被重新应用', async () => {
        await withPage('keep.html', async page => {
            await press(page, 'g')
            await page.$eval('#v', v => { v.playbackRate = 1 })   // evaluate 不产生用户手势
            await settle(page)
            eq(await rateOf(page), 2)
        })
    })

    await t.test('换 src（加载算法会重置成 defaultPlaybackRate）：速度保持', async () => {
        await withPage('keep.html', async page => {
            await press(page, 'g')
            await page.$eval('#v', v => { v.src = 'silence.wav?ep=9' })
            await page.waitForFunction(() => document.querySelector('#v').readyState >= 1)
            eq(await rateOf(page), 2)
        })
    })

    await t.test('点「下一集」（有手势 + 换 src + 设回 1）：仍按站点重置处理', async () => {
        await withPage('keep.html', async page => {
            await press(page, 'g')
            await page.click('#next')
            await page.waitForFunction(() => document.querySelector('#v').readyState >= 1)
            await settle(page)
            eq(await rateOf(page), 2)
        })
    })

    await t.test('用户在播放器菜单里主动改：尊重，之后的站点重置恢复到用户选的值', async () => {
        await withPage('keep.html', async page => {
            await press(page, 'g')
            await page.click('#menu-15')
            await settle(page)
            eq(await rateOf(page), 1.5)
            await page.waitForTimeout(1100)   // 走出手势窗口
            await page.$eval('#v', v => { v.playbackRate = 1 })
            await settle(page)
            eq(await rateOf(page), 1.5)
            // 用户在菜单里选「正常」也是主动选择
            await page.click('#menu-10')
            await settle(page)
            eq(await rateOf(page), 1)
        })
    })

    await t.test('动态插入的视频（含 shadow root 里的）自动套用当前倍速，不用再按键', async () => {
        await withPage('keep.html', async page => {
            await press(page, 'x', 2)
            const got = await page.evaluate(async () => {
                const a = document.createElement('video')
                a.src = 'silence.wav?new=1'
                document.body.append(a)
                const b = document.createElement('video')
                document.querySelector('#sp').shadowRoot.querySelector('.frame').append(b)
                await new Promise(r => setTimeout(r, 50))
                return [a.playbackRate, b.playbackRate]
            })
            eq(got, [1.5, 1.5])
        })
    })

    console.log('OSD')

    const osd = page => page.evaluate(() => {
        const el = document.querySelector('[data-video-speed-osd]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { text: el.textContent, opacity: getComputedStyle(el).opacity, x: Math.round(r.left), y: Math.round(r.top) }
    })

    await t.test('改速时在视频左上角出现，约 1 秒后淡出', async () => {
        await withPage('pick.html', async page => {
            await ready(page)
            await press(page, 'x')
            await page.waitForTimeout(350)   // 淡入的 transition 是 .3s
            const big = await page.$eval('#big', v => v.getBoundingClientRect().toJSON())
            const o = await osd(page)
            eq([o.text, o.opacity], ['1.25×', '1'])
            assert(o.x >= big.left && o.x < big.left + 40 && o.y >= big.top && o.y < big.top + 40, `位置不在视频左上角：${JSON.stringify(o)}`)
            await page.waitForTimeout(1100)
            eq((await osd(page)).opacity, '0')
        })
    })

    await t.test('快进快退也有提示；1.0 显示为 1.0×', async () => {
        await withPage('media.html', async page => {
            await press(page, 'e')
            eq((await osd(page)).text, '5 秒 »')
            await press(page, 'r')
            eq((await osd(page)).text, '1.0×')
        })
    })

    /**
     * OSD 是否真的在最上面看得见：截 OSD 那块区域，数白色（文字）像素。
     * 全屏元素在 top layer 里，普通 z-index 再大也压不过它，被盖住时那块是纯黑的视频。
     *
     * 不用 elementFromPoint 做命中测试：实测提示已经画在全屏视频上面了（截图可见），
     * 它仍然返回 <video>——对 top layer 里的 popover 不可靠。
     */
    async function osdVisiblePixels(page) {
        await page.waitForTimeout(400)   // 等淡入 transition 走完
        const clip = await page.$eval('[data-video-speed-osd]', el => {
            const r = el.getBoundingClientRect()
            return { x: r.left, y: r.top, width: r.width, height: r.height }
        })
        const png = (await page.screenshot({ clip })).toString('base64')
        return page.evaluate(async b64 => {
            const img = new Image()
            img.src = 'data:image/png;base64,' + b64
            await img.decode()
            const c = document.createElement('canvas')
            c.width = img.width; c.height = img.height
            const ctx = c.getContext('2d')
            ctx.drawImage(img, 0, 0)
            const d = ctx.getImageData(0, 0, c.width, c.height).data
            let white = 0
            for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++
            return white
        }, png)
    }

    for (const [btn, what] of [['#fs-player', '播放器容器'], ['#fs-video', '<video> 本身']]) {
        await t.test(`全屏时（全屏的是${what}）OSD 仍在最上层可见`, async () => {
            await withPage('fullscreen.html', async page => {
                await page.click(btn)
                await page.waitForFunction(() => !!document.fullscreenElement)
                await press(page, 'x')
                eq(await rateOf(page), 1.25)
                const white = await osdVisiblePixels(page)
                assert(white > 20, `OSD 被全屏元素盖住了（白色像素 ${white}）`)
            })
        })
    }

    console.log('按站点记忆')

    const SITE = 'https://video.example.com/watch'
    /** 「真实域名」：拦下来用本地 fixture 回，不访问外网。silence.wav 的 route 不限域名，照样生效。 */
    async function fakeSite(context, url, fixture) {
        const body = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8')
        await context.route(url, r => r.fulfill({ contentType: 'text/html; charset=utf-8', body }))
    }
    const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('__gm:rates')))
    const reloadAndWait = async page => {
        await page.reload()
        await page.waitForFunction(() => document.querySelector('#v').readyState >= 1)
    }

    /** withPage 的导航在 fn 之前，route 来不及挂；记忆相关的用例自己开页面。 */
    async function withSite(fn, opts = {}) {
        const context = await env.browser.newContext()
        await context.route(/\/silence\.wav(\?|$)/, serveWav)
        await fakeSite(context, SITE, 'keep.html')
        const page = await context.newPage()
        try {
            await h.install(page, SCRIPT, opts)
            await page.goto(SITE)
            await page.waitForFunction(() => document.querySelector('#v').readyState >= 1)
            await fn(page)
            eq(h.errors(page).map(String), [])
        } finally {
            await context.close()
        }
    }

    await t.test('调过的速度按 hostname 存下，刷新后不按键自动恢复', async () => {
        await withSite(async page => {
            await press(page, 'g')
            eq(await stored(page), { 'video.example.com': 2 })
            await reloadAndWait(page)
            eq(await rateOf(page), 2)
            // 恢复之后站点重置照样拉回来
            await page.$eval('#v', v => { v.playbackRate = 1 })
            await settle(page)
            eq(await rateOf(page), 2)
        })
    })

    await t.test('只认本站的记忆；调回 1.0 时删掉本站的条目', async () => {
        await withSite(async page => {
            eq(await rateOf(page), 1)
            await press(page, 'x')
            await press(page, 'r')
            eq(await stored(page), { 'other.example.org': 3 })
        }, { values: { rates: { 'other.example.org': 3 } } })
    })

    await t.test('在播放器菜单里主动改的也记住', async () => {
        await withSite(async page => {
            await press(page, 'g')
            await page.click('#menu-15')
            await settle(page)
            eq(await stored(page), { 'video.example.com': 1.5 })
        })
    })

    await t.test('菜单：清除本站记忆', async () => {
        await withSite(async page => {
            await press(page, 'g')
            await h.menu(page, '清除本站记忆的倍速（video.example.com）')
            eq(await stored(page), {})
            await reloadAndWait(page)
            eq(await rateOf(page), 1)
        })
    })

    await t.test('菜单：关闭记忆后不存也不恢复，菜单文字跟着变', async () => {
        await withSite(async page => {
            eq((await h.gm(page)).menu, ['清除本站记忆的倍速（video.example.com）', '记忆倍速：已开启（点击关闭）'])
            await h.menu(page, '记忆倍速：已开启')
            eq((await h.gm(page)).menu, ['清除本站记忆的倍速（video.example.com）', '记忆倍速：已关闭（点击开启）'])
            await press(page, 'g')
            eq(await stored(page), { 'video.example.com': 1.25 })
            await reloadAndWait(page)
            eq(await rateOf(page), 1)
        }, { values: { rates: { 'video.example.com': 1.25 } } })
    })

    console.log('边界情况')

    await t.test('站点死锁 1.0：拉锯几次后让步，不无限循环；再按键会重新尝试', async () => {
        await withPage('locked.html', async page => {
            await press(page, 'g')
            await page.waitForTimeout(500)
            const n1 = await page.evaluate(() => rateEvents)
            assert(n1 < 30, `ratechange 次数失控：${n1}`)
            eq(await rateOf(page), 1)
            assert(page.logs.some(l => l.includes('停止自动恢复')), '没有让步日志')
            await page.waitForTimeout(500)
            eq(await page.evaluate(() => rateEvents), n1, '让步后还在拉锯')
            // 用户再按一次：明确的意图，重新尝试（然后再次让步）
            await press(page, 'x')
            await page.waitForTimeout(500)
            const n2 = await page.evaluate(() => rateEvents)
            assert(n2 > n1 && n2 < n1 + 30, `再按键后 ratechange：${n1} → ${n2}`)
        })
    })

    console.log('iframe')

    await t.test('各 frame 各管各的：快捷键只作用于有焦点的那个 frame；记忆按 frame 自己的 hostname', async () => {
        const context = await env.browser.newContext()
        const top = 'https://video.example.com/iframe'
        await fakeSite(context, top, 'iframe.html')
        await fakeSite(context, 'https://video.example.com/iframe-inner.html', 'iframe-inner.html')
        await fakeSite(context, 'https://player.example.net/embed', 'iframe-inner.html')
        const page = await context.newPage()
        try {
            await h.install(page, SCRIPT)
            await page.goto(top)
            const same = page.frame({ url: /iframe-inner/ })
            const cross = page.frame({ url: /player\.example\.net/ })
            const all = async () => [await rateOf(page), await same.$eval('#v', v => v.playbackRate), await cross.$eval('#v', v => v.playbackRate)]

            await page.frameLocator('#cross').locator('#v').click()
            await press(page, 'g')
            eq(await all(), [1, 1, 2])

            await page.frameLocator('#same').locator('#v').click()
            await press(page, 'x')
            eq(await all(), [1, 1.25, 2])

            await page.click('#v')
            await press(page, 'z')
            eq(await all(), [0.75, 1.25, 2])

            // 跨域 iframe 的记忆记在它自己的域名下（harness 的 GM 存储按源隔离，这里在各自的源里读）
            eq(await cross.evaluate(() => JSON.parse(localStorage.getItem('__gm:rates'))), { 'player.example.net': 2 })
            eq(await page.evaluate(() => JSON.parse(localStorage.getItem('__gm:rates'))), { 'video.example.com': 0.75 })
            // 菜单只在顶层注册
            eq((await h.gm(page)).menu.length, 2)
            eq(await cross.evaluate(() => window.__gm.menu.length), 0)
            eq(h.errors(page).map(String), [])
        } finally {
            await context.close()
        }
    })

    await env.close()
    t.done()
})().catch(e => {
    console.error(e)
    process.exitCode = 1
})
