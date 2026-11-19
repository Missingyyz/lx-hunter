'use strict'
/**
 * 从音源库导出快照生成 R7 评测样本（**gold=keep 方向**，2026-11-19 B 批 B1）
 *
 * === 为什么需要这个 ===
 * R7 原本只有 14 条 dead/404 + 15 条 keep 对照，且 `keep` 那 15 条是 dual-blind 时期
 * 随手挑的对照，覆盖面窄。更致命的是：一旦这些 keep 样本因门槛/分层原因被筛掉，
 * R7|D1 的 `keepGoldCount` 就是 0，**删源误伤率数学上无法计算**（分母为 0）——
 * 而删源是不可逆动作，这一层等于从没被验证过。
 *
 * 本工具从真实库按 R7 prompt 的 keep 判据批量构造 keep 样本，让误伤率可观测。
 *
 * === gold 依据（不是主观判断，逐条可回查） ===
 * 判据全部来自 `aiReview.js` 的 `REVIEW_PROMPTS.R7.system` 原文，按以下顺序归因：
 *
 *   K1 实测可用    本机深度实测「可用 >= 1」，或 usable=true
 *                → prompt：「凡本机深度实测"可用>=1"或 usable=true 的……一律 keep
 *                  （信号矛盾时以实测为准，不删）」【最强依据】
 *   K2 刚失效      深度实测可用=0，但连续失效次数 < 10
 *                → prompt：「连续失效次数<10 的，即便深度实测可用=0，也一律 keep」
 *   K3 证据缺失    无深度实测（或从未检测），且 status 非 dead
 *                → prompt：「证据缺失、判定层级为空、deep 无实测且状态又非 dead 的，
 *                  一律 keep」
 *   K4 高危形态    实测可用 >= 1 **且**带混淆特征（obfLevel 高 / eval / jsjiami / spin）
 *                → 同上「以实测为准」；这类是最容易被模型误判成 blacklist 的高危形态，
 *                  专门留作误伤率的分母，是本批样本的核心价值
 *
 * 归因顺序 K1 → K4 → K2 → K3（一条样本只记一个 primary，其余命中写进 secondary）。
 * K4 优先于 K2/K3 是因为它必须满足 K1，本质上更硬。
 *
 * === 铁律（与 gen-r7-samples.js 一致，违反会污染评测） ===
 * 1. **一个 contentHash 只生成一个样本**。同内容多副本各记一次自己的深检结果，
 *    同一份脚本能测出 0/5、2/5、3/5；逐条生成会产生「同内容、相反 gold」的自相矛盾
 *    样本，把评测毒死。
 * 2. `input` 严格脱敏：不含脚本正文、不含密钥、真实域名/路径/邮箱/t.me 一律替换。
 * 3. `annotation.blind=false` + `annotator` 如实写 `rule-keep`，并注明「gold 由规则推导，
 *    非人工盲标」。冒充盲标会让后续复核失去意义。
 * 4. 不改已有样本文件，只新增。
 *
 * === 用法 ===
 *   node tests/tools/gen-r7-keep-samples.js <库快照.json> [输出文件]
 */

const fs = require('fs')
const path = require('path')
const { scrubText, scrubList, deepSummary, obfHitsText, usableCount, normSources } = require('./gen-r7-samples')

const hasDeep = (e) => !!(e && e.deep && e.deep.checkedAt && Object.keys((e.deep && e.deep.platforms) || {}).length)

/** 混淆特征强度（只看「容易被误判」的那几项，与 R7 buildText 渲染的字段一致）。 */
function obfRisk (e) {
  const h = (e && e.obfHits) || {}
  const lv = String((e && e.obfLevel) || '')
  const hits = []
  if (lv === 'high') hits.push('obfLevel=high')
  else if (lv === 'mid' || lv === 'medium') hits.push('obfLevel=' + lv)
  const ev = Number(h.evalCalls) || 0
  const js = Number(h.jsjiamiMarks) || 0
  const sp = Number(h.spinLoops) || 0
  const un = Number(h.totalUni) || 0
  const ex = Number(h.totalExotic) || 0
  if (ev > 0) hits.push('evalCalls=' + ev)
  if (js > 0) hits.push('jsjiamiMarks=' + js)
  if (sp > 0) hits.push('spinLoops=' + sp)
  if (un > 0 || ex > 0) hits.push('totalUni=' + un + '/totalExotic=' + ex)
  return hits
}

/**
 * 组内挑代表：与 gen-r7-samples 的 pickRepresentative 相反——
 * keep 方向要挑「实测最好」的那一份，因为 gold 是「该保留」。
 *   ① 有深检优先（有实测证据才谈得上判 keep）
 *   ② 可用平台**多**的优先
 *   ③ lastCheck 最新
 *   ④ id 小者稳定排序
 */
function pickKeepRepresentative (group) {
  const score = (e) => {
    const deep = hasDeep(e) ? e.deep : null
    return {
      hasDeep: deep ? 1 : 0,
      usable: deep ? usableCount(deep) : -1,
      lastCheck: Number(e.lastCheck) || Number(deep && deep.checkedAt) || Number(e.addedAt) || 0,
      id: String(e.id || '')
    }
  }
  return group.slice().sort((x, y) => {
    const a = score(x); const b = score(y)
    if (a.hasDeep !== b.hasDeep) return b.hasDeep - a.hasDeep
    if (a.usable !== b.usable) return b.usable - a.usable
    if (a.lastCheck !== b.lastCheck) return b.lastCheck - a.lastCheck
    return a.id.localeCompare(b.id)
  })[0]
}

function buildInput (e) {
  const deep = hasDeep(e) ? e.deep : null
  const inp = {
    name: scrubText(e.name || e.lxName || e.scriptName || ''),
    scriptName: scrubText(e.scriptName || e.lxName || ''),
    scriptVersion: scrubText(e.scriptVersion || (deep && deep.version) || ''),
    status: String(e.status || ''),
    error: scrubText(e.error || ''),
    repository: e.repo ? '[REPO]' : '',
    validTier: String(e.validTier || ''),
    obfLevel: String(e.obfLevel || ''),
    obfHits: obfHitsText(e.obfHits),
    obfDomains: scrubList(e.obfDomains),
    apiHosts: scrubList(e.apiHosts),
    apiDownStreak: Number(e.apiDownStreak) || 0,
    suspected: e.suspected === true ? true : (e.suspected === false ? false : null),
    usable: e.usable === true,
    deep: deepSummary(deep)
  }
  inp.installed = !!(e.scriptName || (Array.isArray(e.apiHosts) && e.apiHosts.length) || inp.deep || e.validTier)
  return inp
}

/**
 * 判定一个条目属于哪一类 keep 依据。
 *
 * ★ 采样口径要「可靠」，不是「能凑数」：
 *  - K3 必须排除 `probe.status === 'not_loadable'`（脚本实测加载不了）和
 *    `validTier === 'rejected'`（已判明确非音源/已死）。这两类虽然 R7 prompt 字面上
 *    「无 deep 且非 dead 就 keep」，但把它们当 gold=keep 会与事实打架：脚本根本跑不起来，
 *    拿去当误伤率的分母等于自己制造假阳/假阴。实测原始 K3 323 条里 267 条是
 *    not_loadable、243 条是 rejected，收紧后只剩 56 条干净的「从没测过」条目。
 *  - K1/K4 要求确有深度实测证据。
 *
 * @returns {{primary:string, secondary:string[], risk:string[]}|null}
 */
function classifyKeep (e) {
  const deepOk = hasDeep(e)
  const uc = deepOk ? usableCount(e.deep) : null
  const streak = Number(e.apiDownStreak) || 0
  const st = String(e.status || '')
  const probeBad = String((e.probe && e.probe.status) || '') === 'not_loadable'
  const tierRejected = String(e.validTier || '') === 'rejected'
  const hit = []
  if (uc !== null && uc >= 1) hit.push('K1')
  if (uc !== null && uc === 0 && streak < 10) hit.push('K2')
  // K3 收紧：必须「从没测过」的干净条目，排除实测加载失败与已判 rejected。
  // 再要求**有音源特征**（suspected=true，或状态为隔离区）——否则会把 `search`、
  // `app` 这种根本不是音源脚本的条目当成「该保留的真源」，gold 依据站不住：
  // 它们确实「没被判定死」，但那是因为压根没测，不代表它是音源。
  // 铁律：gold 的依据必须是「这条源实测能用/可能能用」，不是「没证据判它死」。
  const looksLikeSource = e.suspected === true || String(e.status) === 'quarantined'
  if (!deepOk && st !== 'dead' && !probeBad && !tierRejected && looksLikeSource) hit.push('K3')
  const risk = obfRisk(e)
  if (uc !== null && uc >= 1 && risk.length) hit.push('K4')
  if (!hit.length) return null
  const primary = hit.indexOf('K4') !== -1 ? 'K4' : hit[0]
  return { primary, secondary: hit.filter(x => x !== primary), risk }
}

const TIER_TEXT = {
  K1: '本机深度实测可用 >= 1 平台（prompt：可用>=1 或 usable=true 一律 keep，信号矛盾时以实测为准）',
  K2: '深度实测可用=0 但连续失效次数 < 10（prompt：<10 的即便可用=0 也一律 keep）',
  K3: '无深度实测且 status 非 dead（prompt：证据缺失/无实测且状态非 dead 一律 keep）',
  K4: '实测可用 >= 1 且带混淆特征——最容易被误判成 blacklist 的高危形态（prompt：以实测为准，不删）'
}

/** zone：有深检证据 → HARD，否则 GREY（与 gen-r7-samples 同口径） */
function zoneFor (rep) {
  return hasDeep(rep) ? 'HARD' : 'GREY'
}

/**
 * 生成 R7 keep 样本。
 * @param {object|Array} raw 库快照
 * @param {object} [opts] { now, perTier }
 * @returns {{cases:Array, stats:object, skipped:Array}}
 */
function genR7Keep (raw, opts) {
  const o = opts || {}
  const now = Number(o.now) || Date.now()
  const all = normSources(raw).filter(x => x && typeof x === 'object')
  // 只在**活跃**条目里找 keep 样本：已废弃条目要么是重复副本、要么是规则已判掉的，
  // 拿它当「该保留」的 gold 会和去重结论打架（同内容一条 keep 一条 blacklist）。
  const live = all.filter(e => !e.deprecated)

  const byHash = new Map()
  let noHash = 0
  for (const e of live) {
    if (!e.contentHash) { noHash++; continue }
    if (!byHash.has(e.contentHash)) byHash.set(e.contentHash, [])
    byHash.get(e.contentHash).push(e)
  }

  const stats = {
    liveEntries: live.length,
    noHashSkipped: noHash,
    groups: byHash.size,
    byTier: { K1: 0, K2: 0, K3: 0, K4: 0 },
    generated: 0,
    multiCopyGroups: 0,
    conflictDeepGroups: 0,
    usableDist: {},
    obfHighRisk: 0
  }
  const skipped = []
  const cases = []

  for (const [hash, g] of byHash) {
    const rep = pickKeepRepresentative(g)
    if (!rep) continue
    const cls = classifyKeep(rep)
    if (!cls) continue
    // 组内若有任一活跃副本满足 keep 依据，用该副本作代表（优先实测最好的那一份）
    const deep = hasDeep(rep) ? rep.deep : null
    const uc = deep ? usableCount(deep) : null

    const deepSig = new Set()
    for (const x of g) if (hasDeep(x)) deepSig.add(deepSummary(x.deep))
    if (g.length > 1) stats.multiCopyGroups++
    if (g.length > 1 && deepSig.size > 1) stats.conflictDeepGroups++

    const noteParts = []
    noteParts.push('gold 由规则推导（' + cls.primary + '），非人工盲标')
    if (cls.secondary.length) noteParts.push('同时满足 ' + cls.secondary.join('/'))
    if (uc !== null) noteParts.push('代表条目实测可用 ' + uc + ' 个平台')
    noteParts.push('连续失效次数 ' + (Number(rep.apiDownStreak) || 0))
    if (cls.risk && cls.risk.length) noteParts.push('混淆特征：' + cls.risk.join(' '))
    if (g.length > 1) {
      noteParts.push('同一内容共 ' + g.length + ' 个活跃副本')
      if (deepSig.size > 1) noteParts.push('副本深检结果有 ' + deepSig.size + ' 种，本样本取实测最好的那一份')
    }

    const criteria = '【' + cls.primary + '】' + TIER_TEXT[cls.primary] +
      (uc !== null ? '；本条实测 ' + deepSummary(deep) : '；本条无深度实测') +
      '。按「宁可漏判、绝不误伤」准则判 keep。'

    cases.push({
      id: 'r7k-' + hash.slice(0, 10),
      kind: 'R7',
      source: 'library-export',
      status: 'labeled',
      frozenAt: now,
      systemPrompt: null,
      input: buildInput(rep),
      expected: { verdict: 'keep', zone: zoneFor(rep), danger: 'D1', criteria },
      goldAct: 'keep',
      annotation: { annotator: 'rule-keep', at: now, blind: false, note: noteParts.join('；') },
      sensitivity: 'pii-free',
      // 评测侧统计用，不参与判定
      contentHash: hash,
      copies: g.length,
      deepVariants: deepSig.size,
      keepTier: cls.primary
    })
    stats.byTier[cls.primary]++
    if (cls.risk && cls.risk.length) stats.obfHighRisk++
    if (uc !== null) stats.usableDist[uc] = (stats.usableDist[uc] || 0) + 1
  }

  cases.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  stats.generated = cases.length
  return { cases, stats, skipped }
}

module.exports = { genR7Keep, classifyKeep, pickKeepRepresentative, obfRisk, hasDeep, TIER_TEXT }

if (require.main === module) {
  const src = process.argv[2]
  const dst = process.argv[3]
  if (!src) {
    console.error('用法: node tests/tools/gen-r7-keep-samples.js <库快照.json> [输出文件]')
    process.exit(2)
  }
  const raw = JSON.parse(fs.readFileSync(src, 'utf8'))
  const { cases, stats } = genR7Keep(raw)
  const outFile = dst || path.join(__dirname, '..', 'eval-cases', 'r7-keep-library.json')
  fs.writeFileSync(outFile, JSON.stringify({
    version: 1,
    note: 'R7 keep 样本：从真实库按 R7 prompt 的 keep 判据构造（K1 实测可用 / K2 刚失效 / K3 证据缺失 / K4 高危形态实测可用）。一个 contentHash 一条。gold 由规则推导（annotator=rule-keep），非人工盲标。input 已脱敏。',
    cases
  }, null, 1))
  console.log('生成 ' + cases.length + ' 条 → ' + outFile)
  console.log('统计: ' + JSON.stringify(stats))
}
