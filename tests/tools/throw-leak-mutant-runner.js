'use strict'
/**
 * 阳性对照 runner：把一个**宿主 realm** 的 Error 显式塞进沙箱，
 * 验证 realm 判据与危害判据**确实能检出**它（防止矩阵「扫不出东西所以恒绿」）。
 *
 * 用法: node throw-leak-mutant-runner.js
 * 输出: 一行 JSON { realm: 'host'|'sandbox', escaped: bool }
 *
 * 这个 runner 同时被 sandbox-throw-leak.test.js 的变异测试段使用。
 */
const path = require('path')
const { Sandbox } = require(path.join(__dirname, '..', '..', 'src', 'core', 'sandbox.js'))

// ---- 沙箱内分析代码（普通字符串拼接，零嵌套转义）--------------------------
const CODE = [
  '(function () {',
  '  var e = globalThis.__hostErr;',
  '  var sbProto = Object.getPrototypeOf({});',
  '  var p = Object.getPrototypeOf(e), g = 0, realm = "host";',
  '  while (p && g++ < 32) {',
  '    if (p === sbProto) { realm = "sandbox"; break; }',
  '    p = Object.getPrototypeOf(p);',
  '  }',
  '  var escaped = false, detail = "";',
  '  try {',
  '    var pr = e.constructor.constructor("return process")();',
  '    if (pr && (typeof pr.mainModule !== "undefined" || typeof pr.pid === "number")) {',
  '      escaped = true; detail = "pid=" + (typeof pr.pid);',
  '    } else { detail = "fakeProcess"; }',
  '  } catch (x) { detail = "blocked:" + String(x && x.name || ""); }',
  '  return JSON.stringify({ realm: realm, escaped: escaped, detail: detail });',
  '})()'
].join('\n')

async function main () {
  const sb = new Sandbox({ id: 'mutant', fetchTimeout: 1000 })
  await sb.init('', {})
  // 宿主 realm 的 Error：直接在宿主侧 new，sandbox.js 完全不知道它的存在
  const hostErr = new Error('host-side')
  sb.context.__hostErr = hostErr
  const raw = String(sb.run(CODE, 5000))
  sb.destroy()
  let out
  try { out = JSON.parse(raw) } catch (e) { out = { fatal: 'parse:' + String(raw).slice(0, 200) } }
  console.log(JSON.stringify(out))
}

main().catch(e => console.log(JSON.stringify({ fatal: String(e && e.message || '').slice(0, 200) })))
