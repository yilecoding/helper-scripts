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

## 安装

在 Tampermonkey 中新建脚本，粘贴对应 `*.user.js` 的内容即可；或在浏览器打开脚本文件的 raw 链接（需先关联 GitHub 远程仓库）由 Tampermonkey 自动识别安装。
