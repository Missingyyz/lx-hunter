'use strict'
/**
 * R4-R7 真实 executor —— **仅评测沙箱可用，生产构建不含本目录**。
 *
 * package.json build.files 只含 src 与 tests/eval-cases 两处；
 * Dockerfile 只 COPY src / tests/eval-cases ⇒ 生产镜像根本没有 tests/eval-lab/，
 * 这些 write 函数在生产代码层不存在（不是"靠开关关着"，是"根本没有")。
 *
 * 本文件由 tests/eval-lab/run.js 显式 require 并注入 AIReview.setExecutor()；
 * 生产 core 只留 sandboxOk() 门禁 + null 注入点。
 *
 * 安全底线（用户最高原则：精准不误伤）：
 *  - R7 服务端删除不可逆 ⇒ 永不接 adapter.remove；只删本地副本并标 serverDeleteSkipped。
 *  - 每条动作一个 audit，before/after 全深拷贝，undo 按 path 白名单写回。
 *  - R6 undo 用快照直写，不用 trust=false（后者会按规则重新隔离，可能与 before 不一致）。
 */

function deepClone (o) { return o == null ? o : JSON.parse(JSON.stringify(o)) }

/** R5 非音源判定 → 写特征库（复用 hunter._autoLearnBlockPattern 的同一口径：去重 + 上限 300） */
function r5BlockPattern (ctx) {
  const store = ctx.store
  if (!store) throw new Error('R5 executor 需要 store')
  const stem = String(ctx.stem || ctx.name || '').trim()
  if (!stem) throw new Error('R5 executor 需要 stem/name')
  const MAX = 300
  const before = deepClone(store.config.crawlerBlockPatterns || [])
  const after = before.slice()
  if (after.indexOf(stem) === -1 && after.length < MAX) after.push(stem)
  store.config.crawlerBlockPatterns = after
  store.saveConfig()
  return {
    targets: [{ path: 'config.crawlerBlockPatterns', before, after: deepClone(after) }],
    reversible: true, warnings: after.length >= MAX ? ['特征库已达上限 300，未新增'] : []
  }
}

/** R6 混淆信任放行 → 写 trustedObfHashes + 源状态（复用 hunter.trustObfSource 的写入口径） */
function r6Trust (ctx) {
  const store = ctx.store
  if (!store) throw new Error('R6 executor 需要 store')
  const id = String(ctx.entryId || ctx.id || '')
  if (!id) throw new Error('R6 executor 需要 entryId')
  const hash = String(ctx.contentHash || (store.db.sources[id] && store.db.sources[id].contentHash) || '')
  if (!hash) throw new Error('R6 executor 需要 contentHash（信任按内容指纹）')
  const trustBefore = deepClone(store.config.trustedObfHashes || [])
  const srcBefore = deepClone(store.db.sources[id] || null)
  const trustAfter = trustBefore.slice()
  if (trustAfter.indexOf(hash) === -1) trustAfter.push(hash)
  store.config.trustedObfHashes = trustAfter
  const e = store.db.sources[id] || {}
  e.obfTrusted = true
  e.quarantined = false
  e.status = 'ok'
  delete e.error
  e.usable = !!(e.deep && e.deep.checkedAt)
  store.db.sources[id] = e
  store.saveConfig(); store.saveDb()
  return {
    targets: [
      { path: 'config.trustedObfHashes', before: trustBefore, after: deepClone(trustAfter) },
      { path: 'db.sources.' + id, before: srcBefore, after: deepClone(e) }
    ],
    reversible: true, warnings: []
  }
}

/** R7 拉黑删源 —— 只删本地副本（db.sources/db.imported），**绝不调 adapter.remove**（服务端删除不可逆、undo 无法恢复）。 */
function r7DeleteLocal (ctx) {
  const store = ctx.store
  if (!store) throw new Error('R7 executor 需要 store')
  const id = String(ctx.entryId || ctx.id || '')
  if (!id) throw new Error('R7 executor 需要 entryId')
  const srcBefore = deepClone(store.db.sources[id] || null)
  const impBefore = deepClone(store.imported[id] || null)
  if (store.db.sources[id]) delete store.db.sources[id]
  if (store.imported[id]) delete store.imported[id]
  store.saveDb(); store.saveImported()
  return {
    targets: [
      { path: 'db.sources.' + id, before: srcBefore, after: null },
      { path: 'db.imported.' + id, before: impBefore, after: null }
    ],
    reversible: true, warnings: ['serverDeleteSkipped']  // 服务端原源未删，undo 可完整复活本地副本
  }
}

/** R4 追更提示：评测副本上定向合并 updateTips（不跑完整下载/沙箱/灌入管线，副作用外溢太大）。 */
function r4FollowTips (ctx) {
  const store = ctx.store
  if (!store) throw new Error('R4 executor 需要 store')
  const id = String(ctx.entryId || ctx.id || '')
  if (!id) throw new Error('R4 executor 需要 entryId')
  const srcBefore = deepClone(store.db.sources[id] || null)
  if (!srcBefore) throw new Error('R4 executor：源不存在 ' + id)
  const e = store.db.sources[id]
  e.updateTips = Array.isArray(ctx.updateTips) ? deepClone(ctx.updateTips) : deepClone(srcBefore.updateTips || [])
  if (ctx.updateUrl) e.updateUrl = String(ctx.updateUrl)
  store.db.sources[id] = e
  store.saveDb()
  return {
    targets: [{ path: 'db.sources.' + id, before: srcBefore, after: deepClone(e) }],
    reversible: true, warnings: ['followUpdatePipelineSkipped']  // 完整追更链路（下载/沙箱/灌入）不在评测执行器内
  }
}

module.exports = { r4FollowTips, r5BlockPattern, r6Trust, r7DeleteLocal }
