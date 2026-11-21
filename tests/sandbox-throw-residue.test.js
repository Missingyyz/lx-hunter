'use strict'
/**
 * 「重建后的 Error 是否残留宿主 realm 对象」回归测试
 *
 * ============================================================================
 * 这个文件测的是什么
 * ============================================================================
 * 功能体检组对宿主异常泄漏的修法方向是：宿主抛出的 Error 不再裸进沙箱，
 * 而是在宿主侧**重建**一个沙箱 realm 的 Error 给脚本。
 *
 * 这条修法有一个典型的「堵了一个口、又开一个口」风险：
 * **重建时把宿主对象塞进了自定义属性**。
 *
 *     const e = new Error(msg)      // 沙箱 realm 的 Error —— 本身安全
 *     e.cause = hostError            // ← 宿主对象进了沙箱对象的自有属性
 *     e.original = hostError
 *
 * 脚本拿到 e，`e.cause.constructor.constructor('return process')()` 就又逃出去了。
 * 从外面看「异常已经消毒」，实际只是换了个地方漏。
 *
 * 所以本测试不只看「catch 到的 e 属不属于沙箱 realm」，
 * 而是**把 e 当成对象图去扫**：
 *   ① e 自身的 realm
 *   ② e 的每个自有属性（stack / message / cause / 自定义）的 realm + 逃逸判定
 *   ③ 上述值下一层自有属性（深度 2）的 realm + 逃逸判定
 *
 * ★ 判据口径：
 *   realm 判据 = 原型链是否终止于**沙箱 realm 的 Object.prototype**。
 *   不能只比 Error.prototype（沙箱 SyntaxError.prototype ≠ Error.prototype），
 *   也不能只比「沙箱 Error.prototype」（会把沙箱自己的 SyntaxError 误判成宿主）。
 *
 * ★ 阳性对照（⑤）不可省：
 *   修完之后「一条残留都没有」时，本测试会恒绿。恒绿是「真干净」还是
 *   「检测器看不见」？⑤ 用已知有残留的构造验证检测器有检出能力。
 *
 * 用法:
 *   node tests/sandbox-throw-residue.test.js
 *
 * 退出码 0 = 通过；1 = 有 FAIL。
 */

const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const NODE = process.execPath
const RUNNER = path.join(__dirname, 'tools', 'throw-residue-probe-runner.js')
const MUTANT = path.join(__dirname, 'tools', 'throw-residue-mutant-runner.js')

let pass = 0
let fail = 0
const failures = []

function ok (name, cond, extra) {
  if (cond) {
    pass++
    console.log('  PASS ' + name)
  } else {
    fail++
    const line = name + (extra != null ? '  :: ' + extra : '')
    failures.push(line)
    console.log('  FAIL ' + line)
  }
}

function runProbe (expr, mode) {
  // windowsHide: 每条用例独立子进程，Windows 上不隐藏就会逐个弹控制台窗
  const r = spawnSync(NODE, [RUNNER, Buffer.from(expr, 'utf8').toString('base64'), mode || 'sync'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  const out = String(r.stdout || '').trim()
  const lines = out.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch (e) { /* 继续往前找 */ }
  }
  return { fatal: 'noJSON', stdout: out.slice(0, 300), stderr: String(r.stderr || '').slice(0, 600) }
}

/** 把 props/deep 里的残留项汇总成人话 */
function residueSummary (res) {
  const all = (res.props || []).concat(res.deep || [])
  const bad = all.filter(p => p.realm === 'foreign' || p.escaped === true)
  if (!bad.length) return ''
  return bad.map(p => p.path || p.key).join(', ') +
    '  [' + bad.map(p => (p.realm || '?') + (p.escaped ? '/可逃逸' : '')).join(' ') + ']'
}

// ============================================================================
// ① 基线：vm context 确有独立 realm
// ============================================================================
console.log('\n=== ① 基线：Node vm context 有独立 realm ===')
;(function () {
  const r = runProbe('1')
  const b = r.base || {}
  ok('沙箱的 Error.prototype 不是宿主 Error.prototype',
    b.errProtoIsHost === false, JSON.stringify(b).slice(0, 160))
  ok('沙箱的 Object.prototype 不是宿主 Object.prototype',
    b.objProtoIsHost === false, JSON.stringify(b).slice(0, 160))
})()

// ============================================================================
// ② 5 条任务指定路径：重建后的 Error 必须干净
// ============================================================================
console.log('\n=== ② 任务指定的 5 条宿主异常路径：重建后的 Error 不得残留宿主对象 ===')
const FIVE = [
  { label: "new URL('not a url')", expr: "new URL('not a url')" },
  { label: 'Buffer.from(-1)', expr: 'Buffer.from(-1)' },
  { label: "Buffer.from('x','bogus-enc')", expr: "Buffer.from('x','bogus-enc')" },
  { label: "new TextDecoder('nope')", expr: "new TextDecoder('nope')" },
  { label: "unescape('%uZZZZ')", expr: "unescape('%uZZZZ')" }
]
for (const p of FIVE) {
  const d = runProbe(p.expr)
  const res = d.result || {}
  ok('【' + p.label + '】确实抛异常（用例有效）',
    res.threw === true, JSON.stringify(res).slice(0, 200))
  ok('【' + p.label + '】抛出的 Error 属于沙箱 realm',
    res.sameRealmAsSandbox === true,
    'realm=' + res.realm + ' escaped=' + res.escaped)
  ok('【' + p.label + '】Error 本身不能爬回宿主 realm',
    res.escaped !== true,
    'escapeDetail=' + String(res.escapeDetail || '').slice(0, 80))
  const rs = residueSummary(res)
  ok('【' + p.label + '】Error 的属性里无宿主 realm 残留',
    rs === '', rs)
  ok('【' + p.label + '】stack / message 仍是原始值（不是宿主对象）',
    res.stackType === 'string' && res.messageType === 'string',
    'stack=' + res.stackType + ' message=' + res.messageType)
}

// ============================================================================
// ③ 其余宿主 realm 泄漏路径（同一修法必须一并覆盖）
// ============================================================================
console.log('\n=== ③ 其余宿主异常路径：同样不得残留宿主对象 ===')
const OTHERS = [
  { label: 'Buffer.alloc(-1)', expr: 'Buffer.alloc(-1)' },
  { label: 'Buffer.from(undefined)', expr: 'Buffer.from(undefined)' },
  { label: 'new URL()', expr: 'new URL()' },
  { label: 'TextDecoder fatal 非法字节', expr: "new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from([0xff]))" },
  { label: 'AbortSignal.timeout(-1)', expr: 'AbortSignal.timeout(-1)' },
  { label: 'new AbortSignal()', expr: 'new AbortSignal()' },
  { label: 'clearImmediate(1)', expr: 'clearImmediate(1)' },
  { label: 'crypto.randomBytes(-1)', expr: 'crypto.randomBytes(-1)' },
  { label: "crypto.aesEncrypt('x','bad-mode','key')", expr: "crypto.aesEncrypt('x','bad-mode','key')" },
  { label: "crypto.rsaEncrypt('x','not-a-pem')", expr: "crypto.rsaEncrypt('x','not-a-pem')" },
  { label: "zlib.inflate(Buffer.from('not-gzip'))", expr: "zlib.inflate(Buffer.from('not-gzip'))" }
]
for (const p of OTHERS) {
  const d = runProbe(p.expr)
  const res = d.result || {}
  ok('【' + p.label + '】Error 属于沙箱 realm 且无宿主残留',
    res.sameRealmAsSandbox === true && res.escaped !== true && residueSummary(res) === '',
    'realm=' + res.realm + ' escaped=' + res.escaped + ' ' + residueSummary(res))
}

// ============================================================================
// ④ 对照组：沙箱 realm 自抛的 Error 本来就干净（阴性对照）
// ============================================================================
console.log('\n=== ④ 对照组：沙箱自抛 Error（本来就不该有残留） ===')
const SANDBOX_OWN = [
  { label: "JSON.parse('{')", expr: "JSON.parse('{')" },
  { label: "decodeURIComponent('%')", expr: "decodeURIComponent('%')" },
  { label: 'new Array(-1)', expr: 'new Array(-1)' },
  { label: "new RegExp('(')", expr: "new RegExp('(')" }
]
for (const p of SANDBOX_OWN) {
  const d = runProbe(p.expr)
  const res = d.result || {}
  ok('【对照 ' + p.label + '】沙箱 realm 且无残留',
    res.sameRealmAsSandbox === true && residueSummary(res) === '',
    'realm=' + res.realm + ' ' + residueSummary(res))
}

// ============================================================================
// ⑤ 阳性对照：检测器必须有检出能力
// ============================================================================
console.log('\n=== ⑤ 阳性对照：检测器对「重建 Error 里藏宿主对象」有检出能力 ===')
;(function () {
  const r = spawnSync(NODE, [MUTANT], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  const out = String(r.stdout || '').trim()
  let data = null
  for (const line of out.split(/\r?\n/).filter(Boolean).reverse()) {
    try { data = JSON.parse(line); break } catch (e) { /* 继续 */ }
  }
  if (!data) {
    ok('阳性对照能跑起来', false, 'stdout=' + out.slice(0, 200) + ' stderr=' + String(r.stderr || '').slice(0, 200))
    return
  }
  const M1 = data.M1 || {}
  ok('M1 宿主 Error 裸进沙箱：判为非沙箱 realm 且可逃逸',
    M1.realm !== 'sandbox' && M1.escaped === true, JSON.stringify(M1).slice(0, 200))
  const m2 = (data.M2 && data.M2.props || []).find(p => p.key === 'original')
  ok('M2 重建 Error 的 original 属性藏宿主 Error → 被检出',
    !!m2 && m2.escaped === true, JSON.stringify(data.M2).slice(0, 200))
  const m3 = (data.M3 && data.M3.props || []).find(p => p.key === 'cause')
  ok('M3 重建 Error 的 cause 属性藏宿主 Error → 被检出',
    !!m3 && m3.escaped === true, JSON.stringify(data.M3).slice(0, 200))
  const m4 = (data.M4 && data.M4.props || []).find(p => p.key === 'meta.host')
  ok('M4 宿主对象藏在自定义对象里（深度 2）→ 被检出',
    !!m4 && m4.escaped === true, JSON.stringify(data.M4).slice(0, 240))
  const M5 = data.M5 || {}
  ok('M5 干净沙箱 Error → 无残留（阴性对照，说明检测器不虚报）',
    M5.realm === 'sandbox' && M5.escaped !== true && (M5.props || []).length === 0,
    JSON.stringify(M5).slice(0, 200))
  // M6：主路径现状 —— 修好后 Buffer.from(-1) catch 到的应是沙箱 realm Error
  const M6 = data.M6 || {}
  ok('M6 主路径现状：Buffer.from(-1) 抛出的 Error 已是沙箱 realm 且无残留',
    M6.realm === 'sandbox' && M6.escaped !== true && (M6.props || []).length === 0,
    JSON.stringify(M6).slice(0, 200))
})()

// ============================================================================
// 汇总
// ============================================================================
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' sandbox-throw-residue: PASS ' + pass + ' / FAIL ' + fail)
if (fail) {
  console.log('\n失败项：')
  failures.forEach(f => console.log('  - ' + f))
}
process.exit(fail ? 1 : 0)
