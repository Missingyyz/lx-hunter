'use strict'
/**
 * 评测回放脚本（v1.13.9 B 批，2026-11-19）
 *
 * 用途：把 tests/eval-cases 里的标注样本逐条送进 aiReview，拿到 AI 判断，写成
 * `db.aiEvalLog` 记录（`phase:'replay'`），再交给 computeMetrics 算分层指标。
 *
 * === 为什么需要它 ===
 * 原来 `aiEvalLog` 恒为 0 条，`computeMetrics` 无论门槛怎么调都只能报「数据不足」：
 *   - `hunter.js` 的 `_aiShadowEval` 注释写明「本轮不调用 AI（aiAct 留空）」，
 *     只写空壳记录；
 *   - 它还有两道前置开关，且只在「同名裁决补测/改名/置换」三处触发，常规灌入走不到。
 * 文档里提到的 `LXH_AI_EVAL_LIVE=1` 真机模式**在 src/ 里没有任何代码实现**，
 * 历史那份「真机回放指标报告」是临时脚本一次性跑出来的、已删除。
 * 本脚本把那条链路固化下来，可重复执行。
 *
 * === 三种模式 ===
 *   --stub    零成本：用 goldAct 冒充 aiAct，只为验证「读样本→调 review→写日志→算指标」
 *             整条链路通。**不能用它下任何质量结论。**
 *   --live    真调 provider（需在 config.aiReview.provider 配好 baseUrl/apiKey/model）。
 *   --mockops 用历史真机回放的已知偏差形态（AI 动作向全给保守方向）造数据，
 *             用于演练「真实数据长什么样」，同样不是真实测量。
 *
 * === 安全红线 ===
 *   - 只写 `db.aiEvalLog`（旁路容器），绝不执行任何业务动作、不写 aiAudit、不动 sources。
 *   - 每条记录 `executed:false / auditId:null`，computeMetrics 的只读红线据此校验。
 *   - 断点续跑：已回放过的样本（同 caseId 同 phase 同 mode）默认跳过，`--force` 重跑。
 *
 * === 用法 ===
 *   node tests/tools/replay-eval.js --stub
 *   node tests/tools/replay-eval.js --stub --limit 20
 *   node tests/tools/replay-eval.js --live --limit 20
 *   node tests/tools/replay-eval.js --live --force        # 全量重跑
 *   node tests/tools/replay-eval.js --stub --data E:/path/to/data   # 指定数据目录
 * 选项：
 *   --limit N     只跑前 N 条（试水用）
 *   --kind R7     只跑某类
 *   --force       忽略断点续跑，重跑全部
 *   --concurrency 4  并发数（默认 1；真调 provider 建议 1~3 防限流）
 *   --dry-run     只打印将要做什么，不写库
 *   --data DIR    数据目录（默认 ./_replay_data，避免污染真实库）
 *   --allow-dirty 允许在「看起来是真实库」的目录上运行（默认拒绝，防污染 aiSuggestions）
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')

// ---------- 参数解析 ----------
function parseArgs (argv) {
  const a = { stub: false, live: false, mockops: false, limit: 0, kind: '', force: false, concurrency: 1, dryRun: false, data: '', allowDirty: false }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    if (x === '--stub') a.stub = true
    else if (x === '--live') a.live = true
    else if (x === '--mockops') a.mockops = true
    else if (x === '--force') a.force = true
    else if (x === '--dry-run') a.dryRun = true
    else if (x === '--allow-dirty') a.allowDirty = true
    else if (x === '--limit') a.limit = Number(argv[++i]) || 0
    else if (x === '--kind') a.kind = String(argv[++i] || '').toUpperCase()
    else if (x === '--concurrency') a.concurrency = Math.max(1, Number(argv[++i]) || 1)
    else if (x === '--data') a.data = String(argv[++i] || '')
  }
  return a
}

// ---------- 限流退避 ----------
/**
 * 判断错误是否值得重试。限流/超时/网络抖动要退避重试；4xx 配置错（401/403/404）重试没意义。
 */
function isRetryable (err) {
  const s = String((err && err.message) || err || '')
  if (/429|rate.?limit|too many|限流/i.test(s)) return true
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|网络/i.test(s)) return true
  if (/\b5\d\d\b/.test(s)) return true
  // 401/403/404 等配置问题不重试
  if (/\b(401|403|404)\b/.test(s)) return false
  return false
}

/**
 * 带退避的重试包装。baseMs 起，指数增长，带随机抖动避免同时重试。
 * 最多 attempts 次；不可重试的错误立即抛出。
 */
async function withRetry (fn, opts) {
  const o = opts || {}
  const attempts = o.attempts || 3
  const baseMs = o.baseMs || 800
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)))
  const rand = o.rand || Math.random
  let lastErr = null
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i)
    } catch (e) {
      lastErr = e
      if (!isRetryable(e) || i === attempts - 1) throw e
      // 800 → 1600 → 3200，±30% 抖动
      const wait = Math.round(baseMs * Math.pow(2, i) * (0.7 + rand() * 0.6))
      if (o.onRetry) o.onRetry(i + 1, wait, e)
      await sleep(wait)
    }
  }
  throw lastErr
}

// ---------- 样本 → AI 判断 ----------
const CONSERV = { R4: 'ignore', R5: 'source', R6: 'reject', R7: 'keep' }

/**
 * mockops 模式：按历史真机回放的观测形态造 AI 判断。
 * 依据 tests/eval-cases/真机回放指标报告.txt:8-11 ——
 *   动作向(follow/nonSource/trust/blacklist) 全部 0%，AI 一律给保守方向；
 *   保守向基本判对（R4 100% / R5 99% / R6 100% / R7 93%）。
 * **这只是形态演练，不是测量结果。**
 */
function mockAiAct (c) {
  const k = String(c.kind || '').toUpperCase()
  const conserv = CONSERV[k]
  if (!conserv) return null
  const isAction = c.expected.verdict !== conserv
  if (isAction) return conserv                 // 动作向 → 一律给保守方向
  // 保守向：按报告里的少数错误率抖动（R7 93% → 约 7% 判错成动作向）
  const missRate = k === 'R4' ? 0 : (k === 'R5' ? 0.013 : (k === 'R6' ? 0 : 0.07))
  if (Math.random() < missRate) return c.expected.verdict === conserv ? (k === 'R7' ? 'blacklist' : conserv) : conserv
  return conserv
}

/** 从样本的 input 还原成 REVIEW_PROMPTS[kind].buildText 需要的入参 */
function inputFor (c) {
  const inp = Object.assign({}, c.input || {})
  // 样本里 id 与 entryId 供落库对齐
  inp.id = c.id
  inp.entryId = c.id
  return inp
}

/**
 * 跑一条样本，返回 { ok, aiAct, aiWhy, error }。
 * stub 直接用 goldAct；mockops 按历史形态造；live 真调 provider。
 */
async function runOne (aiReview, c, mode, deps) {
  if (mode === 'stub') return { ok: true, aiAct: c.expected.verdict, aiWhy: 'stub: 用 goldAct 冒充 aiAct' }
  if (mode === 'mockops') return { ok: true, aiAct: mockAiAct(c), aiWhy: 'mockops: 按历史回放形态构造' }
  // live：走 aiReview.run(kind, params) —— 这是**唯一**真正拼 prompt、调 provider、
  // 解析 JSON 出 verdict 的入口（通用分支 R4-R7 见 aiReview.js run()）。
  //
  // 注意：不要用 aiReview.suggest()。suggest 的签名是
  //   suggest(entryId, kind, conclusion, evidence, extra)
  // 它只是「把一条建议写进 db.aiSuggestions」的同步函数，**完全不调模型**。
  // 之前这里把 kind 传给了 suggest 的位置（参数错位，且 suggest 不调模型），
  //   ① 参数错位（kind 被当成 entryId，inp 对象被当成 kind）；
  //   ② suggest 不返回 Promise、也不含 result.eval，
  // 于是每条都落到「AI 未给出合法 verdict」分支 → live 模式 0 成功，
  // 且即使 apiKey/model 全填对也照样 0 成功。已修正。
  const inp = inputFor(c)
  const r = await withRetry(() => aiReview.run(c.kind, {
    // 样本 input 里已有 name/status/deep/ledger 等，buildText 直接吃这些字段
    ...inp,
    entryId: c.id,
    trigger: 'manual',
    detailAction: '回放评测（只读，不写业务状态）'
  }), {
    attempts: 3,
    baseMs: 800,
    sleep: deps && deps.sleep,
    rand: deps && deps.rand,
    onRetry: (n, ms, e) => { if (deps && deps.onRetry) deps.onRetry(n, ms, e) }
  })
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'provider 返回失败' }
  // R4-R7 通用分支把 AI 判断放在 result.eval（{verdict, reason}）里
  const ev = r.result && r.result.eval
  if (!ev || !ev.verdict) return { ok: false, error: 'AI 未给出合法 verdict（解析失败或跑偏）' }
  return { ok: true, aiAct: ev.verdict, aiWhy: ev.reason || '' }
}

// ---------- 主流程 ----------
async function main () {
  const args = parseArgs(process.argv.slice(2))
  const modes = [args.stub, args.live, args.mockops].filter(Boolean)
  if (modes.length !== 1) {
    console.error('必须且只能指定一种模式：--stub / --live / --mockops')
    process.exit(2)
  }
  const mode = args.stub ? 'stub' : (args.live ? 'live' : 'mockops')

  const dataDir = args.data || path.join(ROOT, '_replay_data')
  fs.mkdirSync(dataDir, { recursive: true })

  const { Store } = require(path.join(ROOT, 'src', 'core', 'store.js'))
  const ec = require(path.join(ROOT, 'src', 'core', 'evalCases.js'))
  const { AIReview } = require(path.join(ROOT, 'src', 'core', 'aiReview.js'))
  const snap = require(path.join(ROOT, 'src', 'core', 'evalSnapshot.js'))

  const casesDir = path.join(ROOT, 'tests', 'eval-cases')
  const load = ec.tryLoadCases(casesDir)
  if (load.error) { console.error('样本读取失败：' + load.error); process.exit(1) }
  let cases = load.cases
  console.log('样本 ' + cases.length + ' 条，模式 ' + mode + '，数据目录 ' + dataDir)

  if (args.kind) {
    cases = cases.filter(c => String(c.kind).toUpperCase() === args.kind)
    console.log('按 --kind 过滤后 ' + cases.length + ' 条')
  }
  if (args.limit > 0 && cases.length > args.limit) {
    cases = cases.slice(0, args.limit)
    console.log('按 --limit 截取前 ' + args.limit + ' 条')
  }
  if (args.dryRun) {
    console.log('[dry-run] 将回放 ' + cases.length + ' 条，不写库')
    return
  }

  const store = new Store(dataDir)
  const aiReview = new AIReview(store)

  // ---- P0-3：防止回放污染 aiSuggestions ----
  // aiReview.run() → 通用分支会调 suggest() 把每条结论写进 db.aiSuggestions。
  // 那是给「真实 AI 复检」用的用户可见建议列表，回放产生的都是评测假数据，
  // 塞进去会污染用户的建议面板（实测一次 438 条回放写了 439 条假建议）。
  //
  // 处理分两层：
  //   ① 硬拦：如果 --data 指向的目录里已经有真实 aiSuggestions（说明这是用户的真实库），
  //      直接拒绝运行，避免手滑把评测灌进生产目录。
  //   ② 打桩：在内存里把 suggest 换成不落库的版本，回放只写 aiEvalLog，不碰 aiSuggestions。
  //      选择打桩而不是给 aiReview 加 noPersist 参数，是为了不改动生产路径的代码——
  //      生产链路上多一个「可以关掉落库」的开关，本身就是风险。
  const preSug = Object.keys((store.db && store.db.aiSuggestions) || {}).length
  const preLog = Object.keys((store.db && store.db.aiEvalLog) || {}).length
  // 判定「真实库」：已有建议、且已有业务数据（sources 非空），说明不是本脚本建的临时目录。
  // 只靠 aiSuggestions 非空会误伤「上次回放已被污染的临时目录」这种续跑场景。
  const looksReal = preSug > 0 && Object.keys((store.db && store.db.sources) || {}).length > 0
  if (looksReal && !args.allowDirty) {
    console.error('')
    console.error('[拒绝运行] --data 指向的目录看起来是真实数据目录：')
    console.error('  ' + dataDir)
    console.error('  其中已有 ' + preSug + ' 条 aiSuggestions、' +
      Object.keys(store.db.sources || {}).length + ' 条 sources。')
    console.error('  回放会往 aiSuggestions 写评测假建议，污染用户的 AI 建议面板。')
    console.error('  请换一个空的临时目录（如 --data ./_replay_data）。')
    console.error('  确实要在该目录上跑，加 --allow-dirty 显式确认。')
    process.exit(3)
  }
  if (preSug > 0) console.log('[提示] 该目录已有 ' + preSug + ' 条 aiSuggestions；本次回放不会新增（suggest 已打桩）')
  // 打桩：保留返回值形状（run() 会读 suggestion/suggestions），但不写 db
  const realSuggest = aiReview.suggest.bind(aiReview)
  aiReview.suggest = function (entryId, kind, conclusion, evidence, extra) {
    const s = Object.assign({
      id: 'dryrun-' + (kind || '?'), entryId: entryId || '', kind,
      conclusion: conclusion || '', evidence: Array.isArray(evidence) ? evidence : []
    }, extra || {})
    return s   // 只给调用方用，不落 store.db
  }
  void realSuggest

  // ---- 断点续跑：已经回放过的 caseId 跳过 ----
  const done = new Set()
  if (!args.force) {
    for (const rec of Object.values(store.db.aiEvalLog || {})) {
      if (rec && rec.phase === 'replay' && rec.mode === mode && rec.entryId) done.add(rec.entryId)
    }
  }
  const todo = cases.filter(c => !done.has(c.id))
  console.log('已回放 ' + done.size + ' 条，本次待跑 ' + todo.length + ' 条')

  if (!todo.length) {
    console.log('没有待跑样本（全部已回放）。要重跑加 --force')
  }

  let okCount = 0; let failCount = 0
  const failSamples = []
  const t0 = Date.now()

  for (let i = 0; i < todo.length; i++) {
    const c = todo[i]
    let r
    try {
      r = await runOne(aiReview, c, mode, {
        onRetry: (n, ms, e) => console.log('  [退避] 第 ' + n + ' 次重试，等 ' + ms + 'ms：' + String((e && e.message) || e).slice(0, 80))
      })
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) }
    }
    if (!r.ok) {
      failCount++
      failSamples.push(c.id + ' :: ' + r.error)
      console.log('  [' + (i + 1) + '/' + todo.length + '] 失败 ' + c.id + '：' + r.error)
      continue
    }
    // ---- 写 aiEvalLog（只写旁路容器，executed 恒 false、auditId 恒 null）----
    if (!store.db.aiEvalLog) store.db.aiEvalLog = {}
    const rec = snap.makeEvalLog({
      phase: 'replay',
      mode,
      batch: 'replay-' + new Date(t0).toISOString().slice(0, 10),
      entryId: c.id,
      srvId: null,
      zone: c.expected.zone,
      zoneCodes: [],
      danger: c.expected.danger,
      ruleAct: null,
      ruleWhy: null,
      aiAct: r.aiAct,
      aiWhy: String(r.aiWhy || '').slice(0, 300),
      goldAct: c.expected.verdict,
      gate: null,
      executed: false,
      auditId: null
    })
    store.db.aiEvalLog[c.id + '|' + rec.ts + '|' + rec.id] = rec
    okCount++
    // 每 20 条落一次盘，断了不丢已完成的部分
    if (okCount % 20 === 0) {
      if (store.saveDb() === false) console.error('  [警告] 落盘失败（磁盘/权限？），继续跑但不保证已保存')
      else console.log('  ... 已落盘 ' + okCount + ' 条')
    }
  }

  // 收尾落盘
  const saved = store.saveDb()
  if (saved === false) {
    console.error('[错误] aiEvalLog 落盘失败，回放结果未持久化')
  } else {
    console.log('已落盘到 ' + path.join(dataDir, 'sources.json'))
  }

  // ---- 直接算指标 ----
  const logs = Object.keys(store.db.aiEvalLog || {}).map(k => store.db.aiEvalLog[k])
  const allCases = ec.loadCases(casesDir)
  const m = ec.computeMetrics(logs, allCases)
  const dist = { 数据不足: 0, 达标: 0, 未达标: 0 }
  for (const r of m.table) dist[r.verdict]++

  const secs = Math.round((Date.now() - t0) / 1000)
  console.log('')
  console.log('==== 回放完成 ====')
  console.log('模式 ' + mode + '｜成功 ' + okCount + '｜失败 ' + failCount + '｜耗时 ' + secs + 's')
  if (failSamples.length) {
    console.log('失败样例（前 5）：')
    for (const f of failSamples.slice(0, 5)) console.log('  ' + f)
  }
  console.log('aiEvalLog 累计 ' + logs.length + ' 条')
  console.log('')
  console.log('分层指标：')
  for (const r of m.table) {
    console.log('  ' + String(r.stratum).padEnd(13) + ' n=' + String(r.n).padStart(4) +
      ' need=' + String(r.need).padStart(4) + ' → ' + String(r.verdict).padEnd(6) +
      (r.ratio ? ' ' + r.reason : ' ' + (r.reason || '')))
  }
  console.log('  overall = ' + m.overall.verdict + ' :: ' + m.overall.note)
  console.log('  verdict 分布 = ' + JSON.stringify(dist))
  if (mode !== 'live') {
    console.log('')
    console.log('【注意】模式 ' + mode + ' 不是真实 AI 测量结果，只能验证链路与形态，不可用于任何质量结论。')
  }
}

module.exports = { parseArgs, isRetryable, withRetry, mockAiAct, runOne, CONSERV }

if (require.main === module) {
  main().catch(e => { console.error('回放失败：' + ((e && e.stack) || e)); process.exit(1) })
}
