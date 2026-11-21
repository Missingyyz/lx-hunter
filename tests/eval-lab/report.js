'use strict'
/**
 * 影子评测报告：规则基线 vs AI 介入后对照，按 evalCases 的 HARM_DIR 口径判 harm/miss。
 * 三态 verdict（达标/未达标/数据不足）——样本不足时绝不写"达标"（最高原则）。
 * 报告顶部固定红字："评测能力，非放开授权"。
 */

// 与 src/core/evalCases.js:281 同口径（本目录不 import 生产 core 的评测模块，保持独立）
const HARM_DIR = { keep: 'blacklist', reject: 'trust', source: 'nonSource' }
const MIN_SAMPLES = 20  // 与 EVAL_THRESHOLDS 下限一致；不足即"数据不足"

/**
 * 对一组逐条对照结果算 harm/miss。
 * @param {Array<{id,goldAct,ruleAct,aiAct}>} rows
 * @returns {{harmCount,missCount,keepGoldCount,changedSources,verdict,reason}}
 */
function diffAndVerdict (rows) {
  const arr = Array.isArray(rows) ? rows : []
  let harmCount = 0, missCount = 0, keepGoldCount = 0
  const changedSources = []
  for (const r of arr) {
    const gold = String(r.goldAct || '')
    const ai = String(r.aiAct || '')
    const rule = String(r.ruleAct || '')
    if (gold === 'keep') keepGoldCount++
    // harm：gold 是好源/安全动作，AI 却做了不可逆的相反动作
    const harm = !!(HARM_DIR[gold] && ai === HARM_DIR[gold])
    if (harm) harmCount++
    // miss：gold 要求动手（删/信任/屏蔽），AI 却没动（可逆、代价低）
    const miss = !!gold && gold !== 'keep' && (ai === 'keep' || ai === 'skip' || !ai) && ai !== gold
    if (miss) missCount++
    if (ai !== rule) {
      changedSources.push({ id: r.id, goldAct: gold, ruleAct: rule, aiAct: ai,
        danger: harm ? 'false-delete/false-trust/false-block' : (miss ? 'miss' : 'benign') })
    }
  }
  let verdict = '数据不足', reason = ''
  if (arr.length < MIN_SAMPLES) {
    reason = `样本 ${arr.length} < 下限 ${MIN_SAMPLES}，不可判定达标`
  } else if (harmCount > 0) {
    verdict = '未达标'; reason = `不可逆方向误伤 ${harmCount} 条（最高原则：精准不误伤）`
  } else {
    verdict = '达标'; reason = `样本 ${arr.length} 达下限，误伤 0（漏判 ${missCount} 条，可逆）`
  }
  return { harmCount, missCount, keepGoldCount, changedSources, verdict, reason }
}

function makeReport (meta, rows) {
  const d = diffAndVerdict(rows)
  return Object.assign({
    _notice: '评测能力，非放开授权：本报告只说明"如果让 AI 改判定链会怎样"，不构成在生产放开任何自动操作的依据。',
    id: 'shadow-' + Date.now().toString(36),
    at: new Date().toISOString(),
    sandbox: meta.sandbox || {},
    scope: meta.scope || {},
    baseline: meta.baseline || {},
    aiMutated: meta.aiMutated || {},
    guard: meta.guard || {},
    thresholds: { minSamples: MIN_SAMPLES },
    artifacts: Object.assign({ discarded: true }, meta.artifacts || {})
  }, d)
}

module.exports = { diffAndVerdict, makeReport, HARM_DIR, MIN_SAMPLES }
