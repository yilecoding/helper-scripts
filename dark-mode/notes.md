# 通用暗色模式（dark-mode）开发笔记

## 做什么

任意网站一键暗色，不依赖站点自己有没有暗色主题：

- 整页反色，再把图片、视频、画布、iframe、`<embed>`/`<object>`、svg 里的位图、带背景图的元素、
  只装着彩色 emoji 的元素反转回来，照片和视频保持原色
- `document-start` 注入，页面第一次绘制前就是暗的，不闪白
- 自动识别本来就是暗色的站点（量实际背景色 + `color-scheme` 声明），不做「暗上加暗」；
  量到的结果按站点记住，暗色站点再次打开时一开始就不反
- 全局三种模式：总是开（默认）/ 跟随系统 `prefers-color-scheme`（实时切换）/ 定时（默认 19:00–07:00，可跨午夜）
- 每个站点三态：跟随全局 / 强制开 / 强制关；`Alt+Shift+D` 切换本站
- 亮度、对比度、棕褐色可调（全局）
- 菜单：切换本站、本站恢复跟随全局、全局模式…、亮度 / 对比度 / 棕褐色…（后两个是 `prompt`）

`@match` 全站，`@noframes`：iframe 由外层整体反转回来，里面的页面保持原样（见「已知限制」）。

## 怎么实现的

| 模块 | 做法 |
|---|---|
| `Style` | 一个 `<style>`（`GM_addStyle`），`html { filter: invert(1) hue-rotate(180deg) [亮度 对比度 棕褐色] }` + 媒体元素再 `invert hue-rotate` 一次；开关靠 `<style media="not all">`，不往页面的 `<html>` 上加类名 |
| `Detect` | 关掉自己的样式，采样 body + 视口中线上三个点的元素，取「看起来」的背景色（透明就往上找，考虑 body 背景传播到画布），相对亮度 < 0.2 算暗；都透明时看 `color-scheme` |
| `Scanner` | 背景图元素和 emoji 元素：全量扫一遍计算样式打类名；`MutationObserver`（childList + style/class 属性）收集变动，200ms 节流后只扫变动的部分 |
| `decide()` | 站点强制开 > 站点强制关 > 全局模式 && 页面本来不是暗色 |
| `Menu` | 菜单文字带当前状态；每次 `apply()` 都会调，文字没变就不重注册 |
| `Store` | GM 存储：`settings`（模式、定时、色调）、`site:<hostname>`（auto 时删键）、`pageDark:<hostname>`（上次量到的结果） |

`hue-rotate(180deg)` 是为了让反色后的彩色「色相」回到原样（红还是红、蓝还是蓝，只是明暗反了）。
反两次 `invert + hue-rotate(180deg)` 推导上是恒等的（规范里的 hue-rotate(180°) 矩阵是 `2L − I`，L 是亮度投影，
平方为 I；invert 是 `1 − x`，两者组合两次抵消）。没算进中间结果被截到 0–1 的情况，高饱和色可能有偏差，未逐色实测。
整页的亮度 / 对比度 / 棕褐色是叠在外层的，反转回来的图片也会跟着变暗 —— 刻意不补偿。

识别的时机：`DOMContentLoaded` 量一次、`load` 再量一次（晚到的样式表），系统主题变化时再量一次
（声明了 `light dark` 的页面会跟着系统变）。

## 关键的坑

1. **filter 必须加在 `<html>` 上，不能加在 `<body>` 上。**（实测，有对照用例）
   除根元素外，带 `filter` 的元素会成为 `position: fixed` 后代的包含块。加在 body 上，
   滚动 1200px 后 `top: 0` 的固定栏 `getBoundingClientRect().top` 是 -1200（跟着页面滚走了）；
   加在 html 上仍是 0。顺带：仓库里 `article-toc/notes.md` 的已知限制写着「`<html>` 上有 filter 时 fixed 相对 html 定位」，
   至少在 Chromium 上对 filter 不成立。
2. **根背景透明时，正文下方的空白反转后还是白的。**（实测，像素测试）
   透明的根背景露出的是浏览器画布，画布不吃 html 的 filter。显式 `html { background-color: #fff }` 后，
   根背景跟着 filter 画，变成黑。只给 body 设背景时 body 背景会传播到画布、也会被反（实测），所以真正出问题的是
   html 和 body 都透明的页面 —— 恰恰是最朴素的那种页面。这条规则不加 `!important`，页面自己给 html 设了背景就用页面的。
3. **量背景色前要先关掉自己的样式。** 我们给 html 设了白底，开着量，所有页面的根背景都是白的。
   `Style.without()` 同步地关→量→开，中间不绘制，不会闪；代价是两次全页样式重算。
4. **短页面的采样点落在 `<html>` 上，而 body 的背景其实铺满了画布。**（实测，修之前两条用例失败）
   `body { background: #1e1e1e }`、内容只有两行时，视口中间那几个点 `elementFromPoint` 拿到的是 html，
   html 透明 → 当成「露出画布」→ 判成亮色。CSS 的背景传播规则：html 背景透明时，body 的背景画在整个画布上。
   所以一路透明到根时要再看一眼 body。
5. **`color-scheme: light dark` 只在页面自己没铺背景时才算数。** 很多站点声明它只是为了滚动条，
   自己却铺着白底；如果「声明了 dark + 系统是暗色」就算暗色站点，这些站就不反了。
   只有 html、body 和采样点都透明（真的露出画布）时才看 `color-scheme`：只声明 dark → 暗；
   声明 light dark → 跟系统。
6. **body 上的背景纹理图不能当成「背景图元素」反转回来。**（实测，修之前用例失败）
   老站常给 body 铺一张很淡的纹理，扫描时 body 也命中 `background-image: url()`，
   反转回来等于整页又翻成亮色。html、body 一律跳过。
7. **已经反转回来的元素里面的媒体不能再反。**（实测，修之前用例失败）背景图横幅里的 logo、
   卡片背景里的视频、背景图里套背景图：父元素反一次、自己再反一次，又成了底片。
   用 `:is(反转的) :is(反转的) { filter: none !important }`，特异性 (0,2,0) 高于逐个反转的规则，同为 `!important` 时它赢。
8. **`classList.add` 一个已有的类也会产生一条 attributes 变更记录。**（实测）扫描时无条件 add，
   观察者就会被自己触发、无限扫下去。只在状态真的要变时才改，扫完再 `takeRecords()` 丢掉自己造成的记录。
9. **节流不是防抖。** 一直在变的页面（轮播、计时器）上防抖永远等不到安静，背景图永远不处理。
   用「第一条变动起最多等 200ms」的节流（有用例：每 50ms 改一次 DOM，新元素仍在 600ms 内处理）。
10. **emoji 不能按 `Extended_Pictographic` 判断。** © ® ™ ↔ 都在里面，它们按文字颜色画，
    反转回来就成了暗底上的暗字。用 `Emoji_Presentation`（默认彩色显示的）或「字符 + U+FE0F」。
    只处理叶子元素、全是 emoji、≤ 32 个码元的；和文字混排的不管 —— 拆文本节点包 span，框架会当成脏 DOM。
11. **暗色站点反向闪一下。** document-start 时没有 DOM 可量，只能先按亮色站点反；暗色站点就先被反成亮色，
    DOM 就绪后才变回来。所以量到的结果按 hostname 记住，下次打开直接用（有用例）。第一次打开仍会闪一下。
12. **切换本站翻回来时存回 auto。** 如果「翻过去的结果」正好等于跟随全局的结果，存 auto 而不是强制值；
    否则按两下快捷键，本站就永远不再跟着定时 / 系统主题走了，而且用户看不出来。
13. **强制开压过「页面本来就暗」。** 用户强制开多半就是因为自动识别判错了，不能再被识别结果否决。
14. **定时模式用 30 秒轮询，不算好下一个整点 `setTimeout`。** 理由是电脑睡眠时长定时器会被拖后；未实测。
    切回标签页（`visibilitychange`）时也重新判断一次。

测试工具相关的坑：

- **`page.clock.install` 要在 `h.install` 之前调。** init script 按注册顺序执行，后装的话脚本已经拿到了
  真的 `setInterval`，只有 `Date` 是假的，`clock.runFor` 推不动定时检查（实测，第一次写用例就踩到）。
- 像素检查用 1×1 截图 + 页面里的离屏 canvas 解码：离屏 canvas 的像素不受页面 CSS filter 影响。

## 已知限制

- 反色是「算」出来的暗色，不是站点设计的暗色：品牌色、阴影、渐变都会变；彩色 svg 图标（logo）会被反色。
- 页面自己给图片设的 `filter`（灰度、hover 变亮之类）被 `!important` 的反转规则覆盖掉。
- 只扫有尺寸的背景图元素：`display: none` 的不打标，显示出来时如果是**它自己**的 style / class 变了会补上；
  如果是祖先的 class 变了让它显示（轮播、tab 切换），在下一次全量扫描（只有 `load` 时有一次）之前不会处理。
- 伪元素（`::before`/`::after`）上的背景图没有处理。
- 大面积的容器（不是 body）铺纹理背景图时会被整块反转回来，那块区域变成亮色。
- 和文字混排的彩色 emoji 是反色的（黄脸变蓝脸）。
- `@noframes`：iframe 里的页面保持原色（外层把 iframe 整个反转回来了）—— 嵌入的视频、地图是对的，
  嵌入的白底评论区就是白的。
- 识别结果按 hostname 记，同一个站里有暗色页面也有亮色页面时，换到另一类页面的第一屏会闪一下。
- 识别只在 DOMContentLoaded / load / 系统主题变化时做；SPA 后来自己切换成暗色主题不会被发现（可按 Alt+Shift+D 手动关）。
- 设置改了以后，其他已经打开的标签页要刷新才生效（没有用 `GM_addValueChangeListener`）。
- 未实测：真实 Tampermonkey 下 `GM_addStyle` 在 document-start 的挂载时机（测试只在 harness 里跑过）；
  浏览器滚动条颜色（大概率不跟着反）；全屏视频；Firefox / Safari；超大页面上整页 filter 的滚动性能；
  macOS 上 `Option+Shift+D` 的 `e.code`。

## 怎么跑测试

```bash
NODE_PATH=/path/to/node_modules node dark-mode/test/run.cjs
```

`NODE_PATH` 指向任意一个装了 `playwright` 的 `node_modules`（本仓库不带依赖）。
测试用 `tools/userscript-harness.cjs` 在 Playwright 里加载脚本、模拟 GM_*；
页面用 `page.route`（正则）挂在假域名 `https://example.com/...` 下，fixtures 在 `test/fixtures/`，不访问外网。

覆盖：html 的 filter 与媒体元素反转回来（读计算样式）、document-start 注入（页面 head 里第一段脚本读到的 filter）、
画面像素（白底变黑、正文下方空白也黑、背景图里的 logo 保持原色）、fixed 元素位置（含 body 上加 filter 的对照）、
色调参数与越界夹回、暗色站点识别（body 铺色 / SPA 容器铺色 / color-scheme 三种声明 / 系统主题实时切换）、
背景图元素（行内 / 样式表 / 渐变不算 / 零尺寸不算 / 动态插入 / 后改样式 / 去掉背景图 / 持续变动下的节流 / 不自激）、
三种全局模式（跟随系统实时切换、定时含跨午夜和跨边界自动切换）、站点强制开 / 关的优先级、
菜单与快捷键（刷新保持、翻回 auto）、prompt 设置、body 纹理图、嵌套反转、emoji、识别结果的记忆与纠正。

harness 和真实 Tampermonkey 的差异，影响到的地方：

- GM 存储在 harness 里是页面的 localStorage，只在同源内共享；「按 hostname 区分站点设置」只能通过
  键名验证（在 `www.example.com` 的存储里放 `site:example.com` 不生效），测不出真实的跨站共享。
- harness 的 `GM_addStyle` 在 `<html>` 还没出现时会等它出现再挂，和 Tampermonkey 的行为是否完全一致未实测。
