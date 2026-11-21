'use strict'
/**
 * R10（v1.16 / v1.16.1）仓库级「AI 判非音源 → 拉黑」专项验证
 *
 * 本轮修复点（对应 hunter.js / aiReview.js / store.js）：
 *  阻断① 可用音源数改按 deep.platforms 实测累加；验真改真实 verifyRepoHasSource。
 *  阻断② blockedMeta 的 key 统一小写 + findBlockedMetaKey 大小写不敏感兼容老原形 key。
 *  ③   snapshot 改 Set 合并（拉黑→解除→再拉黑不丢首轮记录）。
 *  ④   _pruneNonSourceRepos 改走 blockRepo 单一写路径（_internal 绕 jobGate）。
 *  ⑤   needsEval 加 R10；不可逆类 evalVerdict 缺省即拒。
 *  ⑥   R9 → R10 全量改名。
 *  v1.16.1（功能体检）：crawler.verifyRepoHasSource 的 meta 提到函数作用域 +
 *       full_name 兜底（修掉"无 .js 无压缩包"路径的 ReferenceError，见 Part 4c）；
 *       main/web ②段改用独立水位 db.aiR10LastAt 并补 cfg.autoEnabled 校验；
 *       前端接 metaFound===false → warn 提示（见 Part 9 / Part 10）。
 *
 * 结构（零框架，真实 Store 临时目录 + Hunter.prototype + 真实 crawler 函数，全程不联网）：
 *  Part 1 ★可回滚真跑：大小写混合拉黑 → 三种传参（小写/原形/混合）都要 metaFound:true + restoredIds>0
 *  Part 2 老原形 key（历史数据）兼容；跨仓不误删；snapshot Set 合并
 *  Part 3 ★临时失败不拉黑：403/429/5xx/timeout/抛异常 → verifyHasSource 不成立 → 不拉黑；TTL 生效且不缓存临时失败
 *  Part 4 ★_pruneNonSourceRepos 等价性：移清单/删脚本/removedRepos/removedSources 数值等价 + 可 unblock 回滚 + _internal 绕 jobGate
 *         4c ★v1.16.1 验真 meta 修复：空树仓不再抛错、prune 真判死、R10 真拉黑、传/不传 branch 判据一致
 *  Part 5 evalVerdict 缺省即拒 / '未评测'拒 / '达标'放行
 *  Part 6 三重旁证真 AND + 默认关兜死 + blockedRepos 结构 + 建议层不写黑名单
 *  Part 7 countUsableByDeep 真实口径（deep.platforms 累加，不用 e.usable）
 *  Part 8 R9→R10 改名彻底性（AI 侧无残留 R9 授权位；R9 仍是追更链域名校验）
 *  Part 9 db.aiR10LastAt 水位：首次必跑 / 未到期不重跑 / 到期可跑 / 与③段解耦 / 忙时不推进 / autoEnabled 校验
 *  Part 10 前端 metaFound===false → warn 分支（历史拉黑数据无快照）
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CORE = (n) => path.join(ROOT, 'src', 'core', n)
const { Store, DEFAULT_CONFIG } = require(CORE('store'))
const { Hunter } = require(CORE('hunter'))
const { AIReview } = require(CORE('aiReview'))
const crawler = require(CORE('crawler'))

let pass = 0, fail = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  -> ' + extra : '')) }
  else { fail++; fails.push(name + (extra ? '  :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')) }
}
const section = (t) => console.log('\n=== ' + t + ' ===')

function mkStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-r10-'))
  const st = new Store(dir)
  // ★ Store 是浅拷贝 DEFAULT_CONFIG：repos / repoAiHints / blockedRepos / blockedMeta / aiReview
  //   这些容器都与模块级默认对象共享同一引用，多个实例会互相串（实测：前一个用例 addRepo 的仓库
  //   出现在后一个用例的 config.repos 里）。这里一次性换成各实例独占的新容器，保证用例间隔离。
  st.config.repos = []
  st.config.repoAiHints = {}
  st.config.blockedRepos = []
  st.config.blockedMeta = {}
  st.config.aiReview = JSON.parse(JSON.stringify(st.config.aiReview))
  st.config.aiFollowVeto = 'off'
  return { st, dir }
}
function mkHunter (st) {
  const h = Object.create(Hunter.prototype)
  h.store = st
  h.emit = () => {}
  h.logs = []
  h.log = (msg, mod, level) => { h.logs.push({ msg: String(msg), mod, level }) }
  h.job = { running: false, cancel: false, progress: {}, step: '' }
  h.batchId = 'r10-test'
  return h
}
function cleanup (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {} }

// 造 N 个属于某 repo 的脚本入库（tag 区分批次，避免 id 撞车）
function seedScripts (st, repo, n, opt) {
  const o = opt || {}
  const tag = o.tag ? String(o.tag) : ''
  const ids = []
  for (let i = 0; i < n; i++) {
    const id = repo + '::' + tag + 'src' + i + '.js'
    const e = { id, repo, name: 'src' + i, lxName: 'src' + i, scriptName: 'src' + i,
      apiHosts: [], updateTips: [], status: 'ok', usable: !!o.usable, deprecated: false, contentHash: 'sha' + i }
    if (o.deep) e.deep = o.deep
    st.db.sources[id] = e
    ids.push(id)
  }
  st.saveDb()
  return ids
}
// 往仓库清单加一条
function addRepo (st, repo, origin) {
  if (!Array.isArray(st.config.repos)) st.config.repos = []
  st.config.repos.push({ repo, enabled: true, builtin: false, origin: origin || 'discovered' })
  st.saveConfig()
}

function main () {
  ;(async () => {
    // ★ 快照：Store 是浅拷贝 DEFAULT_CONFIG（aiReview 内部对象共享引用），后面对
    // st.config.aiReview.* 的写入会污染 DEFAULT_CONFIG。所以"默认值"必须在任何写操作之前取快照。
    const DEF = {
      R10: DEFAULT_CONFIG.aiReview.autoActions.R10,
      R9: DEFAULT_CONFIG.aiReview.autoActions.R9,
      allowIrreversible: DEFAULT_CONFIG.aiReview.allowIrreversible,
      irreversible: DEFAULT_CONFIG.aiReview.autoActions.irreversible
    }

    // ==================================================================
    section('Part 1 ★ 可回滚真跑：大小写混合 → 三种传参都要 metaFound:true + restoredIds>0')
    // ==================================================================
    {
      const cases = [
        ['小写传参', 'Owner/Repo', 'owner/repo'],
        ['原形传参', 'Owner/Repo', 'Owner/Repo'],
        ['混合传参', 'Owner/Repo', 'OWNER/rePo']
      ]
      for (const [label, storedForm, unblockArg] of cases) {
        const { st, dir } = mkStore()
        const h = mkHunter(st)
        const N = 3
        const ids = seedScripts(st, storedForm, N)
        addRepo(st, storedForm, 'discovered')
        const r = h.blockRepo(storedForm, { by: 'user', reason: 'R10 可回滚验证' })
        const metaKey = Object.keys(st.config.blockedMeta)[0]
        const metaRepo = (st.config.blockedMeta[metaKey] || {}).repo
        const u = h.unblockRepo(unblockArg, true)
        ok('[' + label + '] blockRepo 清掉 ' + N + ' 条脚本（removedSources=' + r.removedSources + '）', r.removedSources === N)
        ok('[' + label + '] blockedMeta key 为小写（' + metaKey + '）', metaKey === 'owner/repo')
        ok('[' + label + '] blockedMeta.repo 保留原形（' + metaRepo + '）', metaRepo === storedForm, 'key=' + metaKey)
        ok('[' + label + '] ★ unblockRepo(' + unblockArg + ') metaFound:true', u.metaFound === true, JSON.stringify({ metaFound: u.metaFound, restoredIds: u.restoredIds }))
        ok('[' + label + '] ★ unblockRepo restoredIds=' + N, u.restoredIds === N, 'restored=' + u.restoredIds)
        ok('[' + label + '] 解除后 deletedIds 不含这些 id（可重采）',
          ids.every(id => !st.deletedIds().includes(id)), 'deleted=' + JSON.stringify(st.deletedIds()))
        ok('[' + label + '] 解除后 _undeleted 不再拦（' + N + '/' + N + '）',
          st._undeleted(ids.map(id => ({ id, repo: storedForm, name: id }))).length === N)
        ok('[' + label + '] 解除后 blockedRepos 与 blockedMeta 均已清空',
          st.config.blockedRepos.length === 0 && Object.keys(st.config.blockedMeta).length === 0)
        cleanup(dir)
      }
    }

    // ==================================================================
    section('Part 2 老原形 key 兼容 / 跨仓不误删 / snapshot Set 合并')
    // ==================================================================
    // 2a 历史数据：老版本写的 blockedMeta key 是仓库原形（含大写），现在按任意大小写解除都要命中
    {
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      const repo = 'Legacy/Owner-Repo'
      const N = 2
      const ids = seedScripts(st, repo, N)
      addRepo(st, repo)
      // 手工模拟"老数据"：blockedRepos 小写、blockedMeta 原形 key（旧实现写的是 name 原形）
      st.config.blockedRepos = ['legacy/owner-repo']
      st.config.blockedMeta = {
        'Legacy/Owner-Repo': { repo: 'Legacy/Owner-Repo', by: 'user', reason: '老数据', at: Date.now(), snapshot: ids.slice() }
      }
      st.db.deletedIds = ids.slice()
      st.saveConfig(); st.saveDb()
      ok('老数据前提：blockedMeta 只有原形 key', Object.keys(st.config.blockedMeta).join(',') === 'Legacy/Owner-Repo')
      const u = h.unblockRepo('legacy/owner-repo', false)
      ok('★ 老原形 key：小写传参也能 metaFound:true', u.metaFound === true, JSON.stringify(u))
      ok('★ 老原形 key：restoredIds=' + N + '（快照没静默丢失）', u.restoredIds === N, 'restored=' + u.restoredIds)
      ok('老原形 key：解除后 deletedIds 清空', st.deletedIds().length === 0, JSON.stringify(st.deletedIds()))
      ok('老原形 key：blockedMeta 已删除（清理掉原形 key）', Object.keys(st.config.blockedMeta).length === 0)
      cleanup(dir)
    }
    // 2b 兼容另一形态：key 是随机形态但 meta.repo 记录原形（比 meta[k].repo 的那条分支）
    {
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      const repo = 'Mixed/Case-Repo'
      const ids = seedScripts(st, repo, 2)
      addRepo(st, repo)
      st.config.blockedRepos = ['mixed/case-repo']
      st.config.blockedMeta = { 'some-legacy-norm-key': { repo: 'Mixed/Case-Repo', by: 'user', at: 1, snapshot: ids.slice() } }
      st.db.deletedIds = ids.slice()
      st.saveConfig(); st.saveDb()
      const u = h.unblockRepo('MIXED/CASE-REPO', false)
      ok('★ 靠 meta.repo 比对的兼容分支：metaFound:true 且 restoredIds=2',
        u.metaFound === true && u.restoredIds === 2, JSON.stringify(u))
      cleanup(dir)
    }
    // 2c 跨仓不误删：解除 A 不影响 B
    {
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      const idsA = seedScripts(st, 'owner/a', 2)
      const idsB = seedScripts(st, 'owner/b', 3)
      addRepo(st, 'owner/a'); addRepo(st, 'owner/b')
      h.blockRepo('owner/a', { by: 'user' })
      h.blockRepo('owner/b', { by: 'user' })
      const u = h.unblockRepo('owner/a', true)
      ok('★ 跨仓不误删：解除 A restoredIds=2', u.restoredIds === 2, 'restored=' + u.restoredIds)
      ok('★ 跨仓不误删：B 的 3 条仍在 deletedIds', idsB.every(id => st.deletedIds().includes(id)) &&
        st.deletedIds().length === idsB.length, 'deleted=' + JSON.stringify(st.deletedIds()))
      ok('★ 跨仓不误删：B 仍被拉黑（blockedRepos/blockedMeta 都还在）',
        st.config.blockedRepos.includes('owner/b') && !!st.config.blockedMeta['owner/b'])
      ok('跨仓不误删：A 的 2 条已可重采', idsA.every(id => !st.deletedIds().includes(id)))
      cleanup(dir)
    }
    // 2d snapshot Set 合并：拉黑 → 部分恢复 → 再拉黑 → 首轮记录仍在
    {
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      const repo = 'owner/merge'
      const first = seedScripts(st, repo, 3)            // 首轮 3 条
      addRepo(st, repo)
      const r1 = h.blockRepo(repo, { by: 'user' })
      ok('合并首轮：snapshot=3', r1.snapshot.length === 3, JSON.stringify(r1.snapshot))
      // 拉黑状态下人为把首轮快照里的 id 从 deletedIds 撤掉一部分（模拟已有部分恢复），
      // 但 blockedMeta.snapshot 仍保留 → 再拉黑时必须合并而不是覆盖
      st.removeDeletedIds(first.slice(0, 2))
      // 再灌入一批新脚本（同 repo，tag 区分避免与首轮 id 撞车），再次拉黑
      const second = seedScripts(st, repo, 2, { tag: 'b' })
      addRepo(st, repo)
      const r2 = h.blockRepo(repo, { by: 'user' })
      const snap = st.config.blockedMeta['owner/merge'].snapshot
      ok('★ snapshot Set 合并：再拉黑后 snapshot 含首轮 3 条 + 第二轮新 2 条 = 5',
        snap.length === 5 && first.every(id => snap.includes(id)) && second.every(id => snap.includes(id)),
        'snap=' + JSON.stringify(snap))
      ok('★ snapshot Set 合并：返回的 snapshot 与落盘一致（' + r2.snapshot.length + '）', r2.snapshot.length === 5)
      ok('snapshot Set 合并：无重复 id（Set 去重生效）', new Set(snap).size === snap.length)
      // 解除后：5 条全部可从 deletedIds 撤销（首轮 2 条已被撤过，removed 只会报实际移除数）
      const u = h.unblockRepo(repo, true)
      ok('snapshot Set 合并：解除后 metaFound:true', u.metaFound === true)
      ok('snapshot Set 合并：解除后 ids 全部不在 deletedIds', [...first, ...second].every(id => !st.deletedIds().includes(id)),
        'deleted=' + JSON.stringify(st.deletedIds()))
      cleanup(dir)
    }

    // ==================================================================
    section('Part 3 ★ 临时失败不拉黑（403/429/5xx/timeout/异常）+ TTL 生效且不缓存临时失败')
    // ==================================================================
    {
      // 用真实 crawler.verifyRepoHasSource，只把最底层 fetch 换成受控桩（不联网）。
      // 每条用例造一个"AI 判 tool + 可用音源 0"的仓，验真返回不同的临时失败 → 必须不拉黑。
      const savedFetch = globalThis.fetch
      let calls = 0
      let mode = '403'
      globalThis.fetch = async () => {
        calls++
        const mk = (status, body) => new Response(String(body == null ? '' : body), { status, headers: { 'content-type': 'application/json' } })
        if (mode === '403') return mk(403, '{"message":"rate limit"}')
        if (mode === '429') return mk(429, '{"message":"too many requests"}')
        if (mode === '500') return mk(500, 'oops')
        if (mode === '503') return mk(503, 'unavailable')
        if (mode === 'timeout') { const e = new Error('请求超时 15000ms'); e.name = 'TimeoutError'; throw e }
        if (mode === 'neterr') { const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e }
        if (mode === 'throw') throw new Error('boom')
        if (mode === 'empty') return mk(200, JSON.stringify({ default_branch: 'main', tree: [] }))
        if (mode === 'ok') return mk(200, JSON.stringify({ default_branch: 'main', tree: [{ path: 'src/song-source.js', type: 'blob', size: 500 }] }))
        return mk(404, '{}')
      }
      const setupRepo = (st, repo) => {
        addRepo(st, repo)
        seedScripts(st, repo, 1, { usable: false })
        st.config.repoAiHints[repo] = { cls: 'tool', reason: 'R10 临时失败用例', at: Date.now() }
        st.config.aiReview.enabled = true
        st.config.aiReview.allowIrreversible = true
        st.config.aiReview.autoActions.R10 = true
        st.config.aiReview.autoActions.irreversible = true
        st.config.aiReview.evalVerdictR10 = '达标'
        st.saveConfig()
      }
      // 3a-3f 各类临时失败。注意 reason 口径：verifyRepo 把临时失败折成 verifyHasSource=undefined，
      // gate 在 needsEval 之后走证据守卫 → 对外统一报「证据缺失，降级人工」（见 Part 6 的
      // verifyHasSource=undefined 用例）。所以这里断言的是「不拉黑 + 计入 skipped」，不是具体网络文案。
      const transients = [
        ['403 限流', '403'],
        ['429 限流', '429'],
        ['500 服务端', '500'],
        ['503 服务端', '503'],
        ['timeout', 'timeout'],
        ['网络异常', 'neterr'],
        ['抛异常', 'throw']
      ]
      for (const [label, m] of transients) {
        const { st, dir } = mkStore()
        const h = mkHunter(st)
        const repo = 'owner/transient-' + m
        setupRepo(st, repo)
        mode = m
        const out = await h.pruneAiRepos({ _internal: true })
        ok('[' + label + '] 不拉黑（blocked 为空）', out.blocked.length === 0 && !st.config.blockedRepos.includes(repo),
          'blocked=' + JSON.stringify(out.blocked))
        ok('[' + label + '] 计入 skipped（未过门控，留建议层）', out.skipped.length === 1,
          'skipped=' + JSON.stringify(out.skipped))
        ok('[' + label + '] 临时期不写缓存（下轮可重试）', h._repoVerifyCache.size === 0,
          'cacheSize=' + h._repoVerifyCache.size)
        ok('[' + label + '] 仓仍在清单、脚本没被删', st.config.repos.some(x => x.repo === repo) && st.getSources().length === 1)
        cleanup(dir)
      }
      // 3a' 底层口径单测：verifyRepoHasSource 对这些失败返回的 reason 各自落在临时失败正则里
      {
        const isTransient = (why) => /HTTP (403|429|5\d\d)|ERR |ECONN|timeout|abort|超时/i.test(String(why || ''))
        const saved = globalThis.fetch
        for (const [label, m, expRe] of [
          ['403', '403', /repo HTTP 403/], ['429', '429', /repo HTTP 429/],
          ['500', '500', /repo HTTP 500/], ['503', '503', /repo HTTP 503/],
          ['timeout', 'timeout', /超时|timeout/i], ['neterr', 'neterr', /ERR |ECONN|fetch failed/i]
        ]) {
          mode = m
          let v
          try { v = await crawler.verifyRepoHasSource('owner/x', {}) } catch (e) { v = { ok: false, reason: 'ERR ' + e.message } }
          ok('底层验真[' + label + '] reason 命中临时失败正则（' + String(v.reason).slice(0, 40) + '）',
            v.ok === false && expRe.test(String(v.reason)) && isTransient(v.reason), 'reason=' + v.reason)
        }
        globalThis.fetch = saved
      }
      // 3g TTL 内复用缓存，不重复请求（用 404 这条确定性失败路径：reason='repo HTTP 404' 非临时）
      {
        const { st, dir } = mkStore()
        const h = mkHunter(st)
        const repo = 'owner/ttl'
        setupRepo(st, repo)
        mode = '404'
        calls = 0
        const out1 = await h.pruneAiRepos({ _internal: true, dryRun: true })
        const callsAfter1 = calls
        const out2 = await h.pruneAiRepos({ _internal: true, dryRun: true })
        const callsAfter2 = calls
        ok('TTL：首轮真实调用了验真（calls=' + callsAfter1 + '）', callsAfter1 > 0)
        ok('★ TTL 30min 内第二轮命中缓存，0 次新请求（calls ' + callsAfter1 + '→' + callsAfter2 + '）', callsAfter2 === callsAfter1,
          'first=' + callsAfter1 + ' second=' + callsAfter2)
        ok('TTL：缓存里存的是确定性结论（ok=false / repo HTTP 404）',
          h._repoVerifyCache.size === 1 && h._repoVerifyCache.get('owner/ttl').v.ok === false &&
          /404/.test(String(h._repoVerifyCache.get('owner/ttl').v.reason)),
          JSON.stringify([...h._repoVerifyCache]))
        ok('TTL：确定性"无音源"→ 三重旁证成立 → dryRun 判定 blocked',
          out1.blocked.length === 1 && out2.blocked.length === 1, 'b1=' + JSON.stringify(out1.blocked))
        // TTL 过期后重新请求（把缓存时间往前推 31 分钟）
        const cached = h._repoVerifyCache.get('owner/ttl')
        cached.at = Date.now() - 31 * 60 * 1000
        calls = 0
        await h.pruneAiRepos({ _internal: true, dryRun: true })
        ok('★ TTL 过期（31min）后重新发起验真请求（calls=' + calls + '）', calls > 0, 'calls=' + calls)
        cleanup(dir)
      }
      // 3h 临时失败不写缓存（下轮可重试）
      {
        const { st, dir } = mkStore()
        const h = mkHunter(st)
        const repo = 'owner/nocache'
        setupRepo(st, repo)
        mode = '429'
        calls = 0
        await h.pruneAiRepos({ _internal: true, dryRun: true })
        const c1 = calls
        ok('★ 临时失败(429)不写缓存（cacheSize=' + h._repoVerifyCache.size + '）', h._repoVerifyCache.size === 0)
        await h.pruneAiRepos({ _internal: true, dryRun: true })
        const c2 = calls - c1
        ok('★ 临时失败下轮会重试（再次发起请求 ' + c2 + ' 次，未被缓存吃掉）', c2 > 0, 'retryCalls=' + c2)
        // 换成确定性失败后：首轮写入缓存，次轮命中缓存不再请求
        mode = '404'
        await h.pruneAiRepos({ _internal: true, dryRun: true })
        const c3 = calls
        await h.pruneAiRepos({ _internal: true, dryRun: true })
        ok('临时失败转为确定性结论后，后续命中缓存（calls 停在 ' + calls + '）', calls === c3 && h._repoVerifyCache.size === 1,
          'c3=' + c3 + ' now=' + calls + ' cache=' + h._repoVerifyCache.size)
        cleanup(dir)
      }
      // 3i 404 是确定性"仓库不存在"→ 会被判死（保守：确认它不属于临时失败口径）
      {
        const { st, dir } = mkStore()
        const h = mkHunter(st)
        const repo = 'owner/notfound'
        setupRepo(st, repo)
        mode = '404'
        const out = await h.pruneAiRepos({ _internal: true })
        ok('404 属确定性失败（repo HTTP 404 非临时）→ 三重旁证成立则真拉黑',
          out.blocked.length === 1 && st.config.blockedRepos.includes(repo), 'blocked=' + JSON.stringify(out.blocked))
        cleanup(dir)
      }
      globalThis.fetch = savedFetch
    }

    // ==================================================================
    section('Part 4 ★ _pruneNonSourceRepos 等价性（改走 blockRepo 后行为是否一致）')
    // ==================================================================
    {
      const savedFetch = globalThis.fetch
      // ★ 构造真正的"确定性判死"：用 6 个不成词义的压缩包 —— verifyRepoHasSource 走
      //   `packs.length && !packOk` 分支返回 ok:false（packs.length>5 时 || 右侧短路，不依赖仓库身份判据）。
      //   选这条路径是为了让「死仓/活仓」的判死原因与仓库名无关，等价性对照更干净。
      //   （v1.16.1 起"空树/无 .js"路径也已修好、能正常返回 ok:false，见 Part 4c。）
      globalThis.fetch = async (url) => {
        const u = String(url)
        const m = u.match(/api\.github\.com\/repos\/([^/]+\/[^/?]+)/)
        const repo = m ? m[1] : ''
        if (/\/git\/trees\//.test(u)) {
          const tree = /alive\/hassource/.test(u)
            ? [{ path: 'src/song-source.js', type: 'blob', size: 400 }]
            : Array.from({ length: 6 }, (_, i) => ({ path: 'data' + i + '.zip', type: 'blob', size: 900 }))
          return new Response(JSON.stringify({ tree }), { status: 200 })
        }
        if (/\/releases/.test(u)) return new Response('[]', { status: 200 })
        if (/\/contents\//.test(u)) {
          return new Response(`const { EVENT_NAMES, on } = globalThis.lx
on(EVENT_NAMES.request, () => 'http://x/1')
`, { status: 200 })
        }
        return new Response(JSON.stringify({ default_branch: 'main', full_name: repo }), { status: 200 })
      }
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      const deadRepo = 'dead/nosource'
      const aliveRepo = 'alive/hassource'
      const deadIds = seedScripts(st, deadRepo, 3)
      const aliveIds = seedScripts(st, aliveRepo, 2)
      addRepo(st, deadRepo, 'discovered')
      addRepo(st, aliveRepo, 'discovered')
      addRepo(st, 'builtin/repo', 'builtin')
      // 黑名单残留脚本：预置黑名单仓库的脚本，验证⓪步清理仍生效
      const leftoverIds = seedScripts(st, 'gone/blocked', 2)
      st.config.blockedRepos = ['gone/blocked']
      st.saveConfig()

      const out = await h.pruneNonSourceRepos({})
      // —— 等价性断言（对应改造前口径：removedRepos / removedSources / 移清单 / 删脚本 / 黑名单）——
      ok('★ 等价性 removedRepos 只含确定性失败的仓（' + JSON.stringify(out.removedRepos) + '）',
        out.removedRepos.length === 1 && out.removedRepos[0] === deadRepo)
      ok('★ 等价性 removedSources = 死仓 3 条 + 黑名单残留 2 条 = 5（实际 ' + out.removedSources + '）',
        out.removedSources === deadIds.length + leftoverIds.length)
      ok('★ 等价性 死仓已移出清单', !st.config.repos.some(x => x.repo === deadRepo))
      ok('★ 等价性 活仓仍在清单（不误删）', st.config.repos.some(x => x.repo === aliveRepo))
      ok('★ 等价性 内置仓仍在清单（不动种子）', st.config.repos.some(x => x.repo === 'builtin/repo'))
      ok('★ 等价性 死仓脚本已清空', deadIds.every(id => !st.db.sources[id]))
      ok('★ 等价性 活仓脚本保留', aliveIds.every(id => !!st.db.sources[id]))
      ok('★ 等价性 死仓已进 blockedRepos（改造前也写黑名单）', st.config.blockedRepos.includes(deadRepo))
      ok('★ 等价性 死仓写了 blockedMeta（新能力：by=user + snapshot）',
        !!st.config.blockedMeta[deadRepo] && st.config.blockedMeta[deadRepo].by === 'user' &&
        st.config.blockedMeta[deadRepo].snapshot.length === 3,
        JSON.stringify(st.config.blockedMeta[deadRepo] && st.config.blockedMeta[deadRepo].snapshot))
      ok('★ 等价性 死仓脚本记入 deletedIds（不再自动回流）', deadIds.every(id => st.deletedIds().includes(id)))
      ok('等价性 checked = 待验真仓数 2（活+死，内置跳过）', out.checked === 2, 'checked=' + out.checked)
      // —— 新能力：prune 拉黑的仓现在能 unblock 恢复 ——
      const u = h.unblockRepo(deadRepo, true)
      ok('★ prune 拉黑的仓可 unblockRepo 恢复（改造前做不到）',
        u.metaFound === true && u.restoredIds === 3, JSON.stringify(u))
      ok('★ 恢复后死仓脚本可重采（deletedIds 已撤）', deadIds.every(id => !st.deletedIds().includes(id)))
      ok('★ 恢复后回到清单 origin=unblocked',
        st.config.repos.some(x => x.repo === deadRepo && x.origin === 'unblocked'))
      // —— 4c ★ v1.16.1 已修：crawler.verifyRepoHasSource 的 meta 作用域缺陷 ——
      //   修复前：meta 声明在 `if (!branch)` 块内，块外的 `looksLikeSourceRepo(meta)` 不可见 →
      //   「无 .js 且无压缩包」（packs.length<=5，含 0 个）一路抛 ReferenceError，被上层包成
      //   'ERR ...' 误判为临时失败 ⇒ prune 漏清理、R10 永远拿不到 verifyHasSource=false。
      //   修复后（crawler.js）：meta 提到函数作用域 + Object.assign 收进 /repos 响应；
      //   并补 full_name 兜底，使「传 branch / 不传 branch」两条路径判据一致。
      //   以下断言如实锁定修复后的新行为（与功能体检描述逐项核对过，实测一致）。
      {
        const crSrc = fs.readFileSync(CORE('crawler.js'), 'utf8')
        const crLines = crSrc.split('\n')
        // 按内容定位（不按固定行号——本轮 src 加了注释行，硬编码行号已偏移）
        const declIdx = crLines.findIndex(l => /^\s*const meta = \{\}\s*$/.test(l))
        const useIdx = crLines.findIndex(l => /looksLikeSourceRepo\(meta\)/.test(l))
        const ifIdx = crLines.findIndex(l => /^\s*if \(!branch\) \{/.test(l))
        ok('★ v1.16.1：meta 在 if (!branch) 块**之前**、函数作用域声明',
          declIdx >= 0 && ifIdx >= 0 && declIdx < ifIdx,
          'declLine=' + (declIdx + 1) + ' ifLine=' + (ifIdx + 1))
        ok('★ v1.16.1：使用点 looksLikeSourceRepo(meta) 仍在（判据未删）',
          useIdx >= 0, 'useLine=' + (useIdx + 1))
        ok('★ v1.16.1：/repos 响应用 Object.assign 收进函数级 meta',
          /Object\.assign\(meta,/.test(crSrc))
        ok('★ v1.16.1：补了 full_name 兜底（保证传/不传 branch 判据一致）',
          /if \(!meta\.full_name && !meta\.name\) meta\.full_name = String\(repo\)/.test(crSrc))

        const saved = globalThis.fetch
        globalThis.fetch = async (url) => {
          const u = String(url)
          const m = u.match(/api\.github\.com\/repos\/([^/]+)\/([^/?]+)$/)
          if (/\/git\/trees\//.test(u)) return new Response(JSON.stringify({ tree: [{ path: 'README.md', type: 'blob', size: 9 }] }), { status: 200 })
          if (/\/releases/.test(u)) return new Response('[]', { status: 200 })
          if (m) return new Response(JSON.stringify({ default_branch: 'main', full_name: m[1] + '/' + m[2] }), { status: 200 })
          return new Response('{}', { status: 200 })
        }
        let v = null
        let threw = null
        try { v = await crawler.verifyRepoHasSource('no/js-repo', {}) } catch (e) { threw = String(e && e.message) }
        ok('★ v1.16.1：空树仓不再抛错，返回 ok:false + 「无 .js 也无压缩包」',
          !threw && v && v.ok === false && /无 \.js 也无压缩包/.test(String(v.reason)),
          threw ? 'threw=' + threw : JSON.stringify(v))
        // 传 branch 那条路径（修复前正是它触发 ReferenceError）
        let v2 = null
        let threw2 = null
        try { v2 = await crawler.verifyRepoHasSource('no/js-repo', { branch: 'main' }) } catch (e) { threw2 = String(e && e.message) }
        ok('★ v1.16.1：传 branch 路径同样不抛错且结论一致',
          !threw2 && v2 && v2.ok === false && v2.reason === v.reason,
          threw2 ? 'threw=' + threw2 : JSON.stringify(v2))
        // full_name 兜底让两条路径判据一致（1 个非语义 zip + 仓名像音源 → 两条都放行）
        const stubZip = async (url) => {
          const u = String(url)
          const m = u.match(/api\.github\.com\/repos\/([^/]+)\/([^/?]+)$/)
          if (/\/git\/trees\//.test(u)) return new Response(JSON.stringify({ tree: [{ path: 'data0.zip', type: 'blob', size: 900 }] }), { status: 200 })
          if (/\/releases/.test(u)) return new Response('[]', { status: 200 })
          if (m) return new Response(JSON.stringify({ default_branch: 'main', full_name: m[1] + '/' + m[2], description: '', topics: [] }), { status: 200 })
          return new Response('{}', { status: 200 })
        }
        globalThis.fetch = stubZip
        const nb = await crawler.verifyRepoHasSource('owner/lx-music-source', {})
        globalThis.fetch = stubZip
        const wb = await crawler.verifyRepoHasSource('owner/lx-music-source', { branch: 'main' })
        ok('★ v1.16.1：full_name 兜底生效——传/不传 branch 判据完全一致（1 个非语义 zip + 仓名像音源 → 均放行压缩包分发）',
          nb.ok === true && wb.ok === true && nb.reason === wb.reason, 'noBranch=' + JSON.stringify(nb) + ' withBranch=' + JSON.stringify(wb))

        // 影响①（修复后）：pruneNonSourceRepos 对空树仓**真判死清理**（不再当临时失败跳过）
        globalThis.fetch = async (url) => {
          const u = String(url)
          const m = u.match(/api\.github\.com\/repos\/([^/]+)\/([^/?]+)$/)
          if (/\/git\/trees\//.test(u)) return new Response(JSON.stringify({ tree: [{ path: 'README.md', type: 'blob', size: 9 }] }), { status: 200 })
          if (/\/releases/.test(u)) return new Response('[]', { status: 200 })
          if (/\/contents\//.test(u)) return new Response('', { status: 200 })
          if (m) return new Response(JSON.stringify({ default_branch: 'main', full_name: m[1] + '/' + m[2] }), { status: 200 })
          return new Response('{}', { status: 200 })
        }
        const { st: stA, dir: dirA } = mkStore()
        const hA = mkHunter(stA)
        seedScripts(stA, 'empty/tree', 1)
        addRepo(stA, 'empty/tree', 'discovered')
        const outA = await hA.pruneNonSourceRepos({})
        ok('★ v1.16.1 影响①：空树仓被真判死清理（removedRepos=1 / skipped=0 / 已移出清单）',
          outA.removedRepos.length === 1 && outA.removedRepos[0] === 'empty/tree' && outA.skipped === 0 &&
          !stA.config.repos.some(x => x.repo === 'empty/tree'),
          'removedRepos=' + JSON.stringify(outA.removedRepos) + ' skipped=' + outA.skipped +
          ' repos=' + JSON.stringify(stA.config.repos.map(x => x.repo)))
        // 影响②（修复后）：R10 对空树仓**能拿到 verifyHasSource=false → 真拉黑**
        const stB = mkStore()
        const hB = mkHunter(stB.st)
        addRepo(stB.st, 'empty/tree', 'discovered')
        seedScripts(stB.st, 'empty/tree', 1)
        stB.st.config.repoAiHints['empty/tree'] = { cls: 'tool', at: 1 }
        stB.st.config.aiReview.enabled = true
        stB.st.config.aiReview.allowIrreversible = true
        stB.st.config.aiReview.autoActions.R10 = true
        stB.st.config.aiReview.autoActions.irreversible = true
        stB.st.config.aiReview.evalVerdictR10 = '达标'
        stB.st.saveConfig()
        const outB = await hB.pruneAiRepos({ _internal: true })
        ok('★ v1.16.1 影响②：空树仓 R10 真拉黑（blocked=1，三重旁证齐）',
          outB.blocked.length === 1 && outB.blocked[0] === 'empty/tree' &&
          stB.st.config.blockedRepos.includes('empty/tree') && outB.skipped.length === 0,
          JSON.stringify({ blocked: outB.blocked, skipped: outB.skipped }))
        ok('★ v1.16.1 影响②：验真结论已是确定性「无 .js 也无压缩包」（写进缓存，非临时失败）',
          hB._repoVerifyCache.size === 1 &&
          /无 \.js 也无压缩包/.test(String([...hB._repoVerifyCache.values()][0].v.reason)),
          JSON.stringify([...(hB._repoVerifyCache || new Map())]))
        cleanup(stB.dir)
        cleanup(dirA)
        globalThis.fetch = saved
      }
      // —— _internal 确实绕过 jobGate：占着任务位也不自锁 ——
      {
        const { st: st2, dir: dir2 } = mkStore()
        const h2 = mkHunter(st2)
        seedScripts(st2, deadRepo, 2)
        addRepo(st2, deadRepo, 'discovered')
        // 模拟"已在任务位内"：job.running=true（pruneNonSourceRepos 还没占位时由外层占）
        h2.job = { running: true, type: 'crawl', cancel: false, progress: {}, step: '采集' }
        let threw = null
        try { h2.blockRepo(deadRepo, { by: 'user', _internal: true }) } catch (e) { threw = e }
        ok('★ _internal:true 绕过 jobGate（忙时也不抛错、不自锁）', threw === null && st2.config.blockedRepos.includes(deadRepo),
          threw ? String(threw.message) : 'ok')
        // 对照：不传 _internal 时必须被 jobGate 拒绝
        let threw2 = null
        try { h2.blockRepo('other/repo', { by: 'user' }) } catch (e) { threw2 = e }
        ok('★ 对照：不传 _internal 时忙态被 jobGate 拒绝', threw2 !== null && /已有任务在运行/.test(String(threw2.message)),
          threw2 ? String(threw2.message) : 'no-throw')
        // pruneNonSourceRepos 入口本身仍受 jobGate（对用户手动触发要互斥）
        let threw3 = null
        try { await h2.pruneNonSourceRepos({}) } catch (e) { threw3 = e }
        ok('★ pruneNonSourceRepos 入口仍受 jobGate（忙时拒绝）', threw3 !== null && /已有任务在运行/.test(String(threw3.message)),
          threw3 ? String(threw3.message) : 'no-throw')
        cleanup(dir2)
      }
      // pruneAiRepos 外层占位 + finally 回滚
      {
        const { st: st3, dir: dir3 } = mkStore()
        const h3 = mkHunter(st3)
        h3.job = { running: false, type: '', cancel: false, progress: {}, step: '' }
        const before = JSON.stringify(h3.job)
        // 无候选 → 直接返回，也要把任务位回滚
        const o3 = await h3.pruneAiRepos({})
        ok('★ pruneAiRepos 外层占位后 finally 回滚任务位（job.running=false）', h3.job.running === false,
          'job=' + JSON.stringify(h3.job))
        ok('pruneAiRepos 无候选时也走完占位/回滚（checked=0）', o3.checked === 0)
        // 忙态下不传 _internal → 被 jobGate 拒
        h3.job = { running: true, type: 'crawl', cancel: false, progress: {}, step: '采集' }
        let threw = null
        try { await h3.pruneAiRepos({}) } catch (e) { threw = e }
        ok('★ pruneAiRepos 忙态被 jobGate 拒绝（不自锁前先互斥）', threw !== null && /已有任务在运行/.test(String(threw.message)))
        const ok4 = await h3.pruneAiRepos({ _internal: true })
        ok('★ pruneAiRepos _internal:true 在忙态下也能执行（外层已在任务位内）', ok4 && ok4.checked === 0)
        cleanup(dir3)
        void before
      }
      globalThis.fetch = savedFetch
      cleanup(dir)
    }

    // ==================================================================
    section('Part 5 evalVerdict 缺省即拒 / 未评测拒 / 达标放行')
    // ==================================================================
    {
      const mk = (aaa) => {
        const { st, dir } = mkStore()
        st.config.aiReview.enabled = true
        st.config.aiReview.allowIrreversible = true
        st.config.aiReview.autoActions.R10 = true
        st.config.aiReview.autoActions.irreversible = true
        if (aaa && aaa.allowIrreversible !== undefined) {
          st.config.aiReview.allowIrreversible = aaa.allowIrreversible
          // 双锁要真生效：关总锁时把不可逆位也置 false（否则被上面用例留下的 true 掩盖）
          if (!aaa.allowIrreversible) st.config.aiReview.autoActions.irreversible = false
        }
        const a = new AIReview(st)
        const signals = a.collectSignals({ aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, 'R10')
        return { a, signals, st, dir }
      }
      // 缺省（不传 evalVerdict 键）→ 拒
      {
        const { a, signals, dir } = mk()
        const g = a.gate('R10', { signals })
        ok('★ R10 不传 evalVerdict → 拒绝自动（缺评测凭证）', g.auto === false && /缺评测凭证/.test(g.reason || ''), JSON.stringify(g))
        cleanup(dir)
      }
      // 显式传 undefined 也等于缺省 → 拒
      {
        const { a, signals, dir } = mk()
        const g = a.gate('R10', { signals, evalVerdict: undefined })
        ok('★ R10 evalVerdict=undefined → 拒绝（不因"传了键"就放行）', g.auto === false, JSON.stringify(g))
        cleanup(dir)
      }
      // '未评测' → 拒
      {
        const { a, signals, dir } = mk()
        const g = a.gate('R10', { signals, evalVerdict: '未评测' })
        ok('★ R10 evalVerdict=未评测 → 拒绝（评测未达标）', g.auto === false && /评测未达标/.test(g.reason || ''), JSON.stringify(g))
        cleanup(dir)
      }
      // '达标' → 放行
      {
        const { a, signals, dir } = mk()
        const g = a.gate('R10', { signals, evalVerdict: '达标' })
        ok('★ R10 evalVerdict=达标 + 三重旁证齐 → 放行', g.auto === true, JSON.stringify(g))
        cleanup(dir)
      }
      // 对照：可逆类 R4 保持旧口径（不传不阻塞）
      {
        const { st, dir } = mkStore()
        st.config.aiReview.enabled = true
        st.config.aiReview.autoActions.R4 = true
        const a = new AIReview(st)
        const g = a.gate('R4', {})
        ok('对照：可逆类 R4 不传 evalVerdict 仍不阻塞（旧口径未改）', g.auto === true, JSON.stringify(g))
        cleanup(dir)
      }
      // needsIrreversible 双锁：R10=true 但 irreversible 未开 → 拒
      {
        const { a, signals, dir } = mk({ allowIrreversible: false })
        const g = a.gate('R10', { signals, evalVerdict: '达标' })
        ok('★ R10 双锁：irreversible 未开 → 拒（即使评测达标）', g.auto === false && /不可逆/.test(g.reason || ''), JSON.stringify(g))
        cleanup(dir)
      }
      // pruneAiRepos 实际传的是 evalVerdictR10 缺省 '未评测' → 线上默认不自动拉黑
      {
        const { st, dir } = mkStore()
        const h = mkHunter(st)
        addRepo(st, 'owner/default-eval')
        seedScripts(st, 'owner/default-eval', 1)
        st.config.repoAiHints['owner/default-eval'] = { cls: 'tool', at: 1 }
        st.config.aiReview.enabled = true
        st.config.aiReview.allowIrreversible = true
        st.config.aiReview.autoActions.R10 = true
        st.config.aiReview.autoActions.irreversible = true
        st.saveConfig()
        const savedFetch = globalThis.fetch
        // 用 404（确定性"仓库不存在"）构造"证据齐全"的仓：目的是让 gate 走到评测门槛那一层，
        // 断言拒绝原因是「评测未达标」而不是「证据缺失」——故刻意选与验真实现细节无关的路径。
        globalThis.fetch = async () => new Response('{"message":"Not Found"}', { status: 404 })
        const out = await h.pruneAiRepos({ _internal: true })
        ok('★ 未配置 evalVerdictR10（缺省"未评测"）→ 线上默认不自动拉黑',
          out.blocked.length === 0 && out.skipped.length === 1 && /评测未达标/.test(String(out.skipped[0].reason)),
          'checked=' + out.checked + ' skipped=' + JSON.stringify(out.skipped) + ' blocked=' + JSON.stringify(out.blocked) +
          ' hints=' + JSON.stringify(Object.keys(st.config.repoAiHints)) + ' repos=' + JSON.stringify(st.config.repos.map(x => x.repo)))
        globalThis.fetch = savedFetch
        cleanup(dir)
      }
    }

    // ==================================================================
    section('Part 6 三重旁证真 AND + 默认关兜死 + 结构 + 建议层')
    // ==================================================================
    {
      const { st, dir } = mkStore()
      st.config.aiReview.enabled = true
      st.config.aiReview.allowIrreversible = true
      st.config.aiReview.autoActions.R10 = true
      st.config.aiReview.autoActions.irreversible = true
      const a = new AIReview(st)
      const combos = [
        ['只 AI=tool', { aiClass: 'tool', verifyHasSource: true, usableSourceCount: 3 }, false],
        ['缺 aiTool', { aiClass: 'real', verifyHasSource: false, usableSourceCount: 0 }, false],
        ['缺 verifyNoSource（有音源）', { aiClass: 'tool', verifyHasSource: true, usableSourceCount: 0 }, false],
        ['缺 noUsableSource（有可用）', { aiClass: 'tool', verifyHasSource: false, usableSourceCount: 2 }, false],
        ['★ verifyHasSource=undefined（临时失败口径）', { aiClass: 'tool', verifyHasSource: undefined, usableSourceCount: 0 }, false],
        ['三者全满足', { aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, true]
      ]
      for (const [name, facts, exp] of combos) {
        const signals = a.collectSignals(facts, 'R10')
        const g = a.gate('R10', { signals, evalVerdict: '达标' })
        ok('三重旁证 ' + name + ' → auto=' + exp, g.auto === exp, JSON.stringify({ sig: signals.map(s => s.key + '=' + s.ok), gate: g }))
      }
      const sig = a.collectSignals({ aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, 'R10')
      ok('collectSignals(R10) 产出 3 条证据键且顺序稳定',
        sig.length === 3 && sig.map(s => s.key).join(',') === 'aiTool,verifyNoSource,noUsableSource',
        JSON.stringify(sig.map(s => s.key)))
      cleanup(dir)
    }
    // 默认关兜死（三层：默认值 / 归一化 / gate）
    {
      ok('DEFAULT_CONFIG.aiReview.autoActions.R10 === false（进程启动时的初始值）', DEF.R10 === false, String(DEF.R10))
      ok('DEFAULT_CONFIG.aiReview.allowIrreversible === false（初始值）', DEF.allowIrreversible === false, String(DEF.allowIrreversible))
      ok('DEFAULT_CONFIG.aiReview.autoActions.irreversible === false（初始值）', DEF.irreversible === false, String(DEF.irreversible))
      ok('DEFAULT_CONFIG.aiReview.autoActions 无 R9 键（已改名 R10）', DEF.R9 === undefined, String(DEF.R9))
      // ★ 如实记录：Store 是浅拷贝 DEFAULT_CONFIG —— 若不显式换成独占容器，
      //   config.aiReview 与模块级默认是同一对象引用（多实例互相串）。本测试的 mkStore 已隔离，
      //   这里用裸 Store 验证一次该固有特性，验证后立刻还原，避免污染后续用例。
      {
        const dirX = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-r10-share-'))
        const stX = new Store(dirX)
        const sameRef = stX.config.aiReview === DEFAULT_CONFIG.aiReview
        const defBefore = DEFAULT_CONFIG.aiReview.autoActions.R10
        stX.config.aiReview.autoActions.R10 = !defBefore
        const leaked = DEFAULT_CONFIG.aiReview.autoActions.R10 !== defBefore
        DEFAULT_CONFIG.aiReview.autoActions.R10 = defBefore
        stX.config.aiReview.autoActions.R10 = defBefore
        ok('如实记录：裸 Store 的 config.aiReview 与 DEFAULT_CONFIG.aiReview 是同一对象（浅拷贝）',
          sameRef === true, 'sameRef=' + sameRef)
        ok('如实记录：因此多实例会互相串（本测试用 mkStore 显式隔离规避）', leaked === true, 'leaked=' + leaked)
        cleanup(dirX)
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-r10-norm-'))
      const st = new Store(dir)
      st.config.aiReview.allowIrreversible = false
      st.config.aiReview.autoActions.R10 = true
      st.config.aiReview.autoActions.irreversible = true
      st.saveConfig()
      const st2 = new Store(dir)
      ok('★ 归一化：allowIrreversible=false → 重启后 R10 强制 false', st2.config.aiReview.autoActions.R10 === false,
        'R10=' + st2.config.aiReview.autoActions.R10)
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ aiReview: { enabled: true, allowIrreversible: false, autoActions: { clusterLog: true } } }))
      const st3 = new Store(dir)
      ok('★ 老配置缺 R10 键 → 归一化后 false', st3.config.aiReview.autoActions.R10 === false,
        'R10=' + st3.config.aiReview.autoActions.R10)
      cleanup(dir)
      // gate 层默认拒（显式复位，避免被上面用例污染）
      const { st: st4, dir: dir4 } = mkStore()
      st4.config.aiReview.enabled = true
      st4.config.aiReview.allowIrreversible = false
      st4.config.aiReview.autoActions.R10 = false
      st4.config.aiReview.autoActions.irreversible = false
      const a4 = new AIReview(st4)
      const s4 = a4.collectSignals({ aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, 'R10')
      const g4 = a4.gate('R10', { signals: s4, evalVerdict: '达标' })
      ok('★ gate 层：默认授权关 → auto=false（只给意见）', g4.auto === false && /只给意见/.test(g4.reason || ''), JSON.stringify(g4))
      cleanup(dir4)
      // AI 总开关关 → 拒
      const { st: st5, dir: dir5 } = mkStore()
      st5.config.aiReview.enabled = false
      st5.config.aiReview.allowIrreversible = true
      st5.config.aiReview.autoActions.R10 = true
      st5.config.aiReview.autoActions.irreversible = true
      const a5 = new AIReview(st5)
      const s5 = a5.collectSignals({ aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, 'R10')
      const g5 = a5.gate('R10', { signals: s5, evalVerdict: '达标' })
      ok('★ 总开关关 → R10 拒绝（即便其余全开）', g5.auto === false && /总开关/.test(g5.reason || ''), JSON.stringify(g5))
      cleanup(dir5)
    }
    // blockedRepos 结构未破
    {
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      seedScripts(st, 'Owner/X', 2)
      addRepo(st, 'Owner/X')
      h.blockRepo('Owner/X', { by: 'user' })
      ok('blockedRepos 仍是纯字符串数组（小写）',
        Array.isArray(st.config.blockedRepos) && st.config.blockedRepos.every(x => typeof x === 'string') &&
        st.config.blockedRepos.includes('owner/x'), JSON.stringify(st.config.blockedRepos))
      ok('blockedMeta 与 blockedRepos 结构分离（meta 是对象、repo 保留原形）',
        !Array.isArray(st.config.blockedMeta) && st.config.blockedMeta['owner/x'].repo === 'Owner/X')
      const hsrc = fs.readFileSync(CORE('hunter.js'), 'utf8')
      const setCount = (hsrc.match(/new Set\(\(Array\.isArray\(cfg\.blockedRepos\)/g) || []).length
      // 如实口径：源码里对 cfg.blockedRepos 建 Set 的点实际是 4 处（1185/2340/2482/2526），
      // 旧断言写「≥6处」是错的（把 this.store.config.blockedRepos 之类不同写法也算进去了）。
      ok('blockedRepos 的 Set 兼容点 = 4 处（findAll 逐个可构造）', setCount === 4, 'count=' + setCount)
      let setOk = true
      try { const s = new Set(st.config.blockedRepos.map(x => String(x || '').toLowerCase())); setOk = s.has('owner/x') } catch (e) { setOk = false }
      ok('实际 new Set(blockedRepos) 不报错且命中', setOk)
      cleanup(dir)
    }
    // 建议层不写黑名单
    {
      const hsrc = fs.readFileSync(CORE('hunter.js'), 'utf8')
      const i = hsrc.indexOf('_coldStartPrioritizeRepos')
      const j = hsrc.indexOf('\n  async ', i + 10)
      const coldBody = hsrc.slice(i, j > 0 ? j : hsrc.length)
      ok('建议层只写 repoAiHints（cls:\'tool\'）', /cfg\.repoAiHints\[r\] = \{ cls: 'tool'/.test(coldBody))
      ok('建议层跳过非 tool', /c\.class !== 'tool'/.test(coldBody))
      ok('★ 建议层不调 blockRepo', !/blockRepo\(/.test(coldBody))
      ok('★ 建议层不写 blockedRepos / blockedMeta', !/blockedRepos|blockedMeta/.test(coldBody))
      ok('repoAiHints 无 uncertain/real 写入', !/repoAiHints\[[^\]]+\] = \{[^}]*cls:\s*'(uncertain|real)'/.test(hsrc))
    }
    // pruneAiRepos 唯一执行路径都过 gate
    {
      const hsrc = fs.readFileSync(CORE('hunter.js'), 'utf8')
      const i = hsrc.indexOf('async _pruneAiRepos')
      const j = hsrc.indexOf('\n  // ---------------- ', i)
      const body = hsrc.slice(i, j > 0 ? j : hsrc.length)
      ok('_pruneAiRepos 调 collectSignals(facts, \'R10\')', /collectSignals\(facts, 'R10'\)/.test(body))
      ok('_pruneAiRepos 调 gate(\'R10\')', /gate\('R10'/.test(body))
      ok('★ blockRepo(by:\'ai\') 在 gate 之后（唯一执行路径，无旁路）',
        /blockRepo\(repo, \{ by: 'ai'/.test(body) && body.indexOf("gate('R10'") < body.indexOf("blockRepo(repo, { by: 'ai'"))
      ok('gate 未过 → continue（绝不落 blockRepo）', /if \(!g\.auto\) \{ out\.skipped\.push[\s\S]{0,140}continue/.test(body))
      ok('★ blockRepo(by:\'ai\') 带 _internal:true（外层已占任务位）', /by: 'ai'[^}]*_internal: true/.test(body))
    }

    // ==================================================================
    section('Part 7 countUsableByDeep 真实口径（deep.platforms 累加，不看 e.usable）')
    // ==================================================================
    {
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      const repo = 'owner/usable'
      // 3 条脚本：第1条 2 个可用平台、第2条 1 个 usable:true 布尔形态、第3条 0 可用
      st.db.sources['a'] = { id: 'a', repo, deep: { platforms: [{ status: 'usable' }, { status: 'usable' }, { status: 'dead' }] }, usable: false }
      st.db.sources['b'] = { id: 'b', repo, deep: { platforms: [{ usable: true }, { status: 'dead' }] }, usable: false }
      st.db.sources['c'] = { id: 'c', repo, deep: { platforms: [{ status: 'dead' }] }, usable: true }
      // platforms 用对象形态（Map 序列化）
      st.db.sources['d'] = { id: 'd', repo, deep: { platforms: { qq: { status: 'usable' }, wy: { status: 'dead' } } }, usable: false }
      // 其它仓的高可用条目不应混入
      st.db.sources['e'] = { id: 'e', repo: 'other/repo', deep: { platforms: [{ status: 'usable' }] }, usable: true }
      st.saveDb()
      // 直接调用内部实现（与 _pruneAiRepos 内一致的口径）：通过一个可用平台数统计复算
      const countUsable = (low) => {
        let n = 0
        for (const e of st.getSources()) {
          if (!e || !e.deep) continue
          const r = crawler.normalizeRepo(e.repo)
          if (!r || r.toLowerCase() !== low) continue
          const plats = e.deep.platforms
          const arr = Array.isArray(plats) ? plats : (plats && typeof plats === 'object' ? Object.values(plats) : [])
          if (arr.some(p => p && (p.status === 'usable' || p.usable === true))) n++
        }
        return n
      }
      // 与源码逐字比对，确认测试复算没走样
      const hsrc = fs.readFileSync(CORE('hunter.js'), 'utf8')
      const fnBody = (() => { const i = hsrc.indexOf('const countUsableByDeep'); const j = hsrc.indexOf('\n    }', i); return hsrc.slice(i, j) })()
      ok('源码 countUsableByDeep 用 deep.platforms 且判 status==="usable" || usable===true',
        /e\.deep\.platforms/.test(fnBody) && /p\.status === 'usable' \|\| p\.usable === true/.test(fnBody))
      ok('源码 countUsableByDeep 不用 e.usable', !/e\.usable/.test(fnBody))
      const n = countUsable(repo)
      ok('★ 实测累加：该仓可用音源数 = 3（a=2平台但计 1 条、b=布尔 usable 计 1、d=对象形态计 1）', n === 3, 'n=' + n)
      ok('★ 不混入其它仓（other/repo 的可用条目不计入）', countUsable('other/repo') === 1)
      ok('该仓 usableSourceCount>0 → 三重旁证 noUsableSource 不成立 → gate 拒',
        new AIReview(st).collectSignals({ aiClass: 'tool', verifyHasSource: false, usableSourceCount: n }, 'R10')
          .find(s => s.key === 'noUsableSource').ok === false)
      cleanup(dir)
    }

    // ==================================================================
    section('Part 8 R9 → R10 改名彻底性')
    // ==================================================================
    {
      const aiSrc = fs.readFileSync(CORE('aiReview.js'), 'utf8')
      const stSrc = fs.readFileSync(CORE('store.js'), 'utf8')
      const hSrc = fs.readFileSync(CORE('hunter.js'), 'utf8')
      const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
      const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
      const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
      ok('aiReview RISK 有 R10、无 R9 授权位', /R10: \{ level: 'high'/.test(aiSrc) && !/R9: \{ level:/.test(aiSrc))
      ok('aiReview ACTION_KEY 有 R10', /R10: 'R10'/.test(aiSrc) && !/R9: 'R9'/.test(aiSrc))
      ok('aiReview needsEval 含 R10', /kind === 'R10'/.test(aiSrc))
      ok('aiReview FEATURE_EXECUTORS 有 R10', /R10: \{ mode: 'conditional'/.test(aiSrc) && !/R9: \{ mode:/.test(aiSrc))
      ok('aiReview 双锁清零列表用 R10', /next\.autoActions\.R10 = false/.test(aiSrc) && !/next\.autoActions\.R9 = false/.test(aiSrc))
      ok('store 默认 autoActions 含 R10 不含 R9', /\bR10: false/.test(stSrc) && !/\bR9: false/.test(stSrc))
      ok('store 归一化清零 R10', /a\.autoActions\.R10 = false/.test(stSrc))
      ok('hunter 建议层注释/tool 判定写 R10', /走 R10 门控/.test(hSrc))
      ok('main 自动挡判断用 cfg.autoActions.R10', /cfg\.autoActions\.R10 === true/.test(mainSrc) && !/cfg\.autoActions\.R9 === true/.test(mainSrc))
      ok('app.js 回填/提交用 aaR10 与 R10', /aaR10: 'R10'/.test(appSrc) && /R10: !!\(\$\('aaR10'\)/.test(appSrc))
      ok('index.html 有 #aaR10 且默认不勾（无 checked）',
        /id="aaR10"/.test(htmlSrc) && !/id="aaR10"[^>]*checked/.test(htmlSrc))
      ok('index.html 无残留 aaR9', !/id="aaR9"/.test(htmlSrc) && !/aaR9/.test(appSrc))
      ok('R9 仍是追更链域名校验（未被抢走语义）', /R9（v1\.13\.15）：追更链/.test(hSrc))
      ok('hunter 内 R10 拉黑注释齐全（三重旁证 AND）', /R10 三重旁证/.test(hSrc))
    }

    // ==================================================================
    section('Part 9 ★ v1.16.1 水位 db.aiR10LastAt（首次必跑 / 未到期不跑 / 到期可跑 / 与③段解耦 / 忙时不推进 / autoEnabled 校验）')
    // ==================================================================
    // 直接从 main/index.js 与 server/web.js 抽出②段源码，用 new Function 真实执行
    // （不复制逻辑——复制就等于测自己写的副本，抽真源码才测得到实际行为）。
    {
      const SRC_FILES = {
        'main/index.js': path.join(ROOT, 'src', 'main', 'index.js'),
        'server/web.js': path.join(ROOT, 'src', 'server', 'web.js')
      }
      const extract = (src) => {
        const i = src.indexOf('// ② v1.16')
        const j = src.indexOf('// ③ 自动只读复检', i)
        if (i < 0 || j < 0) return null
        return src.slice(i, j)
      }
      const HOUR = 3600 * 1000
      // 用抽取的源码建一个可执行的②段
      const mkRun = (block) => new Function('cfg', 'store', 'plan', 'hunter', 'pushLog', 'Date',
        'return (async () => {' + block + '})()')

      for (const [label, p] of Object.entries(SRC_FILES)) {
        const block = extract(fs.readFileSync(p, 'utf8'))
        ok('[' + label + '] 能抽到②段（R10 门控 + aiR10LastAt 水位）',
          !!block && /aiR10LastAt/.test(block) && /cfg\.autoActions\.R10 === true/.test(block))
        if (!block) continue
        // 门控形态断言（两处必须一致）
        ok('[' + label + '] 门控含 cfg.autoEnabled 校验',
          /cfg\.enabled && cfg\.autoEnabled && cfg\.autoActions && cfg\.autoActions\.R10 === true/.test(block))
        ok('[' + label + '] 门控含 r10Due（独立水位到期）与 plan.activeNow',
          /\br10Due\b/.test(block) && /plan\.activeNow/.test(block))
        ok('[' + label + '] 不再用 plan.due 作为 R10 的到期条件',
          !/r10Due\s*&&[\s\S]{0,40}plan\.due/.test(block) &&
          !/if \([^)]*plan\.due[^)]*autoActions\.R10/.test(block))
        ok('[' + label + '] 间隔复用 autoIntervalHours（1..720 收敛，默认 24）',
          /Math\.min\(720, Math\.max\(1, Number\(cfg\.autoIntervalHours\) \|\| 24\)\)/.test(block))
        ok('[' + label + '] 忙时（/已有任务在运行/）把 ranAt 置 0 → 不推进水位',
          /const busy = \/已有任务在运行\/\.test/.test(block) && /if \(busy\) ranAt = 0/.test(block))
        ok('[' + label + '] finally 里只在 ranAt 有值时推进水位',
          /if \(ranAt\) \{ try \{ store\.db\.aiR10LastAt = ranAt; store\.saveDb\(\) \} catch \(_\) \{\} \}/.test(block))
        ok('[' + label + '] 水位键是独立 db.aiR10LastAt（代码行不碰 aiAutoReview 水位）',
          /store\.db\.aiR10LastAt/.test(block) &&
          !block.split('\n').filter(l => !/^\s*\/\//.test(l)).some(l => /aiAutoReview/.test(l)),
          'nonCommentAiAutoReview=' + block.split('\n').filter(l => !/^\s*\/\//.test(l) && /aiAutoReview/.test(l)).length)

        // —— 行为仿真：真实执行②段 ——
        const mkStoreStub = (db) => ({
          db: Object.assign({}, db),
          saveDb () { this.saved = (this.saved || 0) + 1 }
        })
        const baseCfg = () => ({ enabled: true, autoEnabled: true, autoActions: { R10: true }, autoIntervalHours: 24 })
        const activePlan = { due: false, activeNow: true }   // due=false 用来证明与③段解耦
        const runWith = async (cfg, db, plan, hunterImpl) => {
          const store = mkStoreStub(db)
          const calls = { n: 0 }
          const hunter = hunterImpl || { pruneAiRepos: async () => { calls.n++; return { blocked: [] } } }
          const logs = []
          const pushLog = (o) => logs.push(o)
          await mkRun(block)(cfg, store, plan || activePlan, hunter, pushLog, Date)
          return { store, calls, logs }
        }

        // 9a 首次必跑（水位缺失 → due）
        {
          const r = await runWith(baseCfg(), {})
          ok('[' + label + '] ★ 首次（无水位）必跑', r.calls.n === 1, 'calls=' + r.calls.n)
          ok('[' + label + '] ★ 首次跑完写入 aiR10LastAt', Number(r.store.db.aiR10LastAt) > 0, String(r.store.db.aiR10LastAt))
          ok('[' + label + '] 跑完落盘（saveDb 被调用）', (r.store.saved || 0) >= 1)
        }
        // 9b 1 小时后不重跑（24h 间隔未到）
        {
          const r = await runWith(baseCfg(), { aiR10LastAt: Date.now() - 1 * HOUR })
          ok('[' + label + '] ★ 1 小时后不重跑（24h 间隔未到）', r.calls.n === 0, 'calls=' + r.calls.n)
          ok('[' + label + '] 未跑时不改动水位',
            Math.abs(Number(r.store.db.aiR10LastAt) - (Date.now() - 1 * HOUR)) < 60000)
        }
        // 9c 24 小时后可跑
        {
          const r = await runWith(baseCfg(), { aiR10LastAt: Date.now() - 25 * HOUR })
          ok('[' + label + '] ★ 24 小时后可重跑', r.calls.n === 1, 'calls=' + r.calls.n)
        }
        // 9d 与③段解耦：plan.due=false（③段被 autoLlmReviewEnabled 挡住时就是这样）仍要能跑
        {
          const r = await runWith(baseCfg(), {}, { due: false, activeNow: true })
          ok('[' + label + '] ★ 与③段解耦：plan.due=false 时 R10 仍跑（旧实现此处恒不跑/恒跑取决于③段）',
            r.calls.n === 1, 'calls=' + r.calls.n)
        }
        // 9e 时段外（activeNow=false）不跑
        {
          const r = await runWith(baseCfg(), {}, { due: true, activeNow: false })
          ok('[' + label + '] 时段外（activeNow=false）不跑', r.calls.n === 0, 'calls=' + r.calls.n)
        }
        // 9f 忙时被拒不推进水位
        {
          const busyHunter = { pruneAiRepos: async () => { const e = new Error('已有任务在运行：crawl（采集）（本次「AI 评估非音源仓库」未执行，详见日志）'); throw e } }
          const r = await runWith(baseCfg(), {}, activePlan, busyHunter)
          ok('[' + label + '] ★ 忙时被拒 → 不推进水位（aiR10LastAt 仍为 0）',
            !r.store.db.aiR10LastAt, String(r.store.db.aiR10LastAt))
          ok('[' + label + '] 忙时仍留痕一条日志（info）',
            r.logs.length === 1 && r.logs[0].level === 'info' && /未执行/.test(r.logs[0].msg),
            JSON.stringify(r.logs.map(x => x.level + '|' + String(x.msg).slice(0, 30))))
        }
        // 9g 真失败（非忙）→ 推进水位（避免失败后每小时重试烧配额）
        {
          const failHunter = { pruneAiRepos: async () => { throw new Error('验真网络异常') } }
          const r = await runWith(baseCfg(), {}, activePlan, failHunter)
          ok('[' + label + '] ★ 真失败也推进水位（避免失败后每小时重试烧配额）',
            Number(r.store.db.aiR10LastAt) > 0, String(r.store.db.aiR10LastAt))
          ok('[' + label + '] 真失败留痕日志', r.logs.length === 1 && /未执行/.test(r.logs[0].msg))
        }
        // 9h cfg.autoEnabled 关 → 不跑
        {
          const c = baseCfg(); c.autoEnabled = false
          const r = await runWith(c, {})
          ok('[' + label + '] ★ cfg.autoEnabled=false → R10 不跑', r.calls.n === 0, 'calls=' + r.calls.n)
        }
        // 9i cfg.enabled 关 → 不跑
        {
          const c = baseCfg(); c.enabled = false
          const r = await runWith(c, {})
          ok('[' + label + '] cfg.enabled=false → R10 不跑', r.calls.n === 0, 'calls=' + r.calls.n)
        }
        // 9j autoActions.R10 关 → 不跑
        {
          const c = baseCfg(); c.autoActions = { R10: false }
          const r = await runWith(c, {})
          ok('[' + label + '] autoActions.R10=false → 不跑', r.calls.n === 0, 'calls=' + r.calls.n)
        }
        // 9k autoIntervalHours 自定义（1h）生效
        {
          const c = baseCfg(); c.autoIntervalHours = 1
          const r = await runWith(c, { aiR10LastAt: Date.now() - 1.1 * HOUR })
          ok('[' + label + '] autoIntervalHours=1 时 1.1 小时后可跑（间隔真复用该配置）',
            r.calls.n === 1, 'calls=' + r.calls.n)
        }
        // 9l 有 blocked 结果时写 warn 日志
        {
          const bh = { pruneAiRepos: async () => ({ blocked: ['a/b', 'c/d'] }) }
          const r = await runWith(baseCfg(), {}, activePlan, bh)
          ok('[' + label + '] 有拉黑结果时写 warn 日志（含数量）',
            r.logs.some(x => x.level === 'warn' && /2 个/.test(x.msg)), JSON.stringify(r.logs.map(x => x.level)))
        }
      }
    }

    // ==================================================================
    section('Part 10 ★ v1.16.1 前端 metaFound===false → warn（历史拉黑数据无快照）')
    // ==================================================================
    {
      const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
      ok('app.js 有 metaFound === false 分支', /d\.metaFound === false/.test(appSrc))
      ok('★ 该分支走 warn toast（不是 ok）',
        /if \(d\.metaFound === false\)[\s\S]{0,400}toast\([\s\S]{0,400}'warn'\)/.test(appSrc))
      ok('warn 文案说明「没有采集快照（历史拉黑数据）」',
        /没有采集快照（历史拉黑数据）/.test(appSrc))
      ok('warn 文案说明「需要重新采集才能回来」', /重新采集才能回来/.test(appSrc))
      ok('else 分支才走 ok 并在 restoredIds>0 时提示恢复条数',
        /\} else \{[\s\S]{0,300}toast\([\s\S]{0,300}d\.restoredIds \? `，已按快照恢复 \$\{d\.restoredIds\} 条脚本的采集记录`[\s\S]{0,80}'ok'\)/.test(appSrc))

      // —— 行为侧：历史数据（blockedRepos 有、blockedMeta 空）→ metaFound:false, restoredIds:0 ——
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      const repo = 'legacy/nometa'
      const ids = seedScripts(st, repo, 2)
      // 模拟改动前旧 prune 留下的数据：进了黑名单、脚本被删，但没有 blockedMeta 快照
      st.config.blockedRepos = ['legacy/nometa']
      st.config.blockedMeta = {}
      st.db.deletedIds = ids.slice()
      st.saveConfig(); st.saveDb()
      const u = h.unblockRepo('legacy/nometa', true)
      ok('★ 历史数据：blockedRepos 有但 blockedMeta 空 → metaFound:false',
        u.metaFound === false, JSON.stringify(u))
      ok('★ 历史数据：restoredIds=0（无快照可还原）', u.restoredIds === 0, 'restored=' + u.restoredIds)
      ok('★ 历史数据：脚本仍在 deletedIds（需重新采集）',
        ids.every(id => st.deletedIds().includes(id)), 'deleted=' + JSON.stringify(st.deletedIds()))
      ok('历史数据：仓库仍能解除拉黑并回清单（不因缺快照失败）',
        !st.config.blockedRepos.includes('legacy/nometa') &&
        st.config.repos.some(x => x.repo === 'legacy/nometa' && x.origin === 'unblocked'))
      // 对照：有快照的正常路径 metaFound:true 且 restoredIds>0
      {
        const s2 = mkStore()
        const h2 = mkHunter(s2.st)
        const ids2 = seedScripts(s2.st, 'ok/withmeta', 3)
        addRepo(s2.st, 'ok/withmeta')
        h2.blockRepo('ok/withmeta', { by: 'user' })
        const u2 = h2.unblockRepo('ok/withmeta', true)
        ok('对照：有快照 → metaFound:true 且 restoredIds=3（前端走 else 的 ok 分支）',
          u2.metaFound === true && u2.restoredIds === 3, JSON.stringify(u2))
        cleanup(s2.dir)
      }
      cleanup(dir)
    }

    // 收尾
    console.log('\n===== RESULT pass=' + pass + ' fail=' + fail + ' =====')
    if (fails.length) { console.log('FAILS:'); fails.forEach(f => console.log('  - ' + f)) }
    process.exit(fail ? 1 : 0)
  })().catch(e => { console.error('TEST_EXCEPTION', e); process.exit(2) })
}

main()
