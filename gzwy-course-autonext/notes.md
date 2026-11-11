# 贵州省网络研修专题自动续课

目标专题：`http://www.gzwy.gov.cn/page.html#/pc/nc/pagespecial/specialDetail?id=28c0ade8b77e42ac821863d958ade8c8`

## 调研结果

- 页面是 Vue 单页应用，入口文件加载 `modules/nc/js/dsf-nc.pc.js`，课程播放器使用 ckplayer。
- 专题页列表从 `nc/class/course/list` 获取有序 `lists[].subList[]`；课程行包含 `businessId`、`name`、`typeValue`、`progress`、`playState` 等字段。
- 专题列表的「进入」按钮调用 Vue 组件的 `clickEnter`。**贵州站点实际生效的是 `static/js/project/dsf-pc.js` 里的项目版组件**，参数表是 `clickEnter(group, item, classId, group, index, previousProgress, isStudentFlag)`；`modules/nc/js/dsf-nc.pc.js` 里的通用版是 `clickEnter(item, classId, group, index, previousProgress)`。按通用版顺序去调项目版，第二个参数变成 classId 字符串，`playState` 读不到，页面提示「不在学习时间范围」且不打开课程。脚本按形参个数（≥6 为项目版）区分两种调用方式。
- 课程播放页从 `nc/course/play/getPlayTrend` 取 `playTree`，使用 `locationSite` 载入当前课件。播放器结束回调可在课程树里继续下一课件；站点原生切换函数会把最后一项绕回第一项。
- 学习进度由页面播放器按正常播放进度调用 `nc/course/play/pulseSaveRecord` 上报；专题列表可重新加载后读取平台记录的完成百分比。

## 脚本行为

gzwy-course-autonext.user.js 在目标专题页和课程播放页显示面板，默认关闭。切课由**专题页**负责，播放页只负责催一下和停播：

- **专题页**：点「开始学习第一门未完成课程」后，用专题组件原生的 clickEnter 打开课程，并把这门课的 `businessId` 记为「正在学」（存在 GM 值 `gzwy-course-autonext-active` 里，跨标签页共享）。之后每 60 秒调一次列表组件父级的 `initData()` 重新拉 `nc/class/course/list`，正在学的课程 `progress` 到 100 就按列表顺序找第一门未完成课程，再走一次原生 clickEnter。站点自己的开放时间、报名状态、前置课程及人脸核验检查都保留。下一项是考试、直播等非课程项目，或者没有待学课程时停止并提示。面板上有「重新打开」按钮，新标签页被浏览器拦截时点它（这是一次真实点击，不会被拦）。
- **播放页**：每 5 秒读 Vue 播放器课程树 `chapterInfo.children[].finishedRate`，全部课件达到 100 就向 `window.opener`（专题页）派发一个自定义事件，让它立刻检查，不用等 60 秒那一轮。发现「正在学」已经换成别的课程时，本页暂停播放；开了后台保活的话还会尝试关闭自己（只有脚本打开的标签页关得掉）。

两个坑：

- 不能用「最后一个课件播完」来判断课程学完：站点的结束回调 `playEnd` 先于脚本执行，`end_action` 为 2 时立刻 `playNextCourse()`，最后一项会绕回第一项，脚本看到的当前课件已经是第一个。表现就是课件在课程内循环，永远不切下一门。
- 早期版本由播放页去调专题页的 clickEnter 并在播放页里等进度，切课依赖 `window.opener` 和播放页的状态，用户看到的是「专题页列表不动、也不切」。现在专题页自己盯自己的列表，播放页挂了也不影响。

首次启动需要在专题页点击按钮，以满足浏览器打开播放页的用户手势要求；后续课程是脚本打开的，需要对该站点允许弹出式窗口。脚本不改学习进度接口，不自动答题、不模拟视频结束，也不处理人脸核验。

## 后台保活（可选，默认关闭）

面板第二个开关，设置跨标签页共享，只在课程播放页生效，对开关之后打开的播放页起作用。站点播放器有两处会让挂后台的课停下来（均见 `static/js/project/dsf-pc.js`）：

- `initPlayerTabStop`：收到 `visibilitychange` 且 `document.hidden` 为真时暂停播放器。脚本在保活开启时让播放页的 `document.hidden` / `visibilityState` 读成前台，并在捕获阶段拦下 `visibilitychange`。
- 无操作提醒：`document.onmousemove` 超过后台配置的分钟数没触发，就暂停并弹「您已学习 N 分钟了,是否继续学习？」。脚本每 5 秒调用一次 `document.onmousemove` 重置计时；弹窗仍然出现时点「确定」（弹窗 DOM 按 Element UI 的 `.el-message-box` 推断，未在真实页面核对）。

另外每 5 秒检查一次：视频处于暂停且未播完时调用 `play()`，被浏览器自动播放策略拒绝则静音后再播。保活开着时手动暂停会被续播，要暂停先关开关。

保活会停下来的情况：页面上有可见的 `.el-dialog__wrapper`（人脸核验二维码、随堂测验等）或其他提示框时不续播，面板提示手动处理；课件全部看完后不再续播；本页被换下去之后停止保活。

## 已知限制

- 专题页标签页不能关。它在后台时浏览器会把定时器降到大约每分钟一次，所以切课最多慢一分钟左右；播放页的催促事件不受这个限制。浏览器的「内存节省程序」如果把专题页丢弃了，切课就停了，长时间挂机建议把该站点加入「始终保持活动状态」。
- 「正在学」和开关状态会保留。带着它们重新打开专题页时，脚本会直接继续盯进度，课程已满 100% 的话会马上尝试打开下一门（没有点击手势，可能被拦，点「重新打开」即可）。
- 每次重新拉列表，站点会闪一下加载遮罩，这是 `initData()` 自带的。
- 站点更新 Vue 组件属性名、课程行结构或资源进度语义后，需要重新调研；实现使用功能特征识别 Vue 实例，避免依赖压缩后的组件名。
- 支持 gzwy.gov.cn / www.gzwy.gov.cn 的 HTTP 和 HTTPS 页面地址。

## 安装

离线测试命令：`NODE_PATH=/path/to/node_modules node gzwy-course-autonext/test/run.cjs`。测试使用本地页面模拟播放器、专题 Vue 课程列表及站点入口；专题页的 60 秒轮询在测试里用催促事件触发。

用 Tampermonkey 安装 gzwy-course-autonext.user.js，打开目标专题页，点「开始学习第一门未完成课程」（会自动打开开关）；要挂后台就先勾上「后台保活」。若之前安装过旧版，请在 Tampermonkey 中更新脚本并刷新专题页。
