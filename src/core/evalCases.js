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

// 方案文档门槛（本轮落地为常量，喂数据阶段按此判定是否可评估）。
const EVAL_THRESHOLDS = {
  HARD: 500,          // 强证据区样本量
  GREY: 200,          // 灰区盲标样本量
  DANGER: 100,        // 危险动作样本量
  BLACKLIST: 380,     // 删源样本量
  ADVERSARIAL: 50,    // 对抗样本量
  hardNonInterference: 0.99,  // 强证据区不干涉率
  greyAccuracy: 0.85,         // 灰区准确率
  dangerPrecision: 0.95,      // 危险动作精确率
  blacklistFalsePositive: 0.01 // 删源误判上限
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

/** 取某分层所需样本门槛：删源(R7 blacklist)用 BLACKLIST，D1 用 DANGER，按 zone 取 HARD/GREY。 */
function thresholdFor(caseOrKey) {
  const c = typeof caseOrKey === 'string' ? (() => {
    const parts = String(caseOrKey).split('|')
    return { kind: parts[0], expected: { zone: parts[1], danger: parts[2] } }
  })() : caseOrKey
  const k = String(c.kind).toUpperCase()
  const z = String(c.expected.zone)
  const d = String(c.expected.danger)
  if (k === 'R7' && d === 'D1') return EVAL_THRESHOLDS.BLACKLIST
  if (d === 'D1') return EVAL_THRESHOLDS.DANGER
  if (z === 'HARD') return EVAL_THRESHOLDS.HARD
  return EVAL_THRESHOLDS.GREY
}

/**
 * 计算指标。logs 是回放产生的 aiEvalLog 数组（含 aiAct/goldAct/executed/auditId/zone/danger），
 * cases 是样本数组。返回按分层可解释的指标表；样本不足的分层标 insufficient=true、不给通过结论。
 */
function computeMetrics(logs, cases, opts) {
  const o = opts || {}
  const th = Object.assign({}, EVAL_THRESHOLDS, o.thresholds || {})
  const byId = {}
  for (const c of (Array.isArray(cases) ? cases : [])) byId[c.id] = c
  const groups = groupByStratum(cases)
  const table = []
  for (const key of Object.keys(groups).sort()) {
    const cs = groups[key]
    const need = thresholdFor(key)
    const stratumLogs = (Array.isArray(logs) ? logs : []).filter(l => cs.some(c => c.id === l.entryId || c.id === l.caseId))
    const withAi = stratumLogs.filter(l => l.aiAct != null && l.aiAct !== '')
    const correct = stratumLogs.filter(l => l.goldAct != null && l.aiAct === l.goldAct)
    const n = cs.length
    const sufficient = n >= need
    const row = {
      stratum: key,
      kind: key.split('|')[0],
      zone: key.split('|')[1],
      danger: key.split('|')[2],
      n, need, sufficient,
      coverage: stratumLogs.length ? withAi.length / stratumLogs.length : 0,
      accuracy: stratumLogs.length ? correct.length / stratumLogs.length : 0,
      // 只读红线：回放不得执行真实动作、不得写审计
      readonlyOk: stratumLogs.every(l => l.executed === false && l.auditId == null),
      insufficient: !sufficient,
      verdict: sufficient ? 'evaluated' : '数据不足'
    }
    if (!sufficient) row.reason = 'n=' + n + ' < 门槛 ' + need
    table.push(row)
  }
  const anyInsufficient = table.some(r => r.insufficient)
  return {
    table,
    overall: {
      verdict: !table.length || anyInsufficient ? '数据不足' : 'evaluated',
      sampleCount: (Array.isArray(cases) ? cases.length : 0),
      note: !table.length ? '无样本' : (anyInsufficient ? '存在未达门槛的分层，不判通过' : '各分层样本达标')
    },
    thresholds: th
  }
}

module.exports = { KINDS, ZONES, DANGERS, EVAL_THRESHOLDS, validateCase, loadCases, groupByStratum, thresholdFor, computeMetrics }
