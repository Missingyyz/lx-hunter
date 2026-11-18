'use strict'
/**
 * 突破项② R4 更新说明语义分级针对性测试（隔离数据 / mock provider.chat，不联网、不碰真实 /data）。
 * 判据（C 订正）：判「有无实质修复/新功能」，不是「见广告就剔」。
 * 覆盖：①批量5条只调1次 ②enabled关/未配置/失败/非JSON/非法class全降级
 *       ③7条含广告但实质修复的源绝不误判为纯广告剔除（eval真实文案）
 *       ④纯催更/广告判false ⑤纯版本播报判uncertain ⑥产出字段不进判定链 ⑦core/renderer徽章/tie-break一致
 */
const provider = require('../src/core/aiProvider')
const { AIReview } = require('../src/core/aiReview')
const Q = require('../src/core/quality')
const S = require('../src/renderer/sorters')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}
function makeStore(enabled, providerCfg) {
  return { db: {}, config: { aiReview: Object.assign({ enabled }, providerCfg ? { provider: providerCfg } : {}) } }
}
const realProvider = { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }
const origChat = provider.chat
const mkItems = n => Array.from({ length: n }, (_, i) => ({ id: 't' + i, name: '源' + i, tips: ['发现新版本 v1.0.1'] }))

// eval 真实文案（tests/eval-cases/r4-r7.labeled.json）
const AD_WITH_SUBSTANCE = [
  '发现新版本 v3.2.19\n更换域名修复部分地区 DNS 解析错误问题\n📱 G1联通双月卡29元220G+100分钟【发全国】➠ h[URL]',
  '更换域名修复部分地区 DNS 解析错误问题\n📱 G1联通双月卡29元220G+100分钟【发全国】➠ h[URL]',
  '更换域名修复部分地区 DNS 解析错误问题',
  '恢复kg',
  '豆包定制[聚合音源] v1.9 更新说明：· v1.9 健壮性大版本：断路器区分确定性/瞬时错误、源URL域名白名单校验'
]
const PURE_AD = '版本更新\n版本: v27\n更新URL: [URL]\n切记，莫对人言\n验证码获取：c.wwwweb.top\n群：329970458'
const PURE_NUDGE = '发现新版本 v1.3.0\n更新内容: 长青svip音源更新，请尽快更新！\n请更新后使用'
const VERSION_ONLY = ['发现新版本 v1.1.2', '当前源脚本版本过低(v4)，请下载最新版本(v7)', '有新版本啦，点击更新即可～']

async function main() {
  console.log('=== ① 批量 one-shot 调用计数（每批 1 次） ===')
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: JSON.stringify({ results: mkItems(5).map(x => ({ id: x.id, substantive: 'true', reason: '实质' })) }) } }
    const a = new AIReview(makeStore(true, realProvider))
    const r = await a.classifyUpdateTips(mkItems(5))
    ok('一批 5 条只调用 1 次 provider.chat', calls === 1, 'calls=' + calls)
    ok('5 条结果全部落回', Object.keys(r).length === 5)
  }

  console.log('=== ② 失败降级（enabled关/未配置/失败/非JSON/非法class） ===')
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{}' } }
    const off = new AIReview(makeStore(false, realProvider))
    const r = await off.classifyUpdateTips(mkItems(3))
    ok('enabled=false 不调用、返回空（不预判）', calls === 0 && Object.keys(r).length === 0)
  }
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: true, text: '{}' } }
    const noCfg = new AIReview(makeStore(true, { baseUrl: '', model: '' }))
    const r = await noCfg.classifyUpdateTips(mkItems(3))
    ok('未配置 baseUrl/model 不调用、返回空', calls === 0 && Object.keys(r).length === 0)
  }
  {
    const cases = [
      ['ok:false（限流/网络）', async () => ({ ok: false, error: '429' })],
      ['抛异常', async () => { throw new Error('boom') }],
      ['非JSON文本', async () => ({ ok: true, text: 'not json' })],
      ['JSON无results', async () => ({ ok: true, text: '{"foo":1}' })]
    ]
    for (const [name, impl] of cases) {
      provider.chat = impl
      const a = new AIReview(makeStore(true, realProvider))
      let threw = false, r
      try { r = await a.classifyUpdateTips(mkItems(3)) } catch (e) { threw = true }
      ok(name + ' → 静默降级为空、不抛', !threw && Object.keys(r).length === 0)
    }
    // 非法 class 一律 uncertain（不误判为 false=纯广告剔除）
    provider.chat = async () => ({ ok: true, text: JSON.stringify({ results: [{ id: 't0', substantive: 'EVIL', reason: 'x' }, { id: 't1', substantive: null }] }) })
    const a = new AIReview(makeStore(true, realProvider))
    const r = await a.classifyUpdateTips(mkItems(2))
    ok('非法/缺失 substantive 降级为 uncertain（不误判为纯广告）', r.t0 && r.t0.substantive === 'uncertain' && r.t1 && r.t1.substantive === 'uncertain', JSON.stringify(r))
  }

  console.log('=== ③ 含广告但实质修复的源「绝不误判为纯广告剔除」 ===')
  {
    // 模拟模型正确行为：实质修复（含广告）→ true；同类被判 uncertain 也算安全；关键绝不落 false
    provider.chat = async (p, msgs) => {
      const usr = msgs[1].content
      // 简单规则桩：含"修复/恢复/更新说明"→true；纯广告→false；其余版本播报→uncertain
      const results = []
      const ids = (usr.match(/^t\d+/gm) || [])
      for (const id of ids) {
        const line = usr.split('\n').find(l => l.startsWith(id)) || ''
        let sub = 'uncertain'
        if (/修复|恢复|更新说明|白名单|断路器/.test(line)) sub = 'true'
        else if (/验证码|群：|套餐外链/.test(line)) sub = 'false'
        results.push({ id, substantive: sub, reason: '桩' })
      }
      return { ok: true, text: JSON.stringify({ results }) }
    }
    const items = AD_WITH_SUBSTANCE.map((t, i) => ({ id: 't' + i, name: '源' + i, tips: [t] }))
    const a = new AIReview(makeStore(true, realProvider))
    const r = await a.classifyUpdateTips(items)
    // 核心断言：这 5 条都不应被判 false（误杀）。允许 true 或 uncertain。
    const misjudged = items.filter(it => r[it.id] && r[it.id].substantive === false)
    ok('5 条含广告但实质修复的源，判 false（误杀）的条数 = 0', misjudged.length === 0, '误杀: ' + misjudged.map(x => x.id).join(','))
    ok('其中含"修复DNS/恢复kg/更新说明"的明确判 true', items.filter((it, i) => /修复|恢复|更新说明|白名单|断路器/.test(it.tips[0]) && r[it.id] && r[it.id].substantive === true).length >= 3)
    // 落字段层：true/false/uncertain 都可能，但绝不因"夹带广告"被强制 false
    const hasAd = AD_WITH_SUBSTANCE.filter(t => /套餐外链|联通双月卡/.test(t)).length
    ok('含广告外链的实质源无一被判 false', AD_WITH_SUBSTANCE.map((t, i) => ({ t, i })).filter(x => /联通双月卡/.test(x.t)).every(x => r['t' + x.i].substantive !== false), 'adCount=' + hasAd)
  }

  console.log('=== ④ 纯催更/纯广告判 false ===')
  {
    provider.chat = async (p, msgs) => {
      const results = [
        { id: 'ad', substantive: 'false', reason: '验证码群号纯广告无修复' },
        { id: 'nudge', substantive: 'false', reason: '泛泛催更无实质' }
      ]
      return { ok: true, text: JSON.stringify({ results }) }
    }
    const a = new AIReview(makeStore(true, realProvider))
    const r = await a.classifyUpdateTips([{ id: 'ad', tips: [PURE_AD] }, { id: 'nudge', tips: [PURE_NUDGE] }])
    ok('纯广告(验证码群号)判 false', r.ad && r.ad.substantive === false)
    ok('纯催更(长青svip请尽快更新)判 false', r.nudge && r.nudge.substantive === false)
  }

  console.log('=== ⑤ 纯版本播报判 uncertain（不交 AI 单独定夺） ===')
  {
    provider.chat = async (p, msgs) => {
      const results = VERSION_ONLY.map((t, i) => ({ id: 'v' + i, substantive: 'uncertain', reason: '仅版本号/灰区' }))
      return { ok: true, text: JSON.stringify({ results }) }
    }
    const a = new AIReview(makeStore(true, realProvider))
    const items = VERSION_ONLY.map((t, i) => ({ id: 'v' + i, tips: [t] }))
    const r = await a.classifyUpdateTips(items)
    ok('纯版本号/版本过低/点击更新 全部 uncertain', items.every(it => r[it.id] && r[it.id].substantive === 'uncertain'))
    // uncertain 不出徽章、不改 tie-break（见 ⑦）
  }

  console.log('=== ⑥ 产出字段不进判定链（compareVerdict 只读既定维度） ===')
  {
    const mk = (id, cls) => ({ id, deep: { platforms: { wy: { status: 'usable' } }, metrics: { depth: 'full', samples: 3, p50LatencyMs: 300 } }, updateTipsAiClass: cls })
    const x = mk('x', false), y = mk('y', true)
    const before = Q.compareVerdict(x, y)
    const x2 = Object.assign({}, x); delete x2.updateTipsAiClass
    const y2 = Object.assign({}, y); delete y2.updateTipsAiClass
    ok('compareVerdict 不受 updateTipsAiClass 影响', JSON.stringify(before) === JSON.stringify(Q.compareVerdict(x2, y2)), JSON.stringify([before, Q.compareVerdict(x2, y2)]))
    // 字段只是独立键，不含 act/verdict
    const e = { id: 'a', updateTipsAiClass: false, updateTipsAiReason: '广告' }
    ok('产出字段名独立（updateTipsAiClass/updateTipsAiReason）', e.updateTipsAiClass === false && e.updateTipsAiReason === '广告' && !('act' in e) && !('verdict' in e))
  }

  console.log('=== ⑦ core/renderer 徽章与 tie-break 一致 ===')
  {
    const mkE = (id, sub) => ({ id, deep: { platforms: { wy: { status: 'usable' } }, metrics: { depth: 'full', samples: 3, p50LatencyMs: 300 } }, updateTipsAiClass: sub })
    ok('tie-break：实质更新(true) 排在纯催更(false) 前', Q.compareImportQuality(mkE('t', true), mkE('f', false)) < 0)
    ok('tie-break：uncertain 与无字段中立（相等）', Q.compareImportQuality(mkE('u', 'uncertain'), mkE('n', undefined)) === 0)
    ok('徽章 有实际更新=true、像是催更=false', /有实际更新/.test(S.updateTipsBadgeHtml({ updateTipsAiClass: true })) && /像是催更/.test(S.updateTipsBadgeHtml({ updateTipsAiClass: false })))
    ok('徽章 uncertain/无字段不出（不编造）', S.updateTipsBadgeHtml({ updateTipsAiClass: 'uncertain' }) === '' && S.updateTipsBadgeHtml({}) === '')
    ok('徽章理由无 HTML 标签注入', !/<script/i.test(S.updateTipsBadgeHtml({ updateTipsAiClass: false, updateTipsAiReason: '<script>x</script>' })))
    const p = [mkE('a', true), mkE('b', false)]
    ok('core/renderer sortKey 逐位一致（未破坏镜像）', p.every(e => JSON.stringify(S.qualitySortKey(e)) === JSON.stringify(Q.sortKey(e))))
    // 输入超长控量
    const many = Array.from({ length: 200 }, (_, i) => ({ id: 'm' + i, name: '源', tips: ['很长的更新说明'.repeat(120) + i] }))
    const built = AIReview.buildUpdateTipsInput(many, 11000)
    ok('输入超长主动控量 <12000 且保留头部', built.text.length <= 12000 && built.text.includes('m0'), 'len=' + built.text.length)
    ok('控量 truncated 标记正确', built.truncated === true && built.ids.length < many.length)
  }

  provider.chat = origChat
  console.log('\n' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS（' + pass + ' 项）'))
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); provider.chat = origChat; process.exit(1) })
