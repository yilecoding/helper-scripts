# 贵州省网络研修专题自动续课

目标专题：`http://www.gzwy.gov.cn/page.html#/pc/nc/pagespecial/specialDetail?id=28c0ade8b77e42ac821863d958ade8c8`

## 调研结果

- 页面是 Vue 单页应用，入口文件加载 `modules/nc/js/dsf-nc.pc.js`，课程播放器使用 ckplayer。
- 专题页列表从 `nc/class/course/list` 获取有序 `lists[].subList[]`；课程行包含 `businessId`、`name`、`typeValue`、`progress`、`playState` 等字段。
- 专题列表的「进入」按钮调用 Vue 组件 `clickEnter(item, classId, group, index, previousProgress)`，该方法保留平台报名、前置课程和人脸核验等原有检查。
- 课程播放页从 `nc/course/play/getPlayTrend` 取 `playTree`，使用 `locationSite` 载入当前课件。播放器结束回调可在课程树里继续下一课件；站点原生切换函数会把最后一项绕回第一项。
- 学习进度由页面播放器按正常播放进度调用 `nc/course/play/pulseSaveRecord` 上报；专题列表可重新加载后读取平台记录的完成百分比。

## 脚本行为

gzwy-course-autonext.user.js 在目标专题页和课程播放页显示面板，默认关闭。在专题页打开开关后点「开始学习第一门未完成课程」，通过专题组件原生 clickEnter 进入课程。在播放页，它监听真实媒体的 ended 事件，并只在 Vue 播放器确认当前课件是课程树最后一项时等待平台同步。平台专题列表将当前课程标记为 100% 后，脚本按顺序找到下一门未完成课程，并调用专题组件原生 clickEnter；该入口会保留站点自己的开放时间、报名状态、前置课程及人脸核验检查。考试、直播等非课程项目会提示手动处理。没有待学课程时停止。

首次启动需要在专题页点击按钮，以满足浏览器打开播放页的用户手势要求。通过站点原生入口打开下一门时，浏览器可能打开新标签页；保留专题页和课程标签页。脚本不改学习进度接口，不自动答题、不模拟视频结束，也不跳过平台校验。

## 已知限制

- 若直接单独打开课程播放页，脚本无法判断专题里的下一门；请从目标专题页按钮启动。
- 站点更新 Vue 组件属性名、课程行结构或资源进度语义后，需要重新调研；实现使用功能特征识别 Vue 实例，避免依赖压缩后的组件名。
- 支持 gzwy.gov.cn / www.gzwy.gov.cn 的 HTTP 和 HTTPS 页面地址。

## 安装

离线测试命令：`NODE_PATH=/path/to/node_modules node gzwy-course-autonext/test/run.cjs`。测试使用本地页面模拟播放器、专题 Vue 课程列表及站点入口。

用 Tampermonkey 安装 gzwy-course-autonext.user.js，打开目标专题页，先开启自动续课，再点「开始学习第一门未完成课程」。若之前安装过旧版，请在 Tampermonkey 中更新脚本并刷新专题页。
