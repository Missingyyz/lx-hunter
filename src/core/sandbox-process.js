'use strict'
/**
 * 子进程沙箱（v1.13.14）：`Sandbox` 的跨进程实现，接口与之对齐。
 *
 * 设计取舍与理由见 sandbox-worker.js 的头注释。这里只强调三件落地细节：
 *
 * 一、为什么用 fork + --permission 而不是继续加固 vm
 *    vm 的逃逸面「验证成本不可穷尽」——四次同类复核每次都发现新的一类漏点。
 *    `--permission` 是**操作系统/运行时级**边界，不需要我们逐个记得泄露点。
 *
 * 二、接口必须与 `Sandbox` 同形，否则调用方要分叉
 *    `checker.js` 只用 init / dispatch / stop / destroy / initError / updateTips，
 *    而且 init 和 dispatch **本来就是 await 的**，所以换成异步后端时签名不变。
 *    唯一无法保留的是同步的 `run()` / `probeRegistered*()`：跨进程不可能同步返回。
 *    解法是把注册表快照放进 init 的返回值里（worker 侧 init 结束后一并上行），
 *    `probeRegisteredSources()` 改成返回缓存快照，语义等价。
 *
 * 三、子进程异常必须降级成「脚本不可用」，不能变成「检测系统故障」
 *    崩溃 / 超时 / 协议错乱都归到 loadError，让上层显示「脚本执行报错」，
 *    而不是抛出去把整个检测任务打断。
 */

const { fork } = require('child_process')
const path = require('path')
const crypto = require('crypto')

const WORKER = path.join(__dirname, 'sandbox-worker.js')
// 冷启动实测：fork + 首次 IPC 约 101ms（其中加载 sandbox.js 仅 11ms）。
const READY_TIMEOUT_MS = 8000

/**
 * 上行协议 token（v1.13.15）
 *
 * ⚠ 这是**堵一个已实测可利用的洞**，不是防御性编程。
 *
 * 实测（tests/tools/attack-surface.js ⑧）：父进程对子进程 stdout 上的
 * 「任意一行 JSON」无条件信任。只要脚本能拿到真 process（=已逃逸），
 * 写一行 `{"t":"tip","tip":{"url":"http://evil/x"}}` 就能让父进程接受一条伪造的
 * 更新提示；同理可以伪造 `dispatched` 结果（=伪造取链 URL）、伪造 `inited`。
 * 而且这种伪造**不需要子进程权限之外的任何东西**。
 *
 * 做法：fork 时生成一个 16 字节随机 token，只通过 `env` 交给子进程
 * （env 不经过 stdout，脚本要拿到它必须先读 process.env）。
 * 子进程每条上行消息都带 `k` 字段，父进程比对；不带或不对的一律丢弃并记账。
 *
 * 为什么不是无懈可击：脚本若已逃逸，可以读 `process.env` 拿到 token 再伪造。
 * 但那需要**先逃逸**（现在最多只能读 /app/src + 出网），比原来的「只要拿到
 * process 就能伪造」提高了一档。彻底解法是把上行通道换成 IPC
 * （`child.send` / `process.send`），stdout 只留日志——列为后续项。
 */
function makeProtocolToken() {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * 计算 `--permission` 允许读取的路径。
 *
 * ⚠ 这个参数**不能省**：不给任何 `--allow-fs-read` 时，连
 *   `require('./sandbox.js')` 都会 ERR_ACCESS_DENIED（node:fs:2727），子进程直接起不来。
 *   所以至少要给本目录（src），给到 src 的父目录（= 应用根）更稳，
 *   但**绝不能给 /data 或整个文件系统** —— 那正是我们要隔离的东西。
 *
 * 同时把 node 可执行文件自身所在目录、以及 node_modules 的解析路径算进去，
 * 否则安装了可选依赖时 require 会失败。
 */
function permissionArgs(opts) {
  const o = opts || {}
  // 调用方可显式覆盖（测试用）；默认给应用根（src 的上一级）
  const readRoots = Array.isArray(o.fsReadRoots) && o.fsReadRoots.length
    ? o.fsReadRoots
    : [path.resolve(__dirname, '..')]
  const args = ['--permission']
  for (const p of readRoots) args.push('--allow-fs-read=' + p)
  // 堆上限（v1.13.15）：见下方 maxOldSpaceMb 的说明
  const heap = Number(o.maxOldSpaceMb)
  if (heap > 0) args.push('--max-old-space-size=' + Math.round(heap))
  return args
}

class SandboxProcess {
  /**
   * @param {object} opts 与 Sandbox 同名的选项（id / fetchTimeout / initGraceMs /
   *   maxInflight / maxTotalFetches / knownHosts / onLog），另加：
   *   - fsReadRoots  覆盖 --allow-fs-read（仅测试用）
   *   - noPermission 关闭 --permission（仅用于对照实验，绝不在生产打开）
   *   - workerPath   覆盖 worker 脚本路径（仅测试用）
   *   - maxOldSpaceMb 给子进程加 --max-old-space-size=N（堆上限，MB）
   *
   * maxOldSpaceMb 的设计说明（v1.13.15）：
   *   资源维度和权限维度是**两件独立的事**。--permission 只管 fs/child_process，
   *   不管内存；容器又没有 cgroup memory 限额，所以恶意脚本可以把整机吃满，
   *   进而被 OOM Killer 选中（上一版就出过 SIGKILL 137）。
   *   加堆上限能让「越界只崩这一个子进程」而不是拖死整机。
   *   ⚠ 默认**不设**：混淆音源本身就可能吃较多内存，贸然设小会误伤正常音源。
   *   是否启用由调用方按实测数据决定（见 tests/tools/mem-bomb.js）。
   */
  constructor(opts) {
    opts = opts || {}
    this.id = opts.id || 'sbp_' + Date.now()
    this.opts = opts
    this.onLog = opts.onLog || function () {}
    this.workerPath = opts.workerPath || WORKER
    this.destroyed = false
    this.stopped = false
    this._failed = false            // _failAll 幂等标志（stdin error / exit / child error 可能并发触发）
    this.initError = null
    this.updateTips = []
    this.events = []
    this.cookies = {}
    this.baseUrl = null
    // init 后拿到的注册表快照（替代同步 probeRegistered*）
    this.registeredSources = []
    this.registeredEvents = []
    // 出站审计：在父进程侧做（子进程的 record 也会上行，但父进程要能直接读）
    this.outboundAudit = null
    this.child = null
    this._readyPromise = null
    this._readyResolve = null
    this._readyReject = null
    this._pendingInit = null
    this._pending = new Map()   // rid -> { resolve, reject, timer }
    this._rid = 0
    this._stdoutBuf = ''
    this._exitReason = null
    this._spawn()
  }

  _spawn() {
    const env = Object.assign({}, process.env)
    // 子进程不要继承 debugger/inspector 相关变量
    delete env.NODE_OPTIONS
    // ⚠ execArgv 里**只放 node 参数**，绝不要放 worker 路径：
    //   fork(modulePath, args, opts) 会自己把 modulePath 追加到 argv。
    //   实测（容器内 spawnargs）：
    //     写错 → node --permission --allow-fs-read=/app/src worker.js worker.js   ← 路径重复
    //     正确 → node --permission --allow-fs-read=/app/src worker.js
    //   重复虽然不致命（第二个被当成 argv 透传给 worker），但会污染自检断言。
    const execArgv = this.opts.noPermission ? [] : permissionArgs(this.opts)
    // ⚠ 堆上限必须与 --permission 解耦：noPermission 时 execArgv 被清空，
    //   堆限制不能跟着丢（它和权限是两回事，见 maxOldSpaceMb 注释）
    const heapMb = Number(this.opts.maxOldSpaceMb)
    if (heapMb > 0 && !execArgv.some(a => a.startsWith('--max-old-space-size='))) {
      execArgv.push('--max-old-space-size=' + Math.round(heapMb))
    }

    // 上行协议 token：见 makeProtocolToken() 上方注释（堵 stdout 伪造）
    this._protocolToken = makeProtocolToken()
    env.LX_SANDBOX_TOKEN = this._protocolToken
    // 记账：被丢弃的伪造/非法行条数，便于上层发现「有脚本在写 stdout」
    this.rejectedProtocolLines = 0
    // 超时计数：用于「所有平台都超时 → 判定脚本整体卡死 → 收掉省 CPU」
    this.timeoutCount = 0
    this._killAfterTimeouts = Number(this.opts.killAfterTimeouts) > 0 ? Number(this.opts.killAfterTimeouts) : 0

    try {
      this.child = fork(this.workerPath, [], {
        execArgv,
        // fork 的 modulePath 已经指定了 worker，这里 stdio 要管道化才能收发协议
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env,
        // 不给子进程继承父进程的 cwd 之外的语义；cwd 设成 src 让相对 require 稳
        cwd: path.dirname(this.workerPath)
      })
    } catch (e) {
      this._exitReason = '无法启动沙箱子进程: ' + String((e && e.message) || e).slice(0, 200)
      this.initError = this._exitReason
      return
    }

    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve
      this._readyReject = reject
    })
    // 没人接的拒绝会冒成 unhandledRejection，预挂兜底
    this._readyPromise.catch(() => {})

    const readyTimer = setTimeout(() => {
      if (this._readyResolve) { const r = this._readyResolve; this._readyResolve = null; this._readyReject = null; r(false) }
    }, READY_TIMEOUT_MS)

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      this._stdoutBuf += chunk
      let i
      while ((i = this._stdoutBuf.indexOf('\n')) >= 0) {
        const line = this._stdoutBuf.slice(0, i)
        this._stdoutBuf = this._stdoutBuf.slice(i + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch (e) { continue }
        // 协议 token 校验（v1.13.15）：见 makeProtocolToken 上方注释。
        // 不带 token 或不匹配 → 视为伪造/污染行，丢弃并记账。
        // 注意 'ready' 也要校验：否则脚本可以先伪造 ready 抢占初始化。
        if (!msg || msg.k !== this._protocolToken) {
          this.rejectedProtocolLines++
          if (this.rejectedProtocolLines <= 3) {
            this._log('[协议] 丢弃 1 行无有效 token 的上行消息（疑似脚本直写 stdout）')
          }
          continue
        }
        delete msg.k
        if (msg.t === 'ready') {
          clearTimeout(readyTimer)
          if (this._readyResolve) { const r = this._readyResolve; this._readyResolve = null; this._readyReject = null; r(true) }
          continue
        }
        this._onMessage(msg)
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      // 子进程的 stderr 是它自己的错误（含 --permission 拒绝信息），转成日志
      const s = String(chunk).trim()
      if (s) this._log('[子进程] ' + s.slice(0, 400))
    })
    // ★ stdin 的 'error' 必须监听（v1.13.16，EPIPE 上线阻塞项）
    //   子进程被 OOM killer 杀掉后，stdin 管道已关闭，此时 _send() 的 write()
    //   会以**异步 'error' 事件**（EPIPE / ECONNRESET）冒出。Node 对没有监听器的
    //   'error' 事件会升级成 uncaught exception → **直接崩掉主进程**。
    //   同步 try/catch（_send 里那个）接不到异步 emit，所以必须在这里挂监听。
    //   注意幂等：OOM 后 child.on('exit') 也会触发 _failAll；_failAll 自身已幂等。
    this.child.stdin.on('error', e => {
      const code = String((e && e.code) || 'UNKNOWN')
      const why = '沙箱子进程 stdin 写入失败（' + code + '）：子进程可能已被 OOM killer 终止'
      this._log('[子进程] ' + why)
      if (this._exitReason == null) this._exitReason = why
      this._failAll(why)
    })
    this.child.on('error', e => {
      this._exitReason = '子进程错误: ' + String((e && e.message) || e).slice(0, 200)
      this._failAll(this._exitReason)
    })
    this.child.on('exit', (code, signal) => {
      clearTimeout(readyTimer)
      const why = '沙箱子进程已退出（code=' + code + ', signal=' + signal + '）'
      // 只有非正常退出才记为故障原因；正常 close 后退出不算
      if (!this.destroyed && code !== 0) this._exitReason = why
      this._failAll(this._exitReason || why)
    })
  }

  _log(m) {
    try { this.onLog(m) } catch (e) {}
  }

  _onMessage(msg) {
    if (msg.t === 'log') {
      this._log(msg.msg)
      return
    }
    if (msg.t === 'tip') {
      // 更新提示（updateTip / updateAlert）：进程内版由 __host_emit 收集，
      // 子进程版必须显式上转，否则「有新版本」这个功能会静默消失。
      const tip = msg.tip
      if (tip && tip.url && !this.updateTips.some(t => t.url === tip.url)) {
        this.updateTips.push({
          url: String(tip.url),
          msg: String(tip.msg || '').slice(0, 200),
          at: Number(tip.at) || Date.now()
        })
        if (this.updateTips.length > 5) this.updateTips = this.updateTips.slice(-5)
      }
      return
    }
    if (msg.t === 'fatal') {
      this._exitReason = String(msg.e || '子进程致命错误').slice(0, 300)
      this.initError = this._exitReason
      this._failAll(this._exitReason)
      return
    }
    if (msg.t === 'inited') {
      const p = this._pendingInit
      this._pendingInit = null
      if (!p) return
      const r = msg.r || {}
      // 缓存注册表快照，供同步的 probeRegistered* 使用
      if (Array.isArray(r.sources)) this.registeredSources = r.sources.slice()
      if (Array.isArray(r.events)) this.registeredEvents = r.events.slice()
      if (r.initError) this.initError = r.initError
      if (r.error) this.initError = String(r.error).slice(0, 300)
      p.resolve(r)
      return
    }
    if (msg.t === 'dispatched') {
      const p = this._pending.get(msg.rid)
      if (!p) return
      this._pending.delete(msg.rid)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.v)
      else p.reject(new Error(String(msg.e || '取链失败').slice(0, 300)))
    }
  }

  _failAll(reason) {
    // 幂等：OOM 场景下 stdin 'error' / child 'error' / child 'exit' 可能几乎同时触发。
    // 原实现已经"事实幂等"（ready/pendingInit 先置 null、pending reject 后 clear），
    // 这里再加一道显式闸门，保证日志与副作用也只走一次，防未来回归。
    if (this._failed) return
    this._failed = true
    const err = new Error(String(reason || '沙箱子进程不可用').slice(0, 300))
    // ★ 必须一并收尾 ready：否则 init() 会一直等到 READY_TIMEOUT_MS 才失败。
    //   实测：fork 一个不存在的 worker 时 stdout 永不发 ready，只靠 exit 事件；
    //   这里不收尾的话，调用方要多等 8 秒才拿到「子进程不可用」。
    if (this._readyResolve) {
      const r = this._readyResolve
      this._readyResolve = null
      this._readyReject = null
      r(false)
    }
    if (this._pendingInit) {
      const p = this._pendingInit
      this._pendingInit = null
      p.resolve({ inited: false, error: err.message })
    }
    for (const [, p] of this._pending) {
      clearTimeout(p.timer)
      try { p.reject(err) } catch (e) {}
    }
    this._pending.clear()
  }

  _send(obj) {
    if (!this.child || this.child.killed || this.child.exitCode != null) return false
    const stdin = this.child.stdin
    // 流已销毁（子进程退出 / OOM 后）直接判失败，不要往死管道里写。
    if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.writableFinished) return false
    try {
      // 注意：write() 返回 false 只是"内核缓冲满、进入队列待发"的背压信号，
      // 数据仍会发完（或后续 emit 'error' 由上面的监听兜住），**不是写失败**。
      // 若把它当 false 返回，会让 init()/dispatch() 在正常负载下误判失败（功能倒退）。
      // 真正的写失败由三条路径覆盖：上面的流状态前置检查、下面的同步 throw、
      // 以及异步 'error' 监听 → _failAll → 所有 pending 收到 reject + _exitReason。
      stdin.write(JSON.stringify(obj) + '\n')
      return true
    } catch (e) {
      // 同步抛错（如流在 write 瞬间被 destroy 的竞态）→ 明确告知调用方失败。
      return false
    }
  }

  /** 等子进程就绪；返回 false 表示没等到（省得调用方无限等） */
  async _ready() {
    if (!this._readyPromise) return false
    try { return await this._readyPromise } catch (e) { return false }
  }

  // --------------------------------------------------------------------------
  // 与 Sandbox 对齐的接口
  // --------------------------------------------------------------------------

  async init(code, meta) {
    this.events.length = 0
    const hp = meta && meta.homepage
    this.baseUrl = (typeof hp === 'string' && /^https?:\/\//i.test(hp)) ? hp : null
    const ok = await this._ready()
    if (!ok) {
      const why = this._exitReason || '沙箱子进程未就绪（可能被 --permission 拒绝读取运行所需文件）'
      this.initError = why
      return { inited: false, error: why }
    }
    if (this.destroyed || this.stopped) return { inited: false, error: '已取消' }
    const initTimeout = Math.max(
      5000,
      (Number(this.opts.initGraceMaxMs) || 15000) + 5000
    )
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!this._pendingInit) return
        this._pendingInit = null
        this.initError = '子进程初始化超时'
        resolve({ inited: false, error: '子进程初始化超时' })
      }, initTimeout)
      this._pendingInit = {
        resolve: r => { clearTimeout(timer); resolve(r) }
      }
      const sent = this._send({
        t: 'open',
        id: this.id,
        opts: {
          id: this.opts.id,
          fetchTimeout: this.opts.fetchTimeout,
          dispatchTimeout: this.opts.dispatchTimeout,
          initGraceMs: this.opts.initGraceMs,
          initGraceMaxMs: this.opts.initGraceMaxMs,
          maxInflight: this.opts.maxInflight,
          maxTotalFetches: this.opts.maxTotalFetches,
          knownHosts: this.opts.knownHosts,
          allowPrivateHosts: this.opts.allowPrivateHosts === true
        },
        code: String(code || ''),
        meta: meta || {}
      })
      if (!sent) {
        clearTimeout(timer)
        this._pendingInit = null
        const why = this._exitReason || '无法向沙箱子进程发送初始化指令'
        this.initError = why
        resolve({ inited: false, error: why })
      }
    })
  }

  /** 注册表快照（init 结束时已上行）；语义等同 Sandbox 的同名方法 */
  probeRegisteredSources() { return this.registeredSources.slice() }

  probeRegisteredEvents() { return this.registeredEvents.slice() }

  /**
   * 跨进程模式下没有同步 run()：显式抛错比静默返回 undefined 好。
   * 目前没有任何生产代码调用它（checker 只用 init/dispatch），
   * 保留这个名字是为了让「误用」有一个明确的报错信息。
   */
  run() {
    throw new Error('SandboxProcess 不支持同步 run()：跨进程无法同步执行脚本。请用 init()/dispatch()')
  }

  /** 设置脚本元信息：沙箱内由 init 一次性完成，这里保留空实现以兼容接口 */
  setScriptInfo() {}

  dispatch(action, payload, timeoutMs) {
    if (this.stopped || this.destroyed) return Promise.reject(new Error('已取消'))
    const rid = 'hq_' + Date.now() + '_' + (this._rid++)
    const tmo = Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(rid)
        this.timeoutCount++
        // ★ 超时后要不要杀子进程（v1.13.15）——**默认不杀**，这是有意取舍。
        //
        // 实测（attack-surface.js ④）：脚本 `while(1){}` 时 dispatch 超时返回，
        // 但子进程仍在空转，只有 destroy() 才停 → 确实占 CPU。
        //
        // 但「超时就杀」会引入更严重的功能倒退：
        //   同一个脚本里，若某平台卡死、另一平台正常可用，
        //   杀掉进程会让那个**本来可用的平台也测不出来**（usable → failed）。
        //   checker 是逐平台 dispatch 同一个沙箱的，误伤范围是整个脚本。
        // 实测证据见 tests/sandbox-timeout-kill.test.js：killOnTimeout=true 时
        // 可用的平台会一起丢掉。
        //
        // 折中：默认只在「累计超时次数达到所有平台都试过」时收手，
        // 由调用方通过 killOnTimeout / killAfterTimeouts 显式启用。
        // 不启用时，CPU 空转最多持续到本条目检测结束（finally 里的 destroy）。
        if (this.opts.killOnTimeout === true) {
          this._killChild('取链超时')
        } else if (this._killAfterTimeouts > 0 && this.timeoutCount >= this._killAfterTimeouts) {
          // 「全都超时」= 脚本整体卡死，没有抢救价值，收掉省 CPU
          this._killChild('连续取链超时（已达 ' + this.timeoutCount + ' 次）')
        }
        reject(new Error('取链超时'))
      }, tmo)
      this._pending.set(rid, { resolve, reject, timer })
      const sent = this._send({ t: 'dispatch', rid, action, payload, timeoutMs: tmo })
      if (!sent) {
        clearTimeout(timer)
        this._pending.delete(rid)
        reject(new Error(this._exitReason || '沙箱子进程不可用'))
      }
    })
  }

  /**
   * 杀掉子进程并收尾所有等待中的请求。
   * 与 destroy() 的区别：destroy 是「主动收工」，这里是「判定不可信，强制终止」。
   * 都会让 killed 之后的 dispatch 快速失败而不是挂满超时。
   */
  _killChild(reason) {
    const why = String(reason || '沙箱子进程已被终止').slice(0, 200)
    if (this._exitReason == null) this._exitReason = why
    this._failAll(why)
    const c = this.child
    if (c && !c.killed && c.exitCode == null) {
      try { c.kill('SIGKILL') } catch (e) {}
    }
  }

  /**
   * 停止：标记停止 + 拒绝后续 dispatch + **一并杀掉子进程**（v1.13.15）。
   *
   * 原来 stop() 只 `_send({t:'stop'})` 不 kill，实测（attack-surface.js ⑤）
   * stop() 之后子进程依然存活（还挂着脚本的 setInterval）。
   * 正常路径下 checker 的 finally 会补 destroy()，所以不漏；但任何
   * 「提前 return / 抛错跳过 finally」的路径都会泄漏一个正跑定时器的进程。
   * 一行代价就能堵住，不值得赌调用方永远写对 finally。
   */
  stop() {
    this.stopped = true
    this._send({ t: 'stop' })
    this._failAll('已取消')
    const c = this.child
    if (c && !c.killed && c.exitCode == null) {
      // 给 100ms 让 worker 自己退出（它会 destroy 沙箱、清定时器），再强杀
      const t = setTimeout(() => {
        try { if (c.exitCode == null) c.kill('SIGKILL') } catch (e) {}
      }, 100)
      if (t.unref) t.unref()
      c.once('exit', () => clearTimeout(t))
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.stopped = true
    this._failAll('已取消')
    try { this._send({ t: 'close' }) } catch (e) {}
    // 给 100ms 优雅退出，然后强杀：音源脚本可能挂着不肯结束的定时器
    const c = this.child
    if (c && !c.killed && c.exitCode == null) {
      const t = setTimeout(() => {
        try { c.kill('SIGKILL') } catch (e) {}
      }, 100)
      if (t.unref) t.unref()
      c.once('exit', () => clearTimeout(t))
    }
  }
}

module.exports = { SandboxProcess, permissionArgs, WORKER_PATH: WORKER }
