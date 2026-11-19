'use strict'
/**
 * R7 prompt 护栏：试跑/沙箱结果不得单独作为删源依据
 *
 * ============================================================================
 * 这个漏洞是怎么来的
 * ============================================================================
 * R7 是「删源」判定（不可逆高危）。而「本机深度实测」有两种来源：
 *   ① 正式深度实测 —— 本地程序在真实环境跑的观测值
 *   ② 试跑（隔离区「试跑一次」）—— 跑在与真实运行环境**不同**的沙箱里：
 *      网络出口受限、请求超时更短、部分平台接口在沙箱里根本连不上、权限受限。
 * 于是「试跑失败」极可能是**沙箱限制**造成的，而不是音源真的坏了。
 * 若把试跑失败当成删源依据，就是把「环境差异」误判成「音源失效」——
 * 删源不可逆，误删一个好源没法恢复。
 *
 * 数据侧早就有「这是试跑」的标注（deepSummaryText 的 probeOnly 标注），
 * 但**标注 ≠ 禁止**：模型看得见「这是试跑」，却仍可能被「可用=0 + streak>=10」
 * 判据②带偏。所以必须在 **system prompt（指令侧）**明文禁止。
 *
 * 本测试锁住：
 *   ① system prompt 里有这条硬约束（且措辞点明「沙箱环境与真实运行环境不同」）
 *   ② 原有删源判据**没被删掉**（护栏不是把 R7 变成哑巴）
 *   ③ 「拿不准一律 keep」的最高准则仍在
 *   ④ R4/R5/R6 的 prompt **一个字都没动**（不扩大范围）
 *   ⑤ updateTips / msg 的处理逻辑**没动**（那是另一条已确认风险，只报告不修）
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const AI = path.join(ROOT, 'src', 'core', 'aiReview.js')
const { REVIEW_PROMPTS } = require(AI)

let pass = 0
let fail = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; fails.push(name + (extra ? '  :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')) }
}

const sys = String(REVIEW_PROMPTS.R7.system || '')

// ============================================================================
console.log('\n=== ① 指令侧硬约束：试跑/沙箱结果不得单独作为删源依据 ===')
// ============================================================================
{
  ok('R7 system 里出现了「试跑」相关硬约束', /试跑/.test(sys))
  ok('★ 明文出现「不得单独作为删源依据」（或等价措辞）',
    /试跑\/沙箱结果不得单独作为删源依据/.test(sys) ||
    /试跑[^。\n]{0,30}不得[^。\n]{0,20}作为[^。\n]{0,20}删源依据/.test(sys),
    sys.slice(0, 400))
  ok('★ 措辞点明「沙箱 与 真实运行环境 不同」（护栏的理由写进去了）',
    /沙箱[^。\n]{0,40}(真实运行环境|真实环境)[^。\n]{0,20}不同/.test(sys),
    (sys.match(/试跑\/沙箱结果[^\n]*/) || [''])[0])
  ok('★ 措辞点明「试跑失败可能只是沙箱限制」',
    /沙箱限制/.test(sys), (sys.match(/试跑\/沙箱结果[^\n]*/) || [''])[0])
  ok('★ 措辞点明「不可逆 / 误删无法恢复」（给出下禁令的理由）',
    /不可逆/.test(sys) && /误删/.test(sys),
    (sys.match(/试跑\/沙箱结果[^\n]*/) || [''])[0])
  ok('★ 明确「只有与运行环境无关的硬失效证据才可删源」',
    /只有[^。\n]{0,40}dead\/HTTP 404[^。\n]{0,40}才可删源/.test(sys),
    (sys.match(/试跑\/沙箱结果[^\n]*/) || [''])[0])
}

// ============================================================================
console.log('\n=== ② 护栏没有把 R7 变成哑巴：原判据仍在 ===')
// ============================================================================
{
  ok('判据①（dead / HTTP 404）仍在', /状态为 dead \/ HTTP 404/.test(sys))
  ok('判据②（可用=0 + 连续失效≥10）仍在',
    /平台数>0 但可用=0/.test(sys) && /≥10次/.test(sys))
  ok('「可用>=1 一律 keep」仍在', /可用>=1/.test(sys))
  ok('「拿不准一律 keep」的最高准则仍在', /拿不准一律 keep/.test(sys))
  ok('「宁可漏判、绝不误伤」仍在', /宁可漏判、绝不误伤/.test(sys))
  ok('verdict 枚举没变', REVIEW_PROMPTS.R7.verdicts.join(',') === 'blacklist,keep')
  ok('prompt 版本已 bump（v4，护栏生效的标记）', REVIEW_PROMPTS.R7.version === 'v4',
    'version=' + REVIEW_PROMPTS.R7.version)
}

// ============================================================================
console.log('\n=== ③ 数据侧标注仍在（护栏是双保险，不是取代） ===')
// ============================================================================
{
  const probeEntry = {
    id: 'p', name: 'n', status: 'quarantined', usable: false, apiDownStreak: 15,
    apiHosts: ['gitee.com'], deep: {
      checkedAt: 1795000000000, loadable: true, probeOnly: true,
      platforms: { wy: { status: 'failed' }, tx: { status: 'failed' }, kw: { status: 'failed' } }
    }
  }
  const txt = REVIEW_PROMPTS.R7.buildText(probeEntry)
  ok('试跑 deep 的 buildText 里带「试跑」标注', /试跑/.test(txt))
  ok('标注点明「用户尚未确认信任」', /用户尚未确认信任/.test(txt))
  ok('标注点明「不得作为删除依据」', /不得作为删除依据/.test(txt))
}

// ============================================================================
console.log('\n=== ④ 范围没扩大：R4/R5/R6 的 prompt 一个字没动 ===')
// ============================================================================
{
  // R4/R5/R6 不含任何「试跑/沙箱」相关的新约束（本次只改 R7）
  for (const k of ['R4', 'R5', 'R6']) {
    const s = String(REVIEW_PROMPTS[k].system || '')
    ok(k + ' 的 prompt 里没有引入「沙箱结果不得作为删源依据」这类新约束',
      !/沙箱结果不得/.test(s) && !/不得单独作为删源依据/.test(s))
  }
  // R4 的更新提示语义（本次明确不动）
  ok('R4 的 updateTips 语义提示仍在（本次只报告不修）',
    /仅输出一个 JSON/.test(REVIEW_PROMPTS.R4.system) && /follow/.test(REVIEW_PROMPTS.R4.system))
}

// ============================================================================
console.log('\n=== ⑤ updateTips / msg 的处理逻辑没动（只报告不修） ===')
// ============================================================================
{
  const src = fs.readFileSync(AI, 'utf8')
  // updateTips 的 AI 旁路分类（classifyUpdateTips）仍在原处
  ok('classifyUpdateTips 仍存在（updateTips 的 AI 语义分级没被本次改动碰）',
    /classifyUpdateTips/.test(src))
  ok('R7 的 buildText 里没有新增 updateTips 字段（本次不扩范围）',
    !/updateTips/.test(REVIEW_PROMPTS.R7.buildText({ name: 'x' })))
  // 本次改动只在 R7 的 system 里加了一行护栏
  ok('R7 system 里出现护栏的次数恰好 1（没有重复插入）',
    (sys.match(/试跑\/沙箱结果不得单独作为删源依据/g) || []).length === 1)
}

console.log('\n' + (fail ? '✗' : '✓') + ' r7-sandbox-guard: PASS ' + pass + ' / FAIL ' + fail)
if (fail) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
process.exit(0)
