'use strict'
/**
 * AI 复检层测试（v1.14.0）：门控 / 证据门槛 / undo 幂等与深拷贝 /
 * 预算 / 超时不阻塞 / 自定义 OpenAI 兼容中转站 / R1-R2 纯本地能力 /
 * 双外壳 API 镜像一致性 / apiKey 脱敏 / 检测详情 detail 与 off 档语义。
 * 零框架，assert + 计数，沿用 security-hardening 风格。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

const ROOT = path.join(__dirname, '..')
const { Store, DEFAULT_CONFIG } = require(path.join(ROOT, 'src', 'core', 'store'))
const { AIReview, RISK, REVIEW_PROMPTS } = require(path.join(ROOT, 'src', 'core', 'aiReview'))
const aiProvider = require(path.join(ROOT, 'src', 'core', 'aiProvider'))

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-ai-'))
  return new Store(dir)
}

console.log('--- ① 配置模型：默认安全 + 完全自定义中转站 ---')
ok(DEFAULT_CONFIG.aiReview && DEFAULT_CONFIG.aiReview.enabled === false, '默认关闭')
ok(DEFAULT_CONFIG.aiReview.mode === 'off' && DEFAULT_CONFIG.aiReview.allowIrreversible === false, '默认 off 档、第三锁关闭')
ok(DEFAULT_CONFIG.aiReview.provider && 'baseUrl' in DEFAULT_CONFIG.aiReview.provider && 'model' in DEFAULT_CONFIG.aiReview.provider && 'headers' in DEFAULT_CONFIG.aiReview.provider, 'provider 开放 baseUrl/model/headers 自定义')
;(() => {
  const s = tmpStore()
  // 模拟旧配置：aiReview 只有半截，浅合并会吃掉默认 provider
  s.saveConfig({ aiReview: { enabled: true, provider: { baseUrl: 'https://my-relay.example/v1' } } })
  const s2 = new Store(s.dir)
  ok(s2.config.aiReview.enabled === true, '用户已存值被尊重')
  ok(s2.config.aiReview.provider.baseUrl === 'https://my-relay.example/v1', '自定义中转站地址被保留')
  ok(s2.config.aiReview.provider.timeoutMs === DEFAULT_CONFIG.aiReview.provider.timeoutMs, '半截配置自动补齐默认 timeoutMs')
  ok(s2.config.aiReview.provider.headers && typeof s2.config.aiReview.provider.headers === 'object', '半截配置自动补齐默认 headers')
  ok(s2.config.aiReview.budget && s2.config.aiReview.budget.maxItemsPerRound === 20, '半截配置自动补齐默认 budget')
})()

console.log('--- ② 三档 × 风险级门控 + 三把锁 ---')
;(() => {
  const s = tmpStore()
  const a = new AIReview(s)
  const offGate = a.gate('R1')
  ok(offGate.auto === false && /总开关/.test(offGate.reason), '总开关关闭时零自动（reason 含「总开关」）')
  s.config.aiReview.enabled = true
  const modeOffGate = a.gate('R1')
  ok(modeOffGate.auto === false && /off/.test(modeOffGate.reason), 'off 档不自动（reason 含 off）')
  s.config.aiReview.mode = 'assist'
  ok(a.gate('R1').auto === true, 'assist 档 R1 只读自动')
  ok(a.gate('R2').auto === true && a.gate('R3').auto === true, 'assist 档 R2/R3 自动')
  ok(a.gate('R4').auto === false && a.gate('R5').auto === false, 'assist 档 R4/R5 不自动')
  ok(a.gate('R6').auto === false && a.gate('R7').auto === false, 'assist 档高风险不自动')
  s.config.aiReview.mode = 'auto'
  ok(a.gate('R4').auto === true && a.gate('R5').auto === true, 'auto 档中风险自动')
  ok(a.gate('R6').auto === false && /allowIrreversible/.test(a.gate('R6').reason), 'auto 档高风险仍需第三锁')
  s.config.aiReview.allowIrreversible = true
  ok(a.gate('R6').auto === true && a.gate('R7').auto === true, '第三锁打开后高风险才自动')
  ok(RISK.R6.needsIrreversible && RISK.R7.needsIrreversible, 'R6/R7 标记为不可逆需双锁')
})()

console.log('--- ③ 证据门槛：客观项 AND + AI 引用可定位 ---')
;(() => {
  const s = tmpStore()
  const a = new AIReview(s)
  const g1 = a.evaluateGate([{ key: 'score', ok: true }, { key: 'domain', ok: true }])
  ok(g1.pass === true && g1.missing.length === 0, '全部证据满足 → 通过')
  const g2 = a.evaluateGate([{ key: 'score', ok: true }, { key: 'domain', ok: false }, { key: 'veto', ok: false }])
  ok(g2.pass === false && g2.missing.join(',') === 'domain,veto', '缺项 → 降级并记录缺项 key')
  ok(a.quoteLocatable({ quote: 'lx.on("music")' }, 'function(){ lx.on("music"); }') === true, '逐字引用可定位 → 通过')
  ok(a.quoteLocatable({ quote: '不存在的片段' }, 'function(){ lx.on("music"); }') === false, '编造引用 → 定位失败')
  ok(a.quoteLocatable({}, 'anything') === false, '无引用 → 定位失败')
})()

console.log('--- ④ 建议详情 detail：逐字段携带 + 不传 detail 向后兼容 ---')
;(() => {
  const s = tmpStore()
  const a = new AIReview(s)
  const supplied = {
    inputDigest: 'x',
    gate: { auto: false, reason: '档位 off' },
    promptVersion: 'v1',
    action: '只读'
  }
  const s1 = a.suggest('e1', 'R1', '摘要', [], { detail: supplied })
  ok(s1.detail && typeof s1.detail === 'object', 'suggest 返回携带 detail 对象')
  ok(s1.detail.inputDigest === 'x', 'detail.inputDigest 逐字段保留')
  ok(s1.detail.gate && s1.detail.gate.auto === false, 'detail.gate.auto 逐字段保留')
  ok(s1.detail.gate && s1.detail.gate.reason === '档位 off', 'detail.gate.reason 逐字段保留')
  ok(s1.detail.promptVersion === 'v1', 'detail.promptVersion 逐字段保留')
  ok(s1.detail.action === '只读', 'detail.action 逐字段保留')
  ok(a.store.db.aiSuggestions[s1.id] && a.store.db.aiSuggestions[s1.id].detail === s1.detail, 'detail 随建议一并落库')

  let threw = false
  let s2
  try { s2 = a.suggest('e2', 'R1', '摘要2', []) } catch (e) { threw = true }
  ok(threw === false, '不传 detail 调 suggest 不抛错（向后兼容）')
  ok(s2 && (s2.detail === undefined || (typeof s2.detail === 'object' && Object.keys(s2.detail).length === 0)), '不传 detail 时 s.detail 为 undefined 或空对象')
})()

console.log('--- ⑤ 审计：before 深拷贝 + undo 幂等 + 损坏不静默 ---')
;(() => {
  const s = tmpStore()
  const a = new AIReview(s)
  const before = { target: { path: 'db.sources.x', value: { status: 'ok' } } }
  const rec = a.audit('x', 'R5', before, { target: { path: 'db.sources.x', value: { status: 'done' } } }, 'ai')
  before.target.value.status = 'MUTATED'
  ok(rec.before.target.value.status === 'ok', 'before 是深拷贝，不随外部对象变化')
  const u1 = a.undo(rec.id)
  ok(u1.ok === true && u1.undone === true, 'undo 成功')
  ok(a.undo(rec.id).note && /无需重复/.test(a.undo(rec.id).note), '重复 undo 幂等（不二次写）')
  s.db.aiAudit['bad'] = { id: 'bad', before: null, undone: false }
  let threw = false
  try { a.undo('bad') } catch (e) { threw = /缺少有效 before/.test(e.message) }
  ok(threw, 'before 缺失时报错而非静默成功')
  let missingThrew = false
  try { a.undo('nope') } catch (e) { missingThrew = /不存在/.test(e.message) }
  ok(missingThrew, '审计记录不存在时报错')
})()

console.log('--- ⑥ provider：自定义中转站 / 自定义请求头 / 三态静默降级 ---')
;(async () => {
  const p = { baseUrl: 'https://my-relay.example/v1/', apiKey: 'sk-test', model: 'my-model', headers: { 'X-Relay-Token': 'abc' }, timeoutMs: 1000 }
  ok(aiProvider.joinUrl(p.baseUrl) === 'https://my-relay.example/v1/chat/completions', 'baseUrl 归一到 /chat/completions')
  ok(aiProvider.joinUrl('https://h/v1/chat/completions') === 'https://h/v1/chat/completions', '完整 endpoints 原样保留')
  const h = aiProvider.buildHeaders(p)
  ok(h['X-Relay-Token'] === 'abc' && h['Authorization'] === 'Bearer sk-test' && h['Content-Type'] === 'application/json', '自定义头 + Bearer 鉴权 + JSON 头')

  let seenUrl = '', seenBody = null
  const okFetch = async (url, opt) => {
    seenUrl = url; seenBody = JSON.parse(opt.body)
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }
  }
  const r1 = await aiProvider.chat(p, 'ping', { fetchImpl: okFetch })
  ok(r1.ok === true && r1.text === 'OK', '正常响应解析 choices[0].message.content')
  ok(seenUrl === 'https://my-relay.example/v1/chat/completions' && seenBody.model === 'my-model', '请求打到自定义中转站并使用自定义模型名')

  const r2 = await aiProvider.chat(p, 'ping', { fetchImpl: async () => ({ ok: false, status: 429 }) })
  ok(r2.ok === false && /非 2xx/.test(r2.error), '非 2xx 静默降级为 ok:false')
  const r3 = await aiProvider.chat(p, 'ping', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json') } }) })
  ok(r3.ok === false && /JSON/.test(r3.error), '非 JSON 静默降级')
  const r4 = await aiProvider.chat(p, 'ping', { fetchImpl: async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e } })
  ok(r4.ok === false && /超时/.test(r4.error), '超时静默降级且不抛')

  const s = tmpStore()
  const a = new AIReview(s)
  let blocked = false
  try {
    await a.review('sys', 'text') // 未启用 → 直接返回 ok:false，不触网
  } catch (e) { blocked = true }
  ok(blocked === false, 'AI 调用失败/未启用不抛到主链路（旁路铁律）')
  ok((await a.review('sys', 'text')).ok === false, '未启用时审查返回 ok:false')
})().catch(e => { console.error(e); process.exitCode = 1 }).then(() => learnTests())

console.log('--- ⑦ R1 / R2 纯本地能力（provider 挂了也能用） ---')
;(() => {
  const s = tmpStore()
  const a = new AIReview(s)
  const out = a.clusterFailures([
    { id: 'a', error: 'SSL certificate expired' },
    { id: 'b', error: '证书校验失败' },
    { id: 'c', error: 'RATE_LIMIT 429' },
    { id: 'd', error: 'something else' }
  ])
  ok(out.clusters.some(c => c.reason === '证书 / TLS 错误' && c.count === 2), 'R1 按语义归类证书错误')
  ok(out.clusters.some(c => /限流/.test(c.reason) && c.count === 1), 'R1 归类限流')
  ok(/证书|限流/.test(out.summary), 'R1 输出人话摘要')
  const ex = a.explainVerdict({ act: 'replace', why: '本地平台数更多' }, { localVer: 'v2', srvVer: 'v1' })
  ok(ex.act === 'replace' && /本地 v2/.test(ex.whyAi), 'R2 生成带版本的人话解释')
  ok(a.explainVerdict({ act: 'rename', why: '平台零交集' }).act === 'rename', 'R2 不改裁决 act')
})()

console.log('--- ⑧ 双外壳 API 镜像一致 + apiKey 脱敏（源码契约） ---')
;(() => {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8')
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'web-bridge.js'), 'utf8')
  const web = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
  const methods = ['aiConfigGet', 'aiConfigSet', 'aiTest', 'aiRun', 'aiSuggestions', 'aiApply', 'aiUndo', 'aiEvalReport']
  for (const m of methods) {
    ok(preload.indexOf(m + ':') !== -1, 'preload 暴露 ' + m)
    ok(bridge.indexOf(m + ':') !== -1, 'web-bridge 镜像 ' + m)
  }
  ok(/route\('GET', '\/api\/ai-review\/eval-report'/.test(web), 'Web 端只读 eval-report 路由存在')
  ok(/ipcMain\.handle\('ai-review:evalReport'/.test(fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')), '桌面端 evalReport IPC 存在')
  ok(/c\.aiReview\.provider\.apiKey = ''/.test(web), 'sanitizeConfig 脱敏 AI apiKey')
  ok(/route\('GET', '\/api\/ai-review\/config'/.test(web), 'Web 端 AI config 路由存在')
  ok(/ipcMain\.handle\('ai-review:configSet'/.test(fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')), '桌面端 AI configSet IPC 存在')
  // M1：两端 run handler 必须把 run() 的 {ok:false,error} 转成 throw 冒泡到 guard，
  // 不能被吞成 return {ok:false,...} 而被 guard 包成 {ok:true,data:{ok:false,...}}。
  const mainRun = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
  ok(/out\.ok === false\) throw new Error\(out\.error/.test(web), 'Web run handler 把 AI 失败 throw 到 guard')
  ok(/out\.ok === false\) throw new Error\(out\.error/.test(mainRun), '桌面 run handler 把 AI 失败 throw 到 guard')
})()

console.log('--- ⑨ 呈现范式契约：内联 chip / 按钮分流 / R1 日志化 / apply 白名单 / 聚类周期（源码正则） ---')
;(() => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
  const web = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'store.js'), 'utf8')

  // 内联 chip：音源行 / 隔离区共用 entryId -> 建议 的 Map（方案 B）
  ok(/aiHintByEntry/.test(app), 'app.js 有 entryId->建议 内联索引 aiHintByEntry')
  ok(/loadAiHints/.test(app), 'app.js loadSources 后拉起 loadAiHints')
  ok(/ai-hint-chip/.test(app), 'app.js 音源行渲染 ai-hint-chip 只读标注')
  ok(/qz-deep[\s\S]{0,120}AI/.test(app), 'app.js 隔离区输出 AI 意图审查行')
  ok(/aiHintByEntry/.test(app) && /rowHtml/.test(app), '内联 Map 接入 rowHtml（全表+增量刷新）')

  // v1.10.9：确认执行从「kind 白名单」细化为「kind+verdict 白名单」——
  // R7 keep / R5 source / R4 ignore 这类"不动它"的结论不该给执行按钮
  ok(/AI_ACTIONABLE_VERDICT/.test(app) && /function aiActionable/.test(app), 'app.js 有 kind+verdict 动作白名单 aiActionable')
  ok(/R7:\s*\['blacklist'\]/.test(app) && /R5:\s*\['nonSource'\]/.test(app) && /R4:\s*\['follow'\]/.test(app),
    '动作白名单：R7 只 blacklist / R5 只 nonSource / R4 只 follow')
  ok(/data-ai-apply="/.test(app), 'chip 浮层对真有动作的建议提供「就按这个处理」按钮')

  // R1 降级为日志：前端 logOnly、后端统一走 core 的 run() 执行器
  ok(/logOnly:\s*true/.test(app), 'app.js R1 立即分析带 logOnly:true')
  const runStart = web.indexOf("route('POST', '/api/ai-review/run'")
  const runSrc = runStart === -1 ? '' : web.slice(runStart, web.indexOf('route(', runStart + 10) === -1 ? web.length : web.indexOf('route(', runStart + 10))
  ok(runStart !== -1, "web.js 存在 POST /api/ai-review/run 路由")
  ok(/\.run\(/.test(runSrc), 'web.js AI run 路由调用统一执行器 a.run()')
  ok(/out\.logged/.test(runSrc) && /pushLog/.test(runSrc), 'web.js AI run 路由按 out.logged 落日志')
  const aiSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'aiReview.js'), 'utf8')
  ok(/promptVersion:\s*\(REVIEW_PROMPTS\[kind\]\s*&&\s*REVIEW_PROMPTS\[kind\]\.version\)\s*\|\|\s*'v1'/.test(aiSrc), 'aiReview.makeDetail 统一生成 promptVersion（动态取 REVIEW_PROMPTS[kind].version，默认 v1）')
  ok(/AUTO_READONLY_KINDS\s*=\s*\['R1'\s*,\s*'R2'\s*,\s*'R3'\]/.test(aiSrc), 'core 默认只读档白名单 R1/R2/R3')
  ok(/autoMarked/.test(aiSrc) && /appliedBy\s*=\s*'ai'/.test(aiSrc), 'core auto 档对 R4-R7 只铺轨标记（不硬拦、不执行业务）')
  ok(/writeClusterReport/.test(aiSrc), 'core R1 AI 研究报告方法存在')

  // apply 白名单 + kind 校验（双端），堵住只读建议被误标 applied
  for (const [label, src] of [['web.js', web], ['main/index.js', mainSrc]]) {
    ok(/APPLYABLE[\s\S]{0,60}R4[\s\S]{0,20}R5[\s\S]{0,20}R6[\s\S]{0,20}R7/.test(src), label + ' apply 有 R4-R7 白名单')
    ok(/只读结论无需执行/.test(src), label + ' apply 拒绝只读结论')
    ok(/kind 不匹配/.test(src), label + ' apply 校验 kind 一致')
    ok(/a\.gate\(s\.kind\)/.test(src), label + ' apply gate 用建议自身 kind')
  }

  // R1 每周聚类：默认 168 小时、水位、登录。两端定时器 + store 配置字段
  ok(/clusterIntervalHours:\s*168/.test(storeSrc), 'store 默认 clusterIntervalHours=168（一周）')
  ok(/clusterIntervalHours\s*==\s*null/.test(storeSrc), 'store 深合并兜底 clusterIntervalHours')
  for (const [label, src] of [['web.js', web], ['main/index.js', mainSrc]]) {
    ok(/clusterIntervalHours/.test(src) && /aiLastClusterAt/.test(src), label + ' 有 R1 聚类水位定时器')
  }

  // 桌面端日志落盘：与 Web 共用 core/logFile
  ok(/\.\.\/core\/logFile/.test(mainSrc), 'main/index.js 引入 core/logFile 落盘')
  ok(/createAppLogWriter/.test(fs.readFileSync(path.join(ROOT, 'src', 'core', 'logFile.js'), 'utf8')), 'core/logFile.js 提供 createAppLogWriter')

  // AI 页已缩编：建议列表/详情卡移除，配置与聚类入口保留
  ok(/id="aiBaseUrl"/.test(html) && /id="aiMode"/.test(html), 'AI 页保留中转站/档位配置')
  ok(/马上归类一次/.test(html), 'AI 页聚类按钮改为「马上归类一次」（大白话）')
  ok(/id="aiDetail"/.test(html) === false, 'AI 页已移除 #aiDetail 详情卡')
  // v1.13.9：随容器移除一并清掉死代码，防止后来人"补回来"一个永远显示不了的渲染函数
  const appSrc9 = app
  const cssSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8')
  ok(!/function renderDetail\b/.test(appSrc9), '死代码 renderDetail 已移除（容器早已不存在）')
  ok(!/function renderOffHint\b/.test(appSrc9), '死代码 renderOffHint 已移除')
  ok(!/function offHintHtml\b/.test(appSrc9), '死代码 offHintHtml 已移除')
  ok(!/btnAiRefresh/.test(appSrc9), '#btnAiRefresh 死绑定已移除')
  ok(!/^\s*\.ai-suggestion[\s{,]/m.test(cssSrc) && !/^\s*\.ai-detail[\s{,]/m.test(cssSrc), '无对应容器的 .ai-suggestion* / .ai-detail* CSS 已清理')
  ok(!/_coldStartClassifySources/.test(fs.readFileSync(path.join(ROOT, 'src', 'core', 'hunter.js'), 'utf8')), 'hunter 死代码 _coldStartClassifySources 已移除')
  // v1.10.8：新增 #aiSummaryCard 替代不存在的 #aiSuggestions（用户拍板：不做建议列表页）
  ok(/id="aiSummaryCard"/.test(html), 'AI 页有统计卡 #aiSummaryCard 替代建议列表')
  ok(/id="aiSuggestions"/.test(html) === false, 'AI 页仍无 #aiSuggestions 列表容器')
})()

// --- ⑩ R1 样本驱动自生长：攒样本 → AI 归纳 → 自动生效 → 可停用 ---
async function learnTests() {
  console.log('--- ⑩ R1 样本驱动自生长（本地规则 + 仅其他失败调 AI） ---')
  try {
    // 1) 未命中样本进池，seed 仍命中
    // 注意：Store 构造是浅合并，config.aiReview 可能共享 DEFAULT 引用；测试里显式复制独立副本，避免互相污染。
    const s = tmpStore()
    s.config.aiReview = Object.assign({}, s.config.aiReview)
    const a = new AIReview(s)
    a.cfg.enabled = true
    a.cfg.clusterLearnEnabled = true
    a.cfg.clusterLearnMinSamples = 2
    a.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
    const o = a.clusterFailures([
      { id: '1', error: 'gateway returns MOOV_ATTACHED_404 for track' },
      { id: '2', error: 'MOOV_ATTACHED_404 on another item' }
    ])
    ok(o.clusters.some(c => c.reason === '其他失败'), '未命中样本归其他失败')
    ok(Object.keys(s.db.aiClusterSamples).length >= 1, '未命中样本写入样本池')

    // 2) 样本不足时不调 AI
    const low = tmpStore(); low.config.aiReview = Object.assign({}, low.config.aiReview)
    const la = new AIReview(low)
    la.cfg.enabled = true; la.cfg.clusterLearnMinSamples = 99
    ok((await la.learnClusterRules()).learned === 0, '样本不足不归纳')

    // 3) 启用关时不调 AI
    const off = tmpStore(); off.config.aiReview = Object.assign({}, off.config.aiReview)
    const oa = new AIReview(off)
    oa.cfg.enabled = false
    ok((await oa.learnClusterRules()).learned === 0, '总开关关闭不归纳')

    // 4) 攒够样本 → AI 返回 JSON → 写规则并下次命中
    let called = 0
    a.fetchImpl = async () => {
      called++
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify([
        { reason: 'MOOV前置', regex: 'MOOV_ATTACHED', samples: 2 }
      ]) } }] }) }
    }
    const r = await a.learnClusterRules()
    ok(called === 1, '样本达标后调 AI 一次')
    ok(r.learned === 1 && /MOOV/.test(r.rules[0].reason), 'AI 归纳出新类别')
    const rules = s.db.aiClusterRules
    ok(Object.values(rules).some(x => x.source === 'learned' && x.regex === 'MOOV_ATTACHED'), '新类别写入规则表 source=learned')
    const o2 = a.clusterFailures([{ id: '3', error: 'MOOV_ATTACHED again' }])
    ok(o2.clusters.some(c => c.reason === 'MOOV前置' && c.count === 1), '下周聚类自动命中新类别')
    ok(o2.clusters.some(c => c.reason === '其他失败') === false, '新规则覆盖后不再落其他失败')

    // 5) AI 返回非 JSON / 非法正则 → 不落规则、不抛
    const bad = tmpStore(); bad.config.aiReview = Object.assign({}, bad.config.aiReview)
    const ba = new AIReview(bad)
    ba.cfg.enabled = true; ba.cfg.clusterLearnMinSamples = 1
    ba.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
    ba.clusterFailures([{ id: 'x', error: 'weird unmatched err' }])
    ba.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }) })
    ok((await ba.learnClusterRules()).learned === 0, 'AI 返回非 JSON 不落规则')

    // 6) 规则上限
    const max = tmpStore(); max.config.aiReview = Object.assign({}, max.config.aiReview)
    const ma = new AIReview(max)
    ma.cfg.enabled = true; ma.cfg.clusterLearnMaxRules = 1
    max.db.aiClusterRules = { x: { reason: '已有', regex: 'x', source: 'learned', enabled: true } }
    ok((await ma.learnClusterRules()).learned === 0, '规则数达上限停止归纳')

    // 7) 停用规则：seed 不可改
    const ruleId = Object.keys(rules).find(k => rules[k].source === 'learned')
    ok(a.disableClusterRule(ruleId, false).ok === true && rules[ruleId].enabled === false, 'AI 规则可停用')
    ok(a.disableClusterRule('seed-x', false).ok === false, 'seed 规则不可停用')

    // 8) 配置归一化保留新字段
    const norm = a.normalizeConfig(a.cfg, { clusterLearnMinSamples: 7 })
    ok(norm.clusterLearnMinSamples === 7 && norm.clusterLearnEnabled === true, 'normalizeConfig 保留自生长字段')

    // 9) 新配置字段与 db 容器在 Store 默认可用
    const fresh = tmpStore()
    ok(fresh.config.aiReview.clusterLearnEnabled === true && fresh.db.aiClusterRules && fresh.db.aiClusterSamples, 'Store 默认含自生长配置与 db 容器')

    // 10) 源码契约：定时器解耦、日志带新增类别、seed 规则常量（UI 不展示，仅进日志）
    const web = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
    for (const [label, src] of [['web.js', web], ['main/index.js', mainSrc]]) {
      ok(/本周新增类别/.test(src), label + ' R1 日志带新增类别文案')
      ok(/ai\(\)\.run\('R1'/.test(src), label + ' 定时器走统一 run(R1)')
      ok(/if \(cfg\.enabled\)[\s\S]{0,200}aiLastClusterAt/.test(src), label + ' R1 聚类只受 enabled 管（与自动挡解耦）')
    }
    ok(/SEED_CLUSTER_RULES/.test(fs.readFileSync(path.join(ROOT, 'src', 'core', 'aiReview.js'), 'utf8')), 'core 内置 seed 规则常量')

    // 10.5) R1 auto 不花钱润色、留自生长；manual 才写报告（2026-11-18 效果优化）
    {
      const mk = () => {
        const st = tmpStore(); st.config.aiReview = Object.assign({}, st.config.aiReview)
        const ai = new AIReview(st)
        ai.cfg.enabled = true
        ai.cfg.clusterLearnEnabled = true
        ai.cfg.clusterLearnMinSamples = 99   // 样本门槛调高，确保 auto 时自生长不调 LLM
        ai.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
        ai.fetchImpl = async () => {
          ai.__calls = (ai.__calls || 0) + 1
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '本周报告：趋势平稳' } }] }) }
        }
        return ai
      }
      const entries = [{ id: '1', error: 'gateway timeout on request' }, { id: '2', error: 'gateway timeout again' }]
      const aiAuto = mk()
      const rAuto = await aiAuto.run('R1', { entries, trigger: 'auto', logOnly: true })
      ok(!aiAuto.__calls, 'auto 触发不调 LLM（报告跳过、自生长样本不足）')
      ok(!rAuto.result.report && !!rAuto.result.summary, 'auto 时 report 缺省、summary 仍在（日志用 summary）')
      const aiManual = mk()
      const rManual = await aiManual.run('R1', { entries, trigger: 'manual' })
      ok(aiManual.__calls === 1, 'manual 触发调 LLM 写报告一次')
      ok(/本周报告/.test(rManual.result.report || ''), 'manual 报告来自 LLM')
      // 自生长进化引擎在 auto 下仍保留：样本达标时仍会归纳
      const aiGrow = mk()
      aiGrow.cfg.clusterLearnMinSamples = 1
      aiGrow.clusterFailures([{ id: 'z', error: 'weird new failure unmatched' }])
      aiGrow.fetchImpl = async () => {
        aiGrow.__calls = (aiGrow.__calls || 0) + 1
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify([{ reason: '新类别', regex: 'weird new', samples: 1 }]) } }] }) }
      }
      const rGrow = await aiGrow.run('R1', { entries, trigger: 'auto', logOnly: true })
      ok(aiGrow.__calls === 1 && rGrow.result.learnedCount >= 1, 'auto 下自生长仍调 LLM 归纳（进化引擎保留）')
      ok(!rGrow.result.report, 'auto 即使自生长发生了也不写润色报告')
    }

    // 10.6) 自动档逐条 LLM 复检独立开关：默认关，评测达标再开（2026-11-18 省额度）
    {
      const st = tmpStore()
      ok(st.config.aiReview.autoLlmReviewEnabled === false, 'Store 默认 autoLlmReviewEnabled=false（逐条LLM复检默认关）')
      const a = new AIReview(st)
      ok(a.cfg.autoLlmReviewEnabled === false, 'AIReview cfg 默认关')
      ok(a.normalizeConfig(a.cfg, {}).autoLlmReviewEnabled === false, 'normalizeConfig 缺省保留 false')
      ok(a.normalizeConfig(a.cfg, { autoLlmReviewEnabled: true }).autoLlmReviewEnabled === true, 'normalizeConfig 可显式打开')
      const web = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
      const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
      for (const [label, src] of [['web.js', web], ['main/index.js', mainSrc]]) {
        ok(/if \(!cfg\.autoLlmReviewEnabled\) return/.test(src), label + ' 自动逐条复检受独立开关门禁')
      }
      const ui = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
      ok(/id="aiAutoLlmReview"/.test(ui), 'UI 有逐条AI复检开关')
      const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
      ok(/autoLlmReviewEnabled: !!\(\$\('aiAutoLlmReview'\)/.test(app), 'app.js 保存逐条AI复检开关')
    }

    // ---- 四块补齐：R3 真调 AI / R1 报告 / R4-R7 自动铺轨 / 隔离区放行前意见 ----
    // 1) R3 真调 AI：模型返回 JSON 时结论来自模型
    const s3 = tmpStore(); s3.config.aiReview = Object.assign({}, s3.config.aiReview)
    const a3 = new AIReview(s3)
    a3.cfg.enabled = true
    a3.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
    a3.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ suspicious: true, reason: '模型判定：疑似测试副本' }) } }] }) })
    const r3 = await a3.run('R3', { entryId: 'n1', name: '音源 (1)', text: '', trigger: 'manual' })
    ok(r3.result.byAi === true && /模型判定/.test(r3.result.conclusion), 'R3 真调 AI：结论来自模型')
    // entries 数组逐条落库，每条建议带自己的 entryId（chip 内联前提）
    const r3multi = await a3.run('R3', { entries: [{ id: 'id-A', name: 'A (1)', text: '' }, { id: 'id-B', name: 'B', text: '' }], trigger: 'manual' })
    ok(r3multi.suggestions && r3multi.suggestions.length === 2 &&
       r3multi.suggestions[0].entryId === 'id-A' && r3multi.suggestions[1].entryId === 'id-B',
       'R3 entries 逐条建议且 entryId 正确')
    // 2) R3 模型失败降级回本地结论，不抛
    const a3b = new AIReview(tmpStore()); a3b.cfg.enabled = true
    a3b.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
    a3b.fetchImpl = async () => ({ ok: false, status: 500 })
    const r3b = await a3b.run('R3', { entryId: 'n2', name: '音源 (1)', text: '', trigger: 'manual' })
    ok(r3b.result.byAi === false && !!r3b.result.conclusion, 'R3 降级：模型失败不抛、结论非空')

    // 3) R1 AI 研究报告：模型文本进 result.report
    const s1 = tmpStore(); s1.config.aiReview = Object.assign({}, s1.config.aiReview)
    const a1 = new AIReview(s1)
    a1.cfg.enabled = true
    a1.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
    a1.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '本周证书错误集中爆发，建议核对上游证书链。' } }] }) })
    const r1 = await a1.run('R1', { entries: [{ id: 'e1', error: 'SSL certificate expired' }], logOnly: true, trigger: 'manual' })
    ok(/证书错误集中/.test(r1.result.report || ''), 'R1 报告：模型文本进 result.report')
    // R1 报告失败降级为本地摘要
    a1.fetchImpl = async () => ({ ok: false, status: 500 })
    const r1b = await a1.run('R1', { entries: [{ id: 'e1', error: 'SSL certificate expired' }], logOnly: true, trigger: 'manual' })
    ok(/本地摘要/.test(r1b.result.report || ''), 'R1 报告：失败降级为本地摘要')

    // 4) R4-R7 自动铺轨：auto 档 gate 放行时标记 appliedBy=ai，不碰业务
    const s4 = tmpStore(); s4.config.aiReview = Object.assign({}, s4.config.aiReview)
    const a4 = new AIReview(s4)
    a4.cfg.enabled = true; a4.cfg.mode = 'auto'
    a4.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
    a4.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '建议追更' } }] }) })
    const r4 = await a4.run('R4', { entryId: 'u1', text: '有更新地址', trigger: 'auto' })
    ok(r4.autoMarked === true && r4.suggestion.status === 'applied' && r4.suggestion.appliedBy === 'ai', 'R4 auto 档自动铺轨标记 appliedBy=ai')
    // off 档不标记
    const s4b = tmpStore(); s4b.config.aiReview = Object.assign({}, s4b.config.aiReview)
    const a4b = new AIReview(s4b)
    a4b.cfg.enabled = true; a4b.cfg.mode = 'off'
    a4b.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
    a4b.fetchImpl = a4.fetchImpl
    const r4b = await a4b.run('R4', { entryId: 'u2', text: '有更新地址', trigger: 'auto' })
    ok(!r4b.autoMarked && r4b.suggestion.status === 'pending', 'off 档 R4 不铺轨标记')

    // 6) R4-R7 评测台子：REVIEW_PROMPTS / 结构化输出 / R7 从零建 / entries 逐条 / 不碰业务
    ok(REVIEW_PROMPTS && ['R4', 'R5', 'R6', 'R7'].every(k => REVIEW_PROMPTS[k] && REVIEW_PROMPTS[k].system && Array.isArray(REVIEW_PROMPTS[k].verdicts) && typeof REVIEW_PROMPTS[k].buildText === 'function'),
      'REVIEW_PROMPTS 导出且 R4-R7 齐全（system/verdicts/buildText）')
    ok(REVIEW_PROMPTS.R7.verdicts.join(',') === 'blacklist,keep', 'R7 verdict 枚举 blacklist/keep（从零建入口）')
    ;(() => {
      const txt = REVIEW_PROMPTS.R7.buildText({ name: 'n', installed: false, ledger: { hash: 'h', foreign: false }, streak: 3 })
      ok(/只禁不删/.test(txt) && /账本 hash/.test(txt), 'R7 buildText 含「只禁不删/账本」客观证据字段')
      ok(/API_KEY|apiKey/.test(txt) === false, 'R7 buildText 不含密钥字样')
    })()
    {
      const s7 = tmpStore(); s7.config.aiReview = Object.assign({}, s7.config.aiReview)
      const a7 = new AIReview(s7)
      a7.cfg.enabled = true; a7.cfg.mode = 'off'
      a7.cfg.provider = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', headers: {}, timeoutMs: 1000 }
      a7.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"verdict":"blacklist","reason":"长期全平台失效，建议拉黑"}' } }] }) })
      const beforeSources = JSON.stringify(s7.db.sources || {})
      const r7 = await a7.run('R7', { entries: [{ id: 'r7-a', name: '源A' }, { id: 'r7-b', name: '源B' }], trigger: 'manual' })
      ok(r7.recorded === 2 && r7.suggestions.length === 2, 'R7 entries 数组逐条产 2 条建议')
      ok(r7.suggestions[0].entryId === 'r7-a' && r7.suggestions[1].entryId === 'r7-b', 'R7 每条建议用自身 entryId 落库')
      ok(r7.suggestion.eval && r7.suggestion.eval.verdict === 'blacklist' && /拉黑/.test(r7.suggestion.conclusion), 'R7 结构化输出：eval.verdict + 人话 conclusion')
      ok(s7.db.aiSuggestions[r7.suggestions[0].id] && !r7.autoMarked, 'R7 建议落库；manual/off 档不自动标记')
      ok(JSON.stringify(s7.db.sources || {}) === beforeSources, 'R7 产建议后 sources 逐字未变')
      ok(Object.keys(s7.db.aiAudit || {}).length === 0, 'R7 产建议不调 audit()')
      // 非 JSON 降级：不抛、eval=null、conclusion 放原文
      a7.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '模型没按格式回' } }] }) })
      const r7b = await a7.run('R7', { entryId: 'r7-c', trigger: 'manual' })
      ok(r7b && r7b.suggestion && r7b.suggestion.eval == null && /模型没按格式回/.test(r7b.suggestion.conclusion), 'R7 非 JSON 输出不抛、eval=null、conclusion 放原文')
    }

    // 7) 前端标记：单条 AI 复检按钮 + 隔离区放行前 confirm + 批量按钮扩展 R4-R7
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
    ok(/data-act="aiReview"/.test(appSrc), 'app.js 单条操作列有 ✦AI 复检按钮')
    ok(/act === 'aiReview'/.test(appSrc), 'app.js 单条 AI 复检点击分支存在')
    ok(/act === 'aiReview'[\s\S]{0,200}srcIndex\.get\(id\)/.test(appSrc), 'app.js 单条 AI 复检从 srcIndex 取音源（非 rowMap 的 <tr>）')
    ok(/kind: 'R6'/.test(appSrc) && /window\.confirm\(/.test(appSrc), 'app.js 隔离区放行前调 R6 并 confirm')
    ok(/const kinds = \['R3', 'R4', 'R5', 'R7'\]/.test(appSrc), '批量按钮扩展 R3/R4/R5/R7（R6 留隔离区）')
    ok(/toast\('已完成 '/.test(appSrc) && /made \+=/.test(appSrc), '批量按钮按真实建议数 toast')

    // ============================================================
    console.log('\n=== P0-1：suspected 语义（正向音源特征打分，非「疑似非音源」）===')
    // 背景：checker.classifyEntry = scoreEntry(...) >= 4，scoreEntry 是正向打分
    // （名字像音源 +2、globalThis.lx +3、lx.request +2…），分越高越像音源。
    // 所以 suspected===true 表示「通过音源特征筛选 / 疑似是音源」。
    // 原先 R5 渲染成「疑似非音源」、R7 渲染成「命中本地启发式：是」，两处都把
    // 真音源的证据说成了该杀的理由，导致真源被误判 nonSource。
    const r5Src = REVIEW_PROMPTS.R5.buildText({ name: 'x', suspected: true })
    const r5False = REVIEW_PROMPTS.R5.buildText({ name: 'x', suspected: false })
    ok(/本地启发式：.*疑似音源/.test(r5Src) && !/疑似非音源/.test(r5Src),
      'R5：suspected=true 渲染为「疑似音源」，且不含「疑似非音源」')
    ok(/本地启发式：.*疑似非音源/.test(r5False),
      'R5：suspected=false 渲染为「疑似非音源」')
    ok(r5Src.indexOf('疑似非音源') === -1 && r5False.indexOf('疑似音源') === -1,
      'R5：两个分支互斥，不会同时出现')

    // R5 的 heuristic 在真实样本里 87/87 全是 undefined，短路必然落到 suspected 分支
    const r5WithHeur = REVIEW_PROMPTS.R5.buildText({ name: 'x', suspected: true, heuristic: '自定义启发式文案' })
    ok(/本地启发式：自定义启发式文案/.test(r5WithHeur),
      'R5：显式给 heuristic 时优先用它（保持向后兼容）')

    const r7Src = REVIEW_PROMPTS.R7.buildText({ name: 'x', status: 'ok', suspected: true })
    ok(/本地音源特征筛选：.*通过/.test(r7Src),
      'R7：suspected=true 渲染为「通过（命中音源特征，倾向保留）」')
    ok(r7Src.indexOf('命中本地启发式') === -1,
      'R7：不再出现「命中本地启发式」（删源语境下会被误读为命中可疑特征）')
    ok(!/命中可疑|可疑特征|建议删除|该删/.test(r7Src),
      'R7：文案不含任何「命中可疑/该删」字眼，不会被模型误认为删源依据')
    const r7False = REVIEW_PROMPTS.R7.buildText({ name: 'x', status: 'ok', suspected: false })
    ok(/本地音源特征筛选：.*未通过/.test(r7False), 'R7：suspected=false 渲染为「未通过」')

    // 语义方向锁定：suspected 必须来自正向打分，不能是取反
    const checkerSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'checker.js'), 'utf8')
    ok(/function classifyEntry\s*\([^)]*\)\s*\{\s*return scoreEntry\([^)]*\)\s*>=\s*4\s*\}/.test(checkerSrc),
      'checker.classifyEntry 仍是 scoreEntry(...) >= 4（正向，未被取反）')
    ok(!/suspected\s*=\s*!/.test(checkerSrc) && !/suspected:\s*!/.test(checkerSrc),
      'checker 里没有任何地方把 suspected 取反赋值')
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
  finish()
}

function finish() {
  console.log('\nai-review: PASS ' + pass + ' / FAIL 0')
}
