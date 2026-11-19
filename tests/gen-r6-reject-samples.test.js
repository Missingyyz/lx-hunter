'use strict'
/**
 * gen-r6-reject-samples.js 的单元测试（零框架）
 *
 * 生成脚本比生成出来的样本更容易腐坏：样本是静态 JSON，一旦写进仓库就固定了；
 * 生成器下次重跑会按新代码产出**不同**的 gold。所以生成器的口径必须有测试盯着。
 *
 * 守四件事：
 *   ① 前置条件：只用「混淆 high + 非废弃 + 有**正式**深度实测 + 实测可用>=1」的条目
 *      —— 缺一条就会混进「其实没有实测」的条目，那类样本测不出「有实测时会不会误放行」
 *   ② gold 归因：P1（硬特征）与 P2（域名）必须真的对上 R6 prompt 的门槛，
 *      不能因为「想凑够条数」把不合格的也标上
 *   ③ 脱敏：域名要保留主机名（R6 靠它判域名可疑），但不能带路径/查询串（可能含 token）
 *   ④ probeOnly 的 deep 不算正式证据，必须跳过
 *
 * 夹具都是手工造的小样本，不依赖真实库快照——真实库会变，测试不能跟着变。
 */

const assert = require('assert')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const { genR6Reject, classifyReject, keepHosts, hardHits, isProbeOnly } = require(path.join(ROOT, 'tests', 'tools', 'gen-r6-reject-samples.js'))

let pass = 0
let fail = 0
function ok (cond, msg) {
  if (cond) { pass++; console.log('  PASS ' + msg) } else { fail++; console.log('  FAIL ' + msg) }
}

// ---------------- 夹具 ----------------
function mkDeep (spec, probeOnly) {
  const platforms = {}
  const names = ['wy', 'tx', 'kw', 'kg', 'mg']
  names.forEach((k, i) => { platforms[k] = { status: i < spec.usable ? 'usable' : (i < spec.usable + spec.failed ? 'failed' : 'untested') } })
  const d = { checkedAt: 1795000000000, loadable: true, platforms }
  if (probeOnly) d.probeOnly = true
  return d
}

function mkEntry (o) {
  const e = {
    id: o.id || 'e1',
    contentHash: o.hash || 'h1',
    name: o.name || '某音源',
    scriptName: o.name || '某音源',
    status: o.status || 'ok',
    validTier: o.tier === undefined ? 'confirmed' : o.tier,
    obfLevel: o.obfLevel === undefined ? 'high' : o.obfLevel,
    obfHits: o.obfHits || { spinLoops: 0, evalCalls: 0, selfSchedCalls: 0, jsjiamiMarks: 0 },
    apiHosts: o.apiHosts || [],
    obfDomains: o.obfDomains || [],
    deprecated: o.deprecated === true,
    suspected: true,
    deep: o.deep === null ? null : (o.deep || mkDeep({ usable: o.usable === undefined ? 3 : o.usable, failed: 0 }))
  }
  return e
}

const snap = (arr) => ({ sources: arr.reduce((m, e) => { m[e.id] = e; return m }, {}) })

// ============================================================
console.log('=== ① 前置条件：只有「正式实测 + 可用>=1 + 混淆 high + 非废弃」才进池 ===')
{
  // 基线：合格条目（P1：带 spin）
  const good = mkEntry({
    id: 'good1', hash: 'ha', usable: 2,
    obfHits: { spinLoops: 1, evalCalls: 0, selfSchedCalls: 0, jsjiamiMarks: 0 }
  })
  let r = genR6Reject(snap([good]), { now: 1 })
  ok(r.cases.length === 1, '合格条目生成 1 条（' + r.cases.length + '）')

  // 各缺一个条件，都应为 0 条
  const cases = [
    ['可用=0（没有实测可用，就不是危险格子）', mkEntry({ id: 'a', hash: 'hb', usable: 0, obfHits: { spinLoops: 1 } })],
    ['probeOnly 的 deep（试跑不算正式证据）', mkEntry({ id: 'b', hash: 'hc', usable: 2, obfHits: { spinLoops: 1 }, deep: mkDeep({ usable: 2, failed: 0 }, true) })],
    ['没有 deep', mkEntry({ id: 'c', hash: 'hd', usable: 2, obfHits: { spinLoops: 1 }, deep: null })],
    ['deprecated', mkEntry({ id: 'd', hash: 'he', usable: 2, obfHits: { spinLoops: 1 }, deprecated: true })],
    ['obfLevel 不是 high', mkEntry({ id: 'e', hash: 'hf', usable: 2, obfHits: { spinLoops: 1 }, obfLevel: 'mid' })]
  ]
  for (const [label, e] of cases) {
    const rr = genR6Reject(snap([e]), { now: 1 })
    ok(rr.cases.length === 0, '排除：' + label)
  }
}

// ============================================================
console.log('\n=== ② gold 归因必须对上 R6 prompt 的门槛 ===')
{
  // P1：三条门槛里 ①② 满足、③（三硬特征全 0）不满足
  const p1 = mkEntry({ id: 'p1', hash: 'hp1', usable: 2, obfHits: { spinLoops: 0, evalCalls: 2, selfSchedCalls: 0 } })
  const r1 = classifyReject(p1, {})
  ok(!!r1 && r1.primary === 'P1', 'evalCalls=2 + 可用=2 + confirmed → P1（' + (r1 && r1.primary) + '）')

  // P2：三条门槛全满足，但非常规域名 >= 4
  const p2 = mkEntry({
    id: 'p2', hash: 'hp2', usable: 2,
    apiHosts: ['a1.example-a.xyz', 'a2.example-b.top', 'a3.example-c.cc', 'a4.some-d.cn']
  })
  const r2 = classifyReject(p2, {})
  ok(!!r2 && r2.primary === 'P2', '4 个非常规域名 + 三条门槛满足 → P2（' + (r2 && r2.primary) + '）')

  // P2 的排他性：硬特征不为 0 时不该判 P2（那是 P1 的地盘），否则两条依据纠缠、测不出域名规则
  const both = mkEntry({
    id: 'both',
    hash: 'hboth',
    usable: 2,
    obfHits: { spinLoops: 1, evalCalls: 0, selfSchedCalls: 0 },
    apiHosts: ['b1.example-a.xyz', 'b2.example-b.top', 'b3.example-c.cc', 'b4.some-d.cn']
  })
  const rb = classifyReject(both, {})
  ok(!!rb && rb.primary === 'P1',
    '两类理由都成立时主归因取 P1（' + (rb && rb.primary) + '）')
  ok(!!rb && rb.secondary.indexOf('P2') !== -1,
    '另一条理由记进 secondary 保留痕迹（不丢样本、也不重复计入 byTier）')

  // 不合格的必须返回 null，不能因为「差不多」就放进样本
  ok(classifyReject(mkEntry({ id: 'x1', hash: 'hx1', usable: 0 }), {}) === null,
    '可用=0 → 不归因（null）')
  ok(classifyReject(mkEntry({ id: 'x2', hash: 'hx2', usable: 2, tier: '' }), {}) === null,
    'validTier 为空 → 不归因（门槛①不满足，gold=reject 的理由不干净）')
  ok(classifyReject(mkEntry({ id: 'x3', hash: 'hx3', usable: 2, apiHosts: ['a.com'] }), {}) === null,
    '只有 1 个常规域名且无硬特征 → 不归因（本来就该 trust）')
  // 3 个域名不算「4 个及以上」
  ok(classifyReject(mkEntry({
    id: 'x4', hash: 'hx4', usable: 2,
    apiHosts: ['a1.example-a.xyz', 'a2.example-b.top', 'a3.example-c.cc']
  }), {}) === null, '3 个非常规域名 → 不归因（prompt 要求 >= 4 才是独立拒绝条件）')
}

// ============================================================
console.log('\n=== ③ 域名脱敏：保留主机名，砍掉路径/端口/协议 ===')
{
  const kept = keepHosts([
    'https://api.example-a.com/v1/get?id=abc&token=SECRET',
    'music.example-b.top:8080/path/to/x.js',
    'www.example-c.cn',
    '  175.27.166.236  ',
    'https://api.example-a.com/other',   // 与第 1 条同主机，应去重
    '', null
  ])
  ok(kept.indexOf('api.example-a.com') !== -1, '保留主机名 api.example-a.com')
  ok(kept.filter(x => x === 'api.example-a.com').length === 1, '同一主机出现两次只留一条（去重）')
  ok(kept.indexOf('music.example-b.top') !== -1, '去掉端口 8080 后保留主机名')
  ok(kept.indexOf('example-c.cn') !== -1, 'www. 前缀归一（避免同一域算两个）')
  ok(kept.indexOf('175.27.166.236') !== -1, '裸 IP 保留（它本身就是「非常规域名」的证据）')
  ok(!kept.join(',').includes('SECRET'), '★ 查询串里的 token 不进样本')
  ok(!kept.join(',').includes('/v1/get'), '★ 路径不进样本')
  ok(!kept.join(',').includes('8080'), '端口不进样本')
  ok(kept.every(x => x === x.toLowerCase()), '统一小写（避免大小写导致重复计数）')
}

// ============================================================
console.log('\n=== ④ 一 contentHash 一条：同内容多副本不重复生成 ===')
{
  const a = mkEntry({ id: 'a', hash: 'SAME', usable: 1, obfHits: { spinLoops: 1 } })
  const b = mkEntry({ id: 'b', hash: 'SAME', usable: 3, obfHits: { spinLoops: 1 } })
  const r = genR6Reject(snap([a, b]), { now: 1 })
  ok(r.cases.length === 1, '同 hash 两个副本只生成 1 条（' + r.cases.length + '）')
  ok(/可用\s*=?\s*3/.test(r.cases[0].expected.criteria),
    '组内取实测最好的副本作代表（criteria 里写的是可用=3）')
}

// ============================================================
console.log('\n=== ⑤ 生成的样本结构合法，且 gold 与 annotation 如实标注 ===')
{
  const e = mkEntry({ id: 'z', hash: 'hz', usable: 2, obfHits: { spinLoops: 1, evalCalls: 0, selfSchedCalls: 0 } })
  const r = genR6Reject(snap([e]), { now: 12345 })
  const c = r.cases[0]
  ok(c.kind === 'R6', 'kind=R6')
  ok(c.expected.verdict === 'reject', 'expected.verdict=reject')
  ok(c.expected.zone === 'HARD', 'zone=HARD（有 confirmed + 正式深检，客观证据齐全）')
  ok(c.expected.danger === 'D1', 'danger=D1（信任放行是不可逆动作）')
  ok(String(c.expected.criteria).length > 40, 'criteria 写清了依据（' + String(c.expected.criteria).length + ' 字符）')
  ok(/门槛|域名/.test(c.expected.criteria), 'criteria 里引用了具体门槛（不是只写「应该 reject」）')
  ok(c.annotation.blind === false, '★ annotation.blind=false（gold 由规则推导，绝不冒充人工盲标）')
  ok(c.annotation.annotator === 'rule-reject', 'annotator=rule-reject（点名来源）')
  ok(c.goldAct === 'reject', 'goldAct=reject')
  ok(/^r6r-/.test(c.id), 'id 前缀 r6r-（便于与既有样本区分）')
  ok(c.contentHash === 'hz', 'contentHash 记在样本上（评测侧统计用）')
  ok(c.rejectTier === 'P1', 'rejectTier 记在样本上（可回查归因）')
}

// ============================================================
console.log('\n=== ⑥ 工具函数本身 ===')
{
  // hardHits 的入参是**条目**（内部读 e.obfHits），不是 obfHits 本身。
  // 一开始按 obfHits 传，三项全返 0——正是因为它默默返回 0 而不会抛错，
  // 这类「静默返回默认值」最容易让测试假 PASS，所以这里显式钉住两种入参。
  ok(hardHits({ obfHits: { spinLoops: 1, evalCalls: 2, selfSchedCalls: 3 } }).evalN === 2,
    'hardHits 读条目上的 obfHits.evalCalls')
  const hh = hardHits({ obfHits: { spinLoops: 1, evalCalls: 2, selfSchedCalls: 3 } })
  ok(hh.spin === 1 && hh.evalN === 2 && hh.selfSched === 3, 'hardHits 抽全三项硬特征')
  ok(hardHits({}).spin === 0, 'hardHits 空对象全 0（不抛错）')
  ok(hardHits(null).spin === 0, 'hardHits(null) 不抛错')
  ok(isProbeOnly({ deep: { probeOnly: true } }) === true, 'isProbeOnly 认 probeOnly=true')
  ok(isProbeOnly({ deep: { probeOnly: false } }) === false, 'isProbeOnly 认 probeOnly=false')
  ok(isProbeOnly({ deep: {} }) === false, 'isProbeOnly 无字段为 false')
  // 只认严格 true：'true' / 1 不算（与 checker.isProbeOnlyDeep 的严格口径一致）
  ok(isProbeOnly({ deep: { probeOnly: 'true' } }) === false, "isProbeOnly 不认 'true' 字符串（与 checker 严格口径一致）")
  ok(isProbeOnly({ deep: { probeOnly: 1 } }) === false, 'isProbeOnly 不认 1（同理）')
}

// ============================================================
console.log('\n=== ⑦ 真实快照跑出来的样本，条数与归因要和统计口径一致 ===')
{
  // 这条守「统计说生成了 N 条，实际 cases 就得是 N 条」——防止某天在循环里 continue 掉
  // 却忘了同步 stats，让报告里的数字变成假的。
  const list = [
    mkEntry({ id: 'q1', hash: 'hq1', usable: 2, obfHits: { spinLoops: 1 } }),
    mkEntry({ id: 'q2', hash: 'hq2', usable: 0, obfHits: { spinLoops: 1 } }),   // 可用 0，不进池
    mkEntry({ id: 'q3', hash: 'hq3', usable: 3, apiHosts: ['v1.example-a.xyz', 'v2.example-b.top', 'v3.example-c.cc', 'v4.some-d.cn'] })
  ]
  const r = genR6Reject(snap(list), { now: 1 })
  ok(r.stats.generated === r.cases.length,
    'stats.generated(' + r.stats.generated + ') === cases.length(' + r.cases.length + ')')
  ok(r.stats.byTier.P1 + r.stats.byTier.P2 === r.cases.length, 'byTier 之和等于生成条数')
  ok(r.stats.liveHigh === 3, 'liveHigh 统计到 3 条混淆 high 非废弃条目（' + r.stats.liveHigh + '）')
  ok(r.stats.usableGE1 === 2, 'usableGE1 统计到 2 条（可用 0 的那条被正确剔除）')
}

// ============================================================
console.log('\n----------------------------------------')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '：' + pass + ' 项通过，' + fail + ' 项失败')
if (fail > 0) process.exit(1)
assert.ok(true)
