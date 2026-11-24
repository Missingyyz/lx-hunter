'use strict'
/**
 * 分组并行测试 runner（正式测试链工具，替代 package.json 里那条 4000 字符的串行 && 链）。
 *
 * 为什么分组并行：
 *  - 全量 121 个 test.js，纯串行要 10+ 分钟（sandbox-throw-leak 单个 ~360s）；
 *  - 组间并行、组内限并发 2，瓶颈沙箱组大幅缩短；总墙钟取最慢的组。
 *  - 组内并发用异步 spawn（runOne 返回 Promise），不是 spawnSync —— spawnSync 会阻塞事件循环，
 *    对 files.map 套 Promise.all 也不会真并行。
 *
 * 并发纪律（防 0xC0000409 / libuv UV_HANDLE_CLOSING）：
 *  - 并发度固定 2（历史上 3 路并发出现过上述崩溃，勿直接调 3）。
 *  - 三个「重子进程」测试（sandbox-throw-leak / sandbox-throw-residue / sandbox-return-write）
 *    互斥：各自会起几十个 node 子进程，彼此不能同时跑；用一个专用互斥槽串行执行它们，
 *    其余轻量测试照常在 2 槽内并行。
 *
 * 分组口径（按文件名前缀，纯测试组织，不改任何被测代码）：
 *  - ai       AI 复检 / 评测 / R1-R10 / 配额 / 影子判据
 *  - sandbox  沙箱逃逸 / 混淆闸门 / 隔离区 / server-veto / 安全
 *  - func     其余功能项（爬取/巡检/去重/导入/UI/网络…）
 *  启动时做「分组守恒」自检：每个 test.js 恰好归一组，不重不漏。
 *
 * 用法：
 *   node tests/tools/run-tests.js               # 全量，三组并行（npm test 走这条）
 *   node tests/tools/run-tests.js --serial      # 全量，纯串行（低配/排查用）
 *   node tests/tools/run-tests.js --group=ai    # 只跑一组（ai|sandbox|func）
 *   node tests/tools/run-tests.js --quiet       # 精简输出
 *
 * 退出码：有任一测试失败/超时 → 1；全绿 → 0。
 * 结果摘要写到 tests/tools/.last-test-result.txt（不进 git）。
 */
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const TOOLS = __dirname
const TESTS = path.resolve(TOOLS, '..')
// 默认用运行本脚本的 node；可用 TEST_NODE 指定特定 node（如项目自带 v22）
const NODE = process.env.TEST_NODE || process.execPath
const args = process.argv.slice(2)
const SERIAL = args.includes('--serial')
const QUIET = args.includes('--quiet')
const groupArg = (args.find(a => a.startsWith('--group=')) || '').split('=')[1]

// 超时白名单：sandbox-throw-leak 每条用例起独立子进程（tools/throw-leak-matrix.js ~314s），全文件 ~360s
const TIMEOUT_MS = { 'sandbox-throw-leak.test.js': 700000 }
const timeoutFor = (f) => TIMEOUT_MS[f] || 240000

// 全部 test.js（自动发现，新增测试自动纳入，不再靠手改 package.json 的 && 链）
const all = fs.readdirSync(TESTS).filter(f => /\.test\.js$/.test(f)).sort()
// 注意正则顺序/重叠：^silent 会抢走 silent-failure（它本应归 ai）；^r[0-9] 会抢走
// r7-sandbox-guard（应归 sandbox）。故先列「显式归属」白名单，再走通用前缀。
const AI_OVERRIDE = /^silent-failure/i
const SBX_OVERRIDE = /^r[0-9]+-sandbox|^sandbox|^obf-|^quarantine|^server-veto|^silent(?!-failure)|^security/i
const reAi = /^(ai-|a1-|eval|r[0-9]|phase-|github-quota|quality|quota|feedback|blindspot|decision-)/i
function groupOf (f) {
  if (SBX_OVERRIDE.test(f)) return 'sandbox'
  if (AI_OVERRIDE.test(f) || reAi.test(f)) return 'ai'
  return 'func'
}
const groups = { ai: [], sandbox: [], func: [] }
for (const f of all) groups[groupOf(f)].push(f)
// 分组守恒自检：每个文件恰好归一组，不重不漏（新增测试若漏归类会在这里直接报错）
{
  const sum = groups.ai.length + groups.sandbox.length + groups.func.length
  const dup = all.filter(f => Object.values(groups).filter(g => g.includes(f)).length !== 1)
  if (sum !== all.length || dup.length) {
    throw new Error(`分组守恒失败: total=${all.length} 分组和=${sum} 重复/漏分=${JSON.stringify(dup)}`)
  }
  console.log(`分组自检 OK: ai=${groups.ai.length} sandbox=${groups.sandbox.length} func=${groups.func.length} total=${all.length}`)
}

// 三个重子进程测试：彼此互斥（各自起几十个 node 子进程，并发会触发 Windows libuv 崩溃）
const HEAVY = new Set(['sandbox-throw-leak.test.js', 'sandbox-throw-residue.test.js', 'sandbox-return-write.test.js'])
const CONCURRENCY = 2

// 异步跑单个测试：自己管理 timeout/kill/stdout+stderr 收集。
// 必须 windowsHide:true，否则 Windows 上每个子进程都会弹一个控制台窗。
function runOne (file) {
  return new Promise(resolve => {
    let out = ''
    let settled = false
    const finish = why => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ file, ok: !why, why })
    }
    let child
    try {
      child = cp.spawn(NODE, [path.join(TESTS, file)], {
        cwd: path.dirname(TESTS), windowsHide: true
      })
    } catch (e) {
      return finish('throw :: ' + String(e && e.message))
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch (_) {}
      finish('TIMEOUT')
    }, timeoutFor(file))
    const push = d => { if (out.length < 16 * 1024 * 1024) out += d }  // 与旧 maxBuffer 16MB 等价
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', e => finish('throw :: ' + String(e && e.message)))
    child.on('close', code => {
      if (code === 0) return finish()
      const failLines = out.split(/\r?\n/).filter(l => /\bFAIL\b/.test(l)).slice(0, 3)
      finish((code === null ? 'killed' : 'exit=' + code) + ' :: ' + (failLines.join(' | ') || out.slice(-240)))
    })
  })
}

// 组内有限并发：全局最多 CONCURRENCY 个 worker；三个 heavy 测试彼此互斥（最多 1 个在跑）。
async function runGroup (name, files, serial) {
  const t0 = Date.now()
  const results = new Array(files.length)
  const queue = files.map((f, i) => ({ f, i }))
  let next = 0
  let heavyBusy = false
  const limit = serial ? 1 : CONCURRENCY

  async function worker () {
    while (true) {
      // 从队列里挑一个「当前可跑」的任务：heavy 必须等 heavyBusy 释放
      let picked = -1
      for (let k = next; k < queue.length; k++) {
        const isHeavy = HEAVY.has(queue[k].f)
        if (isHeavy && heavyBusy) continue
        picked = k
        break
      }
      if (picked < 0) {
        if (next >= queue.length) return
        await new Promise(r => setTimeout(r, 20))   // 只剩被锁的 heavy，等释放
        continue
      }
      const task = queue[picked]
      // 把它与 next 位置交换后推进游标，保证每个任务只被取一次
      ;[queue[picked], queue[next]] = [queue[next], queue[picked]]
      next++
      const isHeavy = HEAVY.has(task.f)
      if (isHeavy) heavyBusy = true
      try {
        results[task.i] = await runOne(task.f)
      } finally {
        if (isHeavy) heavyBusy = false
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, files.length) }, () => worker())
  await Promise.all(workers)
  const fails = results.filter(r => r && !r.ok)
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  return { name, total: files.length, pass: files.length - fails.length, fails, secs }
}

function report (g) {
  if (!QUIET) console.log(`[${g.name}] ${g.pass}/${g.total} PASS, ${g.fails.length} FAIL (${g.secs}s)`)
  for (const f of g.fails) console.log(`  FAIL ${f.file} :: ${f.why}`)
}

function writeResult (allGroups) {
  const lines = []
  let tp = 0, tt = 0, tf = 0
  for (const g of allGroups) {
    lines.push(`${g.name}: ${g.pass}/${g.total} PASS, ${g.fails.length} FAIL (${g.secs}s)`)
    for (const f of g.fails) lines.push(`  FAIL ${f.file} :: ${f.why}`)
    tp += g.pass; tt += g.total; tf += g.fails.length
  }
  lines.push(`TOTAL ${tp}/${tt} PASS, ${tf} FAIL`)
  try { fs.writeFileSync(path.join(TOOLS, '.last-test-result.txt'), lines.join('\n') + '\n', 'utf8') } catch (_) {}
  return { tp, tt, tf }
}

async function main () {
  console.log(`node ${NODE}  ·  测试 ${all.length} 个  ·  模式 ${SERIAL ? 'serial' : (groupArg ? 'group:' + groupArg : 'parallel')}`)
  const names = groupArg ? [groupArg] : ['ai', 'sandbox', 'func']
  if (groupArg && !groups[groupArg]) { console.error('未知分组: ' + groupArg + '（应为 ai|sandbox|func）'); process.exit(2) }

  let resultGroups
  if (SERIAL) {
    // 纯串行：一个组接一个组，组内也串行（并发度 1）
    resultGroups = []
    for (const n of names) { const g = await runGroup(n, groups[n], true); report(g); resultGroups.push(g) }
  } else {
    // 组间并行：3 组同时开跑，各自组内限并发 2、heavy 互斥
    const gs = await Promise.all(names.map(n => runGroup(n, groups[n], false)))
    for (const g of gs) report(g)
    resultGroups = gs
  }
  const { tp, tt, tf } = writeResult(resultGroups)
  console.log(`\n==== TOTAL ${tp}/${tt} PASS  ${tf} FAIL ====`)
  process.exitCode = tf ? 1 : 0
}

main().catch(e => { console.error('FATAL ' + String(e && e.stack || e)); process.exit(2) })
