'use strict'
/**
 * AI 批量分类「批级重试」针对性测试（mock provider.chat，不联网、不碰真实 /data）。
 *
 * 背景（真实 8197 容器实测 37 条 tips、连跑 3 轮）：
 *   第1轮 25/37 err=fetch failed；第2轮 37/37 err=fetch failed；第3轮 25/37 err=请求超时。
 *   对照单条调用 6/6 全成功（各约 3 秒）→ 中转站正常，是"4 批连跑 45-50 秒期间必断一批"。
 *   修复前 aiProvider.chat 无任何重试 → 断一批 = 丢该批 12 条。
 *
 * 覆盖：①第2批首次失败、重试成功 → 37 条全回、成功批只调 1 次
 *       ②某批重试 2 次仍失败 → 放弃该批、其它批正常、不抛、统计正确
 *       ③重试次数与退避间隔符合设计（800 → 1600+抖动，最多 2 次）
 *       ④429/限流 → 不重试（直接放弃，避免加剧限流）
 *       ⑤总时长预算超限 → 不再重试后续失败批
 *       ⑥非网络层错误（未知/解析问题）→ 不重试
 */
const provider = require('../src/core/aiProvider')
const { AIReview } = require('../src/core/aiReview')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}
function makeStore(enabled) {
  const prov = { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' }
  return { db: {}, config: { aiReview: { enabled, provider: prov } } }
}
const origChat = provider.chat
const mkTips = n => Array.from({ length: n }, (_, i) => ({ id: 'u' + i, name: '源' + i, tips: ['发现新版本 v1.0.' + i + ' 修复DNS解析'] }))
// 从 user 正文取该批 id 列表
const idsOf = messages => {
  const usr = String((messages && messages[1] && messages[1].content) || '')
  return usr.split('\n').filter(l => /^[\w-]+/.test(l) && l.indexOf('|') >= 0).map(l => l.split('|')[0].trim())
}
const echoOk = messages => ({ ok: true, text: JSON.stringify({ results: idsOf(messages).map(id => ({ id, substantive: 'true', reason: 'ok' })) }) })

async function main() {
  // ------------------------------------------------------------ ① 第2批首次失败、重试成功
  console.log('=== ① 第 2 批首次失败、重试成功 → 37 条全回、成功批只调 1 次 ===')
  {
    const callsPerBatch = {}   // 每批首 id → 调用次数
    let failedOnce = false
    provider.chat = async (p, messages) => {
      const ids = idsOf(messages)
      const key = ids[0]
      callsPerBatch[key] = (callsPerBatch[key] || 0) + 1
      if (key === 'u12' && !failedOnce) { failedOnce = true; return { ok: false, error: 'AI 请求失败：fetch failed' } }
      return echoOk(messages)
    }
    const a = new AIReview(makeStore(true))
    a._sleep = () => Promise.resolve()   // 退避另有测试，这里只看逻辑
    const r = await a.classifyUpdateTips(mkTips(37), { withStats: true })
    ok('最终 37 条全部返回（失败批被重试救回）', Object.keys(r.map).length === 37, 'got=' + Object.keys(r.map).length)
    ok('成功的批只调 1 次（不重跑成功批）',
      callsPerBatch['u0'] === 1 && callsPerBatch['u24'] === 1 && callsPerBatch['u36'] === 1,
      JSON.stringify(callsPerBatch))
    ok('失败批调了 2 次（首轮+1 次重试）', callsPerBatch['u12'] === 2, JSON.stringify(callsPerBatch))
    ok('stats 随返回值传出：重试 1 次、救回 1 批、0 放弃', r.stats.retries === 1 && r.stats.retriedOk === 1 && r.stats.dropped === 0, JSON.stringify(r.stats))
    ok('无放弃时 lastError 不是"放弃"语义', !/放弃/.test(String(a.lastError || '')), String(a.lastError))
  }

  // ------------------------------------------------------------ ② 重试 2 次仍失败 → 放弃该批
  console.log('=== ② 某批重试 2 次仍失败 → 放弃该批、其它批正常、不抛 ===')
  {
    const callsPerBatch = {}
    provider.chat = async (p, messages) => {
      const ids = idsOf(messages)
      const key = ids[0]
      callsPerBatch[key] = (callsPerBatch[key] || 0) + 1
      if (key === 'u12') return { ok: false, error: 'AI 请求失败：请求超时' }   // 恒失败
      return echoOk(messages)
    }
    const a = new AIReview(makeStore(true))
    a._sleep = () => Promise.resolve()
    let threw = false, r
    try { r = await a.classifyUpdateTips(mkTips(37), { withStats: true }) } catch (e) { threw = true }
    ok('函数不抛（失败批只丢自己）', !threw)
    ok('放弃批 12 条缺失、其余 25 条照常', !!r && Object.keys(r.map).length === 25 && !r.map['u12'] && !!r.map['u0'] && !!r.map['u24'], r && 'got=' + Object.keys(r.map).length)
    ok('失败批共调 3 次（首轮 + 2 次重试，即 3 次机会）', callsPerBatch['u12'] === 3, JSON.stringify(callsPerBatch))
    ok('其它批各只调 1 次', callsPerBatch['u0'] === 1 && callsPerBatch['u24'] === 1, JSON.stringify(callsPerBatch))
    ok('stats 随返回值传出：1 批放弃、12 条、重试 2 次', r.stats.dropped === 1 && r.stats.droppedIds === 12 && r.stats.retries === 2, JSON.stringify(r.stats))
    ok('lastError 体现"重试后放弃"', /重试后放弃/.test(String(a.lastError || '')), String(a.lastError))
  }

  // ------------------------------------------------------------ ③ 次数与退避间隔
  console.log('=== ③ 重试次数与退避间隔符合设计 ===')
  {
    const sleeps = []
    provider.chat = async () => ({ ok: false, error: 'AI 请求失败：请求超时' })
    const a = new AIReview(makeStore(true))
    a._sleep = ms => { sleeps.push(ms); return Promise.resolve() }
    a._rand = () => 0          // 去掉抖动，看纯退避基数
    const r = await a.classifyUpdateTips(mkTips(2), { withStats: true })   // 单批、恒失败
    ok('单批最多 3 次调用（1+2 重试）', r.stats.calls === 3, 'calls=' + r.stats.calls)
    ok('只睡了 2 次（重试之间），间隔为 800、1600', sleeps.length === 2 && sleeps[0] === 800 && sleeps[1] === 1600, JSON.stringify(sleeps))
    ok('失败后返回空、不抛', r && Object.keys(r.map).length === 0)
  }
  {
    // 抖动存在且在 0-299 区间
    const sleeps = []
    provider.chat = async () => ({ ok: false, error: 'AI 请求失败：请求超时' })
    const a = new AIReview(makeStore(true))
    a._sleep = ms => { sleeps.push(ms); return Promise.resolve() }
    a._rand = () => 0.5
    await a.classifyUpdateTips(mkTips(2))
    ok('退避带随机抖动（800+150=950、1600+150=1750）', sleeps[0] === 950 && sleeps[1] === 1750, JSON.stringify(sleeps))
  }
  {
    // 默认真的走 setTimeout 但不能真等 —— 用极小 backoffBase 验证实现路径
    const t0 = Date.now()
    provider.chat = async () => ({ ok: false, error: 'AI 请求失败：请求超时' })
    const a = new AIReview(makeStore(true))
    a._rand = () => 0
    await a._classifyInBatches(mkTips(2), c => ({ text: c.map(x => x.id + ' | 提示=' + x.tips[0]).join('\n') }),
      () => 'sys', j => ({}), { backoffBase: 1 })
    const el = Date.now() - t0
    ok('真实 sleep 路径可用（1ms 基数两次退避后完成）', el < 500, 'elapsed=' + el)
  }

  // ------------------------------------------------------------ ④ 429/限流 → 不重试
  console.log('=== ④ 429/限流：不重试、直接放弃（避免加剧限流） ===')
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: false, error: 'AI 中转站返回非 2xx（429）' } }
    const a = new AIReview(makeStore(true))
    a._sleep = () => { throw new Error('429 不该重试、不该睡') }
    const r = await a.classifyUpdateTips(mkTips(2), { withStats: true })
    ok('429 只调 1 次（不重试）', calls === 1, 'calls=' + calls)
    ok('429 未进入重试（未睡）', r.stats.retries === 0, JSON.stringify(r.stats))
    ok('429 计入 throttled、该批放弃', r.stats.throttled === 1 && r.stats.dropped === 1, JSON.stringify(r.stats))
    ok('429 不抛、返回空 map', r && Object.keys(r.map).length === 0)
  }
  {
    // 多种限流文案都能识别为 throttle（不重试）
    const cases = [
      'AI 中转站返回非 2xx（429）',
      'AI 请求失败：429 Too Many Requests',
      'AI 请求失败：rate limit exceeded',
      'AI 请求失败：触发限流',
      'AI 请求失败：quota exceeded'
    ]
    let allSingle = true
    const detail = []
    for (const msg of cases) {
      let calls = 0
      provider.chat = async () => { calls++; return { ok: false, error: msg } }
      const a = new AIReview(makeStore(true))
      a._sleep = () => Promise.resolve()
      await a.classifyUpdateTips(mkTips(2))
      detail.push(calls)
      if (calls !== 1) allSingle = false
    }
    ok('各类 429/限流文案均不重试（各 1 次）', allSingle, JSON.stringify(detail))
  }
  {
    // 5xx 属网络层 → 可重试
    let calls = 0
    provider.chat = async () => { calls++; return { ok: false, error: 'AI 中转站返回非 2xx（502）' } }
    const a = new AIReview(makeStore(true))
    a._sleep = () => Promise.resolve()
    await a.classifyUpdateTips(mkTips(2))
    ok('502（服务端临时错）可重试 → 共 3 次', calls === 3, 'calls=' + calls)
  }

  // ------------------------------------------------------------ ⑤ 总时长预算
  console.log('=== ⑤ 总时长预算：超限后不再重试后续失败批 ===')
  {
    let calls = 0
    let fakeNow = 0
    provider.chat = async () => { calls++; return { ok: false, error: 'AI 请求失败：请求超时' } }
    const a = new AIReview(makeStore(true))
    a._sleep = ms => { fakeNow += ms; return Promise.resolve() }
    a._now = () => fakeNow
    // 每批首轮后时间就远超预算 → 后续批次不再重试
    let st = null
    await a._classifyInBatches(mkTips(24), c => ({ text: c.map(x => x.id + ' | 提示=' + x.tips[0]).join('\n') }),
      () => 'sys', () => ({}), { backoffBase: 100000, totalBudgetMs: 1000 }).then(res => { st = res.stats })
    ok('超预算后不再重试（总调用数远小于 3×批数）', calls < 6, 'calls=' + calls)
    ok('统计标记 giveUpByBudget > 0', st && st.giveUpByBudget > 0, JSON.stringify(st))
    ok('超预算不会无限重试（每批最多 3 次机会的上界仍成立）', calls <= 6, 'calls=' + calls)
  }
  {
    // 预算充足时正常重试（对照）
    let calls = 0
    provider.chat = async () => { calls++; return { ok: false, error: 'AI 请求失败：请求超时' } }
    const a = new AIReview(makeStore(true))
    a._sleep = () => Promise.resolve()
    await a._classifyInBatches(mkTips(2), c => ({ text: c.map(x => x.id + ' | t').join('\n') }),
      () => 'sys', () => ({}), { totalBudgetMs: 180000 })
    ok('预算充足 → 单批完整 3 次机会', calls === 3, 'calls=' + calls)
  }

  // ------------------------------------------------------------ ⑥ 非网络层错误不重试
  console.log('=== ⑥ 非网络层错误（未知原因）不重试 ===')
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: false, error: '某个奇怪错误' } }
    const a = new AIReview(makeStore(true))
    a._sleep = () => { throw new Error('不该重试') }
    const r6 = await a.classifyUpdateTips(mkTips(2), { withStats: true })
    ok('未知错误只调 1 次（不猛冲）', calls === 1, 'calls=' + calls)
    ok('未知错误计入放弃', r6.stats.dropped === 1 && r6.stats.retries === 0, JSON.stringify(r6.stats))
  }

  // ------------------------------------------------------------ ⑦ stats 随返回值传递（并发不互相覆盖）
  console.log('=== ⑦ stats 随返回值传递：两 worker 并发不互相覆盖 ===')
  {
    // 造两个"慢/快"不同的场景，让两个 _classifyInBatches 真正并发
    let n = 0
    provider.chat = async (p, messages) => {
      const ids = idsOf(messages)
      // 第 1 个任务（含 id 'a*'）每批失败 1 次后成功；第 2 个（含 id 'b*'）全失败
      const isA = ids[0] && ids[0][0] === 'a'
      if (isA) {
        n++
        if (n === 1) return { ok: false, error: 'AI 请求失败：fetch failed' }
        return echoOk(messages)
      }
      return { ok: false, error: 'AI 请求失败：请求超时' }
    }
    const a = new AIReview(makeStore(true))
    a._sleep = () => new Promise(r => setTimeout(r, 5))   // 真异步，制造交错
    const tipsA = [{ id: 'a0', name: 'A', tips: ['修复DNS解析'] }]
    const tipsB = [{ id: 'b0', name: 'B', tips: ['修复链路'] }]
    const [rA, rB] = await Promise.all([
      a.classifyUpdateTips(tipsA, { withStats: true }),
      a.classifyUpdateTips(tipsB, { withStats: true })
    ])
    ok('两 worker 并发各自拿到自己的 stats（A：重试 1 次救回 1 批）', rA.stats && rA.stats.retriedOk === 1 && rA.stats.dropped === 0, JSON.stringify(rA.stats))
    ok('两 worker 并发各自拿到自己的 stats（B：0 重试成功、1 批放弃）', rB.stats && rB.stats.retriedOk === 0 && rB.stats.dropped === 1, JSON.stringify(rB.stats))
    ok('两份 stats 互不覆盖（不像实例属性那样只剩最后一份）', !!rA.stats && !!rB.stats && JSON.stringify(rA.stats) !== JSON.stringify(rB.stats))
    ok('实例上不再有 lastBatchStats 属性', !('lastBatchStats' in a))
  }

  // ------------------------------------------------------------ ⑧ 错误分类正则收紧（C 建议 2）
  console.log('=== ⑧ 错误分类边界收紧 ===')
  {
    const C = AIReview.classifyBatchError
    // quota 词边界：quotation 不再误判成 throttle
    ok('`quotation 校验失败` 不再判 throttle（归 other）', C({ error: 'quotation 校验失败' }) === 'other', C({ error: 'quotation 校验失败' }))
    ok('`quota exceeded` 仍判 throttle（词边界不误伤真限流）', C({ error: 'quota exceeded' }) === 'throttle', C({ error: 'quota exceeded' }))
    ok('`insufficient quota` 仍判 throttle', C({ error: 'insufficient quota' }) === 'throttle', C({ error: 'insufficient quota' }))
    ok('`配额已用完` 仍判 throttle', C({ error: '配额已用完' }) === 'throttle', C({ error: '配额已用完' }))
    // socket 收紧：非网络语义的 socket 不再白重试
    ok('`socket连接但账号未配置` 不再判 transient（归 other）', C({ error: 'socket连接但账号未配置' }) === 'other', C({ error: 'socket连接但账号未配置' }))
    ok('`socket hang up` 仍判 transient', C({ error: 'AI 请求失败：socket hang up' }) === 'transient', C({ error: 'socket hang up' }))
    ok('`socket error` 仍判 transient', C({ error: 'socket error' }) === 'transient', C({ error: 'socket error' }))
    ok('`socket closed` 仍判 transient', C({ error: 'socket closed' }) === 'transient', C({ error: 'socket closed' }))
    ok('`socket.timeout` 仍判 transient', C({ error: 'socket.timeout' }) === 'transient', C({ error: 'socket.timeout' }))
    // 原有 transient 用例一个不能漏
    const mustTransient = ['AI 请求失败：请求超时', 'timeout', 'AI 请求失败：fetch failed', 'connect ECONNREFUSED 127.0.0.1:7890', 'ETIMEDOUT', 'EAI_AGAIN', 'AI 中转站返回非 2xx（503）', 'AI 中转站返回非 2xx（502）', 'AI 中转站响应不是合法 JSON', 'AI 中转站返回内容为空', 'network error']
    const miss = mustTransient.filter(m => C({ error: m }) !== 'transient')
    ok('原 transient 用例 11/11 仍归 transient（收紧未漏）', miss.length === 0, JSON.stringify(miss))
    // 原有 throttle / other 用例
    const mustThrottle = ['AI 中转站返回非 2xx（429）', '429 Too Many Requests', 'rate limit exceeded', '触发限流']
    ok('原 throttle 用例 4/4 仍正确', mustThrottle.every(m => C({ error: m }) === 'throttle'), JSON.stringify(mustThrottle.filter(m => C({ error: m }) !== 'throttle')))
    const mustOther = ['AI provider 未配置 baseUrl', 'AI provider 未配置 model', 'AI 中转站返回非 2xx（401）', 'AI 中转站返回非 2xx（400）', '运行时无可用 fetch', '未知失败']
    const missOther = mustOther.filter(m => C({ error: m }) !== 'other')
    ok('原 other 用例 6/6 仍归 other', missOther.length === 0, JSON.stringify(missOther))
  }
  {
    // 行为层面：quotation 失败不重试（只调 1 次）、socket 精确匹配后 hang up 仍重试
    let calls = 0
    provider.chat = async () => { calls++; return { ok: false, error: 'quotation 校验失败' } }
    const a = new AIReview(makeStore(true))
    a._sleep = () => { throw new Error('quotation 不该重试') }
    const r = await a.classifyUpdateTips(mkTips(2), { withStats: true })
    ok('quotation 失败：只调 1 次、0 重试', calls === 1 && r.stats.retries === 0, 'calls=' + calls + ' ' + JSON.stringify(r.stats))
  }
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: false, error: 'socket连接但账号未配置' } }
    const a = new AIReview(makeStore(true))
    a._sleep = () => { throw new Error('不该重试') }
    const r = await a.classifyUpdateTips(mkTips(2), { withStats: true })
    ok('socket 非连接级错误：只调 1 次、0 重试（不再白重试 2 次）', calls === 1 && r.stats.retries === 0, 'calls=' + calls + ' ' + JSON.stringify(r.stats))
  }
  {
    let calls = 0
    provider.chat = async () => { calls++; return { ok: false, error: 'AI 请求失败：socket hang up' } }
    const a = new AIReview(makeStore(true))
    a._sleep = () => Promise.resolve()
    const r = await a.classifyUpdateTips(mkTips(2), { withStats: true })
    ok('socket hang up：仍重试到 3 次机会', calls === 3 && r.stats.retries === 2, 'calls=' + calls + ' ' + JSON.stringify(r.stats))
  }

  provider.chat = origChat
  console.log('\n' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS（' + pass + ' 项）'))
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); provider.chat = origChat; process.exit(1) })
