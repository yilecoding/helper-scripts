/*
 * pangu-spacing 的测试。运行（本仓库不带 node_modules，借一个装了 playwright 的目录）：
 *   NODE_PATH=/path/to/node_modules node pangu-spacing/test/run.cjs
 *
 * 两部分：
 *   1. 文本规则：脚本没有 document 时只导出纯函数，直接在 node 里用 vm 加载、批量比对输入 → 期望输出
 *   2. DOM：页面用 page.route 挂在假域名 https://example.com/ 下（正则匹配），不访问外网
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const h = require('../../tools/userscript-harness.cjs')

const SCRIPT = path.join(__dirname, '..', 'pangu-spacing.user.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const SITE = 'https://example.com'

const t = h.createRunner('pangu-spacing')

/** 在 node 里加载脚本，拿到导出的纯函数。 */
function loadPure() {
    const sandbox = { module: { exports: {} }, console }
    vm.runInNewContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: SCRIPT })
    return sandbox.module.exports
}

/** 输入 → 期望输出。期望与输入相同的是反例（不该动）。 */
const CASES = [
    // CJK 与字母数字
    ['今天用React写组件', '今天用 React 写组件'],
    ['共有3个', '共有 3 个'],
    ['2026年10月29日', '2026 年 10 月 29 日'],
    ['Hello世界', 'Hello 世界'],
    ['中文English中文', '中文 English 中文'],
    ['在café里', '在 café 里'],
    ['希腊字母α和β', '希腊字母 α 和 β'],
    ['来自Москва的', '来自 Москва 的'],
    // 已有空格
    ['已经有 English 空格', '已经有 English 空格'],
    ['中文 English', '中文 English'],
    // 日文、韩文
    ['日本語のテキストとEnglish', '日本語のテキストと English'],
    ['カタカナTest', 'カタカナ Test'],
    ['한국어English', '한국어 English'],
    ['Seoul서울', 'Seoul 서울'],
    // 扩展区（补充平面）
    ['𠀀字与A', '𠀀字与 A'],
    // 没有 CJK 的整段不动
    ['plain English text', 'plain English text'],

    // 后缀符号：跟前面的词走
    ['增长了100%以上', '增长了 100% 以上'],
    ['100%', '100%'],
    ['用C++写', '用 C++ 写'],
    ['C++和Python', 'C++ 和 Python'],
    ['用C#和F#都行', '用 C# 和 F# 都行'],
    ['今天25℃左右', '今天 25℃ 左右'],
    ['转了90°角', '转了 90° 角'],
    // 前缀符号：跟后面的词走
    ['看看#标签', '看看 #标签'],
    ['#标签', '#标签'],
    ['话题#tag', '话题 #tag'],
    ['看#话题#很好', '看 #话题# 很好'],
    ['#话题#正文', '#话题# 正文'],
    ['联系@张三', '联系 @张三'],
    ['花了$100块', '花了 $100 块'],
    ['变量$PATH里', '变量$PATH 里'],
    // 运算符号、连字符：不加
    ['苹果+香蕉', '苹果+香蕉'],
    ['北京-上海', '北京-上海'],
    ['是/否', '是/否'],
    ['a=b和c', 'a=b 和 c'],
    // 括号
    ['用(括号)', '用 (括号)'],
    ['苹果(apple)很甜', '苹果 (apple) 很甜'],
    ['(注)正文', '(注) 正文'],
    ['函数f(x)的值', '函数 f(x) 的值'],
    ['用（全角括号）', '用（全角括号）'],
    ['文字[1]', '文字[1]'],
    // 引号
    ['他说"hello"然后走了', '他说 "hello" 然后走了'],
    ['他说"你好"然后', '他说 "你好" 然后'],
    ['"开头"', '"开头"'],
    ['不配对的"引号', '不配对的"引号'],
    ['它的it\'s不动', '它的 it\'s 不动'],
    // 全角标点：两侧都不加
    ['你好，World！', '你好，World！'],
    ['“English”说', '“English”说'],
    ['「React」是', '「React」是'],
    ['《Python编程》', '《Python 编程》'],
    ['完成。Next', '完成。Next'],
    ['日本語・English', '日本語・English'],
    // 半角标点
    ['Hello,世界', 'Hello, 世界'],
    ['等等e.g.中文', '等等 e.g. 中文'],
    ['wait...然后', 'wait... 然后'],
    ['中文,English', '中文,English'],
    // 单位、emoji
    ['面积100㎡', '面积 100㎡'],
    ['你好😀world', '你好😀world'],
    ['开心😀', '开心😀'],
    ['🎉庆祝2026', '🎉庆祝 2026'],

    // URL、邮箱、路径、版本号、时间：内部不动，两侧照常
    ['访问https://example.com获取', '访问 https://example.com 获取'],
    ['见https://example.com/wiki/C++教程 吧', '见 https://example.com/wiki/C++教程 吧'],
    ['搜https://example.com/s?q=React教程&p=2 第二页', '搜 https://example.com/s?q=React教程&p=2 第二页'],
    ['锚点https://example.com/page#小节，完', '锚点 https://example.com/page#小节，完'],
    ['见(https://example.com)中', '见 (https://example.com) 中'],
    ['打开www.example.com网站', '打开 www.example.com 网站'],
    ['邮箱abc.def+x@example.com联系', '邮箱 abc.def+x@example.com 联系'],
    ['目录/usr/local/bin下', '目录/usr/local/bin 下'],
    ['编辑~/.bashrc文件', '编辑~/.bashrc 文件'],
    ['在C:\\Users\\Admin目录', '在 C:\\Users\\Admin 目录'],
    ['版本v1.2.3发布', '版本 v1.2.3 发布'],
    ['升级到1.2.3-beta.1了', '升级到 1.2.3-beta.1 了'],
    ['会议12:30开始', '会议 12:30 开始'],
    ['时间12:30:45到', '时间 12:30:45 到'],
    ['服务器192.168.1.1上', '服务器 192.168.1.1 上'],
]

async function main() {
    console.log('文本规则')
    const pure = loadPure()
    for (const [input, expected] of CASES) {
        await t.test(`${input} → ${expected}`, () => t.eq(pure.spacing(input), expected))
    }
    await t.test('幂等：处理两遍和一遍一样', () => {
        for (const [input] of CASES) t.eq(pure.spacing(pure.spacing(input)), pure.spacing(input), input)
    })

    console.log('\n跨节点交界（纯函数）')
    const JUNCTIONS = [
        ['中文', 'English', true],
        ['English', '中文', true],
        ['中文 ', 'English', false],
        ['中文', ' English', false],
        ['中文', '，English', false],
        ['增长100%', '以上', true],
        ['用C++', '写', true],
        ['看', '#话题#很好', true],
        ['https://example.com/a', '中文', true],
        ['https://example.com/wiki/', '中文', false],
        ['用', '(括号)', true],
        ['中文', '中文', false],
        ['English', 'English', false],
    ]
    for (const [l, r, want] of JUNCTIONS) {
        await t.test(`「${l}」|「${r}」→ ${want ? '加' : '不加'}`, () => t.eq(pure.junction(l, r), want))
    }

    const { browser, close } = await h.setup(FIXTURES)

    /** 新开页面（独立 context），把 example.com 的请求映射到 fixtures。 */
    async function open(file, opts = {}) {
        const page = await browser.newPage()
        await page.route(/^https:\/\/example\.com\//, (route) => {
            const url = new URL(route.request().url())
            const name = path.basename(url.pathname) || file
            const fp = path.join(FIXTURES, name)
            if (!fs.existsSync(fp)) return route.fulfill({ status: 404, body: 'not found' })
            route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(fp) })
        })
        await h.install(page, SCRIPT, opts)
        await page.goto(`${SITE}/${file}`)
        await page.waitForLoadState('load')
        return page
    }

    const text = (page, sel) => page.$eval(sel, (el) => el.textContent)

    console.log('\nDOM')
    await t.test('页面上的文字被处理，pre / code 不动', async () => {
        const page = await open('basic.html')
        await page.waitForFunction(() => document.getElementById('p1').textContent.includes(' React '))
        t.eq(await text(page, '#p1'), '今天用 React 写了 2 个组件')
        t.eq(await text(page, '#p2'), '已经有空格的 English 不变')
        t.eq(await text(page, '#pre'), '代码里的x=1不动')
        t.eq(await text(page, '#p3 code'), 'npm包')
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('跳过 code / pre / kbd / samp / 表单控件 / 可编辑区 / svg / math / 脚本样式', async () => {
        const page = await open('skip.html')
        await page.waitForFunction(() => document.getElementById('ok').textContent === '正文用 Vue 写')
        const got = await page.evaluate(() => {
            const $ = (id) => document.getElementById(id)
            return {
                pre: $('pre').textContent, code: $('code').textContent, kbd: $('kbd').textContent, samp: $('samp').textContent,
                ta: $('ta').value, inp: $('inp').value, opt: $('opt').textContent, optValue: $('sel').value,
                ce: $('ce-p').textContent, ceFalse: $('ce-false').textContent,
                svg: $('svg-t').textContent, math: $('math').textContent,
                js: $('js').textContent, css: document.querySelector('style').textContent,
            }
        })
        t.eq(got, {
            pre: '块代码x=1中文', code: 'npm包', kbd: 'Ctrl键', samp: '输出A',
            ta: '文本框里A不动', inp: '输入框A不动', opt: '选项A', optValue: '选项A',
            ce: '编辑器里A不动加粗B', ceFalse: '不可编辑的 A 要处理',
            svg: '图形A', math: '变量x',
            js: "var s = '脚本A';", css: '.x{color:red}/* 样式里的中文A不动 */',
        })
        t.eq(h.errors(page).map(String), [])
        await page.close()
    })

    await t.test('只改文字：DOM 结构、元素与文字节点的引用、事件绑定都不变', async () => {
        const page = await open('structure.html')
        await page.waitForFunction(() => document.getElementById('p').textContent.includes(' 3 条'))
        const got = await page.evaluate(() => {
            document.getElementById('btn').click()
            return {
                sameSig: window.__sig() === window.__sig0,
                sameBtn: document.getElementById('btn') === window.__btnRef,
                heldConnected: window.__heldText.isConnected,
                heldValue: window.__heldText.nodeValue,
                clicks: window.__clicks,
                p: document.getElementById('p').textContent,
            }
        })
        t.eq(got, {
            sameSig: true, sameBtn: true, heldConnected: true, heldValue: '第 1 条', clicks: 1,
            p: '点击按钮 A之后会有 3 条记录',
        })
        await page.close()
    })

    await t.test('跨元素边界：空格加在不被样式影响的一侧', async () => {
        const page = await open('cross.html')
        await page.waitForFunction(() => document.getElementById('b').innerHTML !== '中文<b>English</b>中文')
        const html = await page.evaluate(() => {
            const out = {}
            for (const p of document.querySelectorAll('body > [id]')) out[p.id] = p.innerHTML
            return out
        })
        t.eq(html, {
            b: '中文 <b>English</b> 中文',
            a: '请看 <a href="#x">GitHub</a> 上的说明',
            'a-cjk': '项目<a href="#x">文档</a> English',
            aa: '<a href="#1">链接 </a><a href="#2">Link</a>',
            nested: '前面 <span><em>Deep</em></span> 后面',
            'em-left': '<em>强调</em> Text',
            code: '使用 <code>npm</code> 安装 <kbd>Ctrl</kbd> 键',
            spaced: '已有 <b>空格</b> 的',
            ws: '<b>中文</b>\n<i>English</i>',
            sup: '文字<sup>1</sup>注脚',
            br: '第一行<br>Second',
            block: '<div>块一</div><div>Block</div>',
            url: '<a href="#u">https://example.com/a</a> 中文',
            pct: '增长 <b>100%</b> 以上',
            cpp: '用 <i>C++</i> 写',
        })
        await page.close()
    })

    await close()
    t.done()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
