'use strict'
/**
 * AI 评测离线回放（零框架 / 零第三方依赖）：assert + pass/fail 计数。
 * 第一部分：纯函数单测（分区 / 调度 / 范围 / 只读白名单 / 日志 / 默认配置）；
 * 第二部分：buildEvalSnapshot → evidenceClass → makeEvalLog 链路离线自对拍。
 * 不调真实 AI、不 require 音源脚本、不读用户库与密钥；临时 Store 仅在系统临时目录且用完即删。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

const ROOT = path.join(__dirname, '..')
const core = (name) => path.join(ROOT, 'src', 'core', name)
const { buildEvalSnapshot, evidenceClass, makeEvalLog } = require(core('evalSnapshot'))
const { AIReview, RISK, AUTO_READONLY_KINDS } = require(core('aiReview'))
const { aiSchedulePlan, describeNextAIReview, selectScope, getActiveHoursOk } = require(core('aiSchedule'))
const { Store, DEFAULT_CONFIG } = require(core('store'))

const HOUR = 3600 * 1000
const T0 = new Date(2024, 0, 1, 10, 0, 0).getTime() // 本地 10 点，固定便于时段断言

/** 强证据对：账本 hash 与内容 hash 相同 + 双侧打分且非 declared + 版本可比（H1/H6）。 */
function strongPair() {
  const deep = (p50) => ({
    metrics: { depth: 'full', samples: 8, p50LatencyMs: p50, qualityMax: 'flac' },
    platforms: { kw: {}, kg: {} },
    checkedAt: T0
  })
  return {
    e: {
      id: 'fx-hard', name: '强证据样本', contentHash: 'hash-h1', scriptVersion: 'v2.1.0',
      repository: 'demo/repo', supportedSources: ['kw', 'kg'], deep: deep(120)
    },
    srv: {
      id: 'srv-hard', version: 'v1.0.0', repository: 'demo/repo',
      supportedSources: ['kw', 'kg'], deep: deep(180)
    }
  }
}

/** 灰区对：只有声明值 / 未打分 / 版本不可比。 */
function greyPair() {
  return {
    e: { id: 'fx-grey', name: '灰区样本', contentHash: 'hash-g1', scriptVersion: 'v2',
      deep: { metrics: { depth: 'shallow', samples: 0 } } },
    srv: { id: 'srv-grey', version: 'latest' }
  }
}

function strongSnap() {
  const { e, srv } = strongPair()
  return buildEvalSnapshot(e, srv, '/* code only for hash */', {}, {
    ledger: { hash: 'hash-h1', lxId: 'lx-demo', foreign: false }
  })
}

function greySnap() {
  const { e, srv } = greyPair()
  return buildEvalSnapshot(e, srv, '/* code only for hash */', {}, {
    ledger: { hash: 'hash-g1', lxId: 'lx-demo', foreign: false }
  })
}

console.log('--- ① evidenceClass：HARD / GREY / 宁可 GREY ---')
;(() => {
  const hard = strongSnap()
  ok(hard.profile.local.scored === true && hard.profile.local.declared === false, '强证据样本：本地已打分且非 declared')
  const h1 = evidenceClass(hard, 'replace')
  ok(h1.zone === 'HARD', '账本 hash 相同 + 版本可比 → HARD')
  ok(Array.isArray(h1.codes) && h1.codes.indexOf('H1') !== -1 && h1.codes.indexOf('H6') !== -1, 'HARD 给出 H1/H6 证据码')
  ok(h1.danger === 'D1', 'HARD × replace → D1')
  ok(evidenceClass(hard, 'skip').danger === 'D0' && evidenceClass(hard, 'rename').danger === 'D0', 'HARD × 其余动作 → D0')

  const grey = greySnap()
  ok(grey.version.comparable === false && grey.profile.server.declared === true, '灰区样本：版本不可比且仅声明值')
  const g1 = evidenceClass(grey, 'replace')
  ok(g1.zone === 'GREY', 'declared / unscored / 不可比 → GREY')
  ok(g1.codes.indexOf('G1') !== -1 && g1.codes.indexOf('G2') !== -1 && g1.codes.indexOf('G4') !== -1, 'GREY 给出 G1/G2/G4 缺失证据码')
  ok(g1.danger === 'D1', '灰区 × replace 仍标 D1（最高危格 GREY×D1 可被识别）')

  let threw = false
  let emptyZone = null
  try {
    emptyZone = evidenceClass({}).zone
    evidenceClass(null)
    buildEvalSnapshot(null, null, null, null, null)
    makeEvalLog(null)
  } catch (e) { threw = true }
  ok(threw === false, '极端缺失字段不抛错')
  ok(emptyZone === 'GREY', '空快照判 GREY，不误判 HARD')
  const declaredBait = Object.assign({}, hard, { profile: Object.assign({}, hard.profile, {
    local: Object.assign({}, hard.profile.local, { declared: true })
  }) })
  ok(evidenceClass(declaredBait, 'replace').zone === 'GREY', 'H 码齐全但任一侧 declared → 退回 GREY（宁可 GREY）')
})()

console.log('--- ② aiSchedulePlan：关闭 / 到期 / 未到期 / 时段外 ---')
;(() => {
  const off = aiSchedulePlan({ enabled: true, autoEnabled: false, autoIntervalHours: 24 }, {}, T0)
  ok(off.due === false && /关闭/.test(off.reason), 'autoEnabled=false → due=false 且 reason 含「关闭」')
  const masterOff = aiSchedulePlan({ enabled: false, autoEnabled: true }, {}, T0)
  ok(masterOff.due === false && /关闭/.test(masterOff.reason), '总开关关闭同样不触发')

  const cfg = { enabled: true, autoEnabled: true, autoIntervalHours: 24, autoScope: 'failed', autoMaxItems: 20 }
  const old = { lastAttempt: T0 - 48 * HOUR, lastRun: T0 - 48 * HOUR }
  const due = aiSchedulePlan(cfg, old, T0)
  ok(due.due === true, 'enabled+autoEnabled 且水位很久以前 → due=true')
  ok(due.scope === 'failed' && due.limit === 20 && due.intervalHours === 24, 'plan 回传 scope/limit/intervalHours')

  const fresh = aiSchedulePlan(cfg, { lastAttempt: T0 - 60 * 1000, lastRun: T0 - 60 * 1000 }, T0)
  ok(fresh.due === false && /未到期/.test(fresh.reason), '水位刚更新 → due=false')

  const outHours = aiSchedulePlan(Object.assign({}, cfg, { autoActiveHours: { start: 2, end: 4 } }), old, T0)
  ok(outHours.activeNow === false && outHours.due === false && /时段外/.test(outHours.reason), 'autoActiveHours 时段外 → activeNow=false 且 due=false')
  ok(getActiveHoursOk({ autoActiveHours: { start: 9, end: 12 } }, T0) === true, 'getActiveHoursOk：时段内为 true')
  const desc = describeNextAIReview(due)
  ok(typeof desc === 'string' && /仅失败源/.test(desc) && /20条/.test(desc), 'describeNextAIReview 输出可读中文描述')
})()

console.log('--- ③ selectScope：各范围筛选 / limit 截断 / 排除 deprecated+private ---')
;(() => {
  const sources = [
    { id: 's-failed', error: 'timeout', deep: { checkedAt: T0 } },
    { id: 's-dead', status: 'dead', deep: { checkedAt: T0 } },
    { id: 's-quarantined', status: 'quarantined', error: 'x', deep: { checkedAt: T0 } },
    { id: 's-new', lastCheck: 0, deep: { checkedAt: 0 } },
    { id: 's-fresh', status: 'ok' },
    { id: 's-old', lastCheck: T0, deep: { checkedAt: T0 } },
    { id: 's-deprecated', error: 'x', deprecated: true },
    { id: 's-private', error: 'x', private: true }
  ]
  const failed = selectScope(sources, 'failed', 20, T0)
  ok(failed.join(',') === 's-failed,s-dead,s-quarantined', 'failed 范围命中 error / dead / quarantined')
  const fresh = selectScope(sources, 'new', 20, T0)
  ok(fresh.join(',') === 's-new,s-fresh', 'new 范围命中未检新源')
  ok(selectScope(sources, 'quarantined', 20, T0).join(',') === 's-quarantined', 'quarantined 范围只取隔离源')
  ok(selectScope(sources, 'all', 20, T0).length === 6, 'all 范围取全部有效条目')
  ok(selectScope(sources, 'all', 2, T0).join(',') === 's-failed,s-dead', 'limit=2 正确截断')
  for (const scope of ['new', 'failed', 'quarantined', 'all']) {
    const got = selectScope(sources, scope, 20, T0)
    ok(got.indexOf('s-deprecated') === -1 && got.indexOf('s-private') === -1, scope + ' 范围均排除 deprecated / private')
  }
  ok(sources.length === 8, 'selectScope 不修改传入数组')
})()

console.log('--- ④ 自动只读白名单红线：R1-R3 only ---')
;(() => {
  ok(typeof AIReview === 'function' && RISK && typeof RISK === 'object', 'aiReview 导出 AIReview / RISK')
  ok(Array.isArray(AUTO_READONLY_KINDS) && AUTO_READONLY_KINDS.join(',') === 'R1,R2,R3', 'AUTO_READONLY_KINDS 恰为 R1/R2/R3')
  ok(['R4', 'R5', 'R6', 'R7'].every(k => AUTO_READONLY_KINDS.indexOf(k) === -1), '白名单不含任何可执行风险级 R4-R7')
  ok(RISK.R6.needsIrreversible === true && RISK.R7.needsIrreversible === true, 'R6/R7 仍标记为不可逆高危')
})()

console.log('--- ⑤ makeEvalLog：字段齐全 / 默认档 / 不执行 / id 唯一 ---')
;(() => {
  const log = makeEvalLog({ entryId: 'e1', zone: 'GREY' })
  const need = ['id', 'ts', 'phase', 'batch', 'entryId', 'srvId', 'zone', 'zoneCodes', 'danger',
    'ruleAct', 'ruleWhy', 'aiAct', 'aiWhy', 'goldAct', 'gate', 'executed', 'auditId', 'undoed', 'outcome']
  ok(need.every(k => k in log), 'aiEvalLog 字段齐全（' + need.length + ' 项）')
  ok(log.phase === 'replay', 'phase 默认 replay')
  ok(log.executed === false && log.auditId === null && log.undoed === false, '默认 executed=false 且无审计/撤销记录')
  ok(log.danger === 'D0' && Array.isArray(log.zoneCodes), 'danger 默认 D0，zoneCodes 默认数组')
  ok(log.entryId === 'e1' && log.zone === 'GREY', '传入字段覆盖默认值')
  ok(makeEvalLog().id !== makeEvalLog().id, 'id 唯一')
})()

console.log('--- ⑥ store 默认配置：自动挡新增字段（临时目录，用完即删） ---')
;(() => {
  const d = DEFAULT_CONFIG.aiReview
  ok(d.autoEnabled === false && d.autoScope === 'failed' && d.autoMaxItems === 20 && d.shadowEval === false,
    'DEFAULT_CONFIG.aiReview 新字段默认安全值')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-evalreplay-'))
  try {
    const s = new Store(dir)
    const a = s.config.aiReview
    ok(a.autoEnabled === false && a.autoScope === 'failed', 'new Store：autoEnabled=false / autoScope=failed')
    ok(a.autoMaxItems === 20 && a.shadowEval === false, 'new Store：autoMaxItems=20 / shadowEval=false')
    ok(a.autoActiveHours && a.autoActiveHours.start === 0 && a.autoActiveHours.end === 24, 'new Store：默认全天时段')
    ok(s.db.aiEvalLog && typeof s.db.aiEvalLog === 'object', 'new Store：db.aiEvalLog 已初始化')
    ok(a.clusterLearnEnabled === true && a.clusterLearnMinSamples === 5 && a.clusterLearnMaxRules === 40,
      'new Store：自生长配置默认（开/5样本/40规则上限）')
    ok(s.db.aiClusterSamples && s.db.aiClusterRules, 'new Store：db 样本池与规则表已初始化')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()

console.log('--- ⑦ 离线回放：快照 → 分区 → 日志（规则自对拍，不调 AI） ---')
/** 只读取文本、按 @name 取标识；绝不 require / 执行音源脚本。 */
function readFixtureTexts(limit) {
  const dir = path.join(__dirname, 'fixtures')
  const out = []
  try {
    if (!fs.existsSync(dir)) return out
    for (const name of fs.readdirSync(dir)) {
      if (out.length >= limit) break
      if (!/^_real_.*\.js$/i.test(name)) continue
      try {
        const file = path.join(dir, name)
        if (!fs.statSync(file).isFile()) continue
        const text = fs.readFileSync(file, 'utf8')
        const m = /@name\s+([^\r\n]+)/.exec(text)
        out.push({ file, name: m ? m[1].trim().slice(0, 40) : name, text })
      } catch (e) { console.log('  SKIP ' + name + '：' + e.message) }
    }
  } catch (e) { console.log('  SKIP fixtures 目录：' + e.message) }
  return out
}

;(() => {
  const cases = []
  // 两个固定合成样本：保证链路在任何环境下都有 HARD + GREY 各一条。
  cases.push({ label: '合成-强证据', snap: strongSnap(), ruleAct: 'replace', expect: 'HARD' })
  cases.push({ label: '合成-灰区', snap: greySnap(), ruleAct: 'replace', expect: 'GREY' })

  // 真实样本只取文本：先探一次拿到 codeHash，再把账本 hash 对齐，演示“账本↔内容”对拍。
  const fixtures = readFixtureTexts(2)
  if (!fixtures.length) console.log('  SKIP 真实样本：tests/fixtures 无可读 _real_*.js（改用合成样本）')
  for (const fx of fixtures) {
    try {
      const e = {
        id: 'fx-real-' + fx.name, name: fx.name, scriptVersion: 'v2.1.0',
        supportedSources: ['kw', 'kg'],
        deep: { metrics: { depth: 'full', samples: 5, p50LatencyMs: 130, qualityMax: 'flac' },
          platforms: { kw: {}, kg: {} }, checkedAt: T0 }
      }
      const srv = {
        id: 'srv-real-' + fx.name, version: 'v1.0.0', supportedSources: ['kw', 'kg'],
        deep: { metrics: { depth: 'full', samples: 5, p50LatencyMs: 160, qualityMax: 'flac' },
          platforms: { kw: {}, kg: {} }, checkedAt: T0 }
      }
      const probe = buildEvalSnapshot(e, srv, fx.text, {}, null)
      const snap = buildEvalSnapshot(e, srv, fx.text, {}, {
        ledger: { hash: probe.codeHash, lxId: 'lx-demo', foreign: false },
        inputDigest: fx.name
      })
      ok(snap.codeHash === probe.codeHash, fx.name + '：脚本正文只用于算 hash，不写入快照')
      ok(JSON.stringify(snap).indexOf(fx.text.slice(0, 80)) === -1 && /API_KEY|apiKey/.test(JSON.stringify(snap)) === false,
        fx.name + '：快照脱敏（不含脚本文字与密钥）')
      cases.push({ label: '真实-' + fx.name, snap, ruleAct: 'replace', expect: 'HARD' })
    } catch (err) { console.log('  SKIP ' + fx.name + '：无法安全解析（' + err.message + '）') }
  }

  const logs = []
  let hard = 0, grey = 0, d1 = 0
  for (const c of cases) {
    const cls = evidenceClass(c.snap, c.ruleAct)
    const log = makeEvalLog({
      batch: 'offline-replay', entryId: c.snap.entryId, srvId: c.snap.srvId,
      zone: cls.zone, zoneCodes: cls.codes, danger: cls.danger,
      ruleAct: c.ruleAct, ruleWhy: '规则基线自对拍', aiAct: null,
      gate: { auto: false, reason: '离线回放不执行' }, executed: false
    })
    ok(log.zone === c.expect, c.label + '：链路分区符合预期（' + c.expect + '）')
    ok(log.danger === (c.ruleAct === 'replace' ? 'D1' : 'D0') && log.executed === false && log.auditId === null,
      c.label + '：链路日志 danger/executed 合法（AI 只判不改）')
    logs.push(log)
    if (cls.zone === 'HARD') hard++
    if (cls.zone === 'GREY') grey++
    if (cls.danger === 'D1') d1++
  }
  ok(logs.length === cases.length, '每条样本都产出一条合法 aiEvalLog')
  ok(new Set(logs.map(l => l.id)).size === logs.length, '回放批次日志 id 互不重复')
  console.log('\nAI EVAL REPLAY: 样本 ' + cases.length + ' / HARD ' + hard + ' / GREY ' + grey + ' / D1 ' + d1 + ' / 链路OK')
  // 契约提醒：上游若漏写 profile.*.scored / declared（undefined），硬码齐全的残缺快照仍可能判 HARD。
  console.log('  NOTE: 证据分区依赖显式 scored/declared 字段；缺失时请按 GREY 兜底。')
})()

console.log('--- ⑩ 影子钩子参数契约：buildEvalSnapshot 收 cfg（非 verdict）/ evidenceClass 收 ruleAct ---')
;(() => {
  const hunterPath = path.join(ROOT, 'src', 'core', 'hunter.js')
  const hunterMod = require(hunterPath)
  const Hunter = hunterMod.Hunter || hunterMod
  const fn = Hunter.prototype && Hunter.prototype._aiShadowEval
  ok(typeof fn === 'function', 'Hunter.prototype._aiShadowEval 可用')

  const snap = require(core('evalSnapshot'))
  const origBuild = snap.buildEvalSnapshot
  let gotCfg = null, gotRuleAct = '__unset__'
  snap.buildEvalSnapshot = function (e, srv, code, cfg, opt) { gotCfg = cfg; return origBuild.apply(this, arguments) }
  const origClass = snap.evidenceClass
  snap.evidenceClass = function (s, ruleAct) { gotRuleAct = ruleAct; return origClass.apply(this, arguments) }
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-shadow-'))
    const s = new Store(dir)
    s.config.aiReview = Object.assign({}, s.config.aiReview, { enabled: true, shadowEval: true })
    const a = new AIReview(s)
    const fakeThis = { store: s, _ai: () => a }
    const cfgTag = { mode: 'assist', version: 'v-shadow-test', promptVersion: 'pv1' }
    const entry = { id: 'shadow-e1', contentHash: 'h1', scriptVersion: 'v2', repository: 'd/r', supportedSources: ['kw', 'kg'], deep: { metrics: { depth: 'full', samples: 6, p50LatencyMs: 120, qualityMax: 'flac' }, platforms: { kw: {}, kg: {} }, checkedAt: Date.now() } }
    const srv = { id: 'shadow-s1', version: 'v1', repository: 'd/r', supportedSources: ['kw', 'kg'], deep: { metrics: { depth: 'full', samples: 6, p50LatencyMs: 180, qualityMax: 'flac' }, platforms: { kw: {}, kg: {} }, checkedAt: Date.now() } }
    const verdict = { act: 'replace', why: '规则铁判' }
    fn.call(fakeThis, entry, srv, '/* code */', verdict, cfgTag, { ledger: { hash: 'h1', foreign: false } })
    ok(gotCfg === cfgTag, 'buildEvalSnapshot 第4参是 cfg（不是 verdict）——参数错位已修')
    ok(gotRuleAct === 'replace', 'evidenceClass 第2参是 ruleAct（danger 才有意义）')
    const logs = Object.keys(s.db.aiEvalLog || {}).map(k => s.db.aiEvalLog[k]).filter(l => l.entryId === 'shadow-e1')
    ok(logs.length === 1, '影子旁路写入 1 条 aiEvalLog')
    ok(logs[0] && logs[0].danger === 'D1', 'replace 裁决 → danger=D1（非恒 D0）')
    ok(logs[0] && (logs[0].zone === 'HARD' || logs[0].zone === 'GREY'), 'zone 合法（' + (logs[0] && logs[0].zone) + '）')
    ok(logs[0] && logs[0].ruleAct === 'replace' && logs[0].executed === false && logs[0].auditId === null, '影子日志只读：ruleAct 记录、executed=false、无审计')
    ok(Object.keys(s.db.sources || {}).length === 0, '影子旁路不改 sources')
  } finally {
    snap.buildEvalSnapshot = origBuild
    snap.evidenceClass = origClass
  }
})()

console.log('--- ⑪ R4-R7 指标 + 数据不足（评测台子；产建议链路见 ai-review.test.js 第6步） ---')
;(() => {
  const ec = require(core('evalCases'))
  const cases = ec.loadCases(path.join(ROOT, 'tests', 'eval-cases'))
  ok(cases.length >= 4, '样本加载 >=4 条（实际 ' + cases.length + '）')
  ok(typeof ec.validateCase({ id: 'x' }) === 'string' && ec.validateCase({ id: 'x' }).length > 0, 'validateCase 拒绝缺字段样本')
  ok(cases.every(c => c.sensitivity === 'pii-free' && !/API_KEY|apiKey/.test(JSON.stringify(c.input))), '样本脱敏：pii-free 且无密钥字样')

  // 桩回放：按人工标注 goldAct 充当 aiAct，构造只读 aiEvalLog（run 产建议链路已在 ai-review.test.js 验证）
  const logs = cases.map(c => makeEvalLog({
    phase: 'replay', entryId: c.id, kind: c.kind,
    aiAct: c.goldAct, goldAct: c.goldAct,
    zone: c.expected.zone, danger: c.expected.danger,
    executed: false, auditId: null
  }))
  ok(logs.every(l => l.goldAct && l.executed === false && l.auditId === null), '回放日志 goldAct 非空且只读（无执行/审计）')

  const m = ec.computeMetrics(logs, cases)
  ok(m.overall.verdict === '数据不足', '样本量未达门槛 → overall 判「数据不足」而非通过')
  ok(m.table.length >= 4 && m.table.every(r => r.insufficient === true && r.verdict === '数据不足'),
    '4 个分层均标数据不足（' + m.table.map(r => r.stratum).join(' ') + '）')
  ok(m.table.every(r => r.accuracy === 1 && r.readonlyOk === true), '桩回放 accuracy=1 且全部只读')
  ok(ec.thresholdFor('R7|GREY|D1') === 380 && ec.thresholdFor('R4|GREY|D0') === 200,
    '门槛落地：R7 删源=380，灰区=200')
  // 样本补齐到门槛后应判 evaluated，证明「数据不足」不是写死
  const many = []
  for (let i = 0; i < 210; i++) many.push(Object.assign({}, cases[0], { id: 'r4-' + i, expected: Object.assign({}, cases[0].expected) }))
  const logsMany = many.map(c => makeEvalLog({ entryId: c.id, aiAct: c.goldAct, goldAct: c.goldAct, executed: false, auditId: null }))
  const mM = ec.computeMetrics(logsMany, many)
  const r4 = mM.table.find(r => r.stratum.indexOf('R4|') === 0)
  ok(r4 && r4.sufficient === true && r4.verdict === 'evaluated', '样本达 200 → R4 分层可评估（数据不足非写死）')
})()

console.log('\nai-eval-replay: PASS ' + pass + ' / FAIL 0')
