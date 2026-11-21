'use strict'
/**
 * 历史误隔离复查迁移（obfQuarantineRecheckMigrated）回归测试。
 *
 * 背景：旧版 obfuscationRisk 把纯 CJK \uXXXX 转义计入混淆，把正常音源判 high 关进
 * 隔离区。口径修正后 _migrateObfRecalc 只洗白 obfLevel/obfHits、不碰隔离状态，
 * applyObfGate 低风险分支又不清 quarantined，导致「标注已洗白、状态仍隔离」永久卡死。
 * Store._migrateObfQuarantineRecheck 一次性复查放行这类条目。
 *
 * 锁住：
 *  ① obf 已洗白 + allow 档 + 正式实测可用 → 解除隔离、status 回 ok、usable 恢复
 *  ② 保守：不写 trustedObfHashes、error 留可追查说明
 *  ③ 红线：真高混淆 / 硬特征(spin) / 无实测 / probeOnly / deprecated 一律不碰
 *  ④ 标记位防重复
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const ROOT = path.resolve(__dirname, '..')
const { Store } = require(path.join(ROOT, 'src', 'core', 'store'))

let pass = 0
let fail = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; fails.push(name + (extra ? '  :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')) }
}
const HANZI = ['音', '源', '聚', '合', '更', '新', '版', '本', '下', '载', '服', '务', '器', '接', '口', '播', '放', '歌', '单', '曲']
function cjkOnlyScript (n) {
  const parts = []
  for (let i = 0; i < n; i++) parts.push('var s' + i + ' = "\\u' + HANZI[i % HANZI.length].charCodeAt(0).toString(16) + '";')
  while (parts.join('\n').length < 12000) parts.push('// ' + 'x'.repeat(60))
  return parts.join('\n')
}
function realObfScript (n) {
  const parts = []
  for (let i = 0; i < n; i++) parts.push('var a' + i + ' = "\\u' + (0x61 + (i % 26)).toString(16).padStart(4, '0') + '";')
  while (parts.join('\n').length < 12000) parts.push('// ' + 'x'.repeat(60))
  return parts.join('\n')
}
const DEEP = () => ({ checkedAt: 1700000000000, platforms: { qq: { status: 'usable' }, netease: { status: 'usable' } } })

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-qz-recheck-test-'))
const s = new Store(dir)
s.config.trustedObfHashes = []
const cjk = cjkOnlyScript(400)  // 纯 CJK 转义：新口径非 high

// ① 应放行：误判隔离、obf 洗白、allow 档、正式实测可用
s.db.sources['freed'] = {
  id: 'freed', name: '误隔离源', code: cjk,
  status: 'quarantined', quarantined: true, usable: true,
  obfLevel: 'high', obfHits: { totalUni: 1500, perKbUni: 12 },
  deep: DEEP()
}
// ③ 红线反例
s.db.sources['bad_realobf'] = {
  id: 'bad_realobf', name: '真高混淆', code: realObfScript(1500),
  status: 'quarantined', quarantined: true, usable: true, deep: DEEP(),
  obfLevel: 'high', obfHits: { totalUni: 1500, perKbUni: 12 }
}
s.db.sources['bad_spin'] = {
  id: 'bad_spin', name: '空转死循环', code: cjk + '\nwhile(!![]){}',
  status: 'quarantined', quarantined: true, usable: true, deep: DEEP()
}
s.db.sources['bad_nodeep'] = {
  id: 'bad_nodeep', name: '未实测', code: cjk, status: 'quarantined', quarantined: true, usable: false
}
s.db.sources['bad_probeonly'] = {
  id: 'bad_probeonly', name: '仅试跑', code: cjk,
  status: 'quarantined', quarantined: true, usable: true,
  deep: Object.assign(DEEP(), { probeOnly: true })
}
s.db.sources['bad_deprecated'] = {
  id: 'bad_deprecated', name: '废弃', code: cjk,
  status: 'quarantined', quarantined: true, usable: true, deprecated: true, deep: DEEP()
}

delete s.db.obfQuarantineRecheckMigrated
const trustBefore = JSON.stringify(s.config.trustedObfHashes)
const changed = s._migrateObfQuarantineRecheck()

console.log('\n=== ① 误隔离条目应放行 ===')
ok('迁移返回 true', changed === true)
ok('标记位已置位', s.db.obfQuarantineRecheckMigrated === true)
const f = s.db.sources['freed']
ok('quarantined 已清', f.quarantined === false)
ok('status 回 ok', f.status === 'ok')
ok('usable 恢复', f.usable === true)
ok('obfLevel 用当前口径刷新', f.obfLevel === '', '实际=' + JSON.stringify(f.obfLevel))
console.log('\n=== ② 保守：不写信任名单、留说明 ===')
ok('trustedObfHashes 未变', JSON.stringify(s.config.trustedObfHashes) === trustBefore)
ok('error 留可追查说明', !!f.error && /历史 obf 口径误判/.test(f.error))

console.log('\n=== ③ 红线反例应全部保持隔离 ===')
for (const id of ['bad_realobf', 'bad_spin', 'bad_nodeep', 'bad_probeonly', 'bad_deprecated']) {
  const e = s.db.sources[id]
  ok(id + ' 仍隔离', e.quarantined === true && e.status === 'quarantined', 'q=' + e.quarantined + ' status=' + e.status)
}

console.log('\n=== ④ 防重复 ===')
f.quarantined = true; f.status = 'quarantined'
ok('第二次返回 false', s._migrateObfQuarantineRecheck() === false)
ok('第二次不重放', f.quarantined === true)

console.log('\n=== 汇总 ===')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fails.length) console.log(fails.map(x => '  - ' + x).join('\n'))
process.exitCode = fail ? 1 : 0
