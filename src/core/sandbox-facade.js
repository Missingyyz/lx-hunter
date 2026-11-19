'use strict'
/**
 * 沙箱逃逸防护（v1.13.12）：把注入沙箱的宿主对象包成「沙箱 realm 内的 Proxy」。
 *
 * ============================================================================
 * 为什么需要这个文件：一次把宿主 Node 进程改坏的修复尝试
 * ============================================================================
 * 原来 `vm.createContext(sandboxGlobals)` 直接注入宿主 `Buffer` / `URL` / `TextEncoder`
 * / `__host_emit` / `fetch` 等真实对象。任何脚本都能顺着它们摸到宿主内核：
 *
 *     __host_emit.constructor('return process')()      // 拿到宿主 process
 *     Buffer.constructor('return process')()           // 同上
 *     Buffer.from('x').constructor.constructor(...)    // 连返回值都泄构造器
 *
 * 第一版修法是 `sealHostValue`：递归给注入值及其**原型**抹掉 `constructor`。
 * 在假类夹具上测 21/21 全挡住，换真实宿主对象一跑直接把 Node 运行时改坏：
 *
 *     seal 真实 Buffer 后：Function.prototype.constructor → undefined（永久）
 *     seal 普通对象后：    Object.prototype.constructor   → undefined（永久）
 *
 * 根因：裸函数值 `Object.getPrototypeOf(fn)` **就是**宿主全局 `Function.prototype`，
 * 普通对象的则是 `Object.prototype`。改它等于改运行时内核，而且
 * `configurable:false` 之后**永久不可恢复**。后果是 `err.constructor === TypeError`、
 * `instanceof`、大量第三方库的类型判断全部失效。
 *
 * ============================================================================
 * 所以这里的原则（维护者务必遵守，否则会重蹈覆辙）
 * ============================================================================
 *   ❌ 绝不 `Object.getPrototypeOf(注入值)` 然后去改那个原型。
 *      它不是我们的东西，是宿主全局内核。
 *   ❌ 绝不 seal 宿主内置类的原型（Buffer / URL / TextEncoder / Array / Object …）。
 *   ✅ 只做「包装」：新建 Proxy / 沙箱内闭包，宿主的原对象一个字节都不动。
 *
 * ============================================================================
 * 做法：两层配合，缺一不可
 * ============================================================================
 * 第一层【本文件】沙箱 realm 深度包装
 *   - 注入值一律包成**在沙箱 realm 里创建的 Proxy**（target 仍是宿主对象，功能不丢）
 *   - `get` 拦截 `constructor` / `__proto__` / `prototype`，返回**沙箱 realm 里的占位**
 *   - **返回值也重新 wrap** —— 这是最容易被漏掉的一环：
 *     `Buffer.from('x')` 返回的是宿主 Buffer 实例，它自己的 constructor 也是逃逸口。
 *     只挡注入值、不挡返回值，等于没挡。
 *   - memo 缓存（宿主值 → Proxy）：不缓存会每次访问新建 Proxy，
 *     Proxy 之间递归取属性直接爆栈（实测 RangeError: Maximum call stack size exceeded）。
 *
 * 第二层【sandbox.js】context 的 `codeGeneration: { strings:false }`
 *   - 挡住沙箱 realm 内一切 `Function('...')` / `eval` 字符串代码生成
 *   - 包装层把攻击者导向「沙箱 realm 的 Function」，这一步再由 codeGeneration 封死
 *
 * 实测两层职责（tests/sandbox-escape.test.js 的「分层对照」固化）：
 *   只开 codeGeneration、不包装 → 28 条攻击仍穿过 15 条
 *   只包装、不开 codeGeneration → 仍穿过 1 条（eval）
 *   两层都开                     → 0 条
 *   ⇒ 任删一层，逃逸口都会回来。所以两层都不是冗余。
 *
 * 宿主零污染由测试单独断言（Function/Object/Array/Buffer 的 prototype.constructor
 * 必须仍是宿主原值），这是对上面那次事故的直接防护。
 */

/**
 * 注入值分类（改注入面时按这张表判断怎么处理）。
 *
 *   A 类 我们创建的闭包/对象   → 原型链归我们控制，可以安全 seal 自身 constructor
 *   B 类 宿主共享内置类/函数   → **只能包装，绝不 seal**（seal 会写到宿主内核）
 *   C 类 我们创建的包装函数    → 算 A 类（新闭包，内部引用宿主函数但不暴露）
 *
 * 判据（别用 `getPrototypeOf(v) === Function.prototype`，实测 Buffer 不满足）：
 *   这个函数对象是不是我们自己 `function(){}` / 箭头函数现造的？
 *   是 → A/C；直接拿了宿主全局（Buffer、clearTimeout …）→ B。
 */

const FACADE_SRC = `
(function () {
  'use strict'

  // 沙箱 realm 内的占位：所有 constructor / __proto__ / prototype 的查询都指向它。
  // 它在 context realm 里创建，即使攻击者拿到并调用，执行的也是沙箱内的代码
  // （沙箱里没有真 process），再由 codeGeneration 限制二次兜底。
  var safeCtor = function () {}
  var safeProto = {}

  var memo = new WeakMap()   // 宿主值 → Proxy（防重复包装、防递归爆栈）
  var back = new WeakMap()   // Proxy → 宿主值（调用时把 this / 参数解包回宿主对象）
  var proxies = new WeakSet() // 本层造出来的 Proxy 集合（幂等包装用）
  var adapters = new WeakSet() // 沙箱回调适配器集合（**不能**被还原成裸沙箱函数）

  function isPrimitive (host) {
    var t = typeof host
    return t === 'string' || t === 'number' || t === 'boolean' ||
      t === 'bigint' || t === 'symbol'
  }

  /**
   * 沙箱 realm 归属校验（v1.13.16）。
   *
   * 判据：这个值的原型链是否终止于**本 realm** 的 Object.prototype。
   * 本文件整体跑在沙箱 realm 里（见 makeSandboxFacade 的说明），
   * 所以这里的 Object.prototype 就是沙箱自己的 Object.prototype。
   *
   * 用途：宿主交回面（fetch 交付 Response 替身等）会送进已经在沙箱 realm 里
   * 造好的对象。这类对象**不需要**再包一层代理：它们本身就是安全的，
   * 而且再包一层会造成「双层代理」，让方法调用穿两层 apply 陷阱，
   * 触发 deepUnwrap 反复解包（见下方 adaptCb 注释）。
   */
  var SB_OBJ_PROTO = Object.prototype
  function isNativeRealm (v) {
    if (v === null) return false
    var t = typeof v
    if (t !== 'object' && t !== 'function') return false
    try {
      var p = Object.getPrototypeOf(v)
      var guard = 0
      while (p && guard++ < 32) {
        if (p === SB_OBJ_PROTO) return true
        p = Object.getPrototypeOf(p)
      }
    } catch (e) {}
    return false
  }

  // ------------------------------------------------------------------
  // ★ v1.13.17 宿主异常消毒（交回面的第三条腿）
  // ------------------------------------------------------------------
  //
  // 事故（复核实测坐实）：facade 只包「兑现值」，**从不包「宿主抛出的异常」**。
  // 宿主侧 API 同步抛出的 Error 是**宿主 realm 的裸对象**，脚本 catch 到它以后
  // 一句 e.constructor.constructor('return process')() 就拿到真 process。
  //
  // 实测 5 条漏口（全部与 fetch 无关）：
  //   new URL('not a url')            → 宿主 TypeError
  //   Buffer.from(-1)                 → 宿主 RangeError
  //   Buffer.from('x','bogus-enc')     → 宿主 TypeError
  //   new TextDecoder('nope')         → 宿主 TypeError
  //   unescape('%uZZZZ')              → 宿主 URIError
  //
  // 对照：JSON.parse / decodeURIComponent 抛的是**沙箱 realm 的 Error**，安全。
  //
  // 修法：宿主异常**一律在沙箱 realm 内重建**再交给脚本。
  // 本文件整体跑在沙箱 realm 里，所以这里的 Error / TypeError … 都是沙箱自己的，
  // 重建出来的实例原型链完全落在沙箱 realm 内。
  //
  // ⚠ 重建时**绝不把宿主对象塞进自定义属性**（那等于又开了个口子）：
  //   只拷 message / name / code 这些**字符串**，cause 也只取其 message 字符串。
  var SB_ERR_CTORS = {
    Error: Error, TypeError: TypeError, RangeError: RangeError,
    SyntaxError: SyntaxError, ReferenceError: ReferenceError,
    EvalError: EvalError, URIError: URIError
  }
  function isErrorLike (v) {
    if (v === null || typeof v !== 'object') return false
    try {
      var tag = Object.prototype.toString.call(v)
      return tag === '[object Error]' || tag === '[object DOMException]'
    } catch (e) { return false }
  }
  function rebuildError (hostErr) {
    // 已经是沙箱 realm 的异常 → 原样抛（别把沙箱自己的错误改头换面）
    if (hostErr !== null && typeof hostErr === 'object' && isNativeRealm(hostErr)) return hostErr
    // 抛出的不是对象（字符串/数字/undefined/null）→ 原样抛。
    // 原始值在沙箱 realm 里装箱，拿到的是沙箱自己的 String/Number 构造器，安全。
    if (hostErr === null || (typeof hostErr !== 'object' && typeof hostErr !== 'function')) return hostErr
    var name = 'Error', msg = '', code = ''
    try { if (hostErr && hostErr.name != null) name = String(hostErr.name) } catch (e) {}
    try { if (hostErr && hostErr.message != null) msg = String(hostErr.message) } catch (e) {}
    try { if (hostErr && hostErr.code != null) code = String(hostErr.code) } catch (e) {}
    var Ctor = SB_ERR_CTORS[name] || Error
    var out
    try { out = new Ctor(msg) } catch (e) { out = new Error(msg) }
    try { if (out.name !== name) out.name = name } catch (e) {}
    if (code) {
      try { Object.defineProperty(out, 'code', { value: code, writable: true, enumerable: false, configurable: true }) } catch (e) {}
    }
    try {
      var cz = hostErr && hostErr.cause
      if (cz != null) {
        var cm = (typeof cz === 'object') ? String(cz && cz.message) : String(cz)
        Object.defineProperty(out, 'cause', { value: cm, writable: true, enumerable: false, configurable: true })
      }
    } catch (e) {}
    return out
  }

  /**
   * 包装任意宿主值。
   * 标量原样返回（没有 constructor 逃逸问题）；对象/函数包成 Proxy。
   */
  function wrap (host) {
    if (host === null || host === undefined) return host
    if (isPrimitive(host)) return host
    // 已经是本层的代理 → 不再包第二层（否则方法调用会穿两层 apply 陷阱）
    if (proxies.has(host)) return host
    // 已经是沙箱 realm 里的对象 → 原样交付（realm 归属校验）
    if (isNativeRealm(host)) return host
    // ★ 宿主异常 → 在沙箱 realm 内重建（不让宿主裸 Error 进沙箱）
    if (isErrorLike(host)) return rebuildError(host)
    var cached = memo.get(host)
    if (cached) return cached
    return typeof host === 'function' ? wrapFn(host) : wrapObj(host)
  }

  /** Proxy → 宿主原值；不是我们包的返回原样 */
  function unwrap (v) {
    if (v === null || v === undefined) return v
    var h = back.get(v)
    return h === undefined ? v : h
  }

  /**
   * 参数解包：脚本传进来的可能是我们包的 Proxy。
   * 不解包的话宿主侧会报「list[0] 必须是 Buffer」（Buffer.concat 就是这么发现的）。
   * 数组要逐元素解包 —— 整体 unwrap 不成立，因为 Proxy 数组的 target 是宿主数组，
   * 但里面装的是 Proxy。
   *
   * ★ 函数参数走 adaptCb（v1.13.14）：宿主稍后会用「宿主对象」回调它，
   *   那条路绕过一切 wrap。见 adaptCb 上方注释。
   */
  function deepUnwrap (v, d) {
    if (v === null || v === undefined) return v
    if (d > 6) return v
    var h = back.get(v)
    // ★ v1.13.16 关键修复：**适配器不能被还原成裸沙箱函数**。
    //
    // 事故（实测坐实，容器内变体对照实验）：
    //   adaptCb 里 back.set(adapter, fn) 是为了「adapter 传回宿主时能还原成脚本原函数」，
    //   但 deepUnwrap 的首分支 back.get(v) 会**先**命中这条登记，
    //   于是「脚本自己的函数」被换成适配器之后、又立刻被还原成**裸沙箱函数**。
    //
    //   后果：宿主回调（fetch 的 then 回调、Promise 兑现）调的是裸沙箱函数，
    //   宿主兑现值 V 于是**原样**进了沙箱，不经 wrap ⇒ 宿主裸对象可逃逸：
    //     await fetch(u).then(r => r.json())   → 拿到宿主裸 JSON 对象
    //     j.constructor.constructor('return process')()  → 真 process
    //
    //   实测（tests/tools/r1-variant.js）：去掉本行的适配器豁免后逃逸立刻消失。
    //
    // 修法：适配器是**边界对象**，必须留在边界上——
    //   传给宿主时保持 adapter 身份（宿主才认得它是回调），
    //   绝不能降级成裸沙箱函数（那等于把边界拆了）。
    if (h !== undefined && !adapters.has(v)) return h
    // 脚本自己的函数（不是我们包的宿主函数）→ 换成适配器
    if (typeof v === 'function') return adaptCb(v)
    if (Array.isArray(v)) {
      var r = new Array(v.length)
      for (var i = 0; i < v.length; i++) r[i] = deepUnwrap(v[i], d + 1)
      return r
    }
    return v
  }

  /** get 拦截：三个逃逸关键字全部导向沙箱 realm 的占位，其余属性照常读并递归包装 */
  function commonGet (t, prop) {
    if (prop === 'constructor') return safeCtor
    if (prop === '__proto__') return safeProto
    if (prop === 'prototype') {
      // 函数的 prototype 属性是 { writable:true, configurable:false }，
      // 因为 writable 为真，Proxy get 返回不同值**不违反 invariant**（不会抛 TypeError）。
      // 若将来注入到 non-writable 的 prototype，这里会抛错 —— 那时改成包装原值，
      // 但要注意别把宿主原型对象本身漏出去。
      return safeProto
    }
    var v
    try { v = Reflect.get(t, prop) } catch (e) { return undefined }
    // ★ 关键：返回值也要 wrap。Buffer.from('x').constructor 就是从这里漏的。
    return wrap(v)
  }

  /** getOwnPropertyDescriptor 拦截：否则 descriptor.value 直接绕过 get 拿到宿主构造器 */
  function commonGopd (t, prop) {
    if (prop === 'constructor' || prop === '__proto__') return undefined
    var d
    try { d = Reflect.getOwnPropertyDescriptor(t, prop) } catch (e) { return undefined }
    if (!d) return d
    var o = { enumerable: d.enumerable, configurable: d.configurable }
    if ('value' in d) { o.value = wrap(d.value); o.writable = d.writable }
    if (d.get) o.get = wrap(d.get)
    if (d.set) o.set = wrap(d.set)
    return o
  }

  /**
   * 沙箱回调适配器（v1.13.14）—— 交回面的**第二处**泄漏点，也是最隐蔽的一处。
   *
   * 只把宿主对象包成 Proxy 是不够的，因为有些宿主 API 是「你给回调，我到时调用它」：
   *
   *     fetch(u).then(r => r.json()).then(j => { j.constructor.constructor(...) })
   *                                        ^ 这里的 j 由**宿主 Promise** 直接传入
   *
   * 调用 j 的那个 then 是宿主的，回调是我们的沙箱函数；宿主解析出的普通对象
   * 就这么原样交给了沙箱回调，绕过了一切 wrap。实测确实拿到真 process。
   *
   * 所以：任何从沙箱流进宿主的函数参数，都换成这个 adapter。宿主调用它时，
   * 先把每个入参和 this 过一遍 wrap，再转交给脚本的回调。
   *
   * 为什么要 memo 而不能每次新建：脚本常见的成对用法
   * emitter.on(fn) / emitter.off(fn)、addEventListener/removeEventListener
   * 依赖函数**同一性**。每次都造新 adapter 会让 off 失效，变成监听器泄漏。
   */
  var cbMemo = new WeakMap()   // 沙箱函数 → adapter（保证同一性）
  function adaptCb (fn) {
    if (typeof fn !== 'function') return fn
    var cached = cbMemo.get(fn)
    if (cached) return cached
    var adapter = function () {
      var n = arguments.length
      var a = new Array(n)
      for (var i = 0; i < n; i++) a[i] = wrap(arguments[i])
      return fn.apply(wrap(this), a)
    }
    cbMemo.set(fn, adapter)
    back.set(adapter, fn)   // 反查：adapter 传回宿主时能还原成脚本原函数
    adapters.add(adapter)  // ★ 但适配器**不可**被 deepUnwrap 还原（见 deepUnwrap 注释）
    return adapter
  }

  function wrapFn (host) {
    var p = new Proxy(host, {
      get: function (t, prop) { return commonGet(t, prop) },
      getOwnPropertyDescriptor: function (t, prop) { return commonGopd(t, prop) },
      // 原型链断在沙箱 realm 的空对象上：fn.__proto__.constructor 于是指向 safeCtor
      getPrototypeOf: function () { return safeProto },
      setPrototypeOf: function () { return true },
      // ★ 写入面五件套（v1.13.14）。缺任何一个，脚本就能改到宿主真对象。
      // 实测缺 set 的后果：Buffer.from = fn → 宿主随后 SIGABRT(134)，整个应用死掉；
      // delete Buffer.isBuffer → 宿主自己的 Buffer.from 直接抛 not a function。
      // 这里一律「静默忽略」而不是抛错：音源脚本里可能有 try{...}catch 包着的赋值，
      // 抛错会改变脚本行为（有的脚本靠赋值失败做环境探测）；忽略则宿主安全且脚本照跑。
      // 返回 true 表示「写入成功」（实际丢弃），避免触发 Proxy invariant 抛 TypeError。
      set: function () { return true },
      defineProperty: function () { return true },
      deleteProperty: function () { return true },
      // Object.freeze/seal/preventExtensions 走 [[PreventExtensions]] → 这个 trap。
      // 少补这一个时，Object.freeze(Buffer) 仍会穿透把宿主永久冻结（实测过）。
      preventExtensions: function () { return true },
      // 与 preventExtensions 配套：invariant 要求 preventExtensions 返回 true 时
      // 目标必须真的不可扩展，否则会抛 TypeError。这里报「仍然可扩展」以保持一致。
      isExtensible: function () { return true },
      apply: function (t, thisArg, args) {
        var a
        try {
          a = new Array(args.length)
          for (var i = 0; i < args.length; i++) a[i] = deepUnwrap(args[i], 0)
        } catch (e) { a = args }
        // ★ v1.13.17 兜底防线：宿主调用抛出的异常一律**在沙箱 realm 内重建**再抛。
        //   没有这层，脚本 catch 到的就是宿主裸 Error，一句
        //   e.constructor.constructor('return process')() 就拿到真 process。
        //   实测 5 条漏口：new URL('not a url') / Buffer.from(-1) /
        //   Buffer.from('x','bogus-enc') / new TextDecoder('nope') / unescape('%uZZZZ')。
        try {
          return wrap(Reflect.apply(t, unwrap(thisArg), a))
        } catch (err) {
          throw rebuildError(err)
        }
      },
      construct: function (t, args) {
        var a
        try {
          a = new Array(args.length)
          for (var i = 0; i < args.length; i++) a[i] = deepUnwrap(args[i], 0)
        } catch (e) { a = args }
        try {
          return wrap(Reflect.construct(t, a))
        } catch (err) {
          throw rebuildError(err)
        }
      }
    })
    memo.set(host, p)
    back.set(p, host)
    proxies.add(p)
    return p
  }

  function wrapObj (host) {
    var p = new Proxy(host, {
      get: function (t, prop) { return commonGet(t, prop) },
      getOwnPropertyDescriptor: function (t, prop) { return commonGopd(t, prop) },
      getPrototypeOf: function () { return safeProto },
      setPrototypeOf: function () { return true },
      set: function () { return true },
      defineProperty: function () { return true },
      deleteProperty: function () { return true },
      preventExtensions: function () { return true },
      isExtensible: function () { return true }
    })
    memo.set(host, p)
    back.set(p, host)
    proxies.add(p)
    return p
  }

  return { wrap: wrap, adaptCb: adaptCb }
})()
`

/**
 * 在当前 vm context 里创建包装工厂。
 *
 * 为什么工厂必须建在 context 内：如果包装函数在宿主 realm 里创建，它自己的
 * `constructor` 就是宿主 `Function`，攻击者从包装函数又能摸回宿主内核 —— 白忙。
 * 由 context realm 创建，`.__proto__` / `.constructor` 的解析全部落在沙箱里。
 *
 * @param {vm.Context} context 已创建的沙箱 context
 * @returns {{wrap: (v:any)=>any}} 包装器（可安全用于 context.realm 内）
 */
function makeSandboxFacade (context) {
  const vm = require('vm')
  return vm.runInContext(FACADE_SRC, context, { timeout: 5000 })
}

/**
 * 给「我们自己创建的闭包/对象」（A/C 类）抹掉自身 constructor。
 *
 * 只动 v 的**自有属性**，不碰 `Object.getPrototypeOf(v)` —— 那才是上次事故的落点。
 * 对现造的函数/字面量对象来说，自有 constructor 本来就不存在，加一个 undefined
 * 是无害的纵深防御：即使包装层被绕过，也还有这一层。
 *
 * ⚠ 绝不把它用在宿主共享的全局函数上（clearTimeout / Buffer 之类）：
 *   那会给宿主的函数对象永久加一个不可配置属性，属于改宿主。
 *
 * @param {any} v 我们创建的闭包或对象
 * @returns {any} 同一个 v
 */
function sealOwnConstructor (v) {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v
  try {
    Object.defineProperty(v, 'constructor', {
      value: undefined, writable: false, enumerable: false, configurable: false
    })
  } catch (e) { /* 已存在不可配置属性时静默跳过 */ }
  return v
}

module.exports = { makeSandboxFacade, sealOwnConstructor }
