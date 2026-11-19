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

/**
 * 样本量门槛：**按真实数据量自适应 + 下限保护**（v1.13.9 B 批，2026-11-19 用户拍板）。
 *
 * 背景：原来的 500/200/100/380 是拍出来的，没有任何统计推导（方案文档只写数字、
 * 没写怎么来的），而现实是网上能找到的真实样本就这么多，那套数字让 13 个分层
 * 永远 0 个达标、评测永远输出「数据不足」。用户要求「门槛按现有真实数据定」。
 *
 * 但直接「门槛 = 该层现有样本数」是错的：那等于 sufficient 恒为 true，
 * 1 条样本也算「够格」——正是刚修完的「把没跑说成通过」的变体（把「只有 3 条」
 * 说成「够格」）。所以设计成三条规则叠加：
 *
 *   1. **危险层（R6+R7 的 D1：信任放行 / 删源）不设硬门槛，同样自适应**
 *      （2026-11-19 用户最终拍板：「门槛按现有的走，R6/R7/R4 同理」）。
 *      关键论证：样本量门槛设多高都不会让错判变得安全，而降低它反而**能让问题暴露**。
 *      R7|D1 有 193 条、旧门槛 380 ⇒ 永远「数据不足」⇒「AI 在删源上误判 100%」
 *      这个真实问题被「数据不足」掩盖。门槛降到 193 后，它会算出真实误判率并判
 *      「未达标」——这才是我们要的结论。
 *      安全边界改由**比率门槛**守（见 stratumRule）：R7|D1 误判率 ≤1%、
 *      R6|D1 准确率 ≥95%。样本量只决定「能不能算」，比率才决定「算出来够不够好。
 *
 *   2. **所有分层统一自适应**：门槛 = max(该层最小可信样本数, 该层现有样本数 × ADAPT_RATIO)
 *      - 现有样本数**由调用方传入**（computeMetrics 自己数），不写死任何数字。
 *        以后样本从 17 涨到 200，门槛自动跟着涨到 200，不会停留在 17。
 *      - ADAPT_RATIO = 1.0 的语义是「这层有多少就认多少」，不做打折。
 *
 *   注：`danger=D1` 并不等于不可逆。R4→follow（追更提示）、R5→nonSource（判非音源）
 *   也标了 D1，但它们都能撤销。旧版把它们一律按 DANGER(100) 算，
 *   现在与其他层一样自适应（下限 20）——这是**有意的语义修正**，不是悄悄放宽门槛：
 *   R4/R5 的 D1 样本本来就少（15/11 条），旧逻辑让它们永远数据不足，而它们做的事
 *   改错了能回退，不配上和删源同级的门槛。
 *
 *   3. **下限保护** MIN_SAMPLES.reversible：防样本归零时门槛也归零。
 *      这个下限**不是拍脑袋**，是「该层要观测到 1 次错误也至少需要多少条」：
 *      - 要证明 accuracy ≥ 85%，用 rule-of-three 的粗算，
 *        95% 置信下「零错误」至少要 n≈3/(1-0.85)≈20 条才能把 85% 说出口。
 *      - 所有分层共用这个下限 20。
 */
const MIN_SAMPLES = {
  // 要能把「准确率 ≥85%」说出口，零错误样本下需 ≈ 3/(1-0.85) ≈ 20 条
  reversible: 20,
  // danger / blacklist 两个键**已不再参与计算**（危险层改为与可逆层一致的自适应），
  // 保留仅为兼容仍按旧键读取的外部代码。新代码请只看 reversible + ADAPT_RATIO。
  danger: 100,
  blacklist: 380
}
/**
 * 自适应系数：门槛 = max(MIN, 现有样本数 × RATIO)。
 *
 * 取 **1.0**（用户 2026-11-19 拍板「门槛就按现有的走」）：
 * 现有样本有多少，门槛就定多少——这一层的数据量就是当前能拿到的最全样本。
 *
 * 为什么不取 <1（比如 0.8）：`n >= 0.8n` 对任何 n 恒成立，等于样本量校验
 * 在 n ≥ 下限之后**完全失效**（1 条样本也能"达标"）。那正是「把没跑说成通过」
 * 的另一副面孔——「把只有 3 条说成够格」。取 1.0 时 `n >= n` 也恒成立，但
 * 语义是「这层有多少就认多少」，且下限保护仍然拦住样本过少的情形；
 * 真正兜底的是**比率门槛**（stratumRule），不是样本量。
 *
 * 0.8 还带来一个副作用：样本微调时已达标层会反复翻转（n=70 门槛 56 达标，
 * 样本掉到 69 门槛 55 仍达标，但门槛值一直在动，指标不稳定）。
 */
const ADAPT_RATIO = 1.0

// 方案文档门槛（2026-11-17 定为常量；2026-11-19 起**样本量部分改为自适应**，
// 这里的数字只在「不传现有样本数」时作为退路，保证旧调用与测试不炸）。
//
// 两组常量语义不同，别混用：
//  - 下面 5 个是**样本量门槛**（n），决定这一层「够不够格下结论」→ sampleNeedFor()
//  - 再下面 4 个是**比率门槛**（0~1），决定「结论本身够不够好」→ stratumRule()
//
// 比率门槛的出处：AI自动挡与评测方案.md:91-99 的指标表。原文 `:101` 还记着
// 「所有比率附 95% 置信区间；样本不足判"数据不足"而非"通过"」——本文件按此实现：
// 样本不足时只报「数据不足」，**绝不**用不足的样本去比比率给绿灯。
const EVAL_THRESHOLDS = {
  HARD: 500,          // 强证据区样本量（退路值；实际由 sampleNeedFor 自适应）
  GREY: 200,          // 灰区样本量（退路值）
  DANGER: 100,        // 危险动作样本量（退路值；实际由 sampleNeedFor 自适应）
  BLACKLIST: 380,     // 删源样本量（退路值；实际由 sampleNeedFor 自适应）
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

/** 是否为危险层（不可逆动作）：只有 R6/R7 的 D1。R4|D1、R5|D1 是可逆的，不算。 */
function isDangerStratum (kind, danger) {
  const k = String(kind || '').toUpperCase()
  const d = String(danger || '')
  return d === 'D1' && (k === 'R6' || k === 'R7')
}

/**
 * 某分层的**样本量门槛**（自适应）。
 *
 * @param {string} kind 'R4'..'R7'
 * @param {string} zone 'HARD'|'GREY'
 * @param {string} danger 'D0'|'D1'
 * @param {number} [existing] 该层当前真实样本数。**不传则退回 EVAL_THRESHOLDS 固定值**
 *   （保证旧调用方与历史测试行为不变）。
 * @param {object} [th] 门槛覆盖表（opts.thresholds）。危险层与下限也允许被显式覆盖，
 *   便于测试与将来调参。
 */
function sampleNeedFor (kind, zone, danger, existing, th) {
  const T = (th && typeof th === 'object') ? th : EVAL_THRESHOLDS
  // ---- 显式要求「固定门槛」时走旧的四档逻辑（测试与临时对比用）----
  // opts.thresholds.fixedSampleTh = true 表示「别自适应，就按 HARD/GREY/DANGER/BLACKLIST 常量判」。
  if (T.fixedSampleTh === true) {
    const k = String(kind || '').toUpperCase()
    const d = String(danger || '')
    if (k === 'R7' && d === 'D1') return _num(T.BLACKLIST, EVAL_THRESHOLDS.BLACKLIST)
    if (isDangerStratum(k, d)) return _num(T.DANGER, EVAL_THRESHOLDS.DANGER)
    if (String(zone) === 'HARD') return _num(T.HARD, EVAL_THRESHOLDS.HARD)
    return _num(T.GREY, EVAL_THRESHOLDS.GREY)
  }
  // ---- 不传现有样本数：退回旧固定值，行为与改动前一致 ----
  const hasExisting = Number.isFinite(Number(existing)) && Number(existing) >= 0
  if (!hasExisting) {
    const k = String(kind || '').toUpperCase()
    const d = String(danger || '')
    if (k === 'R7' && d === 'D1') return _num(T.BLACKLIST, EVAL_THRESHOLDS.BLACKLIST)
    if (isDangerStratum(k, d)) return _num(T.DANGER, EVAL_THRESHOLDS.DANGER)
    if (String(zone) === 'HARD') return _num(T.HARD, EVAL_THRESHOLDS.HARD)
    return _num(T.GREY, EVAL_THRESHOLDS.GREY)
  }
  // ---- 所有分层统一自适应：max(下限, 现有样本 × 系数) ----
  // 危险层（R6|D1 信任放行 / R7|D1 删源）**不在这里设硬门槛**：
  // 用户 2026-11-19 明确要求「门槛按现有真实数据走，R6/R7/R4 同理」。
  // 安全边界不靠样本量守，靠**比率门槛**守（见 stratumRule：
  // R7|D1 要求误判率 ≤1%、R6|D1 要求准确率 ≥95%）——样本量只决定「能不能算」，
  // 比率才决定「算出来够不够好」。样本量门槛设多高都不会让错判变得安全，
  // 而降低它反而能让「AI 在 R7 上误判率 100%」这类问题暴露出来而不是被"数据不足"掩盖。
  const floor = _num(T.minReversible, MIN_SAMPLES.reversible)
  const ratio = _num(T.adaptRatio, ADAPT_RATIO)
  const adapted = Math.floor(Number(existing) * ratio)
  return Math.max(floor, adapted)
}

/**
 * 取某分层所需**样本量**门槛。
 * 规则：所有分层统一「现有样本数 × ADAPT_RATIO，且有下限保护」自适应（见 sampleNeedFor）。
 *   不传 existing 时退回旧固定值（HARD/GREY/DANGER/BLACKLIST），只为向后兼容。
 *
 * @param {string|object} caseOrKey 分层 key（'R4|GREY|D0'）或样本对象
 * @param {object} [th] 门槛覆盖表（通常来自 computeMetrics 合并后的 th）。
 *   **不传时读模块级 EVAL_THRESHOLDS，行为与 v1.13.9 之前完全一致**（向后兼容）。
 *   传了就用传入值——这修的是原来 computeMetrics 算了 th 却没用、导致
 *   `opts.thresholds` 覆盖完全无效的缺陷（传 {HARD:1} 仍判 12 层数据不足）。
 * @param {number} [existing] 该层当前真实样本数；给了就按自适应算门槛。
 */
function thresholdFor(caseOrKey, th, existing) {
  const c = typeof caseOrKey === 'string' ? (() => {
    const parts = String(caseOrKey).split('|')
    return { kind: parts[0], expected: { zone: parts[1], danger: parts[2] } }
  })() : caseOrKey
  const k = String(c.kind).toUpperCase()
  const z = String(c.expected.zone)
  const d = String(c.expected.danger)
  return sampleNeedFor(k, z, d, existing, th)
}

/**
 * 「危险方向」错误映射：key 是 gold，value 是**造成不可逆损害**的误判结果。
 *
 * 只有不可逆动作才有危险方向，可逆动作改错了能回退，不进这张表。
 *   R7：gold=keep（源仍可用）→ AI 判 blacklist（删源，不可逆）
 *   R6：gold=reject（可疑脚本）→ AI 判 trust（信任放行，把混淆源放进库）
 *   R5：gold=source（真音源）→ AI 判 nonSource（进特征库屏蔽，杀掉真源）
 * R4（追更提示）没有不可逆后果，故不入表 ⇒ 误伤恒 0。
 */
const HARM_DIR = {
  keep: 'blacklist',
  reject: 'trust',
  source: 'nonSource'
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
  // 不可逆动作里最贵的一档：删源。用「误伤率」表达，门槛 0.01 是上限。
  //
  // ⚠ 口径（2026-11-19 P0 修复）：误伤率**只能**用「gold=keep 却判 blacklist」算，
  // 不能用 `1 - accuracy`。原因：accuracy 是纯一致率，把两类错误混在一起——
  // AI 一条源都没删（全判 keep）时 accuracy=0，用 1-accuracy 会报「误判率 100%」，
  // 把用户最能容忍的「漏判」显示成最不能忍的「乱删源」，方向完全反了。
  // 漏判（gold=blacklist 却判 keep）单独给一个比率，不混进误伤。
  if (k === 'R7' && d === 'D1') {
    const keepN = _num(row.keepGoldCount, 0)
    const harm = _num(row.harmCount, 0)
    const blackN = _num(row.blackGoldCount, 0)
    const miss = _num(row.missCount, 0)
    return {
      metric: 'falsePositive',
      label: '删源误伤率',
      // 分母是「gold=keep 的条数」。**没有 keep 样本时误伤率不可测量**，
      // 绝不能拿 0 冒充「测出来是 0%」——那正是「把没跑说成通过」的又一副面孔。
      // （实测：R7|HARD|D1 的 193 条样本 gold 全是 blacklist，keepGold=0，
      //   所以这一层的误伤率目前根本没被测量过。）
      value: keepN > 0 ? harm / keepN : 0,
      unmeasurable: keepN === 0,
      threshold: _num(T.blacklistFalsePositive, EVAL_THRESHOLDS.blacklistFalsePositive),
      // 附带的漏判率（安全方向，仅供展示与解释，不参与 pass/fail 判定）
      missValue: blackN > 0 ? miss / blackN : 0,
      counters: { harm, keepGold: keepN, miss, blackGold: blackN }
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

/** 比率是否够格。falsePositive 是「越小越好」，accuracy 是「越大越好」。
 *  误伤率不可测量（该层没有 gold=keep 样本）时**一律不算够格**——
 *  没测过的东西不能说通过，否则「AI 一条都没删」会被报成「误伤率 0%，达标」。 */
function ratioPass(rule) {
  if (rule && rule.unmeasurable === true) return false
  const v = _num(rule.value, 0)
  const t = _num(rule.threshold, 0)
  return rule.metric === 'falsePositive' ? v <= t : v >= t
}

/** 人话地写「实际值 vs 门槛」，让用户知道差多少，而不是只看到一个结论词。 */
function ratioText(rule) {
  const v = _num(rule.value, 0)
  const t = _num(rule.threshold, 0)
  const pct = x => (Math.round(x * 10000) / 100) + '%'
  if (rule && rule.unmeasurable === true) {
    return rule.label + '无法计算（该层没有 gold=keep 的样本，误伤无从观测）' +
      (rule.missValue != null ? '；漏判率 ' + pct(rule.missValue) + '（安全方向，不参与判定）' : '')
  }
  const cmp = rule.metric === 'falsePositive' ? (v <= t ? '≤' : '>') : (v >= t ? '≥' : '<')
  const need = rule.metric === 'falsePositive' ? '上限' : '门槛'
  let s = rule.label + ' ' + pct(v) + ' ' + cmp + ' ' + need + ' ' + pct(t)
  // 删源这类「误伤/漏判」两向错误代价不对称的分层，把漏判率一起说清楚，
  // 否则用户只看到 0% 误伤，会以为 AI 正常工作，实则可能一条都没删。
  if (rule.missValue != null) {
    s += '；漏判率 ' + pct(rule.missValue) + '（安全方向，不参与判定）'
  }
  return s
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
    const n = cs.length
    // 样本量门槛：把该层现有样本数传进去，所有分层按自身样本量自适应（见 sampleNeedFor）。
    const need = thresholdFor(key, th, n)
    const stratumLogs = (Array.isArray(logs) ? logs : []).filter(l => cs.some(c => c.id === l.entryId || c.id === l.caseId))
    const withAi = stratumLogs.filter(l => l.aiAct != null && l.aiAct !== '')
    const correct = stratumLogs.filter(l => l.goldAct != null && l.aiAct === l.goldAct)
    // ---- 危险方向的错误（误伤）与安全方向的错误（漏判/错杀）必须分开计 ----
    // accuracy 是纯一致率，把两类错误混在一起。对「删源」这种不可逆动作，
    // 「AI 一条都没删」与「AI 乱删可用源」在 accuracy 里都是 0 分，但代价天差地别：
    // 前者只是没干活（用户明确「宁可漏判」），后者会毁掉好源。
    // 所以在这里先算清楚计数，交给 stratumRule 按分层语义取用。
    //   harmCount   ：危险方向错误（R7: gold=keep 判 blacklist；R6: gold=reject 判 trust；
    //                 R5: gold=source 判 nonSource）
    //   missCount   ：安全方向错误（该动手却没动手 / 该放行却拒了）
    //   keepGoldCount / blackGoldCount：两个 gold 方向各自的样本数，作比率分母
    const isHit = l => l.goldAct != null && l.aiAct != null && l.aiAct !== ''
    const harmCount = stratumLogs.filter(l => isHit(l) && l.aiAct !== l.goldAct && HARM_DIR[l.goldAct] === l.aiAct).length
    const keepGoldCount = stratumLogs.filter(l => isHit(l) && l.goldAct === 'keep').length
    const blackGoldCount = stratumLogs.filter(l => isHit(l) && l.goldAct === 'blacklist').length
    const missCount = stratumLogs.filter(l => isHit(l) && l.aiAct !== l.goldAct).length - harmCount
    const sufficient = n >= need
    // 对抗样本：样本显式标 adversarial:true 才计（当前恒 0，见 EVAL_THRESHOLDS.ADVERSARIAL 注释）
    for (const c of cs) if (c && c.adversarial === true) adversarialCount++
    const row = {
      stratum: key,
      kind: key.split('|')[0],
      zone: key.split('|')[1],
      danger: key.split('|')[2],
      n, need, sufficient,
      // 门槛来源，让用户看懂「为什么是这个数」（前端/日志可直接用）
      // 危险层与可逆层现在走同一套自适应规则，差别只在比率门槛（见 stratumRule）。
      needBasis: need === _num(th.minReversible, MIN_SAMPLES.reversible)
        ? '下限 ' + need + ' 条（样本低于最小可信样本数）'
        : '按现有样本自适应（' + n + ' 条 × ' + _num(th.adaptRatio, ADAPT_RATIO) + '）',
      // 分母说明：用的是**回放日志条数**，不是样本数。没回放的层会显示 0%，
      // 此时 insufficient 已经为 true，不会被当成「准确率 0」下结论。
      coverage: stratumLogs.length ? withAi.length / stratumLogs.length : 0,
      accuracy: stratumLogs.length ? correct.length / stratumLogs.length : 0,
      // 两个方向的错误分开计数，供 stratumRule 按分层语义取用（P0-2）。
      // accuracy 仍是纯一致率（保持向后兼容），但不可逆分层的判定不再看它。
      harmCount, keepGoldCount, blackGoldCount, missCount,
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
      if (rule.missValue != null) row.ratio.missValue = rule.missValue
      if (rule.unmeasurable === true) row.ratio.unmeasurable = true
      if (rule.counters) row.ratio.counters = rule.counters
      if (rule.unmeasurable === true) {
        // 比率**不可测量**：该层缺少计算这个比率所必需的样本方向
        // （例如 R7|D1 的样本 gold 全是 blacklist，没有一条 keep，误伤无从观测）。
        // 这时既不能说「达标」（没测过），也不该说「未达标」（测都没测，谈不上差）——
        // 正确结论是「数据不足」：样本构成不全。与三态语义一致，也让 overall 不会
        // 因为一个没测过的层而把整体判成「未达标」。
        row.verdict = '数据不足'
        row.reason = ratioText(rule)
      } else {
        row.reason = ratioText(rule) + (pass ? '（达标）' : '（未达标）')
        row.verdict = pass ? '达标' : '未达标'
      }
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

module.exports = { KINDS, ZONES, DANGERS, EVAL_THRESHOLDS, MIN_SAMPLES, ADAPT_RATIO, validateCase, loadCases, tryLoadCases, groupByStratum, thresholdFor, sampleNeedFor, isDangerStratum, stratumRule, ratioPass, ratioText, computeMetrics }
