# lunter（lx-hunter）功能审查报告

审查范围：`src/core/`、`src/server/web.js`、`src/main/{index,preload}.js`、`src/renderer/{app.js,web-bridge.js,index.html}`。审查阶段为纯静态审查（未跑测试/API）；其后 H2/M2 的安全修复已落到 `src/server/web.js`（详见文末修复说明）。

分级口径：**高**＝核心功能不可用或安全红线/凭据风险；**中**＝功能结果错误、误导用户、权限不一致；**低**＝显示/文案/一致性瑕疵。每条均注明「真 bug / 已知项 / 设计取舍」。既定红线（AI 只读建议人确认后执行、AUTO_READONLY_KINDS=[R1,R2,R3]、R4-R7 只产建议不执行、R1 结果只进日志）经核对**未被破坏**。

---

## 一、高危（H）

> H1 已在复核后撤销（非 bug / 用户有意设计，详见下方 H1 条目），本节实际高危仅 H2。

### H1.（已撤销：非 bug / 用户有意设计）AI 复检页无建议列表/详情卡
- 原判定：曾列为高危真 bug，认为 `renderer/index.html` 的 `#view-ai-review` 缺 `#aiSuggestions`/`#aiSuggestionsEmpty`/`#aiDetail`/`#btnAiRefresh`，致 app.js 的 `loadSuggestions()/renderDetail()/renderOffHint()` 一律 `if(!box)return`。
- **撤销依据**：`AI复检入口-呈现方案修订纪要.md` 2.4 节明确要求"独立 AI 复检页缩编为设置+轻量总览，移除失败聚类卡、建议列表、检测详情卡（结论已内联，详情由行内展开层承载）"，P2-UI 行还明确要求"同步测试断言删 aiDetail 正则"。即：`#aiDetail` 等容器被移除是用户拍板的有意设计——AI 结论已内联到音源行/隔离项（chip），详情由行内展开层承载，独立页刻意只保留配置与聚类入口。`tests/ai-review.test.js:243-246` 的 `id="aiDetail" === false` 断言正是该决定的落地守护，不是缺陷。
- 结论：**非 bug**。app.js 中残留的 `loadSuggestions/renderDetail/renderOffHint` 及对应 id 引用属缩编后的遗留死代码（被 `if(!box)return` 短路，无副作用、不影响用户），可另案清理，但不计入本报告的缺陷。原报告将其误判为"核心 UI 不可用"系未对照该呈现纪要所致，现予纠正。

### H2. Web 端 `GET /api/ai-review/config` 无管理员校验，且未脱敏 `provider.headers` 【真 bug / 凭据泄露】
- 位置：`server/web.js:388`、`core/aiReview.js:181-184`；对照正确实现 `server/web.js:259-275,322-332`
- 现象：该端点仅经登录门禁，无 `currentUser(req).admin` 检查，直接 `ai().publicConfig()` 返回。`publicConfig()` 只把 `apiKey` 打码为 `******`，**`provider.headers` 原样透传**；而 `sanitizeConfig()` 本会把 headers 各值清空，却只用在 `GET /api/config`，AI 专用端点从未调用。
- 触发：任意已登录的非管理员账号请求 `GET /api/ai-review/config`，且 `provider.headers` 配了自定义鉴权头（如 `X-Api-Key`/`Authorization` 覆写）。
- 影响：非管理员可读取 AI 中转站的密钥头——与 web.js:256-258 注释中 P-1429 已修复的 `/api/config` 明文泄露同类问题，这里漏了一处。违反既定的凭据脱敏口径。
- 修法：对该端点加 admin 校验；或复用 `sanitizeConfig()` 处理返回值（至少对非管理员清空 headers 值）。

---

## 二、中危（M）

### M1. AI 复检失败被内层 catch 包装成"成功"，用户看到虚假完成提示 【真 bug / 吞错】
- 位置：`server/web.js:411-422`、`main/index.js:294-305`；根因 `core/aiReview.js:315,337,345`（`run()` 按旁路铁律从不抛，失败返回 `{ok:false,error}`）
- 现象：handler 的 `catch(e){return {ok:false,...}}` 永远不会命中；`out={ok:false,error}` 被 `guard` 包成 `{ok:true,data:{ok:false,error}}`。renderer 检查的是顶层 `r.ok===false`（`app.js:2124,2664`），恒为 false 判断落空，于是走"成功"分支。
- 触发：AI 未启用 / 中转站不通 / 配额耗尽 / `run()` 内任意失败。
- 影响：单条复检弹"AI 复检完成，建议已标在音源旁"(`app.js:2126`)，批量弹"已完成 N 条"(:2668)，R1 聚类弹"已记录到日志：无可聚类…"(:4047)——实际全部失败。用户被误导，且失败原因（`out.error`）从未展示。
- 修法：handler 内检测 `out.ok===false` 时直接返回失败（抛错让 guard 统一包装，或显式返回带 `X-Lxh-Error` 的结构）；renderer 同时检查 `r.data && r.data.ok===false`。

### M2. Web 端多个破坏性/耗资端点缺管理员校验（权限模型不一致）【真 bug / 安全缺口】
- 位置：`server/web.js`：AI 端点 `:406(test)/:411(run)/:424(suggestions)/:429(apply)/:448(undo)`；破坏性路由 `:749(db/clear)`、`:753(db/delete)`、`:598(veto/clear)`、`:848(service/remove)`、`:872(service/remove/public)`、`:1050(source-update/apply)`
- 现象：这些端点只经登录门禁，无 admin 限制；而 `config`(`:338`) 与 `ai-review/config POST`(`:392`) 有 admin 校验。
- 影响：任意登录用户可反复调用 AI 端点消耗中转站配额；更严重的是可用 `source-update/apply`（带 `experimental+apply+confirm` 三参）执行真实"删旧灌新"、以及清库/删源/解除冻结等破坏操作。桌面端无鉴权模型属本地取舍，但 Web 版已引入 admin 角色却未覆盖这些端点，是权限模型缺口。
- 修法：对 `source-update/apply`、`db/clear/delete`、`veto/clear`、`service/remove*` 及 AI 耗资端点统一加 admin 校验。

### M3. eval-cases 样本未随构建发布，生产/桌面版评测恒为"无样本" 【真 bug】
- 位置：`server/web.js:459`、`main/index.js:333`（`path.join(__dirname,'..','..','tests','eval-cases')`）；`Dockerfile:14`、`package.json:24-27`（`files` 仅 `src/**/*` + `package.json`）
- 现象：样本实际在 `tests/eval-cases/`（存在 `r4-r7.labeled.json` 等），但 Docker 与 electron-builder 都只打包 `src`。`loadCases` 对不存在的目录返回 `[]`（evalCases.js:52），不抛错。
- 影响：`/api/ai-review/eval-report` 在任何部署形态下都拿不到样本，`computeMetrics(logs,[])` 恒返回"数据不足/无样本"，评测报告功能实质失效（源码目录直接 `node src/server/web.js` 时因 tests 存在而正常，掩盖了问题）。
- 修法：把 `tests/eval-cases` 纳入发布包（`Dockerfile` 增 `COPY tests/eval-cases`，`package.json files` 增该路径），或把样本移到 `src/` 下并调整路径。

### M4. "撤销去重"误读返回结构，后端已恢复但 UI 永远报"没有废弃项"且不刷新 【真 bug】
- 位置：`renderer/app.js:2599-2604`；后端 `server/web.js:744-748`、`main/index.js:645-649` 经 `guard` 包成 `{ok:true,data:{restored,total,busy}}`，桥接层原样透传（`web-bridge.js`/`preload.js`）
- 现象：app.js 直接读 `r.restored`/`r.busy`（顶层），恒为 `undefined`。
- 影响：`restoreDedupe` 实际已恢复条目，UI 却走 else 分支提示"当前没有已废弃的重复项"，且不调用 `loadSources()`，列表不刷新——用户以为功能失效。
- 修法：改为 `const d = (r&&r.data)||r||{}` 后读 `d.restored`/`d.busy`。

### M5. 桌面端"解除拉黑"签名不匹配，功能必然失败 【真 bug】
- 位置：`renderer/app.js:646`（传字符串 repo）vs `main/preload.js:47`（`reposUnblock:(args)=>invoke('repos:unblock',args)`）vs `main/index.js:661`（`(args||{}).repo` 期望对象）；Web 端 `web-bridge.js:211` 期望字符串、正常
- 现象：桌面端收到字符串，`("o/r").repo===undefined` → `unblockRepo('')` → 失败。
- 影响：桌面版（PC 主场景）"解除拉黑"完全失效。`tests/crawl-releases.test.js:410` 只断言方法名存在、未校验签名，故漏检。
- 修法：统一签名——preload 改为 `(repo,reAdd)=>invoke('repos:unblock',{repo,reAdd})`，或 app.js 改传对象并同步 Web 端；补跨端签名测试。

### M6. 保存 AI 配置后 `currentConfig` 被置空，确认执行门控/off 提示失效 【真 bug】
- 位置：`renderer/app.js:4016-4017`；后端返回 `publicConfig` 经 guard 为 `{ok:true,data:publicConfig}`（`web.js:402`、`main/index.js:286`）
- 现象：保存后取 `r.data.config`（`undefined`）→ `c={}` → `currentConfig={}`；而初始加载 `:3890` 用的是 `r.data.config`（GET 返回 `{config:...}`，正确），两处口径不一致。
- 影响：保存后 `currentConfig.mode` 变 undefined → off 档提示(:3925)不再显示；`allowIrreversible` 变 undefined → R6/R7 的 `irreversibleOk`(:4070)为 false，"确认执行"按钮消失。且 `__aiReviewLoad` 的 loaded 标志已 true 不会重新 load，须整应用刷新才恢复。
- 修法：保存后取 `const c=(r&&r.data)||{}`（保存接口 data 即 publicConfig），或让后端 configSet 与 configGet 返回结构一致（都包 `{config:...}`）。

### M7. `apply`（含 `byUser`）绕过第三把锁 `allowIrreversible` 【真 bug / 门控不一致】
- 位置：`server/web.js:439-443`、`main/index.js:316-319`
- 现象：`if(!g.auto && !body.byUser) return...` —— 只要前端传 `byUser:true`，`gate()` 结果被完全跳过，R6/R7 即使 `allowIrreversible=false` 也能被标 applied。
- 影响：UI 侧明明有第三锁（`app.js:4070` `irreversibleOk`），但 API 层可被绕过；本阶段 apply 只改建议 status（不碰业务对象，未破只读红线），故实际破坏有限，但门控口径不一致是隐患——一旦将来 apply 接真实动作，这里就是越权口子。另 `run` 路由直接透传 `trigger:'auto'`（core `aiReview.js:259,329`）也可让调用方绕过人工确认自动标记建议。
- 修法：`byUser` 分支对 R6/R7 仍应校验 `allowIrreversible`；`trigger` 由服务端根据角色/配置决定，不接受前端任意指定 auto。

### M8. 配置写盘失败被静默，UI 提示"保存成功"但重启回退 【真 bug / 吞错】
- 位置：`core/store.js:350-382`（`_write` 失败返回 false）；所有调用点丢弃返回值，如 `web.js:366,401`、`main/index.js:261,285`
- 现象：磁盘只读/配额满/权限不足时，`saveConfig`/`saveDb` 返回 false，但 handler 仍返回新配置/成功。
- 影响：内存已改、磁盘未落，用户以为保存成功，重启后配置/数据回退。
- 修法：关键保存点检查返回值，失败时向前端返回错误提示（至少 pushLog 告警）。

---

## 三、低危（L）

### L1. `service:toggle` 桌面端丢 `reason` 参数 【真 bug】
- `server/web.js:846` 传 `{owner,reason}`，`main/index.js:775-778` 只传 `{owner}`。桌面端停用原因不写进服务端 `disableReason`，两端行为不一致。改 `index.js` 处理器与 preload 签名透传 reason。

### L2. `data:import` Web 端缺 `applyConfig` 【真 bug】
- `main/index.js:555` 有 `net.applyConfig(store.config)`，`web.js:543-553` 无。Web/Docker 导入镜像/代理配置后不即时生效，需重启。补一行调用即可。

### L3. `ai-review:test` 返回结构两端不一致 【真 bug】
- `web.js:408` 返回 `{ok,message,model}`，`main/index.js:291` 只 `{ok,message}`。当前 renderer 只用 message 不显现，但桥接契约应一致。桌面端补 `model`。

### L4. 自动复检定时器全静默吞错 + fire-and-forget，失败无声跳过 【设计取舍 / 低】
- `web.js:1203-1265`、`main/index.js:344-406`：每轮 R1/R3/R4/R5 的 `catch(e){}` 全空，水位 `lastAttempt`/`aiLastClusterAt` 在 finally 无条件推进；R3 不 await，`done++` 不代表成功。
- 影响：AI 失败被静默跳到下一周期，事后无法取证（同文件巡检任务失败会 pushLog，形成反差）。属"旁路静默"既定取舍，但建议至少对异常 pushLog 一条，便于排障。

### L5. `normalizeConfig` 边界 【设计取舍 / 低】
- `core/aiReview.js:205-211,229-236`：正整数无上限（超大 `autoMaxItems`/`timeoutMs` 可致高消耗）；`autoActiveHours` 要求 `s<e`，跨午夜区间（22→6）被判非法回落全天——与 `aiSchedule._activeHours:27` 的"非法区间按全天"口径一致，但用户可能预期支持跨午夜。非 bug，记录供产品判断。

### L6. 桌面端版本号写死过时 【真 bug / 显示】
- `renderer/index.html:18` `<div class="brand-sub">PC 版 v1.9.20</div>`，而代码已含 v1.14.0 功能；Web 版由 `web-bridge.js:246-255` 动态取 `/api/health` 覆盖，桌面版长期显示旧版本号。`dist-selfcheck.js:482` 只禁止 web-bridge 写死，未覆盖 index.html。

### L7. dry-run 报告 verdict 未转义（理论 XSS）【低】
- `app.js:3852` 中 `(LABEL[it.verdict]||it.verdict)` 未经 `esc()` 直接进 innerHTML。verdict 来自后端枚举、风险很低；其余用户输入点（chip/详情/表格）均经 `esc()`，无问题。

### L8. 大请求体超限处理会二次写响应 【设计取舍 / 低】
- `web.js:282-289`：`>192MB` 时 `req.destroy()` 后 guard(`:304-310`)仍尝试 `sendJson`，可能写头报错。客户端多表现为连接重置。行为可接受，记录备查。

---

## 四、已知项 / 明确非 bug（不重复计入缺陷）

- **Store 多实例浅合并污染**：`store.js:223` `Object.assign` 浅合并 + 多处 `new AIReview(store)`/`ai()` 单例按 store 比对重建；多个 Store 实例同时改 `config.aiReview` 会共享嵌套对象、互相污染。**已知未修问题**，本轮确认仍存在（非新发现）。
- **AI "确认执行"按钮**：有意设计（AI 只读提建议、人确认后执行），非 bug。但需注意当前 apply/undo 只改建议 status/审计标记、不产生真实业务效果（`aiReview.js:327-333,417-445`；`audit()` 生产代码从未调用），"执行/回滚"实质接近空操作——这是产品承诺与实现的差距，非红线突破。
- **R1 归纳只进日志、不进 UI**：用户明确要求，符合约定。
- **`evaluateGate`/`quoteLocatable`（`aiReview.js:372-383`）**：定义了但生产代码从未调用（仅测试引用）。"证据全绿门控"实际只在 `gate()` 的三把锁 + 自动铺轨处体现，这两个函数形同虚设——记录为实现与设计文档（"置信度=客观证据 AND"注释，:12）的落差，建议要么接入门控、要么移除避免误导。
- **缓存戳**：当前 `index.html:828-830` 为 `sorters.js?v=27 / web-bridge.js?v=59 / app.js?v=82`，三处测试（`crawl-releases.test.js:386`、`external-source.test.js:304`、`proxy-policy.test.js:174`）断言值一致，无不同步。

---

## 五、总体评价

AI 复检层的**只读红线守得住**（未发现 AI 建议/undo/apply 真改业务对象或同名裁决），provider 超时/降级、调度水位、版本与质量裁决算法均扎实；主要问题集中在两处：①Web 端配置端点泄露中转站密钥头、多个端点缺管理员校验（H2/M2）；②一条失败被包装成功、两处桥接签名/返回结构错位使功能静默失效（M1/M4/M5/M6）。另有 eval 样本未打包、"确认执行"实为空操作、门控辅助函数未接入等实现与设计的落差。建议按 H2/M2→M1→M4/M5/M6 顺序修复，并为跨端 API 契约与 AI 失败路径补测试。（原 H1"AI 复检页缺容器"经复核为误报，依据呈现方案修订纪要 2.4 节，独立页缩编、结论内联是用户有意设计，已撤销。）

---

## 六、修复记录（审查后）

- **H2 已修**：`web.js` `GET /api/ai-review/config` 加 `assertAdmin` 管理员校验，返回经 `sanitizeConfig` 脱敏（apiKey 掩码、headers 清空），`{config:...}` 结构不变。
- **M2 已修**：新增 `assertAdmin(req, action)` 助手（`web.js:72`），并对 AI 耗资端点（test/run/suggestions/apply/undo）与破坏性路由（veto/clear、db/clear、db/delete、service/remove、service/remove/public、source-update/apply）统一加管理员校验。`GET /api/ai-review/eval-report` 为只读聚合，按约定保持不加；桌面端 main/index.js 无鉴权模型，本次不动。
- **H1 已撤销**：按呈现方案修订纪要 2.4 节回退曾尝试补回的容器，`index.html` 恢复缩编配置页（无 `#aiSuggestions/#aiSuggestionsEmpty/#aiDetail/#btnAiRefresh`），app.js 未改、缓存戳未 bump。
- **验证**：`node --check src/server/web.js`、`src/renderer/app.js` 通过；`tests/ai-review.test.js`、`tests/auth.test.js`、`tests/auth-ui.test.js`、`tests/auth-bg-ui.test.js` 全绿。
- **仍未修**：M1、M3-M8 及 L 类各项，留待后续排期。
