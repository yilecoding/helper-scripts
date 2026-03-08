<div align="center">

# helper-scripts

**23 个实用油猴脚本：自动刷课连播、阅读增强、去广告弹窗、解除复制限制、一键导出……装上就能用。**

[![GitHub stars](https://img.shields.io/github/stars/yilecoding/helper-scripts?style=social)](https://github.com/yilecoding/helper-scripts/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Scripts](https://img.shields.io/badge/scripts-23-brightgreen.svg)
![Tampermonkey](https://img.shields.io/badge/Tampermonkey-ready-00485B.svg)

</div>

> A collection of 23 Tampermonkey userscripts, mostly for Chinese websites: an auto-play helper for the 2026 SmartEdu teacher training (the most popular one), plus general tools for reading, de-cluttering, copying, exporting and browsing. Click **安装** in any table below to install.

- **装上就能用**：点表格里的「安装」，Tampermonkey 会自动弹出安装页，之后自动更新。
- **不乱改网页**：通用脚本大多能在菜单里按站点停用，不打扰本来正常的网站。
- **每个都有测试**：22 个通用脚本都带离线自动化测试；每个目录下的 `notes.md` 写了实现思路、踩过的坑和已知限制。

## 目录

- [快速开始](#快速开始)
- [脚本一览](#脚本一览)
  - [⭐ 2026 暑期教师研修自动连播助手](#-2026-暑期教师研修自动连播助手)
  - [阅读体验](#阅读体验)
  - [去干扰与解除限制](#去干扰与解除限制)
  - [导出与下载](#导出与下载)
  - [搜索与浏览效率](#搜索与浏览效率)
  - [实用工具](#实用工具)
- [开发与测试](#开发与测试)
- [许可证与声明](#许可证与声明)

## 快速开始

1. **安装脚本管理器 Tampermonkey**（篡改猴）：[Chrome](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo) · [Edge](https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd) · [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/) · [官网](https://www.tampermonkey.net/)
2. **Chrome / Edge 用户多做一步**：打开扩展管理页 → Tampermonkey「详细信息」→ 打开「允许用户脚本」（旧版浏览器是打开右上角的「开发者模式」）。不开的话脚本不会运行。
3. **在下面的表格里点「安装」**，在弹出的页面点「安装」，然后刷新要用的网页即可。

> 其他脚本管理器（Violentmonkey、ScriptCat 等）一般也能用，但没有专门测试过。

## 脚本一览

### ⭐ 2026 暑期教师研修自动连播助手

> 国家中小学智慧教育平台（`basic.smartedu.cn`）· 2026 年「暑期教师研修」专题（基础教育）· **本仓库使用人数最多的脚本**
>
> **[👉 点击安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/smartedu-2026-basic/smartedu-2026-basic.user.js)** · [平台调研与开发笔记](./smartedu-2026-basic/notes.md)

**能做什么**

- **自动发现课程**：从平台接口读出专题里的全部课程，面板列出课程名、学时上限和学习进度，不用手动填课程链接。
- **一键连播**：点一门课开始，自动展开所有章节，跳过已学完的，播完立刻接下一个；打开「自动续学」后，学完一门自动进入下一门。
- **倍速播放**：默认 2 倍速（平台本身允许倍速），面板里可以改；平台把倍速改回去时会自动恢复。
- **后台继续播**：切到别的标签页、最小化窗口，视频也不会停。
- **课堂练习**：遇到练习弹窗自动作答并提交（没有题库：单选选第一个，多选选前两个）。
- **挂一整天也稳**：每看完 5 个视频、连续出错或播放卡住 3 分钟，会自动刷新页面并接着学；有防止反复刷新的保护。
- **一键诊断**：遇到问题点「诊断」，报告会复制到剪贴板，可以直接发给作者。

**怎么用**

1. 按 [快速开始](#快速开始) 装好 Tampermonkey 和本脚本。
2. 登录 [basic.smartedu.cn](https://basic.smartedu.cn/)，打开 2026 暑期教师研修专题的任意页面。
3. 页面右侧会出现「研修助手」面板和课程目录，点一门课开始。
4. 之后可以把这个标签页放到后台，去做别的事。

**注意事项**

- **同一账号只在一个地方学**。平台检测到多个地方同时学习，会自动暂停本端，脚本会停下来提示你。请关掉手机 App 和其他浏览器里的学习页面。
- 第一次打开时会在后台逐门扫描学习进度，目录里的数字会陆续更新。
- 学时以平台记录为准，建议隔一段时间在平台上核对一下。
- 其他专题：改脚本开头 `CONFIG` 里的专题 ID 等三项即可适配。

### 阅读体验

| 脚本 | 做什么 | |
|---|---|---|
| **文章自动目录**<br>`article-toc` | 给长文章生成浮动目录，滚动时高亮当前章节，点击跳转时避开吸顶导航栏；顶部阅读进度条，可拖动、可折叠，支持单页应用 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/article-toc/article-toc.user.js) · [笔记](./article-toc/notes.md) |
| **阅读位置记忆**<br>`scroll-memory` | 长文、小说、文档读到一半关掉，回来时回到上次读到的地方。按段落而不是像素记位置，图片懒加载后也不会跑偏；附回到顶部 / 底部按钮和阅读进度 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/scroll-memory/scroll-memory.user.js) · [笔记](./scroll-memory/notes.md) |
| **通用暗色模式**<br>`dark-mode` | 任意网站一键变暗，页面加载前注入，不闪白；自动识别本来就是暗色的网站；可按站点开关、跟随系统或定时切换。快捷键 `Alt+Shift+D` | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/dark-mode/dark-mode.user.js) · [笔记](./dark-mode/notes.md) |
| **自动翻页**<br>`auto-pager` | 论坛、搜索结果、文章列表滚到底自动加载下一页并拼在后面；自动识别「下一页」，老论坛 GBK 编码不乱码，失败可重试 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/auto-pager/auto-pager.user.js) · [笔记](./auto-pager/notes.md) |
| **划词翻译**<br>`translate-selection` | 选中文字就能翻译，中英自动互译，单词显示词典释义，可朗读；Google 接口失败时自动换用备用接口。快捷键 `Alt+T` | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/translate-selection/translate-selection.user.js) · [笔记](./translate-selection/notes.md) |
| **中英文自动加空格**<br>`pangu-spacing` | 在中文和英文、数字之间自动加空格（盘古之白），不破坏网址、版本号、`C++`、`100%` 这类内容 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/pangu-spacing/pangu-spacing.user.js) · [笔记](./pangu-spacing/notes.md) |

### 去干扰与解除限制

| 脚本 | 做什么 | |
|---|---|---|
| **网页复制限制解除**<br>`copy-unlock` | 解除禁止选中、禁止右键、复制后追加版权尾巴；CSDN 代码块免登录复制；按站点开关 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/copy-unlock/copy-unlock.user.js) · [笔记](./copy-unlock/notes.md) |
| **外链直达**<br>`link-direct` | 跳过知乎、掘金、CSDN、简书、QQ、Steam 等二十多个网站的「即将离开」中转页，可选去掉 utm 追踪参数 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/link-direct/link-direct.user.js) · [笔记](./link-direct/notes.md) |
| **弹窗遮罩清理**<br>`overlay-killer` | Cookie 同意弹窗优先点「拒绝」；隐藏「打开 App」「登录后查看」遮罩并恢复滚动；展开「阅读全文」折叠。不误伤视频全屏和你自己打开的对话框 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/overlay-killer/overlay-killer.user.js) · [笔记](./overlay-killer/notes.md) |
| **网页元素屏蔽**<br>`element-hider` | 点选广告、浮窗、推荐栏一键隐藏，按站点记住，页面加载时就隐藏不闪烁；可撤销，可导入导出规则 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/element-hider/element-hider.user.js) · [笔记](./element-hider/notes.md) |

### 导出与下载

| 脚本 | 做什么 | |
|---|---|---|
| **网页正文转 Markdown**<br>`page-to-markdown` | 自动识别文章正文，转成干净的 Markdown（表格、代码块、嵌套列表都支持），复制或下载；识别不准时可以手动选区 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/page-to-markdown/page-to-markdown.user.js) · [笔记](./page-to-markdown/notes.md) |
| **网页表格导出**<br>`table-export` | 鼠标移到表格上即可复制（直接粘进 Excel）或下载 CSV / JSON / Markdown；正确展开合并单元格，CSV 用 Excel 打开不乱码 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/table-export/table-export.user.js) · [笔记](./table-export/notes.md) |
| **图片查看与批量下载**<br>`image-gallery` | 收集页面所有图片（自动取最大尺寸，包括懒加载图和背景图），网格浏览、放大旋转，勾选批量下载。快捷键 `Alt+Shift+I` | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/image-gallery/image-gallery.user.js) · [笔记](./image-gallery/notes.md) |
| **页面二维码**<br>`qr-code` | 把当前网址、选中的文字或链接变成二维码，手机一扫就打开；可下载或复制图片，不依赖外部库。快捷键 `Alt+Q` | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/qr-code/qr-code.user.js) · [笔记](./qr-code/notes.md) |

### 搜索与浏览效率

| 脚本 | 做什么 | |
|---|---|---|
| **搜索引擎一键切换**<br>`search-switcher` | 在搜索结果页带着同一个关键词，一键切到百度、Google、Bing、GitHub、知乎、B 站等，引擎列表可自定义 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/search-switcher/search-switcher.user.js) · [笔记](./search-switcher/notes.md) |
| **以图搜图**<br>`image-search` | 按住 `Alt` 右键点图片（或悬停按 `S`），用 Google Lens、Bing、百度、SauceNAO 等反查；本地和内网图片自动改为上传 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/image-search/image-search.user.js) · [笔记](./image-search/notes.md) |
| **键盘浏览**<br>`keyboard-nav` | Vimium 风格：`j`/`k` 滚动、`f` 显示链接提示后按字母打开、`H`/`L` 后退前进；在输入框里不拦截按键，按 `?` 查看全部快捷键 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/keyboard-nav/keyboard-nav.user.js) · [笔记](./keyboard-nav/notes.md) |
| **GitHub 增强**<br>`github-enhancer` | 显示仓库大小和创建时间；单个文件一键下载；复制 raw 链接、带行号的永久链接；「3 天前」旁边显示具体时间 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/github-enhancer/github-enhancer.user.js) · [笔记](./github-enhancer/notes.md) |

### 实用工具

| 脚本 | 做什么 | |
|---|---|---|
| **通用视频倍速**<br>`video-speed` | 任意网站的视频都能用快捷键调速：`Z` 减速、`X` 加速、`R` 恢复 1 倍、`G` 切到常用倍速、`Q`/`E` 快退快进；按站点记住倍速，网站把倍速重置时自动恢复 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/video-speed/video-speed.user.js) · [笔记](./video-speed/notes.md) |
| **表单草稿自动保存**<br>`form-saver` | 评论、工单、帖子写到一半误关页面，回来一键恢复；不保存密码、卡号、验证码；草稿 7 天后自动清除 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/form-saver/form-saver.user.js) · [笔记](./form-saver/notes.md) |
| **网页变化监控**<br>`page-monitor` | 选中页面上一块区域（价格、库存、公告、成绩），定时检查，内容变化或达到价格阈值时通知你，并标出具体改了什么 | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/page-monitor/page-monitor.user.js) · [笔记](./page-monitor/notes.md) |
| **网站使用时长统计**<br>`site-timer` | 只统计真正在用的时间，多个标签页不重复计算；可给网站设每日上限，超时全屏提醒；看今天和近 7 天排行，导出 CSV | [安装](https://raw.githubusercontent.com/yilecoding/helper-scripts/main/site-timer/site-timer.user.js) · [笔记](./site-timer/notes.md) |

## 开发与测试

每个脚本一个目录，目录名和脚本文件同名：

```
<script-name>/
  <script-name>.user.js   # 脚本本体
  notes.md                # 实现思路、踩过的坑、已知限制
  test/run.cjs            # 离线自动化测试
tools/
  userscript-harness.cjs  # 测试工具：在 Playwright 里加载脚本，模拟 GM_* 接口
```

测试全程离线。仓库不带 `node_modules`，需要指向一个装了 `playwright` 的目录：

```bash
NODE_PATH=/path/to/node_modules node <script-name>/test/run.cjs
```

测试环境和真实 Tampermonkey 的差异写在 [userscript-harness.cjs](./tools/userscript-harness.cjs) 开头的注释里。

## 许可证与声明

本仓库使用 [MIT 许可证](./LICENSE)。

脚本仅供学习交流。请遵守各网站的用户协议和相关规定，使用脚本产生的后果由使用者自行承担。
