# 新平台（basic.smartedu.cn）结构调研 — 2026 暑期教师研修（基础教育）

调研于 2026-08-11，未登录状态下从公开 CDN JSON 获得。

## 与旧版的根本差异

| | 旧版（脚本现在适配的） | 新版 |
|---|---|---|
| 域名 | `core.teacher.vocational.smartedu.cn` | `basic.smartedu.cn` |
| 播放页路由 | `/p/course/vocational/v_<id>?itemId=…&segId=…` | `/teacherTraining/courseIndex?courseId=<uuid>&libraryId=…`（`courseDetail` 会 302 到 `courseIndex`） |
| 前端 | 传统多页，类名稳定（`.video-title.clearfix`、`.four`） | React + CSS Modules，类名带构建哈希（`index-module_course-catalog_w31Fa`）——**选择器不可依赖哈希** |
| 进度显示 | DOM 文本 `100%`（`.four`） | 只有空 div `.status-icon`，靠 CSS 表现；**DOM 里读不到百分比** |
| 课程清单 | 脚本里硬编码 URL 数组 | 走接口，可自动发现 |
| 组件库 | layui（`#layui-layer<N>`） | Fish（`.fish-collapse-item` / `.fish-collapse-header` / `.fishicon`）——**类名稳定，可用** |

## 稳定可用的选择器

```
[class*="course-catalog"]        课程大纲容器
.fish-collapse-item             章节（折叠项）
.fish-collapse-header           章节标题（点击展开）
.fish-collapse-content-active   已展开的章节内容
.resource-item                  资源条目（视频/文档），点击进入学习
.resource-item .status-icon     学习状态图标（无文本，需读 class 或伪元素）
```

注意：未展开的章节**不渲染**其 `.resource-item`（懒渲染），所以枚举全部视频前必须先点开所有 `.fish-collapse-header`。

## 数据接口

### 1. 专题结构（公开，无需登录）
```
GET https://s-file-1.ykt.cbern.com.cn/teach/api_static/trains/{trainId}.json
```
返回 `train`（标题/起止时间）、`train_phase_list`（阶段与学时要求）、`train_course_ids`（课程 ID 数组）、`pass_rule`。

本专题 `trainId = dc6d78f2-bad8-4d09-b8da-0d758803dbe4`（short_name `2026jjsqpx`）
- 标题：2026年“暑期教师研修”专题（基础教育）
- 学习期：2026-07-27 18:00 → 2026-09-30 23:59
- 阶段：`学科教学能力提升`，`period_hour_limit: 3`（需 3 学时 = `period_limit: 8100` 秒）
- `pass_rule.period_rule_type: "$stipulated"`（完成全部规定学时）

### 2. 课程详情（公开，无需登录）
```
GET https://s-file-1.ykt.cbern.com.cn/teach/s_course/v2/business_courses/{courseId}/course_relative_infos/zh-CN.json
```
关键字段：`course_detail.name`、`activity_set_id`、`total_activity_count`、
`ext_info.max_period`（学时上限）、`ext_info.progress_config`、`ext_info.video_study_config`。

### 3. 视频/活动清单（**需登录，未登录 403**）
`activity_set_id` 对应的活动列表接口未确定，已试均 403：
```
/teach/s_course/v2/activity_sets/{activitySetId}/zh-CN.json          → 403
/teach/s_course/v2/business_courses/{courseId}/activity_set/zh-CN.json → 403
/teach/s_course/v2/business_courses/{courseId}/activities/zh-CN.json   → 403
```
→ 待登录后从 Network 抓真实 URL。

### 4. 进度上报（需登录）
每门课的 `ext_info.progress_config` 里直接给出：
```
spi        https://elearning-train-gateway.ykt.eduyun.cn/v1/spi/trains/{trainId}/courses/{courseId}/progress/actions/async
begin-spi  https://elearning-train-gateway-safe.ykt.eduyun.cn/.../progress/actions/async_begin
fix_spi    https://elearning-train-gateway-safe.ykt.eduyun.cn/.../progress/actions/async_fix
```
同时给出播放约束：
- `is_allow_speed: true` → **平台允许倍速**
- `is_allow_drag: false` → 禁止拖动进度条
- `max_period` → 该课学时上限

## 11 门课程（train_course_ids 顺序）

| # | 课程名 | courseId | activity_set_id | max_period | 资源数 |
|---|---|---|---|---|---|
| 1 | 大力弘扬教育家精神 | `79d28f6c-0b8a-443d-bdda-a78165c462f3` | `da0be0d4-d531-4f16-b30b-7a21d89846a0` | 2 | 142 |
| 2 | 数智素养提升 | `165d9433-5486-43e4-926e-3f33b92635e4` | `c2a715f6-38eb-4bd8-9547-7b45ddc5b248` | 3 | 357 |
| 3 | 科学素养提升 | `b2ec4202-c747-4ad2-a1b1-35a6c277c856` | `e915d605-1401-46ac-b4f6-c2e0598c837c` | 1 | 23 |
| 4 | 心理健康教育能力提升 | `ca2a448a-5ff5-4183-92c2-6506f6696228` | `863da0ff-fdfb-4028-bd18-9f4ba2c71598` | 1 | 9 |
| 5 | 学校美育浸润行动 | `a09d7192-d7d6-4451-8828-a96d3a5e66ca` | `0367b0ed-926f-450c-ac50-a9be743e24ca` | -1 | 30 |
| 6 | 学科美育教学改革专题培训 | `6a46308e-17ff-456a-a320-b5bdb494e93d` | `27605d58-6b38-4951-a2cc-70a8d56b4130` | -1 | 25 |
| 7 | 有效开展每日综合体育活动 | `f120b8f7-1768-440e-ae79-3e79dd0650f2` | `a99d361f-8122-4913-afa0-1efa70f7d3cb` | -1 | 11 |
| 8 | 跨学科实验设计 | `0b69a573-7585-4450-8bae-48d3e3fd5cc1` | `5a0f4670-1ed1-480d-bb25-8625b1f863a7` | -1 | 18 |
| 9 | 孤独症教育骨干教师培训 | `12a71d1f-8c22-418e-8ffe-ab0a6741fd74` | `15365cbc-ab59-40aa-841a-cd32d638d3dc` | -1 | 73 |
| 10 | 融合教育通识课程 | `c7044ffc-64b4-44b9-a866-0c117ff104d1` | `5d8ac098-0d9e-4c26-8a06-7bc1d90239c8` | -1 | 112 |
| 11 | 面向普教校长与教师的融合教育通识课实录 | `87102185-fa21-4565-ad94-ade986c1c141` | `9beefdad-eb71-4e70-991d-b8378c549e00` | -1 | 41 |

`max_period: -1` = 不限学时。`total_activity_count` 含视频与文档，不等于视频数。

## 对新脚本的设计影响

1. **课程列表不再硬编码。** 从 `trainId` 拉 `train_course_ids`，再逐个取课程名与 `max_period`，改专题只需换一个 `trainId`。
2. **学时判断不能再数「多少个 100%」。** 新版 DOM 无百分比。需改为读 `.status-icon` 的状态 class，或走登录后的进度接口。
3. **选择器换成 Fish 类名 + `[class*=]` 前缀匹配**，绕开 CSS Modules 哈希。
4. **播放页是 SPA 内部跳转**，不再是整页 `location.href` 导航 → 翻课要走点击或 History API，`@match` 只需 `basic.smartedu.cn/teacherTraining/*`。
5. 枚举视频前需先展开所有章节。

## 播放器：video.js（不是西瓜播放器）

旧平台用的是西瓜播放器（xgplayer），新平台换成了 **video.js**，所以 `.xgplayer-icon-play`
那套选择器在新平台完全无效。实测容器链：

```
DIV.video-js fish-ndrVideo vjs-big-play-centered vjs-paused vjs_video_1-dimensions
 └ DIV.fish-video                        ← 稳定，无哈希
   └ DIV.course-video fixed-radio        ← 稳定，无哈希
     └ DIV.index-module_course-player_uq5bZ   ← 带哈希，勿用
       └ DIV.index-module_video-wrapper_r6ONu ← 带哈希，勿用
```

可用选择器（按优先级）：

```
.fish-video video              定位 video 元素（避免抓到页面上别的 video）
.course-video video            备选
.vjs-big-play-button           大播放按钮 ✓ 存在
.video-js .vjs-play-control    控制栏播放按钮 ✓ 存在
[title="Play"]                 ✓ 存在（video.js 英文 locale，故 [aria-label="播放"] 无效）
```

视频源是 `blob:` URL（MSE/HLS），`duration` 可正常读取（实测 2000.57s）。
另有 `vjs-watermark-animation-pause` class，说明挂了水印插件。

## 后台标签保活（实测于 Chrome 148）

切标签后"不动了"有三个独立原因，解法不同：

| 原因 | 机制 | 解法 |
|---|---|---|
| 定时器节流 | 后台标签 `setInterval` 被限制到 ≥1s，5 分钟后降到 **1 次/分钟**。注意：**播放"有声"音频的页面豁免**，静音页面不豁免 | 心跳移进 Worker（Worker 定时器不受同样节流）；`ended` 事件即时响应而非等心跳 |
| 平台主动暂停 | 平台若监听 `visibilitychange`/`blur` 则会 `pause()` 或停止上报 | 伪装 Page Visibility |
| rAF 冻结 | `requestAnimationFrame` 在后台完全停止 | 同上（或不切走） |

实测结论：

- `document.hidden` / `visibilityState` 的属性描述符 `configurable: true`，**可覆盖**
- 在 `@run-at document-start` 抢先注册捕获阶段监听 + `stopImmediatePropagation()`，
  能拦住之后注册的监听器（实测"平台的监听"收到 0 次事件）
- blob Worker 可用，站点无 CSP meta 阻挡；800ms 内正常跳 11 次
- `navigator.getAutoplayPolicy` 不可用，无法预判自动播放策略 → 只能 try/catch 回退静音

**最省事的替代方案**：Chrome 的 `visibilityState` 只在标签切后台或窗口最小化时变 `hidden`，
**失焦但仍可见的窗口依然是 `visible`**。所以把课程页拉成独立窗口放在副屏/分屏，
三个原因全部不成立，无需任何 hack。

## 资源行的状态判定（2026-08-11 登录态实测确认）

**最大的坑：状态不在 `.status-icon` 自己身上，而在它内部的子元素上。**
读 `.status-icon` 这个 div 的 `className` / `title` 永远是空字符串，
照那样写判定会永远返回 false，导致脚本反复重播平台已经打勾的视频。

三种状态的真实 HTML：

```html
<!-- 已学完 -->
<div class="resource-item resource-item-train ">
  <div><img src="…/video-c1287471.png">&nbsp;中学生人际交往心理辅导</div>
  <div style="display:flex;align-items:center;">
    <div class="status-icon"><i class="iconfont icon_checkbox_fill" title="已学完"></i></div>
  </div>
</div>

<!-- 正在播放（注意行上多了 resource-item-active） -->
<div class="resource-item resource-item-train resource-item-active">
  …<div class="status-icon"><div class="index-module_running_oSftp" style="transf…"></div></div>
</div>

<!-- 未学 -->
<div class="status-icon"></div>   <!-- 空 -->
```

**三种状态的完整实测结果**（2026-08-11 登录态诊断确认）：

```html
已学完 <div class="status-icon"><i class="iconfont icon_checkbox_fill"   title="已学完"></i></div>
进行中 <div class="status-icon"><div class="index-module_running_*">…条形动画 svg…</div>
                                <i class="iconfont icon_processing_fill" title="进行中"></i></div>
未开始 <div class="status-icon"><i class="iconfont icon_checkbox_linear" title="未开始"></i></div>
```

⚠ **「进行中」的 class 里也带 `fill`**（`icon_processing_fill`）。
关键词必须写 `checkbox_fill`，写成 `fill` 会把进行中误判成已学完 —— 整门课被直接跳过。
「未开始」是 `icon_checkbox_linear`，和 `icon_checkbox_fill` 只差后缀，同理不能只匹配 `checkbox`。

判定顺序（稳定性从高到低）：

1. `.status-icon [title]` 的 `title` 含「已学完/已完成/学习完成/已学习」
2. `.status-icon` 的 `innerHTML` 含 `checkbox_fill` / `finish` / `complete` / `done` 等关键字
3. 行内文本含上述文案
4. 脚本自己的本地记账（`ended` 事件）

**两个必须避开的误判**（已写成回归用例验证）：

- `icon_checkbox`（未学的空心框）不能被 `checkbox` 命中 → 关键字必须用 `checkbox_fill`，不能用 `checkbox`
- `title="未学习"` 不能被 `已学习` 命中 → 中文子串是安全的，但换判定词时要重新检查

误判成"全部已学完"的后果是整门课被直接跳过，比漏判严重得多。

另：`.resource-item-active` 标记当前播放行，无哈希，比脚本自己记 currentTitle 更可靠
（平台自己切视频时我们记的会是旧的）。

**推进逻辑不能只靠 `ended` 事件。** 进课程页时平台会自动恢复上次的播放位置，
如果那条早就学完了，视频既没结束又不是"没有播放器"，脚本会一路维持播放
把已完成的视频整个再放一遍（实测撞上过 1:36:50 的，2 倍速也要白播 48 分钟）。
所以每轮心跳都要先问一句「现在播的这条是不是已经学完」，是就直接跳。
跳转要加 5 秒节流——心跳 4 秒一次，平台切换没那么快，否则会重复点击打架。

## 多端并发检测（2026-08-11 实测，影响最大的一条）

同一账号在两个端同时学习时，平台会弹：

> 你已在其他端进入学习，本端自动暂停学习。知道了

同时把本端的视频 `pause()` 掉。实测 13 秒内触发 3 次。

**不能把它当普通提示关掉。** 关掉再播 → 平台再暂停，形成拉锯：
2 倍速的有效速度被拖到约 1.4x（4 秒心跳只涨 5~6 秒，正常应涨 8 秒）。
正确做法是停下来提示用户去关掉另一个端。

这条也解释了"设了 2x 但进度只按 1x 走"的现象——倍速本身是生效的，是播放被反复打断。

### 两个必须用 MutationObserver 而不是轮询的理由

1. **弹窗只存活约 1.3 秒**，而心跳是 4 秒一次，轮询大概率错过。
2. **弹窗刚插入 DOM 的那一刻 `isVisible` 还是 false**（动画未生效），
   即使轮询撞上，"不可见就跳过"的判断也会把它漏掉。

实测轮询漏检率接近 100%，改成 MutationObserver 后 100% 捕获。

### 弹窗节点会累积，不要用「取第一个」的方式选弹窗

平台每弹一次窗就往 `body` 里留一个**不删除**的 `.fish-modal-root` 残骸。
实测跑几分钟后：

```
.fish-modal            → 29
[class*="fish-modal"]  → 290
[class*="modal"]       → 296
```

所以 `querySelector('.fish-modal')` 或「第一个可见的，否则第 0 个」这类写法
基本等于随机取一个陈旧节点。必须遍历所有候选，只保留**可见且有文字**的。
课堂练习的检测也受同样影响。

## 油猴沙箱 vs 页面注入：同一段代码行为不同

调试时用 `<script src=…>` 把脚本注入页面很方便，但**测不出沙箱相关的坑**。

实测踩到的：

```js
new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })
```

- 页面里直接跑：正常
- 油猴脚本里跑：抛 `Failed to construct 'MouseEvent': Failed to read the 'view'
  property from 'UIEventInit': Failed to convert value to 'Window'`

因为油猴沙箱里的 `window` 是代理对象，不是真正的 `Window` 实例。

后果比想象严重：异常从 `realClick` 冒泡到 `dismissModals`，再被 `tick` 的
try/catch 兜住，**整轮 tick 直接中断**，表现为"弹窗一直关不掉、每 4 秒重复一次"。

结论：
- 派发鼠标事件不要传 `view`，它是可选的，点击处理用不到
- 需要真 window 时用 `unsafeWindow`
- 注入测试通过 ≠ 油猴环境可用，涉及 `window` / `document` 原型的代码要在油猴里实测

## 主循环的早退分支必须有兜底

`tick()` 开头那几步（关弹窗 / 答题 / 展开章节）只要返回 true 就中断本轮。
它们全都存在「永远返回 true」的可能：

| 分支 | 卡死原因 |
|---|---|
| 关弹窗 | 弹窗残骸不从 DOM 移除，里面的「我知道了」一直可点、点了没反应 |
| 课堂练习 | 弹窗出现但选项选择器没命中 → 一直「等待选项渲染」 |
| 展开章节 | 平台切视频时重新折叠章节 → 每轮都触发展开 |

任何一种发生，后面的播放维持、跳过已学完、翻课**一次都执行不到**，
表现就是"卡住不动、不翻下一个视频"——而且日志看起来还挺正常，很难查。

解法是给每个早退分支加计数器，连续超过 N 轮未解决就放行：

```js
const stallCounts = {};
function blocking(key, hit, limit = 3) {
  if (!hit) { stallCounts[key] = 0; return false; }
  stallCounts[key] = (stallCounts[key] || 0) + 1;
  if (stallCounts[key] > limit) { Log.tick(`「${key}」连续未解决，先放行`); return false; }
  return true;
}
```

教训：**任何"处理完就 return"的守卫，都要问一句"如果它永远处理不完会怎样"。**

## 用隐藏 iframe 批量探测各门课进度（可行，已实测）

面板要显示 11 门课的进度，但只有当前打开的那门能从 DOM 读到。
解法是用同源隐藏 iframe 逐门打开课程页读 DOM，结果缓存到 GM。

实测数据（登录态）：

```
心理健康（9 个视频）    13.1s  行=9  状态=9  已学完=9
孤独症（72 个 / 16 章节） 12.4s  行=72 状态=72 已学完=9
```

三个必须注意的点：

1. **iframe 不能放到 `left:-99999px`。**
   平台的懒渲染（IntersectionObserver）会判定它不可见而完全不渲染，列表永远 0 行。
   必须留在视口内，靠 `opacity:0.01` + `z-index:-99999` 藏起来。

2. **「教师研修」是挂在 `teacher.ykt.eduyun.cn` 的微前端（micro-app），启动慢。**
   实测 12–13 秒列表和状态才**一起**出现（不是列表先、状态后）。
   超时至少给 30 秒。加载失败时页面会显示「加载组件时发生了一些异常」，
   控制台里是 `[micro-app] app MICRO_TCHTRAINING: ... stop rendering`。

3. **必须等到「每一行都有 title」才计数。**
   未登录时列表照样渲染但状态图标全空，这时直接数会得到 `done=0`。
   把这种错值缓存下来，脚本会以为整门课一个没学、从头重刷一遍 —— 比不缓存糟得多。
   拿不准就返回 null 标「未统计」。

### 一次调试事故，值得记

第一次测 iframe 得到「行=72 状态=0」，我据此断定"iframe 拿不到进度"并删掉了功能。
**结论是错的** —— 当时浏览器窗格掉了登录，而未登录页面的表现恰好一模一样
（列表正常渲染、状态全空）。

教训：**下"做不到"的结论前，先确认实验环境本身是有效的。**
判断登录态的可靠方法是看 `document.querySelectorAll('.status-icon [title]').length`，
不是看页面上有没有"登录/注册"字样（导航栏里本来就可能有）。

## 自愈：把"刷新页面"当补偿手段

长时间跑（比如挂一夜）会越来越不稳定。原因是可以证实的：

- 平台每弹一次窗就留一个**不回收**的 `.fish-modal-root` 残骸，
  实测 `[class*="modal"]` 能从 27 涨到近 300
- 播放器反复换源，监听器和内存只增不减
- 微前端（`teacher.ykt.eduyun.cn`）偶发加载失败，页面进入半死状态，
  脚本自己救不回来

刷新能一次性清干净，而且**是安全的**：进度和 running 状态都存在 GM 里，
刷新后 `boot()` 会自动接着跑。

### 三个触发源

| 触发 | 阈值 | 对应的坏掉方式 |
|---|---|---|
| 例行 | 看完 5 个视频 | 防患于未然，清累积残骸 |
| 异常 | 连续 3 轮抛异常 | 进了脚本自己出不来的状态 |
| 停滞 | 播放进度 3 分钟不动 | 播放器或微前端半死 |

停滞检测只在"本该正常播放"时才算数 —— 弹窗、答题、多端暂停都会在
`tick()` 前段就 return，走到检测点说明确实该在播。

### 防刷新循环（比刷新本身更重要）

写错会让浏览器陷入无限重载，后果比"不刷新"严重得多。两道防护：

```js
if (count >= maxReloadsPerSession) return false;   // 单标签页上限 40 次
if (now - last < minReloadGapMs) return false;     // 两次间隔至少 60 秒
```

计数存 `sessionStorage`：能跨刷新存活，又不会污染下一次会话
（用 localStorage 会永久累积，用内存变量则一刷新就清零、等于没有防护）。

回归用例（已验证）：

```
连调 5 次(同一时刻) => true,false,false,false,false
+59s               => false
+61s               => true
到达上限 40         => false
第 39 次            => true
```

## 仍缺

- 课堂练习弹窗：新版是否还有？题型文案与提交按钮选择器（至今未在实页遇到）。
- 活动清单接口的真实 URL（`activity_sets` 相关，未登录 403）。
