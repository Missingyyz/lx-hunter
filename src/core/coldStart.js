'use strict'
/**
 * 冷启动语义预判的纯函数（突破项①）——无副作用、不碰 AI/store，供 Hunter 与单测共用。
 * 红线：这里的「排序」只调先后，不删不拉黑；产出只是独立分类字段，不进任何判定/act。
 */

/** class → 排序权重（小者靠前）：real 前、uncertain 中立、tool 后；未预判=中立。 */
function tieRank(cls) {
  return cls === 'real' ? -1 : cls === 'tool' ? 1 : 0
}

/**
 * 阶段1：按冷启动分类对仓库列表做稳定重排（只重排、不增删）。
 * @param {string[]} repos 原始仓库名
 * @param {object} clsMap { [repo]: {class, reason} }
 * @returns {string[]} 重排后的数组（元素与入参完全相同，仅顺序可能不同）
 */
function classifyReposPure(repos, clsMap) {
  const arr = Array.isArray(repos) ? repos.slice() : []
  if (arr.length < 2) return arr
  const m = clsMap && typeof clsMap === 'object' ? clsMap : {}
  const rank = r => tieRank(m[String(r)] && m[String(r)].class)
  return arr.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(x => x.r)
}

/**
 * 把一条预判结果合并成「独立字段」（只写 sourceAiClass/sourceAiReason，不碰任何业务字段）。
 * @returns {object} { sourceAiClass, sourceAiReason }
 */
function mergeClassFields(entry, classified) {
  const c = classified && classified.class
  const cls = c === 'real' || c === 'tool' ? c : 'uncertain'
  return { sourceAiClass: cls, sourceAiReason: String((classified && classified.reason) || '').slice(0, 120) }
}

module.exports = { tieRank, classifyReposPure, mergeClassFields }
