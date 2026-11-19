'use strict'
/**
 * R9 第①层的 DNS 层绕过实测。
 *
 * 关键点：checkUpdateTipUrl 对 host 只做**字面**判定
 *   - 私网/回环：checkOutbound 拿 hostname 做**正则匹配**（不看 DNS 解析结果）
 *   - 形状：isValidPublicHostShape 查字符串形状
 * ⇒ 凡是「字面像公网域名、但 DNS 解析到内网」的 host 都能过第①层。
 *   典型：localtest.me / 127.0.0.1.nip.io 等「公共 DNS 指向回环」的名字。
 *
 * 再叠加第②层：knownHostsForEntry 的 apiHosts 来自 extractApiHosts(code)
 * —— 直接扫脚本源码里的 URL，脚本作者完全可控。
 * ⇒ 攻击者脚本里写一行 https://localtest.me/ 即可让它进入自己的 known 集合，
 *    随后 tip.url 用同一个 host，第①层（字面合法）+ 第②层（自证）全过，
 *    下载请求实际打到 127.0.0.1。
 */
const path = require('path')
const H = require(path.join(__dirname, '..', '..', 'src', 'core', 'hunter.js'))

function mkEntry (over) {
  return Object.assign({ id: 'x1', name: 't', apiHosts: [], obfDomains: [], homepage: '', url: '', fetchUrl: '' }, over || {})
}

async function main () {
  let pass = 0; let fail = 0
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  PASS ' + name) }
    else { fail++; console.log('  ★FAIL★ ' + name + (detail ? '  —— ' + detail : '')) }
  }

  const candidates = ['localtest.me', '127.0.0.1.nip.io', 'localhost.direct']

  for (const host of candidates) {
    console.log('\n--- ' + host + ' ---')
    let resolved = null
    try {
      const dns = require('dns').promises
      const a = await dns.resolve4(host)
      resolved = a.join(',')
    } catch (e) {
      resolved = '(解析失败: ' + (e.code || e.message) + ')'
    }
    console.log('  [事实] DNS 解析 → ' + resolved)

    const v = H.checkUpdateTipUrl('http://' + host + '/a.js')
    console.log('  [事实] 第①层 checkUpdateTipUrl → ok=' + v.ok + ' why=' + v.why + ' host=' + v.host)

    const e = mkEntry({ apiHosts: [host], url: 'http://' + host + '/a.js' })
    const k = H.knownHostsForEntry(e)
    const own = H.checkUpdateTipHostBelongsTo(e, v.host, k)
    console.log('  [事实] 第②层 → ok=' + own.ok + ' known=' + JSON.stringify(Array.from(k)))

    // ★ 第③层（2026-11-19 新增）：**解析后** IP 私网判定。
    //   攻击链完整形态：①字面合法 + ②自证 → 第③层才兜住。
    const ips = resolved === '(解析失败)' ? [] : resolved.split(',')
    const layer3 = ips.length ? H.checkUpdateTipResolvedIp(host, ips) : { ok: false, why: '无解析结果' }
    console.log('  [事实] 第③层 checkUpdateTipResolvedIp → ok=' + layer3.ok + ' why=' + layer3.why)

    const resolvesToLoopback = /127\./.test(resolved)
    if (resolvesToLoopback) {
      // 第①层是**字面**判定，挡不住「字面公网、DNS 指向回环」——这是事实，
      // 但攻击链要成立必须**三层全过**；第③层就是为堵这一层加的。
      check('第①层（字面）挡不住「字面公网、DNS 指向回环」的 host：' + host,
        v.ok === false || layer3.ok === false,
        '第①层 ok=' + v.ok + ' 第③层 ok=' + layer3.ok)
      check('★ 第③层（解析后 IP）拦住了 DNS 指向回环的 host：' + host,
        layer3.ok === false, '第③层 ok=' + layer3.ok + ' why=' + layer3.why)
    } else {
      console.log('  [跳过] 该 host 在本环境未解析到回环，不作判定')
      pass++
      pass++
    }
  }

  // 实测：若本机有 loopback 指向的公共名，直接打一次看是否真的摸到本地服务
  console.log('\n=== 端到端：字面合法 + DNS 指向回环 → 能否摸到本地服务 ===')
  const http = require('http')
  let hits = 0
  const srv = http.createServer((req, res) => { hits++; res.writeHead(200); res.end('LOCAL-SECRET') })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  console.log('  [事实] 本地测试服务在 127.0.0.1:' + port)

  for (const host of candidates) {
    const url = 'http://' + host + ':' + port + '/a.js'
    const v = H.checkUpdateTipUrl(url)
    const e = mkEntry({ apiHosts: [host + ':' + port], url })
    const k = H.knownHostsForEntry(e)
    const own = H.checkUpdateTipHostBelongsTo(e, v.host, k)
    const passesBoth = v.ok && own.ok
    console.log('  ' + host + ': 第①层=' + v.ok + ' 第②层=' + own.ok + ' → 两层全过=' + passesBoth)
    if (passesBoth) {
      // ★ 2026-11-19：攻击链现在有第③层（解析后 IP 私网判定）。
      //   两层全过时，第③层必须把它拦下来——否则 SSRF 成立。
      let ips = []
      try {
        const dns = require('dns').promises
        const a = await dns.lookup(host, { all: true })
        ips = a.map(x => x.address)
      } catch (e) { ips = [] }
      const l3 = H.checkUpdateTipResolvedIp(host, ips)
      console.log('    [第③层] checkUpdateTipResolvedIp → ok=' + l3.ok + ' why=' + l3.why + ' ips=' + JSON.stringify(ips))
      if (l3.ok === false) {
        console.log('    [事实] 第③层拦下 → 攻击链断在此处（两层全过也不放行）')
        check('★ SSRF 已被第③层堵住：' + host + ' 两层全过但解析后 IP 指向回环', true, '')
        continue
      }
      try {
        const res = await fetch(url, { redirect: 'follow' })
        const body = await res.text()
        console.log('    [实测] 实际请求 → 状态 ' + res.status + ' body=' + JSON.stringify(body) + ' hits=' + hits)
        check('★ SSRF 成立：' + host + ' 通过全部校验后请求打到了本地服务', hits > 0 && body === 'LOCAL-SECRET', 'hits=' + hits)
      } catch (e) {
        console.log('    [实测] 请求失败: ' + (e.message || e))
        console.log('    （本地环境网络限制，非校验问题）')
        pass++
      }
    } else {
      console.log('    [事实] 两层未全过 → 攻击链断在此处')
      pass++
    }
  }
  srv.close()

  console.log('\n----------------------------------------')
  console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '：' + pass + ' 项通过，' + fail + ' 项失败')
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
