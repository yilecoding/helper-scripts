# GitHub 增强（github-enhancer）开发笔记

## 做什么

只在 `https://github.com/*` 上运行（`@noframes`）：

- **仓库信息**：仓库首页 / 目录页 / 文件页显示仓库大小、默认分支、创建日期。
  数据来自 `api.github.com/repos/{owner}/{repo}`，按仓库缓存 1 小时（GM 存储）。
  限流时显示「几点几分恢复」，失败显示原因 + 重试，不会静默消失。
- **文件列表按钮**：每个文件一行「下载」（raw 文件，`GM_download`）；每个目录一行「检出命令」，
  复制只取这个目录的 `git clone --filter=blob:none --sparse … && git sparse-checkout set <目录>`。
  不依赖 download-directory 之类的第三方服务。
- **文件页按钮**：「复制 raw 链接」「复制永久链接」—— 永久链接把分支名换成当前提交 SHA，带上 `#L10-L20` 行号。
- **绝对时间**：每个「3 天前」（`<relative-time>`）后面加一个本地时区的 `（2024-03-05 14:07）`。
- **菜单**：四个功能各自开关（关掉立即收走已插入的元素）、设置 / 清除 GitHub token、清除缓存。

## 怎么实现的

| 模块 | 做法 |
|---|---|
| `Context.parse` | 只看 URL：`/owner/repo/{tree,blob,blame,edit,raw,commits}/<ref>/<path>`、`/commit/<sha>`（含 `.diff`/`.patch`）、`/pull/N/commits/<sha>`、`/releases/tag/<tag>`。第一段是保留名（`settings`、`orgs`、`notifications`…）或只有一段时不是仓库页 |
| `Context.resolve` | 把「第一段是 ref」的猜测落实成确定的 ref / path，顺带拿 SHA，见下面「ref 消歧」 |
| `Api` | `GM_xmlhttpRequest` 的 Promise 包装，自己计时超时；非 2xx 不 reject，把状态和响应头交给调用方判断是不是限流。同仓库并发请求合并 |
| `Store` | GM 存储：`settings`（开关）、`token`、`ratelimit`（`{ reset, authed }`）、`cache:repo:<owner>/<repo>`（`{ at, data }`） |
| `RepoInfo` / `FileRows` / `FileActions` / `AbsTime` | 每个功能一个 `apply(ctx, on)`，必须幂等：已经插过且仍然对得上就什么都不做 |
| `Nav` | `turbo:load` / `turbo:render` / `turbo:frame-load` / `pjax:end` / `popstate` / 挂钩的 `pushState`、`replaceState` / `MutationObserver`，全部防抖 150ms 汇成一次 `apply` |

### 选择器（新旧两套，找不到就跳过这一项）

| 用途 | React 版（2023 起，2026-10 对照真实页面） | 旧版（pjax 时代，按记忆复原，**未对照真实页面**） | 都没有时 |
|---|---|---|---|
| 仓库信息挂载点 | `#repo-title-component` 之后（只有仓库首页有） | `#repository-container-header` 末尾 | `#repo-content-turbo-frame` / `#repo-content-pjax-container` 最前面 |
| 文件列表的行 | `table[aria-labelledby="folders-and-files"]` 里的 `tr.react-directory-row` | `[role="grid"] [role="row"].js-navigation-item` | 不加按钮 |
| 行里的文件名链接 | 大屏单元格 `.react-directory-row-name-cell-large-screen .react-directory-filename-cell a` | `[role="rowheader"] a.js-navigation-open` | — |
| 文件页按钮挂载点 | `a[data-testid="raw-button"]` 所在的 `[data-component="ButtonGroup"]` 之后 | `a#raw-url` 所在的 `.BtnGroup` 之后 | 面包屑文件名（`[data-testid="breadcrumbs-filename"]` / `#blob-path`）之后；再没有就不加 |
| 分支按钮 | `button.ref-selector-class` 的 `aria-label`（「`<名字>` branch」/「`<名字>` tag」） | `#branch-select-menu [data-menu-button]` 的文字 | — |
| 面包屑仓库根 | `a[data-testid="breadcrumbs-repo-link"]` | `.js-repo-root a` | — |
| 永久链接 SHA | 嵌入数据 `refInfo.currentOid` | `a.js-permalink-shortcut`（快捷键 y） | API |
| 时间 | `relative-time[datetime]` | `time-ago[datetime]` | — |

每个功能在 `apply` 里单独 `try/catch`：某一项的选择器在新版页面上失效，只是这一项不出现，不会让整个脚本挂掉。

### ref 消歧（分支名带 `/`）

`/octo/demo/tree/feature/x/src` 本身有歧义：可能是 `feature` 分支下的 `x/src`，也可能是 `feature/x` 分支下的 `src`。
`Context.parse` 先按第一段猜，标 `exact: false`；`resolve` 依次尝试：

1. **整段 40 位 SHA**：不用消歧。
2. **嵌入数据**：`<react-app>` 里 `script[data-target="react-app.embeddedData"]` 的 `payload.*.refInfo`（`name` / `refType` / `currentOid`）。
   **只在 `<react-app initial-path>` 和当前地址一致时才信**（见坑 1）。
3. **分支按钮**的名字、**面包屑**仓库根链接里 `/tree/` 后面的整段。
4. **本次会话已知的 ref**：git 不允许 `feature` 和 `feature/x` 两个分支同时存在，所以一个已知分支只要按 `/` 分段对得上 refPath 的开头，就一定是它。同一分支下换目录不再查。
5. **API**：`git/matching-refs/heads/<第一段>`，挑按分段对得上的最长分支；分支里没有再查 `tags/<第一段>`。同一个「仓库 + 第一段」一次会话只查一次。
6. 都失败（限流、网络错误）：保留「第一段是 ref」的猜测，`source: 'guess'`。

候选名字一律要求是 refPath 的**分段前缀**才采用（`feature/xy/…` 不算以 `feature/x` 开头），这样页面上残留的旧分支名不会被误用。

消歧失败的影响面：raw 链接不受影响（ref 和 path 拼回去是同一个字符串，raw.githubusercontent.com 自己能解析带 `/` 的分支，
2026-10-29 用 curl 实测 `raw.githubusercontent.com/microsoft/vscode/release/1.100/README.md` → 200）；
受影响的是 sparse 命令的 `--branch` 和目录参数。

旧版仓库首页没有嵌入数据、URL 里也没有 ref：当前目录确定是根，就用「文件名」从行链接尾部倒推出 ref。

## 关键的坑

1. **嵌入数据只描述首次加载的那一页。** React 代码视图自己路由换目录 / 换文件时，那段 JSON 原样留在 DOM 里，
   内容（分支名、`currentOid`）还是老页面的。不看 `initial-path` 直接用，换页后永久链接会用上老页面的 SHA。
   （依据是 SSR 页面的结构：`initial-path` 属性写的就是服务端渲染时的地址；在真实浏览器里点着换页看 DOM **未实测**。）
2. **Turbo Drive 换页会把整个 `<body>` 换成新元素。** `MutationObserver` 挂在 `body` 上的话，第一次换页之后就再也收不到变化。
   观察的是 `document.documentElement`。
3. **事件触发时新内容还没渲染。** `turbo:load`、`pushState` 之后 React 才异步渲染新目录；所以除了事件还要靠
   `MutationObserver`，并且一律防抖后再注入。
4. **React 复用 DOM 只改属性。** 换目录时 `<tr>` 可能原地复用、只换链接；文件页的按钮组也可能复用。
   幂等判断不能只看「有没有插过」，要看「插的是不是这一行 / 这个文件的」：行按钮记 `data-href`，文件页按钮记上下文键，对不上就重建。
   `<relative-time>` 被复用时只改 `datetime` 属性、没有子节点变化，所以观察器还要 `attributeFilter: ['datetime']`。
5. **403 不等于限流。** 没权限、仓库被封也是 403。只有 `x-ratelimit-remaining: 0`（主限流，`x-ratelimit-reset` 是恢复时刻）
   或带 `retry-after`（次级限流，403/429）才算。限流记下来（`ratelimit`），到点前所有 API 调用直接返回限流，不再越撞越久；
   消歧用的 matching-refs 请求撞上限流也要记 —— 原来没记，仓库信息紧接着又撞一次。限流按「未认证 IP」和「token 用户」分别计，
   设置 / 清除 token 时清掉限流记录。
6. **文件页的嵌入数据里有整份源码**（`rawLines`），大文件好几 MB；`apply` 在每次 DOM 变化后都会跑（代码行虚拟滚动时 DOM 一直在变）。
   解析结果按 `<script>` 元素用 `WeakMap` 缓存，不然就是每 150ms 一次大 `JSON.parse`。
7. **旧版「跳过空目录」的折叠行**（`lib/core/util` 显示成一行），链接的 `title` 是一句说明文字，不是文件名；倒推 ref 时用链接文字。
8. **React 版文件列表每行有两个文件名单元格**（大屏 / 小屏，CSS 只显示一个）。链接和按钮都只取大屏那个，不然一行算两次。
   「..」上级目录行、子模块行（链到别的仓库）、「View all files」行都要排除：只认本仓库的 blob/tree 链接，且路径在当前目录下面。
9. **sparse 命令里 `--branch` 不接受 SHA。** ref 是 SHA 时改成 `--no-checkout` 克隆、设好 sparse 再 `git checkout <sha>`。
   路径和分支名按 POSIX shell 单引号转义。

## token 的安全含义

- 菜单「设置 GitHub token」用 `prompt` 输入，**明文**存在脚本管理器的 GM 存储里（不进页面的 localStorage，页面脚本读不到）。
- 只在两种请求里带上：`api.github.com`（仓库信息、消歧、查 SHA）和 `raw.githubusercontent.com`（`GM_download` 下载私有仓库文件）。
- 能读到它的：脚本管理器本身、管理器的导出 / 云同步备份、拿到这台机器浏览器配置目录的人。
  所以**建议用 fine-grained token，只给需要的仓库、只读权限（Contents: Read-only / Metadata: Read-only），设过期时间**；
  不要用带写权限的 classic token。
- 不设 token 时未认证限额是每小时 60 次（按 IP），设了是 5000 次（按用户）。

## 已知限制

- 旧版（pjax 时代）的选择器是按记忆复原的 fixture 测的，**未对照真实的旧页面**；GitHub 目前的页面都是 React 版。
- 2026-10 对照的是**未登录**的 SSR 输出；登录后页面结构是否有差异**未实测**。
- 插在 React 管理的节点里（`#repo-title-component` 旁边、按钮组旁边、文件列表行里）：如果脚本在 React hydration 之前插入，
  可能被 React 当成不匹配的节点丢掉或引发 hydration 警告。被丢掉时 `MutationObserver` 会再插回来；有没有 hydration 警告**未实测**。
- `GM_download` 跨域下载、带 `Authorization` 头下载私有仓库的 raw 文件：**未实测**（Tampermonkey 文档写了支持 `headers`）。
  管理器的下载模式设成「禁用」或扩展名不在白名单时会失败，此时退回 `<a download target=_blank>`，跨域时浏览器会直接打开 raw 页面而不是保存。
- 仓库信息的 `size` 是 GitHub 统计的仓库存储大小（含历史，KB），不是检出后的工作区大小。
- 文件列表的按钮只挂在大屏单元格里，窄屏（CSS 切到小屏单元格）时看不到。
- 永久链接用的是「点按钮时 ref 指向的提交」：如果打开页面后分支有了新提交，而 SHA 又是走 API 查的（React 内部换过页），
  链接指向的是新提交，不一定是页面上显示的那个版本。
- 短 SHA（`/blob/abc1234/…`）不认作 SHA，会走 matching-refs 消歧（查不到，退回猜测），永久链接再走 API 拿完整 SHA。
- 分支 `feature` 和 tag `feature/x` 同时存在这类极端情况下，「已知分支」规则可能选错。

## 怎么跑测试

```bash
NODE_PATH=/path/to/node_modules node github-enhancer/test/run.cjs
```

`NODE_PATH` 指向任意一个装了 `playwright` 的 `node_modules`（本仓库不带依赖）。不访问外网：

- `https://github.com/...` 的文档请求用 `context.route`（**正则**，glob 匹配不了带 query 的 URL）按 pathname 返回 `test/fixtures/` 里的页面，
  其余请求一律 abort。路由挂在 context 而不是 page 上：下载失败退回打开 raw 链接时开的新标签也要被拦住。
- `api.github.com` 走 `GM_xmlhttpRequest`，由 harness 的 `xhr` 选项模拟。
- 每个用例新开一个 context，GM 存储（harness 里是 localStorage）互不影响；时区固定 `Asia/Shanghai`，绝对时间才能断言。

fixtures：`repo-react.html`（仓库首页）、`tree-react.html`（`feature/x` 分支下的目录，含「..」和子模块行）、
`blob-react.html`（文件页）是按 2026-10-29 未登录抓到的真实页面精简的；`tree-legacy.html`、`blob-legacy.html` 是旧版结构；`plain.html` 是通用空页面。

上下文解析的断言靠脚本的调试日志：上下文一变就 `console.debug('[GitHub增强] 上下文', JSON)`，测试收集这些日志。

覆盖：URL 解析（root / tree / blob / `/tree/feature/x/path` / SHA / commit / `.diff` / PR 里的 commit / release tag / 非仓库页）、
五种消歧来源与回退、嵌入数据过期、仓库信息渲染与本地时区、缓存命中 / 过期、失败重试、主限流 / 次级限流 / 403 非限流、404 提示、
token 请求头与菜单设置 / 取消 / 清除、文件行按钮（raw URL 编码、sparse 命令、SHA 与转义、子模块 / 上级目录排除、下载失败兜底）、
文件页按钮（嵌入数据 SHA / permalink 快捷键 SHA / API SHA、行号 hash、失败提示）、绝对时间（跨日、动态插入、属性变化、开关）、
菜单开关与清除缓存、Turbo 反复触发事件与整个 body 替换后不重复注入、三个边界问题的回归。

harness 和真实 Tampermonkey 的差异，影响到的地方：

- harness 的 `GM_download` 只记录 `url` 和 `name`，不记录 `headers`，所以「下载时带 token」没有被断言到。
- harness 没有沙箱，`unsafeWindow === window`，history 挂钩总是生效；「挂钩失效只靠 turbo 事件 / DOM 变化」的路径
  只在 Turbo 换 body 的用例里（用 `History.prototype.pushState` 绕开挂钩）间接测到。
- `GM_setClipboard` 只记录最后一次的值，没有真的写系统剪贴板。
