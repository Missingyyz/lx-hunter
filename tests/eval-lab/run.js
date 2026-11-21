'use strict'
/**
 * 判定链/去重/灌入/排序 影子评测 lab（阶段8，物理隔离）。
 *
 * 运行：NODE_ENV=test LX_EVAL_SANDBOX=1 DATA_DIR=<主库目录> node tests/eval-lab/run.js
 * 三重断言：LX_EVAL_SANDBOX==='1' && NODE_ENV!=='production' && 副本路径!==DATA_DIR。
 * 任一不满足立即 process.exit(1)——生产镜像不含本目录，且 NODE_ENV 写死 production。
 *
 * 主库只读快照 → 临时 Store 副本 → 副本上跑确定性基线 + 模拟 AI 介入 → diff 报告 →
 * finally 丢弃副本。全程不 import 主库 store 单例、不写主库、不调网络 adapter。
 */
const fs = require('fs')
const path = require('path')
const { makeShadowStore, discard } = require('./snapshot-copy')
const { makeReport } = require('./report')

const { compareVerdict, compareImportQuality } = require('../../src/core/quality')
const { sortSources } = require('../../src/renderer/sorters')
const { buildEvalSnapshot, evidenceClass } = require('../../src/core/evalSnapshot')

function fail (msg) { console.error('[eval-lab] 拒绝运行：' + msg); process.exit(1) }

// 三重断言（在任何副作用之前）
if (process.env.LX_EVAL_SANDBOX !== '1') fail('LX_EVAL_SANDBOX 未置 1')
if (process.env.NODE_ENV === 'production') fail('NODE_ENV=production（生产禁止影子评测）')
const MAIN_DIR = process.env.DATA_DIR || ''
if (!MAIN_DIR) fail('DATA_DIR 未设置（无从确定只读来源）')

let shadow = null
try {
  shadow = makeShadowStore(MAIN_DIR)
  const sources = Object.values(shadow.snapshot.sources || {})
  console.log('[eval-lab] 副本已建：' + shadow.dir + '，样本 ' + sources.length + ' 条（主库只读，未改）')

  // ① 判定链基线：对每条源用确定性证据分区（HARD/GREY）产出 ruleAct/gold（HARD 区规则即 gold）。
  const rows = []
  for (const e of sources) {
    const snap = buildEvalSnapshot(e, {}, null, {}, {})
    const cls = evidenceClass(snap, 'skip')  // 基线按保守 skip 取证（不删）
    const zone = cls.zone
    // 规则基线：HARD 区证据充分 → 按 sortKey 决定 keep/replace；GREY → skip（不误伤）
    let ruleAct = 'skip'
    if (zone === 'HARD') {
      const cmp = compareVerdict(e, {})
      ruleAct = cmp.cmp > 0 ? 'keep' : 'skip'
    }
    // gold：HARD 区以规则为准；GREY 区无 gold（不纳入 harm 分母，宁可"数据不足"）
    const goldAct = zone === 'HARD' ? ruleAct : ''
    // 模拟 AI 介入：只在 GREY 区把 skip 翻成 replace（最激进的误伤形态），HARD 区保持规则。
    // 这是"如果让 AI 改判定链"的最坏情况对照，不是生产行为。
    const aiAct = (zone === 'GREY') ? 'replace' : ruleAct
    rows.push({ id: e.id, zone, danger: cls.danger, goldAct, ruleAct, aiAct })
  }

  // ② 去重基线：副本 Store 上跑 dedupe 会写副本 sources.json（不碰主库）；此处只统计基线计数。
  // 纯函数 compareImportQuality / sortSources 直接喂脱敏对象，零副作用。
  const sortedBaseline = sortSources(sources, { key: 'plat', dir: 'desc' }, shadow.store.imported || {})
  const sortedIds = sortedBaseline.map(s => s.id)
  const qualityRanked = sources.slice().sort(compareImportQuality).map(s => s.id)

  // ③ 灌入队列基线：_planImportQueue 未导出且需 Hunter 实例，影子 lab 只做"若 AI 改 skip 会怎样"的
  // 抽象对照（用判定链的 aiAct 代替 queue.skip），不调真网络/写盘。生产灌入逻辑不因本 lab 改变。
  const changedByKind = {
    verdict: rows.filter(r => r.aiAct !== r.ruleAct).length,
    dedupe: 0,   // 去重是确定性规则，影子不模拟 AI 改（复刻成本高且无 gold）
    import: 0,
    sort: sortedIds.join(',') === qualityRanked.join(',') ? 0 : 1
  }

  const report = makeReport({
    sandbox: { nodeEnv: process.env.NODE_ENV, dataDir: '[redacted]', isIsolated: true },
    scope: { kinds: ['R2', 'R5', 'R6', 'R7', 'dedupe', 'import', 'sort'], sampleCount: sources.length },
    baseline: {
      zoneCounts: rows.reduce((m, r) => { m[r.zone] = (m[r.zone] || 0) + 1; return m }, {}),
      sortTop20Ids: sortedIds.slice(0, 20),
      dedupeChanged: changedByKind.dedupe, importChanged: changedByKind.import
    },
    aiMutated: { verdictFlips: changedByKind.verdict, sortChanged: changedByKind.sort },
    guard: { evidencePassRate: sources.length ? rows.filter(r => r.zone === 'HARD').length / sources.length : 0 }
  }, rows)

  const outDir = path.join(__dirname, 'reports')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, report.id + '.json')
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log('[eval-lab] 报告：' + outFile)
  console.log('[eval-lab] verdict=' + report.verdict + ' | harm=' + report.harmCount +
    ' miss=' + report.missCount + ' | ' + report.reason)
  console.log('[eval-lab] ' + report._notice)
} catch (e) {
  console.error('[eval-lab] 运行失败：' + (e && e.stack || e))
  process.exitCode = 1
} finally {
  if (shadow) discard(shadow)
  console.log('[eval-lab] 临时副本已丢弃（artifacts.discarded=true），主库未改动')
}
