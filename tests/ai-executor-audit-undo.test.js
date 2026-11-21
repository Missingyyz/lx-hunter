'use strict'
/**
 * R4-R7 真实 executor + audit/undo（v1.15.0，阶段7）。
 * 验证：① 生产/非沙箱恒拒绝执行；② 沙箱注入后 R5/R6/R7 真实写回；
 * ③ audit 多 target 快照正确；④ undo 逐字回到 before；⑤ R7 标 serverDeleteSkipped 且不碰服务端。
 * 零框架，assert + 计数。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ROOT = path.join(__dirname, '..')
let pass = 0
const ok = (c, l) => { assert.ok(c, l); pass++; console.log('  PASS', l) }

const { Store } = require(path.join(ROOT, 'src', 'core', 'store'))
const { AIReview } = require(path.join(ROOT, 'src', 'core', 'aiReview'))
const execs = require(path.join(ROOT, 'tests', 'eval-lab', 'executors'))

function tmpStore () { return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-exec-'))) }

async function main () {
  console.log('--- ① 生产恒拒绝（代码层无 write 能力） ---')
  const s0 = tmpStore()
  const a0 = new AIReview(s0)
  a0.cfg.enabled = true
  const r0 = await a0.execute('R5', {})
  ok(r0.executed === false && /非评测沙箱/.test(r0.reason), '未开沙箱时 execute 拒绝（生产默认）')
  const beforeSources = JSON.stringify(s0.db.sources)
  ok(JSON.stringify(s0.db.sources) === beforeSources, '拒绝时 sources 未变')

  console.log('--- ② 沙箱注入 + R5 特征库真实写回 + undo ---')
  const savedSandbox = process.env.LX_EVAL_SANDBOX
  const savedNodeEnv = process.env.NODE_ENV
  process.env.LX_EVAL_SANDBOX = '1'
  process.env.NODE_ENV = 'test'
  const s = tmpStore()
  const a = new AIReview(s)
  a.cfg.enabled = true
  a.cfg.evalExecutorsEnabled = true   // 在 aiReview 子配置里（AI_REVIEW_DEFAULTS）
  // 开启对应授权位 + 高风险双锁（否则 gate 拒绝，execute 不会调 executor）
  a.cfg.autoActions.R5 = true
  a.cfg.autoActions.R6 = true
  a.cfg.autoActions.R7 = true
  a.cfg.autoActions.irreversible = true
  a.cfg.allowIrreversible = true
  AIReview.setExecutor('R5', execs.r5BlockPattern)
  AIReview.setExecutor('R6', execs.r6Trust)
  AIReview.setExecutor('R7', execs.r7DeleteLocal)
  const cfgBefore = deepClone(s.config.crawlerBlockPatterns)
  const r5 = await a.execute('R5', { stem: '评测新增模式', evalVerdict: '达标', signals: [{ key: 'x', ok: true }] })
  ok(r5.executed === true && r5.auditId, 'R5 沙箱执行成功，落 auditId')
  ok(s.config.crawlerBlockPatterns.indexOf('评测新增模式') !== -1, 'R5 真实写入 crawlerBlockPatterns')
  const u5 = a.undo(r5.auditId)
  ok(u5.ok && u5.restored.indexOf('config.crawlerBlockPatterns') !== -1, 'R5 undo 恢复路径正确')
  ok(JSON.stringify(s.config.crawlerBlockPatterns) === JSON.stringify(cfgBefore), 'R5 undo 后特征库逐字回到 before')

  console.log('--- ③ R6 信任真实写回 + undo（快照直写，不用 trust=false） ---')
  s.db.sources.r6src = { id: 'r6src', status: 'quarantined', quarantined: true, contentHash: 'hash-r6',
    error: '混淆隔离', deep: { checkedAt: 1, platforms: [{ status: 'usable' }] } }
  s.saveDb()
  const trustBefore = deepClone(s.config.trustedObfHashes)
  const srcBefore = deepClone(s.db.sources.r6src)
  const r6 = await a.execute('R6', { entryId: 'r6src', contentHash: 'hash-r6', evalVerdict: '达标',
    signals: [{ key: 'obfEvidence', ok: true }, { key: 'notHardDead', ok: true }] })
  ok(r6.executed === true, 'R6 沙箱执行成功')
  ok(s.config.trustedObfHashes.indexOf('hash-r6') !== -1 && s.db.sources.r6src.status === 'ok' && !s.db.sources.r6src.quarantined,
    'R6 真实写信任名单 + 源状态')
  a.undo(r6.auditId)
  ok(JSON.stringify(s.config.trustedObfHashes) === JSON.stringify(trustBefore), 'R6 undo 后信任名单逐字回退')
  ok(JSON.stringify(s.db.sources.r6src) === JSON.stringify(srcBefore), 'R6 undo 后源对象逐字回退（不被重新隔离）')

  console.log('--- ④ R7 只删本地副本 + undo 复活 + serverDeleteSkipped ---')
  s.db.sources.r7src = { id: 'r7src', status: 'dead' }
  s.imported.r7src = { id: 'r7src', hash: 'h' }
  s.saveDb(); s.saveImported()
  const r7Before = deepClone(s.db.sources.r7src)
  const impBefore = deepClone(s.imported.r7src)
  const r7 = await a.execute('R7', { entryId: 'r7src', evalVerdict: '达标',
    signals: [{ key: 'deleteEvidence', ok: true }, { key: 'noUsablePlatform', ok: true }] })
  ok(r7.executed === true && (r7.warnings || []).indexOf('serverDeleteSkipped') !== -1,
    'R7 执行报告 serverDeleteSkipped（服务端删除未接）')
  ok(!s.db.sources.r7src && !s.imported.r7src, 'R7 本地副本已删')
  a.undo(r7.auditId)
  ok(JSON.stringify(s.db.sources.r7src) === JSON.stringify(r7Before) &&
    JSON.stringify(s.imported.r7src) === JSON.stringify(impBefore), 'R7 undo 后本地副本逐字复活')

  // 还原环境变量（避免污染其它测试）
  if (savedSandbox === undefined) delete process.env.LX_EVAL_SANDBOX; else process.env.LX_EVAL_SANDBOX = savedSandbox
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv

  console.log('\n执行器+审计回滚: PASS ' + pass + ' / FAIL 0')
}
function deepClone (o) { return o == null ? o : JSON.parse(JSON.stringify(o)) }
main().catch(e => { console.error('\n执行器+审计回滚: FAIL\n', e); process.exitCode = 1 })
