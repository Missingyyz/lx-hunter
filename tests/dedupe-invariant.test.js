/**
 * 去重不变量测试（v1.13.10）
 *
 * 背景：dedupe() 与 runCheck 共 5 处写 deprecated，全是「标记我自己 + 记下 dupOf」的
 * 单向写入，没有任何一处回头修正「指向我的那些条目」。keeper 一旦变废弃，指向它的条目
 * 永久悬空；最坏情况是一组同 contentHash 副本全部废弃 = 这份内容从活跃库彻底消失
 * （8197 生产库实测 100 组 / 480 条）。
 *
 * 本测试锁定六条不变量（用户 2026-11-19 裁定，② 在 P1 后加了「同内容须同 hash」）：
 *   ① 每个 contentHash 组活跃副本数 ≥ 1
 *   ② 不存在 dupOf 指向「已废弃」或「不存在」的目标；
 *      「同内容重复」还须指向同 contentHash 的条目（「同名旧版本」跨组指向是合法的）
 *   ③ 不存在 usable===true && deprecated===true
 *   ④ 不存在 dupOf 成环（含自指）
 *   ⑤ 每个 contentHash 组活跃副本数 ≤ 1（去重必须收敛，不留多份）
 *   ⑥ 复活动作纯净：只清重复标记 + 按 deep 证据重算 usable，deep/status/contentHash/size 不动
 *
 * 另含一个「100 组全灭」的 fixture，直接验证收尾修复真的能把内容救回来。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const { Store } = require(path.join(ROOT, 'src', 'core', 'store'))
const { Hunter } = require(path.join(ROOT, 'src', 'core', 'hunter'))
const { usableCount } = require(path.join(ROOT, 'src', 'core', 'checker'))

let pass = 0
let fail = 0
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra != null ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-dedupe-inv-'))
function newStore () {
  const st = new Store(dir)
  st.db = { sources: {}, imported: {}, config: {} }
  return st
}

const DEEP_OK = () => ({
  checkedAt: Date.now(),
  platforms: {
    wy: { status: 'usable', metrics: { playable: 1, latencies: [100], successes: 3, attempts: 3, qualityUsed: '320k' } },
    tx: { status: 'usable', metrics: { playable: 1, latencies: [120], successes: 3, attempts: 3, qualityUsed: '320k' } }
  }
})
const DEEP_ZERO = () => ({ checkedAt: Date.now(), platforms: { wy: { status: 'failed' }, tx: { status: 'failed' } } })

let seq = 0
function mk (st, opts) {
  const o = opts || {}
  seq++
  const id = o.id || ('repo/r' + seq + '::f' + seq + '.js')
  st.db.sources[id] = Object.assign({
    id,
    repo: o.repo || 'repo/r' + seq,
    path: o.path || ('f' + seq + '.js'),
    url: 'https://example.invalid/x.js',
    name: o.name || ('f' + seq),
    scriptName: o.scriptName || o.name || ('f' + seq),
    lxName: o.lxName || '',
    code: 'code-' + id,
    contentHash: o.contentHash || 'H' + seq,
    status: o.status || 'ok',
    size: o.size != null ? o.size : 10,
    addedAt: Date.now(),
    lastCheck: 1,
    deep: o.deep || null,
    usable: o.usable === undefined ? false : o.usable
  }, o.extra || {})
  return st.db.sources[id]
}

/** 四条不变量检查（返回违规明细数组，空 = 全过） */
function checkInvariants (store) {
  const all = Object.values(store.db.sources)
  const byId = {}
  for (const e of all) byId[e.id] = e
  const v = { g1: [], g2: [], g3: [], g4: [] }

  // ① 每个 contentHash 组活跃数 ≥ 1
  const groups = {}
  for (const e of all) { if (e.contentHash) (groups[e.contentHash] = groups[e.contentHash] || []).push(e) }
  for (const [h, g] of Object.entries(groups)) {
    if (g.length < 2) continue
    if (g.filter(e => !e.deprecated).length < 1) v.g1.push('hash=' + h.slice(0, 12) + ' copies=' + g.length)
  }

  // ② dupOf 目标必须存在且未废弃；「同内容重复」还须指向同 contentHash 的条目
  for (const e of all) {
    if (!e.deprecated || e.dupOf == null) continue
    const t = byId[e.dupOf]
    if (!t) { v.g2.push('dangling: ' + e.id + ' -> ' + e.dupOf); continue }
    if (t.deprecated) { v.g2.push('to-deprecated: ' + e.id + ' -> ' + e.dupOf); continue }
    // P1：「同内容」跨 contentHash 指向是错的（同 contentHash 才叫同内容）。
    // 「同名旧版本」跨组指向是必须的（旧版指向新版，内容必然不同），不在此列。
    if (/同内容/.test(String(e.dupReason || '')) && t.contentHash !== e.contentHash) {
      v.g2.push('cross-hash-samecontent: ' + e.id + '(' + String(e.contentHash).slice(0, 8) + ') -> ' + e.dupOf + '(' + String(t.contentHash).slice(0, 8) + ')')
    }
  }

  // ③ usable && deprecated 不得同时成立
  for (const e of all) if (e.deprecated && e.usable === true) v.g3.push('both: ' + e.id)

  // ④ dupOf 不得成环（含自指）
  for (const e of all) {
    if (e.dupOf == null) continue
    if (e.dupOf === e.id) { v.g4.push('self: ' + e.id); continue }
    const seen = new Set([e.id])
    let cur = e
    let hops = 0
    while (cur && cur.dupOf != null && hops < 64) {
      const next = byId[cur.dupOf]
      if (!next) break
      if (seen.has(next.id)) { v.g4.push('cycle: ' + e.id); break }
      seen.add(next.id)
      cur = next
      hops++
    }
  }
  return v
}

function assertAll (store, tag) {
  const v = checkInvariants(store)
  ok(tag + ' · ①每个 contentHash 组活跃数≥1', v.g1.length === 0, v.g1.slice(0, 3).join(' | '))
  ok(tag + ' · ②dupOf 不指向废弃/不存在的目标', v.g2.length === 0, v.g2.slice(0, 3).join(' | '))
  ok(tag + ' · ③不存在 usable&&deprecated 矛盾态', v.g3.length === 0, v.g3.slice(0, 3).join(' | '))
  ok(tag + ' · ④dupOf 不成环（含自指）', v.g4.length === 0, v.g4.slice(0, 3).join(' | '))
  // ⑤ 去重要收敛：每个 contentHash 组活跃副本数不得 > 1（同内容留多份 = 去重失效）
  const gg = {}
  for (const e of Object.values(store.db.sources)) { if (e.contentHash) (gg[e.contentHash] = gg[e.contentHash] || []).push(e) }
  const multi = Object.entries(gg).filter(([, x]) => x.filter(e => !e.deprecated).length > 1)
  ok(tag + ' · ⑤每个 contentHash 组活跃数≤1（去重收敛，不留多份）', multi.length === 0,
    multi.slice(0, 3).map(([h, x]) => h.slice(0, 10) + ':' + x.filter(e => !e.deprecated).length).join(' | '))
}

// ============================================================
console.log('\n=== ① 基础：同 hash 组正常去重后满足四条不变量 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  mk(st, { contentHash: 'H1', deep: DEEP_OK(), usable: true })
  mk(st, { contentHash: 'H1' })
  mk(st, { contentHash: 'H1' })
  const r = h.dedupe()
  assertAll(st, '基础同hash')
  const live = Object.values(st.db.sources).filter(e => !e.deprecated)
  ok('基础 · 同 hash 3 条 → 活跃恰好 1 条', live.length === 1, 'live=' + live.length)
  ok('基础 · dupContent 计 2', r.dupContent === 2, JSON.stringify(r))
})()

// ============================================================
console.log('\n=== ② A2 回归：同名裁决②废掉①选出的 keeper → 指针必须重定向 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  // A1/A2 同 hash H1，A1 深检可用；另有一条同名 H2 且版本更高
  const a1 = mk(st, { id: 'r/x::A1.js', repo: 'r/x', path: 'A1.js', name: '同名源', scriptName: '同名源', contentHash: 'H1', scriptVersion: '1.0.0', deep: DEEP_OK(), usable: true })
  const a2 = mk(st, { id: 'r/x::A2.js', repo: 'r/x', path: 'A2.js', name: '同名源', scriptName: '同名源', contentHash: 'H1', scriptVersion: '1.0.0' })
  const b = mk(st, { id: 'r/x::B.js', repo: 'r/x', path: 'B.js', name: '同名源', scriptName: '同名源', contentHash: 'H2', scriptVersion: '2.0.0', deep: DEEP_OK(), usable: true })
  h.dedupe()
  assertAll(st, 'A2回归')
  const liveH1 = Object.values(st.db.sources).filter(e => e.contentHash === 'H1' && !e.deprecated)
  ok('A2回归 · H1 组活跃数 ≥1（内容未丢失）', liveH1.length >= 1, 'liveH1=' + liveH1.length)
  ok('A2回归 · A2 的 dupOf 不指向已废弃的 A1',
    !(a2.deprecated && a2.dupOf === 'r/x::A1.js' && a1.deprecated),
    'a2.dupOf=' + a2.dupOf + ' a1.deprecated=' + a1.deprecated)
})()

// ============================================================
console.log('\n=== ③ A1 回归：组内全废弃（星形+环）必须被救回 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  // 复刻 8197 生产形态：三条都废弃，A→C、B→C、C→A（互指成环）
  const a = mk(st, { id: 'c/A.js', repo: 'c', path: 'A.js', contentHash: 'HC' })
  const b = mk(st, { id: 'c/B.js', repo: 'c', path: 'B.js', contentHash: 'HC' })
  const c = mk(st, { id: 'c/C.js', repo: 'c', path: 'C.js', contentHash: 'HC', deep: DEEP_OK() })
  a.deprecated = true; a.dupOf = 'c/C.js'; a.dupReason = '同内容重复'; a.usable = false
  b.deprecated = true; b.dupOf = 'c/C.js'; b.dupReason = '同内容重复'; b.usable = false
  c.deprecated = true; c.dupOf = 'c/A.js'; c.dupReason = '同内容重复'; c.usable = false
  const r = h.dedupe()
  assertAll(st, '全灭复活')
  const live = Object.values(st.db.sources).filter(e => !e.deprecated)
  ok('全灭复活 · 该组活跃数 ≥1', live.length >= 1, 'live=' + live.length)
  ok('全灭复活 · revived 计数 > 0', r.revived > 0, JSON.stringify(r))
  ok('全灭复活 · 复活的是组内条目', live.every(e => e.contentHash === 'HC'), JSON.stringify(live.map(e => e.id)))
})()

// ============================================================
console.log('\n=== ④ 悬空 dupOf（keeper 已不存在）必须被处理 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  const e = mk(st, { id: 'd/E.js', repo: 'd', path: 'E.js', contentHash: 'HD' })
  e.deprecated = true; e.dupOf = 'not/exist::ghost.js'; e.dupReason = '同内容重复'; e.usable = false
  const r = h.dedupe()
  assertAll(st, '悬空')
  // 单条组的唯一副本没有「内容丢失」问题（它就是那个内容的全部），所以不复活，
  // 但必须把指不到活人的幽灵指针清掉，不能留着 dangling。
  ok('悬空 · 幽灵指针被清空（不再指向不存在的目标）', e.dupOf == null, 'dupOf=' + e.dupOf)
  ok('悬空 · 保持 deprecated（单条组不按内容丢失处理）', e.deprecated === true, 'deprecated=' + e.deprecated)
  ok('悬空 · ④不变量通过（无成环/无悬空）', checkInvariants(st).g4.length === 0)
  ok('悬空 · ②不变量通过（dupOf 不再指向不存在目标）', checkInvariants(st).g2.length === 0)
})()

// ============================================================
console.log('\n=== ④b 单条组的悬空同名旧版本：清指针+如实改写原因，不复活 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  const e = mk(st, { id: 'd/N.js', repo: 'd', path: 'N.js', contentHash: 'HN', name: '同名X', scriptName: '同名X' })
  e.deprecated = true; e.dupOf = 'd/GONE.js'; e.dupReason = '同名旧版本（已有更新版本）'; e.usable = false
  h.dedupe()
  assertAll(st, '单条同名悬空')
  ok('单条同名悬空 · 指针被清空', e.dupOf == null, 'dupOf=' + e.dupOf)
  ok('单条同名悬空 · 原因如实改写（保留方已失效）', /保留方已失效/.test(String(e.dupReason)), 'dupReason=' + e.dupReason)
  ok('单条同名悬空 · 保持 deprecated（旧版本本就该废，复活会让同名去重失效）', e.deprecated === true, 'deprecated=' + e.deprecated)
})()

// ============================================================
console.log('\n=== ⑤ 矛盾态：usable=true 且 deprecated=true ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  // 组内已有活跃副本 → 这条多余副本，应被置为 usable=false
  mk(st, { id: 'e/K.js', repo: 'e', path: 'K.js', contentHash: 'HK', deep: DEEP_OK(), usable: true })
  const dup = mk(st, { id: 'e/D.js', repo: 'e', path: 'D.js', contentHash: 'HK', deep: DEEP_OK(), usable: true })
  dup.deprecated = true; dup.dupOf = 'e/K.js'; dup.dupReason = '同内容重复'
  const r = h.dedupe()
  assertAll(st, '矛盾态')
  ok('矛盾态 · 多余副本 usable 被置 false', dup.usable === false, 'usable=' + dup.usable)
  ok('矛盾态 · keeper 仍是活跃+可用', !st.db.sources['e/K.js'].deprecated && st.db.sources['e/K.js'].usable === true)
  ok('矛盾态 · usableFixed 计数 > 0', r.usableFixed > 0, JSON.stringify(r))
})()

// ============================================================
console.log('\n=== ⑥ keeper 无深检 vs 副本实测可用：保留策略仍正确 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  mk(st, { id: 'f/a.js', repo: 'f', path: 'a.js', name: 'Y', scriptName: 'Y', contentHash: 'HY' })
  const good = mk(st, { id: 'f/b.js', repo: 'f', path: 'b.js', name: 'Y', scriptName: 'Y', contentHash: 'HY', deep: DEEP_OK(), usable: true })
  h.dedupe()
  assertAll(st, '保留策略')
  const live = Object.values(st.db.sources).filter(e => !e.deprecated)
  ok('保留策略 · 留下的是实测可用那条', live.length === 1 && live[0].id === 'f/b.js' && live[0].usable === true,
    JSON.stringify(live.map(e => e.id + ':' + e.usable)))
  ok('保留策略 · good 引用一致', good.id === 'f/b.js')
})()

// ============================================================
console.log('\n=== ⑦ 幂等：同一数据连跑 3 次，不变量始终成立且活跃集合稳定 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  mk(st, { contentHash: 'HZ1', deep: DEEP_OK(), usable: true })
  mk(st, { contentHash: 'HZ1' })
  mk(st, { contentHash: 'HZ2', deep: DEEP_ZERO() })
  mk(st, { contentHash: 'HZ2', deep: DEEP_OK(), usable: true })
  h.dedupe()
  const snap1 = Object.values(st.db.sources).filter(e => !e.deprecated).map(e => e.id).sort()
  h.dedupe()
  const snap2 = Object.values(st.db.sources).filter(e => !e.deprecated).map(e => e.id).sort()
  h.dedupe()
  const snap3 = Object.values(st.db.sources).filter(e => !e.deprecated).map(e => e.id).sort()
  assertAll(st, '幂等')
  ok('幂等 · 三次活跃集合完全一致', JSON.stringify(snap1) === JSON.stringify(snap2) && JSON.stringify(snap2) === JSON.stringify(snap3),
    JSON.stringify(snap1) + ' / ' + JSON.stringify(snap2) + ' / ' + JSON.stringify(snap3))
})()

// ============================================================
console.log('\n=== ⑧ ★ 核心 fixture：100 组全灭 → 修复后每组活跃数必须 ≥1 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  const GROUPS = 100
  const COPIES = [2, 3, 5, 10, 28]   // 复刻生产里的副本规模分布（2/3/5/10/28 份）
  const expectGroups = {}
  for (let g = 0; g < GROUPS; g++) {
    const n = COPIES[g % COPIES.length]
    const hash = 'FIX' + g
    // 形态按生产 40 组纯成环的特征：星形（多数指向 [0]）+ 少量二元互指
    const isPairCycle = (g % 7 === 0)
    const ids = []
    for (let i = 0; i < n; i++) {
      const id = 'fix/g' + g + '/c' + i + '.js'
      ids.push(id)
      mk(st, {
        id,
        repo: 'fix/g' + g,
        path: 'c' + i + '.js',
        name: 'F' + g + '_' + i,
        scriptName: 'F' + g + '_' + i,
        contentHash: hash,
        deep: i === 0 ? DEEP_OK() : null,
        usable: i === 0
      })
    }
    // 全部标成 deprecated，并写出成环/星形的 dupOf
    for (let i = 0; i < n; i++) {
      const e = st.db.sources[ids[i]]
      e.deprecated = true
      e.dupReason = '同内容重复'
      e.usable = i === 0   // 制造矛盾态：usable=true 且 deprecated=true
      if (isPairCycle && n >= 2) {
        e.dupOf = ids[i === 0 ? 1 : 0]
      } else {
        e.dupOf = i === 0 ? ids[n - 1] : ids[0]   // 星形：全部指向 [0]，而 [0] 指向最后一个
      }
    }
    expectGroups[hash] = n
  }
  const totalEntries = Object.values(st.db.sources).length
  const before = checkInvariants(st)
  ok('fixture 前置 · 确实构造出 100 组全灭', before.g1.length === GROUPS, 'g1=' + before.g1.length)
  ok('fixture 前置 · 确实构造出成环', before.g4.length > 0, 'g4=' + before.g4.length)
  ok('fixture 前置 · 确实构造出矛盾态', before.g3.length === GROUPS, 'g3=' + before.g3.length)

  const r = h.dedupe()

  assertAll(st, '100组全灭')
  const groups2 = {}
  for (const e of Object.values(st.db.sources)) {
    if (!e.contentHash) continue
    ;(groups2[e.contentHash] = groups2[e.contentHash] || []).push(e)
  }
  const zeroGroups = Object.entries(groups2).filter(([, g]) => g.filter(e => !e.deprecated).length === 0)
  ok('100组全灭 · 修复后活跃数为 0 的组 = 0 个', zeroGroups.length === 0, zeroGroups.slice(0, 3).map(([h]) => h).join(','))
  ok('100组全灭 · 每个组活跃数恰好 1（不多留也不丢）',
    Object.values(groups2).every(g => g.filter(e => !e.deprecated).length === 1),
    JSON.stringify(Object.entries(groups2).filter(([, g]) => g.filter(e => !e.deprecated).length !== 1).slice(0, 3).map(([h, g]) => h + ':' + g.filter(e => !e.deprecated).length)))
  const liveTotal = Object.values(st.db.sources).filter(e => !e.deprecated).length
  ok('100组全灭 · 复活条数 = 100（每组救回 1 条）', liveTotal === GROUPS, 'live=' + liveTotal)
  ok('100组全灭 · revived 计数 = 100', r.revived === GROUPS, JSON.stringify(r))
  ok('100组全灭 · 矛盾态归零（③不变量通过）',
    checkInvariants(st).g3.length === 0,
    JSON.stringify(checkInvariants(st).g3.slice(0, 3)))
  ok('100组全灭 · 修复确实动过数据（revived+repointed+usableFixed > 0）', r.revived + r.repointed + r.usableFixed > 0, JSON.stringify(r))
  console.log('    【数字】修复前：' + totalEntries + ' 条 / 100 组全灭 / 活跃 ' + (totalEntries - 480) + ' 条')
  console.log('    【数字】修复后：活跃 ' + liveTotal + ' 条（100 组各救回 1 条）/ 活跃为 0 的组 = 0')
  console.log('    【数字】明细：' + JSON.stringify(r))
})()

// ============================================================
console.log('\n=== ⑨ store.mergeSources：无正文→有正文且换 hash，必须清废弃标记 ===')
;(() => {
  const st = newStore()
  const e = mk(st, { id: 'm/X.js', repo: 'm', path: 'X.js', contentHash: 'OLD' })
  e.code = undefined
  e.deprecated = true; e.dupOf = 'm/K.js'; e.dupReason = '同内容重复'; e.usable = true
  e.deep = DEEP_OK()
  st.mergeSources([{ id: 'm/X.js', code: 'brand new content', contentHash: 'NEW', size: 17 }])
  const cur = st.db.sources['m/X.js']
  ok('mergeSources · contentHash 已更新为 NEW', cur.contentHash === 'NEW', cur.contentHash)
  ok('mergeSources · 换版后 deprecated 被清除', cur.deprecated === false, 'deprecated=' + cur.deprecated)
  ok('mergeSources · 换版后 dupOf/dupReason 被清除', cur.dupOf == null && cur.dupReason == null,
    'dupOf=' + cur.dupOf + ' dupReason=' + cur.dupReason)
  ok('mergeSources · 换版后 deep 被作废（不复用旧内容结果）', cur.deep == null, 'deep=' + (cur.deep && 'set'))
  ok('mergeSources · 换版后 size 与内容一致', cur.size === 17, 'size=' + cur.size)
  ok('mergeSources · 换版后 usable 被置 false', cur.usable === false, 'usable=' + cur.usable)
})()

// ============================================================
console.log('\n=== ⑩ 复活约束：只清重复标记，不动 usable/deep/status ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  // 造一个「多副本组全灭」里的复活对象：同组还有别的副本，所以必会被救活
  const pick = mk(st, { id: 'r/v1.js', repo: 'r', path: 'v1.js', contentHash: 'HV', deep: DEEP_ZERO(), status: 'ok' })
  const other = mk(st, { id: 'r/v2.js', repo: 'r', path: 'v2.js', contentHash: 'HV' })
  for (const e of [pick, other]) { e.deprecated = true; e.dupOf = e === pick ? 'r/v2.js' : 'r/v1.js'; e.dupReason = '同内容重复'; e.usable = false }
  const deepBefore = JSON.stringify(pick.deep)
  const statusBefore = pick.status
  const pickId = pick.id
  const r = h.dedupe()
  const liveV = Object.values(st.db.sources).filter(e => e.contentHash === 'HV' && !e.deprecated)
  ok('复活约束 · 组内恰好救活 1 条', liveV.length === 1, 'live=' + liveV.length + ' revived=' + r.revived)
  const revived = liveV[0]
  ok('复活约束 · 已解除废弃', revived.deprecated === false, 'deprecated=' + revived.deprecated)
  // deep 可能因 betterKeeper 择优选中组内另一条而不同，所以按「救活那条自身的 deep 未被人为改写」验：
  // 复活动作本身只清 deprecated/dupOf/dupReason，不写 deep/usable/status。
  const deepNow = JSON.stringify(revived.deep)
  const deepOrigin = JSON.stringify(revived.id === pickId ? JSON.parse(deepBefore) : other.deep)
  ok('复活约束 · deep 未被复活动作改写（交给下次检测裁决）', deepNow === deepOrigin, 'now=' + String(deepNow).slice(0, 60) + ' origin=' + String(deepOrigin).slice(0, 60))
  ok('复活约束 · status 未被改写', revived.status === statusBefore, 'status=' + revived.status)
  ok('复活约束 · usable 不被预设为 true（该条深检本就 0 可用）', revived.usable === false, 'usable=' + revived.usable)
  ok('复活约束 · 同组其余副本仍保持废弃', Object.values(st.db.sources).filter(e => e.contentHash === 'HV' && e.deprecated).length === 1)
})()

// ============================================================
console.log('\n=== ⑪ ★ 复活动作本身的纯净性：只清重复标记，一个字都不多写 ===')
;(() => {
  // 直接调 _dedupeInvariants，绕开 betterKeeper 择优选谁的问题，精确验证「复活改了哪些字段」
  const st = newStore()
  const h = new Hunter(st)
  const a = mk(st, { id: 'p/a.js', repo: 'p', path: 'a.js', contentHash: 'HP', deep: DEEP_ZERO(), status: 'quarantined' })
  const b = mk(st, { id: 'p/b.js', repo: 'p', path: 'b.js', contentHash: 'HP', deep: DEEP_OK(), status: 'ok' })
  for (const e of [a, b]) { e.deprecated = true; e.dupOf = e === a ? 'p/b.js' : 'p/a.js'; e.dupReason = '同内容重复'; e.usable = e === b }
  const snapshot = {}
  for (const e of Object.values(st.db.sources)) snapshot[e.id] = { deep: JSON.stringify(e.deep), usable: e.usable, status: e.status, contentHash: e.contentHash, size: e.size, suspected: e.suspected }
  const r = h._dedupeInvariants(Object.values(st.db.sources))
  assertAll(st, '复活纯净性')
  ok('复活纯净性 · 组内恰好 1 条活跃', Object.values(st.db.sources).filter(e => !e.deprecated).length === 1, 'revived=' + r.revived)
  const live = Object.values(st.db.sources).find(e => !e.deprecated)
  const snap = snapshot[live.id]
  ok('复活纯净性 · deep 逐字节未变', JSON.stringify(live.deep) === snap.deep, 'changed')
  ok('复活纯净性 · status 未变', live.status === snap.status, 'status=' + live.status + ' vs ' + snap.status)
  ok('复活纯净性 · contentHash 未变', live.contentHash === snap.contentHash)
  ok('复活纯净性 · size 未变', live.size === snap.size)
  // usable 的规则（P0 后）：按 deep 证据重算——有深检且可用平台 > 0 才为 true，
  // 没有深检证据的不得被预设成 true（交给下一次检测裁决）。
  const hasEvidence = !!(live.deep && live.deep.checkedAt && usableCount(live) > 0)
  ok('复活纯净性 · usable 按 deep 证据重算（有证据=可用，无证据不得为 true）',
    live.usable === hasEvidence, 'usable=' + live.usable + ' hasEvidence=' + hasEvidence)
})()

// ============================================================
console.log('\n=== ⑫ ★ P0 回归：复活后必须按 deep 证据重算 usable（不能把废弃期的 false 带出来） ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  // 三条同内容副本，全部废弃；usable 全被 dep() 置 false。
  // dead 那条深检 0 可用，good 那条深检 3 个可用。
  const dead = mk(st, { id: 'q/dead.js', repo: 'q', path: 'dead.js', contentHash: 'HQ', deep: DEEP_ZERO() })
  const good = mk(st, { id: 'q/good.js', repo: 'q', path: 'good.js', contentHash: 'HQ', deep: DEEP_OK() })
  const unck = mk(st, { id: 'q/unck.js', repo: 'q', path: 'unck.js', contentHash: 'HQ', deep: null })
  for (const e of [dead, good, unck]) { e.deprecated = true; e.dupOf = 'q/dead.js'; e.dupReason = '同内容重复'; e.usable = false }
  const r = h._dedupeInvariants(Object.values(st.db.sources))
  assertAll(st, 'P0 复活重算 usable')
  ok('P0 · 救回的正是有深检证据的那条', !good.deprecated, 'good.deprecated=' + good.deprecated)
  ok('P0 · 救回条 usable 被重算为 true（深检 3 个可用平台）', good.usable === true, 'usable=' + good.usable)
  ok('P0 · 其余副本仍废弃且 usable=false', dead.deprecated === true && dead.usable === false && unck.deprecated === true && unck.usable === false)
  ok('P0 · revived=1 / unusableRevived=0', r.revived === 1 && r.unusableRevived === 0, JSON.stringify(r))
})()

// ============================================================
console.log('\n=== ⑬ ★ P0 反向：救回的唯一副本没有深检证据 → usable 不得被预设为 true ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  const a = mk(st, { id: 'z/a.js', repo: 'z', path: 'a.js', contentHash: 'HZ', deep: null })
  const b = mk(st, { id: 'z/b.js', repo: 'z', path: 'b.js', contentHash: 'HZ', deep: DEEP_ZERO() })
  for (const e of [a, b]) { e.deprecated = true; e.dupOf = e === a ? 'z/b.js' : 'z/a.js'; e.dupReason = '同内容重复'; e.usable = false }
  const r = h._dedupeInvariants(Object.values(st.db.sources))
  assertAll(st, 'P0 无证据')
  const live = Object.values(st.db.sources).find(e => !e.deprecated)
  ok('P0无证据 · 组内救回 1 条', !!live, 'revived=' + r.revived)
  ok('P0无证据 · 无深检证据时 usable 保持 false（不预设可用）', live.usable === false, 'usable=' + live.usable)
  ok('P0无证据 · unusableRevived 计数 = 1', r.unusableRevived === 1, JSON.stringify(r))
})()

// ============================================================
console.log('\n=== ⑭ ★ P1 回归：「同内容重复」不得跨 contentHash 指向 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  // X 组的副本，却指向 Y 组的活跃条目——这是错的「同内容重复」
  const x = mk(st, { id: 'w/x.js', repo: 'w', path: 'x.js', contentHash: 'HX', deep: DEEP_ZERO() })
  x.deprecated = true; x.dupOf = 'w/y.js'; x.dupReason = '同内容重复'; x.usable = false
  mk(st, { id: 'w/y.js', repo: 'w', path: 'y.js', contentHash: 'HY', deep: DEEP_OK(), usable: true })
  // 同组的另一个活跃副本：正确目标
  const xRep = mk(st, { id: 'w/x2.js', repo: 'w', path: 'x2.js', contentHash: 'HX', deep: DEEP_OK(), usable: true })
  h._dedupeInvariants(Object.values(st.db.sources))
  assertAll(st, 'P1 跨组同内容')
  ok('P1 · 跨组「同内容重复」被改指到本组代表', x.dupOf === xRep.id, 'dupOf=' + x.dupOf + ' expect=' + xRep.id)
  ok('P1 · 仍保持 deprecated（不因改指而复活）', x.deprecated === true)
  ok('P1 · ②不变量无 cross-hash-samecontent 违例',
    checkInvariants(st).g2.filter(s => /cross-hash/.test(s)).length === 0, checkInvariants(st).g2.join(' | '))
})()

// ============================================================
console.log('\n=== ⑮ ★ P1 反向：「同名旧版本」跨 contentHash 指向是合法的，不得被打散 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  const oldV = mk(st, { id: 'v/old.js', repo: 'v', path: 'old.js', name: '同名N', scriptName: '同名N', contentHash: 'HOLD', scriptVersion: '1.0.0' })
  oldV.deprecated = true; oldV.dupOf = 'v/new.js'; oldV.dupReason = '同名旧版本（已有更新版本）'; oldV.usable = false
  mk(st, { id: 'v/new.js', repo: 'v', path: 'new.js', name: '同名N', scriptName: '同名N', contentHash: 'HNEW', scriptVersion: '2.0.0', deep: DEEP_OK(), usable: true })
  h._dedupeInvariants(Object.values(st.db.sources))
  assertAll(st, 'P1 同名旧版本跨组')
  ok('P1反向 · 同名旧版本仍指向新版（未被误改）', oldV.dupOf === 'v/new.js', 'dupOf=' + oldV.dupOf)
  ok('P1反向 · 仍保持 deprecated', oldV.deprecated === true)
})()

// ============================================================
console.log('\n=== ⑯ ★ repointed 必须是「实际变化的条目数」，不重复计数 ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  // 造一条会被 a 段和 d 段都碰到的条目，验证只计一次
  const r1 = mk(st, { id: 'c1/a.js', repo: 'c1', path: 'a.js', contentHash: 'HC1' })
  const r2 = mk(st, { id: 'c1/b.js', repo: 'c1', path: 'b.js', contentHash: 'HC1' })
  const r3 = mk(st, { id: 'c1/c.js', repo: 'c1', path: 'c.js', contentHash: 'HC1' })
  for (const e of [r1, r2, r3]) { e.deprecated = true; e.dupOf = 'nope/x.js'; e.dupReason = '同内容重复'; e.usable = false }
  const before = {}
  for (const e of Object.values(st.db.sources)) before[e.id] = e.dupOf
  const r = h._dedupeInvariants(Object.values(st.db.sources))
  const actualChanged = Object.values(st.db.sources).filter(e => before[e.id] !== e.dupOf).length
  ok('repointed 计数 = 实际 dupOf 变化条目数', r.repointed === actualChanged, 'repointed=' + r.repointed + ' actual=' + actualChanged)
})()

// ============================================================
console.log('\n=== ⑰ ★ 复活日志必须带 usable 字段（便于事后审计） ===')
;(() => {
  const st = newStore()
  const h = new Hunter(st)
  const logs = []
  h.log = (m) => logs.push(m)
  const a = mk(st, { id: 'g1/a.js', repo: 'g1', path: 'a.js', contentHash: 'HG1', deep: DEEP_OK() })
  const b = mk(st, { id: 'g1/b.js', repo: 'g1', path: 'b.js', contentHash: 'HG1', deep: DEEP_ZERO() })
  for (const e of [a, b]) { e.deprecated = true; e.dupOf = e === a ? 'g1/b.js' : 'g1/a.js'; e.dupReason = '同内容重复'; e.usable = false }
  h._dedupeInvariants(Object.values(st.db.sources))
  const rv = logs.filter(l => /dedupe: revive/.test(l))
  ok('复活日志条数 = 1', rv.length === 1, JSON.stringify(logs))
  ok('复活日志含 hash=/id=/reason=/usable=', /hash=\S+ id=\S+ reason=\S+ copies=\d+ usable=(true|false)/.test(rv[0] || ''), rv[0])
  ok('复活日志的 usable 与被救回条目一致', /usable=true/.test(rv[0] || ''), rv[0])
})()

fs.rmSync(dir, { recursive: true, force: true })
console.log('\ndedupe-invariant: PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
