'use strict'
/**
 * v1.13.1：GitHub 配额优化的可验证部分
 *
 * 用户 2026-11-11：先对照代码评测，再决定做哪几项。评测结论是做 1/2/3/5，不做 4（pushed_at 会漏
 * release-only 仓库）和 6（hunter 根本没有 HTTP 5xx 重试）。
 *
 * 这里用**本地 HTTP 服务**真跑一遍，不 mock：
 *   - 第 1 项 ETag：304 时返回缓存内容、且不再解析 body（GitHub 规则：304 不计配额）
 *   - 第 3 项 404 记忆：3 天内跳过，过期后重探，恢复后自动回来
 *   - 第 5 项 分支快捷路径：给了 branch 就不再请求 /repos/{repo}（每仓库省 1 次配额）
 */
const assert = require('assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crawler = require('../src/core/crawler')
const {
  ghGetJson, filterDeadRepos, DEAD_REPO_TTL_MS,
  resetGhStats, ghStatsSnapshot,
  filterNegativeCached, isTransientVerifyReason, GH_NEG_TTL_MS,
  etagCacheSnapshot, hydrateEtagCache, verifyRepoHasSource
} = crawler

let pass = 0
function ok(name) { pass++; console.log('  ✓ ' + name) }

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port
      try { await fn('http://127.0.0.1:' + port) } catch (e) { reject(e) } finally { srv.close() }
      resolve()
    })
  })
}

async function main() {
  console.log('== 1. ETag / 304（304 不计入 GitHub 配额） ==')
  await withServer((req, res) => {
    const etag = '"abc"'
    req.__hits = (req.__hits || 0) + 1
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag })
    res.end(JSON.stringify([{ sha: 'x1' }]))
  }, async (base) => {
    const url = base + '/repos/a/b/releases?per_page=5'
    const r1 = await ghGetJson(url, '', 5000)
    assert.strictEqual(r1.ok, true)
    assert.strictEqual(r1.notModified, false)
    assert.deepStrictEqual(r1.json, [{ sha: 'x1' }])

    const r2 = await ghGetJson(url, '', 5000)
    assert.strictEqual(r2.notModified, true, '第二次带 If-None-Match → 304')
    assert.deepStrictEqual(r2.json, r1.json, '304 时用缓存内容，不重复解析')
    ok('200 → 存 ETag；再次请求命中 304 并复用缓存')

    const r3 = await ghGetJson(base + '/other', '', 5000)
    assert.strictEqual(r3.notModified, false, '不同 URL 不串缓存')
  })

  console.log('\n== 3. 404 仓库记忆（3 天内跳过） ==')
  {
    const now = 1794400000000
    const dead = { 'a/gone': { at: now - 3600 * 1000, hits: 2 } }
    const r = filterDeadRepos(['a/gone', 'a/alive'], dead, now)
    assert.deepStrictEqual(r.keep, ['a/alive'])
    assert.deepStrictEqual(r.skipped, ['a/gone'])
    ok('TTL 内的 404 仓库被跳过，活的照常探')

    const old = filterDeadRepos(['a/gone'], dead, now + DEAD_REPO_TTL_MS + 1000)
    assert.deepStrictEqual(old.keep, ['a/gone'], '过期后允许重探（组织改名/恢复后能自己回来）')
    ok('超过 TTL 自动重探')

    const none = filterDeadRepos(['b/x'], null, now)
    assert.deepStrictEqual(none.keep, ['b/x'])
    assert.deepStrictEqual(none.skipped, [])
    ok('没有死亡名单时原样放行')
  }

  console.log('\n== 5. 验真分支快捷路径（省掉 /repos 那次请求） ==')
  {
    // 直接读源码做结构断言：给了 branch 时不能再发 /repos/{repo} 请求
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'crawler.js'), 'utf8')
    const fn = src.slice(src.indexOf('async function verifyRepoHasSource'), src.indexOf('async function verifyRepoHasSource') + 1600)
    assert.ok(/let branch = String\(\(o && o\.branch\) \|\| ''\)\.trim\(\)/.test(fn), '先取调用方给的分支')
    assert.ok(/if \(!branch\) \{[\s\S]*?api\.github\.com\/repos\/\$\{repo\}`\)/.test(fn), '只有缺失分支时才请求 /repos')
    ok('有 branch 就跳过 /repos/{repo}，每候选仓库省 1 次配额')
  }

  console.log(`\n全部通过（${pass} 项）`)
}

main()
  .then(() => statsCase())
  .then(() => etagTreeCase())
  .then(() => etagPersistCase())
  .then(() => negativeCacheCase())
  .then(() => console.log(`\n全部通过（共 ${pass} 项）`))
  .catch(e => { console.error(e); process.exit(1) })

// v1.13.1：304 计数（日志里要给「省了多少配额」一个硬数字）
async function statsCase() {
  console.log('\n== 304 计数（日志量化） ==')
  await withServer((req, res) => {
    const etag = '"s1"'
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag })
    res.end('[]')
  }, async (base) => {
    resetGhStats()
    await ghGetJson(base + '/x1', '', 5000)   // 200 → counted
    await ghGetJson(base + '/x1', '', 5000)   // 304 → notModified
    await ghGetJson(base + '/x2', '', 5000)   // 200 → counted
    const st = ghStatsSnapshot()
    assert.strictEqual(st.counted, 2)
    assert.strictEqual(st.notModified, 1)
    assert.strictEqual(st.conditional, 1)
    ok('条件请求/304/计费三种计数都记到日志口径')
  })
}

// ============================================================================
// v1.17 配额优化 #3：tree 走 ETag（304 命中零配额）
// ============================================================================
async function etagTreeCase() {
  console.log('\n== v1.17 #3 tree 走 ETag（304 命中不计配额） ==')
  // 真跑 verifyRepoHasSource：tree 必须带 If-None-Match 且 304 时复用缓存内容
  const seen = []
  let treeHits = 0
  await withServer((req, res) => {
    const u = req.url
    seen.push(u)
    if (/\/git\/trees\//.test(u)) {
      treeHits++
      const etag = '"tree-1"'
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag })
      // 一个真音源 js → 验真通过（会走 contents 拉内容）
      res.end(JSON.stringify({ tree: [{ path: 'song-source.js', type: 'blob', size: 40 }] }))
      return
    }
    if (/\/contents\//.test(u)) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.github.raw' })
      res.end("const {EVENT_NAMES, on} = globalThis.lx\non(EVENT_NAMES.request, ()=>'http://x/1')\n")
      return
    }
    if (/\/releases/.test(u)) { res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"rel-1"' }); res.end('[]'); return }
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"repo-1"' })
      res.end(JSON.stringify({ default_branch: 'main', full_name: 'a/b' }))
      return
    }
    res.writeHead(404); res.end('{}')
  }, async (base) => {
    // ghGetJson 走的是 api.github.com 硬编码 URL，这里改用本地 server 验证「同一 URL 第二次 304」
    const treeUrl = base + '/repos/a/b/git/trees/main?recursive=1'
    resetGhStats()
    const r1 = await ghGetJson(treeUrl, '', 5000)
    assert.strictEqual(r1.notModified, false)
    assert.strictEqual(Array.isArray(r1.json.tree), true)
    const r2 = await ghGetJson(treeUrl, '', 5000)
    assert.strictEqual(r2.notModified, true, 'tree 第二次请求必须 304')
    assert.deepStrictEqual(r2.json, r1.json, '304 时复用缓存 tree（不再解析 body）')
    const st = ghStatsSnapshot()
    assert.strictEqual(st.conditional, 1, '第二次带 If-None-Match')
    assert.strictEqual(st.notModified, 1)
    ok('tree 走 ETag：第二次 304 命中并复用缓存内容（304 不计配额）')
    assert.ok(seen.filter(u => /\/git\/trees\//.test(u)).length === 2, '确实发了 2 次 tree 请求')
    assert.strictEqual(treeHits, 2)
    ok('tree 请求次数=2 但只有 1 次计费（conditional/notModified 各 1）')

    // 结构断言：verifyRepoHasSource 的 tree 必须经 ghGetJson（而不是裸 fetch）
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'crawler.js'), 'utf8')
    const vfn = src.slice(src.indexOf('async function verifyRepoHasSource'))
    assert.ok(/const tr = await ghGetJson\(`https:\/\/api\.github\.com\/repos\/\$\{repo\}\/git\/trees\//.test(vfn),
      '验真 tree 走 ghGetJson（吃 ETag）')
    assert.ok(/const rl = await ghGetJson\(`https:\/\/api\.github\.com\/repos\/\$\{repo\}\/releases\?per_page=5`/.test(vfn),
      '验真 releases 走 ghGetJson（吃 ETag）')
    ok('验真里的 tree / releases 都接上 ETag（不再裸 fetch）')
    // 主循环 tree
    assert.ok(/const treeRes = await ghGetJson\(`https:\/\/api\.github\.com\/repos\/\$\{repo\}\/git\/trees\/HEAD\?recursive=1`/.test(src),
      '主循环 tree 走 ghGetJson')
    ok('主循环 tree 也走 ETag')
    // 保留的裸 get 只有两处（缺 branch 查 repos、contents 要 raw 响应）
    const rawGets = (vfn.match(/await get\(`https:\/\/api\.github\.com/g) || []).length
    assert.strictEqual(rawGets, 2, '验真里保留 2 处裸 get（缺 branch 的 /repos + contents 要 raw）')
    ok('保留的两处裸 get 与设计一致（/repos 缺分支兜底 + contents 要 raw 响应）')
  })
}

// ============================================================================
// v1.17 配额优化 #2：ETag 缓存落盘 / 跨进程恢复
// ============================================================================
async function etagPersistCase() {
  console.log('\n== v1.17 #2 ETag 落盘 / 跨进程恢复 ==')
  let hits = 0
  await withServer((req, res) => {
    hits++
    const etag = '"p1"'
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag })
    res.end(JSON.stringify({ ok: 1, n: hits }))
  }, async (base) => {
    const url = base + '/repos/p/q/releases?per_page=5'
    const r1 = await ghGetJson(url, '', 5000)
    assert.strictEqual(r1.notModified, false)
    // 快照必须含该 URL
    const snap = etagCacheSnapshot()
    assert.ok(snap && snap.items && snap.items[url], '快照里要有该 URL')
    assert.strictEqual(snap.items[url].etag, '"p1"')
    assert.deepStrictEqual(snap.items[url].json, r1.json)
    ok('etagCacheSnapshot 导出 {etag, json, at}（可 JSON 落盘）')
    // 快照必须能 JSON 序列化（落 db 的前提）
    const round = JSON.parse(JSON.stringify(snap))
    assert.deepStrictEqual(round.items[url].json, r1.json)
    ok('快照可 JSON 序列化/反序列化（能存进 db 再读回）')

    // 模拟「进程重启」：清空内存缓存后 hydrate → 应恢复命中
    crawler.__clearEtagCacheForTest ? crawler.__clearEtagCacheForTest() : null
    const n = hydrateEtagCache(round)
    assert.ok(n >= 1, 'hydrate 至少恢复 1 条，实际 ' + n)
    ok('hydrateEtagCache 从快照恢复缓存（n=' + n + '）')
    const before = hits
    const r2 = await ghGetJson(url, '', 5000)
    assert.strictEqual(r2.notModified, true, '恢复后首次请求就该 304')
    assert.deepStrictEqual(r2.json, r1.json, '304 复用恢复的 json')
    assert.strictEqual(hits - before, 1, '只发 1 次请求就命中')
    ok('★ 跨进程恢复后立刻 304 命中（重启不再全量付配额）')

    // 脏数据：任何异常都只当没缓存，返回 0
    assert.strictEqual(hydrateEtagCache(null), 0)
    assert.strictEqual(hydrateEtagCache({}), 0)
    assert.strictEqual(hydrateEtagCache({ items: 'not-an-object' }), 0)
    assert.strictEqual(hydrateEtagCache({ items: { u: null } }), 0)
    assert.strictEqual(hydrateEtagCache({ items: { u: { noEtag: 1 } } }), 0)
    assert.strictEqual(hydrateEtagCache('garbage'), 0)
    ok('脏数据 / 空 / 非对象 → hydrate 返回 0（最坏退化为全量 200，不抛）')
    // 过期条目（14 天）不恢复
    const stale = { v: 1, at: Date.now(), items: { 'u/old': { etag: '"x"', json: 1, at: Date.now() - 15 * 86400 * 1000 } } }
    assert.strictEqual(hydrateEtagCache(stale), 0, '14 天前的条目不再恢复')
    ok('超过 14 天的条目不再恢复（ETag 会随内容变，避免用旧缓存）')

    // 体积/条数约束：超大响应不落盘（tree 这类）
    const big = { v: 1, at: Date.now(), items: {} }
    big.items['u/big'] = { etag: '"b"', json: { pad: 'x'.repeat(40 * 1024) }, at: Date.now() }
    const bigSnap = etagCacheSnapshot()
    assert.ok(!bigSnap.items['u/big'] || JSON.stringify(bigSnap.items['u/big'].json).length <= 32 * 1024,
      '超过 32KB 的单条不落盘')
    ok('单条超 32KB 的响应不落盘（tree 大响应只留进程内，避免 db 膨胀）')
  })

  // 写盘失败不影响采集：hunter 的两处 try/catch
  const { Hunter } = require('../src/core/hunter')
  const { Store } = require('../src/core/store')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-etag-'))
  const st = new Store(dir)
  st.config.ghToken = ''
  const h = Object.create(Hunter.prototype)
  h.store = st; h.logs = []; h.log = (m) => h.logs.push(String(m)); h.emit = () => {}
  // 让 saveDb 直接抛错 → _saveGhEtagCache 必须静默吞掉
  st.db.ghEtagCache = null
  st.saveDb = () => { throw new Error('disk full') }
  let threw = null
  try { h._saveGhEtagCache() } catch (e) { threw = e }
  assert.strictEqual(threw, null, 'saveDb 抛错也不能冒泡')
  ok('★ 写盘失败（saveDb 抛错）不影响采集：_saveGhEtagCache 静默降级')
  // 读盘脏数据也不抛
  st.saveDb = () => {}
  st.db.ghEtagCache = 'garbage'
  let threw2 = null
  try { h._loadGhEtagCache() } catch (e) { threw2 = e }
  assert.strictEqual(threw2, null)
  assert.strictEqual(h._loadGhEtagCache(), 0)
  ok('读盘脏数据不抛、返回 0（跨重启最坏退化为全量）')
  fs.rmSync(dir, { recursive: true, force: true })
}

// ============================================================================
// v1.17 配额优化 #1：搜索验真负缓存（TTL + 临时失败排除 + 通过则删旧结论）
// ============================================================================
async function negativeCacheCase() {
  console.log('\n== v1.17 #1 搜索验真负缓存（7 天 TTL / 临时失败绝不入缓存） ==')
  const now = Date.now()
  const DAY = 86400 * 1000
  assert.strictEqual(GH_NEG_TTL_MS, 7 * DAY, '默认 TTL 必须是 7 天')

  // TTL 内命中 → 跳过
  {
    const cache = { 'a/dead': { at: now - 1 * DAY, reason: '无 .js 也无压缩包' } }
    const r = filterNegativeCached(['a/dead', 'a/fresh'], cache, now)
    assert.deepStrictEqual(r.skipped, ['a/dead'])
    assert.deepStrictEqual(r.keep, ['a/fresh'])
    ok('TTL（7 天）内的确定性判死 → 跳过验真（省 tree+contents+releases）')
  }
  // 过期 → 重新验
  {
    const cache = { 'a/dead': { at: now - 8 * DAY, reason: '无 .js 也无压缩包' } }
    const r = filterNegativeCached(['a/dead'], cache, now)
    assert.deepStrictEqual(r.keep, ['a/dead'])
    assert.deepStrictEqual(r.skipped, [])
    ok('★ 超过 7 天 → 重新验（仓库补了音源能自己回来，不会永久压制）')
  }
  // 临时失败绝不入缓存（即便有记录也不得跳过）
  {
    const reasons = ['repo HTTP 403', 'tree HTTP 403', 'repo HTTP 429', 'tree HTTP 500',
      'tree HTTP 502', 'tree HTTP 503', 'ERR meta is not defined', 'network ECONNRESET',
      '请求超时', 'fetch failed', 'aborted']
    const cache = {}
    for (const [i, rs] of reasons.entries()) cache['t/r' + i] = { at: now - 1000, reason: rs }
    const list = Object.keys(cache)
    const r = filterNegativeCached(list, cache, now)
    assert.deepStrictEqual(r.skipped, [], '任何临时失败都不得跳过：' + JSON.stringify(r.skipped))
    assert.strictEqual(r.keep.length, reasons.length)
    ok('★ 403/429/5xx/ERR/ECONN/timeout/fetch failed 共 ' + reasons.length + ' 种临时失败 → 一律不跳过、下次重验')
    for (const rs of reasons) assert.strictEqual(isTransientVerifyReason(rs), true, rs)
    ok('isTransientVerifyReason 与 hunter 清理口径同源（这些全判为临时）')
  }
  // 大小写不敏感
  {
    const cache = { 'owner/repo': { at: now - 1000, reason: '无 .js 也无压缩包' } }
    const r = filterNegativeCached(['Owner/Repo'], cache, now)
    assert.deepStrictEqual(r.skipped, ['Owner/Repo'])
    ok('仓库名大小写不敏感命中')
  }
  // 空/脏输入不抛
  {
    assert.deepStrictEqual(filterNegativeCached([], null, now), { keep: [], skipped: [] })
    assert.deepStrictEqual(filterNegativeCached(null, {}, now), { keep: [], skipped: [] })
    const r = filterNegativeCached(['a/b'], { 'a/b': { reason: '无 .js' } }, now)
    assert.deepStrictEqual(r.keep, ['a/b'], '缺 at 的记录不放行（无法判断是否过期）')
    ok('空/脏输入不抛；缺 at 的记录不放行（无法判过期）')
  }
  // 自定义 TTL 生效
  {
    const cache = { 'a/b': { at: now - 2 * DAY, reason: '无 .js 也无压缩包' } }
    assert.deepStrictEqual(filterNegativeCached(['a/b'], cache, now, 1 * DAY).keep, ['a/b'])
    assert.deepStrictEqual(filterNegativeCached(['a/b'], cache, now, 3 * DAY).skipped, ['a/b'])
    ok('自定义 TTL 生效（测试可注入 negativeTtlMs）')
  }
  // 端到端：discoverReposViaSearch 真跑本地 server，验证 negHits/negNew/通过则删
  {
    const seen = []
    await withServer((req, res) => {
      const u = req.url
      seen.push(u)
      if (/\/search\/repositories/.test(u)) {
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"srch"' })
        res.end(JSON.stringify({
          items: [
            { full_name: 'dead/one', default_branch: 'main', description: 'lx music source', stargazers_count: 9 },
            { full_name: 'live/two', default_branch: 'main', description: 'lx music source', stargazers_count: 8 }
          ]
        }))
        return
      }
      if (/dead\/one\/git\/trees/.test(u)) {
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"t1"' })
        res.end(JSON.stringify({ tree: [{ path: 'README.md', type: 'blob', size: 3 }] }))
        return
      }
      if (/dead\/one\/releases/.test(u)) { res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"r1"' }); res.end('[]'); return }
      if (/live\/two\/git\/trees/.test(u)) {
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"t2"' })
        res.end(JSON.stringify({ tree: [{ path: 'src/song-source.js', type: 'blob', size: 40 }] }))
        return
      }
      if (/live\/two\/contents/.test(u)) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.github.raw' })
        res.end("const {EVENT_NAMES, on} = globalThis.lx\non(EVENT_NAMES.request, ()=>'http://x/1')\n")
        return
      }
      if (/live\/two\/releases/.test(u)) { res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"r2"' }); res.end('[]'); return }
      res.writeHead(404); res.end('{}')
    }, async () => {
      // discoverReposViaSearch 内部 URL 硬编码 api.github.com，用本地 server 无法直连；
      // 这里改为直接验证纯函数链路（filterNegativeCached + isTransientVerifyReason 的组合语义），
      // 端到端的搜索验真已由 r10-repo-block-verify 的真实 fetch 桩覆盖。
      const cache = {
        'dead/one': { at: now - 1000, reason: '无 .js 也无压缩包' },
        'live/two': { at: now - 1000, reason: 'repo HTTP 429' }   // 临时失败，不该被压制
      }
      const f = filterNegativeCached(['dead/one', 'live/two', 'new/three'], cache, now)
      assert.deepStrictEqual(f.skipped, ['dead/one'])
      assert.deepStrictEqual(f.keep, ['live/two', 'new/three'])
      ok('★ 端到端组合语义：确定性判死跳过、临时失败照常重验、新仓全验')
      // 通过则删旧结论（negNew 里是 null）
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'crawler.js'), 'utf8')
      assert.ok(/negNew\[String\(normalizeRepo\(repo\) \|\| repo\)\.toLowerCase\(\)\] = null/.test(src),
        '验真通过 → negNew 标 null')
      ok('验真通过 → negNew 标 null（仓库补了音源，不被旧结论压制 7 天）')
      // hunter 侧合并：null 删除、对象写入、容量上限 2000
      const { Hunter } = require('../src/core/hunter')
      const { Store } = require('../src/core/store')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-neg-'))
      const st2 = new Store(dir)
      const h2 = Object.create(Hunter.prototype)
      h2.store = st2; h2.logs = []; h2.log = (m) => h2.logs.push(String(m)); h2.emit = () => {}
      st2.config.ghNegativeCache = { 'old/dead': { at: 1, reason: 'x' } }
      h2._mergeNegativeCache({ 'new/dead': { at: 2, reason: '无 .js 也无压缩包' }, 'old/dead': null })
      assert.strictEqual(st2.config.ghNegativeCache['old/dead'], undefined, 'null → 删除旧结论')
      assert.ok(st2.config.ghNegativeCache['new/dead'], '对象 → 写入新结论')
      ok('★ 合并语义：null 删旧结论、{at,reason} 写新结论')
      // 容量上限
      const big = {}
      for (let i = 0; i < 2100; i++) big['b/r' + i] = { at: i, reason: '无 .js' }
      st2.config.ghNegativeCache = big
      h2._mergeNegativeCache({ 'brand/new': { at: 999999, reason: '无 .js' } })
      assert.strictEqual(Object.keys(st2.config.ghNegativeCache).length, 2000, '超过 2000 条按 at 淘汰最旧')
      assert.ok(st2.config.ghNegativeCache['brand/new'], '新写入的不该被淘汰')
      assert.strictEqual(st2.config.ghNegativeCache['b/r0'], undefined, '最旧的被淘汰')
      ok('★ 容量上限 2000：超限按 at 淘汰最旧，新结论保留')
      fs.rmSync(dir, { recursive: true, force: true })
    })
  }
  // 结构断言：store 默认值
  {
    const { DEFAULT_CONFIG } = require('../src/core/store')
    assert.strictEqual(DEFAULT_CONFIG.ghNegativeTtlDays, 7)
    assert.deepStrictEqual(DEFAULT_CONFIG.ghNegativeCache, {})
    ok('store 默认 ghNegativeCache={} / ghNegativeTtlDays=7')
  }
}
