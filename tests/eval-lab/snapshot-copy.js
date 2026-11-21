'use strict'
/**
 * 主库只读快照 → 临时副本 Store（阶段8 影子评测的物理隔离层）。
 * 只读取主库 sources/imported/config 的深拷贝（去 apiKey），写入临时目录的新 Store；
 * 本模块**绝不 import 主库 store 单例**，也不写主库任何文件。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { Store } = require('../../src/core/store')

function deepClone (o) { return o == null ? o : JSON.parse(JSON.stringify(o)) }

/** 读主库目录里的 json（只读，不实例化 Store、不触发任何迁移写盘） */
function readJson (dir, file) {
  const p = path.join(dir, file)
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null }
}

/**
 * 造隔离副本。
 * @param {string} mainDataDir 主库 DATA_DIR（只读来源）
 * @returns {{dir:string, store:Store, snapshot:object}}
 */
function makeShadowStore (mainDataDir) {
  const srcDir = path.resolve(mainDataDir || '')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-eval-lab-'))
  // 三重断言之一：副本绝不能指向主库
  if (path.resolve(tmpDir) === srcDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw new Error('影子副本路径等于主库 DATA_DIR，拒绝运行')
  }
  const srcCfg = readJson(srcDir, 'config.json') || {}
  const srcDb = readJson(srcDir, 'sources.json') || {}
  const srcImp = readJson(srcDir, 'imported.json') || {}

  // 脱敏：去掉 aiReview.provider.apiKey
  const cfg = deepClone(srcCfg)
  if (cfg.aiReview && cfg.aiReview.provider) delete cfg.aiReview.provider.apiKey
  const snapshot = {
    config: cfg,
    sources: deepClone(srcDb.sources || {}),
    imported: deepClone(srcImp)
  }
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'sources.json'), JSON.stringify({ sources: snapshot.sources }, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'imported.json'), JSON.stringify(snapshot.imported, null, 2))
  const store = new Store(tmpDir)
  return { dir: tmpDir, store, snapshot }
}

function discard (shadow) {
  if (shadow && shadow.dir) {
    try { fs.rmSync(shadow.dir, { recursive: true, force: true }) } catch (e) {}
  }
}

module.exports = { makeShadowStore, discard, readJson }
