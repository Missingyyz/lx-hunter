'use strict'
/**
 * 突破项①冷启动语义预判针对性测试（隔离数据 / mock provider.chat，不联网、不碰真实 /data）。
 * 覆盖：①批量 one-shot 调用计数 ②各类失败降级 ③低价值只延后不删 ④产出字段不进判定链
 *       ⑤core/renderer 徽章与 tie-break 口径一致 ⑥输入超长主动控量不丢关键源。
 */
const provider = require('../src/core/aiProvider')
const { AIReview } = require('../src/core/aiReview')
const { classifyReposPure, tieRank, mergeClassFields } = require('../src/core/coldStart')
const Q = require('../src/core/quality')
const S = require('../src/renderer/sorters')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}

function makeStore(enabled, providerCfg) {
  return {
    db: {},
    config: { aiReview: Object.assign({ enabled }, providerCfg ? { provider: providerCfg } : {}) }
  }
}
const realProvider = { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }
const origChat = provider.chat
const mkItems = n => Array.from({ length: n }, (_, i) => ({ id: 'it' + i, name: '源' + i, description: '聚合音源 ' + i, topics: ['lx', 'music'] }))

async function main() {
  console.log('=== ① 批量 one-shot 调用计数（每批 1 次） ===')
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: JSON.stringify({ results: mkItems(5).map(x => ({ id: x.id, class: 'real', reason: '真源' })) }) } }
    const a = new AIReview(makeStore(true, realProvider))
    const r = await a.classifyColdStart(mkItems(5), 'source')
    ok('一批 5 条只调用 1 次 provider.chat', calls === 1, 'calls=' + calls)
    ok('5 条结果全部落回', Object.keys(r).length === 5)
  }

  console.log('=== ② 失败降级（enabled关/未配置/失败/限流/非JSON/非法class） ===')
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{}' } }
    const off = new AIReview(makeStore(false, realProvider))
    const rOff = await off.classifyColdStart(mkItems(3), 'source')
    ok('enabled=false 不调用、返回空（不预判）', calls === 0 && Object.keys(rOff).length === 0)
  }
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{}' } }
    const noCfg = new AIReview(makeStore(true, { baseUrl: '', model: '' }))
    const r = await noCfg.classifyColdStart(mkItems(3), 'source')
    ok('未配置 baseUrl/model 不调用、返回空', calls === 0 && Object.keys(r).length === 0)
  }
  {
    const cases = [
      ['ok:false（限流/网络）', async () => ({ ok: false, error: '429' })],
      ['抛异常', async () => { throw new Error('boom') }],
      ['非JSON文本', async () => ({ ok: true, text: 'not json at all' })],
      ['JSON无results', async () => ({ ok: true, text: '{"foo":1}' })]
    ]
    for (const [name, impl] of cases) {
      provider.chat = impl
      const a = new AIReview(makeStore(true, realProvider))
      let threw = false, r
      try { r = await a.classifyColdStart(mkItems(3), 'source') } catch (e) { threw = true }
      ok(name + ' → 静默降级为空、不抛', !threw && Object.keys(r).length === 0)
    }
    provider.chat = async () => ({ ok: true, text: JSON.stringify({ results: [{ id: 'it0', class: 'EVIL', reason: 'x' }] }) })
    const a = new AIReview(makeStore(true, realProvider))
    const r = await a.classifyColdStart(mkItems(1), 'source')
    ok('非法 class 降级为 uncertain（不误判 tool）', r.it0 && r.it0.class === 'uncertain', JSON.stringify(r))
  }

  console.log('=== ③ 低价值只延后不拉黑（阶段1仓库重排） ===')
  {
    const repos = ['a/real', 'b/tool', 'c/uncertain', 'd/real']
    const cls = { 'a/real': { class: 'real' }, 'b/tool': { class: 'tool' }, 'c/uncertain': { class: 'uncertain' }, 'd/real': { class: 'real' } }
    const ranked = classifyReposPure(repos, cls)
    ok('重排后元素一个不少（不删不拉黑）', ranked.length === repos.length && repos.every(r => ranked.includes(r)))
    ok('real 排最前、tool 排最后', ranked[0] === 'a/real' && ranked[ranked.length - 1] === 'b/tool', ranked.join(','))
    ok('uncertain 中立在中间', ranked.indexOf('c/uncertain') > ranked.indexOf('a/real') && ranked.indexOf('c/uncertain') < ranked.indexOf('b/tool'))
    ok('同 class 内稳定保序（a/real 在 d/real 前）', ranked.indexOf('a/real') < ranked.indexOf('d/real'))
    ok('空分类返回原序', JSON.stringify(classifyReposPure(repos, {})) === JSON.stringify(repos))
  }

  console.log('=== ④ 产出字段不进判定链（compareVerdict 只读既定维度） ===')
  {
    const mk = (id, cls) => ({ id, deep: { platforms: { wy: { status: 'usable' } }, metrics: { depth: 'full', samples: 3, p50LatencyMs: 300 } }, sourceAiClass: cls })
    const x = mk('x', 'tool'), y = mk('y', 'real')
    const before = Q.compareVerdict(x, y)
    const x2 = Object.assign({}, x); delete x2.sourceAiClass
    const y2 = Object.assign({}, y); delete y2.sourceAiClass
    const after = Q.compareVerdict(x2, y2)
    ok('compareVerdict 不受 sourceAiClass 影响', JSON.stringify(before) === JSON.stringify(after), JSON.stringify([before, after]))
    const merged = mergeClassFields({ id: 'a', name: 'A' }, { class: 'tool', reason: 'r' })
    ok('产出只含独立字段、无 act/verdict/usable', merged.sourceAiClass === 'tool' && merged.sourceAiReason === 'r' && !('act' in merged) && !('verdict' in merged) && !('usable' in merged))
  }

  console.log('=== ⑤ core/renderer 徽章与 tie-break 口径一致 ===')
  {
    const mkE = (id, cls) => ({ id, deep: { platforms: { wy: { status: 'usable' } }, metrics: { depth: 'full', samples: 3, p50LatencyMs: 300 } }, sourceAiClass: cls })
    ok('tie-break：real 排在 tool 前', Q.compareImportQuality(mkE('r', 'real'), mkE('t', 'tool')) < 0)
    ok('tie-break：uncertain 与无字段中立（相等）', Q.compareImportQuality(mkE('u', 'uncertain'), mkE('n', undefined)) === 0)
    ok('tieRank 方向与 core 一致', tieRank('real') < tieRank('uncertain') && tieRank('uncertain') < tieRank('tool'))
    ok('徽章 real=像是真源、tool=像是工具', /像是真源/.test(S.coldStartBadgeHtml({ sourceAiClass: 'real' })) && /像是工具/.test(S.coldStartBadgeHtml({ sourceAiClass: 'tool' })))
    ok('徽章 uncertain/无字段不出（不编造）', S.coldStartBadgeHtml({ sourceAiClass: 'uncertain' }) === '' && S.coldStartBadgeHtml({}) === '')
    ok('徽章理由无 HTML 标签注入', !/<script/i.test(S.coldStartBadgeHtml({ sourceAiClass: 'tool', sourceAiReason: '<script>x</script>' })))
    const p = [mkE('a', 'real'), mkE('b', 'tool')]
    ok('core/renderer sortKey 逐位一致（未破坏镜像）', p.every(e => JSON.stringify(S.qualitySortKey(e)) === JSON.stringify(Q.sortKey(e))))
  }

  console.log('=== ⑥ 输入超长主动控量（不截断关键源） ===')
  {
    const many = mkItems(200).map((x, i) => Object.assign(x, { description: '很长的描述'.repeat(80) + i }))
    const built = AIReview.buildColdStartInput(many, 11000)
    ok('输入控制在预算内（<12000）', built.text.length <= 12000, 'len=' + built.text.length)
    ok('控量后仍含头部源 id', built.text.includes('it0') && built.text.includes('it1'))
    ok('控量标记 truncated 正确', built.truncated === true && built.ids.length < many.length)
    ok('控量后 id 列表与实际文本一致', built.ids.every(id => built.text.includes(id)))
    const few = AIReview.buildColdStartInput(mkItems(5), 11000)
    ok('少量条目完整保留、不标 truncated', few.ids.length === 5 && few.truncated === false)
  }

  provider.chat = origChat
  console.log('\n' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS（' + pass + ' 项）'))
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); provider.chat = origChat; process.exit(1) })
