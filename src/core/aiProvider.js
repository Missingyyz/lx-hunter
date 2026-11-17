'use strict'
/**
 * AI provider —— 最小 OpenAI 兼容客户端（v1.14.0，零第三方 SDK）。
 *
 * 设计约束（方案共识）：
 *  - 不引 SDK，只用 Node 全局 fetch + AbortController，保仓库零运行时依赖。
 *  - 完全开放：baseUrl / model / 额外 headers 全部来自用户配置，任何实现
 *    POST {baseUrl}/chat/completions 的中转站都能接（DeepSeek / 智谱 / Kimi / 自建）。
 *  - 三态失败静默降级：非 2xx / 非 JSON / 超时或网络错，一律返回 {ok:false, error}
 *    由调用方忽略，绝不抛到主链路。
 *  - 不接收任何凭据类配置去拼 prompt；apiKey 只用于鉴权头，不进正文。
 *
 * 依赖注入：fetchImpl 参数便于测试桩掉（签名同全局 fetch）。
 */

const DEFAULT_TIMEOUT = 20000

function joinUrl(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) return ''
  // 用户可能直接把完整 endpoints 填进来，兼容三种写法：
  //   https://host/v1            -> https://host/v1/chat/completions
  //   https://host/v1/           -> 同上
  //   https://host/v1/chat/completions -> 原样
  if (/\/chat\/completions$/.test(b)) return b
  return b + '/chat/completions'
}

function buildHeaders(provider) {
  const h = Object.assign({}, provider.headers || {})
  if (provider.apiKey) h['Authorization'] = 'Bearer ' + provider.apiKey
  if (!Object.keys(h).some(k => k.toLowerCase() === 'content-type')) {
    h['Content-Type'] = 'application/json'
  }
  return h
}

/**
 * 发一次 chat completion 请求。
 * @param {object} provider  {baseUrl, apiKey, model, headers, timeoutMs}
 * @param {string|Array} messages  传给 messages 字段（调用方负责拼 system/user）
 * @param {object} opts {fetchImpl, signal}
 * @returns {Promise<{ok:boolean, text?:string, raw?:object, error?:string}>}
 */
async function chat(provider, messages, opts) {
  opts = opts || {}
  const p = provider || {}
  const url = joinUrl(p.baseUrl)
  if (!url) return { ok: false, error: 'AI provider 未配置 baseUrl' }
  if (!p.model) return { ok: false, error: 'AI provider 未配置 model' }
  const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages == null ? '' : messages) }]
  const body = JSON.stringify({ model: p.model, messages: msgs, temperature: 0, stream: false })
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) return { ok: false, error: '运行时无可用 fetch' }

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timeoutMs = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : DEFAULT_TIMEOUT
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const resp = await doFetch(url, {
      method: 'POST',
      headers: buildHeaders(p),
      body,
      signal: ctrl ? ctrl.signal : undefined
    })
    if (!resp || !resp.ok) {
      const code = resp && resp.status ? resp.status : '无响应'
      return { ok: false, error: 'AI 中转站返回非 2xx（' + code + '）' }
    }
    let data
    try { data = await resp.json() } catch (e) { return { ok: false, error: 'AI 中转站响应不是合法 JSON' } }
    const text = data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'AI 中转站返回内容为空' }
    return { ok: true, text: text.trim(), raw: data }
  } catch (e) {
    const msg = String((e && e.name === 'AbortError') ? '请求超时' : ((e && e.message) || e))
    return { ok: false, error: 'AI 请求失败：' + msg.slice(0, 120) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

module.exports = { chat, joinUrl, buildHeaders }
