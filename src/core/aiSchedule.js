'use strict'
/**
 * AI 自动只读复检调度（纯函数，零依赖）
 *
 * 与 hunter.js 的 patrolSchedule 同款风格：水位取 max(lastAttempt, lastRun)，
 * 失败轮也推进水位（由调用方在真正触发前写 lastAttempt），避免失败时每分钟空转。
 * now 可注入，便于单测；不 require 任何 core 模块，保持纯粹。
 */

/** 各范围的人话标签（describeNextAIReview 用） */
const SCOPE_LABEL = {
  new: '仅新增（未检新源）',
  failed: '仅失败源（含隔离区）',
  all: '全部有效源（不含废弃/私有）'
  // quarantined 已并入 failed，不再作为独立可选范围（v1.15.0 做减法）
}

/**
 * 归一化小时段 [start,end)：
 *  - start < end：普通区间（例 9→18）
 *  - start > end：**跨午夜区间**（例 22→6 = 晚 22 点到次日早 6 点）
 *  - end = 24：到午夜（例 22→24 = 晚 22 点到零点），保持 v1.13.8 之前的旧语义
 *  - start === end：零长度无意义，按全天兜底（宁可全天，也不要永远判时段外）
 */
function _activeHours(cfg) {
  const h = (cfg && cfg.autoActiveHours) || {}
  let start = Number(h.start)
  let end = Number(h.end)
  if (!Number.isFinite(start)) start = 0
  if (!Number.isFinite(end)) end = 24
  start = Math.max(0, Math.min(24, Math.floor(start)))
  end = Math.max(0, Math.min(24, Math.floor(end)))
  if (start === end) { start = 0; end = 24 }   // 零长度区间按全天兜底，避免永远判时段外
  return { start, end }
}

/** 当前小时是否在允许时段 [start,end) 内（end=24 表示到午夜；start>end 表示跨午夜）。 */
function getActiveHoursOk(cfg, now) {
  const t = Number(now)
  const d = Number.isFinite(t) ? new Date(t) : new Date()
  const hour = d.getHours()
  const { start, end } = _activeHours(cfg)
  // 跨午夜：22→6 表示 hour>=22 或 hour<6
  if (start > end) return hour >= start || hour < end
  return hour >= start && hour < end
}

/**
 * AI 自动复检到期判定。
 * @param {object} cfg store.config.aiReview（enabled/autoEnabled/autoIntervalHours/
 *                     autoScope/autoMaxItems/autoActiveHours/[retryMinutes]）
 * @param {object} aiState store.db.aiAutoReview（{lastAttempt,lastRun,lastError}，可空）
 * @param {number} now 当前时间戳（可注入）
 * @returns {{due:boolean,gapMs:number,reason:string,intervalHours:number,
 *            scope:string,limit:number,activeNow:boolean}}
 */
function aiSchedulePlan(cfg, aiState, now) {
  const c = cfg || {}
  const st = aiState || {}
  const t = Number(now) || Date.now()
  // v1.13.9：这里必须**再收敛一次**。normalizeConfig 只在「保存配置」时生效，
  // 老库里已存着 autoMaxItems=5000 的话，直读路径会照跑 5000 次 AI 调用。
  // 上限值与 aiReview.CFG_LIMITS 保持一致（此处硬编码避免循环依赖：aiReview 依赖 aiSchedule 的反向不存在）。
  const MAX_ITEMS = 200
  const MAX_INTERVAL_HOURS = 720
  const intervalHours = Math.min(MAX_INTERVAL_HOURS, Math.max(1, Number(c.autoIntervalHours) || 24))
  const intervalMs = intervalHours * 3600 * 1000
  // 失败退避：短于主间隔才生效（与 patrolSchedule 同口径，退避不超过主间隔）
  const retryMinutes = Math.max(1, Math.min(intervalMs / 60000,
    Number(c.retryMinutes) || 15))
  const last = Math.max(Number(st.lastAttempt) || 0, Number(st.lastRun) || 0)
  const failed = !!st.lastError
  const gapMs = failed ? Math.min(intervalMs, retryMinutes * 60000) : intervalMs
  const scope = c.autoScope || 'failed'   // v1.15.0：与 store/core 默认对齐（旧值为 new 的历史不一致已修）
  const limit = Math.min(MAX_ITEMS, Math.max(1, Number(c.autoMaxItems) || 20))
  const activeNow = getActiveHoursOk(c, t)
  const elapsed = t - last

  let due = false
  let reason = ''
  if (!c.enabled) {
    reason = 'AI 复检总开关关闭'
  } else if (!c.autoEnabled) {
    reason = '自动挡关闭'
  } else if (!activeNow) {
    reason = '时段外'
  } else if (last && elapsed < gapMs) {
    reason = failed
      ? `失败退避中（还需 ${Math.ceil((gapMs - elapsed) / 60000)} 分钟）`
      : `未到期（每 ${intervalHours} 小时一次）`
  } else {
    due = true
    reason = failed ? '失败退避到期' : '已到自动复检时间'
  }
  return { due, gapMs, reason, intervalHours, scope, limit, activeNow }
}

/**
 * 按范围筛选音源并返回前 limit 条的 id 数组。
 * 所有范围都先排除 deprecated / private（与现有口径一致）。
 * 不修改传入数组。now 仅作签名占位（保留给未来按时间过滤，当前口径不使用）。
 */
function selectScope(sources, scope, limit, now) {
  const arr = Array.isArray(sources) ? sources : []
  const n = Math.max(0, Number(limit) || 0)
  const mode = scope || 'all'
  const hit = (e) => {
    const x = e || {}
    switch (mode) {
      case 'new': return x.lastCheck === 0 || !(x.deep && x.deep.checkedAt)
      // failed 含隔离区：status==='quarantined' 或 e.quarantined 标记
      case 'failed': return !!(x.error || x.status === 'dead' || x.status === 'quarantined' || x.quarantined)
      // v1.15.0：quarantined 旧值重定向到 failed（向后兼容，等同失败源）
      case 'quarantined': return !!(x.error || x.status === 'dead' || x.status === 'quarantined' || x.quarantined)
      case 'all': return true
      default: return false
    }
  }
  const out = []
  for (const e of arr) {
    if (!e || e.deprecated || e.private) continue
    if (!hit(e)) continue
    const id = e.id != null ? e.id : (e.scriptName || e.name)
    if (id != null) out.push(id)
    if (out.length >= n) break
  }
  return out
}

/** 一句中文描述，供 UI / 日志复用。 */
function describeNextAIReview(plan) {
  const p = plan || {}
  const label = SCOPE_LABEL[p.scope] || p.scope || '全部音源'
  const hours = Number(p.intervalHours) || 24
  const every = hours % 24 === 0 ? `每${hours / 24}天` : `每${hours}小时`
  let s = `${every}自动只读复检，范围=${label}，每轮最多${Number(p.limit) || 0}条`
  if (p.activeNow === false) s += '（当前时段外，不触发）'
  if (p.due === true) s += '（已到期）'
  else if (p.reason) s += `（${p.reason}）`
  return s
}

module.exports = { aiSchedulePlan, describeNextAIReview, selectScope, getActiveHoursOk }
