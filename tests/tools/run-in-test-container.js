'use strict'
/**
 * 容器内探针执行器（只针对测试容器 lx-hunter-ai-test）
 *
 * ============================================================================
 * 为什么需要这个
 * ============================================================================
 * 有一些探针**只能在容器内跑**，因为它们 require 的是容器里的绝对路径：
 *   require('/app/src/core/sandbox-process')
 * 而仓库里对应的是 src/core/sandbox-process.js —— 本地跑会 MODULE_NOT_FOUND。
 *
 * 典型例子：tests/tools/verify-b-r2-forge.js（token 伪造复验）。
 *
 * ⚠ 硬约束：
 *   - **绝不碰生产容器 lx-hunter**（端口 8191）。本脚本只接受 --container=lx-hunter-ai-test。
 *   - 探针文件只落在容器 /tmp 下，用完即删（不污染 /app）。
 *   - 探针内容来自本地仓库 tests/tools/ 下指定文件，不接受任意代码。
 *
 * 用法:
 *   node tests/tools/run-in-test-container.js tests/tools/verify-b-r2-forge.js
 *   node tests/tools/run-in-test-container.js --keep tests/tools/xxx.js
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')
const REPO = path.join(ROOT, '..')
const HOST = 'admin@192.168.1.246'
const ASKPASS = process.env.LX_SSH_ASKPASS || 'E:\\AI\\Deva\\lunter\\_askpass.cmd'

const ALLOWED_CONTAINER = 'lx-hunter-ai-test'
const REMOTE_TMP = '/tmp/lxprobe'

function run (cmd, args, opts) {
  opts = opts || {}
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, {
      SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0'
    })
    const p = spawn(cmd, args, {
      env, windowsHide: true,
      stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    let out = ''; let err = ''
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => err += d)
    if (opts.stdinFile) {
      try { p.stdin.write(fs.readFileSync(opts.stdinFile)) } catch (e) { /* ignore */ }
    }
    if (opts.stdinFile) p.stdin.end()
    const t = setTimeout(() => p.kill(), opts.timeout || 600000)
    p.on('close', c => { clearTimeout(t); resolve({ code: c, out, err }) })
  })
}

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

async function main () {
  const args = process.argv.slice(2)
  const keep = args.includes('--keep')
  const file = args.filter(a => !a.startsWith('--'))[0]
  if (!file) { console.log('用法: node tests/tools/run-in-test-container.js <tests/tools/xxx.js>'); process.exit(2) }

  const abs = path.resolve(ROOT, file)
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
  // 白名单：只允许 tests/ 下的 .js
  if (!rel.startsWith('tests/') || !rel.endsWith('.js')) {
    console.log('拒绝：只允许 tests/ 下的 .js（收到 ' + rel + '）'); process.exit(2)
  }
  if (!fs.existsSync(abs)) { console.log('文件不存在: ' + abs); process.exit(2) }

  const sudoPass = readSudoPassword()
  if (!sudoPass) { console.log('读不到 sudo 口令'); process.exit(2) }

  // ⚠ 两个坑：
  //   ① 容器有独立的 /tmp，宿主的 /tmp/<file> 在容器里看不到 → 不能 scp 到宿主 /tmp 再 exec。
  //   ② `sudo -S` 要从 stdin 读密码，会**吃掉 stdin 的第一行**，
  //      所以「探针内容走 stdin」这条路走不通（实测 node - 收到空输入）。
  //   ⇒ 改成：探针内容 base64 后塞进远端命令行，容器内解码落 /tmp 再 node 执行、随即删除。
  const b64 = fs.readFileSync(abs).toString('base64')
  const remoteTmp = REMOTE_TMP + '_' + path.basename(rel)
  const remoteCmd = "printf '%s\\n' '" + sudoPass + "' | sudo -S docker exec " + ALLOWED_CONTAINER +
    " sh -c \"echo '" + b64 + "' | base64 -d > " + remoteTmp + " && node " + remoteTmp + " 2>&1; rm -f " + remoteTmp + "\" 2>/dev/null"

  const r = await run('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
    '-o', 'NumberOfPasswordPrompts=1', HOST, remoteCmd], { timeout: 600000 })

  console.log('--- 容器内输出（' + rel + '）---')
  console.log(r.out)
  if (r.err && r.err.trim()) console.log('--- stderr ---\n' + r.err.slice(0, 800))

  process.exit(r.code === 0 ? 0 : 1)
}

main().catch(e => { console.log('FATAL ' + String(e && e.message || e)); process.exit(2) })
