// ==UserScript==
// @name         网页表格导出 | 一键复制/下载 CSV、Excel、Markdown、JSON
// @name:zh-CN   网页表格导出 | 一键复制/下载 CSV、Excel、Markdown、JSON
// @name:en      Table Export | Copy or download any web table as CSV / TSV / Markdown / JSON
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.05.05.2
// @description  任意网页上的表格一键导出：识别原生 <table>（自动排除排版用的布局表格），正确展开 rowspan/colspan 合并单元格，从菜单把页面上所有表格下载为 CSV（带 BOM，Excel 直接打开不乱码）。
// @description:zh-CN  任意网页上的表格一键导出：识别原生 <table>（自动排除排版用的布局表格），正确展开 rowspan/colspan 合并单元格，从菜单把页面上所有表格下载为 CSV（带 BOM，Excel 直接打开不乱码）。
// @description:en  Export any table on any web page. Detects native <table> elements (skipping layout-only tables), expands rowspan/colspan merged cells, and downloads every table on the page as CSV (with UTF-8 BOM so Excel opens Chinese text correctly).
// @author       壹樂（V：ita1125）
// @match        *://*/*
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

    /** 页面上所有数据表（文档顺序）。 */
    function findTables(root = document) {
        const out = [];
        for (const table of root.querySelectorAll('table')) {
            if (table.getClientRects().length === 0) continue;   // 整张表不可见
            let grid = null;
            const reason = structureReason(table) || contentReason((grid = readGrid(table)));
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

    /**
     * 原生表格 → 原始行：[{ group, cells: [{ text, rowSpan, colSpan }] }]。
     * table.rows 的顺序是规范定死的：thead 的行 → tbody / 直属 tr → tfoot 的行，
     * 和源码里 <tfoot> 写在 <tbody> 前面无关（HTML4 时代的写法，老页面里还很常见）。
     */
    function nativeRows(table) {
        return Array.from(table.rows, (row) => ({
            group: row.parentElement,
            cells: Array.from(row.cells, (cell) => ({
                text: cellText(cell),
                rowSpan: cell.rowSpan,
                colSpan: Math.max(1, cell.colSpan || 1),
            })),
        }));
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

    function readGrid(table) {
        return expand(nativeRows(table));
    }

    // =========================================================================
    // 序列化
    // =========================================================================

    /** RFC 4180：含逗号、双引号、换行的字段整体加双引号，内部双引号写两遍；行尾 CRLF。 */
    function toCSV(grid) {
        const esc = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
        return grid.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
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

    /** 默认文件名：<caption> 优先，没有就用「页面标题-表格N」。 */
    function baseName(table, index) {
        const caption = table.caption ? cellText(table.caption) : '';
        const name = sanitizeName(caption) || sanitizeName(`${document.title || location.hostname}-表格${index + 1}`);
        return name || `table-${index + 1}`;
    }

    function download(name, text, mime) {
        // BOM 必须有：Excel 双击打开 CSV 时没有 BOM 就按本地编码（GBK）解析，中文全乱码
        const blob = new Blob(['﻿' + text], { type: `${mime};charset=utf-8` });
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

    // =========================================================================
    // 菜单
    // =========================================================================

    async function exportAll() {
        const tables = findTables();
        if (!tables.length) {
            alert(`${TAG} 页面上没有找到数据表格`);
            return;
        }
        log(`导出 ${tables.length} 张表`);
        for (let i = 0; i < tables.length; i++) {
            if (i) await new Promise((r) => setTimeout(r, CONFIG.downloadGap));
            const t = tables[i];
            download(baseName(t.el, i) + '.csv', toCSV(t.grid), 'text/csv');
        }
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

    GM_registerMenuCommand('导出页面上所有表格（CSV）', exportAll);
    registerFillMenu();
})();
