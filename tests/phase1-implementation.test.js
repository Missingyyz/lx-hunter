'use strict'
/**
 * Phase1 四项针对性回归（隔离数据，不碰真实 /data、不联网、不改 gold）。
 *  P1-1 队列质量排序：稳定/可复现、未打分源按 usable 分层降级、verified/稳健性次级键、tie-break
 *  P1-2 仓库排序：历史产出优先 + 强制防饥饿（新仓每轮保底名额）、定向不排序的契约在函数层
 *  P1-3 服务端画像：纯函数聚合、serverList=null 容错返回 null（调用方据此保留旧值）、不驱动行为
 *  P1-4 闲置信号：稳健性次级键生效、UI 徽章字段缺失不编造、core/renderer 逐位一致
 */
const assert = require('assert')
const Q = require('../src/core/quality')
const S = require('../src/renderer/sorters')
const { profileServerFleet } = require('../src/core/serverVeto')
const { rankRepoSeeds, buildRepoSeeds } = require('../src/core/hunter')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}
const KEYS = ['wy', 'tx', 'kw', 'kg', 'mg']
// entry：n 个可用平台；score=深度打分；extra 追加指标
function entry(id, n, p50, extra) {
  const platforms = {}
  KEYS.forEach((k, i) => { platforms[k] = { status: i < n ? 'usable' : 'failed', verified: i < n && extra && extra.verified ? true : undefined } })
  const metrics = p50 == null ? (extra && extra.metrics) : Object.assign({ depth: 'full', samples: 3, p50LatencyMs: p50 }, extra && extra.metrics)
  const deep = { checkedAt: 1, platforms }
  if (metrics) deep.metrics = metrics
  return Object.assign({ id, scriptName: id, deep }, extra && extra.top ? extra.top : {})
}

console.log('=== P1-1 队列质量排序 ===')
{
  // 主键：平台数多优先
  const a = entry('a', 2, 300), b = entry('b', 4, 900)
  ok('平台数优先于延迟', Q.compareImportQuality(b, a) < 0)
  // 未打分源按 usable 分层降级（层内末位），不是全局 MAX
  const scored2 = entry('s2', 2, 500)
  const unscored2 = entry('u2', 2, null)
  const scored3 = entry('s3', 3, 800)
  const unscored3 = entry('u3', 3, null)
  ok('同 usable 层内：已打分排在未打分之前', Q.compareImportQuality(scored2, unscored2) < 0)
  ok('分层降级：3平台未打分仍排在 2平台已打分之前', Q.compareImportQuality(unscored3, scored2) < 0)
  ok('未打分源之间按 id 兜底可复现（sortKey 全等）', Q.compareSortKey(unscored2, entry('u2b', 2, null)) === 0)
  // 稳定可复现：打乱输入顺序结果一致
  const pool = [unscored2, scored3, scored2, entry('x', 5, 100), unscored3]
  const o1 = pool.slice().sort((x, y) => Q.compareImportQuality(x, y) || String(x.id).localeCompare(String(y.id))).map(e => e.id).join('')
  const o2 = pool.slice().reverse().sort((x, y) => Q.compareImportQuality(x, y) || String(x.id).localeCompare(String(y.id))).map(e => e.id).join('')
  ok('排序稳定可复现（输入反转结果一致）', o1 === o2, o1 + ' vs ' + o2)
  // verified 次级键：主键全等时真校验多的排前
  const vHi = entry('vh', 3, 400, { verified: 2 })   // 两个可用平台 verified
  const vLo = entry('vl', 3, 400, { verified: 0 })
  ok('verified 作次级键（有则用）', Q.compareImportQuality(vHi, vLo) < 0, JSON.stringify([Q.profile(vHi).verified, Q.profile(vLo).verified]))
  // 稳健性次级键：playableRate 高者排前（主键/verified 全等）
  const rHi = entry('rh', 3, 400, { metrics: { playableRate: 0.9, successRate: 0.95, p90LatencyMs: 500 } })
  const rLo = entry('rl', 3, 400, { metrics: { playableRate: 0.5, successRate: 0.8, p90LatencyMs: 500 } })
  ok('playableRate 作次级键', Q.compareImportQuality(rHi, rLo) < 0)
  // suspectScore tie-break：其余全等时分低者排前
  const sLo = entry('sl', 3, 400, { top: { suspectScore: 1 } })
  const sHi = entry('sh', 3, 400, { top: { suspectScore: 9 } })
  ok('suspectScore 作 tie-break', Q.compareImportQuality(sLo, sHi) < 0)
}

console.log('=== P1-2 仓库排序 + 防饥饿 ===')
{
  const now = Date.now()
  const repos = ['org/oldA', 'org/oldB', 'org/newC', 'org/newD', 'org/newE']
  const sources = [
    { repo: 'org/oldA', usable: true, addedAt: now - 1e7 },
    { repo: 'org/oldA', usable: true, addedAt: now - 1e7 },
    { repo: 'org/oldB', usable: true, addedAt: now - 3e7 }
  ]
  const r = rankRepoSeeds(repos, { sources, now, newQuota: 2 })
  ok('有历史仓按 score 降序（oldA > oldB）', r.ordered.indexOf('org/oldA') < r.ordered.indexOf('org/oldB'))
  ok('防饥饿：每轮前 N 名额给新仓（newC/newD 提到最前）',
    r.ordered[0] === 'org/newC' && r.ordered[1] === 'org/newD', r.ordered.join(','))
  ok('新仓未被拉黑（其余新仓仍在队列）', ['org/newC', 'org/newD', 'org/newE'].every(x => r.ordered.includes(x)))
  ok('新仓 score=中位数（非 0）', r.scores['org/newC'] > 0, String(r.scores['org/newC']))
  // 死仓命中惩罚生效
  const dead = { 'org/oldB': { hits: 100 } }
  const r2 = rankRepoSeeds(repos, { sources, now, deadRepos: dead, newQuota: 2 })
  ok('deadRepos.hits 作负权重（oldB 分下降）', r2.scores['org/oldB'] < r.scores['org/oldB'])
  // 无历史仓时全部新仓保序（防饥饿不炸）
  const r3 = rankRepoSeeds(['x/1', 'y/2'], { sources: [], now, newQuota: 2 })
  ok('无历史仓时保序不炸', r3.ordered.join(',') === 'x/1,y/2')
  // buildRepoSeeds 仍返回纯种子（排序是 runCrawl 内存阶段，不污染种子函数）
  ok('buildRepoSeeds 不受排序改动影响', Array.isArray(buildRepoSeeds({ repos: [{ repo: 'a/b', enabled: true }] })))
}

console.log('=== P1-3 服务端画像（纯落盘、null 容错） ===')
{
  ok('serverList=null 返回 null（调用方据此跳过、保留旧值）', profileServerFleet(null, {}, {}) === null)
  ok('非数组返回 null', profileServerFleet({}, {}, {}) === null)
  const sl = [
    { id: '1', enabled: true, status: 'ok', supportedSources: ['wy', 'tx'], disabledSources: [], owner: 'open' },
    { id: '2', enabled: false, status: 'failed', supportedSources: ['wy'], disabledSources: ['wy'], owner: 'alice' },
    { id: '3', enabled: true, status: 'ok', supportedSources: [], disabledSources: [], owner: 'open' }
  ]
  const p = profileServerFleet(sl, { '1': {}, '2': {} }, { '2': { type: 'isolated' } })
  ok('计数：total/enabled/disabled/failed/isolated', p.total === 3 && p.enabled === 2 && p.disabled === 1 && p.failed === 1 && p.isolated === 1)
  ok('平台 supported/disabled 计数', p.platforms.wy.supported === 2 && p.platforms.wy.disabled === 1 && p.platforms.tx.supported === 1)
  ok('缺口平台按支撑升序（kw/kg/mg 为 0 排前）', p.gapPlatforms.slice(0, 3).join(',') === 'kw,kg,mg', p.gapPlatforms.join(','))
  ok('owner 分布', p.owners.open === 2 && p.owners.alice === 1)
  ok('样本数与时间戳', p.sampleCount === 3 && typeof p.at === 'number')
  ok('画像只含统计字段、不含 any act/veto 写指令', !('act' in p) && !('blockedRepos' in p))
}

console.log('=== P1-4 稳健性徽章 + 镜像一致 ===')
{
  ok('稳健性徽章：有字段显示可播/取链/p90', /可播 90%/.test(S.qualityRobustnessHtml({ deep: { metrics: { playableRate: 0.9, successRate: 0.8, p90LatencyMs: 450 } } })))
  ok('稳健性徽章：字段缺失返回空串（不编造）', S.qualityRobustnessHtml({}) === '' && S.qualityRobustnessHtml({ deep: { metrics: {} } }) === '')
  ok('稳健性徽章：无 HTML 注入面', /^<span class="qbrief robust"/.test(S.qualityRobustnessHtml({ deep: { metrics: { playableRate: 0.9 } } })))
  // core/renderer 逐位一致（含 P1-1 分层语义、samples=0 降级）
  const pool = [entry('a', 4, 600, { metrics: { qualityMax: 'flac' } }), entry('b', 4, 300), entry('c', 2, null), entry('d', 5, 900), entry('e', 2, 200, { metrics: { samples: 0 } })]
  const same = pool.every(e => JSON.stringify(S.qualitySortKey(e)) === JSON.stringify(Q.sortKey(e)))
  ok('core/renderer sortKey 逐位一致（含 samples=0 降级）', same,
    pool.map(e => e.id + ':' + JSON.stringify(S.qualitySortKey(e)) + '/' + JSON.stringify(Q.sortKey(e))).join(' '))
}

console.log('\n' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS（' + pass + ' 项）'))
process.exit(fail ? 1 : 0)
