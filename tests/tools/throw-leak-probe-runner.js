'use strict'
/**
 * 单条探针的执行器（被 throw-leak-matrix.js 以子进程方式调用）。
 *
 * 为什么要独立成文件而不是 node -e 传字符串：
 *   沙箱代码要嵌进宿主脚本、宿主脚本又要嵌进矩阵脚本，多层模板字符串转义
 *   会把代码改坏（我第一版栽在这：EXPR 没被替换，50 条全报 "EXPR is not defined"，
 *   差点被当成「50 条漏洞」上报）。这里全部用普通字符串拼接，零嵌套转义。
 *
 * 用法: node throw-leak-probe-runner.js <base64(expr)> [mode]
 *   mode: sync（默认）| promise
 * 输出: 一行 JSON
 */
const path = require('path')

/**
 * ★ 验证模式：把 src/core/sandbox-facade.js 换成「打了补丁的副本」，
 *   用于**独立验证**「宿主异常消毒」这个修法本身是否成立。
 *
 *   开关：环境变量 LX_FACADE_PATCHED=1
 *
 *   ⚠ 顺序坑：必须**先**替换 require.cache，**再** require sandbox.js。
 *     sandbox.js 里 `const { makeSandboxFacade } = require('./sandbox-facade')`
 *     是模块级 require，一旦 sandbox.js 先加载，它已经把函数捕获到局部常量里，
 *     之后再替换缓存对已加载的模块无效（我第一版就栽在这：补丁跑出来 16 条照样泄漏，
 *     差点误判成「修法不成立」）。
 *
 *   为什么要走 require.cache 替换：src/ 归功能体检组施工，我不动。
 */
if (process.env.LX_FACADE_PATCHED === '1') {
  const facadePath = require.resolve(path.join(__dirname, '..', '..', 'src', 'core', 'sandbox-facade.js'))
  const patched = require('./sandbox-facade-patched.js')
  const m = new module.constructor()
  m.filename = facadePath
  m.loaded = true
  m.exports = patched
  require.cache[facadePath] = m
}

const { Sandbox } = require(path.join(__dirname, '..', '..', 'src', 'core', 'sandbox.js'))

const EXPR = Buffer.from(process.argv[2] || '', 'base64').toString('utf8')
const MODE = process.argv[3] || 'sync'

// ---- 分析器源码（普通字符串拼接，不套模板串）--------------------------------
const ANALYZE_SRC = [
  '(function (thrown) {',
  '  var out = { threw: false, realm: "none", escaped: false };',
  '  if (!thrown) return JSON.stringify(out);',
  '  out.threw = true;',
  '  out.msg = String(thrown && thrown.message || "").slice(0, 140);',
  '  out.name = String(thrown && thrown.name || "").slice(0, 40);',
  '  out.ctorName = String(thrown && thrown.constructor && thrown.constructor.name || "").slice(0, 40);',
  '  // ★ realm 判据：原型链是否终止于**沙箱 realm** 的 Object.prototype。',
  '  //   不能直接比 Error.prototype —— 沙箱里的 SyntaxError/TypeError 的原型',
  '  //   是 SyntaxError.prototype/TypeError.prototype，不等于 Error.prototype。',
  '  //   也不能只比「沙箱 Error.prototype」—— 那会把沙箱自己抛的 SyntaxError 误判成宿主 realm。',
  '  var sbObjProto = Object.getPrototypeOf({});',
  '  var realm = "host";',
  '  try {',
  '    var p = Object.getPrototypeOf(thrown), g = 0;',
  '    while (p && g++ < 32) {',
  '      if (p === sbObjProto) { realm = "sandbox"; break; }',
  '      p = Object.getPrototypeOf(p);',
  '    }',
  '  } catch (x) {}',
  '  out.realm = realm;',
  '  out.sameRealmAsSandbox = (realm === "sandbox");',
  '  try {',
  '    var p2 = thrown.constructor.constructor("return process")();',
  '    if (p2 && (typeof p2.mainModule !== "undefined" || typeof p2.pid === "number")) {',
  '      out.escaped = true;',
  '      out.escapeDetail = "pid=" + (typeof p2.pid) + " binding=" + (typeof p2.binding);',
  '    } else { out.escapeDetail = "fakeProcess"; }',
  '  } catch (x) {',
  '    out.escapeBlocked = String(x && x.name || "") + ":" + String(x && x.message || "").slice(0, 60);',
  '  }',
  '  return JSON.stringify(out);',
  '})'
].join('\n')

const SYNC_CODE = [
  '(function () {',
  '  var analyze = ' + ANALYZE_SRC + ';',
  '  try {',
  '    var v = (' + EXPR + ');',
  '    return JSON.stringify({ threw: false, realm: "none", escaped: false, note: "ok", valueType: typeof v });',
  '  } catch (e) { return analyze(e); }',
  '})()'
].join('\n')

const PROMISE_CODE = [
  '(function () {',
  '  var analyze = ' + ANALYZE_SRC + ';',
  '  globalThis.__leak_result = "";',
  '  var p;',
  '  try { p = (' + EXPR + '); } catch (e) { globalThis.__leak_result = analyze(e); return "SET"; }',
  '  if (!p || typeof p.then !== "function") { globalThis.__leak_result = JSON.stringify({ threw: false, realm: "none", escaped: false, note: "notAPromise" }); return "SET"; }',
  '  p.then(function (v) { globalThis.__leak_result = JSON.stringify({ threw: false, realm: "none", escaped: false, note: "resolved" }); },',
  '         function (e) { globalThis.__leak_result = analyze(e); });',
  '  return "SET";',
  '})()'
].join('\n')

async function main () {
  const sb = new Sandbox({ id: 'throwleak', fetchTimeout: 1000, allowPrivateHosts: true })
  await sb.init('', {})

  // 沙箱 realm 基准。
  // ⚠ 判据必须**在宿主侧**做：在沙箱里比较 `Object.getPrototypeOf(new Error()) === Error.prototype`
  //   比的是「沙箱 vs 沙箱」，恒为 true，毫无意义（我第一版就写成这样，基线一直红）。
  //   正确做法：把沙箱的 Error.prototype / Object.prototype **取回宿主侧**再与宿主的比。
  const base = {}
  try {
    const sbErrProto = sb.run('Error.prototype', 5000)
    const sbObjProto = sb.run('Object.prototype', 5000)
    base.errProtoIsHost = (sbErrProto === Error.prototype)
    base.objProtoIsHost = (sbObjProto === Object.prototype)
    base.sandboxHasOwnError = typeof sbErrProto === 'object' && sbErrProto !== null
  } catch (e) { base.err = String(e && e.message).slice(0, 120) }

  let raw
  try {
    if (MODE === 'promise') {
      sb.run(PROMISE_CODE, 5000)
      await new Promise(r => setTimeout(r, 400))
      raw = String(sb.run('globalThis.__leak_result || ""', 5000))
    } else {
      raw = String(sb.run(SYNC_CODE, 5000))
    }
  } catch (e) {
    raw = JSON.stringify({ fatal: 'runThrow:' + String(e && e.message || '').slice(0, 150) })
  }
  sb.destroy()

  let result
  try { result = JSON.parse(raw) } catch (e) { result = { fatal: 'parse:' + String(raw).slice(0, 200) } }
  console.log(JSON.stringify({ base: base, result: result }))
}

main().catch(e => console.log(JSON.stringify({ fatal: 'main:' + String(e && e.message || '').slice(0, 200) })))
