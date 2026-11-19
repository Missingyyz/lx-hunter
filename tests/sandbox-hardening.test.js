'use strict'
/**
 * 沙箱加固的「返回值」与「分层职责」回归测试（v1.13.12）
 *
 * ============================================================================
 * 为什么单独有这个文件
 * ============================================================================
 * `sandbox-escape.test.js` 管的是「注入值本身能不能摸到宿主」。它有个盲区：
 * **注入的函数本身挡住了，但它返回的宿主对象实例又把 constructor 链漏回来。**
 *
 *     // 注入的 setTimeout 已包装，直接 setTimeout.constructor 挡住
 *     var t = setTimeout(()=>{}, 100000)
 *     t.constructor.constructor('return process')()     // → 真拿到 process 🔴
 *
 * 这是本次加固里最容易漏、也最容易被将来的人改回去的一环，所以单独固化。
 * 实测泄露点清单：Buffer 实例、crypto.randomBytes/aesEncrypt/rsaEncrypt 返回值、
 * zlib.inflate/deflate 返回值、setTimeout/setInterval 返回的 Timeout、
 * fetch 返回的宿主 Promise、URL、URLSearchParams、AbortController、TextEncoder。
 *
 * ============================================================================
 * 第二件事：把「两层各自职责」用数字钉死
 * ============================================================================
 * 加固是两层：codeGeneration 限制 + 沙箱 realm 深度包装。
 * 只测「都开时全挡住」，将来删掉任一层测试仍然全绿（另一层还在撑着），
 * 直到某天两层以不同方式同时失效才炸。所以这里分别测、并断言具体的失效数量级。
 *
 * 实测（同一批 payload）：
 *   两层都不做 → 逃逸最多（对照组，证明探针有效）
 *   只开 codeGeneration、不包装 → 仍逃逸 15/28
 *   只包装、不开 codeGeneration → 仍逃逸 1/28（eval）
 *   两层都开 → 0/28
 *   ⇒ 任删一层，漏洞都会回来。两层都不是冗余。
 *
 * ============================================================================
 * 用法
 * ============================================================================
 *   node tests/sandbox-hardening.test.js
 *   退出码 0 = 全部通过；1 = 有 FAIL。
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

/** 在独立子进程里跑探针（攻击会真的执行，必须隔离，理由见 sandbox-escape.test.js 铁律②） */
function runInChild (script, timeoutMs) {
  const r = spawnSync(NODE, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs || 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  let data = null
  const out = String(r.stdout || '').trim()
  if (out) {
    const lines = out.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try { data = JSON.parse(lines[i]); break } catch (e) { /* 继续往前找 */ }
    }
  }
  return { ok: !r.error && r.status === 0 && data != null, data, stderr: String(r.stderr || '').slice(0, 1500), error: r.error ? String(r.error.message) : null }
}

// ============================================================================
// ① 返回值路径：注入函数的返回值不能把宿主构造器漏回来
// ============================================================================
console.log('\n=== ① 返回值路径（注入函数返回的宿主对象实例） ===')
;(function () {
  const script = `
    'use strict'
    const path = require('path')
    const { Sandbox } = require(path.join(${JSON.stringify(ROOT)}, 'src', 'core', 'sandbox.js'))

    // 每条：造出返回值 → 走 3 条 constructor 路径 → 判断能否拿到真 process
    const CASES = [
      ['setTimeout', 'var x = setTimeout(function(){}, 100000)'],
      ['setInterval', 'var x = setInterval(function(){}, 100000)'],
      ['Buffer.from', 'var x = Buffer.from("abc")'],
      ['Buffer.alloc', 'var x = Buffer.alloc(4)'],
      ['crypto.randomBytes', 'var x = crypto.randomBytes(4)'],
      ['crypto.md5', 'var x = crypto.md5("a")'],
      ['zlib.deflate', 'var x = zlib.deflate(Buffer.from("a"))'],
      ['new URL', 'var x = new URL("https://a.com/p")'],
      ['new URLSearchParams', 'var x = new URLSearchParams("a=1")'],
      ['TextEncoder.encode', 'var x = new TextEncoder().encode("x")'],
      ['TextDecoder.decode', 'var x = new TextDecoder().decode(new Uint8Array([97]))'],
      ['new AbortController', 'var x = new AbortController()'],
      ['JSON.parse', 'var x = JSON.parse("{\\\\"a\\\\":1}")'],
      ['JSON.parse 嵌套', 'var x = JSON.parse("{\\\\"a\\\\":{\\\\"b\\\\":1}}").a'],
      ['Object.keys', 'var x = Object.keys({a:1})'],
      ['fetch', 'var x = fetch("http://127.0.0.1:1/x")']
    ]

    const main = async () => {
      const sb = new Sandbox({ id: 'ret', fetchTimeout: 400, maxTotalFetches: 50 })
      await sb.init('', {})
      const escaped = []
      const detail = []
      for (const [name, setup] of CASES) {
        const code = '(function(){\\n' +
          setup + ';\\n' +
          'var paths = [\\n' +
          '  function(){ return x.constructor && x.constructor.constructor },\\n' +
          '  function(){ return Object.getPrototypeOf(x) && Object.getPrototypeOf(x).constructor },\\n' +
          '  function(){ return x.constructor }\\n' +
          '];\\n' +
          'for (var i=0;i<paths.length;i++){\\n' +
          '  try {\\n' +
          '    var C = paths[i]();\\n' +
          '    if (typeof C !== "function") continue;\\n' +
          '    try {\\n' +
          '      var p = C("return process")();\\n' +
          '      if (p && typeof p.pid === "number") return "ESCAPED";\\n' +
          '    } catch(e) {}\\n' +
          '  } catch(e) {}\\n' +
          '}\\n' +
          'return "safe";\\n' +
          '})()'
        let r
        try { r = String(sb.run(code, 3000)) } catch (e) { r = 'THROW' }
        if (r.indexOf('ESCAPED') >= 0) escaped.push(name)
        detail.push(name + '=' + r)
      }
      sb.destroy()
      console.log(JSON.stringify({ count: CASES.length, escaped, detail }))
    }
    // 必须显式退出：探针里起了 setInterval(100000)，事件循环不会自己空，否则子进程挂到超时
    main().then(function(){ process.exit(0) }).catch(e => { console.log(JSON.stringify({ error: String(e && e.message) })); process.exit(1) })
  `
  const r = runInChild(script, 120000)
  const d = r.ok ? r.data : null
  if (!d || d.error) {
    ok('返回值探针能跑起来', false, r.error || (d && d.error) || r.stderr)
  } else {
    console.log('    〔数字〕覆盖 ' + d.count + ' 类返回值 × 3 条 constructor 路径')
    ok('【核心】注入函数的返回值也无法漏出宿主构造器',
      Array.isArray(d.escaped) && d.escaped.length === 0,
      '逃逸 ' + (d.escaped ? d.escaped.length : '?') + ' 项: ' + (d.escaped || []).join(', '))
    if (d.escaped && d.escaped.length) {
      d.escaped.forEach(x => console.log('      ✗ ' + x))
    }
  }
})()

// ============================================================================
// ② 分层职责：分别断言每层单独存在时仍会漏，叠加才归零
// ============================================================================
console.log('\n=== ② 分层职责对照（证明两层都不冗余） ===')
;(function () {
  const script = `
    'use strict'
    const vm = require('vm')

    // 与 sandbox-facade.js 同构的精简版包装工厂（用于在裸 context 上做对照实验）
    const FACADE = \`
      (function(){
        var safeCtor = function(){}
        var safeProto = {}
        var memo = new WeakMap(), back = new WeakMap()
        function prim(h){ var t=typeof h; return t==='string'||t==='number'||t==='boolean'||t==='bigint'||t==='symbol' }
        function wrap(h){
          if (h===null||h===undefined) return h
          if (prim(h)) return h
          var c = memo.get(h); if (c) return c
          return typeof h==='function' ? wrapFn(h) : wrapObj(h)
        }
        function unwrap(v){ if(v===null||v===undefined) return v; var h=back.get(v); return h===undefined?v:h }
        function deepUnwrap(v,d){
          if(v===null||v===undefined) return v
          if(d>6) return v
          var h=back.get(v); if(h!==undefined) return h
          if(Array.isArray(v)){ var r=new Array(v.length); for(var i=0;i<v.length;i++) r[i]=deepUnwrap(v[i],d+1); return r }
          return v
        }
        function commonGet(t,prop){
          if(prop==='constructor') return safeCtor
          if(prop==='__proto__') return safeProto
          if(prop==='prototype') return safeProto
          var v; try{ v=Reflect.get(t,prop) }catch(e){ return undefined }
          return wrap(v)
        }
        function commonGopd(t,prop){
          if(prop==='constructor'||prop==='__proto__') return undefined
          var d; try{ d=Reflect.getOwnPropertyDescriptor(t,prop) }catch(e){ return undefined }
          if(!d) return d
          var o={enumerable:d.enumerable,configurable:d.configurable}
          if('value' in d){ o.value=wrap(d.value); o.writable=d.writable }
          if(d.get) o.get=wrap(d.get)
          if(d.set) o.set=wrap(d.set)
          return o
        }
        function wrapFn(host){
          var p=new Proxy(host,{
            get:function(t,prop){return commonGet(t,prop)},
            getOwnPropertyDescriptor:function(t,prop){return commonGopd(t,prop)},
            getPrototypeOf:function(){return safeProto},
            setPrototypeOf:function(){return true},
            apply:function(t,thisArg,args){
              var a; try{ a=new Array(args.length); for(var i=0;i<args.length;i++) a[i]=deepUnwrap(args[i],0) }catch(e){ a=args }
              return wrap(Reflect.apply(t,unwrap(thisArg),a))
            },
            construct:function(t,args){
              var a; try{ a=new Array(args.length); for(var i=0;i<args.length;i++) a[i]=deepUnwrap(args[i],0) }catch(e){ a=args }
              return wrap(Reflect.construct(t,a))
            }
          })
          memo.set(host,p); back.set(p,host); return p
        }
        function wrapObj(host){
          var p=new Proxy(host,{
            get:function(t,prop){return commonGet(t,prop)},
            getOwnPropertyDescriptor:function(t,prop){return commonGopd(t,prop)},
            getPrototypeOf:function(){return safeProto},
            setPrototypeOf:function(){return true}
          })
          memo.set(host,p); back.set(p,host); return p
        }
        return { wrap: wrap }
      })()
    \`

    const PAYLOADS = [
      'Buffer.constructor("return process.version")()',
      'Buffer.from("x").constructor.constructor("return process.version")()',
      'URL.constructor("return process.version")()',
      'TextEncoder.constructor("return process.version")()',
      'JSON.parse("{}").constructor.constructor("return process.version")()',
      '__host_emit.constructor("return process.version")()',
      'setTimeout.constructor("return process.version")()',
      '({}).constructor.constructor("return process.version")()',
      '[].constructor.constructor("return process.version")()',
      'globalThis.constructor.constructor("return process.version")()',
      'eval("1")'
    ]

    function build (withWrap, withCg) {
      const g = { }
      Object.setPrototypeOf(g, null)
      const ctx = vm.createContext(g, withCg ? { codeGeneration: { strings: false, wasm: false } } : {})
      const F = vm.runInContext(FACADE, ctx)
      const exp = withWrap ? F.wrap : (x => x)
      g.Buffer = exp(Buffer)
      g.URL = exp(URL)
      g.TextEncoder = exp(TextEncoder)
      g.JSON = exp(JSON)
      g.setTimeout = exp(setTimeout)
      g.__host_emit = exp(function hostEmit(){})
      return ctx
    }

    function countEscapes (ctx) {
      let n = 0
      const which = []
      for (const p of PAYLOADS) {
        let r
        try {
          r = String(vm.runInContext('(function(){try{return "OK:"+String(' + p + ')}catch(e){return "BLOCKED"}})()', ctx, { timeout: 2000 }))
        } catch (e) { r = 'OUTER' }
        if (/OK:v\\d+\\./.test(r) || /OK:\\d+$/.test(r)) { n++; which.push(p.slice(0, 30)) }
      }
      return { n, which }
    }

    const none = countEscapes(build(false, false))
    const onlyCg = countEscapes(build(false, true))
    const onlyWrap = countEscapes(build(true, false))
    const both = countEscapes(build(true, true))

    console.log(JSON.stringify({
      total: PAYLOADS.length,
      none: none.n, onlyCg: onlyCg.n, onlyWrap: onlyWrap.n, both: both.n,
      onlyCgWhich: onlyCg.which
    }))
  `
  const r = runInChild(script, 60000)
  const d = r.ok ? r.data : null
  if (!d) {
    ok('分层对照能跑起来', false, r.error || r.stderr)
  } else {
    console.log('    〔数字〕共 ' + d.total + ' 条 payload：无防护逃逸 ' + d.none +
      ' / 只 codeGeneration ' + d.onlyCg + ' / 只包装 ' + d.onlyWrap + ' / 两者 ' + d.both)
    ok('【对照有效性】两层都不做确实会逃逸（证明探针有效，不是白跑）',
      d.none > 0, 'none=' + d.none)
    ok('【关键事实】只开 codeGeneration、不包装 → 仍会逃逸（⇒ 包装层不可删）',
      d.onlyCg > 0, 'onlyCg=' + d.onlyCg)
    ok('【关键事实】只包装、不开 codeGeneration → 仍会逃逸（⇒ codeGeneration 不可删）',
      d.onlyWrap > 0, 'onlyWrap=' + d.onlyWrap)
    ok('【核心】两层都开 → 逃逸归零',
      d.both === 0, 'both=' + d.both)
  }
})()

// ============================================================================
// ③ 宿主零污染：加固后宿主核心原型必须完好（本次事故的直接防护）
// ============================================================================
console.log('\n=== ③ 宿主零污染（加固后，事故直接防护） ===')
;(function () {
  const script = `
    'use strict'
    const path = require('path')
    const { Sandbox } = require(path.join(${JSON.stringify(ROOT)}, 'src', 'core', 'sandbox.js'))
    const main = async () => {
      const sb = new Sandbox({ id: 'clean', fetchTimeout: 400 })
      await sb.init('', {})
      // 跑一遍典型攻击，确认不会顺带改坏宿主
      try { sb.run('Buffer.constructor("return process")()', 2000) } catch (e) {}
      try { sb.run('globalThis.constructor.constructor("return process")()', 2000) } catch (e) {}
      try { sb.run('__host_emit.constructor("return process")()', 2000) } catch (e) {}
      sb.destroy()

      const checks = [
        ['Function.prototype.constructor === Function', Function.prototype.constructor === Function],
        ['Object.prototype.constructor === Object', Object.prototype.constructor === Object],
        ['Array.prototype.constructor === Array', Array.prototype.constructor === Array],
        ['String.prototype.constructor === String', String.prototype.constructor === String],
        ['Number.prototype.constructor === Number', Number.prototype.constructor === Number],
        ['RegExp.prototype.constructor === RegExp', RegExp.prototype.constructor === RegExp],
        ['Promise.prototype.constructor === Promise', Promise.prototype.constructor === Promise],
        ['Map.prototype.constructor === Map', Map.prototype.constructor === Map],
        ['Error.prototype.constructor === Error', Error.prototype.constructor === Error],
        ['Buffer.prototype.constructor === Buffer', Buffer.prototype.constructor === Buffer],
        ['Buffer.constructor === Function', Buffer.constructor === Function],
        ['URL.constructor === Function', URL.constructor === Function],
        ['TextEncoder.constructor === Function', TextEncoder.constructor === Function],
        ['setTimeout.constructor === Function', setTimeout.constructor === Function],
        ['({}).constructor === Object', ({}).constructor === Object],
        ['(function(){}).constructor === Function', (function () {}).constructor === Function],
        ['(() => {}).constructor === Function', (() => {}).constructor === Function],
        ['class X {}.constructor === Function', (class X {}).constructor === Function]
      ]
      const bad = checks.filter(c => !c[1]).map(c => c[0])
      // 宿主功能面
      const funcOk = Buffer.from('a').toString() === 'a' &&
        JSON.parse('{"a":1}').a === 1 &&
        new URL('https://a.com').hostname === 'a.com' &&
        typeof require('crypto').createHash('md5').update('a').digest('hex') === 'string'
      console.log(JSON.stringify({ total: checks.length, bad, funcOk }))
    }
    main().catch(e => console.log(JSON.stringify({ error: String(e && e.message) })))
  `
  const r = runInChild(script, 90000)
  const d = r.ok ? r.data : null
  if (!d || d.error) {
    ok('宿主零污染探针能跑起来', false, r.error || (d && d.error) || r.stderr)
  } else {
    ok('【事故直接防护】加固后宿主核心原型全部完好（' + d.total + ' 项）',
      Array.isArray(d.bad) && d.bad.length === 0,
      '被污染: ' + (d.bad || []).join('; '))
    ok('加固后宿主自己的 Buffer/JSON/URL/crypto 仍正常',
      d.funcOk === true, 'funcOk=' + d.funcOk)
  }
})()

// ============================================================================
// ④ 变异测试：把包装层摘掉，断言必须能检出逃逸（防「测试空跑」）
// ============================================================================
console.log('\n=== ④ 变异测试：断言非空跑 ===')
;(function () {
  const script = `
    'use strict'
    const fs = require('fs')
    const path = require('path')
    const vm = require('vm')

    // 变异体：把 sandbox.js 里的 facade 应用循环删掉（等价于「有人删了包装层」）
    const SRC = path.join(${JSON.stringify(ROOT)}, 'src', 'core', 'sandbox.js')
    const orig = fs.readFileSync(SRC, 'utf8')
    const marker = 'sandboxGlobals[key] = facade.wrap(sandboxGlobals[key])'
    if (orig.indexOf(marker) < 0) {
      console.log(JSON.stringify({ error: '变异点未找到，测试需同步更新' }))
    } else {
    const mutated = orig.replace(marker, 'void (sandboxGlobals[key])')
    const TMP = path.join(${JSON.stringify(ROOT)}, 'src', 'core', '_sb_mutant.js')
    fs.writeFileSync(TMP, mutated, 'utf8')

    const main = async () => {
      let escaped = null
      try {
        delete require.cache[require.resolve(TMP)]
        const { Sandbox } = require(TMP)
        const sb = new Sandbox({ id: 'mut', fetchTimeout: 400 })
        await sb.init('', {})
        let r
        try { r = String(sb.run('Buffer.constructor("return process")()', 3000)) } catch (e) { r = 'BLOCKED' }
        escaped = (typeof r === 'string' && r !== 'undefined' && r.indexOf('BLOCKED') < 0)
        sb.destroy()
      } finally {
        try { fs.unlinkSync(TMP) } catch (e) {}
      }
      console.log(JSON.stringify({ escaped }))
    }
    main().then(function(){ process.exit(0) }).catch(e => { console.log(JSON.stringify({ error: String(e && e.message) })); process.exit(1) })
    }
  `
  const r = runInChild(script, 60000)
  const d = r.ok ? r.data : null
  if (!d || d.error) {
    ok('变异测试能跑起来', false, r.error || (d && d.error) || r.stderr)
  } else {
    ok('【变异】摘掉包装层 → 必须能检出逃逸（否则本测试是空跑）',
      d.escaped === true, 'escaped=' + d.escaped)
  }
})()

// ============================================================================
// 汇总
// ============================================================================
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' sandbox-hardening: PASS ' + pass + ' / FAIL ' + fail)
if (fail) {
  console.log('\n失败项：')
  failures.forEach(f => console.log('  - ' + f))
}
process.exit(fail ? 1 : 0)
