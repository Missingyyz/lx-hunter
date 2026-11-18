'use strict'
/**
 * 反馈闭环 MVP 针对性回归（隔离数据，不联网、不碰 /data）：
 *  - feedbackStats()/selfCheck() 零 AI（mock provider.chat 计数=0）
 *  - 采纳率/偏置/一致性候选聚合正确
 *  - 老 db（无 feedback/无 aiEvalLog）兼容 → dataInsufficient，不抛错
 *  - 两壳 dismiss/apply/evalReport 契约镜像（源码断言）
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Store } = require('../src/core/store')
const { AIReview } = require('../src/core/aiReview')
const provider = require('../src/core/aiProvider')

let pass = 0
const ok = (c, label) => { assert.ok(c, label); pass++; console.log('  PASS', label) }
const R = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
const webSrc = R('server/web.js')
const mainSrc = R('main/index.js')
const preSrc = R('main/preload.js')
const bridgeSrc = R('renderer/web-bridge.js')
const appSrc = R('renderer/app.js')

function store() { return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-feedback-'))) }

console.log('--- 1. 零 AI 保证（mock provider.chat 计数=0） ---')
{
  const original = provider.chat
  let calls = 0
  provider.chat = async function () { calls++; return { ok: true, text: '{}' } }
  try {
    const s = store()
    const a = new AIReview(s)
    s.db.aiSuggestions = {
      a1: { id: 'a1', kind: 'R7', status: 'applied', feedback: { action: 'adopt' }, eval: { verdict: 'blacklist', promptVersion: 'v2' } },
      a2: { id: 'a2', kind: 'R7', status: 'dismissed', feedback: { action: 'dismiss' }, eval: { verdict: 'keep', promptVersion: 'v2' } },
      a3: { id: 'a3', kind: 'R5', status: 'applied', feedback: { action: 'adopt' }, eval: { verdict: 'nonSource', promptVersion: 'v1' } }
    }
    const fs1 = a.feedbackStats()
    const sc = a.selfCheck()
    ok(calls === 0, 'feedbackStats + selfCheck 共调用 provider.chat 0 次')
    ok(fs1.total === 3 && fs1.adopt === 2 && fs1.dismiss === 1, '采纳/忽略计数正确')
  } finally { provider.chat = original }
}

console.log('--- 2. feedbackStats 聚合与"数据不足" ---')
{
  const s = store()
  const a = new AIReview(s)
  // 空 db（老库无任何字段）
  ok(a.feedbackStats().dataInsufficient === true, '老 db 无建议 → 数据不足')
  // 4 条表态（<5）仍不足：3 adopt + 1 dismiss
  s.db.aiSuggestions = {}
  for (let i = 0; i < 3; i++) s.db.aiSuggestions['x' + i] = { id: 'x' + i, kind: 'R3', feedback: { action: 'adopt' }, eval: { promptVersion: 'v1' } }
  s.db.aiSuggestions.x3 = { id: 'x3', kind: 'R3', feedback: { action: 'dismiss' }, eval: { promptVersion: 'v1' } }
  ok(a.feedbackStats().dataInsufficient === true, '表态数 <5 → 数据不足')
  // 补第 5 条 dismiss → 3 adopt / 2 dismiss = 60%
  s.db.aiSuggestions.x4 = { id: 'x4', kind: 'R3', feedback: { action: 'dismiss' }, eval: { promptVersion: 'v1' } }
  const st = a.feedbackStats()
  ok(st.dataInsufficient === false && st.overallRate === 60, '5 条表态采纳率=60%，非数据不足')
  ok(/忽略≠误判/.test(st.note), 'note 明确"忽略≠误判"')
  const kv = st.byKind.find(b => b.kind === 'R3')
  ok(kv && kv.adopt === 3 && kv.dismiss === 2 && kv.rate === 60, '按 kind 聚合正确')
}

console.log('--- 3. selfCheck 偏置/一致性候选/老db兼容 ---')
{
  const s = store()
  const a = new AIReview(s)
  ok(a.selfCheck().dataInsufficient === true, '老 db 无影子日志/建议 → 数据不足')
  // 5 条 R7 verdict 全 blacklist → 单边偏置 100%
  s.db.aiSuggestions = {}
  for (let i = 0; i < 5; i++) s.db.aiSuggestions['b' + i] = {
    id: 'b' + i, kind: 'R7', eval: { verdict: 'blacklist', promptVersion: 'v2' }, feedback: { action: 'adopt' }
  }
  // 1 条 blacklist 却 dismiss → 唯一明确的相悖项，进一致性候选
  s.db.aiSuggestions.k1 = { id: 'k1', kind: 'R7', eval: { verdict: 'blacklist' }, feedback: { action: 'dismiss' } }
  // 1 条 keep + adopt（AI建议保留、用户采纳）本就一致，不该算冲突
  s.db.aiSuggestions.k2 = { id: 'k2', kind: 'R5', eval: { verdict: 'keep' }, feedback: { action: 'adopt' } }
  s.db.aiEvalLog = { e1: { zone: 'GREY', danger: 'D1', ruleAct: 'delete' }, e2: { zone: 'HARD', danger: 'D0', ruleAct: 'block' } }
  const sc = a.selfCheck()
  ok(sc.dataInsufficient === false || sc.bias.length > 0, '有足够样本时不再标数据不足')
  const bias = sc.bias.find(b => b.kind === 'R7')
  ok(bias && bias.verdict === 'blacklist' && bias.share === 100, 'R7 verdict 单边集中 → 偏置提示 100%')
  ok(sc.distribution.some(d => d.stratum.indexOf('GREY×D1') === 0), '影子日志按 zone×danger 分布')
  ok(/待复评|待人工复评/.test(sc.note) && /不判对错/.test(sc.note), '自检 note 声明不判对错、不改门控')
  ok(sc.consistencyCandidates.some(c => c.id === 'k1'), 'blacklist+dismiss 列为一致性候选')
  ok(!sc.consistencyCandidates.some(c => c.id === 'k2'), 'keep+adopt 本就一致，不列为冲突')
}

console.log('--- 4. 两壳契约镜像（dismiss/apply feedback/evalReport） ---')
for (const [name, src] of [['web', webSrc], ['main', mainSrc]]) {
  ok(/feedback = \{ action: 'adopt'/.test(src), name + ' apply 记 adopt 采纳信号')
  ok(new RegExp(name === 'web' ? "route\\('POST', '/api/ai-review/dismiss'" : "ipcMain.handle\\('ai-review:dismiss'").test(src), name + ' 有 dismiss handler')
  ok(/feedback = \{ action: 'dismiss'/.test(src) && /status = 'dismissed'/.test(src), name + ' dismiss 只写 status+feedback')
  ok(/feedbackStats: a\.feedbackStats\(\), selfCheck: a\.selfCheck\(\)/.test(src), name + ' evalReport 追加 feedbackStats+selfCheck')
}
ok(/aiSuggestionIgnore: .*ai-review\/dismiss|aiSuggestionIgnore: .*ai-review:dismiss/.test(preSrc + bridgeSrc), '两桥 aiSuggestionIgnore 指向 dismiss')
// v1.14（用户 2026-11-18 拍板）：忽略改为「本次会话」语义——只做本地隐藏，不再调后端 dismiss。
// 原先这里断言 app.js 必须调 api.aiSuggestionIgnore 持久化，那正好是本次要去掉的行为：
// 持久化会让一次误点变成不可逆（建议永远不再出现，且界面无「恢复」入口）。
// 后端的 dismiss 路由与统计仍保留（供采纳率口径与将来可能的显式入口使用），只是 UI 不再自动触发。
ok(!/api\.aiSuggestionIgnore\(\{ id: s\.id, byUser: true \}\)/.test(appSrc), 'app.js 忽略动作不再调后端 dismiss（会话级）')
ok(/aiIgnoredIds\.add\(id\)/.test(appSrc), 'app.js 忽略只记本地集合（会话级生效）')

console.log(`\n反馈闭环 MVP 回归全部通过（${pass} 项）`)
