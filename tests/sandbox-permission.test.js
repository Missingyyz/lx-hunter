'use strict'
/**
 * 沙箱子进程的**安全边界**测试（v1.13.14）
 *
 * 与 sandbox-return-write.test.js 的分工：
 *   sandbox-return-write  → 进程内 facade 是否挡住「交回面/写入面」逃逸
 *   本文件                → 就算逃逸成功，子进程还能碰到什么
 *
 * 这是本轮换方案的核心断言。上一版的四条路线（facade 补 trap、补交回面、
 * 只测注入面、只测同步）都能过测试却仍有 RCE，所以这里不再追求「逃不出去」，
 * 而是断言「逃出去也读不到 /data、写不了文件、起不了命令」。
 *
 * 分两段跑：
 *   A. 平台无关（Windows/Linux 都跑）：逃逸在**进程内**是否仍被 facade 挡住 + 子进程隔离生效
 *   B. `--permission` 真边界（只在 Linux 上有效）：读 /data、写文件、execSync
 *
 * Windows 上 Node 的 --permission 支持不完整，B 段会 skip 并明确打出来，
 * 免得「全绿」掩盖「其实没验」。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const ROOT = path.resolve(__dirname, '..')
const { SandboxProcess } = require(path.join(ROOT, 'src', 'core', 'sandbox-process'))

let pass = 0
let fail = 0
let skip = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; fails.push(name + (detail ? '  :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}
function skipped(name, why) { skip++; console.log('  SKIP  ' + name + '  :: ' + why) }

/**
 * B 段为什么在非 Linux 上也能跑（原先误判为 skip）
 *
 * 实测（Windows 11 + node v22.14.0）：
 *   --permission + --allow-fs-read=<目录> → 该目录内文件**可读**
 *   --permission 但不给对应目录           → `Error: Access to this API has been restricted`
 * 也就是说 --permission 在 Windows 上同样生效，只是**路径必须显式给全**：
 *   Windows 上不能指望「给 /app 就覆盖子路径」，探针脚本自己也得在允许列表里。
 *
 * 所以只有「/data 目录存在与否」和「/etc 类路径」需要按平台分支，
 * 不再整体 skip —— 整体 skip 会让「全绿」掩盖「其实没验」。
 */
const IS_WIN = process.platform === 'win32'

/**
 * 攻击链的「触发器」：必须用一个**不会被私网阻断拦掉**的错误来源。
 *
 * ⚠ 踩过：上一版这里用 `fetch('http://127.0.0.1:1/')`，结果请求在出站策略那一步
 * 就被拦了，`constructor` 逃逸根本没被执行 —— 测试变绿了，但**验的是一个假象**。
 * 现在改用「不存在的协议/畸形地址」：它在 URL 解析阶段就失败，属于沙箱内部的
 * 同步错误，既不经出站策略、也照样把宿主 Error 对象交回给脚本。
 */
const TRIGGER = `try { fetch('bad-scheme://x').then(null, function (e) { __ATK(e) }) } catch (e) { __ATK(e) }`

/**
 * 在子进程沙箱里跑一段攻击脚本，把结果通过 console.warn 收上来。
 *
 * 两个已知坑（记在项目记忆里）：
 *   1. 沙箱内 console.log 是**故意 no-op**，观测必须用 console.warn
 *   2. 攻击脚本里不要嵌 Windows 绝对路径（多层转义会踩两次），用注入变量
 */
async function attack(codeBody, waitMs) {
  const logs = []
  const sb = new SandboxProcess({ id: 'atk', initGraceMs: 600, onLog: m => logs.push(String(m)) })
  // 先发 inited 保证沙箱跑起来，再执行攻击体
  const script = `
    lx.send('inited', { sources: { wy: { name: 'x', actions: ['musicUrl'], qualitys: ['128k'] } } })
    try {
      ${codeBody}
    } catch (e) { console.warn('ATK_THROW ' + String(e && e.message || e).slice(0, 160)) }
  `
  await sb.init(script, {})
  await new Promise(r => setTimeout(r, waitMs || 900))
  const joined = logs.join('\n')
  sb.destroy()
  return joined
}

/** 从日志里取形如 PREFIX 之后的内容 */
function grab(joined, prefix) {
  const m = joined.match(new RegExp(prefix + ' (.*)'))
  return m ? m[1].trim() : ''
}

/**
 * 真正模拟「沙箱已被完全攻破」：直接 spawn 一个**故意** require fs / child_process
 * 的探针脚本，并用与子进程沙箱完全相同的 --permission 参数跑它。
 *
 * 这是本文件最要紧的一段。上一版 B 段大半断言都是因为「进程内 facade 挡住了
 * process」才变绿的 —— 那等于**没测到 --permission**，而这一层正是换方案的全部理由。
 */
function escapedProbe(action, target, extraReadRoots) {
  const { spawnSync } = require('child_process')
  const probe = path.join(__dirname, 'fixtures', 'sandbox-escape-probe.js')
  const roots = [path.resolve(ROOT, 'src')].concat(extraReadRoots || [])
  const args = ['--permission']
  for (const r of roots) args.push('--allow-fs-read=' + r)
  // 探针自身必须在允许列表里（Windows 上尤其严格：不显式给就连自己都读不了）
  args.push('--allow-fs-read=' + probe)
  args.push(probe, action)
  if (target) args.push(target)
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 })
  const m = (r.stdout || '').match(/ESCAPE_PROBE (.*)/)
  if (m) { try { return JSON.parse(m[1]) } catch (e) {} }
  return { raw: (r.stderr || '').slice(0, 200), status: r.status }
}

async function main() {
  // ==========================================================================
  console.log('\n=== A. 进程内逃逸面：即使拿到 process 也必须读不到 /data ===')
  // ==========================================================================
  {
    // 经典逃逸链：fetch 回调 → constructor → process → getBuiltinModule('fs')
    // 这一条在上一版是**真的能用**（会写文件、会 execSync）。现在预期：要么
    // facade 挡住拿不到 process，要么拿到了但 fs 被 --permission 拒。
    const out = await attack(`
      function __ATK(e) {
        var p = null
        try { p = e.constructor.constructor('return process')() } catch (x) { console.warn('ATK_GETPROC_BLOCKED ' + String(x.message).slice(0,80)); return }
        if (!p || typeof p.pid !== 'number') { console.warn('ATK_GETPROC_NOTPROC'); return }
        console.warn('ATK_GETPROC_OK pid=' + p.pid)
        try {
          var fsmod = p.getBuiltinModule ? p.getBuiltinModule('fs') : null
          if (!fsmod) { console.warn('ATK_NO_GETBUILTIN'); return }
          try { fsmod.writeFileSync('/tmp/lx_atk_marker', 'HARM'); console.warn('ATK_WRITE_OK') }
          catch (x2) { console.warn('ATK_WRITE_DENIED ' + String(x2.message).slice(0,100)) }
        } catch (x3) { console.warn('ATK_FS_THROW') }
      }
      ${TRIGGER}
    `, 1200)
    const gotProc = /ATK_GETPROC_OK pid=/.test(out)
    const writeOk = /ATK_WRITE_OK/.test(out)
    ok('逃逸链无法写文件（要么拿不到 process，要么写被拒）', !writeOk,
      out.slice(0, 300))
    if (gotProc) {
      // 拿到了 process —— 这说明进程内 facade 仍有一条没堵住
      console.log('  INFO  逃逸拿到了 fabric process（说明 facade 仍有洞，靠 --permission 兜底）')
      ok('拿到 process 但写文件仍被拒', /ATK_WRITE_DENIED/.test(out) || !writeOk, out.slice(0, 300))
    } else {
      console.log('  INFO  逃逸没拿到 process（facade 挡住了）: ' + out.slice(0, 160))
      ok('拿不到 process 时自然写不了文件', !writeOk)
    }
  }

  // ==========================================================================
  console.log('\n=== B. --permission 真边界 ===')
  // ==========================================================================
  {
    // 靶子：优先用容器里的 /data/config.json（真实敏感文件）；
    // 否则退到平台上一个「应用目录之外」的文件，保证攻击面等价。
    let target = '/data/config.json'
    if (!fs.existsSync(target)) {
      target = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'win.ini') : (fs.existsSync('/etc/hostname') ? '/etc/hostname' : '/etc/os-release')
    }
    const haveRealData = fs.existsSync('/data/config.json')
    if (!haveRealData) console.log('  INFO  /data/config.json 不存在，靶子改为: ' + target)

    // B1：脚本直接读文件（应该没有 fs 可用）
    {
      const out = await attack(`
        var got = null
        try { got = require('fs') } catch (e) { console.warn('B1_NOREQ ' + String(e.message).slice(0,80)) }
        if (got) {
          try { console.warn('B1_READ_OK ' + got.readFileSync('${target}', 'utf8').slice(0, 20)) }
          catch (x) { console.warn('B1_READ_DENIED ' + String(x.message).slice(0,100)) }
        }
      `)
      ok('沙箱脚本里 require 不可用（读不到靶子文件）',
        !/B1_READ_OK/.test(out), out.slice(0, 300))
    }

    // B2～B5 用「已逃逸」探针：故意模拟沙箱完全被攻破后还能碰到什么。
    // 这才真正测到 --permission 这一层（进程内 facade 的拦截在 A 段单独验）。
    console.log('\n  --- B2: 已逃逸进程读应用目录外的文件 ---')
    {
      const r = escapedProbe('read', target)
      ok('已逃逸状态下读靶子文件被拒', r.readOk === false, JSON.stringify(r).slice(0, 300))
      if (r.readOk === false) {
        ok('拒绝原因是权限类（access denied / restricted），不是文件不存在',
          /EACCES|EPERM|restricted|permission|ACCESS_DENIED|operation not permitted/i.test(String(r.readErr)),
          String(r.readErr))
      }
    }

    console.log('\n  --- B3: 已逃逸进程写文件 ---')
    {
      const marker = path.join(os.tmpdir(), 'lx_harm_' + Date.now())
      const r = escapedProbe('write', marker)
      const exists = fs.existsSync(marker)
      ok('已逃逸状态下写文件被拒', r.writeOk === false && !exists, JSON.stringify(r).slice(0, 200) + ' exists=' + exists)
      if (exists) { try { fs.unlinkSync(marker) } catch (e) {} }
    }

    console.log('\n  --- B4: 已逃逸进程执行系统命令 ---')
    {
      const r = escapedProbe('exec')
      ok('已逃逸状态下 execSync 被拒', r.execOk === false, JSON.stringify(r).slice(0, 300))
    }

    console.log('\n  --- B5: 已逃逸进程读 /data（容器真实数据）---')
    if (!fs.existsSync('/data')) {
      skipped('读 /data/config.json', '/data 不存在（非容器环境，容器内必须由 CI 覆盖）')
    } else {
      const r = escapedProbe('read', '/data/config.json')
      ok('已逃逸状态下读 /data/config.json 被拒', r.readOk === false, JSON.stringify(r).slice(0, 300))
    }

    console.log('\n  --- B5b: 反向断言 —— src 目录必须仍可读（否则功能就废了）---')
    {
      const r = escapedProbe('read-src', path.join(ROOT, 'src', 'core', 'sandbox.js'))
      ok('允许列表内的 src 文件仍可读（功能未被安全策略压垮）', r.srcOk === true, JSON.stringify(r).slice(0, 200))
    }

    // B1 补充：沙箱脚本直接 require 也要失败（第一道防线）
    console.log('\n  --- B1: 沙箱脚本内 require 不可用 ---')
    {
      const out = await attack(`
        var got = null
        try { got = require('fs') } catch (e) { console.warn('B1_NOREQ ' + String(e.message).slice(0,80)) }
        if (got) {
          try { console.warn('B1_READ_OK ' + got.readFileSync('${target}', 'utf8').slice(0, 20)) }
          catch (x) { console.warn('B1_READ_DENIED ' + String(x.message).slice(0,100)) }
        }
      `)
      ok('沙箱脚本里 require 不可用（读不到靶子文件）',
        !/B1_READ_OK/.test(out), out.slice(0, 300))
    }

    // B4 补充：走完整沙箱链路的 execSync 也不成
    console.log('\n  --- B4b: 完整沙箱链路内 execSync ---')
    {
      const out = await attack(`
        function __ATK(e) {
          var p = null
          try { p = e.constructor.constructor('return process')() } catch (x) { console.warn('B4_PROC_BLOCKED'); return }
          if (!p || typeof p.pid !== 'number') { console.warn('B4_NOTPROC'); return }
          var cp = p.getBuiltinModule ? p.getBuiltinModule('child_process') : null
          if (!cp) { console.warn('B4_NO_MODULE'); return }
          try { var r = cp.execSync('echo HARM').toString(); console.warn('B4_EXEC_OK ' + r.slice(0,40)) }
          catch (x) { console.warn('B4_EXEC_DENIED ' + String(x.message).slice(0,120)) }
        }
        ${TRIGGER}
      `, 1200)
      ok('沙箱链路内 execSync 未成功', !/B4_EXEC_OK/.test(out), out.slice(0, 300))
    }

    // B5 补充：走完整沙箱链路读 /data
    {
      if (!fs.existsSync('/data')) {
        skipped('走沙箱链路读 /data/config.json', '/data 不存在（非容器环境）')
      } else {
        const out = await attack(`
          function __ATK(e) {
            var p = null
            try { p = e.constructor.constructor('return process')() } catch (x) { console.warn('B5_PROC_BLOCKED'); return }
            if (!p || typeof p.pid !== 'number') { console.warn('B5_NOTPROC'); return }
            var f = p.getBuiltinModule ? p.getBuiltinModule('fs') : null
            if (!f) { console.warn('B5_NO_MODULE'); return }
            try { console.warn('B5_READ_OK ' + f.readFileSync('/data/config.json', 'utf8').slice(0, 30)) }
            catch (x) { console.warn('B5_READ_DENIED ' + String(x.message).slice(0,120)) }
          }
          ${TRIGGER}
        `, 1200)
        ok('走沙箱链路逃逸后读 /data/config.json 未成功', !/B5_READ_OK/.test(out), out.slice(0, 400))
      }
    }

    // B6：功能未坏（同一套 --permission 参数下，正常脚本必须还能跑）
    {
      const logs = []
      const sb = new SandboxProcess({ id: 'fn', initGraceMs: 1500, onLog: m => logs.push(String(m)) })
      const r = await sb.init(`
        lx.send('inited', { sources: { wy: { name: '正常源', actions: ['musicUrl'], qualitys: ['320k'] } } })
        lx.on('request', function () { return Promise.resolve('http://ok.invalid/a.mp3') })
      `, {})
      ok('--permission 下正常脚本仍能 init', r && r.inited === true, JSON.stringify(r).slice(0, 200))
      ok('--permission 下正常脚本仍能注册平台', (r.sources || []).includes('wy'), JSON.stringify(r && r.sources))
      const v = await sb.dispatch('request', { action: 'musicUrl', source: 'wy' }, 5000)
      ok('--permission 下正常取链仍可用', v && v.result === 'http://ok.invalid/a.mp3', JSON.stringify(v))
      sb.destroy()
    }
  }

  console.log('')
  const head = fail ? '✗' : '✓'
  console.log(head + ' sandbox-permission: PASS ' + pass + ' / FAIL ' + fail + (skip ? ' / SKIP ' + skip : ''))
  if (fail) {
    console.log('\n失败项：')
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(e => {
  console.log('✗ sandbox-permission 测试自身崩溃: ' + (e && e.stack || e))
  process.exit(1)
})
