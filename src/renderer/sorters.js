'use strict'
/**
 * 音源库表格排序（v1.7.3）—— 纯函数，渲染进程（window.LXSort）与 Node 单测共用。
 *
 * 表头四列可排序：音源（名称）/ 平台可用性 / 来源仓库 / 状态，点击表头切换，再点反向。
 * 状态排序口径与状态徽章（statusCell）一致，并把「已灌入」排到最后：
 * 配合工具栏「只选未灌入」按钮，实现「排除已灌入、只勾选未灌入部分灌入」。
 */
;(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.LXSort = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const SORT_KEYS = ['name', 'plat', 'repo', 'status']

  /** 已下载检测过、但内容不是洛雪音源脚本（疑似度不足，未进入深度检测） */
  const isCheckedNoSource = e => !!e.lastCheck && e.status === 'ok' && !e.suspected && !e.deep
  /** 深检失效：无可播放平台、有实测失败、失败原因不像本机网络 */
  const isDeepDead = e => !!e.deep && !e.usable && e.deep.failKind === 'dead'

  const nameOf = e => String(e.scriptName || e.name || '')

  /** 名称比较：中文按 locale，数字段按数值（v1.2.0 排在 v1.10.0 前） */
  function nameCmp(a, b) {
    return nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN', { numeric: true })
  }

  /**
   * 状态排序权重（升序 = 越靠前），口径与状态徽章（statusCell）逐条对应：
   *   10 可用 → 20 疑似 → 25 未检测 → 30 不可用（已检测）→ 40 失效 → 41 混淆高危
   *   → 50 重复·已合并 → 60 已灌入（垫底：先处理未灌入的，已灌入的聚在最后好排除）
   * 「有更新·待检测」的条目检测结果已重置（deep=null），按「未检测」同权，不再单列。
   */
  function statusRank(e, imported) {
    if (imported && imported[e.id]) return 60
    if (e.deprecated && !e.deep) return 50
    if (e.usable) return 10
    if (e.status === 'dead') return 40
    if (e.suspected || isCheckedNoSource(e)) return 20
    if (e.obfLevel === 'high') return 41
    if (e.deep) return isDeepDead(e) ? 40 : 30
    return 25
  }

  /** 平台可用性权重：实测可用平台数（含「已取链未校验」档），整体可用另加 100 */
  function platScore(e) {
    const p = (e.deep && e.deep.platforms) || {}
    let n = 0
    for (const k in p) if (p[k] && p[k].status === 'usable') n++
    return (e.usable ? 100 : 0) + n
  }

  // ---------------- 质量排序口径（2026-11-10 用户拍板：平台数 → p50 → 音质档） ----------------
  // 渲染进程 nodeIntegration=false，无法 require 主进程的 src/core/quality.js，
  // 所以这里必须自带一份。**口径一致性由 tests/table-sort.test.js 锁死**（同一批数据
  // 分别喂给本文件与 core/quality.sortKey，排序结果必须逐位相同），改一边不改另一边会直接红。
  const TIER_RE = [
    [/hires|hi-?res|dsd|dolby|atmos|master|jymaster|sq|无损|母带/i, 1.00],
    [/flac|ape|wav|96k|192k|lossless|24bit/i, 0.85],
    [/320k|320|exhigh|极高/i, 0.70],
    [/192k|192|high|高品/i, 0.55],
    [/128k|128|standard|标准/i, 0.40]
  ]
  function tierValue(q) {
    const v = String(q || '').trim()
    if (!v) return null
    for (let i = 0; i < TIER_RE.length; i++) if (TIER_RE[i][0].test(v)) return TIER_RE[i][1]
    return 0.30
  }
  function bestTierValue(list) {
    const arr = Array.isArray(list) ? list : (list ? [list] : [])
    let best = null
    for (let i = 0; i < arr.length; i++) {
      const v = tierValue(arr[i])
      if (v !== null && (best === null || v > best)) best = v
    }
    return best
  }
  /**
   * 综合质量排序键（升序小者优先）：[-可用平台数, 已打分?, p50, -档位]。
   * 与 core/quality.sortKey 完全同口径（含 P1-1 未打分分层语义）；不带 300ms 噪声带
   * （噪声带只用于「删不删」的二元裁决，排序要求顺序可复现，差 1ms 也要能分出先后）。
   *
   * 打分门控（2026-11-10 用户口径）：只有「深度检测（打分）」产生的 metrics
   * （depth==='full' 且 samples!==0）才参与排序。第一位 usable 是分层键，
   * 第二位把「是否已打分」显式化——同平台数层内，已打分排前、未打分排本层末位
   * （P1-1：不再用全局 MAX_SAFE_INTEGER 冒充延迟）。
   */
  function qualitySortKey(e) {
    const p = (e.deep && e.deep.platforms) || {}
    let n = 0
    for (const k in p) if (p[k] && p[k].status === 'usable') n++
    const m = (e.deep && e.deep.metrics) || (e.metrics) || null
    const zeroSamples = !!(m && Number(m.samples) === 0)
    const scored = !!(m && m.depth === 'full' && !zeroSamples)
    const raw = scored ? Number(m.p50LatencyMs) : NaN
    const p50 = raw > 0 ? raw : null
    const tier = scored ? bestTierValue(m && m.qualityMax) : null
    return [-n, scored ? 0 : 1, p50 === null ? 0 : p50, tier === null ? -1 : -tier]
  }
  /**
   * 质量摘要 HTML（「3平台 · 320ms」）——排序依据的可读化。
   * 与 qualitySortKey 同文件实现，避免「排序按一套值、显示另一套值」的错位。
   * 最高可播档当前无数据（采集不测音质，只有同名冲突专项补测写 qualityMax），
   * 所以不显示档位；有值时补第三段，绝不能拿 qualityUsed 冒充。
   */
  function qualityBriefHtml(e) {
    const p = (e && e.deep && e.deep.platforms) || {}
    let n = 0
    for (const k in p) if (p[k] && p[k].status === 'usable') n++
    if (!n) return ''   // 一个可用平台都没有：不编造摘要
    const m = (e && e.deep && e.deep.metrics) || null
    const scored = !!(m && m.depth === 'full')
    if (!scored) {
      // 快速模式（初筛 / 巡检）测到第一个可用平台就停，剩下的标 untested。
      // 这种「平台数」不是脚本真实支持的平台数，只是本次体检的下限 ——
      // 必须把它叫成「快速体检值」，否则用户会拿巡检后变小的数字当能力下降（P-1414）。
      let untested = 0
      for (const k in p) if (p[k] && p[k].status === 'untested') untested++
      if (untested > 0) {
        return '<span class="qbrief unscored" title="快速体检值：巡检/初筛测到第一个可用平台就停，另有 ' + untested +
          ' 个平台没测、不计入这里的 ' + n + ' 个。所以这个平台数只是体检下限，不是脚本能用的全部平台；' +
          '想看准确平台数（并让质量排序生效）请点工具栏「深度检测（打分）」">快速体检 ' + n + ' 平台</span>'
      }
      // 没有未测平台仍不打分（如老记录没 depth）：明确说「还没打分」，不拿 1 样本 p50 冒充能力
      return '<span class="qbrief unscored" title="初筛只确认「有可用平台」，不打分。' +
        '点工具栏「深度检测（打分）」跑五平台真取链后，这里会显示「N平台 · XXms」并参与排序">未打分</span>'
    }
    const raw = Number(m.p50LatencyMs)
    if (!(raw > 0)) return '<span class="qbrief unscored" title="深度检测已完成，但没有取到可用于计时的成功请求">无延迟样本</span>'
    // 不再有「p50 来自上次深度检测」这种继承：初筛/巡检一律清分（2026-11-11 00:38 拍板），
    // 能显示出来的 p50 一定是这一轮深度检测测出来的。
    return '<span class="qbrief" title="排序依据：可用平台 ' + n + ' 个 → p50 延迟 ' +
      Math.round(raw) + 'ms → 最高可播档（需专项补测）">' + n + '平台 · ' + Math.round(raw) + 'ms</span>'
  }

  /**
   * P1-4 稳健性徽章：可播率 / 取链成功率 / p90 长尾延迟（只读展示，取自 deep.metrics）。
   * 只作提示，不参与排序裁决、不进删源；字段缺失（eval/初筛样本常见）时返回空串，不编造。
   */
  function qualityRobustnessHtml(e) {
    const m = (e && e.deep && e.deep.metrics) || null
    if (!m) return ''
    const bits = []
    const pr = Number(m.playableRate), sr = Number(m.successRate), p90 = Number(m.p90LatencyMs)
    if (Number.isFinite(pr) && pr > 0) bits.push('可播 ' + Math.round(pr * 100) + '%')
    if (Number.isFinite(sr) && sr > 0) bits.push('取链 ' + Math.round(sr * 100) + '%')
    if (Number.isFinite(p90) && p90 > 0) bits.push('p90 ' + Math.round(p90) + 'ms')
    if (!bits.length) return ''
    return '<span class="qbrief robust" title="稳健性信号（仅展示，不参与删源判定）：' + bits.join('、') + '">' + bits.join(' · ') + '</span>'
  }

  /**
   * 突破项①阶段2 UI 徽章：冷启动语义预判结果（只读，sourceAiClass 由灌入前旁路写入）。
   * 只展示、不参与判定；未预判/uncertain 不出徽章（不编造）。
   */
  function coldStartBadgeHtml(e) {
    const c = e && e.sourceAiClass
    if (!c || c === 'uncertain') return ''
    const reason = String((e && e.sourceAiReason) || '').slice(0, 60)
    if (c === 'real') return '<span class="qbrief cs-real" title="AI 猜这是真音源（只是提示，不参与判定）' + (reason ? ' — ' + reason.replace(/[<>"']/g, '') : '') + '">像是真源</span>'
    if (c === 'tool') return '<span class="qbrief cs-tool" title="AI 猜这是自检/示例工具（只是排后面，不删除也不判死）' + (reason ? ' — ' + reason.replace(/[<>"']/g, '') : '') + '">像是工具，待确认</span>'
    return ''
  }

  /**
   * 突破项② UI 徽章：R4 更新说明语义分级结果（只读，updateTipsAiClass 由灌入前旁路写入）。
   * 只有明确 substantive=true/false 出徽章；uncertain/无字段不出（不编造）。判据是「有无实质修复」。
   */
  function updateTipsBadgeHtml(e) {
    const c = e && e.updateTipsAiClass
    if (c === undefined || c === null || c === 'uncertain') return ''
    const reason = String((e && e.updateTipsAiReason) || '').slice(0, 60).replace(/[<>"']/g, '')
    if (c === true) return '<span class="qbrief ut-sub" title="AI 看更新说明：有实际修复或新功能（只是提示，不参与判定）' + (reason ? ' — ' + reason : '') + '">有实际更新</span>'
    if (c === false) return '<span class="qbrief ut-ad" title="AI 看更新说明：只是催更或广告，没实质内容（只是提示，不自动删源）' + (reason ? ' — ' + reason : '') + '">像是催更，待确认</span>'
    return ''
  }

  /** 质量排序键 → 比较器；全等时按名称兜底，保证顺序稳定。 */
  function qualityCmp(a, b) {
    const ka = qualitySortKey(a), kb = qualitySortKey(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
    return 0
  }

  /**
   * 每列的首选排序方向与「升序比较器」（cmp 恒为升序：A→Z / 权重低→高；
   * dir=desc 时在 sortSources 里整体取反，实现「再点反向」）。
   */
  const SORT_DEFS = {
    name: { dir: 'asc', label: '名称', cmp: nameCmp },
    // 首选降序 = 综合质量高的在前（平台数多 → 延迟低 → 档位高）。
    // 旧口径只比「可用平台数 + 整体可用」，同平台数时全是平手、顺序随列表变；
    // 现在同平台数会继续比 p50 与音质档，方便用户照着从高到低手动灌入。
    // 注意参数顺序：SORT_DEFS 的 cmp 统一约定为「升序比较器」，本列 dir=desc 会在
    // sortSources 里整体取反；qualitySortKey 本身是「小者优先（好在前）」，
    // 所以这里用 qualityCmp(b, a) 抵消取反，最终仍是「质量高的在前」。
    plat: { dir: 'desc', label: '平台可用性', cmp: (a, b) => qualityCmp(b, a) || nameCmp(a, b) },
    repo: { dir: 'asc', label: '来源仓库', cmp: (a, b) => String(a.repo || '').localeCompare(String(b.repo || ''), 'zh-Hans-CN', { numeric: true }) },
    status: { dir: 'asc', label: '状态', cmp: (a, b, imp) => statusRank(a, imp) - statusRank(b, imp) || nameCmp(a, b) }
  }

  /**
   * 排序（返回新数组，不改原列表）。
   * @param list 条目数组
   * @param sort { key, dir }；key 为空/非法时按原序返回
   * @param imported 已灌入映射（id -> 记录），状态排序用
   */
  function sortSources(list, sort, imported) {
    const arr = Array.prototype.slice.call(list)
    const def = sort && SORT_DEFS[sort.key]
    if (!def) return arr
    const dir = sort.dir === 'desc' ? -1 : 1
    return arr.sort((a, b) => dir * def.cmp(a, b, imported))
  }

  return { SORT_KEYS, SORT_DEFS, statusRank, platScore, sortSources, qualitySortKey, qualityCmp, tierValue, bestTierValue, qualityBriefHtml, qualityRobustnessHtml, coldStartBadgeHtml, updateTipsBadgeHtml, isDeepDead, isCheckedNoSource }
})
