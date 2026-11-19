'use strict'
/**
 * web.js：配置写盘失败必须被报出来（不能静默成功）
 *
 * ============================================================================
 * 问题
 * ============================================================================
 * `src/server/web.js` 的 POST /api/config 直接 `store.saveConfig(ctx.body)`，
 * **忽略返回值**。而 `src/core/store.js` 的 `_write(f, obj)` 返回 true/false：
 * 磁盘满 / 目录权限不足 → false。
 * 结果：用户点了「保存」，界面提示成功，**配置其实一个字都没落盘**——
 * 重启后全部回到旧值，而且**没有任何日志**说明发生过这件事。
 *
 * ============================================================================
 * 本测试怎么验证（不联网、不起真服务、不占端口）
 * ============================================================================
 * web.js 是个「require 就 listen」的脚本，直接 require 会占端口 + 在 DATA_DIR 建库，
 * 测试不能有这种副作用。所以：
 *   ① **源码级**：断言关键代码形态（检查返回值 / 抛错 / 记 error 日志），
 *      防有人把保护逻辑悄悄删掉。
 *   ② **行为级**：从 web.js 源码里**切出** POST /api/config 那个 route(...) 片段，
 *      在 vm 沙箱里用假 route/guard/store/pushLog 跑它——
 *      跑的是**生产源码本身**，不是复刻品。
 *      沙箱里的 guard 按 web.js 的真实语义复刻（catch → {ok:false,error} + X-Lxh-Error 头）。
 */
const path = require('path')
const fs = require('fs')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const WEB = path.join(ROOT, 'src', 'server', 'web.js')

let pass = 0
let fail = 0
const fails = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; fails.push(name + (extra ? '  :: ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')) }
}

// ============================================================================
console.log('\n=== ① 源码级：web.js 的配置保存必须检查 saveConfig 返回值 ===')
// ============================================================================
{
  const src = fs.readFileSync(WEB, 'utf8')
  const idx = src.indexOf("route('POST', '/api/config'")
  ok('找到 POST /api/config 路由', idx >= 0)
  const block = idx >= 0 ? src.slice(idx, idx + 3000) : ''
  ok('调用了 store.saveConfig(...)', /store\.saveConfig\(/.test(block))
  ok('★ 检查了返回值（=== false）', /store\.saveConfig\([^)]*\)\s*===\s*false/.test(block),
    block.slice(0, 400).replace(/\n/g, ' | '))
  ok('★ 写盘失败时抛错（不静默成功）',
    /saveConfig[^)]*\)\s*===\s*false[\s\S]{0,500}?throw new Error/.test(block))
  ok('★ 写盘失败时记 error 级日志',
    /saveConfig[^)]*\)\s*===\s*false[\s\S]{0,500}?pushLog\([\s\S]{0,240}?level:\s*'error'/.test(block))
  ok('日志文案点明「没有保存成功」（用户看得懂）', /没有保存成功/.test(block))
  ok('抛错文案点明原因（磁盘/权限）', /写盘失败/.test(block))
  // 反向断言：不能只记日志却继续当成功（必须抛错）
  ok('★ 不是「只记日志不抛错」', /saveConfig[^)]*\)\s*===\s*false[\s\S]{0,500}?throw new Error/.test(block))
}

// ============================================================================
console.log('\n=== ② 行为级：把 /api/config 的处理逻辑抽出来跑一遍 ===')
// ============================================================================
async function behaviourPart () {
  const src = fs.readFileSync(WEB, 'utf8')
  const start = src.indexOf("route('POST', '/api/config'")
  ok('定位到 POST /api/config', start >= 0)

  let end = src.indexOf("\nroute('", start + 10)
  if (end < 0) end = src.length
  const snippet = src.slice(start, end)
  ok('切出的片段包含 saveConfig 调用', /store\.saveConfig\(/.test(snippet), 'len=' + snippet.length)

  /**
   * 跑一次 POST /api/config 的 handler。
   * @param {boolean} writeFails store.saveConfig 返回 false（模拟写盘失败）
   * @returns {Promise<{resp:object|null, logs:Array, saved:Array, headers:object}>}
   */
  function runConfigPost (writeFails) {
    const logs = []
    const saved = []
    const headers = {}
    const fakeStore = {
      config: { crawlProxy: 'http://old', proxyPolicy: 'auto' },
      saveConfig (patch) {
        saved.push(patch)
        if (writeFails) return false
        Object.assign(this.config, patch)
        return true
      }
    }
    let handler = null
    let resp = null
    const sandbox = {
      store: fakeStore,
      pushLog: (e) => logs.push(e),
      currentUser: () => ({ name: 'admin', admin: true }),
      assertAdmin: () => {},
      // guard：按 web.js 的真实语义复刻（catch → 打 X-Lxh-Error 头 + {ok:false,error}）
      guard: (fn) => async (req, res, ctx) => {
        try {
          const data = await fn(req, res, ctx)
          if (!res.writableEnded) resp = { ok: true, data }
        } catch (e) {
          res.setHeader('X-Lxh-Error', '1')
          resp = { ok: false, error: String((e && e.message) || e) }
        }
      },
      require: () => ({ normalizeRepo: (r) => r, resetProxyHealth: () => {}, applyConfig: () => {} }),
      updater: null,
      updaterKey: '',
      console,
      URL
    }
    sandbox.route = function (method, pattern, h) {
      if (method === 'POST' && pattern === '/api/config') handler = h
    }
    vm.createContext(sandbox)
    vm.runInContext(snippet, sandbox, { filename: 'web.js#/api/config' })
    if (!handler) throw new Error('没抓到 handler')
    const res = {
      writableEnded: false,
      setHeader: (k, v) => { headers[k] = v }
    }
    return Promise.resolve(handler({ url: '/api/config', headers: {}, socket: {} }, res, { body: { foo: 1 } }))
      .then(() => ({ resp, logs, saved, headers }))
  }

  const okCase = await runConfigPost(false)
  ok('★ 写盘成功：ok=true，不报错', okCase.resp && okCase.resp.ok === true,
    JSON.stringify(okCase.resp))
  ok('★ 写盘成功：saveConfig 被调用了一次', okCase.saved.length === 1, 'saved=' + okCase.saved.length)
  ok('★ 写盘成功：没有 error 级日志', !okCase.logs.some(l => l.level === 'error'),
    JSON.stringify(okCase.logs))
  ok('★ 写盘成功：没有 X-Lxh-Error 头', !okCase.headers['X-Lxh-Error'],
    JSON.stringify(okCase.headers))

  const failCase = await runConfigPost(true)
  ok('★ 写盘失败：返回 ok=false（前端能知道失败）',
    failCase.resp && failCase.resp.ok === false, JSON.stringify(failCase.resp))
  ok('★ 写盘失败：错误文案点明「写盘失败」',
    failCase.resp && /写盘失败/.test(String(failCase.resp.error)),
    failCase.resp ? String(failCase.resp.error) : '')
  ok('★ 写盘失败：打了 X-Lxh-Error 头（web.js 既有失败标记约定）',
    failCase.headers['X-Lxh-Error'] === '1', JSON.stringify(failCase.headers))
  ok('★ 写盘失败：记了 error 级日志',
    failCase.logs.some(l => l.level === 'error'), JSON.stringify(failCase.logs))
  ok('★ 写盘失败：日志说清「没有保存成功」',
    failCase.logs.some(l => /没有保存成功/.test(String(l.msg || ''))),
    JSON.stringify(failCase.logs.map(l => l.msg)))
}

behaviourPart().then(() => {
  console.log('\n' + (fail ? '✗' : '✓') + ' web-saveconfig-writefail: PASS ' + pass + ' / FAIL ' + fail)
  if (fail) {
    console.log('\n失败项：')
    for (const f of fails) console.log('  - ' + f)
    process.exit(1)
  }
  process.exit(0)
}).catch(e => { console.error('测试异常:', e); process.exit(1) })
