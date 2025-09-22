# 键盘浏览（keyboard-nav）开发笔记

## 做什么

Vimium 的轻量版，任意网页上用键盘浏览：

| 按键 | 作用 |
|---|---|
| `j` / `k` | 向下 / 向上滚一小步（60px） |
| `h` / `l` | 向左 / 向右 |
| `d` / `u` | 向下 / 向上半屏（按滚动容器自己的高度算） |
| `gg` / `G` | 顶部 / 底部 |
| `f` / `F` | 链接提示：当前页点击 / 新标签打开（`GM_openInTab`，后台） |
| `gi` | 聚焦第一个能打字的输入框（`3gi` 第三个） |
| `H` / `L` | 后退 / 前进（`2H` 退两步） |
| `r` | 刷新 |
| `yy` | 复制当前网址（`GM_setClipboard`） |
| `i` | 直通模式：除 Esc 外所有键交给页面 |
| `?` | 帮助浮层（从命令表生成） |
| `Esc` | 取消前缀 / 关提示 / 输入框失焦 / 退出直通 |

数字前缀（`5j`）对滚动、`gi`、`H`/`L` 有效。

不打扰：焦点在 input / textarea / select / contenteditable（含 open shadow DOM 里的）时不响应；
带 Ctrl / Alt / Meta 的组合键不拦；输入法组字时不拦；Gmail、Google 文档、Outlook、Notion、Figma、
腾讯文档、语雀、飞书、石墨、金山文档默认停用，菜单「在本站停用 / 启用键盘浏览」按站点切换。
右下角只在有事时显示：直通模式、链接提示、按了一半的前缀键（`5g`）。

`@run-at document-start`、`@noframes`。

## 怎么实现的

| 模块 | 做法 |
|---|---|
| `Sites` | GM 存储 `sites`，只存「和默认不同」的站点（`host → 'on' / 'off'`）；切回默认就删掉这条，默认黑名单以后增删，没手动改过的站点能跟着变。匹配含子域名 |
| `Scroll` | 选滚动容器 + 自己的 rAF 平滑动画（见下） |
| `Hints` | 收集 → 可见性 / 遮挡判断 → 生成标签 → shadow DOM 覆盖层 → 按键过滤 → 激活 |
| `Keys` | 按键缓冲：`pending`（多键序列已按的部分）+ `count`（数字前缀），1.5 秒超时清空 |
| `Status` / `Help` | 右下角状态区、帮助浮层，各自一个 open shadow root，宿主 `pointer-events: none` |
| 命令表 `COMMANDS` | `{ keys, group, desc, repeat, run(n) }`，绑定、前缀集合、帮助浮层都从它生成 |

按键在 `window` 的**捕获**阶段处理，而且是 document-start 就注册 —— 排在页面自己的 keydown 监听前面。
吃掉一个键时 `preventDefault` + `stopImmediatePropagation`，配套的 keypress / keyup 也一并拦下
（有的站点在 keyup 上绑快捷键，只拦 keydown 会两边一起触发）。

### 滚动目标：找「真正在滚的区域」

后台、文档站、聊天应用常是 body 不滚、内部 div 滚，对 window 滚动毫无反应。选法：

1. 最近一次鼠标按下的元素往上找，第一个还能往这个方向滚的容器（和浏览器方向键的行为一致：点过侧栏，j 就滚侧栏）；
2. 没点过、或者点过的地方往这个方向滚到头了：从视口中央的元素（钻进 open shadow root）往上收集可滚动的祖先，
   优先「还能往这个方向滚的」，其中取**可见面积最大**的 —— 普通文章页中央有个代码块时，j 滚的是页面而不是代码块；
3. 视口中央压着一层不滚的遮罩之类、一个都没找到：全页扫一遍，取可见面积最大的滚动容器。

### 平滑滚动为什么自己做

每个（容器, 方向）记一个目标位置，新按键只往目标上累加，rAF 每帧追剩余距离的 25%（按帧间隔换算，120Hz 屏速度一样）。
长按时自动重复的 keydown 让目标匀速前移，动画一直追着跑，就是连续匀速滚动。
动画途中用户自己滚了（位置和上一帧设的差 2px 以上）就放手；系统开了「减少动态效果」直接跳。

只有单键滚动命令（`repeat: true`）响应自动重复的 keydown；长按 `g` 不会变成 `gg`，长按 `f` 不会开一堆提示。

### 链接提示

- **收集**：`a[href]`、`button`、`input`、`select`、`textarea`、`summary`、`label`、常见 `role`、`[onclick]`、
  `tabindex >= 0`、`contenteditable`。按文档顺序遍历，遇到 open shadow root 钻进去（嵌套几层都行）。
- **可见 + 没被挡**：逐块 `getClientRects()`（折行链接有多块），先裁到视口内，再在中心和两个角附近用
  `elementFromPoint` 打点，打到的是元素自己或它的后代才算露在最上面。元素在 shadow DOM 里时用它所在的
  `ShadowRoot.elementFromPoint`，`document` 只能打到 host。
- **去重**：包着可见控件的 `<label>` 不出（控件自己有）；外层和里层框一样大的嵌套只留外层。
- **标签**：把字母表 `sadfjklewcmpgh` 当树，每次展开最浅的叶子，直到叶子够数 —— 最短且互不为前缀，
  输完一个标签立刻触发、不用等超时。30 个元素是 12 个单字母 + 18 个双字母。
- **激活**：能打字的元素 `focus()`；其余按真实点击的顺序派发 pointerover → mouseover → pointerdown → mousedown →
  （没被 preventDefault 就 focus）→ pointerup → mouseup → click，坐标给元素中心。
  F 只收能打开的链接（`HTMLAnchorElement` / `HTMLAreaElement`，排除 `javascript:`），`GM_openInTab(url, { active: false, insert: true, setParent: true })`。
- 提示开着时页面滚了：提示跟着元素挪，挪出视口的藏起来。窗口失焦、改尺寸、鼠标按下都退出提示。

### 为什么不做 `/` 页内查找

交给浏览器的 Ctrl+F / Cmd+F：

- 浏览器自带的查找会高亮全部匹配、显示「第几个 / 共几个」、还能搜 iframe 里的文字，自己遍历文本节点
  （还要处理 shadow DOM、折行、隐藏文本）很难做到同样好；唯一现成的 `window.find()` 是非标准接口，各浏览器行为不一（未实测对比）。
- 很多站点自己把 `/` 绑成「聚焦站内搜索框」（GitHub、YouTube、Gmail、MDN）。`/` 不绑，就原样交给站点，比一个半吊子的页内查找有用。

### 数字为什么不拦

数字前缀记下来，但数字键本身照常传给页面：YouTube 的 0–9 跳进度、一些站点的数字快捷键都不受影响。
代价是在这类站点上按 `5j`，`5` 也会被页面响应一次。

## 关键的坑

1. **原生平滑滚动连按会丢距离。**（实测，Chromium）`scrollBy({ behavior: 'smooth' })` 动画途中再调一次，
   新动画从「半路的当前位置」算起：停在 60 时快速连按两下 j，最后停在 120 而不是 180。长按时每个重复 keydown 都把动画
   打断重来，一顿一顿。所以改成自己维护目标位置的 rAF 动画。
2. **`behavior: 'auto'` 会被页面的 `scroll-behavior: smooth` 变成平滑滚动。**（实测）动画每帧的瞬时设置
   如果用 `'auto'`，页面 CSS 一开 `scroll-behavior: smooth`，每帧都变成一次原生平滑滚动、和自己的动画互相打架 ——
   长按 j 20 次本该滚到 1260，实测只爬到 184。每次设位置都显式 `behavior: 'instant'`。
3. **body 自己是滚动容器的页面。**（实测，边界测试测出来的）`html { height: 100%; overflow: hidden }` +
   `body { height: 100%; overflow: auto }` 这种写法，滚的是 body，`document.scrollingElement`（html）不滚。
   最初找祖先时把 body 和 html 一起跳过了，这种页面 j 完全没反应。反过来，html 是 `overflow: visible` 时
   body 的 overflow 传给了视口，body 本身不是滚动容器、设它的 `scrollTop` 没用 —— 只有 html 自己设了 overflow，
   body 才算独立的滚动容器。
4. **半屏滚动选容器时要带方向。**（实测，边界测试测出来的）d/u 的距离要等选好容器才知道（容器多高），
   最初选容器时方向固定传了「向下」：页面滚到底、视口中央是个还能往下滚的代码块时，u 选中了代码块
   （它往上滚不动），页面纹丝不动。方向和距离分开传。
5. **`<body onclick>` 这种全局事件委托。**（实测）body 匹配 `[onclick]`、整页都「可点」，左上角会多出一个
   毫无意义的提示。html / body 不出提示。
6. **视口里没东西可点时要说一声。**（实测）页面滚过之后输入框滚出视口，按 f 什么都不发生，看起来像脚本坏了。
   现在右下角提示「视口里没有可点击的元素」。
7. **焦点判断要穿 shadow DOM。** keydown 的 `target` 被重定向成 shadow host，`document.activeElement` 也停在 host 上；
   用 `composedPath()[0]` 和逐层 `shadowRoot.activeElement` 才拿到真正的输入框（测试覆盖了 shadow 里的 input）。
8. **`tabindex="-1"` 不算可点击。** 框架常给正文容器、弹窗外壳打 `tabindex=-1` 用来编程聚焦，算进去会冒出一堆巨大的提示。
9. **输入框里的 Esc 只失焦、不拦。** 输入框里的 Esc 往往还有站点自己的用途（关下拉、关弹窗），只 `blur()`，事件照常传下去。
   直通模式下退出用的 Esc 则吃掉。
10. **断掉的序列要回退。** 按了 `g` 再按 `j`，`gj` 不是命令；丢掉前缀把 `j` 当单键重新解释，否则 j 被吞掉。

## 已知限制

- **iframe**：`@noframes`，焦点在 iframe 里时按键到不了顶层页面，iframe 里的元素也不出提示。
- **closed shadow root** 里的元素拿不到，不出提示；closed shadow root 里的输入框获得焦点时也认不出来，
  在里面打字时 j/k 会被当成滚动（未实测，按 API 推断）。
- **非拉丁键盘布局 / CapsLock**：按 `e.key` 匹配，俄文布局下 j 键的 `e.key` 是西里尔字母，不响应；CapsLock 开着时 j 变成 J，也不响应（未实测）。
- **`target="_blank"` 的链接用 f 点**：派发的是合成点击（`isTrusted: false`），浏览器的弹窗拦截可能拦下新窗口（未实测）。要新标签打开请用 F。
- **只响应可信事件的组件**：检查 `event.isTrusted` 的站点，合成点击无效（未实测具体站点）。
- **scroll-snap 页面**：动画每帧设位置，`scroll-snap-type: mandatory` 可能每帧都吸回原位，滚不动（未实测）。
- **`<html>` 上有 `transform` / `filter`**（某些暗色模式扩展会加）时，`position: fixed` 的提示、状态区会跟着页面走（未实测）。
- 提示只覆盖**视口内**的元素；提示开着时滚动只挪位置，新滚进视口的元素不补提示。
- 页面先于脚本在 window 捕获阶段注册的 keydown 监听仍然先执行（Tampermonkey 的 document-start 通常早于页面脚本，但不保证，未在真实 Tampermonkey 里验证）。
- 黑名单只按 hostname 匹配，不能按路径（比如只想在某个站的编辑页停用）。
- 数字键不拦，在把数字绑成快捷键的站点上 `5j` 的 `5` 会被页面响应一次（见上文，刻意的取舍）。

## 怎么跑测试

```bash
NODE_PATH=/path/to/node_modules node keyboard-nav/test/run.cjs
```

`NODE_PATH` 指向任意一个装了 `playwright` 的 `node_modules`（本仓库不带依赖）。
测试用 `tools/userscript-harness.cjs` 在 Playwright（Chromium）里加载脚本、模拟 GM_*；
页面用 `page.route` 正则挂在假域名 `https://example.com/` 下（黑名单用例挂在 `https://mail.google.com/`），
其余请求一律 abort，不访问外网。fixtures 在 `test/fixtures/`。

覆盖（35 条）：j/k/d/u/h/l/gg/G 滚到准确位置（整页、body 不滚内部 div 滚、body 自己滚、页面底部的代码块）；
点过侧栏后滚侧栏、到底回落主区域；数字前缀与数字放行；序列断开与超时；吃掉的键 keyup 不漏；
平滑滚动连按不丢距离、长按单调不停顿、页面 `scroll-behavior: smooth` 不干扰、长按 g 不触发 gg；
f 提示数量与标签无前缀冲突、被遮挡 / 裁掉 / 不可见 / 视口外 / 禁用 / tabindex=-1 不出提示、固定顶栏下被裁的列表项；
真实点击序列、输入框聚焦、链接导航、label 切换隐藏复选框、过滤 / Backspace / Esc；
open shadow DOM（嵌套两层）的按钮、closed 的拿不到；F 调 `GM_openInTab`；gi / yy / H / L / r；
输入框里 j 不滚（含 shadow 里的 input、contenteditable）、Esc 失焦；模式指示；直通模式；
黑名单站点不响应与菜单切换、停用状态刷新后保留；`?` 帮助浮层。

长按用页面里派发 `repeat: true` 的 KeyboardEvent 模拟（每 33ms 一次，接近系统的自动重复），
因为从 Node 一个个发按键的往返时间不稳定，测不出「每帧都在动」。

harness 和真实 Tampermonkey 的差异，影响到的地方：

- harness 没有沙箱、脚本直接跑在页面上下文，「document-start 注册的捕获监听排在页面监听前面」在真实 Tampermonkey 里没验证过。
- GM 存储在 harness 里按源隔离；站点开关本来就按 hostname 存在一个 `sites` 键里，测试里用不同的假域名各开一个页面即可，没有受影响。
