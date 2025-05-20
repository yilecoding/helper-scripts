# table-export 开发笔记

任意网页上的表格一键导出 / 复制。脚本本体：[table-export.user.js](./table-export.user.js)。

## 做什么

- 鼠标移到表格上，表格右上角浮出工具条：**复制 TSV**（直接粘贴进 Excel / WPS / Google 表格）、**复制 MD**（Markdown 表格）、**下载 CSV**、**下载 JSON**。
- Tampermonkey 菜单：
  - 「导出页面上所有表格（逐个 CSV）」—— 每张表一个文件
  - 「导出页面上所有表格（合并为一个 JSON）」—— 只下载一个文件，`{ title, url, exportedAt, tables: [{ name, header, rows }] }`
  - 「合并单元格：每一格都填 / 只填第一格（点击切换）」—— 存在 GM 存储里
- 文件名：`<caption>` → `aria-label` → `aria-labelledby` 指向的文字；都没有就是「页面标题-表格N」。

## 怎么实现的

整个流程是 **原始行 → 展开 → 序列化**，两类表格只在第一步有区别：

```
原生 <table> ─┐
              ├─ rawRows() → [{ group, header, cells: [{ text, rowSpan, colSpan, col? }] }]
ARIA 表格 ────┘                │
                               ▼
                          expand()  按 HTML 表格模型摊平合并单元格 → 矩形二维数组
                               │    另带 headerRows / header（表头键）
                               ▼
                 toCSV / toTSV / toMarkdown / toJSON
```

### 表格识别

- 原生：`table`。ARIA：`[role=table|grid|treegrid]` 下的 `role=row`，格是 `cell|gridcell|columnheader|rowheader`。
  行和格都要求「最近的那张表就是我」，嵌套子表的行不会混进外层。
- `<table role="grid">` 仍按原生表格读（看标签名，不看 role）。
- **布局表格判据**（原生表格，命中任一条就跳过）：
  | 判据 | 典型样子 |
  |---|---|
  | `role="presentation"` / `"none"` | 作者明确声明 |
  | 内含嵌套 `<table>` 且自己没有 `caption` / `thead` / `th` | 整页排版的外层容器 |
  | 被套在 2 层以上的 `<table>` 里 | 老式排版的最内层碎片 |
  | 可见行 < 2 | 一行导航按钮 |
  | 列数 < 2 | 竖排版块 |
  | 没有任何文字 | 图片网格、间隔条 |

  阈值在 `CONFIG.minRows / minCols / maxNestDepth`。ARIA 表格只看后三条（写了 role=grid 就是作者声明的数据表）。

### 合并单元格

- `expand()` 按 HTML 表格模型走：每个格落在本行第一个没被占的位置，占住 rowspan × colspan 的区域。
- `CONFIG.mergeFill`（菜单可切）：`all` = 被覆盖的每一格都填同值；`first` = 只填左上角。
- 表头键（JSON 的键、Markdown 的表头）固定按 `all` 算，多行表头每列去重后用 `/` 连：两行表头「周一」+「上」→ `周一/上`。

### 工具条

- 宿主是自定义标签 `<table-export-toolbar>`，挂在 `<html>` 下，`position: fixed`，样式全在 open shadow root 里。
- 位置按表格的**可见矩形**算：表格矩形与每一层 `overflow` 非 visible 的祖先、视口取交集，右对齐；上沿外侧放得下就放外侧，否则压进表格右上角。
- 悬停检测是 `window` 捕获阶段的 `mouseover` 委托，所以 SPA 晚渲染的表格不用额外处理。
- `ResizeObserver` 盯着当前表格：表格变宽重新对齐，被卸载就收起。

## 关键的坑

1. **CSV 必须带 UTF-8 BOM，JSON 必须不带。** 没有 BOM，Excel 双击打开 CSV 按本地编码（中文 Windows 是 GBK）解析，中文全乱码。
   JSON 反过来：带 BOM 的话 Python `json.load` 直接 `JSONDecodeError: Unexpected UTF-8 BOM`（已实测）。所以 `download()` 的 BOM 是按格式开的，不是全局加。

2. **隐藏的行 / 格要在展开「之前」剔除，不能展开完再删。** Chromium 实测：
   - `rowspan="2"` 的格下面紧跟一个 `display:none` 的行，它会跨到**再下面那个可见行**
   - 一行里隐藏一个格，右边的格整体**左移一列**

   先展开再删，这两种情况都会错位。测试 `hidden.html` 里拿渲染后的坐标和导出结果对了一遍。

3. **rowspan 不跨行组。** tbody 最后一行写 `rowspan="5"` 不会延伸进 tfoot；`rowspan="0"` 表示延伸到行组末尾（`cell.rowSpan` 也确实返回 0）。

4. **`table.rows` 的顺序是 thead → tbody → tfoot，与源码顺序无关。** 老页面常把 `<tfoot>` 写在 `<tbody>` 前面（HTML4 写法），按 DOM 顺序遍历的话合计行会跑到表头下面。

5. **TSV 也要引号转义。** 单元格里有换行不加引号，粘贴进 Excel 会被当成新的一行，整表错位。规则跟 Excel 自己复制单元格时一样：含制表符 / 换行 / 双引号的格加双引号，内部双引号写两遍。

6. **Markdown 的 `|` 必须转义成 `\|`**，否则被当成列分隔符；换行在 GFM 表格里不合法，换成 `<br>`。

7. **悬停判断不能扫整表。** 早先版本每次 `mouseover` 都把整张表的行列数一遍，5000 行 × 10 列的表实测**每次 ~56ms**，鼠标一动就卡。
   现在：还在当前表格里移动直接放行；新表格的判断「满 2 行 2 列且有文字」就停。悬停判断也不碰 `innerText`（会强制排版）。

8. **工具条不能插在表格旁边。** 插进表格的祖先里会被 `overflow: hidden/auto` 的容器裁掉 —— 横向滚动的宽表基本都是这种。
   挂在 `<html>` 下 + `position: fixed` + 按可见矩形定位才行；宿主 `pointer-events: none`，只有按钮接收点击，空白处不挡表格。

9. **只靠 scroll / resize 事件定位不够。** 表格自己变宽、被 SPA 卸载时这两个事件都不触发，工具条悬在原地，点下去导出的是脱离文档的表 ——
   实测得到一个只有 BOM + 换行的空 CSV。现在用 `ResizeObserver` 跟踪，点击时也再检查一次 `isConnected`。

10. **虚拟滚动表格（AG Grid 这一类）的 DOM 顺序不是显示顺序。** 冻结列把一行拆进左/中/右三个容器、行节点滚动时被复用挪位。
    每一行都带 `aria-rowindex` 时按它合并、排序；每个格都带 `aria-colindex` 时按它落位，以全表最小列号为第 0 列（横向也虚拟化时左边可能从第 5 列开始）。

11. **下载用 `<a download>` + Blob，不用 `GM_download`。** `GM_download` 只放行 Tampermonkey 设置里白名单中的扩展名，
    不在名单就报 `not_whitelisted`，要用户自己去加 `.csv` / `.json`。`<a download>` 不需要授权。

12. **菜单只在顶层注册。** 脚本在每个 iframe 里都会跑一份，各注册一遍菜单里就会出现 N 个同名命令。顶层那份会顺带扫所有同源 iframe；工具条则每个 frame 自己管自己。

## 已知限制

- **虚拟滚动只能导出已渲染的行。** 几万行的表只渲染屏幕上那几十行，没渲染的拿不到（要拿全得翻页或走接口）。
- **跨域 iframe 里的表**不在「导出全部」里（读不到它的 document）；鼠标移上去的工具条仍然可用。
- **Web Components 的 shadow DOM 里的表格**识别不到（`querySelectorAll` / `closest` 不穿透 shadow root）。
- 纯 div 拼、**没有任何 role** 的「表格」识别不到 —— 没有可靠判据，不猜。
- 单元格文本走 `innerText` 语义：视觉隐藏但仍在渲染树里的文字（`sr-only` 那种 clip 掉的读屏提示）会被带出来。
- 值一律保留字符串（JSON 不转数字，避免吃掉「001」的前导零、长编号丢精度）；
  但 CSV 用 Excel 打开时 Excel 自己会把长数字转成科学计数法、去掉前导零，这是 Excel 的行为，脚本管不了。
- CSV 不做公式注入防护：`=`、`+`、`-`、`@` 开头的单元格在 Excel 里会被当公式。
- 工具条在表格上沿外侧放不下时（表格贴着视口顶部）会压住表格右上角一小块。
- 表头只按 `<thead>` / 整行 `columnheader` 判断；没有这些标注的表默认第一行是表头。
- 只在 Chromium（Playwright）里测过；Firefox 下 Tampermonkey 沙箱里的 Blob 下载未验证。

## 怎么跑测试

用仓库里的 [`tools/userscript-harness.cjs`](../tools/userscript-harness.cjs)：Playwright 打开 `test/fixtures/` 下的本地页面，注入脚本并模拟 `GM_*`。仓库不带 `node_modules`，借一个装了 playwright 的目录：

```bash
NODE_PATH=/path/to/node_modules node table-export/test/run.cjs
```

- 下载走 `<a download>`，不经过 `GM_download`，所以测试用 Playwright 的 `download` 事件接住真实文件、读字节断言（连 BOM 一起验）。
- 剪贴板看 harness 记录的 `GM_setClipboard` 调用。
- 工具条在 open shadow root 里，Playwright 的 CSS 选择器能直接穿进去点按钮：`table-export-toolbar button[data-action="copy-tsv"]`。

| fixture | 覆盖 |
|---|---|
| `layout.html` | 布局表格判据（嵌套、单列、无文字、presentation、过深） |
| `basic.html` | CSV 转义、BOM、`<br>` / 块级元素变换行、文件名清洗 |
| `complex.html` | rowspan/colspan 混合逐格断言、tfoot 写在前、rowspan=0、rowspan 越过 tbody |
| `toolbar.html` | 工具条出现 / 位置 / 不挡点击 / overflow 裁剪 / 页面样式隔离 |
| `formats.html` | Markdown `\|` 转义、JSON 重复键与空键 |
| `aria.html` | ARIA 表格识别、aria-colspan、嵌套子表、aria-labelledby |
| `hidden.html` | 隐藏行 / 列 / 行组，rowspan 跨隐藏行与渲染坐标对照 |
| `virtual.html` | aria-rowindex 合并冻结列、乱序、aria-colindex 落位 |
| `frames.html` | 同源 iframe、合并 JSON、菜单只注册一次 |
| `dynamic.html` | SPA 晚渲染、滚动、表格变宽 / 卸载、5000 行悬停性能 |
