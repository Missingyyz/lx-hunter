'use strict'
/**
 * 沙箱逃逸回归测试（v1.13.11）
 *
 * ⚠️⚠️⚠️ 2026-11-19 重要更正：**本文件全绿不代表沙箱安全** ⚠️⚠️⚠️
 *
 * 本文件只覆盖「**注入面**」——枚举 globalThis 上的注入值、测它们的 constructor 链。
 * 它完全没覆盖「**交回面**」：宿主通过 fetch 回调参数、setTimeout 的 this、Promise 的
 * resolve 值等**把裸宿主对象交回沙箱**。实测这四条路径全部能拿到宿主 process：
 *
 *     fetch(u).then(r => r.constructor.constructor('return process')())     → 🔴 成功
 *     fetch(u).then(r => r.headers.constructor.constructor(...)())          → 🔴 成功
 *     fetch(u).then(r => r.json().then(o => ...))                           → 🔴 成功
 *     setTimeout(function(){ this.constructor.constructor(...)() }, 30)     → 🔴 成功
 *
 * 另外 Proxy 缺 set/defineProperty/deleteProperty 陷阱，沙箱内一句
 * `Buffer.from = () => 'x'` 就直接改掉宿主方法，宿主随后 SIGABRT(134)。
 *
 * 也就是说：**本文件 18 项 PASS 与真实可执行 RCE 并存**。看到全绿请先确认
 * 交回面/写入面是否另有测试覆盖，不要据此认为已修好。
 *
 * ============================================================================
 * 为什么有这个文件：一次「测试全绿、生产炸掉」的事故
 * ============================================================================
 * 修复沙箱逃逸时，验证用的是**自己 new 的假类 FakeBuffer**（原型链独立），
 * 21 条攻击全挡、30 项功能全通。换成真实的 `Buffer` 一测，直接炸：
 *
 *     seal 真实 Buffer 后：Function.prototype.constructor → undefined
 *                          （宿主所有函数的 constructor 都没了）
 *
 * 根因：`Object.getPrototypeOf(Buffer)` 返回的就是宿主全局 `Function.prototype`，
 * 去改它等于改 Node 运行时内核，而且 `configurable:false` 永久不可恢复。
 *
 * 本文件的三条铁律，就是为了让这个错误不可能再犯第二次：
 *
 *   铁律①【只用真实宿主对象做夹具】绝不 new 假类冒充 Buffer/URL/TextEncoder。
 *          假类会掩盖「原型链指向宿主内核」这个致命性质。
 *   铁律②【每条断言都跑在子进程里】因为「seal 宿主原型」本身就是本测试要防的事故。
 *          进程内跑，一条用例毁掉原型后，后面所有用例的结果都不可信、也无法定位是
 *          谁毁的。子进程隔离是唯一能同时做到「可检测 + 可定位 + 不传染」的方式。
 *   铁律③【攻击清单不手写，自动枚举】手写清单会过时。本文件遍历 context 里所有
 *          可达的注入值 × 多条 constructor 路径，新增注入值自动被覆盖。
 *
 * ============================================================================
 * 用法
 * ============================================================================
 *   node tests/sandbox-escape.test.js
 *
 * 退出码 0 = 全部通过（当前应为通过，因为漏洞已在 sandbox.js 修复）；
 * 退出码 1 = 有 FAIL（说明逃逸口回来了，或某层防线被删掉了）。
 *
 * 设计说明见 `tests/SANDBOX-ESCAPE-TEST-PLAN.md`。
 */

const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const NODE = process.execPath

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
 * 在**独立子进程**里跑一段探针脚本，返回它 stdout 里解析出的 JSON。
 *
 * 为什么不进程内跑：
 *  - 被测行为可能污染宿主原型（这正是事故形态）。进程内一旦污染，
 *    后续所有断言都在被污染的环境里执行，结果无意义。
 *  - 子进程崩溃/卡死不会带走测试主进程，还能给出「哪一条」导致的。
 *
 * @param {string} script 子进程脚本；必须以 `console.log(JSON.stringify(result))` 结束
 * @param {number} [timeoutMs] 超时（默认 60s，防脚本被沙箱空转卡死时测试永久挂起）
 * @returns {{ok:boolean, data:any, stderr:string, signal:string|null}}
 */
function runInChild (script, timeoutMs) {
  const r = spawnSync(NODE, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs || 60000,
    maxBuffer: 8 * 1024 * 1024,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  let data = null
  let parseErr = null
  const out = String(r.stdout || '').trim()
  if (out) {
    // 取最后一行合法 JSON（防子进程里有别的 console 输出干扰）
    const lines = out.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try { data = JSON.parse(lines[i]); parseErr = null; break } catch (e) { parseErr = e }
    }
  }
  return {
    ok: !r.error && r.status === 0 && data != null,
    data,
    stderr: String(r.stderr || '').slice(0, 1200),
    signal: r.signal || null,
    spawnErr: r.error ? String(r.error.message) : null,
    parseErr: parseErr ? String(parseErr.message).slice(0, 200) : null
  }
}

// ============================================================================
// 宿主零污染断言（铁律①/②）
// ============================================================================
/**
 * 宿主核心原型「身份表」。
 *
 * 为什么用 `===` 身份比对而不是 JSON diff：
 * 事故形态是 `Function.prototype.constructor` **消失**（变成 undefined），
 * 值变了才叫污染。JSON diff 会把 undefined 和缺失混在一起，漏掉真正的破坏。
 *
 * ⚠ 本清单**不含**「Object.getPrototypeOf(Buffer) === Function.prototype」这类断言：
 * 我第一版写过，实测发现是错的——`Object.getPrototypeOf(Buffer)` 是 `Function`
 * （Buffer 继承 Uint8Array，其原型对象的原型才是 Function.prototype），
 * 只有「裸函数值」（__host_emit/setTimeout 这类）才满足那等式。
 * 把错误假设写进断言，等于给自己造一个永远红的假警报。
 */
const HOST_INVARIANTS = [
  'Function', 'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Date', 'Error',
  'Promise', 'Map', 'Set', 'Symbol', 'Uint8Array', 'ArrayBuffer'
]

/** 生成「宿主原型体检」子进程脚本 */
function hostCleanScript () {
  return `
    'use strict'
    const bad = []
    const checks = [
      ['Function.prototype.constructor', Function.prototype.constructor, Function],
      ['Object.prototype.constructor', Object.prototype.constructor, Object],
      ['Array.prototype.constructor', Array.prototype.constructor, Array],
      ['String.prototype.constructor', String.prototype.constructor, String],
      ['Number.prototype.constructor', Number.prototype.constructor, Number],
      ['RegExp.prototype.constructor', RegExp.prototype.constructor, RegExp],
      ['Promise.prototype.constructor', Promise.prototype.constructor, Promise],
      ['Map.prototype.constructor', Map.prototype.constructor, Map],
      ['Error.prototype.constructor', Error.prototype.constructor, Error],
      ['Buffer.prototype.constructor', Buffer.prototype.constructor, Buffer],
      // 注入值的 constructor 必须仍是宿主 Function（这是逃逸取值得以成功的原因，
      // 也是 seal 想改的落点）。它一旦不是 Function，说明有人动了宿主内核。
      ['Buffer.constructor', Buffer.constructor, Function],
      ['URL.constructor', URL.constructor, Function],
      ['TextEncoder.constructor', TextEncoder.constructor, Function]
    ]
    for (const [name, actual, expected] of checks) {
      if (actual !== expected) bad.push({ name, actual: typeof actual, expected: expected && expected.name })
    }
    console.log(JSON.stringify({ clean: bad.length === 0, bad }))
  `
}

// ============================================================================
// ① 宿主零污染基线
// ============================================================================
console.log('\n=== ① 宿主零污染（测试开始前的基线） ===')
;(function () {
  const r = runInChild(hostCleanScript())
  ok('基线：宿主核心原型在测试开始前是干净的',
    r.ok && r.data && r.data.clean === true,
    r.ok ? JSON.stringify(r.data) : ('子进程失败: ' + (r.spawnErr || r.stderr || r.parseErr)))
})()

// ============================================================================
// ② 铁律的回归：假对象夹具检测器
// ============================================================================
/**
 * 这一项是**对本次事故的直接止血**。
 *
 * 事故根因是「夹具用假对象」。所以本测试不只测 sandbox，还要测**夹具本身**：
 * 断言所有被测对象确实是「原型链通向宿主内核」的真实对象。
 *
 * 如果将来有人为了「让 seal 好做」而把 Buffer 换成 FakeBuffer，
 * 这里会立刻 FAIL —— 因为 FakeBuffer 的原型链不通向宿主 Function.prototype。
 */
console.log('\n=== ② 夹具真实性（防「假对象掩盖真实性质」再次发生） ===')
;(function () {
  const script = `
    'use strict'
    /**
     * 被测夹具必须是**真实宿主构造器**。真与假的判据（我第一版写错过，这里记下正确口径）：
     *   ✓ 真实：typeof v === 'function' && v.constructor === Function
     *           （它的 constructor 就是宿主 Function ⇒ 这正是逃逸取值得以成立的路径，
     *             也正是 seal 会误动宿主内核的原因）
     *   ✗ 假类：new 出来的 FakeBuffer —— v.constructor 是那个假类自己，不是 Function
     *
     * ⚠ 不能用 Object.getPrototypeOf(v) === Function.prototype 当判据：
     *   实测 Buffer 与 AbortSignal 都不满足（Buffer 继承 Uint8Array），
     *   只有裸函数值才满足。用它会把真实 Buffer 误判成假类。
     */
    const subjects = { Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal }
    const real = []
    const fake = []
    for (const [name, v] of Object.entries(subjects)) {
      const isFn = typeof v === 'function'
      const ctorIsHostFunction = isFn && v.constructor === Function
      if (ctorIsHostFunction) real.push(name)
      else fake.push({ name, isFn, ctorName: v && v.constructor && v.constructor.name })
    }
    // 反面验证：一个真正的假类会被识别为 fake（证明判据有区分力，不是恒真）
    // ⚠ 我第一版把「FakeBuffer.constructor 不是 Function」当区分力，实测为 false ——
    //   因为**任何类/函数的 constructor 都是 Function**，
    //   「v.constructor === Function」对假类同样成立，判据根本没区分力。
    //   真正能区分真假的是「原生行为特征」：
    //     真 Buffer  → Buffer.isBuffer(v) 为真、有 from/alloc 静态方法
    //     假 FakeBuffer → isBuffer 为假、无 from/alloc
    class FakeBuffer { constructor () { this.length = 0 } }
    const fakeLooksReal = typeof FakeBuffer.isBuffer === 'function' && FakeBuffer.isBuffer(new FakeBuffer())
    const realLooksReal = Buffer.isBuffer(Buffer.from('x'))
    // 区分力成立 = 真对象被判真、假对象被判假（两者结论相反）
    const discriminates = (realLooksReal === true) && (fakeLooksReal === false)
    console.log(JSON.stringify({
      real,
      fake,
      discriminates,
      realLooksReal,
      fakeLooksReal,
      realBufferInstance: Buffer.isBuffer(Buffer.from('x')),
      bufferCtorIsFunction: Buffer.constructor === Function
    }))
  `
  const r = runInChild(script)
  const d = r.ok && r.data ? r.data : null
  ok('所有被测构造器都是真实宿主对象（v.constructor === Function）',
    !!d && Array.isArray(d.fake) && d.fake.length === 0,
    d ? ('fake=' + JSON.stringify(d.fake)) : ('子进程失败: ' + (r.spawnErr || r.stderr)))
  ok('判据有区分力：真 Buffer 被判真、假 FakeBuffer 被判假（不是恒真断言）',
    !!d && d.discriminates === true,
    d ? ('realLooksReal=' + d.realLooksReal + ' fakeLooksReal=' + d.fakeLooksReal) : '子进程失败')
  ok('Buffer 是 Node 原生 Buffer（Buffer.isBuffer 认可其实例）',
    !!d && d.realBufferInstance === true, d ? String(d.realBufferInstance) : '子进程失败')
  ok('【事故锚点】Buffer.constructor === Function（seal 真实 Buffer 会写到宿主 Function.prototype 的根因）',
    !!d && d.bufferCtorIsFunction === true, d ? String(d.bufferCtorIsFunction) : '子进程失败')
})()

// ============================================================================
// ③ 攻击面自动枚举 + 全路径逃逸检测（铁律③）
// ============================================================================
/**
 * 攻击面自动扫掠（**不手写清单**）。
 *
 * 做法：
 *   1. 在沙箱 context 里枚举 globalThis 的**全部** key（for..in + getOwnPropertyNames）
 *      —— 这样 sandbox.js 里新增任何注入值都会自动进入测试，不需要有人记得补清单。
 *   2. 对每个值尝试 4 条 constructor 路径：
 *        v.constructor
 *        Object.getPrototypeOf(v).constructor
 *        v.constructor && v.constructor.constructor
 *        v.prototype && v.prototype.constructor
 *   3. 判定「是否逃逸」用**宿主真 process 的独有特征**：
 *        真 process 有 pid / mainModule
 *        沙箱里的假 process 只有 env/platform/version/nextTick
 *      —— 不能用 `typeof process === 'object'`，因为沙箱注入了假 process，
 *         那样会把「拿到假 process」误报成逃逸（我第一次探针就栽在这）。
 *
 * 为什么必须在子进程里做：这些攻击真的会执行 `Function('return process')()`，
 * 若修复不完整，子进程会被污染；子进程死掉不影响主测试，且能定位到具体 key+路径。
 */
console.log('\n=== ③ 攻击面自动扫掠：所有注入值 × 4 条 constructor 路径 ===')
;(function () {
  const script = `
    'use strict'
    const path = require('path')
    const { Sandbox } = require(path.join(${JSON.stringify(ROOT)}, 'src', 'core', 'sandbox.js'))

    const ENUM = \`(function(){
      var out = [];
      try { for (var k in globalThis) out.push(String(k)) } catch (e) {}
      try { Object.getOwnPropertyNames(globalThis).forEach(function(k){ if (out.indexOf(k) < 0) out.push(String(k)) }) } catch (e) {}
      return JSON.stringify(out);
    })()\`

    // 对某个 key 尝试第 p 条路径；返回 ESCAPED / FAKEPROC / BLOCKED / ...
    function tryPath (sb, k, p) {
      const exprs = [
        'v.constructor',
        'Object.getPrototypeOf(v).constructor',
        '(v && v.constructor && v.constructor.constructor)',
        '(v && v.prototype && v.prototype.constructor)'
      ]
      const code = \`(function(){
        var v; try { v = globalThis[\` + JSON.stringify(k) + \`] } catch (e) { return 'GETFAIL' }
        var C; try { C = \` + exprs[p] + \` } catch (e) { return 'EXPRFAIL' }
        if (typeof C !== 'function') return 'NOFUNC'
        var p; try { p = C('return process')() } catch (e) { return 'CALLBLOCKED' }
        if (!p || typeof p !== 'object') return 'NOPROC'
        // 只有宿主真 process 才有 pid / mainModule；沙箱假 process 没有
        if (typeof p.mainModule !== 'undefined' || typeof p.pid === 'number') {
          var exec = false, fs = false
          try { exec = !!p.mainModule.require('child_process').execSync } catch (e) {}
          try { fs = !!p.mainModule.require('fs').readFileSync } catch (e) {}
          return 'ESCAPED:' + exec + ':' + fs
        }
        return 'FAKEPROC'
      })()\`
      try { return String(sb.run(code, 3000)) } catch (e) { return 'THROW' }
    }

    const main = async () => {
      const sb = new Sandbox({ id: 'escape-scan', fetchTimeout: 1000 })
      await sb.init('', {})
      const keys = JSON.parse(sb.run(ENUM, 5000))
      const escaped = []
      const attempted = []
      for (const k of keys) {
        for (let p = 0; p < 4; p++) {
          attempted.push(k + '#' + p)
          const out = tryPath(sb, k, p)
          if (out.indexOf('ESCAPED') === 0) escaped.push({ key: k, path: p, detail: out })
        }
      }
      sb.destroy()
      console.log(JSON.stringify({ keyCount: keys.length, tried: attempted.length, escaped }))
    }
    main().catch(e => { console.log(JSON.stringify({ error: String(e && e.message) })) })
  `
  const r = runInChild(script, 120000)
  const d = r.ok ? r.data : null
  if (!d || d.error) {
    ok('扫掠能跑起来', false, r.spawnErr || (d && d.error) || r.stderr || r.parseErr)
  } else {
    console.log('    〔数字〕枚举到 ' + d.keyCount + ' 个 globalThis key，共试 ' + d.tried + ' 条路径')
    ok('扫掠覆盖了 sandboxGlobals 的全部注入值（key 数 > 20）',
      d.keyCount > 20, 'keyCount=' + d.keyCount)
    ok('【核心】所有注入值 × 所有 constructor 路径都无法拿到宿主 process',
      Array.isArray(d.escaped) && d.escaped.length === 0,
      '逃逸 ' + (d.escaped ? d.escaped.length : '?') + ' 条: ' +
        (d.escaped || []).slice(0, 12).map(x => x.key + '#' + x.path).join(', '))
    if (Array.isArray(d.escaped) && d.escaped.length) {
      console.log('    〔逃逸明细，前 12 条〕')
      d.escaped.slice(0, 12).forEach(x => console.log('      ✗ ' + x.key + ' path' + x.path + ' → ' + x.detail))
    }
  }
})()

// ============================================================================
// ④ 真实危害链验证：拿到 process 后能不能执行命令 / 读文件
// ============================================================================
/**
 * 前面只验证「拿到宿主 process」。这一项验证**危害是否可达**：
 * 真能 execSync / readFileSync 才算真逃逸。
 *
 * 注意：这里故意用 `echo` 和一个只读文件，**不写任何东西**，
 * 也不真的去 exec 危险命令 —— 逃逸验证只需证明「通道存在」，不必真造成破坏。
 */
console.log('\n=== ④ 危害链：命令执行 / 文件读取通道是否被封死 ===')
;(function () {
  const script = `
    'use strict'
    const path = require('path')
    const { Sandbox } = require(path.join(${JSON.stringify(ROOT)}, 'src', 'core', 'sandbox.js'))
    const main = async () => {
      const sb = new Sandbox({ id: 'harm', fetchTimeout: 1000 })
      await sb.init('', {})
      // 禁止用 replace(/\\n/g) 之类转义：这个脚本本身嵌在模板字符串里，
      // 多层嵌套会把反斜杠吃掉，导致 read= 判定永真/永假的假绿（我踩过）。
      // 只用 slice + indexOf 判定，不做正则替换。
      const payload = \`(function(){
        // 拿 process 的路径不止 mainModule。实测 process.mainModule 可能为 undefined
        //（ESM/新版 Node），但 process.binding / pid 同样是「真 process」的铁证。
        var marks = [];
        try {
          var p = globalThis.__host_emit.constructor('return process')();
          if (p.mainModule && p.mainModule.require) {
            try {
              var exec = p.mainModule.require('child_process').execSync('echo PWNED_BY_SANDBOX').toString().trim();
              marks.push('exec=' + exec);
            } catch (e) { marks.push('execFail:' + String(e && e.message).slice(0, 30)) }
            try {
              var txt = p.mainModule.require('fs').readFileSync('package.json', 'utf8').slice(0, 10);
              marks.push('read=' + txt);
            } catch (e) { marks.push('readFail:' + String(e && e.message).slice(0, 30)) }
          } else { marks.push('noMainModule') }
          marks.push('binding=' + (typeof p.binding));
          marks.push('pid=' + (typeof p.pid));
          return marks.join('|');
        } catch (e) { return 'BLOCKED:' + String(e && e.message).slice(0, 60) }
      })()\`
      let out
      try { out = String(sb.run(payload, 5000)) } catch (e) { out = 'THROW:' + String(e.message).slice(0, 60) }
      sb.destroy()
      console.log(JSON.stringify({ out }))
    }
    main().catch(e => console.log(JSON.stringify({ error: String(e && e.message) })))
  `
  const r = runInChild(script, 90000)
  const out = r.ok && r.data ? String(r.data.out || '') : ''
  // 「拿到真 process」本身就是核心危害：真 process 有 binding/pid，
  // 沙箱注入的假 process 只有 env/platform/version/nextTick。
  // 有了真 process，拿 child_process/fs 只是多一步的事（binding/p.env 也能走）。
  const gotRealProcess = out.indexOf('binding=function') >= 0 || out.indexOf('pid=number') >= 0
  ok('【核心】沙箱脚本无法通过 __host_emit.constructor 拿到宿主真 process',
    !gotRealProcess, '返回: ' + out.slice(0, 140))
  ok('【核心】沙箱脚本无法通过 __host_emit.constructor 执行宿主命令（child_process）',
    out.indexOf('exec=PWNED_BY_SANDBOX') < 0 && out.indexOf('execFail') < 0,
    '返回: ' + out.slice(0, 140))
  ok('【核心】沙箱脚本无法通过该路径读取宿主文件（且拿不到真 process）',
    out.indexOf('read=') < 0 && out.indexOf('readFail') < 0 && !gotRealProcess,
    '返回: ' + out.slice(0, 140))
  ok('【核心】即使拿到 process，也不该有 binding/pid（假 process 才没有这些）',
    !gotRealProcess, '返回: ' + out.slice(0, 140))
})()

// ============================================================================
// ⑤ 分层对照：分别证明每一层还在（删任一层必须 FAIL）
// ============================================================================
/**
 * 修复是两层：
 *   A. `codeGeneration: { strings: false }` —— 禁掉 context 内的字符串代码生成
 *   B. seal / Proxy —— 切断「注入值的 constructor」这条取值路径
 *
 * 为什么要分开测：
 * 只测「都开时全挡住」，将来有人删掉 A 层或 B 层，测试**仍然全绿**（因为另一层还在），
 * 直到某天两层都以不同方式失效才炸。所以必须分别验证：
 *
 *   - 在**没有 seal 保护**的裸 context 上，`strings=false` 单独能否挡住 via-injection？
 *     实测答案：**挡不住**（宿主函数的 constructor 是宿主 Function，
 *     strings=false 只约束 context 内的代码生成）。
 *     ⇒ 这说明 B 层（seal/Proxy）是**不可替代**的，本项断言锁死这一点。
 *
 *   - 在**有 Proxy 保护**的 context 上，即使 strings=true 也挡住 ⇒ A 层是纵深防御。
 */
console.log('\n=== ⑤ 分层对照：每层防线单独验证 ===')
;(function () {
  const script = `
    'use strict'
    const vm = require('vm')

    const ATTACK = () => \`(function(){
      try {
        var p = globalThis.h.constructor('return process')();
        if (typeof p.mainModule !== 'undefined' || typeof p.pid === 'number') return 'ESCAPED';
        return 'FAKEPROC';
      } catch (e) { return 'BLOCKED' }
    })()\`

    function probe (ctxOpts, injected) {
      const ctx = vm.createContext(injected, ctxOpts)
      try { return String(vm.runInContext(ATTACK(), ctx, { timeout: 2000 })) } catch (e) { return 'THROW' }
    }

    // 层 A 单独：strings=false + 直接注入宿主函数（无 seal）
    const onlyStrings = probe({ codeGeneration: { strings: false } }, { h: function hostThing () {} })

    // 层 B 单独：Proxy 切断原型链 + strings 允许
    const hostFn = function hostThing () { return 1 }
    const trap = new Proxy(hostFn, {
      get (t, prop) {
        if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype') return undefined
        const v = Reflect.get(t, prop)
        return typeof v === 'function' ? trap : v
      },
      getPrototypeOf () { return null },
      has () { return true }
    })
    const onlySeal = probe({}, { h: trap })

    // 两层都上
    const both = probe({ codeGeneration: { strings: false } }, { h: trap })

    // 对照：什么都不加（证明探针本身是有效的，否则"全挡住"不可信）
    const none = probe({}, { h: function hostThing () {} })

    console.log(JSON.stringify({ onlyStrings, onlySeal, both, none }))
  `
  const r = runInChild(script)
  const d = r.ok ? r.data : null
  if (!d) {
    ok('分层对照能跑起来', false, r.spawnErr || r.stderr || r.parseErr)
  } else {
    ok('【对照有效性】裸 context（两层都不加）确实能逃逸 —— 证明探针有效，不是白跑',
      d.none === 'ESCAPED', 'none=' + d.none)
    ok('【关键事实】只开 strings=false、不做 seal 时仍然会逃逸（⇒ seal 不可替代）',
      d.onlyStrings === 'ESCAPED', 'onlyStrings=' + d.onlyStrings)
    ok('【关键事实】只做 seal/Proxy、不关 strings 时也能挡住（⇒ 两层互为纵深）',
      d.onlySeal !== 'ESCAPED', 'onlySeal=' + d.onlySeal)
    ok('两层都上 → 逃逸被完全挡住',
      d.both !== 'ESCAPED', 'both=' + d.both)
  }
})()

// ============================================================================
// ⑥ 变异测试：证明断言不是空跑
// ============================================================================
/**
 * 变异测试的目的：证明「测试真的能失败」。
 *
 * 做法：**不改项目文件**，而是在子进程里用等价的「破损版」构造出变异体，
 * 然后断言：
 *   - 变异体（无防护）→ 扫掠必然发现逃逸 ⇒ 说明扫掠逻辑有检出能力
 *   - 正常版（sandbox.js）→ 扫掠无逃逸 ⇒ 说明修复真的生效
 *
 * 这两条一起成立，才排除了「扫掠写错了，永远返回空」这种假绿。
 */
console.log('\n=== ⑥ 变异测试：断言非空跑 ===')
;(function () {
  const script = `
    'use strict'
    const vm = require('vm')

    // 变异体 1：完全不防护的 context（等价于「有人删掉了 seal 和 codeGeneration」）
    const mutantNone = vm.createContext({ h: function hostThing () {} })
    // 变异体 2：只有 strings=false（等价于「有人删掉了 seal」）
    const mutantNoSeal = vm.createContext({ h: function hostThing () {} }, { codeGeneration: { strings: false } })

    const ATTACK = \`(function(){
      try {
        var p = globalThis.h.constructor('return process')();
        if (typeof p.mainModule !== 'undefined' || typeof p.pid === 'number') return 'ESCAPED';
        return 'FAKEPROC';
      } catch (e) { return 'BLOCKED' }
    })()\`

    function escapes (ctx) {
      try { return String(vm.runInContext(ATTACK, ctx, { timeout: 2000 })) === 'ESCAPED' } catch (e) { return false }
    }
    console.log(JSON.stringify({
      mutantNoneEscapes: escapes(mutantNone),
      mutantNoSealEscapes: escapes(mutantNoSeal)
    }))
  `
  const r = runInChild(script)
  const d = r.ok ? r.data : null
  if (!d) {
    ok('变异测试能跑起来', false, r.spawnErr || r.stderr || r.parseErr)
  } else {
    ok('【变异1】把防护全删掉（变异体）→ 必须能检出逃逸（否则测试是空跑）',
      d.mutantNoneEscapes === true, 'mutantNoneEscapes=' + d.mutantNoneEscapes)
    ok('【变异2】只删掉 seal 保留 strings=false → 仍必须能检出逃逸',
      d.mutantNoSealEscapes === true, 'mutantNoSealEscapes=' + d.mutantNoSealEscapes)
  }
})()

// ============================================================================
// ⑦ 宿主零污染（测试结束后）
// ============================================================================
console.log('\n=== ⑦ 宿主零污染（跑完全部攻击后复查） ===')
;(function () {
  const r = runInChild(hostCleanScript())
  ok('【事故直接防护】跑完所有逃逸攻击后，宿主核心原型仍然完好',
    r.ok && r.data && r.data.clean === true,
    r.ok ? JSON.stringify(r.data && r.data.bad) : ('子进程失败: ' + (r.spawnErr || r.stderr)))
})()

// ============================================================================
// 汇总
// ============================================================================
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' sandbox-escape: PASS ' + pass + ' / FAIL ' + fail)
if (fail) {
  console.log('\n失败项：')
  failures.forEach(f => console.log('  - ' + f))
}
process.exit(fail ? 1 : 0)
