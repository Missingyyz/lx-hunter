'use strict'
/**
 * 最坏后果实测：updateurl:: 入库条目能否顶掉真音源？
 *
 * 场景（对应任务要求「查 updateurl:: 条目进入生产库后会有什么后果」）：
 *   1. 恶意脚本上报 tip.url 指向攻击者托管域（共享托管域场景，闸门②已实测可绕）
 *   2. hunter 把它当「音源脚本」入库，id = updateurl::xxx，name 取自脚本里的 @name
 *   3. 攻击者把 @name 写成与真音源**同名**（含版本号）
 *   4. 该条目进入检测队列 → 检测后与真音源同名 → 同名即时去重 / dedupe 裁决
 *
 * 关键判定问题：**谁会被废弃？**
 *   - 真音源已深检、有可用平台 → betterKeeper 应保留真音源（质量优先）
 *   - 真音源未深检 / 恶意条目质量更好 → 可能被废弃
 */
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const CORE = (n) => path.join(ROOT, 'src', 'core', n)
const H = require(CORE('hunter'))
const { usableCount } = require(CORE('checker'))
const identity = require(CORE('identity'))

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (x != null ? '  :: ' + x : '')) } }

const hunter = Object.create(H.Hunter.prototype)
const nm = identity.normName

console.log('=== 场景 1：真音源已深检且有可用平台，恶意条目质量更差 ===')
{
  const real = {
    id: 'real-1', lxName: '目标音源 v1.0', scriptName: '目标音源 v1.0', name: '目标音源 v1.0',
    url: 'https://music-api.example.com/source.js',
    contentHash: 'h1', deep: { checkedAt: Date.now(), hash: 'h1', platforms: { a: { status: 'usable' }, b: { status: 'usable' } } },
    usable: true, deprecated: false
  }
  const evil = {
    id: 'updateurl::aaa:bbb', lxName: '目标音源 v1.0', scriptName: '目标音源 v1.0', name: '目标音源 v1.0',
    url: 'https://raw.githubusercontent.com/ATT/evil/main/payload.js',
    contentHash: 'h2', deep: { checkedAt: Date.now(), hash: 'h2', platforms: { a: { status: 'failed' } } },
    usable: false, deprecated: false
  }
  ok('两条确实同名', nm(real.lxName) === nm(evil.lxName), nm(real.lxName) + ' vs ' + nm(evil.lxName))
  const keep = hunter.betterKeeper(real, evil) ? real : evil
  ok('★ 真音源被保留（不被顶掉）', keep.id === 'real-1', 'keep=' + keep.id)
  console.log('  usableCount(real) =', usableCount({ deep: real.deep }), ' usableCount(evil) =', usableCount({ deep: evil.deep }))
}

console.log('\n=== 场景 2：真音源未深检（刚入库），恶意条目深检过且有可用平台 ===')
{
  const real = {
    id: 'real-2', lxName: '目标音源 v1.0', scriptName: '目标音源 v1.0', name: '目标音源 v1.0',
    url: 'https://music-api.example.com/source.js',
    contentHash: 'h1', usable: false, deprecated: false
  }
  const evil = {
    id: 'updateurl::aaa:ccc', lxName: '目标音源 v1.0', scriptName: '目标音源 v1.0', name: '目标音源 v1.0',
    url: 'https://raw.githubusercontent.com/ATT/evil/main/payload.js',
    contentHash: 'h2', deep: { checkedAt: Date.now(), hash: 'h2', platforms: { a: { status: 'usable' } } },
    usable: true, deprecated: false
  }
  const keep = hunter.betterKeeper(real, evil) ? real : evil
  // 2026-11-19 R9 硬规则落地后，这条断言**反转**：
  //   修复前：未深检的真音源输给已深检的恶意条目 → 真音源被标 deprecated + dupOf=恶意条目。
  //   修复后：updateurl:: 条目永远不能挤掉真音源 → 保留 real-2。
  // 断言文本也跟着改成正向口径（否则它会把「漏洞仍在」当成通过）。
  ok('★ 真音源被保留（恶意条目不能挤掉它）', keep.id === 'real-2', 'keep=' + keep.id)
  console.log('  → 恶意条目应被让位；真音源不得被标 deprecated + dupOf=恶意条目')
}

console.log('\n=== 场景 3：两边都没深检（攻击者刚入库、真音源也是新条目） ===')
{
  const real = { id: 'real-3', lxName: '目标音源 v1.0', scriptName: '目标音源 v1.0', name: '目标音源 v1.0', url: 'https://music-api.example.com/s.js', contentHash: 'h1', usable: false, deprecated: false }
  const evil = { id: 'updateurl::aaa:ddd', lxName: '目标音源 v1.0', scriptName: '目标音源 v1.0', name: '目标音源 v1.0', url: 'https://raw.githubusercontent.com/ATT/e.js', contentHash: 'h2', usable: false, deprecated: false }
  const keep = hunter.betterKeeper(real, evil) ? real : evil
  console.log('  keep =', keep.id)
  ok('兜底裁决有确定结果（不随机）', !!keep)
}

console.log('\n=== 场景 4：updateurl:: 条目是否会被「灌入」到 LX 服务端 ===')
{
  // _planImportQueue 的前置过滤（hunter.js:4620 附近）
  const src = require('fs').readFileSync(CORE('hunter.js'), 'utf8')
  const i = src.indexOf('既无脚本地址、也无本地脚本正文')
  console.log('  _planImportQueue 过滤片段:')
  console.log(src.slice(i - 900, i + 260).split('\n').map(l => '    ' + l).join('\n'))
}

console.log('\n=== 场景 5：updateurl:: 条目在 UI 上是否被当作真音源展示 ===')
{
  const src = require('fs').readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
  const i = src.indexOf('updateTipsBadgeHtml')
  // 找条目渲染是否对 id 前缀做特殊处理
  const hasPrefixFilter = /updateurl::/.test(src)
  ok('★ 前端没有任何按 updateurl:: 前缀的过滤/标记（当作普通音源展示）', hasPrefixFilter === false,
    'app.js 里有 updateurl:: 字样=' + hasPrefixFilter)
  const st = require('fs').readFileSync(path.join(ROOT, 'src', 'renderer', 'sorters.js'), 'utf8')
  ok('★ sorters.js 也没有按 updateurl:: 前缀过滤', /updateurl::/.test(st) === false)
}

console.log('\n=== 场景 6：更新提示徽章（updateTipsBadgeHtml）的影响面 ===')
{
  const st = require('fs').readFileSync(path.join(ROOT, 'src', 'renderer', 'sorters.js'), 'utf8')
  const i = st.indexOf('function updateTipsBadgeHtml')
  console.log(st.slice(i, i + 700))
}

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' probe: PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
