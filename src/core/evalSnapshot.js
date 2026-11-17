'use strict'
/**
 * 评测快照构造（脱敏，零依赖）
 *
 * 冻结"当时 AI 看到了什么"：只留结构性证据与摘要，不含脚本文字与密钥。
 * 不 require quality.js / version.js（避免循环依赖），只做与现有口径对齐的简单判断。
 * 所有函数对任意缺失字段都不抛。
 */

/** 安全字符串化并截断；不保留脚本文字（调用方不应把 code 传进来）。 */
function _text(v, max) {
  const s = v == null ? '' : (typeof v === 'string' ? v : String(v))
  return s.slice(0, max || 200)
}

/** 取第一个有限数，否则 null。 */
function _num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 版本能否比较：两边都能解析出 "x.y" 形式的版本号即可比（与 cmpVersion 可用前提一致）。 */
function _versionComparable(local, srv) {
  const re = /[vV]?\d+(?:\.\d+)/
  return re.test(String(local == null ? '' : local)) && re.test(String(srv == null ? '' : srv))
}

/** 单侧质量画像：scored = deep.depth==='full' 且 samples>0；无实测平台证据则 declared。 */
function _profile(entry) {
  const e = entry || {}
  const deep = (e.deep && typeof e.deep === 'object') ? e.deep : null
  const metrics = (deep && deep.metrics && typeof deep.metrics === 'object') ? deep.metrics : null
  const platforms = (deep && deep.platforms && typeof deep.platforms === 'object') ? deep.platforms : null
  const samples = _num(metrics && metrics.samples)
  const scored = !!(metrics && metrics.depth === 'full' && samples !== null && samples > 0)
  const declared = !(platforms && Object.keys(platforms).length)
  const p50 = (scored && metrics) ? _num(metrics.p50LatencyMs) : null
  const q = (scored && metrics && metrics.qualityMax != null)
    ? (Array.isArray(metrics.qualityMax) ? metrics.qualityMax[0] : metrics.qualityMax) : null
  return {
    usable: platforms ? Object.keys(platforms).length : 0,
    tier: q == null ? null : _text(q, 40),
    p50,
    scored,
    declared
  }
}

/**
 * 构造脱敏评测输入快照。
 * @param {object} e 本地条目（contentHash/status/deep.metrics/repository…）
 * @param {object} srv 服务端条目（version/supportedSources/qualityProxy/id…）
 * @param {string} code 脚本正文——只用于算 codeHash，绝不写入快照
 * @param {object} cfg 配置（取 version 相关键）
 * @param {object} opt 额外证据：ledger/hash/foreign/lxId/sameSourceKey/inputDigest
 */
function buildEvalSnapshot(e, srv, code, cfg, opt) {
  const en = e || {}
  const sv = srv || {}
  const o = opt || {}
  const c = cfg || {}
  const deep = (en.deep && typeof en.deep === 'object') ? en.deep : {}
  const metrics = (deep.metrics && typeof deep.metrics === 'object') ? deep.metrics : {}
  const ledger = (o.ledger && typeof o.ledger === 'object') ? o.ledger : {}
  const local = o.local || en
  const server = o.server || sv

  const localSources = Array.isArray(en.supportedSources) ? en.supportedSources : []
  const serverSources = Array.isArray(sv.supportedSources) ? sv.supportedSources
    : (Array.isArray(sv.qualityProxy && sv.qualityProxy.supportedSources) ? sv.qualityProxy.supportedSources : [])
  const overlap = localSources.filter(x => serverSources.indexOf(x) !== -1)

  let codeHash = o.codeHash || en.contentHash || null
  if (!codeHash && code) {
    // 纯 JS 确定性摘要（djb2 + 长度后缀），只为同/异判定，不作安全用途。
    let h = 5381
    const s = String(code)
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
    codeHash = 'djb2:' + h.toString(16) + ':' + s.length
  }

  const localVer = en.scriptVersion || o.localVersion || en.version || null
  const srvVer = sv.version || null
  const sameSourceKey = o.sameSourceKey != null
    ? o.sameSourceKey
    : ((o.sourceKeyA || (local && local.repository) || en.repository) &&
       (o.sourceKeyB || (server && server.repository) || sv.repository) &&
       String(o.sourceKeyA || en.repository) === String(o.sourceKeyB || sv.repository))

  return {
    entryId: en.id != null ? en.id : null,
    srvId: sv.id != null ? sv.id : null,
    codeHash,
    inputDigest: _text(o.inputDigest != null ? o.inputDigest
      : (en.name || en.scriptName || sv.name || ''), 200),
    cfg: {
      version: c.version != null ? c.version : null,
      promptVersion: c.promptVersion != null ? c.promptVersion : null,
      mode: c.mode != null ? c.mode : null
    },
    ledger: {
      hash: ledger.hash != null ? ledger.hash : (o.ledgerHash != null ? o.ledgerHash : null),
      lxId: ledger.lxId != null ? ledger.lxId : (o.lxId != null ? o.lxId : null),
      foreign: !!(ledger.foreign != null ? ledger.foreign : o.foreign)
    },
    profile: { local: _profile(local), server: _profile(server) },
    platformOverlap: overlap.length ? overlap : [],
    version: {
      local: localVer,
      srv: srvVer,
      comparable: _versionComparable(localVer, srvVer)
    },
    sameSourceKey: !!sameSourceKey,
    status: en.status != null ? en.status : null,
    scored: !!metrics.depth && metrics.depth === 'full' && (_num(metrics.samples) || 0) > 0
  }
}

/**
 * 证据分区。HARD 要零容忍：证据不全/不可比一律退回 GREY。
 * @returns {{zone:'HARD'|'GREY',codes:string[],danger:'D0'|'D1'}}
 */
function evidenceClass(snap, ruleAct) {
  const s = snap || {}
  const danger = ruleAct === 'replace' ? 'D1' : 'D0'
  const p = s.profile || {}
  const L = p.local || {}, R = p.server || {}
  const v = s.version || {}
  const led = s.ledger || {}
  const codes = []

  // 先决条件：任一侧只有声明值 / 未打分，或版本不可比 → 证据不足，只能 GREY。
  const declared = L.declared === true || R.declared === true
  const unscored = L.scored === false || R.scored === false
  const incomparable = v.comparable !== true
  const hasHash = !!(led.hash)
  const sameHash = hasHash && led.hash === s.codeHash
  const diffHash = hasHash && s.codeHash && led.hash !== s.codeHash
  const samePlatforms = Array.isArray(s.platformOverlap) && s.platformOverlap.length > 0
  const p50Gap = (L.p50 != null && R.p50 != null) ? Math.abs(L.p50 - R.p50) : 0

  const hard = []
  if (sameHash) hard.push('H1')                                  // 账本 hash 相同且内容未变
  if (diffHash && led.foreign === false) hard.push('H2')         // 账本 hash 不同且非外来条目
  if (L.usable === 0) hard.push('H3')                            // 本地 0 可用平台
  if (L.scored && R.scored && !declared && (p50Gap >= 300 || !samePlatforms)) hard.push('H5')
  if (v.comparable === true) hard.push('H6')                     // 版本可直接比较

  if (!declared && !unscored && !incomparable && hard.length) {
    return { zone: 'HARD', codes: hard, danger }
  }

  // GREY：按缺失证据记 G 码；宁可 GREY 也不误判 HARD。
  const grey = []
  if (declared) grey.push('G1')
  if (unscored) grey.push('G2')
  if (!hard.length) grey.push('G3')
  if (incomparable) grey.push('G4')
  if (!s.sameSourceKey) grey.push('G5')
  return { zone: 'GREY', codes: grey.length ? grey : ['G3'], danger }
}

/** 造一条 aiEvalLog（不落库，由调用方决定写哪里）。 */
function makeEvalLog(fields) {
  const f = fields || {}
  return Object.assign({
    id: 'eval_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    ts: Date.now(),
    phase: 'replay',
    batch: null,
    entryId: null,
    srvId: null,
    zone: null,
    zoneCodes: [],
    danger: 'D0',
    ruleAct: null,
    ruleWhy: null,
    aiAct: null,
    aiWhy: null,
    goldAct: null,
    gate: null,
    executed: false,
    auditId: null,
    undoed: false,
    outcome: null
  }, f)
}

module.exports = { buildEvalSnapshot, evidenceClass, makeEvalLog }
