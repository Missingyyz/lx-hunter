'use strict'
/**
 * B4：评测指标「不可测量」的展示口径测试（v1.13.10）
 *
 * 背景：后端 `evalCases.stratumRule` 早在 P0-2 就正确产出
 * `ratio.unmeasurable=true` 与「误伤率无法计算」的 reason，但前端 `app.js` 的
 * `loadFeedbackStats` **完全不渲染 metrics**——用户只能看到采纳率与自检，
 * 于是「删源这一层从没被验证过」在界面上彻底不可见，看起来一切正常。
 *
 * 本测试锁两件事：
 *   1. 后端给「分母为 0」的层打 unmeasurable，且 reason 里出现「无法计算」，**不得出现 0%**；
 *   2. 前端渲染函数（app.js 里那段拼接）对 unmeasurable 行必须说「样本构成不全/测不了/
 *      算不出来」，且**不得**把 value 当 0% 显示。
 *
 * 第 2 点用「源码级断言」而不是跑浏览器：app.js 是渲染进程脚本、依赖 window，
 * 在 node 里跑不起来；但它的展示文案是确定的，直接断言源码里那段逻辑存在且含关键措辞，
 * 能挡住「以后有人把这段删了」的回归（这正是本 B4 的起因）。
 */
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const ec = require(path.join(ROOT, 'src', 'core', 'evalCases'))

let pass = 0; let fail = 0
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) } else { fail++; console.log('  FAIL ' + name + (extra != null ? ' :: ' + extra : '')) }
}

// ============================================================
console.log('\n=== ① 后端：分母为 0 的层必须标 unmeasurable，且措辞不得出现 0% ===')
;(() => {
  // 构造一个「只有 blacklist」的 R7|HARD|D1 层（keepGold=0）
  const cases = [
    { id: 'b1', kind: 'R7', expected: { verdict: 'blacklist', zone: 'HARD', danger: 'D1' }, goldAct: 'blacklist', input: {} },
    { id: 'b2', kind: 'R7', expected: { verdict: 'blacklist', zone: 'HARD', danger: 'D1' }, goldAct: 'blacklist', input: {} }
  ]
  const logs = cases.map(c => ({ kind: 'R7', zone: 'HARD', danger: 'D1', aiAct: 'keep', goldAct: 'blacklist', caseId: c.id, executed: false, auditId: null }))
  const m = ec.computeMetrics(logs, cases, { thresholds: { HARD: 1, GREY: 1, DANGER: 1, BLACKLIST: 1, fixedSampleTh: true } })
  const row = m.table.find(r => r.stratum === 'R7|HARD|D1')
  ok('分母为 0 → ratio.unmeasurable=true', !!row && row.ratio && row.ratio.unmeasurable === true, row && JSON.stringify(row.ratio))
  ok('该层 verdict=数据不足（不冒充达标/未达标）', !!row && row.verdict === '数据不足', row && row.verdict)
  ok('reason 明说「无法计算」', !!row && /无法计算/.test(row.reason || ''), row && row.reason)
  ok('reason 不得出现「0%」冒充测出来是 0', !!row && !/删源误伤率\s*0%/.test(row.reason || ''), row && row.reason)
  ok('总评不得因该层被判达标', m.overall.verdict !== '达标', m.overall.verdict)
})()

// ============================================================
console.log('\n=== ② 前端：app.js 必须真的渲染 metrics 并说清「不可测量」 ===')
;(() => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
  // 找到 loadFeedbackStats 那段
  const idx = src.indexOf('async function loadFeedbackStats')
  ok('存在 loadFeedbackStats', idx !== -1)
  const seg = src.slice(idx, idx + 9000)
  ok('该段引用了 d.metrics（以前完全不渲染指标）', /d\.metrics/.test(seg))
  ok('该段遍历 metrics.table', /m\.table/.test(seg))
  ok('该段对 unmeasurable 单独分支处理', /unmeasurable/.test(seg))
  ok('不可测量的文案说「样本构成不全」或「测不了」',
    /样本构成不全/.test(seg) || /测不了/.test(seg), '缺关键措辞')
  ok('不可测量分支里明确「不是 0%」', /不是 ?0%/.test(seg), '需明确否掉 0% 的读法')
  ok('展示整体结论 overall.verdict', /overall/.test(seg))
  // 关键回归：不可测量分支必须在「正常比率分支」之前，否则会先命中 value=0 显示 0%
  const iUnm = seg.indexOf('unmeasurable === true')
  const iVal = seg.indexOf('typeof r.ratio.value === \'number\'')
  ok('unmeasurable 分支排在「显示百分比」分支之前（否则会先显示 0%）',
    iUnm !== -1 && iVal !== -1 && iUnm < iVal, 'iUnm=' + iUnm + ' iVal=' + iVal)
})()

// ============================================================
console.log('\n=== ③ 真实样本：补 keep 后 R7|D1 不再不可测量 ===')
;(() => {
  const cases = ec.loadCases(path.join(ROOT, 'tests', 'eval-cases'))
  const r7d1 = cases.filter(c => c.kind === 'R7' && c.expected.danger === 'D1')
  const keepN = r7d1.filter(c => c.goldAct === 'keep').length
  const blackN = r7d1.filter(c => c.goldAct === 'blacklist').length
  ok('R7|D1 的 gold=keep 样本文本 > 0（B1 之前是 0）', keepN > 0, 'keepGold=' + keepN)
  ok('R7|D1 的 gold=keep 样本 ≥ 60（任务要求的可观测下限）', keepN >= 60, 'keepGold=' + keepN)
  console.log('    〔数字〕R7|D1 keep=' + keepN + ' blacklist=' + blackN)
})()

console.log('\ndedupe-eval-display: PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
