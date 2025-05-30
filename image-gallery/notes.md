# image-gallery — 网页图片查看与批量下载

任意网页上按 **Alt+Shift+I**（或脚本菜单「打开图片画廊」），把页面里的图片收进一个全屏网格：
看尺寸、筛选排序、点开大图查看，勾选后批量下载。

## 功能

| 部分 | 做了什么 |
|---|---|
| 收集 | `<img>`（`srcset` / `<picture><source>` 里取分辨率最高的、懒加载属性、`currentSrc`）· 可见元素的 CSS `background-image` · 直接指向图片文件的 `<a href>` · open shadow DOM（可嵌套） |
| 去重 / 过滤 | 地址转绝对、去掉 `#hash` 后去重（query 保留）；宽或高 < 100 的、加载失败的不进画廊 |
| 画廊 | shadow DOM 浮层；缩略图 + 尺寸标签；勾选 / 全选 / 反选；「最小边」滑块；页面顺序 / 面积排序 |
| 查看器 | 滚轮以鼠标为中心缩放 · 拖拽平移 · `R` 顺时针 / `Shift+R` 逆时针旋转 · `←` `→` 切换（首尾循环）· 双击在适应窗口 / 原始尺寸间切换 · `0` 回到适应 · `Esc` 先退查看器、再按关画廊 |
| 下载 | `GM_download`，同时 3 个；文件名 `<站点>_<序号>.<扩展名>`；进度条；失败的列出来（带原因），可一键重试，文件名不变 |

## 实现要点

**一次遍历收齐三类来源**（`collect()`）。从 `document` 起用 TreeWalker 走所有元素，
碰到 `el.shadowRoot` 就把它排进队列接着走。每个元素顺手判断：是 `<img>` 就挑一张地址、
是 `<a>` 就看 href 的扩展名、再读一次 `getComputedStyle` 看背景图。

**一个 `<img>` 只取一张**，优先级：`<picture><source>` + `srcset`（含 `data-srcset`）里最大的 →
懒加载属性（`data-src` / `data-original` / `data-lazy-src` …，值是 `data:` 的跳过）→ `currentSrc` → `src`。
`w` 描述符一律压过 `x`。

**尺寸**：页面上已加载完的 `<img>` 直接读 `naturalWidth`；其余的用游离 `Image()` 预加载探测
（并发 8、单张 10 秒超时）。所以懒加载还没加载的真图也能拿到真实尺寸。

**扩展名**：`data:` 看 MIME → 路径最后一段（先切掉又拍云 `!thumb`、阿里云 `@100w` 这类处理后缀）→
query 里的 `format` / `fm` / `wx_fmt` / `ext` / `type` → 都没有时发 `HEAD` 读 `content-type`
（`GM_xmlhttpRequest`，所以要 `@connect *`）→ 兜底 `jpg`。`.php`、`.aspx` 这种不当扩展名用。

## 关键的坑

1. **srcset 不能按「逗号 + 空白」切。** 压缩过的 HTML 里逗号后面经常没有空格
   （`a.png 200w,b.png 900w`），那样整串会被当成一个候选，只拿到第一张小图。
   但也不能按逗号切 —— Cloudinary 的 URL 自带逗号（`c_fill,w_800`）。
   按规范来：URL 是一段不含空白的字符，**URL 末尾的**逗号才是分隔符，描述符读到下一个括号外的逗号为止。
   第一版就是按「逗号 + 空白」切的，边界测试测出来才改（见提交 `1879efb`）。

2. **`naturalWidth` 要核对 `currentSrc`。** 挑出来的是 srcset 里最大的那张，浏览器实际加载的可能是小的；
   这时 `<img>` 的 `naturalWidth` 是小图的尺寸。地址对不上就去探测，不能直接用。

3. **快捷键按 `e.code` 不按 `e.key`。** macOS 按住 Option 时 `e.key` 是 `ˆ` 之类的字符。

4. **浮层打开期间要截住所有按键，并且把焦点移进浮层。** 只截自己处理的键是不够的：
   网格模式下方向键、`j`/`k` 会漏给背后页面的轮播和快捷键；焦点还留在页面输入框里时，
   按键事件截住了，打的字照样进了被盖住的输入框（截事件不阻止默认行为）。
   现在是 window 捕获阶段 `stopImmediatePropagation` 全部 keydown/keyup/keypress，
   打开时 focus 浮层，关闭时把焦点还回去。

5. **背景图只对少数元素读布局。** 先读 `backgroundImage`（绝大多数是 `none`，直接跳过），
   确认有背景图后才 `checkVisibility()` + `getBoundingClientRect()` 判断可见。
   元素超过 8000 个就不再查背景图（`<img>` 和链接照常收）。这个上限是保守取的，没有在超大页面上测过耗时。

6. **失败列表里的链接不能 `rel="noreferrer"`。** 防盗链的图正是因为没带 Referer 才失败的，
   手动点开时要让它带上本页的 Referer。

## 已知限制

- **防盗链（Referer 敏感）的图床**：`GM_download` 由扩展发起请求，带不带页面的 Referer
  取决于 Tampermonkey 的下载模式，脚本控制不了；这类图（pixiv `i.pximg.net` 之类）很可能出现在失败列表里。
  替代办法：点失败列表里的链接在新标签页打开（会带 Referer）再手动保存，或在查看器里右键另存。
  ⚠️ 这一条是按机制推断的，没有在真实 Tampermonkey + 防盗链站点上验证过。
- Tampermonkey 设置里有「下载 → 文件扩展名白名单」，扩展名不在白名单里会被拒绝。脚本只会产出常见图片扩展名，
  默认白名单应当覆盖；若改过白名单，需要把 `webp` / `avif` 等加进去。（同样未真机验证）
- 页面里 `blob:` 地址的图大多下载不了（扩展的上下文里取不到页面的 blob）。
- closed shadow DOM、跨域 iframe（脚本带 `@noframes`，只在顶层页面运行）、CSS 伪元素（`::before` 的背景图）、
  `<canvas>` / `<video poster>` 都不收集。
- 背景图的 `image-set()` 里的每个地址都会被当成一张图收进来，不会只挑最高倍率的。
- 没写 width/height 的 SVG，Chromium 报 300×150（实测），所以 SVG 小图标会通过 100×100 的过滤。
- 加载失败（含探测超时）的图直接丢掉，不进画廊 —— 防盗链导致探测失败的图也会被丢掉。
- 只扫描打开那一刻的页面；无限滚动的页面加载了新图，关掉画廊再打开会重新扫描。

## 测试

```bash
NODE_PATH=/path/to/node_modules node image-gallery/test/run.cjs
```

`NODE_PATH` 指向任何一个装了 playwright 的 `node_modules`（本仓库不带依赖）。用的是 `tools/userscript-harness.cjs`。
**不访问外网**：页面和图片都用 `page.route` 模拟真实域名 ——

| 地址 | 返回 |
|---|---|
| `https://shop.example/<file>` | `test/fixtures/<file>` |
| `https://img.example/<W>x<H>/<任意>`（`shop.example` 下同样的路径也行） | 现场生成的 W×H 纯色 PNG（`test/png.cjs`） |
| 其他 `img.example` 路径 | 404（当坏图用） |

覆盖：入口（菜单 / 快捷键 / Esc）· `<img>` 收集（srcset、`<picture>`、懒加载、相对地址去重）·
背景图（可见性）· 链接 · 嵌套 shadow DOM · 小图 / 1×1 `data:` / 坏图过滤 · 网格数量与样式隔离 ·
勾选 / 全选 / 反选 / 滑块 / 排序 · 查看器（适应比例、滚轮锚点、拖拽、旋转、双击、切换循环、Esc 层级）·
下载（次数、文件名、并发峰值、各种扩展名推断、HEAD、失败与重试）· 按键隔离 · 重开重扫。

### harness 的限制，以及测试里怎么绕的

- **`GM_download` 模拟永远成功**（只会调 `onload`，没有 `onerror` / `ontimeout`）。
  测失败重试时把 `window.__gm.downloads` 换成一个 `push` 会抛错的数组，让 `GM_download` 同步抛异常；
  脚本把同步异常也当失败处理，所以能走到失败列表。真实环境的失败是走 `onerror` 回调，这条路径测试没覆盖。
- 没有沙箱：所有 `GM_*` 无论 `@grant` 写没写都可用，`@connect` 也不校验 —— 漏写 `@grant` 测试发现不了。
- 没传 `opts.xhr` 时 `GM_xmlhttpRequest` 会同步抛错（真实环境不会），脚本里已 try/catch 兜底。
- 查看器的状态（index / scale / rot / tx / ty / mode）写在 `.viewer` 的 `data-*` 上，下载进度写在 `.dl` 的 `data-*` 上
  （含同时下载数峰值 `data-peak`），测试读这些属性断言。
