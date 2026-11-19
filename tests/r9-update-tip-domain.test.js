'use strict'
/**
 * R9：追更链（updateTip.url）域名校验测试
 *
 * ============================================================================
 * 这个漏洞是怎么来的
 * ============================================================================
 * 沙箱里的音源脚本能上报「更新提示」：
 *   sandbox.js 的 lx.send('updateAlert') 与 lx.request 响应嗅探两条通道，
 *   都把 url 收进 self.updateTips；
 *   checker 把它写回条目 → hunter._mergeUpdateTips 存进 e.updateTips；
 *   hunter._followUpdateTips **按 tip.url 下载内容并 store.addSources() + saveDb()**。
 *
 * 也就是说：**沙箱里的恶意脚本能让 hunter 往用户的音源库里注入任意内容**。
 * 沙箱是执行不可信代码的地方，所以「沙箱里报出来的 url」天然不可信。
 *
 * ============================================================================
 * 本测试锁住四件事
 * ============================================================================
 * ① 陌生伪造域名被拒（不进 addSources，也不发起下载）
 * ② 合法域名（属于该音源自己的已知域名）通过 → 正常入库
 * ③ **单条追更失败不阻断整轮**（一条坏的 + 一条好的，好的一样入库）
 * ④ 私网/回环地址被拒（复用 outbound-policy 的封闭判据，不另写一套）
 *
 * ============================================================================
 * 为什么第②层按「音源自己的已知域名」而不是公共 CDN 白名单
 * ============================================================================
 * outbound-policy.js 的设计是「普通域名只审计不阻断」，理由是生产库 1713 条音源
 * 有 239 个唯一域名、其中约 150 个是第三方聚合站，**换域名是常态**。
 * 照抄一份公共白名单去挡陌生域名，会让生产音源换个域名就**静默失效**
 * （表现为「音源坏了」，用户看到功能故障而不是安全提示）——
 * 这正是 outbound-policy.js 里写明「曾计划做、已否决」的做法。
 * 所以这里只认「这个音源自己已经表现出来的域名」，不臆造任何公共清单。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const CORE = (n) => path.join(ROOT, 'src', 'core', n)

const { Hunter, checkUpdateTipUrl, knownHostsForEntry, checkUpdateTipHostBelongsTo, isSameSiteHost, isValidPublicHostShape } =
  require(CORE('hunter'))
const { Store } = require(CORE('store'))

let pass = 0
let fail = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; fails.push(name + (extra ? '  :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')) }
}

// 一个像模像样的音源脚本内容（追更入库的判据是脚本特征）
const NEW_SCRIPT = '/** @name 新版音源 v2 */\nglobalThis.lx={EVENT_NAMES:{request:"request"},on(){},request(){}};\n'

/**
 * 造一个 Hunter 实例，并把 net.crawlFetch 换成可控桩。
 *
 * ⚠️ 为什么不能直接 patch net.crawlFetch：
 *   hunter.js 在**模块加载时**就把 crawlFetch 解构进闭包常量，
 *   之后 patch net.crawlFetch 对 hunter 无效。
 *   所以这里换成**直接替换 hunter 内部用的那个函数**——
 *   但 hunter.js 里它是模块级 const 引用，没法从外部改。
 *   ⇒ 改用「把 net 模块缓存清掉 + 用 require.cache 注入假 net」的方式，
 *   在 require hunter **之前**换掉 net 的 crawlFetch。
 */
function loadHunterWithFakeNet (fetchImpl) {
  const netPath = require.resolve(CORE('net'))
  const netReal = require(netPath)
  const fetched = []
  const fakeNet = Object.assign({}, netReal, {
    crawlFetch: async function (url, opts) {
      fetched.push(String(url))
      return fetchImpl(String(url), opts)
    }
  })
  // 让下一次 require('.../net') 直接拿到假实现
  const saved = require.cache[netPath]
  require.cache[netPath] = { id: netPath, filename: netPath, loaded: true, exports: fakeNet }
  // hunter 也要重新加载（它内部持有 crawlFetch 的引用）
  const hunterPath = require.resolve(CORE('hunter'))
  const savedHunter = require.cache[hunterPath]
  delete require.cache[hunterPath]
  const hunterMod = require(CORE('hunter'))
  // 复原缓存（不影响本进程后续其它 require 的正确性）
  if (saved) require.cache[netPath] = saved
  else delete require.cache[netPath]
  if (savedHunter) require.cache[hunterPath] = savedHunter
  else delete require.cache[hunterPath]
  return { Hunter: hunterMod.Hunter, fetched }
}

const NO_NET = () => ({ res: null, url: '', mirror: null, attempts: [{ mirror: 'stub', error: '测试桩：不联网' }] })
const WITH_SCRIPT = (u) => ({ res: { ok: true, status: 200, text: async () => NEW_SCRIPT }, url: u, mirror: 'stub', attempts: [] })

function mkHunter (HunterCls, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-r9-'))
  const store = new Store(dir)
  store.db.sources = entries || {}
  const h = Object.create(HunterCls.prototype)
  h.store = store
  h.emit = () => {}
  h.logs = []
  h.log = (msg, mod, level) => { h.logs.push({ msg: String(msg), mod, level }) }
  h.job = { running: false, cancel: false, progress: {}, step: '' }
  h.batchId = 'r9-test'
  h._dir = dir
  return h
}

/** 造一条音源条目：自带已知域名（apiHosts）+ 更新提示 */
function mkEntry (id, apiHosts, tips, extra) {
  return Object.assign({
    id,
    name: '音源 ' + id,
    lxName: '音源 ' + id,
    scriptName: '音源 ' + id,
    apiHosts,
    updateTips: tips,
    status: 'ok',
    usable: false,
    deprecated: false
  }, extra || {})
}

function cleanup (h) {
  try { fs.rmSync(h._dir, { recursive: true, force: true }) } catch (e) {}
}

async function main () {
  // ==========================================================================
  console.log('\n=== ① 第①层硬校验：协议 / 域名格式 / 私网回环 ===')
  // ==========================================================================
  {
    ok('javascript: 被拒', checkUpdateTipUrl('javascript:alert(1)').ok === false)
    ok('data: 被拒', checkUpdateTipUrl('data:text/javascript,alert(1)').ok === false)
    ok('file: 被拒', checkUpdateTipUrl('file:///c:/windows/win.ini').ok === false)
    ok('http: 通过', checkUpdateTipUrl('http://example.com/a.js').ok === true)
    ok('https: 通过', checkUpdateTipUrl('https://example.com/a.js').ok === true)
    ok('空串被拒', checkUpdateTipUrl('').ok === false)
    ok('null 被拒', checkUpdateTipUrl(null).ok === false)
    ok('相对地址被拒', checkUpdateTipUrl('/local/a.js').ok === false)
    ok('不是 URL 被拒', checkUpdateTipUrl('not a url').ok === false)
    ok('超长地址被拒', checkUpdateTipUrl('https://example.com/' + 'a'.repeat(3000)).ok === false)

    const MUST_BLOCK = [
      ['http://127.0.0.1/x.js', 'IPv4 回环'],
      ['https://127.1/x.js', '回环简写 127.1'],
      ['http://10.0.0.5/x.js', '10/8 私网'],
      ['http://172.16.0.1/x.js', '172.16/12'],
      ['http://192.168.1.1/x.js', '192.168/16'],
      ['http://169.254.169.254/latest/meta-data/', '云元数据'],
      ['http://0.0.0.0/x.js', '0/8'],
      ['http://localhost/x.js', 'localhost'],
      ['http://app.localhost/x.js', '*.localhost'],
      ['http://[::1]/x.js', 'IPv6 回环'],
      ['http://[fd00::1]/x.js', 'fc00::/7'],
      ['http://[fe80::1]/x.js', 'fe80::/10'],
      ['http://[::ffff:127.0.0.1]/x.js', 'IPv4 映射回环']
    ]
    for (const u of MUST_BLOCK) {
      const r = checkUpdateTipUrl(u)
      ok('私网/回环被拒：' + u + '（' + u[1] + '）', r.ok === false, 'why=' + r.why)
    }
    // 公网地址不能被误伤（功能断言，防「为了安全把正常音源也拦了」）
    for (const u of ['https://music.163.com/a.js', 'https://api.qq.com/a.js', 'http://172.32.0.1/a.js', 'https://193.168.1.1/a.js']) {
      ok('公网地址放行：' + u, checkUpdateTipUrl(u).ok === true)
    }
    ok('单标签主机名形状不合法（只能是内网/本机名）', isValidPublicHostShape('myhost') === false)
    ok('IPv4 字面量形状合法（直连 IP 是生产常态，私网由 checkOutbound 判）',
      isValidPublicHostShape('175.27.166.236') === true)
    ok('非法 IPv4（>255）形状不合法', isValidPublicHostShape('999.1.1.1') === false)
    ok('正常域名形状通过', isValidPublicHostShape('music-api.gdstudio.xyz') === true)
    ok('下划线域名形状不合法', isValidPublicHostShape('a_b.example.com') === false)
    ok('空 label 形状不合法', isValidPublicHostShape('a..example.com') === false)
  }

  // ==========================================================================
  console.log('\n=== ② 第②层：域名必须属于「这个音源自己」 ===')
  // ==========================================================================
  {
    const e = mkEntry('e1', ['music-api.gdstudio.xyz', 'oiapi.net'], [])
    const known = knownHostsForEntry(e)
    ok('已知域名集合含 apiHosts', known.has('music-api.gdstudio.xyz') && known.has('oiapi.net'), Array.from(known).join(','))
    ok('已知域名集合含 homepage', knownHostsForEntry(mkEntry('e2', [], [], { homepage: 'https://home.example.com/' })).has('home.example.com'))
    ok('已知域名集合含脚本地址 url', knownHostsForEntry(mkEntry('e3', [], [], { url: 'https://raw.example.org/a.js' })).has('raw.example.org'))

    ok('完全相同的域名 → 属于该音源', checkUpdateTipHostBelongsTo(e, 'music-api.gdstudio.xyz', known).ok === true)
    ok('子域 → 属于该音源', checkUpdateTipHostBelongsTo(e, 'v2.music-api.gdstudio.xyz', known).ok === true)
    // 2026-11-19 R9 收紧：父域方向**不再**算同域。
    //   收紧理由：known 里若有 `gdstudio.xyz` 这类公共域，
    //   父域方向会让 `attacker.gdstudio.xyz` 也被判成「自己的域名」。
    //   收紧实测：43 条 tip 放行数 22→22、27 条红线 10→10，真差异 0（零误伤）。
    ok('父域 → 不属于该音源（父域方向已收紧）', checkUpdateTipHostBelongsTo(e, 'gdstudio.xyz', known).ok === false)
    ok('陌生域名 → 不属于该音源', checkUpdateTipHostBelongsTo(e, 'evil.attacker.tld', known).ok === false)
    ok('「后缀像但不是子域」→ 不属于该音源', checkUpdateTipHostBelongsTo(e, 'oiapi.net.evil.tld', known).ok === false)
    ok('无任何已知域名 → 一律不通过（无法证明归属）',
      checkUpdateTipHostBelongsTo(mkEntry('e4', [], []), 'example.com', new Set()).ok === false)

    ok('isSameSiteHost：同主机名', isSameSiteHost('a.com', new Set(['a.com'])) === true)
    ok('isSameSiteHost：一层子域', isSameSiteHost('x.a.com', new Set(['a.com'])) === true)
    ok('isSameSiteHost：多层子域不放行', isSameSiteHost('a.b.a.com', new Set(['a.com'])) === false)
    ok('isSameSiteHost：父域不放行（已收紧）', isSameSiteHost('a.com', new Set(['x.a.com'])) === false)
    ok('isSameSiteHost：不同站', isSameSiteHost('b.com', new Set(['a.com'])) === false)
    ok('isSameSiteHost：后缀相同但不是子域（nota.com vs a.com）',
      isSameSiteHost('nota.com', new Set(['a.com'])) === false)
  }

  // ==========================================================================
  console.log('\n=== ③ _mergeUpdateTips：写入时丢弃不合法地址（但不影响其它 tip） ===')
  //   注意分层：合并侧只做**第①层**（协议/域名格式/私网回环）的纵深校验——
  //   「这个域名是不是这个音源自己的」是**第②层**，要按具体条目判断，
  //   放在下载前（_followUpdateTips）做，那里才知道是哪个音源、它的已知域名是什么。
  //   所以这里：合法公网域名（哪怕陌生）**照写**（下一轮追更时才决定要不要跟），
  //   私网/回环/畸形地址在写入时就丢掉。
  // ==========================================================================
  {
    const { Hunter: H } = loadHunterWithFakeNet(NO_NET)
    const h = mkHunter(H)
    const e = mkEntry('m1', ['music-api.gdstudio.xyz'], [])
    const tips = [
      { url: 'https://music-api.gdstudio.xyz/new.js', msg: '好的一条' },
      { url: 'https://evil.attacker.tld/payload.js', msg: '陌生域名（写入侧放行，下载侧拦）' },
      { url: 'http://127.0.0.1/x.js', msg: '回环一条' },
      { url: 'javascript:alert(1)', msg: '协议一条' },
      { url: '/relative.js', msg: '相对地址一条' }
    ]
    h._mergeUpdateTips(e, tips)
    const urls = (e.updateTips || []).map(t => t.url)
    ok('合法已知域名被写入', urls.indexOf('https://music-api.gdstudio.xyz/new.js') >= 0, JSON.stringify(urls))
    ok('回环地址没被写入', urls.indexOf('http://127.0.0.1/x.js') === -1, JSON.stringify(urls))
    ok('非 http(s) 没被写入', urls.indexOf('javascript:alert(1)') === -1, JSON.stringify(urls))
    ok('相对地址没被写入', urls.indexOf('/relative.js') === -1, JSON.stringify(urls))
    ok('写了日志（不是静默丢弃）', h.logs.some(l => /更新提示/.test(l.msg) && l.level === 'warn'),
      JSON.stringify(h.logs.map(l => l.msg)))
    ok('一条坏的不拖垮整批（合法的那条照写）',
      urls.indexOf('https://music-api.gdstudio.xyz/new.js') >= 0 && urls.length === 2, JSON.stringify(urls))
    cleanup(h)
  }

  // ==========================================================================
  console.log('\n=== ④ _followUpdateTips：陌生伪造域名被拒（不下载、不入库） ===')
  // ==========================================================================
  {
    const { Hunter: H, fetched } = loadHunterWithFakeNet(NO_NET)
    const h = mkHunter(H, {
      evil: mkEntry('evil', ['music-api.gdstudio.xyz'], [
        { url: 'https://evil.attacker.tld/payload.js', msg: '伪造更新' }
      ])
    })
    await h._followUpdateTips({})
    const sources = Object.keys(h.store.db.sources || {})
    ok('伪造域名没被入库（库里仍只有原来那一条）', sources.length === 1, JSON.stringify(sources))
    ok('伪造域名没被下载', fetched.length === 0, JSON.stringify(fetched))
    ok('记了跳过日志', h.logs.some(l => /追更跳过/.test(l.msg)), JSON.stringify(h.logs.map(l => l.msg)))
    cleanup(h)
  }

  // ==========================================================================
  console.log('\n=== ⑤ _followUpdateTips：私网/回环地址被拒 ===')
  // ==========================================================================
  {
    const { Hunter: H, fetched } = loadHunterWithFakeNet(NO_NET)
    const h = mkHunter(H, {
      priv: mkEntry('priv', ['music-api.gdstudio.xyz'], [
        { url: 'http://127.0.0.1/x.js', msg: '回环' },
        { url: 'http://192.168.1.10/x.js', msg: '私网' },
        { url: 'http://[::1]/x.js', msg: 'IPv6 回环' }
      ])
    })
    await h._followUpdateTips({})
    ok('私网/回环没被下载', fetched.length === 0, JSON.stringify(fetched))
    ok('私网/回环没入库', Object.keys(h.store.db.sources).length === 1)
    cleanup(h)
  }

  // ==========================================================================
  console.log('\n=== ⑥ _followUpdateTips：合法域名（属于该音源自己）通过 → 正常入库 ===')
  // ==========================================================================
  {
    const { Hunter: H, fetched } = loadHunterWithFakeNet(WITH_SCRIPT)
    const h = mkHunter(H, {
      good: mkEntry('good', ['music-api.gdstudio.xyz'], [
        { url: 'https://music-api.gdstudio.xyz/v2.js', msg: '正常更新' }
      ])
    })
    await h._followUpdateTips({})
    const ids = Object.keys(h.store.db.sources || {})
    const added = ids.filter(id => String(id).indexOf('updateurl::') === 0)
    ok('合法更新地址被下载', fetched.length === 1, JSON.stringify(fetched))
    ok('合法更新地址入库（updateurl:: 前缀）', added.length === 1, JSON.stringify(ids))
    ok('入库条目带上 fromUpdateTip 溯源',
      added.length === 1 && h.store.db.sources[added[0]].fromUpdateTip === 'good',
      added.length ? JSON.stringify(h.store.db.sources[added[0]].fromUpdateTip) : 'none')
    cleanup(h)
  }

  // ==========================================================================
  console.log('\n=== ⑦ ★ 单条追更失败不阻断整轮（一条坏的 + 一条好的 → 好的照样入库） ===')
  // ==========================================================================
  {
    const { Hunter: H, fetched } = loadHunterWithFakeNet(WITH_SCRIPT)
    const h = mkHunter(H, {
      mixed: mkEntry('mixed', ['music-api.gdstudio.xyz'], [
        { url: 'https://evil.attacker.tld/payload.js', msg: '坏的一条' },
        { url: 'https://music-api.gdstudio.xyz/v2.js', msg: '好的一条' }
      ])
    })
    let threw = null
    try { await h._followUpdateTips({}) } catch (e) { threw = e }
    ok('整轮没有抛错（坏的不阻断整轮）', threw === null, threw ? String(threw.message) : '')
    const ids = Object.keys(h.store.db.sources || {})
    const added = ids.filter(id => String(id).indexOf('updateurl::') === 0)
    ok('好的一条照样入库', added.length === 1, JSON.stringify(ids))
    ok('只下载了那一条好地址', fetched.length === 1 && /gdstudio/.test(fetched[0]), JSON.stringify(fetched))
    ok('坏的被跳过并记日志', h.logs.some(l => /追更跳过/.test(l.msg)), JSON.stringify(h.logs.map(l => l.msg)))
    cleanup(h)
  }

  // ==========================================================================
  console.log('\n=== ⑧ 被跳过的 tip 不记进 followedUpdateUrls（下轮还能再试） ===')
  // ==========================================================================
  {
    const { Hunter: H } = loadHunterWithFakeNet(WITH_SCRIPT)
    const h = mkHunter(H, {
      e: mkEntry('e', ['music-api.gdstudio.xyz'], [
        { url: 'https://evil.attacker.tld/payload.js', msg: '坏' }
      ])
    })
    await h._followUpdateTips({})
    const e = h.store.db.sources.e
    ok('被跳过的 tip 没被记成「已跟进」',
      !Array.isArray(e.followedUpdateUrls) || e.followedUpdateUrls.length === 0,
      JSON.stringify(e.followedUpdateUrls))
    cleanup(h)
  }

  // ==========================================================================
  console.log('\n=== ⑨ 接线：追更链真的接上了校验（源码断言，防被悄悄摘掉） ===')
  // ==========================================================================
  {
    const src = fs.readFileSync(CORE('hunter.js'), 'utf8')
    ok('hunter.js 引入了 outbound-policy', /require\(['"]\.\/outbound-policy['"]\)/.test(src))
    ok('追更前调用 checkUpdateTipUrl', /checkUpdateTipUrl\(tip\.url\)/.test(src))
    ok('追更前调用 checkUpdateTipHostBelongsTo', /checkUpdateTipHostBelongsTo\(/.test(src))
    ok('合并时也做校验（纵深：写入侧也有）', /checkUpdateTipUrl\(t\.url\)/.test(src))
    ok('私网判据复用 checkOutbound（不另写一套）',
      /checkOutbound\(u\.href\)/.test(src) && /require\(['"]\.\/outbound-policy['"]\)/.test(src))
    ok('没有臆造公共 CDN 白名单（不得出现硬编码 CDN 名单常量）',
      !/CDN_WHITELIST|CDN_ALLOW|ALLOWED_CDN/i.test(src))
  }

  console.log('\n' + (fail ? '✗' : '✓') + ' r9-update-tip-domain: PASS ' + pass + ' / FAIL ' + fail)
  if (fail) {
    console.log('\n失败项：')
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(e => { console.error('测试异常:', e); process.exit(1) })
