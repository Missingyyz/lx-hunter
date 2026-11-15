'use strict'
/**
 * P-1429 加固项（2026-11-12 随机测试报告的修复）：
 *  ① /api/config 明文凭据 → 非管理员剥离 + POST 仅管理员
 *  ② sendJson / staticHandler 协商 gzip
 *  ③ store._write 原子写（tmp + rename），写坏不再可能
 *  ④ 静态资源 ETag/304
 *  ⑤ X-Lxh-Error 业务失败标记（监控可识别，状态码契约不变）
 *  ⑥ 恢复 requestTimeout/headersTimeout 默认（ Slowloris 防线）
 *  ⑦ 安全基线响应头
 * web.js 会 listen，不能直接 require —— 服务端部分用源码契约断言；
 * store 部分做真实行为测试。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let pass = 0
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  PASS', label) }

const webSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'web.js'), 'utf8')
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'store.js'), 'utf8')
const authSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'auth.js'), 'utf8')
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'auth-bg.js'), 'utf8')

console.log('--- ① /api/config 凭据不外泄 ---')
ok(/function sanitizeConfig\(cfg\)/.test(webSrc), 'sanitizeConfig 已定义')
ok(/config: isAdmin \? store\.config : sanitizeConfig\(store\.config\)/.test(webSrc), 'GET config 非管理员拿掩码版')
ok(/c\.adminPassword = ''/.test(webSrc) && /c\.ghToken = ''/.test(webSrc), '剥离 adminPassword 与 ghToken')
ok(/platforms\.map\(p => Object\.assign\(\{\}, p, \{ password: '' \}\)\)/.test(webSrc), '剥离各平台 password')
ok(/仅管理员可修改配置/.test(webSrc) && /route\('POST', '\/api\/config'[\s\S]{0,400}仅管理员可修改配置/.test(webSrc), 'POST config 仅管理员')

console.log('--- ② 协商 gzip ---')
ok(/require\('zlib'\)/.test(webSrc), '引入 zlib')
ok(/gzipSync\(body\)/.test(webSrc) && /Content-Encoding.*gzip/.test(webSrc), 'sendJson 大响应 gzip')
ok(/body\.length > 1024/.test(webSrc), '小响应不压（<1KB）')
ok(/zlib\.gzipSync\(cached\.data\)/.test(webSrc) && /javascript\|css\|html\|svg\|json/.test(webSrc), '静态资源文本类 gzip、二进制不压')

console.log('--- ③ store._write 原子写 ---')
ok(/renameSync\(tmp, f\)/.test(storeSrc) && /const tmp = f \+ '\.tmp'/.test(storeSrc), 'tmp + rename 两步写')
ok(/catch \(e1\)/.test(storeSrc) && /writeFileSync\(f, JSON\.stringify\(obj\)/.test(storeSrc), 'rename 失败回退直接写（不比旧行为差）')
;(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxh-atomic-'))
  const mod = require(path.join(__dirname, '..', 'src', 'core', 'store.js'))
  const s = new mod.Store(dir)
  s.config.ghToken = 'tok-1'
  ok(s.saveConfig({}) === true, 'saveConfig 成功')
  ok(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).ghToken === 'tok-1', '内容完整可读回')
  ok(!fs.existsSync(s.configFile + '.tmp'), 'rename 后无 .tmp 残留')
  fs.rmSync(dir, { recursive: true, force: true })
})()

console.log('--- ④⑤⑥⑦ ETag / X-Lxh-Error / 超时 / 安全头 ---')
ok(/if-none-match.*=== etag/.test(webSrc) && /res\.writeHead\(304, \{ ETag: etag \}\)/.test(webSrc), 'If-None-Match 命中回 304')
ok(/ETag: etag/.test(webSrc), '响应携带 ETag')
ok(/X-Lxh-Error.*'1'/.test(webSrc) || /setHeader\('X-Lxh-Error', '1'\)/.test(webSrc), '业务失败带 X-Lxh-Error 头（监控可识别）')
ok(/server\.requestTimeout = 300000/.test(webSrc) && /server\.headersTimeout = 60000/.test(webSrc), '超时恢复默认（Slowloris 防线回来了）')
ok(/X-Content-Type-Options.*nosniff/.test(webSrc) && /X-Frame-Options.*SAMEORIGIN/.test(webSrc) && /Referrer-Policy.*no-referrer/.test(webSrc), '三个安全基线响应头')
ok(/"public" 指"公开音源"，不是"免鉴权"/.test(webSrc), 'list/public 命名歧义已注释说明')
ok(/建议混合字母、数字与符号/.test(authSrc), '密码文案带强度建议（规则未强改）')

console.log('--- ⑧ auth-bg.js 解析开销优化（一次读取传参）---')
ok(/function readSetting\(cachedLib\)/.test(bgSrc), 'readSetting 支持传入已解析的库')
ok(/function applySetting\(setting, root, nonce, cachedLib\)/.test(bgSrc), 'applySetting 支持 cachedLib')
ok(/function renderLib\(activeId, cachedLib\)/.test(bgSrc) && /function syncFoot\(v, cachedLib\)/.test(bgSrc), '渲染链支持 cachedLib')
ok(/const lib = readLib\(\)\n      const v = readSetting\(lib\)/.test(bgSrc), 'refreshAll 只解析一次')
ok(!/renderHead\(readLib\(\)/.test(bgSrc), 'renderHead 不再自己重新读库（调用方传 lib）')
ok(!/findItem\(null, v\.itemId\) : null/.test(bgSrc), 'syncFoot 用传入的库（不再 readLib）')
ok(/applySetting\(v, null, freshNonce\(\), lib\)/.test(bgSrc), 'activate 的 applySetting 复用 lib')

console.log('--- ⑫ P-1429 #6：patrolDisableAfter 暴露到设置页 ---')
ok(/patrolDisableAfter: 2,/.test(storeSrc), 'store 默认 patrolDisableAfter=2（原先无此键恒隐藏 2）')
ok(/id="cfgPatrolDisableAfter" type="number" min="1" max="20"/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')), '设置页已暴露自动禁用阈值')
ok(/patrolDisableAfter: Math\.max\(1, Math\.min\(20/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')), '保存链路带范围钳制（1-20）')
ok(/自动禁用.*先于.*自动删除|禁用次数应 ≤ 删除次数/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')), '页面说明「先禁后删」次序')

console.log('--- ⑬ P-1429 #6 扩展：灌入后启用改为账号级 ---')
const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'services', 'index.js'), 'utf8')
const lxSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'services', 'lxserver.js'), 'utf8')
ok(/function resolveEnableAfterImport\(acct, config\)/.test(idxSrc), 'getBatchImportAccounts 统一解析账号级开关')
ok(/enableAfterImport: p\.enableAfterImport !== undefined \? p\.enableAfterImport : globalOn|resolveEnableAfterImport\(p, config\)/.test(idxSrc), '账号值优先、未设回退全局')
ok(/Object\.assign\(\{\}, cur\.acct, \{ enableAfterImport: resolveEnableAfterImport/.test(idxSrc), 'active 兜底路径同样解析')
ok(/acct\.enableAfterImport !== undefined\) cfg\.enableAfterImport = acct\.enableAfterImport/.test(lxSrc), 'lxserver toCfg 透传账号级字段（修复 Web 版全局开关失效）')
const accHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')
ok(/id="accEnableAfter"/.test(accHtml), '账号弹窗有「灌入后自动启用」勾选框')
ok(/accEnableAfter'\)\.checked/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')), '弹窗初始值：账号值优先、跟随全局')

console.log('--- ⑭ P-1430：混淆隔离优化（空正文清残留 + 域名画像）---')
const hunterSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'hunter.js'), 'utf8')
const checkerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'checker.js'), 'utf8')
ok(/function obfDomains\(code\)/.test(checkerSrc), 'checker 提供 obfDomains 域名画像');ok(/正文拿不到的条目不隔离，且要清掉历史残留/.test(hunterSrc), '空正文的隔离残留自动清回音源库')
ok(/e\.obfDomains = obfDomains\(code\)/.test(hunterSrc), '隔离时记录外联域名画像')
ok(/obfDomains, obfDomainVerdict/.test(checkerSrc), 'checker 导出 obfDomains/obfDomainVerdict')
ok(/外联：/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')), '隔离页显示外联域名画像')

console.log('--- ⑮ P-1431：规则制自动信任（用户要求：不要每次人工信任）---')
ok(/function obfDomainVerdict\(domains, customList\)/.test(checkerSrc), 'checker 提供自动信任判定 obfDomainVerdict')
ok(/autoTrustCleanObf !== false && e\.contentHash && !trustedHashes\.includes/.test(hunterSrc), '闸门检测路径有自动信任判定（可关）')
ok(/hardHit = \(hh\.spinLoops \|\| 0\) > 0/.test(hunterSrc), '硬特征条目永不自动信任')
ok(/obfDomainVerdict\(obfDomains\(code\)\.concat\(urls\), cfg\.trustedObfDomains\)/.test(hunterSrc), '判定域 = 静态外联 + 沙箱实测取链 URL')
ok(/自动信任 \$\{autoTrusted\} 条/.test(hunterSrc), '自动信任有日志可追溯')
ok(/Array\.isArray\(cfg\.trustedObfHashes\)\) cfg\.trustedObfHashes = \[\]/.test(hunterSrc), 'trustedHashes 挂回 cfg（修复首签丢失隐患）')
ok(/autoTrustCleanObf: true,/.test(storeSrc), '默认开启')
ok(/id="cfgAutoTrustObf"/.test(accHtml), '设置页有自动信任开关')
ok(/id="cfgTrustedObfDomains"/.test(accHtml), '设置页有自定义白名单输入框')
ok(/autoTrustCleanObf: \$\('cfgAutoTrustObf'\)\.checked/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')), '读写链路接通')

console.log('--- ⑰ P-1432：检测口径「未测 vs 不可用」+ dedupe 完整性守卫 ---')
const checkerSrc3 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'checker.js'), 'utf8')
ok(/const attemptsBefore = metrics\.attempts/.test(checkerSrc3), 'testPlatform 记录 dispatch 前 attempts 基线')
ok(/metrics\.attempts === attemptsBefore &&\s*\n\s*\/已知失败\|跳过重复请求\|RATE_LIMIT\|限流\/i\.test\(lastMsg\)\) {\s*\n\s*return done\(\{ status: 'untested'/.test(checkerSrc3), '脚本拦截类拒绝记 untested（语义白名单，网络错误仍 failed）')
ok(/多个平台报同一个错/.test(checkerSrc3), 'hint 文案修正（不再声称「所有平台」）')
ok(/this\._deepIncomplete\(cur\) \|\| this\._deepIncomplete\(e\)/.test(hunterSrc), '_dedupe 深检完整性守卫（含 untested 不定胜负，共用 _deepIncomplete）')
ok(/vals\.some\(pl => !pl \|\| pl\.status === 'untested' \|\| pl\.status === 'pending'\)/.test(hunterSrc), '完整性判定覆盖 untested/pending')

console.log(`\nsecurity-hardening: PASS ${pass} / FAIL 0`)

console.log('--- ⑯ P-1508 规则化：同名冲突自动补测 ---')
const hunterSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'hunter.js'), 'utf8')
ok(/async _supplementConflicts\(plans, codeCache, cfg\)/.test(hunterSrc2), '证据补齐层已实现（照 _probeTierForConflicts 模式）')
ok(/await this\._supplementConflicts\(plans, codeCache, cfg\)/.test(hunterSrc2), '调用点在规划之后、音质档补测之前')
ok(/usableN >= srvN\) continue/.test(hunterSrc2), '判据：实测已达标不补测')
ok(/metrics\.depth === 'full' && untestedN === 0 && e\.deep\.checkedAt/.test(hunterSrc2), 'P-1432：只有 full 且无 untested 才算新鲜完整证据（full+untested 仍补测）')
ok(/quickCheck: false/.test(hunterSrc2), '补测用全平台深检（写回 e.deep）')
ok(/item\.srv \|\| srvByName/.test(hunterSrc2), 'skip 项补带 srv 引用（老数据按名回查）')
ok(/自动补测 \$\{probes\} 条 → 重新裁决改判/.test(hunterSrc2), '补测结果有日志可追溯')

console.log('--- ⑱ P-1432 R1/R3/R4：excluded 明细 + 强制重测 + 同名并存自动深检 + @repository ---')
const hunterSrc3 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'hunter.js'), 'utf8')
const checkerSrc4 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'checker.js'), 'utf8')
const appSrc4 = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8')
ok(/excludedReasons: excludedList\.slice\(0, 50\)/.test(hunterSrc3), '/api/check 返回体带排除明细')
ok(/点条目的「强制重测」可纳入检测/.test(hunterSrc3), 'deprecated 排除原因写明重测入口')
ok(/\(opts && opts\.force\) && e\.deprecated/.test(hunterSrc3), 'force 时纳入 deprecated 条目')
ok(/_deepIncomplete\(prev\.entry\) \|\| this\._deepIncomplete\(e\)\) continue/.test(hunterSrc3), '本批内同名即时去重也有完整性守卫（r2 路径封堵）')
ok(/async _autoDeepPendingDuels\(cfg\)/.test(hunterSrc3), '同名并存组自动深检跟进（R3）')
ok(/autoDeepPendingDuels !== false && !this\.cancelRequested/.test(hunterSrc3), '自动深检有开关（默认开）且响应取消')
ok(/同名并存自动深检完成 \$\{probes\} 条 → 重新去重裁决/.test(hunterSrc3), '深检后重新去重收敛')
ok(/repository: \/@repository\\s\+\(\.\+\)\//.test(checkerSrc4), 'extractMeta 认 @repository（R4）')
ok(/entry\.repository = meta\.repository \|\| entry\.repository/.test(checkerSrc4), 'entry.repository 写回且保留已有值')
ok(/entry\.homepage = meta\.homepage \|\| entry\.homepage/.test(checkerSrc4), 'homepage 不再被覆写成空')
ok(/e\.deprecated \? '强制重测' : '检测'/.test(appSrc4), 'deprecated 条目按钮显示「强制重测」')
ok(/autoDeepPendingDuels: true,/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'store.js'), 'utf8')), '自动深检默认开')

console.log('--- ⑲ P-1432 R3 补充：autoDeepPendingDuels 设置页开关 ---')
ok(/id="cfgAutoDeepDuels"/.test(accHtml), '设置页有「同名并存自动深检」勾选框')
ok(/cfgAutoDeepDuels'\)\.checked/.test(appSrc4), '读写链路接通（默认跟随 config，未设即开）')
ok(/autoDeepPendingDuels: \$\('cfgAutoDeepDuels'\)\.checked/.test(appSrc4), '保存链路写回 config')

console.log('--- ⑳ P-1432 日志核查优化：弱名守卫 + 限流退避 ---')
const hunterSrc4 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'hunter.js'), 'utf8')
ok(/if \(isWeakBaseName\(nm\)\) continue\s+\/\/ P-1432 实测：'main' 通用名组/.test(hunterSrc4), 'autoDeep 分组复用弱名守卫（main 组 6 条白耗预算实测）')
ok(/\/RATE_LIMIT\|限流\|已知失败\/i\.test\(String\(pl\.message \|\| ''\)\)\)/.test(hunterSrc4), '限流退避按 untested 的限流文案判定')
ok(/Date\.now\(\) - e\.deep\.checkedAt < 30 \* 60 \* 1000\)\s*\{\s*rlSkip\+\+/.test(hunterSrc4), '限流冷却 30 分钟内跳过无效重试')
ok(/限流冷却中跳过 \$\{rlSkip\} 条/.test(hunterSrc4), '跳过数进汇总日志可追溯')
