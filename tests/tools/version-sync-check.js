'use strict'
/**
 * 可复用的「仓库 vs 容器」版本核对脚本。
 *
 * 存在的意义：之前所有「已验收」结论都不可复现，根因是
 *   ① 测试容器挂载的是 NAS 上 patch-ai/ 的**拷贝**，不跟随仓库；
 *   ② 文件级 bind mount 绑定 inode，rename 替换会让容器继续指向旧 inode。
 * 本脚本把「仓库当前状态」与「容器实际在跑什么」逐文件对齐，
 * 任何声称「已验收」之前都应先跑它。
 *
 * 用法:
 *   node tests/tools/version-sync-check.js              # 打印对照表 + 差异统计
 *   node tests/tools/version-sync-check.js --strict     # 有差异时 exit 1（CI 用）
 *   LX_SSH_HOST=admin@<host> node tests/tools/version-sync-check.js --strict
 *   或：node tests/tools/version-sync-check.js --host admin@<host>
 *
 * 依赖：能 ssh 到宿主并 docker exec 进容器。
 *   宿主地址：--host 参数 或 LX_SSH_HOST 环境变量（默认 admin@localhost，需显式配置）
 *   SSH 口令：LX_SSH_ASKPASS 指向的 askpass 脚本，默认值取仓库根目录 _askpass.cmd
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const args = process.argv.slice(2)
const STRICT = args.includes('--strict')
const HOST_ARG = args.indexOf('--host')
// 隐私：默认地址用通用占位，私人宿主由 --host 或 LX_SSH_HOST 环境变量显式提供
const HOST = HOST_ARG >= 0 ? args[HOST_ARG + 1] : (process.env.LX_SSH_HOST || 'admin@localhost')
const CONTAINER = (() => {
  const i = args.indexOf('--container')
  return i >= 0 ? args[i + 1] : 'lx-hunter-ai-test'
})()

// 仓库根：脚本在 lx-hunter/tests/tools/ 下，往上两级
const REPO = path.resolve(__dirname, '..', '..')
const ASKPASS = process.env.LX_SSH_ASKPASS || path.join(REPO, '_askpass.cmd')

// 仓库相对路径 → 容器内路径
const MAP = [
  ['src/core/aiProvider.js', '/app/src/core/aiProvider.js'],
  ['src/core/aiReview.js', '/app/src/core/aiReview.js'],
  ['src/core/aiSchedule.js', '/app/src/core/aiSchedule.js'],
  ['src/core/auth.js', '/app/src/core/auth.js'],
  ['src/core/checker.js', '/app/src/core/checker.js'],
  ['src/core/coldStart.js', '/app/src/core/coldStart.js'],
  ['src/core/community.js', '/app/src/core/community.js'],
  ['src/core/crawlSchedule.js', '/app/src/core/crawlSchedule.js'],
  ['src/core/crawler.js', '/app/src/core/crawler.js'],
  ['src/core/dataio.js', '/app/src/core/dataio.js'],
  ['src/core/evalCases.js', '/app/src/core/evalCases.js'],
  ['src/core/evalSnapshot.js', '/app/src/core/evalSnapshot.js'],
  ['src/core/hubfeed.js', '/app/src/core/hubfeed.js'],
  ['src/core/hunter.js', '/app/src/core/hunter.js'],
  ['src/core/identity.js', '/app/src/core/identity.js'],
  ['src/core/logFile.js', '/app/src/core/logFile.js'],
  ['src/core/lxbootstrap.js', '/app/src/core/lxbootstrap.js'],
  ['src/core/lxservice.js', '/app/src/core/lxservice.js'],
  ['src/core/net.js', '/app/src/core/net.js'],
  ['src/core/outbound-policy.js', '/app/src/core/outbound-policy.js'],
  ['src/core/portable.js', '/app/src/core/portable.js'],
  ['src/core/probeQueue.js', '/app/src/core/probeQueue.js'],
  ['src/core/quality.js', '/app/src/core/quality.js'],
  ['src/core/sandbox-facade.js', '/app/src/core/sandbox-facade.js'],
  ['src/core/sandbox-process.js', '/app/src/core/sandbox-process.js'],
  ['src/core/sandbox-worker.js', '/app/src/core/sandbox-worker.js'],
  ['src/core/sandbox.js', '/app/src/core/sandbox.js'],
  ['src/core/serverVeto.js', '/app/src/core/serverVeto.js'],
  ['src/core/sourceUpdate.js', '/app/src/core/sourceUpdate.js'],
  ['src/core/sourceView.js', '/app/src/core/sourceView.js'],
  ['src/core/store.js', '/app/src/core/store.js'],
  ['src/core/version.js', '/app/src/core/version.js'],
  ['src/core/websource.js', '/app/src/core/websource.js'],
  ['src/core/zip.js', '/app/src/core/zip.js'],
  ['src/core/services/index.js', '/app/src/core/services/index.js'],
  ['src/core/services/geelonn.js', '/app/src/core/services/geelonn.js'],
  ['src/core/services/lxserver.js', '/app/src/core/services/lxserver.js'],
  ['src/core/services/musicsync.js', '/app/src/core/services/musicsync.js'],
  ['src/core/services/songloft.js', '/app/src/core/services/songloft.js'],
  ['src/main/index.js', '/app/src/main/index.js'],
  ['src/main/preload.js', '/app/src/main/preload.js'],
  ['src/renderer/app.js', '/app/src/renderer/app.js'],
  ['src/renderer/auth-bg.js', '/app/src/renderer/auth-bg.js'],
  ['src/renderer/index.html', '/app/src/renderer/index.html'],
  ['src/renderer/sorters.js', '/app/src/renderer/sorters.js'],
  ['src/renderer/sourceLabel.js', '/app/src/renderer/sourceLabel.js'],
  ['src/renderer/styles.css', '/app/src/renderer/styles.css'],
  ['src/renderer/web-bridge.js', '/app/src/renderer/web-bridge.js'],
  ['src/server/web.js', '/app/src/server/web.js']
]

function md5 (buf) { return crypto.createHash('md5').update(buf).digest('hex') }

/** 从 SSH_ASKPASS 脚本里读出口令（该脚本最后一行是 echo <口令>） */
function readSudoPassword () {
  if (process.env.LX_SUDO_PASSWORD) return process.env.LX_SUDO_PASSWORD
  try {
    const raw = fs.readFileSync(ASKPASS, 'utf8')
    const line = raw.split(/\r?\n/).map(s => s.trim())
      .filter(s => s && !/^@?echo\s+off$/i.test(s)).pop()
    if (!line) return null
    const m = line.match(/^echo\s+(.+)$/i)
    return m ? m[1].trim() : line
  } catch (e) { return null }
}

function ssh (remoteCmd, timeoutMs) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, {
      SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0'
    })
    const p = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
      '-o', 'NumberOfPasswordPrompts=1', HOST, remoteCmd],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => err += d)
    const t = setTimeout(() => p.kill(), timeoutMs || 120000)
    p.on('close', c => { clearTimeout(t); resolve({ code: c, out, err }) })
  })
}

;(async () => {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log('=== 仓库 vs 容器 版本核对 ===')
  console.log('核对时刻: ' + stamp + ' (本地时区)')
  console.log('仓库:     ' + REPO)
  console.log('容器:     ' + CONTAINER + ' @ ' + HOST)
  console.log('')

  // 一次 ssh 拿到容器全部 md5
  // 远端 docker 通常需要 root。口令不写死在脚本里：从 SSH_ASKPASS 指向的
  // 脚本读取（该脚本形如 "@echo off\necho <口令>"），或用环境变量覆盖。
  const sudoPass = readSudoPassword()
  const inner = `md5sum ${MAP.map(m => m[1]).join(' ')} 2>&1`
  const cmd = sudoPass
    ? `printf '%s\\n' ${JSON.stringify(sudoPass)} | sudo -S docker exec ${CONTAINER} sh -c ${JSON.stringify(inner)}`
    : `sudo -n docker exec ${CONTAINER} sh -c ${JSON.stringify(inner)}`
  const r = await ssh(cmd, 120000)
  if (r.code !== 0) {
    console.log('!! 无法连接容器: ' + (r.err || r.out).slice(0, 400))
    process.exit(1)
  }
  const cMd5 = new Map()
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{32})\s+(.+)$/)
    if (m) cMd5.set(m[2].trim(), m[1])
  }

  const rows = []
  let diff = 0, missing = 0
  for (const [rel, cpath] of MAP) {
    const p = path.join(REPO, rel)
    let rmd5 = 'MISSING_IN_REPO', rsize = 0, rmtime = ''
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p)
      rmd5 = md5(buf); rsize = buf.length
      rmtime = fs.statSync(p).mtime.toISOString().replace('T', ' ').slice(0, 19)
    }
    const cmd5 = cMd5.get(cpath) || 'MISSING_IN_CONTAINER'
    let state
    if (rmd5 === 'MISSING_IN_REPO') state = 'REPO-无此文件'
    else if (cmd5 === 'MISSING_IN_CONTAINER') { state = '容器缺'; missing++ }
    else if (rmd5 !== cmd5) { state = '不一致'; diff++ }
    else state = '一致'
    rows.push({ rel, cpath, rmd5, cmd5, rsize, rmtime, state })
  }

  const w = Math.max(...rows.map(r => r.rel.length))
  console.log('文件'.padEnd(w) + '  仓库md5              容器md5              仓库时间             状态')
  console.log('-'.repeat(w + 88))
  for (const r of rows) {
    console.log(r.rel.padEnd(w) + '  ' + r.rmd5 + '  ' + r.cmd5 + '  ' + r.rmtime + '  ' + r.state)
  }
  console.log('')
  console.log(`合计 ${rows.length} 个文件；不一致 ${diff}，容器缺失 ${missing}`)
  if (diff || missing) {
    console.log('!! 结论：容器与仓库【不一致】——在此容器上取得的任何验收结论都不可复现。')
  } else {
    console.log('✓ 结论：容器与仓库完全一致。')
  }
  if (STRICT && (diff || missing)) process.exit(1)
})()
