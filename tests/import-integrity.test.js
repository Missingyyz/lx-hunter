'use strict'
/**
 * 漏 import / 漏引用静态排查（防回归）。
 *
 * 背景（真实 bug）：src/core/hunter.js 用了 obfDomainVerdict 却从未 import，
 * 导致 P-1432「重度混淆脚本自动信任」规则一旦被触发（重度混淆 + 无硬特征）就抛
 * ReferenceError，灌入链路崩在 72 秒后 —— 该功能从未真正工作过。
 * 同轮还查出：sourceUpdate.js 从 './crawler' 解构 crawlFetch（实际由 ./net 导出 → undefined）、
 * 以及 compareQuality 用了但没解构。
 *
 * 本测试做两件事：
 *  ① 结构检查：所有 `const { a, b } = require('./x')` 的解构名，必须都在该模块实际导出里
 *     （这类错误 100% 是 bug：要么 undefined 调用崩，要么白解构）。
 *  ② 交叉检查：对若干"高危符号"（曾经漏过的）确认 import 到位且可调用。
 * 不联网、不碰真实 /data。
 */
const fs = require('fs')
const path = require('path')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')) }
}

const SRC = path.resolve(__dirname, '..', 'src')
const files = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.js')) files.push(p)
  }
})(SRC)

const rel = p => path.relative(path.resolve(__dirname, '..'), p).replace(/\\/g, '/')

function main() {
  console.log('=== ① 每个 require 解构名都必须在该模块的导出里（扫描 ' + files.length + ' 个文件） ===')
  const bad = []
  const relPaths = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const names = m[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean)
      const spec = m[2]
      const target = path.resolve(path.dirname(f), spec)
      relPaths.push({ file: rel(f), spec })
      let mod
      try { mod = require(target) } catch (e) {
        bad.push({ file: rel(f), spec, err: 'require 失败：' + String(e.message).slice(0, 80) })
        continue
      }
      if (typeof mod === 'function') continue      // 默认导出函数，无需具名解构
      const keys = new Set(Object.keys(mod || {}))
      for (const n of names) {
        if (!keys.has(n)) bad.push({ file: rel(f), spec, name: n, err: '不在导出里' })
      }
    }
  }
  ok('所有 require 解构名都在对应模块导出里', bad.length === 0, JSON.stringify(bad.slice(0, 6)))
  ok('扫描覆盖 core/server/main/renderer（文件数 > 30）', files.length > 30, 'files=' + files.length)

  console.log('\n=== ② 高危符号交叉检查（历史漏 import 点） ===')
  const checker = require('../src/core/checker')
  const net = require('../src/core/net')
  const quality = require('../src/core/quality')

  ok('checker 导出 obfDomainVerdict', typeof checker.obfDomainVerdict === 'function')
  ok('net 导出 crawlFetch', typeof net.crawlFetch === 'function')
  ok('quality 导出 compareQuality', typeof quality.compareQuality === 'function')

  // hunter.js 必须真正解构到 obfDomainVerdict（静态文本 + 运行时双查）
  const hunterSrc = fs.readFileSync(path.join(SRC, 'core', 'hunter.js'), 'utf8')
  ok('hunter.js 的 require 解构里含 obfDomainVerdict',
    /const\s*\{[^}]*\bobfDomainVerdict\b[^}]*\}\s*=\s*require\(\s*['"]\.\/checker['"]\s*\)/.test(hunterSrc))
  const { Hunter } = require('../src/core/hunter')
  const h = new Hunter({ config: {}, db: {} }, () => {})
  ok('Hunter 实例方法 applyObfGate 存在', typeof h.applyObfGate === 'function')

  // sourceUpdate 的 crawlFetch / compareQuality 是否指向正确模块
  const suSrc = fs.readFileSync(path.join(SRC, 'core', 'sourceUpdate.js'), 'utf8')
  ok('sourceUpdate.js 不再从 ./crawler 解构 crawlFetch', !/crawlFetch\s*\}\s*=\s*require\(\s*['"]\.\/crawler['"]\s*\)/.test(suSrc))
  ok('sourceUpdate.js 从 ./net 解构 crawlFetch', /crawlFetch\s*\}\s*=\s*require\(\s*['"]\.\/net['"]\s*\)/.test(suSrc))
  ok('sourceUpdate.js 解构里含 compareQuality',
    /const\s*\{[^}]*\bcompareQuality\b[^}]*\}\s*=\s*require\(\s*['"]\.\/quality['"]\s*\)/.test(suSrc))

  // web.js 不得再引用 checker 从未导出的 getActiveDeepNames
  const webSrc = fs.readFileSync(path.join(SRC, 'server', 'web.js'), 'utf8')
  const webNoComment = webSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\s\/\/[^\n]*$/gm, '')
  ok('web.js 不再 import checker 的 getActiveDeepNames（该函数从不存在）', !/getActiveDeepNames/.test(webNoComment))
  ok('web.js 提供本地 activeDeepNames 实现', /function\s+activeDeepNames\s*\(/.test(webSrc))

  // 行为验证：sourceUpdate.defaultFetchCode 必须真的调到 net.crawlFetch（而非 undefined 崩）
  const U = require('../src/core/sourceUpdate')
  const origCrawlFetch = net.crawlFetch
  let crawlCalled = 0
  net.crawlFetch = async () => { crawlCalled++; return { ok: true, res: { ok: true, status: 200, text: async () => 'var a=1' } } }
  const p = U.defaultFetchCode({ url: 'https://example.test/a.js' }, 1000)
  p.then(() => {
    net.crawlFetch = origCrawlFetch
    ok('defaultFetchCode 实际调用 net.crawlFetch（修复前是 crawlFetch is not a function）', crawlCalled === 1, 'called=' + crawlCalled)
    console.log('\n' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS（' + pass + ' 项）'))
    process.exit(fail ? 1 : 0)
  }).catch(e => {
    net.crawlFetch = origCrawlFetch
    ok('defaultFetchCode 调用 net.crawlFetch 不抛 ReferenceError/TypeError', false, String(e && e.message))
    console.log('\n' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS（' + pass + ' 项）'))
    process.exit(fail ? 1 : 0)
  })
}
main()