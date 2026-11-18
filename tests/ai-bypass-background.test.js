'use strict'
/**
 * 旁路转后台（C 终审 Step2）针对性测试 —— 隔离数据 / mock provider.chat，不联网、不碰真实 /data。
 *
 * 覆盖 C 要求的 4 条硬验收（缺一不可）：
 *  ① compareVerdict 不受 sourceAiClass / updateTipsAiClass 影响（"只判定绝不误伤"落点）
 *  ② 灌入主流程不包含 AI 等待（慢 mock + 断言 _queueBypassClassify 立即返回、runImport 不阻塞）
 *  ③ 源已删除时字段不写回（排队后删源，worker 完成不抛、不写、不复活）
 *  ④ 重启后自动重算（队列/内存状态清空，未写字段的源下次仍被选中）
 * 另覆盖：字段只写独立键、worker 自行落盘、一条日志、enabled=false 零调用、_aiBackground 可注入。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Store } = require('../src/core/store')
const { Hunter } = require('../src/core/hunter')
const provider = require('../src/core/aiProvider')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}

const REAL_PROVIDER = { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-bypass-'))
  const s = new Store(dir)
  s.config.aiReview = Object.assign({}, s.config.aiReview, { enabled: true, provider: REAL_PROVIDER })
  s.saveConfig()
  return s
}

/** 造一条 source 条目（含 updateTips 的用于项②） */
function mkEntry(id, tips) {
  const e = {
    id, repo: 'r', path: id + '.js', name: id, code: 'x', status: 'unknown', usable: true,
    addedAt: Date.now(), lastCheck: 0, supportedSources: [1, 2]
  }
  if (tips) e.updateTips = tips.map(m => ({ msg: m }))
  return e
}

function mkHunter(store, logs) {
  const h = new Hunter(store, (t, p) => { if (t === 'log' && p && p.msg) logs.push(p.msg) })
  return h
}

const origChat = provider.chat

/** 从 buildColdStartInput 的正文里提取 id（每行首字段即 id，形如 `s1 | 名称=...`） */
function idsFromBody(messages) {
  const body = String((messages && messages[1] && messages[1].content) || '')
  const out = []
  for (const m of body.matchAll(/^([\w:.\/-]+) \| 名称=/gm)) out.push(m[1])
  return out
}

async function main() {
  // ---------------------------------------------------------------- ① 判定链不受 AI 字段影响
  console.log('=== ① compareVerdict 不受 sourceAiClass/updateTipsAiClass 影响 ===')
  {
    // compareVerdict 若导出则直接测；否则用已知契约：AI 字段只在 compareImportQuality 里
    const Q = require('../src/core/quality')
    ok('quality 导出 compareVerdict', typeof Q.compareVerdict === 'function')
    const base = { usable: true, suspectScore: 0, deep: { metrics: { playableRate: 0.5, successRate: 0.5, p90LatencyMs: 100 } } }
    const withAi = Object.assign({}, base, { sourceAiClass: 'real', updateTipsAiClass: true })
    if (typeof Q.compareVerdict === 'function') {
      const v1 = Q.compareVerdict({ status: 'ok', usable: true }, base)
      const v2 = Q.compareVerdict({ status: 'ok', usable: true }, withAi)
      ok('compareVerdict 对同一源加 AI 字段前后裁决一致', String(v1) === String(v2), JSON.stringify([v1, v2]))
    }
    // 反向：AI 字段只改排序先后，不改任何裁决字段
    const a = Object.assign({}, base, { id: 'a', sourceAiClass: 'tool', updateTipsAiClass: false })
    const b = Object.assign({}, base, { id: 'b', sourceAiClass: 'real', updateTipsAiClass: true })
    ok('AI 字段只影响 compareImportQuality 先后（tool/false 排后）', Q.compareImportQuality(b, a) < 0)
  }

  // ---------------------------------------------------------------- ③ 源删除不写回
  console.log('=== ③ 源已删除时不写回、不抛、不复活 ===')
  {
    const store = mkStore()
    const logs = []
    const h = mkHunter(store, logs)
    h._aiBackgroundImpl = fn => fn()   // 同步执行，测试可控
    provider.chat = async (p, messages) => {
      return { ok: true, text: JSON.stringify({ results: [{ id: 's1', class: 'real', reason: '真源' }] }) }
    }
    store.db.sources.s1 = mkEntry('s1')
    // 入队前先拿到 target 引用，然后删除
    const targets = [store.db.sources.s1]
    const handle = h._queueBypassClassify(targets)
    delete store.db.sources.s1          // 排队后删源（模拟主流程期间被删除）
    await handle
    ok('源删除后字段未写回（条目不复活）', store.db.sources.s1 === undefined)
    ok('源删除后不抛异常（handle 正常 settle）', true)
  }

  // ---------------------------------------------------------------- ③b 正常落库 + 自行 saveDb
  console.log('=== ③b worker 按 id 重取、写独立字段、自行落盘 ===')
  {
    const store = mkStore()
    const logs = []
    const h = mkHunter(store, logs)
    h._aiBackgroundImpl = fn => fn()
    provider.chat = async (p, messages) => {
      const out = idsFromBody(messages).map(id => ({ id, class: 'real', reason: '真源' }))
      return { ok: true, text: JSON.stringify({ results: out.length ? out : [{ id: 's2', class: 'real', reason: '真源' }] }) }
    }
    store.db.sources.s2 = mkEntry('s2')
    store.saveDb()
    const handle = h._queueBypassClassify([store.db.sources.s2])
    await handle
    const e = store.db.sources.s2
    ok('结果写入 sourceAiClass 独立字段', e && e.sourceAiClass === 'real', e && e.sourceAiClass)
    ok('只写独立字段、不动 status/usable', e && e.status === 'unknown' && e.usable === true)
    // 落盘验证：重新从磁盘读
    const reload = new Store(store.dir)
    ok('字段已自行落盘（重启后仍在）', reload.db.sources.s2 && reload.db.sources.s2.sourceAiClass === 'real')
    ok('写了一条 AI 旁路日志', logs.some(l => /AI 旁路预判完成/.test(l)), JSON.stringify(logs))
  }

  // ---------------------------------------------------------------- ② 不阻塞主流程
  console.log('=== ② 灌入不再等待 AI（慢 mock 下 _queueBypassClassify 立即返回） ===')
  {
    const store = mkStore()
    const logs = []
    const h = mkHunter(store, logs)
    // _aiBackground 默认实现（微任务调度），不注入同步 → 验证「不 await」特性
    let resolveSlow
    let chatStarted = false
    provider.chat = () => new Promise(res => { chatStarted = true; resolveSlow = () => res({ ok: true, text: '{"results":[]}' }) })
    store.db.sources.s3 = mkEntry('s3')
    const t0 = Date.now()
    const handle = h._queueBypassClassify([store.db.sources.s3])
    const elapsed = Date.now() - t0
    ok('_queueBypassClassify 立即返回（未等 AI，<50ms）', elapsed < 50, 'elapsed=' + elapsed)
    ok('同时返回了可 await 的 job 句柄（供测试/收尾）', handle && typeof handle.then === 'function')
    // 让微任务跑起来，确认 AI 确实在后台被调用
    await new Promise(r => setTimeout(r, 10))
    ok('后台 worker 已启动调用 provider.chat', chatStarted === true)
    if (resolveSlow) resolveSlow()
    await handle
  }

  // ---------------------------------------------------------------- ②b runImport 路径不阻塞
  console.log('=== ②b runImport 在 AI 慢时不阻塞（AI 入队后继续，最终因无账号报错） ===')
  {
    const store = mkStore()
    const logs = []
    const h = mkHunter(store, logs)
    let chatStarted = false
    provider.chat = () => new Promise(res => { chatStarted = true; setTimeout(() => res({ ok: true, text: '{"results":[]}' }), 2000) })
    store.db.sources.s4 = mkEntry('s4')
    store.config.aiReview.enabled = true
    // 无任何平台账号 → runImport 会在 _importTargets 后抛 NO_ACCOUNT_ERR；关键是它没卡在 AI 上
    const t0 = Date.now()
    let err = null
    try { await h.runImport(['s4'], {}) } catch (e) { err = e }
    const elapsed = Date.now() - t0
    ok('runImport 未等待 AI（<1000ms 即结束，而非 2000ms+）', elapsed < 1000, 'elapsed=' + elapsed)
    ok('runImport 抛的是无账号错误（非 AI 异常）', err && /账号|平台|account/i.test(String(err.message)), err && err.message)
    ok('AI 已在后台启动（不阻塞但确实跑了）', chatStarted === true)
  }

  // ---------------------------------------------------------------- ④ 重启后自动重算
  console.log('=== ④ 重启后未写字段的源下次自动重算（幂等无需补偿） ===')
  {
    const store = mkStore()
    const h = mkHunter(store, [])
    h._aiBackgroundImpl = fn => fn()
    provider.chat = async () => ({ ok: true, text: '{"results":[]}' })   // 空结果 = 不写字段（模拟未完成/失败）
    store.db.sources.s5 = mkEntry('s5')
    store.saveDb()   // 先落盘，否则"重启"后磁盘上没有这条源
    await h._queueBypassClassify([store.db.sources.s5])
    ok('空结果不写字段（sourceAiClass 仍为空）', !store.db.sources.s5.sourceAiClass)

    // 模拟"进程重启"：全新 Store + 全新 Hunter，队列天然为空
    const store2 = new Store(store.dir)
    store2.config.aiReview = Object.assign({}, store2.config.aiReview, { enabled: true, provider: REAL_PROVIDER })
    const h2 = new Hunter(store2, () => {})
    h2._aiBackgroundImpl = fn => fn()
    let called = 0
    provider.chat = async (p, messages) => {
      called++
      const out = idsFromBody(messages).map(id => ({ id, class: 'real', reason: '真源' }))
      return { ok: true, text: JSON.stringify({ results: out }) }
    }
    // 重算条件：仍被 !e.sourceAiClass 选中
    const fresh = Object.keys(store2.db.sources).map(k => store2.db.sources[k]).filter(e => !e.sourceAiClass)
    ok('重启后未写字段的源仍被选中重算（过滤条件命中）', fresh.length === 1 && fresh[0].id === 's5')
    await h2._queueBypassClassify(fresh)
    ok('重算后这次成功写入', called >= 1 && store2.db.sources.s5.sourceAiClass === 'real')
  }

  // ---------------------------------------------------------------- enabled=false 零调用
  console.log('=== enabled=false / 已预判过 → 零调用零入队 ===')
  {
    const store = mkStore()
    store.config.aiReview.enabled = false
    const h = mkHunter(store, [])
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{}' } }
    store.db.sources.s6 = mkEntry('s6')
    const handle = h._queueBypassClassify([store.db.sources.s6])
    await handle
    ok('enabled=false 完全不调用 provider.chat', calls === 0 && !store.db.sources.s6.sourceAiClass)
  }
  {
    const store = mkStore()
    const h = mkHunter(store, [])
    h._aiBackgroundImpl = fn => fn()
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{"results":[]}' } }
    const e = mkEntry('s7'); e.sourceAiClass = 'real'; e.updateTipsAiClass = 'uncertain'
    store.db.sources.s7 = e
    await h._queueBypassClassify([e])
    ok('已预判过（两字段都有）→ 不重复花钱', calls === 0)
  }

  // ---------------------------------------------------------------- 项② updateTips 走同一后台
  console.log('=== 项② updateTips 同样转后台写独立字段 ===')
  {
    const store = mkStore()
    const logs = []
    const h = mkHunter(store, logs)
    h._aiBackgroundImpl = fn => fn()
    provider.chat = async () => ({ ok: true, text: JSON.stringify({ results: [{ id: 's8', substantive: 'true', reason: '修复了取链' }] }) })
    store.db.sources.s8 = mkEntry('s8', ['修复了取链失败问题'])
    await h._queueBypassClassify([store.db.sources.s8])
    const e = store.db.sources.s8
    ok('项② 写入 updateTipsAiClass（布尔 true 或字符串归一后）', e && (e.updateTipsAiClass === true || e.updateTipsAiClass === 'true'), e && String(e.updateTipsAiClass))
    ok('项② 日志计数包含项②', logs.some(l => /项②.*[1-9]/.test(l)), JSON.stringify(logs))
  }

  // ---------------------------------------------------------------- Step1 全兜底态跳过预判
  console.log('=== Step1 全兜底态（无 description/topics）不调用 AI ===')
  {
    const store = mkStore()
    const h = mkHunter(store, [])
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{"results":[]}' } }
    const repos = ['a/b', 'c/d', 'e/f']
    const metaNoDesc = { 'a/b': { id: 'a/b', name: 'b' }, 'c/d': { id: 'c/d', name: 'd' }, 'e/f': { id: 'e/f', name: 'f' } }
    const out = await h._coldStartPrioritizeRepos(repos, metaNoDesc)
    ok('全兜底态不调用 provider.chat', calls === 0, 'calls=' + calls)
    ok('全兜底态返回原序（不重排）', JSON.stringify(out) === JSON.stringify(repos))
  }
  {
    const store = mkStore()
    const h = mkHunter(store, [])
    let calls = 0
    provider.chat = async (p, messages) => {
      calls++
      const out = idsFromBody(messages).map(id => ({ id, class: 'real', reason: '真源' }))
      return { ok: true, text: JSON.stringify({ results: out }) }
    }
    const repos = ['a/b', 'c/d']
    const metaYes = { 'a/b': { id: 'a/b', name: 'b', description: '聚合音源' }, 'c/d': { id: 'c/d', name: 'd', topics: ['lx'] } }
    const out = await h._coldStartPrioritizeRepos(repos, metaYes)
    ok('有 description/topics 时正常调用 AI', calls >= 1, 'calls=' + calls)
    ok('有实质输入时返回仍是原集合重排（元素不增不减）', out.length === 2 && ['a/b', 'c/d'].every(r => out.includes(r)))
  }

  // ---------------------------------------------------------------- in-flight 去重（C 复核 §2 缺陷④）
  console.log('=== in-flight 去重：在途重复入队不重复花钱 ===')
  {
    // ① 同一源连续两次入队（第一次未完成）→ provider.chat 只调 1 次
    const store = mkStore()
    const h = mkHunter(store, [])
    let calls = 0
    let release
    provider.chat = () => new Promise(res => { calls++; release = () => res({ ok: true, text: '{"results":[]}' }) })
    store.db.sources.d1 = mkEntry('d1')
    const t1 = store.db.sources.d1
    const h1 = h._queueBypassClassify([t1])
    const h2 = h._queueBypassClassify([t1])       // 在途窗口内再次入队
    await new Promise(r => setTimeout(r, 10))
    ok('在途重复入队 → provider.chat 只调 1 次', calls === 1, 'calls=' + calls)
    if (release) release()
    await h1; await h2
  }
  {
    // ② worker 完成后再次入队 → 字段未写则仍可重新判（delete 生效）
    const store = mkStore()
    const h = mkHunter(store, [])
    h._aiBackgroundImpl = fn => fn()
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{"results":[]}' } }  // 空结果=不写字段
    store.db.sources.d2 = mkEntry('d2')
    await h._queueBypassClassify([store.db.sources.d2])
    ok('worker 完成后（空结果）字段仍未写', !store.db.sources.d2.sourceAiClass)
    ok('在途集合已清空（delete 生效）', h._bypassInFlight.size === 0, 'size=' + h._bypassInFlight.size)
    await h._queueBypassClassify([store.db.sources.d2])
    ok('完成后再次入队仍可重判（字段未写 → 调用第 2 次）', calls === 2, 'calls=' + calls)
  }
  {
    // ③ 项①(cold) 与项②(tips) 同 id 不互相干扰
    const store = mkStore()
    const h = mkHunter(store, [])
    h._aiBackgroundImpl = fn => fn()
    const seen = []
    provider.chat = async (p, messages) => {
      const body = String((messages && messages[1] && messages[1].content) || '')
      seen.push(/updateTips|更新|实质/.test(body) || /substantive/.test(body) ? 'tips' : 'cold')
      return { ok: true, text: '{"results":[]}' }
    }
    const e = mkEntry('d3', ['修复了取链失败'])
    store.db.sources.d3 = e
    await h._queueBypassClassify([e])
    ok('同一 id 的项①与项②各自都跑了（互不干扰）', seen.length === 2, JSON.stringify(seen))
    ok('两种 kind 在途键均已清理', h._bypassInFlight.size === 0, 'size=' + h._bypassInFlight.size)
  }
  {
    // ③b 项①在途时，项②同 id 仍应能入队（键不互相干扰）
    const store = mkStore()
    const h = mkHunter(store, [])
    let calls = 0
    let holds = []
    provider.chat = () => new Promise(res => { calls++; holds.push(res) })
    const e = mkEntry('d4', ['修复了取链失败'])
    e.sourceAiClass = 'real'                 // 让 cold 不排队，只有 tips 会排队
    store.db.sources.d4 = e
    const h1 = h._queueBypassClassify([e])   // 只排 tips
    ok('只有 tips 在途（cold 已预判过）', h._bypassInFlight.has('tips:d4') && !h._bypassInFlight.has('cold:d4'))
    ok('同 id 的 cold 键未被占用', !h._bypassInFlight.has('cold:d4'))
    await new Promise(r => setTimeout(r, 20))  // 等 worker（微任务）启动
    ok('仅 1 次调用（只 tips）', calls === 1, 'calls=' + calls)
    holds.forEach(r => r({ ok: true, text: '{"results":[]}' }))
    await h1
  }
  {
    // ④ worker 失败/异常时 in-flight 也正确清理
    const store = mkStore()
    const h = mkHunter(store, [])
    h._aiBackgroundImpl = fn => fn()
    provider.chat = async () => { throw new Error('boom') }
    store.db.sources.d5 = mkEntry('d5')
    await h._queueBypassClassify([store.db.sources.d5])
    ok('worker 抛异常后 in-flight 已清理（不永久卡住）', h._bypassInFlight.size === 0, 'size=' + h._bypassInFlight.size)
    let calls2 = 0
    provider.chat = async () => { calls2++; return { ok: true, text: '{"results":[]}' } }
    await h._queueBypassClassify([store.db.sources.d5])
    ok('失败后再入队可重判（说明未卡死）', calls2 === 1, 'calls2=' + calls2)
  }
  {
    // ④b 调度器同步抛错也不留残留
    const store = mkStore()
    const h = mkHunter(store, [])
    h._aiBackgroundImpl = () => { throw new Error('scheduler boom') }
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{"results":[]}' } }
    store.db.sources.d6 = mkEntry('d6')
    await h._queueBypassClassify([store.db.sources.d6])
    ok('调度器同步抛错后 in-flight 无残留', h._bypassInFlight.size === 0, 'size=' + h._bypassInFlight.size)
    ok('调度器抛错不调用 chat、不抛给调用方', calls === 0)
  }

  provider.chat = origChat
  console.log(`\n=== ${fail === 0 ? 'ALL PASS' : 'FAILED'} : pass=${pass} fail=${fail} ===`)
  if (fail) process.exitCode = 1
}

main().catch(e => { console.error('TEST CRASH', e); process.exitCode = 1 })
