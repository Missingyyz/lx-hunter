'use strict'
/**
 * 阳性对照：证明「宿主残留检测器」有真实检出能力。
 *
 * ============================================================================
 * 为什么需要这个文件
 * ============================================================================
 * 残留检测（throw-residue-probe-runner.js）判据是：
 *   「沙箱 realm 的 Error 的自有属性里，是否藏着宿主 realm 对象」。
 *
 * 施工方改完之后，残留可能**一条都没有**——那时检测器恒绿，
 * 但「恒绿」到底是因为「真的干净」还是因为「检测器根本看不见」？
 * 这个文件回答的就是后一个问题。
 *
 * ★ 版本修正（重要）：
 *   第一版里 hostErr 是**从沙箱内** `catch (e) { Buffer.from(-1) }` 取的。
 *   那正是漏洞形态 —— 施工方修好后，那里的 Error 已经是**沙箱 realm** 的了，
 *   于是 M1 判成 sandbox、M2/M3/M4 里塞的也不再是宿主对象，
 *   检测器「看不见」了 —— 看起来像检测器坏了，其实是**变异源失效**。
 *   （这是「阳性对照随被测对象一起被修好」的经典陷阱。）
 *
 *   现在改成：**宿主侧直接造好真宿主对象**，通过 sandbox context 注入进去。
 *   这样无论漏洞修没修，变异源永远是真正的宿主 realm 对象，
 *   检测器的检出能力才能被持续验证。
 *
 * 五个用例：
 *   M1 宿主 Error 裸进沙箱              → 应判 foreign + escaped
 *   M2 沙箱 Error + 属性塞宿主 Error     → 应判 sandbox，但属性里 foreign/escaped
 *   M3 沙箱 Error + cause 塞宿主 Error   → 应判 sandbox，但 cause 属性 foreign/escaped
 *   M4 沙箱 Error + 属性塞宿主普通对象    → 应判 sandbox，但属性里 foreign
 *   M5 干净沙箱 Error（无宿主残留）      → 应判 sandbox 且无残留（阴性对照）
 *   M6 主路径现状：Buffer.from(-1) catch → 修好后应为 sandbox（回归确认）
 *
 * M2/M3/M4 是「修 escape 引入新 escape」的典型形态：
 *   宿主对象不再裸进 catch，但被塞进了重建 Error 的自定义属性里。
 *
 * 用法: node throw-residue-mutant-runner.js
 * 输出: 一行 JSON
 */
const path = require('path')
const { Sandbox } = require(path.join(__dirname, '..', '..', 'src', 'core', 'sandbox.js'))

/**
 * 沙箱侧脚本：构造 6 种 Error 并逐个扫描。
 */
const SANDBOX_SRC = [
  '(function () {',
  '  var SB = Object.getPrototypeOf({});',
  '  function classify (v) {',
  '    if (v === null) return "null";',
  '    var t = typeof v;',
  '    if (t !== "object" && t !== "function") return "primitive";',
  '    try {',
  '      var p = Object.getPrototypeOf(v), g = 0;',
  '      while (p && g++ < 32) { if (p === SB) return "sandbox"; p = Object.getPrototypeOf(p); }',
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
  '  function propScan (e) {',
  '    var res = [];',
  '    var keys = [];',
  '    try { keys = Object.getOwnPropertyNames(e); } catch (x) { keys = []; }',
  '    for (var i = 0; i < keys.length; i++) {',
  '      var k = keys[i];',
  '      if (k === "stack") continue;',
  '      var val;',
  '      try { val = e[k]; } catch (x) { continue; }',
  '      var r = classify(val);',
  '      if (r === "primitive" || r === "null") continue;',
  '      var rec = { key: k, realm: r, escaped: escaped(val), depth: 1 };',
  '      // 深度 2：沙箱对象里再嵌一层宿主对象（重建 Error 时把宿主对象包进自定义对象的情形）',
  '      if (r === "sandbox" && val && typeof val === "object") {',
  '        var k2 = [];',
  '        try { k2 = Object.getOwnPropertyNames(val); } catch (x) { k2 = []; }',
  '        for (var j = 0; j < k2.length && j < 24; j++) {',
  '          var kk = k2[j];',
  '          if (kk === "constructor" || kk === "__proto__") continue;',
  '          var v2;',
  '          try { v2 = val[kk]; } catch (x) { continue; }',
  '          var r2 = classify(v2);',
  '          if (r2 === "primitive" || r2 === "null") continue;',
  '          res.push({ key: k + "." + kk, realm: r2, escaped: escaped(v2), depth: 2 });',
  '        }',
  '      }',
  '      res.push(rec);',
  '    }',
  '    return res;',
  '  }',
  '  var out = {};',
  '  // ★ 变异源：**宿主侧注入**的真宿主对象（不是从沙箱内 catch 出来的）',
  '  var hostErr = globalThis.__mutantHostError;',
  '  var hostObj = globalThis.__mutantHostObject;',
  '  out.M1 = { realm: classify(hostErr), escaped: escaped(hostErr), props: propScan(hostErr) };',
  '  var e2 = new Error("rebuilt-2");',
  '  e2.original = hostErr;',
  '  out.M2 = { realm: classify(e2), escaped: escaped(e2), props: propScan(e2) };',
  '  var e3 = new Error("rebuilt-3");',
  '  e3.cause = hostErr;',
  '  out.M3 = { realm: classify(e3), escaped: escaped(e3), props: propScan(e3) };',
  '  var e4 = new Error("rebuilt-4");',
  '  e4.meta = { host: hostObj };',
  '  out.M4 = { realm: classify(e4), escaped: escaped(e4), props: propScan(e4) };',
  '  var e5 = new Error("clean");',
  '  out.M5 = { realm: classify(e5), escaped: escaped(e5), props: propScan(e5) };',
  '  // M6：主路径现状（修好后应为 sandbox realm）',
  '  var caught = null;',
  '  try { Buffer.from(-1) } catch (e) { caught = e; }',
  '  out.M6 = { realm: classify(caught), escaped: escaped(caught), props: propScan(caught) };',
  '  return JSON.stringify(out);',
  '})()'
].join('\n')

async function main () {
  const sb = new Sandbox({ id: 'residue-mutant', fetchTimeout: 1000, allowPrivateHosts: true })
  await sb.init('', {})

  // ★ 宿主侧造好真宿主对象，注入沙箱 context。
  //   注意：这本身就是一个「宿主对象进沙箱」的场景 —— 正是我们要检测的形态。
  try {
    sb.context.__mutantHostError = new Error('host-side-error')
    sb.context.__mutantHostObject = { hostField: 'host-value' }
  } catch (e) { /* ignore */ }

  let raw = ''
  try {
    raw = String(sb.run(SANDBOX_SRC, 8000))
  } catch (e) {
    raw = JSON.stringify({ fatal: String(e && e.message || '').slice(0, 200) })
  }
  sb.destroy()
  let data
  try { data = JSON.parse(raw) } catch (e) { data = { fatal: 'parse:' + String(raw).slice(0, 200) } }
  console.log(JSON.stringify(data))
}

main().catch(e => console.log(JSON.stringify({ fatal: 'main:' + String(e && e.message || '').slice(0, 200) })))
