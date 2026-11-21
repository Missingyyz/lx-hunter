'use strict'
/**
 * 2026-11-22：豆包/doujs「高版本被低版本挤掉」修复回归。
 * 覆盖：预发布版本序 / quick 完整性守卫 / ②b 翻案放宽 / 同项目改名识别 / store 存量迁移。
 */
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { cmpVersion, preRank, STABLE_RANK } = require('../src/core/version')
const { Hunter } = require('../src/core/hunter')
const { Store } = require('../src/core/store')

let pass = 0
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('PASS ' + msg); pass++ }

console.log('=== A. 预发布版本序 ===')
ok(cmpVersion('9.1.5-r1', '9.1.5') === -1, 'r1 预发布 < 正式版')
ok(cmpVersion('9.1.5-r2', '9.1.5-r1') === 1, 'r2 > r1')
ok(cmpVersion('9.1.5-r1 (test)', '9.1.5') === -1, '(test) 后缀同样判预发布')
ok(preRank('9.1.5') === STABLE_RANK, '正式版 preRank=STABLE_RANK')
ok(cmpVersion('12.0 星海', '1.4 kg') === 1, '豆包 v12.0 > v1.4')
ok(cmpVersion('v2.0', 'v1.9.9') === 1 && cmpVersion('v2.0', 'v2.0.0') === 0, '既有纯版本断言不回退')

console.log('=== B. _deepIncomplete：quick 完整 / 限流不完整 ===')
const h = new Hunter({}, () => {})
const mkDeep = (platforms, depth) => ({ checkedAt: Date.now(), metrics: { depth }, platforms })
ok(h._deepIncomplete({ deep: mkDeep({ kw: { status: 'usable' }, tx: { status: 'untested', message: '未测（快速模式：已确认可用即停止）' } }, 'quick') }) === false, 'quick 的按设计未测 → 完整（可裁决）')
ok(h._deepIncomplete({ deep: mkDeep({ kw: { status: 'usable' }, tx: { status: 'untested', message: 'RATE_LIMIT 限流熔断' } }, 'full') }) === true, 'full 的限流未测 → 不完整（仍挂起）')
ok(h._deepIncomplete({ deep: mkDeep({ kw: { status: 'pending' } }, 'quick') }) === true, 'pending 一律不完整')
ok(h._deepIncomplete({ deep: null }) === true, '无深检 → 不完整')

console.log('=== C. 同项目改名识别 ===')
ok(h._isSameRepoNewerVersion(
  { repo: 'luanmuc/backend-api', scriptVersion: '9.1.2', path: 'release:v9.1.2:lx-source.js' },
  { repo: 'luanmuc/lx-music-source', scriptVersion: '1.4', path: 'versions/聚合音源v1.4.js' }) === false,
  '不同资产文件名不误判同项目')
ok(h._isSameRepoNewerVersion(
  { repo: 'luanmuc/backend-api', scriptVersion: '9.1.2', path: 'release:v9.1.2:lx-source.js' },
  { repo: 'luanmuc/lx-music-source', scriptVersion: '1.4', path: 'lx-source.js' }) === true,
  '同 owner + 同名资产 lx-source.js → 跨仓改名的真迭代')

console.log('=== D. store 存量迁移 ===')
function mkStore(sources) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-dedup-'))
  const st = new Store(dir)
  st.db.sources = sources
  delete st.db.wrongDedupMigrated   // 构造时已跑过一次迁移，这里重置以测新数据
  return st
}
const deep3 = { checkedAt: Date.now(), metrics: { depth: 'full' }, platforms: { kw: { status: 'usable' }, tx: { status: 'usable' }, wy: { status: 'usable' } } }
const deep1 = { checkedAt: Date.now(), metrics: { depth: 'full' }, platforms: { kw: { status: 'usable' } } }
const db1 = {
  'high': { id: 'high', repo: 'zues0077/doujs', scriptVersion: '9.1.5-r1', contentHash: 'h1', deep: deep3, deprecated: true, dupOf: 'low', dupReason: '同名旧版本', status: 'ok' },
  'low': { id: 'low', repo: 'zues0077/doujs', scriptVersion: '9.1.1-r1', contentHash: 'h2', deep: deep3, deprecated: false }
}
const st1 = mkStore(db1)
ok(st1._migrateWrongDedup() === true, '迁移执行一次')
ok(st1.db.sources.high.deprecated === false && st1.db.sources.low.deprecated === true, '版本更新者即使平台数相同也翻案（doujs 9.1.5-r1 场景）')
ok(st1._migrateWrongDedup() === false, '迁移标记：只跑一次')

// 共享 keeper 链式：v1.4 Keeper 被多个高版本指向，全部改指到最优者
const chain = {
  'v14': { id: 'v14', scriptVersion: '1.4', contentHash: 'c0', deep: null, deprecated: false },
  'v120': { id: 'v120', scriptVersion: '12.0', contentHash: 'c1', deep: deep3, deprecated: true, dupOf: 'v14', dupReason: '同名旧版本' },
  'v272': { id: 'v272', scriptVersion: '27.2', contentHash: 'c2', deep: deep3, deprecated: true, dupOf: 'v14', dupReason: '同名旧版本' },
  'v1113': { id: 'v1113', scriptVersion: '11.13', contentHash: 'c3', deep: deep3, deprecated: true, dupOf: 'v14', dupReason: '同名旧版本' }
}
const stc = mkStore(chain)
stc._migrateWrongDedup()
ok(stc.db.sources.v272.deprecated === false, '共享 keeper 组：最高版本 v27.2 复活')
ok(stc.db.sources.v14.deprecated === true && stc.db.sources.v14.dupOf === 'v272', '原低版 keeper v1.4 被废并改指 v27.2')
ok(stc.db.sources.v120.dupOf === 'v272' && stc.db.sources.v1113.dupOf === 'v272', '其余被废成员统一改指新赢家（无链式误指）')

// 含糊组不动：双方 deep 且版本相同、平台数差 1（<2）
const deep2 = { checkedAt: Date.now(), metrics: { depth: 'full' }, platforms: { kw: { status: 'usable' }, tx: { status: 'usable' } } }
const db2 = {
  'a': { id: 'a', scriptVersion: '9.1.5', contentHash: 'h1', deep: deep2, deprecated: true, dupOf: 'b', dupReason: '同名旧版本' },
  'b': { id: 'b', scriptVersion: '9.1.5', contentHash: 'h2', deep: deep1, deprecated: false }
}
const st2 = mkStore(db2)
st2._migrateWrongDedup()
ok(st2.db.sources.a.deprecated === true, '含糊组（版本相同、差 1）不误翻：保留原裁决')

// 版本不占优不动
const db3 = {
  'old': { id: 'old', scriptVersion: '1.4', contentHash: 'h1', deep: deep3, deprecated: true, dupOf: 'new', dupReason: '同名旧版本' },
  'new': { id: 'new', scriptVersion: '12.0', contentHash: 'h2', deep: null, deprecated: false }
}
const st3 = mkStore(db3)
st3._migrateWrongDedup()
ok(st3.db.sources.old.deprecated === true, '被废方版本更低 → 不翻案（避免反向误伤）')

console.log(`\n${pass} PASS / doubao-dedup-fix.test.js`)
