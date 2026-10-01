# ARCHITECTURE — hapora

## 系统概述

本仓库自身很小，复杂度全在「被改对象」上。结构上只有两条线：一条 CLI 编排，一条注入源码。

```
                     pnpm hack
                         │
                 ┌───────▼────────┐
                 │  src/hack.ts   │  编排（按能力位分支）：
                 └───┬────────┬───┘
                     │        │  [asar 路线] 备份 → 注入 → 打包(临时) → 落盘 → 写许可证 → 验收
                     │        └─ [记录路线] 备份记录 → 伪造记录 → 验收
        ┌────────────┘
        ▼
┌──────────────────┐                 ┌─────────────────┐
│  src/typora.ts   │  平台无关门面    │  src/patch.ts   │
│ 定位/进程/启动/写入│                 │ 渲染占位符并注入 │
└────────┬─────────┘                 └────────┬────────┘
         │ 调用                               │ 读取
         ▼                                    ▼
┌────────────────────────────────┐  ┌──────────────────────────┐
│        src/platform/           │  │ src/inject/patch.js      │
│ index → windows / darwin /     │  │ （仅 asar 路线：注入 Typora）│
│          linux                 │  └──────────────────────────┘
│ types / scan / unix：公共契约   │  ┌──────────────────────────┐
│ darwin-license：macOS 记录文件  │  │ src/registry.ts          │
└────────┬───────────────────────┘  │ （Windows 许可证存储）      │
         │                          └──────────────────────────┘
         ├── [asar 路线] ──▶ <安装目录>/resources/app.asar          ←─ 覆盖
         │                   <安装目录>/resources/app.asar.hapora-orig.bak  ← 首次创建
         └── [记录路线] ──▶ ~/Library/Application Support/<bundle id>/.<指纹>       ←─ 覆盖
                            ~/Library/Application Support/<bundle id>/.<指纹>.hapora-orig.bak
```

两条路线对应两类被改对象：Windows/Linux 是 Electron 应用的 `app.asar`（补丁接管进程内校验链），
macOS 是原生应用的许可证记录文件（只伪造存储，不动安装包，见 ADR-011）。

`src/asar.ts`（解包 / 打包 / 读 `main`）只被 asar 路线使用，与平台无关，故不画入上图。

运行期（Typora 进程内）：

```
[asar 路线 · Windows/Linux]
Typora 主进程
  └─ app.asar/<package.json:main>        ← 入口名从 package.json 读，不写死
       ├─ [注入] patch.js  ← 文件最前面（"use strict" 之后）：挂 3 组 Hook
       └─ require(... .jsc) ← 字节码
            └─ 读许可证存储 → 解密许可证 → 续期 → 渲染进程
                 ▲            ▲            ▲
   fs.* / crypto.createHash   publicDecrypt   electron.net.request
   （自校验放行，双层）        （许可证接管）   （续期 / 更新接管）

[记录路线 · macOS]
Typora 原生进程
  └─ LicenseManager readLicenseInfo
       └─ AES 解密 ~/Library/.../.<指纹> → keyed archive 字典
            └─ email/license 键存在 ⇒ 已激活（不校验内容、不验签）
                 └─ renew：仅当 lastTry 距今 [1,12) 小时之外才发起（伪造时落在窗口内，不发）
```

## 核心模块

| 模块 | 职责 |
|------|------|
| `src/hack.ts` | CLI 入口。参数解析、步骤编排、启动验收、失败回滚、输出报告。只调用平台无关的门面，不出现平台分支。 |
| `src/typora.ts` | 平台无关门面：把「定位 / 进程 / 启动 / 能力位 / 写入 / 许可证 / 验收探针」这些语义动作转给当前平台实现。 |
| `src/platform/index.ts` | 按 `process.platform` 选平台实现；不支持的平台直接抛错。 |
| `src/platform/types.ts` | 平台契约（`Platform` 接口）、安装信息的构造与校验、写入权限探测、外部命令封装。 |
| `src/platform/scan.ts` | 平台无关的「浅扫描」兜底：在给定根目录下找安装目录，带深度与目录数上限。 |
| `src/platform/windows.ts` | Windows 实现：注册表 App Paths/文件关联/卸载表 + PATH + 默认目录 + 盘符浅扫描；`tasklist`/`taskkill`；UAC 提权；许可证写注册表。 |
| `src/platform/darwin.ts` | macOS 实现：Spotlight(`mdfind`) + `/Applications`、`~/Applications`；`.app` 包解析（bundle id 与可执行名读自 Info.plist）；`pgrep`/`pkill`；**不走 asar 路线**，许可证走记录文件、验收走记录轮询。 |
| `src/platform/darwin-license.ts` | macOS 许可证记录文件的编解码与伪造：binary plist 最小编解码器、keyed archive 组装、AES 加解密、指纹/密钥派生、伪造配方。 |
| `src/platform/linux.ts` | Linux 实现：`which typora` + `/usr/share/typora` 等 + Flatpak/Snap；`pgrep`/`pkill`；`sudo -n` 提权；许可证未实现（显式失败）。 |
| `src/asar.ts` | `app.asar` 的解包 / 打包 / 读单文件，以及从包内 `package.json` 读 `main`。 |
| `src/patch.ts` | 补丁模板的加载与占位符渲染；把补丁注入到入口文件最前面；定义许可证值格式。 |
| `src/inject/patch.js` | 真正写进 Typora 的代码：自校验放行（读取层 + 哈希层）、许可证接管、续期/更新接管。ES5 语法。 |
| `src/config.ts` | 邮箱与序列号的可自定义项：默认值、`.env` 解析、来源优先级。 |
| `src/registry.ts` | `HKCU\SOFTWARE\Typora` 的读写，以及两个通用只读查询（`queryValue` / `queryTree`）。仅被 Windows 平台实现使用。 |

## 模块关系

- `hack.ts` 是唯一有副作用的编排者，其余模块都是工具。
- `typora.ts` 是平台无关门面，不含任何平台判断；`platform/index.ts` 是唯一的平台分派点，
  因此「加一个平台」= 加一个 `platform/<id>.ts` 加一行分支，编排流程不动。
- `registry.ts` 只被 Windows 平台实现使用；其余平台不得直接依赖它（否则跨平台会散架）。
- `platform/scan.ts` 与 `platform/types.ts` 是各平台共用的公共部分，定位规则本身才是各平台私有的。
- `patch.ts` 同时定义「补丁长什么样」和「自校验量怎么算」，是注入能否成功的关键；
  `inject/patch.js` 只负责运行时行为，两边的契约是 7 个占位符。
- `patch.ts` 与 `inject/patch.js` 必须成对修改：模板里少一个占位符，`loadTemplate()` 会直接报错。
- `config.ts` 的值只经由 `patch.ts` 的占位符流入补丁，不参与任何判定。

## 数据流

1. **定位**：`typora.ts` → 当前平台实现，按成本从低到高汇集候选、命中即止；
   每个候选都以「该目录下存在平台对应的 asar 路径」为准（见 ADR-009、ADR-010）。
2. **读原始状态**：`hack` 从 `app.asar.hapora-orig.bak` 取 `package.json` → `main` → 该入口文件的原文
   （若备份不存在，则从当前 `app.asar` 剥掉补丁）。
3. **算自校验量**：对入口原文算 `sha256`，并把原文本身编成 base64 备用。
4. **渲染并注入**：替换占位符，插到入口文件 `"use strict"` 之后的**最前面**；
   量出注入后的字节长度，回填到定宽的 8 位长度占位符（回填不改变文件长度）。
5. **打包**：解包整个 asar 到用户临时目录 → 写入新的入口文件 → 重新打包成一份成品 `app.asar`（仍在临时目录里）。
6. **落盘**：`installFiles()` 把「备份（如需）」与「成品」写进安装目录。目录可写就直接复制；
   不可写就只对这一步做一次平台提权（Windows 一次 UAC / Unix `sudo -n`）批量完成这两次复制。
7. **写许可证**：
   - Windows：`SLicense = base64("@@HAPORA_LICENSE@@") + "#0#" + M/D/YYYY`、`IDate = M/D/YYYY`（注册表，用户级，无需提权）；
   - macOS：往 `~/Library/Application Support/<bundle id>/.<指纹>` 写 AES 加密的 keyed archive 字典
     （`email` + `license` + `lastTry=now-2h` + 保留 `installDate`），不需要提权；
   - Linux：在改动任何文件之前就失败（存储位置未确认，见 ADR-010）。
8. **验收**（启动 Typora 后轮询平台探针 `probeActivation`）：
   - Windows：只读最后一次启动的 `typora.log` 片段，等过启动 ~1s 的自校验窗口；
     命中 `hasL: true` 且无致命信号判成功；命中 `Integrity check failed` / `unfill due to renew fail`
     判「补丁导致的失败」；
   - macOS：轮询记录文件是否仍带 `email`/`license` 键（unfill 会把记录物理清写成只剩 `installDate`）
     与进程是否存活，过了 settle 窗口仍完整即判成功；
   - 判定为「可归因失败」时自动回滚（还原备份 + 清许可证）。

## 外部系统

| 外部系统 | 交互方式 | 说明 |
|----------|----------|------|
| Typora 安装目录（asar 路线） | 直接改文件 | 仅 Windows/Linux：`app.asar` 被整体替换，原始文件留在同目录的 `.hapora-orig.bak`；目录不可写时这一步需要一次平台提权 |
| 许可证记录文件（记录路线） | 直接改文件 | 仅 macOS：`~/Library/Application Support/<bundle id>/.<指纹>` 被替换为伪造记录，原始文件备份为同名的 `.hapora-orig.bak`；用户目录恒可写，**无需提权、不触碰 /Applications** |
| 许可证存储 | Windows：`reg.exe`；macOS：无外部命令 | Windows 写 `HKCU\SOFTWARE\Typora` 的 `SLicense` / `IDate`；macOS 加密由 Node 内置 `crypto` 完成；Linux 尚未实现 |
| Typora 自身日志 | Windows 只读 | asar 路线的验收读 `%APPDATA%\Typora\typora.log`；macOS 无日志可用，改读记录文件状态 |
| 网络 | **不交互** | asar 路线在进程内截断请求；记录路线靠 `lastTry` 窗口让客户端不发起续期 |

## 重要技术边界

- **只改明文入口**：`.jsc` 是 V8 字节码，任何改动都会破坏 `vm.Script` 的 `cachedData` 反序列化；
  因此所有逻辑都挂在 `package.json:main` 指向的明文入口上。
- **入口名不写死**：读包内 `package.json` 的 `main` 得到；Typora 的自校验也是先读它再读目标文件，
  两边必须用同一个来源。
- **自校验基准天然对齐**：基准就是「该版本随包发布的入口内容」的哈希，补丁在打包时按实际内容现算，
  所以不需要知道基准常量是什么。
- **自校验放行是双层的**：读取层（`fs.readFileSync` / `fs.readFile` / `fs.promises.readFile` 命中入口路径时
  返回原文）与哈希层（`crypto.createHash` 命中自己时返回基准哈希）。实测两层各自单独都足以通过校验，
  同时保留是为了在未知版本上互为兜底。
- **伪造的 HTTP 响应必须是 `Readable`**：Typora 经 `electron-fetch` 发请求，内部执行 `res.pipe(...)`，
  只实现 `EventEmitter` 会在构造 `Response` 时抛错。
- **ES5 语法约束**：注入代码运行在 Typora 的模块作用域，不保证跑在支持新语法的构建配置下，
  统一用 `var` / `function`。
- **伪造载荷的 `fingerprint` 必须逐字符匹配**：客户端会拿 `Base64(SHA256(MachineGuid + "typora"))[0..10]`
  再跑一次 `.replace(/[/=+-]/g, "a")`，与许可证里的值做相等比较；漏掉末尾那次替换，
  补丁会在一半的机器上静默失效（`no info` / `onUnfillLicense`，且没有任何错误日志）。详见研究报告 §4.1。
- **提权只用于「往安装目录写文件」**：解包、注入、打包、写许可证、启动 Typora、读日志全都不需要提权；
  提权只发生在 `installFiles()` 里，且是「备份 + 成品」一次性完成的一次提权
  （Windows 一次 UAC，macOS/Linux 一次 `sudo -n`）。详见 ADR-008。
- **平台差异只允许出现在 `src/platform/`**：定位、进程、启动、验收探针、写入与提权、许可证存储
  这六件事之外，其余逻辑必须平台无关；`hack.ts` 里按**能力位**（`asarPatchSupported`）分支，
  不出现平台名。详见 ADR-010 / ADR-011。
- **定位不是「只认几个默认目录」**：按成本从低到高汇集候选（显式指定 → 注册表/Spotlight/`which` →
  PATH → 默认目录 → 卸载表 → 浅扫描），命中即止，每个候选都以平台自己的结构判据为准
  （Windows/Linux：目录下有 `resources/app.asar`；macOS：`.app` 包结构）。详见 ADR-009。
- **未实现的平台必须显式失败**：许可证存储没有实证结论的平台（当前是 Linux）在改动任何文件
  **之前**就退出，而不是猜一个位置写进去 —— 「打了补丁却没激活」比直接失败更难排查。详见 ADR-010。
- **macOS 不碰安装包**：记录路线只写用户目录下的许可证记录；安装目录的 Developer ID 签名
  （hardened runtime + Sealed Resources）保持完好，也不需要 App Management TCC 授权。详见 ADR-011。
- **macOS 的密钥/指纹是设备派生的**：`指纹 = Base64(SHA256(IOPlatformUUID))[0..10]`（`/=+-` 替换为 `a`），
  记录文件名即指纹；`key = SHA256(IOPlatformUUID + "typora-license")`。见研究报告 `activation-mac.md` §2。
- **macOS 记录文件的编码有两条硬约束**：int marker 低 4 位是 log2(字节数)；`NS.time` 必须 real。
  踩错时 `NSKeyedUnarchiver` **静默返回 nil**（现象是「伪造被无视、状态未激活」且无任何报错），
  验证必须以 `NSKeyedUnarchiver` 为准而非 `plistlib`。见研究报告 §2.3。
- **失败要响且要可逆**：补丁自检（占位符数量、长度回填、入口存在）任何一项不满足都直接抛错；
  启动验收把「不兼容」翻译成一次自动回滚，而不是留下一个启动即退的坏包（或一份被清掉的伪造记录）。
