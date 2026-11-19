'use strict'
/**
 * 对比脚本：原版 facade vs 补丁版 facade，在「宿主异常」上的
 *   - realm 归属（沙箱 / 宿主）
 *   - 是否可逃逸（拿到真 process）
 *   - 重建后是否有宿主对象残留（自定义属性 / stack / message / 嵌套）
 *
 * 这就是「修 escape 引入新 escape」的检查：
 *   补丁版必须做到 realm=sandbox + escaped=false + 零宿主残留。
 *
 * 用法: node tests/tools/throw-residue-compare.js
 */
const { execFileSync } = require('child_process')
const path = require('path')

const RUNNER = path.join(__dirname, 'throw-residue-probe-runner.js')

const EXPRS = [
  ['URL: new URL("not a url")', "new URL('not a url')"],
  ['Buffer.from(-1)', 'Buffer.from(-1)'],
  ['Buffer.from("x","bogus-enc")', "Buffer.from('x','bogus-enc')"],
  ['TextDecoder("nope")', "new TextDecoder('nope')"],
  ['unescape("%uZZZZ")', "unescape('%uZZZZ')"],
  ['Buffer.alloc(-1)', 'Buffer.alloc(-1)'],
  ['AbortSignal.timeout(-1)', 'AbortSignal.timeout(-1)'],
  ['crypto.rsaEncrypt 坏 PEM', "crypto.rsaEncrypt('x','not-a-pem')"],
  ['zlib.inflate 非 gzip', "zlib.inflate(Buffer.from('not-gzip'))"],
  ['crypto.randomBytes(-1)', 'crypto.randomBytes(-1)'],
  ['clearImmediate(1)', 'clearImmediate(1)']
]

function probe (expr, patched) {
  const env = Object.assign({}, process.env)
  if (patched) env.LX_FACADE_PATCHED = '1'; else delete env.LX_FACADE_PATCHED
  const out = execFileSync(process.execPath, [RUNNER, Buffer.from(expr).toString('base64'), 'sync'], {
    encoding: 'utf8', env, timeout: 120000
  })
  return JSON.parse(out.trim())
}

function summarize (label, j) {
  const r = j.result || {}
  const props = r.props || []
  const deep = r.deep || []
  const badProps = props.filter(p => p.realm === 'foreign' || p.escaped)
  const badDeep = deep.filter(p => p.realm === 'foreign' || p.escaped)
  return {
    label,
    realm: r.realm,
    escaped: !!r.escaped,
    stackType: r.stackType,
    messageType: r.messageType,
    badProps,
    badDeep,
    msg: r.msg
  }
}

;(async () => {
  console.log('=== 宿主异常消毒：原版 vs 补丁版（残留 + 逃逸 双向检查）===')
  console.log('判据: realm=sandbox 且 escaped=false 且 零宿主残留 才算修好\n')
  let origBad = 0; let patchBad = 0
  const rows = []
  for (const [name, expr] of EXPRS) {
    const o = summarize('原版', probe(expr, false))
    const p = summarize('补丁', probe(expr, true))
    if (o.realm === 'foreign' || o.escaped) origBad++
    if (p.realm !== 'sandbox' || p.escaped || p.badProps.length || p.badDeep.length) patchBad++
    rows.push([name, o, p])
  }
  for (const [name, o, p] of rows) {
    const mark = (s) => (s.realm === 'sandbox' && !s.escaped && !s.badProps.length && !s.badDeep.length ? '✅' : '❌')
    console.log(`${name}`)
    console.log(`   原版 ${mark(o)} realm=${o.realm} escaped=${o.escaped} 残留prop=${o.badProps.length} 残留deep=${o.badDeep.length}`)
    console.log(`   补丁 ${mark(p)} realm=${p.realm} escaped=${p.escaped} 残留prop=${p.badProps.length} 残留deep=${p.badDeep.length} stack=${p.stackType} message=${p.messageType}`)
    if (o.badProps.length) console.log('        原版残留: ' + JSON.stringify(o.badProps))
    if (p.badProps.length) console.log('        补丁残留: ' + JSON.stringify(p.badProps))
    if (p.badDeep.length) console.log('        补丁深层残留: ' + JSON.stringify(p.badDeep))
  }
  console.log(`\n统计: 原版不合格 ${origBad}/${EXPRS.length}；补丁版不合格 ${patchBad}/${EXPRS.length}`)
  console.log(patchBad === 0
    ? '✅ 补丁版：全部沙箱 realm、不可逃逸、无宿主对象残留'
    : '❌ 补丁版仍有问题')
  process.exit(patchBad === 0 ? 0 : 1)
})().catch(e => { console.log('FATAL ' + String(e && e.message || e)); process.exit(2) })
