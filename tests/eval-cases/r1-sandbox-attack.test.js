'use strict'
/**
 * R1 交回面攻击测试（B 组 → A 组互攻）
 *
 * 目标：lx-hunter/src/core/sandbox-facade.js 的 deepUnwrap / adaptCb 交回面。
 *
 * 背景（与项目记忆 p_fda6d160 / p_1f1046d4 一致）：
 *   根因是 adaptCb 的 back.set(adapter,fn) 与 deepUnwrap 首分支 back.get(v) 互相抵消，
 *   宿主 Promise 兑现值绕过 wrap 直入沙箱；
 *   **恰好两层 Proxy 才逃逸**（单层/三层安全），escape 面仅 Response body 消费方法
 *   （json/arrayBuffer/bytes/blob）。
 *
 * 覆盖（任务书要求）：
 *   - json / arrayBuffer / blob / bytes 四条 body 消费路径
 *   - await 与 .then 两种写法
 *   - 单层 / 双层 / 三层 Proxy / realm 绕过
 *   - 防止 undefined 假绿
 *
 * ⚠ 铁律（沿用 sandbox-escape.test.js）：
 *   ① 只用真实宿主对象做夹具
 *   ② 每条断言跑在**独立子进程**里
 *   ③ 判「逃逸成立」必须看真 process 的铁证（pid / mainModule / binding），
 *      不能只看 typeof process —— 沙箱注入的是假 process，恒真会全漏。
 *
 * ⚠ 三态区分（否则全绿都是假绿）：
 *   NOFETCH  = body 消费路径没真跑到（fetch 失败/被沙箱拦）——这条用例等于没测
 *   BLOCKED  = 路径真跑到了，但逃逸尝试被沙箱拦下 —— **这才是安全**
 *   ESCAPED  = 真拿到宿主 process —— 失败
 *   FAKEPROC = 拿到的是沙箱假 process —— 不算逃逸
 */
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')
const NODE = process.execPath

let pass = 0
let fail = 0
const failures = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else {
    fail++
    const line = name + (extra != null ? '  :: ' + extra : '')
    failures.push(line)
    console.log('  ★FAIL★ ' + line)
  }
}

function runInChild (script, timeoutMs) {
  const r = spawnSync(NODE, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs || 180000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
  })
  let data = null
  const out = String(r.stdout || '').trim()
  if (out) {
    const lines = out.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try { data = JSON.parse(lines[i]); break } catch (e) {}
    }
  }
  return { ok: !r.error && r.status === 0 && data != null, data, stderr: String(r.stderr || '').slice(0, 1500) }
}

/** 沙箱内的通用「逃逸尝试」片段：拿到对象后试着取宿主 process */
const TRY = `
  function tryEscape (obj) {
    try {
      var C = obj && obj.constructor && obj.constructor.constructor;
      if (typeof C !== 'function') return 'NOCONSTRUCTOR';
      var p = C('return process')();
      if (!p || typeof p !== 'object') return 'NOPROC';
      // 只有宿主真 process 才有 pid / mainModule；沙箱假 process 没有
      if (typeof p.pid === 'number' || typeof p.mainModule !== 'undefined') return 'ESCAPED';
      try { if (p.binding && p.binding('fs')) return 'ESCAPED'; } catch (e) {}
      return 'FAKEPROC';
    } catch (e) {
      // 沙箱禁了 codeGeneration → 这是「拦住了」，不是「没跑到」
      return 'BLOCKED:' + String(e && e.message || e).slice(0, 60);
    }
  }
`

function probeScript (cases) {
  return `
    'use strict'
    const path = require('path')
    const http = require('http')
    const os = require('os')
    const { Sandbox } = require(path.join(${JSON.stringify(ROOT)}, 'src', 'core', 'sandbox.js'))

    const CASES = ${JSON.stringify(cases)}

    async function main () {
      // ⚠ 不能绑 127.0.0.1：沙箱正确禁止访问回环地址（我第一版就踩了，
      //   14 条用例全被沙箱自己的 SSRF 防线拦掉 → 所有断言假绿）。
      let bindAddr = null
      for (const k of Object.keys(os.networkInterfaces())) {
        for (const a of os.networkInterfaces()[k] || []) {
          if (a.family === 'IPv4' && !a.internal) { bindAddr = a.address; break }
        }
        if (bindAddr) break
      }
      if (!bindAddr) { console.log(JSON.stringify({ error: '找不到非回环本机地址' })); return }
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ hello: 'world', n: 42 }))
      })
      await new Promise(r => srv.listen(0, bindAddr, r))
      const host = bindAddr + ':' + srv.address().port

      const sb = new Sandbox({ id: 'r1-attack', fetchTimeout: 8000 })
      await sb.init('', {})

      const results = []
      for (const c of CASES) {
        let out
        try {
          // 脚本是 async IIFE，sb.run 返回 Promise，必须 await（否则拿到 [object Promise]）
          out = String(await sb.run(c.code.replaceAll('__HOST__', host), 20000))
        } catch (e) {
          out = 'THROW:' + String(e && e.message || e).slice(0, 120)
        }
        results.push({ id: c.id, out })
      }
      sb.destroy()
      srv.close()
      console.log(JSON.stringify({ results }))
    }
    main().catch(e => { console.log(JSON.stringify({ error: String(e && e.stack || e) })) })
  `
}

const CASES = [
  {
    id: 'json-await',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const j = await r.json();
      if (!j || j.hello !== 'world') return 'NOFETCH';
      return tryEscape(j);
    })()`
  },
  {
    id: 'json-then',
    code: `(async () => {
      ${TRY}
      return await fetch('http://__HOST__/x')
        .then(r => r.json())
        .then(j => { if (!j || j.hello !== 'world') return 'NOFETCH'; return tryEscape(j); });
    })()`
  },
  {
    id: 'arrayBuffer-await',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const b = await r.arrayBuffer();
      if (!b || !b.byteLength) return 'NOFETCH';
      return tryEscape(b);
    })()`
  },
  {
    id: 'blob-await',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const b = await r.blob();
      if (!b || !b.size) return 'NOFETCH';
      return tryEscape(b);
    })()`
  },
  {
    id: 'bytes-await',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const b = await r.bytes();
      if (!b || !b.length) return 'NOFETCH';
      return tryEscape(b);
    })()`
  },
  {
    id: 'text-await',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const t = await r.text();
      if (!t || t.indexOf('world') < 0) return 'NOFETCH';
      return tryEscape(t);
    })()`
  },
  {
    id: 'headers',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const h = r.headers;
      if (!h) return 'NOFETCH';
      return tryEscape(h);
    })()`
  },
  {
    id: 'json-2proxy',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const j = await r.json();
      if (!j || j.hello !== 'world') return 'NOFETCH';
      const p2 = new Proxy(j, {});
      return tryEscape(p2);
    })()`
  },
  {
    id: 'json-3proxy',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const j = await r.json();
      if (!j || j.hello !== 'world') return 'NOFETCH';
      const p1 = new Proxy(j, {});
      const p2 = new Proxy(p1, {});
      const p3 = new Proxy(p2, {});
      return tryEscape(p3);
    })()`
  },
  {
    id: 'json-getPrototypeOf-2proxy',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const j = await r.json();
      if (!j || j.hello !== 'world') return 'NOFETCH';
      const p2 = new Proxy(j, {});
      try {
        var C = Object.getPrototypeOf(p2).constructor;
        var p = C('return process')();
        if (p && (typeof p.pid === 'number' || typeof p.mainModule !== 'undefined')) return 'ESCAPED';
        return 'FAKEPROC';
      } catch (e) { return 'BLOCKED:' + String(e && e.message || e).slice(0, 60); }
    })()`
  },
  {
    id: 'json-nested-value',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const j = await r.json();
      if (!j || j.hello !== 'world') return 'NOFETCH';
      return tryEscape(j.hello);
    })()`
  },
  {
    id: 'promise-resolve-value',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const j = await r.json();
      if (!j || j.hello !== 'world') return 'NOFETCH';
      const v = await Promise.resolve(j);
      return tryEscape(v);
    })()`
  },
  {
    id: 'setTimeout-this',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const j = await r.json();
      if (!j || j.hello !== 'world') return 'NOFETCH';
      return await new Promise(res => {
        setTimeout(function () {
          try {
            var C = this && this.constructor && this.constructor.constructor;
            var p = C('return process')();
            if (p && (typeof p.pid === 'number' || typeof p.mainModule !== 'undefined')) return res('ESCAPED');
            res('FAKEPROC');
          } catch (e) { res('BLOCKED:' + String(e && e.message || e).slice(0, 60)); }
        }, 30);
      });
    })()`
  },
  {
    id: 'json-via-async-fn-arg',
    code: `(async () => {
      ${TRY}
      const r = await fetch('http://__HOST__/x');
      const j = await r.json();
      if (!j || j.hello !== 'world') return 'NOFETCH';
      // 把兑现值再经一层函数参数传递（deepUnwrap 的参数路径）
      function pass (x) { return tryEscape(x); }
      return await Promise.resolve().then(() => pass(j));
    })()`
  }
]

console.log('\n=== R1 交回面攻击：body 消费路径 × Proxy 层数 × await/then ===')
const r = runInChild(probeScript(CASES))
if (!r.ok || !r.data || r.data.error) {
  ok('R1 攻击探针能跑起来', false, (r.data && r.data.error) || r.stderr)
} else {
  const byId = {}
  for (const x of r.data.results) byId[x.id] = x.out
  console.log('  〔原始输出〕')
  for (const c of CASES) console.log('    ' + c.id + ' → ' + byId[c.id])

  const escaped = CASES.filter(c => /^ESCAPED/.test(byId[c.id] || ''))
  ok('【核心】所有 body 消费路径都无法拿到宿主 process',
    escaped.length === 0,
    '逃逸 ' + escaped.length + ' 条: ' + escaped.map(c => c.id).join(', '))

  const noFetch = CASES.filter(c => (byId[c.id] || '').indexOf('NOFETCH') === 0)
  ok('【防假绿】每条用例的 body 消费路径都真跑到了（无 NOFETCH）',
    noFetch.length === 0,
    '未跑到: ' + noFetch.map(c => c.id).join(', '))

  const vague = CASES.filter(c => {
    const o = byId[c.id] || ''
    return o === '' || o === 'undefined' || o === 'null' || o === 'THROW:undefined'
  })
  ok('【防假绿】每条用例都有明确结论（无空/undefined 输出）',
    vague.length === 0,
    '含糊: ' + vague.map(c => c.id + '=' + byId[c.id]).join(', '))

  const bodyPaths = ['json-await', 'json-then', 'arrayBuffer-await', 'blob-await', 'bytes-await']
  const bodyEsc = bodyPaths.filter(c => /^ESCAPED/.test(byId[c.id] || ''))
  ok('四条 body 消费路径（json/arrayBuffer/blob/bytes）都不逃逸',
    bodyEsc.length === 0,
    '逃逸: ' + bodyEsc.join(', '))

  const proxyCases = ['json-await', 'json-2proxy', 'json-3proxy', 'json-getPrototypeOf-2proxy', 'json-via-async-fn-arg']
  const proxyEsc = proxyCases.filter(c => /^ESCAPED/.test(byId[c.id] || ''))
  ok('单/双/三层 Proxy、getPrototypeOf 绕过、函数参数传递都不逃逸',
    proxyEsc.length === 0,
    '逃逸: ' + proxyEsc.join(', '))

  ok('realm 绕过（宿主 Object 冒充沙箱对象）不成立',
    !/^ESCAPED/.test(byId['json-nested-value'] || ''),
    'out=' + byId['json-nested-value'])

  // 统计拦下方式，作为交底材料
  const kinds = {}
  for (const c of CASES) {
    const o = byId[c.id] || 'EMPTY'
    const k = o.split(':')[0]
    kinds[k] = (kinds[k] || 0) + 1
  }
  console.log('  〔结论分布〕' + JSON.stringify(kinds))
}

console.log('\n----------------------------------------')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + '：' + pass + ' 项通过，' + fail + ' 项失败')
if (failures.length) { console.log('\n失败明细：'); failures.forEach(f => console.log('  - ' + f)) }
process.exit(fail ? 1 : 0)
