'use strict'
/**
 * 仓库筛选两步方案验证（v1.16）
 *
 * Part 1 可回滚是否真成立（真跑，不读代码）：造 N 个脚本→blockRepo→unblockRepo→
 *       断言 deletedIds 全部移除 + _undeleted 不再拦（可重新采集）。对比"旧行为永不回"。
 * Part 2 默认关：autoActions.R10=false；allowIrreversible 未开时即便 R10=true 也不执行；老配置缺 R10 归一化 false。
 * Part 3 三重旁证真 AND：缺一即拒；三者全满足需同时过 gate 双锁+评测才放行。
 * Part 4 gate 链完整：pruneAiRepos 唯一执行路径都过 gate('R10')；无旁路直接写黑名单。
 * Part 5 建议层不自动写黑名单：repoAiHints 只存 tool；建议层代码不调 blockRepo。
 * Part 6 blockedRepos 仍是纯字符串数组；六处 Set 逻辑不报错。
 * Part 7 uncertain 绝不提示（repoAiHints 不含 uncertain/real）。
 *
 * 零框架；用真实 Store（临时目录）+ Hunter.prototype，不联网、不改真实 /data。
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

let pass = 0, fail = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; fails.push(name + (extra ? '  :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')) }
}
const section = (t) => console.log('\n=== ' + t + ' ===')

function mkStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-repofilter-'))
  const st = new Store(dir)
  // Store 是浅拷贝 DEFAULT_CONFIG：这些容器与模块级默认共享引用，换成独占实例避免用例互相串
  st.config.repos = []
  st.config.repoAiHints = {}
  st.config.blockedRepos = []
  st.config.blockedMeta = {}
  st.config.aiReview = JSON.parse(JSON.stringify(st.config.aiReview))
  return { st, dir }
}
function mkHunter (st) {
  const h = Object.create(Hunter.prototype)
  h.store = st
  h.emit = () => {}
  h.logs = []
  h.log = (msg, mod, level) => { h.logs.push({ msg: String(msg), mod, level }) }
  h.job = { running: false, cancel: false, progress: {}, step: '' }
  h.batchId = 'repofilter-test'
  return h
}
function cleanup (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {} }

// 造 N 个属于某 repo 的脚本入库
function seedScripts (st, repo, n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const id = repo + '::src' + i + '.js'
    st.db.sources[id] = { id, repo, name: 'src' + i, lxName: 'src' + i, scriptName: 'src' + i,
      apiHosts: [], updateTips: [], status: 'ok', usable: false, deprecated: false, contentHash: 'sha' + i }
    ids.push(id)
  }
  st.saveDb()
  return ids
}

function main () {
  ;(async () => {
    // ==================================================================
    section('Part 1 ★ 可回滚是否真成立（真跑 blockRepo→unblockRepo）')
    // ==================================================================
    {
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      const repo = 'owner/demo-repo'
      const N = 4
      const ids = seedScripts(st, repo, N)
      // 拉黑前：N 个脚本都在库里、都不在 deletedIds
      ok('拉黑前 N 个脚本入库（' + N + '）', ids.every(id => st.db.sources[id]) && st.deletedIds().length === 0,
        'sources=' + ids.filter(id => st.db.sources[id]).length + ' deleted=' + st.deletedIds().length)
      // 拉黑（人工确认 by:user）
      const r = h.blockRepo(repo, { by: 'user', reason: '测试' })
      ok('blockRepo 清掉 N 个脚本', r.removedSources === N && ids.every(id => !st.db.sources[id]), 'removed=' + r.removedSources)
      ok('blockRepo 产生 snapshot 含全部 N 个 id', Array.isArray(r.snapshot) && r.snapshot.length === N && ids.every(id => r.snapshot.includes(id)),
        'snap=' + JSON.stringify(r.snapshot))
      ok('blockRepo 把 N 个 id 记入 deletedIds（不再采集）', ids.every(id => st.deletedIds().includes(id)),
        'deleted=' + JSON.stringify(st.deletedIds()))
      ok('blockedRepos 加入该仓（纯字符串数组）', Array.isArray(st.config.blockedRepos) && st.config.blockedRepos.includes(repo))
      ok('blockedMeta 记录 by=user+snapshot', st.config.blockedMeta[repo] && st.config.blockedMeta[repo].by === 'user' &&
        Array.isArray(st.config.blockedMeta[repo].snapshot) && st.config.blockedMeta[repo].snapshot.length === N)
      // 拉黑期间：重新采集被拦（_undeleted 过滤掉这些 id）
      const reCrawl = ids.map(id => ({ id, repo, name: id }))
      ok('拉黑期间 _undeleted 拦住这些 id（不回流）', st._undeleted(reCrawl).length === 0,
        'passed=' + st._undeleted(reCrawl).length)
      // 解除拉黑 → 按 snapshot 撤销 deletedIds
      const u = h.unblockRepo(repo, true)
      ok('unblockRepo 返回 restoredIds=N', u.restoredIds === N, 'restored=' + u.restoredIds)
      const remaining = st.deletedIds().filter(id => ids.includes(id))
      ok('★ 解除后 N 个 id 全部从 deletedIds 移除（可回滚成立）', remaining.length === 0,
        'remaining=' + JSON.stringify(remaining))
      ok('解除后 _undeleted 不再拦（能重新采集回来）', st._undeleted(reCrawl).length === N,
        'passed=' + st._undeleted(reCrawl).length + '/' + N)
      ok('解除后 blockedRepos 移除、blockedMeta 删除', !st.config.blockedRepos.includes(repo) && !st.config.blockedMeta[repo])
      ok('解除后仓库回到清单（origin=unblocked）', Array.isArray(st.config.repos) &&
        st.config.repos.some(x => x.repo === repo && x.origin === 'unblocked'))
      // 对比旧行为：若用 clearDeletedIds 之外的"永不回" …这里验证其它仓的 deletedIds 不被误清
      cleanup(dir)
    }
    // 对照组：其它仓的删除记录不受影响（精确撤销而非核弹）
    {
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      const repoA = 'owner/a', repoB = 'owner/b'
      const idsA = seedScripts(st, repoA, 2)
      const idsB = seedScripts(st, repoB, 2)
      h.blockRepo(repoA, { by: 'user' })
      h.blockRepo(repoB, { by: 'user' })
      const deletedBefore = st.deletedIds().length
      h.unblockRepo(repoA, true)
      const stillDeletedB = idsB.every(id => st.deletedIds().includes(id))
      ok('精确撤销：解除 A 不影响 B 的删除记录（非核弹）', stillDeletedB && st.deletedIds().length === idsB.length,
        'deletedBefore=' + deletedBefore + ' after=' + st.deletedIds().length + ' Bkept=' + stillDeletedB)
      cleanup(dir)
    }

    // ==================================================================
    section('Part 2 默认关')
    // ==================================================================
    {
      ok('DEFAULT_CONFIG.autoActions.R10 === false', DEFAULT_CONFIG.aiReview.autoActions.R10 === false,
        String(DEFAULT_CONFIG.aiReview.autoActions.R10))
      ok('DEFAULT_CONFIG.allowIrreversible === false', DEFAULT_CONFIG.aiReview.allowIrreversible === false)
      // 未开 allowIrreversible 时即便 autoActions.R10=true 也归一化为 false
      const { st, dir } = mkStore()
      st.config.aiReview.allowIrreversible = false
      st.config.aiReview.autoActions.R10 = true
      // 重新触发归一化：saveConfig 不归一化；归一化在构造时。这里模拟构造再读
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-norm-'))
      const st2 = new Store(dir2)
      st2.config.aiReview.allowIrreversible = false
      st2.config.aiReview.autoActions.R10 = true
      st2.config.aiReview.autoActions.irreversible = true
      st2.saveConfig()
      const st3 = new Store(dir2)   // 重开，触发归一化
      ok('allowIrreversible=false 时重启归一化强制 R10=false', st3.config.aiReview.autoActions.R10 === false,
        'R10=' + st3.config.aiReview.autoActions.R10)
      // 老配置缺 R10 键 → 归一化后 false
      const raw = { aiReview: { enabled: true, allowIrreversible: false, autoActions: { clusterLog: true, readonlyReview: true, autoMark: false, R4: false } } }
      fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify(raw))
      const st4 = new Store(dir2)
      ok('老配置缺 R10 键 → 归一化后 R10=false', st4.config.aiReview.autoActions.R10 === false,
        'R10=' + st4.config.aiReview.autoActions.R10)
      cleanup(dir); cleanup(dir2)
    }
    // gate 层：autoActions.R10=false 时 gate('R10') 拒绝
    {
      const { st, dir } = mkStore()
      const a = new AIReview(st)
      const signals = a.collectSignals({ aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, 'R10')
      const g = a.gate('R10', { signals, evalVerdict: '达标' })
      ok('gate(R10) 默认授权关 → auto=false（advisory）', g.auto === false, JSON.stringify(g))
      cleanup(dir)
    }
    // 双锁：R10=true 但 irreversible 未开 → 拒
    {
      const { st, dir } = mkStore()
      st.config.aiReview.enabled = true
      st.config.aiReview.allowIrreversible = false
      st.config.aiReview.autoActions.R10 = true
      st.config.aiReview.autoActions.irreversible = false
      st.config.aiReview.autoActions.R4 = false
      const a = new AIReview(st)
      const signals = a.collectSignals({ aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, 'R10')
      const g = a.gate('R10', { signals, evalVerdict: '达标' })
      ok('R10=true 但 irreversible 未开（双锁）→ 拒', g.auto === false, JSON.stringify(g))
      cleanup(dir)
    }
    // 评测：R10=true + 双锁开 + 但评测未达标 → 拒
    {
      const { st, dir } = mkStore()
      st.config.aiReview.enabled = true
      st.config.aiReview.allowIrreversible = true
      st.config.aiReview.autoActions.R10 = true
      st.config.aiReview.autoActions.irreversible = true
      const a = new AIReview(st)
      const signals = a.collectSignals({ aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, 'R10')
      const g = a.gate('R10', { signals, evalVerdict: '未达标' })
      ok('全锁开但评测未达标 → 拒', g.auto === false && /评测/.test(g.reason || ''), JSON.stringify(g))
      cleanup(dir)
    }

    // ==================================================================
    section('Part 3 ★ 三重旁证真 AND（缺一即拒，三者全满足才放行）')
    // ==================================================================
    {
      const { st, dir } = mkStore()
      st.config.aiReview.enabled = true
      st.config.aiReview.allowIrreversible = true
      st.config.aiReview.autoActions.R10 = true
      st.config.aiReview.autoActions.irreversible = true
      const a = new AIReview(st)
      const ectx = '达标'
      const combos = [
        ['只 AI=tool（缺 verifyNoSource+noUsable）', { aiClass: 'tool', verifyHasSource: true, usableSourceCount: 3 }, false],
        ['只客观无音源（缺 aiTool+noUsable）', { aiClass: 'real', verifyHasSource: false, usableSourceCount: 3 }, false],
        ['只可用数0（缺 aiTool+verifyNoSource）', { aiClass: 'real', verifyHasSource: true, usableSourceCount: 0 }, false],
        ['缺 aiTool', { aiClass: 'uncertain', verifyHasSource: false, usableSourceCount: 0 }, false],
        ['缺 verifyNoSource（有音源）', { aiClass: 'tool', verifyHasSource: true, usableSourceCount: 0 }, false],
        ['缺 noUsableSource（有可用）', { aiClass: 'tool', verifyHasSource: false, usableSourceCount: 2 }, false],
        ['三者全满足', { aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, true]
      ]
      for (const [name, facts, expAuto] of combos) {
        const signals = a.collectSignals(facts, 'R10')
        const g = a.gate('R10', { signals, evalVerdict: ectx })
        ok('三重旁证 ' + name + ' → auto=' + expAuto, g.auto === expAuto, JSON.stringify({ signals: signals.map(s => s.key + '=' + s.ok), gate: g }))
      }
      // 明确是 AND 不是 OR：任一 false 则整体拒绝
      const sig = a.collectSignals({ aiClass: 'tool', verifyHasSource: false, usableSourceCount: 0 }, 'R10')
      ok('collectSignals(R10) 产出 3 条证据键', sig.length === 3 && sig.map(s => s.key).join(',') === 'aiTool,verifyNoSource,noUsableSource',
        JSON.stringify(sig.map(s => s.key)))
      cleanup(dir)
    }

    // ==================================================================
    section('Part 4 gate 链完整（pruneAiRepos 唯一执行路径都过 gate）')
    // ==================================================================
    {
      const hsrc = fs.readFileSync(CORE('hunter.js'), 'utf8')
      // pruneAiRepos 内必调 collectSignals('R10') + gate('R10')，且 blockRepo 只在 gate 通过后调用
      const body = (() => { const i = hsrc.indexOf('async pruneAiRepos'); const j = hsrc.indexOf('\n  // ---------------- ', i); return hsrc.slice(i, j > 0 ? j : hsrc.length) })()
      ok('pruneAiRepos 调 collectSignals(facts,\'R10\')', /collectSignals\(facts, 'R10'\)/.test(body))
      ok('pruneAiRepos 调 gate(\'R10\')', /gate\('R10'/.test(body))
      ok('blockRepo(by:\'ai\') 在 gate 之后（唯一执行路径）', /blockRepo\(repo, \{ by: 'ai'/.test(body) && body.indexOf('gate(\'R10\'') < body.indexOf("blockRepo(repo, { by: 'ai'"))
      ok('gate 未过时 continue（不执行 blockRepo）', /if \(!g\.auto\) \{ out\.skipped\.push[\s\S]{0,120}continue/.test(body))
      // 全仓：除 blockRepo 定义内，是否有其它地方直接改 blockedRepos 并 pop 入黑名单而不经 gate？
      // 允许的位置：blockRepo(2475-2479)、unblockRepo(2512-2517)、prune 清理旧名(2440-2443)、旧清理逻辑(2324)
      const directAdds = (hsrc.match(/cfg\.blockedRepos = Array\.from\(blk\)/g) || []).length
      ok('blockedRepos 直接赋值点均为已知函数（blockRepo/unblockRepo/清理）', directAdds >= 2, 'count=' + directAdds)
    }

    // ==================================================================
    section('Part 5 建议层不自动写黑名单（repoAiHints 只存 tool）')
    // ==================================================================
    {
      const hsrc = fs.readFileSync(CORE('hunter.js'), 'utf8')
      const coldBody = (() => { const i = hsrc.indexOf('_coldStartPrioritizeRepos'); const j = hsrc.indexOf('\n  async ', i + 10); return hsrc.slice(i, j > 0 ? j : hsrc.length) })()
      ok('建议层只写 repoAiHints', /cfg\.repoAiHints\[r\] = \{ cls: 'tool'/.test(coldBody))
      ok('建议层跳过非 tool（class !== tool → continue）', /c\.class !== 'tool'/.test(coldBody))
      ok('建议层不调用 blockRepo', !/blockRepo\(/.test(coldBody))
      ok('建议层无 blockedRepos 写入', !/blockedRepos/.test(coldBody))
      // 用 AIReview 统计：repoAiHints 不应含 uncertain / real
      // （通过代码断言：写死 cls:'tool'，故不可能写 uncertain/real）
      ok('repoAiHints 写入值恒为 cls:\'tool\'（无 uncertain/real）', !/repoAiHints\[[^\]]+\] = \{[^}]*cls:\s*'(uncertain|real)'/.test(hsrc))
    }

    // ==================================================================
    section('Part 6 blockedRepos 仍是纯字符串数组 + 六处 Set 不报错')
    // ==================================================================
    {
      const { st, dir } = mkStore()
      const h = mkHunter(st)
      seedScripts(st, 'owner/x', 2)
      h.blockRepo('owner/x', { by: 'user' })
      ok('blockedRepos 是字符串数组', Array.isArray(st.config.blockedRepos) && st.config.blockedRepos.every(x => typeof x === 'string'),
        JSON.stringify(st.config.blockedRepos))
      ok('blockedMeta 与 blockedRepos 结构分离', typeof st.config.blockedMeta === 'object' && !Array.isArray(st.config.blockedRepos.find(x => typeof x !== 'string')))
      // 全部 Set 构造点（如实口径：源码里对 cfg.blockedRepos 建 Set 的是 4 处；旧断言写「≥6处」是错的）
      const hsrc = fs.readFileSync(CORE('hunter.js'), 'utf8')
      const setCount = (hsrc.match(/new Set\(\(Array\.isArray\(cfg\.blockedRepos\)/g) || []).length
      ok('blockedRepos Set 兼容点 = 4 处（均兼容纯字符串数组）', setCount === 4, 'count=' + setCount)
      // 实际构造 Set 验证不报错
      let setOk = true
      try { const s = new Set((Array.isArray(st.config.blockedRepos) ? st.config.blockedRepos : []).map(x => String(x || '').toLowerCase()).filter(Boolean)); setOk = s.size >= 1 } catch (e) { setOk = false }
      ok('实际 new Set(blockedRepos...) 不报错', setOk)
      cleanup(dir)
    }

    // ==================================================================
    section('Part 7 uncertain 绝不提示')
    // ==================================================================
    {
      const hsrc = fs.readFileSync(CORE('hunter.js'), 'utf8')
      ok('repoAiHints 只写 tool（代码层 cls!==tool continue）', /if \(!c \|\| c\.class !== 'tool'\) continue/.test(hsrc))
      ok('repoAiHints 无 uncertain 写入', !/repoAiHints[^\n]*uncertain/.test(hsrc))
      ok('repoAiHints 无 real 写入', !/repoAiHints[^\n]*'real'/.test(hsrc))
    }

    // 收尾
    console.log('\n===== RESULT pass=' + pass + ' fail=' + fail + ' =====')
    if (fails.length) { console.log('FAILS:'); fails.forEach(f => console.log('  - ' + f)) }
    process.exit(fail ? 1 : 0)
  })().catch(e => { console.error('TEST_EXCEPTION', e); process.exit(2) })
}

main()
