# scroll-memory —— 阅读位置记忆

长文、小说、文档读到一半关掉，回来时回到上次读到的地方。

## 做什么

- 滚动停下 600ms 后记下位置；关标签 / 跳走 / 切到后台时立即补记最后一次滚动。
  只在页面总长 **> 2 屏**、且滚过 **> 1 屏**时记录。
- 再次打开同一页：等内容稳定后，底部浮出「**跳回上次位置（xx%）· 取消**」，点了才跳；
  菜单里可改成直接跳。12 秒没人理自己收起。
- 用户在恢复前已经自己滚了（滚轮 / 触摸 / 翻页键 / 拖滚动条）就不打扰。
- 正文在内层 `div` 里滚动的站（后台、文档站）、`html` 不滚 `body` 滚的站、SPA 换页都支持。
- 右下角回到顶部 / 底部按钮（滚过半屏才出现），中间显示阅读进度百分比。
- 读到底（> 95%）删除记录；记录 30 天没访问过期；总数超过 300 条从最久没访问的删起。
- 菜单：清除本页记忆、在本站停用 / 启用（停用时连本站已有记录一起删）、恢复方式（先提示 / 直接跳回）、清除全部记忆。

`@match` 是全站，`@noframes` 不进 iframe，`@run-at document-end`。

## 存了什么

GM 存储，不出本机、不发网络请求。一页一个键 `sm:p:<页面键>`，设置在 `sm:settings`。

```
{ t, p, y, h, c, a: { path, tag, fp, i, off, eh } }
```

| 字段 | 含义 |
|---|---|
| 页面键 | `origin + pathname` + 白名单里的 query（排序后）+ hash 路由（`#/…`、`#!/…`）。普通的 `#第三节` 不算 |
| `t` | 最后记录 / 回访的时间（过期和 LRU 都看它） |
| `p` / `y` / `h` | 进度（0~1）、当时的 scrollTop、当时的滚动高度 |
| `c` | 内层滚动容器的选择器路径；`null` = window；`'body'` = body 自己滚 |
| `a.path` | 锚点元素的选择器路径：从最近的**稳定 id** 祖先（`#post > div:nth-of-type(1) > p:nth-of-type(30)`）或滚动容器（`:scope > …`）起算 |
| `a.tag` / `a.fp` / `a.i` | 标签、文本指纹（压空白后的前 40 字；没字的用图片文件名）、同标签序号 |
| `a.off` / `a.eh` | 视口上沿在元素里的偏移（px，负数表示元素在视口上沿下方）、元素当时的高度 |

query 白名单（`CONFIG.queryWhitelist`）：`page p pn id tid aid cid bid chapter chapterid article doc v`。
不在白名单里的参数（`utm_*`、`from`、`spm`…）一律不参与。

## 怎么实现的

| 模块 | 做法 |
|---|---|
| `makeScroller` | window / body / 内层 div 统一成 `top / setTop / view / height / max / rect / root` |
| `findScroller` | 开局猜：从视口中间 5 个点往上找第一个「够大（≥ 40% 视口高、≥ 30% 视口宽）且能滚」的元素，和 window 比可滚距离。之后用户真正滚的是哪个，`adoptScroller` 就改成哪个；侧栏、代码块的滚动不算 |
| `captureAnchor` | 在视口上沿往下 8/40/80/140/220/320px、横向 50%/35%/65% 处 `elementFromPoint`，跳过 fixed / sticky（吸顶栏）和自己的 UI；打到段落间隙拿到的是大容器 → 往下钻到跨过这条线的子元素；打到 `<em>` 等行内元素 → 往上爬到所在的块。取第一个有指纹的 |
| `locate` | 依次尝试：路径命中**且指纹一致** → 按指纹在同标签元素里找、取序号离记录时最近的 → 进度百分比。视口上沿原本在元素内部时，偏移按元素新高度等比换算（字号变了照样落在同一行附近） |
| `waitStable` | 每 100ms 看一次滚动高度，连续 500ms 不变（或等满 5 秒）再恢复；容器路径每次重新解析（SPA 的容器可能还没渲染） |
| `follow` | 跳回去之后 3 秒内每 150ms 重新定位一次锚点，偏了就纠正；用户一动就停 |
| `onRoute` | 挂钩 `pushState` / `replaceState`（改 `unsafeWindow.history`）+ `popstate` / `hashchange` + 滚动时比 URL 兜底 |
| `UI` | 一个 shadow DOM（open）宿主 `<scroll-memory-ui>` 挂在 `<html>` 下，内联 `!important` 定位；提示条和按钮都在里面 |

### 和浏览器的 `history.scrollRestoration` 怎么分工

脚本**不改** `scrollRestoration`，保持浏览器默认的 `auto`，按 `performance.getEntriesByType('navigation')[0].type` 分：

| 这次加载 | 谁负责 |
|---|---|
| `back_forward`（整页前进 / 后退） | **浏览器**。同一会话里它记着像素位置；bfcache 命中时脚本根本不重跑。脚本什么都不做 |
| SPA 里的 `popstate` | **浏览器 / 路由**（React Router 的 `ScrollRestoration`、Vue Router 的 `savedPosition`）。有 Navigation API 时按 `navigationType === 'traverse'` 判定 |
| `reload` | 浏览器先按像素还原，**脚本接着按锚点静默校准**（不弹提示） |
| `navigate`（新打开 / 从别处点进来） | **脚本**：提示或直接跳 |
| 带 `#锚点` 打开、或脚本跑起来时页面已不在顶部 | 不恢复：用户要看的是那一节 / 已经自己滚了 |

## 关键的坑（标了「实测」的是在 Playwright Chromium 里跑出来的）

1. **整页刷新：浏览器还原的像素会被夹小，再被推开（实测）。** 内容还没加载完时 `scrollHeight` 不够，
   刷新后浏览器还原出的 scrollY 被夹到当时的最大值（3000 → 2605）；之后广告插在上方，
   Chrome 的 scroll anchoring 又把它往下推（→ 3655）。离目标六百多像素，按「离得近才算浏览器已还原」的规则
   会多弹一次提示。现在刷新一律静默按锚点校准。
2. **Chrome 的 scroll anchoring 会改 scrollY（实测）。** 用户滚了 300px 后上方插入 700px 广告，scrollY 变成 1150。
   测「用户先滚了就不打扰」时不能断言 `scrollY <= 300`，要看内容有没有被拉到上次的位置。
   反过来，跳回去之后再插内容，Chromium 会自己补偿；但 Safari 没有这个机制、也有站点写了 `overflow-anchor: none`
   —— 所以有 `follow`（测试里用 `overflow-anchor: none` 模拟，实测不加 follow 会偏 930px）。
3. **`html { overflow: hidden } body { height: 100%; overflow: auto }`（实测）。** 这时 body 是自己的滚动容器、
   `window.scrollY` 永远是 0，scroll 事件的 target 是 `body`。只认 window 的话一条都记不下来。
   判别：只有 html 的 overflow **不是** visible 时，body 才是自己的滚动容器（否则 body 的 overflow 会传播给视口）。
4. **`#100%` 让 `decodeURIComponent` 抛 URIError（实测）。** Chromium 的 `location.hash` 原样给出 `#100%`，
   解码一抛，整个恢复跟着挂掉。解码失败就用原样。
5. **SPA 换页那一刻 DOM 可能已经换成新页（实测）。** 有的路由先换视图、后 `pushState`。换页时再算锚点就算到
   空的新页上了。所以滚动中每 150ms 拍一张带页面键的快照，换页时写的是这张；测试里把「直接 `record()`」换回去，
   旧页的记录直接丢了。
6. **LRU 会把正在打开的页挤掉（实测）。** 启动时先清理再恢复：这页恰好是最久没访问的那条，就在恢复前被删了。
   清理时把当前页的时间当成「现在」。
7. **后台标签页（模拟实测）。** 中键打开的标签在后台时，提示条 12 秒后自己收起 —— 用户切过来时什么都没有。
   现在切到前台才开始等内容稳定。测试是改写 `document.visibilityState` + `page.clock` 模拟的；
   真实后台标签的定时器节流（1 秒一次、5 分钟后更慢）**未实测**。
8. **Playwright 的 Chromium 后退没命中 bfcache（实测）。** 脚本重跑，导航类型是 `back_forward`。
   真实浏览器多半命中 bfcache，那时脚本不重跑、自然也不打扰。
9. **区分「用户在滚」靠输入事件，不靠 scroll 事件。** scroll 事件分不出是用户、浏览器还原、还是内容撑开。
   看 `wheel` / `touchmove` / 翻页键（输入框里的不算）/ 按在滚动条上的 `mousedown`（target 是滚动容器本身）。
   测试只覆盖了滚轮；触摸和拖滚动条**未实测**。
10. **等待恢复期间的 scroll 不记。** 否则浏览器还原、内容撑开触发的滚动会把要恢复的那条记录先覆盖掉。
11. **随机 id 不能当路径起点。** `:r1:`、`mui-38291`、uuid、nanoid 每次渲染都变，认出来就继续往上找稳定的。

## 已知限制

- 不进 iframe（`@noframes`）；正文在 shadow DOM 里的页面（`elementFromPoint` 只打到宿主）**未实测**，大概率只能按百分比恢复。
- 虚拟列表 / 无限滚动：锚点元素不在 DOM 里时退到百分比，而内容没加载全时的百分比不准；目标超出当前可滚范围会被夹住。**未实测**真实站点。
- canvas 渲染的阅读器（部分在线文档、网盘预览）没有可用的 DOM 锚点，只能按百分比。**未实测**。
- 「读到底」看的是整页进度：正文下面有很长的评论区时，读完正文也到不了 95%，记录不会删，下次还会提示。
  反过来，点「到底部」按钮也会把记录删掉。
- query 白名单是全局的。用别的参数名分页的站（`?chapter_id=`、`?n=`）几页会共用一条记录，要自己改 `CONFIG.queryWhitelist`。
- 没有 Navigation API 的浏览器里，点 `<a href="#/xxx">` 的 hash 路由换页会被当成前进 / 后退而不恢复（按「popstate 也会因页内跳转触发」推断，Firefox / Safari **未实测**）。
- 文本指纹是前 40 字：大量开头相同的段落（对话体小说的 `“……”`）靠序号就近区分，改版后可能落到相邻一段。
- 同一页开在两个标签里，后滚动的那个覆盖记录。
- 恢复最多等 5 秒；更慢的页面会在内容没齐时就恢复（`follow` 只再盯 3 秒）。

## 怎么跑测试

```bash
NODE_PATH=<装了 playwright 的 node_modules> node scroll-memory/test/run.cjs
```

用 `tools/userscript-harness.cjs` 在 Playwright 里加载脚本、模拟 `GM_*`（存储在同源 localStorage，刷新能读回；
真实环境是脚本全局共享）。页面用 `page.route(/^https:\/\/novel\.example\.com\//)` 挂在假域名上（**用正则**：
glob 的 `**` 对带 query 的 URL 不可靠），**不访问外网**。全套约 70 秒。

| fixture | 场景 |
|---|---|
| `long.html` | 80 段长文（段落文字、高度各不相同）。参数（都不在白名单里，页面键不变）：`drift=px&delay=ms` 晚到的广告 + 3 段公告插到正文最前（像素和 `nth-of-type` 一起漂）、`font=px` 改字号、`rewrite=1` 改版（指纹全失效）、`noanchor=1` 关掉 scroll anchoring |
| `fixed-header.html` | 同上，顶栏 `position: fixed` 盖住视口上沿 90px |
| `short.html` | 不到两屏 |
| `inner.html` | `html, body { overflow: hidden }`，正文在内层 div 里滚、异步渲染；旁边还有个能滚的窄侧栏 |
| `body-scroll.html` | `html { overflow: hidden }`，body 自己是滚动容器 |
| `spa.html` | 极简 SPA：pushState 后异步渲染、换页滚回顶部；一个链接先换视图后 pushState；带 utm 的链接；hash 路由链接 |
