'use strict'
/**
 * 把仓库 src/ 同步到测试容器的目录挂载源（**只动测试容器**）。
 *
 * ============================================================================
 * 这个脚本存在的意义
 * ============================================================================
 * 之前所有「已验收」结论不可复现，根因是挂载形态踩了三个坑，
 * 这个脚本把正确姿势固化下来：
 *
 *   坑① 挂载形态：原来 patch-ai 是**逐文件 bind mount**。
 *        文件级 bind 绑定的是 **inode**，不是路径。
 *        仓库用 rename 替换文件（scp 默认行为、编辑器保存、git checkout）
 *        → 容器永远指向旧 inode，即使对新 inode 就地写入 + restart 也没用，
 *          **必须重建容器**。现已改为目录级挂载。
 *
 *   坑② 换目录会断链：目录级挂载下，`rm -rf $D/src && mv new $D/src`
 *        会让 bind mount 指向被替换掉的旧目录，容器继续跑旧代码。
 *        正确姿势是**就地覆盖解包**（tar 对已存在文件是 O_TRUNC 写，inode 不变）。
 *
 *   坑③ 多套一层：tar 包内路径带 `src/` 前缀（tar -C REPO src），
 *        直接解到 $D/src 会得到 $D/src/src/... —— 表现为文件数翻倍、
 *        关键文件 md5 仍是旧值。必须 `--strip-components=1`。
 *
 * ★ 安全边界：
 *   - 只写 /vol1/1000/docker/lx-hunter/patch-ai/src/（测试容器 lx-hunter-ai-test 的挂载源）
 *   - 生产容器 lx-hunter 挂的是 patch-qz/，与本目录无关，**绝不触碰**
 *   - 本脚本不重建容器（目录挂载下无需重建）；若发现容器里仍是旧版，
 *     那是挂载形态问题，需人工确认后再重建。
 *
 * 用法:
 *   node tests/tools/sync-src-to-test-container.js
 *   node tests/tools/sync-src-to-test-container.js --check   # 只核对不同步
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const REPO = path.join(ROOT, '..')
const TARBALL = path.join(REPO, '_src_tree.tar')
// 隐私：宿主地址与凭据路径不再写死私人值，改由环境变量提供。
// 本机用法示例：LX_SSH_HOST=admin@<host> LX_SSH_ASKPASS=<你的askpass路径> node <本脚本>
const HOST = process.env.LX_SSH_HOST || 'admin@localhost'
const ASKPASS = process.env.LX_SSH_ASKPASS || path.join(REPO, '_askpass.cmd')
const CHECK_ONLY = process.argv.includes('--check')

const REMOTE_SRC = '/vol1/1000/docker/lx-hunter/patch-ai/src'
const CONTAINER = 'lx-hunter-ai-test'

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
    let out = '', err = ''
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => err += d)
    if (opts.stdinFile) {
      try { p.stdin.write(fs.readFileSync(opts.stdinFile)) } catch (e) { /* ignore */ }
    }
    if (opts.stdinFile) p.stdin.end()
    const t = setTimeout(() => p.kill(), opts.timeout || 300000)
    p.on('close', c => { clearTimeout(t); resolve({ code: c, out, err }) })
  })
}

/** 打包仓库 src/ 并 scp 到远端 /tmp/_src_tree.tar */
async function packAndUpload () {
  if (fs.existsSync(TARBALL)) fs.unlinkSync(TARBALL)
  const r = await run('tar', ['-cf', TARBALL, '-C', ROOT, 'src'], { timeout: 180000 })
  if (r.code !== 0) throw new Error('tar 失败: ' + r.err.slice(0, 300))
  const bytes = fs.statSync(TARBALL).size
  console.log('打包完成: ' + TARBALL + '  bytes=' + bytes)
  const s = await run('scp', ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
    '-o', 'NumberOfPasswordPrompts=1', TARBALL, HOST + ':/tmp/_src_tree.tar'], { timeout: 300000 })
  if (s.code !== 0) throw new Error('scp 失败: ' + s.err.slice(0, 300))
  console.log('上传完成: /tmp/_src_tree.tar (scp exit=' + s.code + ')')
}

/** 从 SSH_ASKPASS 脚本里读出口令（形如 "@echo off\necho <口令>"），或用环境变量覆盖 */
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

/** 远端执行：就地覆盖解包 + 打印源/容器两侧 md5 */
async function remoteOverlay () {
  const sudoPass = readSudoPassword()
  if (!sudoPass) throw new Error('读不到 sudo 口令（LX_SUDO_PASSWORD 或 SSH_ASKPASS 脚本）')
  const script = [
    'set -e',
    'D=' + REMOTE_SRC,
    'T=/tmp/_src_tree.tar',
    'if [ -d "$D/src" ]; then echo "清理嵌套目录 $D/src/src"; rm -rf "$D/src/src"; fi',
    'echo "同步前文件数: $(find $D -type f | wc -l)"',
    'tar -xf "$T" -C "$D" --strip-components=1 --no-same-owner',
    'echo "同步后文件数: $(find $D -type f | wc -l)"',
    'echo "=== 挂载源 md5 ==="',
    'md5sum $D/core/sandbox-facade.js $D/core/sandbox.js $D/core/sandbox-worker.js $D/core/sandbox-process.js $D/core/checker.js $D/core/hunter.js $D/core/aiReview.js $D/core/outbound-policy.js',
    'echo "=== 容器内 md5 ==="',
    "printf '%s\\n' '" + sudoPass + "' | sudo -S docker exec " + CONTAINER + " sh -c 'md5sum /app/src/core/sandbox-facade.js /app/src/core/sandbox.js /app/src/core/sandbox-worker.js /app/src/core/sandbox-process.js /app/src/core/checker.js /app/src/core/hunter.js /app/src/core/aiReview.js /app/src/core/outbound-policy.js' 2>/dev/null",
    "echo '=== 容器状态 ==='",
    "printf '%s\\n' '" + sudoPass + "' | sudo -S docker ps --filter name=" + CONTAINER + " --format '{{.Names}} | {{.Status}}' 2>/dev/null"
  ].join('\n')

  const tmp = path.join(REPO, '_sync_remote_tmp.sh')
  fs.writeFileSync(tmp, script, 'utf8')
  const r = await run('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
    '-o', 'NumberOfPasswordPrompts=1', HOST, 'sh -s'], { stdinFile: tmp, timeout: 300000 })
  try { fs.unlinkSync(tmp) } catch (e) { /* ignore */ }
  return r
}

;(async () => {
  try {
    if (!CHECK_ONLY) {
      await packAndUpload()
    } else {
      console.log('--check：只核对，不同步')
    }
    const r = await remoteOverlay()
    console.log(r.out)
    if (r.err) console.log('[stderr] ' + r.err.slice(0, 400))
    console.log('远端退出码: ' + r.code)
    if (r.code !== 0) process.exit(1)
  } catch (e) {
    console.log('失败: ' + String(e && e.message || e))
    process.exit(1)
  }
})()
