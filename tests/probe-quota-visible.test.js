'use strict'
/**
 * 试跑配额可见（v1.15.0）：后端 probeQueue.status() 暴露剩余条数/重置时间；
 * 两端入口暴露查询接口；前端隔离区常驻显示"还可试跑 N/5，M 分钟后重置"，用尽禁用。
 * 零框架，assert + 计数。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
let pass = 0
const ok = (c, l) => { assert.ok(c, l); pass++; console.log('  PASS', l) }

async function main () {
  console.log('--- ① probeQueue.status() 配额真值 ---')
  const { makeProbeQueue, PROBE_LIMIT_PER_ROUND, PROBE_WINDOW_MS } = require(path.join(ROOT, 'src', 'core', 'probeQueue'))
  ok(PROBE_LIMIT_PER_ROUND === 5 && PROBE_WINDOW_MS === 10 * 60 * 1000, '默认 5 条 / 10 分钟窗口')
  let t = 1000000
  const q = makeProbeQueue({ now: () => t })
  let s = q.status()
  ok(s.used === 0 && s.remaining === 5 && s.limit === 5, '初始 0/5，剩余 5')
  const r = await q.run(() => Promise.resolve({ ok: true }))
  ok(r.quota && r.quota.remaining === 4, '试跑结果附带 quota 快照（跑完即可刷新显示）')
  s = q.status()
  ok(s.used === 1 && s.remaining === 4, '跑 1 次后 1/5，剩余 4')
  ok(s.resetAt === t + PROBE_WINDOW_MS, 'resetAt = 起点 + 10 分钟')
  t += PROBE_WINDOW_MS + 1
  s = q.status()
  ok(s.used === 0 && s.remaining === 5, '窗口过期后自动重置为 0/5')

  console.log('--- ② 两端入口暴露查询接口 + 前端常驻显示 ---')
  const web = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8')
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'web-bridge.js'), 'utf8')
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
  ok(/\/api\/sources\/probe-quota/.test(web) && /probeQueue\.status\(\)/.test(web), 'Web 路由 GET /api/sources/probe-quota 存在')
  ok(/'sources:probeQuota'/.test(mainSrc) && /probeQueue\.status\(\)/.test(mainSrc), '桌面 IPC sources:probeQuota 存在')
  ok(/sourcesProbeQuota/.test(pre) && /sourcesProbeQuota/.test(bridge), 'preload 与 web-bridge 镜像 sourcesProbeQuota')
  ok(/id="qzProbeQuota"/.test(html), '隔离区有配额常驻徽章 #qzProbeQuota')
  ok(/async function refreshProbeQuota/.test(app) && /refreshProbeQuota\(\)/.test(app),
    'app.js refreshProbeQuota 在渲染隔离区时调用')
  ok(/本轮还可试跑/.test(app) && /分钟后重置/.test(app), '前端文案含"还可试跑 N/limit + 分钟后重置"')
  ok(/b\.disabled = exhausted/.test(app), '配额用尽时禁用试跑按钮')

  console.log('\n试跑配额可见: PASS ' + pass + ' / FAIL 0')
}
main().catch(e => { console.error('\n试跑配额可见: FAIL\n', e); process.exitCode = 1 })
