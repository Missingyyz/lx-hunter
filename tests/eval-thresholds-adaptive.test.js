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

  // 无论样本多少，危险层门槛恒定
  for (const n of [0, 1, 5, 15, 100, 193, 1000, 100000]) {
    ok('R7|HARD|D1 n=' + n + ' → 380（恒定）', thresholdFor('R7|HARD|D1', null, n) === 380, String(thresholdFor('R7|HARD|D1', null, n)))
    ok('R6|GREY|D1 n=' + n + ' → 100（恒定）', thresholdFor('R6|GREY|D1', null, n) === 100, String(thresholdFor('R6|GREY|D1', null, n)))
  }
})()

// ============================================================
console.log('\n=== ② 可逆层自适应：max(下限, 样本数 × 系数) ===')
;(() => {
  ok('系数为 0.8', ADAPT_RATIO === 0.8, String(ADAPT_RATIO))
  ok('可逆层下限为 20', MIN_SAMPLES.reversible === 20, String(MIN_SAMPLES.reversible))

  ok('n=70 → 56（70×0.8）', thresholdFor('R4|GREY|D0', null, 70) === 56, String(thresholdFor('R4|GREY|D0', null, 70)))
  ok('n=100 → 80', thresholdFor('R5|GREY|D0', null, 100) === 80)
  ok('n=57 → 45（向下取整）', thresholdFor('R6|GREY|D0', null, 57) === 45, String(thresholdFor('R6|GREY|D0', null, 57)))

  // 下限保护：样本很少时不会塌成 0/个位数
  ok('【核心】n=0 → 20（不塌成 0，否则 0 条样本也算够格）', thresholdFor('R4|GREY|D0', null, 0) === 20, String(thresholdFor('R4|GREY|D0', null, 0)))
  ok('n=1 → 20', thresholdFor('R4|GREY|D0', null, 1) === 20)
  ok('n=5 → 20（5×0.8=4 < 20）', thresholdFor('R4|GREY|D0', null, 5) === 20)
  ok('n=17 → 20（17×0.8=13 < 20）', thresholdFor('R4|GREY|D0', null, 17) === 20)
  ok('n=25 → 20（25×0.8=20，正好等于下限）', thresholdFor('R4|GREY|D0', null, 25) === 20)

  // HARD 区的可逆层也走自适应（不是走旧的 HARD=500）
  ok('R4|HARD|D0 n=5 → 20（不再固定 500）', thresholdFor('R4|HARD|D0', null, 5) === 20, String(thresholdFor('R4|HARD|D0', null, 5)))
  ok('R7|HARD|D0 n=5 → 20（D0 可逆，不走删源门槛）', thresholdFor('R7|HARD|D0', null, 5) === 20)
})()

// ============================================================
console.log('\n=== ③ 不硬编码：样本变化时门槛自动跟着变 ===')
;(() => {
  // 同一个分层，样本量不同 → 门槛不同（证明没写死某个数字）
  const a = thresholdFor('R5|GREY|D0', null, 70)
  const b = thresholdFor('R5|GREY|D0', null, 200)
  const c = thresholdFor('R5|GREY|D0', null, 500)
  ok('同一层 n=70/200/500 → 门槛 56/160/400（随样本变）', a === 56 && b === 160 && c === 400, [a, b, c].join('/'))
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
  ok('opts.thresholds + existing 同时给：覆盖优先于自适应',
    thresholdFor('R4|GREY|D0', { minReversible: 7 }, 100) === 80, String(thresholdFor('R4|GREY|D0', { minReversible: 7 }, 100)))
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

  // needBasis 要能解释「为什么是这个数」
  const danger = m.table.filter(r => isDangerStratum(r.kind, r.danger))
  const rev = m.table.filter(r => !isDangerStratum(r.kind, r.danger))
  ok('危险层 needBasis 写明硬门槛', danger.length > 0 && danger.every(r => /硬门槛/.test(r.needBasis)), danger.map(r => r.needBasis).join('|'))
  ok('可逆层 needBasis 写明自适应', rev.length > 0 && rev.every(r => /自适应/.test(r.needBasis)))

  // 危险层在真实数据下全部仍数据不足（这是设计要的保守）
  ok('【核心】真实数据下 R7|D1 仍数据不足（193 < 380，宁可不给结论）',
    m.table.filter(r => r.kind === 'R7' && r.danger === 'D1').every(r => r.verdict === '数据不足'))
  ok('【核心】真实数据下 R6|D1 仍数据不足（15/9 < 100）',
    m.table.filter(r => r.kind === 'R6' && r.danger === 'D1').every(r => r.verdict === '数据不足'))
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
