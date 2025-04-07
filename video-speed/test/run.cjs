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

;(async () => {
    const env = await h.setup(FIXTURES)
    const t = h.createRunner('video-speed')
    const { assert, eq } = t

    /** 每个用例一个独立 context（localStorage 互不串），用完关掉。 */
    async function withPage(file, fn, opts = {}) {
        const context = await env.browser.newContext()
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

    await env.close()
    t.done()
})().catch(e => {
    console.error(e)
    process.exitCode = 1
})
