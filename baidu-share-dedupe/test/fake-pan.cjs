/*
 * 假的百度网盘：分享方的文件树 + 自己网盘的文件树，回答脚本用到的几个同源接口。
 * 只实现脚本依赖的字段和行为，返回格式照真实接口的样子写（errno / list / fs_id …）。
 */
'use strict'

class FakePan {
    constructor(opts = {}) {
        this.shareid = opts.shareid || '58800001'
        this.uk = opts.uk || '1100223344'
        this.bdstoken = opts.bdstoken || 'tok123'
        this.calls = []
    }

    /** 分享页里的 window.yunData。 */
    yunData() {
        return { shareid: this.shareid, share_uk: this.uk, bdstoken: this.bdstoken }
    }

    /** method + URL + 表单原文 → { status?, body }。 */
    async handle(method, url, form) {
        this.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), form })
        return { status: 404, body: JSON.stringify({ errno: -1, show_msg: 'fake-pan: 未实现 ' + url.pathname }) }
    }
}

module.exports = { FakePan }
