'use strict'
/**
 * 中高盲区修复的针对性回归（隔离数据，不 listen、不联网、不碰 /data）：
 *  越权门禁 / 失败退避水位 / dataExport 误报 / dataio 原子性 / 401 广播 / L1-L3 / L6
 * web.js 会 listen，服务端与桥接层用源码契约断言；dataio / aiSchedule 做真实行为测试。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let pass = 0
const ok = (c, label) => { assert.ok(c, label); pass++; console.log('  PASS', label) }
const R = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
const webSrc = R('server/web.js')
const mainSrc = R('main/index.js')
const preSrc = R('main/preload.js')
const bridgeSrc = R('renderer/web-bridge.js')
const html = R('renderer/index.html')
const pkg = require('../package.json')

console.log('--- 1. 越权门禁：data import/export 仅管理员 ---')
ok(/route\('POST', '\/api\/data\/export'[\s\S]{0,120}assertAdmin\(req, '导出配置数据'\)/.test(webSrc), 'data/export 有 assertAdmin')
ok(/route\('POST', '\/api\/data\/import'[\s\S]{0,120}assertAdmin\(req, '导入配置数据'\)/.test(webSrc), 'data/import 有 assertAdmin')

console.log('--- 2. 失败退避水位：两壳写 lastRun/lastError ---')
for (const [name, src] of [['web', webSrc], ['main', mainSrc]]) {
  ok(/patch\.lastRun = Date\.now\(\)/.test(src), name + ' 成功写 lastRun')
  ok(/patch\.lastError = batchError \?/.test(src), name + ' 失败写 lastError')
  ok(/const markAsyncError = \(e\) =>/.test(src), name + ' 异步失败回调落库')
  ok(/awaitIgnore\(r, markAsyncError\)/.test(src) && /awaitIgnore\(p, markAsyncError\)/.test(src), name + ' fire-and-forget 失败被捕获')
  ok(/function awaitIgnore\(p, onError\)/.test(src), name + ' awaitIgnore 支持 onError')
}
// 真实行为：aiSchedulePlan 见 lastError 时进入失败退避（gapMs 收窄）
{
  const { aiSchedulePlan } = require('../src/core/aiSchedule')
  const base = { enabled: true, autoEnabled: true, autoIntervalHours: 24, autoActiveHours: { start: 0, end: 24 } }
  const st = { lastAttempt: Date.now() - 5 * 60000, lastRun: 0, lastError: '连接失败' }
  const plan = aiSchedulePlan(base, st, Date.now())
  ok(plan.gapMs === 15 * 60000 && /失败退避/.test(plan.reason), '有 lastError → 15min 失败退避生效（原来死代码）')
  const okState = { lastAttempt: Date.now() - 5 * 60000, lastRun: 0, lastError: null }
  const plan2 = aiSchedulePlan(base, okState, Date.now())
  ok(plan2.gapMs === 24 * 3600 * 1000 && /未到期/.test(plan2.reason), '无 lastError → 正常 24h 间隔')
  // max(lastAttempt,lastRun)：lastRun 更近时应以它为准
  const now = Date.now()
  const recentRun = { lastAttempt: now - 24 * 3600 * 1000 - 1, lastRun: now - 1000, lastError: null }
  ok(aiSchedulePlan(base, recentRun, now).due === false, '水位取 max(lastAttempt,lastRun)：lastRun 更近则未到期')
}

console.log('--- 3. dataExport 误报成功修复 ---')
ok(/envelope && envelope\.ok === false/.test(bridgeSrc), 'dataExport 解析响应信封 ok:false')
ok(/if \(r\.status === 401 && envelope\.authRequired\) handleAuthExpired\(\)/.test(bridgeSrc), 'dataExport 401 广播')

console.log('--- 4. dataio 原子性：saveConfig 抛错不脏内存 ---')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-atomic-import-'))
  const { importData } = require('../src/core/dataio')
  const orig = { repos: [{ repo: 'A/one', enabled: true, builtin: true, origin: 'builtin' }] }
  const committed = JSON.parse(JSON.stringify(orig))
  const store = {
    config: JSON.parse(JSON.stringify(orig)),
    saveConfig(patch) { throw new Error('DISK_FULL') }   // 模拟落盘失败
  }
  let threw = false
  try { importData(store, 'repos', { repos: [{ repo: 'a/one', enabled: false }, { repo: 'B/two', enabled: true }] }) }
  catch (e) { threw = /DISK_FULL/.test(e.message) }
  ok(threw, 'saveConfig 失败时错误上抛')
  ok(JSON.stringify(store.config) === JSON.stringify(committed), '落盘失败后 store.config 未被就地改脏（原子性）')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('--- 5. 401 不弹登录层：裸 fetch 接口补广播 ---')
ok(/function checkAuthExpired\(r, j\)/.test(bridgeSrc) && /function handleAuthExpired\(\)/.test(bridgeSrc), '401 统一处理 helper 存在')
ok((bridgeSrc.match(/checkAuthExpired\(r, await r\.json\(\)\)/g) || []).length >= 3, 'dbImport/dataImport/sourceImport 三个裸 fetch 都检查 401')
ok(/if \(r\.status === 401 && envelope\.authRequired\)/.test(bridgeSrc), 'dataExport 401 也检查')

console.log('--- 6. L1 reason 透传 / L2 applyConfig / L3 model 字段 ---')
ok(/ipcMain\.handle\('service:toggle', guard\(async \(e, id, enabled, owner, reason\)[\s\S]{0,300}svc\.adapter\.toggle\(svc\.acct, id, enabled, \{ owner, reason \}\)/.test(mainSrc), 'L1 桌面 handler 透传 reason')
ok(/serviceToggle: \(id, enabled, owner, reason\)/.test(preSrc) && /serviceToggle: \(id, enabled, owner, reason\)/.test(bridgeSrc), 'L1 preload/web-bridge 签名镜像一致')
ok(/route\('POST', '\/api\/data\/import'[\s\S]{0,400}applyConfig\(store\.config\)/.test(webSrc), 'L2 Web data import 后 applyConfig')
ok(/ai-review:test'[\s\S]{0,200}model: \(ai\(\)\.cfg\.provider \|\| \{\}\)\.model/.test(mainSrc), 'L3 桌面 ai-review:test 返回 model 字段')

console.log('--- 7. L6 桌面版本号同步 package.json ---')
ok(html.includes('PC 版 v' + pkg.version), 'L6 index.html 版本标记 = package.json 版本（dist-selfcheck 不再挂）')

console.log(`\n盲区修复回归全部通过（${pass} 项）`)
