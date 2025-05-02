// ==UserScript==
// @name         网页表格导出 | 一键复制/下载 CSV、Excel、Markdown、JSON
// @name:zh-CN   网页表格导出 | 一键复制/下载 CSV、Excel、Markdown、JSON
// @name:en      Table Export | Copy or download any web table as CSV / TSV / Markdown / JSON
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.05.02.1
// @description  任意网页上的表格一键导出：识别原生 <table>（自动排除排版用的布局表格），从菜单把页面上所有表格下载为 CSV（带 BOM，Excel 直接打开不乱码）。
// @description:zh-CN  任意网页上的表格一键导出：识别原生 <table>（自动排除排版用的布局表格），从菜单把页面上所有表格下载为 CSV（带 BOM，Excel 直接打开不乱码）。
// @description:en  Export any table on any web page. Detects native <table> elements (skipping layout-only tables) and downloads every table on the page as CSV (with UTF-8 BOM so Excel opens Chinese text correctly).
// @author       壹樂（V：ita1125）
// @match        *://*/*
// @grant        GM_registerMenuCommand
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
            .replace(/ /g, ' ')
            .trim();
    }

    /** 读成二维字符串数组。 */
    function readGrid(table) {
        const grid = [];
        for (const row of table.rows) {
            grid.push(Array.from(row.cells, cellText));
        }
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

    GM_registerMenuCommand('导出页面上所有表格（CSV）', exportAll);
})();
