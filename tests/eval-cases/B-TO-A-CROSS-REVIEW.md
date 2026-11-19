# B 组 → A 组：R9 域名校验 / R1 沙箱交回面 交叉复核报告

> 复核方：B 组（R7 测试成员）
> 被复核方：A 组（R9 域名校验实现 + R1 沙箱 facade）
> 复核范围：**只读 + 测试**，**不修改 A 组正在改的 `lx-hunter/src/`**
> 复核方式：直接调用 A 组导出的纯函数 + 本地起服务做端到端实测

---

## 0. 结论速览

| # | 议题 | 结论 | 严重度 |
|---|---|---|---|
| 1 | R9 第①层只查 host **字面**，不查 DNS 解析结果 | **不同意** —— 可被「公网名 → 内网 IP」绕过，端到端 SSRF 已坐实 | 🔴 高 |
| 2 | R9 第②层 known 集合可被**音源自己声明**的域名投毒 | **不同意** —— `apiHosts` / `homepage` 都是脚本可控字段 | 🔴 高 |
| 2b | 下载阶段跟随重定向且不重校验（R9 只校验「源」） | **不同意** —— 与议题 1 叠加时 SSRF 零成本 | 🟠 中 |
| 3 | `isSameSiteHost` 父域放宽 | **不同意** —— 父域的**任意深度子域**全部放行 | 🟠 中 |
| 4 | `obfDomains`（被判为「陌生可疑域名」）进了信任集合 | **不同意** —— 语义反了 | 🟠 中 |
| 5 | `userinfo` 凭据未拒 | **不同意** —— `https://user:pass@host/` 被放行 | 🟡 低 |
| 6 | 域名形状/边界判定（伪装域、大小写、端口、协议、空 URL 等） | **同意** —— 实测全部正确 | ✅ |
| 7 | R1 交回面（`json`/`arrayBuffer`/`blob`/`bytes` × Proxy 层数） | **同意** —— 14 条攻击路径全部被沙箱拦下 | ✅ |

---

## 1. 🔴 议题 1：第①层不查 DNS ⇒ SSRF 可达（端到端坐实）

### 1.1 缺陷位置

`lx-hunter/src/core/hunter.js:536` `checkUpdateTipUrl()`：

```js
const host = normalizeHost(u.hostname)
...
const out = checkOutbound(u.href)      // ← 只按 hostname 字符串做正则
if (out && out.blocked) { ... }
if (!isValidPublicHostShape(host)) { ... }
```

`lx-hunter/src/core/outbound-policy.js:96` `checkOutbound()`：

```js
host = normalizeHost(new URL(String(url)).hostname)   // ← 字符串
for (const p of BLOCKED_HOST_PATTERNS) {
  if (p.re.test(host)) return { blocked: true, ... }   // ← 正则匹配字面
}
```

**两处都只看 URL 里的 hostname 字符串，从不做 DNS 解析。**
因此「字面是公网域名、但 DNS 解析到 127.0.0.1」的主机名全部放行。

### 1.2 实测（`tests/eval-cases/r9-dns-bypass.test.js`）

```
--- localtest.me ---
  [事实] DNS 解析 → 127.0.0.1
  [事实] 第①层 checkUpdateTipUrl → ok=true why= host=localtest.me
  [事实] 第②层 → ok=true known=["localtest.me"]
--- 127.0.0.1.nip.io ---
  [事实] DNS 解析 → 127.0.0.1
  [事实] 第①层 → ok=false why=指向私网/回环地址（IPv4 回环地址）  ← 靠"字面含 127."被拦
--- localhost.direct ---
  [事实] DNS 解析 → 127.0.0.1
  [事实] 第①层 → ok=true why= host=localhost.direct
```

端到端（本地起一个真实 HTTP 服务，让沙箱/下载器去请求）：

```
  [事实] 本地测试服务在 127.0.0.1:7475
  localtest.me:     第①层=true 第②层=true → 两层全过=true
    [实测] 实际请求 → 状态 200 body="LOCAL-SECRET" hits=1
  localhost.direct: 第①层=true 第②层=true → 两层全过=true
    [实测] 实际请求 → 状态 200 body="LOCAL-SECRET" hits=2
```

**攻击链完整成立**：

```
沙箱逃逸 → 伪造 updateTips({url:'http://localtest.me:<port>/x.js'})
        → R9 第①层：字面合法 → 放行
        → R9 第②层：攻击者在脚本里写一行 https://localtest.me/ 即可自证 → 放行
        → _followUpdateTips 调 crawlFetch(tip.url) → 实际打到 127.0.0.1:<port>
```

> `crawlFetch` 走 `fetchWithTimeout` → `fetchAnyWithTimeout`（`src/core/net.js:129`），
> Node 原生 `fetch` **默认 `redirect: 'follow'`**，实测确认跟随重定向。

### 1.3 退回建议（请 A 组处理）

1. 第①层在 `checkOutbound` 之后**增加 DNS 解析后判定**：解析 `host` 的 A/AAAA 记录，
   任一落在私网/回环/CGNAT/云元数据段 → 拒。
   —— 注意 DNS rebinding：应「解析后把 IP 交给连接层使用」，而不是「解析一次、检查一次、然后让
   fetch 自己再解析一次」（否则 TOCTOU 仍在）。
2. 至少**堵死已知公共解析到回环的名字**（`localtest.me`、`*.localhost.direct`、`127.0.0.1.nip.io`
   这类 wildcard DNS 服务）——但这只是止血，**不能替代 DNS 解析判定**。
3. 下载阶段应显式 `redirect: 'manual'` 或对每一跳重跑 R9 校验（现在校验的是**源**，终点由 302 决定）。

### 1.4 附带发现：重定向不重校验（结构性问题，非「绕过」）

R9 校验的是 `tip.url` 的 **host（源）**，而实际下载终点由服务器的 `302` 决定，两者可以不一致。
`crawlFetch` → `fetchWithTimeout` → `fetchAnyWithTimeout`（`src/core/net.js:129`）用的是 Node 原生
`fetch`，**默认 `redirect: 'follow'`**，实测确认跟随重定向：

```
  [事实] checkUpdateTipUrl(重定向源) → ok=true host=100.104.72.72
  [事实] 第②层 → ok=true known=["100.104.72.72"]
  PASS R9 两层静态校验放行了「源」，但终点由 302 决定（静态校验不跟随重定向）
  [事实] fetch 默认跟随重定向 → 最终状态 200 body="INTERNAL-CONTENT"
  PASS Node fetch 默认跟随重定向，重定向到私网后确实取到了内网内容
```

即：源域合法 + 源域在 known 集合里 ⇒ 两层校验通过 ⇒ 302 可以把请求引到**任意终点**（含内网）。
**与议题 1 叠加时，这条把 SSRF 从「一次 DNS 查询」变成「零成本」** ——
攻击者用 `localtest.me`（第①层放行）+ 302 → `http://127.0.0.1:xxxx/` 即可。

---

## 2. 🔴 议题 2：known 集合可被音源自证（自述当自有证据）

### 2.1 缺陷位置

`lx-hunter/src/core/hunter.js:590` `knownHostsForEntry()`：

```js
for (const h of (Array.isArray(e.apiHosts) ? e.apiHosts : [])) addHost(h)   // ← 脚本源码扫出来的
for (const h of (Array.isArray(e.obfDomains) ? e.obfDomains : [])) addHost(h)
addUrl(e.homepage)     // ← 脚本头 @homepage 声明的
addUrl(e.url)
addUrl(e.fetchUrl)
```

### 2.2 信任来源逐条追溯

| 字段 | 真实来源 | 是否脚本可控 | 出处 |
|---|---|---|---|
| `e.apiHosts` | `checker.extractApiHosts(entry.code)` —— **直接正则扫描脚本源码里的 http(s) URL** | **完全可控** | `src/core/checker.js:416,446,1124-1136` |
| `e.homepage` | `checker.extractMeta()` 从脚本头 `@homepage` 解析 | **完全可控** | `src/core/checker.js:70,75,412,442` |
| `e.obfDomains` | 静态扫描出的「陌生外联域名」 | 间接可控（脚本里写即可） | `checker.obfDomains` |
| `e.url` | 该条目脚本的下载地址 | 有限可控（入库时定） | `store.addSources` |
| `e.fetchUrl` | 实际拉取成功的镜像地址 | 有限可控 | `crawler`/`crawlFetch` |

**关键点**：`extractApiHosts` 就是拿一条正则去扫源码：

```js
const re = /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi
```

攻击者只要在脚本里写一行 `// https://evil.test/` 或 `const x='https://evil.test/a.js'`，
这个域名就进了 `apiHosts` → 进了自己的 known 集合 → 第②层自动放行。

### 2.3 实测（`tests/eval-cases/r9-exploitability.test.js`）

```
=== B. known 集合可被脚本自身投毒 ===
  [事实] 脚本声明 evil.test 后 → known=["evil.test"] 放行=true
  PASS 脚本声明的域名自动进入自己的信任集合（R9 把「自述」当「自有」证据）
  [事实] @homepage 声明 evil.test → known=["evil.test"] 放行=true
  PASS @homepage 声明（脚本可写）同样进入信任集合
  [事实] known=example.com → anything.attacker.example.com 放行=true
  PASS 父域放宽：父域的任意深度子域都放行
  [事实] obfDomains 进 known → known=["suspicious.test"] 放行=true
  PASS obfDomains（被判为陌生的可疑域名）也进了信任集合
```

### 2.4 退回建议

1. **known 集合必须区分「宿主实测」与「脚本自述」**：
   - `apiHosts`：来自源码扫描 ⇒ 属**自述**，不能单独作信任依据
   - `homepage`：脚本头声明 ⇒ 属**自述**
   - 只有 `e.url` / `e.fetchUrl`（宿主实际下载脚本用过的地址）是**宿主实测**
2. 建议口径：**known 里若没有一条「宿主实测」来源的域名**，第②层直接判否
   （现在 `known` 非空就放行，等于「自述即可自证」）。
3. 若一定要保留自述来源，至少要求「自述域名 ⊆ 宿主实测域名集合」，
   而不是「自述域名 ∪ 实测域名」。

> 注：这一点与 R7 的护栏是**同一个原则** —— 音源自述内容不可信、不能当判断依据。
> R7 那边已经做了 A/B 分区，R9 这边还没做。

---

## 3. 🟠 议题 3：父域放宽

`hunter.js:565` `isSameSiteHost()`：

```js
if (host.length > k.length && host.endsWith('.' + k)) return true   // host 是 k 的子域
if (k.length > host.length && k.endsWith('.' + host)) return true   // host 是 k 的父域  ← 这条
```

第②条意味着：known 里有 `example.com` ⇒ `attacker.example.com`、
`a.b.c.example.com` **全部放行**。

**实测确认**：`known=example.com → anything.attacker.example.com 放行=true`。

风险：若某个真音源的 known 里混进了 `example.com` 这种**泛用父域**（生产库 apiHosts 里存在
`175.27.166.236` 这类直连 IP，也有短 host），攻击者可用任意子域承载恶意更新脚本。

**退回建议**：
- 父域方向（host 是 known 的父域）应**只允许完全相等**，不要向上放宽；
- 子域方向应限制**一层**（`a.k` 可以，`a.b.k` 不行），且要求 known 里的 k 至少是两级域名；
- 若必须保留多层子域，至少要求该子域**也在宿主的实测外联记录里出现过**。

---

## 4. 🟠 议题 4：`obfDomains` 进信任集合（语义反了）

`obfDomains` 是静态扫描出来的「**陌生的**外联域名」——按定义就是**可疑**信号。
但 `knownHostsForEntry` 把它直接加进信任集合：

```
  [事实] obfDomains 进 known → known=["suspicious.test"] 放行=true
```

于是「一个被判定为可疑的域名」反而成了「这个音源可信的自有域名」的证据。

**退回建议**：`obfDomains` 应从 known 里**移除**，或至少**降级**为「不得单独作信任依据」。

---

## 5. 🟡 议题 5：`userinfo` 凭据未拒

```
  [事实] 带凭据 URL → ok=true url=https://user:pass@cdn.example.com/a.js
```

`checkUpdateTipUrl` 只判 `u.protocol` 和 `u.hostname`，**没判 `u.username` / `u.password`**。
后果：
- 凭据会随请求发出去（钓鱼/信息泄漏面）；
- 同一 host、不同凭据被当成同一个 tip，`followedUpdateUrls` 去重逻辑（`hunter.js:4229`）按整串 URL 比较，
  语义不清；
- `https://evil.com@good.com/` 这类**视觉混淆**（看起来像 evil.com，实际访问 good.com）不拦。

**退回建议**：第①层加一条 `if (u.username || u.password) return {ok:false, why:'地址含凭据'}`。

---

## 6. ✅ 议题 6：域名形状/边界判定 —— 同意

实测（`tests/eval-cases/r9-domain-attack.test.js`）全部正确：

| 用例 | 结果 |
|---|---|
| `evil-example.com` vs `example.com` | 不判同域 ✓ |
| `example.com.evil.com` vs `example.com` | 不判同域 ✓ |
| `example.company` / `notexample.com` / `example.com.cn` | 不判同域 ✓ |
| 末尾点（`example.com.`）、punycode 前缀、多级后缀 | 不判同域 ✓ |
| 大小写 / 端口 | 正确归一化 ✓ |
| `http` 与 `https` | 都允许 ✓ |
| 无 known 域名 | 默认拒绝 ✓ |
| 空 URL / 非 URL / `javascript:` / `data:` / `file:` / `ftp:` / 协议相对 URL | 全部拒绝 ✓ |
| 回环 / 私网 / 云元数据地址（字面） | 全部拒绝 ✓ |

**唯一 FAIL（已归入议题 5）**：带凭据 URL 被放行。

---

## 7. ✅ 议题 7：R1 沙箱交回面 —— 同意

`src/core/sandbox-facade.js` 的 `deepUnwrap` / `adaptCb` 交回面（项目记忆 `p_1f1046d4` 记的那个根因）
**实测已修复**。

测试文件：`tests/eval-cases/r1-sandbox-attack.test.js`

```
=== R1 交回面攻击：body 消费路径 × Proxy 层数 × await/then ===
  json-await              → BLOCKED:Code generation from strings disallowed for this context
  json-then               → BLOCKED:Code generation from strings disallowed for this context
  arrayBuffer-await       → BLOCKED:Code generation from strings disallowed for this context
  blob-await              → BLOCKED:Code generation from strings disallowed for this context
  bytes-await             → BLOCKED:Code generation from strings disallowed for this context
  text-await              → BLOCKED:Code generation from strings disallowed for this context
  headers                 → BLOCKED:Code generation from strings disallowed for this context
  json-2proxy             → BLOCKED:Code generation from strings disallowed for this context
  json-3proxy             → BLOCKED:Code generation from strings disallowed for this context
  json-getPrototypeOf-2proxy → BLOCKED:C(...) is not a function
  json-nested-value       → BLOCKED:Code generation from strings disallowed for this context
  promise-resolve-value   → BLOCKED:Code generation from strings disallowed for this context
  setTimeout-this         → BLOCKED:Code generation from strings disallowed for this context
  json-via-async-fn-arg   → BLOCKED:Code generation from strings disallowed for this context
  PASS 【核心】所有 body 消费路径都无法拿到宿主 process
  PASS 【防假绿】每条用例的 body 消费路径都真跑到了（无 NOFETCH）
  PASS 四条 body 消费路径（json/arrayBuffer/blob/bytes）都不逃逸
  PASS 单/双/三层 Proxy、getPrototypeOf 绕过、函数参数传递都不逃逸
  PASS realm 绕过（宿主 Object 冒充沙箱对象）不成立
  〔结论分布〕{"BLOCKED":14}
ALL PASS：6 项通过，0 项失败
```

覆盖口径：
- 四条 body 消费路径：`json` / `arrayBuffer` / `blob` / `bytes`（另加 `text` / `headers`）
- `await` 与 `.then` 两种写法
- 单层 / 双层 / 三层 Proxy、`Object.getPrototypeOf` 绕过、函数参数传递
- 判逃逸看真 process 铁证（`pid` / `mainModule` / `binding`），不是 `typeof process`
- **三态区分**（`NOFETCH`=路径没跑到 / `BLOCKED`=被沙箱拦下 / `ESCAPED`=真逃逸），
  避免「因为异常所以安全」的假绿

**两处测试写法上的坑（供 A 组后续写同类测试参考）**：
1. 沙箱 `run()` 跑 async 脚本返回 **Promise**，必须 `await` —— 否则拿到 `[object Promise]`，全绿假绿；
2. 沙箱**禁止访问回环地址**，起本地服务要绑**非回环本机地址**，否则 14 条用例全被沙箱自己的
   SSRF 防线拦掉，同样是假绿。

---

## 8. 复核方法与产物

### 8.1 新增测试文件（均在 `tests/eval-cases/`，只读生产源码）
| 文件 | 用途 |
|---|---|
| `r9-domain-attack.test.js` | R9 域名形状/边界攻击 |
| `r9-exploitability.test.js` | R9 known 集合自证 / 父域放宽 / userinfo |
| `r9-dns-bypass.test.js` | R9 第①层 DNS 层绕过（端到端 SSRF） |
| `r1-sandbox-attack.test.js` | R1 交回面攻击 |

### 8.2 A 组导出的纯函数（B 组直接调用，未改源码）
`hunter.js:5281-5283` 导出了 `checkUpdateTipUrl` / `checkUpdateTipHostBelongsTo` /
`knownHostsForEntry` / `isSameSiteHost`，测试直接 `require` 使用。

---

## 9. 汇总：需要 A 组改的 5 件事（按优先级）

| 优先级 | 事项 | 位置 |
|---|---|---|
| P0 | 第①层增加 **DNS 解析后私网/回环判定**，并处理 DNS rebinding（解析结果交给连接层） | `hunter.js:536` / `outbound-policy.js:96` |
| P0 | known 集合**剔除或降级脚本自述来源**（`apiHosts` / `homepage` / `obfDomains`），无「宿主实测」来源时第②层直接判否 | `hunter.js:590` |
| P1 | 下载阶段 `redirect: 'manual'`，或对每一跳重跑 R9 校验 | `hunter.js:4252` / `net.js` |
| P1 | `isSameSiteHost` 父域方向不向上放宽；子域方向限一层 | `hunter.js:565` |
| P1 | `obfDomains` 从 known 移除 | `hunter.js:606` |
| P2 | 第①层拒绝带 `userinfo` 凭据的 URL | `hunter.js:536` |

**R9 本身的口径提醒**：`tip.msg` 不参与 R9 任何一层判定（`r9-domain-attack.test.js` ④ 已记录事实）。
`msg` 是**音源自述的任意文本**，与 R7 的 B 区是同一类东西 —— 若 R4 把它拼进 AI prompt，
注入面依然存在（R7 侧已加护栏，R4 侧尚未处理）。
