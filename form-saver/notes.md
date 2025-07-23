# form-saver —— 表单草稿自动保存

写了半天的评论 / 工单 / 帖子，误关标签、页面崩溃、提交失败跳走后内容全没了。
这个脚本在任意网页上自动存草稿，回到页面时在右下角提示「检测到 N 个字段的草稿 → 恢复 / 忽略」。

## 做什么

- 监听 `input` / `textarea` / `select` / `contenteditable` 的输入，停止输入 800ms 后落盘；
  刷新、关标签、跳走、切到后台时立即落盘。
- 回到页面，有草稿且对应字段**是空的**，右下角浮出提示条；点「恢复」才填，从不自动覆盖。
- 菜单：本页草稿（列表、单条恢复 / 删除、清除本页）、本站按 URL 参数区分页面、本站停用 / 启用、清除全部草稿。

## 存了什么（隐私）

存在 Tampermonkey 的脚本存储里（`GM_setValue`），**不出本机、不发任何网络请求**。每个站点一个键 `fs:d:<origin>`：

```
{ "<页面键>": { t, title, dismissedAt?, fields: { "<字段键>": { v, k, l, t, s? } } } }
```

| 字段 | 含义 |
|---|---|
| 页面键 | `origin + pathname`（+ 本站开启时的 query，去掉 utm_* 等跟踪参数并排序）+ hash 路由（`#/…`） |
| `title` | 页面标题前 80 字，菜单列表里显示用 |
| 字段键 | 锚（form 的 id/name/序号，或最近的稳定 id 祖先）+ 字段的 name / id / 结构路径 |
| `v` | 字段的值：文本、勾选状态、选中项；富文本是**清洗过的** HTML |
| `l` | 字段的标签（aria-label / placeholder / label 文本 / name），前 40 字 |
| `t` / `s` | 最后编辑时间 / 提交时间 |

**绝不保存**（`isSecretField` + `looksLikeCardNumber`）：

- `type` 为 `password` / `hidden` / `file` 的 input，以及按钮类 input；
- `autocomplete` 含 `cc-*`、`one-time-code`、`new-password`、`current-password`；
- name / id / autocomplete / placeholder / aria-label / label 文本像密码、PIN、卡号、CVV、有效期、验证码、
  OTP / 2FA、captcha、身份证、SSN（中英文关键词）；
- **值**像银行卡号（13~19 位数字、过 Luhn 校验）的字段 —— 字段名起得再无害也不存，已存的旧值一起删；
- 含有（或出现过）密码框的整张表单（登录 / 注册表单）；
- `disabled` / `readonly` 字段。

本站停用时，本站已存的草稿一并删除。草稿最后编辑后 **7 天**过期，每次启动扫一遍**所有**站点的草稿。

## 怎么实现的 / 关键的坑

### 1. React 受控组件：恢复要用原型上的原生 setter

React 在每个受控 input 实例上装了 `value` 拦截器（inputValueTracking），记录「它认为的当前值」。
input 事件来时它拿 `el.value` 跟记录比，相同就不触发 `onChange`。直接 `el.value = v` 走的是实例上的拦截器，
记录也被改成 `v` → 事件发出去 React 判定没变 → state 还是空 → 下次渲染把输入框改回空。
`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)` 绕过拦截器，
记录停在旧值，随后派发的 `input` 事件才算数。之后再派发 `change`（Vue `.lazy`）。

checkbox / radio 用 `el.click()`：浏览器的激活行为会改 `checked` 并派发 click/input/change，
React 的 checkbox `onChange` 挂在 click 上，只发 change 它收不到。

### 2. React 受控组件：初始值要快照，不能现读 `defaultValue`

「字段没被动过」的判断原本是 `value === defaultValue`。但 React 每次渲染都会把 `defaultValue`
（input 的 value 属性、textarea 的 defaultValue）同步成当前值 —— 于是所有 React 输入框都被判成「没动过」，
**一个字都存不下来**。现在在 `focusin` / 第一次 `input`（捕获阶段，React 重新渲染之前）拍快照。
富文本没有 `defaultValue` 可回溯，启动时和 DOM 变化后趁还没人动先拍。

### 3. SPA 的随机 id

`:r1:`（React useId）、`mui-38291`、`el-id-1024-17`、uuid、nanoid…… 每次渲染都变，拿来当键刷新后就对不上了。
`looksRandom()` 认出这类 id/name 后降级到**结构路径**；路径从「锚」开始算（form，或最近的带稳定 id 的祖先如 `#app`），
不从 body 算 —— 否则页面顶上插一条 cookie 横幅，所有路径整体错位。

字段晚于脚本渲染、路由切换，都靠 `MutationObserver` 发现（路由切换必然伴随 DOM 变化，不用去改 `history.pushState`）。

### 4. SPA 换页复用同一个输入框

聊天 / 工单类 SPA 切换会话时常复用同一个输入框并用程序清空。防抖落盘按「编辑时的页面键」写、却按「落盘时的值」判断，
不处理的话会把上一页的草稿当成「用户删光了」删掉；「程序清空 = 发送成功」的检测也会误判。
所以路由变了之后的「变空」一律不算数。

### 5. 提交后什么时候删

- **页面内提交**（`submit` 被 `preventDefault`，AJAX）：1.5s / 4s 后看表单 —— 被清空了 = 成功，删；
  内容还在 = 失败（校验没过），取消提交标记，草稿照常保留。
- **跳转式提交**：页面走了，结果看不到。草稿打上提交标记 `s` 保留 **1 小时**；这期间回到原页面且字段是空的，
  提示写明「刚提交过的内容，如果提交没成功，可以恢复」；对它点「忽略」就删（多半是成功了）；过了 1 小时自动删。
- **没有 `<form>` 的输入框**（回车发送的聊天框）：存过的字段被页面自己清空（没有 input 事件）就当作已发送，删掉。
- 表单 `reset`：用户明确不要了，删。

### 6. 其他

- 防抖期间刷新 / 关标签会丢掉最后几个字 —— 恰恰是最想保住的那几个。`pagehide` 和 `visibilitychange → hidden` 时立即落盘。
- 富文本恢复先走 `execCommand('insertHTML')`（像粘贴一样经过 beforeinput/input，ProseMirror / Quill 能跟着更新模型），
  不生效才退回 `innerHTML`。HTML 存之前洗一遍、恢复前再洗一遍（`<template>` 解析，去掉 script/iframe/事件属性/`javascript:` 链接等）。
- 提示条在 shadow DOM 里，宿主元素用内联 `!important` 定位，页面写 `form-saver-ui { display: none }` 也盖不过。
- 「忽略」不删草稿，只是这份草稿不再自动提示（之后再编辑会重新提示）；误点了还能从菜单「本页草稿」里找回。
- 上限：单站点最多 50 个页面、草稿总体积 512K 字符，超了从最久没编辑的页面开始丢；单个字段超过 2 万字符不存。

## 已知限制

- 不进 iframe（`@noframes`）：iframe 里的编辑器（老式 TinyMCE、第三方评论框）不覆盖。
- shadow DOM 里的字段（Web Components 内部的 input）不覆盖。
- 自己维护文档模型的富文本编辑器（Slate、Lexical、CodeMirror、Monaco 等）恢复不保证生效；纯文本 `textarea` / 简单 contenteditable 可靠。
- 结构路径对改版敏感：没有稳定 name/id 的字段，页面改版后可能对不上（对不上就不提示）；极端情况下结构变了但路径恰好落到另一个空字段上，会填错位置 —— 恢复前提示条只给数量，填完请过目。
- 跳转式提交的成败无法确知；成功后 1 小时内回到同一页会看到一次「刚提交过」的提示。
- 敏感字段判别靠关键词，宁可错杀：带「密码」字样标签的普通字段也不会存。
- GM 存储按脚本全局共享，同一台机器上的同一个浏览器配置里，任何能读脚本存储的人都能看到草稿明文。

## 怎么跑测试

```bash
NODE_PATH=<装了 playwright 的 node_modules> node form-saver/test/run.cjs
# 例如本机：
NODE_PATH=/home/yujie_ao/code/fastapi-react-admin/node_modules/.pnpm/playwright@1.62.1/node_modules node form-saver/test/run.cjs
```

用 `tools/userscript-harness.cjs` 在 Playwright 里加载脚本、模拟 `GM_*`（存储在同源 localStorage，刷新能读回）。
页面用 `page.route` 挂在假域名上（`https://forum.test` 等），**不访问外网**。fixtures：

| 文件 | 场景 |
|---|---|
| `basic.html` | 最简发帖表单，记录收到的 input/change 次数 |
| `fields.html` | 各种字段类型：name / id / 无标识 / select / 多选 / radio / checkbox / 同名字段 |
| `privacy.html` | 登录表单、「显示密码」、hidden、file、cc-*、一次性验证码、验证码 / 卡号关键词、值像卡号 |
| `react.html` | React 受控组件的最小模拟：实例上的 value tracker、事件比对、渲染回写 state、同步 defaultValue |
| `spa.html` | pushState 路由、异步渲染、无 form 无 name、随机 id、二次加载插 cookie 横幅 |
| `inbox.html` | 切换会话复用同一输入框并清空 |
| `rich.html` | contenteditable |
| `ajax.html` / `done.html` / `chat.html` | 页面内提交成功 / 失败、跳转提交、无 form 的回车发送 |

harness 的已知差异：GM 存储按 origin 隔离（真实环境全局共享），所以「清除全部」「过期扫所有站点」的测试
把别的站点的键预置在同一个 origin 的存储里。
