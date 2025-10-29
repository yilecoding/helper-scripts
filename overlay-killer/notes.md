# 弹窗遮罩清理（overlay-killer）开发笔记

## 做什么

打开页面后自动清掉挡住正文的东西：

- **Cookie 同意弹窗**：认得 OneTrust、Cookiebot、Quantcast Choice、Didomi、Usercentrics、TrustArc、
  Sourcepoint、CookieYes、Complianz、Osano、cookieconsent、Klaro；不是这些平台的自建横幅按「贴边 + 说明句里有
  Cookie/隐私字样」兜底。**优先点「拒绝全部 / 仅必要」，没有拒绝按钮才隐藏横幅，从不点「接受全部」。**
- **遮罩**：「登录后查看全文」「打开 App 阅读」这类盖住大半个视口的半透明固定层，连同上面的弹窗一起隐藏，
  并恢复被锁住的滚动（`overflow: hidden`、`position: fixed; top: -Npx`、`touch-action: none`）。
- **「打开 App」引导条**：贴在顶部 / 底部的小条，直接隐藏。
- **折叠全文**：`max-height`/`height` + `overflow: hidden` + 渐变 + 「展开阅读全文」按钮，展开并去掉按钮和渐变。
- **菜单**：本站停用 / 启用、手动「清理当前页」、本页处理记录（列表 + 撤销最近一次）、撤销最近一次。

`@match` 全站，`@noframes`，`@run-at document-end`。

### 为什么不点「接受全部」

隐藏横幅 ≈ 没有表态。GDPR 一类的规定要求用户表态前只放必要 Cookie，规范的 CMP 也是这么实现的；
而点「接受」是替用户做了一个他没做的同意，而且 CMP 会把它记下来、之后不再问。
所以顺序是：拒绝按钮（规则表里的 id → 横幅里按文字找）→ 隐藏。
即便选择器命中了，按钮上写的是「接受全部 / Accept all / 同意」也不点（`ACCEPT_ALL_RE` 兜底）——
CMP 改版时把 id 挪给别的按钮是可能发生的。

## 怎么实现的

| 步骤 | 做法 |
|---|---|
| `cookieCmp` | CMP 规则表：`detect`（横幅，可见才算）/ `reject` / `hide` / `shadow`（Usercentrics 画在 open shadow root 里）。找不到 `reject` 时在横幅里按文字找。点了以后 1.5 秒横幅还在（CMP 脚本没接住），改成隐藏 |
| `overlays` | 视口里取 5 个点 `elementsFromPoint`，收集命中元素的所有 fixed 祖先，逐个打分（见下），过线的连同弹窗本体一起隐藏，再解滚动锁 |
| `edgeBars` | 视口四边各取两行点，取命中元素最外层的 fixed/sticky 祖先；高度 ≤ 60% 视口、贴边 50px 以内的，按「说明句」分成 Cookie 横幅 / App 引导条 |
| `expandFolds` | 先跑站点规则；再用 XPath 找文字含「展开 / 全文 / read more…」的文本节点，按钮文字整句匹配后，往上 5 层、每层看自己和前面 3 个兄弟，找被截断的容器 |
| `guard` | 已隐藏的元素被站点重新显示就再藏回去；本页解过锁、视口里又没有别的大浮层时，补解后加的滚动锁 |
| 时机 | document-end 跑一次；`MutationObserver`（childList + class/style/hidden/open 属性）节流 300ms；`load` 再跑一次。每轮结束 `takeRecords()` 丢掉自己改动触发的记录 |
| 标记 | 处理过的元素打 `data-overlay-killer="<方式>"`：`consent`/`rejected`/`overlay`/`app`/`expand`/`expanded`/`user`/`undone`/`self`，带标记的不再处理 |
| 撤销 | 所有样式改动都走 `setImportant()`，记下原来的内联值和优先级，撤销时原样放回（原来没有就删掉）。点过的拒绝按钮撤不回来，记录里标「不可撤销」，撤销时跳过 |

### 遮罩打分（满分 10，及格线 6）

| 条件 | 分 |
|---|---|
| fixed 定位（候选本身就是） | +1 |
| 盖住视口 ≥ 95% / ≥ 60%（不到 60% 不算候选） | +2 / +1 |
| 半透明背景（alpha 在 0.05~0.95，算自身和铺满它的子元素），否则有 `backdrop-filter` | +3 / +2 |
| z-index ≥ 1000 / ≥ 10 | +2 / +1 |
| html/body 滚动被锁 | +1 |
| 遮罩 + 弹窗的文字像登录墙 / 打开 App | +1 |
| 文字超过 3000 字（那是正文，有的站整个 app 外壳就是 fixed 全屏） | −3 |

纯白不透明、z-index 不高、又没有「登录」字样的全屏层到不了 6 分 —— 那多半是 SPA 外壳或站点自己的全屏页面。

### 不误伤的判据

- **用户自己打开的模态框**：弹窗第一次被扫到时，距离用户最近一次**真实的**（`isTrusted`）`pointerdown`，
  或者回车 / 空格键，不到 1.5 秒，就算用户打开的。打 `user` 标记，之后关了再开（同一个元素）也不动。
  扫描本身有最多 300ms 的节流延迟，所以宽限要比它长得多。打字不算（只认回车和空格）。
  脚本自己 `.click()` 的拒绝按钮、站点代码派发的事件都不是 `isTrusted`，不会误开宽限。
  同一判据也用在 Cookie 横幅上：用户在页脚点了「Cookie 设置」重新打开的横幅，不能替他点拒绝。
- **全屏**：`document.fullscreenElement` 和候选互相包含时不动；「网页全屏」播放器（里面有占了一半以上视口的 `<video>`）不动。
- **图片灯箱**：里面有占三成以上视口的 `img/picture/canvas`，或者类名像灯箱（lightbox、fancybox、photoswipe/pswp、viewer、gallery…）。
- **原生 `<dialog>`**：不动，那是站点自己的模态框。
- 菜单里「清理当前页」是用户明确要清：忽略 `user` 标记和宽限期。

### 站点规则（折叠全文）

| 站点 | 截断容器 | 去掉 | 状态 |
|---|---|---|---|
| CSDN | `#article_content`（内联 `height: 2000px; overflow: hidden`） | `.hide-article-box` | **未实测**，结构参照公开的去限制脚本 |
| 知乎 | `.RichContent--collapsed .RichContent-inner` | `.RichContent--collapsed .ContentItem-expandButton` | **未实测**，按类名推测 |
| 百度知道 | `.best-text, .answer-text` | `.wgt-best-mask, .wgt-answers-mask, .wgt-best-showbtn` | **未实测**，按类名推测 |

选择器不命中时没有副作用，通用识别照常兜底。CMP 规则表的选择器同样来自各家的公开接入文档和常见页面结构，
**都没有在真实站点上逐个实测**；测试里的 OneTrust / Quantcast / Usercentrics 是按这些结构写的模拟页面。

## 关键的坑

下面的都是开发中用测试实际撞到的：

1. **`scrollTo` 能穿过 `overflow: hidden`。** 一开始用「`scrollTo(500)` 后 `scrollY === 500`」判断页面能不能滚，
   结果滚动锁没解开的用例也是绿的 —— `overflow: hidden` 只拦用户滚动，脚本滚动照样生效。
   现在看 computed style，没装 `page.clock` 的用例再补一个真实滚轮（`page.mouse.wheel`）。
2. **滚动锁可能在遮罩隐藏之后才加。** 弹窗库常在入场动画结束后才锁滚动。遮罩那一步只在隐藏的当下解锁，
   后加的锁一直留着，页面滚不动又看不出原因。`guard()` 在本页解过锁、视口里没有别的大浮层时补解 ——
   后面这个条件是为了不去解灯箱、用户自己打开的对话框的锁。
3. **`el.style.display = 'block'` 能盖掉内联的 `display: none !important`。** 内联 `!important` 挡得住样式表，
   挡不住站点脚本直接改同一条内联声明。元素带着标记，常规扫描会跳过它，所以要 `guard()` 单独盯着已隐藏的元素。
4. **固定顶栏里有「隐私政策」「下载 App」链接很正常。** 按整条横幅的文字匹配关键词，会把整条导航栏当成
   Cookie 横幅藏掉。关键词只在链接 / 按钮以外的「说明句」里找；整条就是一个链接的「App 内打开」小条另走一条路
   （字少、可点的东西 ≤ 3 个）。那条小条只有 7 个字，最初的「至少 8 个字」门槛把它漏掉了，现在是 4。
5. **展开按钮的文字要整句匹配。** 包含匹配下「查看更多评论」会被当成展开按钮，把它前面一个无关的
   `overflow: hidden` 容器展开；只往后找兄弟节点时，按钮会管到下一篇文章的截断容器。
   现在整句匹配（允许「登录后」「关注博主即可」前缀），只看自身和**前面**的兄弟。
6. **自己的改动会触发自己的 MutationObserver。** 每轮清理结束 `observer.takeRecords()` 丢掉队列。
   自己的处理记录面板也是 fixed 浮层，打 `self` 标记，免得被当成横幅。
7. **渐变遮挡常画在 `::after` 上**，脚本改不了伪元素的样式。给宿主打 `data-overlay-killer-fade` 属性，
   一条全局样式 `[data-overlay-killer-fade]::before, ::after { display: none !important }` 统一藏掉。
8. **`position: fixed` 锁法要还原滚动位置。** body 钉住时 `top` 是负的滚动位置，解锁后 `scrollTo` 回去；
   用 `behavior: 'instant'`，否则 html 上有 `scroll-behavior: smooth` 时会动画滚过去（测试在 600ms 后才检查，
   去掉 `instant` 用例照样绿，所以这条「会慢慢滚」**未实测**，只是按规范写的保险）。
9. **测试里的 `__lockedAt` 一开始是 0**：fixture 自己在 `scroll-behavior: smooth` 下 `scrollTo(1200)`，
   读 `scrollY` 时动画还没走。fixture 也要用 `instant`。

## 已知限制

- CMP 规则表、站点规则表的选择器**未在真实站点实测**（见上）。
- 跨域 iframe 里的 CMP（Sourcepoint、TrustArc 的弹窗模式）按钮点不到，只能隐藏容器；`@noframes` 也不进 iframe。
- 点拒绝用的是 `.click()`（`isTrusted: false`），个别 CMP 如果校验事件来源会不认。**未实测。**
- closed shadow root 里的横幅看不到。
- Fullscreen API 那条判据（`document.fullscreenElement`）没有测试覆盖：无头浏览器里要先有用户手势，
  而用户手势本身就会触发「用户刚操作过」的保护，测不出这条单独生效。**未实测。**
- 「用户刚操作过」是时间判据：自动弹窗恰好在用户点了别的东西 1.5 秒内弹出，会被放过；
  SPA 里点链接换页后 1.5 秒内出现的登录墙也会被放过。可以用菜单「清理当前页」手动清。
- 遮罩用 `elementsFromPoint` 取点，`pointer-events: none` 的遮罩打不到（这种遮罩也挡不住点击，影响小）。
- 解锁只解 y 方向，只看 html / body。锁在别的滚动容器上（整页内容在一个 `overflow: auto` 的 div 里）的不管。
- 折叠展开只是改 CSS，内容本来就不在 DOM 里（要点按钮才去请求剩下的正文）的站展开不出来。
- 站点用定时器反复重新显示遮罩时，会和 `guard()` 来回拉锯（每 300ms 一次，被节流住，不会卡死）。
- `<html>` 上有 `overflow: hidden` + body 自己 `overflow: auto` 作为滚动容器的站点设计，如果同时有遮罩，
  解锁会把 html 改成 `overflow-y: auto`，可能出现双滚动条。**未实测。**

## 怎么跑测试

```bash
NODE_PATH=/path/to/node_modules node overlay-killer/test/run.cjs
```

`NODE_PATH` 指向任意一个装了 `playwright` 的 `node_modules`（本仓库不带依赖）。
测试用 `tools/userscript-harness.cjs` 在 Playwright 里加载脚本、模拟 GM_*；页面用 `page.route` 挂在假域名
`https://example.com/` 下（CSDN 规则挂在 `https://blog.csdn.net/`），路由用正则，fixtures 在 `test/fixtures/`，不访问外网。
每个用例新开一个 browser context，GM 存储互不影响。

覆盖：普通页面的固定顶栏（含「隐私政策」「下载 App」链接）和悬浮按钮不受影响；OneTrust 点拒绝不点接受 / 没有拒绝时隐藏；
Quantcast 按文字点 DISAGREE；Usercentrics shadow root；自建 Cookie 卡片点「仅必要」；只有「我知道了」时隐藏不点；
两种 App 引导条；通用遮罩 + 兄弟弹窗 + `overflow: hidden`（含真实滚轮）；`position: fixed; top: -1200px` 解锁后
`scrollY` 还原到 1200、`touch-action` 恢复；用户点击打开的模态框不处理（宽限期过后 DOM 再变也不处理）；
灯箱、网页全屏播放器不处理；两种折叠写法（兄弟渐变 / `::after` 渐变）展开、代码块和无按钮容器和「查看更多评论」不动；
CSDN 站点规则；遮罩隐藏后才加的滚动锁；站点用内联 style 重新显示遮罩；延迟 2 秒弹出（`page.clock`）；
本站停用（存储预置 / 菜单切换且不刷新撤回、刷新后保持、再启用立刻处理）；处理记录面板与撤销（不可撤销项跳过、
撤销后不再被处理）；手动清理忽略用户打开的保护。

harness 和真实 Tampermonkey 的差异，影响到的地方：

- GM 存储在 harness 里是页面的 localStorage，按源隔离；「本站停用」以 hostname 为键，测试只能在同一域名下验证，
  测不出跨站隔离。预置值用 `install(page, script, { values })`，只在该源第一次加载时写入。
- harness 没有沙箱，脚本直接跑在页面上下文；真实环境里 `isTrusted`、`elementsFromPoint` 在隔离 world 下的行为
  **未实测**（按规范应一致）。
- `page.clock.install()` 要在 `goto` 之前装；装上以后脚本的节流 `setTimeout`、`Date.now()` 都走假时钟，
  用 `page.clock.runFor()` 推进。
