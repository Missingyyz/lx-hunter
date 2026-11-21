'use strict'
/**
 * 分组并行测试 runner（正式测试链工具，替代 package.json 里那条 4000 字符的串行 && 链）。
 *
 * 为什么分组并行：
 *  - 全量 121 个 test.js，纯串行要 10+ 分钟（sandbox-throw-leak 单个 ~360s）；
 *  - 组间并行、组内串行，实测 ~10 分钟 → ~1.5 分钟（瓶颈落在最慢的沙箱组）。
 *
 * 分组口径（按文件名前缀，纯测试组织，不改任何被测代码）：
 *  - ai       AI 复检 / 评测 / R1-R10 / 配额 / 影子判据
 *  - sandbox  沙箱逃逸 / 混淆闸门 / 隔离区 / server-veto / 安全
 *  - func     其余功能项（爬取/巡检/去重/导入/UI/网络…）
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
const reAi = /^(ai-|a1-|eval|r[0-9]|phase-|github-quota|silent-failure|quality|quota|feedback|blindspot|decision-)/i
const reSbx = /^sandbox|^obf-|^quarantine|^server-veto|^silent|^security/i
function groupOf (f) {
  if (reSbx.test(f)) return 'sandbox'
  if (reAi.test(f)) return 'ai'
  return 'func'
}
const groups = { ai: [], sandbox: [], func: [] }
for (const f of all) groups[groupOf(f)].push(f)

function runOne (file) {
  try {
    const r = cp.spawnSync(NODE, [path.join(TESTS, file)], {
      cwd: path.dirname(TESTS), encoding: 'utf8', timeout: timeoutFor(file),
      windowsHide: true, maxBuffer: 16 * 1024 * 1024
    })
    if (r.status === 0) return { file, ok: true }
    const out = (r.stdout || '') + (r.stderr || '')
    const failLines = out.split(/\r?\n/).filter(l => /\bFAIL\b/.test(l)).slice(0, 3)
    return { file, ok: false, why: (r.status === null ? 'TIMEOUT' : 'exit=' + r.status) + ' :: ' + (failLines.join(' | ') || out.slice(-240)) }
  } catch (e) {
    return { file, ok: false, why: 'throw :: ' + String(e && e.message) }
  }
}

function runGroup (name, files) {
  const t0 = Date.now()
  const results = files.map(runOne)          // 组内串行
  const fails = results.filter(r => !r.ok)
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
    // 纯串行：一个组接一个组，组内也串行
    resultGroups = []
    for (const n of names) { const g = runGroup(n, groups[n]); report(g); resultGroups.push(g) }
  } else {
    // 组间并行：3 组同时开跑，各自组内串行
    const gs = await Promise.all(names.map(n => Promise.resolve().then(() => runGroup(n, groups[n]))))
    for (const g of gs) report(g)
    resultGroups = gs
  }
  const { tp, tt, tf } = writeResult(resultGroups)
  console.log(`\n==== TOTAL ${tp}/${tt} PASS  ${tf} FAIL ====`)
  process.exitCode = tf ? 1 : 0
}

main().catch(e => { console.error('FATAL ' + String(e && e.stack || e)); process.exit(2) })
