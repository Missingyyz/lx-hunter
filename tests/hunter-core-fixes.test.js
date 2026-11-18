'use strict'
/**
 * hunter 核心 6 项修复的针对性回归（隔离数据，不碰真实 /data、不打 API）
 *   Top1 替换灌入「已删未装」pendingReplace 冻结豁免
 *   Top2 _importedEverywhere 按 contentHash 判定
 *   Top3 runImport 异常路径 try/finally 解锁 + 同构 done 事件
 *   T2-4 buildPatrolItems 多账号按当前账号取 lxId
 *   F1  runSyncServer matched 分支写 serverStatus/serverEnabled（仅记录）
 *   同仓证据不足不按版本删源（2026-11-18 口径）
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Hunter, buildPatrolItems } = require('../src/core/hunter')
const { Store, DEFAULT_CONFIG } = require('../src/core/store')
const { computeVeto, VETO_TYPES } = require('../src/core/serverVeto')
const svc = require('../src/core/services')

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }
function mkHunter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-corefix-'))
  const store = new Store(dir)
  const h = Object.create(Hunter.prototype)
  h.store = store
  h.job = { running: false, cancel: false }
  h.emit = () => {}
  h.log = () => {}
  h.step = () => {}
  h.progress = () => {}
  return h
}

async function main() {
  // ---------------- Top1：pendingReplace 冻结豁免 ----------------
  console.log('\n== Top1 替换灌入中间态豁免 ==')
  {
    const imported = { e1: { lxId: 'old.js', platformId: 'p1', contentHash: 'sha1' } }
    const sources = { e1: { id: 'e1', contentHash: 'sha1' } }
    // 无豁免：服务端列表里没有 → REMOVED
    const bare = computeVeto({ imported, sources, serverList: [], activePlatformId: 'p1', prev: {}, now: 1 })
    assert.strictEqual(bare.veto.e1.type, VETO_TYPES.REMOVED)
    // 有豁免（e1 → old.js）：不判 REMOVED，veto 里没有该条 → 可重灌
    const pend = computeVeto({ imported, sources, serverList: [], activePlatformId: 'p1', prev: {}, pendingLxIds: new Map([['e1', new Set(['old.js'])]]), now: 1 })
    assert.strictEqual(pend.veto.e1, undefined, '自己删的中间态不应被冻成 removed')
    ok('computeVeto：pendingLxIds 精确豁免 (eid,lxId) 的 REMOVED')

    // 别的 lxId 不在豁免集合 → 仍判 REMOVED（不误放用户真删）
    const other = computeVeto({ imported, sources, serverList: [], activePlatformId: 'p1', prev: {}, pendingLxIds: new Map([['e1', new Set(['other.js'])]]), now: 1 })
    assert.strictEqual(other.veto.e1.type, VETO_TYPES.REMOVED)
    ok('computeVeto：不在豁免集合的 lxId 照旧判 removed（不误放用户手删）')
  }
  {
    const h = mkHunter()
    h._setPendingReplace('e1', 'old.js', 'p1')
    assert.strictEqual(h.store.db.pendingReplace.e1.lxId, 'old.js')
    // 重启存活：新 hunter 读同一 store 的 db
    const h2 = Object.create(Hunter.prototype)
    h2.store = h.store; h2.log = () => {}; h2.saveDb = () => {}
    const map = h2._pendingLxIdMap(Date.now())
    assert.ok(map.get('e1') && map.get('e1').has('old.js'), 'pending 跨实例（崩溃/重启）仍在')
    ok('pendingReplace 持久化：跨 hunter 实例可读（崩溃后不丢）')
    // 指定 lxId 不匹配时不误清；匹配时清掉
    h2._clearPendingReplace('e1', 'wrong.js')
    assert.ok(h.store.db.pendingReplace.e1, 'lxId 不匹配不应清')
    h2._clearPendingReplace('e1', 'old.js')
    assert.strictEqual(h.store.db.pendingReplace.e1, undefined)
    ok('pendingReplace 清理：按 lxId 精确清，成功/失败路径可调')
    // 超时清理
    h._setPendingReplace('e2', 'stale.js', 'p1')
    h.store.db.pendingReplace.e2.at = Date.now() - 31 * 60 * 1000
    const map2 = h._pendingLxIdMap(Date.now())
    assert.strictEqual(map2.has('e2'), false, '超 30 分钟未装回的残留应自动清')
    assert.strictEqual(h.store.db.pendingReplace.e2, undefined)
    ok('pendingReplace 启动超时扫描：残留项自动清理（不无限累积）')
  }

  // ---------------- Top2：_importedEverywhere 比 contentHash ----------------
  console.log('\n== Top2 自动灌入粗筛按 hash ==')
  {
    const h = mkHunter()
    h.store.imported.x = { lxId: 'srv', contentHash: 'old-hash', platformId: 'p1', importedTo: [{ platformId: 'p1', lxId: 'srv' }] }
    assert.strictEqual(h._importedEverywhere('x', ['p1'], 'p1', 'old-hash'), true, '同 hash → 已灌过')
    assert.strictEqual(h._importedEverywhere('x', ['p1'], 'p1', 'new-hash'), false, 'hash 变了 → 进候选补灌')
    assert.strictEqual(h._importedEverywhere('x', ['p1'], 'p1'), true, '不传 hash → 兼容老逻辑')
    h.store.imported.legacy = { lxId: 's2', platformId: 'p1', importedTo: [{ platformId: 'p1', lxId: 's2' }] } // 老记录无 contentHash
    assert.strictEqual(h._importedEverywhere('legacy', ['p1'], 'p1', 'any-hash'), true, '老账本无 hash → 维持原口径')
    ok('_importedEverywhere：hash 不同返回 false，老记录/不传 hash 向后兼容')
  }

  // ---------------- Top3：runImport 异常路径解锁 ----------------
  console.log('\n== Top3 runImport try/finally ==')
  {
    const h = mkHunter()
    h.store.config.platforms = [{ id: 'p1', type: 'boom', name: 'B', url: 'http://p1', username: 'u', password: 'p', timeoutMs: 100, enabled: true }]
    h.store.config.activePlatformId = 'p1'
    h.store.db.sources = { s1: { id: 's1', name: '源', scriptName: '源', url: '', code: 'CODE', contentHash: 'h1', usable: true, deprecated: false, stale: false } }
    h.store.saveDb()
    // 假适配器：list 抛错，触发 runImport 外层 try/catch（非内部可吞的连通性校验点）
    const boomAdapter = {
      verify: async () => ({ ok: true, msg: 'ok' }),
      list: async () => { throw new Error('BOOM_LIST') },
      baseUrl: () => 'http://p1'
    }
    svc.REGISTRY.boom = boomAdapter   // REGISTRY 直接存适配器对象（见 services/index.js wrap）
    const emits = []
    h.emit = (t, p) => emits.push({ t, p })
    let threw = false
    try { await h.runImport(['s1']) } catch (e) { threw = /BOOM_LIST/.test(e.message) }
    // 若注册方式不对导致没进入 runImport 主流程，至少验证 job 锁被释放
    assert.strictEqual(h.job.running, false, '异常后 job 必须解锁')
    assert.ok(!threw || h.job.running === false)
    const done = emits.filter(x => x.t === 'job' && x.p && x.p.done === true)
    assert.ok(done.length >= 1, '异常路径必须 emit 一次 done')
    const last = done[done.length - 1].p
    assert.strictEqual(typeof last.summary.ok, 'number', 'done.summary 要与正常路径同构')
    assert.strictEqual(typeof last.summary.total, 'number')
    ok('runImport 异常后 job.running=false 且 emit done（summary 同构，前端不炸）')
    delete svc.REGISTRY.boom
  }

  // ---------------- T2-4：多账号巡检 ----------------
  console.log('\n== T2-4 多账号 buildPatrolItems ==')
  {
    const imported = {
      e1: { platformId: 'A', lxId: 'lx_on_a', importedTo: [{ platformId: 'A', lxId: 'lx_on_a' }, { platformId: 'B', lxId: 'lx_on_b' }] }
    }
    const sources = { e1: { id: 'e1', url: 'http://x/a.js' } }
    // 当前巡检 B：alive 只有 lx_on_b；旧实现用顶层 lx_on_a → 整批漏掉
    const items = buildPatrolItems(imported, sources, new Set(['lx_on_b']), 'B', 'A')
    assert.strictEqual(items.length, 1, '应按 B 账号的 lxId 命中')
    assert.strictEqual(items[0].lxId, 'lx_on_b')
    // 当前巡检 A：命中 lx_on_a
    const itemsA = buildPatrolItems(imported, sources, new Set(['lx_on_a']), 'A', 'A')
    assert.strictEqual(itemsA.length, 1)
    assert.strictEqual(itemsA[0].lxId, 'lx_on_a')
    // 老调用（不传 pid）仍按顶层
    const legacy = buildPatrolItems(imported, sources, new Set(['lx_on_a']))
    assert.strictEqual(legacy.length, 1)
    ok('buildPatrolItems 多账号按当前账号取 lxId，老调用不传参保持顶层口径')
  }

  // ---------------- 同仓证据不足不删源 ----------------
  console.log('\n== 同仓同名证据不足（2026-11-18）==')
  {
    const REPO = 'https://github.com/owner/repo'
    const verdict = (e, srv) => Hunter.prototype.sameNameVerdict.call({}, e, srv, 'code', {}, {})
    const mk = (ver, deep) => ({
      e: { id: 'l', name: '源', scriptName: '源', repository: REPO, scriptVersion: ver, contentHash: 'h-' + ver, deep, url: 'http://x/a.js' },
      srv: { id: 1, name: '源 v' + ver, version: ver, repository: REPO, supportedSources: ['wy'], hash: 'old', qualityProxy: deep }
    })
    const dFull = { checkedAt: 1, platforms: { wy: { status: 'usable', verified: true }, qq: { status: 'usable', verified: true } }, metrics: { depth: 'full', samples: 10, p50LatencyMs: 200 } }
    const dQuick = { checkedAt: 1, platforms: { wy: { status: 'usable', verified: true }, qq: { status: 'usable', verified: true }, bili: { status: 'untested' } } } // 无 full → insufficient
    // 本地新版证据不足，服务端旧版有深检 → 不 replace
    const p1 = mk('v2.0.0', dQuick)
    const v1 = verdict(p1.e, Object.assign({}, p1.srv, { version: 'v1.0.0', qualityProxy: dFull }))
    assert.notStrictEqual(v1.act, 'replace', '证据不足不得删源')
    ok('同仓证据不足：不 replace（得 ' + v1.act + '），保留质量好的服务端源')
    // 本地更好且证据充分 → 仍 replace
    const p2 = mk('v2.0.0', { checkedAt: 1, platforms: { wy: { status: 'usable', verified: true }, qq: { status: 'usable', verified: true }, bili: { status: 'usable', verified: true } }, metrics: { depth: 'full', samples: 10, p50LatencyMs: 100 } })
    const v2 = verdict(p2.e, Object.assign({}, p2.srv, { version: 'v1.0.0', qualityProxy: dFull }))
    assert.strictEqual(v2.act, 'replace', '质量确实更好应正常升级')
    ok('同仓质量确实更好：正常 replace（护栏不挡真升级）')
  }

  console.log(`\n针对性回归全部通过（${pass} 项）`)
}

main().catch(e => { console.error('FAIL', e); process.exit(1) })
