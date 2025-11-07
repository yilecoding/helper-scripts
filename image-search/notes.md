# image-search —— 以图搜图

在任意网页的图片上 **按住 Alt 点右键**（或鼠标停在图片上按 **S**），在鼠标处弹出一个小菜单：
挑一个搜图引擎搜这张图，或者「全部打开」一次在后台标签里开所有启用的引擎；
下面还有复制图片地址、新标签打开原图、下载原图。
本地 / 内网 / canvas 这类搜图网站拿不到的图，自动改为把图片字节上传过去。

## 用法

| 操作 | 说明 |
|---|---|
| Alt + 右键图片 | 弹出菜单（页面屏蔽了右键也行） |
| 鼠标停在图片上按 S | 同上。焦点在输入框里、带修饰键、鼠标下面没有图时，按键原样交给页面 |
| Esc / 点菜单外面 / 滚动页面 | 关闭菜单 |
| 「改用上传」勾选框 | 图片要登录才能看时手动打开；不可公开的图自动勾上且锁定 |
| 脚本菜单「选择 / 排序搜图引擎」 | 一个 prompt：按顺序填要启用的引擎 id 或序号，没填的就是停用 |
| 脚本菜单「恢复默认引擎」/「在 xxx 上停用」 | 字面意思；停用按域名存 |

**为什么是 Alt + 右键，不是 Alt + 左键**：左键是页面的（点开灯箱、跟随链接），而 Chrome / Firefox 里
Alt + 左键点链接是「下载链接目标」—— 包在 `<a>` 里的图会被直接下载。右键本来就是浏览器的地盘，
加 Alt 在 Windows / macOS 上没有默认行为。部分 Linux 桌面把 Alt + 鼠标拖动绑给了窗口管理器
（没有逐个桌面实测），那种环境用 S 键。

## 实现

**找图**（`findImageAt`）。用 `elementsFromPoint` 从上往下逐层找，而不是只看事件 target。每一层：

- `<img>`：`<picture><source>` + `srcset`（含 `data-srcset`）里最大的 → 懒加载属性（`data-src` 等，值是 `data:` 的跳过）→ `currentSrc` → `src`
- `<canvas>`：`toDataURL('image/png')`；被跨域图污染的画布读不出来，菜单里直接说原因
- 其他元素：计算样式里 `background-image` 的第一个 `url()`；`<html>` / `<body>` 的背景不算
- 进 open shadow root 再找一遍；一层都没找到时按几何位置兜底（见坑 1）

地址转绝对、去掉 `#hash`（服务器收不到它）。

**三种搜法**：

| 搜法 | 什么时候 | 怎么做 |
|---|---|---|
| 按地址 | 公网图（默认） | 把图片地址 `encodeURIComponent` 进引擎的 URL 模板，`GM_openInTab` |
| 直接上传 | 不可公开 / 手动勾选，引擎有能拿到结果地址的上传接口（Google Lens） | 取图片字节 → 自己拼 `multipart/form-data`（Blob + 带 boundary 的 Content-Type）→ `GM_xmlhttpRequest` POST → 从 303 的 `Location`（或 `finalUrl`）拿结果页地址 |
| 接力上传 | 结果直接是 POST 返回的 HTML（SauceNAO、IQDB），或上传要页面脚本签名（百度） | 图片转 data: 地址暂存进 GM 存储 → 打开引擎页面 `#__image-search=<token>` → 本脚本在那个页面上把文件交给它的表单 |

**「不可公开」的判定**（`privateReason`）：`data:`、`blob:`、canvas、`localhost` / 没有点的主机名（`http://nas/`）/
`.local` `.lan` `.internal` 等后缀、私网 IPv4（10/8、172.16/12、192.168/16、127/8、169.254/16、100.64/10）、
IPv6 回环 / `fc00::/7` / `fe80::/10`。要登录 cookie 才能看的图从地址上看不出来，所以留了手动开关。

**取图片字节**（`getImageBlob`）：`data:` / canvas 就地解码；`blob:` 和同源图用页面的 `fetch`（带 cookie）；
跨域用 `GM_xmlhttpRequest`（带上本页 Referer 应付防盗链）。类型不是 `image/*` 时按文件头认格式，
认不出且是 HTML / 文本的报「可能需要先登录」。超过 20 MB 不传。

**设置**存 GM：`engines = { enabled: [...], known: [...] }`、`disabledHosts`、接力暂存 `relay:<token>`。
`known` 用来区分「用户关掉的」和「脚本新加的」引擎 —— 新加的按 `defaultOn` 追加，否则存过设置的用户永远看不到新引擎。

## 各引擎的地址格式与核实情况

2026-10-29 在本机（国内网络）核实。「无头浏览器」指 Playwright Chromium 直接打开真实站点。

| 引擎 | 按地址搜 | 核实 | 上传 | 核实 |
|---|---|---|---|---|
| Google Lens | `https://lens.google.com/uploadbyurl?url=<url>` | curl：303 → `www.google.com/search?vsrid=…&udm=26`（Lens 结果页）。无头浏览器跟过去被 Google 人机验证拦下，**结果内容没看到** | 直接上传：`POST https://lens.google.com/v3/upload?hl=…&re=df&st=<ms>&ep=gsbubb`，字段 `encoded_image` | curl 传一张 202×66 的 PNG → 303 到 `/search?…&udm=26&vsdim=202,66` ✔。在用户浏览器里打开这个结果页**未实测** |
| Bing | `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:<url>` | 无头浏览器：百度 logo 图 → 跳到 `www.bing.com/search?…FORM=SBIESR`，页面有「视觉匹配项」✔。换成 wikimedia 的图时回落成普通图片首页（怀疑 Bing 取不到那张图）。`cn.bing.com` 不认这个参数 | 无 | 上传接口没核实 |
| Yandex | `https://yandex.com/images/search?rpt=imageview&url=<url>` | curl 200；无头浏览器被 SmartCaptcha 拦下，**结果没看到** | 无 | 网上流传的 `POST ?rpt=imageview&format=json`（`upfile` 字段）实测返回「The service is under construction」页面，所以不做 |
| 百度识图 | `https://graph.baidu.com/pcpage/index?tpl_from=pc&queryImageUrl=<url>`，由脚本在识图页代填网址框 | 识图页**自己不读** `queryImageUrl`（无头浏览器停在首页；老入口 `image.baidu.com/n/pc_search?queryImageUrl=` 302 过来也一样）。用合成事件往「粘贴图片网址」框写值 + 回车 → 跳到 `/s?…` 结果页 ✔ | 接力：文件塞进页面的 `input.general-upload-file` 再派发 `change` | 无头浏览器实测跳到 `/s?…` ✔。自己拼 `POST /upload` 被拒（`status 1002 Params illegal` / `1 Reject`）—— 页面请求里带了一个现算的 `sdkParams` 签名 |
| 搜狗识图（默认停用） | `https://pic.sogou.com/ris?flag=1&drag=0&query=<url>` | 200，页面认这个参数，但两张测试图都显示「很抱歉没有找到相关图片结果」；首页已经找不到识图入口 | 无 | —— |
| SauceNAO | `https://saucenao.com/search.php?url=<url>` | **未实测**（本机连不上 saucenao.com），依据公开 API 文档 | 接力：在 saucenao.com 上造表单 `POST /search.php`，字段 `file` | **未实测** |
| TinEye | `https://tineye.com/search?url=<url>` | **未实测**（连不上） | 无 | —— |
| IQDB | `https://iqdb.org/?url=<url>` | **未实测**（连不上） | 接力：`POST /`，字段 `MAX_FILE_SIZE=8388608` + `file` | **未实测** |
| ascii2d | `https://ascii2d.net/search/url/<url>`（整个地址编码进路径） | **未实测**：首页 curl 200，这个地址 curl 和无头浏览器都吃 Cloudflare 质询（403） | 无 | 首页的上传表单 `POST /search/file` 要 `authenticity_token`；带令牌 curl 上传也被 Cloudflare 403，所以不做 |
| Trace.moe | `https://trace.moe/?url=<url>` | 无头浏览器 ✔：页面显示「Your search image」并发起搜索（测试图不是动画截图，结果为空） | 无 | 没核实 |

上传模式下没有上传能力的引擎在菜单里**置灰并把原因写在按钮上**，「全部打开」只数能用的。

## 关键的坑

1. **找图不能只看事件 target。** Instagram 式的透明壳盖在图上，target 永远是壳 —— 所以用 `elementsFromPoint` 逐层找。
   但它又有两个洞，都是写了测试才发现的（`68f6fcd`）：
   - **Flickr（老版）在照片上盖一张拉伸的 1×1 透明 gif**（spaceball），它在最上层，搜出来的是透明像素。
     现在跳过「挑出来的就是正在显示的那张、真实尺寸 ≤ 2×2」的 `<img>`。懒加载占位图另有 `data-src`，不受影响。
     副作用：测试夹具里原来用 1×1 的 `data:` 图当「内嵌图片」，被这条规则跳过了，改成了 8×6
   - **`pointer-events: none` 的元素不会出现在 `elementsFromPoint` 里**（防拖拽的站常给 `<img>` 加）。
     兜底：在最上面几层元素里按 `getBoundingClientRect` 找盖住鼠标的 `<img>` / `<canvas>`，到 `<body>` 为止
2. **contextmenu / keydown 都在 window 捕获阶段监听。** `document.oncontextmenu = () => false` 屏蔽右键的站、
   GitHub 的 S（聚焦搜索）这类单键快捷键，冒泡阶段轮到我们时页面已经处理过了。但只在鼠标下确实有图时才截，否则原样放行
3. **不是所有 keydown 都有 `key`。** `new Event('keydown')` 这类合成事件 `e.key` 是 `undefined`，
   直接 `.toLowerCase()` 会在每次这种事件上抛错（`68f6fcd` 修）
4. **图片地址里的 `#`**：浏览器规范化后，文件名里编码过的 `%23` 保持原样，真正的 `#hash` 要去掉；
   之后整个地址 `encodeURIComponent` 进模板。测试用一个同时带中文、空格、`&`、`%23`、中文 query、`#hash` 的地址，
   从每个引擎的 URL 里取回来必须一字不差，另外钉死了三个引擎的原始字符串（防「编码两次再解码两次」的对称错误）
5. **接力上传为什么不在原页面直接提交 `target=_blank` 的表单**：原页面的 CSP `form-action` 会拦（GitHub 这类站只允许提交到自己的域名）；
   而且字节要异步取，取完再提交时点击手势已经过期，新窗口会被弹窗拦截。改成在引擎自己的页面上同源提交就都绕开了。
   落地后先把 `#token` 从地址栏去掉，刷新 / 后退回来不会再提交一遍；百度按地址搜用 `sessionStorage` 记一下，同理
6. **百度识图要页面脚本签名**：上传请求里带一个现算的 `sdkParams`，自己拼请求会被拒。
   所以文件和网址都交给它的页面：网址框是 React 受控输入，要用 `HTMLInputElement.prototype` 上的原生 setter 写值再派发 `input`，
   直接 `input.value = …` 会被 React 的值缓存吃掉（这条是 React 的已知行为，本页面只验证了原生 setter 的写法能用）
7. **multipart 自己拼，不用 FormData**：各管理器把 FormData 转交给扩展后台的方式不一样；自己拼成一个 Blob、
   自己写带 boundary 的 Content-Type 最可控。文件名一律 `image.<扩展名>`，避开非 ASCII 文件名的编码问题
8. **对象存储常把图存成 `binary/octet-stream`**：第一版只放行 `image/*` 和 `application/octet-stream`，
   S3 风格的 `binary/octet-stream` 被当成「不是图片」拒掉了（`de650fb`）。现在类型不是 `image/*` 就按文件头认格式，
   认不出且是 HTML / 文本的才报错
9. **`overrideMimeType` 会连带改掉响应 Blob 的 `type`**（变成 `text/plain; charset=x-user-defined`）。
   为了兼容不认 `responseType` 的老管理器加了 x-user-defined，所以类型只认响应头。⚠️ 这条是按 XHR 规范推断的，
   harness 给不出 Blob 响应，没有测到
10. **Lens 的上传用 `redirect: 'manual'`**：不然管理器会替我们跟 303，在后台白白加载一遍结果页。
    不认这个选项的管理器照样跟，那时结果地址在 `finalUrl` 里，两种都接
11. **找到了图但用不了要说出来**：被污染的 canvas、取回来是登录页、引擎返回错误、接力暂存过期，
    都在菜单状态行（或引擎页顶部的红条）写明原因，菜单不关；不能当成「没找到图」静默放过

## 已知限制

- 要登录 cookie 的图从地址上看不出来，要手动勾「改用上传」
- 带 `@noframes`：iframe 里的图找不到（鼠标下拿到的是 `<iframe>` 元素本身）
- 不收：closed shadow DOM、CSS 伪元素的背景图、`<video>` 的画面和 poster、SVG 里的 `<image>`；`image-set()` 只取第一个地址
- `pointer-events: none` 的图如果直接挂在 `<body>` 下（中间没有包一层），兜底找不到它
- 接力上传依赖引擎页面的结构（百度的两个输入框 class），改版后会在 15 秒后在页面顶部提示「没找到…可能改版了」
- 接力暂存把整张图（data: 地址，约 1.33 倍体积）放进 GM 存储，10 分钟没人取就清掉
- `GM_xmlhttpRequest` 能不能真的带上 `Referer` 头取决于管理器，没有实测
- Lens 的结果页带 `gsessionid`，在用户浏览器里打开能否正常显示没有实测
- 表格里标「未实测」的几项（SauceNAO / TinEye / IQDB / ascii2d 的地址格式，SauceNAO / IQDB 的接力上传）只依据公开资料

## 测试

```bash
NODE_PATH=/path/to/node_modules node image-search/test/run.cjs
```

用 `tools/userscript-harness.cjs`。**不访问外网**：`page.route` 用正则匹配，先注册一条兜底把所有没模拟的请求 `abort` 掉 ——

| 地址 | 返回 |
|---|---|
| `https://site.example/<file>` | `test/fixtures/<file>` |
| `https://site.example/<W>x<H>/…`、`https://img.example/<W>x<H>/…` | 现场生成的 W×H 纯色 PNG（`test/png.cjs`） |
| `https://site.example/private/<W>x<H>/…` | 带 `session=ok` cookie 才给图，否则 200 一个登录页 |
| `http://192.168.1.20/…`、`http://nas/…`、`http://[fd00::12]/…` | 一张 PNG（只为页面上的 `<img>` 能显示；脚本取字节走模拟的 `GM_xmlhttpRequest`） |
| `https://saucenao.com/`、`https://iqdb.org/` | `fixtures/engine.html`；POST 记下请求体后返回假结果页 |
| `https://graph.baidu.com/pcpage/index…` | `fixtures/baidu.html`（300ms 后才渲染两个输入框，模仿 React） |

覆盖：触发与关闭（Alt + 右键 / 普通右键 / 页面屏蔽右键 / Esc / 点外面 / 滚动）· 悬停 S（页面快捷键收不到、输入框里、修饰键、没 key 的事件）·
复制 / 打开 / 下载（文件名、失败提示、`data:` 图）· 取地址（srcset 最大、压缩 srcset、`<picture>`、`data-src`、背景图、透明壳、
相对地址 + hash、shadow DOM、带逗号的 URL、透明垫片、`pointer-events: none`、body 底纹不算）· 各引擎 URL 编码 · 全部打开 ·
贴边翻转 · 不可公开的六种来源 · Lens 上传的 multipart 请求体（字段名、文件名、类型、逐字节比对）· 同源登录图 · 登录页 / 引擎报错 ·
接力上传两侧（暂存、共用 token、表单字段、百度文件 / 网址代填、过期提示、本站停用不影响、过期清理）· 脚本菜单。

### harness 的问题，以及测试里怎么绕的

- **`GM_xmlhttpRequest` 的 `data` 是 Blob 时传不回 node**：harness 经 `exposeFunction` 把 details 传出来，Blob 被序列化成 `{}`。
  测试里在页面上把 `window.__gmXhrBridge` 包一层，先把 Blob 读成字节数组再传（`hookXhrBodies`）
- **GM 存储按源隔离**（存在各自的 localStorage），真实 Tampermonkey 是脚本全局共享。接力上传跨两个站，
  所以「原页面存」和「引擎页面取」分开测：取的那一侧把暂存数据作为 `values` 初始值灌进引擎那个源
- **模拟响应的 `finalUrl` 永远等于请求地址**，`response` 永远是字符串：Lens 只测到了「从 `Location` 头取结果地址」这条路，
  取图片字节只测到了 x-user-defined 字符串这条路；`finalUrl` 和 Blob 响应两条路没测到
- 没有沙箱，`@grant` / `@connect` 写漏了测试发现不了
