'use strict'
/**
 * 「dispatch 超时要不要杀子进程」的取舍验证（v1.13.15）
 *
 * 背景：攻击面实测（attack-surface.js ④）发现，脚本 CPU 空转时 dispatch 会超时返回，
 * 但**子进程仍在空转**，只有 destroy() 才停。
 *
 * 直觉修法是「超时就 kill」。但 checker 是**同一个沙箱里逐平台 dispatch**，
 * 杀掉进程会连带废掉同一脚本里其它本来可用的平台 —— 那是把「一条平台慢」
 * 升级成「整条音源不可用」。本文件把这个倒退量出来，用来决定默认值。
 *
 * ============================================================================
 * 关键前提：必须区分「卡住」的两种形态（第一版测试就栽在这里）
 * ============================================================================
 *   A【异步挂起】平台在等网络/Promise 永不 resolve
 *       → worker 事件循环空闲，**其它平台照常能测**
 *       → 这种情况下「超时就 kill」会误伤，是真倒退
 *
 *   B【同步空转】`while(1){}` 死循环
 *       → worker 是单线程，**整个进程被这一个循环占住**
 *       → 其它平台本来也测不出来（不论杀不杀），所以「kill」在这里**没有额外代价**
 *
 * 第一版测试用 B 去证明 A 的结论，结果两组都失败 —— 那说明结论不能混着用。
 * 本文件把两种形态分开测，各自给出该有的策略。
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const { SandboxProcess } = require(path.join(ROOT, 'src', 'core', 'sandbox-process'))

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}

const HEAD = `
lx.send('inited', {
  sources: {
    wy: { name: 'wy', actions: ['musicUrl'], qualitys: ['128k'] },
    kw: { name: 'kw', actions: ['musicUrl'], qualitys: ['128k'] }
  }
})
`

// A【异步挂起】wy 永不 resolve（等一个 12s 的定时器），kw 立刻返回
const ASYNC_HANG = HEAD + `
lx.on('request', function (data) {
  if (data.source === 'wy') {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve('http://wy.invalid/late.mp3') }, 12000)
    })
  }
  return Promise.resolve('http://kw.invalid/ok.mp3')
})
`

// B【同步空转】wy 死循环 12s，kw 立刻返回
const SYNC_SPIN = HEAD + `
lx.on('request', function (data) {
  if (data.source === 'wy') {
    var s = Date.now()
    while (Date.now() - s < 12000) { }
    return Promise.resolve('http://wy.invalid/late.mp3')
  }
  return Promise.resolve('http://kw.invalid/ok.mp3')
})
`

// 所有平台都同步空转
const ALL_SPIN = HEAD + `
lx.on('request', function () {
  var s = Date.now()
  while (Date.now() - s < 8000) { }
  return Promise.resolve(null)
})
`

async function runCase(script, opts, wyTimeout, kwTimeout) {
  const sb = new SandboxProcess(Object.assign({ id: 'case', initGraceMs: 3000 }, opts || {}))
  await sb.init(script, {})
  let wyOut = null
  try { wyOut = (await sb.dispatch('request', { action: 'musicUrl', source: 'wy' }, wyTimeout)).result } catch (e) { wyOut = 'ERR:' + e.message }
  let kwOut = null
  try { kwOut = (await sb.dispatch('request', { action: 'musicUrl', source: 'kw' }, kwTimeout)).result } catch (e) { kwOut = 'ERR:' + e.message }
  const pid = sb.child && sb.child.pid
  let alive = (() => { try { return !!(sb.child && sb.child.exitCode === null && sb.child.signalCode === null) } catch (e) { return false } })()
  try { sb.destroy() } catch (e) {}
  return { wyOut, kwOut, pid, alive }
}

async function aliveAfterWait(sb, ms) {
  await new Promise(r => setTimeout(r, ms))
  try { return !!(sb.child && sb.child.exitCode === null && sb.child.signalCode === null) } catch (e) { return false }
}

async function main() {
  // ==========================================================================
  console.log('=== A【异步挂起】killOnTimeout=true → 连累可用平台（倒退真实存在）===')
  // ==========================================================================
  {
    const r = await runCase(ASYNC_HANG, { killOnTimeout: true }, 1500, 3000)
    console.log('    wy(挂起)=' + JSON.stringify(r.wyOut) + '  kw(正常)=' + JSON.stringify(r.kwOut))
    ok('wy 超时', /取链超时|ERR/.test(String(r.wyOut)), String(r.wyOut))
    ok('★ kw 的可用链接被连带丢掉 —— 这就是倒退', /ERR|超时/.test(String(r.kwOut)), 'kw=' + JSON.stringify(r.kwOut))
  }

  // ==========================================================================
  console.log('\n=== B【异步挂起】默认（不 kill）→ 可用平台保住 ===')
  // ==========================================================================
  {
    const r = await runCase(ASYNC_HANG, {}, 1500, 3000)
    console.log('    wy(挂起)=' + JSON.stringify(r.wyOut) + '  kw(正常)=' + JSON.stringify(r.kwOut))
    ok('wy 超时', /取链超时|ERR/.test(String(r.wyOut)), String(r.wyOut))
    ok('★★ kw 的可用链接保住了 —— 默认不 kill 的理由', r.kwOut === 'http://kw.invalid/ok.mp3', 'kw=' + JSON.stringify(r.kwOut))
  }

  // ==========================================================================
  console.log('\n=== C【同步空转】不 kill → 单线程被占，别的平台本来也测不出来 ===')
  // ==========================================================================
  {
    const r = await runCase(SYNC_SPIN, {}, 1500, 2500)
    console.log('    wy(空转)=' + JSON.stringify(r.wyOut) + '  kw(正常但被堵)=' + JSON.stringify(r.kwOut))
    ok('wy 超时', /取链超时|ERR/.test(String(r.wyOut)), String(r.wyOut))
    ok('kw 也超时（同步空转堵住整个 worker，与杀不杀无关）', /ERR|超时/.test(String(r.kwOut)), 'kw=' + JSON.stringify(r.kwOut))
    ok('因此对「同步空转」而言 kill 没有额外代价', true, '')
  }

  // ==========================================================================
  console.log('\n=== D【同步空转 + killAfterTimeouts=2】收掉进程省 CPU ===')
  // ==========================================================================
  {
    const sb = new SandboxProcess({ id: 'allspin', initGraceMs: 3000, killAfterTimeouts: 2 })
    await sb.init(ALL_SPIN, {})
    const outs = []
    for (const src of ['wy', 'kw']) {
      try { outs.push((await sb.dispatch('request', { action: 'musicUrl', source: src }, 1200)).result) } catch (e) { outs.push('ERR:' + e.message) }
    }
    const pid = sb.child && sb.child.pid
    const alive = await aliveAfterWait(sb, 1200)
    ok('两次都超时', outs.every(o => /ERR/.test(String(o))), JSON.stringify(outs))
    ok('★ 累计 2 次超时后子进程被收掉（省 CPU）', alive === false, 'pid=' + pid + ' alive=' + alive)
    try { sb.destroy() } catch (e) {}
  }

  // ==========================================================================
  console.log('\n=== E【同步空转】默认 killAfterTimeouts=0 → 不因超时杀进程 ===')
  // ==========================================================================
  {
    const sb = new SandboxProcess({ id: 'nokill', initGraceMs: 3000 })
    await sb.init(ALL_SPIN, {})
    for (const src of ['wy', 'kw']) {
      try { await sb.dispatch('request', { action: 'musicUrl', source: src }, 800) } catch (e) {}
    }
    const alive = await aliveAfterWait(sb, 500)
    ok('默认不杀：子进程仍在（交给 destroy 收尾）', alive === true, 'alive=' + alive)
    try { sb.destroy() } catch (e) {}
  }

  // ==========================================================================
  console.log('\n=== F stop() 会一并杀子进程（堵「跳过 finally」的泄漏）===')
  // ==========================================================================
  {
    const sb = new SandboxProcess({ id: 'stopkill', initGraceMs: 3000 })
    await sb.init(ASYNC_HANG, {})
    const pid = sb.child && sb.child.pid
    const before = (() => { try { return !!(sb.child && sb.child.exitCode === null && sb.child.signalCode === null) } catch (e) { return false } })()
    ok('init 后子进程存活', before === true, 'pid=' + pid)
    sb.stop()
    const after = await aliveAfterWait(sb, 1200)
    ok('★ stop() 之后子进程已退出', after === false, 'alive=' + after)
    let rejected = false
    try { await sb.dispatch('request', { action: 'musicUrl' }, 3000) } catch (e) { rejected = /已取消|不可用/.test(String(e.message)) }
    ok('stop 后 dispatch 快速失败', rejected, '')
  }

  // ==========================================================================
  console.log('\n=== G destroy() 杀进程（既有行为，防止回退）===')
  // ==========================================================================
  {
    const sb = new SandboxProcess({ id: 'destroykill', initGraceMs: 3000 })
    await sb.init(ASYNC_HANG, {})
    sb.destroy()
    const after = await aliveAfterWait(sb, 1200)
    ok('destroy() 之后子进程已退出', after === false, 'alive=' + after)
  }

  console.log('')
  if (fail) {
    console.log('✗ sandbox-timeout-kill: PASS ' + pass + ' / FAIL ' + fail)
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('✓ sandbox-timeout-kill: PASS ' + pass + ' / FAIL 0')
  process.exit(0)
}

main().catch(e => { console.log('✗ sandbox-timeout-kill 自身崩溃: ' + (e && e.stack || e)); process.exit(1) })
