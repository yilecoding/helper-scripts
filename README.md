# tampermonkey-scripts

个人 Tampermonkey 用户脚本集合。每个脚本一个目录，目录名与脚本主文件（`*.user.js`）同名，脚本自身的调研/开发笔记放在同目录下的 `notes.md`。

```
<script-name>/
  <script-name>.user.js   # 脚本本体
  notes.md                 # 调研笔记 / 开发记录（可选）
```

## 脚本列表

### [smartedu-2026-basic](./smartedu-2026-basic/smartedu-2026-basic.user.js)

2026 年暑期教师研修 | 国家中小学智慧教育平台 | 自动连播助手。适配 `basic.smartedu.cn`（React + Fish + video.js），加载后弹出课程目录，点一门即开始：自动展开章节、自动播放、播完立即续播下一个、可选学完自动进下一门、课堂练习自动选第一个，支持后台标签页持续播放。

调研笔记见 [notes.md](./smartedu-2026-basic/notes.md)。

### 通用工具类

下面这些不限站点（个别带站点规则表），每个目录下的 `notes.md` 写了实现思路、踩过的坑和已知限制。

| 脚本 | 做什么 |
|---|---|
| [copy-unlock](./copy-unlock/copy-unlock.user.js) | 解除禁止选中 / 禁止右键 / 复制追加版权尾巴；CSDN 代码块免登录复制；按站点开关 |
| [link-direct](./link-direct/link-direct.user.js) | 跳过知乎、掘金、CSDN、简书、QQ、Steam 等二十多个站点的「即将离开」中转页，可选去掉 utm 追踪参数 |
| [video-speed](./video-speed/video-speed.user.js) | 任意网站 HTML5 视频快捷键调速、快进快退，按站点记住倍速，站点重置倍速后自动恢复 |
| [page-to-markdown](./page-to-markdown/page-to-markdown.user.js) | 自动识别文章正文，转成干净的 Markdown（表格、代码块、嵌套列表、front-matter），复制或下载；提取不准时可手动选区 |
| [table-export](./table-export/table-export.user.js) | 悬停任意表格即可复制 TSV / Markdown，下载 CSV（带 BOM，Excel 不乱码）/ JSON；正确展开合并单元格，支持 ARIA 表格 |
| [form-saver](./form-saver/form-saver.user.js) | 输入框、富文本自动存草稿，误关页面回来一键恢复；兼容 React 受控组件；不存密码、卡号、验证码 |
| [image-gallery](./image-gallery/image-gallery.user.js) | 收集页面所有图片（srcset 最大图、懒加载、背景图）成画廊，大图查看缩放旋转，勾选批量下载 |
| [translate-selection](./translate-selection/translate-selection.user.js) | 划词翻译，中英自动互译，单词显示词典释义，Google 接口失败自动降级 MyMemory，可朗读 |
| [article-toc](./article-toc/article-toc.user.js) | 给长文章生成浮动目录，滚动高亮当前章节，跳转扣除吸顶导航栏，可拖动折叠，支持 SPA |
| [search-switcher](./search-switcher/search-switcher.user.js) | 搜索结果页带上同一关键词一键切换百度 / Google / Bing / GitHub / 知乎 / B 站等，可自定义引擎列表 |
| [auto-pager](./auto-pager/auto-pager.user.js) | 自动翻页：识别「下一页」（rel=next / 文字 / 页码），滚到底拼接下一页内容，支持 GBK 页面，失败可重试 |
| [github-enhancer](./github-enhancer/github-enhancer.user.js) | GitHub 增强：仓库大小与创建时间、单文件下载、目录 sparse-checkout 命令、复制 raw / 永久链接、相对时间旁显示绝对时间 |
| [dark-mode](./dark-mode/dark-mode.user.js) | 通用暗色模式：document-start 注入不闪白，自动识别本来就是暗色的站点，按站点 / 跟随系统 / 定时切换 |
| [page-monitor](./page-monitor/page-monitor.user.js) | 网页变化监控：点选页面上一块区域，定时检查，内容变化（关键词、价格阈值）时通知并显示逐词差异 |
| [qr-code](./qr-code/qr-code.user.js) | 页面二维码：当前网址 / 选中文字 / 悬停链接生成二维码，编码器自实现（经 ZXing 解码与 ISO 18004 样例验证） |
| [keyboard-nav](./keyboard-nav/keyboard-nav.user.js) | Vimium 风格键盘浏览：j/k/gg/G 滚动、f/F 链接提示（含 shadow DOM）、数字前缀、直通模式、站点黑名单 |
| [element-hider](./element-hider/element-hider.user.js) | 网页元素屏蔽：点选隐藏广告和烦人元素，生成跳过随机类名的稳定选择器，按站点记住，可撤销、导入导出 |
| [pangu-spacing](./pangu-spacing/pangu-spacing.user.js) | 中英文之间自动加空格（盘古之白），跨元素边界，不破坏 URL / 版本号 / C++ / 100%，只改文本节点 |
| [scroll-memory](./scroll-memory/scroll-memory.user.js) | 阅读位置记忆：按锚点而不是像素记位置，懒加载插入内容后仍能回到原处；附回顶 / 回底按钮与进度 |
| [overlay-killer](./overlay-killer/overlay-killer.user.js) | 弹窗遮罩清理：Cookie 同意弹窗优先点「拒绝」，隐藏登录 / 打开 App 遮罩并恢复滚动，展开「阅读全文」折叠 |
| [site-timer](./site-timer/site-timer.user.js) | 网站使用时长：只算可见且在用的时间，多标签不重复计，可设每日上限，超时遮罩提醒，7 天排行 |
| [image-search](./image-search/image-search.user.js) | 以图搜图：Alt+右键图片用 Google Lens / Bing / 百度 / SauceNAO 等反查，内网与 blob 图自动改走上传 |

## 测试

每个脚本的 `test/run.cjs` 用 [tools/userscript-harness.cjs](./tools/userscript-harness.cjs) 在 Playwright 里加载脚本、模拟 `GM_*`，全程离线。仓库不带 `node_modules`，借一个装了 `playwright` 的目录：

```bash
NODE_PATH=/path/to/node_modules node <script>/test/run.cjs
```

## 安装

在 Tampermonkey 中新建脚本，粘贴对应 `*.user.js` 的内容即可；或在浏览器打开脚本文件的 raw 链接（需先关联 GitHub 远程仓库）由 Tampermonkey 自动识别安装。
