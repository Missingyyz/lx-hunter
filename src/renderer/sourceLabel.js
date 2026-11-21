(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.LXSourceLabel = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'
  /**
   * 音源标签统一口径（v1.15.0 P2）：chip 显示 / 搜索 / 名称排序共用同一套规则，
   * 避免 displayName / nameOf / 搜索三处规则漂移。
   *
   * 两条独立字段（绝不写进 name/lxName/scriptVersion——那会破坏 identity.js normName、
   * crawler filterLatestOnly、hunter 同名分组/同仓裁决，可能重复灌入或绕开裁决）：
   *  - releaseTag：正式字段，采集时从 release tag 落库；历史数据从 path/assetKey 惰性 fallback。
   *  - userTag：用户自定义，采集/导入不得覆盖。
   */

  /** 历史数据兼容：从 path/assetKey 里解析 release tag（不写回、只读取） */
  function releaseTagOf (e) {
    e = e || {}
    if (typeof e.releaseTag === 'string' && e.releaseTag) return e.releaseTag
    // assetKey = '<tag>/<file>'（crawler parseReleaseAssets）
    const ak = String(e.assetKey || '')
    if (ak) {
      const m = ak.match(/^([^/]+)\//)
      if (m && m[1] && !/^https?:$/.test(m[1])) return m[1]
    }
    // path/id 里形如 'release:<tag>:<name>'
    const p = String(e.path || e.id || '')
    const m2 = p.match(/release:([^:]+):/)
    if (m2 && m2[1]) return m2[1]
    return ''
  }

  function userTagOf (e) {
    const t = (e || {}).userTag
    return typeof t === 'string' && t.trim() ? t.trim() : ''
  }

  /** 基础名字（不含任何 tag），三处统一用它做"名字本身" */
  function baseNameOf (e) {
    e = e || {}
    return String(e.lxName || e.scriptName || e.name || e.id || '')
  }

  /**
   * 统一展示标签：<名字>（[用户标签]）（[来源标签]）。
   * @param {object} e 音源对象
   * @param {object} [opt] {withRelease:false} 可只显示用户标签（某些窄 UI）
   */
  function sourceLabel (e, opt) {
    const o = opt || {}
    const parts = [baseNameOf(e)]
    const u = userTagOf(e)
    if (u) parts.push('[' + u + ']')
    const r = releaseTagOf(e)
    if (r && o.withRelease !== false) parts.push('(' + r + ')')
    return parts.join(' ')
  }

  /** 搜索用的小写文本（包含 tag，让搜索 release tag / 用户标签都能命中） */
  function searchTextOf (e) {
    e = e || {}
    return [e.scriptName, e.name, e.lxName, e.author, e.repo, e.path,
      releaseTagOf(e), userTagOf(e)].filter(Boolean).join(' ').toLowerCase()
  }

  return { releaseTagOf, userTagOf, baseNameOf, sourceLabel, searchTextOf }
})
