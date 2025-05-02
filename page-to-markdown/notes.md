# page-to-markdown 开发笔记

把文章页的正文一键转成干净的 Markdown，复制到剪贴板或下载为 `.md`。
自包含，不 `@require` 任何外部库（转换器、正文提取都是脚本里自己写的）。

## 用法

Tampermonkey 菜单里三项：

| 菜单 | 行为 |
|---|---|
| 复制正文为 Markdown | 自动找正文 → 转换 → `GM_setClipboard`。**页面上有选中文本时只转选区** |
| 下载正文为 Markdown | 同上，存成 `<标题>.md` |
| 手动选择区域 | 悬停高亮，点击复制（Shift+点击下载）；↑ / 滚轮向上扩到父元素，↓ / 滚轮向下原路缩回，Esc 退出 |

输出顶部带 YAML front-matter：

```yaml
---
title: "用 Rust 写一个 HTTP 服务器"
url: "https://…"
author: "李四, 王五"          # 取不到就不写
date: "2026-10-01T08:00:00+08:00"  # 取不到就不写
captured: "2026-10-28T23:54:28+08:00"
---
```

`CONFIG` 里可以关掉 front-matter（`frontMatter`）、关掉「没有 h1 时补标题」（`titleHeading`）、改列表标记和文件名长度。

## 实现

```
findContent()       Readability 风格打分，返回正文元素（最高分容器 + 够格的兄弟）
cloneForConvert()   克隆；在活 DOM 上判隐藏 / 判「CSS 显示成块」，按下标把标记抄到克隆上；cleanTree() 清噪声
selectionRoot()     选区 → 碎片，补回 pre / 列表 / 表格外壳
Picker              手动选区模式
htmlToMarkdown()    renderChildren / renderBlock / renderInline 递归；最后 resolveEmphasis()
buildDocument()     front-matter + 标题 + 正文
output()            复制 / 下载（GM_download，失败退回 <a download>）
```

### 正文提取

照 Mozilla Readability 的思路：

1. 「段落」= `p` / `pre` / `td`，外加没有块级子元素的 `div` / `section`（很多中文站一段一个 div）。
   不可见的（`getClientRects()` 为空）和位于噪声区里的跳过。
2. 段落分 = `1 + 逗号数 + min(长度/100, 3)`，长度不足 25 的不计。分数传给父（全额）、祖父（1/2）、曾祖父（1/6）。
3. 祖先的初始分按标签（div +5、列表 -3、标题 -5…）加 class/id 正负关键词（±25），`article` / `main` / `itemprop=articleBody` 再 +25。
4. 最终分 × (1 − 链接密度)，取最高；只有一个孩子的包装层往上提；分数 ≥ max(10, 最高分×20%) 的兄弟和够长的 `<p>` 兄弟一并带上。
5. 噪声区：`nav` / `aside` / `footer` / `form` / `dialog`、`role=navigation|complementary|…`、
   class/id 命中 comment / sidebar / footer / share / related / 广告词 等且不命中 article / content / post 等。

清理（只对自动提取的结果做 class 关键词清理，见下面坑 6）：script / style / iframe / svg / 表单控件 / 隐藏元素 /
`aria-hidden` 的小元素 / `.sr-only` / 广告块（`ins.adsbygoogle`、`div-gpt-ad`、`data-ad*`、按词边界匹配的 ad 类名）/
链接占比 > 60% 的小块（相关文章、标签云）。

### 转换器

- 块：标题、段落、列表（有序带 `start`、嵌套、任务列表）、引用（可嵌套）、代码块、GFM 表格、`hr`。
- 行内：加粗、强调、删除线、行内代码（内容含反引号时加长围栏）、链接、图片、`<sup>`/`<sub>`（保留 HTML）、`<br>`。
- `<br>` 先输出占位符，整段拼完再定：段首段尾的丢掉、连续两个以上当分段（不少中文站用 `<br><br>` 代替 `<p>`）、
  单个变成 `\` + 换行（CommonMark 硬换行）。表格里变 `<br>`，标题里变空格。
- 代码块语言来源：`language-*` / `lang-*` / `highlight-source-*` / `brush: *` / `data-lang`，以及
  `hljs xxx`、`highlight xxx`（Hexo 的 `figure.highlight`）、`sourceCode xxx`（pandoc）旁边的类名。往上找 5 层祖先。
- 图片地址：先 `data-src` 一类懒加载属性，再 `srcset` / `data-srcset` 里最大的那张，最后才是 `src`；
  `src` 是短 `data:` URI 的视为占位图丢掉。

## 关键的坑

每条都有对应测试（`test/run.cjs` 里搜关键词）。

1. **中文段落过不了 25 字门槛。** Readability 按字符数算长度，一个中文字信息量约等于两三个英文字母。
   不加权时中文正文的段落大半不计分，正文容器反而输给侧栏。现在 CJK 字符算 2，逗号把 `，、。；` 也算上。

2. **隐藏元素只能在活 DOM 上判断。** 克隆出来的游离节点拿不到计算样式。`cloneNode(true)` 结构一致，
   两边 `querySelectorAll('*')` 顺序一一对应，按下标把「隐藏」「CSS 显示成块」标记抄到克隆上再删 / 再判。

3. **`**注意：**这里` 不是加粗。** CommonMark 规定闭合的 `**` 如果前面是标点，后面就必须是空白或标点；
   中文里「冒号 / 引号 + 紧跟正文」极常见，照直输出会在渲染结果里留下一对裸星号。
   要看到外面紧挨着的字才能判断，所以强调先输出成私用区占位符，整篇拼完在 `resolveEmphasis()` 里
   看左右字符定成 `**` 还是 `<strong>`。英文的 `**Note:** text` 不受影响。

4. **相邻的两个同类列表会被并成一个。** 中间空一行也拦不住（CommonMark 里那只会让它变成宽松列表）。
   后一个换标记：`-` ↔ `*`，`1.` ↔ `1)`。

5. **表格单元格里的 `|` 连行内代码里的也要转义。** GFM 先按 `|` 切列再解析行内语法，`` `a | b` `` 也会把列切断。
   换行只能写 `<br>`。单元格里不做行首转义（单独一个 `-` 是常见的「无」，转成 `\-` 难看）。

6. **用户点选的评论区被清成空。** 自动提取后的清理会删 class 命中 comment 的元素；手动点选 `section.comments`
   时这条把里面的 `.comment` 全删了，结果是「没有提取到内容」。手动点选和选中文本只清硬噪声（脚本 / 隐藏 / 表单），
   选中的根元素本身永远不删。

7. **短正文、表格多的页面，最高分落在某个单元格上。** 兄弟合并捞不回分数低的表格和列表。
   页面只有一个 `<article>`（或 `itemprop=articleBody`）且最高分在它里面时，直接用它。

8. **各家高亮器的行号。** `textContent` 会把行号和代码拼在一起：
   Prism `span.line-numbers-rows`、highlightjs-line-numbers 的 `table.hljs-ln`（每行一个 `tr`）、
   CSDN 的 `ul.pre-numbering`、Hexo / Pygments 的 `td.gutter` / `td.linenos`（整列行号是另一个 `<pre>`）。
   另外 `<pre>` 里每行一个 `div` / `tr` 的结构，只取 `textContent` 会把行粘起来，要按块边界补换行。

9. **选区丢外壳。** `range.cloneContents()` 在 `<pre>` 里选半段只给几个文本节点，既不是代码块也没语言。
   从公共祖先往上到最近的 `pre` / `ul` / `ol` / `table` / `blockquote`，把这段祖先浅拷贝回来套上。

10. **转义要克制。** `.`、单词中间的 `_`（snake_case）、两边都是空白的 `*` 不转；`2*3*4`、`3~5`、`__init__` 转。
    行首的 `# ` `- ` `1. ` `> ` 和 `---` 只在一段拼完后按行转 —— 单个文本节点不知道自己在不在行首。
    字面的 `[文字](地址)` 只转 `]`；`<div>` 转 `<`；`&nbsp;` 转 `&`；文本末尾的 `\` 也要转，否则吃掉紧跟的 `**`。

11. **「没有 h1 就补标题」要看 DOM，不能在 Markdown 里搜 `# `。** 代码块里的 shell 注释也是 `# ` 开头。

12. **srcset 不能按裸逗号切。** cloudinary 一类的地址里有 `w_800,h_600`。URL 贪婪吃到空白为止，之后的逗号才是分隔符。

13. **手动模式要连 `mousedown` / `pointerdown` 一起拦。** 只拦 `click` 时链接还是会跳 —— 不少 SPA 的路由在 mousedown 就切了。
    高亮框放在 `pointer-events:none` 的 shadow 宿主里，不挡命中，也不吃页面 CSS。

14. **YAML 值一律加双引号。** 标题里的 `: `、`#`、开头的 `[` 都会让不加引号的 front-matter 解析出错。
    抓取时间写本地时区（`toISOString()` 是 UTC，读起来差 8 小时）。

15. **文件名。** 去掉 `\ / : * ? " < > |` 和控制字符、首尾的点和空格；`CON` / `NUL` 一类保留名后面加 `_`；
    按码点截断，不把 emoji 切成半个。

## 已知限制

- 表格：`rowspan` 不处理（列会错位）；单元格里的块内容压成 `<br>` 连接的一行；嵌套表格整张按排版表格展开。
- 不进 Shadow DOM（`cloneNode` 不复制 shadow root），Web Components 里的正文会丢；`iframe` 内容、`svg` 图表直接丢。
- 数学公式拿到的是渲染后的文字，不是 TeX 源码；脚注不转成 GFM 脚注语法。
- 行号如果是直接写在每行文本里的（没有任何标记），去不掉。
- 只靠 JS 才设置地址、DOM 里没有任何属性的懒加载图片拿不到；分页 / 无限滚动的文章只转当前已加载的部分。
- 选中文本模式不过滤隐藏元素（选区碎片拿不到计算样式）。
- 手动模式里滚轮被用来扩 / 缩选区，页面不能用滚轮滚动（可用键盘或拖滚动条）。
- 两段删除线紧挨着（`~~旧~~~~价~~`）时的渲染结果取决于渲染器。
- Tampermonkey 的 `GM_download` 受扩展名白名单约束，被拒时脚本退回 `<a download>` —— 这条退路**没有在真实
  Tampermonkey 上实测过**，测试 harness 的 `GM_download` 模拟总是成功，走不到 `onerror`。
- 正文提取是启发式的：多个 `<article>` 的聚合页、正文被切成很多小块的页面可能选不准 —— 用「手动选择区域」兜底。
- 只在 Chromium（Playwright）里测过，没在 Firefox / Violentmonkey 上跑过。

## 测试

```bash
# 仓库根目录。本仓库不带 node_modules，借一个装了 playwright 的目录
NODE_PATH=/path/to/node_modules node page-to-markdown/test/run.cjs
```

用 `tools/userscript-harness.cjs` 在 Playwright 里加载脚本、模拟 `GM_*`，通过菜单触发，断言剪贴板 / 下载记录里的具体 Markdown 片段。

| fixture | 覆盖 |
|---|---|
| `basic.html` | 标题、段落、强调、链接、`<br>` / `<br><br>`、`hr` |
| `article.html` | 带导航 / 侧栏 / 评论 / 页脚 / 广告 / 隐藏元素的博客页，正文选对；标题去站点后缀；选中文本；手动选区 |
| `lists.html` | 嵌套缩进（含两位数序号 4 格缩进）、任务列表、`ul` 直接套 `ul`、宽松列表、嵌套引用 |
| `code.html` | 行内代码、9 个代码块（Prism / hljs-ln / CSDN / Hexo / GitHub / pandoc / 逐行 div …）的语言推断与去行号、内容含 ```` ``` ```` 时加长围栏、选区落在代码块里 |
| `tables.html` | GFM 表格、对齐、`\|` 与换行转义、colspan、排版用单列表格展开 |
| `links.html` | 用 `page.route` 模拟 `https://blog.example.com/…`：相对 / 根相对 / 锚点链接转绝对、懒加载 `data-src` / `srcset` / `data-actualsrc`、图片链接、卡片链接 |
| `meta.html` | front-matter（og:title、JSON-LD `@graph` 里的多作者、发布时间、抓取时间）、补 h1、下载文件名去非法字符、下载内容 |
| `escape.html` | 转义收敛与行首转义、中文标点贴着加粗 |
| `edge.html` | 相邻同类列表、CSS 显示成块的 `span` / 自定义元素 / `strong` / `img` |

测试不访问外网：fixture 由 harness 起的本地服务提供；模拟真实域名的那个用例先把所有 `http(s)` 请求 abort，
再只放行 `blog.example.com`（Playwright 里后注册的路由优先）。下载内容的断言是在页面里 `fetch` 那个 Blob URL ——
脚本延迟 60 秒才 revoke，正是为了 `GM_download` 异步取数据时还能读到。
