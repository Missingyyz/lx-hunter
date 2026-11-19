'use strict'
/**
 * 沙箱子进程（v1.13.14）—— 用 `--permission` 把「逃逸」降级成「逃不出去也伤不到」。
 *
 * ============================================================================
 * 为什么要有这个文件
 * ============================================================================
 * 上一版的做法是把 `vm` 加固到极致（facade 包装 + codeGeneration 关闭）。实测仍然
 * 被攻破 4 次，而且每次都是**新发现的一类**漏点：假类原型链归属、realm 归属、
 * 只测注入面漏交回面、只测同步漏 `.then` 异步。这不是「再修一次就好」的问题——
 * 它的验证成本不可穷尽，"测试全绿"与"实际 RCE"可以同时成立。
 *
 * 所以改路线：**不再追求「逃不出去」，改成「逃出去也伤不到」**。
 *
 *   父进程：可信逻辑（读写库、跑检测流程、AI 调用）
 *   子进程：只跑不可信音源脚本，用 Node 22 的 `--permission` 做**操作系统级**限制
 *
 * 实测（容器内 node v22.23.5）：
 *   不给 --allow-fs-read     → 连 require('sandbox.js') 都跑不起来（ERR_ACCESS_DENIED）
 *   给 --allow-fs-read=/app/src → /data 完全不可达；逃逸成功也读不到；检测功能正常
 *   写文件 / execSync / dlopen / fork → 全部 ERR_ACCESS_DENIED
 *
 * ⚠ 那个 `--allow-fs-read` **必须**给（本文件所在目录），否则启动即失败。
 *   代价是子进程能读自己的源码（不敏感），远小于「整个容器文件系统随便读」。
 *
 * ============================================================================
 * 进程内仍然保留 facade 加固
 * ============================================================================
 * 子进程只解决「越界之后能碰到什么」，不解决「碰到什么之后能干什么」。
 * 进程内的 `Sandbox`（vm + facade）原样保留并继续加固——两件事都要做：
 *   子进程 + --permission → 挡住 fs / 命令 / dlopen
 *   vm + facade           → 让逃逸本身更难，且挡住网络/进程内其它资源
 * 缺前者：逃逸后直接读 config.json（上一版就是这样丢的）。
 * 缺后者：子进程里脚本能改到宿主对象、能自由发请求。
 *
 * ============================================================================
 * 通信协议（只传 JSON，绝不传对象）
 * ============================================================================
 * 跨进程传对象会「重新制造」一类交回面问题（结构化克隆出来的对象在接收侧
 * 又是一个裸的宿主对象）。所以这里的规矩是：**进出都是 JSON 字符串**。
 *
 * 父 → 子（stdin 按行 JSON）：
 *   {t:'open', id, opts, code, meta}     建沙箱并执行脚本
 *   {t:'dispatch', rid, action, payload, timeoutMs}
 *   {t:'stop'}   中止（拒绝待完成）
 *   {t:'close'}  退出
 * 子 → 父（stdout 按行 JSON）：
 *   {t:'log', id, msg}
 *   {t:'inited', id, r}         init 结果
 *   {t:'dispatched', rid, ok, v, e}
 *   {t:'ready'}                 启动就绪
 *   {t:'fatal', e}
 */

const readline = require('readline')

let sb = null
let sbId = null
// 父进程 fork 时下发的协议 token（env 下发，不经过 stdout）。见 sandbox-process.js
const PROTOCOL_TOKEN = process.env.LX_SANDBOX_TOKEN || ''

/** 统一上行：一行一个 JSON。绝不 throw（否则子进程会带着调用方的请求一起死） */
function emit(obj) {
  try {
    // 每条上行都带协议 token（v1.13.15）：父进程用 fork 时下发的随机值校验，
    // 挡住「脚本逃逸后直写 stdout 伪造 dispatched / tip / inited」。
    // token 走 env 下发，不经过 stdout。
    obj.k = PROTOCOL_TOKEN
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch (e) {
    // stdout 都写不进去就没办法了，但绝不能抛
  }
}

/**
 * 兜底：子进程里任何未捕获异常/拒绝都只记账，不退出。
 * 与父进程同样的理由——音源脚本不接 catch 是常态，崩了会让父进程收到一个
 * 空白的「子进程已退出」，把「脚本写得烂」误报成「检测系统故障」。
 */
process.on('uncaughtException', e => {
  emit({ t: 'log', id: sbId, msg: '子进程未捕获异常: ' + String((e && e.message) || e).slice(0, 200) })
})
process.on('unhandledRejection', e => {
  emit({ t: 'log', id: sbId, msg: '子进程未处理拒绝: ' + String((e && e.message) || e).slice(0, 200) })
})

/**
 * 惰性 require：让「require 失败」变成一个可以回报给父进程的错误，
 * 而不是启动即崩（否则父进程只看到子进程秒退，无法归因）。
 */
function loadSandbox() {
  try {
    return require('./sandbox')
  } catch (e) {
    emit({ t: 'fatal', e: '子进程无法加载 sandbox.js: ' + String((e && e.message) || e).slice(0, 200) })
    return null
  }
}

function handleOpen(msg) {
  const mod = loadSandbox()
  if (!mod) return
  const { Sandbox } = mod
  sbId = msg.id
  const opts = Object.assign({}, msg.opts || {})
  // 日志一律转成上行消息：子进程直接写 stdout 会污染协议流
  opts.onLog = m => emit({ t: 'log', id: sbId, msg: String(m).slice(0, 500) })
  // ★ 更新信号必须单独上转（v1.13.15）。
  //
  // 进程内版里 `__host_emit` 会把 updateTip / updateAlert 两条通道收进
  // `self.updateTips`，deepCheck 再把它写回条目（UI 靠它提示"有新版本"）。
  // 子进程里如果只上转 log/inited/dispatched，这两个信号就**静默丢失**——
  // 不抛错、不报错，只是「版本更新提示」这个功能悄悄没了。
  // 这类"静默功能缺失"比崩溃更难发现，所以单独用一条协议消息保住它。
  opts.onTip = tip => emit({ t: 'tip', id: sbId, tip })
  try {
    sb = new Sandbox(opts)
  } catch (e) {
    emit({ t: 'inited', id: sbId, r: { inited: false, error: '子进程创建沙箱失败: ' + String((e && e.message) || e).slice(0, 200) } })
    return
  }
  sb.init(msg.code, msg.meta || {}).then(r => {
    // 注册表快照随 init 一起上行：父进程侧不再需要「同步 run() 读注册表」，
    // 那几个探针在跨进程模式下无法同步执行（见 sandbox-process.js 的说明）。
    let sources = []
    let events = []
    try { sources = sb.probeRegisteredSources() } catch (e) {}
    try { events = sb.probeRegisteredEvents() } catch (e) {}
    // ⚠ initError 是实例属性（sandbox.js:469 赋在 this 上），不在 init() 的返回值里。
    // 上一版读 r.initError 永远拿到 undefined，导致「脚本执行报错」这类原因丢失，
    // 上层只能显示泛化的「脚本未调用 inited」。
    emit({
      t: 'inited',
      id: sbId,
      r: {
        inited: !!(r && r.inited),
        data: (r && r.data) || null,
        recovered: !!(r && r.recovered),
        guessedSources: !!(r && r.guessedSources),
        runError: (r && r.runError) || null,
        waitedMs: (r && r.waitedMs) || 0,
        initError: sb.initError || null,
        sources,
        events
      }
    })
  }, e => {
    emit({ t: 'inited', id: sbId, r: { inited: false, error: String((e && e.message) || e).slice(0, 200) } })
  })
}

function handleDispatch(msg) {
  if (!sb) {
    emit({ t: 'dispatched', rid: msg.rid, ok: false, e: '沙箱未初始化' })
    return
  }
  sb.dispatch(msg.action, msg.payload, msg.timeoutMs).then(v => {
    // ⚠ 注意 vm 版 Sandbox.dispatch 的返回值是**信封** {id, result}，
    // 不是裸的取链结果（sandbox.js:217 直接 resolve 了整个 dispatchResult 事件）。
    // 上一版这里按「裸结果」写的，导致取链值被埋进 result 字段，调用方拿到对象当 URL 用。
    // 跨进程协议要**原样保留**这个信封，父进程才不必分叉两套解析。
    let safe = null
    try {
      safe = JSON.parse(JSON.stringify(v === undefined ? null : v))
    } catch (e) {
      emit({ t: 'dispatched', rid: msg.rid, ok: false, e: '取链结果无法序列化: ' + String((e && e.message) || e).slice(0, 120) })
      return
    }
    emit({ t: 'dispatched', rid: msg.rid, ok: true, v: safe })
  }, e => {
    emit({ t: 'dispatched', rid: msg.rid, ok: false, e: String((e && e.message) || e).slice(0, 200) })
  })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  if (!line) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch (e) {
    emit({ t: 'log', id: sbId, msg: '子进程收到非 JSON 输入，已忽略' })
    return
  }
  try {
    if (msg.t === 'open') return handleOpen(msg)
    if (msg.t === 'dispatch') return handleDispatch(msg)
    if (msg.t === 'stop') {
      if (sb) { try { sb.stop() } catch (e) {} }
      return
    }
    if (msg.t === 'close') {
      if (sb) { try { sb.destroy() } catch (e) {} }
      process.exit(0)
    }
  } catch (e) {
    emit({ t: 'log', id: sbId, msg: '子进程处理 ' + String(msg.t) + ' 时出错: ' + String((e && e.message) || e).slice(0, 200) })
  }
})
rl.on('close', () => {
  if (sb) { try { sb.destroy() } catch (e) {} }
  process.exit(0)
})

emit({ t: 'ready' })
