/**
 * T1-1 回归：P-1434 采集特征库对压缩包内 .js 必须与树内 .js 同口径拦截。
 * 曾经树内路径命中特征词被跳过，zip 内路径却没有检查 → 被标记的废源换 zip 分发又采回。
 * 本测试用同一个 score=11 的真音源特征脚本，验证树内与 zip 内都被拦。
 */
const { setCrawlBlockPatterns, extractCandidates, pickScriptsFromZip, isBlockedPath } = require('../src/core/crawler')
const { scoreEntry } = require('../src/core/checker')

let bad = 0
const ck = (n, c, x) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  -> ' + x : ''}`) }

// 真音源特征脚本：文件名含 source(+2)、src- 前缀(+1)、正文 globalThis.lx(+3)+lx.on(+2)+lx.request(+2)+musicSources(+2) = 12
const CODE = `globalThis.lx = { on(){}, request(){}, utils:{} };
globalThis.lx.on("request", async () => ({ musicSources: [], qualitys:{} }));
globalThis.lx.request('https://api.example.com/url');
const inited = true; const supportedSources = ["wy","qq"];`
const BLOCK_KW = 'example'   // 特征库词：文件名 example-source.js 命中
const INNER = 'src/example-source.js'

const score = scoreEntry(INNER, CODE)
ck('测试脚本确为真音源特征（score>=4，本例 ' + score + '）', score >= 4)

// ---- 统一判定函数 ----
setCrawlBlockPatterns([BLOCK_KW])
ck('isBlockedPath 命中特征词', isBlockedPath(INNER) === true)
ck('isBlockedPath 不误伤干净路径', isBlockedPath('src/real-source.js') === false)
setCrawlBlockPatterns([])
ck('特征库清空后不拦截', isBlockedPath(INNER) === false)

// ---- 树内 .js：命中特征词被拦 ----
setCrawlBlockPatterns([BLOCK_KW])
const tree = { tree: [
  { type: 'blob', path: INNER, sha: 'a', size: CODE.length },
  { type: 'blob', path: 'src/real-source.js', sha: 'b', size: CODE.length }
] }
const cand = extractCandidates(tree, 50)
ck('树内：命中特征词的 .js 被拦', cand.items.length === 1 && !cand.items.some(i => i.path.includes(BLOCK_KW)),
  'items=' + cand.items.map(i => i.path).join(',') + ' block=' + cand.filtered.block)
ck('树内：干净 .js 仍采集', cand.items.some(i => i.path === 'src/real-source.js'))

// ---- zip 内 .js：命中特征词被拦（T1-1 核心）----
const entries = [
  { path: INNER, data: Buffer.from(CODE, 'utf8') },
  { path: 'src/real-source.js', data: Buffer.from(CODE, 'utf8') }
]
const picked = pickScriptsFromZip(entries, '音源打包.zip', 'o/r', 'https://x/音源打包.zip', 50)
ck('zip 内：命中特征词的 .js 被拦（T1-1）', picked.length === 1 && !picked.some(p => p.innerPath.includes(BLOCK_KW)),
  'picked=' + picked.map(p => p.innerPath).join(','))
ck('zip 内：干净 .js 仍采集', picked.some(p => p.innerPath === 'src/real-source.js'))

// ---- 压缩包文件名命中特征词：整包内脚本都被拦 ----
const picked2 = pickScriptsFromZip(
  [{ path: 'src/real-source.js', data: Buffer.from(CODE, 'utf8') }],
  'example-音源包.zip', 'o/r', 'https://x/example.zip', 50)
ck('zip 外名命中特征词：包内脚本也被拦', picked2.length === 0, 'picked=' + picked2.length)

setCrawlBlockPatterns([])  // 还原默认，避免影响同进程其它测试
console.log('\n' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'))
process.exit(bad ? 1 : 0)
