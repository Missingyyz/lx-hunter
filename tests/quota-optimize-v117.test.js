'use strict'
/**
 * v1.17 配额优化专项：④ prune 跳过已死仓改名 / ⑤ 重启防重复整轮
 *
 * 这两项的共同点：不改判定结果，只砍「没意义的请求」和「重复的整轮」，
 * 因此断言必须同时证明「省了」和「结果没变」——只证明省了会掩盖漏判。
 *
 * 零框架，真实 Store 临时目录 + Hunter.prototype，本文件全程不联网
 * （prune 的验真走 _verifyRepoCached，用桩替换 verifyRepoHasSource 的返回）。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const { Store } = require(path.join(ROOT, 'src', 'core', 'store'))
const { Hunter } = require(path.join(ROOT, 'src', 'core', 'hunter'))

let pass = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra !== undefined ? '  -> ' + extra : '')) } else {
    fails.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : ''))
  }
}
function section (t) { console.log('\n=== ' + t + ' ===') }

function mkStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-q17-'))
  const st = new Store(dir)
  st.config.repos = []
  st.config.repoAiHints = {}
  st.config.blockedRepos = []
  st.config.blockedMeta = {}
  st.config.aiReview = JSON.parse(JSON.stringify(st.config.aiReview))
  st.config.ghNegativeCache = {}
  return { st, dir }
}
function mkHunter (st) {
  const h = Object.create(Hunter.prototype)
  h.store = st; h.emit = () => {}; h.logs = []
  h.log = (m) => h.logs.push(String(m))
  h.job = { running: false, cancel: false, progress: {}, step: '' }
  return h
}
const HOUR = 3600 * 1000

;(async () => {
  // ====================================================================
  section('④ prune 跳过已死仓的改名探测（省 GET /repos/{repo}，结果不变）')
  // ====================================================================
  {
    // 桩：验真结论直接给，避免联网。dead/x 确定性判死，live/y 通过。
    const { st, dir } = mkStore()
    const h = mkHunter(st)
    st.config.repos = [
      { repo: 'dead/x', enabled: true, builtin: false, origin: 'discovered' },
      { repo: 'live/y', enabled: true, builtin: false, origin: 'discovered' }
    ]
    for (const r of ['dead/x', 'live/y']) {
      const id = r + '::s.js'
      st.db.sources[id] = { id, repo: r, deep: { platforms: [{ status: 'ok' }] } }
    }
    st.saveConfig(); st.saveDb()
    // 覆盖 _verifyRepoCached：dead/x 判死，live/y 通过
    h._verifyRepoCached = async (repo) => (/^dead\//.test(repo)
      ? { ok: false, reason: '无 .js 也无压缩包', score: 0 }
      : { ok: true, reason: '含音源脚本', score: 7 })
    // 记录改名探测真正发出的请求（resolveRepoRename 走 ghGetJson → 这里用 fetch 桩计数）
    const asked = []
    const saved = globalThis.fetch
    globalThis.fetch = async (url) => {
      asked.push(String(url))
      // 404 → 视为「没改名」，任何探测都不误判
      return new Response('{"message":"Not Found"}', { status: 404 })
    }
    const out = await h.pruneNonSourceRepos({})
    globalThis.fetch = saved
    ok('④ 已死仓仍被清理（结果不变）',
      out.removedRepos.length === 1 && out.removedRepos[0] === 'dead/x', JSON.stringify(out.removedRepos))
    ok('④ 活仓留在清单（结果不变）',
      st.config.repos.some(x => x.repo === 'live/y') && !st.config.repos.some(x => x.repo === 'dead/x'),
      JSON.stringify(st.config.repos.map(x => x.repo)))
    const probeUrls = asked.filter(u => /api\.github\.com\/repos\/[^/]+\/[^/?]+$/.test(u))
    ok('★ ④ 改名探测只对活仓发请求（dead/x 一个都没问）',
      !probeUrls.some(u => /dead\/x/.test(u)), 'probes=' + JSON.stringify(probeUrls))
    ok('④ 活仓的改名探测照常发（没有把该省的也省掉）',
      probeUrls.some(u => /live\/y/.test(u)), 'probes=' + JSON.stringify(probeUrls))
    ok('④ 日志里说明了跳过数量（可排查）',
      h.logs.some(m => /改名探测：跳过 1 个已判死的仓库/.test(m)), JSON.stringify(h.logs.filter(m => /改名探测/.test(m))))
    // 源码结构：deadSet 用 batch 过滤
    const hSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'hunter.js'), 'utf8')
    ok('④ 源码：deadSet + renameTargets 过滤存在',
      /const deadSet = new Set\(dead\.map/.test(hSrc) && /const renameTargets = batch\.filter\(r => !deadSet\.has/.test(hSrc))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ====================================================================
  section('⑤ 重启防重复整轮（crawlAttemptInterrupted）')
  // ====================================================================
  {
    const { st, dir } = mkStore()
    const h = mkHunter(st)
    const now = 1795000000000
    // ① 正常收尾：lastAttempt 早、nextAt 在它之后 → 不算被打断
    st.db.crawlLastAttempt = now - 40 * 60 * 1000
    st.db.crawlNextAt = now - 30 * 60 * 1000
    let r = h.crawlAttemptInterrupted(now)
    ok('⑤ 正常收尾过的一轮 → 不算被打断', r.interrupted === false, JSON.stringify(r))
    // ② 刚开跑即被杀：lastAttempt 3 分钟前、nextAt 还停在上上轮 → 判定被打断
    st.db.crawlLastAttempt = now - 3 * 60 * 1000
    st.db.crawlNextAt = now - 5 * HOUR
    r = h.crawlAttemptInterrupted(now)
    ok('★ ⑤ 开跑 3 分钟后被杀（nextAt 落后于 lastAttempt）→ 判定被打断',
      r.interrupted === true, JSON.stringify(r))
    // ③ 窗口边界：>10 分钟不再算（可能只是长时间正常跑的仓，不能一直压制）
    st.db.crawlLastAttempt = now - 11 * 60 * 1000
    st.db.crawlNextAt = now - 5 * HOUR
    r = h.crawlAttemptInterrupted(now)
    ok('⑤ 超过 10 分钟窗口 → 不压制（避免误伤长任务）', r.interrupted === false, JSON.stringify(r))
    // ④ 自定义窗口
    r = h.crawlAttemptInterrupted(now, 20 * 60 * 1000)
    ok('⑤ 窗口可注入（测试/运维可调）', r.interrupted === true, JSON.stringify(r))
    // ⑤ 没有 lastAttempt（全新安装）→ 不打断
    st.db.crawlLastAttempt = 0
    r = h.crawlAttemptInterrupted(now)
    ok('⑤ 全新安装（无 crawlLastAttempt）→ 不打断', r.interrupted === false, JSON.stringify(r))
    // ⑥ nextAt 恰等于 lastAttempt → 不算打断（< 而非 <=）
    st.db.crawlLastAttempt = now - 2 * 60 * 1000
    st.db.crawlNextAt = now - 2 * 60 * 1000
    r = h.crawlAttemptInterrupted(now)
    ok('⑤ nextAt === lastAttempt → 不算打断（边界用严格小于）', r.interrupted === false, JSON.stringify(r))
    // ⑦ clock skew：lastAttempt 在未来 → ageMs<0 → 不打断（避免负数把窗口算成负）
    st.db.crawlLastAttempt = now + 5 * 60 * 1000
    st.db.crawlNextAt = now - 5 * HOUR
    r = h.crawlAttemptInterrupted(now)
    ok('⑤ lastAttempt 在未来（时钟回拨）→ 不打断，不崩', r.interrupted === false, JSON.stringify(r))
    // ⑧ 源码：只拦定时器，手动采集不受限
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
    const webSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
    ok('⑤ main/index.js 接了 crawlAttemptInterrupted 并 return（拦定时器）',
      /const chk = hunter\.crawlAttemptInterrupted\(\)/.test(mainSrc) &&
      /if \(chk\.interrupted\) \{[\s\S]{0,400}return/.test(mainSrc))
    ok('⑤ server/web.js 同样接了（两端一致）',
      /crawlAttemptInterrupted\(\)/.test(webSrc))
    // 手动采集路径里不该出现这个判断
    const manualIdx = mainSrc.indexOf("ipcMain.handle('crawl:start'")
    const manualSlice = manualIdx >= 0 ? mainSrc.slice(manualIdx, manualIdx + 2500) : ''
    ok('★ ⑤ 手动采集（crawl:start）不受 crawlAttemptInterrupted 限制',
      !/crawlAttemptInterrupted/.test(manualSlice),
      'manual handler found=' + (manualIdx >= 0))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ====================================================================
  section('③ R10 与 prune 共享同一份验真缓存（同一批仓只花一次配额）')
  // ====================================================================
  {
    const { st, dir } = mkStore()
    const h = mkHunter(st)
    st.config.aiReview.enabled = true
    st.config.aiReview.allowIrreversible = true
    st.config.aiReview.autoActions.R10 = true
    st.config.aiReview.autoActions.irreversible = true
    st.config.aiReview.evalVerdictR10 = '达标'
    st.config.repos = [{ repo: 'shared/repo', enabled: true, builtin: false, origin: 'discovered' }]
    const id = 'shared/repo::s.js'
    st.db.sources[id] = { id, repo: 'shared/repo', deep: { platforms: [{ status: 'dead' }] } }
    st.config.repoAiHints['shared/repo'] = { cls: 'tool', at: 1 }
    st.saveConfig(); st.saveDb()
    let calls = 0
    const answers = { n: 0 }
    h._repoVerifyCache = new Map()
    // 真实 _verifyRepoCached 会调 verifyRepoHasSource（联网）；用 fetch 桩让它真跑但还是断网
    const saved = globalThis.fetch
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (/\/git\/trees\//.test(u)) { calls++; answers.n++; return new Response(JSON.stringify({ tree: [{ path: 'README.md', type: 'blob', size: 3 }] }), { status: 200 }) }
      if (/\/releases/.test(u)) { calls++; return new Response('[]', { status: 200 }) }
      if (/\/repos\//.test(u)) { calls++; return new Response(JSON.stringify({ default_branch: 'main', full_name: 'shared/repo' }), { status: 200 }) }
      return new Response('{}', { status: 200 })
    }
    const outB = await h.pruneAiRepos({ _internal: true })
    const afterR10 = calls
    ok('③ R10 真跑了验真（产生了请求）', afterR10 > 0, 'requests=' + afterR10)
    ok('③ R10 拿到确定性结论并拉黑', outB.blocked.length === 1, JSON.stringify(outB.blocked))
    // 再跑 pruneNonSourceRepos：该仓已被 blockRepo 移出清单，prune 不会再验它
    const outC = await h.pruneNonSourceRepos({})
    const afterPrune = calls
    ok('★ ③ R10 拉黑后该仓已移出清单 → prune 不再重复验（0 次新增请求，双重省配额）',
      afterPrune === afterR10 && outC.removedRepos.length === 0,
      'r10=' + afterR10 + ' afterPrune=' + afterPrune + ' removed=' + JSON.stringify(outC.removedRepos))
    // 缓存本身的可复用性：同一仓连问两次只付一次配额（30min TTL）
    h._repoVerifyCache = new Map()
    const before2 = calls
    const v1 = await h._verifyRepoCached('shared/repo', st.config)
    const mid2 = calls
    const v2 = await h._verifyRepoCached('shared/repo', st.config)
    const after2 = calls
    ok('★ ③ _verifyRepoCached 30min TTL 命中：第二次问同一仓 0 次新增请求',
      mid2 > before2 && after2 === mid2, 'first=' + (mid2 - before2) + ' second=' + (after2 - mid2))
    ok('③ 缓存命中返回同一结论（不改变判定）',
      JSON.stringify(v1) === JSON.stringify(v2) && v1.ok === false, JSON.stringify(v1) + ' vs ' + JSON.stringify(v2))
    ok('③ 缓存里只有 1 条（按 repo 小写去重）', h._repoVerifyCache.size === 1, 'size=' + h._repoVerifyCache.size)
    globalThis.fetch = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ====================================================================
  section('ETag 落盘接入点（runCrawl 前后各一次）')
  // ====================================================================
  {
    const hSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'hunter.js'), 'utf8')
    const loadIdx = hSrc.indexOf('this._loadGhEtagCache()', hSrc.indexOf('async runCrawl('))
    const saveIdx = hSrc.indexOf('this._saveGhEtagCache()', hSrc.indexOf('async runCrawl('))
    ok('runCrawl 开跑时加载 ETag 缓存（_loadGhEtagCache）', loadIdx > 0)
    ok('runCrawl finally 落盘 ETag 缓存（_saveGhEtagCache）', saveIdx > loadIdx && saveIdx > 0)
    ok('加载在爬取主流程之前（loadIdx < saveIdx）', loadIdx < saveIdx, 'load=' + loadIdx + ' save=' + saveIdx)
    ok('落盘在一轮只写一次（finally 里调用，不在循环内）',
      /finally \{[\s\S]{0,300}this\._saveGhEtagCache\(\)/.test(hSrc))
  }

  console.log('\n===== RESULT pass=' + pass + ' fail=' + fails.length + ' =====')
  if (fails.length) { console.log('FAILS:'); fails.forEach(f => console.log('  - ' + f)) }
  process.exit(fails.length ? 1 : 0)
})().catch(e => { console.error('TEST_EXCEPTION', e); process.exit(2) })
