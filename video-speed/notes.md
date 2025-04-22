# video-speed 开发笔记

通用视频倍速控制：任意网站的 HTML5 `<video>` / `<audio>` 用快捷键调速，站点把速度重置回 1 时自动恢复，按站点记住倍速。

## 快捷键（`CONFIG.keys` 里改）

| 键 | 作用 |
|---|---|
| `X` / `Z` | 加速 / 减速一档（0.25），钳在 0.1–16 |
| `R` | 恢复 1.0 |
| `G` | 切到常用倍速（`CONFIG.preferredRate`，默认 2.0），再按切回之前的速度 |
| `E` / `Q` | 快进 / 快退 `CONFIG.seekSeconds`（默认 5）秒 |

按住 Shift / Ctrl / Alt / Meta 时一律不响应；焦点在输入框、textarea、select、contenteditable 里时不响应。

Tampermonkey 菜单：「清除本站记忆的倍速（hostname）」「记忆倍速：已开启 / 已关闭」。

## 实现

### 键盘

- **用 `e.code`（物理键位），不用 `e.key`。** `e.key` 随布局和输入法变：俄语布局按 X 得到 `ч`，中文输入法激活时是 `Process`。代价是 AZERTY 用户按的是「同一位置」的键（`KeyZ` 在 AZERTY 上印的是 W）。
- **`window` 的捕获阶段 + `@run-at document-start`。** 事件流里最早的一站，页面在 document 上 `stopPropagation` 也拦不住我们；document-start 保证我们比页面先注册。
- 处理掉的键 `preventDefault` + `stopImmediatePropagation`，**对应的 keyup / keypress 也吞**（有的播放器在 keyup 上响应）。页面上没有媒体时一个键都不拦。
- 「是否在打字」看 `e.composedPath()[0]`，不看 `e.target`：输入框在 shadow DOM 里时，`window` 上拿到的 `target` 已被重定向成 shadow host。测试里把它换回 `e.target`，shadow 输入框那条用例立刻失败。
- 默认键避开常见播放器已占用的：YouTube 的 K J L F M C I T N P、数字、`<` `>`；B 站的 D（弹幕）、F、M、`[` `]`。
- `G` / `R` 忽略按住连发（`e.repeat`），加减速、快进快退允许连发。

### 「当前视频」

排序：**正在播放 > 最近交互过 > 视口里露出面积最大**。屏外的、`display:none` / `visibility:hidden` / `opacity:0` 的、既不在播也没点过的不参与。

- 「交互过」按 `pointerdown` 的坐标落在哪个媒体的矩形里判定，不看事件路径——播放器的控制层盖在 `<video>` 上面，点击路径里根本没有 `<video>`。
- 用快捷键操作过的也记为交互过，连续按键时不会因为布局变化中途换对象。

### 发现媒体

- 深度收集穿进 **open shadow root**（`document.querySelectorAll` 不穿）。
- `MutationObserver` 盯 document，**每发现一个 shadow root 也单独 observe 它**（MutationObserver 看不进 shadow root）。
- 按快捷键时再全量扫一遍兜底。

### 保持倍速

`Speed = { desired, active }`：倍速是整页的；按键立即作用于当前视频，其它媒体在下次加载 / 开播时跟上。`active` 为 false（这一页没调过速、也没有记忆）时完全不碰媒体，站点自己设的倍速不归我们管。

站点改回 1 的几条路和对应的钩子：

| 站点的做法 | 钩子 |
|---|---|
| 播放器逻辑直接写 `playbackRate = 1` | `ratechange` |
| 换集：同一个元素换 `src` | 加载算法把 `playbackRate` 重置为 `defaultPlaybackRate` → 我们把 `defaultPlaybackRate` 也设上，并在 `loadedmetadata` 补一次 |
| 换集：整个 `<video>` 换新的 | `MutationObserver` 发现新元素，开播前就套上 |
| 广告结束、`play()` 时重设 | `play` / `playing` |

**区分站点重置和用户在播放器菜单里主动改：** 改动前 `userChangeWindowMs`（1 秒）内有用户手势（`pointerdown` / `pointerup` / `click` / 非本脚本的 `keydown`）的算用户改的，跟着改并记住；否则算站点重置，拉回来。

但「点下一集」也是手势，播放器常顺手把速度设回 1。所以有手势时等 100ms，期间这个元素发生过 `loadstart` 的仍按站点重置处理。测试里让新集的元数据晚到 600ms，去掉这个判断用例就失败（速度被当成用户选的 1.0）。

**拉锯让步：** 有的站点（培训 / 考试类）每次 `ratechange` 都改回 1。2 秒内被重置超过 5 次就对这个元素停止自动恢复，OSD 提示「本站锁定了倍速」；用户再按快捷键时解除、重新尝试。

### OSD

- 挂在 `popover="manual"` 的元素上，每次显示先 `hidePopover()` 再 `showPopover()`，进 **top layer** 并排到全屏元素之上。
- 样式全部走 CSSOM（`element.style`），不插 `<style>`：站点 CSP 的 `style-src` 拦得住 `<style>`，拦不住 CSSOM 赋值。
- 不支持 popover 的浏览器退回挂进全屏容器（全屏的是 `<video>` 本身时无解）。

### 按站点记忆

- GM 存储一个对象 `rates = { hostname: rate }`，1.0 不存（调回 1.0 时删掉本站条目）；`remember`（默认 true）是开关。
- document-start 时就读出来设好 `Speed`，后面发现的媒体一出现就是记住的速度。
- `file://` 页面 hostname 是空串，退到 `file:`。

### iframe

没写 `@noframes`，Tampermonkey 默认在每个 frame 里各跑一份脚本，**各 frame 各管各的**：

- 键盘事件只发给有焦点的 frame。要控制 iframe 里的视频，先点一下那个视频（让 iframe 拿到焦点）再按键；顶层页面的按键管不到 iframe 里的视频，反之亦然。
- 记忆按 frame 自己的 hostname 存：嵌在 A 站里的 B 站播放器，记的是 B 站的倍速。同 hostname 的 frame 共用一条记忆，后写的覆盖先写的。
- 菜单只在顶层注册（否则菜单里会出现好几条同名命令），所以 **iframe 所在站点的记忆没法从菜单清除**——直接打开那个站点再清，或在 Tampermonkey 的存储里删。

## 关键的坑（都在测试里实测过）

1. **全屏时 OSD 被盖住。** 全屏元素在 top layer，挂在 body 上的提示 z-index 再大也压不过；全屏的是播放器容器还是 `<video>` 本身都一样。截图可见：修之前全屏画面里没有提示，改用 popover 后有。
2. **`elementFromPoint` 判断不了 popover 是否盖在全屏元素之上。** 提示已经画在全屏视频上面（截图可见），它仍然返回 `<video>`。全屏用例改成截取 OSD 区域数白色像素。
3. **换 `src` 时 Chrome 会把 `playbackRate` 重置为 `defaultPlaybackRate`，并发出 `ratechange`。** 只设 `playbackRate` 的话换集时会先掉回 1 再被拉回；把 `defaultPlaybackRate` 也设上，速度根本不掉。
4. **站点锁死 1.0 时无限拉锯。** 没有让步机制时，测试里 0.5 秒内 ratechange 达 55 万次。
5. **自己的快捷键不能算「用户手势」。** 一开始手势监听也挂了 `keydown`，结果按 `G` 之后 1 秒内的站点重置全被当成「用户在菜单里改成了 1」。现在只有本脚本放行的键才记手势。

## 已知限制

- **closed shadow DOM** 里的媒体找不到（`el.shadowRoot` 是 null）。
- 元素插进文档**之后很久**才 `attachShadow` 的，MutationObserver 看不到；要等下次按快捷键的全量扫描才会被发现，在那之前不会自动套用记忆的倍速。
- 用户 / 站点的区分是启发式：手势后 1 秒内、没有换 `src` 的站点重置会被当成用户的选择（反过来，用户通过非手势途径改速——比如播放器的定时逻辑——会被拉回）。
- 页面没有媒体时不拦按键；有媒体时 Z X R G Q E 被本脚本吞掉，和站点自己的同名快捷键冲突时改 `CONFIG.keys`。
- 不是 HTML 媒体元素的播放器（Canvas / WebGL 自绘、纯 Web Audio）管不到。
- OSD 依赖 Popover API（Chrome 114+、Firefox 125+、Safari 17+）；更老的浏览器在 `<video>` 本身全屏时看不到提示。
- 测试跑在 harness 里，不是真实的 Tampermonkey：没有沙箱（`unsafeWindow === window`），MV3 隔离 world 下的事件监听顺序没有实测。

## 测试

```bash
NODE_PATH=/path/to/node_modules node video-speed/test/run.cjs
```

`NODE_PATH` 指向任一装了 `playwright` 的 `node_modules`（仓库本身不带）。用 `tools/userscript-harness.cjs` 在 Playwright 里加载脚本、模拟 GM_*，不访问外网：

- `test/fixtures/*.html` 由 harness 的本地服务提供；「真实域名」（`video.example.com`、`player.example.net`）用 `context.route` 拦截后本地 fulfill。
- 需要真实媒体（duration、seek、播放状态）的用例用**运行时生成的静音 WAV**（8 kHz / 8 bit / 单声道，60 秒），经 route 提供，不进仓库；`<video>` 也能播纯音频文件。只测 `playbackRate` 的用例用不加载媒体的空 `<video>`。
- 覆盖：快捷键调速与钳位、连发、修饰键、输入框（含 shadow DOM 里的）不响应、按键不漏给页面；当前视频判定；shadow DOM 与动态插入；站点重置 / 换 src / 下一集 / 用户主动修改；OSD 位置、淡出、两种全屏；按站点记忆与菜单；锁死站点的让步；同源 / 跨域 iframe。

写测试时踩到的（不是脚本的问题）：

- **WAV 必须按 `Range` 回 206。** 整包回 200 的话 Chrome 认为服务器不支持分段，`seekable` 是 `[0, 0]`，设置 `currentTime` 被静默钳回 0（`buffered` 明明有 60 秒）。
- **`context.route('**/silence.wav')` 匹配不了带 query 的 URL**（`silence.wav?ep=2`），改用正则。
- harness 的 GM 存储是按源隔离的 `localStorage`，真实 Tampermonkey 是脚本全局共享。所以「不同站点的记忆互不影响」没法靠两个源各读各的来验证，改成预置别的站点的记忆、断言本站读不到也不会删掉它。
