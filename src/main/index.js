'use strict'
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { Store } = require('../core/store')
const { createAppLogWriter } = require('../core/logFile')
const { Hunter, formatIntervalHours, patrolSchedule } = require('../core/hunter')
const { makeProbeQueue } = require('../core/probeQueue')
const { getActiveService, resolveService, TYPE_LABELS, NO_ACCOUNT_ERR } = require('../core/services')
const { DEFAULT_REPOS } = require('../core/crawler')

let win = null
let store = null
let hunter = null
const MAX_LOGS = 3000
const logs = []
// 业务日志落盘（v1.14.0）：与 Web 端共用 core/logFile，重启不丢自动路径日志。
// 数据目录经 setupPortableMode() 改写 userData，必须在首次 pushLog 时才按 getDataDir() 建 writer，
// 不能在模块顶层用固定路径初始化。writer 只管内存数组 + JSONL 落盘；IPC 推送仍由 pushLog 负责。
let appLogWriter = null
function getAppLogWriter() {
  if (!appLogWriter) appLogWriter = createAppLogWriter(getDataDir(), { maxLogs: MAX_LOGS })
  return appLogWriter
}

// ---- 主进程异常兜底 ----
// 音源脚本是不可信代码，沙箱内异步回调的极个别异常不应打断主进程（弹系统错误框）。
process.on('uncaughtException', err => {
  const first = String((err && err.stack) || err).split('\n')[0]
  console.error('[main] uncaughtException:', err)
  try { pushLog({ msg: '已捕获主进程异常（不影响使用）：' + first.slice(0, 160), module: '系统', level: 'error', at: Date.now() }) } catch (e) {}
})
// 音源脚本自身未捕获的 Promise 异常非常多（脚本质量参差不齐），同一个脚本可能刷出几十条。
// 这里做「同消息 10 秒内只报一次 + 计数」，避免日志被脚本噪声淹没。
const rejSeen = new Map()
process.on('unhandledRejection', err => {
  const first = String((err && err.stack) || err).split('\n')[0].slice(0, 160)
  console.error('[main] unhandledRejection:', err)
  try {
    const now = Date.now()
    const prev = rejSeen.get(first)
    if (prev && now - prev.at < 10000) {
      prev.n++
      return
    }
    if (prev && prev.n > 1) {
      pushLog({ msg: `（另有 ${prev.n} 条同类脚本异常已合并，未逐条展开）`, module: '系统', level: 'warn', at: now })
    }
    rejSeen.set(first, { at: now, n: 1 })
    if (rejSeen.size > 200) rejSeen.clear()
    // 脚本内部异常不是本工具的故障，明确标注来源，避免误以为程序出错
    const isScript = /沙箱|fetch|Failed to parse URL|__host_|vm:/i.test(first)
    pushLog({
      msg: (isScript ? '音源脚本内部未捕获异常（已忽略，不影响检测）：' : '已捕获未处理的 Promise 异常：') + first,
      module: '系统', level: 'warn', at: now
    })
  } catch (e) {}
})

function pushLog(e) {
  logs.push(e)
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
  try { getAppLogWriter().pushLog(e) } catch (err) {}   // v1.14.0 落盘：失败静默，绝不影响内存日志与 IPC
  if (win && !win.isDestroyed()) win.webContents.send('hunter:log', e)
}

// R1 聚类日志人话文案（手动/定时共用）：末尾带本周 AI 新归纳的类别 + AI 研究报告。
function clusterLogMsg(out, trigger) {
  const r = (out && out.result) || out || {}
  let msg = 'AI 失败聚类（' + (trigger === 'auto' ? '定期' : '手动') + '）：' + (r.summary || '')
  const added = Array.isArray(r.newRules) ? r.newRules : []
  if (added.length) msg += '；本周新增类别 ' + added.join('、') + '（来自 ' + (r.learnedCount || added.length) + ' 条规则归纳）'
  if (r.report) msg += '\nAI 研究报告：' + r.report
  return msg
}

function emitAll(type, payload) {
  if (type === 'log') { pushLog(payload); return }
  if (win && !win.isDestroyed()) win.webContents.send('hunter:event', { type, payload })
}

// ---- 便携数据目录（v1.7.3）：数据与软件同目录 ----
// 需求：软件数据与软件本身在同一文件夹，拷贝整个软件目录到 B 电脑，数据不丢。
// 便携根目录的识别逻辑与旧数据迁移在 src/core/portable.js（纯函数，有单测）。
// 目标目录不可写（如装进 Program Files）时回退系统用户目录（旧版行为），功能不受影响。
let dataDir = null
function getDataDir() {
  if (!dataDir) dataDir = path.join(app.getPath('userData'), 'data')
  return dataDir
}
function setupPortableMode() {
  const { resolvePortableRoot, migrateLegacyData } = require('../core/portable')
  // 开发模式（electron .）下模块顶层拿不到 app.getPath —— 此时 app 尚未就绪，
  // 取 path 会抛 TypeError 并让整个主进程挂掉。开发模式没有便携意图，直接跳过。
  if (!app.isPackaged) return null
  const legacyUserData = app.getPath('userData')
  const portableRoot = resolvePortableRoot(process.env, path.dirname(app.getPath('exe')))
  if (!portableRoot) return null
  const newUserData = path.join(portableRoot, 'userData')
  try {
    fs.mkdirSync(newUserData, { recursive: true })
    const probe = path.join(newUserData, '.write-probe')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    app.setPath('userData', newUserData)
    const migrated = migrateLegacyData(path.join(legacyUserData, 'data'), path.join(newUserData, 'data'))
    return { root: newUserData, migrated }
  } catch (e) {
    console.warn('[portable] 数据目录不可写，回退系统用户目录：', (e && e.message) || e)
    return { error: String((e && e.message) || e) }
  }
}
// 必须在 new Store / app.whenReady 之前重定向 userData，后续所有 getPath('userData') 才一致
const portableInfo = setupPortableMode()

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: '音源猎手 PC 版',
    backgroundColor: '#14161c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
}

app.whenReady().then(() => {
  if (portableInfo && portableInfo.root) {
    pushLog({
      msg: `便携模式：数据目录 ${getDataDir()}（与软件同目录；拷贝整个软件文件夹即可迁移到其他电脑）` +
        (portableInfo.migrated ? `；已从旧数据目录迁移 ${portableInfo.migrated} 个文件（原文件保留作备份）` : ''),
      module: '系统', level: 'info', at: Date.now()
    })
  } else if (portableInfo && portableInfo.error) {
    pushLog({ msg: '便携数据目录不可写，已回退系统用户目录：' + portableInfo.error, module: '系统', level: 'warn', at: Date.now() })
  }
  store = new Store(getDataDir())
  hunter = new Hunter(store, emitAll)
  // 网络加速配置（爬取代理/强制代理/jsDelivr 开关/自定义镜像）在启动时同步到网络层
  require('../core/net').applyConfig(store.config)
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  // ---- 定时任务：巡检 / 爬取（v1.7.0 起，v1.9.0 起爬取可接自动灌入）----
  // 「每分钟检查一次」是**轮询节奏**，不是**执行频率**：到期判据 = 距上次执行 ≥ 设置里的间隔，
  // 所以设 2 天就是每 2 天跑一次（最多晚 1 分钟），应用需保持运行。
  setInterval(() => {
    try {
      if (!store || !hunter) return
      const cfg = store.config
      if (!cfg.patrolEnabled || hunter.job.running) return
      const sched = patrolSchedule(cfg, store.db.patrol, Date.now())
      const last = sched.last
      const hours = sched.hours
      // 主判据仍是「距上次执行 ≥ 设定间隔」；上一轮失败时另按 patrolRetryMinutes 退避。
      // 关键：触发前就写 lastAttempt。旧代码只在 runPatrol 成功收尾写 lastRun，推送服务端一关，
      // 每分钟轮询都会判「到期」并真跑一轮，日志被 fetch failed 刷屏（2026-11-06 实测）。
      if (Date.now() - last >= hours * 3600 * 1000 || sched.dueByRetry) {
        store.db.patrol = Object.assign({}, store.db.patrol, { lastAttempt: Date.now(), lastError: null })
        store.saveDb()
        pushLog({
          msg: sched.failed
            ? `上次巡检未成功，按失败重试间隔 ${sched.retryMinutes} 分钟后重试…`
            : `定时巡检到期（间隔 ${formatIntervalHours(hours)}），开始重测已灌入音源…`,
          module: '巡检', level: 'info', at: Date.now()
        })
        hunter.runPatrol()
          .then(() => {
            store.db.patrol = Object.assign({}, store.db.patrol, { lastError: null })
            store.saveDb()
          })
          .catch(e => {
            const msg = String((e && e.message) || e)
            store.db.patrol = Object.assign({}, store.db.patrol, { lastError: msg })
            store.saveDb()
            pushLog({
              msg: `定时巡检失败：${msg}；已按 ${sched.retryMinutes} 分钟延后重试，不会每分钟重复尝试（可在设置里调整失败重试间隔，或关闭「启用定时巡检」）`,
              module: '巡检', level: 'error', at: Date.now()
            })
          })
      }
    } catch (e) {}
  }, 60 * 1000)
  // v1.14.1：「未知源」冻结的短周期复查（桌面版，与 web.js 同款逻辑）。
  // unloaded 是唯一会「服务端自愈」的冻结类型（用户去服务端点一次允许原生 VM 就好了），
  // 却和 removed/disabled/isolated 共用 24h 巡检周期 → 实测界面会顶着红色「未知源·冻结」
  // 十几个小时。这里每 15 分钟核对一次；refreshUnloadedVeto 内部先查有没有 unloaded，
  // 没有就零请求返回，所以正常情况下不产生任何 HTTP。
  const VETO_UNLOADED_RECHECK_MS = 15 * 60 * 1000
  setInterval(() => {
    try {
      if (!store || !hunter) return
      if (hunter.job && hunter.job.running) return
      const veto = (store.db && store.db.veto) || {}
      let hasUnloaded = false
      for (const k of Object.keys(veto)) {
        const v = veto[k]
        if (v && (v.type === 'unloaded' || v.type === 'vm-blocked') && !v.partial) { hasUnloaded = true; break }
      }
      if (!hasUnloaded) return
      const last = Number(store.db.vetoUnloadedCheckAt) || 0
      if (Date.now() - last < VETO_UNLOADED_RECHECK_MS) return
      // 节流水位：**只记内存，不在这里落盘**（v1.14.2 性能修复，2026-11-24）。
      // 为什么删：紧跟的 refreshUnloadedVeto() 真解冻时会自己 saveDb()，那次会把水位一起
      // 落盘；这里再单独写一次，等于把整份 data/sources.json（生产 36MB 级、每天 96 轮）
      // 白白重写一遍，纯冗余 IO。
      // 代价：只有「本轮没解冻 / 提前 return」时水位不持久化，进程重启后立刻多跑一次核对；
      // 核对幂等（只读一次服务端 list，无变化不改任何东西），可以接受。
      // ★ 内存赋值必须保留：去掉它 last 恒为 0，15 分钟节流会失效、退化成每分钟一次。
      store.db.vetoUnloadedCheckAt = Date.now()
      hunter.refreshUnloadedVeto().catch(e => {
        pushLog({
          msg: `「未知源」自动复查失败：${String((e && e.message) || e).slice(0, 120)}；15 分钟后重试`,
          module: '灌入', level: 'warn', at: Date.now()
        })
      })
    } catch (e) {}
  }, 60 * 1000)
  // 定时爬取：到期后跑增量爬取（文件树 + Releases），已抓取的按 blob sha / 资产标识判重跳过，
  // 只收新音源；内容有变化的就地更新并重置检测结果。
  // 勾了「爬取结束后自动灌入」则走 runAutoPipeline：爬取 → 检测新增/变化音源 → 灌入可用音源。
  setInterval(() => {
    try {
      if (!store || !hunter) return
      const cfg = store.config
      if (!cfg.crawlScheduleEnabled || hunter.job.running) return
      const hours = Math.max(1, Number(cfg.crawlIntervalHours) || 24)
      // v1.13.0：与 Web 版同一条判据 —— crawlNextAt 由 runCrawl 收尾算好（配额/代理/退避）
      const due = Number(store.db.crawlNextAt) || ((store.db.lastCrawl || 0) + hours * 3600 * 1000)
      if (Date.now() < due) return
      // v1.17（配额优化 #5）：上一轮「开跑后即被杀」（无正常收尾）→ 推迟 10 分钟再判，
      // 避免重启后立刻重跑一整轮白花约 62 次配额。手动采集不受此限。
      try {
        const chk = hunter.crawlAttemptInterrupted()
        if (chk.interrupted) {
          const waitMin = Math.ceil((10 * 60 * 1000 - chk.ageMs) / 60000)
          pushLog({ msg: `定时爬取：上一轮 ${Math.max(0, Math.round(chk.ageMs / 60000))} 分钟前刚启动即中断（进程重启），推迟 ${Math.max(1, waitMin)} 分钟再判，避免重复整轮烧配额`, module: '爬取', level: 'info', at: Date.now() })
          return
        }
      } catch (e) {}
      const span = formatIntervalHours(hours)
      if (cfg.crawlAutoImport) {
        pushLog({ msg: `定时爬取到期（间隔 ${span}），开始「增量爬取 → 检测 → 自动灌入」…`, module: '爬取', level: 'info', at: Date.now() })
        hunter.runAutoPipeline().catch(e => pushLog({ msg: '定时任务失败：' + String((e && e.message) || e), module: '爬取', level: 'error', at: Date.now() }))
      } else {
        pushLog({ msg: `定时爬取到期（间隔 ${span}），开始增量爬取（文件树 + Releases 资产）…`, module: '爬取', level: 'info', at: Date.now() })
        hunter.runCrawl({ incremental: true }).catch(e => pushLog({ msg: '定时爬取失败：' + String((e && e.message) || e), module: '爬取', level: 'error', at: Date.now() }))
      }
    } catch (e) {}
  }, 60 * 1000)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ---------------- IPC ----------------
function guard(fn) {
  return async (event, ...args) => {
    try { return { ok: true, data: await fn(event, ...args) } }
    catch (e) { return { ok: false, error: String((e && e.message) || e) } }
  }
}

// mirrors：内置镜像清单（v1.9.13 起设置页下拉由它动态生成，新增镜像不用再改 HTML）
ipcMain.handle('config:get', guard(() => ({
  config: store.config,
  dataDir: getDataDir(),
  defaultRepos: DEFAULT_REPOS,
  mirrors: require('../core/net').MIRROR_PRESETS.map(m => ({ id: m.id, label: m.label }))
})))

ipcMain.handle('config:set', guard((e, patch) => {
  // 附加仓库做规范化（支持完整 URL），避免 Not Found
  if (Array.isArray(patch.customRepos)) {
    const { normalizeRepo } = require('../core/crawler')
    const out = []
    for (const r of patch.customRepos) {
      const n = normalizeRepo(r)
      if (n && out.indexOf(n) === -1) out.push(n)
    }
    patch.customRepos = out
    patch._reposNormalized = patch.customRepos.length
  }
  // 统一仓库清单：对每个条目做规范化（owner/repo 小写去空格），去重，保留 enabled/origin/builtin
  if (Array.isArray(patch.repos)) {
    const { normalizeRepo } = require('../core/crawler')
    const seen = new Set(); const out = []
    for (const it of patch.repos) {
      if (!it || !it.repo) continue
      const n = normalizeRepo(it.repo)
      const k = n ? n.toLowerCase() : ''
      if (!k || seen.has(k)) continue // GitHub 仓库名大小写不敏感，按小写去重避免同一仓库存两份
      seen.add(k)
      out.push({ repo: n, enabled: it.enabled !== false, builtin: !!it.builtin, origin: it.origin || 'custom' })
    }
    patch.repos = out
  }
  const prevProxy = store.config.crawlProxy
  const prevPolicy = store.config.proxyPolicy
  store.saveConfig(patch)
  const netmod = require('../core/net')
  if (store.config.crawlProxy !== prevProxy || store.config.proxyPolicy !== prevPolicy) netmod.resetProxyHealth()
  netmod.applyConfig(store.config) // 网络设置改动即时生效
  return store.config
}))

// ---------------- AI 复检层（v1.14.0，旁路） ----------------
let aiReviewInstance = null
function ai() {
  if (!aiReviewInstance || aiReviewInstance.store !== store) {
    const { AIReview, RISK } = require('../core/aiReview')
    aiReviewInstance = new AIReview(store)
  }
  return aiReviewInstance
}

ipcMain.handle('ai-review:configGet', guard(() => ({ config: ai().publicConfig() })))

ipcMain.handle('ai-review:configSet', guard((e, p) => {
  p = p || {}
  const cur = store.config.aiReview || {}
  // 白名单与默认值由 core/aiReview.normalizeConfig 统一负责。
  // 超限数值会被收敛到上限，这里显式记一条日志（与 web.js 同口径，不静默改）。
  const next = ai().normalizeConfig(cur, p, (clamps) => {
    const desc = clamps.map(x => `${x.key} ${x.from}→${x.to}`).join('；')
    pushLog({ msg: 'AI 复检配置有数值超出上限，已收敛：' + desc, module: 'AI复检', level: 'warn', at: Date.now() })
  })
  // 写盘失败必须抛出来：saveConfig 返回 false 表示磁盘满/权限不足，原来一律当成功，
  // 用户以为配置存下了、重启又回旧值（v1.13.9 修静默失效，与 web.js 同口径）。
  if (store.saveConfig({ aiReview: next }) === false) throw new Error('配置写盘失败（磁盘空间或目录权限），这次修改没有保存成功')
  return ai().publicConfig()
}))

ipcMain.handle('ai-review:test', guard(async () => {
  const r = await ai().review('你是一个连通性探测助手。', '只回复 OK 两个字母。')
  return { ok: !!r.ok, message: r.ok ? '连接成功' : (r.error || '连接失败'), model: (ai().cfg.provider || {}).model || '' }
}))

ipcMain.handle('ai-review:run', guard(async (e, body) => {
  const a = ai()
  body = body || {}
  // 与 Web 端同口径：不在此处 try/catch，run 失败 ({ok:false,error}) 必须 throw
  // 冒泡到 guard，产出顶层 {ok:false,error}，避免被包成 {ok:true,data:{ok:false,...}}。
  const out = await a.run(String(body.kind || 'R1'), body)
  if (out && out.ok === false) throw new Error(out.error || 'AI 复检失败')
  // R1 落日志（自动/手动都要记）
  if (out && out.logged) pushLog({ msg: clusterLogMsg(out, body.trigger === 'auto' ? 'auto' : 'manual'), module: 'AI复检', level: 'info', at: Date.now() })
  return out
}))

ipcMain.handle('ai-review:suggestions', guard((e, filter) => ({ suggestions: ai().listSuggestions(filter || {}) })))

ipcMain.handle('ai-review:apply', guard((e, body) => {
  const a = ai(); body = body || {}
  const APPLYABLE = new Set(['R4', 'R5', 'R6', 'R7'])
  const s = a.store.db.aiSuggestions[body.id]
  if (!s) throw new Error('建议不存在：' + body.id)
  if (!APPLYABLE.has(s.kind)) return { applied: false, reason: '只读结论无需执行' }
  if (s.kind !== String(body.kind || '')) return { applied: false, reason: 'kind 不匹配' }
  const g = a.gate(s.kind)
  // 与 web.js 同口径（v1.13.9）：byUser 只替代「档位」这一把锁，
  // 不能替代 enabled（总开关）与 allowIrreversible（高危不可逆操作）。
  const needIrrev = !!(RISK[s.kind] && RISK[s.kind].needsIrreversible)
  if (!g.auto) {
    if (needIrrev && !a.cfg.allowIrreversible) {
      return { applied: false, needSetting: 'allowIrreversible', reason: '这是不可逆操作，需要先在设置里打开「允许不可逆操作」' }
    }
    if (!a.cfg.enabled) return { applied: false, needSetting: 'enabled', reason: 'AI 复检总开关未开启，不能执行任何 AI 动作' }
    if (!body.byUser) return { applied: false, needUserConfirm: true, reason: g.reason }
  }
  s.status = 'applied'; s.appliedAt = Date.now(); s.appliedBy = body.byUser ? 'user' : 'ai'
  s.feedback = { action: 'adopt', at: Date.now(), by: body.byUser ? 'user' : 'ai' }
  a.store.saveDb()
  // v1.15.0：诚实告知——apply 只标记采纳，不执行任何业务动作（真实执行仅在评测沙箱）。
  return { applied: true, executed: false, message: '已标记采纳，未执行任何业务动作；实际处理需你手动操作', suggestion: s }
}))

// 反馈闭环（与 web.js 镜像）：忽略只标采纳意愿，不碰执行白名单/门控/业务状态。
ipcMain.handle('ai-review:dismiss', guard((e, body) => {
  const a = ai(); body = body || {}
  const s = a.store.db.aiSuggestions[body.id]
  if (!s) throw new Error('建议不存在：' + body.id)
  s.status = 'dismissed'
  s.feedback = { action: 'dismiss', at: Date.now(), by: body.byUser ? 'user' : 'ai' }
  a.store.saveDb()
  return { dismissed: true, id: s.id }
}))

ipcMain.handle('ai-review:undo', guard((e, auditId) => {
  const out = ai().undo(String(auditId || ''))
  store.saveDb()
  return out
}))

// 只读评测报告（与 web.js 镜像）：回放日志 + 样本 → 分层指标 / 数据不足。纯聚合、零副作用。
// 样本读取失败必须显式暴露（与 web.js 同口径）：原来 catch 吞成 cases=[] 后
// 「样本读坏了」与「确实没样本」同症状，评测静默失效。
// 该 IPC 每次打开 AI 页都会被调，同一错误只记一条日志（内存去重，不落盘）。
let _evalCasesErrLogged = ''
ipcMain.handle('ai-review:evalReport', guard(() => {
  const ec = require('../core/evalCases')
  const path = require('path')
  const casesDir = path.join(__dirname, '..', '..', 'tests', 'eval-cases')
  const load = ec.tryLoadCases(casesDir)
  const cases = load.cases
  if (load.error && load.error !== _evalCasesErrLogged) {
    _evalCasesErrLogged = load.error
    pushLog({ msg: '评测样本读取失败，评测结果不可信：' + load.error, module: 'AI评测', level: 'warn', at: Date.now() })
  }
  const logs = Object.keys(store.db.aiEvalLog || {}).map(k => store.db.aiEvalLog[k])
  const metrics = ec.computeMetrics(logs, cases)
  const a = ai()
  // 与 web.js 镜像：反馈闭环只读聚合，零 AI、零副作用。
  return {
    ok: true, cases: cases.length, logs: logs.length, metrics,
    casesError: load.error || '',      // 空串=样本读取正常；非空=读坏了/没打进产物
    feedbackStats: a.feedbackStats(), selfCheck: a.selfCheck()
  }
}))

// P1-3 服务端画像只读端点（与 web.js 镜像）：仅回读落盘画像，不计算、不请求、不驱动任何行为。
ipcMain.handle('server:fleetProfile', guard(() => ({ profile: store.db.serverFleetProfile || null })))

// 通用自动复检定时器：每小时轮询。R1 失败聚类日志只受总开关 enabled 管（与自动挡解耦），
// 保持 clusterIntervalHours 每周语义；R3 自动只读复检受 aiSchedulePlan（自动挡）管。
// 水位：R1 用 db.aiLastClusterAt，R3 用 aiSchedulePlan 内部水位；无论成败都推进，避免刷屏；全程静默。
setInterval(async () => {
  try {
    if (!store) return
    const cfg = store.config.aiReview || {}
    const { aiSchedulePlan, selectScope } = require('../core/aiSchedule')
    const plan = aiSchedulePlan(cfg, store.db.aiAutoReview || {}, Date.now())
    // ① R1 失败聚类日志：受 enabled + autoActions.clusterLog 授权位管（默认开，保留既有零误伤自动化）
    if (cfg.enabled && (!cfg.autoActions || cfg.autoActions.clusterLog !== false)) {
      const rawHours = cfg.clusterIntervalHours || 168
      const intervalMs = Math.max(1, Number(rawHours) || 168) * 3600 * 1000
      const last = Number(store.db.aiLastClusterAt) || 0
      if (Date.now() - last >= intervalMs) {
        try {
          const fail = store.getSources().filter(e => e && (e.error || e.status === 'dead' || e.status === 'quarantined'))
          const out = await ai().run('R1', { entries: fail, trigger: 'auto', logOnly: true })
          pushLog({ msg: clusterLogMsg(out, 'auto'), module: 'AI复检', level: 'info', at: Date.now() })
        } catch (e) {}
        try { store.db.aiLastClusterAt = Date.now(); store.saveDb() } catch (e) {}
      }
    }
    // ② v1.16：AI 判非音源仓库的门控自动拉黑（R10）。不调 LLM（复用 repoAiHints 现成结论），
    // 只受「自动挡到期/时段 + 总闸 + autoActions.R10 + 不可逆双锁 + 评测达标 + 三重旁证 AND」管；
    // 默认 autoActions.R10=false + allowIrreversible=false ⇒ 永不执行，只留建议层人工确认。
    //
    // v1.16.1 水位修正：原先这里用 plan.due，但 plan.due 的水位（db.aiAutoReview.lastAttempt/
    // lastRun）**只由下面的 ③ 段推进**，而 ③ 段被 autoLlmReviewEnabled（默认关）挡在门口 return。
    // 于是「用户开了 autoActions.R10 但没开 autoLlmReviewEnabled」时 plan.due 恒 true →
    // 每小时都重跑一次验真（≤20 仓 × 1~2 次 GitHub 请求 = 20~100 次/小时），持续烧配额。
    // 现在 R10 用**自己的水位 db.aiR10LastAt**，按 autoIntervalHours 判定到期，与 ③ 段完全解耦。
    const r10Hours = Math.min(720, Math.max(1, Number(cfg.autoIntervalHours) || 24))
    const r10GapMs = r10Hours * 3600 * 1000
    const r10Last = Number(store.db.aiR10LastAt) || 0
    const r10Due = !r10Last || Date.now() - r10Last >= r10GapMs
    if (cfg.enabled && cfg.autoEnabled && cfg.autoActions && cfg.autoActions.R10 === true && r10Due && plan.activeNow) {
      let ranAt = Date.now()
      try {
        // 不传 _internal：本方法内含真实网络验真，需要自己占任务位并与爬取互斥（忙时被拒绝，下轮再试）
        const out = await hunter.pruneAiRepos({})
        if (out && out.blocked && out.blocked.length) {
          pushLog({ msg: `AI 自动拉黑非音源仓库：${out.blocked.length} 个（三重旁证+门控全过）`, module: 'AI复检', level: 'warn', at: Date.now() })
        }
      } catch (e) {
        const busy = /已有任务在运行/.test(String((e && e.message) || e))
        // 忙时被任务位拒绝 ⇒ 本轮**没执行、没烧配额**，不推进水位，下小时再试
        if (busy) ranAt = 0
        // 门控/并发/执行异常：不中断后续只读复检，但要留痕（否则「为什么不自动」无从排查）
        pushLog({ msg: 'AI 自动拉黑未执行：' + String((e && e.message) || e).slice(0, 120), module: 'AI复检', level: 'info', at: Date.now() })
      } finally {
        // 真正执行过（含失败）才推进水位：避免失败后每小时重试把自己的配额烧光
        if (ranAt) { try { store.db.aiR10LastAt = ranAt; store.saveDb() } catch (_) {} }
      }
    }
    // ③ 自动只读复检：受自动挡开关/到期/时段控制；选范围 → 逐条 R3 只读分析，只产建议、不执行。
    // 独立开关 autoLlmReviewEnabled 默认关：该路径每轮 20-60 次 LLM 仅产无人消费的 applied 标记，
    // 零进化价值；R1 本地聚类/自生长（①，已在上面）不受影响。评测达标后再开此开关。
    if (!cfg.autoLlmReviewEnabled) return
    if (!plan.due || !plan.activeNow) return
    let batchError = null   // 失败退避信号：本轮同步失败写进 lastError（静默但可查，退避据此生效）
    // 异步（fire-and-forget）失败可能在本轮 finally 之后才 reject，回调里直接落库 lastError，
    // 否则等不到下一轮 while 就丢了信号。lastRun 只在同步轮成功时更新。
    const markAsyncError = (e) => {
      try {
        const prev = store.db.aiAutoReview || {}
        store.db.aiAutoReview = Object.assign({}, prev, { lastError: String((e && e.message) || e).slice(0, 300) })
        store.saveDb()
      } catch (_) {}
    }
    try {
      const ids = selectScope(store.getSources(), plan.scope, plan.limit, Date.now()) || []
      let done = 0, marked = 0
      for (const id of ids) {
        try {
          const src = store.getSources().find(e => e && String(e.id) === String(id)) || {}
          const text = [src.error, src.status].filter(Boolean).join(' / ')
          const name = src.name || src.lxName || src.scriptName || ''
          const r = ai().run('R3', { entryId: id, trigger: 'auto', text, name })
          if (r && typeof r.then === 'function') awaitIgnore(r, markAsyncError)
          // 自动铺轨：R4/R5 授权位开启且 gate 放行时产建议（v1.15 不再写 applied）。
          // R6/R7 高危不自动产；真实执行只在评测沙箱 executor 里。
          if (cfg.autoActions && (cfg.autoActions.R4 === true || cfg.autoActions.R5 === true)) {
            const runExec = async () => {
              const kinds = []
              if (src.updateUrl) kinds.push('R4')
              if (src.error || src.status === 'dead') kinds.push('R5')
              for (const k of kinds) {
                const rr = await ai().run(k, {
                  entryId: id, trigger: 'auto',
                  text: '名称：' + name + '\n状态/错误：' + text + (k === 'R4' ? '\n更新地址：' + src.updateUrl : ''),
                  evidence: [{ key: 'autoScope', ok: true }]
                })
                if (rr && rr.autoMarked) marked++
              }
            }
            const p = runExec(); if (p && typeof p.then === 'function') awaitIgnore(p, markAsyncError)
          }
          done++
        } catch (e) { batchError = batchError || e }
      }
      pushLog({ msg: 'AI 自动只读复检：本轮处理 ' + done + ' 条' + (marked ? '；授权通过 ' + marked + ' 条（仅建议，未执行业务）' : ''), module: 'AI复检', level: 'info', at: Date.now() })
    } catch (e) { batchError = batchError || e } finally {
      // 水位喂全：lastAttempt 恒推进；成功写 lastRun 并清 lastError；失败保留/写 lastError 触发退避。
      try {
        const prev = store.db.aiAutoReview || {}
        const patch = { lastAttempt: Date.now() }
        if (!batchError) patch.lastRun = Date.now()
        patch.lastError = batchError ? String((batchError && batchError.message) || batchError).slice(0, 300) : null
        store.db.aiAutoReview = Object.assign({}, prev, patch)
        store.saveDb()
      } catch (e) {}
    }
  } catch (e) {}
}, 60 * 60 * 1000).unref?.()
function awaitIgnore(p, onError) { try { p.catch(onError || (() => {})) } catch (e) { if (onError) onError(e) } }

ipcMain.handle('net:test', guard(async (e, opts) => {
  const { testNetwork } = require('../core/net')
  return await testNetwork(opts || {})
}))

// 逐镜像测速（设置页「测速」按钮）
ipcMain.handle('net:mirrorTest', guard(async (e, opts) => {
  const { testMirrorSpeeds } = require('../core/net')
  return await testMirrorSpeeds(opts || {})
}))

// 加速镜像自动发现（v1.9.19）：与 Web 版同一条路径（force 无视 24h 窗口）
// 注意：v1.9.19 只给 Web 版加了这两个通道，桌面版点「自动发现镜像」会报
// api.mirrorDiscover is not a function —— v1.9.20 补齐，桌面/网页行为从此一致。
ipcMain.handle('net:mirrorDiscover', guard(async (e, opts) => {
  const b = opts || {}
  if (b.force) {
    const r = await hunter.refreshMirrorPool(true)
    return r || { ok: false, error: '自动发现未执行（已在设置里关闭）' }
  }
  const { discoverMirrors } = require('../core/net')
  const r = await discoverMirrors(b)
  store.saveConfig({ mirrorPool: r.pool, mirrorDiscoverAt: Date.now() })
  pushLog({
    msg: `镜像自动发现：候选 ${r.total} 个，新增 ${r.added} 个、剔除失效 ${r.removed} 个、保留 ${r.kept} 个`,
    module: '网络', level: 'info', at: Date.now()
  })
  return r
}))

// 镜像池手动维护：{remove:[id]} 或 {enable:{id:true/false}}
ipcMain.handle('net:mirrorPoolSet', guard((e, patch) => {
  const b = patch || {}
  let pool = Array.isArray(store.config.mirrorPool) ? store.config.mirrorPool.slice() : []
  if (Array.isArray(b.remove) && b.remove.length) pool = pool.filter(m => !b.remove.includes(m.id))
  if (b.enable && typeof b.enable === 'object') {
    for (const m of pool) if (b.enable[m.id] != null) m.enabled = !!b.enable[m.id]
  }
  store.saveConfig({ mirrorPool: pool })
  require('../core/net').applyConfig({ mirrorPool: pool })
  return { ok: true, pool }
}))

// 爬取代理有效性检测（v1.9.20 设置页「测试代理」按钮）
ipcMain.handle('net:proxyTest', guard(async (e, opts) => {
  const { testProxy } = require('../core/net')
  return await testProxy(opts || {})
}))

// 代理健康状态（v1.11.0，与 Web 版 /api/net/proxy-health 对应）
ipcMain.handle('net:proxyHealth', guard(() => require('../core/net').getProxyHealth()))
ipcMain.handle('net:proxyHealthReset', guard(() => {
  const netmod = require('../core/net')
  netmod.resetProxyHealth()
  return netmod.getProxyHealth()
}))

// ---------------- 音源采集站（v1.9.20 补桌面版通道，逻辑与 Web 版一致）----------------
const hubfeed = require('../core/hubfeed')

function normHubMain(h) {
  if (!h || !h.url) return null
  const url = String(h.url).trim().replace(/\/+$/, '')
  return {
    id: String(h.id || hubfeed.makeHubId(url)),
    name: String(h.name || url).slice(0, 80),
    url,
    kind: String(h.kind || ''),
    enabled: h.enabled !== false,
    entriesUrl: String(h.entriesUrl || ''),
    detailUrl: String(h.detailUrl || ''),
    lastSync: h.lastSync || null,
    addedAt: h.addedAt || Date.now()
  }
}

ipcMain.handle('hubs:get', guard(() => ({ hubs: Array.isArray(store.config.hubs) ? store.config.hubs : [] })))

ipcMain.handle('hubs:test', guard(async (e, url) => {
  return await hubfeed.detectHub(String(url || '').trim(), store.config.timeoutMs)
}))

ipcMain.handle('hubs:add', guard(async (e, payload) => {
  const b = payload || {}
  const url = String(b.url || '').trim()
  if (!url) throw new Error('缺少站点地址')
  const det = (b.detect && b.detect.ok) ? b.detect : await hubfeed.detectHub(url, store.config.timeoutMs)
  if (!det.ok) return { ok: false, error: '无法识别为音源采集站：' + det.error }
  const list = Array.isArray(store.config.hubs) ? store.config.hubs.slice() : []
  if (list.some(h => String(h.url).replace(/\/+$/, '') === url.replace(/\/+$/, ''))) return { ok: false, error: '该站点已在列表中' }
  const h = normHubMain({ id: hubfeed.makeHubId(url), name: b.name || url, url, kind: det.kind, entriesUrl: det.entriesUrl, detailUrl: det.detailUrl })
  list.push(h)
  store.saveConfig({ hubs: list })
  pushLog({ msg: `已添加音源采集站「${h.name}」（${det.kindLabel}，实测可用 ${det.usable}/${det.total} 条）`, module: '采集', level: 'info', at: Date.now() })
  return { ok: true, hub: h, detect: det, hubs: list }
}))

ipcMain.handle('hubs:update', guard((e, patch) => {
  const b = patch || {}
  const list = Array.isArray(store.config.hubs) ? store.config.hubs : []
  const i = list.findIndex(h => h.id === b.id)
  if (i < 0) throw new Error('站点不存在')
  if (b.name != null) list[i].name = String(b.name).slice(0, 80)
  if (b.enabled != null) list[i].enabled = !!b.enabled
  if (b.url != null) list[i].url = String(b.url).trim().replace(/\/+$/, '')
  store.saveConfig({ hubs: list })
  return { ok: true, hubs: list }
}))

ipcMain.handle('hubs:remove', guard((e, id) => {
  const list = (Array.isArray(store.config.hubs) ? store.config.hubs : []).filter(h => h.id !== id)
  store.saveConfig({ hubs: list })
  pushLog({ msg: '已移除音源采集站：' + String(id || ''), module: '采集', level: 'info', at: Date.now() })
  return { ok: true, hubs: list }
}))

ipcMain.handle('hubs:sync', guard(async (e, opts) => await hunter.runHubSync(opts || {})))

// ---------------- 数据导入/导出（v1.9.20，仓库/采集站/镜像三类配置搬家）----------------
const dataio = require('../core/dataio')
const DATA_NAMES = { repos: 'lx-hunter-repos', hubs: 'lx-hunter-hubs', mirrors: 'lx-hunter-mirrors' }
const DATA_TITLES = { repos: '仓库清单', hubs: '音源采集站', mirrors: 'raw 加速镜像' }

ipcMain.handle('data:export', guard(async (e, scope) => {
  const res = await dialog.showSaveDialog(win, {
    title: `导出${DATA_TITLES[scope] || '数据'}`,
    defaultPath: `${DATA_NAMES[scope] || 'lx-hunter-data'}-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return { exported: false }
  fs.writeFileSync(res.filePath, JSON.stringify(dataio.buildExport(store, scope), null, 2), 'utf8')
  return { exported: true, path: res.filePath }
}))

ipcMain.handle('data:import', guard(async (e, scope) => {
  const res = await dialog.showOpenDialog(win, {
    title: `导入${DATA_TITLES[scope] || '数据'}`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { imported: false }
  const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'))
  const summary = dataio.importData(store, scope, data)
  pushLog({
    msg: `导入${summary.label}：新增 ${summary.added}、更新 ${summary.updated}（现有 ${summary.total} 条）`,
    module: '数据', level: 'info', at: Date.now()
  })
  require('../core/net').applyConfig(store.config)
  return { imported: true, summary }
}))


ipcMain.handle('service:test', guard(async (e, cfgOverride) => {
  const svc = resolveService(store.config, cfgOverride)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.verify(svc.acct)
}))

ipcMain.handle('service:list', guard(async () => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.list(svc.acct)
}))

// 账本对账：渲染层刚读到该账号的服务端列表，把「服务端已不存在」的灌入记录摘掉。
// liveIds 由渲染层传（就是它刚展示的那份列表），核心层不再多打一次服务端。
ipcMain.handle('service:reconcile', guard(async (e, platformId, liveIds) => {
  return hunter.reconcileImported(platformId, liveIds)
}))

ipcMain.handle('sources:get', guard(() => {
  // 旧库数据没有 failKind（v1.6.5 前的深检结果）：就地补算一次，
  // 失效统计/筛选/徽章立即生效，并在下次落库时持久化
  const { deepFailKind } = require('../core/checker')
  for (const s of store.getSources()) {
    if (s.deep && s.deep.failKind == null) s.deep.failKind = deepFailKind(s.deep)
  }
  return {
    // 桌面版同样剥掉 code：IPC 也要序列化这 11MB，剥掉后列表响应体 14.3MB → 2.7MB
    // （渲染层列表不用正文，见 core/sourceView.js 的说明）
    // v1.10.8：桌面版与 Web 版保持一致——隔离区三档分级随列表下发（qzLevel/qzReasons）
    sources: require('../core/sourceView').publicSourceList(store.getSources(), store.config),
    imported: store.imported,
    lastCrawl: store.db.lastCrawl,
    patrol: store.db.patrol || { lastRun: 0 }
  }
}))

ipcMain.handle('logs:get', guard(() => logs.slice(-800)))

ipcMain.handle('logs:clear', guard(() => { logs.length = 0; return true }))

// 站外分发源（v1.11.0）：与 Web 版 /api/externals/* 一一对应
ipcMain.handle('externals:get', guard(() => ({ sources: hunter.listExternalSources() })))
ipcMain.handle('externals:probe', guard(async (e, url) => await hunter.probeExternal(String(url || ''))))
ipcMain.handle('externals:add', guard(async (e, payload) => {
  const p = payload || {}
  const det = p.detect || await hunter.probeExternal(String(p.url || ''))
  return { ok: true, sources: hunter.addExternalSource(String(p.url || ''), det) }
}))
ipcMain.handle('externals:update', guard((e, payload) => {
  const p = payload || {}
  return { ok: true, sources: hunter.updateExternalSource(String(p.url || ''), p.patch || {}) }
}))
ipcMain.handle('externals:remove', guard((e, url) => ({ ok: true, sources: hunter.removeExternalSource(String(url || '')) })))


ipcMain.handle('crawl:start', guard(async (e, opts) => {
  // v1.10.6：opts.only 非空时定向主动采集（清单页每行「采集」按钮）
  const r = await hunter.runCrawl(opts || {})
  return r
}))

ipcMain.handle('check:start', guard(async (e, ids, opts) => {
  return await hunter.runCheck(ids, opts)
}))

// 快速去重：只下载 + 内容哈希，不进沙箱
ipcMain.handle('hash:start', guard(async (e, ids) => {
  return await hunter.runHash(ids)
}))

// v1.8.0：opts.platformIds 可显式指定灌入目标（不给则用设置里标记「参与批量灌入」的账号）
ipcMain.handle('import:start', guard(async (e, ids, opts) => {
  return await hunter.runImport(ids, opts)
}))

// 同步服务端已有音源 → 全部纳入管理，算作「已灌入」
ipcMain.handle('server:sync', guard(async () => await hunter.runSyncServer()))

ipcMain.handle('job:cancel', guard(() => ({ cancelled: hunter.requestCancel() })))

ipcMain.handle('job:state', guard(() => ({ running: hunter.job.running, type: hunter.job.type, progress: hunter.job.progress, step: hunter.job.step })))

ipcMain.handle('patrol:start', guard(async () => await hunter.runPatrol()))

// v1.14.1：「未知源」冻结按服务端实况重新核对（桌面版；Web 版走 web.js 的 POST /api/veto/refresh）
ipcMain.handle('veto:refresh', guard(async () => await hunter.refreshUnloadedVeto()))

ipcMain.handle('revoke', guard(async (e, ids) => await hunter.runRevoke(ids)))

ipcMain.handle('db:undedupe', guard((e, ids) => {
  if (hunter.job.running) return { restored: 0, busy: true }
  const r = hunter.restoreDedupe(Array.isArray(ids) ? ids : null)
  return Object.assign({ busy: false }, r)
}))

ipcMain.handle('db:clear', guard(() => {
  store.clearSources()
  return { ok: true }
}))

// 非音源仓库清理（v1.10.3）：与 Web 版 /api/repos/prune 同语义
ipcMain.handle('repos:prune', guard((e, opts) => hunter.pruneNonSourceRepos(opts || {})))
// v1.16：AI 判非音源仓库的门控自动拉黑（默认关，三重旁证 AND 全过才动手）
ipcMain.handle('repos:pruneAi', guard((e, opts) => hunter.pruneAiRepos(opts || {})))
// 仓库行快捷拉黑（v1.10.7）：与 Web 版 /api/repos/block 同语义
// v1.16：兼容 repo 字符串 或 {repo, by, reason}（by 由建议层传 'user'）
ipcMain.handle('repos:block', guard((e, arg) => {
  const repo = typeof arg === 'string' ? arg : String((arg || {}).repo || '')
  const o = (arg && typeof arg === 'object') ? { by: arg.by, reason: arg.reason } : {}
  return hunter.blockRepo(repo, o)
}))
// 解除拉黑（v1.10.7）：与 Web 版 /api/repos/unblock 同语义
ipcMain.handle('repos:unblock', guard((e, args) => hunter.unblockRepo(String((args || {}).repo || ''), (args || {}).reAdd)))
// 混淆隔离：信任/取消信任（v1.10.7）
ipcMain.handle('sources:trustObf', guard((e, args) => hunter.trustObfSource(String((args || {}).id || ''), !!(args || {}).trust)))
// v1.15 P2：用户自定义标签
ipcMain.handle('sources:setUserTag', guard((e, args) => hunter.store.setUserTag(String((args || {}).id || ''), (args || {}).tag)))
// 混淆隔离：试跑一次（v1.13.12）——只实测、不信任。
//
// 配额与串行逻辑在 core/probeQueue.js（v1.13.13 抽出），原因：
//   ① 它是「用户手动点试跑」这个交互的约束，不属于 hunter 的业务语义；
//   ② Web 端原先根本没有试跑通道（A1 复查发现），补路由时必须用**同一套**保护，
//      否则 Web 端可无限试跑、且能并发开多个沙箱。
//
// ⚠️ 残留风险如实：试跑仍在**主线程**跑 deepCheck（没搬 worker）。
// worker 化需要把整个 deepCheck 依赖链（sandbox / net / checker 辅助函数）搬进 worker，
// 属于后续批次。当前缓解手段是：串行 + 单轮上限 + 沙箱自身的资源配额闸门。
// 尚不能硬杀的是「定时器回调里的 CPU 空转」——vm 的 timeout 只约束同步段，
// 这类脚本会让主线程卡到它自己结束。block 档（含空转特征）因此要求二次确认。
const probeQueue = makeProbeQueue()
ipcMain.handle('sources:probeQuarantined', guard((e, args) => {
  const a = args || {}
  return probeQueue.run(() => hunter.probeQuarantined(String(a.id || ''), { confirmBlock: !!a.confirmBlock }))
}))
// v1.15 配额可见：UI 进隔离区时查一次，常驻显示"还可试跑 N/5，M 分钟后重置"
ipcMain.handle('sources:probeQuota', guard(() => probeQueue.status()))

// 手动删除选中音源（v1.10.2）：与 Web 版 /api/db/delete 同签名、同语义
ipcMain.handle('db:delete', guard((e, ids) => {  if (!Array.isArray(ids) || !ids.length) throw new Error('没有选中要删除的音源')
  const r = store.removeSources(ids)
  hunter.log(`手动删除音源 ${r.deleted} 条；累计 ${r.blocked} 条不再自动采集` +
    (r.ledgerDropped ? `；同步清理 ${r.ledgerDropped} 条占位灌入账本` : ''), '音源库', 'info')
  return r
}))
ipcMain.handle('db:deleted:list', guard(() => ({ ids: store.deletedIds() })))
ipcMain.handle('db:deleted:clear', guard(() => {
  const r = store.clearDeletedIds()
  hunter.log(`已清除 ${r.cleared} 条音源删除记录，后续自动采集可重新收录这些音源`, '音源库', 'info')
  return r
}))

ipcMain.handle('db:export', guard(async (e, ids) => {
  const res = await dialog.showSaveDialog(win, {
    title: '导出音源库（含检测结果，可导入到其他机器）',
    defaultPath: `lx-hunter-sources-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return { exported: false }
  const sources = store.getSources().map(x => { const c = Object.assign({}, x); delete c.checking; return c })
  let list = sources
  let imported = store.imported
  if (Array.isArray(ids) && ids.length) {
    const set = new Set(ids)
    list = sources.filter(s => set.has(s.id))
    const imp = {}
    for (const [k, v] of Object.entries(store.imported)) if (set.has(k)) imp[k] = v
    imported = imp
  }
  fs.writeFileSync(res.filePath, JSON.stringify({
    version: 2, app: 'lx-hunter-pc', exportedAt: Date.now(),
    sources: list, imported, lastCrawl: store.db.lastCrawl
  }, null, 2), 'utf8')
  return { exported: true, path: res.filePath, count: list.length }
}))

// 导入音源库：按 id / contentHash 合并检测结果，换机迁移不用重跑
ipcMain.handle('db:import', guard(async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入音源库（合并检测结果）',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { imported: false }
  const raw = fs.readFileSync(res.filePaths[0], 'utf8')
  let data
  try { data = JSON.parse(raw) } catch (e) { throw new Error('文件不是有效的 JSON：' + String(e.message || e).slice(0, 80)) }
  const summary = store.mergeFrom(data)
  return { imported: true, summary, path: res.filePaths[0] }
}))

// 导入单个音源：选一个 .js 文件入库并标记「私人音源」（不参与去重与巡检，可手动检测 / 灌入）
ipcMain.handle('source:importSingle', guard(async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入单个音源（标记私人音源）',
    filters: [{ name: '音源脚本 JS', extensions: ['js'] }],
    properties: ['openFile']
  })
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { imported: false }
  const file = res.filePaths[0]
  const code = fs.readFileSync(file, 'utf8')
  const name = path.basename(file)
  const r = store.addPrivateSource(name, code)
  pushLog({
    msg: `${r.added ? '已导入私人音源' : '已更新私人音源（重新导入）'}「${r.entry.name}」（不参与去重与巡检，可手动检测 / 灌入）`,
    module: '音源库', level: 'info', at: Date.now()
  })
  return { imported: true, added: r.added, updated: r.updated, name: r.entry.name, path: file }
}))

// 对单条音源做「校验脚本」：提交给服务端 validate（不落盘）
ipcMain.handle('source:validate', guard(async (e, id) => {
  const entry = store.db.sources[id]
  if (!entry) throw new Error('音源不存在')
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  const { crawlFetch, readText } = require('../core/net')
  const { res } = await crawlFetch(entry.url, null, store.config.timeoutMs, store.config.mirror)
  if (!res || !res.ok) throw new Error('脚本下载失败')
  const code = await readText(res, store.config.timeoutMs)
  const r = await svc.adapter.validate(svc.acct, code)
  return { status: r.status, data: r.data, text: r.text }
}))

// 手动填 URL 灌入（PC 端下载后直传内容，服务端无需出网）
ipcMain.handle('import:url', guard(async (e, url, name) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  const { crawlFetch, readText } = require('../core/net')
  let r = null
  const { res } = await crawlFetch(url, null, store.config.timeoutMs, store.config.mirror)
  if (res && res.ok) {
    const code = await readText(res, store.config.timeoutMs)
    r = await svc.adapter.upload(svc.acct, code, name)
  } else {
    r = await svc.adapter.importUrl(svc.acct, url, name)
  }
  if (r.success) {
    store.imported['manual:' + r.id] = {
      lxId: r.id, name: r.name || name || url, contentHash: '',
      serverUrl: svc.adapter.baseUrl(svc.acct), importedAt: Date.now(), platforms: r.platforms || [],
      platformId: svc.acct.id, platformType: svc.type, accountName: svc.acct.name
    }
    store.saveImported()
  }
  return r
}))

ipcMain.handle('service:toggle', guard(async (e, id, enabled, owner, reason) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  const r = await svc.adapter.toggle(svc.acct, id, enabled, { owner, reason })
  // v1.14.2（2026-11-24）：启用被服务端以「需要原生 VM」回滚时，把原因记进账本
  // （桌面版与网页版同口径，见 server/web.js 同一处注释）。
  try { if (hunter) hunter.noteToggleNeedUnsafeVM(id, r) } catch (err) { /* 记账失败不影响开关结论 */ }
  return r
}))
ipcMain.handle('service:remove', guard(async (e, id, owner) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.remove(svc.acct, id, { owner })
}))
// 停用/启用（走 update-platforms，不触发服务端全量重载，不会假死）
// owner：源的归属身份，私有源（owner=admin 等）的停用必须写其身份那份 states 才生效
ipcMain.handle('service:platforms', guard(async (e, id, disabledSources, owner) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  return await svc.adapter.setPlatforms(svc.acct, id, disabledSources, { owner })
}))

// 公共音源清理（v1.7.4）：只删服务端公开源（_open），绝不碰各账号私有源；
// 仅 LX Server / Geelonn LX Server 平台具备该能力，其他平台（Songloft / MusicSync）返回友好提示。
ipcMain.handle('service:listPublic', guard(async () => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  if (svc.type !== 'lxserver' && svc.type !== 'geelonn') return { ok: false, error: '当前平台（' + TYPE_LABELS[svc.type] + '）不支持公共音源清理，仅 LX Server / Geelonn LX Server 支持' }
  return await svc.adapter.listPublic(svc.acct)
}))
// 批量删除：服务端每次 delete 都会全量重载脚本（几十秒），串行执行并逐个上报进度
ipcMain.handle('service:removePublicBatch', guard(async (e, ids) => {
  const svc = getActiveService(store.config)
  if (!svc) throw new Error(NO_ACCOUNT_ERR)
  if (svc.type !== 'lxserver' && svc.type !== 'geelonn') return { ok: false, error: '当前平台（' + TYPE_LABELS[svc.type] + '）不支持公共音源清理，仅 LX Server / Geelonn LX Server 支持' }
  return await svc.adapter.removePublicBatch(svc.acct, ids, (done, total, item) => {
    emitAll('log', {
      msg: `删除公共音源 ${done}/${total}：${item.id}${item.success ? '' : ' — 失败：' + item.message}`,
      module: '服务', level: item.success ? 'info' : 'warn', at: Date.now()
    })
    emitAll('event', { type: 'pub-delete', payload: { done, total, id: item.id, success: item.success } })
  })
}))

ipcMain.handle('app:openDataDir', guard(() => {
  shell.openPath(getDataDir())
  return true
}))
