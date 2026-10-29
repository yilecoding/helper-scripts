/*
 * 假的百度网盘：分享方的文件树 + 自己网盘的文件树，回答脚本用到的几个同源接口。
 * 只实现脚本依赖的字段和行为，返回格式照真实接口的样子写（errno / list / fs_id …）。
 *
 * fs_id 故意从 2^53 + 1 起编号，并且在返回的 JSON 原文里写成裸整数 ——
 * 和真实接口一样，JSON.parse 直接解析会丢精度。
 */
'use strict'

let nextId = 9007199254740993n

class FakePan {
    constructor(opts = {}) {
        this.shareid = opts.shareid || '58800001'
        this.uk = opts.uk || '1100223344'
        this.bdstoken = opts.bdstoken === undefined ? 'tok123' : opts.bdstoken
        this.share = new Map([['/', []]])   // 分享方：目录 → [条目]
        this.disk = new Map([['/', []]])    // 自己的网盘：目录 → [条目]
        this._mkdirs(this.disk, '/存档')    // 测试默认的目标文件夹
        this.calls = []
        this.failures = []                  // [{ path, errno, msg, times }]
        this.limit = opts.limit || 500      // 单次转存上限（非会员）
        this.lag = opts.lag || 0            // 转存后目标列表还要回这么多次旧内容（模拟到账延迟）
        this.drop = 0                       // 下一次转存「返回成功但实际没存」的文件个数
        this.transferred = []               // 每次转存的文件名
        this._stale = null                  // 延迟期间返回的旧列表
    }

    /** 分享页里的 window.yunData。 */
    yunData() {
        const d = { shareid: this.shareid, share_uk: this.uk }
        if (this.bdstoken) d.bdstoken = this.bdstoken
        return d
    }

    /** 在分享里放文件：addShare('/照片', [['a.jpg', 100], …])，中间目录自动建。 */
    addShare(dir, files) {
        this._mkdirs(this.share, dir)
        for (const [name, size] of files) this.share.get(dir).push(this._entry(dir, name, size, false))
        return this
    }

    /** 在自己网盘里放文件，用法同 addShare。 */
    addDisk(dir, files) {
        this._mkdirs(this.disk, dir)
        for (const [name, size] of files) this.disk.get(dir).push(this._entry(dir, name, size, false))
        return this
    }

    /** 生成 n 个文件：name-0001.jpg … */
    static files(n, prefix = 'IMG', size = (i) => 1000 + i) {
        return Array.from({ length: n }, (_, i) => [`${prefix}-${String(i + 1).padStart(4, '0')}.jpg`, size(i)])
    }

    /** 下一次（或 times 次）调用 path 时返回 errno。 */
    fail(path, errno, msg = '', times = 1) {
        this.failures.push({ path, errno, msg, times })
        return this
    }

    _entry(dir, name, size, isdir) {
        const id = String(nextId++)
        return { fs_id: id, server_filename: name, size: isdir ? 0 : size, isdir: isdir ? 1 : 0, path: (dir === '/' ? '' : dir) + '/' + name }
    }

    _mkdirs(tree, dir) {
        if (tree.has(dir)) return
        const parent = dir.slice(0, dir.lastIndexOf('/')) || '/'
        this._mkdirs(tree, parent)
        tree.get(parent).push(this._entry(parent, dir.slice(dir.lastIndexOf('/') + 1), 0, true))
        tree.set(dir, [])
    }

    /** JSON 原文里 fs_id 写成裸整数。 */
    _json(obj) {
        return JSON.stringify(obj).replace(/"fs_id":"(\d+)"/g, '"fs_id":$1')
    }

    _page(rows, page, num) {
        const p = Math.max(1, Number(page) || 1)
        const n = Number(num) || 100
        return rows.slice((p - 1) * n, p * n)
    }

    /** method + URL + 表单原文 → { status?, body }。 */
    async handle(method, url, form) {
        const q = Object.fromEntries(url.searchParams)
        this.calls.push({ method, path: url.pathname, query: q, form: Object.fromEntries(new URLSearchParams(form)) })
        const f = this.failures.find((x) => x.path === url.pathname && x.times > 0)
        if (f) {
            f.times--
            return { body: this._json({ errno: f.errno, show_msg: f.msg }) }
        }
        switch (url.pathname) {
            case '/api/gettemplatevariable':
                return { body: this._json({ errno: 0, result: { bdstoken: 'tok-from-api' } }) }
            case '/share/list': {
                if (q.shareid !== this.shareid || q.uk !== this.uk) return { body: this._json({ errno: 2, show_msg: '参数错误' }) }
                const dir = q.root === '1' ? '/' : q.dir
                if (!this.share.has(dir)) return { body: this._json({ errno: -9, show_msg: '' }) }
                const rows = [...this.share.get(dir)].sort((a, b) => a.server_filename.localeCompare(b.server_filename))
                return { body: this._json({ errno: 0, list: this._page(rows, q.page, q.num) }) }
            }
            case '/api/list': {
                if (!this.disk.has(q.dir)) return { body: this._json({ errno: -9, show_msg: '' }) }
                let all = this.disk.get(q.dir)
                if (this._stale && this._stale.dir === q.dir && this._stale.left > 0) {
                    all = this._stale.rows
                    if (Number(q.page || 1) === 1) this._stale.left--
                }
                const rows = [...all].sort((a, b) => a.server_filename.localeCompare(b.server_filename))
                return { body: this._json({ errno: 0, list: this._page(rows, q.page, q.num) }) }
            }
            case '/share/transfer': {
                if (method !== 'POST') return { body: this._json({ errno: -1, show_msg: '要 POST' }) }
                if (q.shareid !== this.shareid || q.from !== this.uk || !q.bdstoken) return { body: this._json({ errno: 2, show_msg: '参数错误' }) }
                const body = Object.fromEntries(new URLSearchParams(form))
                const ids = body.fsidlist.slice(1, -1).split(',')
                if (ids.length > this.limit) return { body: this._json({ errno: 12, show_msg: '转存文件数超过上限' }) }
                const byId = new Map([...this.share.values()].flat().map((e) => [e.fs_id, e]))
                const files = ids.map((id) => byId.get(id))
                if (files.some((x) => !x)) return { body: this._json({ errno: 12, show_msg: '文件不存在（fs_id 对不上）' }) }
                const dir = body.path
                if (!this.disk.has(dir)) return { body: this._json({ errno: -9, show_msg: '' }) }
                if (this.lag) this._stale = { dir, rows: [...this.disk.get(dir)], left: this.lag }
                const kept = files.slice(0, files.length - this.drop)
                this.drop = 0
                for (const e of kept) this.disk.get(dir).push(this._entry(dir, e.server_filename, e.size, false))
                this.transferred.push(files.map((e) => e.server_filename))
                return { body: this._json({ errno: 0, extra: { list: [] } }) }
            }
        }
        return { status: 404, body: this._json({ errno: -1, show_msg: 'fake-pan: 未实现 ' + url.pathname }) }
    }
}

module.exports = { FakePan }
