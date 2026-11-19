'use strict'
/**
 * 宿主同步抛出异常的逃逸回归测试
 *
 * ============================================================================
 * 这个文件测的是什么
 * ============================================================================
 * v1.13.16 的 facade 把「交回面」的**兑现值**都包成了沙箱 realm 的 Proxy，
 * 挡住了 `await fetch(u).then(r => r.json())` 这类取值路径。
 *
 * 但它**没有**处理另一条同样能拿到宿主对象的路径：**宿主同步抛出的异常**。
 *
 * 注入沙箱的宿主内置类（URL / Buffer / TextDecoder / AbortSignal …）和
 * 宿主自建闭包（crypto / zlib polyfill）在参数非法时**同步 throw**，
 * 这个 Error 是**宿主 realm** 的对象，裸着进沙箱的 catch：
 *
 *     try { new URL('not a url') } catch (e) {
 *       e.constructor.constructor('return process')()   // ← 真宿主 process
 *     }
 *
 * 实测（tests/tools/throw-leak-matrix.js，本文件同源）：
 *   ❌ 16 条宿主 realm Error 裸进沙箱，全部**实测逃逸**（能拿到宿主真 process）
 *   ✅  9 条沙箱 realm Error（JSON.parse / decodeURIComponent / new Array(-1)…）安全
 *   ⚪ 25 条不抛
 *
 * ============================================================================
 * 判据：为什么不能只用「拿到 process 没」
 * ============================================================================
 * 任务里明确要求区分「宿主 realm 的 Error」和「沙箱 realm 的 Error」。
 * 理由：
 *   - 「拿到 process 没」只能证明**逃逸成功**，证明不了 Error 属于哪个 realm；
 *   - 沙箱 realm 的 Error 也能构造出「看起来像逃逸」的表象。
 *
 * 所以本文件用**两个独立信号**：
 *   信号A【realm】原型链是否终止于**沙箱 realm 的 Object.prototype**
 *   信号B【危害】e.constructor.constructor('return process')() 能否拿到宿主真 process
 *
 * ⚠ realm 判据踩过的坑（别改回简单写法）：
 *   ① 不能比 `Error.prototype` —— 沙箱的 SyntaxError.prototype ≠ Error.prototype，
 *      那样会把沙箱自己抛的 SyntaxError 误判成宿主 realm（我第一版就栽在这，
 *      9 条沙箱 Error 全被误判成「已消毒」）。
 *   ② 不能只比「沙箱 Error.prototype」—— 同上，会漏掉 SyntaxError/TypeError。
 *   正确口径：**沿原型链上溯，看是否终止于沙箱 realm 的 Object.prototype**。
 *   （Node vm context 确有独立 realm，实测 host Error.prototype !== vm Error.prototype。）
 *
 * 用法:
 *   node tests/sandbox-throw-leak.test.js
 *   node tests/sandbox-throw-leak.test.js --matrix   # 附带跑全量矩阵并打印清单
 *
 * 退出码 0 = 通过；1 = 有 FAIL。
 */

const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const NODE = process.execPath
const RUNNER = path.join(__dirname, 'tools', 'throw-leak-probe-runner.js')

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

// ============================================================================
// 子进程执行器（铁律：每条用例独立进程，逃逸会真的执行 Function('return process')）
// ============================================================================
function runProbe (expr, mode) {
  const r = spawnSync(NODE, [RUNNER, Buffer.from(expr, 'utf8').toString('base64'), mode || 'sync'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  const out = String(r.stdout || '').trim()
  const lines = out.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch (e) { /* 继续往前找 */ }
  }
  return { fatal: 'noJSON', stdout: out.slice(0, 300), stderr: String(r.stderr || '').slice(0, 600) }
}

// ============================================================================
// ① 基线：vm context 确有独立 realm（realm 判据成立的前提）
// ============================================================================
console.log('\n=== ① 基线：Node vm context 有独立 realm（realm 判据成立的前提） ===')
;(function () {
  // ⚠ runProbe 返回的是**整行 JSON** { base, result }，base 就在顶层，
  //   别再解一层 .result（我第一版写成 r.result.base，基线一直红）。
  const r = runProbe('1')
  const b = r.base || {}
  ok('沙箱的 Error.prototype 不是宿主 Error.prototype（独立 realm 成立）',
    b.errProtoIsHost === false,
    'errProtoIsHost=' + b.errProtoIsHost + ' ' + JSON.stringify(b).slice(0, 160))
  ok('沙箱的 Object.prototype 不是宿主 Object.prototype（独立 realm 成立）',
    b.objProtoIsHost === false,
    'objProtoIsHost=' + b.objProtoIsHost + ' ' + JSON.stringify(b).slice(0, 160))
})()

// ============================================================================
// ② 任务指定的 5 条逃逸路径
// ============================================================================
/**
 * 这 5 条是复核阶段实测发现、任务明确要求固化的路径。
 * 断言：既不能是宿主 realm（realm 判据），也不能逃逸（危害判据）。
 */
console.log('\n=== ② 任务指定的 5 条宿主异常泄漏路径 ===')
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
  ok('【' + p.label + '】确实抛异常（用例本身有效，不是空跑）',
    res.threw === true, JSON.stringify(res).slice(0, 200))
  ok('【' + p.label + '】抛出的 Error 属于沙箱 realm，不是宿主 realm',
    res.sameRealmAsSandbox === true,
    'realm=' + res.realm + ' escaped=' + res.escaped + ' msg=' + String(res.msg || '').slice(0, 60))
  ok('【' + p.label + '】沙箱不能从该 Error 爬回宿主 realm',
    res.escaped !== true,
    'escapeDetail=' + String(res.escapeDetail || res.escapeBlocked || '').slice(0, 80))
}

// ============================================================================
// ③ 沙箱 realm 的 Error 是对照组：证明 realm 判据有区分力
// ============================================================================
console.log('\n=== ③ 对照组：沙箱 realm 自抛的 Error（证明 realm 判据不是恒真） ===')
const SANDBOX_OWN = [
  { label: "JSON.parse('{')", expr: "JSON.parse('{')" },
  { label: "decodeURIComponent('%')", expr: "decodeURIComponent('%')" },
  { label: 'new Array(-1)', expr: 'new Array(-1)' },
  { label: "new RegExp('(')", expr: "new RegExp('(')" }
]
for (const p of SANDBOX_OWN) {
  const d = runProbe(p.expr)
  const res = d.result || {}
  ok('【对照 ' + p.label + '】判为沙箱 realm Error（说明判据能区分宿主/沙箱）',
    res.sameRealmAsSandbox === true,
    'realm=' + res.realm + ' msg=' + String(res.msg || '').slice(0, 60))
}

// ============================================================================
// ④ 全量矩阵：所有注入的宿主 API 都不能抛宿主 realm Error
// ============================================================================
/**
 * 这里跑完整的穷举矩阵（tests/tools/throw-leak-probes.js），
 * 断言「没有一条是宿主 realm Error」。这是给施工方的回归护栏：
 * 任何新增注入值只要会抛宿主 realm Error，本项立刻 FAIL。
 */
console.log('\n=== ④ 全量注入面矩阵：不允许出现宿主 realm Error ===')
;(function () {
  const r = spawnSync(NODE, [path.join(__dirname, 'tools', 'throw-leak-matrix.js'), '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  // ⚠ --json 输出是 **pretty-printed 多行 JSON**，不能按行解析。
  //   （我第一版按行找，找不到就报「矩阵能跑起来 FAIL」，假警报。）
  let data = null
  try { data = JSON.parse(String(r.stdout || '').trim()) } catch (e) { data = null }
  if (!data || !data.rows) {
    ok('矩阵能跑起来', false,
      'parseErr=' + (e && e.message ? e.message.slice(0, 120) : '') +
      ' stderr=' + String(r.stderr || '').slice(0, 200) +
      ' stdout=' + String(r.stdout || '').slice(0, 200))
    return
  }
  const leaks = data.rows.filter(x => x.state === 'host-leak')
  const fatal = data.rows.filter(x => x.state === 'FATAL')
  ok('矩阵无 FATAL（探针本身没坏）', fatal.length === 0,
    fatal.map(f => f.key + ':' + f.label).join(', '))
  ok('【核心】没有任何注入的宿主 API 抛出宿主 realm Error',
    leaks.length === 0,
    leaks.map(f => f.key + ': ' + f.label + (f.escaped ? ' ⛔' : '')).join(' | ').slice(0, 500))
  console.log('    〔矩阵统计〕宿主泄漏 ' + data.counts['host-leak'] +
    ' / 沙箱Error ' + data.counts['sandbox-error'] +
    ' / 不抛 ' + data.counts['no-throw'] +
    ' / 共 ' + data.rows.length + ' 条')
})()

// ============================================================================
// ⑤ 变异测试：证明 ④ 的断言不是空跑
// ============================================================================
/**
 * 若「宿主 realm Error」当前不存在，④ 会恒绿 —— 那它到底还有没有检出能力？
 * 这里构造一个**阳性对照**：直接拿宿主 Error 塞进沙箱，
 * 断言它必然被判成 host-leak 且必然能逃逸。
 * 这证明判定逻辑本身有效，不是「扫不出东西所以全绿」。
 */
console.log('\n=== ⑤ 变异测试：阳性对照（宿主 Error 直接塞进沙箱必须被判泄漏） ===')
;(function () {
  const script = path.join(__dirname, 'tools', 'throw-leak-mutant-runner.js')
  const r = spawnSync(NODE, [script], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  const out = String(r.stdout || '').trim()
  let data = null
  for (const line of out.split(/\r?\n/).filter(Boolean).reverse()) {
    try { data = JSON.parse(line); break } catch (e) { /* 继续 */ }
  }
  ok('阳性对照：宿主 realm Error 被正确判为 host realm',
    !!data && data.realm === 'host', JSON.stringify(data || r.stderr).slice(0, 200))
  ok('阳性对照：宿主 realm Error 确实能逃逸（证明判定有检出能力）',
    !!data && data.escaped === true, JSON.stringify(data || r.stderr).slice(0, 200))
})()

// ============================================================================
// 汇总
// ============================================================================
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' sandbox-throw-leak: PASS ' + pass + ' / FAIL ' + fail)
if (fail) {
  console.log('\n失败项：')
  failures.forEach(f => console.log('  - ' + f))
}
process.exit(fail ? 1 : 0)
