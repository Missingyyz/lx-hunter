'use strict'
/**
 * R6「试跑证据」（probeOnly）语义测试 + R7 误读漏洞回归
 *
 * === 这个测试在守什么 ===
 * v1.13.12 给隔离区加了「试跑一次」：条目能在不被信任的前提下拿到真实 deep。
 * 这份 deep 打 `probeOnly = true`，checker 侧靠 `isProbeOnlyDeep` 把它从两处自动化
 * 决策里摘出去（档位降级、自动信任）。但**评测与 AI 复检这一层当时没人守**，
 * 本测试把四个必须成立的语义固化成断言：
 *
 *   ① R6 的 prompt 必须让模型看见「这是试跑，用户尚未确认信任」。
 *      否则模型会把「试跑一次」读成「已审查通过」，用户看到 AI 结论会以为是背书过的。
 *   ② 带 probeOnly 与不带 probeOnly 的同一条，prompt 差异**只允许**是那句标注。
 *      这条防的是「顺手把 deep 也降级/抹掉」——那会让门槛②永远看不到实测数据，
 *      试跑功能等于白做；也防「悄悄多塞别的东西」改变判断依据。
 *   ③ R7 看到 probeOnly 的 deep 时，必须至少知道「这是试跑」。
 *      R7 是删源判定（不可逆），把一次性试跑读成正式实测是本项目代价最高的误判。
 *   ④ 格式非法（probeOnly 写成 1 / 'true'）必须抛错，不能静默退化成「正式证据」。
 *
 * === 关于「AI 会不会因此更谨慎」 ===
 * 本测试**不测**这个。要测必须真调 provider（花钱、不确定、不可重放），
 * 而评测回放的 stub/mockops 模式按 goldAct 造数据，只能验链路、不能下质量结论
 * （见 tests/tools/replay-eval.js 的注释）。所以这里只守「模型能看到这个事实」，
 * 「看到之后怎么判」交给真机回放，结论写进报告，不在这里假装测过。
 */

const assert = require('assert')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const { REVIEW_PROMPTS } = require(path.join(ROOT, 'src', 'core', 'aiReview.js'))
const { isProbeOnlyDeep, classifyQuarantineTrust } = require(path.join(ROOT, 'src', 'core', 'checker.js'))
const { loadCases } = require(path.join(ROOT, 'src', 'core', 'evalCases.js'))

let pass = 0
let fail = 0
function ok (cond, msg) {
  if (cond) { pass++; console.log('  PASS ' + msg) } else { fail++; console.log('  FAIL ' + msg) }
}

// ---------------- 夹具 ----------------
// 一条「隔离区试跑过」的典型条目：混淆 high、实测 5 个平台里 1 个可用。
// 刻意选「可用 >= 1」的形态——这正是 R6 门槛②能通过、模型最容易判 trust 的形态。
function probeEntry (probeOnly) {
  const deep = {
    checkedAt: 1795000000000,
    loadable: true,
    hash: 'abc123',
    platforms: {
      wy: { status: 'usable', url: 'https://example.invalid/wy' },
      tx: { status: 'failed', message: 'no url' },
      kw: { status: 'untested' },
      kg: { status: 'untested' },
      mg: { status: 'untested' }
    }
  }
  if (probeOnly !== undefined) deep.probeOnly = probeOnly
  return {
    id: 'probe-case',
    name: '墨澜音乐源v2.3.4',
    status: 'quarantined',
    error: '',
    validTier: 'confirmed',
    usable: false,
    apiDownStreak: 0,
    apiHosts: ['gitee.com'],
    obfHits: { spinLoops: 0, evalCalls: 0, selfSchedCalls: 0, jsjiamiMarks: 1 },
    obfLevel: 'high',
    suspected: true,
    repository: 'example/repo',
    deep
  }
}

function deepLine (text) {
  return String(text || '').split('\n').filter(l => l.indexOf('深度摘要') === 0 || l.indexOf('本机深度实测') === 0)[0] || ''
}

// ============================================================
console.log('=== ① R6 的 prompt 必须让模型看见「这是试跑」 ===')
{
  const withProbe = REVIEW_PROMPTS.R6.buildText(probeEntry(true))
  const without = REVIEW_PROMPTS.R6.buildText(probeEntry(undefined))

  ok(/试跑/.test(withProbe), 'R6 带 probeOnly 的 prompt 里出现「试跑」字样')
  ok(/用户尚未确认信任/.test(withProbe), 'R6 带 probeOnly 的 prompt 里说明「用户尚未确认信任」')
  ok(!/试跑/.test(without), 'R6 不带 probeOnly 的 prompt 里**不**出现「试跑」（不能给正常条目乱加标注）')

  // 实测数字必须仍然可见：门檻②要求可用>=1，试跑产出的可用数若被抹掉，
  // 试跑功能就失去意义（模型永远拿不到实测证据）。
  ok(/可用\s*=?\s*1/.test(withProbe), 'R6 带 probeOnly 时仍能看到「可用=1」（门槛②的依据没被抹掉）')
}

// ============================================================
console.log('\n=== ② 带 / 不带 probeOnly 的差异只允许是那句标注 ===')
{
  const a = deepLine(REVIEW_PROMPTS.R6.buildText(probeEntry(true)))
  const b = deepLine(REVIEW_PROMPTS.R6.buildText(probeEntry(undefined)))
  const stripped = a.replace('，（此为本机一次性试跑结果，用户尚未确认信任）', '')
  ok(stripped === b, '去掉那句标注后，两条 prompt 的深度摘要行完全相同（没有顺手改动别的字段）')
  ok(a.length > b.length, '带 probeOnly 的摘要在原文之后**追加**说明，而不是删掉或替换原有信息')

  // R6 的 three 门槛原文里「可用平台数 >= 1」的判断不受影响：
  // 标注是加在计数后面的，计数本身（平台数/可用/失败）原样保留。
  ok(/平台数\s*=?\s*5/.test(a) && /失败\s*=?\s*1/.test(a), '平台数 / 失败数也原样保留，不只保留可用数')
}

// ============================================================
console.log('\n=== ③ R7 读到 probeOnly 的 deep 时，必须至少能看见「这是试跑」 ===')
{
  const e = probeEntry(true)
  const r7 = REVIEW_PROMPTS.R7.buildText(e)
  const r7Normal = REVIEW_PROMPTS.R7.buildText(probeEntry(undefined))

  // 这是本轮查出来的漏洞：R7 的 buildText 走 deepSummaryText(p.deep)，
  // 而 probeOnly 标注就加在 deepSummaryText 里 ⇒ R7 也能看到。
  // 若将来有人把这行标注只加在 R6 分支，这条断言会 FAIL，提醒「R7 又开始盲判了」。
  ok(/本机深度实测/.test(r7), 'R7 的 prompt 里有「本机深度实测」这一行（R7 确实读 deep）')
  ok(/试跑/.test(r7), '★ R7 看到 probeOnly 的 deep 时，prompt 里带「试跑」标注（不是盲判）')
  ok(!/试跑/.test(r7Normal), 'R7 对正式测过的条目不加「试跑」标注')

  // 更要紧的一条：R7 的判据①写着「状态 dead/404 一律 blacklist，本机无实测也属失效源」。
  // 试跑产出的 deep 若被 R7 当成「正式实测」，就会出现「试跑 → 实测可用=0 + streak>=10
  // → 判 blacklist」这条基于一次性结果的删源路径。标注在，至少模型知道这不是正式证据。
  ok(/用户尚未确认信任/.test(r7), '★ R7 也拿到了「用户尚未确认信任」的说明（删源不可逆，必须让模型知道证据强度）')

  // 记录事实：R7 prompt 的「本机深度实测」行确实会把试跑的可用数原样写进去。
  // 这不是 bug（模型有权看到真数据），但必须被测试记住——否则将来改了会没人发现。
  ok(/可用\s*=?\s*1/.test(r7), 'R7 的 prompt 里仍含试跑的可用数（如实呈现，靠标注区分证据强度）')
}

// ============================================================
console.log('\n=== ④ probeOnly 必须是严格布尔，写错要抛错而不是静默放行 ===')
{
  ok(isProbeOnlyDeep(probeEntry(true)) === true, 'probeOnly=true → isProbeOnlyDeep 返回 true')
  ok(isProbeOnlyDeep(probeEntry(false)) === false, 'probeOnly=false → 返回 false（显式标记为正式证据）')
  ok(isProbeOnlyDeep(probeEntry(undefined)) === false, '没有 probeOnly 字段 → 返回 false（老数据兼容）')

  let threw = null
  try { isProbeOnlyDeep(probeEntry(1)) } catch (e) { threw = e }
  ok(!!threw && /probeOnly/.test(String(threw.message)), 'probeOnly=1（数字）→ 抛错，不静默当成正式证据')

  threw = null
  try { isProbeOnlyDeep(probeEntry('true')) } catch (e) { threw = e }
  ok(!!threw && /probeOnly/.test(String(threw.message)), "probeOnly='true'（字符串）→ 抛错")
}

// ============================================================
console.log('\n=== ⑤ 数据层隔离：试跑的 deep 不能降级混淆档位 ===')
{
  const withProbe = classifyQuarantineTrust(probeEntry(true), {})
  const formal = classifyQuarantineTrust(probeEntry(undefined), {})

  // 关键语义（checker.js:1155-1160）：试跑的 deep 在档位判定里视为「没有实测」。
  ok(withProbe.evidence.usableN === 0, '试跑的 deep：classifyQuarantineTrust 的 usableN 记为 0（视同没有实测）')
  ok(withProbe.evidence.deepDone === false, '试跑的 deep：deepDone=false（不当成正式实测过）')
  ok(formal.evidence.usableN === 1, '同样的 deep 去掉 probeOnly 后 usableN=1（对照组：确实会变）')
  ok(formal.evidence.deepDone === true, '对照组 deepDone=true')

  // 档位必须真的不同，而且要用**带空转特征**的样本才看得出来：
  // classifyQuarantineTrust 的 block 唯一入口是
  //   spin >= 1 && usableN === 0 && (suspect >= 4 || !deepDone)
  // 干净样本（spin=0）无论 usableN 是多少都是 allow，拿它比档位什么都证明不了。
  // 带 spin 的样本：试跑（usableN 被当 0 + deepDone=false）→ block；
  //                 正式实测（usableN>=1）→ 永不吃 block → risky。
  // 这正是「试跑不能降级」这条隔离要挡的东西：降级就说明试跑一次把 block 洗成了 risky。
  const spinEntry = (probeOnly) => {
    const e = probeEntry(probeOnly)
    e.obfHits = { spinLoops: 1, evalCalls: 0, selfSchedCalls: 0, jsjiamiMarks: 0 }
    return e
  }
  const dangerProbe = classifyQuarantineTrust(spinEntry(true), {})
  const dangerFormal = classifyQuarantineTrust(spinEntry(undefined), {})
  ok(dangerProbe.level === 'block',
    '带空转特征 + 试跑 deep → block（实测没被当成正式证据，' + dangerProbe.level + '）')
  ok(dangerFormal.level === 'risky',
    '同样的条目 + 正式 deep → risky（实测可用>=1 永不吃 block，' + dangerFormal.level + '）')
  ok(dangerProbe.level !== dangerFormal.level,
    '★ 档位确实不同（' + dangerProbe.level + ' vs ' + dangerFormal.level + '）——证明这层隔离真的生效')
  // 干净样本那条也留着当反向对照：确认「档位不变」不是因为判级坏了
  ok(withProbe.level === 'allow' && formal.level === 'allow',
    '干净样本（spin/eval/sched 全 0）两者都是 allow —— 确认判级本身没被改坏')
}

// ============================================================
console.log('\n=== ⑥ 评测集必须真的覆盖 probeOnly 场景（不然等于没测） ===')
{
  // 现有 R6 样本的 deep 全是**字符串**，而 probeOnly 只能表达在**对象** deep 上。
  // 这是个很容易被忽略的坑：样本看起来「有 deep」，但试跑场景压根进不了评测。
  const cases = loadCases(path.join(ROOT, 'tests', 'eval-cases'))
  const r6 = cases.filter(c => c.kind === 'R6')
  const objDeep = r6.filter(c => c.input && c.input.deep && typeof c.input.deep === 'object')
  ok(r6.length > 0, '评测集里有 R6 样本（' + r6.length + ' 条）')
  // 把事实记录下来当断言：当前应为 0，若将来补了对象 deep 的样本，这里会提醒改口径。
  ok(objDeep.length === 0,
    '当前 R6 样本的 deep 全是字符串（对象 deep 的 ' + objDeep.length + ' 条）——' +
    '意味着「probeOnly 直接进评测样本」这条路尚未启用，试跑场景只能按输入形态构造验证')
}

// ============================================================
console.log('\n=== ⑦ 补进来的 reject 样本，gold 依据必须与 R6 prompt 门槛对得上 ===')
{
  const cases = loadCases(path.join(ROOT, 'tests', 'eval-cases'))
  const mine = cases.filter(c => String(c.id).indexOf('r6r-') === 0)
  ok(mine.length > 0, '评测集里有新补的 R6 reject 样本（' + mine.length + ' 条）')

  function parseHits (s) {
    const o = {}
    String(s || '').split(/\s+/).forEach(kv => {
      const m = kv.match(/^(\w+)=([-\d.]+)$/)
      if (m) o[m[1]] = Number(m[2])
    })
    return o
  }
  function parseDeep (s) {
    const m = String(s || '').match(/平台数\s*=?\s*(\d+)\s*可用\s*=?\s*(\d+)/)
    return m ? { total: Number(m[1]), usable: Number(m[2]) } : null
  }

  let bad = []
  for (const c of mine) {
    // 每条 gold=reject 都必须能对上 prompt 里的一条拒绝条件，不能只是「我标了 reject」
    const h = parseHits(c.input.obfHits)
    const d = parseDeep(c.input.deep)
    const hard = (h.spinLoops || 0) + (h.evalCalls || 0) + (h.selfSchedCalls || 0)
    const hosts = Array.from(new Set(
      (c.input.obfDomains || []).concat(c.input.apiHosts || [])
    )).filter(Boolean)
    const p1 = hard > 0 && d && d.usable >= 1 && c.input.validTier === 'confirmed'
    const p2 = hosts.length >= 4 && d && d.usable >= 1 && c.input.validTier === 'confirmed'
    if (!p1 && !p2) bad.push(c.id)
    if (c.expected.verdict !== 'reject') bad.push(c.id + '(verdict)')
    if (String(c.expected.criteria || '').length < 40) bad.push(c.id + '(criteria 太短)')
  }
  ok(bad.length === 0, '每条 reject 都能对上 prompt 的具体拒绝条件（P1 硬特征 / P2 域名可疑），异常：' + (bad.join(',') || '无'))

  // 本批的核心价值：这个格子以前是空的
  const dangerCell = mine.filter(c => {
    const h = parseHits(c.input.obfHits)
    const d = parseDeep(c.input.deep)
    return d && d.usable >= 1 && ((h.spinLoops || 0) + (h.evalCalls || 0) + (h.selfSchedCalls || 0) > 0)
  })
  ok(dangerCell.length > 0, '★「实测可用>=1 × 带硬特征」这个空格子已补上（' + dangerCell.length + ' 条）')
}

// ============================================================
console.log('\n=== ⑧ 域名必须留在样本里（P2 样本的有效性前提） ===')
{
  const cases = loadCases(path.join(ROOT, 'tests', 'eval-cases'))
  const mine = cases.filter(c => String(c.id).indexOf('r6r-') === 0)
  const p2 = mine.filter(c => c.rejectTier === 'P2')
  ok(p2.length > 0, '有 P2（域名可疑）样本（' + p2.length + ' 条）')
  // 踩过的坑：第一版用 scrubList 脱敏，所有域名变成 [HOST]，
  // 模型既数不出个数、也看不出是不是动态解析域名，gold=reject 变成无依据。
  const scrubbed = p2.filter(c => {
    const all = (c.input.obfDomains || []).concat(c.input.apiHosts || [])
    return all.length > 0 && all.every(d => String(d).indexOf('[HOST]') !== -1 || String(d).indexOf('[URL]') !== -1)
  })
  ok(scrubbed.length === 0, 'P2 样本的域名**不是**全被脱敏成 [HOST]/[URL]（否则域名判据无从判断）')
  const hasReal = p2.filter(c => (c.input.apiHosts || []).some(d => /[a-z0-9-]\.[a-z]{2,}/i.test(String(d))))
  ok(hasReal.length === p2.length, '每条 P2 样本都保留了可读的真实主机名')
}

// ============================================================
console.log('\n----------------------------------------')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '：' + pass + ' 项通过，' + fail + ' 项失败')
if (fail > 0) process.exit(1)
assert.ok(true)
