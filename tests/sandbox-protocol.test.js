'use strict'
/**
 * 上行协议完整性测试（v1.13.15）
 *
 * 背景：`tests/tools/attack-surface.js` ⑧ 实测发现，父进程原先对子进程
 * stdout 上的**任意一行 JSON 无条件信任**。只要脚本能拿到真 process（=已逃逸），
 * 写一行 `{"t":"tip",...}` 就能让父进程接受伪造的更新提示；同理可伪造
 * `dispatched`（=伪造取链 URL）与 `inited`。
 *
 * 修复：fork 时生成随机 token 经 env 下发，每条上行消息带 `k`，父进程校验。
 *
 * 本文件锁死三件事：
 *   ① 伪造行（无 token）必须被丢弃并记账
 *   ② 伪造的 `ready` 不能抢占初始化（否则脚本能让父进程误以为 worker 就绪）
 *   ③ 正常通信不受影响（真 worker 的 token 一定对）
 *
 * 铁律：先确认它在未修复的代码上会红。删掉 sandbox-process.js 里的
 * token 校验那一段，① 与 ② 必须变红。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const ROOT = path.resolve(__dirname, '..')
const { SandboxProcess } = require(path.join(ROOT, 'src', 'core', 'sandbox-process'))
const { Sandbox } = require(path.join(ROOT, 'src', 'core', 'sandbox'))

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lxproto-'))
const SRC_DIR = path.join(ROOT, 'src')
function writeFakeWorker(name, lines) {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, lines.join('\n') + '\n')
  return p
}
/**
 * 假 worker 的启动参数。
 *
 * ⚠ 必须把 TMP 加进 fsReadRoots，否则 `--permission` 会拦住 require，
 *   **假 worker 直接起不来** —— 于是「伪造被拒绝」全部空过，
 *   测试变成假绿（这一版第一次跑就是这么假的，实测 rejected=0 才暴露）。
 *   所以下面每条都额外断言「假 worker 确实启动并写了行」。
 */
function fakeOpts(extra) {
  return Object.assign({ fsReadRoots: [SRC_DIR, TMP] }, extra || {})
}

const SCRIPT = `
lx.send('inited', { sources: { wy: { name: 'wy', actions: ['musicUrl'], qualitys: ['128k'] } } })
lx.on('request', function () { return Promise.resolve('http://ok.invalid/a.mp3') })
`

async function main() {
  // ==========================================================================
  console.log('=== ① 伪造 tip（无 token）必须被丢弃 ===')
  // ==========================================================================
  {
    // 这个假 worker 完全模拟「已逃逸脚本直写 stdout」：先发正确 ready 的机会都没有，
    // 直接打伪造行。它没有 token（拿不到 env 里的随机值，因为是硬编码的）。
    const w = writeFakeWorker('forge-tip.js', [
      'process.stdout.write(JSON.stringify({t:"ready"})+"\\n")',
      'process.stdout.write(JSON.stringify({t:"tip",tip:{url:"http://evil.invalid/forged",msg:"forged"}})+"\\n")',
      'process.stdin.resume()',
      'setInterval(function(){},1000)'
    ])
    const sb = new SandboxProcess(fakeOpts({ id: 'f1', initGraceMs: 1500, workerPath: w }))
    await new Promise(r => setTimeout(r, 1200))
    const tips = (sb.updateTips || []).map(t => t.url)
    ok('伪造 tip 未被接受', !tips.some(u => /evil\.invalid/.test(u)), JSON.stringify(tips))
    ok('假 worker 确实起来了（否则本项是假绿）', !!sb._protocolToken && sb.rejectedProtocolLines > 0, 'rejected=' + sb.rejectedProtocolLines)
    ok('丢弃行被记账（rejectedProtocolLines > 0）', sb.rejectedProtocolLines > 0, 'rejected=' + sb.rejectedProtocolLines)
    try { sb.destroy() } catch (e) {}
  }

  // ==========================================================================
  console.log('=== ② 伪造 ready 不能抢占初始化 ===')
  // ==========================================================================
  {
    const w = writeFakeWorker('forge-ready.js', [
      // 先伪造 ready（无 token），再什么都不做
      'process.stdout.write(JSON.stringify({t:"ready"})+"\\n")',
      'process.stdin.resume()',
      'setInterval(function(){},1000)'
    ])
    const sb = new SandboxProcess(fakeOpts({ id: 'f2', initGraceMs: 600, workerPath: w }))
    // 若伪造 ready 被采信，init 会“开始”并且能走到 dispatch；这里断言它超时失败
    const res = await sb.init(SCRIPT, {}).catch(e => ({ __err: String(e.message || e) }))
    ok('伪造就绪未生效：init 得不到真实握手', !(res && res.inited === true), JSON.stringify(res).slice(0, 140))
    ok('确有丢弃记账', sb.rejectedProtocolLines > 0, 'rejected=' + sb.rejectedProtocolLines)
    try { sb.destroy() } catch (e) {}
  }

  // ==========================================================================
  console.log('=== ③ 伪造 dispatched（伪造取链结果）必须被拒绝 ===')
  // ==========================================================================
  {
    const w = writeFakeWorker('forge-dispatch.js', [
      'process.stdout.write(JSON.stringify({t:"ready"})+"\\n")',
      'process.stdin.resume()',
      // 收到任何输入就打一条伪造 dispatched
      'process.stdin.on("data",function(){ process.stdout.write(JSON.stringify({t:"dispatched",rid:1,ok:true,v:"http://evil.invalid/fake.mp3"})+"\\n") })',
      'setInterval(function(){},1000)'
    ])
    const sb = new SandboxProcess(fakeOpts({ id: 'f3', initGraceMs: 500, workerPath: w }))
    await new Promise(r => setTimeout(r, 600))
    let out = null
    try { out = await sb.dispatch('request', { action: 'musicUrl' }, 1200) } catch (e) { out = { __err: String(e.message || e) } }
    const gotFake = JSON.stringify(out).includes('evil.invalid')
    ok('伪造 dispatched 未被当成结果', !gotFake, JSON.stringify(out).slice(0, 140))
    ok('假 worker 确实起来了（否则本项是假绿）', !!sb._protocolToken && sb.rejectedProtocolLines > 0, 'rejected=' + sb.rejectedProtocolLines)
    try { sb.destroy() } catch (e) {}
  }

  // ==========================================================================
  console.log('=== ④ 正常通信不受影响（真 worker token 必然匹配）===')
  // ==========================================================================
  {
    const sb = new SandboxProcess({ id: 'ok1', initGraceMs: 2000 })
    const res = await sb.init(SCRIPT, {})
    ok('真 worker init 成功', res && res.inited === true, JSON.stringify(res).slice(0, 140))
    ok('注册表快照拿到 wy', (sb.registeredSources || []).includes('wy'), JSON.stringify(sb.registeredSources))
    const v = await sb.dispatch('request', { action: 'musicUrl', source: 'wy' }, 4000)
    ok('真 worker dispatch 正常', v && v.result === 'http://ok.invalid/a.mp3', JSON.stringify(v).slice(0, 140))
    ok('无丢弃记账（正常路径不该有）', sb.rejectedProtocolLines === 0, 'rejected=' + sb.rejectedProtocolLines)
    try { sb.destroy() } catch (e) {}
  }

  // ==========================================================================
  console.log('=== ⑤ 进程内后端不受影响（无 token 概念）===')
  // ==========================================================================
  {
    const sb = new Sandbox({ id: 'vm1', initGraceMs: 2000, onLog: () => {} })
    const res = await sb.init(SCRIPT, {})
    ok('进程内后端 init 正常', res && res.inited === true, JSON.stringify(res).slice(0, 120))
    ok('进程内后端无 rejectedProtocolLines 概念', sb.rejectedProtocolLines === undefined, '')
    try { sb.destroy() } catch (e) {}
  }

  // ==========================================================================
  console.log('=== ⑥ token 不可预测（不同实例必须不同）===')
  // ==========================================================================
  {
    const a = new SandboxProcess({ id: 't1', initGraceMs: 500 })
    const b = new SandboxProcess({ id: 't2', initGraceMs: 500 })
    ok('两个实例 token 不同', a._protocolToken !== b._protocolToken && !!a._protocolToken, '')
    ok('token 长度 32 位 hex（16 字节）', /^[0-9a-f]{32}$/.test(a._protocolToken || ''), a._protocolToken)
    try { a.destroy(); b.destroy() } catch (e) {}
  }

  // 清理
  try { for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f)); fs.rmdirSync(TMP) } catch (e) {}

  console.log('')
  if (fail) {
    console.log('✗ sandbox-protocol: PASS ' + pass + ' / FAIL ' + fail)
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('✓ sandbox-protocol: PASS ' + pass + ' / FAIL 0')
  process.exit(0)
}

main().catch(e => { console.log('✗ sandbox-protocol 测试自身崩溃: ' + (e && e.stack || e)); process.exit(1) })
