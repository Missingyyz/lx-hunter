'use strict'
/**
 * 「已逃逸」探针（v1.13.14，测试专用，不进产物链路）
 *
 * 这个文件**故意模拟「沙箱已被完全攻破」的状态**：它直接 require fs /
 * child_process，不做任何沙箱里的花活。
 *
 * 为什么需要它：如果不这样做，功能性断言会「假绿」——上一轮实测发现 B 段
 * 大半断言都是因为「进程内 facade 把 process 挡住了」才通过的，
 * 那就等于**没测到 --permission 这一层**。而这一层正是本轮换方案的全部理由。
 *
 * 它要回答的是第二道防线：**假设第一道（vm + facade）已经破了，还能伤到什么。**
 *
 * 用法：node --permission --allow-fs-read=<src> sandbox-escape-probe.js <action> <path>
 */

const action = process.argv[2]
const target = process.argv[3]
const out = {}

function record(k, v) { out[k] = v }

try {
  if (action === 'read') {
    try {
      record('read', require('fs').readFileSync(target, 'utf8').slice(0, 40))
      record('readOk', true)
    } catch (e) { record('readErr', e.code || String(e.message).slice(0, 90)); record('readOk', false) }
  } else if (action === 'write') {
    try {
      require('fs').writeFileSync(target, 'HARM')
      record('writeOk', true)
    } catch (e) { record('writeErr', e.code || String(e.message).slice(0, 90)); record('writeOk', false) }
  } else if (action === 'exec') {
    try {
      record('exec', require('child_process').execSync('echo HARM').toString().trim())
      record('execOk', true)
    } catch (e) { record('execErr', e.code || String(e.message).slice(0, 90)); record('execOk', false) }
  } else if (action === 'dlopen') {
    try {
      require('node:fs').writeFileSync('/tmp/x', '')
      record('dlopenOk', true)
    } catch (e) { record('dlopenErr', e.code || String(e.message).slice(0, 90)); record('dlopenOk', false) }
  } else if (action === 'read-src') {
    // 反向断言：src 目录内的文件**必须**可读（否则沙箱模块自己都加载不了）
    try {
      record('srcOk', require('fs').readFileSync(target, 'utf8').length > 0)
    } catch (e) { record('srcErr', e.code || String(e.message).slice(0, 90)); record('srcOk', false) }
  }
} catch (e) {
  record('fatal', String(e.message).slice(0, 120))
}

process.stdout.write('ESCAPE_PROBE ' + JSON.stringify(out) + '\n')
