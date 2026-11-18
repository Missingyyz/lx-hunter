'use strict'
/**
 * 隔离区信任三档 + AI 建议「重要才显示」门槛（v1.10.9）。
 *
 * 覆盖：
 *  ① selfSched 三字段分类（timer / decode / unknown）+ 三字段和 == 原总数
 *  ② obfuscationRisk.level 全等回归（不能影响 high 判级）
 *  ③ classifyQuarantineTrust 6 条真实数据落档 + block 边界 + 各档互斥
 *  ④ worthNotifying 口径（26 条真实数据：只剩 2 条重要）+ 边界
 *  ⑤ 三处副本已收敛（静态断言）
 *  ⑥ R6 对接走 spec 而非直传 systemPrompt/text
 *  ⑦ UI 文案无黑话残留
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('PASS ' + msg) } else { fail++; console.log('FAIL ' + msg) } }

const checker = require('../src/core/checker')
const { obfuscationRisk, classifyQuarantineTrust, usableCount } = checker
const { worthNotifying } = require('../src/core/aiReview')
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
const hunterSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'hunter.js'), 'utf8')
const checkerSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'checker.js'), 'utf8')
const viewSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'sourceView.js'), 'utf8')

// ---------- ① selfSched 三字段 ----------
console.log('\n=== ① selfSched 三字段分类 ===')
const pad = '\n' + 'var p' + 'x'.repeat(280) + '=1;'
const cls = code => {
  const h = obfuscationRisk(code + pad).hits || {}
  return { t: h.selfSchedTimer, d: h.selfSchedDecode, u: h.selfSchedUnknown, total: h.selfSchedCalls }
}
let r = cls('var a=_0x1a2b(_0x3c4d,0x7d0);')
ok(r.t === 1 && r.d === 0 && r.u === 0 && r.total === 1, '0x7d0(2000ms) → timer 1')
r = cls('var a=_0x1a2b(_0x3c4d,0xd83d);')
ok(r.d === 1 && r.t === 0 && r.total === 1, '0xd83d(surrogate) → decode 1')
r = cls('var a=_0x1a2b(_0x3c4d,0xdfff);')
ok(r.d === 1 && r.t === 0, '0xdfff(代理区上界) → decode')
r = cls('var a=_0x1a2b(_0x3c4d,0xd800);')
ok(r.d === 1, '0xd800(代理区下界) → decode')
// 原正则要求第二参数至少 3 位十六进制（0x[0-9a-f]{3,5}），因此 100ms 以下不存在可达的 3 位值，
// 2 位写法（如 0x64/0xff）根本不被这个正则匹配——这也是原始计数的既有行为，本次未动。
r = cls('var a=_0x1a2b(_0x3c4d,0x64e);')
ok(r.t === 1, '0x64e(1614ms) → timer')
r = cls('var a=_0x1a2b(_0x3c4d,0x493e1);')
ok(r.u === 1, '0x493e1(300001ms 超上界) → unknown')
r = cls('var a=_0x1a2b(_0x3c4d,0x64);')
ok(r.t === 0 && r.u === 0 && r.total === 0, '2 位参数 0x64 不被正则匹配（既有下限，未改）')
// 三字段和恒等于原总数
let sumBad = 0
const frags = ['var a=_0x1a2b(_0x3c4d,0x7d0);', 'var b=_0x1a2b(_0x3c4d,0xd800);',
  'var c=_0x1a2b(_0x3c4d,0x493e1);', 'var d=_0x1a2b(_0x3c4d,0x63);', 'while(!![]){}', 'eval("x")']
for (let i = 0; i < 200; i++) {
  let code = ''
  const n = 1 + (i % 7)
  for (let k = 0; k < n; k++) code += frags[(i * 31 + k * 17) % frags.length] + ';'
  code += pad
  const h = obfuscationRisk(code).hits || {}
  if ((h.selfSchedTimer || 0) + (h.selfSchedDecode || 0) + (h.selfSchedUnknown || 0) !== (h.selfSchedCalls || 0)) sumBad++
}
ok(sumBad === 0, '200 组合样本：selfSchedTimer+Decode+Unknown 恒等于 selfSchedCalls')

// ---------- ② level 全等回归 ----------
console.log('\n=== ② obfuscationRisk.level 全等回归（不许影响 high 判级）===')
function oldImpl(t0) {
  const t = String(t0 || '')
  if (!t || t.length < 200) return { level: '', hits: null }
  const kb = t.length / 1024
  const count = re => (t.match(re) || []).length
  const n0x = count(/_0x[0-9a-f]{4,6}/gi)
  const nUni = count(/\\u[0-9a-fA-F]{4}/g)
  const nExotic = count(/[\u0600-\u06FF\uFB50-\uFEFF]/g)
  const nEval = count(/\beval\s*\(|new\s+Function\s*\(/g)
  const nSpin = count(/while\s*\(\s*(?:!!\s*\[\s*\]|!0x0|!0|true)\s*\)\s*\{\s*\}/g)
  const nSelf = count(/_0x[0-9a-f]{4,6}\s*(?:\[[^\]\r\n]{1,80}\])?\s*\(\s*_0x[0-9a-f]{4,6}\s*,\s*0x[0-9a-f]{3,5}\s*\)/gi)
  const nJs = count(/jsjiami/gi)
  const hits = {
    perKb0x: n0x / kb, perKbUni: nUni / kb, perKbExotic: nExotic / kb,
    evalCalls: nEval, total0x: n0x, totalUni: nUni, totalExotic: nExotic,
    spinLoops: nSpin, selfSchedCalls: nSelf, jsjiamiMarks: nJs
  }
  if (nSpin >= 1 || nSelf >= 1) return { level: 'high', hits }
  if (hits.perKb0x >= 20 || hits.perKbUni >= 8 || hits.perKbExotic >= 20) return { level: 'high', hits }
  if (nJs >= 1 && (hits.perKb0x >= 2 || hits.perKbUni >= 1 || hits.perKbExotic >= 2)) return { level: 'high', hits }
  if (hits.perKb0x >= 2 || hits.perKbUni >= 1 || hits.perKbExotic >= 2) return { level: 'mid', hits }
  return { level: '', hits }
}
let lvDiff = 0, hitDiff = 0, checked = 0
const lvDist = {}
const genFrags = ['', 'while(!![]){}', 'while(true){}', 'var a=_0x1a2b(_0x3c4d,0x7d0);',
  'var a=_0x1a2b(_0x3c4d,0xd800);', 'eval("x")', 'new Function("a")', 'jsjiami', 'var _0xaaaa=1;',
  '\\u4e2d', 'محمد', 'var a=_0x1a2b["x"](_0x3c4d,0xd83d);']
for (let i = 0; i < 400; i++) {
  const seed = (i * 2654435761) % 4294967296
  let code = ''
  for (let k = 0; k < 1 + (seed % 7); k++) code += genFrags[(seed >>> (k * 3)) % genFrags.length] + ';'
  code += '\n' + 'var _0xaaaa=1;'.repeat([0, 1, 5, 20, 60, 200][i % 6]) + 'x'.repeat(60)
  const a = oldImpl(code), b = obfuscationRisk(code)
  checked++
  const l = (a.level || '(空)')
  lvDist[l] = (lvDist[l] || 0) + 1
  if (a.level !== b.level) lvDiff++
  if (a.hits && b.hits) for (const k of Object.keys(a.hits)) if (a.hits[k] !== b.hits[k]) { hitDiff++; break }
}
ok(checked === 400 && lvDiff === 0, `400 样本 level 与旧实现完全一致（不一致 ${lvDiff}）`)
ok(hitDiff === 0, '400 样本旧 hits 字段值完全一致（新增三字段不影响老字段）')
ok(lvDist['high'] > 100, `回归样本覆盖 high 分支（${JSON.stringify(lvDist)}）`)
ok(/if \(nSpin >= 1 \|\| nSelfSched >= 1\) \{\s*\n\s*return \{ level: 'high', hits \}/.test(checkerSrc), 'high 判级原文逐字未变（仍含 nSelfSched）')

// ---------- ③ classifyQuarantineTrust 6 条真实数据 ----------
console.log('\n=== ③ classifyQuarantineTrust 6 条真实数据落档 ===')
const cfg = { trustedObfDomains: [] }
const mkEntry = (name, hits, deep) => ({ id: name, lxName: name, obfHits: hits, deep: deep || null, obfDomains: [], apiHosts: [] })
const six = [
  [mkEntry('lx-source-v8.16.0', { spinLoops: 0, selfSchedCalls: 0, evalCalls: 0, total0x: 0 }), 'allow'],
  [mkEntry('lx-source-v8.16.4', { spinLoops: 0, selfSchedCalls: 0, evalCalls: 0, total0x: 0 }), 'allow'],
  [mkEntry('墨澜音乐源v2.3.4', { spinLoops: 0, selfSchedCalls: 14, selfSchedTimer: 8, selfSchedDecode: 6, evalCalls: 0, total0x: 6003 }), 'risky'],
  [mkEntry('洛雪音乐源', { spinLoops: 1, selfSchedCalls: 1, selfSchedTimer: 1, evalCalls: 0 },
    { checkedAt: 1, loadable: true, platforms: { a: { status: 'usable' }, b: { status: 'failed' }, c: { status: 'failed' }, d: { status: 'failed' }, e: { status: 'failed' } } }), 'risky'],
  [mkEntry('六音1.2.1', { spinLoops: 0, selfSchedCalls: 0, evalCalls: 1, total0x: 16316 }), 'risky'],
  [mkEntry('洛雪音乐源(此版有bug)', { spinLoops: 1, selfSchedCalls: 47, selfSchedTimer: 47, evalCalls: 0, total0x: 2164 }), 'block']
]
let sixBad = 0
for (const [e, exp] of six) {
  const got = classifyQuarantineTrust(e, cfg).level
  if (got !== exp) { sixBad++; console.log('  BAD ' + e.id + ' → ' + got + '（期望 ' + exp + '）') }
}
ok(sixBad === 0, '6 条真实数据落档全对（2 allow / 3 risky / 1 block）')
ok(six.filter(([e]) => classifyQuarantineTrust(e, cfg).level !== 'block').length === 5, '6 条里只有 1 条落 block（洛雪bug版）')

console.log('\n=== ③b 边界与互斥 ===')
const bc = [
  ['空转+零实测+从未检测 → block', { obfHits: { spinLoops: 1 }, deep: null }, 'block'],
  ['空转+零实测+可疑域≥4 → block', { obfHits: { spinLoops: 1 }, deep: { checkedAt: 1, platforms: {} }, obfDomains: ['a.cc', 'b.cc', 'c.cc', 'd.cc'] }, 'block'],
  ['空转+实测可用1 → risky（永不吃 block）', { obfHits: { spinLoops: 1 }, deep: { checkedAt: 1, platforms: { a: { status: 'usable' } } } }, 'risky'],
  ['空转+测过但0可用+无可疑域 → risky', { obfHits: { spinLoops: 1 }, deep: { checkedAt: 1, platforms: { a: { status: 'failed' } } } }, 'risky'],
  ['eval+实测可用1 → risky（eval 专属上限）', { obfHits: { evalCalls: 1 }, deep: { checkedAt: 1, platforms: { a: { status: 'usable' } } } }, 'risky'],
  ['eval+零实测 → risky（不是 block）', { obfHits: { evalCalls: 1 }, deep: null }, 'risky'],
  ['全零 → allow', { obfHits: { spinLoops: 0, evalCalls: 0, selfSchedCalls: 0 } }, 'allow'],
  ['无 obfHits → allow', {}, 'allow'],
  ['定时器47无空转 → risky', { obfHits: { selfSchedTimer: 47, selfSchedCalls: 47 } }, 'risky']
]
let bcBad = 0
for (const [d, e, exp] of bc) {
  const got = classifyQuarantineTrust(e, cfg).level
  if (got !== exp) { bcBad++; console.log('  BAD ' + d + ' → ' + got) }
}
ok(bcBad === 0, '9 条边界用例全对（含 eval 永不进 allow、空转+可用永不吃 block）')
// 互斥：返回值只可能是三档之一，且 allow 的 reasons 必为空
let exclBad = 0
for (const [e] of six) {
  const c = classifyQuarantineTrust(e, cfg)
  if (['allow', 'risky', 'block'].indexOf(c.level) === -1) exclBad++
  if (c.level === 'allow' && c.reasons.length) exclBad++
  if (c.level !== 'allow' && !Array.isArray(c.reasons)) exclBad++
}
ok(exclBad === 0, '三档互斥：level 取值合法，allow 无 reasons、非 allow 必有 reasons 数组')
// 老数据回退
const legacy = classifyQuarantineTrust({ obfHits: { selfSchedCalls: 5 } }, cfg)
ok(legacy.level === 'risky' && legacy.evidence.schedTimer === 5, '老数据无细分字段时回退 selfSchedCalls')

// ---------- ④ worthNotifying ----------
console.log('\n=== ④ worthNotifying：26 条真实数据只剩 2 条重要 ===')
const sug = (kind, verdict, conclusion, evidence) => ({ kind, conclusion, eval: verdict ? { verdict } : undefined, evidence })
const real = []
for (let i = 0; i < 14; i++) real.push(sug('R2', null, '保留服务端更优版本：服务端 5 个平台 > 本地 3 个'))
for (let i = 0; i < 4; i++) real.push(sug('R3', null, '命名未见明显异常（本地规则提示，仅供参考）', [{ key: 'nameHeuristic', ok: false }]))
real.push(sug('R3', null, '混杂多种特殊同形字符伪装英文，疑似乱码混淆命名。', [{ key: 'nameHeuristic', ok: true }]))
real.push(sug('R3', null, '含"二改整合版"，明显是二次修改/整合的衍生版本，有多版本副本嫌疑。', [{ key: 'nameHeuristic', ok: true }]))
for (let i = 0; i < 3; i++) real.push(sug('R5', 'source', '拿不准，按从宽处理 source'))
for (let i = 0; i < 3; i++) real.push(sug('R7', 'keep', '状态为ok，无错误或连续失效记录；缺乏有害或长期失效证据。'))
const worth = real.filter(worthNotifying)
ok(real.length === 26, '构造了 26 条（与 8197 实测一致）')
ok(worth.length === 2, `26 条里只有 ${worth.length} 条值得提醒（期望 2）`)
ok(worth.every(s => s.kind === 'R3'), '2 条都是 R3 命名异常')
ok(real.filter(s => s.kind === 'R2' && worthNotifying(s)).length === 0, 'R2 全部降级为日志（0 条进界面）')

console.log('\n=== ④b 门槛口径全组合 ===')
const combo = [
  ['R7 blacklist → 提醒', sug('R7', 'blacklist', '多条失效证据'), true],
  ['R7 keep → 不提醒', sug('R7', 'keep', '保留'), false],
  ['R5 nonSource → 提醒', sug('R5', 'nonSource', '不是音源脚本'), true],
  ['R5 source → 不提醒', sug('R5', 'source', '按从宽处理'), false],
  ['R4 follow → 提醒', sug('R4', 'follow', '有实质修复'), true],
  ['R4 ignore → 不提醒', sug('R4', 'ignore', '只是催更'), false],
  ['R6 reject → 提醒', sug('R6', 'reject', '有硬特征'), true],
  ['R6 trust → 提醒', sug('R6', 'trust', '干净'), true],
  ['R2 任意 → 不提醒', sug('R2', null, '保留服务端更优版本'), false],
  ['R1 → 不提醒', sug('R1', null, '连接超时 5'), false],
  ['R3 未知 kind → 不提醒', sug('R9', null, '啥'), false],
  ['R3 无 evidence 且说"未见异常" → 不提醒', sug('R3', null, '命名未见明显异常'), false],
  ['R3 无 evidence 且说"重复副本" → 提醒', sug('R3', null, '疑似重复副本'), true]
]
let comboBad = 0
for (const [d, s, exp] of combo) { const g = worthNotifying(s); if (g !== exp) { comboBad++; console.log('  BAD ' + d + ' → ' + g) } }
ok(comboBad === 0, '13 条门槛边界全对')

// ---------- ⑤ 三处副本已收敛 ----------
console.log('\n=== ⑤ 判据单一来源（三处副本已清零）===')
ok(appSrc.indexOf('function qzHardHits') === -1, '前端 qzHardHits 副本已删除')
ok(!/const hardHit = \(hh\.spinLoops/.test(hunterSrc), 'applyObfGate 的 hardHit 副本已删除')
ok(!/const hard = \(hits\.spinLoops/.test(hunterSrc), 'trustObfSource 的 hard 副本已删除')
ok(/classifyQuarantineTrust/.test(hunterSrc), 'hunter.js 改调 classifyQuarantineTrust')
ok(typeof classifyQuarantineTrust === 'function', 'checker.js 已导出 classifyQuarantineTrust')
ok(/classifyQuarantineTrust/.test(viewSrc), 'sourceView.js 用同一函数算 qzLevel 下发给前端')

// ---------- ⑥ R6 走 spec ----------
console.log('\n=== ⑥ R6 对接走 v2 spec ===')
const r6Call = appSrc.slice(appSrc.indexOf("kind: 'R6'"), appSrc.indexOf("kind: 'R6'") + 900)
ok(r6Call.indexOf('systemPrompt:') === -1, 'R6 调用不再直传 systemPrompt（否则会绕过 spec）')
ok(r6Call.indexOf('text:') === -1, 'R6 调用不再直传 text（否则 buildText 失效）')
ok(/entries:\s*\[/.test(r6Call), 'R6 改传 entries 数组 → 走 spec.system / spec.buildText')
ok(/repository:\s*src\.repo/.test(r6Call), 'R6 传 repository（字段名与 spec 一致，不是 repo）')
ok(/apiHosts:/.test(r6Call), 'R6 传 apiHosts（域名并集规则需要）')
ok(/obfHits:\s*src\.obfHits/.test(r6Call), 'R6 传 obfHits 对象（不是中文串）')
ok(/validTier:/.test(r6Call), 'R6 传 validTier（门槛①判定层级）')

// ---------- ⑦ UI 文案无黑话 ----------
console.log('\n=== ⑦ UI 文案无黑话残留 ===')
// 只看 obfTipUi 的函数体（注释与 obfTipLog 里的技术原文是允许的）。
// 注意 indexOf('function obfTipUi') 会命中 JSDoc 里的反引号引用，必须找真正的定义行。
const uiStart = appSrc.indexOf('\nfunction obfTipUi(')
const uiEnd = appSrc.indexOf('\nfunction obfTipLog(')
const uiBody = uiStart >= 0 && uiEnd > uiStart ? appSrc.slice(uiStart, uiEnd) : ''
ok(uiBody.length > 100, '能定位到 obfTipUi 函数体')
// 断言检查的是**输出给人看的字符串**，不是字段名（h.selfSchedTimer 这种代码标识符不算黑话）。
// 取函数体里所有字符串字面量，逐条检查。
const uiStrings = (uiBody.match(/'[^']*'|`[^`]*`/g) || []).join(' ')
ok(!/while\(!!\[\]\)/.test(uiStrings) && !/_0x/.test(uiStrings) && !/selfSched/.test(uiStrings) &&
  !/setTimeout|setInterval/.test(uiStrings), 'obfTipUi 输出的文案不含 while(!![])/_0x/selfSched/setTimeout 等黑话')
ok(/定时器调用/.test(uiStrings) && /CPU 空转/.test(uiStrings), 'obfTipUi 用「定时器调用」「CPU 空转」等大白话')
ok(/function obfTipLog/.test(appSrc) && appSrc.indexOf('空转死循环 while(!![]){}') !== -1, '日志侧 obfTipLog 保留技术原文')
ok(/名称检查/.test(appSrc) && /判断来源/.test(appSrc), 'evidence 内部键名已翻译（名称检查/判断来源）')
ok(/本地规则（AI 没参与）/.test(appSrc), 'local-fallback 已翻译')
ok(!/<span class="muted">建议动作：/.test(appSrc) && !/证据（' \+ n/.test(appSrc), '浮层不再用「建议动作」「证据（N）」字样')
ok(htmlSrc.indexOf('不可信任') === -1, '隔离区说明不再有「不可信任」一刀切表述')
ok(/有风险，不建议放行/.test(appSrc) && /仍要信任…/.test(appSrc) && /信任放行/.test(appSrc), '隔离区三档按钮文案齐全')
ok(!/disabled title="命中反调试/.test(appSrc), '隔离区不再有 disabled 灰死按钮')
ok(/需要你留意/.test(htmlSrc) && /id="aiSummaryCard"/.test(htmlSrc), 'AI 页有「需要你留意」统计卡')
ok(/只看有 AI 提醒的/.test(htmlSrc), '音源库有「只看有 AI 提醒的」筛选器')
ok(/AI_ACTIONABLE_VERDICT/.test(appSrc), 'chip 浮层按 verdict 白名单决定是否给执行按钮')

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}（${pass + fail} 项，失败 ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
