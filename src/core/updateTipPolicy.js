'use strict'
/**
 * 阶段A「规则追更设定」——纯规则判定 updateTip.msg 的追更价值。
 *
 * 设计约束（务必守住）：
 *  - **纯函数、零依赖、不接 AI**：只做正则匹配，不 require aiReview / 不调模型；
 *  - 只输出 'follow' | 'ignore' | 'gray' 三态，由调用方（hunter._followUpdateTips）按档位决定是否追；
 *  - 广告是弱信号：夹带实质词仍判 follow（先判实质，天然满足）；纯广告/催更才 ignore；
 *  - 「宁可漏判，绝不误判为 ignore」的反面在这里不适用——本函数是**过滤**用途：
 *    只有客观写明实质内容才 follow，纯版本号/无证据一律 gray（交给档位决定），
 *    拿不准不判 ignore 也不判 follow，判 gray 最安全。
 *
 * 判据参照 aiReview.js:237、309-317（R4 更新提示语义判断的既有准则），措辞一字对齐。
 */

// 实质更新词：明确修复具体故障 / 新功能健壮性改进 / 更换域名并说明原因
// 「服务器被屏蔽」属具体功能失效（请求过高致平台被屏蔽→更新修复），语义等价"修复服务器被屏蔽"
// （对齐 aiReview.js:309 的既有示例）；用完整短语而非泛泛的「屏蔽」，避免误伤"已屏蔽广告"之类话术。
const SUBSTANTIVE_RE = /修复|新功能|新增|恢复|改进|扩容|域名解析|换域名|假链|断路器|探测池|白名单校验|服务器被屏蔽/
// 纯催更模板：无实质内容、只是催你更新
const NUDGE_RE = /请尽快更新|有新版本|版本过低|点击(更新|下载)|加群|验证码|群号|svip音源更新/
// 纯广告/引流：弱信号（单独命中才 ignore；夹带实质词已被上面的 SUBSTANTIVE_RE 截为 follow）
const AD_RE = /广告|引流|推广|赞助|点击关注|扫码|二维码/

/**
 * 判定一条更新提示的追更价值。
 * @param {string} msg 更新提示全文（tip.msg）
 * @returns {'follow'|'ignore'|'gray'}
 *   follow = 写明实质修复/新功能/换域名原因 → 任何非 off 档都应追
 *   ignore = 无实质词且明确是纯催更模板/广告 → substantive 档不追
 *   gray   = 纯版本号 / 无证据 / 拿不准 → all 档追、substantive 档不追
 */
function shouldFollowUpdateTip (msg) {
  const text = String(msg == null ? '' : msg)
  if (!text.trim()) return 'gray'                    // 空提示＝无证据
  if (SUBSTANTIVE_RE.test(text)) return 'follow'     // 实质优先：夹带广告/催更也 follow
  if (NUDGE_RE.test(text) || AD_RE.test(text)) return 'ignore'
  return 'gray'                                      // 纯版本号 / 无实质描述 / 拿不准
}

module.exports = { shouldFollowUpdateTip, SUBSTANTIVE_RE, NUDGE_RE, AD_RE }
