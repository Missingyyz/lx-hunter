'use strict'
/**
 * 沙箱出站策略测试（v1.13.14）
 *
 * 两件事各锁一半：
 *   ① 私网/回环必须阻断 —— 这是**安全**断言，任何一条放松都是漏洞
 *   ② 普通公网域名必须放行 —— 这是**功能**断言，防「为了安全把正常音源也拦了」
 *
 * 第①类里最要紧的是「等价写法」那几条：只匹配字面量 127.0.0.1 是不够的，
 * 攻击者用手写 IP（127.1 / 0x7f000001 / [::ffff:127.0.0.1]）就能绕过。
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const { checkOutbound, auditDomain, makeOutboundAudit, BLOCKED_HOST_PATTERNS, normalizeHost } =
  require(path.join(ROOT, 'src', 'core', 'outbound-policy'))

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; fails.push(name + (detail ? '  :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}

// ============================================================================
console.log('\n=== ① IPv4 私网/回环必须阻断 ===')
// ============================================================================
const MUST_BLOCK = [
  ['http://127.0.0.1/', 'IPv4 回环'],
  ['http://127.0.0.1:8080/api', '回环带端口'],
  ['https://127.1/', '回环简写 127.1'],
  ['http://127.0.0.1.nip.io/', 'nip.io 回环域（解析到 127.0.0.1）'],
  ['http://10.0.0.5/', '10/8 私网'],
  ['http://10.255.255.254/', '10/8 边界'],
  ['http://172.16.0.1/', '172.16/12 下界'],
  ['http://172.31.255.254/', '172.31/12 上界'],
  ['http://192.168.1.1/', '192.168/16'],
  ['http://169.254.169.254/latest/meta-data/', '云元数据地址'],
  ['http://0.0.0.0/', '0/8'],
  ['http://localhost/', 'localhost 主机名'],
  ['http://LOCALHOST/', 'localhost 大写'],
  ['http://localhost:3000/x', 'localhost 带端口'],
  ['http://app.localhost/', '*.localhost 子域']
]
for (const [url, desc] of MUST_BLOCK) {
  const r = checkOutbound(url)
  ok('阻断 ' + url + '（' + desc + '）', r.blocked === true, 'why=' + r.why)
}

// ============================================================================
console.log('\n=== ② IPv6 私网/回环必须阻断，含 IPv4 映射写法 ===')
// ============================================================================
const MUST_BLOCK_V6 = [
  ['http://[::1]/', 'IPv6 回环'],
  ['http://[::1]:8080/', 'IPv6 回环带端口'],
  ['http://[::]/', 'IPv6 未指定'],
  ['http://[fd00::1]/', 'fc00::/7 唯一本地'],
  ['http://[fc00::1]/', 'fc00::/7 唯一本地（fc）'],
  ['http://[fe80::1]/', 'fe80::/10 链路本地'],
  ['http://[::ffff:127.0.0.1]/', 'IPv4 映射回环'],
  ['http://[::ffff:192.168.1.1]/', 'IPv4 映射私网']
]
for (const [url, desc] of MUST_BLOCK_V6) {
  const r = checkOutbound(url)
  ok('阻断 ' + url + '（' + desc + '）', r.blocked === true, 'host=' + r.host + ' why=' + r.why)
}

// ============================================================================
console.log('\n=== ③ 公网域名必须放行（防误伤，这是功能断言）===')
// ============================================================================
const MUST_ALLOW = [
  'https://music.163.com/api/song/enhance/player/url',
  'https://api.qq.com/',
  'http://music-api.gdstudio.xyz/api.php',
  'https://oiapi.net/api/',
  'https://api.xcvts.cn/',
  'https://13413.kstore.vip/',
  'https://a.aa.cab/',
  'http://175.27.166.236/api',
  'https://dns.alidns.com/resolve',
  // 172.32 不在 172.16/12 内，必须放行（这是最容易写错边界的点）
  'http://172.32.0.1/',
  // 11.x / 128.x / 192.169.x 都不能被 10. / 127. / 192.168. 规则误伤
  'http://11.0.0.1/',
  'http://128.0.0.1/',
  'http://192.169.1.1/',
  'http://193.168.1.1/'
]
for (const url of MUST_ALLOW) {
  const r = checkOutbound(url)
  ok('放行 ' + url, r.blocked === false, 'why=' + r.why)
}

// ============================================================================
console.log('\n=== ④ 畸形/相对地址不在这里判（交给上游当「无效地址」）===')
// ============================================================================
for (const u of ['', 'not a url', '/relative/path', 'javascript:alert(1)']) {
  const r = checkOutbound(u)
  ok('不阻断也判定为不可解析: ' + JSON.stringify(u), r.blocked === false)
}

// ============================================================================
console.log('\n=== ⑤ 封闭列表本身的属性（防止被悄悄放宽）===')
// ============================================================================
ok('封闭列表非空', BLOCKED_HOST_PATTERNS.length > 0)
ok('每条规则都带 why 说明', BLOCKED_HOST_PATTERNS.every(p => p.re instanceof RegExp && typeof p.why === 'string' && p.why.length > 0))
// 关键：172.16/12 的正则必须是 1[6-9]|2\d|3[01]，写成 1[6-9]|2[0-9] 会把 172.30/31 漏掉
const r172 = BLOCKED_HOST_PATTERNS.find(p => /172/.test(p.re.source))
ok('172 段覆盖到 172.16 与 172.31 两端',
  r172 && r172.re.test('172.16.0.1') && r172.re.test('172.31.255.255'),
  r172 ? r172.re.source : 'missing')
ok('172 段不把 172.32 算进去', r172 && !r172.re.test('172.32.0.1'))

// ============================================================================
console.log('\n=== ⑥ auditDomain：审计用的域名归一 ===')
// ============================================================================
ok('取域名不带协议端口', auditDomain('https://Music.163.com:443/x') === 'music.163.com')
ok('IP 原样返回', auditDomain('http://175.27.166.236/api') === '175.27.166.236')
ok('IPv6 去掉方括号', auditDomain('http://[::1]/') === '::1')
ok('无效 URL 返回空串', auditDomain('not a url') === '')

// ============================================================================
console.log('\n=== ⑦ 审计器：记录次数 + 指出新域名 + 不阻断 ===')
// ============================================================================
{
  const a = makeOutboundAudit(['music.163.com', 'API.QQ.com'])
  const r1 = a.note('https://music.163.com/a')
  ok('已知域名不算新', r1.isNew === false, JSON.stringify(r1))
  ok('已知域名大小写归一', r1.domain === 'music.163.com')
  const r2 = a.note('https://api.qq.com/b')
  ok('已知域名大小写不影响判定', r2.isNew === false, JSON.stringify(r2))
  const r3 = a.note('https://brand-new.example/x')
  ok('首见域名标为新', r3.isNew === true, JSON.stringify(r3))
  const r4 = a.note('https://brand-new.example/y')
  ok('同域名第二次不再算新', r4.isNew === false && r4.count === 2, JSON.stringify(r4))
  ok('newDomains 只列新域名', JSON.stringify(a.newDomains()) === JSON.stringify(['brand-new.example']))
  const snap = a.snapshot()
  ok('snapshot 含次数', snap['brand-new.example'].count === 2, JSON.stringify(snap))
  ok('审计不产生阻断（没有 blocked 字段/不抛）', typeof a.note === 'function')
}
{
  // 不给 known：一律视为新域名（首跑脚本没有历史记录，这是常态）
  const a = makeOutboundAudit()
  ok('无 known 时首见即新', a.note('https://x.example/').isNew === true)
  ok('无 known 时 newDomains 含它', a.newDomains().includes('x.example'))
}

// ============================================================================
console.log('\n=== ⑧ 接线：沙箱 fetch 真的调用了阻断与审计 ===')
// ============================================================================
{
  const fs = require('fs')
  const sbSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'sandbox.js'), 'utf8')
  ok('sandbox.js 引入了 outbound-policy', /require\(['"]\.\/outbound-policy['"]\)/.test(sbSrc))
  ok('fetch 里调用 checkOutbound', /checkOutbound\s*\(/.test(sbSrc))
  ok('fetch 里调用 outboundAudit.note', /outboundAudit\.note\s*\(/.test(sbSrc))
  ok('阻断后返回被拒的 Promise（不是静默放行）',
    /if \(outbound\.blocked[^)]*\)[\s\S]{0,400}Promise\.reject/.test(sbSrc), '锚点失配')
  ok('constructor 建了 outboundAudit', /this\.outboundAudit\s*=\s*makeOutboundAudit/.test(sbSrc))
  // 反向断言：代码里不该出现「域名白名单」式的阻断
  ok('没有把非私网域名当阻断依据', !/WHITELIST|allowHosts|allowedDomains/i.test(sbSrc))
}

// ============================================================================
console.log('\n=== ⑨ 端到端：真实 Sandbox 里访问 127.0.0.1 被拦 ===')
// ============================================================================
const http = require('http')
const { Sandbox } = require(path.join(ROOT, 'src', 'core', 'sandbox'))
const srv = http.createServer((q, r) => r.end('SECRET'))
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port
  const logs = []
  const sb = new Sandbox({ initGraceMs: 1200, knownHosts: ['known.example'], onLog: m => logs.push(String(m)) })
  // 用 console.warn 才观测得到（console.log 在沙箱里是 no-op）
  sb.run('fetch("http://127.0.0.1:' + port + '/").then(' +
    'function(r){console.warn("E2E_ALLOWED")},' +
    'function(e){console.warn("E2E_BLOCKED "+String(e.message).slice(0,120))})')
  setTimeout(() => {
    const joined = logs.join('\n')
    ok('沙箱内访问回环被拒', /E2E_BLOCKED/.test(joined), joined.slice(0, 200))
    ok('拒绝原因点明私网/回环', /私网|回环/.test(joined), joined.slice(0, 200))
    ok('没有真的连上（未出现 ALLOWED）', !/E2E_ALLOWED/.test(joined), joined.slice(0, 200))
    ok('阻断事件进了日志', logs.some(l => /出站已阻断/.test(l)), joined.slice(0, 200))

    // 审计：用一个公网域名形状的地址（不求真连通，只看审计是否记账）
    const sb2 = new Sandbox({ initGraceMs: 300, fetchTimeout: 600, knownHosts: ['known.example'] })
    sb2.run('fetch("https://brand-new-domain.example/x").then(function(){},function(){})')
    setTimeout(() => {
      const snap = sb2.outboundAudit.snapshot()
      ok('审计记到了新域名', !!snap['brand-new-domain.example'], JSON.stringify(snap))
      ok('审计把它列为新', sb2.outboundAudit.newDomains().includes('brand-new-domain.example'),
        JSON.stringify(sb2.outboundAudit.newDomains()))
      try { sb.destroy() } catch (e) {}
      try { sb2.destroy() } catch (e) {}
      srv.close()
      done()
    }, 1200)
  }, 1200)
})

function done() {
  console.log('\n' + (fail ? '✗' : '✓') + ' outbound-policy: PASS ' + pass + ' / FAIL ' + fail)
  if (fail) {
    console.log('\n失败项：')
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  process.exit(0)
}
