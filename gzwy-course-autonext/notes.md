# 贵州省网络研修专题自动续课

目标专题：`http://www.gzwy.gov.cn/page.html#/pc/nc/pagespecial/specialDetail?id=28c0ade8b77e42ac821863d958ade8c8`

## 调研结果

- 页面是 Vue 单页应用，入口文件加载 `modules/nc/js/dsf-nc.pc.js`，课程播放器使用 ckplayer。
- 专题页列表从 `nc/class/course/list` 获取有序 `lists[].subList[]`；课程行包含 `businessId`、`name`、`typeValue`、`progress`、`playState` 等字段。
- 专题列表的「进入」按钮调用 Vue 组件的 `clickEnter`。**贵州站点实际生效的是 `static/js/project/dsf-pc.js` 里的项目版组件**，参数表是 `clickEnter(group, item, classId, group, index, previousProgress, isStudentFlag)`；`modules/nc/js/dsf-nc.pc.js` 里的通用版是 `clickEnter(item, classId, group, index, previousProgress)`。按通用版顺序去调项目版，第二个参数变成 classId 字符串，`playState` 读不到，页面提示「不在学习时间范围」且不打开课程。脚本按形参个数（≥6 为项目版）区分两种调用方式。
- 课程播放页从 `nc/course/play/getPlayTrend` 取 `playTree`，使用 `locationSite` 载入当前课件。播放器结束回调可在课程树里继续下一课件；站点原生切换函数会把最后一项绕回第一项。
- 学习进度由页面播放器按正常播放进度调用 `nc/course/play/pulseSaveRecord` 上报；专题列表可重新加载后读取平台记录的完成百分比。

## 脚本行为

gzwy-course-autonext.user.js 在目标专题页和课程播放页显示面板，默认关闭。在专题页打开开关后点「开始学习第一门未完成课程」，通过专题组件原生 clickEnter 进入课程。在播放页，它监听真实媒体的 ended 事件，并只在 Vue 播放器确认当前课件是课程树最后一项时等待平台同步。平台专题列表将当前课程标记为 100% 后，脚本按顺序找到下一门未完成课程，并调用专题组件原生 clickEnter；该入口会保留站点自己的开放时间、报名状态、前置课程及人脸核验检查。考试、直播等非课程项目会提示手动处理。没有待学课程时停止。

首次启动需要在专题页点击按钮，以满足浏览器打开播放页的用户手势要求。通过站点原生入口打开下一门时，浏览器可能打开新标签页；保留专题页和课程标签页。脚本不改学习进度接口，不自动答题、不模拟视频结束，也不处理人脸核验。

## 后台保活（可选，默认关闭）

面板第二个开关，设置跨标签页共享，只在课程播放页生效，对开关之后打开的播放页起作用。站点播放器有两处会让挂后台的课停下来（均见 `static/js/project/dsf-pc.js`）：

- `initPlayerTabStop`：收到 `visibilitychange` 且 `document.hidden` 为真时暂停播放器。脚本在保活开启时让播放页的 `document.hidden` / `visibilityState` 读成前台，并在捕获阶段拦下 `visibilitychange`。
- 无操作提醒：`document.onmousemove` 超过后台配置的分钟数没触发，就暂停并弹「您已学习 N 分钟了,是否继续学习？」。脚本每 5 秒调用一次 `document.onmousemove` 重置计时；弹窗仍然出现时点「确定」（弹窗 DOM 按 Element UI 的 `.el-message-box` 推断，未在真实页面核对）。

另外每 5 秒检查一次：视频处于暂停且未播完时调用 `play()`，被浏览器自动播放策略拒绝则静音后再播。保活开着时手动暂停会被续播，要暂停先关开关。

保活会停下来的情况：页面上有可见的 `.el-dialog__wrapper`（人脸核验二维码、随堂测验等）或其他提示框时不续播，面板提示手动处理；交给平台打开下一门之后，旧播放页停止保活并暂停播放（站点原生逻辑会把最后一段绕回第一段），面板留一个「重新打开」按钮供弹窗被拦截时重试。

挂机前提：浏览器对该站点允许弹出式窗口；专题页标签页不能关。等待平台把课程记为 100% 的时限是 10 分钟。

## 已知限制

- 若直接单独打开课程播放页，脚本无法判断专题里的下一门；请从目标专题页按钮启动。
- 站点更新 Vue 组件属性名、课程行结构或资源进度语义后，需要重新调研；实现使用功能特征识别 Vue 实例，避免依赖压缩后的组件名。
- 支持 gzwy.gov.cn / www.gzwy.gov.cn 的 HTTP 和 HTTPS 页面地址。

## 安装

离线测试命令：`NODE_PATH=/path/to/node_modules node gzwy-course-autonext/test/run.cjs`。测试使用本地页面模拟播放器、专题 Vue 课程列表及站点入口。

用 Tampermonkey 安装 gzwy-course-autonext.user.js，打开目标专题页，先开启自动续课，再点「开始学习第一门未完成课程」。若之前安装过旧版，请在 Tampermonkey 中更新脚本并刷新专题页。
