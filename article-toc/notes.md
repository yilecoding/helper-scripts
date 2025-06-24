# 文章自动目录（article-toc）开发笔记

## 做什么

在任意长文章页面右侧加一个浮动目录：

- 自动找正文，只收正文里的标题（侧栏、评论区、页脚、文内旁注、不可见的标题不算）
- 按页面**实际用到的**标题层级生成嵌套目录；少于 3 个标题不显示
- 滚动时高亮当前章节，当前项自动滚进目录的可视区
- 点击平滑跳转，标题停在顶部固定/吸顶导航栏下方
- 顶部阅读进度条（可关）
- 面板可折叠成小按钮、可拖动；位置和折叠状态按站点记住
- SPA 换页、正文异步加载后自动重建目录
- 菜单：显示/隐藏目录（本站）、开关进度条、开关伪标题识别（本站）

`@match` 是全站（`http://*/*`、`https://*/*`），`@noframes` 不进 iframe。

## 怎么实现的

| 模块 | 做法 |
|---|---|
| `Content` | 正文容器：先按选择器列表找（站点约定的正文类名 → `article` → `main`/`[role=main]` → `#content`/`.content`），每个选择器取「有效标题最多」的命中，够 3 个才算；都不够就按标题密度推断 —— 包含至少 60% 有效标题的祖先里最深的一个 |
| `buildTree` | 层级按出现过的 tag 排名归一化（只用 h2/h4 → 1/2 级），栈式建树；跳级时只深一层 |
| `Layout` | `topInset()` 算顶部被遮挡的高度；`scrollerOf()` 找正文所在的滚动容器；`scrollToEl()` 拿元素引用算距离自己滚 |
| `Panel` | shadow DOM（open），宿主挂在 `<html>` 下；位置存「距右、距顶」 |
| `Spy` | rAF 节流的 scroll 计算：阅读线以上的最后一个标题就是当前章节；同一帧里顺带算进度 |
| `Watcher` | 挂钩 `pushState`/`replaceState` + `popstate` + `MutationObserver`，防抖 400ms、最长等 2s 后重建 |
| `Store` | GM 存储。`site:<hostname>` 存位置/折叠/隐藏/伪标题开关，`settings` 存全局的进度条开关 |

### 为什么高亮用 scroll 计算而不是 IntersectionObserver

- 「当前章节」= 阅读线以上的最后一个标题。读到长章节中间时视口里一个标题都没有，
  IO 什么都不报，得自己记账推断方向和上一个标题；直接比 `getBoundingClientRect().top` 天然正确。
- 阅读线跟着顶栏高度走（顶栏会收起/展开），IO 的 `rootMargin` 建好就固定，要变只能重建。
- 成本可控：每帧最多算一次，只读不写，几百个标题也是 1ms 级。顶栏高度要读 computed style，缓存 500ms。
- scroll 监听挂在 `document` 的**捕获**阶段：内层容器的 scroll 事件不冒泡，但捕获能收到，
  不用先判断滚的是 window 还是哪个 div。

### 没有 id 的标题怎么跳

不给页面元素加 id（会和站点自己的 id 撞，框架重渲染时还可能被当成脏属性），
也不改 `location.hash`（hash 路由的站会直接切页，`replaceState` 还会触发站点自己的监听）。
目录项直接持有标题元素的引用，点击时算 `标题 top - 阅读线`，对滚动容器 `scrollBy`。
代价是目录项不能「复制链接」—— 本来也不是这个脚本的目标。

## 关键的坑

1. **吸顶栏在页面顶部时还没吸住。** 横幅 + `position: sticky; top: 0` 的导航栏，
   页面在顶部时导航栏在横幅下面，视口最上沿的点打不到它；只按 `elementsFromPoint` 找，
   跳下去以后标题正好被它盖住。所以 `topInset()` 还要扫浅层 DOM 里 `top` 很小的 sticky 元素，
   按它「吸住后」的位置（computed `top` + 高度）算。
2. **缓存的「过期」不能用 0 表示。** `performance.now()` 从导航开始计时，脚本跑起来时可能才过了
   两三百毫秒，`now - 0 < 500` 会被当成「刚算过」，阅读线一直是 0，高亮全部提前一节。用 `-Infinity`。
3. **平滑滚动途中高亮会一路闪过去。** 点击后锁住高亮，滚动停下 150ms 再解锁（最多 3 秒）。
4. **结尾几节太短，标题永远到不了阅读线。** 按常规规则它们永远不会高亮，点了也会在跳转停下后
   退回上一节。滚到底时改成：刚点过的那节还在视口里就高亮它，否则高亮视口里最后一个标题。
   页面根本滚不动时不算「到底」，否则一打开就高亮最后一节。
5. **`scrollIntoView` 会连带滚动页面。** 把当前项滚进目录列表时只改列表自己的 `scrollTop`。
6. **`<header>` 不能一律排除。** 站点头要排除，但文章标题常在 `<article><header>` 或
   `<main><header class="post-header">` 里。只排除不在 `article`/`main` 里的 `header`。
7. **类名排除按「词」匹配。** `post-comments`、`side-bar`、`widget-area` 要认出来，
   但不能子串匹配误伤别的类名。只看标题和正文根之间的祖先 —— 正文外层叫 `has-sidebar` 无所谓。
8. **只改 hash 的 `replaceState` 不算换页。** 文档站的滚动监听库边滚边 `replaceState('#小节')`，
   算进去的话每滚一下就重建一次。路由键只取 `pathname + search`。
9. **history 挂钩在沙箱里不一定生效。** 管理器把脚本放进隔离 world 时，改 `window.history`
   改的是沙箱那份；所以改的是 `unsafeWindow.history`，通知走 DOM 事件（跨 world 可见）。
   即便如此也可能改不动，`MutationObserver` 回调里每次都再比一次 URL 兜底。
10. **框架复用 `<h2>` 只换文字。** 换页时元素不增不减，只有文本节点变；所以观察
    `characterData`，变化发生在标题内部也触发重建。重建前比较「同一批元素 + 同样文字」，
    没变就不重绘，免得目录列表的滚动位置被重置。
11. **面板位置存「距右、距顶」，窗口缩放时从存下的位置重新落位。** 存 left 的话换窗口宽度
    面板就漂走；从当前位置重新夹的话，缩小一次再放大，面板就永久挪到了里面。
    拖到屏幕下方时列表最大高度跟着 top 收缩，否则底部几项伸出视口、滚不到。
12. **进度按正文容器算，不按整页。** 正文下面常挂着几屏评论和推荐，按整页算读完正文才走一半。

## 已知限制

- 高亮按文档顺序找「阅读线以上的最后一个标题」，多栏排版（标题的视觉顺序和 DOM 顺序不一致）时会不准。
- 看不到 iframe 里（`@noframes`）和 Web Components shadow DOM 里的正文标题。
- 虚拟滚动 / 懒渲染的正文：还没渲染出来的章节不在目录里，渲染出来后才会补进来。
- 吸顶栏只扫 DOM 前三层；更深的 sticky 顶栏只有在当前已经吸住时才能被发现。
- `<html>` 上有 `transform`/`filter`（某些暗色模式扩展会加）时，`position: fixed` 相对 `<html>` 定位，面板和进度条会跟着页面走。
- 伪标题识别是启发式（整段只有一个 `<strong>`/`<b>`、不以句号类标点结尾、≤ 40 字、不在引用/列表/表格里），默认关；会有漏判和误判。
- 目录项不能折叠子树；超长目录只能在列表里滚。
- 路由切换时如果正文 DOM 完全不变、history 挂钩又没生效，就发现不了换页（实际很少见）。

## 怎么跑测试

```bash
NODE_PATH=/path/to/node_modules node article-toc/test/run.cjs
```

`NODE_PATH` 指向任意一个装了 `playwright` 的 `node_modules`（本仓库不带依赖）。
测试用 `tools/userscript-harness.cjs` 在 Playwright 里加载脚本、模拟 GM_*；
页面全部用 `page.route` 挂在假域名 `https://blog.example.com/...` 下，fixtures 在 `test/fixtures/`，不访问外网。

覆盖：层级归一化与嵌套、跳级与空标题、侧栏/评论/页脚/旁注/不可见标题排除、密度推断、
少于 3 个不显示、点击跳转避开固定栏和未吸住的吸顶栏、滚动高亮、跳转途中不闪、
长目录当前项滚进可视区、折叠刷新保留、拖动位置记住与夹回视口、进度条、
SPA（pushState / popstate / 内容晚到 / 只改文字 / 只改 hash 不重建）、三个菜单、
结尾短章节、`<main><header>` 标题、内层滚动容器、面板拖到下方与窗口缩放。

harness 和真实 Tampermonkey 的差异，影响到的地方：

- GM 存储在 harness 里是页面的 localStorage，只在同源内共享；所以「按站点存」在测试里
  只能通过检查存储键名（`site:blog.example.com`）来验证，测不出跨站隔离。
- harness 没有沙箱，`unsafeWindow === window`，history 挂钩总是生效；
  「挂钩失效、只靠 MutationObserver 比对 URL」那条兜底路径没有被单独测到。
