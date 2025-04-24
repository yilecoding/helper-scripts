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
        t.assert(gm.menu.includes('复制正文为 Markdown'), JSON.stringify(gm.menu))
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

    await close()
    t.done()
})()
