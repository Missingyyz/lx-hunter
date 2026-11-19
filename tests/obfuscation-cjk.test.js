'use strict'
/**
 * 混淆指标口径修正：CJK（汉字）\uXXXX 转义**不再**计入混淆指标
 *
 * ============================================================================
 * 这个误伤是怎么来的（实证）
 * ============================================================================
 * 洛雪音源脚本**普遍**把中文写成 \uXXXX 转义。
 * 豆包定制 v9.1.0 聚合源实测：3197 个转义里 **93.6% 是汉字**。
 * 老口径（`count(/\\u[0-9a-fA-F]{4}/g)`）把**所有** \uXXXX 都算成混淆指标，
 * 于是这个正常音源 perKbUni=9.23（阈值 HIGH_UNI=8）→ 被判 high → 被误隔离。
 *
 * 汉字转义是「作者把中文写成转义」的正常写法，不是藏代码。
 * 真正用来藏代码的转义是 \u0072\u0065\u0071… 这类 **ASCII 码点**。
 *
 * ============================================================================
 * 本测试锁住三件事
 * ============================================================================
 * ① 大量汉字转义的样本**不再**被判 high（给出具体 perKbUni 数值变化）
 * ② 真正高混淆的样本（大量非 CJK 转义）**仍然**被判 high
 * ③ 阈值一个都没动（只改统计口径）
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const CORE = (n) => path.join(ROOT, 'src', 'core', n)
const { obfuscationRisk, obfuscationTip } = require(CORE('checker'))

let pass = 0
let fail = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; fails.push(name + (extra ? '  :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')) }
}

/** 老口径：把所有 \uXXXX 都算进去（用于对照，不动生产代码） */
function oldUniCount (code) {
  return (String(code || '').match(/\\u[0-9a-fA-F]{4}/g) || []).length
}
function isCjkCp (cp) {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
}
function cjkUniCount (code) {
  const s = String(code || '')
  const re = /\\u([0-9a-fA-F]{4})/g
  let m, n = 0
  while ((m = re.exec(s))) if (isCjkCp(parseInt(m[1], 16))) n++
  return n
}

// ============================================================================
console.log('\n=== ① 构造「豆包定制 v9.1.0 那种」样本：大量汉字转义 ===')
// ============================================================================
// 真实形态：脚本正文里散布大量中文的 \uXXXX 转义。
// 目标形态：老口径 perKbUni ≈ 9.2（越过 HIGH_UNI=8），新口径 perKbUni ≈ 0。
const HANZI_POOL = [
  '音', '源', '聚', '合', '更', '新', '版', '本', '下', '载',
  '服', '务', '器', '接', '口', '请', '求', '播', '放', '歌',
  '单', '曲', '词', '封', '面', '加', '密', '搜', '索', '榜'
]
/**
 * 造一个「豆包定制 v9.1.0 那种」的样本：
 *   - 3197 个 \uXXXX 转义，其中 93.6% 是汉字（余下 6.4% 是 ASCII 码点）
 *   - 总长度 ~346KB ⇒ 老口径 perKbUni ≈ 9.23（与真实实测同量级）
 */
function buildRealLikeScript (totalEscapes, hanziRatio, fillerChars) {
  const parts = []
  let cjk = 0
  for (let i = 0; i < totalEscapes; i++) {
    const isHanzi = (i % 1000) < Math.round(hanziRatio * 1000)
    const cp = isHanzi ? HANZI_POOL[i % HANZI_POOL.length].charCodeAt(0) : (0x61 + (i % 26))
    const esc = '\\u' + cp.toString(16).padStart(4, '0')
    if (isHanzi) cjk++
    parts.push('const t' + i + ' = "' + esc + '";')
  }
  // 掺正常代码行，把体积拉到目标量级
  while (parts.join('\n').length < fillerChars) {
    parts.push('// ' + 'x'.repeat(40) + ' 注释行 ' + parts.length)
  }
  return { code: parts.join('\n'), cjk }
}
{
  const nEsc = 3197
  const built = buildRealLikeScript(nEsc, 0.936, 346 * 1024)
  const code = built.code
  const kb = code.length / 1024
  const oldPerKb = oldUniCount(code) / kb
  const r = obfuscationRisk(code)
  const newPerKb = r.hits ? r.hits.perKbUni : null
  const ratio = 100 * built.cjk / oldUniCount(code)
  console.log('  [样本] 长度 ' + code.length + ' 字符（' + kb.toFixed(1) + ' KB）')
  console.log('  [样本] 总转义 ' + oldUniCount(code) + '，其中汉字 ' + built.cjk +
    '（' + ratio.toFixed(1) + '% 是汉字）')
  console.log('  [样本] 老口径 perKbUni=' + oldPerKb.toFixed(2) + ' → 新口径 perKbUni=' + newPerKb.toFixed(2))

  ok('老口径确实越过 HIGH_UNI=8（即修复前会被判 high）', oldPerKb >= 8, 'old=' + oldPerKb.toFixed(2))
  ok('★ 修复后 perKbUni 大幅下降（汉字转义不再计入）', newPerKb < 1, 'new=' + newPerKb.toFixed(2))
  ok('★ 汉字转义样本不再被判 high', r.level !== 'high', 'level=' + r.level)
  ok('★ 也不再被判 mid（连局部混淆都不算）', r.level === '', 'level=' + r.level)
  ok('hits.totalUni 只计非 CJK 转义', r.hits && r.hits.totalUni === oldUniCount(code) - built.cjk,
    'totalUni=' + (r.hits && r.hits.totalUni))
  ok('★ hits 的字段集合与修复前完全一致（对外接口不变）',
    r.hits && Object.keys(r.hits).sort().join(',') ===
      'evalCalls,jsjiamiMarks,perKb0x,perKbExotic,perKbUni,selfSchedCalls,selfSchedDecode,selfSchedTimer,selfSchedUnknown,spinLoops,total0x,totalExotic,totalUni',
    r.hits ? Object.keys(r.hits).sort().join(',') : 'null')
  ok('汉字转义 93.6% 的样本（3197 个）复现了真实比例',
    Math.abs(ratio - 93.6) < 1, ratio.toFixed(1) + '%')
}

// ============================================================================
console.log('\n=== ② 真正高混淆的样本：大量**非 CJK** 转义 → 仍然 high ===')
// ============================================================================
{
  // 混淆器经典手法：把 ASCII 码点写成转义
  const asciiEsc = ('return \\u0072\\u0065\\u0071\\u0075\\u0069\\u0072\\u0065;').repeat(80)
  const r = obfuscationRisk(asciiEsc)
  ok('ASCII 转义密度高 → 仍然判 high', r.level === 'high', 'level=' + r.level + ' perKbUni=' + (r.hits && r.hits.perKbUni.toFixed(2)))
  ok('ASCII 转义照旧计入 totalUni', r.hits && r.hits.totalUni === 80 * 7, 'totalUni=' + (r.hits && r.hits.totalUni))

  // \u0033\u0034\u0035 这类数字码点转义（另一种常见形态）
  const digitEsc = ('var a = "\\u0033\\u0034\\u0035";').repeat(120)
  const r2 = obfuscationRisk(digitEsc)
  ok('数字码点转义密度高 → 仍然判 high', r2.level === 'high', 'level=' + r2.level + ' perKbUni=' + (r2.hits && r2.hits.perKbUni.toFixed(2)))

  // \u0061\u0062 这种字母码点
  const letterEsc = ('var b = "\\u0061\\u0062\\u0063";').repeat(140)
  const r3 = obfuscationRisk(letterEsc)
  ok('字母码点转义密度高 → 仍然判 high', r3.level === 'high', 'level=' + r3.level + ' perKbUni=' + (r3.hits && r3.hits.perKbUni.toFixed(2)))

  // 混合：少量汉字 + 大量 ASCII → 仍按 ASCII 部分判 high（汉字不能掩盖真混淆）
  const mixed = Array.from({ length: 200 }, (_, i) => 'const t' + i + ' = "\\u97f3\\u4e50";').join('\n') +
    ('\\u0072\\u0065\\u0071').repeat(400)
  const r4 = obfuscationRisk(mixed)
  ok('混合样本（汉字 + 大量 ASCII 转义）→ 仍然 high', r4.level === 'high', 'level=' + r4.level)
}

// ============================================================================
console.log('\n=== ③ 边界：CJK 各区间都算汉字，不该被当成混淆 ===')
// ============================================================================
{
  const cases = [
    ['\\u4e00', 'U+4E00（CJK 基本区下界）', 0x4e00],
    ['\\u9fff', 'U+9FFF（CJK 基本区上界）', 0x9fff],
    ['\\u3400', 'U+3400（CJK 扩展 A 下界）', 0x3400],
    ['\\u4dbf', 'U+4DBF（CJK 扩展 A 上界）', 0x4dbf],
    ['\\u20000', 'U+20000（扩展 B，暂不豁免 → 计入混淆）', 0x20000]
  ]
  for (const [esc, desc, cp] of cases) {
    const code = ('const s = "' + esc + '";').repeat(200)
    const r = obfuscationRisk(code)
    if (cp >= 0x3400 && cp <= 0x9fff) {
      ok(desc + ' → 不计入混淆指标', r.hits && r.hits.totalUni === 0,
        'totalUni=' + (r.hits && r.hits.totalUni))
    } else {
      // 扩展 B 不在豁免范围（按要求「至少覆盖基本区 + 扩展 A」）→ 计入混淆
      ok(desc + ' → 计入混淆指标（豁免范围之外）', r.hits && r.hits.totalUni === 200,
        'totalUni=' + (r.hits && r.hits.totalUni))
    }
  }
  // 边界值：刚好在区间外的码点要计入
  const justOutside = ('const s = "\\u33ff";').repeat(200)  // U+33FF 紧邻扩展 A 之前
  const rj = obfuscationRisk(justOutside)
  ok('区间外的相邻码点（U+33FF）→ 计入混淆指标', rj.hits && rj.hits.totalUni === 200,
    'totalUni=' + (rj.hits && rj.hits.totalUni))
}

// ============================================================================
console.log('\n=== ④ 阈值一个都没动（只改统计口径） ===')
// ============================================================================
{
  const src = fs.readFileSync(CORE('checker.js'), 'utf8')
  ok('HIGH_UNI 仍是 8', /const HIGH_0X = 20, HIGH_UNI = 8, HIGH_EXOTIC = 20/.test(src))
  ok('MID_UNI 仍是 1', /const MID_0X = 2, MID_UNI = 1, MID_EXOTIC = 2/.test(src))
  ok('阈值判断用的仍是 hits.perKbUni（口径变了、阈值没变）',
    /hits\.perKbUni >= HIGH_UNI/.test(src) && /hits\.perKbUni >= MID_UNI/.test(src))
  ok('obfuscationRisk 的返回结构没变（level + hits）',
    /return \{ level: 'high', hits \}/.test(src) && /return \{ level: '', hits \}/.test(src))
}

// ============================================================================
console.log('\n=== ⑤ 对外接口不变 + 回归（干净脚本/短内容/空内容） ===')
// ============================================================================
{
  ok('过短内容仍返回 {level:"",hits:null}', (() => {
    const r = obfuscationRisk('var a=1')
    return r.level === '' && r.hits === null
  })())
  ok('空内容不炸', obfuscationRisk('').level === '' && obfuscationRisk(null).level === '')

  const clean = '// -------- yunmge 酷我 --------\nconst getYunmgeKw = async (songId, quality, musicInfo) => {\n  const id = musicInfo?.rid || musicInfo?.songmid || songId\n  if (!id) throw new Error("yunmge: 缺少 id")\n  const brMap = { "128k":128, "320k":320 }\n  const resp = await httpFetch(url, { method: "GET", timeout: 8000 })\n  return resp.body\n}\n'.repeat(30)
  ok('干净脚本仍无级别', obfuscationRisk(clean).level === '')
  ok('干净脚本 perKbUni=0', obfuscationRisk(clean).hits && obfuscationRisk(clean).hits.perKbUni === 0)
  ok('obfuscationTip 对 high 样本仍给「建议拒绝使用」',
    /建议拒绝使用/.test(obfuscationTip(obfuscationRisk(('\\u0072\\u0065\\u0071').repeat(80)))))
}

// ============================================================================
console.log('\n=== ⑥ 仓库内真实脚本回归：汉字转义不再让正常音源变 high ===')
// ============================================================================
{
  // 扫仓库内 .js：找出「老口径会判 high、新口径不判」的样本 = 本次修复救回来的正常源码
  const files = []
  const collect = (d) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return }
    for (const ent of entries) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) { if (!/node_modules|^\.git$|^dist$|^_tools$/.test(ent.name)) collect(p) }
      else if (/\.js$/.test(ent.name)) {
        try { const st = fs.statSync(p); if (st.size < 400 * 1024) files.push({ name: path.relative(ROOT, p), code: fs.readFileSync(p, 'utf8') }) } catch (e) {}
      }
    }
  }
  collect(path.join(ROOT, 'src')); collect(path.join(ROOT, 'tests'))
  let cjkHeavy = 0
  let rescued = 0
  for (const f of files) {
    const cjk = cjkUniCount(f.code)
    if (cjk < 1) continue
    cjkHeavy++
    const r = obfuscationRisk(f.code)
    if (r.level === 'high') {
      // 真的还有非 CJK 特征（_0x / 异体字符 / 自调度）→ 不算「被汉字误伤」
      const nonCjk = r.hits && (r.hits.totalUni > 0 || r.hits.perKb0x >= 8 || r.hits.perKbExotic >= 8)
      if (!nonCjk) rescued++
    }
  }
  ok('仓库里有含汉字转义的真实脚本（≥3 个）', cjkHeavy >= 3, 'cjkHeavy=' + cjkHeavy)
  ok('★ 没有任何真实脚本因汉字转义被判 high', rescued === 0, 'rescued=' + rescued)
}

console.log('\n' + (fail ? '✗' : '✓') + ' obfuscation-cjk: PASS ' + pass + ' / FAIL ' + fail)
if (fail) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
process.exit(0)
