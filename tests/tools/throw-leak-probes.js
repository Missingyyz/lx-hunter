'use strict'
/**
 * 宿主 API 同步抛出异常的「逃逸探针清单」。
 *
 * 背景（v1.13.16 之后的新发现）：
 *   facade 只消毒「交回面」的**兑现值**，不消毒**宿主同步抛出的异常**。
 *   注入沙箱的宿主内置类（URL / Buffer / TextDecoder …）和宿主自建闭包
 *   （crypto / zlib polyfill）在参数非法时**同步 throw**，
 *   这个 Error 是**宿主 realm** 的对象，裸着进沙箱的 catch：
 *
 *       try { new URL('not a url') } catch (e) {
 *         e.constructor.constructor('return process')()   // ← 真宿主 process
 *       }
 *
 * 本清单是「穷举」用的：每个注入到沙箱 realm 的宿主函数/对象都要有一行，
 * 标明它**可能**在哪些调用下同步抛出，以及那个 Error 来自哪个 realm。
 *
 * realm 判定（关键，不能简化）：
 *   沙箱 realm 的 Error.prototype 与宿主 realm 的 Error.prototype 是**不同对象**。
 *   判据是「原型链是否终止于沙箱 realm 的 Object.prototype」。
 *   ⚠ 不能用「拿到 process 没」当唯一判据：那只能证明逃逸成功，
 *     证明不了 Error 属于哪个 realm（沙箱 realm 的 Error 也能被误判成可逃逸）。
 *
 * kind 字段的取值：
 *   'builtin'  宿主内置模块/类（URL、Buffer、TextDecoder、AbortSignal…）
 *   'closure'  宿主自建闭包/宿主 realm 里 new 的对象（crypto/zlib polyfill…）
 *   'sandbox'  沙箱 realm 自带的内建（JSON、decodeURIComponent、lx.*…）—— 对照组
 *
 * expr 一律用普通字符串（内部单引号写成 \'），避免模板字符串转义踩坑。
 */

module.exports = [
  // ===== A. 宿主内置类 =====
  { key: 'Buffer', kind: 'builtin', label: 'Buffer.from(-1)', expr: 'Buffer.from(-1)' },
  { key: 'Buffer', kind: 'builtin', label: "Buffer.from('x','bogus-enc')", expr: "Buffer.from('x','bogus-enc')" },
  { key: 'Buffer', kind: 'builtin', label: 'Buffer.alloc(-1)', expr: 'Buffer.alloc(-1)' },
  { key: 'Buffer', kind: 'builtin', label: 'Buffer.concat([])', expr: 'Buffer.concat([])' },
  { key: 'Buffer', kind: 'builtin', label: 'Buffer.from(undefined)', expr: 'Buffer.from(undefined)' },
  { key: 'URL', kind: 'builtin', label: "new URL('not a url')", expr: "new URL('not a url')" },
  { key: 'URL', kind: 'builtin', label: "URL.canParse('%%%')", expr: "URL.canParse('%%%')" },
  { key: 'URL', kind: 'builtin', label: 'new URL()', expr: 'new URL()' },
  { key: 'URLSearchParams', kind: 'builtin', label: "new URLSearchParams('%')", expr: "new URLSearchParams('%')" },
  { key: 'TextDecoder', kind: 'builtin', label: "new TextDecoder('nope')", expr: "new TextDecoder('nope')" },
  { key: 'TextDecoder', kind: 'builtin', label: "TextDecoder fatal 非法字节", expr: "new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from([0xff]))" },
  { key: 'TextEncoder', kind: 'builtin', label: 'new TextEncoder()', expr: 'new TextEncoder()' },
  { key: 'AbortController', kind: 'builtin', label: 'new AbortController()', expr: 'new AbortController()' },
  { key: 'AbortSignal', kind: 'builtin', label: 'AbortSignal.timeout(-1)', expr: 'AbortSignal.timeout(-1)' },
  { key: 'AbortSignal', kind: 'builtin', label: 'new AbortSignal()', expr: 'new AbortSignal()' },

  // ===== B. 全局编解码函数 =====
  { key: 'unescape', kind: 'builtin', label: "unescape('%uZZZZ')", expr: "unescape('%uZZZZ')" },
  { key: 'escape', kind: 'builtin', label: "escape('\\uFFFF')", expr: "escape('\\uFFFF')" },
  { key: 'atob', kind: 'builtin', label: "atob('!!!!')", expr: "atob('!!!!')" },
  { key: 'btoa', kind: 'builtin', label: "btoa('\\u4e2d')", expr: "btoa('\\u4e2d')" },

  // ===== C. 定时器 / 微任务（宿主闭包，但沙箱自己加了守卫） =====
  { key: 'setTimeout', kind: 'builtin', label: "setTimeout('notafn')", expr: "setTimeout('notafn', 1)" },
  { key: 'setInterval', kind: 'builtin', label: "setInterval('notafn')", expr: "setInterval('notafn', 1)" },
  { key: 'setImmediate', kind: 'builtin', label: "setImmediate('notafn')", expr: "setImmediate('notafn')" },
  { key: 'queueMicrotask', kind: 'builtin', label: "queueMicrotask('notafn')", expr: "queueMicrotask('notafn')" },
  { key: 'process', kind: 'closure', label: "process.nextTick('notafn')", expr: "process.nextTick('notafn')" },
  { key: 'clearTimeout', kind: 'builtin', label: 'clearTimeout(1)', expr: 'clearTimeout(1)' },
  { key: 'clearInterval', kind: 'builtin', label: 'clearInterval(1)', expr: 'clearInterval(1)' },
  { key: 'clearImmediate', kind: 'builtin', label: 'clearImmediate(1)', expr: 'clearImmediate(1)' },

  // ===== D. 宿主自建 polyfill（crypto / zlib）—— 抛的是宿主 realm Error =====
  { key: 'crypto', kind: 'closure', label: 'crypto.randomBytes(-1)', expr: 'crypto.randomBytes(-1)' },
  { key: 'crypto', kind: 'closure', label: "crypto.aesEncrypt('x','bad-mode','key')", expr: "crypto.aesEncrypt('x','bad-mode','key')" },
  { key: 'crypto', kind: 'closure', label: "crypto.rsaEncrypt('x','not-a-pem')", expr: "crypto.rsaEncrypt('x','not-a-pem')" },
  { key: 'crypto', kind: 'closure', label: 'crypto.md5(null)', expr: 'crypto.md5(null)' },
  { key: 'crypto', kind: 'closure', label: 'crypto.md5({})', expr: 'crypto.md5({})' },
  { key: 'zlib', kind: 'closure', label: "zlib.inflate(Buffer.from('not-gzip'))", expr: "zlib.inflate(Buffer.from('not-gzip'))" },
  { key: 'zlib', kind: 'closure', label: "zlib.deflate(Buffer.from('x'))", expr: "zlib.deflate(Buffer.from('x'))" },

  // ===== E. fetch（宿主闭包；内部多数错误已 catch，但要看有没有漏网的） =====
  { key: 'fetch', kind: 'closure', label: 'fetch() 无参', expr: 'fetch()' },
  { key: 'fetch', kind: 'closure', label: 'fetch(Symbol())', expr: 'fetch(Symbol())' },
  { key: 'fetch', kind: 'closure', label: "fetch({toString(){throw new Error('boom')}})", expr: "fetch({ toString: function () { throw new Error('boom') } })" },

  // ===== F. 宿主 emit / cookie =====
  { key: '__host_emit', kind: 'closure', label: "__host_emit('x','not-json')", expr: "__host_emit('x','not-json')" },
  { key: '__host_setcookie', kind: 'closure', label: '__host_setcookie(123)', expr: '__host_setcookie(123)' },

  // ===== G. console =====
  { key: 'console', kind: 'closure', label: 'console.log()', expr: 'console.log()' },

  // ===== H. 沙箱 realm 自带内建（对照组：证明 realm 判据有区分力） =====
  { key: 'JSON', kind: 'sandbox', label: "JSON.parse('{')", expr: "JSON.parse('{')" },
  { key: 'decodeURIComponent', kind: 'sandbox', label: "decodeURIComponent('%')", expr: "decodeURIComponent('%')" },
  { key: 'encodeURIComponent', kind: 'sandbox', label: "encodeURIComponent('%u')", expr: "encodeURIComponent('%u')" },
  { key: 'Array', kind: 'sandbox', label: 'new Array(-1)', expr: 'new Array(-1)' },
  { key: 'Number', kind: 'sandbox', label: '(1).toFixed(200)', expr: '(1).toFixed(200)' },
  { key: 'RegExp', kind: 'sandbox', label: "new RegExp('(')", expr: "new RegExp('(')" },
  { key: 'Symbol', kind: 'sandbox', label: "Symbol() + ''", expr: "Symbol() + ''" },
  { key: 'JSON', kind: 'sandbox', label: 'JSON.stringify 循环引用', expr: '(function(){var a={};a.a=a;return JSON.stringify(a)})()' },
  { key: 'BigInt', kind: 'sandbox', label: "BigInt('x')", expr: "BigInt('x')" },
  { key: 'lx', kind: 'sandbox', label: 'lx 不存在属性访问', expr: 'lx.__no_such__' },

  // ===== D. lxbootstrap 注入的沙箱 realm 桩（lxbootstrap.js:144-206）=====
  /**
   * 这一组是 SETUP 阶段在**沙箱 realm 内**用纯 JS 造的桩
   * （window/global/self 别名、document、navigator、localStorage/sessionStorage、
   *  XMLHttpRequest），不是宿主对象。
   * 理论上它们抛的 Error 属于沙箱 realm —— 但必须**实测**，
   * 不能靠推断（XMLHttpRequest 内部调 fetch，
   * fetch 的失败路径在 sandbox.js:337-338 重建过 Error，值得单独确认）。
   */
  { key: 'document', kind: 'sandbox', label: 'document.createElement() 缺参', expr: 'document.createElement()' },
  { key: 'document', kind: 'sandbox', label: 'document.cookie 赋值', expr: "(function(){ document.cookie = 'a'; return 1 })()" },
  { key: 'navigator', kind: 'sandbox', label: 'navigator.userAgent', expr: 'navigator.userAgent' },
  { key: 'localStorage', kind: 'sandbox', label: 'localStorage.setItem() 缺参', expr: 'localStorage.setItem()' },
  { key: 'localStorage', kind: 'sandbox', label: 'localStorage.getItem() 缺参', expr: 'localStorage.getItem()' },
  { key: 'sessionStorage', kind: 'sandbox', label: 'sessionStorage.clear()', expr: 'sessionStorage.clear()' },
  { key: 'XMLHttpRequest', kind: 'sandbox', label: 'new XMLHttpRequest()', expr: 'new XMLHttpRequest()' },
  { key: 'XMLHttpRequest', kind: 'sandbox', label: 'XHR.open() 缺参', expr: '(function(){var x=new XMLHttpRequest(); x.open(); return 1})()' },
  { key: 'window', kind: 'sandbox', label: 'window 不存在属性访问', expr: 'window.__no_such__' },
  { key: 'global', kind: 'sandbox', label: 'global 不存在属性访问', expr: 'global.__no_such__' },
  { key: 'self', kind: 'sandbox', label: 'self 不存在属性访问', expr: 'self.__no_such__' },
  { key: 'globalThis', kind: 'sandbox', label: 'globalThis 不存在属性访问', expr: 'globalThis.__no_such__' },
  { key: 'globalThis', kind: 'sandbox', label: 'globalThis.constructor 探测', expr: 'globalThis.constructor' }
]
