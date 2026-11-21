'use strict'
/**
 * R8 隔离区「AI 看可信度」只读入口验证（v1.15.0）。
 * 三件事分开：试跑(能不能出链·事实) / R8(可不可信·价值判断) / R6(是否放行·改状态)。
 * R8 红线：独立 verdict 分域 credible/suspicious、永不自动、永不进 apply、不碰业务状态。
 * 零框架，assert + 计数。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

const ROOT = path.join(__dirname, '..')
const { Store } = require(path.join(ROOT, 'src', 'core', 'store'))
const { AIReview, RISK, REVIEW_PROMPTS } = require(path.join(ROOT, 'src', 'core', 'aiReview'))

function tmpStore() { return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-r8-'))) }

console.log('--- ① R8 分类与 prompt 契约 ---')
ok(!!RISK.R8 && RISK.R8.autoIn.length === 0 && !RISK.R8.needsIrreversible,
  'R8 注册为低风险、autoIn=[]、非不可逆')
ok(!!REVIEW_PROMPTS.R8 && REVIEW_PROMPTS.R8.verdicts.join(',') === 'credible,suspicious',
  'R8 独立 verdict 枚举 credible/suspicious（与 R6 trust/reject 分域）')
ok(REVIEW_PROMPTS.R6.verdicts.join(',') === 'trust,reject' &&
  REVIEW_PROMPTS.R8.verdicts.every(v => REVIEW_PROMPTS.R6.verdicts.indexOf(v) === -1),
  'R8 与 R6 verdict 完全不相交，防下游误接成放行依据')
ok(typeof REVIEW_PROMPTS.R8.buildText === 'function' && /深度摘要/.test(REVIEW_PROMPTS.R8.buildText({})),
  'R8 复用 R6 的客观字段输入构造')
ok(/仅供参考|不要输出.*放行|绝不改变/.test(REVIEW_PROMPTS.R8.system),
  'R8 prompt 明确"仅供参考、不做放行决定、不业务状态"')

console.log('--- ② R8 永不自动、永不进 apply ---')
;(() => {
  const s = tmpStore()
  s.config.aiReview.enabled = true
  s.config.aiReview.autoEnabled = true
  const a = new AIReview(s)
  const g = a.gate('R8')
  ok(g.auto === false && /只读/.test(g.reason), 'R8 gate 恒拒绝自动（即便只读授权位开、自动挡开）')
  const ex = AIReview.FEATURE_EXECUTORS.R8
  ok(ex && ex.mode === 'advisory' && ex.noApply === true && ex.noAuto === true && ex.run === null,
    'R8 executor 声明 advisory + noApply + noAuto + 无 run 实现')
  for (const [label, src] of [
    ['web.js', fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')],
    ['main/index.js', fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')]
  ]) {
    const m = src.match(/APPLYABLE\s*=\s*new Set\(\[[^\]]*\]\)/)
    ok(!!m && !/R8/.test(m[0]), label + ' apply 白名单不含 R8')
  }
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
  const am = app.match(/AI_ACTIONABLE_VERDICT[\s\S]{0,300}/)
  ok(!!am && !/R8/.test(am[0]), '前端动作白名单不含 R8（chip 无「处理」按钮）')
})()

console.log('--- ③ R8 产建议但不碰业务状态 ---')
;(async () => {
  const s = tmpStore()
  const a = new AIReview(s)
  a.cfg.enabled = true
  a.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
  a.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'suspicious', reason: '外联域名可疑且实测全平台不可用' }) } }] }) })
  const beforeSources = JSON.stringify(s.db.sources || {})
  const beforeTrust = JSON.stringify(s.config.trustedObfHashes || [])
  const r = await a.run('R8', { entryId: 'q1', trigger: 'manual',
    name: '混淆源A', repository: 'r', error: '', obfLevel: 'high',
    deep: { checkedAt: 1, platforms: [{ status: 'unusable' }] } })
  ok(!!r.suggestion && r.suggestion.kind === 'R8' && r.suggestion.status === 'pending',
    'R8 产 pending 建议')
  ok(r.suggestion.eval && r.suggestion.eval.verdict === 'suspicious', 'R8 结构化 verdict=suspicious 入 eval')
  ok(r.suggestion.gateEval && r.suggestion.gateEval.pass === false, 'R8 gateEval.pass=false（永不自动）')
  ok(JSON.stringify(s.db.sources || {}) === beforeSources, 'R8 后 sources 逐字未变（不隔离/不放行/不删）')
  ok(JSON.stringify(s.config.trustedObfHashes || []) === beforeTrust, 'R8 后 trustedObfHashes 未变（不写信任名单）')
  ok(Object.keys(s.db.aiAudit || {}).length === 0, 'R8 不写审计（无业务动作可审计）')

  console.log('\nR8 只读入口: PASS ' + pass + ' / FAIL 0')
})().catch(e => { console.error('\nR8 只读入口: FAIL\n', e); process.exitCode = 1 })
