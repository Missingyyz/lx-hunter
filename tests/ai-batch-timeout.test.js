'use strict'
/**
 * AI 批量语义预判「自动分批防超时」针对性测试（mock provider.chat，不联网、不碰真实 /data）。
 * 背景：真实 1668 条源里 37 条有 updateTips，一次性让模型输出 37 条 JSON 超过 20 秒超时 → 返回 {}（功能失效）。
 * 修复：classifyUpdateTips / classifyColdStart 内部自动分批（每批≤12、串行、独立 try/catch、总上限120）。
 * 覆盖：①37条→4批(12/12/12/1)总调用4次、合并37条 ②中间某批失败→只缺该批、其余照常、不抛
 *       ③>120条→只处理前120标记truncated ④≤12条不额外增加调用 ⑤归值语义不变
 */
const provider = require('../src/core/aiProvider')
const { AIReview } = require('../src/core/aiReview')
const { classifyReposPure } = require('../src/core/coldStart')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}
function makeStore(enabled) {
  const provider = { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }
  return { db: {}, config: { aiReview: { enabled, provider } } }
}
const origChat = provider.chat
// provider.chat(p, messages, opts)：messages=[{role:'system',content},{role:'user',content}]
// 从 system prompt 判断是哪类分类（R4 tips 或冷启动），据此构造返回结果
function makeEcho(record) {
  return async (p, messages) => {
    const sys = messages[0].content
    const usr = messages[1].content
    record.push(usr)
    const lines = usr.split('\n').filter(l => /^[\w-]+/.test(l) && l.indexOf('|') >= 0)
    const results = []
    for (const line of lines) {
      const id = line.split('|')[0].trim()
      if (!id) continue
      if (/real|tool/.test(sys) && !/substantive/.test(sys)) results.push({ id, class: 'real', reason: 'ok' })
      else results.push({ id, substantive: 'true', reason: 'ok' })
    }
    return { ok: true, text: JSON.stringify({ results }) }
  }
}
const countLines = t => t.split('\n').filter(l => l.indexOf('|') >= 0).length
const mkTips = n => Array.from({ length: n }, (_, i) => ({ id: 'u' + i, name: '源' + i, tips: ['发现新版本 v1.0.' + i + ' 修复DNS解析'] }))
const mkSources = n => Array.from({ length: n }, (_, i) => ({ id: 's' + i, name: '源' + i, description: '聚合音源 ' + i }))

async function main() {
  console.log('=== ① 37 条 → 4 批(12/12/12/1)、总调用 4 次、合并 37 条 ===')
  {
    const record = []
    provider.chat = makeEcho(record)
    const a = new AIReview(makeStore(true))
    const r = await a.classifyUpdateTips(mkTips(37))
    ok('37 条切成 4 批（总调用 4 次）', record.length === 4, 'calls=' + record.length)
    ok('结果合并 37 条', Object.keys(r).length === 37, 'got=' + Object.keys(r).length)
    ok('每批条目数符合 12/12/12/1', record.map(countLines).join(',') === '12,12,12,1', 'batches=' + record.map(countLines).join(','))
  }
  {
    // classifyColdStart 同样分批
    const record = []
    provider.chat = makeEcho(record)
    const a = new AIReview(makeStore(true))
    const r = await a.classifyColdStart(mkSources(37), 'source')
    ok('classifyColdStart 37 条也分 4 批、合并 37 条', record.length === 4 && Object.keys(r).length === 37, 'calls=' + record.length + ' got=' + Object.keys(r).length)
  }

  console.log('=== ② 某批持续失败（重试耗尽）→ 只缺该批、其余照常、不抛 ===')
  {
    let idx = 0
    provider.chat = async (p, messages) => {
      idx++
      // 第 2 批的每一次尝试都失败（fail 恒真），验证重试耗尽后只丢该批
      const usr = messages[1].content
      const lines = usr.split('\n').filter(l => /^[\w-]+/.test(l) && l.indexOf('|') >= 0)
      if (lines.length && lines[0].split('|')[0].trim() === 'u12') return { ok: false, error: 'AI 请求失败：请求超时' }
      const results = lines.map(line => ({ id: line.split('|')[0].trim(), substantive: 'true', reason: 'ok' }))
      return { ok: true, text: JSON.stringify({ results }) }
    }
    const a = new AIReview(makeStore(true))
    a._sleep = () => Promise.resolve()   // 不真睡（退避另有专项测试）
    let threw = false, r
    try { r = await a.classifyUpdateTips(mkTips(37), { withStats: true }) } catch (e) { threw = true }
    ok('某批重试耗尽后函数不抛', !threw)
    ok('该批 12 条缺失，其余 3 批 25 条照常返回', Object.keys(r.map).length === 25, 'got=' + Object.keys(r.map).length)
    ok('第 2 批的 id 确实缺失', !r.map['u12'] && r.map['u0'] && r.map['u24'], JSON.stringify({ u0: !!r.map['u0'], u12: !!r.map['u12'], u24: !!r.map['u24'] }))
    ok('重试统计（随返回值传出）：1 批放弃、重试 2 次（共 3 次机会）', r.stats && r.stats.dropped === 1 && r.stats.retries === 2, JSON.stringify(r.stats))
  }
  {
    // 某批抛异常也不影响其它批（异常首轮即判非网络层或网络层，重试耗尽后放弃）
    let first = true
    provider.chat = async (p, messages) => {
      const usr = messages[1].content
      const lines = usr.split('\n').filter(l => /^[\w-]+/.test(l) && l.indexOf('|') >= 0)
      if (first && lines.length) { first = false; throw new Error('fetch failed') }  // 首轮第 1 批抛网络层错
      return { ok: true, text: JSON.stringify({ results: lines.map(line => ({ id: line.split('|')[0].trim(), substantive: 'false', reason: 'x' })) }) }
    }
    const a = new AIReview(makeStore(true))
    a._sleep = () => Promise.resolve()
    let threw = false, r
    try { r = await a.classifyUpdateTips(mkTips(24)) } catch (e) { threw = true }
    ok('某批抛异常函数不抛、重试后 24 条全回（网络层异常可重试）', !threw && Object.keys(r).length === 24, 'got=' + Object.keys(r).length)
  }

  console.log('=== ③ >120 条 → 只处理前 120 条（truncated） ===')
  {
    const record = []
    provider.chat = makeEcho(record)
    const a = new AIReview(makeStore(true))
    const r = await a.classifyUpdateTips(mkTips(200))
    ok('200 条只处理前 120 条（10 批）', record.length === 10 && Object.keys(r).length === 120, 'calls=' + record.length + ' got=' + Object.keys(r).length)
    ok('超出部分(第121条起)不处理', !r['u120'] && r['u119'], JSON.stringify({ u119: !!r['u119'], u120: !!r['u120'] }))
  }

  console.log('=== ④ ≤12 条不额外增加调用 ===')
  {
    const record = []
    provider.chat = makeEcho(record)
    const a = new AIReview(makeStore(true))
    const r = await a.classifyUpdateTips(mkTips(10))
    ok('10 条只 1 次调用、10 条结果', record.length === 1 && Object.keys(r).length === 10, 'calls=' + record.length)
  }
  {
    const record = []
    provider.chat = makeEcho(record)
    const a = new AIReview(makeStore(true))
    const r = await a.classifyUpdateTips(mkTips(12))
    ok('恰好 12 条也只 1 次调用', record.length === 1 && Object.keys(r).length === 12, 'calls=' + record.length)
  }

  console.log('=== ⑤ 归值语义不变（true/false/uncertain，非法→uncertain） ===')
  {
    provider.chat = async (p, messages) => {
      const usr = messages[1].content
      const lines = usr.split('\n').filter(l => /^[\w-]+/.test(l) && l.indexOf('|') >= 0)
      const results = []
      lines.forEach((line, i) => {
        const id = line.split('|')[0].trim()
        results.push({ id, substantive: [true, 'true', false, 'false', 'EVIL', null][i % 6], reason: 'r' })
      })
      return { ok: true, text: JSON.stringify({ results }) }
    }
    const a = new AIReview(makeStore(true))
    const r = await a.classifyUpdateTips(mkTips(6))
    const vals = Object.keys(r).sort().map(k => r[k].substantive)
    ok('true/"true"→true、false/"false"→false、EVIL/null→uncertain', vals[0] === true && vals[1] === true && vals[2] === false && vals[3] === false && vals[4] === 'uncertain' && vals[5] === 'uncertain', JSON.stringify(vals))
  }
  {
    // 非法 class → uncertain 也保持
    provider.chat = async (p, messages) => {
      const usr = messages[1].content
      const lines = usr.split('\n').filter(l => /^[\w-]+/.test(l) && l.indexOf('|') >= 0)
      return { ok: true, text: JSON.stringify({ results: lines.map((line, i) => ({ id: line.split('|')[0].trim(), class: i === 0 ? 'real' : 'EVIL', reason: 'r' })) }) }
    }
    const a = new AIReview(makeStore(true))
    const r = await a.classifyColdStart(mkSources(3), 'source')
    ok('class 非法值仍归 uncertain（分批不改变归值）', r['s0'].class === 'real' && r['s1'].class === 'uncertain' && r['s2'].class === 'uncertain', JSON.stringify(r))
  }

  console.log('=== ⑥ enabled=false 仍零调用、返回空 ===')
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{}' } }
    const a = new AIReview(makeStore(false))
    const r = await a.classifyUpdateTips(mkTips(37))
    ok('enabled=false 分批也零调用、返回空', calls === 0 && Object.keys(r).length === 0)
  }

  provider.chat = origChat
  console.log('\n' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS（' + pass + ' 项）'))
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); provider.chat = origChat; process.exit(1) })
