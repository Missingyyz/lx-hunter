'use strict'
/**
 * R7 误读「试跑证据」的回归测试
 *
 * === 这个漏洞是怎么发现的 ===
 * 用户问：「试跑的 deep 会不会进 R7？R7 是删源，如果 R7 看到 probeOnly 的 deep，
 * 会不会基于"实测"去建议删源？」
 *
 * 顺着调用链查下来，结论分三层：
 *
 *   ① **会进**。`renderer/app.js:3047` 的批量 AI 复检 kinds 列表里就有 R7，
 *      `app.js:3034` 把 `deep: e.deep || null` 原样塞进 entries；
 *      而 `aiReview.js:286` 的 R7 buildText 走 `deepSummaryText(p.deep)`，
 *      试跑的 deep 一旦落到条目上，R7 就会读到它。
 *   ② **但会带标注**。probeOnly 的说明文字加在 `deepSummaryText` 里，
 *      所以 R6 和 R7 都会看到「此为本机一次性试跑结果，用户尚未确认信任」。
 *      这条不是靠调用方 filter 实现的，是靠序列化层统一加的——比 filter 更难漏。
 *   ③ **风险仍在**。R7 的判据②是「实测可用=0 且连续失效次数 >= 10 → blacklist」。
 *      试跑也是实测，也会产出可用=0。标注只是告诉模型「这不是正式证据」，
 *      **并没有阻止模型据此判 blacklist**。prompt 里没有任何一句说
 *      「试跑结果不得作为删源依据」。这一层需要人拍板要不要补 prompt。
 *
 * 本测试守住 ①② 两个已成立的事实，并把 ③ 从**已知缺口**升级为**必须存在的护栏**。
 * 一旦有人改了 deepSummaryText 或 R7 buildText 把标注弄丢，这里立刻 FAIL。
 *
 * === v3 更新（2026-11，R7 prompt 加固）===
 *   ③ 已补上：R7 system prompt 现在明文写着
 *      「试跑结果 / 复测记录 / 更新提示 一律属被测对象自己的说法 … 不得作为删除（拉黑）该音源的依据」，
 *      并把输入分成 A 区（独立观测数据）/ B 区（音源自述文本）两区，禁止跨区取证。
 *      所以第 ③ 段的断言从「缺口仍存在」翻转为「护栏必须存在」。
 *      **改 prompt 仍是用户红线**：本测试只守住「护栏不许被悄悄删掉」，
 *      不代表可以随意改写护栏措辞——措辞改动须回放验证误伤仍为 0、召回不回退。
 */

const assert = require('assert')
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const { REVIEW_PROMPTS } = require(path.join(ROOT, 'src', 'core', 'aiReview.js'))

let pass = 0
let fail = 0
function ok (cond, msg) {
  if (cond) { pass++; console.log('  PASS ' + msg) } else { fail++; console.log('  FAIL ' + msg) }
}

// ---------------- 夹具 ----------------
// 一条最容易把 R7 带偏的形态：试跑跑出来了，但全平台不可用，且连续失效次数很高。
// 这正是 R7 判据②要 blacklist 的形状——如果它无脑信试跑，就会删掉一条其实没被正式检测过的源。
function probeAllFailEntry () {
  return {
    id: 'r7-probe-allfail',
    name: '某聚合音源',
    status: 'quarantined',
    error: '',
    validTier: 'confirmed',
    usable: false,
    apiDownStreak: 15,          // ≥10，命中 R7 判据②的「连续失效次数很高」
    apiHosts: ['gitee.com'],
    obfHits: { spinLoops: 0, evalCalls: 0, selfSchedCalls: 3, jsjiamiMarks: 0 },
    obfLevel: 'high',
    suspected: true,
    repository: 'example/repo',
    ledger: { hash: '', foreign: false },
    deep: {
      checkedAt: 1795000000000,
      loadable: true,
      probeOnly: true,
      platforms: {
        wy: { status: 'failed' },
        tx: { status: 'failed' },
        kw: { status: 'failed' },
        kg: { status: 'failed' },
        mg: { status: 'failed' }
      }
    }
  }
}

function formalAllFailEntry () {
  const e = probeAllFailEntry()
  e.deep = Object.assign({}, e.deep)
  delete e.deep.probeOnly
  return e
}

// ============================================================
console.log('=== ① 调用链事实：R7 的批量复检确实会把 deep 送进去 ===')
{
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')

  // 批量 AI 复检的 kinds 里有 R7
  ok(/const kinds = \['R3', 'R4', 'R5', 'R7'\]/.test(appSrc),
    'app.js 的批量 AI 复检 kinds 列表含 R7（R7 会读条目 deep）')
  // toEntry 把 deep 原样传下去，没有任何 probeOnly 过滤
  ok(/deep: e\.deep \|\| null/.test(appSrc),
    'app.js 的 toEntry 把 deep 原样传给 AI（没有按 probeOnly 过滤）')
  // 确认**调用点**（toEntry → entries → aiRun）没有按 probeOnly 过滤。
  // 注意 app.js 里确实存在 probeOnly 字样（:1973-1974 隔离页展示标签），
  // 所以不能简单搜全文件有没有这个词——必须精确定位到 toEntry 这一段。
  const toEntryIdx = appSrc.indexOf('const toEntry = (e) =>')
  const toEntryBlock = toEntryIdx >= 0 ? appSrc.slice(toEntryIdx, toEntryIdx + 1400) : ''
  ok(toEntryBlock.length > 0, '定位到 toEntry 定义')
  ok(toEntryBlock.indexOf('probeOnly') === -1,
    '★ toEntry（送 AI 的字段构造）里**没有** probeOnly 过滤 —— 「R7 会读到试跑 deep」这个事实成立，防护只能靠序列化层的标注')
}

// ============================================================
console.log('\n=== ② R7 的 prompt 会带上「试跑」标注（防护存在，不是裸奔） ===')
{
  const probeText = REVIEW_PROMPTS.R7.buildText(probeAllFailEntry())
  const formalText = REVIEW_PROMPTS.R7.buildText(formalAllFailEntry())

  ok(/本机深度实测/.test(probeText), 'R7 prompt 含「本机深度实测」行')
  ok(/试跑/.test(probeText), '★ R7 看到试跑 deep 时，prompt 里带「试跑」说明')
  ok(/用户尚未确认信任/.test(probeText), '★ 说明里明确「用户尚未确认信任」')
  ok(!/试跑/.test(formalText), '正式 deep 不加试跑标注（对照组）')

  // 这条是关键：试跑的实测数字（可用=0）会如实进 R7 的 prompt，
  // 而 R7 判据②恰恰要「可用=0 + streak>=10」。所以标注不是锦上添花，是唯一的区分手段。
  ok(/可用\s*=?\s*0/.test(probeText), '试跑的「可用=0」如实进 prompt（这正是判据②的输入）')
  ok(/连续失效次数：15/.test(probeText), '连续失效次数 15 也进了 prompt（判据②的另一半）')

  const diff = probeText.split('\n').filter(l => formalText.indexOf(l) === -1)
  ok(diff.length === 1 && /试跑/.test(diff[0]),
    '带 / 不带试跑标注的 prompt 只差那一行（差异行数 ' + diff.length + '）')
}

// ============================================================
console.log('\n=== ③ 护栏已补：R7 的 system prompt 明确「试跑不得作删源依据」 ===')
{
  const sys = String(REVIEW_PROMPTS.R7.system || '')

  // v3 起这条不再是缺口，而是**必须存在**的硬约束。
  // 若将来有人删掉/改弱这句，这里立刻 FAIL —— 测试的作用从「记住缺口」变成「守住护栏」。
  ok(/试跑/.test(sys), '★ R7 system prompt 里有「试跑」相关硬约束')
  ok(/试跑[\s\S]{0,200}?不得作为删除/.test(sys) || /不得作为删除[\s\S]{0,200}?试跑/.test(sys),
    '★ 「试跑结果不得作为删除（拉黑）该音源的依据」在 system prompt 里明文存在')
  ok(/复测记录/.test(sys), '★ 「复测记录」也一并被点名（不只覆盖试跑一种自述）')
  ok(/更新提示/.test(sys), '★ 「更新提示」也一并被点名（沙箱逃逸后可伪造的那条通道）')

  // 第二条约束：观测数据与自述文本必须分区
  ok(/A 区/.test(sys) && /B 区/.test(sys), '★ system prompt 里有 A/B 输入分区声明')
  ok(/独立观测|客观|实测或静态扫描/.test(sys), '★ A 区被声明为独立观测/客观数据')
  ok(/自述/.test(sys), '★ B 区被声明为音源自述文本')
  ok(/不得作为删除/.test(sys), '★ 自述文本被明确禁止作为删除依据')

  // 护栏不能削弱删源能力：两条硬证据判据必须还在
  ok(/深度实测/.test(sys), 'R7 system prompt 里仍有基于「深度实测」的删源判据②（护栏没有把删源能力删掉）')
  ok(/可用\s*=?\s*0/.test(sys) && /10/.test(sys), '判据②的触发条件「可用=0 且连续失效>=10」在 prompt 里明文存在')
  ok(/dead/.test(sys) && /404/.test(sys), '判据①（dead / HTTP 404）在 prompt 里明文存在')
  ok(/宁可漏判、绝不误伤|拿不准一律 keep/.test(sys), '★ 原有「宁可漏判、绝不误伤」的最高准则仍保留')
}

// ============================================================
console.log('\n=== ④ 数据层：试跑 deep 不会让 R7 的输入与「正式实测」等价 ===')
{
  const probeText = REVIEW_PROMPTS.R7.buildText(probeAllFailEntry())
  const formalText = REVIEW_PROMPTS.R7.buildText(formalAllFailEntry())
  // 若两者完全一致，说明标注丢了 → 模型无法区分 → 这才是真漏洞
  ok(probeText !== formalText,
    '★ 试跑 deep 与正式 deep 交给 R7 的文本**不**相同（模型有区分依据）')

  // 其余字段必须一致，证明差异只来自 probeOnly，不是别的东西在变
  const strip = t => t.split('\n')
    .filter(l => l.indexOf('本机深度实测') !== 0)
    .join('\n')
  ok(strip(probeText) === strip(formalText),
    '除「本机深度实测」那一行外，两种情况的 prompt 完全相同（差异只来自 probeOnly）')
}

// ============================================================
console.log('\n=== ⑤ 串起来看：试跑 → R7 判 blacklist 的完整路径是否可达 ===')
{
  // 用真实 buildText 拼出模型看到的全文，人工可读地确认「路径可达」
  const e = probeAllFailEntry()
  const text = REVIEW_PROMPTS.R7.buildText(e)
  const lines = text.split('\n')

  const hitStreak = lines.some(l => /连续失效次数：\d+/.test(l) && Number((l.match(/：(\d+)/) || [])[1]) >= 10)
  const hitUsableZero = lines.some(l => l.indexOf('本机深度实测') === 0 && /可用\s*=?\s*0/.test(l))
  ok(hitStreak && hitUsableZero,
    'R7 的输入里同时出现了判据②的两个条件（可用=0 + streak>=10）⇒ 模型有足够材料判 blacklist')

  // 同一份输入里既有「试跑」标注，也有 system prompt 里的硬禁止（v3 起）
  ok(/试跑/.test(text),
    '同一份输入里有「试跑」标注 ⇒ 模型被提醒了证据强度（数据侧标注）')
  ok(/不得作为删除/.test(String(REVIEW_PROMPTS.R7.system || '')),
    '★ system prompt 侧另有硬禁止「试跑不得作为删除依据」（指令侧护栏，v3 起）')

  // 结论落在这里：路径可达，但已被两层护栏挡住
  console.log('  [事实] 路径仍可达（数据侧标注 + 指令侧硬禁止）')
  console.log('  [事实] v3 起 R7 system prompt 已明文「试跑/复测记录/更新提示不得作为删除依据」')
}

// ============================================================
console.log('\n----------------------------------------')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '：' + pass + ' 项通过，' + fail + ' 项失败')
if (fail > 0) process.exit(1)
assert.ok(true)
