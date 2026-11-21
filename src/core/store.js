'use strict'
/** 本地持久化：配置 / 音源库 / 已灌入记录，存于 Electron userData 目录 */
const fs = require('fs')
const path = require('path')
const { usableCount, obfuscationRisk, classifyQuarantineTrust } = require('./checker')
const { DEFAULT_REPOS, normalizeRepo } = require('./crawler')
const { cmpVersion } = require('./version')

const DEFAULT_CONFIG = {
  serverUrl: '',
  // lxserver 的管理员密码（自定义源接口 /api/custom-source/* 的 x-frontend-auth，
  // 即服务端配置里的 frontend.password）。
  // 注意与 LX 网页「用户账号登录」密码是两套体系：出厂默认见 lxserver 文档，
  // 若改过 frontend.password，这里要同步改（不要在任何地方硬编码真实口令）。
  adminPassword: '',
  username: 'default',
  // ---------------- 多平台 / 多账号（v1.8.0） ----------------
  // 把所有「服务平台账号」统一管理：每个账号一份连接配置，可配置多个平台（lxserver /
  // songloft / musicsync）、每个平台多个账号，并指定其中一个为「当前选中」（灌入 / 同步 /
  // 巡检 / 撤回等操作都作用于它）。
  // 旧版单账号字段（serverUrl / adminPassword / username / serverTimeoutMs）首次启动会
  // 自动迁移成下面 platforms 数组里的第一个 lxserver 账号（见 Store 构造里的 _migratePlatforms）。
  platforms: [],
  activePlatformId: null,
  ghToken: '',
  mirror: 'auto',
  // ---------------- 网络加速 / 代理策略（v1.11.0 统一重整） ----------------
  // crawlProxy：HTTP 代理（http://host:port）。作用于 GitHub 爬取链（raw / release / 仓库扫描）
  // 与第三方站点取数（采集站 hubfeed、网页音源站、站外分发源 websource）；
  // 不影响音源检测的播放请求与灌入。
  // proxyPolicy：off=全局不用代理；auto=第三方站点代理优先、GitHub 走直连+镜像（默认）；
  // force=在 auto 基础上把代理插到 GitHub 候选链最前。forceProxy 是旧字段，写入时与之同步。
  // useJsdelivr：jsDelivr 是否参与镜像候选链；mirrorCustom：镜像选「自定义…」时的前缀基址。
  // P-1434 采集特征库：候选路径/文件名含这些关键词的**不采集**（子串、忽略大小写）。
  // 手动维护（设置→采集源→采集特征库）+ 自动学习（判定「缺少洛雪音源特征」的
  // 非音源脚本自动入册，见 hunter._autoLearnBlockPattern，上限 300 条防膨胀）。
  crawlerBlockPatterns: ['示例音源', '示例脚本', '插件', 'plugin', 'template', '模板'],
  crawlProxy: '',
  proxyPolicy: 'auto',
  forceProxy: false,
  useJsdelivr: true,
  mirrorCustom: '',
  customRepos: [],
  // ---------------- 统一仓库清单（v1.9.12，全部可管理） ----------------
  // repos：内置/附加/发现三类仓库的统一清单，每项是 {repo, enabled, builtin, origin}。
  // 用户可对任一仓库勾选「禁用」（本次不爬）或「删除」（从清单移除）；内置仓库删除后可用「恢复默认」找回。
  // 未初始化（null）时由 _ensureRepoList 从 DEFAULT_REPOS + 旧 customRepos 播种；
  // 一旦是数组（哪怕为空）即尊重用户编辑，不再自动播种。
  // 注意：这里必须是 null 而不是 []——空数组表示「用户已清空清单」，不能再被播种覆盖。
  repos: null,
  // ---------------- 抓取发现（v1.9.9，借鉴 lxhub 关键词搜索发现） ----------------
  // searchEnabled：用关键词在 GitHub 搜索新仓库，作为种子列表的增量补充（默认关，需手动开启）。
  // searchKeywords：搜索关键词（中文）；maxReposPerKeyword/maxSearchReposTotal：每词/全局上限；
  // searchMinStars：最小 star 门槛（0=不限），过滤噪声仓库，避免把 star 极少的仓库也爬进来。
  searchEnabled: false,
  searchKeywords: [
    'lx 音源', '洛雪 音源', 'lx-music 音源', 'lx music 自定义源', 'lxmusic',
    '洛雪音乐 音源', 'lx音乐源', '洛雪音乐 源', 'lx 源脚本', '洛雪音源js'
  ],
  maxReposPerKeyword: 20,
  maxSearchReposTotal: 60,
  searchMinStars: 0,
  // searchVerify：内容验真（v1.9.14）。名字/描述像音源仓库不代表真有脚本——
  // 实测 60 个命中里只有 32 个真含音源，其余是客户端/播放器/API。开启后逐个看文件树
  // 抽检 .js、并放行「压缩包分发」与「Release 资产分发」两类仓库。默认开。
  searchVerify: true,
  // v1.10.3：搜索发现节流。每轮爬取都跑关键词搜索会白烧配额（新音源仓库不会那么快冒出来），
  // 改为距上次 searchDiscoverAt 满 searchDiscoverHours 小时才跑一次；0=不节流（每轮都搜）。
  searchDiscoverHours: 24,
  searchDiscoverAt: 0,
  // v1.10.3：失效仓库自动清理。爬取时对确定性 404（仓库不存在/已删）的条目，爬完自动从
  // 仓库清单移除（仅非内置条目；内置条目可用「恢复默认」找回，不自动删）。
  // 只认 404，网络抖动/5xx/限流一律不删，避免误删暂时不可达的仓库。默认开。
  autoCleanDeadRepos: true,
  // 非音源仓库黑名单（v1.10.3）：被「清理非音源仓库脚本」判定删除的仓库（播放器/管理器/网关等）。
  // 记在这里后，搜索发现与社区精选都不会再把它们加回清单，避免「清了又回来」。
  blockedRepos: [],
  // 黑名单旁路表（v1.16）：记每个被拉黑仓库的来源与快照，供 UI 显示来源徽章 + 解除时按快照还原脚本。
  // 结构 { 'owner/repo': { by:'ai'|'user', reason, at, snapshot:string[] } }。
  // ⚠️ 只读展示 + 回滚辅助；绝不参与 blockedRepos 的判定逻辑（那是纯字符串数组，不能改结构）。
  blockedMeta: {},
  // 仓库级 AI 语义预判结果（v1.16，复用 coldStart 现成结论，零新增 AI 调用）：
  // { 'owner/repo': { cls:'tool', reason, at } }。只存 tool（uncertain/real 一律不存、不提示），供 UI 建议层展示。
  repoAiHints: {},
  // 搜索发现验真的负缓存（v1.17，配额优化 #1）：{ 'owner/repo': { at, reason } }。
  // **只存确定性判死**（ok:false 且非限流/网络/超时），TTL 默认 7 天（ghNegativeTtlDays 可调）。
  // 目的：搜索发现每 24h 会把 40~50 个「名字像音源、实际无音源」的仓库全量重验（3~4 次/仓），
  // 而结论 7 天内不会变。命中即跳过验真，单轮可省一半以上配额。
  // ⚠️ 与 blockedRepos 无关：这里不拉黑、不影响采集，仓库补了音源就会在下次验真通过后自动删除。
  ghNegativeCache: {},
  ghNegativeTtlDays: 7,
  // ---------------- 站外分发源（v1.11.0）----------------
  // externalSources：用户显式添加的 Pages / 自建域名 / 对象存储直链源，与仓库清单并列的一类采集源。
  // 每项 {url, name, enabled, origin:'external', kind, addedAt, lastProbe, lastCrawl}。
  // 刻意不放进 repos：repos 规范化只保留 repo/enabled/builtin/origin 四个字段，
  // 且「清理非音源仓库」会对 repos 里的每条做 GitHub 验真（URL 必然 404 → 误删好源）。
  // buildRepoSeeds 会把 enabled 的站外源 URL 并进爬取种子，全链路（手动/定时/行级采集）自动复用。
  externalSources: [],
  // 站外源时间窗指纹：{ [url]: {hash, at} }。站外源没有 Git 提交/发布时间，
  // 用「响应体指纹是否变化」等价判定「sinceDays 天内有没有新音源」（见 websource.js）。
  // 独立于 externalSources，是为了让从旧「网页音源站」入口加进 repos 的 URL 也吃到同一时间窗。
  externalStates: {},
  // ---------------- 社区精选订阅（v1.9.18，借鉴 lx-hub 的 community.json market） ----------------
  // communityEnabled：爬取时拉取 zlyon/lx-hunter-market 维护的社区精选清单
  // （人工提交、维护者审核，带 submitter/approvedAt），把其中 type=repo 的条目并入种子
  // （origin=community，进统一仓库清单后可单独禁用/删除）。默认开：只多一次 HTTP 拉取
  // （30 分钟缓存，走镜像链），不额外烧 GitHub 配额；拉取失败只记 warn 不影响爬取。
  // communityFeedUrl：自定义订阅源地址（留空 = 内置官方地址）。
  communityEnabled: true,
  communityFeedUrl: '',
  // ---------------- 接口域名探活（v1.9.10，借鉴 lxhub 的 api_hosts/api_alive） ----------------
  // apiHostCheck：检测时额外对脚本引用的后端域名做轻量存活探测（默认关，开启会为每个音源多发若干请求）。
  apiHostCheck: false,
  // v1.9.15：批量补探。探活开关是后开的，库里大量历史音源身上没有 apiAlive，
  // 而主检测走「跳过已检测」分支不重新拉代码，探测永远补不上 → 音源库的
  // 「后端N在线/失效」徽章一直是空的。主检测收尾后单独挑一批缺结果的补探，
  // 每轮限量（apiHostBackfillMax，0=不补探）＋并发＋时间预算，慢慢把全库补齐。
  apiHostBackfillMax: 200,
  apiHostBackfillConcurrency: 6,
  apiHostBackfillBudgetMs: 180000,
  maxCandidatesPerRepo: 400,
  timeoutMs: 15000,
  linkTimeoutMs: 20000,
  serverTimeoutMs: 25000,
  concurrency: 8,
  quickCheck: true,
  skipChecked: true,
  hashDedupeAfterCrawl: true,
  patrolEnabled: false,
  patrolIntervalHours: 12,
  // 巡检失败（常见于推送服务端没开 / 网络不通）后的重试间隔，单位分钟。
  // 旧逻辑失败时不推进调度水位，每分钟轮询都会判「到期」并真跑一轮 → 日志刷屏。
  // 默认 15 分钟：不刷屏，服务端恢复后也不用等满整个巡检间隔。上限不超过主间隔。
  patrolRetryMinutes: 15,
  crawlScheduleEnabled: false,
  crawlIntervalHours: 24,
  crawlSinceDays: 0,
  // v1.10.0「只收最新版」：爬取时按归一化音源名分组，同一音源只收版本号最高的一个
  // 候选（旧版本不下载不入库）。组内无可比较版本号/弱名时全部保留，交给内容去重裁决。
  crawlLatestOnly: true,
  // v1.9.0：定时爬取跑完后自动接上「检测 → 灌入」（全链路无人值守）。
  // 从属于 crawlScheduleEnabled：定时爬取本身没开，也就无所谓「爬完自动灌」。
  crawlAutoImport: false,
  // 同名音源裁决的**兜底**开关（不是全部规则！）：
  // 灌入时先按 hunter.sameNameVerdict 里那 6 条硬规则判（同名同内容不重传 / 本地全挂不替换 /
  // 服务端平台更多保留现条目 / 版本高的赢 / 平台无交集则改名并存 / 有交集则替换），
  // 全都判不出来（两边信息都不足）时才看这里：true=替换服务端旧版（先删后传），false=改名并存。
  replaceSameNameOnImport: true,
  // 2026-11-10 23:28 用户口径修正：不再有「综合质量分」，也就没有权重/门槛类设置项。
  // 同名裁决改用字典序（可用平台数 → 最高可播档 → p50 延迟，延迟噪声带 300ms 写死在
  // quality.LATENCY_MARGIN_MS），所以这里不需要 qualityWeights/MinSamples/... 一串参数 ——
  // 少一组可调参数就少一处「配置漂移导致裁决翻案」的风险。
  patrolAutoDisable: true,
  // v1.9.1：巡检连续失效「自动删除音源」。
  // 与 patrolAutoDisable（自动禁用）的区别：禁用只是把该音源在五个平台上的开关关掉、
  // 音源本体仍留在库里；自动删除则是从服务端 + 本地库一并移除（服务端每次 delete 都会全量
  // 重载脚本，故删除需严格串行化并保留 serverDeleteIntervalMs 间隔，避免服务端假死）。
  // patrolAutoDelete=false（默认）时仅禁用不删；开启后连续 patrolDeleteAfter 次（默认 3）
  // 巡检判定 dead 才走删除。注意：本地（未灌入服务端）的音源无论开关如何都只禁用、不删。
  // v1.13.7 P-1431：重度混淆脚本自动信任规则（见 checker.obfDomainVerdict）。默认开：
  // 无硬特征 + 沙箱实测外联全白名单 → 检测后自动放行，不再等人工点信任。
  autoTrustCleanObf: true,
  // P-1432 R3：同名并存组自动深检跟进（检测收尾把 quick 证据升级 full，让去重裁决收敛）
  autoDeepPendingDuels: true,
  // P-1432（v1.13.8）：脚本更新信号追更（lx.request 响应嗅探 + updateAlert 双通道）
  autoFollowScriptUpdate: true,
  // v1.15.x 阶段A：追更策略（autoFollowScriptUpdate 总闸之下的细分，二者 AND）。
  //   all（默认）=完全等同现网：按 updateUrl 追更、不看 msg 文案；
  //   substantive=按更新说明过滤，只追写明修复/新功能的实质更新；
  //   off=关闭追更（等同 autoFollowScriptUpdate:false）。
  autoFollowPolicy: 'all',
  // v1.15.x 阶段B：追更地址的 AI 安全否决（单向否决，AI 只回答"安不安全"，不决定追不追）。
  //   off（默认）=完全不调 AI＝现网行为；
  //   shadow=调 AI 产 danger 标记 + 旁路日志，但 danger=true 也**不真阻断**，仅供影子观察；
  //   enforce=danger=true 时真阻断（代码就绪但**默认绝不开**，达门槛后由用户单独拍板）。
  //   安全不对称：只有 danger===true 阻断；false/unknown/超时/报错/坏JSON/AI关闭一律放行。
  aiFollowVeto: 'off',
  trustedObfDomains: [],
  patrolAutoDelete: false,
  patrolDeleteAfter: 3,
  // v1.13.4：巡检「连续失效自动禁用」的阈值（patrolJudge 的 streak 达到即处置、
  // apiDownVerdict 的域名判死同用此值）。之前无 config 键也无 UI，恒为隐藏默认 2（P-1429 #6）。
  // 语义次序：失效 streak 先到 patrolDisableAfter → 禁用；继续失效到 patrolDeleteAfter 且
  // patrolAutoDelete 开 → 删除。所以本值应 ≤ patrolDeleteAfter 才有「先禁后删」。
  patrolDisableAfter: 2,
  enableAfterImport: true,
  autoAllowUnsafeVM: false,
  allowUnsafeVM: false,
  skipUnusable: true,
  // 自动剔除高危混淆/反调试脚本（v1.7.1 引入时默认关，v1.9.5 起默认开）：
  // 开启后检测阶段与每次灌入前都会拒绝 high 级脚本——密度超高阈值，或命中反调试硬特征
  // （while(!![]){} 空转死循环 / 混淆自调度定时器 / jsjiami 标识）。
  // 依据：lx-ikun issue#8（音源脚本没有混淆的必要）+ 2026-10-15 NAS CPU 占用实测
  // （jsjiami.com.v7 混淆的「洛雪音乐源.js」独吞 63%~67% 单核 + 270MB，其余 45 个源合计≈0%）。
  // mid 级（局部混淆）只标注不剔除，由用户自行甄别。
  excludeHighRiskObfuscated: true,
  // 混淆隔离信任名单（v1.10.7）：被隔离条目的 contentHash 列表。
  // 用户在「混淆隔离」页对无恶意硬特征的混淆脚本点「信任」后，检测/灌入两道闸门按
  // 内容哈希放行（内容一变哈希就变，重新混入隔离区——信任不跟随未知的新版本）。
  // 只豁免这一个维度：深度体检 / 巡检 / 可用性判定照常执行。
  trustedObfHashes: [],
  // 批量删除公开源时，每个删除之间的间隔（毫秒）。
  // 背景：lxserver 每次 delete 都会全量重载所有脚本，连续删除会把服务端拖到假死
  // （v1.6.8 教训：12 连删导致 Docker 重启）。留间隔让服务端喘口气。
  serverDeleteIntervalMs: 5000,
  // ---------------- AI 复检层（旁路，默认全关 v1.14.0） ----------------
  // 只补规则制判断不了的语义灰区（失败聚类 / 裁决解释 / 意图审查），不参与"能不能用"判定。
  // provider 完全开放：任何实现 OpenAI /chat/completions 协议的中转站都能接——
  // baseUrl 填到根（如 https://api.deepseek.com/v1 或自建中转），model 填该中转站支持的模型名，
  // headers 可填该中转站要求的额外鉴权头（如某些中转用 Authorization 之外的自定义头）。
  aiReview: {
    enabled: false,                 // 总闸，默认关（关闭时手动/自动两挡全停）
    mode: 'off',                    // 废弃授权语义，仅派生显示 + 老配置兼容
    autoEnabled: false,             // 自动挡刹车：定时/事件触发是否跑（默认关）
    allowIrreversible: false,       // 不可逆第三把锁，默认否
    // v1.15.0 操作授权（两挡共用）：默认都只给意见；旁路两项保留既有零误伤自动化。
    autoActions: {
      clusterLog: true, readonlyReview: true, autoMark: false,
      R4: false, R5: false, R6: false, R7: false, R10: false, irreversible: false
    },
    evalExecutorsEnabled: false,    // 真实 executor + audit/undo 仅评测沙箱可用
    provider: {
      baseUrl: '',                  // OpenAI 兼容端点根地址，用户自定义（不锁死厂商）
      apiKey: '',                   // Bearer 密钥；非管理员脱敏（见 web.js sanitizeConfig）
      model: '',                    // 模型名，按中转站实际支持填写
      headers: {},                  // 额外请求头（可选），如 { 'X-Api-Key': '...' }
      timeoutMs: 20000              // 单次超时，超时即放弃、不阻塞主链路
    },
    budget: { perItemMs: 20000, perRoundMs: 180000, maxItemsPerRound: 20 },
    evidencePolicy: 'all-signals',  // 证据门槛：全部满足才允许自动，缺项降级人工
    // R1 失败聚类周期（小时）：一周一次（168 小时），避免每轮巡检都重算失败根因
    clusterIntervalHours: 168,
    // R1 样本驱动语义自生长：本地规则先跑，仅"其他失败"攒够样本才调 AI 归纳新类别
    clusterLearnEnabled: true,       // 归纳开关（总开关 enabled 关时不学）
    clusterLearnMinSamples: 5,       // 同类未匹配样本达到此数才归纳，防噪声
    clusterLearnMaxRules: 40,        // 学到的类别规则上限，防规则表膨胀
    // ---------------- 自动挡调度参数 ----------------
    autoIntervalHours: 24,           // 自动只读复检周期（小时），默认每日；R1 聚类仍用 clusterIntervalHours=168
    autoScope: 'failed',             // 自动范围：new/failed/all（quarantined 已并入 failed），默认仅失败源
    autoMaxItems: 20,                // 自动每轮上限
    autoActiveHours: { start: 0, end: 24 },  // 允许时段，默认全天
    shadowEval: false,               // 影子评测开关：AI 决策只记不执行，默认关
    autoLlmReviewEnabled: false      // 自动档逐条 LLM 复检独立开关，默认关（R3润色+R4/R5铺轨零进化价值；评测达标再开）
  },
  debugMode: false
}

class Store {
  constructor(dir) {
    this.dir = dir
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    this.configFile = path.join(dir, 'config.json')
    this.dbFile = path.join(dir, 'sources.json')
    this.importedFile = path.join(dir, 'imported.json')
    const rawCfg = this._read(this.configFile)
    this.config = Object.assign({}, DEFAULT_CONFIG, rawCfg)
    // v1.16：两组旁路表兜底（老配置缺失/null 时补成空对象，绝不因缺键报错）
    if (!this.config.blockedMeta || typeof this.config.blockedMeta !== 'object' || Array.isArray(this.config.blockedMeta)) this.config.blockedMeta = {}
    if (!this.config.repoAiHints || typeof this.config.repoAiHints !== 'object' || Array.isArray(this.config.repoAiHints)) this.config.repoAiHints = {}
    // v1.17：搜索发现验真负缓存兜底（老配置缺失/null 时补空对象）
    if (!this.config.ghNegativeCache || typeof this.config.ghNegativeCache !== 'object' || Array.isArray(this.config.ghNegativeCache)) this.config.ghNegativeCache = {}
    // AI 复检配置深合并：浅合并会让旧配置文件里半截 aiReview 覆盖掉默认 provider 字段，
    // 导致缺 headers/timeoutMs 等键。逐层补齐默认，且只补缺失键、尊重用户已存值。
    if (rawCfg && rawCfg.aiReview && typeof rawCfg.aiReview === 'object') {
      const d = DEFAULT_CONFIG.aiReview
      const a = this.config.aiReview
      a.provider = Object.assign({}, d.provider, a.provider || {})
      a.budget = Object.assign({}, d.budget, a.budget || {})
      // 新键兜底：浅合并时旧 aiReview 会整体覆盖默认，不在这里补齐的话
      // 老配置 upgrade 后这些键直接丢失。basic 类型 ==null 补默认，对象用 Object.assign。
      if (a.clusterIntervalHours == null) a.clusterIntervalHours = d.clusterIntervalHours
      if (a.clusterLearnEnabled == null) a.clusterLearnEnabled = d.clusterLearnEnabled
      if (a.clusterLearnMinSamples == null) a.clusterLearnMinSamples = d.clusterLearnMinSamples
      if (a.clusterLearnMaxRules == null) a.clusterLearnMaxRules = d.clusterLearnMaxRules
      if (a.autoEnabled == null) a.autoEnabled = d.autoEnabled
      if (a.autoIntervalHours == null) a.autoIntervalHours = d.autoIntervalHours
      if (a.autoScope == null) a.autoScope = d.autoScope
      if (a.autoScope === 'quarantined') a.autoScope = 'failed'  // v1.15.0 旧值迁移
      if (a.autoMaxItems == null) a.autoMaxItems = d.autoMaxItems
      if (a.shadowEval == null) a.shadowEval = d.shadowEval
      if (a.autoLlmReviewEnabled == null) a.autoLlmReviewEnabled = d.autoLlmReviewEnabled
      a.autoActiveHours = Object.assign({}, d.autoActiveHours, a.autoActiveHours || {})
      // v1.15.0 autoActions 逐键补齐（尊重用户已存值）
      a.autoActions = Object.assign({}, d.autoActions, a.autoActions && typeof a.autoActions === 'object' ? a.autoActions : {})
      if (a.evalExecutorsEnabled == null) a.evalExecutorsEnabled = d.evalExecutorsEnabled
      // mode 合法性（兼容老配置）
      if (a.mode !== 'off' && a.mode !== 'assist' && a.mode !== 'auto') a.mode = d.mode
      // 老库迁移：无 autoActions 标志的老配置，按 mode 推导 autoEnabled / autoActions.autoMark；
      // 只补缺失、不翻盘用户显式设置。设 _legacyAiMigrated 标记避免重复迁移。
      if (!a._legacyAiMigrated) {
        const legacy = rawCfg && rawCfg.aiReview && rawCfg.aiReview.autoActions == null
        if (legacy) {
          if (a.mode === 'off') a.autoEnabled = false
          else { a.autoEnabled = true; if (a.mode === 'auto') a.autoActions.autoMark = true }
        }
        a._legacyAiMigrated = true
      }
      // 不可逆双锁：allowIrreversible 关则不可逆位与 R6/R7/R10 恒关
      if (!a.allowIrreversible) {
        a.autoActions.irreversible = false
        a.autoActions.R6 = false
        a.autoActions.R7 = false
        a.autoActions.R10 = false
      }
    }
    // v1.11.0：旧配置只有 forceProxy，按它推导 proxyPolicy，保证升级后行为不变
    if (rawCfg && rawCfg.proxyPolicy == null && rawCfg.forceProxy === true) this.config.proxyPolicy = 'force'
    this.db = this._read(this.dbFile) || { sources: {}, lastCrawl: 0, patrol: { lastRun: 0 } }
    if (!this.db.sources) this.db.sources = {}
    // AI 复检评测日志集合（与 aiSuggestions/aiAudit 并列；L1 自动挡只记日志不处置）
    if (!this.db.aiEvalLog) this.db.aiEvalLog = {}
    // R1 样本驱动自生长：未匹配样本池 + 学到的类别规则表（惰性初始化，沿用旁路容器惯例）
    if (!this.db.aiClusterSamples) this.db.aiClusterSamples = {}
    if (!this.db.aiClusterRules) this.db.aiClusterRules = {}
    // P-1432（用户实测截图：检测完成后条目状态卡「检测中…」）：容器重启会打断正在跑的
    // 检测 job，被打断条目的 checking=true 已落盘，重启后永远没人清 → 状态卡死。
    // 启动时清扫：重启后不可能存在正在运行的检测。
    let stuckChecking = 0
    for (const s of Object.values(this.db.sources || {})) {
      if (s && s.checking) { delete s.checking; stuckChecking++ }
    }
    if (stuckChecking) {
      console.log(`[启动] 清扫上次运行中断残留的 checking 标记 ${stuckChecking} 条`)
      this._write(this.dbFile, this.db)   // 立即落盘，避免文件与内存长期不一致
    }
    // v1.15.0：一次性 obf 重算迁移（历史脏数据：旧版把纯 CJK \uXXXX 转义计入 nUni，
    // 判出 obfLevel=high/totalUni 上千，而 checker.js 早已修正口径却没重算已落库条目）。
    // 只刷新 obfLevel/obfHits，不碰 status/quarantine/任何安全字段；只跑一次。
    if (this._migrateObfRecalc()) this._write(this.dbFile, this.db)
    // 历史误隔离复查（v1.15.x）：obf 口径修正后，老版本按旧口径判 high 关进隔离区、
    // 但新口径已不 high 且实测能用的条目，重算迁移只洗白了 obfLevel 却没动隔离状态，
    // 永远卡死（applyObfGate 低风险分支 kept.push 不清隔离标记）。独立一次性迁移复查放行。
    if (this._migrateObfQuarantineRecheck()) this._write(this.dbFile, this.db)
    // 2026-11-22：一次性「同名旧版本误废」迁移（豆包 v12.0 被 v1.4 占位、doujs 9.1.5-r1 被
    // 9.1.1-r1 废弃）——旧版裁决把高版本/预发布新版当成旧版废掉。只在证据悬殊组翻案。
    if (this._migrateWrongDedup()) this._write(this.dbFile, this.db)
    if (!this.db.patrol) this.db.patrol = { lastRun: 0 }
    // v1.10.2 手动删除记录：被删掉的 id 不再由自动采集加回（见 removeSources）
    if (!Array.isArray(this.db.deletedIds)) this.db.deletedIds = []
    // 兜底：清理进程中断残留的「检测中」标记
    for (const k of Object.keys(this.db.sources)) delete this.db.sources[k].checking
    this.imported = this._read(this.importedFile) || {}
    // 多平台模型迁移：把旧版单账号字段收敛进 platforms 数组，保证向后兼容
    if (this._migratePlatforms()) this.saveConfig()
    // 仓库清单迁移（v1.9.12）：首次启动把内置 38 个 + 旧附加仓库播种进统一 repos 清单
    if (this._ensureRepoList()) this.saveConfig()
  }

  /**
   * 一次性 obf 重算迁移（v1.15.0）：
   *  历史脏数据里 obfLevel=high / obfHits.totalUni 上千，是旧版把纯 CJK \uXXXX 转义
   *  计入混淆指标留下的；checker.js:obfuscationRisk 早已改为只数非 CJK 转义，但已落库
   *  的条目没被重算。这里在启动时用当前生产函数重算一遍，口径与检测路径统一。
   *  约束：只刷 obfLevel/obfHits，绝不碰 status/quarantined/usable/act/任何安全字段；
   *  只对「有 code 且带 obf 字段」的条目重算（无 code 的留待下次 checkBasic 自然刷新）；
   *  用 db.obfRecalcMigrated 标记保证只跑一次。返回是否发生过写入。
   */
  _migrateObfRecalc() {
    if (this.db.obfRecalcMigrated === true) return false
    let recalc = 0
    for (const e of Object.values(this.db.sources || {})) {
      if (!e || typeof e !== 'object') continue
      const hasCode = typeof e.code === 'string' && e.code.length > 0
      if (!hasCode || (!e.obfLevel && !e.obfHits)) continue
      let risk
      try { risk = obfuscationRisk(e.code) } catch (_) { continue }
      e.obfLevel = risk.level || ''
      e.obfHits = risk.hits || null
      recalc++
    }
    this.db.obfRecalcMigrated = true
    if (recalc) console.log(`[启动] obf 重算迁移：按当前口径刷新 ${recalc} 条历史混淆标注`)
    return true
  }

  /**
   * 历史误隔离复查（v1.15.x，独立一次性迁移）：
   *  旧版 obfuscationRisk 把纯 CJK \uXXXX 转义计入混淆指标，把一些正常音源判成 high
   *  关进隔离区。checker.js 修正口径后，_migrateObfRecalc 洗白了它们的 obfLevel/obfHits，
   *  但那条迁移刻意不碰 status/quarantined；而 applyObfGate 的低风险分支只是 kept.push
   *  放行，不清隔离标记（hunter.js:2969），于是这些条目「标注已洗白、状态仍隔离」永远卡死，
   *  试跑/自动信任/常规检测三条路都救不了（详见功能体检诊断）。
   *
   *  本迁移只放行**同时**满足以下全部条件的条目（保守，宁可漏放不可误放）：
   *    ① status==='quarantined' || quarantined===true（确实在隔离区）
   *    ② 有 code 且按当前口径重算 obfuscationRisk 不是 high（口径修正后确非重度混淆）
   *    ③ classifyQuarantineTrust 判 allow（零硬特征：spin/eval/sched 全 0）
   *    ④ deep 是正式实测（有 checkedAt 且非 probeOnly）且 usableN>=1（实测确实能出链接）
   *    ⑤ 非 deprecated
   *  放行动作（保守走法）：清 quarantined / status 回 ok，usable 按 usableCount 恢复，
   *  error 清空并记一条可追查的历史说明；**不写 trustedObfHashes、不加白名单域名**——
   *  条目回到正常检测流程，下次检测若内容真高混淆会被 applyObfGate 重新隔离。
   *  外联域名确认权留给用户走隔离页既有的信任流程，绝不替用户签字。
   *  用 db.obfQuarantineRecheckMigrated 保证只跑一次。返回是否发生过写入。
   */
  _migrateObfQuarantineRecheck() {
    if (this.db.obfQuarantineRecheckMigrated === true) return false
    let freed = 0
    for (const e of Object.values(this.db.sources || {})) {
      if (!e || typeof e !== 'object' || e.deprecated) continue
      const inQ = e.status === 'quarantined' || e.quarantined === true
      if (!inQ) continue
      const hasCode = typeof e.code === 'string' && e.code.length > 0
      if (!hasCode) continue
      let risk
      try { risk = obfuscationRisk(e.code) } catch (_) { continue }
      if (risk && risk.level === 'high') continue
      // 用当前口径重算后的标注回写，避免顶着旧的 high 标注放行
      e.obfLevel = risk.level || ''
      e.obfHits = risk.hits || null
      let cls
      try { cls = classifyQuarantineTrust(e, this.config) } catch (_) { continue }
      if (!cls || cls.level !== 'allow') continue
      const deep = e.deep
      if (!deep || !deep.checkedAt || deep.probeOnly === true) continue
      if (usableCount(e) < 1) continue
      // 保守放行：不写 trustedObfHashes、不碰白名单，只解除隔离状态
      e.quarantined = false
      if (e.status === 'quarantined') e.status = 'ok'
      e.usable = true
      e.error = '历史 obf 口径误判已纠正（旧版把纯 CJK 转义计入混淆）：已解除隔离回到正常检测；外联域名未确认，如需信任请自行核实'
      freed++
    }
    this.db.obfQuarantineRecheckMigrated = true
    if (freed) console.log(`[启动] 历史误隔离复查：按当前口径解除 ${freed} 条误判隔离（未写信任名单，内容更新会按现行规则重判）`)
    return true
  }

  /**
   * 2026-11-22 一次性「同名旧版本误废」迁移。
   * 历史裁决把高版本/预发布新版（豆包 v12.0、doujs 9.1.5-r1）当「同名旧版本」废掉，
   * 保留方（低版或未深检版）占据 dupOf 位。旧逻辑下这些错误永久不纠正。
   *
   * 做法：按 keeper（dupOf 目标）分组，把「组内所有成员」放在一起重新择优——
   *   赢家 = 版本更新（cmpVersion）优先；平手时实测可用平台更多者。
   *   仅当新赢家 ≠ 原 keeper 且明显更优（版本更新，或实测可用平台多 ≥2）才翻案；
   *   其余被废条目统一改指到新赢家，避免链式误指。
   * 只改 deprecated/dupOf/dupReason/usable，不碰 code/status/quarantine/private。
   */
  _migrateWrongDedup() {
    if (this.db.wrongDedupMigrated === true) return false
    const src = this.db.sources || {}
    let flipped = 0
    const vOf = e => String((e && (e.scriptVersion || e.scriptName || e.name)) || '')
    const usableN = e => (e && e.deep && e.deep.checkedAt) ? usableCount(e) : 0
    const groups = {}   // keeperId -> [members]
    for (const e of Object.values(src)) {
      if (!e || typeof e !== 'object' || e.fromServer || e.private || !e.contentHash) continue
      // 只处理「被同名旧版本裁决废掉、且指向仍在的 keeper」的条目（deprecated=true 正是迁移对象）
      if (!e.deprecated || !/^同名旧版本/.test(String(e.dupReason || '')) || !e.dupOf) continue
      const keeper = src[e.dupOf]
      if (!keeper || keeper === e || keeper.fromServer || keeper.private) continue
      ;(groups[e.dupOf] || (groups[e.dupOf] = [])).push(e)
    }
    for (const keeperId of Object.keys(groups)) {
      const keeper = src[keeperId]
      const members = groups[keeperId]
      // 候选 = keeper + 所有指向它的被废条目（只纳有 deep 实测的，避免未测脏数据翻案）
      const cands = [keeper, ...members].filter(e => e && usableN(e) > 0)
      if (cands.length < 2) continue
      // 择优：与 betterKeeper 同口径——可用平台数优先（字典序第一维），平手才比版本。
      // 避免「版本数字大但平台少」的 v27.2(2平台) 挤掉「平台多」的 v12.0(3平台)。
      cands.sort((a, b) => {
        const u = usableN(b) - usableN(a)
        if (u !== 0) return u
        return -cmpVersion(vOf(a), vOf(b))
      })
      const win = cands[0]
      if (win === keeper) continue
      // 赢家必须「实测平台更多(≥2)」或「平台数相同但版本更新」，否则含糊不动
      const vUp = cmpVersion(vOf(win), vOf(keeper)) > 0
      const qUp = usableN(win) - usableN(keeper) >= 2
      if (!vUp && !qUp) continue
      // 翻案：赢家复活（原本就是被废成员），原 keeper 废弃并改指赢家
      win.deprecated = false; win.dupOf = null; win.dupReason = null; win.usable = true
      if (keeper !== win) {
        keeper.deprecated = true; keeper.dupOf = win.id
        keeper.dupReason = (usableN(keeper) === 0) ? '同名旧版本（此版本已失效）' : '同名旧版本'
        keeper.usable = false
      }
      // 其余仍废弃的同组成员统一改指新赢家，消除链式误指
      for (const m of members) {
        if (m === win || m.deprecated === false) continue
        m.dupOf = win.id
      }
      flipped++
    }
    this.db.wrongDedupMigrated = true
    if (flipped) console.log(`[启动] 同名旧版本误废迁移：纠正 ${flipped} 组（复活高版本/实测更优者，含糊组未动）`)
    return true
  }

  /**
   * 旧版 → 多平台迁移（v1.8.0）：
   *  - platforms 为空且存在旧版 serverUrl → 生成第一个 lxserver 账号；
   *  - platforms 非空但 activePlatformId 缺失 → 指向第一个账号。
   * 返回是否有写入过迁移。
   */
  /**
   * 仓库清单迁移（v1.9.12）：首次启动（config.repos 未初始化）时，从内置 DEFAULT_REPOS
   * （builtin）+ 旧 customRepos（custom）播种出统一清单，使所有仓库都进入可管理状态。
   * 已有 repos 数组（哪怕为空）则尊重用户编辑，不再播种。返回是否发生过写入。
   */
  _ensureRepoList() {
    if (Array.isArray(this.config.repos)) return false
    const out = []
    const seen = new Set()
    for (const r of DEFAULT_REPOS) {
      const n = normalizeRepo(r)
      if (n && !seen.has(n)) { seen.add(n); out.push({ repo: n, enabled: true, builtin: true, origin: 'builtin' }) }
    }
    for (const r of (this.config.customRepos || [])) {
      const n = normalizeRepo(r)
      if (n && !seen.has(n)) { seen.add(n); out.push({ repo: n, enabled: true, builtin: false, origin: 'custom' }) }
    }
    this.config.repos = out
    this.config.customRepos = [] // 旧字段已并入 repos，清空避免与 legacy 回退路径重复计数
    return true
  }

  _migratePlatforms() {
    let changed = false
    if (!Array.isArray(this.config.platforms) || this.config.platforms.length === 0) {
      if (this.config.serverUrl) {
        this.config.platforms = [{
          id: 'p_default',
          type: 'lxserver',
          name: '默认 LX 服务',
          url: this.config.serverUrl || '',
          username: this.config.username || 'default',
          password: this.config.adminPassword || '',
          timeoutMs: this.config.serverTimeoutMs || 25000,
          enabled: true
        }]
        changed = true
      } else {
        this.config.platforms = []
      }
      this.config.activePlatformId = this.config.platforms.length ? this.config.platforms[0].id : null
      changed = true
    } else if (!this.config.activePlatformId || !this.config.platforms.find(p => p.id === this.config.activePlatformId)) {
      this.config.activePlatformId = this.config.platforms[0].id
      changed = true
    }
    // 给老账号补默认字段，避免适配器读不到
    for (const p of this.config.platforms) {
      if (!p.id) { p.id = 'p_' + Math.random().toString(36).slice(2, 9); changed = true }
      if (typeof p.timeoutMs !== 'number') { p.timeoutMs = 25000; changed = true }
      if (typeof p.enabled !== 'boolean') { p.enabled = true; changed = true }
      // Geelonn 语义修正（v1.9.4）：v1.9.3 把「用户名」直接当登录账号用，导致音源全被灌进
      // 该账号的**私有**列表（网页端公开列表看不到）。现在「用户名」＝灌入落点、登录账号独立
      // 成 loginUser：老账号把 username 迁到 loginUser，落点恢复默认＝公开源。
      if (p.type === 'geelonn' && !p.loginUser) {
        p.loginUser = p.username || 'admin'
        p.username = ''
        changed = true
      }
    }
    return changed
  }

  _read(f) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { return null }
  }

  _write(f, obj) {
    // P-1429：改为"写临时文件 + rename"两步。之前直接 writeFileSync 覆盖 17MB 的
    // sources.json，写盘中途断电/崩溃/磁盘满会留下半个文件，下次启动 JSON 解析失败
    // = 数据看着"丢了"。同目录 rename 在同一文件系统上是原子操作，最坏只剩完整的旧文件。
    // 目录权限不足（rename 需要目录写权限）时回退旧的直接写——最坏退化为旧行为，不会更糟。
    try {
      const tmp = f + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8')
      fs.renameSync(tmp, f)
      return true
    } catch (e1) {
      try { if (fs.existsSync(f + '.tmp')) fs.unlinkSync(f + '.tmp') } catch (e2) {}
      try {
        fs.writeFileSync(f, JSON.stringify(obj), 'utf8')
        return true
      } catch (e3) {
        return false
      }
    }
  }

  saveConfig(patch) {
    if (patch) {
      this.config = Object.assign(this.config, patch)
      // v1.11.0：两个字段必须始终一致，避免只提交其中一个时行为漂移
      if (patch.proxyPolicy != null) this.config.forceProxy = patch.proxyPolicy === 'force'
      else if (typeof patch.forceProxy === 'boolean') this.config.proxyPolicy = patch.forceProxy ? 'force' : 'auto'
    }
    return this._write(this.configFile, this.config)
  }

  saveDb() { return this._write(this.dbFile, this.db) }
  saveImported() { return this._write(this.importedFile, this.imported) }

  // ---------------- 脚本正文副本（v1.12.7） ----------------
  // 为什么留副本：服务端 list 不回脚本正文，也不回逐平台实测结论（`/api/custom-source/list`
  // 只给 name/version/homepage/size/supportedSources）。要判断「服务端那条现在到底怎么样」，
  // 唯一可行的是本地留一份**当初灌进去的那份正文**，用于：
  //   1) 与服务端 size 对账 —— 不符说明服务端已被换过，本地打分快照不再代表它；
  //   2) 需要时在本地沙箱复测（走的是同一套 checker，不改服务端）。
  // 按 contentHash 命名，天然去重；单条约 50KB，1400 条约 70MB。
  scriptDir() {
    const d = path.join(this.dir, 'scripts')
    try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) } catch (e) { /* 目录建不出来就退化为不落档 */ }
    return d
  }

  /**
   * 只接受 sha256 hex（防路径穿越），且**不做任何 IO** —— 批量对账时会被调用上千次，
   * 每次都 mkdir/exists 检查会白算几千次系统调用。建目录交给 scriptDir()/archiveScript。
   */
  _scriptPath(hash) {
    const h = String(hash || '')
    if (!/^[0-9a-f]{16,64}$/i.test(h)) return ''
    return path.join(this.dir, 'scripts', h + '.js')
  }

  /** 落档（已存在则跳过：同内容不同条目不重复写） */
  archiveScript(hash, code) {
    if (typeof code !== 'string' || !code) return false
    const f = this._scriptPath(hash)
    if (!f) return false
    this.scriptDir()
    try {
      if (fs.existsSync(f) && fs.statSync(f).size === Buffer.byteLength(code, 'utf8')) return true
      fs.writeFileSync(f, code, 'utf8')
      return true
    } catch (e) { return false }
  }

  readScript(hash) {
    const f = this._scriptPath(hash)
    if (!f) return null
    try { return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null } catch (e) { return null }
  }

  /** 副本字节数；没有副本返回 0（0 表示「不知道」，调用方不能据此判定不符） */
  scriptSize(hash) {
    const f = this._scriptPath(hash)
    if (!f) return 0
    try { return fs.existsSync(f) ? fs.statSync(f).size : 0 } catch (e) { return 0 }
  }

  /**
   * 存量补档：把本地库里已经存着正文（压缩包内脚本 / 采集时保存过 code）的条目
   * 按 contentHash 复制一份到副本目录。零网络，纯本地搬运。
   * @returns {{archived:number, skipped:number}}
   */
  backfillScripts() {
    let archived = 0, skipped = 0
    for (const e of Object.values(this.db.sources || {})) {
      if (!e || !e.contentHash || typeof e.code !== 'string' || !e.code) { skipped++; continue }
      if (this.scriptSize(e.contentHash) > 0) { skipped++; continue }
      if (this.archiveScript(e.contentHash, e.code)) archived++
      else skipped++
    }
    return { archived, skipped }
  }

  addSources(items) {
    let added = 0
    for (const it of this._undeleted(items)) {
      if (!this.db.sources[it.id]) { this.db.sources[it.id] = it; added++ }
    }
    return added
  }

  /**
   * 增量合并（定时爬取用，v1.7.0）：
   *  - 新 id → 入库（added）
   *  - 已有 id + 树内 .js 的 blobSha 变了 → 标 stale（raw 链接指向 HEAD，
   *    下次指纹 pass 会重新下载，哈希真变了才更新 + 重置检测结果）
   *  - 已有 id + 带 code 的条目（压缩包内/release 资产）内容哈希变了 → 就地更新：
   *    换 code/hash、重置检测结果（status/usable/deep/lastCheck）、标 updated，
   *    并撤销它此前的「重复废弃」标记（内容已是新版本，交给去重重新裁决）
   *  - 其余 → skipped（已抓取且未变，默认不重抓）
   * @returns {{added, updated, skipped}}
   */
  mergeSources(items, opts) {
    const incremental = !opts || opts.incremental !== false
    const res = { added: 0, updated: 0, skipped: 0 }
    if (!incremental) return this._addCount(items, res)
    for (const it of this._undeleted(items)) {
      const cur = this.db.sources[it.id]
      if (!cur) { this.db.sources[it.id] = it; res.added++; continue }
      let changed = false
      // 树内 .js：blob sha 变化 = 上游内容可能变了（URL 指向 HEAD，无需现在下载）
      if (it.blobSha && cur.blobSha && it.blobSha !== cur.blobSha) {
        cur.blobSha = it.blobSha
        cur.stale = true
        cur.staleAt = Date.now()
        // v1.12.3：树内 .js 换版必须同步撤销废弃标记 —— stale 的废弃条目永远不会被
        // 指纹 pass 重下（_hashPass 过滤 deprecated），旧内容会永久滞留库内
        // （豆包定制[聚合音源] 2026-11-10 实测：上游已更新、库内滞留旧版且无人复活）。
        if (cur.deprecated) { cur.deprecated = false; cur.dupOf = null; cur.dupReason = null }
        changed = true
      } else if (it.blobSha && !cur.blobSha) {
        cur.blobSha = it.blobSha
      }
      // 压缩包内 / release 资产：内容就地比对，真变了才更新
      if (it.code && cur.code && it.contentHash && cur.contentHash && it.contentHash !== cur.contentHash) {
        cur.code = it.code
        cur.contentHash = it.contentHash
        cur.size = it.size != null ? it.size : cur.size
        cur.status = 'unknown'
        cur.suspected = it.suspected != null ? it.suspected : cur.suspected
        cur.usable = false
        cur.deep = null
        cur.lastCheck = 0
        cur.updated = true
        cur.updatedAt = Date.now()
        cur.stale = false
        // 内容已换版：撤销此前的重复废弃标记，让去重按新内容重新裁决
        if (cur.deprecated) { cur.deprecated = false; cur.dupOf = null; cur.dupReason = null }
        changed = true
      } else if (it.code && !cur.code) {
        // v1.13.10：这条分支同样可能带来 contentHash 变化（旧条目没有正文，首次补到正文），
        // 语义与上面「内容换版」完全一致，但此前只写了 code/contentHash 两项，其余派生状态
        // 全部沿用旧值的 → size 与新内容不符、deep.hash 与新 contentHash 错配（用旧内容的
        // 检测结果给新内容定可用性）、deprecated/dupOf 指向已不成立的重复关系。
        // 统一走同一个收尾，两分支不再各写一套。
        cur.code = it.code
        const hashChanged = !!(it.contentHash && it.contentHash !== cur.contentHash)
        if (it.contentHash) cur.contentHash = it.contentHash
        if (hashChanged) {
          cur.size = it.size != null ? it.size : cur.size
          cur.status = 'unknown'
          cur.suspected = it.suspected != null ? it.suspected : cur.suspected
          cur.usable = false
          cur.deep = null
          cur.lastCheck = 0
          cur.updated = true
          cur.updatedAt = Date.now()
          cur.stale = false
          if (cur.deprecated) { cur.deprecated = false; cur.dupOf = null; cur.dupReason = null }
        }
        changed = true
      }
      if (changed) res.updated++
      else res.skipped++
    }
    return res
  }

  _addCount(items, res) {
    for (const it of this._undeleted(items)) {
      if (!this.db.sources[it.id]) { this.db.sources[it.id] = it; res.added++ }
      else res.skipped++
    }
    return res
  }

  getSources() { return Object.values(this.db.sources) }

  /** 手动删除记录（不再自动采集名单）的快照，避免调用方直接改内部数组。 */
  deletedIds() { return Array.isArray(this.db.deletedIds) ? this.db.deletedIds.slice() : [] }

  isDeleted(id) {
    return Array.isArray(this.db.deletedIds) && this.db.deletedIds.indexOf(id) >= 0
  }

  /** 自动入库统一过滤：被用户手动删掉的 id 不再由爬取 / 采集站 / 服务端同步加回。 */
  _undeleted(items) {
    const gone = this.deletedIds()
    if (!gone.length) return items || []
    const set = new Set(gone)
    return (items || []).filter(it => it && it.id && !set.has(it.id))
  }

  /**
   * 手动删除音源（v1.10.2）：按 id 从本地音源库移除，并记入「不再自动采集」名单。
   *  - 只动本地库：服务端上已灌入的脚本不受影响，要撤掉请用「已灌入」页的删除；
   *  - 保留 imported 账本（它描述的是服务端状态）；本地条目没了以后，巡检队列里
   *    取不到 sources[srcId] 会自动跳过，不会把已删条目当作待巡检目标；
   *    **例外**：(服务端) 占位条目（srv:… / fromServer）要连账本一起摘掉 —— 它本来就
   *    是本地快照，留着会成孤儿：巡检跳过它，而「只选未灌入」又因账本仍标已灌入
   *    把它排除，结果既不再被巡检、想重灌也灌不进去；
   *  - 记入 deletedIds 后，runCrawl / 采集站 / 非增量合并都不会把它加回来；
   *  - 恢复途径：导入音源库 JSON（mergeFrom 自动解除）、重新导入同名私人源，
   *    或 clearDeletedIds() 清空记录后重新爬取。
   * @returns {{deleted:number, missing:string[], blocked:number, ledgerDropped:number}}
   */
  removeSources(ids) {
    const list = Array.isArray(ids) ? ids.filter(x => typeof x === 'string' && x).slice(0, 5000) : []
    if (!list.length) return { deleted: 0, missing: [], blocked: this.deletedIds().length, ledgerDropped: 0 }
    if (!Array.isArray(this.db.deletedIds)) this.db.deletedIds = []
    const gone = new Set(this.db.deletedIds)
    const missing = []
    let deleted = 0, ledgerDropped = 0
    for (const id of new Set(list)) {
      const entry = this.db.sources[id]
      if (!entry) { missing.push(id); continue }
      delete this.db.sources[id]
      if (!gone.has(id)) { this.db.deletedIds.push(id); gone.add(id) }
      const isSnapshot = !!entry.fromServer || /^srv:/.test(id)
      if (isSnapshot && this.imported && this.imported[id]) {
        delete this.imported[id]
        ledgerDropped++
      }
      deleted++
    }
    if (ledgerDropped) this.saveImported()
    if (deleted) this.saveDb()
    return { deleted, missing, blocked: this.db.deletedIds.length, ledgerDropped }
  }

  /** 清空删除记录：这些音源后续可以重新被自动采集收录（不会自动立刻出现）。 */
  clearDeletedIds() {
    const cleared = this.deletedIds().length
    this.db.deletedIds = []
    if (cleared) this.saveDb()
    return { cleared }
  }

  /**
   * 按 id 精确移除删除记录（v1.16：解除拉黑时按快照还原用，取代 clearDeletedIds 核弹）。
   * 只撤销「这些具体 id 不再采集」的记录，其它删除记录原样保留。
   * @param {string[]} ids 要撤销删除记录的 id 列表
   * @returns {{removed:number}} 实际撤销条数
   */
  removeDeletedIds(ids) {
    const list = Array.isArray(ids) ? ids.filter(x => typeof x === 'string' && x) : []
    if (!list.length) return { removed: 0 }
    const set = new Set(list)
    const before = this.deletedIds().length
    this.db.deletedIds = this.deletedIds().filter(id => !set.has(id))
    const removed = before - this.db.deletedIds.length
    if (removed) this.saveDb()
    return { removed }
  }

  // 整库清空 = 从零开始，连同删除记录一起清掉，否则之后爬取会莫名少几条
  clearSources() { this.db.sources = {}; this.db.deletedIds = []; this.saveDb() }

  /**
   * v1.15 P2：用户自定义标签（单点写入，只改 userTag）。
   * 采集/更新/导入流程不得覆盖此字段——它与 releaseTag 是两条独立字段，
   * 都不写进 name/lxName/scriptVersion（那会破坏 identity.normName / 同名裁决 / 去重分组）。
   * @param {string} id 音源 id
   * @param {string} tag 标签文本（空串=清除）
   * @returns {{ok:boolean, id:string, userTag:string}}
   */
  setUserTag (id, tag) {
    const key = String(id || '')
    if (!key) throw new Error('缺少音源 id，无法设置标签')
    const e = this.db.sources[key]
    if (!e) throw new Error('音源不存在：' + key)
    const t = String(tag == null ? '' : tag).trim().slice(0, 40)
    if (t) e.userTag = t
    else delete e.userTag
    this.saveDb()
    return { ok: true, id: key, userTag: t }
  }

  /**
   * 导入单个音源并标记「私人」（v1.10.0）：
   *  - id 固定为 private::<文件名>，repo 标「私人音源」，条目带 private:true；
   *  - 私人源受保护：不参与去重废弃，且完全不参与健康巡检（不重测、不累计失效、
   *    不自动禁用/删除，见 hunter.js buildPatrolItems）；用户仍可手动检测与灌入；
   *  - 同名（同文件名）重复导入 = 更新：换 code/hash、重置检测结果，保留原 addedAt。
   * @param {string} name 文件名（如 xxx.js，可不带扩展名）
   * @param {string} code 脚本全文
   * @returns {{entry:object, added:boolean, updated:boolean}}
   */
  addPrivateSource(name, code) {
    const { scoreEntry, sha256Str } = require('./checker')
    const clean = String(name || '').replace(/\.js$/i, '').replace(/[\\/:*?"<>|\s]+/g, '_').trim() || 'private-source'
    const text = String(code || '')
    if (!text.trim()) throw new Error('脚本文本为空')
    if (text.length > 2 * 1024 * 1024) throw new Error('脚本过大（超过 2MB）')
    const id = 'private::' + clean
    const prev = this.db.sources[id]
    const score = scoreEntry(clean + '.js', text)
    const entry = {
      id,
      repo: '私人音源',
      path: clean + '.js',
      url: '',
      name: clean,
      code: text,
      contentHash: sha256Str(text),
      suspectScore: score,
      status: 'unknown',
      suspected: score >= 4,
      usable: false,
      size: text.length,
      addedAt: prev && prev.addedAt ? prev.addedAt : Date.now(),
      lastCheck: 0,
      deep: null,
      private: true
    }
    if (prev) {
      // 重复导入视为更新：旧内容换新，检测与可用性重置，废弃标记撤销（内容已是新的）
      if (prev.deprecated) { entry.dupOf = null; entry.dupReason = null }
    }
    // 手动重新导入同名私人音源 = 明确恢复，解除「不再采集」记录
    this.db.deletedIds = this.deletedIds().filter(x => x !== id)
    this.db.sources[id] = entry
    this.saveDb()
    return { entry, added: !prev, updated: !!prev }
  }

  /**
   * 从导出文件合并数据（检测结果导入，换机迁移不用重跑）：
   *  - 按 id 合并条目：本地没有 → 新增；两边都有 → 保留检测时间较新的版本
   *  - 按 contentHash 补结果：本地某条没检测过，但导入数据里有同内容条目的检测结果 → 直接复制
   *  - 合并已灌入记录（按 key，本地已有则跳过）
   */
  mergeFrom(data) {
    if (!data || !Array.isArray(data.sources)) throw new Error('文件格式不正确：缺少 sources 数组')
    const res = { added: 0, updated: 0, copied: 0, importedAdded: 0, importedSkipped: 0, total: 0 }
    res.total = data.sources.length
    // 用户主动导入音源库 = 明确想恢复：导入文件里出现的 id 一律解除「不再采集」记录，
    // 否则从备份 JSON 也救不回被手动删掉的条目。
    const revived = new Set()
    for (const s of data.sources) if (s && s.id) revived.add(s.id)
    if (revived.size) this.db.deletedIds = this.deletedIds().filter(id => !revived.has(id))
    // 内容哈希 -> 最佳检测结果（取 checkedAt 最新的）
    const bestByHash = {}
    for (const s of data.sources) {
      if (!s || !s.id || !s.deep || !s.contentHash) continue
      const cur = bestByHash[s.contentHash]
      if (!cur || ((s.deep.checkedAt || 0) > (cur.deep.checkedAt || 0))) bestByHash[s.contentHash] = s
    }
    for (const s of data.sources) {
      if (!s || !s.id) continue
      delete s.checking
      const cur = this.db.sources[s.id]
      if (!cur) {
        this.db.sources[s.id] = s
        res.added++
        continue
      }
      const curT = (cur.deep && cur.deep.checkedAt) || 0
      const newT = (s.deep && s.deep.checkedAt) || 0
      if (newT > curT) {
        this.db.sources[s.id] = Object.assign({}, cur, s)
        res.updated++
      }
    }
    // 哈希补结果：本地未检测的同内容条目直接复用导入的检测结果
    for (const e of Object.values(this.db.sources)) {
      if (e.deep || !e.contentHash) continue
      const best = bestByHash[e.contentHash]
      if (!best) continue
      e.deep = best.deep
      e.usable = usableCount(e) > 0
      e.suspected = best.suspected != null ? best.suspected : e.suspected
      if (!e.scriptName && best.scriptName) e.scriptName = best.scriptName
      if (!e.lxName && best.lxName) e.lxName = best.lxName
      if (!e.lastModified && best.lastModified) e.lastModified = best.lastModified
      res.copied++
    }
    for (const [k, v] of Object.entries(data.imported || {})) {
      if (!this.imported[k]) { this.imported[k] = v; res.importedAdded++ }
      else res.importedSkipped++
    }
    if (data.lastCrawl > (this.db.lastCrawl || 0)) this.db.lastCrawl = data.lastCrawl
    this.saveDb()
    this.saveImported()
    return res
  }
}

module.exports = { Store, DEFAULT_CONFIG }
