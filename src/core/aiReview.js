'use strict'
/**
 * AI 复检层核心（v1.14.0）——旁路语义分析 + 建议 + 经授权后的受限执行。
 *
 * 红线（任何档位都不碰）：
 *  - 不参与"能不能用"判定（归沙箱 deepCheck）
 *  - 不改同名裁决结果 act（归 hunter.sameNameVerdict 字典序）
 *  - 不改灌入/冻结（归 serverVeto + runImport）
 *
 * 本模块只产出建议（aiSuggestions）与审计（aiAudit），并把只读类结论直接返回展示。
 * 门控：mode(off/assist/auto) × 风险级(R1-R7) + 三把锁(enabled/mode=auto/allowIrreversible)。
 * 置信度 = 客观证据项 AND，缺项降级人工，不用模型自报分数。
 */

const provider = require('./aiProvider')

const RISK = {
  R1: { level: 'low', autoIn: ['assist', 'auto'] },    // 失败根因聚类（只读）
  R2: { level: 'low', autoIn: ['assist', 'auto'] },    // 裁决解释（只读）
  R3: { level: 'low', autoIn: ['assist', 'auto'] },    // 命名异常提示（只读）
  R4: { level: 'mid', autoIn: ['auto'] },              // 更新提示语义判断
  R5: { level: 'mid', autoIn: ['auto'] },              // 非音源判定入特征库
  R6: { level: 'high', autoIn: [], needsIrreversible: true }, // 混淆信任放行
  R7: { level: 'high', autoIn: [], needsIrreversible: true }  // 拉黑 / 删源
}

// 默认只读档白名单（代码常量，不接受配置）：off/assist 档自动触发只覆盖这三种只读 kind。
// R4-R7 的自动放行改由 gate()（mode=auto + 第三锁）决定，不再在此硬拦；但 auto 档的
// R4-R7 仅"铺轨"（产建议 + 标记），不接真实业务动作——评测跑完再放开执行。
const AUTO_READONLY_KINDS = ['R1', 'R2', 'R3']

// R4-R7 统一「prompt + 输入构造 + 结构化输出」契约（评测台子，2026-11-17）。
// 仅供产建议使用：buildText 只拼脱敏客观字段，绝不拼脚本文字/密钥；verdicts 是可复算枚举。
// system 要求模型只输出一个 JSON 对象 {"verdict":"<枚举>","reason":"<≤120字人话>"}。
// 注意：这里不接任何真实业务动作（追更/特征库/信任/拉黑/删源），也不改门控与只读白名单。
const REVIEW_PROMPTS = {
  R4: {
    version: 'v1',
    verdicts: ['follow', 'ignore'],
    system: [
      '你是音源更新提示审查助手。判断一条音源的「更新提示」是否值得跟进追更。',
      '仅输出一个 JSON 对象：{"verdict":"follow或ignore","reason":"不超过120字的人话理由"}，不要代码块标记。',
      'follow=更新地址可信、确有新版值得追；ignore=噪声/广告/无效地址/无实质更新。不确定的一律 ignore。'
    ].join('\n'),
    buildText: (p) => [
      '名称：' + (p.name || ''),
      '版本：' + (p.scriptVersion || p.version || ''),
      '状态：' + (p.status || ''),
      '错误：' + (p.error || ''),
      '更新地址：' + (p.updateUrl || ''),
      '更新提示：' + (Array.isArray(p.updateTips) ? p.updateTips.slice(-5).join('；') : (p.updateTips || ''))
    ].join('\n')
  },
  R5: {
    version: 'v1',
    verdicts: ['nonSource', 'source'],
    system: [
      '你是音源真伪审查助手。判断一条候选是否「非音源脚本」（应进特征库屏蔽）。',
      '仅输出一个 JSON 对象：{"verdict":"nonSource或source","reason":"不超过120字的人话理由"}，不要代码块标记。',
      'nonSource=明确是文档/配置/客户端源码/工具脚本而非音源；source=是或疑似音源。拿不准一律 source（宁可漏杀不可错杀）。'
    ].join('\n'),
    buildText: (p) => [
      '名称：' + (p.name || ''),
      '脚本名：' + (p.scriptName || ''),
      '状态：' + (p.status || ''),
      '错误：' + (p.error || ''),
      '来源仓库：' + (p.repository || ''),
      '本地启发式：' + (p.heuristic || (p.suspected === true ? '疑似非音源' : p.suspected === false ? '疑似音源' : '未知')),
      '判定层级：' + (p.validTier || ''),
      '混淆等级：' + (p.obfLevel || '')
    ].join('\n')
  },
  R6: {
    version: 'v1',
    verdicts: ['trust', 'reject'],
    system: [
      '你是混淆音源安全审查助手。判断一条重度混淆脚本是否可信、是否建议信任放行。',
      '仅输出一个 JSON 对象：{"verdict":"trust或reject","reason":"不超过120字的人话理由"}，不要代码块标记。',
      'trust=混淆有合理解释、外联域名可信、无恶意特征；reject=有硬恶意特征或域名可疑。拿不准一律 reject。理由用中文人话，便于用户阅读。'
    ].join('\n'),
    buildText: (p) => [
      '名称：' + (p.name || ''),
      '来源仓库：' + (p.repository || ''),
      '错误：' + (p.error || ''),
      '外联域名：' + (Array.isArray(p.obfDomains) ? p.obfDomains.join('、') : (p.obfDomains || '')),
      '混淆特征：' + (Array.isArray(p.obfHits) ? p.obfHits.join('、') : (p.obfHits || '')),
      '域名判定：' + (p.obfDomainVerdict || ''),
      '深度摘要：' + (p.deepSummary || '')
    ].join('\n')
  },
  R7: {
    version: 'v1',
    verdicts: ['blacklist', 'keep'],
    system: [
      '你是音源风险审查助手。判断一条音源是否应拉黑/删源（高危、不可逆）。',
      '仅输出一个 JSON 对象：{"verdict":"blacklist或keep","reason":"不超过120字的人话理由"}，不要代码块标记。',
      'blacklist=长期全平台失效、确认有害、账本指向外来恶意条目；keep=仍可用/偶发失败/证据不足。',
      '最高危原则：本地尚未灌入、仅服务端存在的条目「只禁不删」；证据不足一律 keep。'
    ].join('\n'),
    buildText: (p) => {
      const led = (p.ledger && typeof p.ledger === 'object') ? p.ledger : {}
      return [
        '名称：' + (p.name || ''),
        '来源仓库：' + (p.repository || ''),
        '状态：' + (p.status || ''),
        '错误：' + (p.error || ''),
        '本地已灌入：' + (p.installed === true ? '是' : p.installed === false ? '否（只禁不删）' : '未知'),
        '账本 hash：' + (led.hash || ''),
        '账本外来条目：' + (led.foreign === true ? '是' : led.foreign === false ? '否' : '未知'),
        '连续失效次数：' + (p.streak != null ? p.streak : ''),
        '判定层级：' + (p.validTier || '')
      ].join('\n')
    }
  }
}

// R1 seed 规则（内置、不可删）：本地零成本先跑；未命中的样本才进入 AI 归纳流程。
const SEED_CLUSTER_RULES = [
  { reason: '证书 / TLS 错误', regex: 'certificate|ssl|tls|证书|self\\.signed' },
  { reason: '限流 / 请求过频', regex: '限流|rate.?limit|429|too many requests' },
  { reason: 'DNS / 域名失效', regex: 'enotfound|getaddrinfo|dns|域名|econnrefused' },
  { reason: '连接超时', regex: 'timeout|etimedout|超时|连接失败' },
  { reason: '脚本执行错误', regex: 'is not defined|not a function|syntaxerror|typeerror|脚本错误' },
  { reason: '音频校验失败', regex: '音频|试听|无有效|未找到.*url' }
]

const AI_REVIEW_DEFAULTS = {
  enabled: false,
  mode: 'off',
  allowIrreversible: false,
  evidencePolicy: 'all-signals',
  clusterIntervalHours: 168,
  clusterLearnEnabled: true,
  clusterLearnMinSamples: 5,
  clusterLearnMaxRules: 40,
  autoEnabled: false,
  autoIntervalHours: 24,
  autoScope: 'failed',
  autoMaxItems: 20,
  autoActiveHours: { start: 0, end: 24 },
  shadowEval: false,
  provider: { baseUrl: '', apiKey: '', model: '', headers: {}, timeoutMs: 20000 },
  budget: { perItemMs: 20000, perRoundMs: 180000, maxItemsPerRound: 20 }
}

function now() { return Date.now() }
function uid(prefix) { return prefix + '_' + now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) }
function deepClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)) }

class AIReview {
  constructor(store) {
    this.store = store
    if (!store.db.aiSuggestions) store.db.aiSuggestions = {}
    if (!store.db.aiAudit) store.db.aiAudit = {}
  }

  get cfg() { return (this.store.config && this.store.config.aiReview) || {} }

  /** 供 UI 读的脱敏配置副本（不含 apiKey 明文，由 web 层再兜一层） */
  publicConfig() {
    const c = deepClone(this.cfg)
    if (c.provider && c.provider.apiKey) c.provider.apiKey = '******'
    return c
  }

  /**
   * 配置归一化（纯函数，不改 this 也不改入参）。
   * 供 web.js / main/index.js 的 configSet 调用，消除两处手抄白名单逻辑。
   * 规则：patch 有合法值则用 patch，否则保留 cur，再否则用默认；
   *       非法枚举/数值保留 cur（autoScope 非法固定回 'failed'）。
   * @param {object} cur  当前 aiReview 配置
   * @param {object} patch 前端提交的配置（部分字段）
   * @returns {object} 合并后的完整 aiReview 配置（新对象）
   */
  normalizeConfig(cur, patch) {
    const c = cur && typeof cur === 'object' ? cur : {}
    const p = patch && typeof patch === 'object' ? patch : {}
    const d = AI_REVIEW_DEFAULTS
    const bool = (key) => {
      if (typeof p[key] === 'boolean') return p[key]
      if (typeof c[key] === 'boolean') return c[key]
      return d[key]
    }
    const posInt = (key) => {
      const n = Number(p[key])
      if (Number.isFinite(n) && n >= 1) return Math.floor(n)
      const cn = Number(c[key])
      if (Number.isFinite(cn) && cn >= 1) return Math.floor(cn)
      return d[key]
    }
    const next = {
      enabled: bool('enabled'),
      autoEnabled: bool('autoEnabled'),
      shadowEval: bool('shadowEval'),
      allowIrreversible: bool('allowIrreversible'),
      mode: ['off', 'assist', 'auto'].indexOf(p.mode) !== -1 ? p.mode
        : (['off', 'assist', 'auto'].indexOf(c.mode) !== -1 ? c.mode : d.mode),
      evidencePolicy: p.evidencePolicy === 'all-signals' ? 'all-signals'
        : (c.evidencePolicy === 'all-signals' ? c.evidencePolicy : d.evidencePolicy),
      clusterIntervalHours: posInt('clusterIntervalHours'),
      clusterLearnEnabled: bool('clusterLearnEnabled'),
      clusterLearnMinSamples: posInt('clusterLearnMinSamples'),
      clusterLearnMaxRules: posInt('clusterLearnMaxRules'),
      autoIntervalHours: posInt('autoIntervalHours'),
      autoMaxItems: posInt('autoMaxItems'),
      autoScope: ['new', 'failed', 'quarantined', 'all'].indexOf(p.autoScope) !== -1 ? p.autoScope
        : (['new', 'failed', 'quarantined', 'all'].indexOf(c.autoScope) !== -1 ? c.autoScope : d.autoScope),
      autoActiveHours: (() => {
        const a = p.autoActiveHours && typeof p.autoActiveHours === 'object' ? p.autoActiveHours
          : (c.autoActiveHours && typeof c.autoActiveHours === 'object' ? c.autoActiveHours : d.autoActiveHours)
        const s = Number(a.start), e = Number(a.end)
        return (Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e <= 24 && s < e)
          ? { start: s, end: e }
          : Object.assign({}, d.autoActiveHours, c.autoActiveHours && typeof c.autoActiveHours === 'object' ? c.autoActiveHours : {})
      })()
    }
    // provider / budget：Object.assign 深合并（仿 store），只覆盖传入的键
    next.provider = Object.assign({}, d.provider, c.provider || {}, p.provider && typeof p.provider === 'object' ? p.provider : {})
    // apiKey：仅当 patch 显式给了非空、非脱敏占位字符串才覆盖
    const inKey = p.provider && p.provider.apiKey
    if (typeof inKey === 'string' && inKey && inKey !== '******') next.provider.apiKey = inKey
    // headers：仅当 patch.provider.headers 是对象时覆盖
    const inHeaders = p.provider && p.provider.headers
    if (inHeaders && typeof inHeaders === 'object') next.provider.headers = inHeaders
    next.budget = Object.assign({}, d.budget, c.budget || {}, p.budget && typeof p.budget === 'object' ? p.budget : {})
    return next
  }

  /**
   * 统一执行器：R1/R2/通用三分支的单一入口。
   * @param {string} kind R1..R7
   * @param {object} params {entries, entryId, verdict, ctx, systemPrompt, text, evidence, logOnly, trigger, detailAction}
   * @returns {Promise<object>} R1: {logged:true,result} 或 {suggestion,result}；
   *   R2: {suggestion,result}；通用: {suggestion}；失败: {ok:false,error} 或 {ok:false,reason}
   */
  async run(kind, params) {
    const b = params && typeof params === 'object' ? params : {}
    const trigger = ['manual', 'auto', 'event'].indexOf(b.trigger) !== -1 ? b.trigger : 'manual'
    try {
      if (kind === 'R1') {
        const entries = Array.isArray(b.entries) ? b.entries : []
        const out = this.clusterFailures(entries)
        // 样本驱动自生长：仅"其他失败"攒够样本时调 AI 归纳新类别（失败静默，不阻断聚类）。
        let learned = { learned: 0, rules: [] }
        try { learned = await this.learnClusterRules() } catch (e) {}
        out.newRules = Array.isArray(learned.rules) ? learned.rules.map(r => r.reason) : []
        out.learnedCount = learned.learned || 0
        // AI 研究报告：把聚类/归纳结果交给模型写成"趋势+根因+建议"，失败降级为本地摘要。
        out.report = await this.writeClusterReport(out)
        // 自动触发或 logOnly 只返回聚类结果（日志由调用方写，core 不依赖 pushLog）
        if (trigger === 'auto' || b.logOnly) return { logged: true, result: out }
        const detail = this.makeDetail('R1', '聚类 ' + entries.length + ' 条失败条目', b.detailAction || '生成失败根因聚类摘要（只读，不写状态）')
        const evidence = out.clusters.map(c => ({ key: c.reason, ok: true, count: c.count }))
        const s = this.suggest(b.entryId || '', 'R1', out.summary, evidence, { detail })
        return { suggestion: s, result: out }
      }
      if (kind === 'R2') {
        const out = this.explainVerdict(b.verdict || {}, b.ctx || {})
        const detail = this.makeDetail('R2', out.act, b.detailAction || '生成裁决解释 whyAi（不改裁决结果）')
        const s = this.suggest(b.entryId || '', 'R2', out.whyAi, [], { detail })
        return { suggestion: s, result: out }
      }
      if (kind === 'R3') {
        // R3 命名异常提示：支持 entries 数组逐条出建议（单条按钮/批量都走这里），
        // 每条用自身 id 落库，chip 才能内联到对应音源行；无 entries 时回退到单条 entryId/name/text。
        const rawList = Array.isArray(b.entries) && b.entries.length
          ? b.entries
          : [{ id: b.entryId || '', name: b.name, text: b.text }]
        const list = rawList.slice(0, 30)   // 与每轮上限一致，避免批量复检打爆中转站
        const suggestions = []
        let firstOut = null
        for (const item of list) {
          const one = await this._reviewOneName(item || {})
          suggestions.push(one.suggestion)
          if (!firstOut) firstOut = one.result
        }
        return { suggestion: suggestions[0], suggestions, result: firstOut || {} }
      }
      // 通用分支 R4-R7：走 provider，失败返回 {ok:false,error}，不抛。
      // 支持 entries 数组逐条产建议（对齐 R3），每条用自身 id 落库，供批量复检一次调用。
      const spec = REVIEW_PROMPTS[kind] || null
      const sys = b.systemPrompt || (spec && spec.system) || '你是音源审查助手，只输出 JSON 结论。'
      const rawList = Array.isArray(b.entries) && b.entries.length
        ? b.entries
        : [Object.assign({ id: b.entryId || '' }, b)]
      const list = rawList.slice(0, 30)
      const suggestions = []
      let firstResult = null
      let marked = 0
      for (const item of list) {
        const one = item && typeof item === 'object' ? item : {}
        const text = one.text || (spec && spec.buildText ? spec.buildText(one) : '')
        const r = await this.review(sys, text)
        if (!r.ok) { if (!suggestions.length) return { ok: false, error: r.error }; continue }
        const j = this._parseJsonObject(r.text)
        let conclusion = String(r.text || '')
        let evalField = null
        if (j && spec && spec.verdicts.indexOf(j.verdict) !== -1 && typeof j.reason === 'string' && j.reason.trim()) {
          conclusion = j.reason.trim().slice(0, 200)
          evalField = { verdict: j.verdict, reason: conclusion, promptVersion: (spec && spec.version) || 'v1' }
        }
        const detail = this.makeDetail(kind, text, b.detailAction || '生成语义审查建议（待人工确认）')
        const extra = { detail }
        if (evalField) extra.eval = evalField
        const s = this.suggest(one.id || b.entryId || '', kind, conclusion, b.evidence || [], extra)
        // 自动铺轨：auto 档且 gate 放行时自动标记建议为已应用；仅标记，不执行任何业务动作。
        // R6/R7 高危即便 gate 放行也只在双锁下由 gate 判定，且此处依然不碰真实业务。
        if (trigger === 'auto' && this.gate(kind).auto) {
          s.status = 'applied'; s.appliedAt = now(); s.appliedBy = 'ai'
          try { this.store.saveDb() } catch (e) {}
          marked++
        }
        suggestions.push(s)
        if (!firstResult) firstResult = { ok: true, text: r.text, eval: evalField }
      }
      if (!suggestions.length) return { ok: false, error: '无可产出的建议' }
      try { this.store.saveDb() } catch (e) {}
      return {
        suggestion: suggestions[0], suggestions, result: firstResult || {},
        autoMarked: marked > 0, recorded: suggestions.length
      }
    } catch (e) {
      // 旁路铁律：任何异常都吞掉，返回 {ok:false,error}，绝不抛给主链路
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  /**
   * 判断某风险级在当前配置下是否自动执行。
   * @returns {{auto:boolean, reason:string}}
   */
  gate(kind) {
    if (!this.cfg.enabled) return { auto: false, reason: '总开关关闭' }
    const r = RISK[kind] || { level: 'mid', autoIn: ['auto'] }
    const mode = this.cfg.mode || 'off'
    if (mode === 'off') return { auto: false, reason: '档位 off' }
    if (r.needsIrreversible) {
      if (mode !== 'auto') return { auto: false, reason: '高风险操作仅在 auto 档' }
      if (!this.cfg.allowIrreversible) return { auto: false, reason: '高风险操作需显式开启 allowIrreversible' }
      // 双锁（auto 档 + 第三锁）满足即放行，不再走 autoIn 检查——高风险项的 autoIn 恒为空。
      return { auto: true, reason: '' }
    }
    if (r.autoIn.indexOf(mode) === -1) return { auto: false, reason: '当前档位不自动执行该风险级' }
    return { auto: true, reason: '' }
  }

  /**
   * 客观证据门槛：全部 ok 才允许自动；缺项返回缺项 key 列表。
   * signals: [{key, source, ok, detail}] —— source 标记来源，便于复盘。
   */
  evaluateGate(signals) {
    const arr = Array.isArray(signals) ? signals : []
    const missing = arr.filter(s => !s || s.ok !== true).map(s => (s && s.key) || '(unnamed)')
    return { pass: missing.length === 0, missing }
  }

  /** 校验 AI 引用是否可逐字定位于输入片段（防"我引用了"式幻觉） */
  quoteLocatable(evidence, inputText) {
    const q = evidence && evidence.quote
    if (!q || typeof q !== 'string') return false
    return String(inputText || '').indexOf(q) !== -1
  }

  /**
   * 保存一条建议。
   * extra 支持传入 detail（检测详情，见 makeDetail）：Object.assign 会原样保留，
   * 因此旧调用不传 detail 时行为不变，保持向后兼容。
   */
  suggest(entryId, kind, conclusion, evidence, extra) {
    const s = Object.assign({
      id: uid('sug'), entryId: entryId || '', kind,
      conclusion: conclusion || '', evidence: Array.isArray(evidence) ? evidence : [],
      mode: this.cfg.mode || 'off', createdAt: now(), status: 'pending',
      model: (this.cfg.provider && this.cfg.provider.model) || ''
    }, extra || {})
    this.store.db.aiSuggestions[s.id] = s
    return s
  }

  /**
   * 构造建议的「检测详情」detail，仅供前端详情页只读渲染，不参与任何自动执行判定。
   * 契约：{ inputDigest:string(截断200字), gate:{auto,reason}, promptVersion:'v1', action:string }
   * gate 直接取 gate(kind)：off 档恒为 {auto:false, reason:'档位 off'}，
   * 即"全部人工 = AI 只检测出建议、不自动执行"。
   */
  makeDetail(kind, inputDigest, action) {
    return {
      inputDigest: String(inputDigest == null ? '' : inputDigest).slice(0, 200),
      gate: this.gate(kind),
      promptVersion: (REVIEW_PROMPTS[kind] && REVIEW_PROMPTS[kind].version) || 'v1',
      action: String(action == null ? '' : action)
    }
  }

  /** 记一条审计（before 深拷贝，按单条原子） */
  audit(entryId, action, before, after, by) {
    const a = {
      id: uid('aud'), entryId: entryId || '', action,
      before: deepClone(before), after: deepClone(after),
      by: by || 'ai', auditAt: now(), undone: false
    }
    this.store.db.aiAudit[a.id] = a
    return a
  }

  /**
   * 一键回滚：恢复 before 快照。幂等—— undone=true 的条目直接返回。
   * before 缺失/损坏时抛错（不静默成功），且不影响主链路（调用方 try/catch）。
   */
  undo(auditId) {
    const a = this.store.db.aiAudit[auditId]
    if (!a) throw new Error('审计记录不存在：' + auditId)
    if (a.undone) return { ok: true, undone: true, id: auditId, note: '已回滚，无需重复' }
    if (!a.before || typeof a.before !== 'object' || !Object.prototype.hasOwnProperty.call(a.before, 'target')) {
      throw new Error('审计记录缺少有效 before 快照：' + auditId)
    }
    const b = a.before
    // before.target = {path:'config.aiReview...' | 'db.sources.<id>' , value: ...}
    // 这里只恢复通用字段容器，具体写回由调用方（hunter）按 path 落实；
    // 本层保证快照完整、幂等标记正确，避免越权直接改业务对象。
    a.undone = true
    a.undoneAt = now()
    return { ok: true, undone: true, id: auditId, before: deepClone(b) }
  }

  /** 建议列表（支持 source/status 过滤，供 UI 与 /api/logs?source=ai 复用口径） */
  listSuggestions(filter) {
    const f = filter || {}
    let arr = Object.values(this.store.db.aiSuggestions || {})
    if (f.status) arr = arr.filter(s => s.status === f.status)
    if (f.kind) arr = arr.filter(s => s.kind === f.kind)
    if (f.source === 'ai') arr = arr.filter(s => s.by !== 'user')
    return arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  listAudit() {
    return Object.values(this.store.db.aiAudit || {}).sort((a, b) => (b.auditAt || 0) - (a.auditAt || 0))
  }

  /**
   * 错误文本归一化：去掉数字/UUID/路径/引号内容，作为样本指纹，避免把变量值当新类别。
   * 返回一个较短、可读、脱敏的 key，同时用于样本池去重和喂给 AI 的输入。
   */
  _normalizeError(msg) {
    return String(msg == null ? '' : msg)
      .replace(/https?:\/\/\S+/gi, '<url>')
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<uuid>')
      .replace(/[A-Za-z]:[\\/][^\s'"]+/g, '<path>')
      .replace(/['"][^'"]{1,80}['"]/g, '<q>')
      .replace(/\b\d+\b/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
  }

  /** 当前生效规则：内置 seed + 学到的 enabled 规则，编译成 {reason, re, source} */
  _activeClusterRules() {
    const db = this.store.db
    const out = SEED_CLUSTER_RULES.map(r => {
      let re = null
      try { re = new RegExp(r.regex, 'i') } catch (e) {}
      return re ? { reason: r.reason, re, source: 'seed' } : null
    }).filter(Boolean)
    for (const r of Object.values(db.aiClusterRules || {})) {
      if (!r || r.enabled === false || !r.regex) continue
      let re = null
      try { re = new RegExp(r.regex, 'i') } catch (e) {}
      if (re) out.push({ reason: r.reason, re, source: 'learned' })
    }
    return out
  }

  /**
   * R1 失败根因聚类：把失败条目按 error 语义归类，产出人话摘要。
   * 输入 entries: [{id, error, status}]；返回 {clusters:[{reason,count,ids}], summary}。
   * 纯本地规则（seed + 已学类别，零成本）；未命中样本记入样本池供 learnClusterRules 归纳。
   */
  clusterFailures(entries) {
    const rules = this._activeClusterRules()
    const db = this.store.db
    const samples = db.aiClusterSamples || (db.aiClusterSamples = {})
    const buckets = new Map()
    for (const e of (Array.isArray(entries) ? entries : [])) {
      const msg = String((e && (e.error || e.message)) || '')
      let reason = '其他失败'
      for (const p of rules) { if (p.re.test(msg)) { reason = p.reason; break } }
      if (reason === '其他失败' && msg) {
        // 记样本池：归一化指纹去重、累计次数，供达标后归纳
        const fp = this._normalizeError(msg)
        if (fp) {
          const rec = samples[fp] || (samples[fp] = { error: fp, count: 0, firstAt: now(), lastAt: 0 })
          rec.count++
          rec.lastAt = now()
        }
      }
      if (!buckets.has(reason)) buckets.set(reason, [])
      buckets.get(reason).push((e && (e.id || e.scriptName || e.name)) || '')
    }
    const clusters = Array.from(buckets, ([reason, ids]) => ({ reason, count: ids.length, ids: ids.slice(0, 500) }))
      .sort((a, b) => b.count - a.count)
    const summary = clusters.length ? clusters.map(c => c.reason + ' ' + c.count).join(' / ') : '无失败条目'
    return { clusters, summary }
  }

  /**
   * 样本驱动自生长：对"其他失败"样本池，攒够 minSamples 才调 AI 归纳新类别。
   * 归纳结果经校验后写入 db.aiClusterRules（source:'learned'），下周聚类自动生效。
   * 全程静默：未启用/样本不足/AI 失败/解析失败一律返回 {learned:0}，不抛不阻断主链路。
   */
  async learnClusterRules() {
    const cfg = this.cfg
    if (!cfg.enabled || cfg.clusterLearnEnabled === false) return { learned: 0 }
    const db = this.store.db
    const rules = db.aiClusterRules || (db.aiClusterRules = {})
    const maxRules = Math.max(1, Number(cfg.clusterLearnMaxRules) || 40)
    const learnedCount = Object.values(rules).filter(r => r && r.source === 'learned').length
    if (learnedCount >= maxRules) return { learned: 0, reason: '规则数已达上限' }
    const minSamples = Math.max(1, Number(cfg.clusterLearnMinSamples) || 5)
    const pool = Object.values(db.aiClusterSamples || {})
    const total = pool.reduce((n, r) => n + (Number(r && r.count) || 0), 0)
    if (total < minSamples) return { learned: 0, reason: '样本不足' }

    const samples = pool.sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 30)
    const existing = this._activeClusterRules().map(r => r.reason)
    const system = [
      '你是日志聚类助手。把下面这些"其他失败"的错误样本归纳成人话类别。',
      '仅输出 JSON 数组，不要任何额外文字或代码块标记。每项格式 {"reason":"类别名","regex":"JS正则","samples":数字}。',
      'regex 必须是合法 JavaScript 正则字符串，能匹配该类样本共性；不要匹配已有类别：' + (existing.join('、') || '无') + '。',
      '归纳不出共性就返回空数组 []。类别名不超过 12 字、语气中性。'
    ].join('\n')
    const userText = samples.map((r, i) => (i + 1) + '. ' + r.error + '（×' + r.count + '）').join('\n').slice(0, 12000)
    let r
    try { r = await this.review(system, userText) } catch (e) { return { learned: 0 } }
    if (!r || !r.ok || !r.text) return { learned: 0 }

    let arr
    try {
      let t = String(r.text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
      const s = t.indexOf('['), e = t.lastIndexOf(']')
      if (s < 0 || e <= s) return { learned: 0 }
      arr = JSON.parse(t.slice(s, e + 1))
    } catch (e) { return { learned: 0 } }
    if (!Array.isArray(arr)) return { learned: 0 }

    const out = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const reason = String(item.reason || '').trim().slice(0, 24)
      const regex = String(item.regex || '')
      if (!reason || !regex || existing.indexOf(reason) !== -1) continue
      let re = null
      try { re = new RegExp(regex, 'i') } catch (e) { continue }
      // 正则必须至少命中一条样本，否则是幻觉规则
      if (!samples.some(s => re.test(s.error))) continue
      const id = 'lr_' + now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
      rules[id] = {
        reason, regex, source: 'learned', enabled: true,
        createdAt: now(), samples: Array.isArray(item.samples) ? item.samples.length : samples.length,
        model: (cfg.provider && cfg.provider.model) || ''
      }
      existing.push(reason)
      out.push({ id, reason, regex })
      if (learnedCount + out.length >= maxRules) break
    }
    if (out.length) {
      // 移除已被新规则覆盖的样本指纹，避免下周重复归纳同一批
      for (const rule of out) {
        let re = null
        try { re = new RegExp(rule.regex, 'i') } catch (e) {}
        if (!re) continue
        for (const fp of Object.keys(db.aiClusterSamples || {})) {
          if (re.test(fp)) delete db.aiClusterSamples[fp]
        }
      }
      try { this.store.saveDb() } catch (e) {}
    }
    return { learned: out.length, rules: out }
  }

  /** 供 UI 读的聚类规则表（seed + learned，只读副本） */
  clusterRules() {
    const db = this.store.db
    const seeds = SEED_CLUSTER_RULES.map(r => Object.assign({ source: 'seed', enabled: true, samples: 0 }, r))
    const learned = Object.entries(db.aiClusterRules || {}).map(([id, r]) => Object.assign({ id }, r))
    return { rules: seeds.concat(learned), samples: Object.values(db.aiClusterSamples || {}).length, maxRules: Math.max(1, Number(this.cfg.clusterLearnMaxRules) || 40) }
  }

  /** 停用/启用一条学到的类别规则（seed 不可改） */
  disableClusterRule(id, enabled) {
    const r = (this.store.db.aiClusterRules || {})[id]
    if (!r || r.source !== 'learned') return { ok: false, reason: '规则不存在或不可修改' }
    r.enabled = enabled === true
    try { this.store.saveDb() } catch (e) {}
    return { ok: true, id, enabled: r.enabled }
  }

  /**
   * R2 裁决解释旁路增强：基于 sameNameVerdict 的返回值生成人话理由。
   * 只产出 whyAi 字段，绝不改 act。纯本地模板 + 可选 AI 润色（失败静默）。
   */
  explainVerdict(verdict, ctx) {
    const actMap = { synced: '服务端已有同内容', skip: '保留服务端更优版本', replace: '本地更优，删旧装新', rename: '疑似无关脚本撞名，改名并存' }
    const act = (verdict && verdict.act) || 'unknown'
    const why = (verdict && verdict.why) || ''
    const c = ctx || {}
    const whyAi = `${actMap[act] || '未知裁决'}：${why}` +
      (c.localVer || c.srvVer ? `（本地 ${c.localVer || '?'} / 服务端 ${c.srvVer || '?'}）` : '')
    return { act, why, whyAi }
  }

  /**
   * 通用 AI 审查调用（供 R4/R5/R6/R7 的意图判断复用）。
   * 失败一律返回 {ok:false, error}，并把错误记进 lastError 供 UI 显示，不抛主链路。
   */
  async review(systemPrompt, userText) {
    if (!this.cfg.enabled) return { ok: false, error: 'AI 复检未启用' }
    const p = this.cfg.provider || {}
    if (!p.baseUrl || !p.model) return { ok: false, error: 'AI 中转站未配置 baseUrl/model' }
    try {
      const r = await provider.chat(p, [
        { role: 'system', content: String(systemPrompt || '') },
        { role: 'user', content: String(userText || '').slice(0, 12000) }
      ], this.fetchImpl ? { fetchImpl: this.fetchImpl } : undefined)
      if (!r.ok) { this.lastError = r.error; return r }
      return r
    } catch (e) {
      this.lastError = String((e && e.message) || e)
      return { ok: false, error: this.lastError }
    }
  }

  /**
   * R3 单条命名审查：本地正则作证据 + 真调模型出意见；模型失败降级回本地结论。
   * @returns {{suggestion:object, result:object}}
   */
  async _reviewOneName(entry) {
    const text = String(entry.text == null ? (entry.error == null ? '' : entry.error) : entry.text)
    const name = String(entry.name == null ? '' : entry.name)
    const hay = (name + ' ' + text).toLowerCase()
    const suspicious = /重复|同名|副本|copy|\(1\)|（1）|test|测试|tmp|临时/.test(hay)
    const localConclusion = suspicious
      ? '命名异常：名称含重复/测试/临时等痕迹，建议人工核对是否为同一音源的多版本'
      : '命名未见明显异常（本地规则提示，仅供参考）'
    let conclusion = localConclusion
    let byAi = false
    try {
      const sys = [
        '你是音源命名审查助手。判断音源名称是否异常（重复/测试/临时/多版本副本/乱码混淆等）。',
        '仅输出一个 JSON 对象：{"suspicious":布尔,"reason":"不超过80字的人话理由"}，不要代码块标记。',
        '结合本地规则的命中结果一起判断，但不要盲从：本地规则只是参考证据。'
      ].join('\n')
      const usr = '名称：' + name + '\n错误信息：' + text + '\n本地规则命中：' + (suspicious ? '是（重复/测试/临时类痕迹）' : '否')
      const r = await this.review(sys, usr)
      if (r && r.ok && r.text) {
        const j = this._parseJsonObject(r.text)
        if (j && typeof j.reason === 'string' && j.reason.trim()) {
          conclusion = j.reason.trim().slice(0, 200)
          byAi = true
        }
      }
    } catch (e) {}
    const out = { suspicious, conclusion, byAi, entryId: entry.id || '' }
    const detail = this.makeDetail('R3', hay.slice(0, 200), byAi ? '命名异常 AI 意见（不改状态）' : '命名异常本地规则提示（AI 不可用，降级）')
    const s = this.suggest(entry.id || '', 'R3', conclusion, [
      { key: 'nameHeuristic', ok: suspicious, detail: hay.slice(0, 80) },
      { key: 'source', ok: byAi, detail: byAi ? 'ai' : 'local-fallback' }
    ], { detail })
    return { suggestion: s, result: out }
  }

  /** 从模型文本里宽松解析一个 JSON 对象（去代码块标记、截取首尾大括号），失败返回 null。 */
  _parseJsonObject(text) {
    let t = String(text == null ? '' : text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    const s = t.indexOf('{'), e = t.lastIndexOf('}')
    if (s < 0 || e <= s) return null
    try {
      const j = JSON.parse(t.slice(s, e + 1))
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null
    } catch (e) { return null }
  }

  /**
   * R1 AI 研究报告：把聚类结果交给模型写成"本周失败趋势 + 根因归纳 + 处理建议"，
   * 只进日志供后期调试。失败/未启用/解析异常一律降级为本地摘要，不抛不中断。
   */
  async writeClusterReport(out) {
    const fallback = '本地摘要：' + (out && out.summary ? out.summary : '无失败条目')
    try {
      const clusters = (out && out.clusters) || []
      const lines = clusters.map(c => '- ' + c.reason + '：' + c.count + ' 条').join('\n')
      const added = (out && out.newRules && out.newRules.length) ? '\n本周新归纳类别：' + out.newRules.join('、') : ''
      if (!lines) return fallback
      const sys = [
        '你是音源失败分析助手。根据本周失败聚类写一段简短研究报告。',
        '包含三部分：①本周失败趋势（哪类最多、是否合理）②可能的根因归纳 ③建议怎么处理。',
        '用中文，总共不超过 200 字，分点陈述，不要代码块标记，不要编造数据。'
      ].join('\n')
      const usr = '本周失败聚类：\n' + lines + added
      const r = await this.review(sys, usr)
      if (r && r.ok && r.text && r.text.trim()) return String(r.text).trim().slice(0, 600)
    } catch (e) {}
    return fallback
  }
}

module.exports = { AIReview, RISK, AUTO_READONLY_KINDS, REVIEW_PROMPTS }
