'use strict'
/**
 * 沙箱出站策略（v1.13.14）：私网/回环**硬阻断** + 域名**审计不阻断**。
 *
 * ============================================================================
 * 为什么白名单不阻断（曾计划做「只允许已知域名」，已否决）
 * ============================================================================
 * 拿生产库 1713 条真实音源统计，有域名记录的 1179 条里唯一域名 239 个，
 * 其中约 150 个是「第三方聚合站」（music-api.gdstudio.xyz、oiapi.net、
 * *.dpdns.org 这类），**换域名是常态**。
 *
 * 阻断型白名单的失败模式太差：脚本换域名后请求被拒，表现为「音源坏了」——
 * 用户看到的是功能故障，不是安全提示，而且**静默**、不可归因。
 * 所以要的是「审计」：照常放行，但把要去哪告诉上层，由它标记给用户看。
 *
 * ============================================================================
 * 为什么私网/回环要硬阻断
 * ============================================================================
 * 生产库 apiHosts 字段里真的出现过 127.0.0.1。容器内跑的音源脚本若能访问
 * 回环/私网，就能打本机其它服务（反向代理、内部 API、侧车容器）——
 * 那是「从沙箱里往外打内网」，与音源取链完全无关的正常需求。
 * 而且这个列表是**封闭**的：IP 段不会变，零维护。
 */

/**
 * 硬阻断的私网/回环地址（IPv4 + IPv6）。
 *
 * 判据一律「解析出的 hostname」而非原始 URL 字符串：
 * 否则 `http://127.0.0.1`、`http://127.1`、`http://0x7f.0.0.1` 这些等价写法会绕过。
 * 注意 `127.1` 与 `0x7f000001` 会被 URL 规整成 127.0.0.1/127.0.0.1，
 * 但为了稳，这里仍然把常见简写一并匹配。
 */
const BLOCKED_HOST_PATTERNS = [
  // IPv4 回环 127.0.0.0/8
  { re: /^127\./, why: 'IPv4 回环地址' },
  // IPv4 私网 10.0.0.0/8
  { re: /^10\./, why: 'IPv4 私网地址（10/8）' },
  // IPv4 私网 172.16.0.0/12
  { re: /^172\.(1[6-9]|2\d|3[01])\./, why: 'IPv4 私网地址（172.16/12）' },
  // IPv4 私网 192.168.0.0/16
  { re: /^192\.168\./, why: 'IPv4 私网地址（192.168/16）' },
  // 链路本地 169.254.0.0/16（含云厂商元数据 169.254.169.254）
  { re: /^169\.254\./, why: '链路本地地址（含云元数据 169.254.169.254）' },
  // 0.0.0.0/8 与 "0"：部分系统把 0.0.0.0 当本机
  { re: /^0\./, why: '本机地址（0/8）' },
  // 主机名形式的回环
  { re: /^localhost$/, why: '本机主机名' },
  // *.localhost：RFC 6761 规定整个 .localhost 都解析到回环，必须整域拦
  { re: /\.localhost$/, why: '本机主机名（.localhost 子域）' },
  // IPv6 回环
  { re: /^\[?::1\]?$/, why: 'IPv6 回环地址' },
  // IPv6 唯一本地 fc00::/7（fc / fd 开头）
  { re: /^\[?f[cd][0-9a-f]{0,2}:/i, why: 'IPv6 唯一本地地址（fc00::/7）' },
  // IPv6 链路本地 fe80::/10
  { re: /^\[?fe[89ab][0-9a-f]:/i, why: 'IPv6 链路本地地址' },
  // IPv6 未指定
  { re: /^\[?::\]?$/, why: 'IPv6 未指定地址' }
]

/**
 * IPv4 映射的 IPv6（::ffff:127.0.0.1）要脱壳后重新判：
 * 否则 `http://[::ffff:127.0.0.1]/` 能绕过所有 IPv4 规则。
 *
 * ⚠ 实测坑：WHATWG URL 解析器会把 `::ffff:127.0.0.1` **规范化成 `::ffff:7f00:1`**
 * （点分十进制 → 两段十六进制），所以只匹配「点分十进制」的映射写法会被绕过。
 * 这里两种形态都还原：`::ffff:7f00:1` → 用十六进制段拼回 IPv4。
 */
function deMapIpv4(h) {
  // 形态 1：::ffff:a.b.c.d（直接带点分十进制）
  let m = h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) return [m[1], m[2], m[3], m[4]].map(Number).join('.')
  // 形态 2：::ffff:xxxx:yyyy（URL 规范化后的十六进制段）
  m = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (m) {
    const hi = parseInt(m[1], 16)
    const lo = parseInt(m[2], 16)
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
  }
  return ''
}

function normalizeHost(hostname) {
  let h = String(hostname || '').trim().toLowerCase()
  // 去掉 IPv6 方括号（URL.hostname 对 IPv6 会带括号）
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  const mapped = deMapIpv4(h)
  if (mapped) return mapped
  return h
}

/**
 * 判断一个 URL 是否指向私网/回环。
 * @param {string} url
 * @returns {{blocked: boolean, host: string, why: string|null}}
 */
function checkOutbound(url) {
  let host = ''
  try {
    host = normalizeHost(new URL(String(url)).hostname)
  } catch (e) {
    // URL 解析不出来（相对地址、畸形）交给上游按「无效地址」处理，不在这里判
    return { blocked: false, host: '', why: null }
  }
  for (const p of BLOCKED_HOST_PATTERNS) {
    if (p.re.test(host)) return { blocked: true, host, why: p.why }
  }
  return { blocked: false, host, why: null }
}

/**
 * 从 URL 取用于审计的域名（不带端口、不带协议、转小写）。
 * 取 IP 时原样返回，方便上层看出「这个脚本在直连 IP」。
 */
function auditDomain(url) {
  try {
    return String(new URL(String(url)).hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  } catch (e) { return '' }
}

/**
 * 出站审计器：记录每个域名被请求的次数/首末时间，并能指出「新出现的域名」。
 *
 * 不阻断——上层拿 known 集合判断是不是首见，决定要不要提示用户。
 * 之所以做成对象而不是全局变量：并发的多个检测任务要各自记账，
 * 否则 A 脚本访问过的域名会让 B 脚本的同名请求看起来「不新」。
 *
 * @param {Iterable<string>} known 已知域名（来自 apiHosts 等历史记录）
 */
function makeOutboundAudit(known) {
  const seen = new Map()   // domain -> { count, firstAt, lastAt }
  const knownSet = new Set()
  for (const d of (known || [])) {
    const k = String(d || '').toLowerCase().trim()
    if (k) knownSet.add(k)
  }
  /**
   * @param {string} url
   * @returns {{domain: string, isNew: boolean, count: number}}
   */
  function note(url) {
    const domain = auditDomain(url)
    if (!domain) return { domain: '', isNew: false, count: 0 }
    const prev = seen.get(domain)
    const now = Date.now()
    if (prev) {
      prev.count++
      prev.lastAt = now
      return { domain, isNew: false, count: prev.count }
    }
    seen.set(domain, { count: 1, firstAt: now, lastAt: now })
    const isNew = !knownSet.has(domain)
    return { domain, isNew, count: 1 }
  }
  /** 本次检测中「首见且不在已知集合」的域名清单（去重、按首见顺序） */
  function newDomains() {
    const out = []
    for (const [d] of seen) if (!knownSet.has(d)) out.push(d)
    return out
  }
  function snapshot() {
    const out = {}
    for (const [d, v] of seen) out[d] = { count: v.count, firstAt: v.firstAt, lastAt: v.lastAt }
    return out
  }
  return { note, newDomains, snapshot, known: knownSet }
}

module.exports = {
  BLOCKED_HOST_PATTERNS,
  checkOutbound,
  auditDomain,
  makeOutboundAudit,
  normalizeHost
}
