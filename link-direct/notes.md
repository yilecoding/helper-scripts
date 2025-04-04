# 外链直达（link-direct）开发笔记

## 做什么

国内很多站点把站外链接包一层中转页（「即将离开知乎」「安全提醒」），点一次要多等一页、多点一下。
脚本做两件事：

1. **在宿主页上**把 `<a href="https://link.zhihu.com/?target=…">` 直接改成真实地址；
2. **万一已经落到中转页本身**（从地址栏、书签、别的 App 打开），立即 `location.replace(真实地址)`。

## 怎么实现的

```
规则表 RULES ─→ resolveRaw(href)：host 精确匹配 → path 正则 → 按顺序取参数
                     │  paramValue()  未编码的目标取到 hash 结尾（见「坑」2）
                     │  rule.decode   站点私有编码（Bing 的 a1+base64）
                     │  unwrap()      剥多重 URL 编码 / 试一次 base64
                     │  sanitize()    只放行 http/https
                     └→ 目标又是中转链接就继续往里追（最多 3 层）
               resolve() = resolveRaw + 按开关去追踪参数
```

改写链接的三条路径，各管一类情况：

| 路径 | 管什么 |
|---|---|
| `DOMContentLoaded` 时 `scan(document)` | 首屏静态链接 |
| `MutationObserver`（childList + `href` 属性） | SPA 翻页 / 懒加载插入的链接；站点先渲染直链、后把 `href` 换成中转的情况 |
| 捕获阶段的 `mousedown` / `click` / `auxclick` / `contextmenu` | Shadow DOM 里的链接（observer 和 `querySelectorAll` 都看不进去，`composedPath()` 能）；mousedown 时临时改 href 的站点 |
| 包一层 `window.open` | 站点拦掉 `<a>` 默认行为、自己 `window.open(中转地址)` 的情况 |

中转页本身在 `document-start` 判断，命中就 `replace`，不等页面渲染。

菜单两项：`🔗 本页已处理 N 个链接`（点开看按规则的分布）、`✅/⬜ 去追踪参数`（存在 GM 存储里）。

## 规则表

参数名来自各站点公开可见的链接样本，**没有在真实站点上实测**（测试全部离线，用 fixture 构造的链接）。
按把握程度分两档：

| 站点 | 中转地址 | 参数 | 把握 |
|---|---|---|---|
| 知乎 | `link.zhihu.com/` | `target` | 常见格式，较确定 |
| 掘金 | `link.juejin.cn/` | `target` | 较确定 |
| CSDN | `link.csdn.net/` | `target` | 较确定 |
| 简书 | `www.jianshu.com/go-wild` | `url` | 较确定 |
| Gitee | `gitee.com/link` | `target` | 较确定 |
| Google | `www.google.com/url` | `q`（Gmail / 文档）· `url`（搜索结果） | 较确定 |
| YouTube | `www.youtube.com/redirect` | `q` | 较确定 |
| Steam | `steamcommunity.com/linkfilter/` | `url`（未编码）· `u` | `url` 较确定；`u` **未实测** |
| Facebook | `l.facebook.com/l.php` | `u` | 较确定 |
| QQ / TIM | `c.pc.qq.com/middlem.html` | `pfurl` | 较确定 |
| QQ / TIM | `c.pc.qq.com/ios.html` · `pc.html` | `url` | **未实测** |
| 微博 | `weibo.cn/sinaurl` | `u` · `toasturl` | `u` 较确定；`toasturl` **未实测** |
| 腾讯文档 | `docs.qq.com/scenario/link.html` | `url` | **未实测** |
| 开源中国 | `www.oschina.net/action/GoToLink` | `url` | **未实测** |
| 爱发电 | `afdian.com/link`（及 `afdian.net`、`ifdian.net`） | `target` | **未实测** |
| SegmentFault | `link.segmentfault.com/` | `enc` 加密；只在同时带明文 `url` 时处理 | **未实测**（明文 `url` 是否存在不确定） |
| 少数派 / InfoQ / 力扣 | `sspai.com/link` · `www.infoq.cn/link` · `xie.infoq.cn/link` · `leetcode.cn/link/` | `target` | **未实测** |
| 链滴 | `link.ld246.com/forward` | `goto` | **未实测** |
| 豆瓣 | `www.douban.com/link2/` | `url` | **未实测** |
| 百度贴吧 | `tieba.baidu.com/mo/q/checkurl` | `url` | **未实测** |
| 微信开放社区 | `developers.weixin.qq.com/community/middlepage/href` | `href` | **未实测** |
| QQ 邮箱 | `mail.qq.com/cgi-bin/readtemplate` | `gourl` | **未实测** |
| 语雀 | `www.yuque.com/r/goto` | `url` | **未实测** |
| 金山文档 | `www.kdocs.cn/office/link` | `target` | **未实测** |
| Instagram | `l.instagram.com/` | `u` | **未实测** |
| Bing | `www.bing.com/ck/a` · `cn.bing.com/ck/a` | `u` = `a1` + base64url | **未实测** |

规则写错的代价是「这个站点不生效」，不会改坏链接：参数取不到就不动；取到的不是 http(s) 也不动。

加规则：往 `RULES` 里加一行，再在 `test/fixtures/rules.html` 里加一条样本（测试会检查每条规则的首个 host 都有样本）。

## 关键的坑

1. **目标地址必须校验协议。** 中转参数由链接作者控制。原样写进 `href` 的话，`target=javascript:alert(1)`
   本来会被站点中转页拦下，经过脚本反而成了能直接点的 XSS。`sanitize()` 只放行 `http:`/`https:`，
   并且放在解码**之后** —— 双重编码 / base64 包一层的 `javascript:` 一样被拒。
   相对地址（`/settings`、`//evil.com`）也拒绝。

2. **未编码的目标会被外层 URL 解析吃掉。** Steam 是 `?url=https://example.com/s?a=1&b=2#sec` 原样拼接，
   `searchParams.get('url')` 拿到的是 `https://example.com/s?a=1` —— `&b=2` 被当成外层参数、
   `#sec` 被当成外层 hash；`q=c++` 的 `+` 还会被当成空格（再被 trim 成 `q=c`）。
   测试里实测出来的。现在参数值以裸 `http(s)://` 开头时，取到 hash 结尾的全部原文。

3. **多重编码只剥到出现协议头为止。** 真实地址自己就可能含 `%20`、`%2F`，已经是 `https://…` 了还继续
   `decodeURIComponent`，会把目标本身的编码也剥掉。

4. **去追踪参数不能用 `searchParams.delete()`。** 删完 `URLSearchParams` 会把剩下的参数整体重新序列化
   （`%20` → `+` 等），有的服务端对两者不一视同仁。现在在原始 query 字符串上按 `&` 拆了过滤，
   没删到东西就原样返回。默认只去 `utm_*`：`spm`、`from` 这种名字太常见，有站点拿它当正常参数。

5. **中转页跳转用 `location.replace`，不能赋值。** 赋值会在历史里留下中转页，在目标页点「后退」
   回到中转页，又被脚本弹回目标页，后退键形同失效。测试用「后退回到 about:blank」来验证。

6. **编辑器里的链接不碰。** `contenteditable` 里改 DOM 会和编辑器的文档模型打架，严重的会把改写后的地址
   存进草稿 —— 那就成了改用户的内容。`fixAnchor()` 遇到 `isContentEditable` 直接跳过，点击兜底也一样。

7. **菜单只在顶层页面注册。** `@match` 匹配所有页面，每个 iframe 都跑一份脚本，不限制的话 Tampermonkey
   菜单里会出现好几组重复项。iframe 里的链接照常改写。

8. **块注释里别写 `@match` 的通配串。** 那串字符里有 `*/`，会提前结束 `/* … */` 注释，整个脚本语法错误。
   见下面「测试」里 harness 的问题。

## 已知限制

- **SegmentFault 的 `enc`** 是服务端加密的，前端解不开；只带 `enc` 的链接不处理，落到中转页也不跳。
- **站点在点击时 `location.href = 中转地址`**（不经过 `<a>` 也不经过 `window.open`）拦不住，只能等落到中转页后再 `replace`，
  多一次页面加载。
- **closed Shadow DOM** 里的链接看不到（`composedPath()` 也只给到宿主元素）。
- **iframe 里的计数**不汇总到顶层菜单。
- **去追踪参数开关**只影响之后改写的链接；已经改过的链接要刷新页面才按新设置重算（原始中转地址没有保留）。
- 未编码目标后面如果还跟着外层参数（`?url=https://x.com/&ref=steam`），这些参数会被并进目标地址 ——
  这种情况本来就无法区分，宁可多带参数也不截断目标。
- 只认规则表里的站点；短链（`t.cn`、`t.co`、`url.cn`）要请求服务端才知道去哪，不处理。

## 测试

```bash
NODE_PATH=/path/to/node_modules/.pnpm/playwright@<ver>/node_modules node link-direct/test/run.cjs
```

用的是仓库的 `tools/userscript-harness.cjs`。要点：

- 所有非本地请求都在 `context.route` 里回一个占位页（挂在 context 上，`window.open` 弹出的页也被拦），**不访问外网**。
  中转页 / 目标页都是这个占位页，按 URL 判断有没有跳对。
- fixture 里每个 `<a>` 用 `data-expect` 写期望地址，`keep` 表示应保持原样。比较 `keep` 时用一个**不装脚本**的页面读原始 href ——
  装了脚本的页面里属性已经被改了，读出来永远相等（第一版测试就这么假绿过一次）。
- 覆盖：每条规则的解析（`rules.html`）、多重编码 / base64 / 嵌套（`encoding.html`）、未编码目标（`raw.html`）、
  危险目标被拒（`unsafe.html`）、动态插入（`dynamic.html`）、点击兜底与 `window.open`（`click.html`）、
  中转页自动跳转与不跳转、去追踪参数与开关、菜单计数、编辑器与 iframe（`edge.html`）。

**harness 的问题（没改 `tools/`，在测试里绕开）：** 脚本有语法错误时，harness 的 `new Function(...)` 抛出的异常只变成一条
`pageerror`，页面照常打开、脚本静默不生效，表现是所有用例都「链接没被改写」，看不出根因。
`run.cjs` 第一条用例先用 `vm.Script` 单独编译一遍脚本来兜住。
