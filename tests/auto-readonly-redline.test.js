'use strict'
/**
 * 「自动仅只读」红线守住验证（Phase1 改动后）。只读，不改产品代码/数据。
 * 核心：自动档绝不自动执行 R4-R7 的真实业务动作（删/隔离/信任/入特征库）；
 *       apply 是唯一执行入口且只由人工确认/显式 gate 触发；默认安全态完好。
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const ROOT = path.join(__dirname, '..')
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}

// ---- 1. gate() 各档位判定（真实函数，隔离 store）----
const Store = require('../src/core/store').Store
const AIReview = require('../src/core/aiReview').AIReview
const os = require('os')
function ai(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoro-'))
  const s = new Store(dir)
  s.config.aiReview = Object.assign({}, s.config.aiReview, cfg)
  return new AIReview(s)
}
console.log('=== 1. gate 档位判定 ===')
{
  const off = ai({ enabled: true, mode: 'off' })
  for (const k of ['R1','R2','R3','R4','R5','R6','R7']) ok('off档 '+k+' 不自动', off.gate(k).auto === false, JSON.stringify(off.gate(k)))

  const assist = ai({ enabled: true, mode: 'assist' })
  for (const k of ['R1','R2','R3']) ok('assist档 '+k+' 自动(只读)', assist.gate(k).auto === true)
  for (const k of ['R4','R5','R6','R7']) ok('assist档 '+k+' 不自动', assist.gate(k).auto === false)

  // 总开关关闭：全不自动（即便 auto 档）
  const dis = ai({ enabled: false, mode: 'auto', allowIrreversible: true })
  for (const k of ['R1','R4','R6']) ok('总开关关 '+k+' 不自动', dis.gate(k).auto === false)

  // auto 档：R4/R5 可自动铺轨（低中风险），R6/R7 无双锁不自动
  const auto = ai({ enabled: true, mode: 'auto', allowIrreversible: false })
  ok('auto档 R4 可自动(铺轨非执行)', auto.gate('R4').auto === true)
  ok('auto档 R5 可自动(铺轨非执行)', auto.gate('R5').auto === true)
  ok('auto档 R6 无双锁不自动', auto.gate('R6').auto === false)
  ok('auto档 R7 无双锁不自动', auto.gate('R7').auto === false)
  const autoLock = ai({ enabled: true, mode: 'auto', allowIrreversible: true })
  ok('auto档+双锁 R6 才放行', autoLock.gate('R6').auto === true)
  ok('auto档+双锁 R7 才放行', autoLock.gate('R7').auto === true)
}

// ---- 2. 默认安全态 ----
console.log('=== 2. 默认安全态 ===')
{
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'autoro-')))
  const a = s.config.aiReview
  ok('默认 enabled=false', a.enabled === false)
  ok('默认 mode=off', a.mode === 'off')
  ok('默认 allowIrreversible=false', a.allowIrreversible === false)
  ok('默认 autoEnabled=false', a.autoEnabled === false)
  ok('默认 autoLlmReviewEnabled=false（自动逐条LLM默认关）', a.autoLlmReviewEnabled === false)
}

// ---- 3. 自动定时器只产建议、不调业务执行（静态代码核实）----
console.log('=== 3. 自动定时器无业务执行 ===')
const web = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')
for (const [label, src] of [['web.js', web], ['main/index.js', main]]) {
  // 定位自动定时器区块（R1 聚类 + 自动只读复检），确认只调 ai().run，不调 apply 业务动作
  const timerStart = src.indexOf('R1 失败聚类日志')
  const timerBlock = src.slice(timerStart, timerStart + 4000)
  ok(label + ' 自动定时器调 ai().run', /ai\(\)\.run\('R1'/.test(timerBlock) || /ai\(\)\.run\('R3'/.test(timerBlock))
  ok(label + ' 自动定时器不调 apply', !/applySuggestion|runApply|\.apply\(/.test(timerBlock))
  ok(label + ' 自动定时器不调业务删/信任/隔离', !/\b(blacklist|trustSource|quarantine|deleteSource|applySuggestion|runApply)\s*\(/.test(timerBlock) && !/入特征库\s*[（(]/.test(timerBlock), '仅允许 status===quarantined 只读筛选')
  ok(label + ' 自动逐条LLM受 autoLlmReviewEnabled 门禁', /if \(!cfg\.autoLlmReviewEnabled\) return/.test(timerBlock))
}

// ---- 4. apply 执行入口白名单 + 只读结论拒绝 ----
console.log('=== 4. apply 执行白名单 ===')
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
  const applyBlock = src.slice(src.indexOf("'/api/ai-review/apply'"), src.indexOf("'/api/ai-review/apply'") + 1500)
  ok('apply 有 R4-R7 白名单', /R4.*R5.*R6.*R7|APPLYABLE/.test(applyBlock))
  ok('apply 拒绝只读结论(R1/R2/R3)', /R1|只读|reject/.test(applyBlock))
  ok('apply gate 用建议自身 kind', /kind/.test(applyBlock))
}

// ---- 5. Phase1 排序改动未引入新自动执行通道 ----
console.log('=== 5. Phase1 未开自动执行后门 ===')
{
  const quality = fs.readFileSync(path.join(ROOT, 'src', 'core', 'quality.js'), 'utf8')
  const hunter = fs.readFileSync(path.join(ROOT, 'src', 'core', 'hunter.js'), 'utf8')
  const serverVeto = fs.readFileSync(path.join(ROOT, 'src', 'core', 'serverVeto.js'), 'utf8')
  // 排序/画像纯函数不得包含业务执行动作
  for (const [label, src] of [['quality.js', quality], ['rankRepoSeeds', hunter.slice(hunter.indexOf('rankRepoSeeds'), hunter.indexOf('rankRepoSeeds') + 2500)], ['profileServerFleet', serverVeto.slice(serverVeto.indexOf('profileServerFleet'), serverVeto.indexOf('profileServerFleet') + 2500)]]) {
    ok(label + ' 无删/隔离/信任/写blacklist动作', !/db\.deletedIds|blockedRepos|trustSource|quarantine|blacklist\.push|act\s*=/.test(src))
  }
  // 画像只落盘、无读取驱动排序
  ok('serverFleetProfile 无驱动采集/灌入读取', (hunter.match(/serverFleetProfile/g) || []).length <= 2, '出现次数=' + (hunter.match(/serverFleetProfile/g) || []).length)
}

console.log('\n' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS（' + pass + ' 项）'))
process.exit(fail ? 1 : 0)
