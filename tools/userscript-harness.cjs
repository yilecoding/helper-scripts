/*
 * 用户脚本测试工具：在 Playwright 打开的本地页面里加载 *.user.js，GM_* 用页面内实现模拟。
 *
 * 用法（各脚本的 test/run.cjs）：
 *   const h = require('../../tools/userscript-harness.cjs')
 *   const { browser, base, close } = await h.setup(__dirname + '/fixtures')
 *   const page = await browser.newPage()
 *   await h.install(page, __dirname + '/../xxx.user.js', { values: {...}, xhr: details => ({ status, responseText }) })
 *   await page.goto(base + '/index.html')
 *   ...
 *   const gm = await h.gm(page)        // { clipboard, downloads, menu, notifications, opened }
 *   await h.menu(page, '菜单名')         // 触发 GM_registerMenuCommand 注册的命令
 *   await close()
 *
 * 运行：本仓库不带 node_modules，借一个装了 playwright 的目录：
 *   NODE_PATH=/path/to/node_modules node <script>/test/run.cjs
 *
 * 和真实 Tampermonkey 的差异（写测试时心里有数）：
 *   - GM_getValue/GM_setValue 存在页面的 localStorage（前缀 __gm:），只在同源内共享，
 *     真实环境是按脚本全局共享。同源刷新后能读回，够测「刷新恢复」这类场景。
 *   - 没有沙箱：脚本直接跑在页面上下文，unsafeWindow === window。
 *   - GM_xmlhttpRequest 的 timeout 不计时，要测超时就让 opts.xhr 返回 { timeout: true }。
 *   - @run-at 只区分 document-start（立即执行）/ document-end（DOMContentLoaded）/
 *     document-idle（load，默认）。
 */
'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const vm = require('vm')
const { chromium } = require('playwright')

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
}

/** 起一个静态文件服务（fixtures 目录）+ 浏览器。 */
async function setup(fixturesDir, { headless = true } = {}) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x')
        let file = path.join(fixturesDir, decodeURIComponent(url.pathname))
        if (!file.startsWith(fixturesDir)) return res.writeHead(403).end()
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
        if (!fs.existsSync(file)) return res.writeHead(404).end('not found')
        const type = MIME[path.extname(file)] || 'application/octet-stream'
        const size = fs.statSync(file).size
        // 音视频 seek 要 Range → 206，否则 currentTime 设不过去
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
        if (range) {
            const start = range[1] ? +range[1] : size - +range[2]
            const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1
            res.writeHead(206, {
                'content-type': type,
                'accept-ranges': 'bytes',
                'content-range': `bytes ${start}-${end}/${size}`,
                'content-length': end - start + 1,
            })
            return fs.createReadStream(file, { start, end }).pipe(res)
        }
        res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size })
        fs.createReadStream(file).pipe(res)
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    const browser = await chromium.launch({ headless })
    return {
        browser,
        base,
        async close() {
            await browser.close()
            server.close()
        },
    }
}

function parseMeta(src) {
    const block = src.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/)
    const meta = {}
    if (!block) return meta
    for (const line of block[1].split('\n')) {
        const m = line.match(/^\/\/\s*@([\w:-]+)\s+(.*)$/)
        if (m) (meta[m[1]] ||= []).push(m[2].trim())
    }
    return meta
}

/**
 * 把 GM 模拟层 + 用户脚本注册到 page 上（之后每次导航都会自动注入）。
 * opts.values  GM_getValue 的初始值
 * opts.xhr     (details) => { status, responseText, responseHeaders? }，模拟 GM_xmlhttpRequest；
 *              返回 { timeout: true } 走 ontimeout，抛错走 onerror
 * opts.failDownloads  正则，匹配到的 url 让 GM_download 走 onerror
 */
async function install(page, scriptPath, opts = {}) {
    const src = fs.readFileSync(scriptPath, 'utf8')
    // 先在 node 里编译一遍：语法错误在页面里只是一条 pageerror，用例会全挂在「功能没生效」上，看不出原因
    new vm.Script(`(function () {\n${src}\n})`, { filename: scriptPath })
    const meta = parseMeta(src)
    const runAt = (meta['run-at'] || ['document-idle'])[0]
    const errors = []
    page.on('pageerror', e => errors.push(e))
    page.__usErrors = errors

    if (opts.xhr) {
        await page.exposeFunction('__gmXhrBridge', async details => {
            const r = await opts.xhr(details)
            return { status: 200, responseHeaders: '', ...r }
        })
    }

    await page.addInitScript(
        ({ src, runAt, values, name, failDownloads }) => {
            const PREFIX = '__gm:'
            const rec = (window.__gm = { clipboard: null, downloads: [], menu: [], notifications: [], opened: [] })
            // 初始值只在该源第一次加载时写入，之后删掉的键刷新也不会被补回来
            try {
                if (localStorage.getItem(PREFIX + '__seeded') === null) {
                    for (const [k, v] of Object.entries(values || {})) localStorage.setItem(PREFIX + k, JSON.stringify(v))
                    localStorage.setItem(PREFIX + '__seeded', '1')
                }
            } catch (e) { /* about:blank 等无存储的页面 */ }

            const api = {
                unsafeWindow: window,
                GM_info: { script: { name, version: 'test' }, scriptHandler: 'harness' },
                GM_getValue(k, d) {
                    const raw = localStorage.getItem(PREFIX + k)
                    return raw === null ? d : JSON.parse(raw)
                },
                GM_setValue(k, v) { localStorage.setItem(PREFIX + k, JSON.stringify(v)) },
                GM_deleteValue(k) { localStorage.removeItem(PREFIX + k) },
                GM_listValues() {
                    return Object.keys(localStorage)
                        .filter(k => k.startsWith(PREFIX) && k !== PREFIX + '__seeded')
                        .map(k => k.slice(PREFIX.length))
                },
                GM_addStyle(css) {
                    const s = document.createElement('style')
                    s.textContent = css
                    const mount = () => (document.head || document.documentElement).appendChild(s)
                    // document-start 时 <html> 可能还没解析出来，等它出现再挂（Tampermonkey 也是这样兜的）
                    if (document.documentElement) mount()
                    else new MutationObserver((_, ob) => {
                        if (document.documentElement) { ob.disconnect(); mount() }
                    }).observe(document, { childList: true })
                    return s
                },
                GM_setClipboard(text, type) { rec.clipboard = { text, type } },
                GM_download(arg, nameArg) {
                    const d = typeof arg === 'string' ? { url: arg, name: nameArg } : arg
                    rec.downloads.push({ url: d.url, name: d.name })
                    const fail = failDownloads && new RegExp(failDownloads).test(d.url)
                    setTimeout(() => {
                        if (fail) d.onerror && d.onerror({ error: 'not_succeeded', details: 'harness: failDownloads' })
                        else d.onload && d.onload()
                    }, 0)
                },
                GM_registerMenuCommand(caption, fn) { rec.menu.push({ caption, fn }); return rec.menu.length },
                GM_unregisterMenuCommand(id) { rec.menu[id - 1] = null },
                GM_notification(d, title) { rec.notifications.push(typeof d === 'string' ? { text: d, title } : d) },
                GM_openInTab(url, o) { rec.opened.push({ url, options: o }); return { close() {} } },
                GM_xmlhttpRequest(d) {
                    if (!window.__gmXhrBridge) throw new Error('harness: 没有传 opts.xhr，GM_xmlhttpRequest 不可用')
                    const plain = { method: d.method || 'GET', url: d.url, headers: d.headers, data: d.data }
                    window.__gmXhrBridge(plain).then(
                        r => {
                            if (r.timeout) return d.ontimeout && d.ontimeout({})
                            let response = r.responseText
                            if (d.responseType === 'json') try { response = JSON.parse(r.responseText) } catch (e) { response = null }
                            const resp = { ...r, response, finalUrl: d.url, readyState: 4 }
                            d.onload && d.onload(resp)
                            d.onloadend && d.onloadend(resp)
                        },
                        e => d.onerror && d.onerror({ error: String(e) }),
                    )
                    return { abort() {} }
                },
            }
            api.GM = {
                getValue: async (k, d) => api.GM_getValue(k, d),
                setValue: async (k, v) => api.GM_setValue(k, v),
                deleteValue: async k => api.GM_deleteValue(k),
                setClipboard: async (t, ty) => api.GM_setClipboard(t, ty),
                xmlHttpRequest: d => api.GM_xmlhttpRequest(d),
                info: api.GM_info,
            }

            const names = Object.keys(api)
            const run = () => new Function(...names, src)(...names.map(n => api[n]))
            if (runAt === 'document-start') run()
            else if (runAt === 'document-end') document.addEventListener('DOMContentLoaded', run, { once: true })
            else window.addEventListener('load', run, { once: true })
        },
        {
            src,
            runAt,
            values: opts.values || {},
            name: (meta.name || ['userscript'])[0],
            failDownloads: opts.failDownloads ? opts.failDownloads.source : null,
        },
    )
}

/** 取 GM 调用记录（剪贴板 / 下载 / 菜单名 / 通知 / 打开的标签）。 */
function gm(page) {
    return page.evaluate(() => ({ ...window.__gm, menu: window.__gm.menu.filter(Boolean).map(m => m.caption) }))
}

/** 触发菜单命令，按名字包含匹配。 */
async function menu(page, caption) {
    const ok = await page.evaluate(c => {
        const m = window.__gm.menu.find(x => x && x.caption.includes(c))
        if (m) m.fn()
        return !!m
    }, caption)
    if (!ok) throw new Error(`harness: 没有找到菜单命令「${caption}」`)
}

/** 页面里抛出的未捕获异常，测试结尾断言为空。 */
function errors(page) {
    return page.__usErrors || []
}

/** 极简断言 + 用例计数，避免引入测试框架。 */
function createRunner(title) {
    let passed = 0
    const failed = []
    return {
        async test(name, fn) {
            try {
                await fn()
                passed++
                console.log(`  ✓ ${name}`)
            } catch (e) {
                failed.push(name)
                console.log(`  ✗ ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`)
            }
        },
        assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') },
        eq(a, b, msg) {
            const sa = JSON.stringify(a), sb = JSON.stringify(b)
            if (sa !== sb) throw new Error(`${msg || 'not equal'}\n      actual:   ${sa}\n      expected: ${sb}`)
        },
        done() {
            console.log(`\n${title}: ${passed} passed, ${failed.length} failed`)
            if (failed.length) process.exitCode = 1
        },
    }
}

module.exports = { setup, install, gm, menu, errors, createRunner, parseMeta }
