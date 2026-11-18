'use strict'
/**
 * R4-R7 评测样本与指标（评测台子，2026-11-17）
 *
 * 纯函数、零依赖：只做样本加载/校验/分层/指标计算与「数据不足」判定。
 * 不读用户库、不碰 store、不调 AI、不接任何业务动作。
 *
 * 原则（对齐 AI自动挡与评测方案.md）：
 * - 灰区不得拿规则结果当标准答案：goldAct 必须由样本人工标注提供。
 * - 样本不足报「数据不足」而非「通过」：任一分层未达门槛，该层指标标 insufficient。
 * - 样本 JSON 冻结脱敏输入，不含脚本文字与密钥（sensitivity:'pii-free'）。
 */

const fs = require('fs')
const path = require('path')

const KINDS = ['R4', 'R5', 'R6', 'R7']
const ZONES = ['HARD', 'GREY']
const DANGERS = ['D0', 'D1']

// 方案文档门槛（2026-11-17 定为常量；2026-11-19 A 批把比率指标真正接进判定）。
//
// 两组常量语义不同，别混用：
//  - 上面 5 个是**样本量门槛**（n），决定这一层「够不够格下结论」→ thresholdFor()
//  - 下面 4 个是**比率门槛**（0~1），决定「结论本身够不够好」→ stratumRule()
//
// 比率门槛的出处：AI自动挡与评测方案.md:91-99 的指标表。原文 `:101` 还记着
// 「所有比率附 95% 置信区间；样本不足判"数据不足"而非"通过"」——本文件按此实现：
// 样本不足时只报「数据不足」，**绝不**用不足的样本去比比率给绿灯。
const EVAL_THRESHOLDS = {
  HARD: 500,          // 强证据区样本量
  GREY: 200,          // 灰区盲标样本量
  DANGER: 100,        // 危险动作样本量
  BLACKLIST: 380,     // 删源样本量
  // ADVERSARIAL：对抗样本量。**当前预留、未启用**——它统计的对象不是 R4-R7 的普通样本，
  // 而是 AI自动挡与评测方案.md:105 列的 8 类对抗样本（深检 0 样本、等长改动、账本指向外来条目、
  // 平台零交集、只有声明值、版本不可比、混淆脚本缺双锁、引用幻觉诱导），AI 对这些应当弃权或保守应对。
  // 现在的样本文件里**没有这一类**（cases 无对应字段，采集端也没产出），所以：
  //   - computeMetrics 只在样本显式带 `adversarial:true` 时计数，没有就恒为 0；
  //   - overall.adversarial.enabled 恒为 false，别把它当成"已通过"的红线。
  // 将来启用需要：① 样本 schema 加 adversarial 标记与 8 类子类；② 采集端产出这批样本。
  ADVERSARIAL: 50,    // 对抗样本量（预留未启用，见上）
  // ---- 以下为比率门槛（0~1），由 stratumRule() 选用 ----
  // HARD 区「不干涉率」：语义是 **AI 与规则共识的一致率**，不是泛指的准确率。
  // 依据 AI自动挡与评测方案.md:93「AI 不许在规则已能铁判的地方乱来」。
  // 实现上 HARD 区的 goldAct 由规则预期标注，所以「一致」等价于 aiAct===goldAct，
  // 度量口径同样是 accuracy，只是门槛取值更严（0.99）。
  hardNonInterference: 0.99,  // 强证据区不干涉率（AI 与规则一致率）
  greyAccuracy: 0.85,         // 可逆动作准确率（灰区及一切非不可逆层）
  dangerPrecision: 0.95,      // 不可逆动作准确率（R6 信任放行）
  blacklistFalsePositive: 0.01 // 删源误判上限（R7 删源，误判率 1-accuracy）
}

function _num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d }

function validateCase(c) {
  if (!c || typeof c !== 'object') return '样本不是对象'
  if (!c.id || typeof c.id !== 'string') return '缺 id'
  if (KINDS.indexOf(String(c.kind).toUpperCase()) === -1) return 'kind 非法：' + c.kind
  if (!c.input || typeof c.input !== 'object') return '缺 input'
  if (!c.expected || typeof c.expected !== 'object') return '缺 expected'
  if (!c.expected.verdict || typeof c.expected.verdict !== 'string') return '缺 expected.verdict'
  if (ZONES.indexOf(String(c.expected.zone)) === -1) return 'expected.zone 非法：' + c.expected.zone
  if (DANGERS.indexOf(String(c.expected.danger)) === -1) return 'expected.danger 非法：' + c.expected.danger
  return null
}

/** 读取目录（或单个文件）里的样本 JSON，返回校验通过的样本数组；坏样本抛错。 */
function loadCases(dirOrFile) {
  const p = String(dirOrFile || '')
  if (!p) return []
  const stat = fs.existsSync(p) ? fs.statSync(p) : null
  let files = []
  if (stat && stat.isDirectory()) {
    files = fs.readdirSync(p).filter(f => /\.json$/i.test(f)).sort().map(f => path.join(p, f))
  } else if (stat && stat.isFile()) {
    files = [p]
  }
  const out = []
  for (const f of files) {
    let data
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { throw new Error('样本 JSON 解析失败：' + f + '：' + e.message) }
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.cases) ? data.cases : null)
    if (!arr) throw new Error('样本 JSON 无 cases 数组：' + f)
    for (const c of arr) {
      const err = validateCase(c)
      if (err) throw new Error('样本校验失败（' + f + '）：' + err + (c && c.id ? ' @ ' + c.id : ''))
      out.push(Object.assign({ source: 'file', status: 'labeled' }, c))
    }
  }
  return out
}

/**
 * 不抛版本：返回 `{ cases, error }`，供服务端/桌面端在读取失败时**把原因报给界面**。
 *
 * 为什么需要它（v1.13.9）：调用点原来写成
 *   `try { cases = loadCases(dir) } catch (e) { cases = [] }`
 * 于是「目录不存在」「样本 JSON 坏了」「样本缺字段」三种故障与「确实没有样本」
 * 产生**完全相同的症状**——界面显示「无样本」，用户/我们无从分辨是没喂数据
 * 还是数据读坏了。评测因此在没有验尺的情况下静默失效（部署后 8197 实测发现）。
 *
 * @param {string} dirOrFile 目录或单个文件
 * @returns {{cases:Array, error:string}} error 为空串表示成功；失败时 cases 恒为 []
 */
function tryLoadCases(dirOrFile) {
  const p = String(dirOrFile || '')
  if (!p) return { cases: [], error: '未配置样本目录' }
  let exists = false
  try { exists = fs.existsSync(p) } catch (e) { return { cases: [], error: '样本路径不可访问：' + p + '：' + ((e && e.message) || e) } }
  if (!exists) return { cases: [], error: '样本目录不存在：' + p + '（构建产物未包含 tests/eval-cases）' }
  try {
    return { cases: loadCases(p), error: '' }
  } catch (e) {
    return { cases: [], error: String((e && e.message) || e) }
  }
}

/** 分层：kind × zone × danger，返回 { 'R4|GREY|D1': [case,...] } */
function groupByStratum(cases) {
  const g = {}
  for (const c of (Array.isArray(cases) ? cases : [])) {
    const k = String(c.kind).toUpperCase()
    const z = String(c.expected.zone)
    const d = String(c.expected.danger)
    const key = k + '|' + z + '|' + d
    if (!g[key]) g[key] = []
    g[key].push(c)
  }
  return g
}

/**
 * 取某分层所需**样本量**门槛。
 * 规则：删源(R7+D1) 用 BLACKLIST，其余 D1 用 DANGER，再按 zone 取 HARD/GREY。
 *
 * @param {string|object} caseOrKey 分层 key（'R4|GREY|D0'）或样本对象
 * @param {object} [th] 门槛覆盖表（通常来自 computeMetrics 合并后的 th）。
 *   **不传时读模块级 EVAL_THRESHOLDS，行为与 v1.13.9 之前完全一致**（向后兼容）。
 *   传了就用传入值——这修的是原来 computeMetrics 算了 th 却没用、导致
 *   `opts.thresholds` 覆盖完全无效的缺陷（传 {HARD:1} 仍判 12 层数据不足）。
 */
function thresholdFor(caseOrKey, th) {
  const T = (th && typeof th === 'object') ? th : EVAL_THRESHOLDS
  const c = typeof caseOrKey === 'string' ? (() => {
    const parts = String(caseOrKey).split('|')
    return { kind: parts[0], expected: { zone: parts[1], danger: parts[2] } }
  })() : caseOrKey
  const k = String(c.kind).toUpperCase()
  const z = String(c.expected.zone)
  const d = String(c.expected.danger)
  if (k === 'R7' && d === 'D1') return _num(T.BLACKLIST, EVAL_THRESHOLDS.BLACKLIST)
  if (d === 'D1') return _num(T.DANGER, EVAL_THRESHOLDS.DANGER)
  if (z === 'HARD') return _num(T.HARD, EVAL_THRESHOLDS.HARD)
  return _num(T.GREY, EVAL_THRESHOLDS.GREY)
}

/**
 * 取某分层该用哪个**比率门槛**，以及怎么算这个比率。
 *
 * 分层不是按 danger 平均切的，因为 `danger=D1` 并不等于「不可逆动作」——实测
 * R4→follow(15 条)、R5→nonSource(11 条) 也被标了 D1，但它们没有任何破坏性。
 * 真正不可逆且代价大的是：
 *   - R6 + D1：trust（混淆源信任放行，放错等于把混淆脚本放进库）
 *   - R7 + D1：blacklist（删源，误删用户的好源，用户明确「代价远大于漏判」）
 * 其余（含 R4|D1、R5|D1）按可逆动作的常规准确率要求。
 *
 * @returns {{metric:string, threshold:number, value:number, label:string}}
 *   metric: 'accuracy'（越高越好）| 'falsePositive'（越低越好，取 1-accuracy）
 */
function stratumRule(row, th) {
  const T = th || EVAL_THRESHOLDS
  const k = String(row.kind || '').toUpperCase()
  const z = String(row.zone || '')
  const d = String(row.danger || '')
  const acc = _num(row.accuracy, 0)
  // 不可逆动作里最贵的一档：删源。用「误判率」表达，门槛 0.01 是上限。
  if (k === 'R7' && d === 'D1') {
    return {
      metric: 'falsePositive',
      label: '删源误判率',
      value: 1 - acc,
      threshold: _num(T.blacklistFalsePositive, EVAL_THRESHOLDS.blacklistFalsePositive)
    }
  }
  // 另一个不可逆动作：信任放行（把混淆源放进库）。
  if (k === 'R6' && d === 'D1') {
    return {
      metric: 'accuracy',
      label: '信任放行准确率',
      value: acc,
      threshold: _num(T.dangerPrecision, EVAL_THRESHOLDS.dangerPrecision)
    }
  }
  // 强证据区：AI 不该反对规则已铁判的结论（不干涉率，量纲同为一致率）。
  if (z === 'HARD') {
    return {
      metric: 'accuracy',
      label: '强证据区不干涉率',
      value: acc,
      threshold: _num(T.hardNonInterference, EVAL_THRESHOLDS.hardNonInterference)
    }
  }
  // 其余（可逆动作）：常规准确率。
  return {
    metric: 'accuracy',
    label: '准确率',
    value: acc,
    threshold: _num(T.greyAccuracy, EVAL_THRESHOLDS.greyAccuracy)
  }
}

/** 比率是否够格。falsePositive 是「越小越好」，accuracy 是「越大越好」。 */
function ratioPass(rule) {
  const v = _num(rule.value, 0)
  const t = _num(rule.threshold, 0)
  return rule.metric === 'falsePositive' ? v <= t : v >= t
}

/** 人话地写「实际值 vs 门槛」，让用户知道差多少，而不是只看到一个结论词。 */
function ratioText(rule) {
  const v = _num(rule.value, 0)
  const t = _num(rule.threshold, 0)
  const pct = x => (Math.round(x * 10000) / 100) + '%'
  const cmp = rule.metric === 'falsePositive' ? (v <= t ? '≤' : '>') : (v >= t ? '≥' : '<')
  const need = rule.metric === 'falsePositive' ? '上限' : '门槛'
  return rule.label + ' ' + pct(v) + ' ' + cmp + ' ' + need + ' ' + pct(t)
}

/**
 * 计算指标。logs 是回放产生的 aiEvalLog 数组（含 aiAct/goldAct/executed/auditId/zone/danger），
 * cases 是样本数组。返回按分层可解释的指标表。
 *
 * 判定分**两道**，先样本量后比率（v1.13.9 A 批修）：
 *  1. 样本量够不够格（n >= thresholdFor）→ 不够报「数据不足」，**不看比率**；
 *  2. 够格了才比比率（stratumRule）→ '达标' / '未达标'。
 * 原来只有第 1 道，只要 n 够就无条件打 'evaluated'，等于从不比较准确率——
 * 扩到一万条样本也不会真的验出来，这是本轮修掉的核心缺陷。
 *
 * verdict 三态：'数据不足' | '达标' | '未达标'
 *  （历史上短暂存在过 'evaluated' 别名，已确认生产链路从不产出，予以删除。三态互斥且穷尽。）
 */
function computeMetrics(logs, cases, opts) {
  const o = opts || {}
  const th = Object.assign({}, EVAL_THRESHOLDS, o.thresholds || {})
  const byId = {}
  for (const c of (Array.isArray(cases) ? cases : [])) byId[c.id] = c
  const groups = groupByStratum(cases)
  const table = []
  let adversarialCount = 0
  for (const key of Object.keys(groups).sort()) {
    const cs = groups[key]
    const need = thresholdFor(key, th)          // A1：用合并后的 th，不再读模块级常量
    const stratumLogs = (Array.isArray(logs) ? logs : []).filter(l => cs.some(c => c.id === l.entryId || c.id === l.caseId))
    const withAi = stratumLogs.filter(l => l.aiAct != null && l.aiAct !== '')
    const correct = stratumLogs.filter(l => l.goldAct != null && l.aiAct === l.goldAct)
    const n = cs.length
    const sufficient = n >= need
    // 对抗样本：样本显式标 adversarial:true 才计（当前恒 0，见 EVAL_THRESHOLDS.ADVERSARIAL 注释）
    for (const c of cs) if (c && c.adversarial === true) adversarialCount++
    const row = {
      stratum: key,
      kind: key.split('|')[0],
      zone: key.split('|')[1],
      danger: key.split('|')[2],
      n, need, sufficient,
      // 分母说明：用的是**回放日志条数**，不是样本数。没回放的层会显示 0%，
      // 此时 insufficient 已经为 true，不会被当成「准确率 0」下结论。
      coverage: stratumLogs.length ? withAi.length / stratumLogs.length : 0,
      accuracy: stratumLogs.length ? correct.length / stratumLogs.length : 0,
      // 只读红线：回放不得执行真实动作、不得写审计
      readonlyOk: stratumLogs.every(l => l.executed === false && l.auditId == null),
      insufficient: !sufficient
    }
    // 第二道：只有样本量够格才比率。不够就只报数据不足，绝不用不足样本比比率给绿灯。
    if (!sufficient) {
      row.verdict = '数据不足'
      row.reason = 'n=' + n + ' < 门槛 ' + need
    } else if (!stratumLogs.length) {
      // 样本够了但一条回放都没有：不能判「未达标」——那是把「没跑」说成「跑得差」。
      row.verdict = '数据不足'
      row.reason = '样本已够（n=' + n + '）但没有回放记录，无法计算比率'
    } else {
      const rule = stratumRule(row, th)
      const pass = ratioPass(rule)
      row.ratio = { metric: rule.metric, label: rule.label, value: rule.value, threshold: rule.threshold, pass }
      row.reason = ratioText(rule) + (pass ? '（达标）' : '（未达标）')
      row.verdict = pass ? '达标' : '未达标'
    }
    table.push(row)
  }
  // 汇总不能只看 insufficient（那只反映样本量）。
  // 「样本够但零回放」的层 insufficient===false 而 verdict==='数据不足'，
  // 只查 insufficient 会把它漏掉、直接落进「达标」分支——把「没跑」说成「通过」，
  // 方向反了比原来更危险（C 复核在真实数据上抓到过：12 层全数据不足，overall 却报达标）。
  // 所以按**每层最终 verdict** 汇总：只要有一层不是「达标」，整体就不能说达标。
  const anyFailed = table.some(r => r.verdict === '未达标')
  const anyNotPassed = table.some(r => r.verdict !== '达标')
  const advNeed = _num(th.ADVERSARIAL, EVAL_THRESHOLDS.ADVERSARIAL)
  const advEnabled = adversarialCount > 0
  return {
    table,
    overall: {
      // 三态汇总：有未达标 → 未达标；否则有任何一层没达标（含数据不足）→ 数据不足；全达标 → 达标。
      verdict: !table.length ? '数据不足' : (anyFailed ? '未达标' : (anyNotPassed ? '数据不足' : '达标')),
      sampleCount: (Array.isArray(cases) ? cases.length : 0),
      note: !table.length
        ? '无样本'
        : (anyFailed
            ? '有分层未达比率门槛，不判通过'
            : (anyNotPassed ? '存在未达门槛或未回放的分层，不判通过' : '各分层样本量与比率均达标')),
      // 对抗样本：**预留未启用**，enabled=false 时应把它当"没测"，不能当"通过"。
      adversarial: {
        enabled: advEnabled,
        count: adversarialCount,
        need: advNeed,
        sufficient: adversarialCount >= advNeed,
        note: advEnabled ? '' : '对抗样本未启用（当前样本无 adversarial 标记，也不存在采集来源）'
      }
    },
    thresholds: th
  }
}

module.exports = { KINDS, ZONES, DANGERS, EVAL_THRESHOLDS, validateCase, loadCases, tryLoadCases, groupByStratum, thresholdFor, stratumRule, ratioPass, ratioText, computeMetrics }
