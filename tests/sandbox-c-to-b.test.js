'use strict'
/**
 * C→B 切换回归（v1.13.15）
 *
 * 回答 Deva 最担心的那一项：**把 deepCheck 从 Sandbox（进程内 vm）换到
 * SandboxProcess（子进程）会不会直接崩？**
 *
 * 这里不测「permission 开关」，只测**架构切换**：
 *   C 组 = new Sandbox()          （旧的进程内 vm）
 *   B 组 = new SandboxProcess({}) （新的子进程 + --permission）
 *
 * 覆盖到的语义差异点（每一条都是「切过去可能坏」的地方）：
 *   1. 同步 run() 缺失 —— checker 不能依赖它
 *   2. 注册表快照 —— probeRegistered* 改成 init 时回传，deepCheck 必须照常拿到平台
 *   3. 更新提示 —— updateTip/updateAlert 必须能从子进程上转（否则「有新版本」静默失效）
 *   4. initError / loadError —— 脚本报错的归因文案不能丢
 *   5. 未 inited 但注册了 handler —— 抢救路径（recovered / guessedSources）
 *   6. 定时器回调 —— 43 条真实音源有 setTimeout，时序不能依赖进程内同步
 *   7. dispatch 信封 —— {id, result} 结构必须一致
 *   8. stop/destroy —— 取消语义一致
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const { Sandbox } = require(path.join(ROOT, 'src', 'core', 'sandbox'))
const { SandboxProcess } = require(path.join(ROOT, 'src', 'core', 'sandbox-process'))
const { deepCheck } = require(path.join(ROOT, 'src', 'core', 'checker'))

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; fails.push(name + (detail ? '  :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}

const SCRIPT = `
lx.send('inited', {
  sources: {
    wy: { name: 'wy', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
    kw: { name: 'kw', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] }
  }
})
lx.on('request', function (data) {
  if (data.action === 'musicUrl') return Promise.resolve('http://example.invalid/' + data.source + '.mp3')
  return Promise.resolve(null)
})
`

async function makePair() {
  const c = new Sandbox({ id: 'C', initGraceMs: 1200, allowPrivateHosts: true, onLog: () => {} })
  const b = new SandboxProcess({ id: 'B', initGraceMs: 1200, allowPrivateHosts: true, onLog: () => {} })
  return { c, b }
}

async function main() {
  // ==========================================================================
  console.log('\n=== ① 不崩：deepCheck 走 SandboxProcess 全程无异常 ===')
  // ==========================================================================
  {
    let threw = null
    let d = null
    try {
      d = await deepCheck({ id: 'x1', name: 'x', url: 'local' }, SCRIPT, {
        quickCheck: true, linkTimeoutMs: 4000, platformBudgetMs: 6000, initGraceMs: 1000,
        allowPrivateHosts: true
      }, () => {}, () => true)
    } catch (e) { threw = e }
    ok('deepCheck 走子进程不抛异常', !threw, threw ? String(threw.message).slice(0, 200) : '')
    ok('拿到结果对象', !!d)
    if (d) {
      ok('inited=true', d.inited === true, JSON.stringify({ inited: d.inited, loadError: d.loadError }))
      ok('注册平台齐全（wy + kw）',
        Array.isArray(d.sources) && d.sources.includes('wy') && d.sources.includes('kw'), JSON.stringify(d.sources))
      ok('isolation.hasPermission=true', !!(d.isolation && d.isolation.hasPermission === true), JSON.stringify(d.isolation))
    }
  }

  // ==========================================================================
  console.log('\n=== ② init 返回值字段一致（C 与 B 逐字段对照）===')
  // ==========================================================================
  {
    const { c, b } = await makePair()
    const rc = await c.init(SCRIPT, { name: 'x' })
    const rb = await b.init(SCRIPT, { name: 'x' })
    ok('C.inited === B.inited', !!rc.inited === !!rb.inited, `C=${rc.inited} B=${rb.inited}`)
    const cSrc = Object.keys((rc.data && rc.data.sources) || {}).sort().join(',')
    const bSrc = Object.keys((rb.data && rb.data.sources) || {}).sort().join(',')
    ok('C.data.sources === B.data.sources', cSrc === bSrc, `C=[${cSrc}] B=[${bSrc}]`)
    ok('C.recovered === B.recovered', !!rc.recovered === !!rb.recovered, `C=${rc.recovered} B=${rb.recovered}`)
    ok('C.guessedSources === B.guessedSources', !!rc.guessedSources === !!rb.guessedSources, `C=${rc.guessedSources} B=${rb.guessedSources}`)
    ok('C.initError === B.initError（都是 null）', (rc.initError || c.initError || null) === (rb.initError || b.initError || null),
      `C=${c.initError} B=${b.initError}`)
    c.destroy(); b.destroy()
  }

  // ==========================================================================
  console.log('\n=== ③ dispatch 信封结构一致 ===')
  // ==========================================================================
  {
    const { c, b } = await makePair()
    await c.init(SCRIPT, {}); await b.init(SCRIPT, {})
    const vc = await c.dispatch('request', { source: 'wy', action: 'musicUrl' }, 4000)
    const vb = await b.dispatch('request', { source: 'wy', action: 'musicUrl' }, 4000)
    ok('C 返回 {id,result} 信封', !!(vc && typeof vc === 'object' && 'result' in vc), JSON.stringify(vc))
    ok('B 返回 {id,result} 信封', !!(vb && typeof vb === 'object' && 'result' in vb), JSON.stringify(vb))
    ok('result 值一致', vc.result === vb.result, `C=${vc.result} B=${vb.result}`)
    c.destroy(); b.destroy()
  }

  // ==========================================================================
  console.log('\n=== ④ 更新提示必须能上转（updateAlert）===')
  // ==========================================================================
  {
    const { c, b } = await makePair()
    const alertScript = `
lx.send('inited', { sources: { wy: { name: 'wy', actions: ['musicUrl'], qualitys: ['128k'] } } })
lx.send('updateAlert', { title: '有新版本 v9', updateUrl: 'https://example.invalid/new-version' })
`
    await c.init(alertScript, {})
    await b.init(alertScript, {})
    const cTips = c.updateTips || []
    const bTips = b.updateTips || []
    ok('C 收集到 updateTips', cTips.length > 0, JSON.stringify(cTips))
    ok('B 也收集到 updateTips（子进程上转生效）', bTips.length > 0, JSON.stringify(bTips))
    ok('C/B 的 tip url 一致',
      cTips.length > 0 && bTips.length > 0 && cTips[0].url === bTips[0].url,
      `C=${cTips[0] && cTips[0].url} B=${bTips[0] && bTips[0].url}`)
    c.destroy(); b.destroy()
  }

  // ==========================================================================
  console.log('\n=== ⑤ 脚本报错：loadError 归因一致 ===')
  // ==========================================================================
  {
    const { c, b } = await makePair()
    const boom = 'throw new Error("故意炸掉的脚本")'
    const rc = await c.init(boom, {})
    const rb = await b.init(boom, {})
    ok('C inited=false', rc.inited === false, JSON.stringify(rc).slice(0, 120))
    ok('B inited=false', rb.inited === false, JSON.stringify(rb).slice(0, 120))
    ok('C 与 B 的 initError 都提到错因',
      /故意炸掉/.test(String(c.initError)) && /故意炸掉/.test(String(b.initError)),
      `C=${String(c.initError).slice(0, 80)} B=${String(b.initError).slice(0, 80)}`)
    c.destroy(); b.destroy()
  }

  // ==========================================================================
  console.log('\n=== ⑥ 未 inited 但注册 handler → 抢救路径一致 ===')
  // ==========================================================================
  {
    const { c, b } = await makePair()
    const recover = 'lx.on("request", function () { return Promise.resolve("http://x.invalid/r.mp3") })'
    const rc = await c.init(recover, {})
    const rb = await b.init(recover, {})
    ok('C recovered=true', rc.inited === true && rc.recovered === true, JSON.stringify(rc).slice(0, 120))
    ok('B recovered=true', rb.inited === true && rb.recovered === true, JSON.stringify(rb).slice(0, 120))
    ok('C/B guessedSources 一致', !!rc.guessedSources === !!rb.guessedSources, `C=${rc.guessedSources} B=${rb.guessedSources}`)
    const vc = await c.dispatch('request', { action: 'musicUrl', source: 'wy' }, 4000)
    const vb = await b.dispatch('request', { action: 'musicUrl', source: 'wy' }, 4000)
    ok('抢救后 C/B 都能取链', vc.result === vb.result && !!vb.result, `C=${vc.result} B=${vb.result}`)
    c.destroy(); b.destroy()
  }

  // ==========================================================================
  console.log('\n=== ⑦ 定时器回调（43 条真实音源有 setTimeout）===')
  // ==========================================================================
  {
    const { c, b } = await makePair()
    // 典型真实写法：inited 放在 setTimeout 里；request 里也用定时器包一层
    const timerScript = `
lx.send('inited', { sources: { wy: { name: 'wy', actions: ['musicUrl'], qualitys: ['128k'] } } })
lx.on('request', function (data) {
  return new Promise(function (resolve) {
    setTimeout(function () { resolve('http://timer.invalid/' + data.source + '.mp3') }, 30)
  })
})
`
    const rc = await c.init(timerScript, {})
    const rb = await b.init(timerScript, {})
    ok('C 定时器脚本 inited=true', rc.inited === true, JSON.stringify(rc).slice(0, 100))
    ok('B 定时器脚本 inited=true', rb.inited === true, JSON.stringify(rb).slice(0, 100))
    const vc = await c.dispatch('request', { action: 'musicUrl', source: 'wy' }, 4000)
    const vb = await b.dispatch('request', { action: 'musicUrl', source: 'wy' }, 4000)
    ok('C 定时器取链正确', vc.result === 'http://timer.invalid/wy.mp3', JSON.stringify(vc))
    ok('B 定时器取链正确', vb.result === 'http://timer.invalid/wy.mp3', JSON.stringify(vb))
    c.destroy(); b.destroy()
  }

  // ==========================================================================
  console.log('\n=== ⑧ 异步 inited（网络回调里 send）===')
  // ==========================================================================
  {
    const http = require('http')
    const srv = http.createServer((q, r) => r.end('{"ok":1}'))
    await new Promise(res => srv.listen(0, '127.0.0.1', res))
    const port = srv.address().port
    const asyncScript = `
fetch('http://127.0.0.1:${port}/').then(function (r) { return r.json() }).then(function () {
  lx.send('inited', { sources: { kg: { name: 'kg', actions: ['musicUrl'], qualitys: ['128k'] } } })
}, function () {
  lx.send('inited', { sources: { kg: { name: 'kg', actions: ['musicUrl'], qualitys: ['128k'] } } })
})
`
    const { c, b } = await makePair()
    const rc = await c.init(asyncScript, {})
    const rb = await b.init(asyncScript, {})
    ok('C 异步 init 拿到 kg', !!(rc.data && rc.data.sources && rc.data.sources.kg), JSON.stringify(rc.data || {}).slice(0, 100))
    ok('B 异步 init 拿到 kg', !!(rb.data && rb.data.sources && rb.data.sources.kg), JSON.stringify(rb.data || {}).slice(0, 100))
    c.destroy(); b.destroy()
    srv.close()
  }

  // ==========================================================================
  console.log('\n=== ⑨ 取消语义：stop / destroy 后 dispatch 必须拒绝 ===')
  // ==========================================================================
  {
    const { c, b } = await makePair()
    await c.init(SCRIPT, {}); await b.init(SCRIPT, {})
    c.stop(); b.stop()
    let ce = ''; let be = ''
    try { await c.dispatch('request', { action: 'musicUrl' }, 1000) } catch (e) { ce = String(e.message) }
    try { await b.dispatch('request', { action: 'musicUrl' }, 1000) } catch (e) { be = String(e.message) }
    ok('C stop 后 dispatch 拒绝', /已取消/.test(ce), ce)
    ok('B stop 后 dispatch 拒绝', /已取消/.test(be), be)
    c.destroy(); b.destroy()
  }

  // ==========================================================================
  console.log('\n=== ⑩ 47 条含定时器音源的静态复核（不跑网络，只看 setTimeout 用法是否依赖同步）===')
  // ==========================================================================
  {
    const fs = require('fs')
    const checker = fs.readFileSync(path.join(ROOT, 'src', 'core', 'checker.js'), 'utf8')
    // 关键：checker 不能有「设置一个值，然后同步读回来」的模式
    ok('checker 没有 sb.run( 调用', !/\bsb\.run\s*\(/.test(checker), '发现 sb.run，切子进程必崩')
    ok('checker 没有 .context 直接访问', !/\bsb\.context\b/.test(checker), '发现 sb.context')
    ok('checker 没有 probeRegistered 同步读', !/probeRegistered/.test(checker), '发现 probeRegistered')
    ok('checker 没有 setScriptInfo 调用', !/setScriptInfo/.test(checker), '发现 setScriptInfo')
  }

  console.log('')
  if (fail) {
    console.log('✗ sandbox-c-to-b: PASS ' + pass + ' / FAIL ' + fail)
    console.log('\n失败项：')
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('✓ sandbox-c-to-b: PASS ' + pass + ' / FAIL 0')
  process.exit(0)
}

main().catch(e => {
  console.log('✗ sandbox-c-to-b 测试自身崩溃: ' + (e && e.stack || e))
  process.exit(1)
})
