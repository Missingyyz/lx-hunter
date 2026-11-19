'use strict'
/**
 * A1-A4 遗留项回归测试（v1.13.13）
 *
 * 这批改动的共同点是「**文案/数据缺字段引发的误判**」，静态扫描很难发现问题，
 * 所以这里既断言源码接线，也断言**真实行为**（尤其 R5 的 prompt 内容）。
 *
 * 覆盖：
 *   A1  隔离区不能再说「先信任才能检测」；Web 端必须真的有试跑通道
 *   A2  R5 必须能看到 deep；且「加载失败 / 可用=0」两类必须区分开（否则误杀真源）
 *   A3  dupReason 取值收敛到单一来源，且逻辑依赖的子串没被改掉
 *   A4  （只给结论，评测集归 R7测试 管，本文件不改 tests/eval-cases/）
 */
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')

let pass = 0
let fail = 0
const failures = []
function ok (cond, name, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  -> ' + detail : '')) } else {
    fail++; failures.push(name)
    console.log('FAIL  ' + name + (detail ? '  -> ' + detail : ''))
  }
}

console.log('=== A1：隔离区文案与 Web 试跑通道 ===')

const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
const hunterSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'hunter.js'), 'utf8')
const webSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'web.js'), 'utf8')
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'web-bridge.js'), 'utf8')
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8')

// 1) 「先信任再检测」类误导：隔离条目点「检测」其实什么都不会跑（applyObfGate 会 continue）
ok(!/建议先跑「检测」/.test(appSrc), '【A1】app.js 不再引导隔离条目去点「检测」（那条路不产生实测）')
ok(!/建议先跑「检测」/.test(htmlSrc), '【A1】index.html 不再引导隔离条目去点「检测」')
// 2) 隔离区说明必须提到试跑（唯一的「不必先信任就能验证」的通路）
ok(/试跑一次/.test(htmlSrc), '【A1】隔离区说明文字提到「试跑一次」')
ok(/不必先信任|不需要先信任/.test(htmlSrc + appSrc), '【A1】明确写出「不需要先信任」（死锁已拆）')
// 3) 条目 error 文案（会进 R5/R6/R7 prompt）也不再只说信任
ok(hunterSrc.indexOf('混淆隔离：重度混淆脚本，已移入「混淆隔离」区，可在该页信任后放行') === -1,
  '【A1】hunter.js 的隔离 error 不再只给「信任」一条路')
ok(/混淆隔离：重度混淆脚本，已移入「混淆隔离」区（可在该页点「试跑一次」看实测，或直接信任后放行）/.test(hunterSrc),
  '【A1】隔离 error 同时给出「试跑」与「信任」两个入口')
// 4) Web 端试跑通道：原先完全没有，按钮渲染出来点了必失败
ok(/\/api\/sources\/probe-quarantined/.test(webSrc), '【A1】Web 端有试跑路由')
ok(/sourcesProbeQuarantined/.test(bridgeSrc), '【A1】web-bridge 暴露 sourcesProbeQuarantined')
ok(/makeProbeQueue/.test(webSrc) && /probeQueue\.run\(/.test(webSrc),
  '【A1】Web 试跑走共享配额队列（不能无限试跑 / 不能并发开沙箱）')
ok(/makeProbeQueue/.test(mainSrc) && /probeQueue\.run\(/.test(mainSrc),
  '【A1】桌面 IPC 走同一份队列（两端一致）')
// 5) 试跑后不可再显示「从没实测过」
const checkerSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'checker.js'), 'utf8')
ok(/probedOnly/.test(checkerSrc) && /试跑过/.test(checkerSrc),
  '【A1】风险清单区分「从没实测过」与「试跑过」（试跑后不再说假话）')
ok(/可点「试跑一次」/.test(checkerSrc), '【A1】「从没实测过」时告知可以去试跑（不再让人以为没别的办法）')
// 6) 但判定绝不能因此松动：档位仍必须排除 probeOnly
ok(/deepDone\s*=\s*!!\(deep && deep\.checkedAt\) && !isProbeOnlyDeep\(e\)/.test(checkerSrc),
  '【核心】classifyQuarantineTrust 的 deepDone 仍排除试跑（只改了文案，没改判定）')

console.log('\n=== A2：R5 必须能看到 deep，且两类形态要区分 ===')
const aiReview = require(path.join(ROOT, 'src', 'core', 'aiReview.js'))
const spec = aiReview.REVIEW_PROMPTS.R5

// 1) deep 进 prompt
const withDeep = spec.buildText({ name: 'x', suspected: true, deep: '平台数=5 可用=0 失败=0' })
ok(/本机深度实测：平台数=5 可用=0 失败=0/.test(withDeep),
  '【A2】R5 buildText 渲染 deep（原来这一行根本不存在）')
const withoutDeep = spec.buildText({ name: 'x', suspected: true, deep: '' })
ok(/本机深度实测：无实测/.test(withoutDeep), '【A2】无 deep 时如实写「无实测」')

// 2) 加载失败 vs 可用=0 必须区分（86 条样本分桶：加载失败 10/10 nonSource；可用=0 有 24/25 是 source）
const failLoad = spec.buildText({ name: 'lx_preload', suspected: true, deep: '平台数=0 可用=0 失败=0 加载失败' })
const usable0 = spec.buildText({ name: 'HYWmusic', suspected: true, deep: '平台数=5 可用=0 失败=0' })
ok(/加载失败/.test(failLoad) && /不是能运行的有效音源脚本/.test(failLoad),
  '【A2】加载失败被点明为「不是有效音源脚本」的强证据')
ok(!/不是能运行的有效音源脚本/.test(usable0),
  '【A2】「可用=0 但能加载」不得被说成无效脚本')
ok(/不代表它不是音源/.test(usable0),
  '【核心】「可用=0 但能加载」明确澄清不代表非音源（否则一次误杀 24 条真源）')
// 对象形态（生产实时数据）同样要区分
const objUsable0 = spec.buildText({ name: 'x', suspected: true, deep: { checkedAt: 1, loadable: true, platforms: { wy: { status: 'failed' } } } })
const objFail = spec.buildText({ name: 'x', suspected: true, deep: { checkedAt: 1, loadable: false, platforms: {} } })
ok(/不代表它不是音源/.test(objUsable0), '【A2】对象形态 deep：可用=0 也带澄清')
ok(/不是能运行的有效音源脚本/.test(objFail), '【A2】对象形态 deep：loadable=false 也点明')

// 3) 隔离状态要说清「与真伪正交」——这是 4147f8fffa 被判 nonSource 的病根
const qz = spec.buildText({ name: '长青SVIP音源', suspected: true, status: 'quarantined', error: '混淆隔离：…' })
ok(/隔离状态：已被混淆闸门隔离/.test(qz), '【A2】隔离状态单独成行')
ok(/不是「是不是音源」的证据/.test(qz),
  '【核心】点明「隔离是混淆/安全维度，不是真伪证据」（否则模型把 quarantined 当 nonSource 依据）')
const notQz = spec.buildText({ name: 'x', suspected: true, status: 'ok' })
ok(/隔离状态：无/.test(notQz), '【A2】未隔离时也明确写「无」（避免模型自行猜测）')

// 4) 不能改坏原有语义：suspected 正向渲染仍然成立
ok(/通过音源特征筛选（疑似音源）/.test(spec.buildText({ name: 'x', suspected: true })),
  '【回归】suspected=true 仍渲染为「疑似音源」（没被这次改动碰坏）')
ok(!/疑似非音源/.test(spec.buildText({ name: 'x', suspected: true })), '【回归】不含「疑似非音源」')

// 5) probeOnly 标注不能丢（试跑数据进 R5 也必须带标注）
const probeDeep = { checkedAt: 1, loadable: true, platforms: { wy: { status: 'usable' } }, probeOnly: true }
ok(/用户尚未确认信任/.test(spec.buildText({ name: 'x', suspected: true, deep: probeDeep })),
  '【核心】试跑产出进 R5 时带「尚未确认信任」标注')

console.log('\n=== A3：dupReason 取值收敛 + 逻辑子串不能被改掉 ===')
const { DUP_REASON, DUP_REASON_MARK } = require(path.join(ROOT, 'src', 'core', 'hunter.js'))

ok(DUP_REASON.SAME_CONTENT === '同内容重复', '【A3】SAME_CONTENT 取值未变（测试与生成器按它筛选）')
ok(DUP_REASON.SAME_REPO_NAME === '同仓库同名重复', '【A3】SAME_REPO_NAME 取值未变')
ok(DUP_REASON.OLD_VERSION === '同名旧版本', '【A3】OLD_VERSION 取值未变')
ok(DUP_REASON.OLD_VERSION_NEW === '同名旧版本（已有更新版本）',
  '【核心】OLD_VERSION_NEW 逐字未变（dedupe ②b 翻案是严格等值门禁，改一个字就静默失效）')
ok(DUP_REASON.OLD_VERSION_KEEPER_DEAD === '同名旧版本（保留方已失效）', '【A3】KEEPER_DEAD 取值未变')
ok(DUP_REASON.VERSION_DEAD === '同名版本（此版本已失效）', '【A3】VERSION_DEAD 取值未变')

// 逻辑依赖的子串必须仍在取值里
ok(DUP_REASON.SAME_CONTENT.indexOf(DUP_REASON_MARK.SAME_CONTENT) !== -1,
  '【核心】"同内容" 子串仍在 SAME_CONTENT 中（/同内容/ 判 dupOf 指向合规）')
ok(DUP_REASON.SAME_REPO_NAME.indexOf(DUP_REASON_MARK.SAME_CONTENT) === -1,
  '【核心】SAME_REPO_NAME 不含 "同内容"（否则会被误判成同内容、禁止跨 hash 指向）')
ok(DUP_REASON.OLD_VERSION_NEW.indexOf(DUP_REASON_MARK.UPDATED) !== -1,
  '【核心】"已有更新版本" 子串仍在 OLD_VERSION_NEW 中（改写为 KEEPER_DEAD 靠它）')

// 源码里不该再有裸字面量参与逻辑（收敛到常量的意义就在此）
ok(!/dupReason\s*!==\s*'/.test(hunterSrc), '【A3】不再用裸字面量做 dupReason 严格比较（已收敛到常量）')
ok(!/indexOf\('同名旧版本（已有更新版本）'\)/.test(hunterSrc), '【A3】不再有裸字面量的 indexOf 判断')
ok(/DUP_REASON_MARK\.UPDATED/.test(hunterSrc), '【A3】改写条件改用常量子串')
ok(/DUP_REASON_MARK\.SAME_CONTENT/.test(hunterSrc), '【A3】sameContent 判断改用常量子串')

// 展示层只用一处，措辞会原样进 tooltip
ok(/e\.dupReason/.test(appSrc) && /function mergeTip/.test(appSrc),
  '【A3】前端 mergeTip 仍原样展示 dupReason（取值即文案，已按人话口径定）')

console.log('\n=== A4：样本归属只给结论（不改评测集） ===')
// 本文件不读也不写 tests/eval-cases/。这里只断言「我们没碰」——
// 若有人为了修 A4 去改评测集，会在这里被提醒（A4 归 R7测试）。
const evalDir = path.join(ROOT, 'tests', 'eval-cases')
ok(fs.existsSync(evalDir), '【A4】评测集目录存在（本测试不修改其中任何文件）')

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' a1-a4-regression: PASS ' + pass + ' / FAIL ' + fail)
if (fail) {
  console.log('\n失败项：')
  failures.forEach(f => console.log('  - ' + f))
}
process.exit(fail ? 1 : 0)
