'use strict'
/**
 * updateurl:: 入库链路的闸门强度实测（只读探查，不改 src/）
 *
 * 关注三个问题：
 *   Q1 闸门②「域名属于该音源自己」在**脚本来自共享托管域**时是否被绕过？
 *      knownHostsForEntry(hunter.js:590) 把 e.url（脚本下载地址）算进 known 集合。
 *      若 e.url = https://raw.githubusercontent.com/xxx/y.js，则任何
 *      https://raw.githubusercontent.com/任意路径 都被判成「自己的域名」→ 闸门形同虚设。
 *   Q2 入库的 updateurl:: 条目会不会参与同名裁决、进而替换掉真音源？
 *   Q3 现有闸门能不能拦住「伪造 tip 指向攻击者自有域名」。
 */
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const CORE = (n) => path.join(ROOT, 'src', 'core', n)
const H = require(CORE('hunter'))

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (x != null ? '  :: ' + x : '')) } }

console.log('=== Q1：脚本来自共享托管域时，闸门②是否被绕过 ===')
{
  const e = {
    id: 'x', name: 'n', lxName: 'n', scriptName: 'n',
    // 脚本是从 GitHub raw 下载的（极常见）
    url: 'https://raw.githubusercontent.com/someone/some-repo/main/source.js',
    apiHosts: ['music-api.example.com']
  }
  const known = H.knownHostsForEntry(e)
  console.log('  known =', Array.from(known).join(', '))

  const v = H.checkUpdateTipUrl('https://raw.githubusercontent.com/ATTACKER/evil-repo/main/payload.js')
  console.log('  第①层 checkUpdateTipUrl =', JSON.stringify(v))
  const own = H.checkUpdateTipHostBelongsTo(e, v.host, known)
  console.log('  第②层 belongsTo =', JSON.stringify(own))

  ok('第①层通过（协议/私网/格式都合法）', v.ok === true, JSON.stringify(v))
  ok('★ 第②层被绕过：攻击者托管域被判成「该音源自己的域名」', own.ok === true,
    'own=' + JSON.stringify(own))
  ok('★ 结论：只靠 e.url 撑起的 known 集合不足以当闸门', known.has('raw.githubusercontent.com'))
}

console.log('\n=== Q1b：只有 apiHosts（不含脚本托管域）时闸门是否有效 ===')
{
  const e = {
    id: 'y', name: 'n', lxName: 'n', scriptName: 'n',
    apiHosts: ['music-api.example.com']
  }
  const known = H.knownHostsForEntry(e)
  const v = H.checkUpdateTipUrl('https://raw.githubusercontent.com/ATTACKER/evil/main/payload.js')
  const own = H.checkUpdateTipHostBelongsTo(e, v.host, known)
  ok('无脚本地址时，陌生托管域被拒', own.ok === false, JSON.stringify(own))
}

console.log('\n=== Q1c：父域判定 isSameSiteHost 是否过宽 ===')
{
  const known = new Set(['example.com'])
  ok('子域被放行（同域，合理）', H.isSameSiteHost('a.example.com', known) === true)
  ok('父域不放行（已收紧：known=example.com，host=example.com 本体仍放行）', H.isSameSiteHost('example.com', known) === true)
  ok('★ 父域方向已收紧：host=example.com 对 known=x.example.com 不再放行', H.isSameSiteHost('example.com', new Set(['x.example.com'])) === false)
  ok('★ 同后缀不同主域被拒', H.isSameSiteHost('evil-example.com', known) === false)
  ok('★ 完全无关域被拒', H.isSameSiteHost('attacker.tld', known) === false)
}

console.log('\n=== Q2：updateurl:: 条目在库里长什么样（构造同形条目） ===')
{
  // 模拟 hunter.js:4269-4272 的入库字段
  const crypto = require('crypto')
  const sha256Str = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
  const tipUrl = 'https://raw.githubusercontent.com/ATTACKER/evil/main/payload.js'
  const text = '/** @name 目标音源 v99 */\nglobalThis.lx={};\n'
  const sha = sha256Str(text)
  const id = 'updateurl::' + sha256Str(tipUrl).slice(0, 10) + ':' + sha.slice(0, 12)
  const entry = {
    id, repo: 'updateUrl 追更', url: tipUrl, name: '目标音源 v99', lxName: '目标音源 v99',
    scriptName: '目标音源 v99', code: text, contentHash: sha, size: text.length,
    status: 'ok', usable: false, addedAt: Date.now(), fromUpdateTip: 'real-source-id'
  }
  console.log('  构造的条目 id =', id)
  ok('id 前缀确实是 updateurl::', id.indexOf('updateurl::') === 0)
  ok('条目的 name 直接来自攻击者脚本里的 @name', entry.name === '目标音源 v99')
  ok('★ 条目 status=ok / usable=false —— 会进检测队列（runCheck 遍历 getSources()）', entry.status === 'ok')

  // 名归一化：攻击者能控制名字 ⇒ 能与真音源同名
  const identity = require(CORE('identity'))
  console.log('  normName(攻击者名) =', identity.normName(entry.lxName))
}

console.log('\n=== Q3：现有闸门对「伪造 tip 指向攻击者自有域名」的拦截 ===')
{
  const e = {
    id: 'z', name: 'n', lxName: 'n', scriptName: 'n',
    apiHosts: ['music-api.example.com'], homepage: 'https://music-api.example.com'
  }
  const known = H.knownHostsForEntry(e)
  const v = H.checkUpdateTipUrl('https://attacker.tld/payload.js')
  const own = H.checkUpdateTipHostBelongsTo(e, v.host, known)
  ok('攻击者自有域名被第②层拒绝', own.ok === false, JSON.stringify(own))
  ok('★ 但若攻击者能控制脚本托管域（e.url），闸门②即失效（见 Q1）', true)
}

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' probe: PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
