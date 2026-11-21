'use strict'
/**
 * v1.18 评测样本目录的「非样本文件」隔离机制
 *
 * 背景（2026-11-21 实测事故）：一颗测试 fixture（`{tips:[...]}`）被放进 tests/eval-cases/，
 * 而 loadCases 会把目录里全部 *.json 当样本读、缺 cases 数组就整体抛错 ⇒
 * tryLoadCases 返回 cases=0 ⇒ main/index.js 与 server/web.js 两条链上的 AI 评测
 * 在没有验尺的状态下停摆（且只 log 一次，界面看不出来）。
 *
 * 修法边界（本测试要守住的核心）：只跳过**文件自己声明**非样本的（__NON_SAMPLE__ === true）。
 * 「缺 cases 数组」「样本字段残缺」「JSON 语法坏」必须**仍然抛错** ——
 * v1.13.9 定的「坏样本必须响、不能与『确实没样本』同形」不能削弱，否则又回到静默失效。
 *
 * 全部用临时目录测，不碰真实 tests/eval-cases/。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadCases, tryLoadCases, NON_SAMPLE_MARKER, isNonSampleFile } = require('../src/core/evalCases')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-evalcases-'))
const put = (name, obj) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')
  return p
}
// 一份合法样本（保证「跳过非样本后仍能读到真样本」）
// 字段口径取自 validateCase：kind∈R4-R7、zone∈HARD/GREY、danger∈D0/D1（字符串枚举，不是布尔）
const GOOD = { cases: [{ id: 'g1', kind: 'R5', input: { name: 'x' }, expected: { zone: 'GREY', danger: 'D0', verdict: 'keep' }, goldSource: 'manual' }] }
put('good.json', GOOD)

console.log('=== ① 标记判定严格 ===')
{
  ok(isNonSampleFile({ [NON_SAMPLE_MARKER]: true }) === true, '__NON_SAMPLE__: true → 判为非样本')
  ok(isNonSampleFile({ [NON_SAMPLE_MARKER]: 'true' }) === false, '字符串 "true" 不算（必须严格布尔）')
  ok(isNonSampleFile({ [NON_SAMPLE_MARKER]: 1 }) === false, '真值 1 不算')
  ok(isNonSampleFile({ __NOTE: 'x' }) === false, '只有 __NOTE 不算（不能靠猜）')
  ok(isNonSampleFile([]) === false, '数组形态（裸样本列表）不算非样本')
  ok(isNonSampleFile(null) === false && isNonSampleFile(undefined) === false, '空值不抛且不算')
}

console.log('\n=== ② 带标记的文件被跳过，不影响同目录真样本 ===')
{
  put('fixture-like.json', { [NON_SAMPLE_MARKER]: true, __NOTE: '测试 fixture，非评测样本', tips: [{ n: 1, msg: 'x', expect: 'gray' }] })
  const cs = loadCases(dir)
  ok(cs.length === 1, '跳过非样本后仍读到 1 条真样本，got=' + cs.length)
  const t = tryLoadCases(dir)
  ok(t.error === '' && t.cases.length === 1, 'tryLoadCases：error 空且 cases=1')
}

console.log('\n=== ③ 不能削弱：没标记的非样本文件必须仍然抛错 ===')
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-evalcases2-'))
  fs.writeFileSync(path.join(d2, 'sneaky.json'), JSON.stringify({ tips: [1, 2] }), 'utf8')
  let threw = ''
  try { loadCases(d2) } catch (e) { threw = String(e.message) }
  ok(/无 cases 数组/.test(threw), '无标记 + 无 cases 数组 → 仍抛错（不是静默跳过）：' + threw.slice(0, 50))
  ok(/__NON_SAMPLE__/.test(threw), '抛错信息给出补救方式（提示加标记）')
  const t2 = tryLoadCases(d2)
  ok(t2.cases.length === 0 && /无 cases 数组/.test(t2.error), 'tryLoadCases 仍返回 error（坏数据必须响）')
  fs.rmSync(d2, { recursive: true, force: true })
}

console.log('\n=== ④ 不能削弱：坏样本 / 坏 JSON 仍抛错 ===')
{
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-evalcases3-'))
  // 样本本身缺字段 → validateCase 抛
  fs.writeFileSync(path.join(d3, 'bad.json'), JSON.stringify({ cases: [{ id: 'b1' }] }), 'utf8')
  let m = ''
  try { loadCases(d3) } catch (e) { m = String(e.message) }
  ok(/样本校验失败/.test(m), '残缺样本仍抛（标记不豁免样本校验）：' + m.slice(0, 40))
  fs.rmSync(d3, { recursive: true, force: true })

  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-evalcases4-'))
  fs.writeFileSync(path.join(d4, 'broken.json'), '{ this is not json', 'utf8')
  let m2 = ''
  try { loadCases(d4) } catch (e) { m2 = String(e.message) }
  ok(/解析失败/.test(m2), '语法坏的 JSON 仍抛：' + m2.slice(0, 40))
  fs.rmSync(d4, { recursive: true, force: true })
}

console.log('\n=== ⑤ 真实样本目录不受影响 ===')
{
  const real = tryLoadCases(path.join(__dirname, 'eval-cases'))
  ok(real.error === '', '真实 tests/eval-cases 加载无 error：' + String(real.error).slice(0, 60))
  ok(real.cases.length > 300, '真实样本数 >300（现约 365），got=' + real.cases.length)
  ok(!fs.existsSync(path.join(__dirname, 'eval-cases', 'phase-a1-tips.frozen.json')),
    'fixture 已移出样本目录（现在 tests/fixtures/）')
  ok(fs.existsSync(path.join(__dirname, 'fixtures', 'phase-a1-tips.frozen.json')), 'fixture 在 tests/fixtures/ 下')
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('\nevalcases-non-sample-isolation: PASS ' + pass + ' / FAIL 0')
