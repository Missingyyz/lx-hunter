'use strict'
/**
 * 阶段8 影子评测 lab 的物理隔离验证：
 * ① 生产镜像/构建不含 tests/eval-lab（代码层不存在能力）；
 * ② 入口三重断言（非沙箱 / production / 无 DATA_DIR 均拒绝）；
 * ③ 副本路径 ≠ DATA_DIR、主库跑前后 sha256 一致、副本 finally 丢弃；
 * ④ 报告三态 verdict，样本不足写"数据不足"，harm 口径正确。
 * 零框架，assert + 计数 + child_process。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const ROOT = path.join(__dirname, '..')
let pass = 0
const ok = (c, l) => { assert.ok(c, l); pass++; console.log('  PASS', l) }
const NODE = process.execPath

function sha256File (p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch (e) { return 'MISSING' }
}
function makeMainDir (n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-main-'))
  const sources = {}
  for (let i = 0; i < n; i++) sources['s' + i] = { id: 's' + i, name: '源' + i, status: 'ok',
    deep: { checkedAt: 1, platforms: [{ status: 'usable' }] } }
  fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({ sources }))
  fs.writeFileSync(path.join(dir, 'imported.json'), JSON.stringify({}))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ aiReview: { provider: { apiKey: 'SECRET' } } }))
  return dir
}

console.log('--- ① 生产构建不含 eval-lab ---')
;(() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const files = pkg.build && pkg.build.files ? pkg.build.files : []
  ok(!files.some(f => /eval-lab/.test(f)), 'package.json build.files 不含 eval-lab')
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
  ok(!/eval-lab/.test(docker), 'Dockerfile 不 COPY eval-lab')
  ok(/NODE_ENV=production/.test(docker), 'Dockerfile 写死 NODE_ENV=production（运行时也锁死）')
})()

console.log('--- ② 入口三重断言 ---')
;(() => {
  const run = path.join(ROOT, 'tests', 'eval-lab', 'run.js')
  const dir = makeMainDir(3)
  const tryRun = (env) => {
    try { execFileSync(NODE, [run], { env: Object.assign({}, process.env, env), encoding: 'utf8', stdio: 'pipe' }); return false }
    catch (e) {
      const out = String((e.stdout || '') + (e.stderr || ''))
      return { honest: /拒绝运行/.test(out), out }
    }
  }
  let r = tryRun({ NODE_ENV: 'test', DATA_DIR: dir })  // 无 LX_EVAL_SANDBOX
  ok(r && r.honest && /LX_EVAL_SANDBOX/.test(r.out), '未置 LX_EVAL_SANDBOX → 拒绝')
  r = tryRun({ NODE_ENV: 'production', LX_EVAL_SANDBOX: '1', DATA_DIR: dir })
  ok(r && r.honest && /production/.test(r.out), 'NODE_ENV=production → 拒绝')
  r = tryRun({ NODE_ENV: 'test', LX_EVAL_SANDBOX: '1' })  // 无 DATA_DIR
  ok(r && r.honest && /DATA_DIR/.test(r.out), 'DATA_DIR 未设置 → 拒绝')
})()

console.log('--- ③ 隔离运行 + 主库零改动 + 报告结构 ---')
;(async () => {
  const run = path.join(ROOT, 'tests', 'eval-lab', 'run.js')
  const dir = makeMainDir(30)  // 30 条 ≥ 下限 20，应判"达标"（本样本 HARD 区）
  const before = sha256File(path.join(dir, 'sources.json'))
  const beforeImp = sha256File(path.join(dir, 'imported.json'))
  const beforeCfg = sha256File(path.join(dir, 'config.json'))
  let out = ''
  try { out = execFileSync(NODE, [run], { env: Object.assign({}, process.env,
    { NODE_ENV: 'test', LX_EVAL_SANDBOX: '1', DATA_DIR: dir }), encoding: 'utf8', stdio: 'pipe' }) }
  catch (e) { out = String((e.stdout || '') + (e.stderr || '')) }
  ok(/verdict=/.test(out), 'lab 正常产出报告（' + (out.match(/verdict=\S+/) || [''])[0] + '）')
  ok(sha256File(path.join(dir, 'sources.json')) === before &&
    sha256File(path.join(dir, 'imported.json')) === beforeImp &&
    sha256File(path.join(dir, 'config.json')) === beforeCfg, '主库三文件 sha256 跑前后一致（零写入）')
  ok(/临时副本已丢弃/.test(out), 'finally 丢弃副本')
  // 报告结构
  const reportDir = path.join(ROOT, 'tests', 'eval-lab', 'reports')
  const files = fs.existsSync(reportDir) ? fs.readdirSync(reportDir).filter(f => /^shadow-.*\.json$/.test(f)) : []
  ok(files.length > 0, '报告落盘 tests/eval-lab/reports/')
  if (files.length) {
    const rep = JSON.parse(fs.readFileSync(path.join(reportDir, files[files.length - 1]), 'utf8'))
    ok(/评测能力，非放开授权/.test(rep._notice), '报告顶部红字"评测能力，非放开授权"')
    ok(['达标', '未达标', '数据不足'].indexOf(rep.verdict) !== -1, 'verdict 为三态之一')
    ok(rep.artifacts && rep.artifacts.discarded === true, '报告记 artifacts.discarded=true')
    ok(typeof rep.harmCount === 'number' && typeof rep.missCount === 'number', '报告含 harm/miss 计数')
  }
  // 样本不足 → 数据不足
  const smallDir = makeMainDir(3)
  let out2 = ''
  try { out2 = execFileSync(NODE, [run], { env: Object.assign({}, process.env,
    { NODE_ENV: 'test', LX_EVAL_SANDBOX: '1', DATA_DIR: smallDir }), encoding: 'utf8', stdio: 'pipe' }) }
  catch (e) { out2 = String((e.stdout || '') + (e.stderr || '')) }
  ok(/verdict=数据不足/.test(out2), '样本不足（3<20）→ 判"数据不足"而非"达标"')

  // 清理测试自产的报告（reports/ 只保留 .gitkeep，真实评测报告由使用者按需生成）
  try {
    for (const f of fs.readdirSync(reportDir)) {
      if (/^shadow-.*\.json$/.test(f)) fs.unlinkSync(path.join(reportDir, f))
    }
  } catch (e) {}

  console.log('\n影子评测lab隔离: PASS ' + pass + ' / FAIL 0')
})().catch(e => { console.error('\n影子评测lab隔离: FAIL\n', e); process.exitCode = 1 })
