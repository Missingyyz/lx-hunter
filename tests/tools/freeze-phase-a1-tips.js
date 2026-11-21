'use strict'
/**
 * 阶段A gold 主集 37 条 · 静态 fixture 生成器（可复跑）
 *
 * 为什么需要它：
 *   tests/phase-b-veto-shadow.test.js Part A-1 原先读**容器实时快照** `_snap_8197_sources.json`
 *   并按顺序取全部 updateTips 与硬编码 EXP[37] 逐位比对。容器一采集，tips 就涨到 48 条、顺序也变，
 *   于是出现「代码没动、测试假失败」（got=48 / hit=25）。
 *   → 把冻结时刻的 37 条 tip **原文**与 gold 标签一起落成静态 fixture，Part A-1 改读 fixture。
 *
 * 对齐方式（不做「取前 37 条」这种会漂移的偷懒口径）：
 *   以 gold 文档 tests/eval-cases/规则追更-样本预期.md §1 每行的「来源 name + msg 关键片段」为锚点，
 *   在快照 48 条 tips 里**唯一匹配**出对应那一条；要求
 *     ① 每条锚点在快照中命中且**只命中一条**（多命中时按 occurrence 指定第几次出现，并在 fixture 里记录）
 *     ② 37 条在快照中的位置**严格递增**（保持原主集顺序）
 *     ③ 标签**原样取自冻结时测试 Part A-1 的 EXP 数组**（现内联为本文件 LABELS 常量；Part A-1 改读
 *        fixture 后本文件即标签单一来源）。本生成器不重新推导、不修改任何期望值。
 *   任一条不满足 → 生成器直接报错退出，绝不产出「看起来对」的 fixture。
 *
 * 锚点匹配的两个坑（改锚点前必读，两者都曾造成「假漂移」）：
 *   · 拆词分隔符必须同时含**开闭**括号与方括号：`/[\s()（）\[\]【】]+/`。
 *     漏闭括号会留下 `shellsec)` / `2625)` 这类 token，锚点永远零命中（#29/#33/#35 曾如此）。
 *   · 锚点名是**另一条样本 name 的子串**时，子串匹配会先撞上别人（pos 相同 → 报「复用同一条 tip」）。
 *     此时加 `uniqName: '<快照里 name 原文>'` 走全等分支，**不要用 occurrence 绕**（#19/#22 曾如此）。
 *
 * 防漂移哨兵（Part A-1 已改读 fixture，故本文件是主集样本的唯一来源）：
 *   node tests/tools/freeze-phase-a1-tips.js --check
 *   exit=0：fixture 与「快照对齐结果 + LABELS 标签」一致，测试数据可信。
 *   exit≠0：快照里 37 条 tip 的原文/顺序变了，或 LABELS 与 gold 文档对不上 → **必须人工核对
 *           tests/eval-cases/规则追更-样本预期.md §1 后重新冻结**，禁止为了让 --check 变绿而改期望标签。
 *   日常跑 tests/phase-b-veto-shadow.test.js 不需要容器/快照；只有 --check 才读快照。
 *
 * 用法：
 *   node tests/tools/freeze-phase-a1-tips.js [--snap <快照路径>] [--out <fixture路径>] [--check]
 *   --check：只校验既有 fixture 与快照/标签是否仍一致，不写文件。
 *
 * ⚠ fixture 必须落在 tests/fixtures/，**不要放进 tests/eval-cases/**：
 *   `src/core/evalCases.js` 会把 tests/eval-cases/ 下的 *.json 当评测样本扫进来，要求每个文件有
 *   cases 数组，否则 loadCases 抛错 → tryLoadCases 返回 cases=0；而 main/index.js 与 server/web.js
 *   都调它，于是 fixture 一旦落在那儿，**产品侧 AI 评测样本静默加载为 0 条**，整条评测链在没有验尺的
 *   情况下失效（2026-11-21 实际踩过，连带打挂 7 个测试）。
 *   现 src 侧已另有兜底：文件自己声明 `__NON_SAMPLE__: true` 才跳过。但**本 fixture 仍按目录隔离处理**
 *   （放 tests/fixtures/，不加标记）：样本目录只放样本，比逐文件标记更难被误绕过。
 *   本文件已对 --out 做防呆：输出路径落在 tests/eval-cases/ 内直接 FATAL 退出。
 *   改动产出路径后，先确认产品侧仍能读到样本（在 lx-hunter/ 下跑，应 cases≈365 且 error 为空）：
 *   node -e "const e=require('./src/core/evalCases');const r=e.tryLoadCases('tests/eval-cases');console.log('cases='+r.cases.length+' error='+(r.error||'(空)'))"
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')            // lx-hunter/
const DEFAULT_SNAP = 'E:/AI/Deva/lunter/_snap_8197_sources.json'
const DEFAULT_OUT = path.join(ROOT, 'tests', 'fixtures', 'phase-a1-tips.frozen.json')

const argv = process.argv.slice(2)
const argOf = (flag, dft) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dft
}
const SNAP = path.resolve(ROOT, argOf('--snap', DEFAULT_SNAP))
const OUT = path.resolve(ROOT, argOf('--out', DEFAULT_OUT))
const CHECK_ONLY = argv.includes('--check')
// 防呆：fixture 落进评测样本目录会让产品侧评测静默加载 0 条（详见文件头 ⚠ 段）
// 用 ROOT 解析（与 cwd 无关）+ path.relative 判定，覆盖子目录与 ../ 绕路两种写法
const EVAL_DIR = path.join(ROOT, 'tests', 'eval-cases')
const relOut = path.relative(EVAL_DIR, OUT)
if (relOut && !relOut.startsWith('..') && !path.isAbsolute(relOut)) {
  console.error('FATAL: 输出路径落在 tests/eval-cases/（评测样本目录）内：' + OUT.replace(/\\/g, '/'))
  console.error('       那里的 *.json 会被 src/core/evalCases.js 全量当样本扫入并要求 cases 数组，')
  console.error('       本 fixture 结构是 {tips:[...]} → 产品侧 AI 评测会静默加载 0 条（2026-11-21 踩过）。')
  console.error('       请输出到 ' + DEFAULT_OUT.replace(/\\/g, '/'))
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 1) gold 标签：从 tests/phase-b-veto-shadow.test.js 的 Part A-1 里**原样抽取** EXP 数组
//    （口径单一来源，避免两份文件各写一份标签表而漂移）
// ---------------------------------------------------------------------------
// 冻结时点的 37 条标签（原样抄自 Part A-1 的 EXP 数组，**未重新推导、未修改任何期望值**）。
// Part A-1 改读 fixture 后测试里不再有 EXP，本常量就是标签的单一来源；
// 若测试里还能抽到 EXP，则二者必须完全一致（防两侧漂移）。
const LABELS = ['follow', 'follow', 'gray', 'follow', 'follow', 'ignore', 'follow', 'follow', 'gray', 'ignore',
  'follow', 'follow', 'follow', 'follow', 'ignore', 'follow', 'follow', 'ignore', 'ignore', 'ignore',
  'ignore', 'ignore', 'gray', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'follow', 'follow',
  'follow', 'gray', 'ignore', 'follow', 'gray', 'ignore', 'ignore']

const testFile = path.join(ROOT, 'tests', 'phase-b-veto-shadow.test.js')
const testSrc = fs.readFileSync(testFile, 'utf8')
const a1Start = testSrc.indexOf("section('Part A-1")
const a1End = testSrc.indexOf("section('Part A-2")
let EXP = LABELS
if (a1Start < 0 || a1End < 0 || a1End <= a1Start) {
  console.error('WARN: 未能定位 Part A-1 段落，改用生成器内置的冻结标签 LABELS')
} else {
  const expMatch = testSrc.slice(a1Start, a1End).match(/const EXP = \[([\s\S]*?)\]/)
  if (expMatch) {
    // eslint-disable-next-line no-new-func
    const fromTest = new Function('return [' + expMatch[1] + ']')()
    if (!Array.isArray(fromTest) || fromTest.length !== 37) {
      console.error('FATAL: Part A-1 的 EXP 长度应为 37，实为 ' + (fromTest && fromTest.length))
      process.exit(2)
    }
    if (JSON.stringify(fromTest) !== JSON.stringify(LABELS)) {
      console.error('FATAL: 测试里的 EXP 与生成器 LABELS 不一致（标签漂移，必须人工确认，禁止自动取其一）\n  test   = ' +
        JSON.stringify(fromTest) + '\n  LABELS = ' + JSON.stringify(LABELS))
      process.exit(2)
    }
    EXP = fromTest
  } else {
    console.log('  （Part A-1 已改读 fixture，无 EXP 数组 → 使用生成器内置 LABELS）')
  }
}
if (EXP.length !== 37 || EXP.some(x => !['follow', 'ignore', 'gray'].includes(x))) {
  console.error('FATAL: 标签数组非法：' + JSON.stringify(EXP))
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 2) 37 条锚点（gold §1「来源 name（id 尾）」+ msg 关键片段）
//    每项：{ name: 锚点名（含 gold 文档里的写法）, id?: 匹配 id 前缀, msg: msg 必须包含的片段,
//            occurrence?: 同一 (name,msg) 多次出现时取第几次（1 起，默认 1）, uniq?: 用 name 全等 }
// ---------------------------------------------------------------------------
const ANCHORS = [
  { n: 1, name: '念心音源 v1.0.0', msg: '服务器被屏蔽' },
  { n: 2, name: '星海音乐源 v2.2.8', msg: '当前版本：v2.2.8' },
  { n: 3, name: 'FreeListen-需自备网易云VIP密钥', id: 'guoyue2010', msg: '发现新版本 v1.1.2' },
  { n: 4, name: 'xinghai-music-source2.3.0', msg: '当前版本：v2.3.0 最新版本：v3.2.20' },
  { n: 5, name: '星海音源V2.3.5', msg: '发现新版本 v3.2.20' },
  { n: 6, name: '【推荐】长青SVIP音源v1.2.0', msg: '长青svip音源更新' },
  { n: 7, name: 'xinghai-music-sourcev2.3.7', msg: '新增启动域名连通性日志' },
  { n: 8, name: '星海2.3.8测试', msg: '新增启动域名连通性日志' },
  { n: 9, name: 'xinghai-music-sourcev2.3.11', msg: '发现新版本 v3.2.20' },
  { n: 10, name: '独家音源V5', msg: '版本过低(v5)' },
  { n: 11, name: 'HYWmusic_公益版', msg: '恢复kg' },
  { n: 12, name: '星海音乐源V3.2.15', msg: '新增启动域名连通性日志' },
  { n: 13, name: '星海音乐源v2.3.14', msg: '新增启动域名连通性日志' },
  { n: 14, name: 'xinghai-music-sourcev2.3.13', msg: '新增启动域名连通性日志' },
  { n: 15, name: '洛雪科技[独家音源] v4-会停用', msg: '版本过低(v4)' },
  { n: 16, name: 'xinghai-music-sourcev2.3.4', msg: '发现新版本 v3.2.20' },
  { n: 17, name: '星海音乐源 v2.2.6', id: 'Macrohard0', msg: '当前版本：v2.2.6', occurrence: 1 },
  { n: 18, name: '长青SVIP音源 v1.0.0', msg: '长青svip音源更新' },
  { n: 19, name: 'SVIP音源', uniqName: 'SVIP音源', msg: '长青svip音源更新' },
  { n: 20, name: '花瓣源 v2.0.0.beta5', msg: '长青svip音源更新' },
  { n: 21, name: '(new 6.3)ikun音源[公益] v26', msg: '验证码获取' },
  // #22 的简写拆词后同时命中 pos5「【推荐】长青SVIP音源v1.2.0（全平台支持无损）」（#6 的样本）——
  // 两条 msg 原文完全相同，无法靠 msg 区分 → 用 name 全等锁定 pos23，不要用 occurrence 绕
  { n: 22, name: '(推荐)长青SVIP音源 v1.2.0', uniqName: '(推荐)长青SVIP音源 v1.2.0', msg: '长青svip音源更新' },
  { n: 23, name: '小熊猫音源 v1.1.1', msg: '发现新版本 v1.1.2' },
  { n: 24, name: '极客会 内部源2', msg: '版本过低(v4)' },
  { n: 25, name: 'ikun音源[公益] v24', msg: '验证码获取' },
  { n: 26, name: 'lx-music-source V3.0', msg: '版本过低(v4)' },
  { n: 27, name: '6 (pdone)', id: 'pdone/lx-m', uniqName: '6', msg: '版本过低(v6)' },
  { n: 28, name: 'lx-animemusic', msg: '有新版本啦，点击更新即可' },
  { n: 29, name: '星海音乐源 (shellsec)', id: 'shellsec/l', msg: '新增启动域名连通性日志' },
  { n: 30, name: 'lx-source v1.9', id: 'luanmuc/lx', msg: 'v1.9 健壮性大版本' },
  { n: 31, name: 'lx-source v1.8', id: 'luanmuc/lx', msg: 'v1.8 适配更新弹窗' },
  { n: 32, name: 'xinghai-music-sourcev2.3.12', msg: '发现新版本 v3.2.19' },
  { n: 33, name: '我的聚合音源 (ext/lxhub)', id: 'ext/lxhub-', msg: '有新版本啦，点击更新即可' },
  { n: 34, name: '聚合Hi-Res音乐音源v1.0', msg: '更换域名修复部分地区 DNS 解析错误' },
  { n: 35, name: '星海音乐源 (hub 2625)', id: 'hub/192-16', msg: '发现新版本 v3.2.19' },
  { n: 36, name: '(推荐)长青SVIP音源 v1.1.1', msg: '长青svip音源更新' },
  { n: 37, name: '2 (pdone)', id: 'pdone/lx-m', uniqName: '2', msg: '版本过低(v4)' }
]
if (ANCHORS.length !== 37) { console.error('FATAL: 锚点条数应为 37，实为 ' + ANCHORS.length); process.exit(2) }
ANCHORS.forEach((a, i) => { if (a.n !== i + 1) { console.error('FATAL: 锚点 n 不连续 at ' + (i + 1)); process.exit(2) } })

// ---------------------------------------------------------------------------
// 3) 读快照 → 拍平全部 tips（保持快照内的原始顺序）
// ---------------------------------------------------------------------------
if (!fs.existsSync(SNAP)) {
  console.error('FATAL: 快照不存在 ' + SNAP)
  console.error('  该快照是 8197 测试容器 /data/sources.json 的只读导出；从容器重导一份即可复跑本生成器。')
  process.exit(2)
}
const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'))
const entries = Array.isArray(snap.sources) ? snap.sources : Object.values(snap.sources || {})
const flat = []
entries.forEach((e, ei) => {
  for (const t of (e.updateTips || [])) {
    flat.push({ pos: flat.length, entryOrder: ei, id: String(e.id || ''), name: String(e.name || ''), msg: String(t && t.msg || '') })
  }
})
const nz = (s) => String(s || '').replace(/\s+/g, '')

// 锚点匹配：id 前缀 + name 子串（或全等）+ msg 子串
function matches (a, t) {
  if (a.id && !String(t.id).startsWith(a.id)) return false
  if (a.uniqName) { if (String(t.name).trim() !== a.uniqName) return false }
  else {
    // 锚点名可能是 gold 文档的简写（如 xinghai v2.3.7 / 星海音乐源 (shellsec)）→ 拆词做子串包含
    // 分隔符必须含闭括号：否则「星海音乐源 (shellsec)」会留下 token `shellsec)`，永远匹配不上
    const parts = a.name.split(/[\s()（）\[\]【】]+/).map(nz).filter(Boolean)
    const hay = nz(t.name) + '|' + nz(t.id)
    if (!parts.every(p => hay.includes(p))) return false
  }
  if (a.msg && !nz(t.msg).includes(nz(a.msg))) return false
  return true
}

const picked = []
const used = new Set()
const problems = []
for (const a of ANCHORS) {
  const hits = flat.filter(t => matches(a, t))
  if (hits.length === 0) { problems.push('锚点 #' + a.n + ' [' + a.name + '] 在快照中零命中'); continue }
  const occ = a.occurrence || 1
  if (hits.length < occ) { problems.push('锚点 #' + a.n + ' [' + a.name + '] 只命中 ' + hits.length + ' 条，取不到第 ' + occ + ' 次'); continue }
  if (hits.length > 1 && !a.occurrence) {
    // 多次命中且未指定 occurrence：msg 必须完全一致才允许（否则无法判定取哪条）
    const same = new Set(hits.map(h => h.msg))
    if (same.size !== 1) {
      problems.push('锚点 #' + a.n + ' [' + a.name + '] 命中 ' + hits.length + ' 条且 msg 原文不同（' + [...same].map(s => s.slice(0, 24)).join(' / ') + '），需显式 occurrence')
      continue
    }
  }
  const t = hits[occ - 1]
  if (used.has(t.pos)) { problems.push('锚点 #' + a.n + ' [' + a.name + '] 与前面的锚点复用了同一条 tip（pos=' + t.pos + '）'); continue }
  used.add(t.pos)
  picked.push({ anchor: a, tip: t, occurrences: hits.length })
}
if (problems.length) { console.error('FATAL: 锚点对齐失败（' + problems.length + ' 项）：\n  - ' + problems.join('\n  - ')); process.exit(2) }
if (picked.length !== 37) { console.error('FATAL: 对齐到 ' + picked.length + ' 条，应为 37'); process.exit(2) }
for (let i = 1; i < 37; i++) {
  if (picked[i].tip.pos <= picked[i - 1].tip.pos) {
    console.error('FATAL: 对齐结果在快照中非严格递增（#' + (i + 1) + ' pos=' + picked[i].tip.pos + ' 未大于 #' + i + ' pos=' + picked[i - 1].tip.pos + '），主集顺序无法保证')
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// 4) 组 fixture：37 条 tip 原文 + gold 标签（标签取自 EXP，逐条按锚点序号对齐）
// ---------------------------------------------------------------------------
const frozen = picked.map((p, i) => ({
  n: i + 1,
  name: p.tip.name,
  id: p.tip.id,
  msg: p.tip.msg,
  expect: EXP[i]
}))
const excluded = flat.filter(t => !used.has(t.pos)).map(t => ({ n: t.pos + 1, name: t.name, msg: t.msg.slice(0, 60) }))

const doc = {
  // 显式声明「我不是 R4-R7 评测样本」。evalCases.loadCases 认这个标记并跳过本文件，
  // 于是即便有人手工把本文件拷进 tests/eval-cases/，也只是少一个文件被扫，不会拖垮
  // 整条评测链（产品侧 main/index.js 与 server/web.js 都靠 tryLoadCases 取验尺）。
  // 与生成器上方的 --out 防呆是两道独立防线：防呆拦生成，标记拦手工挪动。
  __NON_SAMPLE__: true,
  __NOTE: '阶段A gold 主集 37 条 updateTips 原文（冻结快照，**不是**实时容器数据，也**不是** R4-R7 评测样本）。由 tests/tools/freeze-phase-a1-tips.js 生成，tests/phase-b-veto-shadow.test.js Part A-1 读取本文件；请勿手改 expect 字段以外的内容。本文件应留在 tests/fixtures/：tests/eval-cases/ 下的 *.json 会被 src/core/evalCases.js 全量当评测样本扫入（要求 cases 数组）。',
  sourceOfTruth: 'gold: tests/eval-cases/规则追更-样本预期.md §1（#1..#37）；标签: tests/tools/freeze-phase-a1-tips.js 的 LABELS（冻结时原样抄自 Part A-1 的 EXP 数组）',
  frozenFromSnapshot: SNAP.replace(/\\/g, '/'),
  snapshotTipsTotal: flat.length,
  frozenCount: frozen.length,
  distribution: frozen.reduce((a, x) => { a[x.expect] = (a[x.expect] || 0) + 1; return a }, {}),
  tips: frozen,
  __EXCLUDED_FROM_SNAPSHOT: excluded
}

// ---------------------------------------------------------------------------
// 5) --check：只比对（fixture 已存在时），并实跑判据函数给 hit
// ---------------------------------------------------------------------------
const { shouldFollowUpdateTip } = require(path.join(ROOT, 'src', 'core', 'updateTipPolicy'))
let hit = 0
const diffs = []
frozen.forEach((t) => {
  const got = shouldFollowUpdateTip(t.msg)
  if (got === t.expect) hit++
  else diffs.push('#' + t.n + ' expect=' + t.expect + ' got=' + got + ' msg=' + String(t.msg).slice(0, 30).replace(/\n/g, ' '))
})

if (CHECK_ONLY) {
  if (!fs.existsSync(OUT)) { console.error('FATAL: fixture 不存在，无法 check：' + OUT); process.exit(2) }
  const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  const same = JSON.stringify(cur.tips) === JSON.stringify(frozen)
  console.log('CHECK snapshot=' + flat.length + ' tips → frozen=37；与既有 fixture ' + (same ? '一致' : '**不一致**（快照或标签已变，需重生成）'))
  console.log('hit=' + hit + '/37 ' + JSON.stringify(diffs))
  process.exit(same && hit === 37 ? 0 : 1)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n', 'utf8')
console.log('WROTE ' + OUT)
console.log('  snapshot tips = ' + flat.length + '（冻结取 37，排除 ' + excluded.length + ' 条后来新增/重复源）')
console.log('  distribution   = ' + JSON.stringify(doc.distribution) + '（follow/ignore/gray）')
console.log('  hit            = ' + hit + '/37 ' + (diffs.length ? JSON.stringify(diffs) : '（与 EXP 逐条一致）'))
console.log('  逐条 name 断言：')
frozen.forEach(t => console.log('    #' + t.n + ' [' + t.expect.padEnd(6) + '] ' + String(t.name).slice(0, 30).replace(/\n/g, ' ') + ' ||| ' + String(t.msg).replace(/\n/g, ' ').slice(0, 46)))
