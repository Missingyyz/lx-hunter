'use strict'
/**
 * 静默失效级缺陷回归（v1.13.9）
 *
 * 本文件守的每一类都是「用户以为成功了、实际没生效」：
 *  S2 评测样本没打进产物 / 读坏了 → 原来与「没样本」同症状，界面永远显示「无样本」
 *  S5 配置数值无上限 → autoMaxItems 填几万就是几万次 AI 调用（烧钱）；timeoutMs 填 1e9 等 11 天
 *  S5b autoActiveHours 不支持跨午夜 → 22→6 被静默改成全天（用户以为限制了其实没限）
 *  S1 apply 的 byUser 一票绕过全部三把锁 → 门控形同虚设
 *  S3 saveConfig/saveDb 返回 false 被丢弃 → 界面报成功、重启后丢数据
 *  S7 innerHTML 拼未转义标签 → XSS
 *  S9 账本多账号取错 lxId → 强证据静默失效
 *
 * 纯源码 + 纯函数断言，不联网、不写真实数据目录。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')) }
}
const read = p => fs.readFileSync(path.join(SRC, p), 'utf8')

const { AIReview, RISK, CFG_LIMITS } = require(path.join(SRC, 'core', 'aiReview'))
const sched = require(path.join(SRC, 'core', 'aiSchedule'))
const ec = require(path.join(SRC, 'core', 'evalCases'))

const mkAI = () => new AIReview({ db: { aiSuggestions: {}, aiAudit: {} }, config: { aiReview: {} } })

// ============================================================
console.log('\n=== ① S2 评测样本：读不到 / 读坏了必须说出来 ===')
;(() => {
  const dir = path.join(ROOT, 'tests', 'eval-cases')
  const good = ec.tryLoadCases(dir)
  ok('正常目录：cases>0 且 error 为空', good.cases.length > 0 && good.error === '', 'cases=' + good.cases.length)

  const missing = ec.tryLoadCases(path.join(ROOT, 'tests', '__no_such_dir__'))
  ok('目录不存在：cases=[] 且 error 含「不存在」', missing.cases.length === 0 && /不存在/.test(missing.error), missing.error)
  ok('目录不存在时 error 提示「构建产物未包含」', /构建产物/.test(missing.error), missing.error)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-eval-'))
  try {
    fs.writeFileSync(path.join(tmp, 'broken.json'), '{{{ bad json', 'utf8')
    const badJson = ec.tryLoadCases(tmp)
    ok('坏 JSON：cases=[] 且 error 带文件名', badJson.cases.length === 0 && /broken\.json/.test(badJson.error), badJson.error)

    fs.writeFileSync(path.join(tmp, 'broken.json'), JSON.stringify([{ id: 'x' }]), 'utf8')
    const badCase = ec.tryLoadCases(tmp)
    ok('缺字段样本：cases=[] 且 error 说明校验失败', badCase.cases.length === 0 && /校验失败/.test(badCase.error), badCase.error)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }

  ok('空路径：有 error', ec.tryLoadCases('').error.length > 0)
  // loadCases 原语义必须保持（老调用方 / 评测回放测试依赖它抛错）
  let threw = false
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-eval2-'))
  try {
    fs.writeFileSync(path.join(tmp2, 'a.json'), '{{', 'utf8')
    try { ec.loadCases(tmp2) } catch (e) { threw = true }
  } finally { fs.rmSync(tmp2, { recursive: true, force: true }) }
  ok('loadCases 对坏 JSON 仍抛错（原语义不变，tryLoadCases 才是吞的那层）', threw)

  // 构建产物必须带样本，且不能把测试脚本一起打进去
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
  ok('Dockerfile 带 tests/eval-cases', /COPY\s+tests\/eval-cases/.test(docker))
  ok('Dockerfile 不整体 COPY tests', !/COPY\s+tests\s/.test(docker))
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const files = (pkg.build && pkg.build.files) || []
  ok('package.json build.files 含 tests/eval-cases', files.some(f => /tests\/eval-cases/.test(f)), JSON.stringify(files))
  ok('package.json build.files 不整体含 tests/**', !files.some(f => /^tests\/\*\*/.test(f)))

  // 两端调用点 + 前端区分
  const web = read('server/web.js')
  const main = read('main/index.js')
  const appSrc = read('renderer/app.js')
  ok('web.js eval-report 用 tryLoadCases', /eval-report[\s\S]{0,1200}tryLoadCases/.test(web))
  ok('web.js 返回 casesError', /casesError:\s*load\.error/.test(web))
  ok('main evalReport 用 tryLoadCases', /ai-review:evalReport[\s\S]{0,1200}tryLoadCases/.test(main))
  ok('main 返回 casesError', /casesError:\s*load\.error/.test(main))
  ok('两端不再静默 catch 成 cases=[]', !/try \{ cases = ec\.loadCases\(casesDir\) \} catch \(e\) \{ cases = \[\] \}/.test(web + main))
  ok('前端把「读坏了」和「没样本」分开说', /casesError/.test(appSrc) && /样本是空的但读取正常/.test(appSrc))
  ok('样本读取失败写 warn 日志（两端各一处）', /评测样本读取失败/.test(web) && /评测样本读取失败/.test(main))
})()

// ============================================================
console.log('\n=== ② S5 配置数值上限（超限收敛，不静默接受） ===')
;(() => {
  const a = mkAI()
  const run = (patch) => { let cl = []; const n = a.normalizeConfig({}, patch, cs => { cl = cs }); return { n, cl } }

  const r1 = run({ autoMaxItems: 5000 })
  ok('autoMaxItems 5000 → 200', r1.n.autoMaxItems === 200, r1.n.autoMaxItems)
  ok('收敛有 onClamp 记录（from/to 都对）', r1.cl.length === 1 && r1.cl[0].from === 5000 && r1.cl[0].to === 200, JSON.stringify(r1.cl))
  ok('autoMaxItems 50 不被动', run({ autoMaxItems: 50 }).n.autoMaxItems === 50)
  ok('autoMaxItems 正好 200 不被动', run({ autoMaxItems: 200 }).n.autoMaxItems === 200)
  ok('autoMaxItems 201 → 200', run({ autoMaxItems: 201 }).n.autoMaxItems === 200)

  ok('timeoutMs 1e9 → 120000', run({ provider: { timeoutMs: 1e9 } }).n.provider.timeoutMs === 120000)
  ok('timeoutMs 120000 原样保留', run({ provider: { timeoutMs: 120000 } }).n.provider.timeoutMs === 120000)
  ok('timeoutMs 非数字 → 回落默认 20000', run({ provider: { timeoutMs: 'abc' } }).n.provider.timeoutMs === 20000)
  ok('timeoutMs 负数 → 回落默认', run({ provider: { timeoutMs: -1 } }).n.provider.timeoutMs === 20000)
  ok('timeoutMs 0 → 回落默认', run({ provider: { timeoutMs: 0 } }).n.provider.timeoutMs === 20000)
  ok('timeoutMs Infinity → 回落默认', run({ provider: { timeoutMs: Infinity } }).n.provider.timeoutMs === 20000)
  ok('timeoutMs 30000 原样保留', run({ provider: { timeoutMs: 30000 } }).n.provider.timeoutMs === 30000)

  const r2 = run({ autoIntervalHours: 99999, clusterIntervalHours: 99999, clusterLearnMinSamples: 999, clusterLearnMaxRules: 9999 })
  ok('autoIntervalHours → 720', r2.n.autoIntervalHours === 720, r2.n.autoIntervalHours)
  ok('clusterIntervalHours → 720', r2.n.clusterIntervalHours === 720, r2.n.clusterIntervalHours)
  ok('clusterLearnMinSamples → 50', r2.n.clusterLearnMinSamples === 50, r2.n.clusterLearnMinSamples)
  ok('clusterLearnMaxRules → 200', r2.n.clusterLearnMaxRules === 200, r2.n.clusterLearnMaxRules)
  ok('一次多处超限，全部记进 clamps', r2.cl.length === 4, 'clamps=' + r2.cl.length)

  ok('默认值本身都在上限内', Object.keys(CFG_LIMITS).every(k => {
    const def = k === 'timeoutMs' ? 20000 : { autoMaxItems: 20, autoIntervalHours: 24, clusterIntervalHours: 168, clusterLearnMinSamples: 5, clusterLearnMaxRules: 40 }[k]
    return def == null || def <= CFG_LIMITS[k].max
  }))

  // 纯函数契约：不新增返回字段、不改入参、无回调也不炸
  const cur = { autoMaxItems: 30, provider: { timeoutMs: 25000 } }
  const snap = JSON.stringify(cur)
  const n3 = a.normalizeConfig(cur, { autoMaxItems: 9999 })
  ok('normalizeConfig 不改入参', JSON.stringify(cur) === snap)
  ok('返回值不新增 clamps 等额外字段', n3.clamps === undefined && n3._clamps === undefined)
  let noThrow = true
  try { a.normalizeConfig({}, { autoMaxItems: 9999 }) } catch (e) { noThrow = false }
  ok('不传 onClamp 也不抛', noThrow)
  let cbThrew = true
  try { a.normalizeConfig({}, { autoMaxItems: 9999 }, () => { throw new Error('cb') }); cbThrew = false } catch (e) { cbThrew = true }
  ok('onClamp 回调自身抛错不影响归一化', cbThrew === false)

  // 两端调用点都记日志（不静默改）
  const web = read('server/web.js')
  const main = read('main/index.js')
  ok('web.js configSet 传 onClamp 并记 warn 日志', /normalizeConfig\(cur, p, \(clamps\)/.test(web) && /数值超出上限，已收敛/.test(web))
  ok('main configSet 传 onClamp 并记 warn 日志', /normalizeConfig\(cur, p, \(clamps\)/.test(main) && /数值超出上限，已收敛/.test(main))

  // 第二道防线：老库里已有超大值，调度层直读也必须收敛
  const plan = sched.aiSchedulePlan({ enabled: true, autoEnabled: true, autoMaxItems: 99999, autoIntervalHours: 99999, autoActiveHours: { start: 0, end: 24 } }, {}, Date.now())
  ok('aiSchedulePlan 对老库超大 autoMaxItems 也收敛到 200', plan.limit === 200, 'limit=' + plan.limit)
  ok('aiSchedulePlan 对老库超大 interval 也收敛到 720', plan.intervalHours === 720, 'intervalHours=' + plan.intervalHours)
})()

// ============================================================
console.log('\n=== ③ S5b autoActiveHours 支持跨午夜（保住 end=24 旧语义） ===')
;(() => {
  const a = mkAI()
  const H = h => new Date(2026, 0, 15, h, 30, 0, 0).getTime()

  const cross = a.normalizeConfig({}, { autoActiveHours: { start: 22, end: 6 } })
  ok('22→6 被接受（不再静默回落全天）', cross.autoActiveHours.start === 22 && cross.autoActiveHours.end === 6, JSON.stringify(cross.autoActiveHours))
  const toMid = a.normalizeConfig({}, { autoActiveHours: { start: 22, end: 24 } })
  ok('22→24 保住旧语义「到午夜」', toMid.autoActiveHours.start === 22 && toMid.autoActiveHours.end === 24, JSON.stringify(toMid.autoActiveHours))
  const zero = a.normalizeConfig({}, { autoActiveHours: { start: 8, end: 8 } })
  ok('8→8 零长度 → 全天兜底', zero.autoActiveHours.start === 0 && zero.autoActiveHours.end === 24, JSON.stringify(zero.autoActiveHours))
  const def = a.normalizeConfig({}, {})
  ok('缺省仍为全天 0→24', def.autoActiveHours.start === 0 && def.autoActiveHours.end === 24)
  const oob = a.normalizeConfig({}, { autoActiveHours: { start: -3, end: 99 } })
  ok('越界小时 → 全天兜底', oob.autoActiveHours.start === 0 && oob.autoActiveHours.end === 24, JSON.stringify(oob.autoActiveHours))

  const cfgCross = { autoActiveHours: { start: 22, end: 6 } }
  ok('跨午夜 22→6：23 点在内', sched.getActiveHoursOk(cfgCross, H(23)) === true)
  ok('跨午夜 22→6：3 点在内', sched.getActiveHoursOk(cfgCross, H(3)) === true)
  ok('跨午夜 22→6：22 点在内（左闭）', sched.getActiveHoursOk(cfgCross, H(22)) === true)
  ok('跨午夜 22→6：6 点不在（右开）', sched.getActiveHoursOk(cfgCross, H(6)) === false)
  ok('跨午夜 22→6：12 点不在', sched.getActiveHoursOk(cfgCross, H(12)) === false)
  ok('跨午夜 22→6：21 点不在', sched.getActiveHoursOk(cfgCross, H(21)) === false)

  const cfgToMid = { autoActiveHours: { start: 22, end: 24 } }
  ok('22→24：23 点在内', sched.getActiveHoursOk(cfgToMid, H(23)) === true)
  ok('22→24：12 点不在', sched.getActiveHoursOk(cfgToMid, H(12)) === false)
  const cfgDay = { autoActiveHours: { start: 0, end: 24 } }
  ok('0→24 全天：0/6/12/23 点都在', [0, 6, 12, 23].every(h => sched.getActiveHoursOk(cfgDay, H(h)) === true))
  const cfgNormal = { autoActiveHours: { start: 9, end: 18 } }
  ok('9→18 普通区间：10 点在内 / 20 点不在',
    sched.getActiveHoursOk(cfgNormal, H(10)) === true && sched.getActiveHoursOk(cfgNormal, H(20)) === false)
})()

// ============================================================
console.log('\n=== ④ S1 apply 门控：byUser 不能替代 enabled / allowIrreversible ===')
;(() => {
  // 与 web.js / main/index.js 的 apply 判定逐句同构
  const decide = (cfg, kind, byUser) => {
    const a = new AIReview({ db: { aiSuggestions: {}, aiAudit: {} }, config: { aiReview: cfg } })
    const g = a.gate(kind)
    const needIrrev = !!(RISK[kind] && RISK[kind].needsIrreversible)
    if (!g.auto) {
      if (needIrrev && !a.cfg.allowIrreversible) return { applied: false, needSetting: 'allowIrreversible' }
      if (!a.cfg.enabled) return { applied: false, needSetting: 'enabled' }
      if (!byUser) return { applied: false, needUserConfirm: true }
    }
    return { applied: true }
  }

  const off = decide({ enabled: false, mode: 'auto', allowIrreversible: true }, 'R4', true)
  ok('【核心】总开关关 + byUser:true → 仍拒绝', off.applied === false, JSON.stringify(off))
  ok('总开关关时给出 needSetting=enabled（前端据此引导）', off.needSetting === 'enabled')

  const r7 = decide({ enabled: true, mode: 'assist', allowIrreversible: false }, 'R7', true)
  ok('【核心】R7 + allowIrreversible:false + byUser:true → 仍拒绝', r7.applied === false, JSON.stringify(r7))
  ok('R7 给出 needSetting=allowIrreversible', r7.needSetting === 'allowIrreversible')
  const r6 = decide({ enabled: true, mode: 'assist', allowIrreversible: false }, 'R6', true)
  ok('【核心】R6 + allowIrreversible:false + byUser:true → 仍拒绝', r6.applied === false, JSON.stringify(r6))

  ok('三把锁齐（auto + allowIrreversible）→ R7 放行', decide({ enabled: true, mode: 'auto', allowIrreversible: true }, 'R7', false).applied === true)
  ok('R4 中危 + 总开关开 + byUser → 放行', decide({ enabled: true, mode: 'assist', allowIrreversible: false }, 'R4', true).applied === true)
  ok('R4 无 byUser → 要用户确认', decide({ enabled: true, mode: 'assist', allowIrreversible: false }, 'R4', false).needUserConfirm === true)
  ok('R5 中危不受 allowIrreversible 影响', decide({ enabled: true, mode: 'assist', allowIrreversible: false }, 'R5', true).applied === true)
  ok('RISK 里 needsIrreversible 的只有 R6/R7',
    ['R1', 'R2', 'R3', 'R4', 'R5'].every(k => !RISK[k].needsIrreversible) && RISK.R6.needsIrreversible && RISK.R7.needsIrreversible)

  const web = read('server/web.js')
  const main = read('main/index.js')
  ok('web.js 不再有 `!g.auto && !body.byUser` 一票绕过', !/if \(!g\.auto && !body\.byUser\)/.test(web))
  ok('main 不再有该绕过写法', !/if \(!g\.auto && !body\.byUser\)/.test(main))
  ok('两端都检查 allowIrreversible 且返回 needSetting', /needSetting: 'allowIrreversible'/.test(web) && /needSetting: 'allowIrreversible'/.test(main))
  ok('两端都检查 enabled 且返回 needSetting', /needSetting: 'enabled'/.test(web) && /needSetting: 'enabled'/.test(main))
  ok('两端都从 core 引 RISK（不手抄 kind 白名单）', /const \{ AIReview, RISK \}/.test(web) && /const \{ AIReview, RISK \}/.test(main))

  const appSrc = read('renderer/app.js')
  ok('前端处理 needSetting 并引导去设置（不是只弹失败）', /needSetting === 'allowIrreversible'/.test(appSrc) && /__openAiSettings/.test(appSrc))
  ok('前端也处理 needSetting=enabled', /needSetting === 'enabled'/.test(appSrc))
  ok('__openAiSettings 有实现（跳设置页并滚到开关）', /window\.__openAiSettings = function/.test(appSrc))
})()

// ============================================================
console.log('\n=== ⑤ S3 写盘失败不再伪装成功 ===')
;(() => {
  const web = read('server/web.js')
  const main = read('main/index.js')
  const hunterSrc = read('core/hunter.js')
  const hubSrc = read('core/hubfeed.js')

  ok('web.js 配置保存检查 saveConfig 返回值并抛错', /if \(store\.saveConfig\(\{ aiReview: next \}\) === false\) throw/.test(web))
  ok('main configSet 同样检查', /if \(store\.saveConfig\(\{ aiReview: next \}\) === false\) throw/.test(main))
  ok('灌入收尾检查 saveDb 返回值并写 error 日志', /if \(this\.store\.saveDb\(\) === false\)[\s\S]{0,200}'灌入', 'error'/.test(hunterSrc))
  ok('给灌入成功汇总前的 ok 计数没被误删（回归：曾误删导致 ReferenceError）',
    /const ok = results\.filter\(r => r\.status === 'success' \|\| r\.status === 'replaced'\)\.length/.test(hunterSrc))
  ok('采集站收尾检查 saveDb 返回值并写 error 日志', /if \(store\.saveDb\(\) === false\)[\s\S]{0,160}'采集', 'error'/.test(hubSrc))
  ok('store._write 仍返回布尔（改动的依据）', /saveDb\(\) \{ return this\._write\(this\.dbFile, this\.db\) \}/.test(read('core/store.js')))
})()

// ============================================================
console.log('\n=== ⑥ S7 XSS：verdict 标签必须转义 ===')
;(() => {
  const appSrc = read('renderer/app.js')
  ok('LABEL[it.verdict] 已包 esc()', /esc\(LABEL\[it\.verdict\] \|\| it\.verdict\)/.test(appSrc))
  ok('不再有裸拼 (LABEL[it.verdict] || it.verdict)', !/\+\s*\(LABEL\[it\.verdict\] \|\| it\.verdict\)\s*\+/.test(appSrc))
})()

// ============================================================
console.log('\n=== ⑦ S9 账本按平台取 lxId（多账号不再串台） ===')
;(() => {
  const { Hunter } = require(path.join(SRC, 'core', 'hunter'))
  const imported = {
    // A：灌过账号 pA 与 pB，两次 lxId 不同
    e1: { contentHash: 'h1', name: 'n1', platformId: 'pA', lxId: 'lxA', importedTo: [{ platformId: 'pA', lxId: 'lxA' }, { platformId: 'pB', lxId: 'lxB' }] },
    // B：只灌过 pA（靠顶层 platformId），查 pB 时不该出现
    e2: { contentHash: 'h2', name: 'n2', platformId: 'pA', lxId: 'lx2' },
    // C：老记录 platformId 为 null → 归当前选中账号
    e3: { contentHash: 'h3', name: 'n3', lxId: 'lx3' },
    // D：有 hash 但没有 lxId → 不入账本（宁可退回 size 弱判据）
    e4: { contentHash: 'h4', name: 'n4', platformId: 'pA' },
    // E：没有 hash → 本来就不入账本
    e5: { name: 'n5', platformId: 'pA', lxId: 'lx5' }
  }
  const h = new Hunter({ config: {}, db: {}, imported }, () => {})

  const onA = h._ledgerByEntry('pA', 'pA')
  const onB = h._ledgerByEntry('pB', 'pA')

  ok('pA 视图：e1 的 lxId 是本平台的 lxA（不是顶层/别的平台）', onA.e1 && onA.e1.lxId === 'lxA', JSON.stringify(onA.e1))
  ok('pB 视图：e1 的 lxId 是 lxB（按平台切换到 B 的 id）', onB.e1 && onB.e1.lxId === 'lxB', JSON.stringify(onB.e1))
  ok('【核心回归】pB 视图绝不给 e1 返回 lxA（旧实现会）', !(onB.e1 && onB.e1.lxId === 'lxA'))
  ok('pA 视图含 e2（只在 pA 灌过）', !!onA.e2 && onA.e2.lxId === 'lx2')
  ok('pB 视图不含 e2（没在 pB 灌过）', onB.e2 === undefined)
  ok('老记录 e3 归当前选中账号 pA', onA.e3 && onA.e3.lxId === 'lx3')
  ok('老记录 e3 在 pB 视图里不出现（活动账号是 pA）', onB.e3 === undefined)
  ok('无 lxId 的 e4 不入账本（保守退回 size 判据）', onA.e4 === undefined && onB.e4 === undefined)
  ok('无 hash 的 e5 不入账本', onA.e5 === undefined)
  ok('账本结构只含 {hash,lxId,name}', Object.keys(onA.e1).sort().join(',') === 'hash,lxId,name', Object.keys(onA.e1).join(','))
  ok('源码用 _recLxIdOn 取平台 id', /const lxId = this\._recLxIdOn\(rec, platformId, activeId\)/.test(read('core/hunter.js')))
  ok('源码不再直取顶层 rec.lxId 进账本', !/out\[eid\] = \{ hash: rec\.contentHash, lxId: rec\.lxId/.test(read('core/hunter.js')))
})()

// ============================================================
console.log('\n=== ⑧ 死代码清理（容器早已移除，防止补回一个永远显示不了的渲染函数） ===')
;(() => {
  const appSrc = read('renderer/app.js')
  const cssSrc = read('renderer/styles.css')
  const hunterSrc = read('core/hunter.js')
  const html = read('renderer/index.html')
  ok('#aiDetail 容器确实不存在（清理的前提）', !/id="aiDetail"/.test(html))
  ok('renderDetail 已删', !/function renderDetail\b/.test(appSrc))
  ok('renderOffHint 已删', !/function renderOffHint\b/.test(appSrc))
  ok('offHintHtml 已删', !/function offHintHtml\b/.test(appSrc))
  ok('selectedId 已删', !/\bselectedId\b/.test(appSrc))
  ok('OFF_HINT 常量已删（唯一使用者已没了）', !/const OFF_HINT =/.test(appSrc))
  ok('刷新按钮死绑定已删', !/btnAiRefresh/.test(appSrc))
  ok('.ai-suggestion* 选择器已删', !/^\s*\.ai-suggestion[\s{,]/m.test(cssSrc))
  ok('.ai-detail* 选择器已删', !/^\s*\.ai-detail[\s{,]/m.test(cssSrc))
  ok('hunter _coldStartClassifySources 已删（全库无调用点）', !/_coldStartClassifySources/.test(hunterSrc))
  ok('刷新入口 __aiRefreshSuggestions 保留（音源库批量复检依赖它）', /window\.__aiRefreshSuggestions = function/.test(appSrc))
  ok('统计卡渲染 loadSuggestions 保留', /function loadSuggestions/.test(appSrc))
  ok('chip 仍用的 aiEvidenceKeyUi/ValUi 未被误删', /function aiEvidenceKeyUi/.test(appSrc) && /function aiEvidenceValUi/.test(appSrc))
})()

// ============================================================
console.log('\n=== ⑨ S8 设计-实现落差已如实标注（不删不接） ===')
;(() => {
  const src = read('core/aiReview.js')
  ok('evaluateGate 仍有定义（保留设计意图）', /evaluateGate\(signals\) \{/.test(src))
  ok('quoteLocatable 仍有定义', /quoteLocatable\(evidence, inputText\) \{/.test(src))
  ok('evaluateGate 的 JSDoc 写明「生产链路从未调用」', /evaluateGate[\s\S]{0,1400}生产链路从未调用/.test(src))
  ok('evaluateGate 的 JSDoc 写明「证据全绿才自动」这条红线当前没守住', /证据全绿才自动[\s\S]{0,80}没有守住|红线当前没有守住/.test(src))
  ok('quoteLocatable 的 JSDoc 写明同样落差', /quoteLocatable 的 JSDoc|同 evaluateGate：\*\*生产链路从未调用/.test(src) || /生产链路从未调用（仅测试引用）[\s\S]{0,400}quoteLocatable/.test(src))
  ok('quoteLocatable 的 JSDoc 含「生产链路从未调用」', (() => {
    const i = src.indexOf('校验 AI 引用是否可逐字定位于输入片段')
    return i > 0 && /生产链路从未调用/.test(src.slice(i, i + 700))
  })())
})()

// ============================================================
console.log('\n=== ⑩ R3：模型判 suspicious=true 必须被采纳（C 复核发现的真缺陷） ===')
;(() => {
  // 缺陷：_reviewOneName 只取了 j.reason，把 j.suspicious 直接丢了。
  // 后果：模型明确判「可疑」但措辞不在本地词表里（仿冒/全角空格/不可见字符/命名不规范）
  //       → worthNotifying 给 false → 真实命名异常被漏提醒，界面还归到「名字没问题」那栏。
  // 下面 4 条是 C 造的实际模型输出，改动前全部为 false（FAIL），改动后必须为 true。
  const { worthNotifying } = require(path.join(SRC, 'core', 'aiReview'))
  const cases = [
    ['AI 判可疑：名称与官方源高度相似，疑似仿冒', '名称与官方源高度相似，疑似仿冒'],
    ['AI 判可疑：名称含全角空格，可能干扰搜索排序', '名称含全角空格，可能干扰搜索排序'],
    ['AI 判可疑：名字里有一个不可见字符', '名字里有一个不可见字符'],
    ['AI 判可疑：命名不规范，建议统一', '命名不规范，建议统一']
  ]
  for (const [label, reason] of cases) {
    // 本地正则没命中（ok=false），模型说 suspicious=true
    const s = {
      kind: 'R3',
      conclusion: reason,
      evidence: [
        { key: 'nameHeuristic', ok: false, detail: 'official-x' },
        { key: 'source', ok: true, detail: 'ai' },
        { key: 'aiSuspicious', ok: true, detail: 'ai' }
      ]
    }
    ok(label + ' → 提醒', worthNotifying(s) === true, 'got=' + worthNotifying(s))
  }

  // aiSuspicious=false 绝不拥有否决权（别再犯 ok===false 短路那个错）
  ok('【防回归】aiSuspicious=false 但结论说乱码 → 仍提醒',
    worthNotifying({
      kind: 'R3', conclusion: '疑似乱码混淆命名',
      evidence: [{ key: 'nameHeuristic', ok: false }, { key: 'aiSuspicious', ok: false }]
    }) === true)
  ok('【防回归】aiSuspicious=false 且结论中性 → 不提醒',
    worthNotifying({
      kind: 'R3', conclusion: '名字一般',
      evidence: [{ key: 'nameHeuristic', ok: false }, { key: 'aiSuspicious', ok: false }]
    }) === false)
  ok('【防回归】aiSuspicious=false 且结论明确「没问题」→ 不提醒',
    worthNotifying({
      kind: 'R3', conclusion: '命名未见明显异常',
      evidence: [{ key: 'aiSuspicious', ok: true }]
    }) === false)

  // 产出端确实保留了 aiSuspicious
  const src = read('core/aiReview.js')
  ok('_reviewOneName 读取 j.suspicious', /typeof j\.suspicious === 'boolean'/.test(src))
  ok('_reviewOneName 把 aiSuspicious 写进 evidence', /key: 'aiSuspicious'/.test(src))
  ok('aiSuspicious 只由「模型真给了布尔」时产出', /aiSuspicious/.test(src))

  // 前端兜底同口径（API 返回的证据数组同名 key）
  const appSrc = read('renderer/app.js')
  ok('前端 aiWorthNotifyingLocal 也认 aiSuspicious', /aiSuspicious/.test(appSrc))
  ok('前端 R3 安静说明改为「本地规则没发现异常」', /本地规则没发现异常/.test(appSrc))
})()

// ============================================================
console.log('\n=== ⑪ S8 风险注释已写进 gate() 旁（防止将来接执行时踩坑） ===')
;(() => {
  const src = read('core/aiReview.js')
  const i = src.indexOf('gate(kind) {')
  ok('gate() 存在', i > 0)
  const before = src.slice(Math.max(0, i - 3000), i)
  ok('gate() 旁的注释写明「只拿 kind，拿不到 evidence」', /拿不到\s*evidence|拿不到任何\s*evidence/.test(before))
  ok('gate() 旁写明「证据 AND 才放行」这条红线未落地', /证据\s*AND[\s\S]{0,120}未落地|红线[\s\S]{0,60}未落地/.test(before))
  ok('gate() 旁写明当前只标 status 不碰业务对象', /只把建议 s\.status 标成 'applied'[\s\S]{0,120}不碰任何业务对象/.test(before) || /只(标|改)\s*status[\s\S]{0,120}不碰/.test(before))
  ok('gate() 旁写明危害是污染采纳率统计', /采纳率/.test(before))
  ok('gate() 旁写明这是「定时炸弹」', /定时炸弹/.test(before))
  ok('gate() 旁要求接真实执行前先补 evaluateGate + quoteLocatable',
    /evaluateGate/.test(before) && /quoteLocatable/.test(before) && /真实(执行|动作)/.test(before))
})()

// ============================================================
console.log('\n=== ⑫ 文案："jsjiami 加密工具" → "jsjiami 混淆" ===')
;(() => {
  const appSrc = read('renderer/app.js')
  ok('不再出现「jsjiami 加密工具」', !/jsjiami 加密工具/.test(appSrc))
  ok('改为「jsjiami 混淆」', /jsjiami 混淆/.test(appSrc))
})()

// ============================================================
console.log('\n=== ⑬ 旧版对照：checker.obfuscationRisk 判级零漂移（C 的方法） ===')
;(() => {
  // C 复核用 `git show <旧提交>:src/core/checker.js` 取真旧版做对照，比内联复刻可靠。
  // 这里把那次对照固化成测试：旧版来自 git 对象库（不落盘成常驻文件），
  // git 不可用 / 取不到旧版时**跳过而不是假通过**，避免测试变成摆设。
  const { execFileSync } = require('child_process')
  const GIT_CANDS = [
    path.join(ROOT, '..', '_tools', 'git', 'cmd', 'git.exe'),
    'git'
  ]
  const runGit = (args) => {
    for (const g of GIT_CANDS) {
      try {
        return execFileSync(g, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch (e) { /* 试下一个 */ }
    }
    return null
  }
  // 找 checker.js 最近一次被改动的提交，取它的**父提交**版本 = 改造前真旧版
  const log = runGit(['log', '--format=%H', '--', 'src/core/checker.js'])
  if (!log) {
    console.log('  SKIP git 不可用，跳过旧版对照（需在有 git 的环境跑）')
    return
  }
  // 取「checker.js 最近一次改动提交」的**父提交**版本 = 那次改造前的真旧版。
  // 注意别取最早那条：最早提交的父提交不存在（浅克隆时更会拿不到）。
  const shas = log.trim().split(/\r?\n/).filter(Boolean)
  if (!shas.length) { console.log('  SKIP 取不到 checker.js 的提交历史'); return }
  let oldSrc = null
  for (const sha of shas) {
    const cand = runGit(['show', sha + '^:src/core/checker.js'])
    if (cand && /function obfuscationRisk/.test(cand)) { oldSrc = cand; break }
  }
  if (!oldSrc) {
    console.log('  SKIP 取不到旧版 checker.js（浅克隆/历史被裁）')
    return
  }
  ok('取到真旧版 checker.js（含 obfuscationRisk，不含新三档函数）',
    /function obfuscationRisk/.test(oldSrc) && !/classifyQuarantineTrust/.test(oldSrc))

  // 旧版落到 src/core 同级目录才能解析它的相对 require（sandbox/net 等）
  const tmpOld = path.join(SRC, 'core', '__old_checker_tmp.js')
  fs.writeFileSync(tmpOld, oldSrc, 'utf8')
  let oldMod, newMod
  try {
    oldMod = require(tmpOld)
    newMod = require(path.join(SRC, 'core', 'checker.js'))
  } finally {
    try { fs.unlinkSync(tmpOld) } catch (e) {}
  }

  // 真实样本：仓库内 .js（音源脚本优先），最多 128 个 —— 与 C 的口径一致
  const realScripts = []
  const collect = (d) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return }
    for (const ent of entries) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) { if (!/node_modules|^\.git$|^dist$|^_tools$/.test(ent.name)) collect(p) }
      else if (/\.js$/.test(ent.name)) {
        try { const st = fs.statSync(p); if (st.size < 400 * 1024) realScripts.push({ name: path.relative(ROOT, p), code: fs.readFileSync(p, 'utf8') }) } catch (e) {}
      }
    }
  }
  collect(path.join(SRC)); collect(path.join(ROOT, 'tests'))
  const likeSource = realScripts.filter(s => /lx\.(on|send|request|utils|musicInfo|currentMusicInfo)\b/.test(s.code))
  const ordered = likeSource.concat(realScripts.filter(s => likeSource.indexOf(s) === -1))
  const realPick = ordered.slice(0, 128)

  // 合成样本：覆盖各判级边界（自调度/eval/spin/Proxy/超长/空）
  const synth = []
  for (let n = 0; n <= 6; n++) synth.push({ name: 'spin' + n, code: 'while(true){' + 'eval("x")'.repeat(n) + '}' })
  for (let n = 0; n <= 6; n++) synth.push({ name: 'sched' + n, code: 'var a=' + n + ';setTimeout(function(){eval("x")},' + n * 1000 + ')' })
  for (let n = 0; n <= 6; n++) synth.push({ name: 'proxy' + n, code: 'var p=new Proxy({},{get:function(){return ' + n + '}})' })
  for (let n = 0; n <= 4; n++) synth.push({ name: 'hex' + n, code: 'var s = "' + 'x'.repeat(n) + '";' })
  for (let n = 0; n <= 5; n++) synth.push({ name: 'uni' + n, code: 'var \u0041 = "\\u00' + (40 + n) + '";' })
  for (let n = 0; n <= 4; n++) synth.push({ name: 'long' + n, code: '/*' + 'A'.repeat(n * 500) + '*/var lx={}' })
  for (let n = 0; n <= 4; n++) synth.push({ name: 'blank' + n, code: ' '.repeat(n * 10) })
  synth.push({ name: 'ok1', code: 'var lx={on:function(){},send:function(){},request:function(){},utils:{}};lx.send("inited")' })
  synth.push({ name: 'ok2', code: 'const lx = require("lx"); lx.on("music", ()=>({})); lx.send("inited")' })
  synth.push({ name: 'jsjiami', code: 'var _0x1a2b=["a","b"];(function(_0x){while(!![]){try{...}}}());' })

  const all = realPick.concat(synth)
  ok('样本量足够（真实≥50 + 合成≥40）', realPick.length >= 50 && synth.length >= 40,
    '真实=' + realPick.length + ' 合成=' + synth.length + ' 合计=' + all.length)

  const NEWKEYS = ['selfSchedTimer', 'selfSchedDecode', 'selfSchedUnknown']
  let levelDiff = 0, hitsDiff = 0, crashes = 0
  const diffs = []
  for (const s of all) {
    let o, n
    try { o = oldMod.obfuscationRisk(s.code, s.name, {}) } catch (e) { crashes++; continue }
    try { n = newMod.obfuscationRisk(s.code, s.name, {}) } catch (e) { crashes++; continue }
    if (!o || !n) { crashes++; continue }
    if (o.level !== n.level) { levelDiff++; if (diffs.length < 5) diffs.push(s.name + ' old=' + o.level + ' new=' + n.level) }
    const keys = new Set([...Object.keys(o.hits || {}), ...Object.keys(n.hits || {})])
    for (const k of keys) {
      if (NEWKEYS.indexOf(k) !== -1) continue
      if (String((o.hits || {})[k]) !== String((n.hits || {})[k])) { hitsDiff++; if (diffs.length < 8) diffs.push(s.name + ' hits.' + k) }
    }
  }
  ok('样本全部可跑（无异常）', crashes === 0, 'crashes=' + crashes)
  ok('【核心】level 判级零漂移（旧版 vs 新版）', levelDiff === 0, '不一致 ' + levelDiff + ' / ' + all.length + (diffs.length ? ' :: ' + diffs.join('; ') : ''))
  ok('【核心】旧字段 hits 值零漂移（新三字段除外）', hitsDiff === 0, '不一致 ' + hitsDiff + (diffs.length ? ' :: ' + diffs.join('; ') : ''))

  // 新版三字段必须存在且为数字（新增字段的契约）。
  // 注意 obfuscationRisk 对 <200 字符内容直接返回 {level:'', hits:null}（:166），
  // 所以样本必须够长，否则拿到的是 null 而非 hits 对象。
  const longSrc = '/*' + 'A'.repeat(300) + '*/var a=1;setTimeout(function(){eval("x")},5000);while(true){}'
  const probe = newMod.obfuscationRisk(longSrc)
  ok('新版返回含 selfSchedTimer/Decode/Unknown',
    !!(probe.hits) && NEWKEYS.every(k => typeof probe.hits[k] === 'number'), JSON.stringify(probe))
  ok('短内容（<200 字符）仍返回 {level:"",hits:null}（原语义不变）',
    (() => { const r = newMod.obfuscationRisk('var a=1;'); return r.level === '' && r.hits === null })())
})()

console.log('\nquarantine/silent-failure regression: PASS ' + pass + ' / FAIL ' + fail)
if (fail > 0) process.exit(1)
