'use strict'
/**
 * 从音源库导出快照生成 R6 评测样本（**gold=reject 方向**，2026-11-19 B 批「补误放行样本」）
 *
 * === 为什么需要这个 ===
 * R6 是「混淆源信任放行」判定，放错=把混淆脚本放进库（不可逆）。它的评测缺口是：
 *
 *   | 组合                        | trust | reject |
 *   |-----------------------------|-------|--------|
 *   | 本机实测可用 >= 1            |  23   |   3    |
 *   | 实测可用 >= 1 **且带硬特征**  |   0   |   0    |  ← 整个格子是空的
 *
 * 第三行才是真正的危险格子：AI 可能因为「有实测可用」就判 trust，而忽略脚本里的
 * spin/eval/selfSched 硬特征。**这个组合此前一条样本都没有**，误放行方向等于没被测过。
 *
 * 试跑功能（v1.13.12 `probeQuarantined`）落地后，隔离区条目第一次能拿到实测 deep，
 * 「可用 >= 1」的人口会变大 ⇒ 上面那个空格子的风险显著上升。本工具把这一批补上。
 *
 * === gold=reject 的依据（全部来自 `aiReview.js` REVIEW_PROMPTS.R6.system 原文） ===
 *   P1 硬特征    门槛③「三项硬恶意特征 evalCalls/spinLoops/selfSchedCalls 全为 0」不满足
 *                → 无论实测多好都 reject。这是 prompt 明文的「缺一即 reject」。
 *   P2 域名可疑  「域名可疑是独立拒绝条件：……或堆叠多个（4 个及以上）非常规免费托管、
 *                动态解析域名 → reject」
 *                → 独立于三条门槛，四条门槛里最容易被忽略的一条。
 *
 * ★ 这两类**不是**「规则层会拦，所以 gold 存疑」的样本：
 *   规则层（classifyQuarantineTrust）与 AI 层（R6）是两套独立防线，评测测的是 AI 那一层。
 *   AI 判错就是 AI 判错，与规则拦不拦无关——P1 尤其如此，因为规则层有一条
 *   「实测可用 >= 1 永不吃 block」的硬规则（checker.js:1189），它和 R6 的门槛③
 *   直接冲突：同一个条目，规则说 risky 可放、AI 该说 reject。这个分叉正是要测的。
 *
 * === 铁律（与 gen-r7-keep-samples.js 一致） ===
 * 1. **一个 contentHash 只生成一个样本**：同内容多副本深检结果可能不同，逐条生成会造出
 *    「同内容相反 gold」的自相矛盾样本。
 * 2. `input` 严格脱敏：不含脚本正文、密钥、真实 URL；域名保留但只作为「可疑域名计数」的证据
 *    （R6 prompt 必须看到域名才能判断，脱敏成 [URL] 会让 P2 样本失效）。
 * 3. `annotation.blind=false` + `annotator=rule-reject`，如实注明「gold 由 prompt 门槛推导」。
 * 4. **不凑数**：快照里没有符合形态的真实条目就不生成，并在 stats 里报出来。
 *    宁可样本少、报「该形态 0 条」，也不要为了把指标做漂亮而放宽采集口径。
 *
 * === 用法 ===
 *   node tests/tools/gen-r6-reject-samples.js <库快照.json> [输出文件]
 */

const fs = require('fs')
const path = require('path')
const { scrubText, deepSummary, usableCount, obfHitsText, normSources } = require('./gen-r7-samples')

const hasDeep = (e) => !!(e && e.deep && e.deep.checkedAt && Object.keys((e.deep && e.deep.platforms) || {}).length)

/** 试跑产出的 deep 不能当正式证据（checker.isProbeOnlyDeep）。样本侧同样要排除。 */
const isProbeOnly = (e) => !!(e && e.deep && e.deep.probeOnly === true)

function hardHits (e) {
  const h = (e && e.obfHits) || {}
  return {
    spin: Number(h.spinLoops) || 0,
    evalN: Number(h.evalCalls) || 0,
    selfSched: Number(h.selfSchedCalls) || 0
  }
}

/**
 * 可疑外联域名（口径必须与 checker.obfDomainVerdict 完全一致，不能另立一套）。
 * 直接用真实实现而不是在这里重写一份白名单——两套口径迟早会漂移，
 * 那时样本的 gold 依据就与生产判据脱节了。
 */
function suspectDomains (e, cfg) {
  let ck
  try { ck = require('../../src/core/checker.js') } catch (err) { ck = null }
  if (!ck || typeof ck.obfDomainVerdict !== 'function') return []
  const toArr = v => (Array.isArray(v) ? v : (v ? [v] : []))
  try {
    const v = ck.obfDomainVerdict(
      toArr(e && e.obfDomains).concat(toArr(e && e.apiHosts)),
      (cfg && cfg.trustedObfDomains) || []
    )
    return (v && Array.isArray(v.suspect)) ? v.suspect : []
  } catch (err) { return [] }
}

/**
 * 判定一个条目属于哪一类 reject 依据。
 *
 * 前置条件（不满足就压根不进候选池）：
 *   - 非 deprecated（废弃条目是去重/规则已经处理掉的，拿它当评测样本会和去重结论打架）
 *   - 有**正式** deep（试跑产出 probeOnly 不算）—— 本批专门测「有实测可用时会不会误放行」，
 *     没有实测的条目归另一批，混进来会让 gold 依据变模糊
 *   - 实测可用 >= 1（这是危险格子的定义：实测说它能用，才谈得上「AI 因为能用就放行」）
 *   - obfLevel=high（R6 的适用前提：重度混淆脚本）
 *
 * @returns {{primary:string, secondary:string[], evidence:object}|null}
 */
function classifyReject (e, opts) {
  const o = opts || {}
  const h = hardHits(e)
  const uc = hasDeep(e) ? usableCount(e.deep) : 0
  const susp = suspectDomains(e, o.cfg)
  const tier = String(e.validTier || '')

  const hit = []
  // P1：三硬特征任一非 0 → R6 门槛③（全为 0）不满足。同时要求三条门槛里另外两条成立，
  // 这样「唯一不合格的就是硬特征」——gold=reject 的依据干净，不会和「无实测」纠缠。
  //
  // 注意这里**不要求**「域名也不可疑」。一开始写成 `susp.length < 4`，本意是让 P1 的依据
  // 单一化，结果把「硬特征 + 域名可疑」这种**两条独立理由都成立**的条目直接丢掉了
  // （classifyReject 返回 null），真实库里这类条目正是最该被拦的形态，白丢评测样本。
  // 现在改成：两条都成立时归 P1（硬特征是更强的理由），P2 记进 secondary 保留痕迹。
  const p1 = (h.spin + h.evalN + h.selfSched) > 0 && uc >= 1 && tier === 'confirmed'
  if (p1) hit.push('P1')
  // P2：域名可疑 >= 4 → 独立拒绝条件。要求三条客观门槛基本满足（层级+实测），
  // 使得「唯一该拒绝的理由是域名」——否则 AI 判 reject 可能出自别的原因，测不出域名规则。
  // 硬特征不为 0 时仍然记 P2，但只作 secondary（P1 已足以判 reject）。
  const p2 = susp.length >= 4 && uc >= 1 && tier === 'confirmed'
  if (p2) hit.push('P2')

  if (!hit.length) return null
  return {
    primary: hit[0],
    secondary: hit.slice(1),
    evidence: { ...h, usableN: uc, suspect: susp.length, tier, suspectList: susp }
  }
}

const TIER_TEXT = {
  P1: '本机实测可用>=1（门槛②满足）但带硬恶意特征（门槛③"evalCalls/spinLoops/selfSchedCalls 全为 0"不满足）→ 按 R6 prompt「三条门槛缺一即 reject」判 reject',
  P2: '本机实测可用>=1 且三条客观门槛均满足，但外联域名中非常规/动态解析域名 >= 4 个 → 按 R6 prompt「域名可疑是独立拒绝条件」判 reject'
}

/**
 * 生成 R6 reject 样本。
 * @param {object|Array} raw 库快照
 * @param {object} [opts] { now, cfg }
 * @returns {{cases:Array, stats:object}}
 */
function genR6Reject (raw, opts) {
  const o = opts || {}
  const now = Number(o.now) || Date.now()
  const all = normSources(raw).filter(x => x && typeof x === 'object')

  const stats = {
    total: all.length,
    liveHigh: 0,
    withFormalDeep: 0,
    usableGE1: 0,
    probeOnlySkipped: 0,
    byTier: { P1: 0, P2: 0 },
    generated: 0,
    // 「差点合格」的条目：让人看清为什么这条没生成，而不是只看到一个 0
    nearMiss: []
  }

  const pool = all.filter(e => !e.deprecated && String(e.obfLevel || '').toLowerCase() === 'high')
  stats.liveHigh = pool.length

  const byHash = new Map()
  let seq = 0
  for (const e of pool) {
    if (isProbeOnly(e)) { stats.probeOnlySkipped++; continue }
    if (!hasDeep(e)) continue
    stats.withFormalDeep++
    if (usableCount(e.deep) < 1) continue
    stats.usableGE1++
    // 一个 contentHash 一条；没有 contentHash 的用 id 兜底（快照里少数条目缺 hash）
    const key = String(e.contentHash || e.id || e.__k || ('nohash-' + (seq++)))
    if (!byHash.has(key)) byHash.set(key, [])
    byHash.get(key).push(e)
  }

  const cases = []
  for (const [hash, g] of byHash) {
    // 组内挑实测最好的一份作代表（同 R7 keep 的口径：证据最强的那个副本最能说明问题）
    const rep = g.slice().sort((x, y) => usableCount(y.deep) - usableCount(x.deep))[0]
    const cls = classifyReject(rep, { cfg: o.cfg })
    if (!cls) {
      const ev = { name: rep.name, usableN: usableCount(rep.deep), ...hardHits(rep), susp: suspectDomains(rep, o.cfg).length, tier: rep.validTier }
      stats.nearMiss.push(ev)
      continue
    }
    const ev = cls.evidence
    const noteParts = ['gold 由 prompt 门槛推导（' + cls.primary + '），非人工盲标']
    if (cls.secondary.length) noteParts.push('同时满足 ' + cls.secondary.join('/'))
    noteParts.push('实测可用 ' + ev.usableN + ' 个平台')
    noteParts.push('硬特征 spinLoops=' + ev.spin + '/evalCalls=' + ev.evalN + '/selfSchedCalls=' + ev.selfSched)
    noteParts.push('非常规外联域名 ' + ev.suspect + ' 个')
    if (g.length > 1) noteParts.push('同一内容共 ' + g.length + ' 个活跃副本')

    const criteria = '【' + cls.primary + '】' + TIER_TEXT[cls.primary] +
      '；本条实测 ' + deepSummary(rep.deep) +
      '，硬特征 spinLoops=' + ev.spin + '/evalCalls=' + ev.evalN + '/selfSchedCalls=' + ev.selfSched +
      '，非常规外联域名 ' + ev.suspect + ' 个（' + ev.suspectList.slice(0, 4).join('、') + '）。' +
      '判 reject 是拒绝放行，不是删除该脚本。'

    cases.push({
      id: 'r6r-' + hash.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 10),
      kind: 'R6',
      source: 'library-export',
      status: 'labeled',
      frozenAt: now,
      systemPrompt: null,
      input: buildInput(rep),
      // zone：本批全部证据齐全（validTier=confirmed + 正式深检），按标注指引「客观证据齐全 → HARD」
      // danger：D1 = 信任放行（不可逆动作），与评测层 isDangerStratum 的语义一致
      expected: { verdict: 'reject', zone: 'HARD', danger: 'D1', criteria },
      goldAct: 'reject',
      annotation: { annotator: 'rule-reject', at: now, blind: false, note: noteParts.join('；') },
      sensitivity: 'pii-free',
      // 评测侧统计用，不参与判定
      contentHash: String(hash),
      copies: g.length,
      rejectTier: cls.primary
    })
    stats.byTier[cls.primary]++
  }

  cases.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  stats.generated = cases.length
  return { cases, stats }
}

/**
 * 域名列表的脱敏口径（与 scrubList 不同，必须区别对待）。
 *
 * scrubList 会把整个主机名替换成 `[HOST]`——R7 的删源判定不看域名，那样做没问题；
 * **但 R6 的「域名可疑是独立拒绝条件」完全依赖域名本身**。实测踩到过这个坑：
 * 第一版样本 9 个域名全变成 `[HOST]`、`[HOST]`……，模型既看不出个数是否 >= 4，
 * 也看不出它们是不是动态解析/免费托管域名，P2 样本直接退化成一条「无域名信息的
 * 可用源」，gold=reject 变得毫无依据。
 *
 * 所以这里保留**主机名**（只去掉协议、端口、路径、查询串），因为：
 *   - 主机名是公开的外联接口地址，不含密钥/凭据；
 *   - 域名形态（dpdns.org / *.top / 裸 IP）本身就是判定所依据的特征。
 * 路径与查询串一律砍掉：那里面才可能出现 token / 私有仓库结构。
 */
function keepHosts (arr) {
  const out = []
  for (const raw of (Array.isArray(arr) ? arr : [])) {
    let h = String(raw == null ? '' : raw).trim().toLowerCase()
    if (!h) continue
    h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')    // 去协议
    h = h.replace(/\/.*$/, '')                       // 去路径/查询串
    h = h.replace(/:\d+$/, '')                       // 去端口
    h = h.replace(/^www\./, '')                      // www 前缀归一，避免重复计数
    if (!h) continue
    if (out.indexOf(h) === -1) out.push(h)
  }
  return out
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
    // 域名保留主机名（见 keepHosts 注释）：R6 的「域名可疑」判据必须看到真实域名。
    // 只砍协议/端口/路径/查询串，保留主机名本身。
    obfDomains: keepHosts(e.obfDomains),
    apiHosts: keepHosts(e.apiHosts),
    apiDownStreak: Number(e.apiDownStreak) || 0,
    suspected: e.suspected === true ? true : (e.suspected === false ? false : null),
    usable: e.usable === true,
    // 本批的核心：带**正式** deep（非 probeOnly）。字符串格式保留「平台数N 可用M 失败K」，
    // 与 R6 buildText 的 deepSummaryText 解析口径一致。
    deep: deepSummary(deep)
  }
  return inp
}

module.exports = { genR6Reject, classifyReject, hardHits, suspectDomains, hasDeep, isProbeOnly, keepHosts, TIER_TEXT }

if (require.main === module) {
  const src = process.argv[2]
  const dst = process.argv[3]
  if (!src) {
    console.error('用法: node tests/tools/gen-r6-reject-samples.js <库快照.json> [输出文件]')
    process.exit(2)
  }
  const raw = JSON.parse(fs.readFileSync(src, 'utf8'))
  const { cases, stats } = genR6Reject(raw)
  const outFile = dst || path.join(__dirname, '..', 'eval-cases', 'r6-reject-library.json')
  fs.writeFileSync(outFile, JSON.stringify({
    version: 1,
    note: 'R6 reject 样本（补「误放行」观测缺口）：从真实库按 R6 prompt 的拒绝条件构造。P1=实测可用>=1 但带硬恶意特征（门槛③不满足）；P2=实测可用>=1 但非常规外联域名>=4（域名独立拒绝条件）。一个 contentHash 一条。gold 由规则推导（annotator=rule-reject），非人工盲标。input 已脱敏（域名保留，R6 需据此判断）。',
    cases
  }, null, 1))
  console.log('生成 ' + cases.length + ' 条 → ' + outFile)
  console.log('统计: ' + JSON.stringify(stats, null, 1))
}
