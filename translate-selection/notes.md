# 划词翻译（translate-selection）开发笔记

## 做什么

任意网页上选中文字 → 选区末端旁浮出「译」图标 → 点一下弹出结果卡片。

- 触发：点图标（默认，不打扰正常选中）· 按住 Alt 选中直接翻译 · `Alt+T` 翻译当前选区（包括键盘选中的）
- input / textarea 里的选区也能用（密码框除外）
- 方向：选中的以中文为主 → 英文，否则 → 中文（`CONFIG.targetLang` / `chineseTarget`）
- 卡片：原文摘要、译文、单词时的词性释义、来源；复制 / 朗读 / 换目标语言重译；Esc、点外面、页面滚出 400px 关闭；下方放不下翻到上方；跟随系统暗色
- 菜单：图标模式开关 · 设置目标语言 · 在本站禁用 / 启用

## 实现

```
mouseup ──setTimeout 0──► readSelection() ──► Icon.show() ──click──► Card.open()
keydown(Alt+T) ─────────► readSelection() ─────────────────────────► Card.open()
                                                         translate(text, tl)
                                                           ├─ Cache（LRU 100 条，存 Promise）
                                                           └─ Google → 失败/超时 → MyMemory
```

- **UI** 全部挂在 `<translate-selection-host>` 的 shadow root 里（open 模式，方便测试定位），
  宿主挂在 `<html>` 下，用前检查 `isConnected`，SPA 换掉 body 也不丢。
- **坐标** 用文档坐标（含滚动），所以图标和卡片跟着页面走；滚出 `closeScrollDistance` 才关。
- **设置**：`CONFIG` 的任一项都能被 GM 存储里的 `settings` 覆盖，菜单改的也存那里，
  自动更新脚本不会冲掉。黑名单单独存 `blacklist`（主机名数组）。
- **缓存** 存的是 Promise：翻译还没回来又触发同一段，只发一次请求；失败的会被删掉。

### 接口

| | Google（主） | MyMemory（备） |
|---|---|---|
| 地址 | `translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=…&dt=t&dt=bd&q=…` | `api.mymemory.translated.net/get?q=…&langpair=autodetect\|…` |
| 返回 | 嵌套数组：`[0]` 分段译文 `[[译文, 原文, …], …]`，`[1]` 词典（仅单词/短语，否则 `null`），`[2]` 源语言 | `{ responseData: { translatedText, detectedLanguage }, responseStatus, quotaFinished, … }` |
| 长度 | 编码后超 1800 字符改 POST | 单次 500 字，先截断 |

测试里的模拟返回就是照实抓的 `hello` / `你好` / `run` / 两句中文 的结构构造的。

## 关键的坑

以下「实测」都是 2026-10-28 真的跑过的（curl 打真实接口，或 Playwright 里的 Chromium）。

1. **Google 接口 GET 的 q 太长直接 400。** 实测 4000 个汉字（编码后 3.6 万字符）→ HTTP 400；
   同一地址 POST 表单 `q=…`、其余参数留在 URL 上 → 200。所以长文本走 POST。

2. **MyMemory 出错时 HTTP 状态仍是 200。** 实测：`langpair=en|xx` 和超 500 字的请求都回 HTTP 200，
   body 里 `responseStatus` 是**字符串** `"403"`，错误信息塞在 `translatedText` 里
   （`QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS`）。只看 HTTP 状态或直接取
   `translatedText`，就会把错误信息当成译文显示。另外它不认 `auto`，要写 `autodetect`（实测可用）。

3. **输入框里的选区不能用 `window.getSelection()` 判断。** 实测 Chromium：选中 input 里的字后
   `toString()` 能返回文字，但 `isCollapsed === true`、Range 没有任何 rect；密码框的
   `toString()` 是 `•••••`。所以输入框单独走 `selectionStart/End`，位置用输入框本身，密码框跳过。

4. **三击选整段，`toString()` 末尾带 `"\n\n"`。** 实测。不去掉的话请求多了换行，缓存键也和拖选同一段
   对不上（测试先挂了才发现）。选区文本统一 `trim()`。

5. **按字符数判断「中文为主」会误判。** 「我们用 React 和 TypeScript 写前端」汉字 7 个、字母 15 个，
   按字符比会判成英文、再「译成中文」原样返回。改为汉字按字、拉丁/西里尔按词比较；
   有假名按日文（非中文）处理。

6. **截断不能切开代理对。** 截到半个 emoji 时 `encodeURIComponent` 抛 `URIError`，
   请求根本发不出去。`cut()` 遇到高位代理就少截一个。

7. **点图标不能清掉页面选区 / 让输入框失焦。** 图标的 `mousedown` 做了 `preventDefault()`，
   出图标时就把选区快照下来，点击时不再重读。测试验证了点完图标后页面选区和输入框的
   焦点、selectionStart/End 都还在（没做去掉 preventDefault 的反例实测）。

8. **mouseup 那一刻选区可能还没定**（在已有选区里单击时），所以读选区推迟一拍 `setTimeout(0)`。
   这条是按浏览器事件顺序推的，测试里的「点空白处图标消失」走的就是这条路径。

9. **快捷键按 `e.code` 匹配。** macOS 上 Option+T 的 `e.key` 是 `†`（推断自键盘布局，没在 mac 上测过）；
   命中时 `preventDefault()`，否则在输入框里会顺手打进一个字符。测试里验证了 textarea 内按 Alt+T 文本不变。

10. **朗读要自己挑 voice。** 不挑就用系统默认嗓音；`getVoices()` 在嗓音异步加载完之前会返回空数组
    （Web Speech API 的已知行为，这里没实测），空的时候只设 `utterance.lang` 交给浏览器。测试里要把 `SpeechSynthesisUtterance` 也换掉 ——
    真的 `utterance.voice` 只接受 `SpeechSynthesisVoice` 实例，赋假对象会抛 TypeError（实测）。

11. **超时自己计时。** 不只依赖 `GM_xmlhttpRequest` 的 `timeout/ontimeout`，各管理器支持不一；
    测试 harness 也不转发这两个字段，正好验证了自计时这条路。

## 已知限制

- Google 接口是网页版用的非官方接口，可能限流（429）或改格式；MyMemory 匿名调用有每日额度，用完后两个都失败就只能显示错误 + 重试。
- 降级到 MyMemory 时只译前 500 字（卡片会提示），且没有词典释义。
- 方向判断是启发式，只区分「中文 / 非中文」；繁体也算中文（→ 英文）。目标语言设成非中文时，中文也译成那门语言。
- Alt 拖选：部分 Linux 桌面 Alt+拖动是移动窗口，Windows 版 Firefox 松开 Alt 会激活菜单栏，Chrome 里 Alt+单击链接是下载 —— 这些都没在真实系统上测过。遇到了可把 `directModifier` 改成别的键或设为 `''`，改用快捷键。
- 输入框里的图标位置按输入框整体（横向跟鼠标、贴下沿），不是精确的字符位置。
- 菜单只在顶层窗口注册；iframe 里的脚本按 iframe 自己的域名查黑名单，且要刷新才生效。
- Canvas 渲染的编辑器（Google Docs 等）、浏览器内置 PDF 阅读器、跨域 iframe 里取不到选区。
- 缓存只在内存里，刷新页面就没了。

## 测试

```bash
NODE_PATH=/path/to/node_modules node translate-selection/test/run.cjs
```

`NODE_PATH` 指向任何一个装了 `playwright` 的 `node_modules`（本仓库不带依赖）。
用的是 `tools/userscript-harness.cjs`：本地起静态服务开 `test/fixtures/index.html`，
GM_* 在页面里模拟；**不访问外网**，翻译接口全由 `xhr` 回调按真实格式返回。

覆盖：选中出图标 · 点图标的请求 URL/参数与卡片译文 · 分段拼接 · 方向判断（中/英/日/中夹英/单词）·
词典释义 · 失败重试 · 降级 MyMemory（含超时、HTTP 200 里的错误）· 缓存命中与 LRU 淘汰 · 失败不进缓存 ·
超长截断与 POST · Esc / 滚动关闭 · 复制 · 朗读选 voice · 切换语言 · 贴底翻转 · 暗色 ·
Alt 直接翻译 · 快捷键 · input / textarea / 密码框 · 三个菜单项 · 黑名单 · 三击选段 · 乱序返回。

写测试时注意：

- 模拟拖选要先派发 `mousedown`（真实操作会先关掉已开的卡片），否则新图标会被旧卡片盖住、点不到。
- harness 没有沙箱，脚本跑在页面上下文，所以能在 `addInitScript` 里提前替换 `speechSynthesis`。
