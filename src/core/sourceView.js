'use strict'
/**
 * 列表接口的音源视图：剥掉脚本正文（`code`）。
 *
 * 为什么单独一层（2026-11-11 性能项 1）：
 *  - `/api/sources` 实测 14.3MB，其中 `code` 11.6MB = 81%。手机/弱网打开一次列表就下 14MB，
 *    NAS 上每次刷新也要序列化 + 传 11MB，列表首屏明显发卡。
 *  - 前端列表**一个字段都不用正文**：预览/导出/检测/灌入/撤回全在服务端按 `id` 取，
 *    renderer 里 grep `\.code` 零命中（只留在 `tests/external-source.test.js` 的采集断言里）。
 *  - 剥掉后 14.3MB → 2.7MB（实测），元信息（state/deep/obfHits/dupOf…）一个不丢。
 *
 * 注意：只用「列表」接口剥正文，`store` 内部、灌入/检测/导出一律拿完整条目。
 * 将来若前端真要显示正文，另开按 id 取单条正文的接口，别把 11MB 又塞回列表。
 */
const STRIP_FIELDS = ['code']

/**
 * v1.10.8：隔离区信任分级由**服务端算好随条目下发**（`qzLevel` / `qzReasons`）。
 *
 * 为什么不放在前端算：分级判据一旦进 renderer 就是第四份副本（前三份是 app.js 的 qzHardHits、
 * hunter.applyObfGate、hunter.trustObfSource，已漂移两轮）。renderer 是纯浏览器脚本没有 require，
 * 拿不到 checker 的纯函数，只能把规则抄一遍。放这里则 Web 版 / Electron 版、前端 / 后端全部同一份。
 *
 * @param {object} src 完整条目
 * @param {object} cfg 配置（classifyQuarantineTrust 只用 trustedObfDomains）
 */
function quarantineTrustView(src, cfg) {
  const out = {}
  // 只对隔离相关条目算（其余条目前端不显示按钮，白算 4000 条浪费 CPU）
  if (!src || (!src.quarantined && src.status !== 'quarantined')) return out
  try {
    const { classifyQuarantineTrust } = require('./checker')
    const cls = classifyQuarantineTrust(src, cfg)
    out.qzLevel = cls.level
    out.qzReasons = cls.reasons
  } catch (e) {
    // 分级只是 UI 提示，算不出来不能让整个列表接口 500——退化成最短确认路径
    out.qzLevel = 'risky'
    out.qzReasons = []
  }
  return out
}

function publicSourceView(src, cfg) {
  if (!src || typeof src !== 'object') return src
  const out = Object.assign({}, src)
  for (const k of STRIP_FIELDS) delete out[k]
  return Object.assign(out, quarantineTrustView(src, cfg))
}

function publicSourceList(list, cfg) {
  const arr = Array.isArray(list) ? list : []
  return arr.map(s => publicSourceView(s, cfg))
}

module.exports = { publicSourceView, publicSourceList, quarantineTrustView, STRIP_FIELDS }
