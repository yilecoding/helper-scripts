// ==UserScript==
// @name         网页表格导出 | 一键复制/下载 CSV、Excel、Markdown、JSON
// @name:zh-CN   网页表格导出 | 一键复制/下载 CSV、Excel、Markdown、JSON
// @name:en      Table Export | Copy or download any web table as CSV / TSV / Markdown / JSON
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.05.14.9
// @description  任意网页上的表格一键导出：识别原生 <table>（自动排除排版用的布局表格）和 div 拼出来的 ARIA 表格（role=table/grid，React 表格组件常见），正确展开 rowspan/colspan 合并单元格。鼠标移到表格上，右上角浮出工具条：复制为 TSV（直接粘贴进 Excel）、复制为 Markdown 表格、下载 CSV（带 BOM，Excel 直接打开不乱码）、下载 JSON（表头当键）；菜单里可一键导出页面上所有表格（含同源 iframe），逐个下载 CSV 或合并成一个 JSON。
// @description:zh-CN  任意网页上的表格一键导出：识别原生 <table>（自动排除排版用的布局表格）和 div 拼出来的 ARIA 表格（role=table/grid，React 表格组件常见），正确展开 rowspan/colspan 合并单元格。鼠标移到表格上，右上角浮出工具条：复制为 TSV（直接粘贴进 Excel）、复制为 Markdown 表格、下载 CSV（带 BOM，Excel 直接打开不乱码）、下载 JSON（表头当键）；菜单里可一键导出页面上所有表格（含同源 iframe），逐个下载 CSV 或合并成一个 JSON。
// @description:en  Export any table on any web page. Detects native <table> elements (skipping layout-only tables) and div-based ARIA grids (role=table/grid, common in React table components), expands rowspan/colspan merged cells. Hover a table to get a small toolbar: copy as TSV (paste straight into Excel) or Markdown, download CSV (with UTF-8 BOM so Excel opens Chinese text correctly) or JSON (header row as keys). Menu commands export every table on the page (same-origin iframes included) as separate CSV files or one combined JSON.
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @license      CC BY-NC-SA
// @run-at       document-idle
// @homepageURL  https://github.com/yilecoding/helper-scripts
// @supportURL   https://github.com/yilecoding/helper-scripts/issues
// @updateURL    https://raw.githubusercontent.com/yilecoding/helper-scripts/main/table-export/table-export.user.js
// @downloadURL  https://raw.githubusercontent.com/yilecoding/helper-scripts/main/table-export/table-export.user.js
// ==/UserScript==

// 脚本持续更新维护，欢迎 star / watch 仓库获取最新版本：
// https://github.com/yilecoding/helper-scripts

/*
 * 下载走页面里的 <a download> + Blob，不用 GM_download。
 * Tampermonkey 的 GM_download 有「文件扩展名白名单」，默认不含 .csv / .json，
 * 下载会直接报 not_whitelisted 失败 —— 用户得自己去设置里加白名单，没人会知道要这么做。
 */

(function () {
    'use strict';

    /** 日志前缀。控制台过滤框输入「表格导出」即可只看本脚本的日志。 */
    const TAG = '[表格导出]';

    // =========================================================================
    // 配置
    // =========================================================================

    const CONFIG = {
        /*
         * 布局表格判据（命中任一条就不当数据表）。老式网站用 <table> 排版，
         * 一个页面能有几十个，不排除的话「导出全部」会下载一堆垃圾。
         */
        minRows: 2,          // 少于 2 行：多半是一行按钮/导航
        minCols: 2,          // 单列：多半是竖排的版块容器
        maxNestDepth: 2,     // 被套在 2 层以上的 <table> 里：老式整页排版的最内层碎片

        /*
         * 合并单元格怎么填：'all' = 被覆盖的每一格都填同样的值（方便筛选/透视），
         * 'first' = 只填左上角那一格、其余留空（和 Excel「合并后居中」的存储方式一致）。
         * 这里是默认值，菜单里可以切换，切换结果存在 GM 存储里。
         */
        mergeFill: 'all',

        downloadGap: 400,    // 连续下载多个文件的间隔（毫秒）。连发太快 Chrome 会吞掉后面的
        maxNameLength: 80,   // 文件名最长字符数（不含扩展名）
    };

    const log = (...a) => console.log(TAG, ...a);

    // =========================================================================
    // 表格识别
    // =========================================================================

    /*
     * 两类表格：原生 <table>，和 div 拼的 ARIA 表格（role=table/grid/treegrid +
     * role=row + role=cell/gridcell/columnheader/rowheader）。很多 React 表格组件
     * （MUI DataGrid、各种虚拟滚动表格）是后一种，querySelectorAll('table') 一个都找不到。
     * <table role="grid"> 仍按原生表格读（isNative 看标签名，不看 role）。
     */
    const ARIA_TABLE = '[role="table"],[role="grid"],[role="treegrid"]';
    const ANY_TABLE = `table,${ARIA_TABLE}`;
    const ARIA_CELL = '[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]';

    const isNative = (el) => el.tagName === 'TABLE';

    /** el 所属的那张表（不含 el 自己）。用来排除嵌套子表的行和格。 */
    const ownerTable = (el) => el.parentElement && el.parentElement.closest(ANY_TABLE);

    function nestDepth(table) {
        let depth = 0;
        for (let p = table.parentElement; p; p = p.parentElement) {
            if (p.tagName === 'TABLE') depth++;
        }
        return depth;
    }

    /** 自己（不是嵌套子表）的表头信号：caption / thead / th。有这些就基本可以确定是数据表。 */
    function hasOwnHeader(table) {
        if (table.caption || table.tHead) return true;
        for (const th of table.querySelectorAll('th')) {
            if (th.closest('table') === table) return true;
        }
        return false;
    }

    /** 不用读单元格就能判的几条，先判，省得对整页排版大表跑 innerText。 */
    function structureReason(table) {
        if (!isNative(table)) return '';   // 写了 role=grid 就是作者明确声明的数据表
        const role = (table.getAttribute('role') || '').toLowerCase();
        if (role === 'presentation' || role === 'none') return `role=${role}`;
        // 外层包着别的表格、自己又没有表头的，是排版容器；里面那张单独判断
        if (table.querySelector('table') && !hasOwnHeader(table)) return '内含嵌套表格';
        if (nestDepth(table) > CONFIG.maxNestDepth) return '嵌套过深';
        return '';
    }

    /** 读出网格之后才能判的：行列数、有没有文字。 */
    function contentReason(grid) {
        if (grid.length < CONFIG.minRows) return `只有 ${grid.length} 行`;
        const cols = Math.max(0, ...grid.map((r) => r.length));
        if (cols < CONFIG.minCols) return '单列';
        if (!grid.some((r) => r.some((c) => c !== ''))) return '没有文字';
        return '';
    }

    /**
     * 悬停时用的快速判断：不跑 innerText（会强制排版），只看结构，而且证据够了就停 ——
     * 满 2 行、2 列、有文字就是数据表，不用把几千行扫完。
     * 早先版本每次 mouseover 都把整张表的行列数一遍，5000 行的表实测每次 ~56ms，鼠标一动就卡。
     */
    function quickReason(table) {
        const structure = structureReason(table);
        if (structure) return structure;
        let rows = 0;
        let cols = 0;
        let text = false;
        for (const row of rowEls(table)) {
            if (!rendered(row)) continue;
            rows++;
            let n = 0;
            for (const cell of cellEls(row)) {
                if (!rendered(cell)) continue;
                n += colSpanOf(cell);
                if (!text && cell.textContent.trim()) text = true;
            }
            cols = Math.max(cols, n);
            if (rows >= CONFIG.minRows && cols >= CONFIG.minCols && text) return '';
        }
        if (rows < CONFIG.minRows) return `只有 ${rows} 行`;
        if (cols < CONFIG.minCols) return '单列';
        return '没有文字';
    }

    const isDataTable = (table) => table.getClientRects().length > 0 && !quickReason(table);

    /** 页面上所有数据表（文档顺序）。快速判断过了的，再用真实网格复核一次。 */
    function findTables(root = document) {
        const out = [];
        for (const table of root.querySelectorAll(ANY_TABLE)) {
            if (!isDataTable(table)) continue;
            const grid = readGrid(table);
            const reason = contentReason(grid);
            if (reason) {
                log('跳过布局表格：', reason, table);
                continue;
            }
            out.push({ el: table, grid });
        }
        return out;
    }

    // =========================================================================
    // 读取网格
    // =========================================================================

    /** 单元格文本：innerText 语义（<br>、块级元素都变换行，隐藏的子元素不算），去首尾空白。 */
    function cellText(cell) {
        return (cell.innerText || '')
            .replace(/\r\n?/g, '\n')
            .replace(/\u00a0/g, ' ')   // &nbsp; 统一成普通空格，否则 Excel 里看着一样、筛选却对不上
            .trim();
    }

    /*
     * 原始行：[{ group, header, cells: [{ text, rowSpan, colSpan }] }]，两类表格读成同一个形状，
     * 后面的展开、序列化不区分来源。
     *
     * 隐藏的行、格（display:none，包括 hidden 属性、被隐藏的行组）在展开「之前」就丢掉，
     * 不是展开完再删 —— 这样才和浏览器画出来的一致（Chromium 实测）：
     *   - rowspan="2" 的格下面紧跟一个隐藏行，它会跨到再下面那个可见行
     *   - 一行里隐藏一个格，右边的格整体左移一列
     * 先展开再删的话，这两种情况都会错位。
     */
    const rendered = (el) => el.getClientRects().length > 0;

    /**
     * 表格自己的行（不含嵌套子表的），文档顺序。
     * 原生表格用 table.rows：顺序是规范定死的 thead 的行 → tbody / 直属 tr → tfoot 的行，
     * 和源码里 <tfoot> 写在 <tbody> 前面无关（HTML4 时代的写法，老页面里还很常见）。
     */
    function* rowEls(table) {
        if (isNative(table)) {
            yield* table.rows;
            return;
        }
        for (const row of table.querySelectorAll('[role="row"]')) {
            if (ownerTable(row) === table) yield row;
        }
    }

    function cellEls(row) {
        if (row.tagName === 'TR') return Array.from(row.cells);
        return Array.from(row.querySelectorAll(ARIA_CELL)).filter((c) => c.parentElement.closest('[role="row"]') === row);
    }

    const ariaSpan = (el, attr) => {
        const n = parseInt(el.getAttribute(attr), 10);
        return Number.isFinite(n) && n >= 0 ? n : 1;
    };
    const colSpanOf = (cell) => Math.max(1, (cell.tagName === 'TD' || cell.tagName === 'TH' ? cell.colSpan : ariaSpan(cell, 'aria-colspan')) || 1);
    const rowSpanOf = (cell) => (cell.tagName === 'TD' || cell.tagName === 'TH' ? cell.rowSpan : ariaSpan(cell, 'aria-rowspan'));

    /**
     * 行组用来截断 rowspan：原生是 thead/tbody/tfoot，ARIA 是表格内的 role=rowgroup。
     * 表头行：原生看是否在 thead 里；ARIA 没有 thead，一整行都是 columnheader 的算表头行。
     */
    function rawRows(table) {
        const out = [];
        for (const row of rowEls(table)) {
            if (!rendered(row)) continue;
            const cells = cellEls(row).filter(rendered);
            let group;
            let header;
            if (row.tagName === 'TR') {
                group = row.parentElement;
                header = group.tagName === 'THEAD';
            } else {
                const g = row.closest('[role="rowgroup"]');
                group = g && g !== table && table.contains(g) ? g : table;
                header = cells.length > 0 && cells.every((c) => c.getAttribute('role') === 'columnheader');
            }
            out.push({
                group,
                header,
                cells: cells.map((cell) => ({
                    text: cellText(cell),
                    rowSpan: rowSpanOf(cell),
                    colSpan: colSpanOf(cell),
                })),
            });
        }
        return out;
    }

    /**
     * 按 HTML 表格模型把合并单元格摊平成矩形网格。
     * 两个按规范来的细节：
     *   - rowspan 不跨行组：tbody 最后一行写 rowspan="5"，也不会延伸进 tfoot
     *   - rowspan="0" 表示「延伸到本行组末尾」，不是 0 行（cell.rowSpan 也确实返回 0）
     */
    function expand(rows, fill = mergeFill()) {
        const grid = rows.map(() => []);
        // 每行所在行组的最后一行下标，用来截断 rowspan
        const groupEnd = [];
        for (let r = rows.length - 1; r >= 0; r--) {
            groupEnd[r] = r + 1 < rows.length && rows[r + 1].group === rows[r].group ? groupEnd[r + 1] : r;
        }
        rows.forEach((row, r) => {
            let c = 0;
            for (const cell of row.cells) {
                while (grid[r][c] !== undefined) c++;   // 跳过被上方 rowspan 占住的格
                const lastRow = cell.rowSpan === 0 ? groupEnd[r] : Math.min(groupEnd[r], r + cell.rowSpan - 1);
                for (let rr = r; rr <= lastRow; rr++) {
                    for (let cc = c; cc < c + cell.colSpan; cc++) {
                        grid[rr][cc] = fill === 'first' && (rr !== r || cc !== c) ? '' : cell.text;
                    }
                }
                c += cell.colSpan;
            }
        });
        // 补齐成矩形：短行、被 rowspan 跳出来的空洞都填空串
        const cols = Math.max(0, ...grid.map((r) => r.length));
        return grid.map((r) => Array.from({ length: cols }, (_, i) => (r[i] === undefined ? '' : r[i])));
    }

    /**
     * 表头键：每列把各表头行的值去重后用「/」连起来（两行表头「周一」+「上」→「周一/上」）。
     * 固定按「每一格都填」展开来算 —— 只填第一格模式下合并表头右边那几列是空的，键会丢。
     */
    function headerKeys(rows, headerRows) {
        const full = expand(rows.slice(0, headerRows), 'all');
        const cols = full.length ? full[0].length : 0;
        return Array.from({ length: cols }, (_, c) => {
            const parts = [];
            for (const row of full) {
                if (row[c] && row[c] !== parts[parts.length - 1]) parts.push(row[c]);
            }
            return parts.join('/');
        });
    }

    /**
     * 返回二维数组，另带两个属性：
     *   headerRows  表头占几行（开头连续的表头行数；一行都没有就当第一行是表头）
     *   header      每列的键（见 headerKeys）
     */
    function readGrid(table) {
        const rows = rawRows(table);
        const grid = expand(rows);
        let leading = 0;
        while (leading < rows.length && rows[leading].header) leading++;
        grid.headerRows = Math.min(leading || 1, grid.length);
        grid.header = headerKeys(rows, grid.headerRows);
        return grid;
    }

    // =========================================================================
    // 序列化
    // =========================================================================

    /** RFC 4180：含逗号、双引号、换行的字段整体加双引号，内部双引号写两遍；行尾 CRLF。 */
    function toCSV(grid) {
        const esc = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
        return grid.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
    }

    /**
     * TSV 是给「粘贴进 Excel / WPS / Google 表格」用的，规则跟着 Excel 自己复制单元格时的格式走：
     * 含制表符、换行、双引号的格子加双引号。不加的话单元格里的换行会被当成新的一行，整表错位。
     */
    function toTSV(grid) {
        const esc = (s) => (/[\t"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
        return grid.map((r) => r.map(esc).join('\t')).join('\n');
    }

    /**
     * GFM 表格。表格必须恰好一行表头，多行表头按 headerKeys 合成一行。
     * 单元格里的 | 不转义会被当成列分隔符，整行错位；换行在表格里不合法，换成 <br>。
     */
    function toMarkdown(grid) {
        const esc = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
        const line = (cells) => `| ${cells.map(esc).join(' | ')} |`;
        const body = grid.slice(grid.headerRows);
        return [line(grid.header), line(grid.header.map(() => '---')), ...body.map(line)].join('\n');
    }

    /** 表头当键的对象数组。值一律保留字符串：转数字会吃掉「001」的前导零、长编号丢精度。 */
    function toJSON(grid) {
        const seen = new Map();
        const keys = grid.header.map((k, i) => {
            const base = k || `列${i + 1}`;
            const n = (seen.get(base) || 0) + 1;
            seen.set(base, n);
            return n === 1 ? base : `${base}_${n}`;
        });
        return grid.slice(grid.headerRows).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]])));
    }

    // =========================================================================
    // 文件名 / 下载
    // =========================================================================

    function sanitizeName(s) {
        return s
            .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, CONFIG.maxNameLength);
    }

    /** 表格自己的名字：<caption> → aria-label → aria-labelledby 指向的元素。 */
    function tableLabel(table) {
        if (isNative(table) && table.caption) return cellText(table.caption);
        const label = table.getAttribute('aria-label');
        if (label) return label;
        const ids = (table.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        return ids.map((id) => document.getElementById(id)).filter(Boolean).map(cellText).join(' ');
    }

    /** 默认文件名：表格自己的名字优先，没有就用「页面标题-表格N」。 */
    function baseName(table, index) {
        const caption = tableLabel(table);
        const name = sanitizeName(caption) || sanitizeName(`${document.title || location.hostname}-表格${index + 1}`);
        return name || `table-${index + 1}`;
    }

    function download(name, text, mime, { bom = false } = {}) {
        const blob = new Blob([(bom ? '\uFEFF' : '') + text], { type: `${mime};charset=utf-8` });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        a.remove();
        // 不能立刻 revoke：Firefox 会在下载真正开始前就失去这个 URL
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    /** 单张表在页面数据表里的序号，用于没有 caption 时的文件名。 */
    function tableIndex(table) {
        return Array.from(document.querySelectorAll(ANY_TABLE)).filter(isDataTable).indexOf(table);
    }

    const ACTIONS = {
        'copy-tsv': { label: '复制 TSV', title: '复制为制表符分隔文本，可直接粘贴进 Excel', run: (grid) => GM_setClipboard(toTSV(grid), 'text') },
        'copy-md': { label: '复制 MD', title: '复制为 Markdown 表格', run: (grid) => GM_setClipboard(toMarkdown(grid), 'text') },
        // CSV 必须带 BOM：Excel 双击打开时没有 BOM 就按本地编码（GBK）解析，中文全乱码。
        // JSON 反过来不能带：RFC 8259 不允许，不少解析器（含 Python 的 json.load 默认）遇到 BOM 直接报错。
        'download-csv': { label: '下载 CSV', title: '下载 CSV 文件（Excel 可直接打开）', run: (grid, name) => download(name + '.csv', toCSV(grid), 'text/csv', { bom: true }) },
        'download-json': { label: '下载 JSON', title: '下载 JSON（表头当键）', run: (grid, name) => download(name + '.json', JSON.stringify(toJSON(grid), null, 2), 'application/json') },
    };

    // =========================================================================
    // 悬停工具条
    // =========================================================================

    /*
     * 工具条挂在 <html> 下、position: fixed，按表格的「可见矩形」定位，而不是插进表格旁边：
     *   - 插进表格的祖先里，会被 overflow: hidden/auto 的容器裁掉（横向滚动的宽表全是这种）
     *   - 样式放进 shadow DOM，页面的 button { … } 之类全局样式进不来
     *   - 宿主 pointer-events: none，只有按钮本身接收点击，空白处不挡表格
     * 优先放在表格上沿的外侧，上面没地方了才压进表格右上角。
     */
    const Toolbar = (() => {
        let host = null;
        let bar = null;
        let current = null;
        let hideTimer = 0;
        let raf = 0;

        const CSS = `
            .bar { position: fixed; display: none; gap: 2px; padding: 2px; pointer-events: auto;
                   background: rgba(255,255,255,.96); border: 1px solid #c8ccd2; border-radius: 6px;
                   box-shadow: 0 2px 8px rgba(0,0,0,.15); font: 12px/1.2 system-ui, sans-serif; }
            .bar.show { display: flex; }
            button { all: unset; cursor: pointer; padding: 3px 7px; border-radius: 4px; color: #1f2329; white-space: nowrap; }
            button:hover { background: #e8f0fe; color: #1a56db; }
            button.done { background: #e6f4ea; color: #137333; }
        `;

        function ensure() {
            if (host && host.isConnected) return;
            // 自定义标签名：页面里 div { … } 这类选择器碰不到宿主本身
            host = document.createElement('table-export-toolbar');
            host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; pointer-events: none;';
            const root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>${CSS}</style><div class="bar"></div>`;
            bar = root.querySelector('.bar');
            for (const [key, a] of Object.entries(ACTIONS)) {
                const b = document.createElement('button');
                b.dataset.action = key;
                b.textContent = a.label;
                b.title = a.title;
                bar.appendChild(b);
            }
            // mousedown 默认行为会抢焦点、清掉用户在表格里的文字选区
            bar.addEventListener('mousedown', (e) => e.preventDefault());
            bar.addEventListener('click', onClick);
            bar.addEventListener('mouseenter', cancelHide);
            bar.addEventListener('mouseleave', scheduleHide);
            document.documentElement.appendChild(host);
        }

        function onClick(e) {
            const b = e.target.closest('button');
            if (!b || !current) return;
            const table = current;
            if (!table.isConnected) return hide();
            try {
                ACTIONS[b.dataset.action].run(readGrid(table), baseName(table, tableIndex(table)));
                flash(b, '✓');
            } catch (err) {
                console.error(TAG, '导出失败', err);
                flash(b, '失败');
            }
        }

        function flash(b, text) {
            const label = ACTIONS[b.dataset.action].label;
            b.textContent = text;
            b.classList.add('done');
            setTimeout(() => {
                b.textContent = label;
                b.classList.remove('done');
            }, 1200);
        }

        /** 表格真正露在外面的矩形：和每一层会裁剪的祖先、视口取交集。 */
        function visibleRect(el) {
            const r = el.getBoundingClientRect();
            let { top, left, right, bottom } = r;
            for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
                const cs = getComputedStyle(p);
                if (/hidden|auto|scroll|clip/.test(cs.overflowX + cs.overflowY)) {
                    const pr = p.getBoundingClientRect();
                    top = Math.max(top, pr.top);
                    left = Math.max(left, pr.left);
                    right = Math.min(right, pr.right);
                    bottom = Math.min(bottom, pr.bottom);
                }
            }
            const vw = document.documentElement.clientWidth;
            const vh = document.documentElement.clientHeight;
            return { top: Math.max(top, 0), left: Math.max(left, 0), right: Math.min(right, vw), bottom: Math.min(bottom, vh) };
        }

        function place() {
            raf = 0;
            if (!current) return;
            if (!current.isConnected) return hide();
            if (!rendered(current)) return hide();   // 被 display:none 掉了（切页签之类）
            const v = visibleRect(current);
            if (v.right - v.left < 20 || v.bottom - v.top < 10) return hide();   // 整张表被滚出去了
            const w = bar.offsetWidth;
            const h = bar.offsetHeight;
            // 右对齐；表格比工具条还窄时向左伸出去，只保证不出视口
            const x = Math.max(0, v.right - w);
            const y = v.top - h - 2 >= 0 ? v.top - h - 2 : v.top + 2;
            bar.style.left = `${x}px`;
            bar.style.top = `${y}px`;
        }

        const schedulePlace = () => {
            if (current && !raf) raf = requestAnimationFrame(place);
        };

        /*
         * 只靠 scroll/resize 事件重新定位不够：表格自己变宽（异步数据撑开列）、
         * 或者被 SPA 整个卸掉时，这两个事件都不会触发，工具条会悬在原地指着空气，
         * 点下去导出的是一张已经脱离文档的表（实测得到空文件）。
         * ResizeObserver 两种情况都能收到：卸载时元素尺寸变成 0 也会回调一次。
         */
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedulePlace()) : null;

        function show(table) {
            ensure();
            cancelHide();
            if (resizeObserver) {
                resizeObserver.disconnect();
                resizeObserver.observe(table);
            }
            current = table;
            bar.classList.add('show');
            place();
        }

        function hide() {
            current = null;
            if (resizeObserver) resizeObserver.disconnect();
            if (bar) bar.classList.remove('show');
        }

        function cancelHide() {
            clearTimeout(hideTimer);
        }

        /** 留一点延时：鼠标从表格移到工具条要穿过两者之间的缝。 */
        function scheduleHide() {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(hide, 300);
        }

        /** 从鼠标下的元素往外找第一张数据表（内层是布局碎片时继续往外找）。 */
        function tableAt(target) {
            for (let t = target.closest(ANY_TABLE); t; t = ownerTable(t)) {
                if (t === current) return t;   // 还在同一张表里移动：已经判过了，别再判一遍
                if (isDataTable(t)) return t;
            }
            return null;
        }

        function onOver(e) {
            const target = e.composedPath()[0];
            if (host && host.contains(target)) return cancelHide();
            const table = target instanceof Element ? tableAt(target) : null;
            if (table && table === current) {
                cancelHide();
                schedulePlace();   // 表格上方插入内容导致的整体下移，ResizeObserver 收不到，鼠标一动就纠正
                return;
            }
            if (!table && !current) return;
            if (table) show(table);
            else scheduleHide();
        }

        function init() {
            // 捕获阶段：页面自己的 mouseover 处理里 stopPropagation 也拦不住我们
            window.addEventListener('mouseover', onOver, true);
            document.documentElement.addEventListener('mouseleave', scheduleHide);
            window.addEventListener('scroll', schedulePlace, { capture: true, passive: true });
            window.addEventListener('resize', schedulePlace, { passive: true });
        }

        return { init };
    })();

    // =========================================================================
    // 菜单
    // =========================================================================

    /**
     * 本页 + 所有同源 iframe 的 document（递归）。后台管理系统爱用 iframe 套页面，
     * 只扫顶层的话「导出全部」常常一张表都找不到。跨域的 iframe 读不到，跳过。
     */
    function allDocuments(doc = document, out = []) {
        out.push(doc);
        for (const frame of doc.querySelectorAll('iframe, frame')) {
            try {
                if (frame.contentDocument && frame.contentDocument.documentElement) allDocuments(frame.contentDocument, out);
            } catch (e) {
                /* 跨域 */
            }
        }
        return out;
    }

    function collectAll() {
        const tables = allDocuments().flatMap((doc) => findTables(doc));
        if (!tables.length) alert(`${TAG} 页面上没有找到数据表格`);
        else log(`导出 ${tables.length} 张表`);
        return tables;
    }

    async function exportAllCSV() {
        const tables = collectAll();
        for (let i = 0; i < tables.length; i++) {
            if (i) await new Promise((r) => setTimeout(r, CONFIG.downloadGap));
            const t = tables[i];
            download(baseName(t.el, i) + '.csv', toCSV(t.grid), 'text/csv', { bom: true });
        }
    }

    /** 合并成一个 JSON：多张表只弹一次下载，也绕开 Chrome「此网站想下载多个文件」的拦截。 */
    function exportAllJSON() {
        const tables = collectAll();
        if (!tables.length) return;
        const data = {
            title: document.title,
            url: location.href,
            exportedAt: new Date().toISOString(),
            tables: tables.map((t, i) => ({ name: baseName(t.el, i), header: t.grid.header, rows: toJSON(t.grid) })),
        };
        const name = sanitizeName(`${document.title || location.hostname}-全部表格`) || 'tables';
        download(name + '.json', JSON.stringify(data, null, 2), 'application/json');
    }

    // =========================================================================
    // 设置（存在 GM 存储里，菜单切换）
    // =========================================================================

    function mergeFill() {
        const v = GM_getValue('mergeFill', CONFIG.mergeFill);
        return v === 'first' ? 'first' : 'all';
    }

    const FILL_LABEL = { all: '每一格都填', first: '只填第一格' };
    let fillMenuId = null;

    /** Tampermonkey 的菜单项不能改名，只能注销后重新注册，所以每次切换都重来一遍。 */
    function registerFillMenu() {
        if (fillMenuId !== null) GM_unregisterMenuCommand(fillMenuId);
        fillMenuId = GM_registerMenuCommand(`合并单元格：${FILL_LABEL[mergeFill()]}（点击切换）`, () => {
            GM_setValue('mergeFill', mergeFill() === 'all' ? 'first' : 'all');
            log('合并单元格填充方式：', FILL_LABEL[mergeFill()]);
            registerFillMenu();
        });
    }

    // 菜单只在顶层注册：脚本在每个 iframe 里也会跑一份，各注册一遍的话
    // Tampermonkey 菜单里同名命令会重复 N 次。顶层那份会顺带扫同源 iframe。
    if (window.top === window.self) {
        GM_registerMenuCommand('导出页面上所有表格（逐个 CSV）', exportAllCSV);
        GM_registerMenuCommand('导出页面上所有表格（合并为一个 JSON）', exportAllJSON);
        registerFillMenu();
    }
    Toolbar.init();
})();
