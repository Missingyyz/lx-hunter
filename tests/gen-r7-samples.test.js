'use strict'
/**
 * gen-r7-samples 生成器自测（用合成库快照，不依赖真实库）
 * 锁住：一个 hash 一条、选代表优先级、脱敏、annotation 诚实、能被 validateCase 接受。
 */
const path = require('path')
const fs = require('fs')
const assert = require('assert')
const ROOT = path.join(__dirname, '..')
const { genR7, scrubText, deepSummary, pickRepresentative } = require(path.join(ROOT, 'tests', 'tools', 'gen-r7-samples.js'))
const ec = require(path.join(ROOT, 'src', 'core', 'evalCases.js'))

let pass = 0; const fails = []
function ok (n, c, e) { if (c) { pass++; console.log('  PASS ' + n) } else { fails.push(n + (e ? ' -> ' + e : '')); console.log('  FAIL ' + n + (e ? ' -> ' + e : '')) } }

const mkEntry = (over) => Object.assign({
  id: 'x/' + Math.random().toString(36).slice(2, 8),
  name: '某源', scriptName: '某源', status: 'ok', error: null,
  repo: 'owner/repo', contentHash: 'h0', deprecated: false, dupReason: null,
  usable: false, lastCheck: 1000, addedAt: 1000,
  scriptVersion: '1.0.0', validTier: 'confirmed',
  obfLevel: 'none', obfHits: { evalCalls: 0, total0x: 0 }, obfDomains: [], apiHosts: [],
  deep: null
}, over)

const deepOf = (usable, total, at) => ({
  checkedAt: at || 1000,
  platforms: (() => {
    const p = {}
    for (let i = 0; i < total; i++) p['p' + i] = { status: i < usable ? 'usable' : 'failed' }
    return p
  })()
})

console.log('\n=== ① 一个 contentHash 只生成一条（核心铁律） ===')
;(() => {
  const raw = { sources: [
    mkEntry({ contentHash: 'A', deprecated: true, dupReason: '同内容重复', deep: deepOf(0, 5, 100) }),
    mkEntry({ contentHash: 'A', deprecated: true, dupReason: '同内容重复', deep: deepOf(2, 5, 200) }),
    mkEntry({ contentHash: 'A', deprecated: true, dupReason: '同内容重复', deep: deepOf(3, 5, 300) }),
    mkEntry({ contentHash: 'A', deprecated: false, deep: deepOf(0, 5, 400) })
  ] }
  const r = genR7(raw)
  ok('4 条同 hash → 只生成 1 条样本', r.cases.length === 1, 'got=' + r.cases.length)
  ok('记录了副本数 4', r.cases[0].copies === 4, String(r.cases[0].copies))
  ok('记录了深检结果种类 > 1', r.cases[0].deepVariants > 1, String(r.cases[0].deepVariants))
  ok('annotation.note 说明副本数与检测差异', /4 个副本/.test(r.cases[0].annotation.note || ''), r.cases[0].annotation.note)
})()

console.log('\n=== ② 选代表优先级：有深检 > 可用少 > 最新 ===')
;(() => {
  const g = [
    mkEntry({ id: 'noDeep', deep: null, lastCheck: 9999 }),
    mkEntry({ id: 'u3', deep: deepOf(3, 5, 100), lastCheck: 100 }),
    mkEntry({ id: 'u0', deep: deepOf(0, 5, 50), lastCheck: 50 })
  ]
  ok('有深检优先于无深检', pickRepresentative(g).id === 'u0' || pickRepresentative(g).id === 'u3')
  ok('可用平台少的优先（u0 < u3）', pickRepresentative(g).id === 'u0', pickRepresentative(g).id)
  const g2 = [mkEntry({ id: 'a', deep: deepOf(0, 5, 1), lastCheck: 100 }), mkEntry({ id: 'b', deep: deepOf(0, 5, 2), lastCheck: 200 })]
  ok('同可用数下 lastCheck 新的优先', pickRepresentative(g2).id === 'b', pickRepresentative(g2).id)
  const g3 = [mkEntry({ id: 'old', deep: null, lastCheck: 100 }), mkEntry({ id: 'new', deep: null, lastCheck: 999 })]
  ok('都没深检时按 lastCheck', pickRepresentative(g3).id === 'new')
})()

console.log('\n=== ③ 伪重复排除（hash 全库唯一） ===')
;(() => {
  // 组内只有 1 条且标了同内容重复 → 不满足前提
  const raw = { sources: [
    mkEntry({ contentHash: 'UNIQ', deprecated: true, dupReason: '同内容重复', deep: deepOf(0, 5) })
  ] }
  const r = genR7(raw)
  ok('单条同内容重复 → 排除，不生成', r.cases.length === 0, 'got=' + r.cases.length)
  ok('计入 pseudoDupExcluded', r.stats.pseudoDupExcluded === 1, String(r.stats.pseudoDupExcluded))
  ok('排除项记录了原因', r.excluded[0] && /伪重复/.test(r.excluded[0].reason))
})()

console.log('\n=== ④ 两个来源 + 重叠 ===')
;(() => {
  const raw = { sources: [
    // 纯重复（存活，有副本）
    mkEntry({ contentHash: 'D', deprecated: false, deep: deepOf(5, 5, 10) }),
    mkEntry({ contentHash: 'D', deprecated: true, dupReason: '同内容重复', deep: deepOf(5, 5, 10) }),
    // 纯失效（存活，0 可用）
    mkEntry({ contentHash: 'E', deprecated: false, deep: deepOf(0, 5, 20) }),
    // 重叠：既重复又失效
    mkEntry({ contentHash: 'B', deprecated: false, deep: deepOf(0, 5, 30) }),
    mkEntry({ contentHash: 'B', deprecated: true, dupReason: '同内容重复', deep: deepOf(0, 5, 30) }),
    // 无关
    mkEntry({ contentHash: 'Z', deprecated: false, deep: deepOf(5, 5, 40) })
  ] }
  const r = genR7(raw)
  ok('生成 3 条（D 重复 / E 失效 / B 重叠）', r.cases.length === 3, 'got=' + r.cases.length + ' ids=' + r.cases.map(c => c.contentHash).join(','))
  ok('groupsBoth=1（重叠只算一次）', r.stats.groupsBoth === 1, String(r.stats.groupsBoth))
  const b = r.cases.find(c => c.contentHash === 'B')
  ok('重叠组优先按 rule-dead 标注（更直接的规则依据）', b && b.annotation.annotator === 'rule-dead', b && b.annotation.annotator)
  const d = r.cases.find(c => c.contentHash === 'D')
  ok('纯重复组标 rule-dedup', d && d.annotation.annotator === 'rule-dedup', d && d.annotation.annotator)
  ok('全部 gold=blacklist', r.cases.every(c => c.goldAct === 'blacklist'))
  ok('全部 zone=HARD / danger=D1', r.cases.every(c => c.expected.zone === 'HARD' && c.expected.danger === 'D1'))
  ok('全部 blind=false', r.cases.every(c => c.annotation.blind === false))
})()

console.log('\n=== ⑤ 脱敏：域名/路径/邮箱/URL 一律替换 ===')
;(() => {
  ok('域名 → [HOST]', scrubText('访问 api.music-xxx.com 取链') === '访问 [HOST] 取链', scrubText('访问 api.music-xxx.com 取链'))
  ok('IPv4 → [HOST]', scrubText('连 175.27.166.236 的接口') === '连 [HOST] 的接口', scrubText('连 175.27.166.236 的接口'))
  ok('Windows 路径 → [PATH]', !/[A-Za-z]:\\/.test(scrubText('C:\\Users\\a\\secret.js')))
  ok('Unix 路径 → [PATH]', !/\/home\//.test(scrubText('/home/user/app/data.js')))
  ok('邮箱 → [EMAIL]', scrubText('联系 a@b.com') === '联系 [EMAIL]', scrubText('联系 a@b.com'))
  ok('完整 URL → [URL]', scrubText('见 https://raw.githubusercontent.com/x/y.js') === '见 [URL]', scrubText('见 https://raw.githubusercontent.com/x/y.js'))
  ok('tg 链接 → [URL]', scrubText('t.me/somechannel') === '[URL]', scrubText('t.me/somechannel'))

  const raw = { sources: [
    mkEntry({ contentHash: 'S', deprecated: false, deep: deepOf(0, 5),
      name: '某源', error: '请求 api.real-domain.com 失败',
      apiHosts: ['api.real-domain.com', '175.27.166.236'],
      obfDomains: ['cdn.example-real.net'] })
  ] }
  const r = genR7(raw)
  const s = JSON.stringify(r.cases[0].input)
  ok('生成的 input 不含真实域名', !/real-domain|example-real|175\.27\.166/.test(s), s.slice(0, 200))
  ok('生成的 input 含 [HOST] 占位', /\[HOST\]/.test(s))
})()

console.log('\n=== ⑥ deep 摘要口径（R7 prompt 按这个正则读） ===')
;(() => {
  ok('0 可用 5 平台', deepSummary(deepOf(0, 5)) === '平台数=5 可用=0 失败=5', deepSummary(deepOf(0, 5)))
  ok('3 可用', /平台数=5 可用=3/.test(deepSummary(deepOf(3, 5))), deepSummary(deepOf(3, 5)))
  ok('无深检返回空串', deepSummary(null) === '')
  ok('无 checkedAt 返回空串', deepSummary({ platforms: { a: { status: 'usable' } } }) === '')
  const dm = deepSummary(deepOf(2, 5)).match(/平台数\s*=?\s*(\d+)\s*可用\s*=?\s*(\d+)\s*失败\s*=?\s*(\d+)/)
  ok('能被 aiReview 的深层摘要正则匹配', !!dm && dm[1] === '5' && dm[2] === '2', deepSummary(deepOf(2, 5)))
})()

console.log('\n=== ⑦ 生成结果必须通过 validateCase / tryLoadCases ===')
;(() => {
  const raw = { sources: [
    mkEntry({ contentHash: 'V1', deprecated: false, deep: deepOf(0, 5) }),
    mkEntry({ contentHash: 'V2', deprecated: true, dupReason: '同内容重复', deep: deepOf(1, 5) }),
    mkEntry({ contentHash: 'V2', deprecated: false, deep: deepOf(1, 5) })
  ] }
  const r = genR7(raw)
  ok('生成 >=1 条', r.cases.length >= 1)
  for (const c of r.cases) {
    const err = ec.validateCase(c)
    ok('validateCase 通过: ' + c.id, err === null, String(err))
  }
  // 落盘 + tryLoadCases 实跑
  const tmpDir = path.join(ROOT, '_tmp_gen_test')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  const file = path.join(tmpDir, 'r7-library.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, note: 't', cases: r.cases }, null, 1))
  const loaded = ec.tryLoadCases(tmpDir)
  ok('tryLoadCases 无错误', loaded.error === '', loaded.error)
  ok('tryLoadCases 读回条数一致', loaded.cases.length === r.cases.length, loaded.cases.length + ' vs ' + r.cases.length)
  // 与既有样本合并后也能通过。基数从目录动态取（新增 r7-library.json 后不再是 234）。
  const baseCases = ec.loadCases(path.join(ROOT, 'tests', 'eval-cases'))
  const baseCount = baseCases.length - r.cases.filter(c => baseCases.some(b => b.id === c.id)).length
  const merged = baseCases.concat(loaded.cases)
  ok('合并后包含既有样本 + 新生成样本',
    merged.length === baseCount + r.cases.length, merged.length + ' vs ' + (baseCount + r.cases.length))
  ok('合并后每条都过校验', merged.every(c => ec.validateCase(c) === null))
  fs.rmSync(tmpDir, { recursive: true, force: true })
})()

console.log('\n=== ⑧ 边界：空库 / 无 hash / 异常输入 ===')
;(() => {
  ok('空数组不抛错', genR7([]).cases.length === 0)
  ok('sources 空对象不抛错', genR7({ sources: {} }).cases.length === 0)
  ok('无 hash 条目被跳过并计数', (() => { const r = genR7({ sources: [mkEntry({ contentHash: null })] }); return r.cases.length === 0 && r.stats.noHash === 1 })())
  ok('null 不抛错', (() => { try { genR7(null); return true } catch (e) { return false } })())
  ok('条目缺 deep 不抛错', (() => { const r = genR7({ sources: [mkEntry({ contentHash: 'N', deprecated: true, dupReason: '同内容重复', deep: undefined }), mkEntry({ contentHash: 'N' })] }); return r.cases.length === 1 })())
})()

console.log('\n=== ⑨ id 唯一性 ===')
;(() => {
  const arr = []
  for (let i = 0; i < 50; i++) arr.push(mkEntry({ contentHash: 'hash' + i, deprecated: false, deep: deepOf(0, 5) }))
  const r = genR7({ sources: arr })
  const ids = r.cases.map(c => c.id)
  ok('50 条样本 id 全唯一', new Set(ids).size === ids.length, ids.length + ' vs ' + new Set(ids).size)
  ok('id 带 r7b- 前缀便于识别来源', ids.every(i => /^r7b-/.test(i)))
})()

console.log('\n=== ⑩ zone 由证据决定：无深检不得标 HARD（否则污染 HARD 不干涉率） ===')
;(() => {
  const { zoneFor } = require(path.join(ROOT, 'tests', 'tools', 'gen-r7-samples.js'))
  ok('有深检（含 platforms）→ HARD', zoneFor(mkEntry({ deep: deepOf(0, 5) })) === 'HARD')
  ok('无 deep → GREY', zoneFor(mkEntry({ deep: null })) === 'GREY')
  ok('deep 无 checkedAt → GREY', zoneFor(mkEntry({ deep: { platforms: { a: { status: 'usable' } } } })) === 'GREY')
  ok('deep 有 checkedAt 但 platforms 空 → GREY', zoneFor(mkEntry({ deep: { checkedAt: 1, platforms: {} } })) === 'GREY')

  // 端到端：纯重复且无深检 → 必须 GREY
  const raw = { sources: [
    mkEntry({ contentHash: 'ND', deprecated: false, deep: null }),
    mkEntry({ contentHash: 'ND', deprecated: true, dupReason: '同内容重复', deep: null })
  ] }
  const r = genR7(raw)
  ok('纯重复无深检 → zone=GREY', r.cases[0].expected.zone === 'GREY', r.cases[0].expected.zone)
  ok('其 criteria 说明「无深检证据，故 zone=GREY」', /无深检证据/.test(r.cases[0].expected.criteria || ''), r.cases[0].expected.criteria)

  // 有深检的重复 → HARD
  const raw2 = { sources: [
    mkEntry({ contentHash: 'WD', deprecated: false, deep: deepOf(1, 5) }),
    mkEntry({ contentHash: 'WD', deprecated: true, dupReason: '同内容重复', deep: deepOf(1, 5) })
  ] }
  ok('有深检的重复 → zone=HARD', genR7(raw2).cases[0].expected.zone === 'HARD')

  // 失效源必然有深检 → 恒 HARD
  const raw3 = { sources: [mkEntry({ contentHash: 'DD', deprecated: false, deep: deepOf(0, 5) })] }
  ok('失效源（必带深检）→ HARD', genR7(raw3).cases[0].expected.zone === 'HARD')
})()

console.log('\n=== ⑪ 选代表不会选出空 deep（有深检副本时必须挑到） ===')
;(() => {
  const g = [
    mkEntry({ id: 'noDeep', deep: null, lastCheck: 99999 }),
    mkEntry({ id: 'deep1', deep: deepOf(1, 5, 5), lastCheck: 5 })
  ]
  ok('有深检的副本一定被选中（不会因 lastCheck 更新而选空 deep）', pickRepresentative(g).id === 'deep1', pickRepresentative(g).id)

  // 端到端：组内混有 空deep/1可用/2可用 → 应选 1 可用（少者优先）
  // 注意：必须有 deprecated + dupReason='同内容重复' 才算「同内容重复」来源，否则不进生成。
  const raw = { sources: [
    mkEntry({ contentHash: 'M', id: 'm1', deep: null, lastCheck: 900 }),
    mkEntry({ contentHash: 'M', id: 'm2', deep: deepOf(2, 5, 10), lastCheck: 10, deprecated: true, dupReason: '同内容重复' }),
    mkEntry({ contentHash: 'M', id: 'm3', deep: deepOf(1, 5, 20), lastCheck: 20, deprecated: true, dupReason: '同内容重复' })
  ] }
  const r = genR7(raw)
  ok('该组生成了 1 条', r.cases.length === 1, String(r.cases.length))
  ok('选可用少的（1 可用）', /可用=1/.test(r.cases[0].input.deep), r.cases[0].input.deep)
})()

console.log('\n=== ⑫ 生成稳定可复现（同一份库两次生成结果一致） ===')
;(() => {
  const raw = { sources: [
    mkEntry({ contentHash: 'S1', id: 'a', deep: deepOf(0, 5, 10) }),
    mkEntry({ contentHash: 'S1', id: 'b', deep: deepOf(0, 5, 10) }),
    mkEntry({ contentHash: 'S2', id: 'c', deep: deepOf(0, 5, 20) })
  ] }
  const a = genR7(raw, { now: 123 }).cases
  const b = genR7(raw, { now: 123 }).cases
  ok('两次生成 id 序列一致', a.map(x => x.id).join(',') === b.map(x => x.id).join(','))
  ok('两次生成内容一致', JSON.stringify(a) === JSON.stringify(b))
})()

console.log('\ngen-r7-samples: PASS ' + pass + ' / FAIL ' + fails.length)
if (fails.length) { console.log('失败项：\n  ' + fails.join('\n  ')); process.exit(1) }
