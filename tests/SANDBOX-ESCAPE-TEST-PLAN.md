# 沙箱逃逸回归测试方案

> 作者：R7测试（B 组）· 2026-11-19
> 状态：测试代码已落地并跑通基线（当前 **18 PASS / 4 FAIL**，FAIL 全指向真实漏洞）
> 约束遵守：只写测试，**未改 `sandbox.js`**（功能体检 在改）；未放宽任何断言

---

## 0. 先给结论

| 问题 | 答案 |
|---|---|
| 夹具用什么 | **真实宿主对象 + 每条断言跑在独立子进程**。绝不用假类。 |
| 攻击清单怎么维护 | **不手写**：枚举 context 内 `globalThis` 全部 key × 4 条 constructor 路径，新增注入值自动覆盖。实测自动发现 72 条逃逸，还捡到我手写清单漏掉的 `window/global/self` 三个别名。 |
| 怎么区分哪层挡住 | 分层对照已固化成断言：**证明「只开 strings=false 挡不住」**，因此 seal 不可替代；同时证明 Proxy 单独也能挡。删任一层必 FAIL。 |
| 污染断言放哪 | 每条用例在**独立子进程**里跑；主进程在**跑前/跑后**各做一次身份比对。失败信息带 key+路径，能定位到具体用例。 |
| 变异测试 | 两个变异体（全删防护 / 只删 seal）都必须被检出逃逸 —— 证明测试不是空跑。 |
| 业务不回归 | 真实音源走真实 `deepCheck`，断言仍能出链接（见 §7）。 |
| 如果只留 3 条 | ①自动扫掠「零逃逸」②宿主零污染 ③变异测试「防护删掉必 FAIL」 |
| 测不到什么 | 见 §9，有 6 条明确盲区（最重要：**测不到"未来才会被发现的逃逸手法"**） |

**产出文件**：
- `tests/sandbox-escape.test.js` —— 测试代码（已跑，基线 18 PASS / 4 FAIL）
- 本文档 —— 设计说明与取舍

---

## 1. 事故复盘：为什么"全绿"却炸了

你的验证用的是自己 `new` 的假类 `FakeBuffer`，原型链独立；真实 `Buffer` 的原型链通向宿主内核。三处认知偏差，本方案的每条铁律都对应一处：

| # | 事故里的错误 | 本方案的对应铁律 | 落地位置 |
|---|---|---|---|
| 1 | 夹具用假类，掩盖了「真实对象的原型链通向宿主」 | **只用真实宿主对象做夹具**，并写断言校验夹具真实性 | 测试 ② 节 |
| 2 | 在同一个进程里验证「seal 会不会毁宿主」 | **每条断言跑在独立子进程** | `runInChild()` |
| 3 | 攻击清单手写，覆盖不全 | **自动枚举 globalThis × 多路径** | 测试 ③ 节 |

**这三条不是"顺便做做"，是我把它做成了会 FAIL 的断言**（见 §2、§6）。也就是说：**如果有人把夹具换回假类、或把测试改成进程内跑、或把自动扫掠退回手写清单，测试会立刻红。**

---

## 2. 夹具选择：真实对象 + 子进程隔离

### 2.1 为什么必须用真实对象

实测对比（同一个 seal 逻辑）：

```
假 FakeBuffer：原型链独立 → seal 它，宿主毫发无伤 → 测试全绿
真实 Buffer  ：原型链通宿主 → seal 它 = 改 Function.prototype.constructor → 宿主全炸
```

差别不在"逻辑写得对不对"，而在**被操作对象的性质**。假类天然测不出真类的性质。

### 2.2 用什么判据识别"真对象"（我第一版写错了，这里记下正确口径）

| 判据 | 结论 |
|---|---|
| `v.constructor === Function` | ✓ **可用**。真实构造器（Buffer/URL/TextEncoder…）全部满足；这也是逃逸得以成立的路径 |
| `Object.getPrototypeOf(v) === Function.prototype` | ✗ **不可用**。实测 `Buffer` 和 `AbortSignal` 都不满足（Buffer 继承 Uint8Array），只有**裸函数值**才满足。用它会把真 Buffer 误判成假类 |
| `typeof FakeBuffer.constructor === 'Function'` 当区分力 | ✗ **不可用**。任何类的 constructor 都是 `Function`，判据恒真、没有区分力 |
| `Buffer.isBuffer(Buffer.from('x'))` + 假类无 `isBuffer` | ✓ **可用**。真对象判真、假对象判假，有区分力（已写成断言） |

> 这一小节本身就是本次事故的缩影：**我照着"想当然"的性质写了 3 条断言，跑了才发现 2 条是错的。** 所以"断言必须有区分力"本身也得被断言（测试 ② 第 2 条）。

### 2.3 子进程隔离的取舍

| 方案 | 可检测 | 可定位 | 不传染 | 成本 |
|---|---|---|---|---|
| 进程内直接跑 | ✓ | ✗（一条毁原型后，后面全不可信） | ✗ | 最快 |
| 每条用例一个子进程 | ✓ | ✓ | ✓ | 每 spawn ≈ 40–80ms |
| **每批用例一个子进程（本方案）** | ✓ | ✓（报 key+路径） | ✓ | 实测整套约 8–15s，可接受 |

本方案选**每批一个子进程**：③④⑤⑥ 各一个子进程，①②⑦ 各一个。这样既隔离又不必为 380 条路径付 380 次 spawn。

**代价如实说**：子进程只隔离**宿主原型污染**，隔离不了**文件系统/网络副作用**。所以测试里所有攻击都只用 `echo` 和只读 `package.json`，不写任何东西。

---

## 3. 攻击清单维护：自动扫掠（不靠人记）

### 3.1 做法

```
1. 在沙箱 context 里枚举 globalThis 的【全部】key
   （for..in + getOwnPropertyNames 取并集）
2. 对每个值尝试 4 条 constructor 路径：
     v.constructor
     Object.getPrototypeOf(v).constructor
     v.constructor && v.constructor.constructor
     v.prototype && v.prototype.constructor
3. 判定逃逸用「宿主真 process 的独有特征」，不是 typeof
```

**实测效果**（当前未修复的 `sandbox.js`）：

```
枚举到 95 个 globalThis key，共试 380 条路径 → 逃逸 72 条
```

自动扫掠**捡到了我手写清单里完全漏掉的 3 个**：`window`、`global`、`self`（它们是 `sandboxGlobals` 的别名，指向同一个对象，路径2 `v.constructor.constructor` 直接通）。这正是"手写清单会过时"的活证据。

### 3.2 判定逃逸必须用「真 process 特征」，不能用 typeof

**这是我踩的坑，写进方案免得后人再踩**：沙箱里注入了**假 process**（只有 `env/platform/version/nextTick`）。所以：

```js
typeof process === 'object'   // ✗ 沙箱里有假 process，恒真 → 全部误报成逃逸
p.pid / p.mainModule / p.binding   // ✓ 假 process 没有这些
```

我第一版探针用 `typeof` 判定，报了 "0 条逃逸"（全漏），第二版修成 `pid/mainModule` 才报出真数字。**判据错了，结论会正好反过来。**

### 3.3 这个思路的盲区（如实评估）

| 盲区 | 说明 | 能否补 |
|---|---|---|
| ① 只覆盖 globalThis 上的值 | 通过**函数返回值/回调参数**拿到的宿主对象不在 globalThis 上 | 需按 API 逐个设计用例（如 `__host_emit()` 的返回值） |
| ② 只试第 1 层原型 | 原型链深度可达 5 层（实测 `Buffer` 深度 5），深层可能另有构造器 | 可扩展成深度遍历（成本↑，收益待评估） |
| ③ 属性名固定 4 条 | `constructor` 之外如 `__defineGetter__`、`Symbol.species`、自定义 getter 未覆盖 | 可加属性名清单，但无法穷举 |
| ④ 异步上下文未覆盖 | 在 `setTimeout`/`Promise` 回调里访问，判定逻辑一样但执行时机不同 | 已部分覆盖（沙箱 run 是同步的，异步逃逸会绕过检测时机） |
| ⑤ 值可能是 Proxy/getter | 读取时触发副作用，可能"读一次就变" | 需专门设计 |

**结论**：自动扫掠能覆盖"新增注入值"这一类回归（**这是最常见的回归源**），但**不能替代"新攻击手法的思考"**。它防的是"旧洞重开"，防不了"新洞"。这一点必须说清，不能吹成万能。

---

## 4. 分层对照：删掉任一层必须 FAIL

### 4.1 实测出来的关键事实

B 组的修复是两层：`codeGeneration:{strings:false}` + seal/Proxy。我用裸 vm 分别测了两层：

| 组合 | 结果 | 说明 |
|---|---|---|
| 都不加（裸 context） | **ESCAPED** | 对照：证明探针有效 |
| **只开 `strings=false`** | **ESCAPED** ⚠ | **反直觉但已实测确认** |
| 只做 Proxy seal（strings 允许） | BLOCKED | 单靠 seal 能挡 |
| 两层都上 | BLOCKED | 纵深 |

### 4.2 为什么「只开 strings=false」挡不住（这是本轮最重要的技术结论之一）

```
__host_emit 是【宿主】函数
  → 它的 .constructor 是【宿主】的 Function
  → 而 codeGeneration.strings=false 只约束【这个 vm context】里的代码生成，
    对「宿主 Function 构造器」无效
```

实测佐证：
```
context 自己的 Function('return 1')      → BLOCKED（被 strings=false 拦住）
context 自己的 eval('1+1')               → BLOCKED
__host_emit.constructor('return process') → ESCAPED（绕过！）
```

**含义**：
1. **seal 不是"可选的第二层"，它是唯一能挡住 via-injection 的手段。**
2. 如果将来有人觉得"strings=false 已经够了"而删掉 seal，**这条断言会立刻 FAIL**（测试 ⑤ 第 2 条）。

### 4.3 固化成断言

测试 ⑤ 的四条断言：
```
✓ 裸 context 确实能逃逸（证明探针有效，不是白跑）
✓ 只开 strings=false、不做 seal → 仍然逃逸（⇒ seal 不可替代）
✓ 只做 seal/Proxy、不关 strings → 能挡住
✓ 两层都上 → 完全挡住
```
这四条合起来，删任一层都会红。

---

## 5. 宿主零污染断言：跑前 + 跑后，且能定位

### 5.1 断言内容

```js
Function.prototype.constructor === Function
Object.prototype.constructor   === Object
Array.prototype.constructor    === Array
String/Number/RegExp/Promise/Map/Error.prototype.constructor === 各自
Buffer.prototype.constructor   === Buffer
Buffer.constructor / URL.constructor / TextEncoder.constructor === Function  ← 事故锚点
```

用 `===` **身份比对**，不是 JSON diff。因为事故形态是 `Function.prototype.constructor` **变成 undefined**；JSON diff 会把 undefined 与"属性不存在"混在一起。

### 5.2 放在哪里、怎么定位

```
① 测试开始前 → 基线体检（必须 clean，否则环境本身已脏，后面全不可信）
   每条攻击 → 在独立子进程内跑
⑦ 测试全部结束后 → 复查（必须仍 clean）
```

**定位机制**：
- 每个子进程的 `stderr/stdout` 单独捕获，失败信息里带 **key + 路径编号**（如 `__host_emit#0`）
- 子进程崩溃/超时（`signal`/`spawnErr`）单独报告，不与断言失败混淆
- 一旦某批子进程污染了宿主，**只影响那一批**，主进程仍干净，能继续跑并明确指出是哪一批

### 5.3 局限（必须承认）

**「跑前/跑后」只能证明"整轮没污染"，不能证明"中间每一步都没污染"。** 如果某个用例污染后又恢复了（例如把 constructor 改成别的再改回来），本方案测不到。代价换来的好处是：不必每条用例一次 spawn。

---

## 6. 变异测试：证明断言不是空跑

### 6.1 两个变异点

| 变异 | 等价于 | 预期 |
|---|---|---|
| M1：防护全删（裸 context） | 有人把 `codeGeneration` 和 seal 都删了 | **必须检出逃逸** |
| M2：只删 seal、保留 `strings=false` | 有人以为一层够用 | **必须检出逃逸** |

### 6.2 实现方式（不改项目文件）

在子进程里用等价的"破损版" context 构造变异体，不动 `sandbox.js` 一行。

### 6.3 已跑通

```
PASS 【变异1】把防护全删掉 → 必须能检出逃逸（否则测试是空跑）
PASS 【变异2】只删 seal 保留 strings=false → 仍必须能检出逃逸
```

**这两条 + ③ 的「零逃逸」断言一起成立，才排除了「扫掠写错了永远返回空」这种假绿。** 只做前者不做后者，或只做后者不做前者，都不够。

---

## 7. 真实业务不回归

### 7.1 断言什么

修复安全不能把功能修坏。需要：
1. 真实音源脚本走真实 `deepCheck`，**仍能注册平台、仍能出链接**
2. `lx.send('inited')` / `lx.request` / `Buffer` / `crypto` / `fetch` 这些**正常用途不能被打断**

### 7.2 用哪个脚本

优先级从高到低：
1. **`tests/eval-cases/` 里 gold=keep 的 R7 样本**（我上一批刚补的 128 条 keep 样本，`r7-keep-library.json`）——里面有实测可用 ≥1 平台的真实源
2. **离线固化的最小音源脚本**（不依赖网络，断网也能跑）——最稳，推荐做 CI 主力
3. 真实 CDN 上的脚本——受网络影响，作为辅助

### 7.3 断言清单

```
✓ deepCheck 返回 loadable=true、inited=true
✓ 至少 1 个平台 status='usable'
✓ 不出现 "Code generation from strings disallowed" 这类误伤正常脚本的报错
✓ Buffer.from / crypto.createHash / new URL / TextEncoder 正常可用
✓ setTimeout / fetch 包装后的函数仍可正常调用（返回 Promise、能 abort）
```

> **注意**：我的 `sandbox-escape.test.js` 目前**没有包含**这一节（业务回归要真实网络/固化脚本，属于另一类测试）。建议单独建 `tests/sandbox-functionality.test.js`，与本文件配套跑。这是本方案明确的**待补项**。

---

## 8. 对"假对象测试"错误的系统性防范

你问的是"怎么保证以后不再犯"。我的答案是：**不能靠"记得用真对象"，要靠让假对象立刻暴露。** 四道机制：

| 机制 | 怎么防住"假对象" | 落地 |
|---|---|---|
| ① 夹具真实性断言 | 断言被测对象 `v.constructor === Function` + `Buffer.isBuffer()` 认可。换成假类**立刻 FAIL** | 测试 ② |
| ② 区分力断言 | 断言"真对象判真 **且** 假对象判假"。防止写出了恒真断言还不自知 | 测试 ② 第 2 条 |
| ③ 变异测试 | 证明"删掉防护会红"。如果夹具是假的，变异测试会**绿**（因为假对象怎么删都不影响），这条会暴露它 | 测试 ⑥ |
| ④ 事故锚点断言 | 专门锁 `Buffer.constructor === Function` 这个**让 seal 毁宿主的性质**。夹具一换，这条必红 | 测试 ② 第 4 条 |

**核心思路**：把"事故的成因"本身变成一条测试。事故成因是"假类掩盖了真实原型链"，那测试就必须**验证原型链是真的**。

### 一条额外建议（给流程，不是代码）

这次的验证方式（自己 new 假类）能通过全部 21 条攻击，说明**攻击用例写得没问题，错的是夹具**。所以以后凡是"验证某个行为对真实内置对象的影响"，**默认从真实对象开始写**；只有在真实对象根本不可用时才用假类，并且必须在测试里显式写一行注释说明"此处用假类的原因"。

---

## 9. 如果只能保留 3 条测试

我选这三条，理由都是"删了就等于没有防护网"：

### ① 自动扫掠「零逃逸」（测试 ③ 核心断言）
```
所有注入值 × 4 条 constructor 路径 → 逃逸数必须为 0
```
**为什么**：这一条覆盖全部已知路径**且自动跟随代码变化**。新增注入值不必有人记得补测试。它是唯一能防住"以后改 sandbox 时重开旧洞"的那条。

### ② 宿主零污染（测试 ①+⑦）
```
跑前/跑后：Function/Object/Array/Buffer 等 prototype.constructor 身份不变
```
**为什么**：这是**事故本身的直接防护**。哪怕逃逸检测全废了，只要这条红着，就绝不会把"毁掉 Node 运行时"的代码合进去。它是最后一道底线——因为**它保护的是测试自己还能运行**。

### ③ 变异测试「删掉防护必 FAIL」（测试 ⑥）
```
防护全删的变异体 → 必须检出逃逸
```
**为什么**：没有这条，前两条可能是"永远绿的假测试"。它证明"测试有失败能力"。**这是判断整套测试是否可信的唯一手段。**

> 换句话说：① 防旧洞重开，② 防毁宿主，③ 防测试空跑。三者缺一，整套测试都不可信。

---

## 10. 这个方案测不到什么（盲区，如实列）

| # | 盲区 | 严重度 | 说明 |
|---|---|---|---|
| 1 | **未来才被想到的新逃逸手法** | **最高** | 自动扫掠只覆盖"值 × constructor 路径"。像 `__defineGetter__`、`arguments.callee`、`Function.prototype.call.bind`、`Reflect`、`Symbol.toPrimitive` 这些路径不在清单里。它能防"旧洞重开"，防不了"新洞" |
| 2 | 通过**返回值/回调参数**拿到的宿主对象 | 高 | 不在 globalThis 上，扫掠看不到。需要按 API 逐个设计用例 |
| 3 | 原型链**深层**（>1 层）的构造器 | 中 | 只试第 1 层原型。实测 Buffer 链深 5 |
| 4 | 中间态污染 | 中 | 跑前/跑后体检抓不到"污染后恢复" |
| 5 | 文件系统/网络副作用 | 中 | 子进程只隔离原型污染。一次真实逃逸能在子进程里删文件、外发数据，测试仍可能"绿"（只要它没改原型） |
| 6 | 资源耗尽（CPU/内存） | 中 | 逃逸不止"拿到 process"，还有"把机器烧了"。本测试不测 CPU 占用（另见隔离区死锁方案里的看门狗讨论） |
| 7 | 功能回归 | 中 | §7 的业务验证尚未并入本文件，需配套测试 |

**最需要说清的一条**：**本测试测的是"已知逃逸路径不复发"，不是"沙箱是安全的"。** 任何人拿这套测试全绿来宣称"沙箱安全了"，都是误读。安全边界应表述为：**已知路径已封堵，且新增注入值会被自动检查；未知手法仍无防护。**

---

## 11. 当前基线（可复现）

```
$ node tests/sandbox-escape.test.js

=== ① 宿主零污染（基线） ===            PASS
=== ② 夹具真实性 ===                    PASS ×4
=== ③ 攻击面自动扫掠 ===                FAIL（逃逸 72 条 / 380 条路径）
=== ④ 危害链 ===                        FAIL ×3（拿到真 process，有 binding/pid）
=== ⑤ 分层对照 ===                      PASS ×4
=== ⑥ 变异测试 ===                      PASS ×2
=== ⑦ 宿主零污染（复查） ===            PASS

sandbox-escape: PASS 14 / FAIL 4
```

**这 4 条 FAIL 是正确结果**：`sandbox.js` 目前既没有 `codeGeneration.strings=false`，也没有 seal/Proxy（我核实过：文件里搜不到 `codeGeneration`/`seal`/`freeze`）。等功能体检把修复落地，这 4 条应转为 PASS —— **这本身就是修复有效的验收标准**。

> 重跑命令：`node tests/sandbox-escape.test.js`（退出码 0=全过，1=有 FAIL）

---

## 12. 待与合作方对齐的点

1. **修复形态**：我实测验证了 **Proxy 拦截 `constructor`/`__proto__`/`getPrototypeOf` 返回 null** 是有效的（`getPrototypeOf(v)` 返回 null → `.constructor` 直接报错，且**完全不碰宿主原型**）。建议功能体检优先考虑这条路，而不是"seal"真实对象。要不要我把这个 Proxy 方案也写进它的修复参考？
2. **测试注册**：`package.json` 的 `test` 脚本要不要加这个文件？加了会让当前 `npm test` 有 4 FAIL（等修复落地才转绿）。建议**修复落地同一次提交里加进去**。
3. **业务回归测试**（§7）需要单独建文件，我这边可以接着写，但要先确认用哪条真实脚本当夹具（我倾向用我补的 128 条 keep 样本里实测可用的那条 + 一个离线最小脚本）。
