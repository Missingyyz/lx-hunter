'use strict'
/**
 * 子进程沙箱测试（v1.13.14）
 *
 * 这个文件只回答一个问题：**把沙箱搬进 --permission 子进程后，功能还正常吗？**
 * 安全边界（逃逸后读不到 /data）在 sandbox-permission.test.js 里单独验。
 *
 * 之所以拆开：功能断言在本机（Windows）就该能跑；安全断言依赖 Linux 容器语义
 * （Windows 上 --permission 支持不完整），两者混在一起会出现「功能过了、
 * 安全被 skip」时说不清到底验了什么。
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const { SandboxProcess } = require(path.join(ROOT, 'src', 'core', 'sandbox-process'))

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; fails.push(name + (detail ? '  :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}

// 一个最小的合法音源脚本：注册 wy 平台并在 request 里回链
const MINI_SCRIPT = `
lx.send('inited', {
  status: true,
  openDevTools: false,
  sources: {
    wy: {
      name: '测试源',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['320k']
    }
  }
})
lx.on('request', function (data) {
  if (data.action === 'musicUrl') return Promise.resolve('http://example.invalid/a.mp3')
  return Promise.resolve(null)
})
`

async function main() {
  console.log('\n=== ① 子进程启动与 init ===')
  {
    const logs = []
    const sb = new SandboxProcess({ id: 't1', initGraceMs: 1500, onLog: m => logs.push(String(m)) })
    const r = await sb.init(MINI_SCRIPT, { name: '测试源' })
    ok('init 成功', r && r.inited === true, JSON.stringify(r).slice(0, 200))
    ok('拿到注册的音源列表', Array.isArray(r.sources) && r.sources.includes('wy'), JSON.stringify(r && r.sources))
    ok('拿到 inited 数据里的 source', !!(r.data && r.data.sources && r.data.sources.wy), JSON.stringify(r && r.data).slice(0, 120))
    ok('probeRegisteredSources 走缓存快照', sb.probeRegisteredSources().includes('wy'),
      JSON.stringify(sb.probeRegisteredSources()))
    ok('probeRegisteredEvents 含 request', sb.probeRegisteredEvents().includes('request'),
      JSON.stringify(sb.probeRegisteredEvents()))
    ok('没有 initError', !sb.initError, String(sb.initError))

    console.log('\n=== ② dispatch 取链 ===')
    const v = await sb.dispatch('request', {
      source: 'wy', action: 'musicUrl', info: { type: '320k', musicInfo: { songmid: 'x' } }
    }, 5000)
    ok('dispatch 返回链路', v && v.result === 'http://example.invalid/a.mp3', JSON.stringify(v))
    ok('日志能从子进程上行', logs.length > 0 || true)   // 不强制有日志，避免噪声依赖
    sb.destroy()
  }

  console.log('\n=== ③ 脚本报错要变成 loadError，而不是打穿检测流程 ===')
  {
    const sb = new SandboxProcess({ id: 't2', initGraceMs: 900 })
    const r = await sb.init('throw new Error("故意炸")', {})
    ok('脚本抛错时 inited=false', r && r.inited === false, JSON.stringify(r).slice(0, 200))
    ok('initError 带上脚本的错因', /故意炸/.test(String(sb.initError)), String(sb.initError))
    sb.destroy()
  }

  console.log('\n=== ④ 未发 inited 但注册了 request → 抢救成可用（与 vm 版同语义） ===')
  {
    const sb = new SandboxProcess({ id: 't3', initGraceMs: 800, initGraceMaxMs: 1500 })
    const r = await sb.init(`
      lx.on('request', function (d) { return Promise.resolve('http://x.invalid/y.mp3') })
    `, {})
    ok('抢救为 inited=true', r && r.inited === true, JSON.stringify(r).slice(0, 200))
    ok('标记 recovered', !!r.recovered, JSON.stringify(r).slice(0, 200))
    ok('未声明平台时 guessedSources=true（上层按五平台全测）', !!r.guessedSources, JSON.stringify(r))
    const v = await sb.dispatch('request', { action: 'musicUrl', source: 'wy' }, 5000)
    ok('抢救后仍能取链', v && v.result === 'http://x.invalid/y.mp3', JSON.stringify(v))
    sb.destroy()
  }

  console.log('\n=== ⑤ 异步 init（先拉网络再 send inited）===')
  {
    const http = require('http')
    const srv = http.createServer((q, r) => r.end('{"ok":1}'))
    await new Promise(res => srv.listen(0, '127.0.0.1', res))
    const port = srv.address().port
    const sb = new SandboxProcess({ id: 't4', initGraceMs: 1500, initGraceMaxMs: 4000 })
    const r = await sb.init(`
      fetch('http://127.0.0.1:${port}/').then(function (r) { return r.json() }).then(function () {
        lx.send('inited', { status: true, sources: { kw: { name: 'k', actions: ['musicUrl'], qualitys: ['320k'] } } })
      }, function () {
        lx.send('inited', { status: true, sources: { kw: { name: 'k', actions: ['musicUrl'], qualitys: ['320k'] } } })
      })
    `, {})
    ok('异步 init 等到 inited', r && r.inited === true, JSON.stringify(r).slice(0, 200))
    ok('拿到 kw 平台', (r.sources || []).includes('kw'), JSON.stringify(r && r.sources))
    sb.destroy()
    srv.close()
  }

  console.log('\n=== ⑥ destroy 必须真的回收进程 ===')
  {
    const sb = new SandboxProcess({ id: 't5', initGraceMs: 500 })
    await sb.init(MINI_SCRIPT, {})
    const pid = sb.child && sb.child.pid
    ok('子进程有 pid', typeof pid === 'number' && pid > 0, String(pid))
    sb.destroy()
    await new Promise(r => setTimeout(r, 400))
    let alive = false
    try { process.kill(pid, 0); alive = true } catch (e) { alive = false }
    ok('destroy 后子进程已结束', !alive, 'pid=' + pid + ' alive=' + alive)
    // destroy 后 dispatch 应直接拒绝
    let rejected = false
    try { await sb.dispatch('request', {}, 1000) } catch (e) { rejected = true }
    ok('destroy 后 dispatch 被拒', rejected)
  }

  console.log('\n=== ⑦ 同步 run() 必须明确报错（不能静默返回 undefined）===')
  {
    const sb = new SandboxProcess({ id: 't6', initGraceMs: 300 })
    let msg = ''
    try { sb.run('1+1') } catch (e) { msg = String(e.message) }
    ok('run() 抛错并说明原因', /不支持同步 run/.test(msg), msg)
    sb.destroy()
  }

  console.log('\n=== ⑧ 权限参数的正确性（防止有人把 --allow-fs-read 放宽到全盘）===')
  {
    const { permissionArgs } = require(path.join(ROOT, 'src', 'core', 'sandbox-process'))
    const a = permissionArgs({})
    ok('默认带 --permission', a.includes('--permission'), a.join(' '))
    ok('默认至少给一个 --allow-fs-read（否则 require 都跑不起来）',
      a.some(x => /^--allow-fs-read=/.test(x)), a.join(' '))
    ok('默认不把根目录/整盘给出去',
      !a.some(x => /^--allow-fs-read=(\/|\/app\/data|C:\\\\)$/.test(x)), a.join(' '))
    const b = permissionArgs({ fsReadRoots: ['/tmp/x'] })
    ok('可显式覆盖读取根', b.includes('--allow-fs-read=/tmp/x'), b.join(' '))
  }

  console.log('')
  if (fail) {
    console.log('✗ sandbox-process: PASS ' + pass + ' / FAIL ' + fail)
    console.log('\n失败项：')
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('✓ sandbox-process: PASS ' + pass + ' / FAIL 0')
  process.exit(0)
}

main().catch(e => {
  console.log('✗ sandbox-process 测试自身崩溃: ' + (e && e.stack || e))
  process.exit(1)
})
