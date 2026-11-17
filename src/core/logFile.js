'use strict'
/**
 * 业务日志落盘公共模块（v1.14.0）
 *
 * 抽取自 Web 端 web.js 的 v1.13.8-beta.2 补丁：原来只有 Web 端 pushLog 会把
 * 内存日志按天追加 JSONL 到 <DATA_DIR>/logs/，桌面端 pushLog 只进内存，
 * 两次重启就能把巡检/爬取/追更/自动信任等自动路径的日志全抹掉，事后无法取证。
 * 用户拍板双端日志一致，故把落盘逻辑抽成这个纯工具模块，供 web.js 与
 * main/index.js 共用（两边各自维护内存 logs 数组 / SSE / IPC 推送）。
 *
 * 设计约束：
 *  - 纯工具：不监听任何事件、不启动任何定时器，由调用方在 pushLog 里显式调用 pushLog(entry)；
 *  - 内存 logs 数组上限由 opts.maxLogs 控制（默认 2000），超出从头部裁掉；
 *  - 落盘 fs.appendFile 异步 fire-and-forget，全程 try/catch 静默：
 *    目录建不出来 / 磁盘满 / 写失败绝不能影响内存日志与 SSE / IPC 主流程；
 *  - 只保留最近 14 天 app-YYYY-MM-DD.jsonl，其他文件一概不碰；
 *  - 零第三方依赖，Node 内置 fs + path 即可。
 */
const fs = require('fs')
const path = require('path')

const APP_LOG_RETENTION_DAYS = 14

function appLogDay(d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 创建业务日志写入器。
 * @param {string} dataDir 数据目录（日志写到其下的 logs/ 子目录）
 * @param {{maxLogs?: number}} [opts] maxLogs 内存日志上限，默认 2000
 * @returns {{logs: Array, pushLog: (entry: any) => void, module: string}}
 *   logs 为调用方共享的内存日志数组（可读取 / slice(-800) 给日志页）；
 *   module 为默认模块标记，方便调用方补 entry.module。
 */
function createAppLogWriter(dataDir, opts) {
  const maxLogs = opts && Number.isFinite(opts.maxLogs) && opts.maxLogs > 0 ? opts.maxLogs : 2000
  const logDir = path.join(String(dataDir || ''), 'logs')
  const logs = []

  try { fs.mkdirSync(logDir, { recursive: true }) } catch (e) {}

  function pruneAppLogs() {
    // 只清 app-YYYY-MM-DD.jsonl 命名格式的旧文件，目录里其他东西一概不碰
    try {
      const cutoff = Date.now() - APP_LOG_RETENTION_DAYS * 86400 * 1000
      for (const f of fs.readdirSync(logDir)) {
        const m = /^app-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
        if (m && new Date(`${m[1]}T23:59:59`).getTime() < cutoff) {
          try { fs.unlinkSync(path.join(logDir, f)) } catch (e) {}
        }
      }
    } catch (e) {}
  }
  pruneAppLogs()

  function appendAppLog(entry) {
    try {
      const file = path.join(logDir, `app-${appLogDay(new Date())}.jsonl`)
      fs.appendFile(file, JSON.stringify(entry) + '\n', () => {})
    } catch (e) {}
  }

  function pushLog(entry) {
    logs.push(entry)
    if (logs.length > maxLogs) logs.splice(0, logs.length - maxLogs)
    appendAppLog(entry)
  }

  return { logs, pushLog, module: '日志' }
}

module.exports = { createAppLogWriter }
