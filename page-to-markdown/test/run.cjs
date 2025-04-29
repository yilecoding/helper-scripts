/*
 * page-to-markdown 测试。从仓库根目录运行：
 *   NODE_PATH=/path/to/node_modules node page-to-markdown/test/run.cjs
 */
'use strict'

const path = require('path')
const h = require(path.join(__dirname, '../../tools/userscript-harness.cjs'))

const SCRIPT = path.join(__dirname, '../page-to-markdown.user.js')
const t = h.createRunner('page-to-markdown')

/** 打开页面 → 触发菜单 → 返回剪贴板里的 Markdown。 */
async function copyFrom(page, caption = '复制正文为 Markdown') {
    await h.menu(page, caption)
    const gm = await h.gm(page)
    t.assert(gm.clipboard, '剪贴板为空')
    return gm.clipboard.text
}

/** 断言 md 里包含片段（多行片段原样比对）。 */
function has(md, frag) {
    t.assert(md.includes(frag), `缺少片段：\n${frag}\n---- 实际输出 ----\n${md}`)
}

function hasNot(md, frag) {
    t.assert(!md.includes(frag), `不应出现：\n${frag}\n---- 实际输出 ----\n${md}`)
}

;(async () => {
    const { browser, base, close } = await h.setup(path.join(__dirname, 'fixtures'))
    const open = async (file, opts) => {
        const page = await browser.newPage()
        await h.install(page, SCRIPT, opts)
        await page.goto(base + '/' + file)
        return page
    }

    await t.test('注册菜单', async () => {
        const page = await open('basic.html')
        const gm = await h.gm(page)
        t.eq(gm.menu, ['复制正文为 Markdown', '下载正文为 Markdown', '手动选择区域'])
        await page.close()
    })

    await t.test('标题 / 段落 / 强调 / 链接 / br / hr', async () => {
        const page = await open('basic.html')
        const md = await copyFrom(page)
        has(md, '# 一级标题\n\n')
        has(md, '这是第一段，带 **加粗**、*强调* 和 [一个链接](' + base + '/docs/intro.html)。')
        has(md, '## 二级 **标题**\n')
        has(md, '第一行\\\n第二行')
        has(md, '上一段\n\n用两个 br 分出来的下一段')
        has(md, '\n\n---\n\n结尾。')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('正文提取：选中文章，排除导航 / 侧栏 / 评论 / 页脚 / 广告 / 隐藏元素', async () => {
        const page = await open('article.html')
        const md = await copyFrom(page)
        has(md, '很多人学 Rust 的第一个项目都是命令行工具')
        has(md, '## 监听端口')
        has(md, '主线程就可以继续 accept 下一个连接了')
        for (const noise of ['首页', '归档', '评论（3）', '写得很好', '热门文章', '本站所有文章均为原创', '保留所有权利',
            '优惠券', 'trackRead', '这段是隐藏的', 'visibility hidden', '微博']) {
            hasNot(md, noise)
        }
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('列表：无序 / 有序（start）/ 嵌套缩进 / 任务列表 / 不合规嵌套', async () => {
        const page = await open('lists.html')
        const md = await copyFrom(page)
        has(md, [
            '- 苹果',
            '- 香蕉',
            '  - 小米蕉',
            '  - 皇帝蕉',
            '    1. 产地一',
            '    2. 产地二',
            '- **橙子**',
        ].join('\n'))
        // 两位数序号的续行缩进 4 格
        has(md, '9. 第九步\n10. 第十步\n    - 十的子项\n11. 第十一步')
        has(md, '- [x] 写测试\n- [ ] 写文档')
        has(md, '- 外层\n  - 直接挂在 ul 下的子列表')
        has(md, '- 宽松列表第一段。\n\n  宽松列表第二段。\n- 第二项。')
        await page.close()
    })

    await t.test('引用：多段 / 嵌套 / 引用里的列表', async () => {
        const page = await open('lists.html')
        const md = await copyFrom(page)
        has(md, '> 引用第一段。\n>\n> > 嵌套引用。\n>\n> - 引用里的列表')
        await page.close()
    })

    await t.test('行内代码：反引号围栏', async () => {
        const page = await open('code.html')
        const md = await copyFrom(page)
        has(md, '行内代码 `npm install`，带反引号的 ``a `b` c``，按键 `Ctrl`。')
        await page.close()
    })

    await t.test('代码块：推断语言 + 去掉行号', async () => {
        const page = await open('code.html')
        const md = await copyFrom(page)
        has(md, '```js\nconst a = 1;\nconst b = 2;\n```')                // Prism line-numbers
        has(md, '```python\ndef f(x):\n    return x * 2\n```')         // hljs + hljs-ln 表格
        has(md, '```\nSELECT 1;\nSELECT 2;\n```')                       // CSDN pre-numbering
        has(md, '```go\npackage main\nfunc main() {}\n```')              // Hexo figure.highlight + gutter
        has(md, '```rust\nfn main() {\n    println!("hi");\n}\n```')    // GitHub highlight-source-*
        has(md, '```bash\necho 1\n```')                                  // pandoc sourceCode
        has(md, '```toml\n[package]\nname = "demo"\n```')               // data-lang + 每行一个 div
        has(md, '````markdown\n```js\nx\n```\n````')                   // 内容里有 ``` 时加长围栏
        has(md, '```\nplain   text\n```')                                // plaintext 不写语言，空格原样保留
        hasNot(md, '\n1\n2\n')
        await page.close()
    })

    await t.test('表格：GFM、对齐、| 与换行转义、colspan、单元格里的块', async () => {
        const page = await open('tables.html')
        const md = await copyFrom(page)
        has(md, [
            '| 命令 | 说明 | 耗时 |',
            '| --- | :---: | ---: |',
            '| `a \\| b` | 管道：把 a 的输出 \\| 交给 b | 1s |',
            '| 多行 | 第一行<br>第二行 | [链接](' + base + '/t) |',
            '| 跨两列 |  | 3s |',
            '| 段落一<br>段落二 |  | - |',
        ].join('\n'))
        has(md, '| 无表头 A | 无表头 B |\n| --- | --- |\n| 1 | 2 |')
        has(md, '\n排版用的单列表格，内容应该直接展开成段落。')
        hasNot(md, '| 排版用的')
        await page.close()
    })

    await t.test('链接与图片：转绝对 URL、懒加载 data-src / srcset、标题、自动链接', async () => {
        // 模拟真实域名，看相对地址是不是按页面地址解析
        const page = await browser.newPage()
        await h.install(page, SCRIPT)
        const html = require('fs').readFileSync(path.join(__dirname, 'fixtures/links.html'), 'utf8')
        await page.route(/^https?:\/\//, r => r.abort()) // 测试不出网；后注册的路由优先
        await page.route('https://blog.example.com/**', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }))
        await page.goto('https://blog.example.com/posts/2026/hello.html')
        const md = await copyFrom(page)
        has(md, '相对链接 [关于](https://blog.example.com/posts/about.html)')
        has(md, '根相对 [标签](https://blog.example.com/tags/rust)')
        has(md, '锚点 [第二节](https://blog.example.com/posts/2026/hello.html#sec-2)')
        has(md, '带标题 [示例](https://example.org/ "示例 \\"站\\"")')
        has(md, '自动链接 <https://example.org/path>')
        has(md, '维基 [Rust](https://en.wikipedia.org/wiki/Rust_%28programming_language%29)')
        has(md, '脚本 点我，删除线 ~~旧~~~~价~~，上标 x<sup>2</sup>。')
        has(md, '![封面 \\[大图\\]](https://blog.example.com/posts/2026/img/cover.png)')
        has(md, '![懒加载](https://blog.example.com/uploads/lazy.jpg)')
        has(md, '![srcset](https://cdn.example.com/w_800,h_600/l.jpg)')
        has(md, '![知乎](https://pic.example.com/zhihu.jpg)')
        has(md, '[![缩略图](https://blog.example.com/thumb.png "点开看大图")](https://blog.example.com/big.png)')
        has(md, '\n[卡片标题 卡片摘要](https://blog.example.com/p/42)\n')
        has(md, '空链接 不输出。')
        hasNot(md, 'data:image')
        await page.close()
    })

    await t.test('front-matter：og:title / JSON-LD 作者 / 发布时间 / 抓取时间，标题补成 h1', async () => {
        const page = await open('meta.html')
        const md = await copyFrom(page)
        const lines = md.split('\n')
        t.eq(lines.slice(0, 5), [
            '---',
            'title: "C++ / Rust: 谁更快？\\"实测\\" <2026>|*"',
            'url: "' + base + '/meta.html"',
            'author: "李四, 王五"',
            'date: "2026-10-01T08:00:00+08:00"',
        ])
        t.assert(/^captured: "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d"$/.test(lines[5]), lines[5])
        t.eq(lines[6], '---')
        // 正文没有 h1 → 补一个；代码块里的 `# 先装依赖` 不能被当成 h1
        has(md, '---\n\n# C++ / Rust: 谁更快？"实测" <2026>|\\*\n\n## 性能对比')
        has(md, '```bash\n# 先装依赖\ncargo build --release\n```')
        await page.close()
    })

    await t.test('下载：文件名去非法字符，内容与复制一致', async () => {
        const page = await open('meta.html')
        await h.menu(page, '下载正文为 Markdown')
        const gm = await h.gm(page)
        t.eq(gm.downloads.length, 1)
        t.eq(gm.downloads[0].name, 'C++ Rust 谁更快？ 实测 2026.md')
        const text = await page.evaluate(u => fetch(u).then(r => r.text()), gm.downloads[0].url)
        has(text, 'title: "C++ / Rust: 谁更快？')
        has(text, '这篇文章用同一组基准测试比较了两种语言')
        await page.close()
    })

    await t.test('转义：克制（. _ 不乱转），但行首块语法、字面链接、HTML 标签要转', async () => {
        const page = await open('escape.html')
        const md = await copyFrom(page)
        has(md, '变量 snake_case_name 和 \\_\\_init\\_\\_ 方法，版本 3.14.15，网址 example.com，表达式 2\\*3\\*4，a * b，范围 3\\~5 天。')
        has(md, '\n1\\. 这不是列表\n')
        has(md, '\n2026\\. 年份开头也不是\n')
        has(md, '\n\\# 这不是标题\n')
        has(md, '\n\\- 这也不是列表\n')
        has(md, '\n\\> 不是引用\n')
        has(md, '上一行\\\n\\---')
        has(md, '字面量 [文字\\](地址) 和 \\<div> 标签，\\&nbsp; 实体，还有 \\`反引号\\`。')
        has(md, '路径 C:\\Users\\name，正则 \\d+，转义 \\\\\\*。')
        has(md, '链接文字里的方括号 [\\[1\\] 参考](' + base + '/ref)。')
        has(md, '\n## \\# 井号开头的标题\n')
        await page.close()
    })

    await t.test('加粗贴着中文标点：** 不生效时退回 <strong>', async () => {
        // CommonMark 的定界符规则：闭合的 ** 前面是标点、后面紧跟文字时不算右定界，加粗失效
        const page = await open('escape.html')
        const md = await copyFrom(page)
        has(md, '<strong>注意：</strong>这里加粗贴着中文标点，<strong>“引号”</strong>也一样；**Note:** English is fine, *(aside)*.')
        has(md, '结尾反斜杠 **C:\\\\** 不能吃掉加粗。')
        await page.close()
    })

    await t.test('有选中文本时优先转换选区', async () => {
        const page = await open('article.html')
        await page.evaluate(() => {
            const p = [...document.querySelectorAll('.post-body p')][1]
            const r = document.createRange()
            r.setStart(p.firstChild, 0)
            r.setEnd(p.firstChild, 28)
            getSelection().removeAllRanges()
            getSelection().addRange(r)
        })
        const md = await copyFrom(page)
        has(md, '\n我们从标准库的 TcpListener 开始，不引入任何\n')
        hasNot(md, '很多人学 Rust')
        hasNot(md, '监听端口')
        await page.close()
    })

    await t.test('选区落在代码块里：补回 pre 外壳和语言', async () => {
        const page = await open('code.html')
        await page.evaluate(() => {
            const code = document.querySelector('pre.language-js code')
            const r = document.createRange()
            r.setStart(code.firstChild, 0)
            r.setEnd(code.firstChild, 20)
            getSelection().removeAllRanges()
            getSelection().addRange(r)
        })
        const md = await copyFrom(page)
        has(md, '```js\nconst a = 1;\nconst b\n```')
        await page.close()
    })

    /** 鼠标移到元素中心。 */
    async function hover(page, selector) {
        const box = await page.locator(selector).first().boundingBox()
        const x = box.x + box.width / 2, y = box.y + Math.min(box.height / 2, 10)
        await page.mouse.move(x, y)
        return { x, y }
    }

    await t.test('手动选区：悬停 + 点击转换该元素，链接不跳转', async () => {
        const page = await open('article.html')
        await h.menu(page, '手动选择区域')
        t.assert(await page.locator('[data-p2md-picker]').count() === 1, '没有出现高亮层')
        const pt = await hover(page, '.navbar a')
        await page.mouse.click(pt.x, pt.y)
        const gm = await h.gm(page)
        t.eq(page.url(), base + '/article.html', '点击被页面当成了导航')
        has(gm.clipboard.text, '[首页](' + base + '/)')
        hasNot(gm.clipboard.text, '很多人学 Rust')
        t.eq(await page.locator('[data-p2md-picker]').count(), 0, '转换后应退出选区模式')
        await page.close()
    })

    await t.test('手动选区：↑ / 滚轮 扩到父元素，↓ / 滚轮 缩回', async () => {
        const page = await open('article.html')
        await h.menu(page, '手动选择区域')
        const pt = await hover(page, '.comment p')
        await page.keyboard.press('ArrowUp')   // → div.comment
        await page.keyboard.press('ArrowUp')   // → section.comments
        await page.mouse.wheel(0, -100)        // → div.main-column
        await page.mouse.wheel(0, 100)         // ← section.comments
        const tip = await page.evaluate(() => document.querySelector('[data-p2md-picker]').shadowRoot.querySelector('.tip b').textContent)
        t.eq(tip, 'section#comments.comments')
        await page.mouse.click(pt.x, pt.y)
        const md = (await h.gm(page)).clipboard.text
        has(md, '### 评论（3）')
        has(md, '写得很好')
        has(md, '这个顺序我觉得是对的')
        hasNot(md, '很多人学 Rust')
        await page.close()
    })

    await t.test('手动选区：Esc 退出后点击恢复正常', async () => {
        const page = await open('article.html')
        await h.menu(page, '手动选择区域')
        await hover(page, '.post-body p')
        await page.keyboard.press('Escape')
        t.eq(await page.locator('[data-p2md-picker]').count(), 0)
        const pt = await hover(page, '.navbar a[href="/archive"]')
        await page.mouse.click(pt.x, pt.y)
        await page.waitForURL(base + '/archive')
        t.eq((await h.gm(page)).clipboard, null)
        await page.close()
    })

    await close()
    t.done()
})()
