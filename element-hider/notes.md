# 网页元素屏蔽（element-hider）开发笔记

## 做什么

uBlock 元素拾取器的轻量版：点选网页上的广告、浮窗、推荐栏，一键隐藏，以后再来也不出现。

- **拾取**：菜单「🎯 拾取要隐藏的元素」或 `Alt+Shift+H` 进入；悬停高亮、点击选中；
  滚轮 / `↑` `↓` 在父子层级间切换（往下原路返回）；`Enter` 选中当前层级；`Esc` 退出
- **确认面板**：自动生成的选择器可以手改，实时显示「当前选择器会匹配 N 个元素」并高亮全部匹配；
  非法选择器提示原因、不能保存；`↑ 父级` / `↓ 子级` 重新生成；作用域选「仅本站」或「整个主域名」
- **撤销**：保存后底部浮出「已隐藏 N 个元素 · 撤销」，5 秒自动消失
- **管理面板**（菜单「📋 管理本站屏蔽规则（N 条）」）：列出本站和主域名两个作用域的规则、每条的匹配数、
  当前一共隐藏了多少个元素；单条预览（取消隐藏、改成红色虚线描边，关面板自动恢复）、编辑、删除；
  导出所有站点的规则（文本框 / 下载文件）、导入 JSON（粘贴或选文件）
- **防误伤**：选择器匹配到 `html` / `body` / `head`，或某个匹配元素盖住视口 90% 以上（页面主体容器）时，
  第一次点「隐藏」只给警告，再点一次才保存；管理面板里编辑规则同样处理
- **本站临时停用**：菜单「⏸ 本站临时停用全部规则」，只管当前标签页，关掉就恢复

`@match` 全站，`@noframes`，`@run-at document-start`。

## 怎么实现的

| 模块 | 做法 |
|---|---|
| `Store` | GM 存储，每个作用域一个键：`rules:www.example.com`、`rules:*.example.com`，值是 `[{ selector, created }]`。页面加载只读本站相关的两个键 |
| `Styler` | 一张 `<style>`（`GM_addStyle`），每条规则一行 `:is(选择器):not(#x):not(#x):not(#x) { display: none !important }`。document-start 时就挂上，所以不闪；对动态插入的元素天然生效，不用 JS 逐个删 |
| `Gen` | 选择器生成：自己能单独定位就用自己（稳定 id → `data-testid` 一类 → `aria-label` / `name` / `alt` → 链接 → `role` → 标签 + 稳定类名）；不能就往上找有锚点的祖先，用 `>` 连下来，同级重复时加 `:nth-of-type` |
| `looksRandom` | 随机 id / 类名判据，一组正则 + 大小写乱序的哈希判断（见下） |
| `UI` | 一个铺满视口、自身 `pointer-events: none` 的 shadow DOM 宿主，挂在 `<html>` 下；高亮框画在里面，面板 / 提示条单独开 `pointer-events: auto` |
| `Picker` | `mousemove` → `elementFromPoint`；鼠标、滚轮、键盘事件全部在 window 捕获阶段拦下 |
| `Confirm` / `Manager` / `Toast` | 确认面板、管理面板、撤销提示 |
| `Backup` | 导出 `{ format: 'element-hider', version: 1, rules: { 作用域: [...] } }`；导入整份校验后合并，重复的跳过 |
| `Pause` | `sessionStorage` 里一个标记，`Styler` 见到就输出空样式表 |
| `Menu` | 规则数或停用状态变化时注销重注册菜单（菜单名里带条数） |

### 随机 id / 类名判据

构建工具生成的类名、组件库的自增 id，下次发版或下次渲染就变了，写进规则等于一次性规则。
判据**宁严勿松**：误判「稳定」→ 规则悄悄失效；误判「随机」→ 只是退回结构路径，照样能用。

| 判为随机 | 例子 |
|---|---|
| emotion / antd cssinjs | `css-1x2y3z`、`css-dev-only-do-not-override-1x2y3z` |
| styled-components | `sc-bdVaJa`、`sc-1a2b3c4d-0`；哈希类 `kZRDVx`、`iVXCSc`（5~8 个纯字母、≥2 个大写、又不是驼峰词） |
| CSS Modules | `Header_title__3xYz1`、`Button__root___2X3yZ`、`_3xYz1aBc`、`module--title--3xYz1` |
| JSS / Svelte / Astro / Stitches | `jss123`、`makeStyles-root-12`、`svelte-1xyz2ab`、`astro-J7PV25F6`、`c-dhzjXW` |
| 组件库 / 框架 id | `:r1:`、`«r2»`、`_r_3_`、`radix-:r3:`、`ember123`、`mui-38291`、`j_id12`、`react-select-2-input` |
| 长数字、uuid、十六进制、nanoid、字母数字穿插 | `div-gpt-ad-1690000000000-0`、`a3f9c01bd2`、`V1StGXR8Z5jdHi6B`、`x-1a2b3c` |

判为稳定的对照组：`card__title`、`btn--primary`、`MuiButton-root`、`navBarItem`、`col-md-6`、
`hover:bg-red-500`、`w-1/2`、`bili-video-card`。另外 `active`、`hover`、`is-open` 这类**状态类**一律不用 ——
拾取那一刻元素正被悬停 / 展开，平时没有这个类。

## 关键的坑

1. **覆盖层会挡住 `elementFromPoint`。** 宿主整个 `pointer-events: none`，命中测试直接穿过去打到页面元素；
   面板和提示条单独 `pointer-events: auto`，打到它们时 `elementFromPoint` 返回宿主本身（shadow 重定向），认出来跳过。
2. **拦点击的监听必须在 document-start 就挂。** 同一个目标同一阶段按注册顺序执行，进了拾取模式再挂，
   就排在页面自己的 window 捕获监听后面，链接照样跳、`mousedown` 上的菜单照样弹。所以启动时就挂好，用标志位开关。
   `pointerdown` / `mousedown` / `mouseup` / `click` / `auxclick` / `contextmenu` 都要拦，只拦 click 不够。
3. **快捷键按 `e.code` 认。** macOS 上 Alt+Shift+H 的 `e.key` 是 `Ó`（未实测，按键盘布局推断）。
4. **`:scope` 在 shadow root 上什么都不匹配。** shadow root 是 DocumentFragment，`root.querySelectorAll(':scope > .x')`
   恒为空 —— 拾取提示条关不掉，就是这么测出来的。改成遍历 `root.children`。
5. **页面自己写 `display: block !important`。** 两边都 `!important` 时比权重，`#main .ad` 比我们的 `.ad` 高，
   规则静默失效；document-start 时我们的样式表还排在页面样式**之前**，同权重也不能指望先后顺序。
   规则包进 `:is()` 再挂三个不存在的 id 的 `:not()`，权重抬高三个 id。`:is()` 不接受伪元素，带 `::` 的原样用。
6. **每条规则单独一行，不合并成选择器列表。** `a, b, c { … }` 里一个非法（比如浏览器后来不支持的伪类），整条作废。
7. **`querySelector` 当语法检查不够。** 它放行 `a/*`（未闭合注释），而样式表里这会把后面所有规则吞掉；
   花括号会提前结束规则块。这几种字符直接拒（导入时同理，防止一份 JSON 把样式表弄坏）。
8. **页面重写 `<head>` 会带走样式表。** 有的 SPA / 换页库 `document.head.innerHTML = …`，已隐藏的元素重新冒出来，
   而且没有任何报错。`MutationObserver` 盯整个文档，样式表一脱离就把同一个元素挂回去；被反复移除 50 次后放弃。
9. **界面不能被自己的规则藏掉。** 用户存一条 `html > *` 或 `body`，宿主也会命中。宿主用内联 `!important`
   写 `display: block`，内联的 `!important` 压过任何样式表；宿主挂在 `<html>` 下而不是 `<body>`，隐藏 body 时撤销提示还在。
10. **防误伤量尺寸要先关掉现有规则。** 已经被别的规则藏起来的主体容器量出来是 0×0，会漏判。
    `sheet.disabled = true` → 量 → 恢复，同步完成，中间不会绘制。
11. **结构路径不收开头只有「标签 + 序号」的。** `div:nth-of-type(3) > span`、`div.widget:nth-of-type(2)` 碰巧唯一也继续
    往上找有 id / 稳定属性的锚点 —— 页面别处多一个同样的结构就指错。
12. **广告联盟链接允许匹配多个。** 链接主机像广告（`ad.`、`ads.`、`doubleclick`、`googlesyndication`、`cpro`…）时生成
    `a[href^="https://主机/"]`，同页同一联盟的链接一起隐藏；普通外链必须精确到选中的那一个，免得点掉一个 GitHub 链接全页的都没了。
13. **导入要么全进、要么全不进。** 只导一半时用户不知道哪些进去了，再导一次又撞重复。错误信息指出位置，如 `rules["a.com"][1]：缺少 selector`。
14. **重复保存不给撤销。** 规则已存在时「撤销」会把原来那条删掉，所以只提示「这条规则已经存在」。

## 已知限制

- 元素的**内联** `style="display: … !important"` 压过任何样式表，这种隐藏不了（需要 JS 改内联样式，没做）。
  页面规则带四个以上 id 并且 `!important` 时也会压过。
- 看不到 Web Components 的 shadow DOM 内部：拾取只能选到宿主元素，样式表也穿不进 shadow root。
- `@noframes`：iframe 元素本身可以拾取隐藏，跨域 iframe 里面的内容管不到。
- 「整个主域名」不查公共后缀表，只认一小组常见二级后缀（`com.cn`、`co.uk`…）。`user.github.io` 这种
  会算成 `*.github.io`，存成主域名规则就会作用到所有 GitHub Pages 站点 —— 这类站点请用「仅本站」。
- 生成的结构路径（`:nth-of-type`）在站点改版后会失效；稳定属性 / 类名的规则也只是「大概率」稳定。
- 元素只是 `display: none`，还在 DOM 里；靠量广告位尺寸检测拦截的站点能发现。
- 「临时停用」存在页面源的 `sessionStorage` 里，页面自己清空 sessionStorage 时会提前恢复。
- 防误伤只在拾取保存和管理面板编辑时检查；导入的规则不检查。
- **未实测**：真实 Tampermonkey 下 GM 存储跨子域名共享（harness 按源隔离，测试里只能在各源预置规则）；
  严格 CSP（`style-src` 不含 `unsafe-inline`）站点上 `GM_addStyle` 是否被拦；macOS 上的快捷键；
  触控板滚动一次触发多个 wheel 事件时会连跳几级层级。

## 测试

```bash
NODE_PATH=/path/to/node_modules node element-hider/test/run.cjs
```

页面用 `page.route` 挂在 `https://*.example.com` 假域名下（正则匹配），不访问外网；规则按 hostname 存，
测的就是真实域名下的行为。选择器生成和随机判据的单测走调试钩子：GM 存储里 `debug: true` 时脚本把
`looksRandom` / `selectorFor` / `selectorError` / `mainDomain` 挂到 `window.__elementHider`（平时也能在控制台用
`__elementHider.selectorFor($0)` 看某个元素会生成什么）。

覆盖：随机类名 / id 判据（一批真实风格样例）；稳定属性优先、生成结果只匹配目标、广告联盟同类匹配；
拾取（菜单 / 快捷键、悬停高亮、点击不触发页面监听、滚轮与方向键切换层级、Esc）；
刷新后 DOMContentLoaded 之前样式已生效；动态插入也隐藏；页面 `!important` 与重写 `<head>`；
确认面板（匹配数、高亮全部、手改、非法提示、作用域）；撤销与 5 秒消失；管理面板预览 / 编辑 / 删除 / 统计；
导出、非法导入被拒；body 与主体容器警告；临时停用。
