'use strict'
/**
 * 「宿主 API 同步抛出异常」逃逸矩阵 —— 实测执行器。
 *
 * ============================================================================
 * 三个信号，缺一不可
 * ============================================================================
 *   信号A【realm 归属】Object.getPrototypeOf(e) === Object.getPrototypeOf(new Error() in sandbox)
 *     实测依据：Node vm context **有独立 realm**（host Error.prototype !== vm Error.prototype），
 *     所以这个二分成立。
 *       true  → Error 属于沙箱 realm（沙箱自己抛的，如 JSON.parse）
 *       false → Error 属于别的 realm（宿主 realm，宿主内置类抛的）
 *
 *   信号B【危害实测】e.constructor.constructor('return process')() 能否拿到宿主真 process
 *
 *   信号C【是否已被 facade 消毒】
 *     被 facade.wrap 过的宿主 Error 是 Proxy，getPrototypeOf 被改写，
 *     于是 A=false 但 B=false —— 这不是漏洞，是「已消毒」。
 *     ⚠ 必须三个信号一起看：只看 A 会把已消毒的误报成漏洞；
 *       只看 B 又证明不了 Error 属于哪个 realm。这正是任务里强调
 *       「别用『拿到 process 没』当唯一判据」的原因。
 *
 * ============================================================================
 * 分类
 * ============================================================================
 *   ❌ HOST-LEAK    A=false 且 B=true  → 宿主 realm Error 裸进沙箱，**可逃逸**
 *   ✅ SANDBOX-ERR  A=true             → 沙箱 realm Error，安全
 *   🛡 SANITIZED    A=false 且 B=false  → 宿主 Error 但已被 facade Proxy 挡住
 *   ⚪ NO-THROW     没抛
 *
 * 用法: node tests/tools/throw-leak-matrix.js [--json] [--only <substr>]
 */

const path = require('path')
const { spawnSync } = require('child_process')
const PROBES = require('./throw-leak-probes')

const ROOT = path.join(__dirname, '..', '..')
const NODE = process.execPath
const RUNNER = path.join(__dirname, 'throw-leak-probe-runner.js')
const AS_JSON = process.argv.includes('--json')
const ONLY_I = process.argv.indexOf('--only')
const ONLY = ONLY_I >= 0 ? process.argv[ONLY_I + 1] : null

function runOne (probe) {
  // windowsHide: 本矩阵每条探针都起独立子进程（几十条），Windows 上不隐藏就会逐个弹控制台窗
  const r = spawnSync(NODE, [RUNNER, Buffer.from(probe.expr, 'utf8').toString('base64'), probe.mode || 'sync'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  const out = String(r.stdout || '').trim()
  const lines = out.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch (e) { /* 继续往前找 */ }
  }
  return { fatal: 'noJSON', stdout: out.slice(0, 300), stderr: String(r.stderr || '').slice(0, 600), status: r.status }
}

const rows = []
for (const p of PROBES) {
  if (ONLY && (p.key + ' ' + p.label).indexOf(ONLY) < 0) continue
  const d = runOne(p) || {}
  const res = d.result || {}
  let state
  if (d.fatal || res.fatal) state = 'FATAL'
  else if (!res.threw) state = 'no-throw'
  else if (res.sameRealmAsSandbox === true) state = 'sandbox-error'
  else if (res.escaped === true) state = 'host-leak'
  else state = 'sanitized'
  rows.push({ ...p, result: res, state, escaped: !!res.escaped })
}

const counts = { 'host-leak': 0, 'sandbox-error': 0, sanitized: 0, 'no-throw': 0, FATAL: 0 }
for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1

const TAG = {
  'host-leak': '❌ 宿主泄漏',
  'sandbox-error': '✅ 沙箱Error',
  sanitized: '🛡 已消毒',
  'no-throw': '⚪ 不抛',
  FATAL: '💥 FATAL'
}

if (AS_JSON) {
  console.log(JSON.stringify({ counts, rows }, null, 2))
} else {
  console.log('=== 宿主 API 同步抛出异常 · 逃逸矩阵（实测） ===')
  console.log("信号A realm: Object.getPrototypeOf(e) === Object.getPrototypeOf(new Error() in sandbox)")
  console.log("信号B 危害: e.constructor.constructor('return process')() 是否拿到宿主真 process")
  console.log('')
  const w = Math.max(...rows.map(r => (r.key + ': ' + r.label).length), 20)
  for (const r of rows) {
    const esc = r.escaped ? '  ⛔已逃逸' : ''
    const note = r.result.note ? '(' + r.result.note + ')' : ''
    console.log((TAG[r.state] || '?').padEnd(12) + (r.key + ': ' + r.label).padEnd(w) + ' | ' +
      (r.result.msg || r.result.name || note || r.result.fatal || '').slice(0, 60) + esc)
  }
  console.log('')
  console.log('统计: ❌宿主泄漏 ' + counts['host-leak'] +
    ' / ✅沙箱Error ' + counts['sandbox-error'] +
    ' / 🛡已消毒 ' + counts.sanitized +
    ' / ⚪不抛 ' + counts['no-throw'] +
    ' / FATAL ' + counts.FATAL)
  const bad = rows.filter(r => r.state === 'host-leak' || r.state === 'FATAL')
  if (bad.length) {
    console.log('')
    console.log('⚠ 需要修的（宿主 realm Error 裸进沙箱，可逃逸）：')
    bad.forEach(r => console.log('  ✗ ' + r.key + ': ' + r.label +
      (r.escaped ? '  ⛔实测逃逸' : '') +
      '  msg=' + (r.result.msg || '').slice(0, 70)))
  }
}
if (counts['host-leak'] > 0) process.exitCode = 1
