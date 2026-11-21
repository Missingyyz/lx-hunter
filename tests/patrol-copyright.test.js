'use strict'
/**
 * v1.18 批次D：巡检版权/会员类失败不误杀（patrolJudge 语义分支）
 *
 * 背景（功能体检 2026-11-21）：
 *   testPlatform 的 5 首测试歌是固定的（"晴天"），如果这首歌在某音源后端临时无版权/需要会员，
 *   5 平台全部返回"返回空链接"——这和"音源脚本真死了"在 message 层面同形（都是 failed+空链），
 *   但前者下一轮换一首歌就好了，后者是真的不能用了。原逻辑所有非网络失败一律 streak+=1、
 *   阈值 2 → 两次版权曲就禁用一条好源。
 *
 * 修法：全部失败原因都是"返回空链接"或明确版权/会员文案时，把阈值从 2 提到 4。
 *  - "未匹配到歌曲"（脚本搜索逻辑问题）不命中 → 仍是 2
 *  - "返回异常: xxx"（脚本内部错误）不命中 → 仍是 2
 *  - 网络原因已在 isLocalNetworkIssue 挡住，不到这里
 *
 * 本测试守住：
 *   ① 全部"返回空链接" → 阈值4：streak1→suspect、streak3→suspect、streak4→dead
 *   ② 混合"返回空链接"+"未匹配到歌曲" → 不命中，阈值2
 *   ③ 全部"未匹配到歌曲" → 阈值2（回归）
 *   ④ 全部"返回异常: xxx" → 阈值2（回归）
 *   ⑤ note 里出现"（失败原因像版权/会员限制，已放宽确认次数）"
 *   ⑥ deadDomain 优先级最高（即使 message 是"返回空链接"）
 */
const assert = require('assert')
const { patrolJudge } = require('../src/core/checker')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

// ---------- ① 全部"返回空链接" → 阈值4 ----------
{
  const deep = { loadable: true, platforms: {
    wy: { status: 'failed', message: '返回空链接' },
    tx: { status: 'failed', message: '返回空链接' },
    kw: { status: 'failed', message: '返回空链接' },
    kg: { status: 'failed', message: '返回空链接' },
    mg: { status: 'failed', message: '返回空链接' }
  } }
  const j1 = patrolJudge(deep, { prevStreak: 0, threshold: 2 })
  ok(j1.verdict === 'suspect' && /连续 4 次/.test(j1.note), 'streak1+版权类 → suspect，阈值已放宽到4')
  ok(/版权\/会员限制/.test(j1.note), 'note 里出现"版权/会员限制"提示')

  const j2 = patrolJudge(deep, { prevStreak: 2, threshold: 2 })
  ok(j2.verdict === 'suspect' && j2.streak === 3, 'streak3仍小于4 → suspect（旧逻辑这里会判dead）')

  const j3 = patrolJudge(deep, { prevStreak: 3, threshold: 2 })
  ok(j3.verdict === 'dead' && j3.streak === 4, 'streak4≥4 → dead（版权类要4次确认才判死）')
}

// ---------- ② 混合"返回空链接"+"未匹配到歌曲" → 不命中，阈值2 ----------
{
  const deep = { loadable: true, platforms: {
    wy: { status: 'failed', message: '返回空链接' },
    tx: { status: 'failed', message: '未匹配到歌曲' }
  } }
  const j = patrolJudge(deep, { prevStreak: 0, threshold: 2 })
  ok(j.verdict === 'suspect' && !/版权\/会员限制/.test(j.note), '混合失败原因 → 不算版权类，阈值仍2')

  const j2 = patrolJudge(deep, { prevStreak: 1, threshold: 2 })
  ok(j2.verdict === 'dead' && j2.streak === 2, '混合类 streak2 → dead（回归旧行为）')
}

// ---------- ③ 全部"未匹配到歌曲" → 阈值2（回归） ----------
{
  const deep = { loadable: true, platforms: {
    wy: { status: 'failed', message: '未匹配到歌曲' },
    tx: { status: 'failed', message: '未匹配到歌曲' },
    kw: { status: 'failed', message: '未匹配到歌曲' }
  } }
  const j = patrolJudge(deep, { prevStreak: 0, threshold: 2 })
  ok(j.verdict === 'suspect' && !/版权\/会员限制/.test(j.note), '"未匹配到歌曲" → 不是版权类')
  const j2 = patrolJudge(deep, { prevStreak: 1, threshold: 2 })
  ok(j2.verdict === 'dead' && j2.streak === 2, '脚本搜索逻辑错 → 2次判死（回归）')
}

// ---------- ④ 全部"返回异常: xxx" → 阈值2（回归） ----------
{
  const deep = { loadable: true, platforms: {
    wy: { status: 'failed', message: '返回异常: Invalid search response' },
    tx: { status: 'failed', message: '返回异常: unknow error' }
  } }
  const j = patrolJudge(deep, { prevStreak: 0, threshold: 2 })
  ok(j.verdict === 'suspect' && !/版权\/会员限制/.test(j.note), '"返回异常" → 不是版权类')
  const j2 = patrolJudge(deep, { prevStreak: 1, threshold: 2 })
  ok(j2.verdict === 'dead' && j2.streak === 2, '脚本内部错 → 2次判死（回归）')
}

// ---------- ⑤ 版权/会员明确文案也命中 ----------
{
  const deep = { loadable: true, platforms: {
    wy: { status: 'failed', message: '需要会员' },
    tx: { status: 'failed', message: '版权限制' },
    kw: { status: 'failed', message: '试听' }
  } }
  const j = patrolJudge(deep, { prevStreak: 0, threshold: 2 })
  ok(j.verdict === 'suspect' && /版权\/会员限制/.test(j.note), '明确"需要会员/版权限制/试听"文案 → 算版权类')
}

// ---------- ⑥ deadDomain 优先级最高 ----------
{
  const deep = { loadable: true, deadDomain: true, platforms: {
    wy: { status: 'failed', message: '返回空链接' },
    tx: { status: 'failed', message: '返回空链接' }
  } }
  const j = patrolJudge(deep, { prevStreak: 0, threshold: 2 })
  ok(j.verdict === 'dead' && /接口域名已失效/.test(j.note), 'deadDomain=true → 立即判死，版权类逻辑不触发')
}

// ---------- ⑦ 网络类失败不进版权类分支 ----------
{
  const deep = { loadable: true, platforms: {
    wy: { status: 'failed', message: '请求超时 20000ms' },
    tx: { status: 'failed', message: '沙箱 fetch 失败: fetch failed' }
  } }
  const j = patrolJudge(deep, { prevStreak: 0, threshold: 2 })
  ok(j.verdict === 'unknown', '网络原因 → unknown（在 isLocalNetworkIssue 挡住，不进版权类判定）')
}

// ---------- ⑧ 回传实际判死阈值（删除线依赖它） ----------
{
  const cp = { loadable: true, platforms: { wy: { status: 'failed', message: '返回空链接' } } }
  const jn = patrolJudge(cp, { prevStreak: 0, threshold: 2 })
  ok(jn.need === 4, '版权类回传 need=4（调用方据此收紧删除线）')
  const norm = { loadable: true, platforms: { wy: { status: 'failed', message: '未匹配到歌曲' } } }
  const jn2 = patrolJudge(norm, { prevStreak: 0, threshold: 2 })
  ok(jn2.need === 2, '非版权类回传 need=2（原口径）')
}

// ---------- ⑨ 红线：禁用必须先于删除（不可逆） ----------
{
  const { patrolAutoDeleteWanted } = require('../src/core/hunter')
  const cfg = { patrolAutoDelete: true, patrolDeleteAfter: 3 }
  // 非版权类 need=2 → 删除线 max(3, 3)=3：streak3 删（与旧行为一致，无回归）
  ok(patrolAutoDeleteWanted(cfg, 3, 2 + 1) === true, '非版权类 streak3 → 删（回归旧行为）')
  ok(patrolAutoDeleteWanted(cfg, 2, 2 + 1) === false, '非版权类 streak2 → 不删')
  // 版权类 need=4：删除线 max(3, 5)=5 → streak4「首次判死」那轮绝不能删（必须先被禁用一轮）
  ok(patrolAutoDeleteWanted(cfg, 4, 4 + 1) === false, '版权类首次判死轮(streak4) → 不删，先禁用')
  ok(patrolAutoDeleteWanted(cfg, 5, 4 + 1) === true, '版权类 streak5（已被禁用过一轮）→ 可删')
  // judgeNeed=0（不经 patrolJudge 的判死路径）退回原口径
  ok(patrolAutoDeleteWanted(cfg, 3, 0) === true, '无 need 时退回配置删除线（不额外收紧）')
  ok(patrolAutoDeleteWanted({ patrolAutoDelete: false }, 99, 1) === false, '开关关闭一律不删')
}

console.log('\npatrol-copyright: PASS ' + pass + ' / FAIL 0')
