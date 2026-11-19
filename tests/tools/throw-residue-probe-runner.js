'use strict'
/**
 * 「重建后的 Error 是否残留宿主 realm 对象」的执行器。
 *
 * ============================================================================
 * 它要验的是「修 escape 引入新 escape」这一类模式
 * ============================================================================
 * 功能体检组的修法方向是：把宿主同步抛出的异常纳入交回面消毒 ——
 * 宿主抛的 Error 不再裸进沙箱，而是**重建**一个沙箱侧的 Error 给脚本。
 *
 * 这条修法有个典型的新风险：**重建时把宿主对象塞进了自定义属性**。
 * 例如：
 *
 *     const e = new Error(msg)          // 沙箱 realm 的 Error
 *     e.cause = hostError                // ← 宿主对象进了沙箱 realm 对象的自有属性
 *     e.original = hostError
 *     e.stack = hostError.stack          // 字符串，无害
 *
 * `e.cause` 是宿主 Error → 脚本 `e.cause.constructor.constructor('return process')()`
 * 就又逃出去了。也就是说：堵了一条口，又开了一条。
 *
 * 所以本执行器做的不是「catch 到 e 就完事」，而是**把 e 当成对象图去扫**：
 *   ① e 本身的 realm（原型链是否终止于沙箱 realm 的 Object.prototype）
 *   ② e 的每一个自有属性（stack / message / cause / 自定义）的 realm
 *   ③ 上述值的下一层自有属性（深度 3），逐个判 realm
 *   ④ 每个对象值的逃逸判定（constructor.constructor('return process')）
 *   ⑤ e.stack / e.message 是否仍是**原始值**（字符串）而不是宿主对象
 *
 * ★ 判据说明：
 *   - realm 判据用「原型链是否终止于沙箱 realm 的 Object.prototype」。
 *     不能只比 Error.prototype（沙箱的 SyntaxError.prototype ≠ Error.prototype），
 *     也不能只比「沙箱 Error.prototype」（会把沙箱自己的 SyntaxError 误判成宿主）。
 *   - facade 包装过的宿主对象，getPrototypeOf 被劫持成沙箱内的 safeProto，
 *     所以它在 realm 判据下显示为「sandbox」——这是**对的**，
 *     因为 facade proxy 确实不是宿主裸对象（它的 constructor 已被换成占位）。
 *     真正要抓的是「沙箱 realm 对象里塞了宿主裸对象」这种绕不过 facade 的情形。
 *
 * 用法: node throw-residue-probe-runner.js <base64(expr)> [mode]
 *   mode: sync（默认）| promise
 * 输出: 一行 JSON
 */
const path = require('path')

/**
 * ★ 验证模式：把 src/core/sandbox-facade.js 换成「打了补丁的副本」。
 *   开关：环境变量 LX_FACADE_PATCHED=1
 *
 *   ⚠ 顺序坑：必须**先**替换 require.cache，**再** require sandbox.js。
 *     sandbox.js 里是模块级 require，sandbox.js 先加载后再替换缓存对它无效。
 *
 *   这个开关的用途：独立验证「宿主异常消毒」修完后，
 *   重建出来的 Error 有没有残留宿主对象、能不能从残留爬回宿主 realm
 *   —— 即「修 escape 引入新 escape」的检查。
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

// ---- 扫描器源码（普通字符串拼接，零嵌套转义）--------------------------------
const SCAN_SRC = [
  '(function (thrown) {',
  '  var SB_OBJ_PROTO = Object.getPrototypeOf({});',
  '  function classify (v) {',
  '    if (v === null) return "null";',
  '    var t = typeof v;',
  '    if (t !== "object" && t !== "function") return "primitive";',
  '    try {',
  '      var p = Object.getPrototypeOf(v), g = 0;',
  '      while (p && g++ < 32) {',
  '        if (p === SB_OBJ_PROTO) return "sandbox";',
  '        p = Object.getPrototypeOf(p);',
  '      }',
  '    } catch (e) {}',
  '    return "foreign";',
  '  }',
  '  function escaped (v) {',
  '    if (v === null || (typeof v !== "object" && typeof v !== "function")) return false;',
  '    try {',
  '      var p2 = v.constructor.constructor("return process")();',
  '      return !!(p2 && (typeof p2.pid === "number" || typeof p2.mainModule !== "undefined"));',
  '    } catch (e) { return false; }',
  '  }',
  '  function escapeBlocked (v) {',
  '    if (v === null || (typeof v !== "object" && typeof v !== "function")) return "";',
  '    try {',
  '      var p2 = v.constructor.constructor("return process")();',
  '      return "returned:" + String(p2);',
  '    } catch (e) { return String(e && e.name || "") + ":" + String(e && e.message || "").slice(0, 60); }',
  '  }',
  '  var out = { threw: false, realm: "none", escaped: false, props: [], deep: [], protoRealm: "none" };',
  '  if (!thrown) return JSON.stringify(out);',
  '  out.threw = true;',
  '  out.msg = String(thrown && thrown.message || "").slice(0, 140);',
  '  out.name = String(thrown && thrown.name || "").slice(0, 40);',
  '  out.realm = classify(thrown);',
  '  out.sameRealmAsSandbox = (out.realm === "sandbox");',
  '  try { out.protoRealm = classify(Object.getPrototypeOf(thrown)); } catch (e) { out.protoRealm = "err"; }',
  '  out.escaped = escaped(thrown);',
  '  if (out.escaped) out.escapeDetail = escapeBlocked(thrown);',
  '  // stack / message 是否仍是原始值（字符串）',
  '  out.stackType = typeof thrown.stack;',
  '  out.messageType = typeof thrown.message;',
  '  try { out.stackIsObject = (thrown.stack && typeof thrown.stack === "object"); } catch (e) { out.stackIsObject = false; }',
  '  // 自有属性逐个扫描',
  '  var keys = [];',
  '  try { keys = Object.getOwnPropertyNames(thrown); } catch (e) { keys = []; }',
  '  for (var i = 0; i < keys.length; i++) {',
  '    var k = keys[i];',
  '    var val;',
  '    try { val = thrown[k]; } catch (e) { out.props.push({ key: k, realm: "throw", escaped: false }); continue; }',
  '    var r = classify(val);',
  '    var rec = { key: k, realm: r, type: typeof val, escaped: escaped(val) };',
  '    if (rec.escaped) rec.detail = escapeBlocked(val);',
  '    out.props.push(rec);',
  '    // 下一层（深度 3）：只有对象值才继续',
  '    if (r !== "sandbox" && r !== "primitive" && r !== "null") continue;',
  '    if (typeof val !== "object" && typeof val !== "function") continue;',
  '    var k2 = [];',
  '    try { k2 = Object.getOwnPropertyNames(val); } catch (e) { k2 = []; }',
  '    for (var j = 0; j < k2.length && j < 24; j++) {',
  '      var kk = k2[j];',
  '      if (kk === "constructor" || kk === "__proto__") continue;',
  '      var v2;',
  '      try { v2 = val[kk]; } catch (e) { continue; }',
  '      var r2 = classify(v2);',
  '      var rec2 = { path: k + "." + kk, realm: r2, type: typeof v2, escaped: escaped(v2) };',
  '      if (rec2.escaped) rec2.detail = escapeBlocked(v2);',
  '      out.deep.push(rec2);',
  '    }',
  '  }',
  '  return JSON.stringify(out);',
  '})'
].join('\n')

const SYNC_CODE = [
  '(function () {',
  '  var scan = ' + SCAN_SRC + ';',
  '  try {',
  '    var v = (' + EXPR + ');',
  '    return JSON.stringify({ threw: false, realm: "none", escaped: false, note: "ok", valueType: typeof v });',
  '  } catch (e) { return scan(e); }',
  '})()'
].join('\n')

const PROMISE_CODE = [
  '(function () {',
  '  var scan = ' + SCAN_SRC + ';',
  '  globalThis.__res = "";',
  '  var p;',
  '  try { p = (' + EXPR + '); } catch (e) { globalThis.__res = scan(e); return "SET"; }',
  '  if (!p || typeof p.then !== "function") { globalThis.__res = JSON.stringify({ threw: false, realm: "none", escaped: false, note: "notAPromise" }); return "SET"; }',
  '  p.then(function (v) { globalThis.__res = JSON.stringify({ threw: false, realm: "none", escaped: false, note: "resolved" }); },',
  '         function (e) { globalThis.__res = scan(e); });',
  '  return "SET";',
  '})()'
].join('\n')

async function main () {
  const sb = new Sandbox({ id: 'residue', fetchTimeout: 1000, allowPrivateHosts: true })
  await sb.init('', {})

  const base = {}
  try {
    const sbErrProto = sb.run('Error.prototype', 5000)
    const sbObjProto = sb.run('Object.prototype', 5000)
    base.errProtoIsHost = (sbErrProto === Error.prototype)
    base.objProtoIsHost = (sbObjProto === Object.prototype)
  } catch (e) { base.err = String(e && e.message).slice(0, 120) }

  let raw
  try {
    if (MODE === 'promise') {
      sb.run(PROMISE_CODE, 5000)
      await new Promise(r => setTimeout(r, 500))
      raw = String(sb.run('globalThis.__res || ""', 5000))
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
