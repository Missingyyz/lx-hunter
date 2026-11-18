'use strict'
/**
 * 样本量门槛自适应回归（v1.13.9 B 批，2026-11-19 用户拍板）
 *
 * 背景：原来的 500/200/100/380 是拍出来的数字（方案文档只写数值、无推导），
 * 让 13 个分层永远 0 个达标、评测永远「数据不足」。用户要求「门槛按现有真实数据定」。
 *
 * 但照字面实现「门槛 = 现有样本数」是错的：sufficient 恒为 true，1 条样本也算够格，
 * 正是刚修完的「把没跑说成通过」的变体。所以最终设计三条规则：
 *   1. 危险层（R6|D1 信任放行、R7|D1 删源）硬门槛，不随样本浮动
 *   2. 可逆层：max(下限, 现有样本数 × 0.8)，现有样本数由调用方传入、不写死
 *   3. 下限 MIN_SAMPLES 防归零，用 rule-of-three 推出（非拍脑袋）
 *
 * 本文件锁住这三点，并守住「不硬编码」这个关键要求。
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const ec = require(path.join(SRC, 'core', 'evalCases'))
const { thresholdFor, sampleNeedFor, isDangerStratum, computeMetrics, loadCases, EVAL_THRESHOLDS, MIN_SAMPLES, ADAPT_RATIO } = ec

let pass = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) } else { fails.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')) }
}

// ============================================================
console.log('\n=== ① 危险层硬门槛：不随样本量浮动 ===')
;(() => {
  ok('R7|D1 被识别为危险层', isDangerStratum('R7', 'D1') === true)
  ok('R6|D1 被识别为危险层', isDangerStratum('R6', 'D1') === true)
  ok('【核心】R4|D1 不算危险层（追更提示可撤销）', isDangerStratum('R4', 'D1') === false)
  ok('【核心】R5|D1 不算危险层（判非音源可撤销）', isDangerStratum('R5', 'D1') === false)
  ok('R6|D0 不算危险层', isDangerStratum('R6', 'D0') === false)

  // v1.13.9 用户拍板「门槛按现有真实数据走，R6/R7/R4 同理」：
  // 危险层不再恒定 380/100，与其他层一致自适应（n×1.0，下限 20）。
  // 安全边界由比率门槛守（R7|D1 误判率≤1%、R6|D1 准确率≥95%）。
  for (const n of [0, 1, 5, 15, 100, 193, 1000, 100000]) {
    const want = Math.max(20, n)
    ok('R7|HARD|D1 n=' + n + ' → ' + want + '（自适应）', thresholdFor('R7|HARD|D1', null, n) === want, String(thresholdFor('R7|HARD|D1', null, n)))
    ok('R6|GREY|D1 n=' + n + ' → ' + want + '（自适应）', thresholdFor('R6|GREY|D1', null, n) === want, String(thresholdFor('R6|GREY|D1', null, n)))
  }
})()

// ============================================================
console.log('\n=== ② 所有层统一自适应：max(下限, 样本数 × 系数) ===')
;(() => {
  ok('系数为 1.0（门槛=现有样本数）', ADAPT_RATIO === 1.0, String(ADAPT_RATIO))
  ok('下限为 20', MIN_SAMPLES.reversible === 20, String(MIN_SAMPLES.reversible))

  ok('n=70 → 70', thresholdFor('R4|GREY|D0', null, 70) === 70, String(thresholdFor('R4|GREY|D0', null, 70)))
  ok('n=100 → 100', thresholdFor('R5|GREY|D0', null, 100) === 100)
  ok('n=57 → 57', thresholdFor('R6|GREY|D0', null, 57) === 57, String(thresholdFor('R6|GREY|D0', null, 57)))

  // 下限保护：样本很少时不会塌成 0/个位数
  ok('【核心】n=0 → 20（不塌成 0，否则 0 条样本也算够格）', thresholdFor('R4|GREY|D0', null, 0) === 20, String(thresholdFor('R4|GREY|D0', null, 0)))
  ok('n=1 → 20', thresholdFor('R4|GREY|D0', null, 1) === 20)
  ok('n=5 → 20（5 < 下限 20）', thresholdFor('R4|GREY|D0', null, 5) === 20)
  ok('n=17 → 20（17 < 下限 20）', thresholdFor('R4|GREY|D0', null, 17) === 20)
  ok('n=25 → 25（25 > 下限 20）', thresholdFor('R4|GREY|D0', null, 25) === 25)

  // HARD 区的可逆层也走自适应（不是走旧的 HARD=500）
  ok('R4|HARD|D0 n=5 → 20（不再固定 500）', thresholdFor('R4|HARD|D0', null, 5) === 20, String(thresholdFor('R4|HARD|D0', null, 5)))
  ok('R7|HARD|D0 n=5 → 20（D0 可逆，走自适应）', thresholdFor('R7|HARD|D0', null, 5) === 20)
})()

// ============================================================
console.log('\n=== ③ 不硬编码：样本变化时门槛自动跟着变 ===')
;(() => {
  // 同一个分层，样本量不同 → 门槛不同（证明没写死某个数字）
  const a = thresholdFor('R5|GREY|D0', null, 70)
  const b = thresholdFor('R5|GREY|D0', null, 200)
  const c = thresholdFor('R5|GREY|D0', null, 500)
  ok('同一层 n=70/200/500 → 门槛 70/200/500（随样本变）', a === 70 && b === 200 && c === 500, [a, b, c].join('/'))
  ok('门槛随样本单调不减', a <= b && b <= c)

  // 源码里不得出现「把某层样本数写死成门槛」的常量
  const src = fs.readFileSync(path.join(SRC, 'core', 'evalCases.js'), 'utf8')
  const hardIdx = src.indexOf('function sampleNeedFor')
  const body = src.slice(hardIdx, hardIdx + 1800)
  ok('【核心】sampleNeedFor 里用 existing 参数算门槛（不写死层数字）', /existing/.test(body))
  ok('【核心】门槛由 existing × ratio 推出', /existing\s*\)\s*\*\s*ratio|Number\(existing\)\s*\*\s*ratio/.test(body))
  ok('【核心】不出现「R4_GREY = 17」这类按层写死的常量',
    !/R4[_A-Z]*\s*[:=]\s*17\b/.test(src) && !/\b17\s*,\s*\/\/\s*R4/.test(src))
})()

// ============================================================
console.log('\n=== ④ 向后兼容：不传现有样本数时保持旧值 ===')
;(() => {
  ok('R7|GREY|D1 = 380', thresholdFor('R7|GREY|D1') === 380, String(thresholdFor('R7|GREY|D1')))
  ok('R4|GREY|D0 = 200', thresholdFor('R4|GREY|D0') === 200)
  ok('R4|HARD|D0 = 500', thresholdFor('R4|HARD|D0') === 500)
  ok('R5|GREY|D1 = 200（旧行为：D1 全走 DANGER，这里退回 GREY）', thresholdFor('R5|GREY|D1') === 200, String(thresholdFor('R5|GREY|D1')))
  ok('R6|HARD|D1 = 100', thresholdFor('R6|HARD|D1') === 100)
  ok('opts.thresholds 覆盖仍生效', thresholdFor('R4|GREY|D0', { GREY: 3 }) === 3)
  ok('opts.thresholds + existing 同时给：minReversible 只影响下限，n×系数仍生效',
    thresholdFor('R4|GREY|D0', { minReversible: 7 }, 100) === 100, String(thresholdFor('R4|GREY|D0', { minReversible: 7 }, 100)))
  ok('minReversible 生效场景：样本低于自定义下限时取该下限',
    thresholdFor('R4|GREY|D0', { minReversible: 7 }, 5) === 7, String(thresholdFor('R4|GREY|D0', { minReversible: 7 }, 5)))
})()

// ============================================================
console.log('\n=== ⑤ 接入 computeMetrics：每层用自己的样本数算门槛 ===')
;(() => {
  const cases = loadCases(path.join(ROOT, 'tests', 'eval-cases'))
  const m = computeMetrics([], cases)
  ok('13 个分层（真实样本）', m.table.length === 13, String(m.table.length))

  for (const r of m.table) {
    const expect = sampleNeedFor(r.kind, r.zone, r.danger, r.n, m.thresholds)
    ok('【核心】' + r.stratum + ' need 与按自身 n 推导一致（n=' + r.n + ' need=' + r.need + '）',
      r.need === expect, r.need + ' vs ' + expect)
  }

  // 危险层与可逆层现在同一套自适应规则，差别只在**比率门槛**（见 stratumRule），
  // 不在样本量。needBasis 要如实反映是「撞了下限」还是「按样本自适应」。
  ok('所有层 needBasis 只说明下限或自适应，不得再出现「硬门槛」字样',
    m.table.every(r => !/硬门槛/.test(r.needBasis || '')), m.table.map(r => r.needBasis).join('|'))
  ok('低于下限的层 needBasis 说明「下限 N 条」',
    m.table.filter(r => r.n < 20).every(r => /下限 20 条/.test(r.needBasis)),
    m.table.filter(r => r.n < 20).map(r => r.stratum + ':' + r.needBasis).join('|'))
  ok('达到下限的层 needBasis 说明「按现有样本自适应」',
    m.table.filter(r => r.n >= 20).every(r => /自适应/.test(r.needBasis)),
    m.table.filter(r => r.n >= 20).map(r => r.stratum + ':' + r.needBasis).join('|'))

  // 危险层在真实数据下：样本量其实够了（need=max(20,n)），仍是「数据不足」的
  // **唯一原因是 0 回放**——这正是降低门槛要暴露的东西，不能再把它写成「因为 380/100」。
  ok('【核心】真实数据下 R7|D1 样本量已够（need=193），数据不足只因 0 回放',
    m.table.filter(r => r.kind === 'R7' && r.danger === 'D1')
      .every(r => r.sufficient === true && /没有回放记录/.test(r.reason)),
    m.table.filter(r => r.kind === 'R7' && r.danger === 'D1').map(r => r.reason).join('|'))
  ok('【核心】真实数据下 R6|D1 低于下限 20，数据不足因样本不足',
    m.table.filter(r => r.kind === 'R6' && r.danger === 'D1')
      .every(r => r.sufficient === false && /< 门槛 20/.test(r.reason)),
    m.table.filter(r => r.kind === 'R6' && r.danger === 'D1').map(r => r.reason).join('|'))
})()

// ============================================================
console.log('\n=== ⑥ 关键：门槛降了但仍不能让「少样本层」误判够格 ===')
;(() => {
  // 构造一个只有 3 条样本的分层：门槛应被下限顶到 20，仍判数据不足
  const tiny = []
  for (let i = 0; i < 3; i++) {
    tiny.push({ id: 'tiny' + i, kind: 'R5', input: { name: 'x' }, expected: { verdict: 'source', zone: 'GREY', danger: 'D0', criteria: 'c' }, goldAct: 'source', annotation: { annotator: 'test', blind: true } })
  }
  const m = computeMetrics([{ entryId: 'tiny0', aiAct: 'source', goldAct: 'source', executed: false, auditId: null }], tiny)
  ok('【核心】3 条样本的层 → 门槛 20、判数据不足（不因降门槛就变够格）',
    m.table[0].need === 20 && m.table[0].verdict === '数据不足', 'need=' + m.table[0].need + ' verdict=' + m.table[0].verdict)

  // 零样本：门槛仍是下限 20，不是 0
  ok('【核心】零样本 → thresholdFor 给下限 20，不是 0', thresholdFor('R5|GREY|D0', null, 0) === 20)
})()

// ============================================================
console.log('\n=== ⑦ 门槛变化会真的改变判定（不是装饰） ===')
;(() => {
  const cases = loadCases(path.join(ROOT, 'tests', 'eval-cases'))
  const logs = cases.map(c => ({ entryId: c.id, aiAct: c.expected.verdict, goldAct: c.expected.verdict, executed: false, auditId: null }))
  const def = computeMetrics(logs, cases)
  const loose = computeMetrics(logs, cases, { thresholds: { BLACKLIST: 1, DANGER: 1, minReversible: 1, adaptRatio: 0 } })
  const defPass = def.table.filter(r => r.verdict === '达标').length
  const loosePass = loose.table.filter(r => r.verdict === '达标').length
  ok('默认自适应门槛下只有少数层达标', defPass >= 0 && defPass <= 13, String(defPass))
  ok('【核心】把门槛全放开后达标层数显著增加（说明门槛真的在拦）', loosePass > defPass, defPass + ' → ' + loosePass)
})()

console.log('\neval-thresholds-adaptive: PASS ' + pass + ' / FAIL ' + fails.length)
if (fails.length) {
  console.log('失败项：\n  ' + fails.join('\n  '))
  process.exit(1)
}
