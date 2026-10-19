# Spec — 注入补丁（`src/inject/patch.js` + `src/patch.ts`）

> **适用范围：仅 asar 路线（Windows / Linux 的 Electron 版）**。
> macOS 版是原生应用、没有可注入的入口，走「伪造许可证记录文件」路线
> （见 spec `module-platform.md` 与 `docs/researches/activation-mac.md`）。

## 要构建什么

- 目标：一段被注入到 Typora 明文入口**最前面**的代码，使被改动过的程序仍能通过自校验，
  并让许可证链路在无服务端的情况下判定为「已激活、已续期、无更新」。
- 约束：不依赖任何 Typora 版本相关的常量——入口名、基准哈希、文件长度、版本号、指纹全部现算。

## 行为

### 1. 自校验放行（两层，互为兜底）

Typora 启动约 1s 后会：读 `<asar>/package.json` 取 `main` → 读该文件 → sha256 → 与内置基准比对，
不一致就记录 `[LC] Integrity check failed` 并退出。补丁做两件事：

- **(a) 读取层**：包装 `fs.readFileSync` / `fs.readFile` / `fs.promises.readFile`，
  当路径规范化后等于 `path.join(__dirname, <入口名>)` 时，返回**随包发布的入口原文**
  （打包时以 base64 内嵌）。这样无论校验用什么算法、怎么比对，都会算出基准值。
- **(b) 哈希层**：包装 `crypto.createHash`，当 `sha256` 的 `update()` 实参满足
  「字节长度等于补丁后入口文件的长度」且「包含补丁标记 `/* === hapora license patch === */`」时，
  `digest(enc)` 返回随包发布内容的 sha256。
- 两层各自单独都足以通过校验（已实测），同时保留是为了在未知版本上互相兜底。
- 其余哈希调用（如机器指纹）必须原样透传。

### 2. 许可证解密接管

- 包装 `crypto.publicDecrypt`。
- **判据只有一条：解密抛错才返回伪造载荷，解密成功一律原样返回。**
  Typora 用 `publicDecrypt` 做两件事：
  1. 解密许可证密文（明文是许可证 JSON）；
  2. 运行约 9 分钟后的**周期性 RSA 自检**（`Math.random() >= 0.8` 时触发，日志打 `2nd <随机数>`）：
     用内置固定密文解密，期望得到一段固定的**非 JSON** 明文，再做 `Buffer.equals` 比较。
  本工具写进许可证存储的是明文标记（18 字节，长度非法），(1) 必然抛 `DATA_LEN_NOT_EQUAL_TO_MOD_LEN`；
  (2) 的固定密文合法、解密必然成功。因此「成功即放行」对两类调用都正确：
  真实许可证与自检明文都透明通过，只有我们自己的标记被替换成伪造载荷。
- 伪造载荷字段：`deviceId` / `fingerprint` / `email` / `license` / `version` / `date` / `type`。
- **反例（ADR-014 修复的 bug）**：曾用「明文不以 `{` 开头就返回伪造载荷」作判据。它会把自检的合法
  非 JSON 明文换成许可证 JSON，使 `equals` 比较失败 ⇒ 撤销激活并清空 `SLicense`。
  现象是「激活后能用几分钟到几小时，然后 `SLicense` 被清空」，且启动验收完全测不出来
  （自检在启动约 9 分钟后才跑，`pnpm hack --yes` 只等 6s）。
- `fingerprint` **必须逐字符等于客户端自己算出来的那一份**，否则整份载荷被拒（详见研究报告 §4.1）：
  `Base64(SHA256(MachineGuid + "typora"))[0..10].replace(/[/=+-]/g, "a")`，
  `MachineGuid` 来自 `HKLM\SOFTWARE\Microsoft\Cryptography`（先试 `native-reg`，失败回退 `reg.exe`）。
  末尾那次 `.replace()` 不能省——base64 前缀里出现 `+` `/` `=` 的概率约一半，
  省掉它会让补丁在一半的机器上静默失效。
- `version` 取当前 Typora 版本（读同目录 `package.json`）。
- `email` / `license` 来自配置（见 `module-hack-cli.md`）。

### 3. 续期 / 激活 / 反激活接管

- 包装 `electron.net.request`。
- URL 命中 `/api/client/` 时，返回一个假 `ClientRequest`，其 `end()` 之后异步 `emit("response", res)`，
  `res` 是 `stream.Readable`，携带 `statusCode = 200`、`statusMessage`、`headers`，body 为
  `{"success":true,"code":1,"msg":"<base64(许可证标记)>"}`。
- 其余 URL 原样透传给原实现。

### 4. 更新检查接管

- 同一个 `net.request` 包装内，URL 命中 `/releases/*.json` 时，返回 body 为
  `{"name":"typora","version":"<当前版本>","releaseNoteLink":"","download":"","downloadCN":"","alternatives":{}}`
  的假响应，使客户端认为已是最新。

## 输入 / 输出

- 输入（模板占位符，由 `src/patch.ts` 渲染，每个在全文件只出现一次）：
  - `__HAPORA_SELF_SHA256__` → 入口原文的 sha256（64 位十六进制）
  - `__HAPORA_SELF_B64__` → 入口原文的 base64
  - `__HAPORA_SELF_LEN__` → 补丁后入口文件的字节长度，定宽 8 位
  - `__HAPORA_ENTRY__` → 入口文件名（相对 asar 根）
  - `__HAPORA_MARKER__` → 许可证标记明文（同时用作许可证值）
  - `__HAPORA_LICENSE_KEY__` / `__HAPORA_EMAIL__` → 伪造载荷里的序列号与邮箱
- 输出：改写后的入口源码（字符串）。
- 运行期输出：`typora.log` 中的 `[L] pass` / `[watch L] hasL: true` / `[renewLicense]: license renewed`。

## 约束

- 语法锁定 ES5：只用 `var` 与 `function`，不用箭头函数、模板串、`const`/`let`。
- 注入位置固定为文件最前面（若以 `"use strict"` 开头则插在其后），不依赖入口里的任何语句形式。
- 占位符全文件各出现一次；`src/patch.ts` 渲染前校验模板包含全部占位符，渲染后校验长度占位符只出现一次。
- 长度回填必须定宽：先 8 个 `0`，量出长度后替换成同宽数字。
- 注入代码整体包在 IIFE 内，且除 Hook 安装外不产生全局副作用。
- 不引入任何新依赖：只用 Node/Electron 内置模块。

## 边界条件

- `crypto.publicDecrypt` 收到空 Buffer / 非法 Base64 / 长度不符的密文（抛错）→ 落回伪造载荷。
- `crypto.publicDecrypt` **解密成功但明文不是 JSON**（周期性自检的固定密文）→ 必须原样返回，
  不得替换成伪造载荷。这是 ADR-014 修复的核心：替换会让 Typora 的 `Buffer.equals` 自检失败，
  进而在启动约 9 分钟后撤销激活并清空 `SLicense`。
- `Math.random()` 是自检分支的选择器：`>= 0.8` 走自检、`< 0.8` 走重新校验许可证。
  补丁对两条分支都必须正确（不得依赖随机数落在哪一侧）。
- `MachineGuid` 读不到 → 指纹退化为 `SHA256("typora")` 的前 10 位；**客户端会因指纹对不上而拒绝**，
  表现为 `no info` / `onUnfillLicense` / `hasL: false`（不会报错，也不会崩）。这是已知的失败模式，
  不是可以忽略的降级。
- `fingerprint` 只要与客户端算出的值差一个字符（例如漏了末尾的 `.replace(/[/=+-]/g, "a")`），
  整份载荷就会被拒；`email` / `date` / `version` / 许可证号则完全不校验。
- `native-reg` 不可用 → 回退到 `reg.exe`；两者都失败 → 空串。
- `electron.net` 不可用 → 静默跳过网络接管（不影响本地激活）。
- 请求在 `end()` 之前被 `abort()`/`destroy()` → 不发出响应，避免幽灵事件。
- 入口文件以 URL 对象 / Buffer 形式传给 fs read → 路径匹配按字符串处理，不命中则原样透传。
- 更新检查拿到的 URL 不属于上述两类（例如 `file://` 资源）→ 原样透传，不能影响页面加载。

## 验收标准

- [x] 注入后 `typora.log` 出现 `[L] pass` 与 `[watch L] hasL: true`。
- [x] 注入后不出现 `Integrity check failed`（自校验放行生效）。
- [x] 单独关闭读取层、或单独关闭哈希层，校验仍然通过（两层各自充分）。
- [x] 两层同时关闭时校验失败并退出（证明上面两条不是假阳性）。
- [x] 出现 `[renewLicense]: license renewed`，且不出现 `unfill due to renew fail`。
- [x] 启动后 `checkForUpdates` 不再产生任何更新提示。
- [x] 主窗口无 `UNREGISTERED` 水印，许可证对话框显示「已使用以下序列号激活」。
- [x] 在用户持有真实许可证的机器上，`publicDecrypt` 返回真实 JSON 时行为不变（原样放行）。
- [x] **（ADR-014）解密成功但明文非 JSON 时原样返回**，不替换成伪造载荷
      —— `test/patch.test.ts` 与 `test/regression-selfcheck.test.ts` 以旧/新判据 A/B 钉死。
- [x] **（ADR-014，真机 · Windows / Typora 1.14.10）`>= 0.8` 自检分支**：沙箱副本 + 强制
      `Math.random()=0.95`，运行超过自检触发点后 `SLicense` 保留、`hasL` 保持 true、无 `onUnfillLicense`、
      进程存活。实测自检定时器 `setTimeout delay=530469ms`（≈8m50s，与 Issue 的「8m51s」吻合）；
      探针记录 `REAL ok out.len=100 firstChar="p" isJSON=false` → `FINAL out.len=100 identicalToReal=true`
      （100 字节合法明文逐字节透传）。为对称 A/B 另跑一轮把该定时器压到 20s，结论一致。
- [x] **（ADR-014，真机 · 对照组）修复前的判据在完全相同条件下复现撤销：**
      `REAL ok out.len=100 isJSON=false` → `FINAL out.len=163 firstChar="{" identicalToReal=false`
      （探针记 `!!!!! 生产补丁改写了合法解密结果`），Typora 日志 `2nd 0.95` 后 **7ms** 出现
      `onUnfillLicense`，注册表 `SLicense` 被清空。自然 530s 与压缩 20s 两种时序下均复现，
      证明差异只来自判据、与定时器压缩无关。
- [x] **（ADR-014，真机）`< 0.8` 重新校验分支未受修复影响（回归确认）**：在已注入修复版补丁的
      真实安装上自然触发（实测 `2nd 0.06506679632211776`），日志为
      `2nd` → 重读 `[WindowsLicenseLocalStore] SLicense` → `renew` → `[L] pass` →
      `[renewLicense]: license renewed`，无 `onUnfillLicense`。
      这条分支会重新解密本工具写入的 18 字节标记（必抛错 ⇒ 仍落入伪造分支），
      结果证明「解密抛错才伪造」的新判据对既有激活路径完全等价。

## 完成定义

- 如何判定已完成：以上清单全部勾选，且把入口文件整体换个位置注入（不依赖任何原语句）后仍能通过验收。
