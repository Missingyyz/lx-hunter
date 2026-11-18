'use strict'
/**
 * evalCases 判定骨架回归（v1.13.9 A 批）
 *
 * 背景：原来 computeMetrics 只比样本量，n 够就无条件打 'evaluated'，
 * **从不比较 accuracy 或任何比率门槛**（evalCases.js 的 4 个比率常量全库零引用）。
 * 后果：样本扩到一万条也只会打 'evaluated'，「达标就放开自动执行」整条链是空的。
 *
 * 本文件锁住三件事：
 *  A1 thresholdFor 接受门槛覆盖（opts.thresholds 真的生效）
 *  A2 三态判定（数据不足 / 达标 / 未达标）+ 分层选用正确的比率指标
 *  A3 ADVERSARIAL 预留未启用要如实标注，不能假装在工作
 */
const path = require('path')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const ec = require(path.join(SRC, 'core', 'evalCases'))
const { computeMetrics, thresholdFor, EVAL_THRESHOLDS, stratumRule, loadCases } = ec

let pass = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) } else { fails.push(name + (extra ? '  -> ' + extra : '')); console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')) }
}

const cases = loadCases(path.join(ROOT, 'tests', 'eval-cases'))
const mkLogs = (cs, correct) => cs.map((c, i) => ({
  entryId: c.id,
  aiAct: correct ? c.expected.verdict : (i % 2 === 0 ? c.expected.verdict : '__WRONG__'),
  goldAct: c.expected.verdict,
  executed: false,
  auditId: null
}))
// 门槛全开：自适应关掉（fixedSampleTh），四档常量压到 1，确保每层 sufficient。
const ALL_ONE = { HARD: 1, GREY: 1, DANGER: 1, BLACKLIST: 1, fixedSampleTh: true }
const HUGE = { HARD: 99999, GREY: 99999, DANGER: 99999, BLACKLIST: 99999, fixedSampleTh: true }

// ============================================================
console.log('\n=== ① A1：thresholdFor 门槛覆盖（向后兼容 + 覆盖生效） ===')
;(() => {
  // 向后兼容：不传 th / 不传 existing 时返回旧的退路值。
  // 注意 R5|GREY|D1：v1.13.9 B 批把「危险层」收窄为仅 R6/R7 的 D1
  // （R5→nonSource 判非音源可撤销，不该和删源同级），所以它现在落回 GREY=200。
  // 这是有意的语义修正，见 evalCases.js 里 MIN_SAMPLES 上方的说明。
  ok('不传 th：R7|GREY|D1 = 380（BLACKLIST）', thresholdFor('R7|GREY|D1') === 380, String(thresholdFor('R7|GREY|D1')))
  ok('不传 th：R4|GREY|D0 = 200（GREY）', thresholdFor('R4|GREY|D0') === 200, String(thresholdFor('R4|GREY|D0')))
  ok('不传 th：R4|HARD|D0 = 500（HARD）', thresholdFor('R4|HARD|D0') === 500, String(thresholdFor('R4|HARD|D0')))
  ok('不传 th：R5|GREY|D1 = 200（可逆层，不再当危险层用 DANGER）', thresholdFor('R5|GREY|D1') === 200, String(thresholdFor('R5|GREY|D1')))
  ok('不传 th：R6|HARD|D1 = 100（R6 信任放行仍是危险层）', thresholdFor('R6|HARD|D1') === 100, String(thresholdFor('R6|HARD|D1')))

  // 覆盖生效
  ok('传 th：R7|GREY|D1 用传入 BLACKLIST', thresholdFor('R7|GREY|D1', { BLACKLIST: 7 }) === 7)
  ok('传 th：R4|HARD|D0 用传入 HARD', thresholdFor('R4|HARD|D0', { HARD: 8 }) === 8)
  ok('传 th：缺字段时回落模块级默认（不返回 undefined）',
    thresholdFor('R4|GREY|D0', {}) === EVAL_THRESHOLDS.GREY, String(thresholdFor('R4|GREY|D0', {})))
  ok('传 null/非对象时退回默认（不抛错）',
    thresholdFor('R4|GREY|D0', null) === EVAL_THRESHOLDS.GREY && thresholdFor('R4|GREY|D0', 'x') === EVAL_THRESHOLDS.GREY)

  // 【核心】computeMetrics 里 opts.thresholds 现在真的生效
  const logs = mkLogs(cases, true)
  const strict = computeMetrics(logs, cases)
  const loose = computeMetrics(logs, cases, { thresholds: ALL_ONE })
  ok('【核心】默认自适应门槛：仍有分层 insufficient（危险层 + 小样本层）',
    strict.table.length >= 12 && strict.table.some(r => r.insufficient === true),
    'len=' + strict.table.length + ' insufficient=' + strict.table.filter(r => r.insufficient).length)
  // v1.13.9 用户拍板「门槛按现有真实数据走，R6/R7/R4 同理」：
  // 危险层不再保留 380/100 硬门槛，样本量门槛与其他层一致（n×1.0，下限 20）。
  // 安全边界由比率门槛守（见 stratumRule）：R7|D1 误判率≤1%、R6|D1 准确率≥95%。
  // 因此这里断言的是「门槛随样本自适应」，而不是「危险层恒不足」。
  // 注意：n<20 的层仍 insufficient（下限保护），所以不能断言全部达标。
  ok('【核心】危险层样本量门槛随样本自适应（= max(下限20, n)），不再固定 380/100',
    strict.table.filter(r => ['R6', 'R7'].indexOf(r.kind) !== -1 && r.danger === 'D1').every(r => r.need === Math.max(20, r.n)),
    strict.table.filter(r => ['R6', 'R7'].indexOf(r.kind) !== -1 && r.danger === 'D1').map(r => r.stratum + ' n=' + r.n + ' need=' + r.need).join(','))
  ok('【核心】opts.thresholds 全 1 后：0 层 insufficient（原来这里恒 12，覆盖无效）',
    loose.table.every(r => r.insufficient === false), loose.table.filter(r => r.insufficient).map(r => r.stratum).join(','))
  ok('【核心】opts.thresholds 真生效后 need 字段跟着变', loose.table.every(r => r.need === 1))
})()

// ============================================================
console.log('\n=== ② A2：三态判定与比率门槛 ===')
;(() => {
  const logsOk = mkLogs(cases, true)
  const m = computeMetrics(logsOk, cases, { thresholds: ALL_ONE })

  // 全对 → 全部达标
  ok('全对回放 + 门槛放开 → 各层全部"达标"', m.table.every(r => r.verdict === '达标'), m.table.map(r => r.verdict).join(','))
  ok('overall 三态汇总为"达标"', m.overall.verdict === '达标', m.overall.verdict)

  // 故意做坏 → 未达标
  const bad = computeMetrics(mkLogs(cases, false), cases, { thresholds: ALL_ONE })
  ok('【核心】准确率不够 → "未达标"（原来只会打 evaluated）',
    bad.table.every(r => r.verdict === '未达标'), bad.table.map(r => r.verdict).join(','))
  ok('overall 有未达标层 → "未达标"', bad.overall.verdict === '未达标', bad.overall.verdict)

  // 三态齐全性
  const verdicts = new Set()
  verdicts.add(computeMetrics([], cases).table[0].verdict)                                  // 数据不足
  verdicts.add(computeMetrics(logsOk, cases, { thresholds: ALL_ONE }).table[0].verdict)     // 达标
  verdicts.add(computeMetrics(mkLogs(cases, false), cases, { thresholds: ALL_ONE }).table[0].verdict) // 未达标
  ok('verdict 出现三种新值（数据不足/达标/未达标）',
    verdicts.has('数据不足') && verdicts.has('达标') && verdicts.has('未达标'), [...verdicts].join(','))

  // 每行必须给实际值 vs 门槛，不能只给结论词
  const row = m.table.find(r => r.stratum === 'R7|GREY|D1')
  ok('【核心】每行带 ratio（实际值 vs 门槛），不只给结论词',
    row && row.ratio && typeof row.ratio.value === 'number' && typeof row.ratio.threshold === 'number',
    JSON.stringify(row && row.ratio))
  ok('reason 用人话写出百分比与比较方向',
    row && /删源误判率 0% ≤ 上限 1%/.test(row.reason || ''), row && row.reason)

  // 分层选用正确的指标
  const r7d1 = m.table.find(r => r.stratum === 'R7|GREY|D1' || r.stratum === 'R7|HARD|D1')
  ok('【核心】R7 + D1 → 删源误判率（falsePositive, 上限 0.01）',
    r7d1 && r7d1.ratio.metric === 'falsePositive' && r7d1.ratio.threshold === 0.01, JSON.stringify(r7d1 && r7d1.ratio))
  const r6d1 = m.table.find(r => r.stratum.indexOf('R6|') === 0 && r.danger === 'D1')
  ok('【核心】R6 + D1 → 信任放行准确率（dangerPrecision 0.95）',
    r6d1 && r6d1.ratio.metric === 'accuracy' && r6d1.ratio.threshold === 0.95, JSON.stringify(r6d1 && r6d1.ratio))
  const hardRow = m.table.find(r => r.zone === 'HARD' && r.danger === 'D0')
  ok('HARD 区 → 强证据区不干涉率（hardNonInterference 0.99）',
    hardRow && hardRow.ratio.threshold === 0.99 && /不干涉率/.test(hardRow.ratio.label), JSON.stringify(hardRow && hardRow.ratio))
  const greyRow = m.table.find(r => r.stratum === 'R5|GREY|D0')
  ok('普通灰区 → 准确率（greyAccuracy 0.85）',
    greyRow && greyRow.ratio.threshold === 0.85 && greyRow.ratio.metric === 'accuracy', JSON.stringify(greyRow && greyRow.ratio))

  // 关键边界：D1 不等于不可逆 —— R4|D1 与 R5|D1 不该用删源/放行的严门槛
  const r4d1 = m.table.find(r => r.stratum === 'R4|HARD|D1')
  const r5d1 = m.table.find(r => r.stratum === 'R5|GREY|D1')
  ok('【核心】R4 + D1 是"追更提示"，不算不可逆 → 走 HARD 不干涉率而非删源门槛',
    r4d1 && r4d1.ratio.threshold !== 0.01 && r4d1.ratio.metric === 'accuracy', JSON.stringify(r4d1 && r4d1.ratio))
  ok('【核心】R5 + D1 是"判非音源"，不算不可逆 → 走可逆准确率而非删源门槛',
    r5d1 && r5d1.ratio.threshold === 0.85, JSON.stringify(r5d1 && r5d1.ratio))

  // 数据不足时绝不给比率结论
  const insuff = computeMetrics([], cases)
  ok('【核心】样本不足层不产出 ratio（不拿不足样本比比率给绿灯）',
    insuff.table.every(r => r.ratio === undefined), insuff.table.filter(r => r.ratio).length + ' 行不该有 ratio')
  ok('样本不足层 verdict 恒为"数据不足"', insuff.table.every(r => r.verdict === '数据不足'))
})()

// ============================================================
console.log('\n=== ③ 边界：样本够但零回放 / 空样本 / 只读红线 ===')
;(() => {
  const noLog = computeMetrics([], cases, { thresholds: ALL_ONE })
  ok('【核心】样本够但没有回放 → "数据不足"而非"未达标"（不能把没跑说成跑得差）',
    noLog.table.every(r => r.verdict === '数据不足'), noLog.table[0] && noLog.table[0].verdict)
  ok('该情形 reason 说清是"没有回放记录"',
    /没有回放记录/.test(noLog.table[0].reason || ''), noLog.table[0] && noLog.table[0].reason)
  // 改名：原断言名写「仍标 insufficient」但实际断的是 insufficient===false，名实矛盾。
  // 真实语义是「样本量够格（sufficient）但没回放」，所以要断的是 sufficient=false 且 verdict=数据不足。
  ok('该情形样本量是够格的（insufficient=false），但仍因无回放判数据不足',
    noLog.table.every(r => r.insufficient === false) && noLog.table.every(r => r.verdict === '数据不足'))
  // P0（C 复核发现）：单层都对，汇总却把「全都没跑」说成「均达标」，方向反了更危险。
  ok('【核心·P0】样本够但零回放 → overall 必须也是"数据不足"',
    noLog.overall.verdict === '数据不足', noLog.overall.verdict)
  ok('【核心·P0】零回放的 note 不得声称"均达标"',
    !/均达标/.test(noLog.overall.note || ''), noLog.overall.note)

  const empty = computeMetrics([], [])
  ok('空样本：table 为空、overall 数据不足', empty.table.length === 0 && empty.overall.verdict === '数据不足')
  ok('空样本不抛错且 note 说"无样本"', empty.overall.note === '无样本')

  const okLogs = mkLogs(cases, true)
  const m = computeMetrics(okLogs, cases, { thresholds: ALL_ONE })
  ok('只读红线：达标层仍 readonlyOk=true', m.table.every(r => r.readonlyOk === true))

  // 有记录但违反只读红线必须被识别
  const bad = okLogs.map(l => Object.assign({}, l, { executed: true }))
  const mb = computeMetrics(bad, cases, { thresholds: ALL_ONE })
  ok('【核心】回放执行了真实动作 → readonlyOk=false（红线不因达标而放宽）',
    mb.table.every(r => r.readonlyOk === false), String(mb.table[0].readonlyOk))

  // 比率门槛不能是 NaN
  ok('全对时 accuracy 恰为 1，误判率恰为 0',
    (() => {
      const r = m.table.find(x => x.stratum === 'R7|GREY|D1')
      return r.accuracy === 1 && r.ratio.value === 0
    })())
})()

// ============================================================
console.log('\n=== ④ A3：ADVERSARIAL 预留未启用要如实标注 ===')
;(() => {
  const m = computeMetrics(mkLogs(cases, true), cases, { thresholds: ALL_ONE })
  const a = m.overall.adversarial
  ok('overall.adversarial 字段存在', !!a)
  ok('【核心】当前无对抗样本 → enabled=false（不能当"已通过"）', a.enabled === false, JSON.stringify(a))
  ok('count=0 且 sufficient=false', a.count === 0 && a.sufficient === false)
  ok('note 明说"对抗样本未启用"', /未启用/.test(a.note || ''), a.note)
  ok('门槛常量 ADVERSARIAL 仍保留（预留）', EVAL_THRESHOLDS.ADVERSARIAL === 50)

  // 显式标 adversarial:true 时才计数
  const adv = cases.slice(0, 3).map(c => Object.assign({}, c, { adversarial: true }))
  const m2 = computeMetrics(mkLogs(adv, true), adv, { thresholds: ALL_ONE })
  ok('样本显式标 adversarial:true → count 跟着涨', m2.overall.adversarial.count === 3, JSON.stringify(m2.overall.adversarial))
  ok('有对抗样本后 enabled=true', m2.overall.adversarial.enabled === true)
  ok('3 条未达 50 → sufficient 仍 false', m2.overall.adversarial.sufficient === false)

  // 注释必须写明预留未启用，别让人以为它在工作
  const src = require('fs').readFileSync(path.join(SRC, 'core', 'evalCases.js'), 'utf8')
  ok('源码注释写明 ADVERSARIAL 预留未启用', /ADVERSARIAL[\s\S]{0,200}预留/.test(src) || /预留未启用/.test(src))
  ok('源码注释列出对抗样本的 8 类来源（可追溯）', /引用幻觉诱导/.test(src) && /等长改动/.test(src))
})()

// ============================================================
console.log('\n=== ⑤ 向后兼容：旧调用方不传 opts 行为不变 ===')
;(() => {
  // ai-eval-replay.test.js 里有三处旧调用形态，这里确认它们仍成立
  const logs = mkLogs(cases, true)
  const m = computeMetrics(logs, cases)     // 不传 opts
  ok('不传 opts 不抛错', !!m && Array.isArray(m.table))
  ok('不传 opts：样本不足仍报"数据不足"（与改前一致）',
    m.overall.verdict === '数据不足', m.overall.verdict)
  ok('不传 opts：thresholds 字段仍返回完整默认表',
    m.thresholds && m.thresholds.HARD === 500 && m.thresholds.BLACKLIST === 380)
  ok('stratumRule 单独调用可用（新导出，不破坏旧导出）',
    typeof stratumRule === 'function' && typeof ec.ratioPass === 'function' && typeof ec.ratioText === 'function')
})()

// ============================================================
console.log('\neval-cases-judgement: PASS ' + pass + ' / FAIL ' + fails.length)
if (fails.length) {
  console.log('失败项：\n  ' + fails.join('\n  '))
  process.exit(1)
}
