# search-switcher 开发笔记

## 做什么

在搜索结果页放一条引擎切换栏，带着同一个关键词一键跳到别的引擎。

- 内置 14 个引擎，分三组：
  - 网页：百度 · Google · Bing · DuckDuckGo · 搜狗 · 360 · Yandex
  - 技术：GitHub · Stack Overflow
  - 视频社区：知乎 · B站 · 抖音 · 微信（搜狗微信）· 小红书
- 默认贴左侧竖排；菜单「切换布局」可换成顶部横条（存 GM，刷新后保持）
- 当前引擎高亮；按页面背景色自动亮 / 暗
- 链接是真正的 `<a href>`：中键 / Ctrl+点击开新标签、右键复制链接都是浏览器原生行为
- `Alt+1…9`、`Alt+0` 切到第 1…9、10 个引擎；焦点在输入框 / textarea / contenteditable 里时不响应
- 菜单「编辑引擎列表」：浮层里编辑 JSON（改名、改模板、调顺序、`"hidden": true` 隐藏、加自定义引擎），校验通过才保存；「恢复默认引擎」清掉自定义

## 怎么实现的

| 部分 | 做法 |
|---|---|
| 引擎表 `BUILTIN` | 每项：`url` 模板（`%s` 占位）、`hosts` + `path` 正则（结果页识别）、`params`（取词的参数名，按顺序）、`pathKey`（关键词在路径里，抖音）、`input`（搜索框选择器）、`group` |
| 取词 | hash 参数 → search 参数 → 路径 → 搜索框，取第一个非空的。含 U+FFFD 的当没取到 |
| 构造 URL | `template.replace(/%s/g, () => encodeURIComponent(wellFormed(kw)))` |
| 地址变化 | Navigation API `currententrychange` + `popstate` / `hashchange` + 1 秒轮询兜底；关键词变了重画，离开结果页收起 |
| UI | 宿主 div 挂在 `<html>` 下，open shadow root；样式走 `adoptedStyleSheets`，失败退回 `<style>` |
| 存储 | `GM_setValue('engines', { list, known })`、`GM_setValue('layout', 'side' \| 'top')` |

小红书只作跳转目标、不注入：网页版搜索要登录，未登录打开结果页是登录弹窗，结果页结构没法核实。
`search_result?keyword=` 这个地址格式是公开链接里常见的形式，登录后可用 —— **没有实测**。

## 关键的坑

带「实测」的是测试里真跑出来的；带「推断」的是按文档 / 机制推出来的，没有在真实 Tampermonkey 里验证。

1. **`String.replace` 的替换串会展开 `$&` / `$1` / `$$`**，而 `encodeURIComponent` 不转义 `$`。
   填模板必须传函数。（实测：往返测试里有 `$& $1 $$ 美元` 这一条）
2. **GBK 编码的老链接**（`wd=%C4%E3%BA%C3`）：`URLSearchParams` 不报错，静默解成一串 `�`。
   含 U+FFFD 就当没取到，退到搜索框。（实测）
3. **路径里的 `+` 是加号不是空格**。抖音的关键词在 `/search/<词>`，不能丢给 `URLSearchParams` 解，要 `decodeURIComponent`。（实测：`/search/C++%20教程` → `C++ 教程`）
4. **`host.hidden = true` 收不起来**：shadow 里的 `:host { all: initial }` 是作者样式，优先级高过 UA 的 `[hidden] { display: none }`。改用内联 `display: none !important`。
   （实测：Chromium 里带 `hidden` 属性的宿主，`getComputedStyle().display` 是 `inline`）
5. **不改写 `history.pushState`**（推断）：Tampermonkey 给有 `@grant` 的脚本用隔离的 JS 环境，在那里替换 `pushState` 拦不到页面自己的调用。改用两边都收得到的事件 + 轮询兜底。
6. **快捷键用 `e.code` 不用 `e.key`**（推断）：macOS 上 Option+1 的 `key` 是 `¡`。
7. **shadow DOM 里的焦点**：事件冒出 shadow 后 `e.target` 被重定向成宿主 div，判断「是否在打字」要看 `composedPath()[0]`。
8. **编辑浮层的键盘事件不能冒出 shadow DOM**。冒出去后页面的全局快捷键（「/」聚焦搜索框）认不出这是在打字，焦点被抢走。
   （实测：去掉 `stopPropagation` 后在编辑框里输入 `a/b/c`，只剩 `a`）
9. **严格 CSP 下 `<style>` 被拦**：`style-src` 不带 `'unsafe-inline'` 时，shadow 里的 `<style>` 一样不生效，栏退化成左上角一串裸链接。
   `adoptedStyleSheets` 不受 `style-src` 管。（实测：响应头 `style-src 'self'` 下，`<style>` 版 `position` 是 `static`，改后是 `fixed`）
10. **孤立代理项让 `encodeURIComponent` 抛 `URIError`**，栏渲染到一半变空。先 `toWellFormed()`。（实测）
11. **不用 `innerHTML`**（推断）：Google 等站开了 Trusted Types，给 `innerHTML` 赋字符串会抛错。
12. **存储要带 `known`**：只存用户的列表，分不清「用户删掉的内置引擎」和「保存时还没有的新内置引擎」。
    不在 `known` 里的内置引擎才自动追加。
13. **布局开关存 GM，不让用户改 `CONFIG`**：改脚本源码会被 `@updateURL` 自动更新覆盖。
14. **页面背景色而不是 `prefers-color-scheme`**：Google / Bing 的深色模式是站内开关，和系统偏好无关。

## 已知限制

- **只在 `@match` 的结果页上注入。** 从 GitHub 首页、B站首页这种不匹配的页面站内（SPA）跳到搜索页时，脚本没有运行，要刷新一次才出现。
- **各站搜索框的选择器没有在真实页面上核实**（测试只用模拟页）。URL 取词是主路径，搜索框只是兜底，选择器失效只影响「URL 里没词」的少数情况。
- 搜索框里改了词但还没提交时，切换栏用的仍是 URL 里的旧词。
- 不保留搜索类型：从 Google 图片 / 视频切过去，到的是对方的网页搜索。
- Google 只列了 11 个国家域名（`@match` 不支持通配顶级域名），别的域名要自己加 `@match`。
- 自定义引擎只是跳转目标：脚本管不到它的页面，在那里不会出现切换栏。
- Linux 上 Chrome / Firefox 的 Alt+1…8 是浏览器切标签的快捷键，可能被浏览器先拿走（没有实测）。冲突就把 `CONFIG.hotkeys` 关掉。
- 编辑浮层只拦了冒泡阶段的键盘事件；页面要是在捕获阶段监听全局快捷键，还是可能抢焦点。
- 抖音关键词里的 `/` 会编码成 `%2F` 放进路径，抖音那边能不能正确识别没有实测。
- 侧边栏可能挡住页面最左侧的一点内容（平时半透明，悬停时不透明）；顶部横条可能压住页头。

## 怎么跑测试

```bash
NODE_PATH=/path/to/node_modules node search-switcher/test/run.cjs
```

`NODE_PATH` 指向任何一个装了 `playwright` 的 `node_modules`（本仓库不带依赖，见 `tools/userscript-harness.cjs` 文件头）。

- 不访问外网：`context.route('**/*')` 拦下所有请求，文档请求按域名返回 `test/fixtures/` 里的模拟结果页（`baidu.html` / `google.html` / `generic.html`），其余一律 abort。
- 覆盖：13 个可注入引擎的特殊字符往返（中文、空格、`&`、`#`、`+`、`%`、`$&`、`/`），高亮、亮暗色、两种布局，Ctrl+点击开新标签，pushState / replaceState / hash / 后退，无 Navigation API 时的轮询，搜索框兜底（GBK、晚渲染），快捷键与输入框，编辑 / 校验 / 隐藏 / 恢复默认 / 刷新后生效，新内置引擎追加，严格 CSP、孤立代理项、被摘掉后挂回、iframe、打印。
- 改 `CONFIG` 的用例（顶部横条）用 `scriptWith()` 把脚本副本写到系统临时目录，不进仓库。

测试工具的两个差异，写用例时绕开了：

1. **harness 的 `opts.values` 每次导航都会补回「缺失的」初始值**（init script 每次加载都跑）。所以「删除存储后刷新」没法用 `values` 预置，改成 `page.evaluate` 直接写 `localStorage` 再刷新。
2. **Playwright 1.62 里，跨站打开的新标签被 `route.fulfill` 接管后一直停在 `about:blank`**（同站的、或 `route.continue` 的都正常；和 harness 无关）。Ctrl+点击的用例只断言「开了新页 + 新页请求的地址对 + 原页没动」，不等新页加载完。

另外，harness 的 GM 存储按源隔离（真实 Tampermonkey 是按脚本全局共享的），所以「在百度上改的列表在 Google 上也生效」这件事测不到，只测了同源刷新。
