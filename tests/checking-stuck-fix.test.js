'use strict'
/**
 * checking 卡死修复回归（2026-11-22）
 *
 * 现象：生产 8191 豆包 release v9.1.2 一直显示「检测中…」，重启才消失。
 * 根因：runCheck 单条处理里，同名对决证据不完整时走 :3374 的 `continue`，
 *       该 continue 在 try 块内，跳过了块尾的 `delete e.checking`，标记永久残留。
 * 修法：把清 checking 放进 finally，任何 continue/return/异常路径都清。
 *
 * 本测试用真实 Store + Hunter，stub checkBasic/deepCheck，造两条同名豆包且
 * deep 带 untested 平台（触发 _deepIncomplete → continue），断言两条 checking 都被清。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const checker = require('../src/core/checker')

checker.checkBasic = async (e) => { e.status = 'ok'; e.suspected = true; e.error = ''; return { code: 'SCRIPT_' + e.id } }
checker.deepCheck = async (e) => ({
  loadable: true, cancelled: false, loadError: null,
  platforms: {
    wy: { status: 'usable', message: 'ok' },
    kg: { status: 'untested', message: 'quick 模式未测' }   // 触发 _deepIncomplete
  },
  usable: 1, hash: e.contentHash, checkedAt: Date.now()
})
delete require.cache[require.resolve('../src/core/hunter')]
const { Hunter } = require('../src/core/hunter')
const { Store, DEFAULT_CONFIG } = require('../src/core/store')

let pass = 0, fail = 0
const ck = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n) } else { fail++; console.log('FAIL  ' + n + (x ? '  -> ' + x : '')) } }

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-checking-stuck-'))
  const store = new Store(dir)
  store.config = Object.assign({}, DEFAULT_CONFIG, store.config, {
    skipChecked: false, apiHostCheck: false, excludeHighRiskObfuscated: false,
    concurrency: 1, autoFollowScriptUpdate: false, autoDeepPendingDuels: false
  })
  for (let i = 1; i <= 2; i++) {
    const id = 'db' + i
    store.db.sources[id] = {
      id, name: '豆包定制[聚合音源]', lxName: '豆包定制[聚合音源]',
      url: 'https://example.com/doubao' + i + '.js',
      status: 'ok', usable: false, contentHash: 'hash' + i
    }
  }
  const hunter = new Hunter(store)
  await hunter.runCheck(['db1', 'db2'])

  const c1 = store.db.sources.db1.checking
  const c2 = store.db.sources.db2.checking
  ck('同名对决 continue 路径：db1 不残留 checking', !c1, 'checking=' + c1)
  ck('同名对决 continue 路径：db2 不残留 checking', !c2, 'checking=' + c2)
  ck('两条都检测完成（status=ok）', store.db.sources.db1.status === 'ok' && store.db.sources.db2.status === 'ok')

  console.log('\nchecking-stuck-fix: PASS ' + pass + ' / FAIL ' + fail)
  if (fail) process.exit(1)
})().catch(e => { console.error('ERROR', e); process.exit(1) })
