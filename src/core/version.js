'use strict'
/**
 * 统一版本号算法（2026-11-10，P-1396 科学复核 / 用户 21:01 拍板「统一版本算法」；
 * 2026-11-22 增补预发布序）
 *
 * 历史问题：hunter.js 与 crawler.js 各有一份 `v = v * 1000 + part`（最多 4 段），
 * sourceUpdate.js 上一轮已单独改成零填充键 —— 三套口径并存，实测：
 *   - 1.0.0.1000 == 1.0.1.0（段值 >= 1000 与相邻段碰撞）
 *   - 1.2.3.4.5  == 1.2.3.4（第 5 段被丢弃）
 *   - v1.9.9 (1009000) > v2.0 (2000000)? 否 → 只收最新版把 v2.0 丢了，留了 v1.9.9
 *
 * 现在统一为「逐段零填充字符串键」：
 *   - 每段固定 8 位，最少补齐 4 段；字典序即版本序，任意段数都不丢信息
 *   - 无版本号返回 ''（falsy），调用点 `if (!v)` / `||` 兜底语义保持不变
 *   - 需要比大小时一律用 cmpVersion()，不要对返回值做减法（字符串相减得 NaN）
 *
 * 2026-11-22 预发布序：9.1.5-r1 < 9.1.5 < 9.1.6，r1 < r2。
 *   - 正则非锚定保持不变（「名字里嵌版本」的既有行为被测试锁定，见
 *     tests/latest-only.test.js:9 与 tests/private-import-2026-11-11.test.js:151）。
 *   - 预发布只在「核心版本号相同」时参与比较：核心不同仍按核心版本裁决。
 *   - 预发布后缀形态：-rN / -betaN / -testN / -rcN / -alphaN（大小写不敏感），
 *     以及 (test)/(beta) 等括号后缀。
 */
const MIN_SEGMENTS = 4
const SEG_WIDTH = 8
const ZERO_SEG = '0'.repeat(SEG_WIDTH)
const VER_RE = /[vV]?(\d+(?:\.\d+)+)/
// 预发布后缀：-r1 / -r2 / -beta / -beta2 / -test / -rc1 / (test) 等
const PRE_RE = /[-_ ]?(?:rc|beta|alpha|preview|pre|test|r)(\d*)\b|\((?:test|beta|rc|alpha|preview|pre)\)/i

/** 版本字符串 → 可字典序比较的规范化键；解析不出返回 '' */
function versionKey(s) {
  const m = String(s == null ? '' : s).match(VER_RE)
  if (!m) return ''
  const parts = m[1].split('.').map(p => {
    const n = parseInt(p, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
  while (parts.length < MIN_SEGMENTS) parts.push(0)
  return parts.map(n => String(n).padStart(SEG_WIDTH, '0')).join('.')
}

/** 取预发布序号：正式版返回 -1；无预发布标记返回 -1（与正式版同序）；
 *  正式版返回 STABLE_RANK(999999)；预发布 -rN→N、-r1→1、-r2→2，
 *  无数字的 -test/-beta→0。仅当核心版本键相同时才用。 */
const STABLE_RANK = 999999
function preRank(s) {
  const raw = String(s == null ? '' : s)
  const m = raw.match(PRE_RE)
  if (!m) return STABLE_RANK
  if (m[1]) return parseInt(m[1], 10) || 0
  return 0
}

/** 比较任意两个版本串：a>b 返回 1，a<b 返回 -1，相等/都无版本返回 0。
 *  无版本一律视为「比任何有版本的都旧」，且两个都无版本视为平手（不猜）。
 *  核心版本相同时用预发布序：正式版 > rN；r 数字越大越新。 */
function cmpVersion(a, b) {
  const ka = versionKey(a), kb = versionKey(b)
  if (!ka || !kb) return !ka && !kb ? 0 : (ka ? 1 : -1)
  const pa = ka.split('.'), pb = kb.split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] || ZERO_SEG, y = pb[i] || ZERO_SEG
    if (x !== y) return x > y ? 1 : -1
  }
  // 核心版本相同 → 预发布序（正式版 > 任何预发布；rN 数字越大越新）
  const ra = preRank(a), rb = preRank(b)
  if (ra !== rb) return ra > rb ? 1 : -1
  return 0
}

/**
 * 取版本串里那段版本号本身，用于**文案展示**（2026-11-11）。
 *
 * 起因：版本取值改成「@version 优先、名字兜底」后，兜底拿到的是整串名字
 * （如「LXHE2E 测试源 v1.0.0」），直接拼进理由就成了
 * 「v1.1.0 ≥ LXHE2E 测试源 v1.0.0」这种前后不一致的句子。
 * 比较仍用原串（versionKey 本来就是整串 match，取子串结果一致），只有显示要短。
 * 解析不出就原样返回 —— 那种情况调用点一般进不到版本文案分支。
 *
 * 2026-11-22：保留「取第一处版本号」的非锚定语义（测试锁定）；预发布后缀
 * 是否带出由调用点决定，这里仍只返回核心版本号，避免破坏既文案断言。
 */
function verLabel(s) {
  const raw = String(s == null ? '' : s)
  const m = raw.match(VER_RE)
  return m ? m[0] : raw
}

module.exports = { versionKey, cmpVersion, verLabel, preRank, STABLE_RANK, MIN_SEGMENTS, SEG_WIDTH }
