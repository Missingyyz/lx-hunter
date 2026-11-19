'use strict'
/**
 * 从音源库导出快照生成 R7 评测样本（B 批，2026-11-19）
 *
 * 背景：评测台子原来只有 4 条合成样本，230 条起步批次也远不够门槛。
 * 用户要求「改成 lunter 采集到的所有音源脚本起步」，本文具兑现这件事。
 *
 * === 铁律（违反会污染评测，改前必读） ===
 * 1. **一个 contentHash 只生成一个样本**。库里有大量同内容副本（`星海音乐源` 一个名字
 *    49 条），每条副本各记一次自己的深检结果，同一份脚本能测出 0/5、2/5、3/5。
 *    若按条目逐条生成，会产生「同一内容、相反 gold」的自相矛盾样本，把评测直接毒死。
 * 2. `input` 严格脱敏：**绝不含脚本正文**、不含密钥、真实域名改 `[URL]`、路径改 `[PATH]`。
 *    脚本正文只在本进程内参与判据（如下面用 deep.hash 判同内容），绝不写进样本。
 * 3. `annotation.blind=false` + `annotator` 如实写 `rule-dedup`/`rule-dead`——
 *    这批 gold 是**规则推导**，不是人工盲标，冒充盲标会让后续复核失去意义。
 * 4. 不改已有样本文件，只新增。
 *
 * === 用法 ===
 *   node tests/tools/gen-r7-samples.js <库快照.json> [输出文件]
 * 库快照接受三种形态：
 *   - store.dd 格式：`{ sources: { id: entry } }`
 *   - 数组：`[entry, entry, ...]`
 *   - 导出包：`{ sources: [entry, ...] }`
 */

const fs = require('fs')
const path = require('path')

// ---------- 脱敏 ----------

/** 真实域名 → [URL]。保留明显的占位/无效域名，便于阅读又不泄露真实外联。 */
const HOST_RE = /\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|cn|net|org|io|xyz|top|vip|cc|me|tv|info|site|online|club|shop|app|dev|link|pro|pw|tk|ml|ga|cf|us|uk|de|jp|hk|tw|ru|in|co|so|ws|bz|la|life|fun|space|store|tech|world|today|host|press|icu|art|best|cloud|one|moe|wiki|zone|asia|mobi|name|pro|red|run|sbs|surf|uno|wtf))\b/gi
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const PATH_RE = /[A-Za-z]:\\[^\s"',;]*|\/(?:home|root|var|tmp|app|opt|usr|etc)\/[^\s"',;]*/g
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const TG_RE = /(?:t\.me|telegram\.me)\/[^\s"',;]*/gi

function scrubText (s) {
  if (s == null) return ''
  let t = String(s)
  // 顺序要紧：**先整段吃掉 URL**，再处理裸域名。
  // 反过来会把 `https://a.com/x/y.js` 先变成 `[HOST]/x/y.js`——域名没了但路径还在，
  // 而路径同样可能泄露私有仓库结构（自测抓到过这个漏）。
  t = t.replace(/\bhttps?:\/\/[^\s"',;)）]+/gi, '[URL]')
  t = t.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"',;)）]+/gi, '[URL]')   // 其它协议（ws/ftp…）
  t = t.replace(/\bwww\.[^\s"',;)）]+/gi, '[URL]')
  t = t.replace(TG_RE, '[URL]')
  t = t.replace(EMAIL_RE, '[EMAIL]')
  t = t.replace(UUID_RE, '[ID]')
  t = t.replace(IPV4_RE, '[HOST]')
  t = t.replace(HOST_RE, '[HOST]')
  t = t.replace(PATH_RE, '[PATH]')
  // 兜底：残留的裸路径片段（形如 /x/y.js），避免仓库内部结构外泄
  t = t.replace(/\/(?:[\w.-]+\/)+[\w.-]*/g, '[PATH]')
  return t
}

function scrubList (arr) {
  return (Array.isArray(arr) ? arr : []).map(x => scrubText(x)).filter(Boolean)
}

// ---------- deep 摘要（照 REVIEW_PROMPTS.R7.buildText 的口径） ----------

function usableCount (deep) {
  const p = (deep && deep.platforms) || {}
  let n = 0
  for (const k of Object.keys(p)) if (p[k] && p[k].status === 'usable') n++
  return n
}

/**
 * 把 deep 压成 `平台数=N 可用=M 失败=K` 这样的摘要串。
 * 与 aiReview.js 的 deepSummaryText 口径保持一致（R7 prompt 按这个正则读平台数/可用/失败）。
 */
function deepSummary (deep) {
  if (!deep || typeof deep !== 'object' || !deep.checkedAt) return ''
  const p = deep.platforms || {}
  const keys = Object.keys(p)
  if (!keys.length) return ''
  let usable = 0; let failed = 0; let untested = 0
  for (const k of keys) {
    const o = p[k] || {}
    const st = String(o.status || '')
    if (st === 'usable' || st === 'ok' || st === 'passed' || o.ok === true) usable++
    else if (st === 'failed') failed++
    else if (st === 'untested' || st === 'pending') untested++
  }
  let s = '平台数=' + keys.length + ' 可用=' + usable + ' 失败=' + failed
  if (untested) s += ' 未测=' + untested
  if (deep.loadable === false) s += '，脚本不可加载'
  return s
}

/** obfHits 压成一行摘要（字段名照既有样本的写法）。 */
function obfHitsText (h) {
  const o = h || {}
  const f = ['evalCalls', 'total0x', 'totalUni', 'totalExotic', 'spinLoops', 'selfSchedCalls', 'jsjiamiMarks', 'perKbExotic']
  return f.map(k => k + '=' + (o[k] == null ? 0 : o[k])).join(' ')
}

// ---------- 同 hash 分组 ----------

function normSources (raw) {
  const j = raw
  if (Array.isArray(j)) return j
  if (j && Array.isArray(j.sources)) return j.sources
  if (j && j.sources && typeof j.sources === 'object') return Object.keys(j.sources).map(k => j.sources[k])
  return []
}

/**
 * 一个 hash 组里选代表。
 *   ① 有深检的优先（没实测证据的条目不能代表这组内容的可用性）
 *   ② 深检可用平台**少**的优先（gold 是「该删」，可用少更贴合结论）
 *   ③ lastCheck 最新优先（同一份脚本多副本会测出不同结果，取最新一次）
 *   ④ 仍平手时按 id 稳定排序（保证同一份库多次生成结果一致，便于复现）
 */
function pickRepresentative (group) {
  const score = e => {
    const deep = (e.deep && e.deep.checkedAt) ? e.deep : null
    return {
      hasDeep: deep ? 1 : 0,
      usable: deep ? usableCount(deep) : 999,
      lastCheck: Number(e.lastCheck) || Number(deep && deep.checkedAt) || Number(e.addedAt) || 0,
      id: String(e.id || '')
    }
  }
  const arr = group.slice().sort((x, y) => {
    const a = score(x); const b = score(y)
    if (a.hasDeep !== b.hasDeep) return b.hasDeep - a.hasDeep
    if (a.usable !== b.usable) return a.usable - b.usable
    if (a.lastCheck !== b.lastCheck) return b.lastCheck - a.lastCheck
    return a.id.localeCompare(b.id)
  })
  return arr[0]
}

/**
 * 该组能否作为 HARD 证据。
 *
 * HARD 的语义（evalSnapshot.js:149）是「两侧深检过 + 版本可比 + 无仅声明值 + 有 H 码」，
 * 核心是**有实测证据**。而「同内容重复」这个事实只说明库里有多份一样的脚本，
 * **完全不能说明这条源能不能用**——把无深检的重复条目标 HARD 会让 HARD 层
 * 的不干涉率门槛（0.99）变成瞎猜也能过，直接污染评测。
 *
 * 所以：只有代表条目**有深检数据**时才给 HARD，否则退回 GREY（证据不足）。
 */
function zoneFor (rep, fromDead) {
  const deep = rep && rep.deep && rep.deep.checkedAt ? rep.deep : null
  if (deep && Object.keys(deep.platforms || {}).length) return 'HARD'
  return 'GREY'
}

function buildInput (e) {
  const deep = (e.deep && typeof e.deep === 'object') ? e.deep : null
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
  // installed：R7 prompt 用它决定「只禁不删」的措辞，必须如实给
  inp.installed = !!(e.scriptName || (Array.isArray(e.apiHosts) && e.apiHosts.length) || inp.deep || e.validTier)
  return inp
}

/**
 * 生成 R7 样本。
 * @param {object|Array} raw 库快照
 * @param {object} [opts] { now }
 * @returns {{cases:Array, stats:object, excluded:Array}}
 */
function genR7 (raw, opts) {
  const o = opts || {}
  const now = Number(o.now) || Date.now()
  const all = normSources(raw).filter(x => x && typeof x === 'object')

  const stats = {
    total: all.length,
    withHash: 0,
    noHash: 0,
    dupContentEntries: 0,
    deadAliveEntries: 0,
    groupsDup: 0,
    groupsDead: 0,
    groupsBoth: 0,
    generated: 0,
    pseudoDupExcluded: 0,
    multiCopyGroups: 0,
    conflictDeepGroups: 0
  }
  const excluded = []
  const cases = []

  // ---- 分组：以 contentHash 为唯一身份 ----
  const byHash = new Map()
  const noHashEntries = []
  for (const e of all) {
    const h = e.contentHash
    if (!h) { stats.noHash++; noHashEntries.push(e); continue }
    stats.withHash++
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h).push(e)
  }

  // ---- 来源1：同内容重复（组内除保留项外，还有 deprecated 副本） ----
  const dupGroups = new Map()   // hash -> entries（全部副本）
  for (const [h, g] of byHash) {
    const dupCopies = g.filter(x => x.deprecated && String(x.dupReason || '').indexOf('同内容重复') !== -1)
    if (!dupCopies.length) continue
    stats.dupContentEntries += dupCopies.length
    dupGroups.set(h, g)
  }
  stats.groupsDup = dupGroups.size

  // 伪重复：组内仅 1 条，不满足「同内容有多份」的前提，不能当删源依据
  for (const [h, g] of dupGroups) {
    if (g.length < 2) {
      stats.pseudoDupExcluded++
      excluded.push({ hash: h, reason: '伪重复（该 hash 全库唯一，不满足同内容前提）', name: g[0] && g[0].name })
      dupGroups.delete(h)
    }
  }

  // ---- 来源2：存活池失效源（全平台 0 可用 + 有深检） ----
  const deadGroups = new Map()
  for (const [h, g] of byHash) {
    const alive = g.filter(x => !x.deprecated)
    for (const e of alive) {
      const deep = e.deep && e.deep.checkedAt ? e.deep : null
      if (!deep) continue
      const plats = Object.keys(deep.platforms || {})
      if (!plats.length) continue
      if (usableCount(deep) !== 0) continue
      stats.deadAliveEntries++
      deadGroups.set(h, g)
      break
    }
  }
  stats.groupsDead = deadGroups.size

  // ---- 合并：重叠的优先当来源2（失效源有更直接的规则依据） ----
  const keys = new Set([...deadGroups.keys(), ...dupGroups.keys()])
  for (const h of keys) {
    const g = byHash.get(h) || []
    const fromDead = deadGroups.has(h)
    const fromDup = dupGroups.has(h)
    if (fromDead && fromDup) stats.groupsBoth++
    const rep = pickRepresentative(g)
    if (!rep) continue

    const deep = rep.deep && rep.deep.checkedAt ? rep.deep : null
    const usable = deep ? usableCount(deep) : null
    // 该组副本深检结果有几种（用于诚实记录"同一内容测出不同结果"）
    const deepSig = new Set()
    for (const x of g) {
      const d = x.deep && x.deep.checkedAt ? x.deep : null
      if (!d) continue
      deepSig.add(deepSummary(d))
    }
    if (g.length > 1) stats.multiCopyGroups++
    if (g.length > 1 && deepSig.size > 1) stats.conflictDeepGroups++

    const kindSrc = fromDead ? 'rule-dead' : 'rule-dedup'
    // zone 由**证据**决定，不由图省事：有深检才 HARD，否则 GREY（见 zoneFor 注释）。
    const zone = zoneFor(rep)
    const criteria = fromDead
      ? '本机深度实测全平台 0 可用（' + (deepSummary(deep) || '无实测') + '），属规则可铁判的失效源，判 blacklist。'
      : (zone === 'HARD'
          ? '与库内其它条目内容完全相同（同 contentHash）且有深检证据（' + (deepSummary(deep) || '') + '），业务上删任意一份无损失，判 blacklist。'
          : '与库内其它条目内容完全相同（同 contentHash），业务上删任意一份无损失，判 blacklist；但该条目本身无深检证据，故 zone=GREY。')
    const noteParts = []
    if (fromDead && fromDup) noteParts.push('同时命中「同内容重复」与「存活池全平台0可用」')
    if (g.length > 1) {
      noteParts.push('同一内容共 ' + g.length + ' 个副本')
      if (deepSig.size > 1) {
        noteParts.push('副本深检结果有 ' + deepSig.size + ' 种（' + [...deepSig].join(' / ') + '），本样本取最新一次检测')
      } else if (deepSig.size === 1) {
        noteParts.push('副本深检结果一致')
      }
    }
    if (usable != null) noteParts.push('代表条目实测可用 ' + usable + ' 个平台')
    noteParts.push('gold 由规则推导，非人工盲标')

    cases.push({
      id: 'r7b-' + h.slice(0, 10),
      kind: 'R7',
      source: 'library-export',
      status: 'labeled',
      frozenAt: now,
      systemPrompt: null,
      input: buildInput(rep),
      expected: { verdict: 'blacklist', zone, danger: 'D1', criteria },
      goldAct: 'blacklist',
      annotation: {
        annotator: kindSrc,
        at: now,
        blind: false,
        note: noteParts.join('；')
      },
      sensitivity: 'pii-free',
      // 评测侧统计用，不参与判定
      contentHash: h,
      copies: g.length,
      deepVariants: deepSig.size
    })
  }

  stats.generated = cases.length
  cases.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return { cases, stats, excluded, noHashEntries: noHashEntries.length }
}

module.exports = { genR7, scrubText, scrubList, deepSummary, usableCount, obfHitsText, pickRepresentative, zoneFor, normSources }

// ---------- CLI ----------
if (require.main === module) {
  const src = process.argv[2]
  const dst = process.argv[3]
  if (!src) {
    console.error('用法: node tests/tools/gen-r7-samples.js <库快照.json> [输出文件]')
    process.exit(2)
  }
  const raw = JSON.parse(fs.readFileSync(src, 'utf8'))
  const { cases, stats, excluded } = genR7(raw)
  const outFile = dst || path.join(__dirname, '..', 'eval-cases', 'r7-library.json')
  const payload = {
    version: 1,
    note: 'R7 样本：从音源库导出快照按 contentHash 去重生成，一个内容一条。gold 由规则推导（rule-dedup/rule-dead），非人工盲标。input 已脱敏。',
    cases
  }
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 1))
  console.log('生成 ' + cases.length + ' 条 → ' + outFile)
  console.log('统计: ' + JSON.stringify(stats))
  if (excluded.length) console.log('排除伪重复 ' + excluded.length + ' 组: ' + excluded.map(x => x.name).join(', '))
}
