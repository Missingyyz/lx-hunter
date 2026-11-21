'use strict'
/**
 * obf 启动迁移重算（v1.15.0）：历史脏数据的 obfLevel/obfHits 用当前生产口径重刷一次。
 *
 * 背景：旧版把纯 CJK \uXXXX 转义计入混淆指标，落库了 obfLevel=high / totalUni 上千的
 * 脏数据；checker.js 早已修正却没重算已落库条目。Store 构造时一次性重算，只刷
 * obfLevel/obfHits，绝不碰 status/quarantine/任何安全字段，靠 db.obfRecalcMigrated 防重复。
 *
 * 本测试锁住：
 *  ① 纯 CJK 转义样本（老口径 high）重算后 level→''（新口径正确）
 *  ② 只刷 obfLevel/obfHits，status/quarantined/usable/act 一个都不碰
 *  ③ 无 code 的条目跳过（留待 checkBasic）
 *  ④ 标记位防重复（第二次调用不再改）
 *  ⑤ 真高混淆样本重算后仍 high（不误伤正确判定）
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const ROOT = path.resolve(__dirname, '..')
const CORE = (n) => path.join(ROOT, 'src', 'core', n)
const { Store } = require(CORE('store'))
const { obfuscationRisk } = require(CORE('checker'))

let pass = 0
let fail = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; fails.push(name + (extra ? '  :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')) }
}

const HANZI = ['音','源','聚','合','更','新','版','本','下','载','服','务','器','接','口','播','放','歌','单','曲','词','封','面','加','密','搜','索','榜']
// 纯 CJK 转义脚本：老口径会数出大量 \uXXXX，新口径（只数非 CJK）应为空
function cjkOnlyScript (n) {
  const parts = []
  for (let i = 0; i < n; i++) parts.push('var s' + i + ' = "\\u' + HANZI[i % HANZI.length].charCodeAt(0).toString(16) + '";')
  while (parts.join('\n').length < 12000) parts.push('// ' + 'x'.repeat(60))
  return parts.join('\n')
}
// 真高混淆脚本：大量非 CJK 转义（ASCII 码点），新口径仍应判 high
function realObfScript (n) {
  const parts = []
  for (let i = 0; i < n; i++) parts.push('var a' + i + ' = "\\u' + (0x61 + (i % 26)).toString(16).padStart(4, '0') + '";')
  while (parts.join('\n').length < 12000) parts.push('// ' + 'x'.repeat(60))
  return parts.join('\n')
}

console.log('\n=== obf 启动迁移重算（obfRecalcMigrated） ===')
;(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-obf-recalc-'))
  const s = new Store(dir)
  const cjk = cjkOnlyScript(1500)
  const obf = realObfScript(1500)
  // 构造脏数据：obfLevel=high / totalUni 上千，且带安全字段，验证不被碰
  s.db.sources['dirty'] = {
    id: 'dirty', name: '纯CJK转义源', code: cjk,
    obfLevel: 'high', obfHits: { totalUni: 1500, perKbUni: 12, evalCalls: 0, total0x: 0 },
    status: 'ok', quarantined: false, usable: true, act: 'follow', deep: { checkedAt: 123 }
  }
  s.db.sources['nocode'] = {
    id: 'nocode', name: '无code源', status: 'ok',
    obfLevel: 'high', obfHits: { totalUni: 2000, perKbUni: 15 }
  }
  s.db.sources['realobf'] = {
    id: 'realobf', name: '真混淆源', code: obf,
    obfLevel: 'mid', obfHits: { totalUni: 2, perKbUni: 0.1 }
  }
  delete s.db.obfRecalcMigrated  // 重置标记，触发迁移

  const changed = s._migrateObfRecalc()
  ok('迁移返回 true（发生了重算）', changed === true)
  ok('标记位已置位', s.db.obfRecalcMigrated === true)

  // ① 纯 CJK 样本重算后降级
  const d = s.db.sources['dirty']
  ok('① 纯CJK样本 obfLevel high→空', d.obfLevel === '', '实际=' + JSON.stringify(d.obfLevel))
  ok('① obfHits 已用当前口径刷新（totalUni 大减）',
    d.obfHits && Number(d.obfHits.totalUni) < 300, 'totalUni=' + (d.obfHits && d.obfHits.totalUni))

  // ② 只刷 obf 字段，安全字段一个不动
  ok('② status 未变', d.status === 'ok')
  ok('② quarantined 未变', d.quarantined === false)
  ok('② usable 未变', d.usable === true)
  ok('② act 未变', d.act === 'follow')
  ok('② deep 未变', d.deep && d.deep.checkedAt === 123)
  ok('② code 未变', d.code === cjk)

  // ③ 无 code 跳过
  const nc = s.db.sources['nocode']
  ok('③ 无code条目 obfLevel 保持 high（跳过）', nc.obfLevel === 'high')
  ok('③ 无code条目 obfHits 未被改', nc.obfHits && nc.obfHits.totalUni === 2000)

  // ⑤ 真高混淆重算后仍 high
  const ro = s.db.sources['realobf']
  ok('⑤ 真高混淆样本重算后 obfLevel=high（不误伤）', ro.obfLevel === 'high', '实际=' + ro.obfLevel)

  // ④ 标记位防重复：再调一次不再改（先把 dirty 改回脏值，第二次迁移应跳过不动它）
  d.obfLevel = 'high'; d.obfHits = { totalUni: 9999 }
  const changed2 = s._migrateObfRecalc()
  ok('④ 第二次调用返回 false（防重复）', changed2 === false)
  ok('④ 第二次不重刷（脏值原样留着）', d.obfLevel === 'high' && d.obfHits.totalUni === 9999)

  // 构造后重开 Store：迁移已标记，不应再动（落盘后标记持久）
  s.saveDb()
  const s2 = new Store(dir)
  ok('落盘后重开 Store 不再迁移（标记持久）', s2.db.obfRecalcMigrated === true && s2.db.sources['dirty'].obfLevel === 'high')
})()

console.log('\n=== 汇总 ===')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (fails.length) console.log(fails.map(f => '  - ' + f).join('\n'))
process.exitCode = fail ? 1 : 0
