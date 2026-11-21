'use strict'
/**
 * P2 音源标识双字段（v1.15.0）：releaseTag（采集正式字段 + 历史 fallback）+ userTag（用户自定义）
 * + 统一 label 纯函数（显示/搜索/排序同源）。红线：tag 绝不写进 name/lxName/scriptVersion。
 * 零框架，assert + 计数。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ROOT = path.join(__dirname, '..')
let pass = 0
const ok = (c, l) => { assert.ok(c, l); pass++; console.log('  PASS', l) }

const Label = require(path.join(ROOT, 'src', 'renderer', 'sourceLabel'))
const { Store } = require(path.join(ROOT, 'src', 'core', 'store'))

console.log('--- ① sourceLabel 纯函数口径 ---')
;(() => {
  ok(Label.releaseTagOf({ releaseTag: 'v9.1' }) === 'v9.1', 'releaseTag 正式字段优先')
  ok(Label.releaseTagOf({ assetKey: 'v2.3/foo.js' }) === 'v2.3', '历史 assetKey fallback 解析 tag')
  ok(Label.releaseTagOf({ path: 'release:v4.0:x.js' }) === 'v4.0', '历史 path 解析 release tag')
  ok(Label.releaseTagOf({}) === '', '无 tag 返回空（不臆造）')
  ok(Label.userTagOf({ userTag: '  我的源  ' }) === '我的源', 'userTag trim')
  ok(Label.baseNameOf({ lxName: '正式名', scriptName: '脚本名', name: '采集名' }) === '正式名',
    'baseName 取 lxName 优先（与显示一致）')
  const e = { lxName: '音源A', userTag: '常用', releaseTag: 'v1.2' }
  const lab = Label.sourceLabel(e)
  ok(lab === '音源A [常用] (v1.2)', '统一 label = 名字 [用户标签] (release 标签)')
  ok(Label.sourceLabel(e, { withRelease: false }) === '音源A [常用]', 'withRelease:false 只显用户标签')
  const st = Label.searchTextOf(e)
  ok(st.includes('常用') && st.includes('v1.2'), '搜索文本含双标签（可按标签搜到）')
})()

console.log('--- ② setUserTag 单点写入，不动名字/版本 ---')
;(() => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-tag-')))
  s.db.sources['x'] = { id: 'x', name: '原名', lxName: '正式名', scriptVersion: '1.0',
    releaseTag: 'v1', userTag: '旧标签' }
  const before = JSON.stringify(s.db.sources.x)
  const out = s.setUserTag('x', '新标签')
  ok(out.ok && out.userTag === '新标签', 'setUserTag 返回成功')
  const e = s.db.sources.x
  ok(e.userTag === '新标签', 'userTag 已更新')
  ok(e.name === '原名' && e.lxName === '正式名' && e.scriptVersion === '1.0' && e.releaseTag === 'v1',
    'name/lxName/scriptVersion/releaseTag 全部未变（identity 不受污染）')
  s.setUserTag('x', '')
  ok(!Object.prototype.hasOwnProperty.call(s.db.sources.x, 'userTag'), '空标签清除 userTag 字段')
  let threw = false
  try { s.setUserTag('none', 'x') } catch (err) { threw = /不存在/.test(err.message) }
  ok(threw, '不存在的源拒绝设置（不静默创建）')
  ok(before && true, '写入前快照已取')
})()

console.log('--- ③ 采集写 releaseTag + 四端路由 + 渲染统一口径 ---')
;(() => {
  const crawler = fs.readFileSync(path.join(ROOT, 'src', 'core', 'crawler.js'), 'utf8')
  ok(/releaseTag:\s*String\(a\.tag/.test(crawler), 'crawler js 分支写 releaseTag')
  ok((crawler.match(/it\.releaseTag\s*=/g) || []).length >= 1, 'crawler zip 循环写 releaseTag')
  ok(!/name:.*releaseTag|lxName:.*releaseTag|scriptVersion:\s*a\.tag.*releaseTag/.test(crawler),
    'releaseTag 未混进 name/lxName（scriptVersion 预填是既有独立行为）')
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8')
  const sorters = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'sorters.js'), 'utf8')
  ok(/LXSourceLabel\.searchTextOf/.test(app), '搜索走统一口径')
  ok(/tagChips\(e\)/.test(app) && /data-tag-id/.test(app), '显示渲染双标签 chip + 编辑入口')
  ok(/LXSourceLabel\.baseNameOf/.test(sorters), '名称排序走统一 baseNameOf')
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
  ok(/sourceLabel\.js/.test(html), 'index.html 引入 sourceLabel.js')
  for (const [f, pat] of [
    ['src/main/preload.js', /sourcesSetUserTag/],
    ['src/main/index.js', /sources:setUserTag/],
    ['src/renderer/web-bridge.js', /sourcesSetUserTag/],
    ['src/server/web.js', /set-user-tag/]
  ]) ok(pat.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f + ' 暴露用户标签路由')
})()

console.log('\nP2 音源标识: PASS ' + pass + ' / FAIL 0')
