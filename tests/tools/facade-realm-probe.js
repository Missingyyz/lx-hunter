'use strict'
/**
 * 探针：确认「facade 内部抛出的 Error 属于沙箱 realm」。
 *
 * 意义：
 *   sandbox-facade.js 的 FACADE_SRC 是用 vm.runInContext(FACADE_SRC, context)
 *   在**沙箱 context 内**执行的（见 makeSandboxFacade）。
 *   如果这是真的，那么 facade 的 apply/construct 陷阱里
 *   `try { ... } catch (e) { throw new Error(...) }` 造出来的 Error
 *   就是**沙箱 realm** 的 Error —— 宿主异常消毒可以干净地落在 facade 里，
 *   不必在 sandbox.js 里为每个注入值单独包一层。
 *
 * 反之（facade 其实在宿主 realm），则这个修法不成立，
 * 必须改成「在沙箱 realm 内预先造好一个 Error 工厂，再传给 facade」。
 *
 * 本探针直接问沙箱：沙箱内看到的 facade 造出的 Error 属于哪个 realm。
 */
const path = require('path')
const vm = require('vm')
const { makeSandboxFacade } = require(path.join(__dirname, '..', '..', 'src', 'core', 'sandbox-facade.js'))

async function main () {
  const context = vm.createContext({})
  const facade = makeSandboxFacade(context)

  // 在**沙箱 context 内**造一个 Error，问宿主侧它属于哪个 realm
  const sbError = vm.runInContext('new Error("from-sandbox")', context)

  // facade 里造一个 Error（模拟消毒时的重建），取回宿主侧判定
  const facadeError = vm.runInContext(
    '(function(){ try { throw new Error("host-side-trigger") } catch (e) { return new Error("rebuilt-in-facade") } })()',
    context)

  // 让 facade 的 wrap 包一个会抛异常的宿主函数，看错误从哪来
  const hostThrower = function boom () { throw new Error('host-thrown') }
  const wrapped = facade.wrap(hostThrower)
  let caught = null
  try { wrapped() } catch (e) { caught = e }

  const hostProto = Error.prototype
  function realmOf (v) {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return 'primitive'
    let p = Object.getPrototypeOf(v); let g = 0
    while (p && g++ < 32) {
      if (p === hostProto) return 'host'
      p = Object.getPrototypeOf(p)
    }
    return 'foreign'
  }

  const out = {
    sandboxErrorRealm: realmOf(sbError),
    facadeErrorRealm: realmOf(facadeError),
    wrappedThrowRealm: caught ? realmOf(caught) : 'no-throw',
    facadeErrorIsHostProto: facadeError === hostProto,
    // ★ facade 造的 Error 与沙箱自造的 Error 是**同一个 realm**吗？
    //   这是「消毒能否落在 facade 里」的决定性判据。
    facadeErrorSameProtoAsSandboxError:
      Object.getPrototypeOf(facadeError) === Object.getPrototypeOf(sbError),
    facadeErrorSameProtoAsHostError:
      Object.getPrototypeOf(facadeError) === hostProto,
    sandboxErrorSameProtoAsHostError:
      Object.getPrototypeOf(sbError) === hostProto,
    // ★ 宿主函数经 facade.wrap 后调用，抛出的还是宿主 Error（未消毒）——根因
    wrappedThrowIsHostProtoChain: caught
      ? Object.getPrototypeOf(caught) === hostProto
      : null,
    facadeProtoChain: (function () {
      const chain = []
      let p = facadeError; let g = 0
      while (p && g++ < 8) { chain.push(p.constructor && p.constructor.name); p = Object.getPrototypeOf(p) }
      return chain
    })()
  }
  console.log(JSON.stringify(out, null, 2))
}
main().catch(e => console.log(JSON.stringify({ fatal: String(e && e.message || e) })))
