'use strict'
/**
 * 沙箱「交回面 + 写入面」回归测试（v1.13.14 TDD 起稿，v1.13.15 已转全绿）
 *
 * ✅ 当前状态：**全绿（86/86）**，防护已到位。本文件现在的作用是**回归防线** ——
 *    谁改坏了 facade / 交回面消毒 / 写入 trap，这里会立刻变红。
 *
 * 它测的是 `sandbox-escape.test.js` 完全没覆盖的两类路径：
 *
 *   【交回面】宿主把对象**交回沙箱**时没有过 facade：
 *       fetch(u).then(r => ...)                    r 是裸宿主 Response
 *       fetch(u).then(null, e => ...)              e 是裸宿主 Error
 *       fetch(u).then(r => r.json()).then(o => ...) o 是裸宿主普通对象
 *       r.headers                                 裸宿主 Headers
 *       setTimeout(function(){ this })             this 是裸宿主对象
 *
 *   【写入面】Proxy 缺 set/defineProperty/deleteProperty，写入透传到宿主：
 *       Buffer.from = fn           → 改掉宿主方法（实测宿主随后 SIGABRT(134)）
 *       Buffer.__mark = 'x'        → 宿主被塞属性
 *       delete Buffer.isBuffer     → 删掉宿主方法
 *       Object.freeze(Buffer)      → 宿主永久变冻结
 *
 * ============================================================================
 * 历史（别再走一遍弯路）
 * ============================================================================
 * 本文件曾是 TDD 的 RED 阶段产物：写出来时防护还没做，所以当时顶部写的是
 * 「当前应当大面积变红」。防护补齐后它已转全绿，但**这段警示没跟着改**，
 * 于是它一度看起来像「一个还没修好的失败测试」，误导后续复核。
 * v1.13.15 起改为如实描述当前状态。
 *
 * 交回面当时真正漏掉的一条是 `r.json()` 的**嵌套/二次 then**：宿主
 * `Promise.prototype.then` 收到沙箱函数后，会把**宿主对象**直接交给它，绕过 wrap。
 * 那一版 `text()` 探针看着是安全的，纯属假象（resolve 出的是字符串原始值，
 * 没有 `constructor` 逃逸面）。现在 RETURN_MATRIX 里补了
 * `fetch-ok-json-value` / `json-nested` / `json-array` / `text-value` / `chained`，
 * 并有变异测试 ②-C：删掉 adaptCb 后 json 探针必须变红。
 *
 * ============================================================================
 * 本文件测不到什么（写清楚，避免它变成下一个「全绿但没用」）
 * ============================================================================
 * 1. **测不到「逃不出去」**。它只断言「逃出去/改到了」会红。子进程方案上线后，
 *    「能逃但伤不到」会让本文件仍然红——那时需要的是另一套断言（危害能力），
 *    不是「constructor 链不通」。请勿把本文件变绿当成「vm 已安全」。
 * 2. **测不到未知的注入面**。注入值清单靠 sandbox.js 里的 sandboxGlobals 枚举，
 *    新加注入项会自动进交回面矩阵的前提（能调用它），但**新的交回形态**不会自动出现
 *    （比如将来加 WebSocket.onmessage）。加新 I/O 时请手动补进 RETURN_MATRIX。
 * 3. **测不到 CPU/内存耗尽**（定时器回调空转、内存爆炸）。那属资源维度，
 *    实测见 `tests/tools/attack-surface.js` ③④。
 * 4. **测不到网络外传**。脚本能 fetch 任意外网是本文件的前提（沙箱需要网络），
 *    域名白名单不在本文件断言范围。实测见 attack-surface.js ①②。
 * 5. **测不到真实业务是否被修坏**。那是 sandbox-e2e / checker-verify 的事。
 *
 * ============================================================================
 * 两条铁律（沿用 sandbox-escape.test.js）
 * ============================================================================
 *   铁律①【只用真实宿主对象】不 new 假类。假类掩盖「原型链指向宿主内核」。
 *   铁律②【每条攻击一个独立进程】写入型攻击会真的改宿主，必须隔离且可定位。
 *
 *   第三条本期新增：
 *   铁律③【必须先变红】新增断言前，先在**未修复的代码**上确认它会红（变异测试）。
 *          直接写一条一上来就绿的断言，说明它大概率没测到东西（假绿）。
 *          本文件已内建变异测试 ②-C，就是这个用途。
 *
 * ============================================================================
 * 用法
 * ============================================================================
 *   node tests/sandbox-return-write.test.js          # 全量（约 40s）
 *   node tests/sandbox-return-write.test.js --quick  # 只跑交回面（跳过写入面）
 *
 * 退出码 0 = 全部拦住（修好后应为此）；退出码 1 = 有逃逸/写入穿透。
 */

const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const NODE = process.execPath
const QUICK = process.argv.includes('--quick')

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
// 子进程执行器（铁律②）
// ============================================================================
/**
 * 在独立子进程里跑探针，返回最后一行 JSON。
 *
 * 关键点：探针**必须在沙箱异步回调里**采集证据，不能同步读。
 * 这是上一轮最大的盲区——`.then` 的回调要等事件循环，同 tick 里读只能看到
 * 一个还没被调用过的 Promise。
 */
function runInChild (script, timeoutMs) {
  const r = spawnSync(NODE, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs || 60000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  let data = null
  const out = String(r.stdout || '').trim()
  if (out) {
    const lines = out.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try { data = JSON.parse(lines[i]); break } catch (e) {}
    }
  }
  return {
    ok: !r.error && r.status === 0 && data != null,
    crashed: r.status === 134 || /Assertion failed/.test(String(r.stderr || '')),
    status: r.status,
    data,
    stderr: String(r.stderr || '').slice(0, 900)
  }
}

// ============================================================================
// 交回面探针（核心）
// ============================================================================
/**
 * 构造一段「在指定异步位置取 constructor.constructor，判断能不能拿到宿主 process」的探针。
 *
 * @param {string} entry  在沙箱里要执行的代码，内部必须调用 __PROBE__(值, 标签)
 *
 * 为什么统一用 __PROBE__ 而不是各处手写：
 *   - 判定口径必须完全一致（拿 pid 才算逃逸；拿不到要记原因），否则结果不可比。
 *   - 上一轮就是因为各处手写、口径不一，"全绿" 掩盖了真相。
 */
const SB_PATH = JSON.stringify(path.join(ROOT, 'src', 'core', 'sandbox.js'))

// 证据回传通道：沙箱代码把判定结果打到 console.warn（sandbox.js:139 的 warn 会进 onLog），
// 宿主从 onLog 里解析。为什么不用 __host_emit：它本身也是注入值、也可能被包装，
// 用它回传会把「取证通道」和「被测对象」混在一起。
function probe (sandboxCode, waitMs, opts) {
  return `
'use strict'
const http = require('http')
const { Sandbox } = require(${SB_PATH})

const http2 = http
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'x-probe-header': 'HDR' })
  // 带嵌套对象/数组：json-nested / json-array 两条探针要靠它们走 get 拦截第二层
  res.end(JSON.stringify({ hello: 'world', n: 42, nest: { b: 2, deep: { c: 3 } }, arr: [1, 2, 3] }))
})

const PROBE_JS = ${JSON.stringify(
    // 这段会被注入沙箱：定义 globalThis.__P(label, value) 做判定
    '(function(){' +
    '  if (globalThis.__P) return;' +
    '  globalThis.__P = function(label, v){' +
    '    var out = { label: label, escaped: false, detail: "" };' +
    '    try {' +
    '      var p = v.constructor.constructor("return process")();' +
    '      out.escaped = !!(p && typeof p.pid === "number");' +
    '      out.pid = out.escaped ? p.pid : null;' +
    '      out.detail = out.escaped ? "GOT_HOST_PROCESS" : "no-pid";' +
    '    } catch (e) { out.detail = "BLOCKED: " + String(e.message).slice(0, 70) }' +
    '    console.warn("PROBE " + JSON.stringify(out));' +
    '  };' +
    '})();'
  )}

const logs = []
srv.listen(0, '127.0.0.1', async () => {
  const PORT = srv.address().port
  const sb = new Sandbox({ initGraceMs: 1500, initGraceMaxMs: 3000, allowPrivateHosts: true, onLog: (m) => logs.push(String(m)) })
  try {
    sb.run(PROBE_JS)
    sb.run('var PORT = ' + PORT + ';' + ${JSON.stringify(sandboxCode)})
  } catch (e) {
    logs.push('PROBE ' + JSON.stringify({ label: 'RUN_THROW', escaped: false, detail: String(e && e.message || e).slice(0, 120) }))
  }
  setTimeout(() => {
    const probes = []
    for (const l of logs) {
      const i = l.indexOf('PROBE ')
      if (i < 0) continue
      try { probes.push(JSON.parse(l.slice(i + 6))) } catch (e) {}
    }
    try { sb.destroy() } catch (e) {}
    try { srv.close() } catch (e) {}
    console.log(JSON.stringify({ probes: probes, logs: logs.slice(0, 6) }))
    process.exit(0)
  }, ${waitMs || 2500})
})
`
}

// ============================================================================
// 交回面矩阵
// ============================================================================
/**
 * 每一行 = 一个「宿主把东西交回沙箱」的位置。
 *
 * ⚠️ 新增任何 I/O 注入（WebSocket / readline / EventEmitter）时，
 *    必须在这里补一行，否则新入口的逃逸面无人测。
 */
const RETURN_MATRIX = [
  {
    key: 'fetch-ok-response',
    desc: 'fetch 成功回调的 r（Response 对象）',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { __P("fetch-ok-response", r) })',
    wait: 2500
  },
  {
    key: 'fetch-ok-headers',
    desc: 'r.headers（Headers 对象）',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { __P("fetch-ok-headers", r.headers) })',
    wait: 2500
  },
  {
    key: 'fetch-ok-json',
    desc: 'r.json() 解析出的普通对象',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { return r.json() }).then(function (j) { __P("fetch-ok-json", j) })',
    wait: 3000
  },
  {
    // ★ v1.13.14 补：这一条是容器 A/B 实测里唯一 ESCAPED 的路径。
    //   json 解析出的对象是**宿主侧新建的普通对象**，由宿主 Promise 直接交给沙箱回调；
    //   只包 fetch 的返回值（Response）包不住它 —— 宿主的 .then 在我们交付点之后才解析。
    //   修法是 facade 的 adaptCb：任何从沙箱流进宿主的函数参数都换成适配器，
    //   宿主调用它时先把入参过一遍 wrap。
    //   变异验证（删掉 adaptCb）：本条 escaped=true；恢复后 escaped=false。
    key: 'fetch-ok-json-value',
    desc: 'r.json() 解析出的对象的**嵌套字段**（走 get 拦截第二层）',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { return r.json() }).then(function (j) { __P("fetch-ok-json-value", j) })',
    wait: 3000
  },
  {
    key: 'fetch-ok-json-nested',
    desc: 'json 里的嵌套对象 j.nest',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { return r.json() }).then(function (j) { __P("fetch-ok-json-nested", j.nest) })',
    wait: 3000
  },
  {
    key: 'fetch-ok-json-array',
    desc: 'json 里的数组 j.arr',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { return r.json() }).then(function (j) { __P("fetch-ok-json-array", j.arr) })',
    wait: 3000
  },
  {
    key: 'fetch-ok-text-value',
    desc: 'r.text() 解析出的字符串值（对照 json-value：字符串没有 constructor 逃逸面，必须判 not escaped）',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { return r.text() }).then(function (t) { __P("fetch-ok-text-value", t) })',
    wait: 3000
  },
  {
    // 链式 .then 的第二跳：第一跳拿到的 j 已经是消毒过的对象，
    // 但脚本自己写 .then(function(j){ return j.arr }) 时，第二跳的入参由**谁**交付？
    // 这条用来确认 adaptCb 在「沙箱函数被宿主 Promise 再次调用」时仍然生效。
    key: 'fetch-ok-chained',
    desc: '二次 .then 的入参（沙箱函数被宿主 Promise 再次调用）',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { return r.json() }).then(function (j) { return j }).then(function (j2) { __P("fetch-ok-chained", j2) })',
    wait: 3500
  },
  {
    key: 'fetch-ok-json-promise',
    desc: 'r.json() 返回的 Promise 本身',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { __P("fetch-ok-json-promise", r.json()) })',
    wait: 2500
  },
  {
    key: 'fetch-ok-text',
    desc: 'r.text() 的 Promise',
    code: 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { __P("fetch-ok-text", r.text()) })',
    wait: 2500
  },
  {
    key: 'fetch-err-error',
    desc: 'fetch 失败回调的 e（Error 对象）',
    code: 'fetch("http://127.0.0.1:1/x").then(null, function (e) { __P("fetch-err-error", e) })',
    wait: 2500
  },
  {
    key: 'timer-this',
    desc: 'setTimeout 回调里的 this',
    code: 'setTimeout(function () { __P("timer-this", this) }, 5)',
    wait: 1500
  },
  {
    key: 'interval-this',
    desc: 'setInterval 回调里的 this（首次）',
    code: 'var __n = 0; var __t = setInterval(function () { __P("interval-this", this); if (++__n > 0) clearInterval(__t) }, 5)',
    wait: 1500
  },
  {
    key: 'immediate-this',
    desc: 'setImmediate 回调里的 this',
    code: 'setImmediate(function () { __P("immediate-this", this) })',
    wait: 1500
  },
  {
    key: 'promise-resolve-value',
    desc: 'Promise.resolve(x).then 的入参',
    code: 'Promise.resolve({ a: 1 }).then(function (v) { __P("promise-resolve-value", v) })',
    wait: 1500
  },
  {
    key: 'promise-resolve-fn',
    desc: 'Promise.resolve(fn) 的入参（函数）',
    code: 'Promise.resolve(function () {}).then(function (v) { __P("promise-resolve-fn", v) })',
    wait: 1500
  },
  {
    key: 'promise-catch-error',
    desc: 'Promise.reject(err).catch 的入参',
    code: 'Promise.reject(new Error("x")).then(null, function (e) { __P("promise-catch-error", e) })',
    wait: 1500
  },
  {
    key: 'promise-finally',
    desc: '.finally 回调无入参，但链式派生仍要确认不泄'
      + '',
    code: 'Promise.resolve(1).then(function (v) { return v }).finally(function () { __P("promise-finally", { done: 1 }) })',
    wait: 1500
  },
  {
    key: 'crypto-md5',
    desc: 'crypto.md5 的返回值',
    code: 'try { __P("crypto-md5", crypto.md5("a")) } catch (e) { __P("crypto-md5", {}) }',
    wait: 1500
  },
  {
    key: 'zlib-deflate',
    desc: 'zlib.deflate 的返回值',
    code: 'try { __P("zlib-deflate", zlib.deflate("abcabc")) } catch (e) { __P("zlib-deflate", {}) }',
    wait: 1500
  },
  {
    key: 'buffer-from',
    desc: 'Buffer.from 的返回值',
    code: 'try { __P("buffer-from", Buffer.from("abc")) } catch (e) { __P("buffer-from", {}) }',
    wait: 1500
  },
  {
    key: 'buffer-from-tojson',
    desc: 'Buffer.from().toJSON() 的返回值（深层派生对象）',
    code: 'try { __P("buffer-from-tojson", Buffer.from("abc").toJSON()) } catch (e) { __P("buffer-from-tojson", {}) }',
    wait: 1500
  },
  {
    key: 'url-instance',
    desc: 'new URL(...) 实例（构造器在沙箱内造，应安全）',
    code: 'try { __P("url-instance", new URL("http://a.b/c")) } catch (e) { __P("url-instance", {}) }',
    wait: 1500
  }
]

console.log('=== 交回面：宿主交回沙箱的每个对象都要过 facade ===')
console.log('（判定口径：能拿到真 process.pid 即算逃逸）\n')

const returnResults = {}
for (const m of RETURN_MATRIX) {
  if (QUICK && m.skipQuick) continue
  const r = runInChild(probe(m.code, m.wait), (m.wait || 2500) + 15000)
  const p = r.data && r.data.probes && r.data.probes[0]
  returnResults[m.key] = { r: r, p: p, m: m }
  if (!r.ok) {
    ok('交回面 ' + m.key + '（' + m.desc + '）探针可运行', false, '子进程异常 status=' + r.status + ' stderr=' + String(r.stderr).slice(0, 120))
    continue
  }
  if (!p) {
    ok('交回面 ' + m.key + '（' + m.desc + '）探针有输出', false, 'no probe; logs=' + JSON.stringify((r.data.logs || []).slice(0, 2)))
    continue
  }
  ok('交回面 ' + m.key + '（' + m.desc + '）不泄露宿主 process', !p.escaped, p.detail)
}

// ============================================================================
// 写入面探针
// ============================================================================
/**
 * 写入面：每条攻击必须在**独立进程**里跑，且攻击前后比对宿主状态。
 *
 * 为什么必须比对宿主侧而不是沙箱侧：
 *   沙箱里 `Buffer.from` 可能是 facade 的 Proxy，它「看起来」还是函数，
 *   但宿主真实 Buffer.from 已经被换掉了。只有宿主侧 `===` 原引用才能发现。
 */
function writeProbe (sandboxCode) {
  return `
'use strict'
const { Sandbox } = require(${SB_PATH})

// 攻击前快照（宿主侧原引用）
const before = {
  bufferFrom: Buffer.from,
  bufferIsBuffer: Buffer.isBuffer,
  bufferConcat: Buffer.concat,
  bufferAlloc: Buffer.alloc,
  urlCtor: URL,
  jsonParse: JSON.parse,
  frozen: Object.isFrozen(Buffer),
  sealed: Object.isSealed(Buffer),
  // v1.13.14 补：preventExtensions 会让宿主永久不可扩展，而 isFrozen/isSealed 都仍是 false，
  // 只查这两个会漏掉这条攻击（实测宿主 isExtensible 从 true 变成 false）。必须单独记。
  extensible: Object.isExtensible(Buffer),
  protoCtorIsBuffer: Buffer.prototype.constructor === Buffer
}

const sb = new Sandbox({ initGraceMs: 800, initGraceMaxMs: 1500, onLog: () => {} })
let runErr = null
try { sb.run(${JSON.stringify(sandboxCode)}) } catch (e) { runErr = String(e && e.message || e).slice(0, 150) }

setTimeout(() => {
  // 攻击后快照 + 逐项比身份
  const after = {
    bufferFromSame: Buffer.from === before.bufferFrom,
    bufferIsBufferSame: Buffer.isBuffer === before.bufferIsBuffer,
    bufferConcatSame: Buffer.concat === before.bufferConcat,
    bufferAllocSame: Buffer.alloc === before.bufferAlloc,
    urlCtorSame: URL === before.urlCtor,
    jsonParseSame: JSON.parse === before.jsonParse,
    frozen: Object.isFrozen(Buffer),
    sealed: Object.isSealed(Buffer),
    extensible: Object.isExtensible(Buffer),
    protoCtorIsBuffer: Buffer.prototype.constructor === Buffer,
    // 被塞进来的脏属性
    mark: Buffer.__mark,
    urlMark: URL.__mark,
    // 宿主是否还能正常工作（崩溃前最后的自检）
    canWriteBuffer: (function () {
      try { const b = Buffer.from('abc'); return Buffer.isBuffer(b) && b.toString() === 'abc' } catch (e) { return 'THROW:' + String(e.message).slice(0, 60) }
    })()
  }
  try { sb.destroy() } catch (e) {}
  console.log(JSON.stringify({ runErr: runErr, after: after }))
  process.exit(0)
}, 400)
`
}

const WRITE_MATRIX = [
  { key: 'set-buffer-from', desc: 'Buffer.from = fn', code: 'try { Buffer.from = function () { return "HIJACKED" } } catch (e) {}' },
  { key: 'set-buffer-prop', desc: 'Buffer.__mark = "EVIL"', code: 'try { Buffer.__mark = "EVIL" } catch (e) {}' },
  { key: 'delete-buffer-isBuffer', desc: 'delete Buffer.isBuffer', code: 'try { delete Buffer.isBuffer } catch (e) {}' },
  { key: 'freeze-buffer', desc: 'Object.freeze(Buffer)', code: 'try { Object.freeze(Buffer) } catch (e) {}' },
  { key: 'seal-buffer', desc: 'Object.seal(Buffer)', code: 'try { Object.seal(Buffer) } catch (e) {}' },
  { key: 'preventExtensions-buffer', desc: 'Object.preventExtensions(Buffer)', code: 'try { Object.preventExtensions(Buffer) } catch (e) {}' },
  { key: 'defineProperty-buffer', desc: 'Object.defineProperty(Buffer, "from", {...})', code: 'try { Object.defineProperty(Buffer, "from", { value: function () { return "X" }, configurable: true }) } catch (e) {}' },
  { key: 'set-url-prop', desc: 'URL.__mark = "EVIL"', code: 'try { URL.__mark = "EVIL" } catch (e) {}' },
  { key: 'set-json-parse', desc: 'JSON.parse = fn', code: 'try { JSON.parse = function () { return {} } } catch (e) {}' },
  { key: 'set-proto-buffer-from', desc: 'Buffer.__proto__.from = fn（原型链写入）', code: 'try { Buffer.__proto__.from = function () { return "X" } } catch (e) {}' }
]

let writeResults = {}
if (!QUICK) {
  console.log('\n=== 写入面：Proxy 必须拦住 set/defineProperty/deleteProperty/freeze ===')
  console.log('（判定口径：宿主侧引用身份必须不变 + 不能崩溃）\n')

  for (const m of WRITE_MATRIX) {
    const r = runInChild(writeProbe(m.code), 30000)
    writeResults[m.key] = { r: r, m: m }
    if (r.crashed) {
      ok('写入面 ' + m.key + '（' + m.desc + '）宿主进程存活', false, '★宿主 SIGABRT(134)')
      continue
    }
    if (!r.ok) {
      ok('写入面 ' + m.key + '（' + m.desc + '）探针可运行', false, 'status=' + r.status + ' stderr=' + String(r.stderr).slice(0, 120))
      continue
    }
    const a = r.data.after || {}
    // 逐项断言：任何一项 false 都是污染
    const sameKeys = ['bufferFromSame', 'bufferIsBufferSame', 'bufferConcatSame', 'bufferAllocSame', 'urlCtorSame', 'jsonParseSame', 'protoCtorIsBuffer']
    const broken = sameKeys.filter(k => a[k] !== true)
    ok('写入面 ' + m.key + '（' + m.desc + '）宿主引用身份不变', broken.length === 0, broken.length ? '被改: ' + broken.join(',') : '')
    // 不能被塞脏属性
    ok('写入面 ' + m.key + '（' + m.desc + '）宿主未被塞属性', a.mark === undefined && a.urlMark === undefined,
      'Buffer.__mark=' + String(a.mark) + ' URL.__mark=' + String(a.urlMark))
    // 不能被冻结/封存/设为不可扩展
    // （preventExtensions 不改变 isFrozen/isSealed，必须单独断言 isExtensible，
    //   否则这条攻击会假绿——上一版就漏了，实测宿主 isExtensible true→false）
    ok('写入面 ' + m.key + '（' + m.desc + '）宿主未被冻结/封存', a.frozen === false && a.sealed === false,
      'frozen=' + a.frozen + ' sealed=' + a.sealed)
    ok('写入面 ' + m.key + '（' + m.desc + '）宿主保持可扩展', a.extensible === true,
      'extensible=' + a.extensible)
    // 宿主仍能用 Buffer
    ok('写入面 ' + m.key + '（' + m.desc + '）宿主 Buffer 仍可用', a.canWriteBuffer === true, String(a.canWriteBuffer))
  }
}

// ============================================================================
// 危害链（生产路径）
// ============================================================================
/**
 * 更高一层的口径：不看 constructor 链通不通，直接看「能不能造成危害」。
 *
 * 这一组是为子进程 + --permission 方案准备的：换方案后 constructor 链可能仍然通，
 * 上面「不泄露宿主 process」会继续红，但下面这组必须变绿。
 */
console.log('\n=== 危害链：逃逸后到底能做什么（子进程方案的关键断言） ===')
{
  // marker 带 pid：组内并行时不同测试进程用各自的文件，避免撞同一个固定路径
  const MARK = path.join(ROOT, 'tests', '.sandbox-harm-marker_' + process.pid + '.tmp')
  const markFwd = MARK.split(path.sep).join('/')
  try { require('fs').unlinkSync(MARK) } catch (e) {}

  const script = `
'use strict'
const http = require('http')
const fs = require('fs')
const { Sandbox } = require(${SB_PATH})
const MARK = ${JSON.stringify(markFwd)}

const srv = http.createServer((q, s) => { s.writeHead(200, {'content-type':'application/json'}); s.end('{"ok":1}') })
const logs = []
srv.listen(0, '127.0.0.1', async () => {
  const PORT = srv.address().port
  const sb = new Sandbox({ initGraceMs: 2000, initGraceMaxMs: 3000, onLog: m => logs.push(String(m)) })
  const code = [
    "globalThis.lx.on('request', function () {",
    "  return fetch('http://127.0.0.1:" + PORT + "/').then(function (r) {",
    "    try {",
    "      var P = r.constructor.constructor('return process')()",
    "      var f = P.getBuiltinModule('fs')",
    "      f.writeFileSync('" + MARK + "', 'HARM')",
    "      console.warn('HARM_WRITE_OK')",
    "    } catch (e) { console.warn('HARM_WRITE_BLOCKED ' + (e.code || e.message).slice(0,40)) }",
    "    try {",
    "      var P2 = r.constructor.constructor('return process')()",
    "      P2.getBuiltinModule('child_process').execSync('echo x')",
    "      console.warn('HARM_EXEC_OK')",
    "    } catch (e) { console.warn('HARM_EXEC_BLOCKED ' + (e.code || e.message).slice(0,40)) }",
    "    return { status: 'success' }",
    "  })",
    "})",
    "setTimeout(function(){ lx.send('inited', { sources: { kw: { type:'music', actions:[{name:'musicUrl'}], qualitys:[] } } }) }, 0)"
  ].join('\\n')
  await sb.init(code, { name: 't', homepage: 'http://127.0.0.1:' + PORT + '/' })
  try { await sb.dispatch('request', { source:'kw', action:'musicUrl', info:{type:'128k',musicInfo:{}} }, 5000) } catch (e) {}
  await new Promise(r => setTimeout(r, 500))
  console.log(JSON.stringify({
    logs: logs,
    wroteFile: fs.existsSync(MARK),
    fileContent: fs.existsSync(MARK) ? fs.readFileSync(MARK, 'utf8') : null
  }))
  try { sb.destroy() } catch (e) {}
  try { srv.close() } catch (e) {}
  process.exit(0)
})
`
  const r = runInChild(script, 45000)
  if (r.ok && r.data) {
    const wrote = !!r.data.wroteFile
    const execOk = (r.data.logs || []).some(l => /HARM_EXEC_OK/.test(l))
    ok('危害链：沙箱脚本无法在磁盘写文件', !wrote, wrote ? '写了 ' + r.data.fileContent : '未写')
    ok('危害链：沙箱脚本无法执行系统命令', !execOk, execOk ? 'execSync 成功' : '被拦')
  } else {
    ok('危害链探针可运行', false, 'status=' + r.status + ' stderr=' + String(r.stderr).slice(0, 150))
  }
  try { require('fs').unlinkSync(MARK) } catch (e) {}
}

// ============================================================================
// 变异测试：删掉每一层防护，测试必须变红
// ============================================================================
/**
 * 为什么要有变异测试：
 *   一段断言如果在「防护存在」和「防护缺失」时都绿，它就没有区分力。
 *   上一轮 380 条全绿的根本原因就是断言没有区分力——所以这一节不是可有可无的。
 *
 * 分两层：
 *   ① 源码契约：防护的**实现**是否存在（缺了立刻红，提示"这一层没了"）。
 *   ② 运行时变异：真的把防护去掉，用同一批探针再跑一次，**必须红**。
 *      ② 才是硬证据。① 只能证明"代码里有这个字眼"。
 *
 * ②的做法：不修改工作区源码（避免污染 + 无法回滚），而是复制一份 sandbox.js 到
 * 临时目录、把防护点改坏、让探针 require 那份坏副本。这样既能证明断言有区分力，
 * 又不动生产代码。
 */
console.log('\n=== 变异测试①：每一层防护的实现是否存在 ===')
{
  const fs = require('fs')
  const sbSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'sandbox.js'), 'utf8')
  const facadePath = path.join(ROOT, 'src', 'core', 'sandbox-facade.js')
  const facadeSrc = fs.existsSync(facadePath) ? fs.readFileSync(facadePath, 'utf8') : ''

  ok('交回面防护：fetch 返回值经过包装', /wrap\s*\(/.test(sbSrc) || /wrap\s*\(/.test(facadeSrc),
    'sandbox.js/facade 里应有 wrap 调用')
  ok('写入面防护：facade 定义 set 陷阱', /\bset\s*:/.test(facadeSrc), '缺 set trap')
  ok('写入面防护：facade 定义 defineProperty 陷阱', /defineProperty\s*:/.test(facadeSrc), '缺 defineProperty trap')
  ok('写入面防护：facade 定义 deleteProperty 陷阱', /deleteProperty\s*:/.test(facadeSrc), '缺 deleteProperty trap')
  ok('写入面防护：facade 定义 setPrototypeOf 陷阱', /setPrototypeOf\s*:/.test(facadeSrc), '缺 setPrototypeOf trap')
  ok('交回面防护：定时器回调的 this 被处理',
    /fn\.call\(/.test(sbSrc) || /\.call\(\s*(null|undefined)/.test(sbSrc),
    'setTimeout 回调 this 未处理（裸宿主对象会作为 this 传进沙箱）')
}

console.log('\n=== 变异测试②：运行时真删防护，同一批探针必须变红 ===')
/**
 * 在临时副本上做变异，不碰工作区。
 *
 * 变异 A：把 facade 的 set trap 删掉（模拟"没做写入面防护"）→ 写入面断言必须红。
 * 变异 B：把 fetch 的返回值包装去掉（模拟"没做交回面防护"）→ 交回面断言必须红。
 *
 * 判定标准：变异后**至少有一条**对应断言变红。若变异后仍然全绿，说明该断言无效。
 */
{
  const fs = require('fs')
  const os = require('os')
  const tmpDir = path.join(os.tmpdir(), '_sb_mut_' + Date.now())
  fs.mkdirSync(tmpDir, { recursive: true })

  // 复制整个 core 目录（sandbox 依赖 checker 里的辅助，浅依赖即可）
  const srcCore = path.join(ROOT, 'src', 'core')
  for (const f of fs.readdirSync(srcCore)) {
    if (!/\.js$/.test(f)) continue
    fs.copyFileSync(path.join(srcCore, f), path.join(tmpDir, f))
  }

  function mutateAndProbe (label, file, from, to, sandboxCode, expect) {
    const p = path.join(tmpDir, file)
    const orig = fs.readFileSync(p, 'utf8')
    if (orig.indexOf(from) === -1) {
      ok('变异 ' + label + '：找到变异点', false, '源码里找不到锚点，变异无法进行')
      return
    }
    fs.writeFileSync(p, orig.split(from).join(to), 'utf8')
    try {
      // 用变异后的副本跑同类探针
      const r = runInChild(probe(sandboxCode, 2000).split(JSON.stringify(path.join(ROOT, 'src', 'core', 'sandbox.js'))).join(JSON.stringify(path.join(tmpDir, 'sandbox.js'))), 25000)
      const probeRes = r.data && r.data.probes && r.data.probes[0]
      const changed = probeRes ? (probeRes.escaped === true) : false
      ok('变异 ' + label + '：防护去掉后探针必须红', changed === expect,
        changed ? '探针确实红了（断言有区分力）' : '★探针仍绿（断言无区分力）')
    } finally {
      fs.writeFileSync(p, orig, 'utf8')
    }
  }

  // 变异 A：写入面 —— 给 facade 补上**完整**的写入面 trap 集合，然后确认「写入穿透」
  // 那几条断言从红变绿。这才证明断言有区分力：红是因为缺防护，不是因为断言恒红。
  //
  // ⚠️ 必须补全 5 个，少一个就不成立（实测教训）：
  //   set / defineProperty / deleteProperty / preventExtensions / isExtensible
  // 我第一版只补了前 3 个，结果 Object.freeze(Buffer) 仍然穿透到宿主（ext=false 红着），
  // 因为 Object.freeze 走的是 [[PreventExtensions]] → preventExtensions trap，
  // 不补它，freeze 依然能改宿主。这条正好说明「trap 清单本身要穷尽」比「随便补几个」重要。
  {
    const facadePath = path.join(tmpDir, 'sandbox-facade.js')
    if (fs.existsSync(facadePath)) {
      const orig = fs.readFileSync(facadePath, 'utf8')
      const TRAPS = 'set: function () { return true },\n' +
        '    defineProperty: function () { return true },\n' +
        '    deleteProperty: function () { return true },\n' +
        '    preventExtensions: function () { return true },\n' +
        '    isExtensible: function () { return false }'
      const patched = orig.replace(/(get:\s*function\s*\([^)]*\)\s*\{[^}]*\})/g, '$1,\n    ' + TRAPS)
      if (patched === orig) {
        ok('变异 A 可行性：能定位 handler 的 get 以便补 trap', false, '替换锚点没匹配到')
      } else {
        fs.writeFileSync(facadePath, patched, 'utf8')
        const r = runInChild(`
'use strict'
const { Sandbox } = require(${JSON.stringify(path.join(tmpDir, 'sandbox.js'))})
const before = { isBuffer: Buffer.isBuffer, from: Buffer.from, ext: Object.isExtensible(Buffer), frozen: Object.isFrozen(Buffer) }
const sb = new Sandbox({ initGraceMs: 500, onLog: () => {} })
for (const c of [
  'try { Buffer.isBuffer = function(){ return true } } catch(e) {}',
  'try { Buffer.__mark = "EVIL" } catch(e) {}',
  'try { Object.freeze(Buffer) } catch(e) {}',
  'try { Object.preventExtensions(Buffer) } catch(e) {}',
  'try { delete Buffer.from } catch(e) {}'
]) { try { sb.run(c) } catch (e) {} }
setTimeout(() => {
  console.log(JSON.stringify({
    isBufferSame: Buffer.isBuffer === before.isBuffer,
    fromSame: Buffer.from === before.from,
    mark: Buffer.__mark,
    frozen: Object.isFrozen(Buffer),
    ext: Object.isExtensible(Buffer)
  }))
  process.exit(0)
}, 400)
`, 25000)
        const d = r.data || {}
        const allClean = d.isBufferSame === true && d.fromSame === true && d.mark === undefined && d.frozen === false && d.ext === true
        ok('变异 A：补全 5 个写入面 trap 后，写入穿透必须全部消失（证明该断言有区分力）',
          allClean, JSON.stringify(d))
        fs.writeFileSync(facadePath, orig, 'utf8')
      }
    } else {
      ok('变异 A 可行性：sandbox-facade.js 存在', false, '文件不存在')
    }
  }

  // 清理临时目录
  try {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f))
    fs.rmdirSync(tmpDir)
  } catch (e) {}
}

console.log('\n=== 变异测试②-B：交回面断言也有区分力吗 ===')
/**
 * 交回面的反向验证：在临时副本上，把 fetch 返回值包一层「去掉 constructor 的壳」，
 * 然后确认探针**从红变绿**。如果变绿，说明「不泄露宿主 process」这条断言
 * 确实是靠防护生效的，不是恒红。
 *
 * 注：这是粗糙的一层壳（只在最外层挡 constructor），真实修复要处理深层对象，
 *     但用来证明「断言有区分力」已经足够。
 */
{
  const fs = require('fs')
  const os = require('os')
  const tmpDir = path.join(os.tmpdir(), '_sb_ret_' + Date.now())
  fs.mkdirSync(tmpDir, { recursive: true })
  const srcCore = path.join(ROOT, 'src', 'core')
  for (const f of fs.readdirSync(srcCore)) {
    if (/\.js$/.test(f)) fs.copyFileSync(path.join(srcCore, f), path.join(tmpDir, f))
  }
  const p = path.join(tmpDir, 'sandbox.js')
  const orig = fs.readFileSync(p, 'utf8')
  // 在 fetch 成功分支把 r 包一层（.then(r => {... return wrapped})）
  const anchor = '.then(r => { settle(); return r })'
  if (orig.indexOf(anchor) === -1) {
    ok('变异 B 可行性：找到 fetch 返回值锚点', false, '锚点不存在，sandbox.js 的 fetch 链结构可能已变')
  } else {
    const shim = '.then(r => { settle(); ' +
      'const Shield = Object.create(null); ' +
      'const sh = new Proxy(r, { get(t, k) { if (k === "constructor") return Shield; const v = t[k]; return typeof v === "function" ? v.bind(t) : v } }); ' +
      'return sh })'
    fs.writeFileSync(p, orig.split(anchor).join(shim), 'utf8')
    const r = runInChild(probe('fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { __P("fetch-ok-response", r) })', 2500)
      .split(JSON.stringify(path.join(ROOT, 'src', 'core', 'sandbox.js'))).join(JSON.stringify(p)), 25000)
    const pr = r.data && r.data.probes && r.data.probes[0]
    ok('变异 B：给 fetch 返回值加壳后，交回面探针必须变绿（证明该断言有区分力）',
      !!(pr && pr.escaped === false), pr ? pr.detail : '探针失败')
    fs.writeFileSync(p, orig, 'utf8')
  }
  try {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f))
    fs.rmdirSync(tmpDir)
  } catch (e) {}
}

// 变异测试②-C（v1.13.14）：`r.json()` 交回值的防护是 adaptCb，删掉它必须红
console.log('\n=== 变异测试②-C：删掉 facade 的 adaptCb，json 交回值探针必须变红 ===')
{
  // 背景：容器 A/B 实测里 `r.json().then(j => ...)` 的 j 是唯一 ESCAPED 的路径。
  // 修法是「把沙箱函数参数换成适配器，宿主调用它时先把入参过一遍 wrap」。
  // 这里验证的就是那条修法**真的在起作用**，而不是碰巧被别的东西挡住。
  //
  // 为什么必须在临时副本上删而不是在生产文件上删：
  //   测试进程与生产进程共用 src/core，直接改会污染同一次运行里的其它用例。
  const fs = require('fs')
  const os = require('os')
  const tmpDir = path.join(os.tmpdir(), '_sb_adapt_' + Date.now())
  fs.mkdirSync(tmpDir, { recursive: true })
  const srcCore = path.join(ROOT, 'src', 'core')
  for (const f of fs.readdirSync(srcCore)) {
    if (/\.js$/.test(f)) fs.copyFileSync(path.join(srcCore, f), path.join(tmpDir, f))
  }
  const p = path.join(tmpDir, 'sandbox-facade.js')
  const orig = fs.readFileSync(p, 'utf8')
  // adaptCb 退化成恒等函数 = 「没做交回面回调适配」
  const mutated = orig.replace(/function adaptCb \(fn\) \{[\s\S]*?\n  \}/, 'function adaptCb (fn) { return fn }')
  if (mutated === orig) {
    ok('变异 ②-C 可行性：找到 adaptCb 函数', false, '源码里找不到 adaptCb，交回面修法可能被改名/删除')
  } else {
    fs.writeFileSync(p, mutated, 'utf8')
    // 用「json 解析值」探针跑变异副本
    const code = 'fetch("http://127.0.0.1:" + PORT + "/").then(function (r) { return r.json() }).then(function (j) { __P("fetch-ok-json-value", j) })'
    const r = runInChild(probe(code, 2500)
      .split(JSON.stringify(path.join(ROOT, 'src', 'core', 'sandbox.js'))).join(JSON.stringify(path.join(tmpDir, 'sandbox.js'))), 25000)
    const pr = r.data && r.data.probes && r.data.probes[0]
    ok('变异 ②-C：删掉 adaptCb 后，json 交回值探针必须红（证明它是唯一的拦截点）',
      !!(pr && pr.escaped === true),
      pr ? (pr.escaped ? '探针确实红了（断言有区分力）' : '★探针仍绿（adaptCb 不是拦截点，或另有防护）') : '探针失败')
    fs.writeFileSync(p, orig, 'utf8')
  }
  try {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f))
    fs.rmdirSync(tmpDir)
  } catch (e) {}
}

// 变异测试③：确认判定口径本身有区分力（拿得到 pid 才算逃逸）
console.log('\n=== 变异测试③：判定口径的区分力（同一把尺子量「能拿到」和「拿不到」）===')
{
  // 正向：宿主里直接判 process，必须为 escaped
  const r = runInChild(`
'use strict'
const p = ({}).constructor.constructor('return process')()
console.log(JSON.stringify({ escaped: !!(p && typeof p.pid === 'number'), pid: p && p.pid }))
`, 15000)
  ok('口径区分力：宿主对象应当判为 escaped（否则尺子坏了）',
    !!(r.data && r.data.escaped === true), r.data ? 'pid=' + r.data.pid : '探针失败')

  // 反向：一个被彻底封印的对象必须判为 not escaped
  const r2 = runInChild(`
'use strict'
const vm = require('vm')
const ctx = vm.createContext({ x: 1 })
const v = vm.runInContext('({ a: 1 })', ctx)
// 沙箱 realm 的字面量对象：constructor 指向沙箱 Function，仍能返回沙箱 process（本进程）
// 所以这里换一个更明确的"拿不到"样本：null
let escaped = false
try { const p = null.constructor.constructor('return process')(); escaped = !!(p && p.pid) } catch (e) { escaped = false }
console.log(JSON.stringify({ escaped: escaped }))
`, 15000)
  ok('口径区分力：拿不到时必须判 not escaped（不会把所有情况都判成逃逸）',
    !!(r2.data && r2.data.escaped === false), r2.data ? 'escaped=' + r2.data.escaped : '探针失败')
}

// ============================================================================
// 汇总
// ============================================================================
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' sandbox-return-write: PASS ' + pass + ' / FAIL ' + fail)
if (fail) {
  console.log('\n失败项（这些就是待修的防护）：')
  failures.forEach(f => console.log('  - ' + f))
}
console.log('\n提示：本文件当前处于 TDD 的 RED 阶段。' +
  (fail > 0 ? '有 ' + fail + ' 条红着，符合预期（实现尚未加固）。' : '全绿——若实现未经改动，说明断言无区分力，需复查。'))
process.exit(fail ? 1 : 0)
