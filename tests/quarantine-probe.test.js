'use strict'
/**
 * 隔离区「试跑一次」（v1.13.12）回归测试
 *
 * ============================================================================
 * 这个功能解决什么，以及为什么测试要写成这样
 * ============================================================================
 * 死锁：混淆闸门把高危脚本移入隔离区后 `continue` 跳过深检；而 R6 判 trust 的硬门槛是
 * 「深检可用平台 >= 1」；深检又只在 `status === 'ok'` 时触发。于是
 * 「要信任 → 需 R6 判 trust → 需有实测 → 需先信任」永久成环，等于要求用户先信任再验证。
 *
 * 拆环手段是给隔离区加「试跑一次」：只实测、不信任。但这**只要漏一处隔离**，就会造出
 * 比死锁更糟的东西——自动放行：
 *
 *    试跑一次 → deep 落库 → applyObfGate 看到「有 deep + allow 档 + 域名干净」
 *             → 自动写入 trustedObfHashes → 永久放行（用户全程没确认）
 *
 * 所以本文件的重点不是「试跑能跑通」，而是**试跑之后什么东西没变**：
 *   - trustedObfHashes 长度不变（最直接的不变量）
 *   - status / quarantined / usable / obfTrusted 不变
 *   - 档位判定（classifyQuarantineTrust）不被试跑结果影响
 *   - 自动信任路径不认试跑的 deep
 *
 * 用例统计：无第三方依赖，手写 pass/fail（与 quarantine-trust-tier.test.js 同风格）。
 *
 * 用法：node tests/quarantine-probe.test.js   （退出码 0 = 全过）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const checker = require(path.join(ROOT, 'src', 'core', 'checker.js'))
const { classifyQuarantineTrust, isProbeOnlyDeep, usableCount, obfuscationRisk, obfDomainVerdict } = checker
const { Store } = require(path.join(ROOT, 'src', 'core', 'store.js'))
const { Hunter } = require(path.join(ROOT, 'src', 'core', 'hunter.js'))
const { deepSummaryText } = (() => {
  // deepSummaryText 未导出，用 vm 从源码里取（与 quarantine-trust-tier.test.js 的取法一致）
  const vm = require('vm')
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'aiReview.js'), 'utf8')
  const m = src.match(/function deepSummaryText[\s\S]*?\n}\n/)
  if (!m) return { deepSummaryText: null }
  const sandbox = { module: { exports: {} }, require, console }
  vm.createContext(sandbox)
  vm.runInContext(m[0] + '\nmodule.exports.deepSummaryText = deepSummaryText;', sandbox)
  return sandbox.module.exports
})()

let pass = 0
let fail = 0
const failures = []
function ok (cond, msg, extra) {
  if (cond) { pass++; console.log('PASS ' + msg) } else {
    fail++
    const line = msg + (extra != null ? '  :: ' + extra : '')
    failures.push(line)
    console.log('FAIL ' + line)
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
/** 造一段稳定的重度混淆代码（纯密度型，无空转/eval 等硬特征）
 *  密度口径与被测实现一致：每行 8 个 _0x 标识符，60 行 ≈ 80 个/KB，稳过 20/KB 的 high 阈值。
 *  （第一版写成「一行一个 var」密度不够，risk.level 为空，导致下游断言全部失效。） */
function denseObfCode (lines) {
  const parts = []
  for (let i = 0; i < (lines || 60); i++) {
    const row = []
    for (let j = 0; j < 8; j++) row.push('_0x' + (0x1000 + i * 8 + j).toString(16) + '=1')
    parts.push(row.join(','))
  }
  return parts.join(';\n') + ';\n'
}

function sha256Str (s) { return require('crypto').createHash('sha256').update(String(s)).digest('hex') }

function mkStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-probe-'))
  const s = new Store(dir)
  // DEFAULT_CONFIG 是浅拷贝，数组字面量会跨 Store 共享；必须显式重置，
  // 否则上一个用例写入的 trustedObfHashes 会串到下一个用例（tests/obf-auto-trust.test.js 同款处理）。
  s.config.trustedObfHashes = []
  s.config.trustedObfDomains = []
  s.config.excludeHighRiskObfuscated = true
  s.config.autoTrustCleanObf = true
  return s
}

/** 造一条「已被混淆闸门隔离」的条目 */
function mkQuarantinedEntry (id, code, deep) {
  const e = {
    id,
    lxName: id,
    scriptName: id,
    name: id,
    code,
    contentHash: sha256Str(code),
    status: 'quarantined',
    quarantined: true,
    usable: false,
    obfLevel: 'high',
    obfHits: {},
    obfDomains: [],
    apiHosts: [],
    error: '混淆隔离：重度混淆脚本，已移入「混淆隔离」区，可在该页信任后放行',
    deep: deep || null
  }
  return e
}

// ===========================================================================
// ① isProbeOnlyDeep 判据本身
// ===========================================================================
console.log('\n=== ① isProbeOnlyDeep 判据 ===')
;(() => {
  ok(isProbeOnlyDeep({ deep: { checkedAt: 1, probeOnly: true } }) === true, 'probeOnly:true 的 deep 被识别为试跑产出')
  ok(isProbeOnlyDeep({ deep: { checkedAt: 1 } }) === false, '常规 deep（无 probeOnly）不被误判')
  ok(isProbeOnlyDeep({ deep: { checkedAt: 1, probeOnly: false } }) === false, 'probeOnly:false 不算试跑产出')
  ok(isProbeOnlyDeep({}) === false, '没有 deep 不算试跑产出')
  ok(isProbeOnlyDeep({ deep: null }) === false, 'deep 为 null 不算试跑产出')
  // 必须严格等于 true，不能用真值判断：否则 'false' 字符串之类会被误判。
  // 但"静默返回 false"不够——非布尔值会让试跑结果偷偷变成正式证据（自动化路径全部把它当合法 deep），
  // 所以要直接抛错，让写错的地方第一次跑就炸。这里断言它抛，而不是断言它返回 false。
  let threw = false
  try { isProbeOnlyDeep({ deep: { probeOnly: 'true' } }) } catch (e) { threw = /必须是布尔/.test(e.message) }
  ok(threw, 'probeOnly 用字符串 "true" 必须抛错（否则试跑结果会被当成正式证据）')
  threw = false
  try { isProbeOnlyDeep({ deep: { probeOnly: 1 } }) } catch (e) { threw = /必须是布尔/.test(e.message) }
  ok(threw, 'probeOnly 用数字 1 必须抛错')
})()

// ===========================================================================
// ② 档位判定不被试跑 deep 污染（checker.js 数据层隔离）
// ===========================================================================
console.log('\n=== ② 档位判定（classifyQuarantineTrust）不受试跑影响 ===')
;(() => {
  const cfg = { trustedObfDomains: [] }
  // 带空转特征 + 从未实测 → block 档（唯一 block 入口：spin>=1 && usableN==0 && (!deepDone || suspect>=4)）
  const blockHits = { spinLoops: 1, evalCalls: 0, selfSchedTimer: 1 }

  const noDeep = { id: 'a', obfHits: blockHits, obfDomains: [], apiHosts: [], deep: null }
  const lvNoDeep = classifyQuarantineTrust(noDeep, cfg).level
  ok(lvNoDeep === 'block', '前提：有空转特征且从未实测 → block 档', 'lv=' + lvNoDeep)

  // 同样的条目，试跑出一份「2 个平台可用」的结果
  const probedDeep = {
    checkedAt: Date.now(),
    probeOnly: true,
    loadable: true,
    platforms: { wy: { status: 'usable' }, tx: { status: 'usable' } }
  }
  const withProbe = Object.assign({}, noDeep, { deep: probedDeep })
  const lvProbe = classifyQuarantineTrust(withProbe, cfg)
  ok(lvProbe.level === 'block',
    '【核心】试跑出 2 个可用平台后档位仍是 block（否则 block→risky 会自动降级）',
    'lv=' + lvProbe.level)
  ok(lvProbe.evidence && lvProbe.evidence.deepDone === false,
    '试跑 deep 在档位判定里被视为「没有实测」（evidence.deepDone=false）',
    'deepDone=' + (lvProbe.evidence && lvProbe.evidence.deepDone))
  ok(lvProbe.evidence && lvProbe.evidence.usableN === 0,
    '试跑 deep 的可用平台数不计入 usableN（保持 0）',
    'usableN=' + (lvProbe.evidence && lvProbe.evidence.usableN))

  // 对照：同样的 deep 去掉 probeOnly 标记 → 档位必须真的降级（证明上面不是恒真断言）
  const realDeep = Object.assign({}, probedDeep)
  delete realDeep.probeOnly
  const withReal = Object.assign({}, noDeep, { deep: realDeep })
  const lvReal = classifyQuarantineTrust(withReal, cfg)
  ok(lvReal.level !== 'block',
    '【对照有效性】正式深检出可用平台后档位确实会变（证明上面的断言不是恒真）',
    '正式 deep 档位=' + lvReal.level)
  ok(lvReal.evidence && lvReal.evidence.usableN === 2,
    '【对照】正式 deep 的 usableN 正常计入 2',
    'usableN=' + (lvReal.evidence && lvReal.evidence.usableN))
})()

// ===========================================================================
// ③ 自动信任路径不认试跑的 deep（hunter.applyObfGate 数据层隔离）
// ===========================================================================
console.log('\n=== ③ 试跑不会触发自动信任（applyObfGate） ===')
;(() => {
  const store = mkStore()
  const h = new Hunter(store, () => {})
  const code = denseObfCode()
  const risk = obfuscationRisk(code)
  ok(risk.level === 'high', '前提：夹具代码确实被判 high（否则测不到隔离路径）', 'level=' + risk.level)
  const hh = risk.hits || {}
  ok(!hh.spinLoops && !hh.evalCalls && !hh.selfSchedTimer,
    '前提：夹具是纯密度型（无空转/eval/自调度硬特征，落在 allow 档）',
    JSON.stringify(hh))

  // 情形 A：正式 deep（带可用平台 + 干净域名）→ 应该自动信任（证明自动信任本身是活的）
  {
    const st = mkStore()
    const hh2 = new Hunter(st, () => {})
    const e = mkQuarantinedEntry('real-deep', code, {
      checkedAt: Date.now(),
      loadable: true,
      platforms: { wy: { status: 'usable', url: 'https://music.163.com/x' } }
    })
    e.obfHits = risk.hits
    const before = st.config.trustedObfHashes.length
    hh2.applyObfGate([e], x => x.code, '灌入前')
    ok(st.config.trustedObfHashes.length === before + 1,
      '【对照有效性】正式 deep + allow 档 + 干净域名 → 自动信任确实会写 trustedObfHashes（路径是活的）',
      'before=' + before + ' after=' + st.config.trustedObfHashes.length)
  }

  // 情形 B：完全相同的条目，只把 deep 标成 probeOnly → 绝不能自动信任
  {
    const st = mkStore()
    const hh2 = new Hunter(st, () => {})
    const e = mkQuarantinedEntry('probe-deep', code, {
      checkedAt: Date.now(),
      probeOnly: true,
      loadable: true,
      platforms: { wy: { status: 'usable', url: 'https://music.163.com/x' } }
    })
    e.obfHits = risk.hits
    const before = st.config.trustedObfHashes.length
    hh2.applyObfGate([e], x => x.code, '灌入前')
    ok(st.config.trustedObfHashes.length === before,
      '【核心不变量】试跑的 deep 不会让 trustedObfHashes 增长（用户没确认过，绝不能自动放行）',
      'before=' + before + ' after=' + st.config.trustedObfHashes.length)
    ok(!e.obfTrusted, '试跑后条目没有被标成已信任（obfTrusted 不为真）', 'obfTrusted=' + e.obfTrusted)
    ok(e.quarantined === true && e.status === 'quarantined', '试跑后条目仍在隔离区', 'status=' + e.status)
  }

  // 情形 C：probeOnly 且没有任何可用平台（更贴近真实试跑失败）→ 同样不能信任
  {
    const st = mkStore()
    const hh2 = new Hunter(st, () => {})
    const e = mkQuarantinedEntry('probe-zero', code, {
      checkedAt: Date.now(),
      probeOnly: true,
      loadable: true,
      platforms: { wy: { status: 'failed' } }
    })
    e.obfHits = risk.hits
    hh2.applyObfGate([e], x => x.code, '灌入前')
    ok(st.config.trustedObfHashes.length === 0, '试跑 0 可用时同样不会写入 trustedObfHashes')
  }
})()

// ===========================================================================
// ④ probeQuarantined 本身的三条硬约束（真跑 deepCheck，但用不可达域名控制成本）
// ===========================================================================
console.log('\n=== ④ probeQuarantined：只实测、不改状态 ===')
;(async () => {
  const store = mkStore()
  const h = new Hunter(store, () => {})
  const code = denseObfCode()
  const e = mkQuarantinedEntry('probe-target', code, null)
  e.obfHits = obfuscationRisk(code).hits
  store.db.sources[e.id] = e

  const before = {
    trustHashes: store.config.trustedObfHashes.length,
    status: e.status,
    quarantined: e.quarantined,
    usable: e.usable,
    obfTrusted: e.obfTrusted
  }
  let summary = null
  let thrown = null
  try {
    // quickCheck 缩短时间；脚本里没有网络调用，deepCheck 会很快判完所有平台
    summary = await h.probeQuarantined(e.id, { confirmBlock: true })
  } catch (err) { thrown = err }

  ok(!thrown, 'probeQuarantined 能跑起来', thrown && String(thrown.message))
  if (summary) {
    ok(summary.probeOnly === true, '返回摘要标明 probeOnly（试跑产出）')
    ok(e.deep && e.deep.probeOnly === true, '落盘的 deep 带 probeOnly 标记')
    ok(e.deep && e.deep.probeAt > 0, '落盘的 deep 带 probeAt 时间戳（便于 UI 说明"什么时候试跑的"）')
    ok(summary.stillQuarantined === true, '摘要明确告知条目仍在隔离区')
  }
  ok(store.config.trustedObfHashes.length === before.trustHashes,
    '【核心不变量】试跑后 trustedObfHashes 长度不变',
    'before=' + before.trustHashes + ' after=' + store.config.trustedObfHashes.length)
  ok(e.status === before.status, '试跑后 status 不变', 'status=' + e.status)
  ok(e.quarantined === before.quarantined, '试跑后 quarantined 不变', 'quarantined=' + e.quarantined)
  ok(e.usable === before.usable, '试跑后 usable 不变', 'usable=' + e.usable)
  ok(!e.obfTrusted, '试跑后 obfTrusted 仍为假')

  // 非隔离条目不允许试跑（避免变成第二个检测入口）
  const okEntry = Object.assign({}, e, { id: 'probe-nonqz', status: 'ok', quarantined: false })
  store.db.sources['probe-nonqz'] = okEntry
  let err2 = null
  try { await h.probeQuarantined('probe-nonqz', { confirmBlock: true }) } catch (err) { err2 = err }
  ok(!!err2 && /不在隔离区/.test(String(err2.message)), '非隔离条目调试跑会被拒绝（提示走常规检测）',
    err2 && String(err2.message))

  // 没有正文的条目：直接提示走检测，不要假装能试跑
  const noCode = mkQuarantinedEntry('probe-nocode', '', null)
  store.db.sources['probe-nocode'] = noCode
  let err3 = null
  try { await h.probeQuarantined('probe-nocode', { confirmBlock: true }) } catch (err) { err3 = err }
  ok(!!err3 && /没有本地脚本正文/.test(String(err3.message)), '没有正文的条目会明确提示（不静默失败）',
    err3 && String(err3.message))

  // ---- ⑤ block 档必须二次确认 ----
  console.log('\n=== ⑤ block 档二次确认 ===')
  const blockCode = denseObfCode() + '\nwhile(true){}\n'
  const be = mkQuarantinedEntry('probe-block', blockCode, null)
  be.obfHits = obfuscationRisk(blockCode).hits
  store.db.sources[be.id] = be
  const clsBlock = classifyQuarantineTrust(be, store.config)
  ok(clsBlock.level === 'block', '前提：夹具确实落在 block 档（有空转特征 + 未实测）', 'lv=' + clsBlock.level)

  let err4 = null
  try { await h.probeQuarantined(be.id, {}) } catch (err) { err4 = err }
  ok(!!err4 && err4.code === 'NEED_CONFIRM_BLOCK',
    '【核心】block 档不带 confirmBlock 直接试跑 → 抛 NEED_CONFIRM_BLOCK 要求二次确认',
    err4 && String(err4.code || err4.message))
  ok(!!err4 && Array.isArray(err4.qzReasons), '拒绝时带回风险清单（供 UI 说清为什么危险）')
  ok(store.config.trustedObfHashes.length === 0, '被二次确认拦下时没有产生任何信任副作用')

  // allow/risky 档不需要二次确认（上面 probe-target 已在不带 confirmBlock 的路径上验证过，
  // 这里再明确断言一次：allow 档传 confirmBlock:false 也能跑）
  {
    const st2 = mkStore()
    const h2 = new Hunter(st2, () => {})
    const ce = mkQuarantinedEntry('probe-allow', denseObfCode(), null)
    ce.obfHits = obfuscationRisk(ce.code).hits
    st2.db.sources[ce.id] = ce
    const lv = classifyQuarantineTrust(ce, st2.config).level
    ok(lv === 'allow', '前提：夹具落在 allow 档', 'lv=' + lv)
    let err5 = null
    try { await h2.probeQuarantined(ce.id, { confirmBlock: false }) } catch (err) { err5 = err }
    ok(!err5 || err5.code !== 'NEED_CONFIRM_BLOCK',
      'allow 档不带 confirmBlock 也能试跑（一次确认即可，不额外设卡）',
      err5 && String(err5.message))
  }

  // ---- ⑥ R6 看到的 deep 摘要必须标注"试跑、未信任" ----
  console.log('\n=== ⑥ R6 数据源标注（prompt 不改，只标注事实） ===')
  if (!deepSummaryText) {
    ok(false, '能从 aiReview.js 取到 deepSummaryText（测试自身需要同步）')
  } else {
    const probeDeep = { checkedAt: 1, probeOnly: true, loadable: true, platforms: { wy: { status: 'usable' }, tx: { status: 'failed' } } }
    const txt = deepSummaryText(probeDeep)
    ok(/试跑/.test(txt) && /未/.test(txt) || /尚未确认信任/.test(txt),
      '【核心】试跑 deep 的摘要里带「试跑 / 尚未确认信任」标注（防止 AI 结论被当成背书）',
      txt)
    ok(/平台数2 可用1 失败1/.test(txt), '摘要仍如实包含可用/失败数字（AI 仍能据此判断）', txt)
    const realDeep2 = { checkedAt: 1, loadable: true, platforms: { wy: { status: 'usable' } } }
    ok(!/试跑/.test(deepSummaryText(realDeep2)), '正式 deep 的摘要不带试跑标注（不污染正常路径）',
      deepSummaryText(realDeep2))
  }

  // ---- ⑦ 源码级约束：probeQuarantined 不许碰信任与去重 ----
  console.log('\n=== ⑦ 源码级约束（防止后人加回副作用） ===')
  const hunterSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'hunter.js'), 'utf8')
  const fnStart = hunterSrc.indexOf('async probeQuarantined(')
  ok(fnStart > 0, '在 hunter.js 中找到 probeQuarantined 实现')
  if (fnStart > 0) {
    // 取函数体：从函数起点到下一个同级方法（以两个空格缩进 + 方法名开头）
    const rest = hunterSrc.slice(fnStart)
    // 精确切到 return summary 之后的收尾大括号，避免把后面 trustObfSource 之类的代码带进来
    // （第一版按 8000 字切，宽到包含了别的函数，误判「改了 e.status」）。
    const endIdx = rest.indexOf('\n  }\n', rest.indexOf('return summary'))
    ok(endIdx > 0, '能精确定位 probeQuarantined 函数体边界（找不到说明测试切片需同步）')
    const body = endIdx > 0 ? rest.slice(0, endIdx) : rest.slice(0, 4000)
    ok(!/trustedObfHashes\s*\.\s*push/.test(body) && !/saveConfig\(\s*\{\s*trustedObfHashes/.test(body),
      '【核心】probeQuarantined 函数体内不写 trustedObfHashes')
    ok(!/\.dedupe\s*\(/.test(body), 'probeQuarantined 函数体内不调 dedupe()（试跑不参与去重裁决）')
    ok(/deep\.probeOnly\s*=\s*true/.test(body), 'probeQuarantined 确实写了 deep.probeOnly = true')
    ok(!/e\.status\s*=[^=]/.test(body), 'probeQuarantined 函数体内不改 e.status（只读判断可以）')
    ok(!/e\.usable\s*=[^=]/.test(body), 'probeQuarantined 函数体内不改 e.usable')
    ok(!/e\.obfTrusted\s*=[^=]/.test(body), 'probeQuarantined 函数体内不改 e.obfTrusted')
    ok(!/e\.quarantined\s*=[^=]/.test(body), 'probeQuarantined 函数体内不改 e.quarantined')
  }

  // 自动信任路径必须带 isProbeOnlyDeep 闸门
  ok(/autoTrustCleanObf[^\n]*isProbeOnlyDeep/.test(hunterSrc),
    '【核心】applyObfGate 的自动信任条件带 isProbeOnlyDeep 闸门（删掉它就会出现"试跑即放行"）')

  // ---- ⑧ IPC 层：串行 + 单轮上限 ----
  // v1.13.13：配额/串行逻辑从 main/index.js 抽到 core/probeQueue.js（Web 端也要用同一份），
  // 因此断言目标从「main 源码里有这段代码」改为「共享模块实现了它 + 两端都真的接上了」。
  // 这样断言更准：原来只查 main 源码，Web 端没接上也照样 PASS——A1 的坑正是这么漏掉的。
  console.log('\n=== ⑧ 单轮上限与串行（core/probeQueue，两端共用） ===')
  const { makeProbeQueue, PROBE_LIMIT_PER_ROUND: LIMIT } = require(path.join(ROOT, 'src', 'core', 'probeQueue.js'))
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
  const webSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
  const pqSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'probeQueue.js'), 'utf8')

  ok(LIMIT === 5, '单轮上限为 5 条（用户拍板）', String(LIMIT))
  ok(/达到上限/.test(pqSrc) && /10 分钟/.test(pqSrc), '超上限的提示写清了原因和恢复方式（大白话）')
  ok(/PROBE_ROUND_LIMIT/.test(pqSrc), '超上限带机器可读的错误码（前端据此提示，不靠猜文案）')
  ok(/const run = chain\.then\(/.test(pqSrc),
    '试跑串行：run 由链条派生，天然排队（不会并发开第二个沙箱）')
  ok(/chain = run\.then\(\(\) => \{\}, \(\) => \{\}\)/.test(pqSrc),
    '串行链条吞掉单个失败，避免一次失败卡死后续试跑')

  // 行为验证：真造一个队列，确认「超上限抛错」和「串行执行」不是空话
  {
    const q = makeProbeQueue({ limit: 2, windowMs: 60000, now: () => 1000 })
    const inflight = []
    let maxConcurrent = 0
    let cur = 0
    const mk = (v) => () => new Promise(resolve => {
      cur++; maxConcurrent = Math.max(maxConcurrent, cur)
      inflight.push(v)
      setTimeout(() => { cur--; resolve({ v }) }, 10)
    })
    const p1 = q.run(mk(1)); const p2 = q.run(mk(2))
    let thrown = null
    try { q.run(mk(3)) } catch (e) { thrown = e }
    ok(!!thrown && thrown.code === 'PROBE_ROUND_LIMIT',
      '【核心】第 3 条被拒且带 PROBE_ROUND_LIMIT（不是静默忽略）', thrown ? thrown.code : '未抛错')
    ok(thrown && thrown.limit === 2 && thrown.used === 2, '错误里带 limit/used，前端能显示进度',
      thrown ? 'limit=' + thrown.limit + ' used=' + thrown.used : 'n/a')
    await Promise.all([p1, p2])
    ok(maxConcurrent === 1, '两条并发提交时实际最多只有 1 个在跑（真的串行）', 'maxConcurrent=' + maxConcurrent)
    ok(inflight.length === 2, '被拒的那条没有偷偷跑起来', 'inflight=' + inflight.length)
  }

  // 两端都必须接上同一份队列——这是 A1 修复的核心断言
  ok(/makeProbeQueue/.test(mainSrc) && /probeQueue\.run\(/.test(mainSrc),
    '桌面 IPC 走共享队列（sources:probeQuarantined）')
  ok(/makeProbeQueue/.test(webSrc) && /probeQueue\.run\(/.test(webSrc),
    '【A1 修复】Web 路由也走共享队列（/api/sources/probe-quarantined）')
  ok(/\/api\/sources\/probe-quarantined/.test(webSrc), 'Web 端有试跑路由（原来完全没有，按钮点了必失败）')
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'web-bridge.js'), 'utf8')
  ok(/sourcesProbeQuarantined/.test(bridgeSrc),
    '【A1 修复】web-bridge 暴露 sourcesProbeQuarantined（否则前端调用 undefined）')

  // 渲染层：试跑与信任放行是两个独立按钮，block 档二次确认
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
  ok(/class="[^"]*qz-probe/.test(appSrc), '隔离区有独立的「试跑一次」按钮')
  ok(/qz-probe/.test(appSrc) && /qz-trust/.test(appSrc), '试跑按钮与信任按钮分开（不共用一个入口）')
  ok(/async function probeQuarantined/.test(appSrc), '渲染层有 probeQuarantined 处理函数')
  ok(/CPU 具体|空转|吃满/.test(appSrc), 'block 档二次确认文案用大白话解释了空转后果')
  const probeFnIdx = appSrc.indexOf('async function probeQuarantined')
  if (probeFnIdx > 0) {
    const seg = appSrc.slice(probeFnIdx, probeFnIdx + 4000)
    const confirms = (seg.match(/window\.confirm\(/g) || []).length
    ok(confirms >= 2, 'block 档至少两道确认（实测 confirm 调用数=' + confirms + '）', 'confirms=' + confirms)
  }

  // ---------------------------------------------------------------------------
  console.log('\n' + (fail === 0 ? '✓' : '✗') + ' quarantine-probe: PASS ' + pass + ' / FAIL ' + fail)
  if (fail) {
    console.log('\n失败项：')
    failures.forEach(f => console.log('  - ' + f))
  }
  process.exit(fail ? 1 : 0)
})().catch(e => {
  console.log('FATAL ' + (e && e.stack || e))
  process.exit(1)
})
