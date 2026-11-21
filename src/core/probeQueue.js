'use strict'
/**
 * 隔离区「试跑一次」的入口约束（v1.13.13）——**唯一来源**。
 *
 * ============================================================================
 * 为什么这些约束放在「入口层」而不是 hunter.probeQuarantined 内部
 * ============================================================================
 * hunter 是个纯业务对象，可能被桌面 IPC、Web HTTP、定时任务等多个入口调用，
 * 每个入口有自己的调用节奏；而「单轮 ≤5 条、串行」是**用户手动点试跑**这个交互的约束。
 * 把它放在入口层，既保证语义正确，也保证两端（桌面 / Web）行为一致。
 *
 * ============================================================================
 * 为什么抽成共享模块（而不是在 main 和 web 各写一份）
 * ============================================================================
 * 原来这套配额只写在 `src/main/index.js` 的 IPC handler 里。A1 复查时发现
 * **Web 端根本没有试跑通道**：`renderer` 两端共用同一份 app.js，「试跑一次」按钮
 * 在 Web 上照样渲染出来，点下去 web-bridge 没有对应方法、服务端也没有路由，
 * 必然报「试跑失败」。
 *
 * 补 Web 路由时必须同步补配额——否则 Web 端可以通过反复点击无限试跑，
 * 而每条试跑都会真开沙箱跑脚本（可能吃满一个核）。两份手抄的实现迟早会漂移
 * （改了一处忘了另一处，且漂移的表现是「某一端没有保护」这种不报错的问题），
 * 所以收敛到这里。
 *
 * ============================================================================
 * 约束的由来（用户拍板 + 实测）
 * ============================================================================
 *  - 单轮 5 条：试跑会占用本机 CPU，要求用户先看完这 5 条的结果。
 *  - 串行：并发试跑会同时开多个沙箱，每个沙箱都会打满一个核，
 *    那正是用户明确不想看到的情况。
 *  - 「一轮」= 10 分钟窗口，过期自动重置，不需要用户手动「开始新一轮」。
 *  - 超上限**不是静默忽略**：明确抛错并说清原因与恢复方式。
 */

const PROBE_LIMIT_PER_ROUND = 5
const PROBE_WINDOW_MS = 10 * 60 * 1000

/**
 * 造一个试跑队列（每次启动/每个入口一个实例，不要跨进程共享）。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]    单轮上限（默认 5）
 * @param {number} [opts.windowMs] 单轮窗口（默认 10 分钟）
 * @param {function} [opts.now]    时钟注入（测试用，默认 Date.now）
 * @returns {{run: function(function():Promise<object>):Promise<object>, limit:number, windowMs:number}}
 */
function makeProbeQueue (opts) {
  const o = opts || {}
  const limit = Number.isFinite(o.limit) && o.limit > 0 ? o.limit : PROBE_LIMIT_PER_ROUND
  const windowMs = Number.isFinite(o.windowMs) && o.windowMs > 0 ? o.windowMs : PROBE_WINDOW_MS
  const now = typeof o.now === 'function' ? o.now : Date.now

  let used = 0
  let at = 0
  let chain = Promise.resolve()

  return {
    limit,
    windowMs,
    /**
     * 排队执行一次试跑。
     *
     * 注意 `fn` 是在**链尾**才被调用的（不是先调用再排队），
     * 所以 `hunter.probeQuarantined` 真正开沙箱的时刻由链条决定，
     * 天然不会出现两个沙箱并发。
     *
     * @param {function():Promise<object>} fn 真正干活的函数（一般是 () => hunter.probeQuarantined(...)）
     * @returns {Promise<object>} fn 的结果，附加 roundUsed / roundLimit 供 UI 显示进度
     */
    run (fn) {
      if (typeof fn !== 'function') throw new TypeError('probeQueue.run 需要传入一个函数')
      const t = now()
      // 单轮窗口：10 分钟内算同一轮。窗口过期自动重置计数，不需要用户手动「开始新一轮」。
      if (!at || t - at > windowMs) {
        at = t
        used = 0
      }
      if (used >= limit) {
        // 不是静默忽略：明确告诉用户为什么这一条没跑、以及怎么继续
        const err = new Error(`本轮已试跑 ${used} 条，达到上限 ${limit} 条。`
          + `试跑会占用本机 CPU，请先看完这 ${limit} 条的结果；10 分钟后或重启应用可再试。`)
        err.code = 'PROBE_ROUND_LIMIT'
        err.limit = limit
        err.used = used
        // 同步抛：调用方（IPC / HTTP）应当把它当作「这次请求没被接受」，不走异步链
        throw err
      }
      used++
      const seq = used
      // 串行：前一个试跑没结束时，后来的排队等它，绝不同时开两个沙箱
      const run = chain.then(() => fn())
      // 即使这一个失败，链条也要继续（否则一次失败会卡死后面所有试跑）
      chain = run.then(() => {}, () => {})
      return run.then(r => Object.assign({}, r, { roundUsed: seq, roundLimit: limit, quota: status() }))
    },
    /**
     * v1.15 配额可见：当前轮还剩几条、何时重置。供 UI 常驻显示，不必先点一次试跑才知道。
     * @returns {{used:number, limit:number, remaining:number, resetAt:number, windowMs:number}}
     */
    status
  }

  function status () {
    const t = now()
    const fresh = !!at && (t - at <= windowMs)
    const u = fresh ? used : 0
    return {
      used: u, limit, remaining: Math.max(0, limit - u),
      resetAt: fresh ? at + windowMs : t,
      active: fresh,  // 是否已有进行中的轮（false=配额满血、尚未开始计时）
      windowMs
    }
  }
}

module.exports = { makeProbeQueue, PROBE_LIMIT_PER_ROUND, PROBE_WINDOW_MS }
