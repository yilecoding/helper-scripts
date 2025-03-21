# copy-unlock 开发笔记

解除网页的复制限制：禁止选中、禁止右键、复制后追加版权尾巴、「登录后复制」。
全站生效（`@match *://*/*`），按站点可停用。

## 做了什么

| 层 | 对付的写法 | 做法 |
|---|---|---|
| CSS | `* { user-select: none }`、`::selection { background: transparent }` | 注入 `user-select: text !important`（含 `-webkit-`），恢复系统选区色；表单控件、按钮、可编辑区不动 |
| 内联属性 | `<body oncopy="return false">`、`unselectable="on"`、`style="user-select:none !important"` | MutationObserver 从 `document` 开始盯，解析器插入的、之后动态插入的、运行时重挂的都清 |
| 事件 | `document.onselectstart = () => false`、`addEventListener('copy', 加尾巴)`、拦 Ctrl+C/A/X、拦右键、拦拖拽 | window 捕获阶段 `stopImmediatePropagation`，页面处理器收不到事件 |
| 复制 | 尾巴、隐形干扰字、零宽水印 | 自己往 `clipboardData` 写 text/plain + text/html |
| 站点规则 | CSDN「登录后复制」、点代码块弹登录、长代码折叠；在线文档的右键菜单 | `SITES` 表，一站一条 |

菜单（Tampermonkey 图标里）：

- `✅ 本站已启用（host），点击停用` / `⛔ 本站已停用（host），点击启用`
- `🖱 右键：已解锁…` / `🖱 右键：未解锁…`

设置存在 GM 存储的 `sites` 里：`{ [hostname]: { disabled?, contextMenu? } }`。
和默认值相同的项不落盘。改完会刷新页面——事件监听和样式都是 document-start 装上的，热切换拆不干净。

## 关键的坑

### 1. 为什么是「让页面收不到事件」，而不是「撤销 preventDefault」

`<body oncopy="return false">` 和 `document.oncopy = () => false` 是在引擎内部取消默认行为的，
改写 `Event.prototype.preventDefault` 拦不住它们；事件一旦被取消也撤不回来。
唯一可靠的办法是在传播路径的起点——window 捕获阶段——截住，所以必须 `@run-at document-start`，
保证我们的监听排第一。

代价是页面对这些事件的所有监听都失效，因此：

- **可编辑区整块放行**（input / textarea / contenteditable）。富文本、代码编辑器（Monaco 用隐藏 textarea）
  靠 copy / cut / keydown 维护自己的数据模型，截了就坏。
- **keydown 只截 Ctrl/Cmd + C/A/X**，其他快捷键照常。
- **`draggable="true"` 的元素放行 dragstart**，拖拽排序、拖拽上传是正常功能。
- **右键单独一个开关**，在线文档（腾讯文档、飞书、语雀、石墨、金山文档）默认不解锁。

判断可编辑区要用 `composedPath()[0]`：Shadow DOM 里的事件冒到 window 时 `e.target` 已被重定向成宿主元素。
`selectstart` 的目标还可能是文本节点，要取 `parentElement`。

### 2. 带 id 的 `!important` 压过全局样式 → `@layer`

CSDN 那种 `#content_views pre code { user-select: none !important }` 特异性是 (1,0,2)，
`body *:not(...)` 的 `!important` 赢不了。全局规则放进 `@layer copy-unlock`：
级联层对 `!important` 是反着排的，层内的 `!important` 胜过所有层外的 `!important`，与特异性无关。

层也压不过的只有内联 `style="... !important"`，由 JS 只摘掉 `user-select` 一项（同一个 style 里别的声明不动），
`style` 属性也在 MutationObserver 的过滤列表里，页面运行时 `el.style.userSelect = 'none'` 也能解开。

### 3. 浏览器原生复制会带出「看不见的字」

实测 Chrome：`Selection.toString()` 跳过 `display:none` / `visibility:hidden`，
但 `font-size:0`、`color:transparent` 的文字和零宽字符都原样保留；`Range.cloneContents()` 连 `display:none` 也克隆。
小说站、文库就靠这个在正文里夹干扰字。

做法：copy 时把选区里这类元素临时打上 `data-copy-unlock-hide`（样式里是 `display:none !important`），
再借浏览器自己的 `toString()` 取文本（换行、空白和原生一致），取完立刻摘掉属性。同步完成，不会闪。

- 零宽字符只删 U+200B / U+2060 / U+FEFF。**U+200D 是 emoji 组合序列的连接符**（👨‍👩‍👧），
  U+200C 是波斯文、印地文的正常字符，删了会把正文弄坏。
- `color: transparent` + `background-clip: text` 是渐变标题，看得见，不能当干扰字删。
- HTML 里的相对链接 / 图片地址改成绝对地址；只选中代码块的一部分时补回 `<pre>`，否则粘贴后缩进被折叠。

### 4. document-start 时 `documentElement` 可能还是 null

样式不用 `GM_addStyle`，自己建 `<style>`，等 `<html>` 出现再挂（`whenRoot()`）。

### 5. 内联 `onmousedown` 不能一刀切

链接上的 `onmousedown` 常用来做点击统计、改写跳转地址。`onmousedown` / `onmouseup` / `onkeydown`
只在内容像拦截（`return false` / `preventDefault` / `returnValue = false`）时才删。

## 加一个站点

在 `SITES` 里加一条，字段都可选：

```js
{
    name: '某站',
    hosts: ['example.com'],          // 匹配本域及所有子域
    contextMenu: false,              // 本站默认不解锁右键
    css: `.foo { display: none !important; }`,
    stripAttrs: { onclick: /login/ },// 属性内容匹配才删
    copyButton: {                    // 站点自带的复制按钮改成直接复制
        selector: '.copy-btn',
        label: '复制',
        code: btn => btn.closest('pre').querySelector('code'),
    },
}
```

CSDN 规则按 2026 年的页面结构写（`.hljs-button` 的 `data-title="登录后复制"`、`<code onclick="mdcp.signin(event)">`、
`pre.set-code-hide` + `.hide-preCode-box`），CSDN 改版后要对着页面重新核对。

## 已知限制

- 页面在我们之前注册的 window 捕获监听拦不住（Tampermonkey 注入晚于页面内联脚本时会出现）。
- 可编辑区整块放行：页面在 document 上拦 Ctrl+C，输入框里的 Ctrl+C 仍会被拦。
- 全局样式进不了 Shadow DOM，shadow root 内部的 `user-select: none` 解不开；closed shadow root 里的编辑框也判断不到。
- 定时 `getSelection().removeAllRanges()` 清选区、或者用透明遮罩层盖住正文的页面没处理。
- 正文是图片 / Canvas 渲染的（部分文库）复制不了，那不是复制限制。
- 复制出的 HTML 只保留结构，不带原生复制那种逐元素的内联计算样式，粘到 Word 里格式更朴素。
- `visibility:hidden` 的父元素里如果有 `visibility:visible` 的子元素，HTML 里会被一起删掉。
- 截掉 selectstart 后，拖滑块、拖分栏时会顺带选中文字（页面原本靠拦 selectstart 避免这个）。
- `::selection` 颜色是全站覆盖成系统选区色，站点自定义的选区配色会丢。

## 测试

```bash
NODE_PATH=/path/to/node_modules node copy-unlock/test/run.cjs
```

用仓库的 `tools/userscript-harness.cjs`，`NODE_PATH` 指向任一装了 playwright 的 `node_modules`。
`test/fixtures/` 里是各种限制写法的最小页面；需要按域名走站点规则的用例（CSDN、在线文档）用
`context.route()` 把 fixture 当作真实地址的响应，不访问外网。复制结果从系统剪贴板读回
（上下文授予了 `clipboard-read` / `clipboard-write`）。

| fixture | 覆盖 |
|---|---|
| `no-select.html` | CSS 整页禁选、透明选区；按钮 / 输入框不被改 |
| `inline-attrs.html` | 内联属性清理、异步插入和重挂的属性、正常 onmousedown 保留 |
| `events.html` | 脚本层的 selectstart / 右键 / Ctrl+C·A / 版权尾巴；编辑区放行；站点停用；菜单开关 |
| `interference.html` | 隐形干扰字、零宽字符、渐变文字、emoji、相对链接、部分选中代码块 |
| `csdn.html` | CSDN 复制按钮、点代码块弹登录、代码折叠、版权声明 |
| `specificity.html` | 带 id 的 `!important`、内联 `!important`、运行时改 style |
| `edge.html` | draggable 组件、图片拖拽、Shadow DOM 里的编辑框 |
