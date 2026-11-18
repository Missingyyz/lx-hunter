'use strict'
/**
 * P-1432「重度混淆脚本自动信任规则」端到端测试（mock 环境，不联网、不碰真实 /data）。
 *
 * 真实 bug：hunter.js 用了 obfDomainVerdict 却从未 import → 该规则一旦触发就抛
 * ReferenceError: obfDomainVerdict is not defined，灌入/检测链路崩（实测 72 秒后崩）。
 * 本测试直接驱动 `Hunter.applyObfGate`（obfDomainVerdict 的唯一调用点），
 * 构造「重度混淆 + 无硬特征(eval/spin/selfSched 全 0) + 白名单外联域名」的条目，
 * 验证：①不再抛 ReferenceError ②规则真正生效（自动信任放行 / 白名单外才隔离）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Store } = require('../src/core/store')
const { Hunter } = require('../src/core/hunter')
const { obfDomainVerdict, obfuscationRisk } = require('../src/core/checker')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}

/**
 * 造「重度混淆但无硬特征」的脚本：_0x 标识符密度远超 HIGH_0X(20/KB)，
 * 但**不含** eval / new Function / while(!![]){} / _0x..(_0x..,0x..) 自调度 / jsjiami。
 * 即：纯密度型 high —— 正是自动信任规则要放行的那类。
 */
function denseObfCode(extraLines) {
  const parts = []
  // 每行 8 个 _0x 标识符；60 行 → 480 个/约 6KB ≈ 80/KB，稳过 20/KB
  for (let i = 0; i < 60; i++) {
    const row = []
    for (let j = 0; j < 8; j++) row.push('_0x' + (0x1000 + i * 8 + j).toString(16) + '=1')
    parts.push(row.join(','))
  }
  const body = parts.join(';\n') + ';\n' + (extraLines || '')
  return { code: body, risk: obfuscationRisk(body) }
}

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-obf-'))
  const s = new Store(dir)
  // 隔离测试环境：DEFAULT_CONFIG 里 trustedObfHashes/trustedObfDomains 是数组字面量，
  // 而 Store 用 Object.assign({}, DEFAULT_CONFIG, rawCfg) 浅拷贝 → 多个 Store 会共享同一数组。
  // 这里给每个 store 独立数组，避免用例互相污染（该浅拷贝问题另见报告）。
  s.config.trustedObfHashes = []
  s.config.trustedObfDomains = []
  return s
}

/** 造一条重度混淆源（带 contentHash / deep 实测平台），用于走 applyObfGate */
function mkEntry(id, code, deepUrls) {
  const { sha256Str } = require('../src/core/checker')
  const platforms = {}
  ;(deepUrls || []).forEach((u, i) => { platforms['p' + i] = { status: 'usable', url: u } })
  return {
    id, repo: 'r', path: id + '.js', name: id, code,
    contentHash: sha256Str(code),
    status: 'ok', usable: true, deep: { checkedAt: Date.now(), platforms }
  }
}

function main() {
  console.log('=== ① obfDomainVerdict 可正确引用、调用不抛 ===')
  {
    const r = obfDomainVerdict(['music.163.com', 'evil.example.com'], [])
    ok('obfDomainVerdict 是函数可直接调用', typeof obfDomainVerdict === 'function' && !!r)
    ok('白名单域 clean、白名单外进 suspect', r.clean === false && r.suspect.length === 1 && r.suspect[0] === 'evil.example.com', JSON.stringify(r))
    ok('全白名单 → clean=true', obfDomainVerdict(['music.163.com', 'y.qq.com'], []).clean === true)
    ok('自定义白名单生效', obfDomainVerdict(['mycdn.example.com'], ['example.com']).clean === true)
  }

  console.log('\n=== ② 构造的脚本确实是「重度混淆且无硬特征」 ===')
  const { code, risk } = denseObfCode()
  ok('obfuscationRisk 判为 high（纯密度型）', risk.level === 'high', JSON.stringify(risk.hits))
  ok('无 eval/new Function（evalCalls=0）', risk.hits.evalCalls === 0, 'evalCalls=' + risk.hits.evalCalls)
  ok('无空转死循环（spinLoops=0）', risk.hits.spinLoops === 0, 'spin=' + risk.hits.spinLoops)
  ok('无混淆自调度（selfSchedCalls=0）', risk.hits.selfSchedCalls === 0, 'selfSched=' + risk.hits.selfSchedCalls)

  console.log('\n=== ③ 端到端：自动信任规则触发时不再抛 ReferenceError ===')
  {
    const store = mkStore()
    store.config.excludeHighRiskObfuscated = true   // 打开混淆闸门
    store.config.autoTrustCleanObf = true
    const logs = []
    const h = new Hunter(store, (t, p) => { if (t === 'log' && p && p.msg) logs.push(p.msg) })

    // 场景 A：沙箱实测外联域名全在音乐生态白名单 → 应「自动信任」放行
    const eA = mkEntry('autoA', code, ['https://music.163.com/api/song/url'])
    const listA = [eA]
    let threwA = null, resA = null
    try { resA = h.applyObfGate(listA, x => x.code, '灌入前') } catch (e) { threwA = e }
    ok('重度混淆+无硬特征+白名单域名：不再抛 obfDomainVerdict is not defined',
      threwA === null, threwA && String(threwA.message))
    ok('自动信任真正生效（status=ok、obfAutoTrust=true、未隔离）',
      !!eA && eA.obfAutoTrust === true && eA.status === 'ok' && eA.quarantined !== true,
      JSON.stringify({ t: eA && eA.obfAutoTrust, s: eA && eA.status, q: eA && eA.quarantined }))
    ok('自动信任后条目仍在放行列表里（list 未被剔除）', listA.length === 1 && listA[0] === eA)
    ok('返回统计 trusted>=1', resA && resA.trusted >= 1, JSON.stringify(resA))
    ok('信任哈希写回 config（可追溯、后续免重评）',
      Array.isArray(store.config.trustedObfHashes) && store.config.trustedObfHashes.includes(eA.contentHash))
  }

  console.log('\n=== ④ 白名单外域名：走隔离分支（verdict.suspect 路径同样不崩） ===')
  {
    const store = mkStore()
    store.config.excludeHighRiskObfuscated = true
    store.config.autoTrustCleanObf = true
    const h = new Hunter(store, () => {})
    // 注意：与场景 A 用不同正文（末尾加一行），避免 contentHash 相同而被 A 的信任哈希命中
    const { code: codeB } = denseObfCode('var hostile=1;')
    const eB = mkEntry('autoB', codeB, ['https://evil-cdn.example.org/x'])
    const listB = [eB]
    let threwB = null, resB = null
    try { resB = h.applyObfGate(listB, x => x.code, '检测') } catch (e) { threwB = e }
    ok('白名单外域名：同样不抛（覆盖 verdict.suspect 分支）', threwB === null, threwB && String(threwB.message))
    ok('被隔离（quarantined=true、status=quarantined）',
      !!eB && eB.quarantined === true && eB.status === 'quarantined',
      JSON.stringify({ q: eB && eB.quarantined, s: eB && eB.status }))
    ok('记录了隔离原因（含白名单外域名）', /白名单外域名/.test(String(eB.obfHoldReason || '')), String(eB.obfHoldReason))
    ok('条目被移出放行列表', listB.length === 0)
    ok('返回统计 rejected=1', resB && resB.rejected === 1, JSON.stringify(resB))
  }

  console.log('\n=== ⑤ 有硬特征（eval）时不出自动信任分支（判据未被改动） ===')
  {
    const store = mkStore()
    store.config.excludeHighRiskObfuscated = true
    store.config.autoTrustCleanObf = true
    const h = new Hunter(store, () => {})
    const { code: c2 } = denseObfCode('eval("1+1");')
    const eC = mkEntry('hardC', c2, ['https://music.163.com/api/song/url'])
    const listC = [eC]
    let threw = null
    try { h.applyObfGate(listC, x => x.code, '检测') } catch (e) { threw = e }
    ok('含 eval 的条目：不抛', threw === null, threw && String(threw.message))
    ok('含 eval（硬特征）→ 不自动信任、直接隔离',
      !!eC && eC.obfAutoTrust !== true && eC.quarantined === true,
      JSON.stringify({ at: eC && eC.obfAutoTrust, q: eC && eC.quarantined }))
  }

  console.log('\n' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS（' + pass + ' 项）'))
  process.exit(fail ? 1 : 0)
}
main()
