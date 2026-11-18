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

/**
 * detail.action（内部/日志语义，**原文不许改**）→ 前端大白话 actionUi 的映射（v1.10.8）。
 *
 * 用户要求「前端大白话、后端日志专业化」，所以不改 action 原文（日志排查要靠这些精确措辞），
 * 另挂一份 actionUi 供界面显示。没登记的长尾 action 由 makeDetail 的调用方显式传 actionUi，
 * 或前端回退显示 action 原文（宁可显示原文，也不显示空白）。
 */
const ACTION_UI = {
  '生成语义审查建议（待人工确认）': '等你确认后才会执行',
  '生成失败根因聚类摘要（只读，不写状态）': '只归类失败原因，不改任何状态',
  '生成裁决解释 whyAi（不改裁决结果）': '解释为什么这么判，不改判定结果',
  '同名裁决自动解释（不改裁决结果）': '解释为什么这么合并，不改判定结果',
  '命名异常 AI 意见（不改状态）': 'AI 的看法，不改音源状态',
  '命名异常本地规则提示（AI 不可用，降级）': '本地快速判断（AI 没参与）'
}

// R4-R7 统一「prompt + 输入构造 + 结构化输出」契约（评测台子，2026-11-17）。
// 仅供产建议使用：buildText 只拼脱敏客观字段，绝不拼脚本文字/密钥；verdicts 是可复算枚举。
// system 要求模型只输出一个 JSON 对象 {"verdict":"<枚举>","reason":"<≤120字人话>"}。
// 注意：这里不接任何真实业务动作（追更/特征库/信任/拉黑/删源），也不改门控与只读白名单。
// 把深度检测结果序列化成模型可读摘要。生产 sources 里 deep 是对象
// {checkedAt,loadable,platforms:{wy:{status:'usable'|'failed'|...},...}}；
// 评测样本里则是字符串「平台数=5 可用=1 失败=0」。两种格式都认。
// status==='usable'（含 verified!==false 的浅验）算可用，'failed' 算失败。
function deepSummaryText (deep, deepSummary) {
  if (deep && typeof deep === 'object' && deep.platforms && typeof deep.platforms === 'object') {
    const vals = Object.keys(deep.platforms).map(k => deep.platforms[k] || {})
    const total = vals.length
    const usable = vals.filter(p => p.status === 'usable').length
    const failed = vals.filter(p => p.status === 'failed').length
    const parts = ['平台数' + total + ' 可用' + usable + ' 失败' + failed]
    if (deep.loadable === false) parts.push('脚本不可加载')
    else if (deep.loadable === true) parts.push('脚本可加载')
    if (deep.checkedAt) parts.push('已实测')
    return parts.join('，')
  }
  // 兼容原有字符串格式（评测样本/旧缓存）：原样返回，R7 buildText 再抽数字。
  if (typeof deep === 'string' && deep.trim()) return deep.trim()
  if (typeof deepSummary === 'string' && deepSummary.trim()) return deepSummary.trim()
  // deep 是非 platforms 对象但 deepSummary 也可能是对象，避免 String(obj)=[object Object]
  if (deepSummary && typeof deepSummary === 'object') return ''
  return ''
}

// 混淆特征 obfHits 在生产是对象（{spinLoops,evalCalls,...}），直接字符串拼接会得到
// [object Object]。转成可读的 key=值 摘要；数组则 joining；标量原样。
function obfHitsText (hits) {
  if (!hits) return ''
  if (Array.isArray(hits)) return hits.join('、')
  if (typeof hits === 'object') {
    const parts = Object.keys(hits)
      .filter(k => hits[k] && typeof hits[k] !== 'object')
      .map(k => k + '=' + hits[k])
    return parts.join('、')
  }
  return String(hits)
}

/**
 * 「这条建议值不值得占用用户注意力」（v1.10.9，纯展示层判定）。
 *
 * 用户准则：**AI 建议只呈现重要的、需要用户决策或注意的异常**；
 * 「一切正常 / 证据不足保留 / 已自动做完的决定解释」属千篇一律的普遍结论 →
 * 降级为只写日志，不进界面。**本函数不改任何判定结果、不删任何数据**，
 * 日志与 aiReviewLedger 全量保留。
 *
 * 口径（kind + verdict + 结论性质三重判断）：
 *  - R1 同类归组：失败聚类总览，日常不需要用户做什么 → 不提醒
 *  - R2 结论解释：解释「为什么这么自动判」，已做完的决定，用户无需操作 → **全部不提醒**（用户已同意）
 *  - R3 命名：只有「确实可疑」才提醒（同形字符伪装/乱码/二改整合/重复副本…）；「未见异常」不提醒
 *  - R4 更新：只有 follow（建议追更）提醒；ignore（不用管）不提醒
 *  - R5 音源：只有 nonSource（判为非音源，真需处置）提醒；source/拿不准不提醒
 *  - R6 信任：trust / reject 都是需要用户决策的结论 → 都提醒
 *  - R7 删除：只有 blacklist（建议删，高危不可逆）提醒；keep/证据不足不提醒
 *
 * verdict 缺失时（模型没按 JSON 返回 / 本地降级路径）退回结论文本启发式，
 * 宁可少提醒也不把"一切正常"糊到界面上。
 *
 * @param {object} s 建议对象 {kind, conclusion, eval:{verdict}, evidence}
 * @returns {boolean}
 */
function worthNotifying(s) {
  const kind = String((s && s.kind) || '').toUpperCase()
  const verdict = s && s.eval && s.eval.verdict ? String(s.eval.verdict) : ''
  const text = String((s && s.conclusion) || '')

  if (kind === 'R2') return false   // 已自动做完的决定解释，用户无动作可做
  if (kind === 'R1') return false   // 失败聚类总览，只写日志
  if (kind === 'R4') return verdict === 'follow'
  if (kind === 'R5') {
    if (verdict) return verdict === 'nonSource'
    return /不是音源|非音源|不像音源/.test(text)
  }
  if (kind === 'R7') {
    if (verdict) return verdict === 'blacklist'
    return /建议删除|应删除|拉黑/.test(text)
  }
  if (kind === 'R6') {
    if (verdict) return verdict === 'trust' || verdict === 'reject'
    return true   // 隔离区信任意见一律值得看
  }
  if (kind === 'R3') {
    // 本地规则的「可疑」标记优先（evidence.nameHeuristic.ok），它比模型措辞稳定
    const ev = Array.isArray(s && s.evidence) ? s.evidence : []
    const nh = ev.find(x => x && x.key === 'nameHeuristic')
    if (nh && typeof nh.ok === 'boolean') return nh.ok
    // 没有标记时看结论：明确说"没问题/未见异常"就不提醒
    if (/未见明显异常|未见异常|看着没问题|正常|无明显异常/.test(text)) return false
    return /异常|可疑|乱码|同形|二改|整合|重复|副本|临时|测试/.test(text)
  }
  return false   // 未知 kind 默认不打扰
}

const REVIEW_PROMPTS = {
  R4: {
    version: 'v2',
    verdicts: ['follow', 'ignore'],
    system: [
      '你是音源更新提示审查助手。判断一条音源的「更新提示」是否值得跟进追更。',
      '仅输出一个 JSON 对象：{"verdict":"follow或ignore","reason":"不超过120字的人话理由"}，不要代码块标记。',
      '核心准则：宁可漏判、绝不误判为 follow——只有提示里写明「实质更新内容」才 follow。',
      'follow 只认以下实质内容之一：①明确修复具体故障（如"修复DNS解析错误""恢复kg""修复服务器被屏蔽"）；',
      '②明确新功能/健壮性改进（如"断路器""探测池扩容""域名白名单校验"）；③明确更换域名并说明原因。',
      'ignore 的判定：',
      '- 仅"发现新版本 vX"纯版本号、无任何内容说明 → ignore；',
      '- "当前版本过低，请下载最新版" 这类催更模板、无实际更新内容 → ignore；',
      '- 串源催更模板/群号/验证码/广告/引流链接为主、无实质修复或新功能 → ignore；',
      '- "有新版本啦，点击更新即可" 之类无内容提示 → ignore。',
      '注意：提示里即使夹带广告，只要同时写明实质修复/新功能，仍判 follow（看实质内容，不因广告一票否决）；',
      '反之只有版本号或催更模板、没有任何实质内容的，一律 ignore。拿不准一律 ignore。'
    ].join('\n'),
    buildText: (p) => {
      // updateTips 取全文（v1 用 slice(-5) 会截断并漏判——这是 v2 的关键修复）。
      // 全文可能很长：单条审查时拼全文，但整体控在 review() 的 12000 截断之内，避免尾部实质内容被吞。
      const tips = Array.isArray(p.updateTips)
        ? p.updateTips.map(t => (t && typeof t === 'object') ? (t.msg || '') : String(t || '')).filter(Boolean).join('；')
        : String(p.updateTips || '')
      const deepStr = deepSummaryText(p.deep, p.deepSummary)
      return [
        '名称：' + (p.name || ''),
        '当前版本：' + (p.scriptVersion || p.version || ''),
        '状态：' + (p.status || ''),
        '错误：' + (p.error || ''),
        '更新地址：' + (p.updateUrl || ''),
        '判定层级：' + (p.validTier || ''),
        '本机深度实测：' + (deepStr || '无实测'),
        '可用性标记：' + (p.usable === true ? 'true' : p.usable === false ? 'false' : '未知'),
        '混淆等级：' + (p.obfLevel || ''),
        '更新提示（全文）：' + tips.slice(0, 11000)   // 单条全文；极端超长时留 11000 给其余字段与 system 余量
      ].join('\n')
    }
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
    version: 'v2',
    verdicts: ['trust', 'reject'],
    system: [
      '你是混淆音源安全审查助手。判断一条重度混淆脚本是否可信、是否建议信任放行。',
      '仅输出一个 JSON 对象：{"verdict":"trust或reject","reason":"不超过120字的人话理由"}，不要代码块标记。',
      '核心准则：绝不误杀真源——但判 trust 必须同时满足全部「客观放行门槛」，缺一即 reject。',
      '客观放行门槛（三条全部满足才 trust）：',
      '① 判定层级=confirmed；',
      '② 本机深度实测显示「可用平台数>=1」（deep 中 可用=N，N>=1）；usable 标记可能滞后，当 usable=false 但 deep 实测可用>=1 时以 deep 实测为准；',
      '③ 三项硬恶意特征 evalCalls/spinLoops/selfSchedCalls 全为 0。',
      '域名可疑是独立拒绝条件：外联域名含社群/引流短链，或堆叠多个（4 个及以上）非常规免费托管、动态解析域名 → reject。',
      '注意：代码托管平台（gitee/github）、普通自有域名、域名数不超过 3 个且均常规，不算可疑。',
      'jsjiamiMarks/total0x/totalUni/totalExotic/perKbExotic 仅是混淆强度描述，不得作为 reject 依据（明确排除 jsjiami）。',
      '拿不准一律 reject；但三条门槛全满足且域名不可疑时必须 trust。理由用中文人话，便于用户阅读。'
    ].join('\n'),
    buildText: (p) => [
      '名称：' + (p.name || ''),
      '来源仓库：' + (p.repository || ''),
      '错误：' + (p.error || ''),
      '外联域名：' + (() => {
        // C 验收修复：原只取 obfDomains（评测数据仅 2 条非空），漏了 apiHosts（25 条非空），
        // 导致可疑域名（oiapi/xcvts/onrender/社群短链等都在 apiHosts）不进 prompt，域名可疑规则形同虚设。
        // 改为 obfDomains ∪ apiHosts 去重并集，与 R7 buildText 口径对齐；空值安全。
        const toArr = v => Array.isArray(v) ? v : (v ? [v] : [])
        const all = toArr(p.obfDomains).concat(toArr(p.apiHosts)).map(x => String(x || '').trim()).filter(Boolean)
        return Array.from(new Set(all)).join('、')
      })(),
      '混淆特征：' + obfHitsText(p.obfHits),
      '判定层级：' + (p.validTier || ''),
      '域名判定：' + (p.obfDomainVerdict || ''),
      '深度摘要：' + deepSummaryText(p.deep, p.deepSummary)
    ].join('\n')
  },
  R7: {
    version: 'v2',
    verdicts: ['blacklist', 'keep'],
    system: [
      '你是音源删源审查助手。判断一条音源是否应拉黑/删源（高危、不可逆）。',
      '仅输出一个 JSON 对象：{"verdict":"blacklist或keep","reason":"不超过120字的人话理由"}，不要代码块标记。',
      '核心准则：宁可漏判、绝不误伤——只要源可能仍可用就 keep；判 blacklist 必须有确凿硬证据。',
      'blacklist 只认以下两类硬证据之一：',
      '① 状态为 dead / HTTP 404、脚本已失效（本机无深度实测也属失效源）。注意：无论本地是否已灌入，dead/404 一律判 blacklist；"只禁不删"只是执行层对无本地脚本的条目仅拉黑、不物理删文件，不改变 verdict。',
      '② 本机深度实测"平台数>0 但可用=0"全平台不可用，且连续失效次数很高（≥10次）。连续失效次数<10 的，即便深度实测可用=0，也一律 keep。',
      '凡本机深度实测"可用>=1"或 usable=true 的，说明源仍可用——无论连续失效次数多大，一律 keep（信号矛盾时以实测为准，不删）。',
      '状态为 ok 且连续失效次数不高的源，即便深度实测可用0或带混淆特征，也一律 keep。',
      '证据缺失、判定层级为空、deep 无实测且状态又非 dead 的，一律 keep。拿不准一律 keep。'
    ].join('\n'),
    buildText: (p) => {
      const led = (p.ledger && typeof p.ledger === 'object') ? p.ledger : {}
      const deepStr = deepSummaryText(p.deep, p.deepSummary)
      const m = deepStr.match(/平台数\s*=?\s*(\d+)\s*可用\s*=?\s*(\d+)\s*失败\s*=?\s*(\d+)/)
      // 仅把计数规范成「平台数N 可用M 失败K」，保留「，已实测/脚本不可加载」等后缀供模型参考。
      const deepDesc = m
        ? deepStr.replace(m[0], '平台数' + m[1] + ' 可用' + m[2] + ' 失败' + m[3])
        : (deepStr || '无实测')
      // 本地已灌入判定：调用方显式传入优先；否则 scriptName / apiHosts / deep / validTier 任一非空即视为曾本地灌入。
      // 注意：scriptName 非空即说明本地有脚本，不能因为 apiHosts 为空就当成"仅服务端存在的占位"。
      const installed = (p.installed === true || p.installed === false)
        ? p.installed
        : !!((p.scriptName && String(p.scriptName).trim()) ||
             (Array.isArray(p.apiHosts) && p.apiHosts.length) ||
             deepStr.trim() || p.validTier)
      const streak = p.streak != null ? p.streak : p.apiDownStreak
      return [
        '名称：' + (p.name || ''),
        '状态：' + (p.status || '') + (p.status === 'dead' ? '（源已失效/HTTP 404）' : ''),
        '错误：' + (p.error || ''),
        '判定层级：' + (p.validTier || ''),
        '可用性标记：' + (p.usable === true ? 'true' : p.usable === false ? 'false' : '未知'),
        '本机深度实测：' + deepDesc,
        '连续失效次数：' + (streak != null ? streak : ''),
        '本地已灌入：' + (installed ? '是' : '否（仅服务端存在，只禁不删）'),
        '外联域名：' + (Array.isArray(p.apiHosts) ? p.apiHosts.join('、') : (p.apiHosts || '')),
        '混淆特征：' + obfHitsText(p.obfHits),
        '命中本地启发式：' + (p.suspected === true ? '是' : p.suspected === false ? '否' : '未知'),
        '来源仓库：' + (p.repository || ''),
        '账本 hash：' + (led.hash || ''),
        '账本外来条目：' + (led.foreign === true ? '是' : led.foreign === false ? '否' : '未知')
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
  // 自动档逐条 LLM 复检（R3 命名润色 + R4/R5 铺轨）独立开关，默认关：
  // 该路径每轮 20-60 次 LLM 调用、只产无人消费的 applied 标记，零进化价值。
  // R1 本地聚类/自生长不受此开关影响（静默、低成本、有进化价值）。评测达标后再开。
  autoLlmReviewEnabled: false,
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
    // 可注入的副作用钩子（仅供批量重试；测试注入以免真的睡 800/2000ms）
    this._sleep = ms => new Promise(r => setTimeout(r, ms))
    this._now = () => Date.now()
    this._rand = Math.random
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
      autoLlmReviewEnabled: bool('autoLlmReviewEnabled'),
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
        // R1研究报告：把聚类写成"趋势+根因+建议"。仅手动触发才调 LLM 润色——
        // 自动聚类(每168h静默跑)不花钱润色，日志用 summary 即可；报告对聚类准确率无贡献，属装饰。
        // 自生长 learnClusterRules 保留在 auto（有样本≥5门槛，会沉淀规则让下周聚类更准，是进化引擎）。
        if (trigger !== 'auto') {
          out.report = await this.writeClusterReport(out)
        }
        // 自动触发或 logOnly 只返回聚类结果（日志由调用方写，core 不依赖 pushLog）
        if (trigger === 'auto' || b.logOnly) return { logged: true, result: out }
        const detail = this.makeDetail('R1', '聚类 ' + entries.length + ' 条失败条目', b.detailAction || '生成失败根因聚类摘要（只读，不写状态）')
        const evidence = out.clusters.map(c => ({ key: c.reason, ok: true, count: c.count }))
        const s = this.suggest(b.entryId || '', 'R1', out.summary, evidence, { detail })
        return { suggestion: s, result: out }
      }
      if (kind === 'R2') {
        const out = this.explainVerdict(b.verdict || {}, b.ctx || {})
        // v1.10.9（用户拍板）：R2 是「为什么这么自动判」的事后解释——决定已经做完、用户没有动作可做，
        // 属千篇一律的普遍结论，**不再产出 UI 建议**，只留日志与 aiReviewLedger。
        // 判定逻辑（explainVerdict）一字未改，只是不往界面塞。调用方仍拿到 result 可写日志。
        return { logged: true, logOnly: true, result: out }
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
    // v1.10.9：给每条建议打「值不值得占用用户注意力」标记（纯展示层，不改判定、不删数据）。
    // 用户准则：AI 建议只呈现重要的、需要决策或注意的异常；"一切正常/证据不足保留/已自动做完的解释"
    // 属千篇一律的普遍结论，降级为只写日志。日志与 aiReviewLedger 全量保留，只是不进界面。
    if (s.worthNotifying == null) s.worthNotifying = !!worthNotifying(s)
    this.store.db.aiSuggestions[s.id] = s
    return s
  }

  /**
   * 构造建议的「检测详情」detail，仅供前端详情页只读渲染，不参与任何自动执行判定。
   * 契约：{ inputDigest:string(截断200字), gate:{auto,reason}, promptVersion:string,
   *         action:string, actionUi:string }
   *
   * v1.10.8 起 action 与 actionUi **严格分两套**（用户要求「前端大白话、后端日志专业化」）：
   *  - `action`   内部/日志语义，原文一个字不改（日志是排查依据，精确描述才有价值）
   *  - `actionUi` 只给界面看的大白话
   * 前端一律读 actionUi（缺省回退 action），日志一律读 action。
   */
  makeDetail(kind, inputDigest, action, actionUi) {
    const act = String(action == null ? '' : action)
    return {
      inputDigest: String(inputDigest == null ? '' : inputDigest).slice(0, 200),
      gate: this.gate(kind),
      promptVersion: (REVIEW_PROMPTS[kind] && REVIEW_PROMPTS[kind].version) || 'v1',
      action: act,
      actionUi: String(actionUi == null ? (ACTION_UI[act] || '') : actionUi)
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
  /**
   * 列出建议。v1.10.9 新增 `worthOnly` 过滤：只返回「值得占用用户注意力」的条目
   * （口径见 worthNotifying）。界面一律传真，日志/评测/回放不传、拿全量。
   * 老数据没有 worthNotifying 字段时就地按同一口径补算，不需要迁移脚本。
   */
  listSuggestions(filter) {
    const f = filter || {}
    let arr = Object.values(this.store.db.aiSuggestions || {})
    if (f.status) arr = arr.filter(s => s.status === f.status)
    if (f.kind) arr = arr.filter(s => s.kind === f.kind)
    if (f.source === 'ai') arr = arr.filter(s => s.by !== 'user')
    if (f.worthOnly) arr = arr.filter(s => (s.worthNotifying == null ? worthNotifying(s) : !!s.worthNotifying))
    return arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  listAudit() {
    return Object.values(this.store.db.aiAudit || {}).sort((a, b) => (b.auditAt || 0) - (a.auditAt || 0))
  }

  /**
   * 反馈聚合（只读、零 AI）：遍历 db.aiSuggestions，按 kind + eval.promptVersion 统计
   * adopt（采纳）/ dismiss（忽略）意愿与采纳率。忽略≠误判，只标意愿，不当 gold。
   * 老建议无 feedback 字段 → 计入 unknown，不算入率；样本不足（< MIN_FEEDBACK）返回 dataInsufficient。
   */
  feedbackStats() {
    const MIN_FEEDBACK = 5
    const all = Object.values((this.store.db && this.store.db.aiSuggestions) || {})
    const buckets = new Map()
    let adopt = 0, dismiss = 0, unknown = 0
    for (const s of all) {
      if (!s || typeof s !== 'object') continue
      const kind = String(s.kind || 'unknown')
      const pv = String((s.eval && s.eval.promptVersion) || s.promptVersion || 'v1')
      const key = kind + '|' + pv
      let b = buckets.get(key)
      if (!b) { b = { kind, promptVersion: pv, adopt: 0, dismiss: 0, pending: 0, unknown: 0, total: 0 }; buckets.set(key, b) }
      b.total++
      const act = s.feedback && s.feedback.action
      if (act === 'adopt') { b.adopt++; adopt++ }
      else if (act === 'dismiss') { b.dismiss++; dismiss++ }
      else if (s.status === 'pending' || s.status === 'applied') { b.pending++; unknown++ }
      else { b.unknown++; unknown++ }
    }
    const decided = adopt + dismiss
    const byKind = Array.from(buckets.values()).map(b => {
      const d = b.adopt + b.dismiss
      return Object.assign({}, b, {
        rate: d > 0 ? Math.round(b.adopt / d * 1000) / 10 : null,
        dataInsufficient: d < MIN_FEEDBACK
      })
    }).sort((a, b) => b.total - a.total)
    return {
      dataInsufficient: decided < MIN_FEEDBACK,
      total: all.length,
      decided,
      adopt,
      dismiss,
      overallRate: decided > 0 ? Math.round(adopt / decided * 1000) / 10 : null,
      note: '采纳率=确认/(确认+忽略)，仅表采纳意愿，不代表 AI 判对与否；忽略≠误判',
      byKind
    }
  }

  /**
   * 影子日志自检（只读、零 AI）：对 db.aiEvalLog 按 zone×danger×ruleAct 聚合分布；
   * 结合建议 feedback 与 eval.verdict 找"一致性候选"（如 verdict=blacklist 却被忽略 / keep 却被确认）。
   * 单边偏置提示：某 kind 的 verdict 分布连续同向且样本足够 → suspectBias。
   * 老 db 无 aiEvalLog 或样本不足 → dataInsufficient。纯计数/比对，绝不调用 review/provider。
   */
  selfCheck() {
    const MIN_SAMPLE = 5
    const db = this.store.db || {}
    const logs = Object.values(db.aiEvalLog || {})
    const suggestions = Object.values(db.aiSuggestions || {})
    const dist = new Map()
    for (const l of logs) {
      if (!l || typeof l !== 'object') continue
      const key = String(l.zone || '?') + '×' + String(l.danger || 'D0') + '→' + String(l.ruleAct || '?')
      dist.set(key, (dist.get(key) || 0) + 1)
    }
    const distribution = Array.from(dist.entries()).map(([stratum, count]) => ({ stratum, count })).sort((a, b) => b.count - a.count)

    // 一致性候选：只标"待复评"，不下"误判"结论
    const consistent = []
    let checked = 0
    for (const s of suggestions) {
      if (!s || !s.eval || !s.eval.verdict || !s.feedback || !s.feedback.action) continue
      checked++
      const v = String(s.eval.verdict)
      const act = s.feedback.action
      // 只标唯一明确的相悖项：AI 建议拉黑/删(blacklist) 而用户忽略(dismiss)该建议。
      // keep+adopt（AI建议保留、用户采纳保留）本就一致，不算冲突；keep+dismiss 语义模糊也不算。
      const conflict = (v === 'blacklist' && act === 'dismiss')
      if (conflict) consistent.push({ id: s.id, kind: s.kind, verdict: v, action: act, note: '建议与采纳意愿相反，待人工复评' })
    }

    // 单边偏置：某 kind 的 verdict 分布里同一 verdict 占比 ≥ 80% 且样本≥MIN_SAMPLE
    const verdictByKind = new Map()
    for (const s of suggestions) {
      if (!s || !s.eval || !s.eval.verdict) continue
      const k = String(s.kind || '?')
      if (!verdictByKind.has(k)) verdictByKind.set(k, new Map())
      const vm = verdictByKind.get(k)
      const v = String(s.eval.verdict)
      vm.set(v, (vm.get(v) || 0) + 1)
    }
    const bias = []
    for (const [k, vm] of verdictByKind) {
      const n = Array.from(vm.values()).reduce((a, b) => a + b, 0)
      if (n < MIN_SAMPLE) continue
      let top = '', topN = 0
      for (const [v, c] of vm) if (c > topN) { top = v; topN = c }
      const share = Math.round(topN / n * 1000) / 10
      if (share >= 80) bias.push({ kind: k, verdict: top, share, samples: n, note: '该 kind 结论单边集中，疑似偏置，建议人工复评（不改任何门控）' })
    }

    return {
      dataInsufficient: logs.length < MIN_SAMPLE && checked < MIN_SAMPLE && bias.length === 0,
      logs: logs.length,
      checked,
      distribution,
      consistencyCandidates: consistent,
      bias,
      note: '自检仅计数/比对，标注"待复评/疑似偏置"，不判对错、不触发任何执行或门控改动'
    }
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
      ? '名字可能有问题：带重复/测试/临时这类痕迹，建议你核对一下是不是同一个源的多个版本'
      : '名字看着没问题（本地快速判断，仅供参考）'
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
   * 批级失败归类（纯函数、导出供测试）。
   *  - 'throttle'  429/限流/配额：**不重试**（重试只会加剧限流，且可能已计费额度）
   *  - 'transient' 网络层：超时/fetch failed/ECONN 系/DNS/连接级 socket 错/5xx/非 JSON/空内容 → 可重试
   *  - 'other'     其余（未配置、401/400、未知）：不重试（不明原因不猛冲）
   *
   * 边界（C 复核 §3.2 收紧）：
   *  - quota 用词边界 `\bquota\b`，避免把 `quotation 校验失败` 误配成限流（语义错，虽行为等价）；
   *  - socket 只认连接级故障（hang up / hang / error / closed / socket.），
   *    避免「socket连接但账号未配置」这类非网络错误被白重试两次。
   * @param {object} r {error} review() 的返回或 {error:异常message}
   * @returns {'throttle'|'transient'|'other'}
   */
  static classifyBatchError(r) {
    const msg = String((r && r.error) || '')
    if (/\b429\b|too many requests|rate.?limit|限流|\bquota\b|配额/i.test(msg)) return 'throttle'
    if (/超时|timeout|timed out|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket\s*(?:hang\s*up|hang|error|closed)|socket\.|network|网络|非 2xx（5\d\d）|响应不是合法 JSON|返回内容为空/i.test(msg)) return 'transient'
    return 'other'
  }

  /**
   * 分批执行批量语义分类（解决 review() 的 20 秒超时：一次让模型输出几十条必超时）。
   *
   * 策略（不放宽 aiProvider 超时，治本）：
   *   - 按条目数切批，每批上限 BATCH_MAX(12) 条——实测 10-15 条安全，12 为保守中值；
   *   - 每批仍走 buildFn 的字符控量（11000）作为二级约束，两者取先到者；
   *   - **串行**调用（不并发，避 429 限流）；每批独立 try/catch，某批失败只丢该批、不影响其它批；
   *   - 总上限 MAX_TOTAL(120) 条，超出部分不处理（下次再跑），避免源爆炸时跑几十分钟；
   *   - 汇总所有成功批次为大对象返回；失败批次不写任何字段（保持"不预判"语义）。
   *
   * 批级重试（真实数据实测：4 批连跑 45-50 秒时必有一批断于超时/fetch failed，无重试=丢该批 12 条）：
   *   - **只重试失败批**，成功批绝不再调（不重复花钱）；
   *   - 每批最多重试 RETRY_MAX(2) 次（共 3 次机会），仅对网络层失败（超时/fetch failed/5xx/空响应）重试；
   *   - 退避 BACKOFF_BASE(800ms) × 2^n 并加 0-300ms 随机抖动（800→1600+抖动），串行不并发；
   *   - **429/限流**（配额类）：不重试（重试只会加剧限流，且中转站可能已计费额度），直接放弃该批；
   *   - **总时长预算** TOTAL_BUDGET_MS(180000)：超预算即停止对后续失败批重试（仍会跑完首轮尚未执行的批），
   *     避免"4 批 50 秒 + 全部重试"把后台任务拖到几分钟；
   *   - 重试仍失败 → 放弃该批（不写字段、下次灌入自动重算），计入 stats 并在日志体现。
   *
   * @param {Array} list 已过滤的有效条目
   * @param {Function} buildFn (chunk) => {text} 构造该批输入
   * @param {Function} systemFn () => string 该批 system prompt
   * @param {Function} parseFn (json) => {[id]:{...}} 解析模型返回的 results 数组
   * @param {object} [opts] { batchMax, maxTotal, retryMax, backoffBase, totalBudgetMs }
   * @returns {Promise<{map:object, batches:number, calls:number, truncated:boolean, total:number, processed:number}>}
   */
  async _classifyInBatches(list, buildFn, systemFn, parseFn, opts) {
    const o = opts || {}
    const batchMax = Math.max(1, Number(o.batchMax) || 12)
    const maxTotal = Math.max(1, Number(o.maxTotal) || 120)
    const retryMax = Number.isFinite(Number(o.retryMax)) ? Math.max(0, Number(o.retryMax)) : 2
    const backoffBase = Number(o.backoffBase) > 0 ? Number(o.backoffBase) : 800
    const totalBudgetMs = Number(o.totalBudgetMs) > 0 ? Number(o.totalBudgetMs) : 180000
    const arr = Array.isArray(list) ? list : []
    const truncated = arr.length > maxTotal
    const work = truncated ? arr.slice(0, maxTotal) : arr
    const map = {}
    let calls = 0, batches = 0
    const stats = {
      batches: 0, calls: 0, retries: 0, retriedOk: 0, dropped: 0, droppedIds: 0,
      giveUpByBudget: 0, throttled: 0, budgetExhausted: false, lastError: ''
    }
    const startedAt = this._now()
    const overBudget = () => (this._now() - startedAt) >= totalBudgetMs

    // 失败归类：429/限流（配额，重试有害）vs 网络层（可重试）vs 其它（不重试）
    const classifyErr = r => AIReview.classifyBatchError(r)

    for (let i = 0; i < work.length; i += batchMax) {
      const chunk = work.slice(i, i + batchMax)
      batches++
      let built
      try {
        built = buildFn(chunk)
        if (!built || !built.text) continue
      } catch (e) { continue }   // 构造失败：该批彻底跳过（重试也没意义）

      let attempt = 0
      let ok = false
      let lastKind = 'other'
      let lastErr = ''
      while (attempt <= retryMax) {
        // 重试前：超预算就不再试（首轮 attempt=0 永远执行）
        if (attempt > 0) {
          if (overBudget()) { stats.giveUpByBudget++; break }
          stats.retries++
          const backoff = backoffBase * Math.pow(2, attempt - 1)
          const jitter = Math.floor(this._rand() * 300)
          try { await this._sleep(backoff + jitter) } catch (_) {}
        }
        calls++
        try {
          const r = await this.review(systemFn(), built.text)
          if (r && r.ok && r.text) {
            const j = this._parseJsonObject(r.text)
            const parsed = parseFn(j)
            if (parsed && typeof parsed === 'object') Object.assign(map, parsed)
            ok = true
            if (attempt > 0) stats.retriedOk++
            break
          }
          lastErr = String((r && r.error) || '未知失败')
          lastKind = classifyErr(r)
          if (lastKind === 'throttle') { stats.throttled++; break }   // 429：不重试，避免加剧限流
          if (lastKind !== 'transient') break                          // 非网络层：重试无意义
        } catch (e) {
          lastErr = String((e && e.message) || e)
          lastKind = classifyErr({ error: lastErr })
          if (lastKind !== 'transient') break
        }
        attempt++
        if (attempt > retryMax) break
      }
      if (!ok) {
        // 该批最终放弃：不写字段（下次灌入自动重算），记录条数与错误
        stats.dropped++
        stats.droppedIds += chunk.length
        if (lastErr) stats.lastError = lastErr
        if (stats.giveUpByBudget > 0 && overBudget()) stats.budgetExhausted = true
      }
    }
    stats.batches = batches
    stats.calls = calls
    // 统计随返回值传递（不再用实例级 lastBatchStats：并发 worker 会互相覆盖，日志数字少算）
    if (stats.dropped || stats.retries) {
      // 只记错误，不抛：调用方仍拿到成功批的结果
      stats.summary = stats.dropped
        ? ('AI 分批：' + stats.dropped + ' 批（' + stats.droppedIds + ' 条）重试后放弃' +
           (stats.throttled ? '，含 ' + stats.throttled + ' 批限流' : '') +
           (stats.lastError ? '：' + String(stats.lastError).slice(0, 100) : ''))
        : ('AI 分批：重试 ' + stats.retries + ' 次后成功 ' + stats.retriedOk + ' 批')
      this.lastError = stats.summary
    }
    return { map, batches, calls, truncated, total: arr.length, processed: work.length, stats }
  }

  // ===== 突破项①：冷启动语义预判（批量 one-shot，只排序/徽章，不进判定链） =====
  // 阶段1 新仓验真前：判「真音源聚合仓 vs 客户端/播放器/教程仓」；
  // 阶段2 新源入库后：判「真音源 vs 自检探测工具/示例」。
  // 产出只写独立字段 repoAiClass/sourceAiClass + 理由，绝不进 act/三锁/默认安全态/gold。

  /** 冷启动预判 system prompt（保守阈值：宁可判 uncertain 不误判 tool）。 */
  static coldStartSystem(kind) {
    return [
      '你是洛雪音乐音源的仓库/条目分类器。只做语义判断，输出 JSON，不要代码块。',
      kind === 'repo'
        ? '判断每个仓库是不是「真·音源聚合仓库」：聚合大量 .js 音源脚本的仓库=real；客户端/播放器/管理器/教程/网关/只有一两个示例脚本的仓库=tool；拿不准=uncertain。'
        : '判断每个条目是不是「真·音源脚本」：名字/用途像正常音乐音源(如星海音乐源/聚合音源)=real；像自检/探测/示例/测试工具(如 live_source_probe、lx_engine_selftest、示例音源、preload_quality_probe)=tool；拿不准=uncertain。',
      '硬规则：证据不足一律判 uncertain，绝不因为名字像工具就把真源判 tool；description/topics/name 才是依据，不臆测。',
      '输出格式：{"results":[{"id":"原样带回的编号","class":"real|tool|uncertain","reason":"一句话中文理由"}]}，每条输入都要有结果。'
    ].join('\n')
  }

  /**
   * 构造冷启动 one-shot 输入并主动控量（<12000 字符，保证尾部条目不被截断吞掉）。
   * 纯函数、导出供测试：超预算先压 description/topics，再按条目裁剪，宁可少带几条也不丢头部关键信息。
   * @param {Array} items [{id,name,description?,topics?,apiHosts?,platformCount?}]
   * @param {number} budget 字符预算（默认 11000，给 system/格式留余量）
   */
  static buildColdStartInput(items, budget) {
    const list = Array.isArray(items) ? items : []
    const cap = Number(budget) > 0 ? Number(budget) : 11000
    const HEAD = '请分类以下条目（id 原样带回）：\n'
    const line = (it, dLen) => {
      const topics = Array.isArray(it.topics) ? it.topics.join(',') : (it.topics ? String(it.topics) : '')
      const hosts = Array.isArray(it.apiHosts) ? it.apiHosts.slice(0, 4).join(',') : ''
      const desc = String(it.description || '').slice(0, dLen)
      return [it.id, '名称=' + String(it.name || ''), desc ? '描述=' + desc : '', topics ? '主题=' + topics : '',
        hosts ? '域名=' + hosts : '', it.platformCount ? '平台数=' + it.platformCount : ''].filter(Boolean).join(' | ')
    }
    let finalList = list.slice()
    let dLen = 160
    let body = finalList.map(it => line(it, dLen)).join('\n')
    // 先压每条的描述长度（保住全部条目）
    while (HEAD.length + body.length > cap && dLen > 40) {
      dLen = Math.max(40, Math.floor(dLen * 0.7))
      body = finalList.map(it => line(it, dLen)).join('\n')
    }
    // 仍超（条目极多）：按条目裁剪，保留头部
    while (HEAD.length + body.length > cap && finalList.length > 1) {
      finalList = finalList.slice(0, Math.ceil(finalList.length * 0.8))
      body = finalList.map(it => line(it, dLen)).join('\n')
    }
    return { text: HEAD + body, ids: finalList.map(it => String(it.id)), truncated: finalList.length < list.length }
  }

  /**
   * 冷启动批量语义预判（旁路、低频、失败静默降级）。
   * @param {Array} items [{id,name,description?,topics?,apiHosts?,platformCount?}]
   * @param {'repo'|'source'} kind
   * @param {object} [o] {withStats:true} → 返回 {map, stats}（stats 含重试/放弃统计，供日志）
   * @returns {Promise<object>} { [id]: {class, reason} }；任何失败/未启用返回 {}（=不预判）
   */
  async classifyColdStart(items, kind, o) {
    const withStats = !!(o && o.withStats)
    const empty = {}
    try {
      const list = Array.isArray(items) ? items.filter(it => it && it.id != null) : []
      if (!list.length) return withStats ? { map: empty, stats: null } : empty
      const sysKind = kind === 'repo' ? 'repo' : 'source'
      const res = await this._classifyInBatches(list,
        chunk => AIReview.buildColdStartInput(chunk, 11000),
        () => AIReview.coldStartSystem(sysKind),
        j => {
          const arr = j && Array.isArray(j.results) ? j.results : []
          const out = {}
          for (const row of arr) {
            if (!row || row.id == null) continue
            const cls = row.class === 'real' || row.class === 'tool' ? row.class : 'uncertain'  // 保守：非法值一律 uncertain
            out[String(row.id)] = { class: cls, reason: String(row.reason || '').slice(0, 120) }
          }
          return out
        })
      return withStats ? { map: res.map, stats: res.stats } : res.map
    } catch (e) { return withStats ? { map: empty, stats: null } : empty }
  }

  // ===== 突破项②：R4 更新说明语义分级（批量 one-shot，只排序/徽章，不进判定链） =====
  // 判据（C 订正）：判「有无实质修复/新功能内容」，**不是「见广告就剔」**！
  // 7 条 gold=follow 的 updateTips 也含广告外链（如"更换域名修复DNS解析 + 联通套餐外链"），
  // 按"见广告就剔"会误杀；广告只作弱信号。纯版本播报/版本号过低=灰区判 uncertain，不交 AI 单独定夺。

  /** R4 语义分级 system prompt（保守阈值：证据不足→uncertain、宁可不判不误杀）。 */
  static updateTipsSystem() {
    return [
      '你是洛雪音乐音源「更新提示」的语义分级助手。只做语义判断，输出 JSON，不要代码块。',
      '任务：判断每条更新提示是否包含【实质修复或新功能内容】。',
      'substantive=true：提示里有具体修复/功能（如"修复DNS解析/更换域名修复地区解析错误/恢复kg/酷我rid前缀修复/假链拦截/断路器区分确定性瞬时错误/白名单校验"等），即便同时夹带广告外链也算 true。',
      'substantive=false：纯催更无实质内容（如"长青svip音源更新，请尽快更新"）、纯引流/广告（验证码群号、套餐外链且无任何修复说明）、无效更新。',
      'uncertain：只有版本号变化（"发现新版本 v1.1.2"）、版本过低提示（"当前源脚本版本过低(v4)"）、"有新版本啦点击更新"这类没有内容证据的灰区——一律 uncertain，不要臆断。',
      '硬规则：广告只是弱信号，绝不能因为夹带广告就把有实质修复的判 false；证据不足一律 uncertain。',
      '输出格式：{"results":[{"id":"原样带回的编号","substantive":"true|false|uncertain","reason":"一句话中文理由"}]}，每条输入都要有结果。'
    ].join('\n')
  }

  /**
   * 构造 R4 语义分级 one-shot 输入并主动控量（<12000 字符，保证尾部条目不被截断吞掉）。
   * 纯函数、导出供测试。
   * @param {Array} items [{id, name?, tips:[string]|string}]
   * @param {number} budget 字符预算（默认 11000）
   */
  static buildUpdateTipsInput(items, budget) {
    const list = Array.isArray(items) ? items : []
    const cap = Number(budget) > 0 ? Number(budget) : 11000
    const HEAD = '请分级以下更新提示（id 原样带回）：\n'
    const tipsOf = it => Array.isArray(it.tips) ? it.tips.filter(Boolean).join('；') : String(it.tips || '')
    const line = (it, tLen) => {
      const tips = tipsOf(it).replace(/\s+/g, ' ').slice(0, tLen)
      return [it.id, it.name ? '名称=' + String(it.name) : '', tips ? '提示=' + tips : ''].filter(Boolean).join(' | ')
    }
    let finalList = list.slice()
    let tLen = 400
    let body = finalList.map(it => line(it, tLen)).join('\n')
    while (HEAD.length + body.length > cap && tLen > 80) {
      tLen = Math.max(80, Math.floor(tLen * 0.7))
      body = finalList.map(it => line(it, tLen)).join('\n')
    }
    while (HEAD.length + body.length > cap && finalList.length > 1) {
      finalList = finalList.slice(0, Math.ceil(finalList.length * 0.8))
      body = finalList.map(it => line(it, tLen)).join('\n')
    }
    return { text: HEAD + body, ids: finalList.map(it => String(it.id)), truncated: finalList.length < list.length }
  }

  /**
   * R4 更新说明批量语义分级（旁路、低频、失败静默降级）。
   * @param {Array} items [{id, name?, tips:[string]|string}]
   * @param {object} [o] {withStats:true} → 返回 {map, stats}（stats 含重试/放弃统计，供日志）
   * @returns {Promise<object>} { [id]: {substantive:true|false|'uncertain', reason} }；任何失败/未启用返回 {}（=不预判）
   */
  async classifyUpdateTips(items, o) {
    const withStats = !!(o && o.withStats)
    const empty = {}
    try {
      const list = Array.isArray(items) ? items.filter(it => it && it.id != null) : []
      if (!list.length) return withStats ? { map: empty, stats: null } : empty
      const res = await this._classifyInBatches(list,
        chunk => AIReview.buildUpdateTipsInput(chunk, 11000),
        () => AIReview.updateTipsSystem(),
        j => {
          const arr = j && Array.isArray(j.results) ? j.results : []
          const out = {}
          for (const row of arr) {
            if (!row || row.id == null) continue
            // 保守：只认明确 true/false，其余（含非法值）一律 uncertain
            let sub = 'uncertain'
            const raw = row.substantive
            if (raw === true || raw === 'true') sub = true
            else if (raw === false || raw === 'false') sub = false
            out[String(row.id)] = { substantive: sub, reason: String(row.reason || '').slice(0, 120) }
          }
          return out
        })
      return withStats ? { map: res.map, stats: res.stats } : res.map
    } catch (e) { return withStats ? { map: empty, stats: null } : empty }
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

module.exports = { AIReview, RISK, AUTO_READONLY_KINDS, REVIEW_PROMPTS, worthNotifying }
