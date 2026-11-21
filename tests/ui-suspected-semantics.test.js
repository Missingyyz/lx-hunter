'use strict'
/**
 * P0-4：界面「疑似」徽章语义（suspected 是正向音源特征打分，不是「可疑」）
 *
 * 背景：
 *   checker.js:136  classifyEntry = scoreEntry(...) >= 4
 *   checker.js:116  scoreEntry 是**正向**打分（名字含「音源/source」+2、globalThis.lx +3、
 *                   lx.request +2 …）⇒ 分越高越像音源 ⇒ suspected===true 表示「像音源」。
 *   而 sorters.js:17 isCheckedNoSource 是 `!e.suspected`，表示「测过了、判定不是音源」。
 *   这两者方向相反，旧界面却都渲染成黄色「疑似」（且 suspected 那条没有 tooltip），
 *   用户既看不出方向，也读不出该做什么。
 *
 * 本测试守住：
 *   ① 两个徽章文案必须不同、且方向可辨（像音源 vs 不像音源）
 *   ② suspected 那条必须有 tooltip（旧代码它是空的）
 *   ③ 统计卡 / 筛选 / 导出范围必须把两者分开，不能再合成一档
 *   ④ 日志侧保持技术表述（suspected / 音源特征），不能跟着改成大白话
 *   ⑤ 不动 suspected 定义、不动 checker.js、不动 isCheckedNoSource 判定
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

const ROOT = path.join(__dirname, '..')
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
const sorterSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'sorters.js'), 'utf8')
const hunterSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'hunter.js'), 'utf8')
const checkerSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'checker.js'), 'utf8')

/** 取函数体（按函数名定位，避免命中别处）。兼容 `function f (` 与 `function f(` 两种写法。 */
function bodyOf (src, name) {
  const i = src.search(new RegExp('function\\s+' + name + '\\s*\\('))
  if (i < 0) return ''
  // 大括号配平
  const start = src.indexOf('{', i)
  let d = 0
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') d++
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(start, j + 1) }
  }
  return ''
}

console.log('=== ① 两个状态徽章：文案必须方向可辨、且都有 tooltip ===')
;(() => {
  // F1 形态提醒改动后：suspected/isCheckedNoSource 徽章逻辑在 statusCellBase，
  // statusCell 变成只加矛盾态小标的包装器（读 e.veto/e.lastPatrol）。徽章断言应提取 base。
  const body = bodyOf(appSrc, 'statusCellBase')
  ok(body.length > 0, '能取到 statusCellBase 函数体（徽章逻辑所在）')

  // 找 suspected 分支与 isCheckedNoSource 分支的返回语句
  const susLine = (body.match(/if \(e\.suspected\)[\s\S]*?<\/span>'/) || [''])[0]
  const noSrcLine = (body.match(/if \(isCheckedNoSource\(e\)\)[\s\S]*?<\/span>'/) || [''])[0]
  ok(susLine.includes('e.suspected'), '定位到 e.suspected 徽章分支')
  ok(noSrcLine.includes('isCheckedNoSource'), '定位到 isCheckedNoSource 徽章分支')

  // ①-1 suspected 分支必须有 tooltip（旧代码 `<span class="badge warn">疑似</span>` 没有）
  ok(susLine.includes('title="'), '【核心·P0-4】suspected 徽章带 tooltip（旧代码没有，用户点上去什么都没有）')
  // ①-2 两条文案不能相同
  const susText = (susLine.match(/>([^<>]+)<\/span>'/) || [])[1] || ''
  const noSrcText = (noSrcLine.match(/>([^<>]+)<\/span>'/) || [])[1] || ''
  ok(susText && noSrcText && susText !== noSrcText,
    '【核心·P0-4】两个徽章文案不同（旧代码都是「疑似」）：' + JSON.stringify(susText) + ' vs ' + JSON.stringify(noSrcText))
  // ①-3 方向可辨：suspected=像音源；isCheckedNoSource=不像音源
  ok(/疑似音源/.test(susText) && /未检测/.test(susText),
    'suspected 文案表达「像音源 + 还没检测」：' + susText)
  ok(/不像音源|非音源/.test(noSrcText) && /已检测/.test(noSrcText),
    'isCheckedNoSource 文案表达「已检测 + 不是音源」：' + noSrcText)
  // ①-4 不能再出现无修饰的裸「疑似」徽章
  ok(!/>疑似<\/span>/.test(body), '【核心·P0-4】不再有裸「疑似」徽章')
  // ①-5 视觉上也要能区分（一个是 warn 一个不是 warn），否则光看颜色还是一样
  ok(/badge warn/.test(susLine) && !/badge warn/.test(noSrcLine),
    '两者徽章颜色不同（suspected=warn 需处理；不像音源=中性，不是警告）')
})()

console.log('\n=== ② validTier 标签与徽章口径统一 ===')
;(() => {
  const i = appSrc.indexOf('function vtLabel')
  const body = appSrc.slice(i, i + 600)
  ok(/probable.*疑似音源/.test(body), 'vtLabel(probable) 与状态徽章统一成「疑似音源·…」口径（原来是「疑似未测」）')
})()

console.log('\n=== ③ 统计卡 / 筛选 / 导出：两个方向必须分开 ===')
;(() => {
  // ③-1 统计卡不再把两者加起来
  const stLine = (appSrc.match(/\$\('stSuspected'\)\.textContent = [^\n]+/) || [''])[0]
  ok(stLine.length > 0, '定位到 stSuspected 统计')
  ok(!/e\.suspected \|\| isCheckedNoSource/.test(stLine),
    '【核心·P0-4】统计卡不再把「像音源」和「不像音源」加成一个数')
  ok(/stNotSource/.test(appSrc), '【核心·P0-4】新增独立的「已检测·不像音源」统计（stNotSource）')
  ok(/id="stNotSource"/.test(htmlSrc), 'index.html 里有 stNotSource 卡片')

  // ③-2 筛选页签拆成两个
  ok(/case 'suspected':[^\n]*e\.suspected\)/.test(appSrc) && !/case 'suspected':[^\n]*isCheckedNoSource/.test(appSrc),
    '【核心·P0-4】筛选 suspected 只匹配 e.suspected（不再混入 isCheckedNoSource）')
  ok(/case 'notSource':/.test(appSrc), '新增筛选档 notSource')
  ok(/data-f="notSource"/.test(htmlSrc), 'index.html 有 notSource 筛选按钮')
  ok(/value="notSource"/.test(htmlSrc), 'index.html 有 notSource 导出选项')

  // ③-3 导出标签说人话
  ok(/suspected: '疑似音源·未检测'/.test(appSrc) && /notSource: '已检测·不像音源'/.test(appSrc),
    '导出范围的中文标签与徽章口径一致（不再是裸的「疑似」）')
})()

console.log('\n=== ④ 日志侧保持技术表述（不跟着改大白话）===')
;(() => {
  // hunter.js 的统计日志应保留 noSource / 非音源 这类技术口径，不能改成「不像音源」这种界面词
  ok(/notSource\+\+/.test(hunterSrc) && /缺少洛雪音源特征/.test(hunterSrc),
    'hunter.js 统计变量/注释保留技术表述（notSource + 缺少洛雪音源特征）')
  ok(!/this\.log\([^)]*不像音源/.test(hunterSrc),
    '【核心·P0-4】日志里没有把 suspected 说成界面词「不像音源」')
  // checker.js 的注释仍是专业口径
  ok(/音源疑似度打分/.test(checkerSrc) && /scoreEntry/.test(checkerSrc),
    'checker.js 保持「音源疑似度打分 / scoreEntry」专业表述（未被改成大白话）')
})()

console.log('\n=== ⑤ 语义定义未被改动（只改显示）===')
;(() => {
  ok(/function classifyEntry\s*\([^)]*\)\s*\{\s*return scoreEntry\([^)]*\)\s*>=\s*4\s*\}/.test(checkerSrc),
    '【核心】checker.classifyEntry 仍是 scoreEntry(...) >= 4（未取反、未改动）')
  ok(/const isCheckedNoSource = e => !!e\.lastCheck && e\.status === 'ok' && !e\.suspected && !e\.deep/.test(sorterSrc),
    '【核心】sorters.isCheckedNoSource 判定逻辑一字未改（只改了注释）')
  ok(/entry\.suspected = score >= 4/.test(checkerSrc),
    '【核心】checker 里 suspected 赋值仍是 score >= 4')
})()

console.log('\n=== ⑥ 缓存戳同步（改 app.js 必须 bump） ===')
;(() => {
  ok(/app\.js\?v=102/.test(htmlSrc), 'index.html 缓存戳已 bump 到 app.js?v=102')
  ok(/sorters\.js\?v=30/.test(htmlSrc), 'index.html 缓存戳已 bump 到 sorters.js?v=30')
  for (const f of ['crawl-releases.test.js', 'external-source.test.js', 'proxy-policy.test.js']) {
    const s = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8')
    ok(/app\.js\?v=102/.test(s) && !/app\.js\?v=101/.test(s), f + ' 缓存戳断言已同步到 v102')
  }
})()

console.log('\nui-suspected-semantics: PASS ' + pass + ' / FAIL 0')
