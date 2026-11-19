'use strict'
/**
 * 检测路径的隔离后端测试（v1.13.14）
 *
 * 回答的唯一问题：**生产检测路径（deepCheck）到底跑在哪个沙箱里？**
 *
 * 背景：上一轮的交付事故是「代码写了、但生产路径根本没用上」——
 * `SandboxProcess` 存在、单测通过，而 `deepCheck` 仍然 `new Sandbox`（主进程 vm），
 * 于是 `--permission` 在生产上**一天都没生效过**。
 * 所以这里断言的不是「模块能加载」，而是「deepCheck 真的起了子进程、argv 里有 --permission」。
 */

const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const checker = require(path.join(ROOT, 'src', 'core', 'checker'))
const { deepCheck, makeSandbox, sandboxIsolation } = checker

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; fails.push(name + (detail ? '  :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}

const CODE = `
lx.send('inited', { sources: { wy: { name: 'x', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })
lx.on('request', function () { return Promise.resolve('http://example.invalid/a.mp3') })
`

async function main() {
  console.log('\n=== ① makeSandbox 默认返回子进程实现 ===')
  {
    const sb = makeSandbox({ id: 'd1', initGraceMs: 500 })
    ok('默认是 SandboxProcess（有 child）', !!sb.child, 'constructor=' + sb.constructor.name)
    const iso = sandboxIsolation(sb)
    ok('sandboxIsolation 能报出 pid', !!(iso && typeof iso.pid === 'number'), JSON.stringify(iso))
    ok('子进程 argv 含 --permission', !!(iso && iso.hasPermission), iso ? iso.argv : 'null')
    ok('argv 里有 --allow-fs-read（否则 require 都跑不起来）',
      !!(iso && /--allow-fs-read=/.test(iso.argv)), iso ? iso.argv : 'null')
    ok('argv 里没有把整盘/根目录放开',
      !!(iso && !/--allow-fs-read=(\/|\/app\/data|C:\\\\)(\s|$)/.test(iso.argv)), iso ? iso.argv : 'null')
    // 防回归：fork(modulePath,...) 会自己追加 modulePath，execArgv 里不能再放一次
    const workerCount = (iso.argv.match(/sandbox-worker\.js/g) || []).length
    ok('argv 里 worker 路径只出现一次（execArgv 别重复塞）', workerCount === 1, iso ? iso.argv : 'null')
    sb.destroy()
  }

  console.log('\n=== ② 显式 backend=vm 时退回进程内实现（降级通道可用）===')
  {
    const sb = makeSandbox({ id: 'd2', initGraceMs: 300, backend: 'vm' })
    ok('backend=vm 返回 Sandbox（无 child）', !sb.child, 'constructor=' + sb.constructor.name)
    ok('sandboxIsolation 对 vm 返回 null', sandboxIsolation(sb) === null)
    sb.destroy()
  }

  console.log('\n=== ③ deepCheck 真的走子进程（core 断言）===')
  {
    const events = []
    const d = await deepCheck({ id: 'dc1', name: 'x', url: 'local' }, CODE, {
      quickCheck: true, linkTimeoutMs: 3000, platformBudgetMs: 3000, initGraceMs: 600,
      allowPrivateHosts: true
    }, e => events.push(e), () => true)

    ok('deepCheck 结果里带 isolation 字段', !!d.isolation, JSON.stringify(d.isolation))
    ok('isolation.hasPermission = true（操作系统级隔离真的启用了）',
      !!(d.isolation && d.isolation.hasPermission === true), JSON.stringify(d.isolation))
    ok('isolation.pid 是有效进程号',
      !!(d.isolation && typeof d.isolation.pid === 'number' && d.isolation.pid > 0),
      JSON.stringify(d.isolation))
    ok('检测本身没被隔离破坏（inited=true）', d.inited === true, JSON.stringify({ inited: d.inited, loadError: d.loadError }))
    ok('平台已注册', Array.isArray(d.sources) && d.sources.includes('wy'), JSON.stringify(d.sources))
  }

  console.log('\n=== ④ deepCheck 走 vm 后端时不谎报隔离 ===')
  {
    const d = await deepCheck({ id: 'dc2', name: 'x', url: 'local' }, CODE, {
      quickCheck: true, linkTimeoutMs: 3000, platformBudgetMs: 3000, initGraceMs: 600,
      allowPrivateHosts: true, sandboxBackend: 'vm'
    }, () => {}, () => true)
    ok('backend=vm 时 isolation 为 null（不会假装有隔离）', d.isolation === null, JSON.stringify(d.isolation))
    ok('vm 后端检测仍正常', d.inited === true, JSON.stringify({ inited: d.inited }))
  }

  console.log('\n=== ⑤ 子进程崩溃要降级并告警，而不是让检测整体失败 ===')
  {
    // 用一个不存在的 worker 路径强制启动失败 → 走降级
    const sb = makeSandbox({ id: 'd3', initGraceMs: 300, workerPath: path.join(ROOT, 'src', 'core', '__nope__.js') })
    // fork 到不存在的文件：child 可能创建但立刻 exit，也可能抛错。
    // 两种情况都要能 init 出一个明确的失败结果，而不是打穿调用方。
    const r = await sb.init('1', {})
    ok('子进程不可用时 init 返回失败结果（不抛）', r && r.inited === false, JSON.stringify(r))
    ok('失败原因可读', !!(sb.initError && sb.initError.length > 0), String(sb.initError))
    sb.destroy()
  }

  console.log('')
  if (fail) {
    console.log('✗ sandbox-wiring: PASS ' + pass + ' / FAIL ' + fail)
    console.log('\n失败项：')
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('✓ sandbox-wiring: PASS ' + pass + ' / FAIL 0')
  process.exit(0)
}

main().catch(e => {
  console.log('✗ sandbox-wiring 测试自身崩溃: ' + (e && e.stack || e))
  process.exit(1)
})
