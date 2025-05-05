// ==UserScript==
// @name         网页表格导出 | 一键复制/下载 CSV、Excel、Markdown、JSON
// @name:zh-CN   网页表格导出 | 一键复制/下载 CSV、Excel、Markdown、JSON
// @name:en      Table Export | Copy or download any web table as CSV / TSV / Markdown / JSON
// @namespace    https://github.com/yilecoding/helper-scripts
// @version      2025.05.05.3
// @description  任意网页上的表格一键导出：识别原生 <table>（自动排除排版用的布局表格），正确展开 rowspan/colspan 合并单元格。鼠标移到表格上，右上角浮出工具条：复制为 TSV（直接粘贴进 Excel）、下载 CSV（带 BOM，Excel 直接打开不乱码）；菜单里可一键导出页面上所有表格。
// @description:zh-CN  任意网页上的表格一键导出：识别原生 <table>（自动排除排版用的布局表格），正确展开 rowspan/colspan 合并单元格。鼠标移到表格上，右上角浮出工具条：复制为 TSV（直接粘贴进 Excel）、下载 CSV（带 BOM，Excel 直接打开不乱码）；菜单里可一键导出页面上所有表格。
// @description:en  Export any table on any web page. Detects native <table> elements (skipping layout-only tables), expands rowspan/colspan merged cells. Hover a table to get a small toolbar: copy as TSV (paste straight into Excel) or download CSV (with UTF-8 BOM so Excel opens Chinese text correctly). A menu command exports every table on the page at once.
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

    /**
     * 悬停时用的快速判断：只数行列、看 textContent，不跑 innerText。
     * innerText 会强制排版，几千行的表每次鼠标划过都读一遍会明显卡顿。
     */
    function quickReason(table) {
        const structure = structureReason(table);
        if (structure) return structure;
        const rows = table.rows;
        if (rows.length < CONFIG.minRows) return `只有 ${rows.length} 行`;
        let cols = 0;
        for (const row of rows) {
            let n = 0;
            for (const cell of row.cells) n += Math.max(1, cell.colSpan || 1);
            cols = Math.max(cols, n);
        }
        if (cols < CONFIG.minCols) return '单列';
        if (!table.textContent.trim()) return '没有文字';
        return '';
    }

    const isDataTable = (table) => table.getClientRects().length > 0 && !quickReason(table);

    /** 页面上所有数据表（文档顺序）。快速判断过了的，再用真实网格复核一次。 */
    function findTables(root = document) {
        const out = [];
        for (const table of root.querySelectorAll('table')) {
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

    /**
     * TSV 是给「粘贴进 Excel / WPS / Google 表格」用的，规则跟着 Excel 自己复制单元格时的格式走：
     * 含制表符、换行、双引号的格子加双引号。不加的话单元格里的换行会被当成新的一行，整表错位。
     */
    function toTSV(grid) {
        const esc = (s) => (/[\t"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
        return grid.map((r) => r.map(esc).join('\t')).join('\n');
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
        const blob = new Blob(['\uFEFF' + text], { type: `${mime};charset=utf-8` });
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
        return Array.from(document.querySelectorAll('table')).filter(isDataTable).indexOf(table);
    }

    const ACTIONS = {
        'copy-tsv': { label: '复制 TSV', title: '复制为制表符分隔文本，可直接粘贴进 Excel', run: (grid) => GM_setClipboard(toTSV(grid), 'text') },
        'download-csv': { label: 'CSV', title: '下载 CSV 文件', run: (grid, name) => download(name + '.csv', toCSV(grid), 'text/csv') },
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
            const v = visibleRect(current);
            if (v.right - v.left < 20 || v.bottom - v.top < 10) return hide();   // 整张表被滚出去了
            const w = bar.offsetWidth;
            const h = bar.offsetHeight;
            const x = Math.max(v.left, v.right - w);
            const y = v.top - h - 2 >= 0 ? v.top - h - 2 : v.top + 2;
            bar.style.left = `${x}px`;
            bar.style.top = `${y}px`;
        }

        const schedulePlace = () => {
            if (current && !raf) raf = requestAnimationFrame(place);
        };

        function show(table) {
            ensure();
            cancelHide();
            current = table;
            bar.classList.add('show');
            place();
        }

        function hide() {
            current = null;
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
            for (let t = target && target.closest && target.closest('table'); t; t = t.parentElement && t.parentElement.closest('table')) {
                if (isDataTable(t)) return t;
            }
            return null;
        }

        function onOver(e) {
            const target = e.composedPath()[0];
            if (host && host.contains(target)) return cancelHide();
            const table = target instanceof Element ? tableAt(target) : null;
            if (table === current) return table ? cancelHide() : undefined;
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
    Toolbar.init();
})();
