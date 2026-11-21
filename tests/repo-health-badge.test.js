'use strict'
/**
 * v1.18 批次B：仓库健康度徽章（纯前端聚合 + 只标异常）
 *
 * 背景（2026-11-21 R10 排查）：AI 拉黑实测不合格（单文件真音源仓误伤 25.7%、三遍翻转），
 * 方案退回「规则标注 + 人工决定」。徽章只用本地已有的 deep 实测证据，不做任何推断。
 *
 * 本测试守住：
 *   ① 聚合口径：deprecated 不计入；deep.probeOnly 不计入；全 usable 才算健康
 *   ② 只标异常：健康仓 / 零条目仓必须返回空串（用户口径：不显示普遍结论）
 *   ③ 三档文案齐全：无可用音源 / 未实测 / （健康=不显示）
 *   ④ 徽章不接入任何自动判定：app.js 里徽章函数不得被 blockRepo/prune 相关代码调用
 *   ⑤ 徽章渲染在仓库行上（renderRepoList 内）
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }
const ROOT = path.join(__dirname, '..')
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')

function bodyOf(src, name) {
  const i = src.search(new RegExp('function\\s+' + name + '\\s*\\('))
  if (i < 0) return ''
  const start = src.indexOf('{', i)
  let d = 0
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') d++
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(start, j + 1) }
  }
  return ''
}

console.log('=== ① 聚合口径 ===')
{
  const agg = bodyOf(appSrc, 'buildRepoHealthIndex')
  ok(agg, 'buildRepoHealthIndex 存在')
  ok(!/if \(!e \|\| e\.deprecated\)/.test(agg) && !/e\.deprecated\) continue/.test(agg), 'deprecated 条目照常计入（聚合循环里没有跳过 deprecated）')
  ok(/probeOnly/.test(agg), 'probeOnly 的 deep 不计入（隔离区试跑产出不得参与判定）')
  ok(/st === 'usable'/.test(agg), '可用口径 = platforms 里 status==="usable"（与 checker.usableCount 一致）')
  ok(/normRepo\(e\.repo\)/.test(agg), '按归一化小写仓名聚合')
}

console.log('\n=== ② 只标异常 ===')
{
  const b = bodyOf(appSrc, 'repoHealthBadgeHtml')
  ok(b, 'repoHealthBadgeHtml 存在')
  ok(/if \(!s \|\| !s\.total\) return ''/.test(b), '零条目的仓不打标（没证据不打扰）')
  ok(/if \(s\.usable > 0\) return ''/.test(b), '健康仓不打标（不显示普遍结论）')
  ok(/无可用音源/.test(b), '死库档文案「无可用音源」')
  ok(/未实测/.test(b), '未测档文案「未实测」')
  ok(/仅供参考，不参与任何自动判定\/拉黑/.test(b), '死库档 tooltip 明示不参与自动判定')
  ok(/没测过≠坏了/.test(b), '未测档 tooltip 明示「没测过≠坏了」')
}

console.log('\n=== ③ 渲染接入 ===')
{
  const rl = bodyOf(appSrc, 'renderRepoList')
  ok(/buildRepoHealthIndex\(state\.sources\)/.test(rl), 'renderRepoList 从已加载的音源库聚合（零请求）')
  ok(/repoHealthBadgeHtml\(healthIdx, r\.repo\)/.test(rl), '徽章渲染在仓库行上')
  ok(/renderRepoList\(\)/.test(bodyOf(appSrc, 'loadSources')), 'loadSources 成功后补渲染（数据先到徽章才准）')
}

console.log('\n=== ④ 不接入自动判定 ===')
{
  // 徽章函数只应出现在定义处与 renderRepoList 内；blockRepo / prune / veto 相关代码不得引用
  const uses = [...appSrc.matchAll(/repoHealthBadgeHtml|buildRepoHealthIndex/g)].length
  ok(uses <= 5, '徽章/聚合函数引用次数 ≤5（仅定义+渲染两处，不被自动化链引用）got=' + uses)
  ok(!/blockRepo[\s\S]{0,200}repoHealth/.test(appSrc), '拉黑链不引用健康度徽章')
}

console.log('\n=== ⑤ 缓存戳 ===')
{
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
  ok(/app\.js\?v=103/.test(html), 'index.html 已 bump 到 app.js?v=103')
}

console.log('\nrepo-health-badge: PASS ' + pass + ' / FAIL 0')
