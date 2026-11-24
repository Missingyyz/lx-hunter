'use strict'
/**
 * 恶意源治理 + Q3 404 分类收敛的**单一真值来源**（2026-11-23，8197 测试版）
 *
 * 设计原则（用户 2026-11-23 拍板）：
 *  - 强混淆恶意脚本（独家音源 v5/v6/v7）能被 hunter 静态评分误判 suspected=false，
 *    "能下载、有 @name、能出链"都不是安全证据。因此按**内容指纹（sha256）**硬拦截，
 *    而不是按名字 / suspected / README 推荐顺序。
 *  - 第三方仓库 szyshr199312/lx-source 以"上游删了我还留着"为设计目标，留存已实锤恶意的
 *    lx/latest.js，0 issue / 1 star、无安全维护 → 整仓拉黑（复用 config.blockedRepos 语义）。
 *  - 调用同一恶意 API 域名（88.lxmusic.xn--fiqs8s）的 allinone×2 / jiexiang/latest 标记"存疑待人工"，
 *    不自动灌入；但不等于判死（保留人工复核空间）。
 *  - Q3：单候选 404 不再短路整条镜像链。**全候选都 404/410** 才收敛成 all-404/gone，
 *    下游判 dead；REDIRECT_BLOCKED 整链终止由 net.js 原位保留，不在这里处理。
 *
 * 全部是纯函数 / 常量，不读写文件、不发请求、不 require 音源脚本；便于单测与回放。
 */

// 已实锤恶意的独家音源家族内容指纹（sha256，小写；上游 pdone issue #16 + 作者复现确认）
const MALICIOUS_HASHES = Object.freeze([
  '79a5c4703e060eaff6f8ffaac05d2fadf5e22b7729f6fe151d1cca2fa3935171', // v7 / latest.js（已证实关机脚本）
  '65ae85f557e8f616d7f2a2446fe59078dee34c825bd766aa5b059b6255697c57', // v5 / 5.js
  'ef5289ddc2e8fd98ec7ac9e096878d9e6fed5e4ae1669d21e4484eac247aeda7'  // v6 / 6.js
])

// 整仓拉黑：以"保留上游已删内容"为目标、留存实锤恶意脚本、无安全维护能力
const MALICIOUS_REPOS = Object.freeze(['szyshr199312/lx-source'])

// ============================================================================
// 静态情报（2026-11-24）：恶意 API 域名 IOC —— 【观察模式】
// 恶意 v7（79a5c470）与 65ae85f5/ef5289dd 等共用同一 API 服务端/签名体系，
// 域名 88.lxmusic.xn--fiqs8s（punycode）= 88.lxmusic.中国（unicode）。
// 归一化：punycode + unicode + 大小写 + 尾部点 + 可选 www，统一到一个规范键。
// 【红线】观察模式只产出审计信号，绝不改判定/usable/suspected/灌入——现有消费方不读它 ⇒ 零倒退。
// 归一化列表集中管理，观察期结束若决定升级硬拦截，只改 matchDomainIoc 的调用方，不动判据。
// ============================================================================
const MALICIOUS_API_DOMAINS = Object.freeze([
  '88.lxmusic.xn--fiqs8s',   // punycode（脚本里实际出现的写法）
  '88.lxmusic.中国'           // unicode 等价写法
])
function normDomain(s) {
  let d = lower(s).trim().replace(/\.$/, '')
  if (d.startsWith('www.')) d = d.slice(4)
  // URL 形态输入时取 hostname
  if (d.indexOf('://') >= 0) {
    try { d = String(new URL(d).hostname).toLowerCase().replace(/\.$/, '') } catch (_) {}
  }
  return d
}
const MALICIOUS_API_DOMAIN_KEYS = Object.freeze(MALICIOUS_API_DOMAINS.map(normDomain))
/** 观察模式：从脚本文本 / URL 列表里找命中恶意 API 域名的规范键（去重，只读）。不改任何判定。 */
function matchDomainIoc(codeOrText, urls) {
  const hits = new Set()
  const scan = (s) => {
    if (!s) return
    const str = String(s)
    for (const k of MALICIOUS_API_DOMAIN_KEYS) {
      if (str.indexOf(k) >= 0) hits.add(k)
    }
  }
  scan(codeOrText)
  for (const u of (Array.isArray(urls) ? urls : [])) scan(u)
  return Array.from(hits)
}

// 存疑源：调用恶意 API 域名 88.lxmusic.xn--fiqs8s，待人工复核，不自动灌入
// 按 path 后缀匹配（跨镜像生效）；这是"存疑隔离观察"不是判死——只挡自动灌入，人工确认后可放行。
const SUSPECT_SOURCE_PATHS = Object.freeze([
  'allinone/latest.js', 'allinone/lite.js', 'jiexiang/latest.js'
])

function lower(s) { return String(s == null ? '' : s).toLowerCase() }

function normRepoKey(s) {
  // 与 crawler.normalizeRepo 同口径：去首尾空白 / 尾部 .git / 前导 github.com/
  let r = lower(s).trim().replace(/\/+$/, '').replace(/\.git$/, '')
  r = r.replace(/^https?:\/\//, '').replace(/^github\.com\//, '')
  return r
}

/** 命中恶意内容指纹（精确 sha256，大小写不敏感） */
function isMaliciousHash(hash) {
  if (!hash) return false
  const h = lower(hash).trim()
  return MALICIOUS_HASHES.indexOf(h) >= 0
}

/** 命中整仓拉黑名单 */
function isBlockedRepo(repo) {
  if (!repo) return false
  const r = normRepoKey(repo)
  if (!r) return false
  return MALICIOUS_REPOS.some(x => normRepoKey(x) === r)
}

/** 存疑源路径命中（path 后缀归一，跨镜像；不按名字，避免误伤同名正常源） */
function isSuspectSource(e) {
  if (!e || typeof e !== 'object') return false
  const p = lower(e.path || '')
  if (!p) return false
  return SUSPECT_SOURCE_PATHS.some(s => p === s || p.endsWith('/' + s))
}

/**
 * 灌入前的安全闸门：恶意 hash / 整仓拉黑 / 存疑源，任一命中即拒绝自动灌入。
 * @returns {{blocked:boolean, reason:string, kind:string}} reason 可直接进日志 / 界面。
 */
function guardImport(e) {
  if (!e || typeof e !== 'object') return { blocked: false, reason: '', kind: '' }
  if (isMaliciousHash(e.contentHash)) {
    return { blocked: true, kind: 'malicious-hash', reason: '命中恶意脚本指纹黑名单（独家音源家族，已证实含关机代码）' }
  }
  if (isBlockedRepo(e.repo || (e.url || ''))) {
    return { blocked: true, kind: 'blocked-repo', reason: '来源仓库已整体拉黑（szyshr199312/lx-source：留存上游已删恶意脚本）' }
  }
  if (isSuspectSource(e)) {
    return { blocked: true, kind: 'suspect-source', reason: '存疑源（调用已知恶意 API 域名），待人工复核，不自动灌入' }
  }
  return { blocked: false, reason: '', kind: '' }
}

/** 批量：把候选分成 {keep, blocked}，供灌入队列前置过滤 */
function filterImportCandidates(entries) {
  const keep = [], blocked = []
  for (const e of entries || []) {
    const g = guardImport(e)
    if (g.blocked) blocked.push({ entry: e, reason: g.reason, kind: g.kind })
    else keep.push(e)
  }
  return { keep, blocked }
}

/**
 * Q3 404 收敛：判断一次 crawlFetch 的 attempts 是否"全候选 404/410"。
 * 只在 net.js 已跑完整条候选链、且没有任何 2xx / 其它状态时返回 true。
 */
function allGone(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return false
  return attempts.every(a => a && (a.status === 404 || a.status === 410))
}

/** 区分"源站 404（带 x-github-request-id）"与"代理/镜像 404"，供 dead 文案与治理统计 */
function goneKind(res) {
  if (!res) return 'unreachable'
  const h = res.headers
  let src = false
  try {
    if (h && typeof h.get === 'function' && h.get('x-github-request-id')) src = true
  } catch (_) {}
  return src ? 'origin-404' : (res.status === 410 ? 'gone' : 'proxy-404')
}

module.exports = {
  MALICIOUS_HASHES, MALICIOUS_REPOS, SUSPECT_SOURCE_PATHS,
  MALICIOUS_API_DOMAINS, MALICIOUS_API_DOMAIN_KEYS, normDomain, matchDomainIoc,
  isMaliciousHash, isBlockedRepo, isSuspectSource,
  guardImport, filterImportCandidates, allGone, goneKind
}
