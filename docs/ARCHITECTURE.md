# ARCHITECTURE — hapora

## 系统概述

本仓库自身很小，复杂度全在「被改对象」上。结构上只有两条线：一条 CLI 编排，一条注入源码。

```
                     pnpm hack
                         │
                 ┌───────▼────────┐
                 │  src/hack.ts   │  编排：备份 → 取原始文件 → 注入 → 打包(临时) → 落盘 → 写注册表 → 验收
                 └───┬────────┬───┘
        ┌────────────┘        └────────────┐
        ▼                                  ▼
┌────────────────┐                ┌─────────────────┐
│ src/typora.ts  │                │  src/patch.ts   │
│ 定位/进程/启动  │                │ 渲染占位符并注入 │
│ 写入(必要时提权)│                └────────┬────────┘
└───────┬────────┘                         │ 读取
        │ 调用                             ▼
        ▼                        ┌──────────────────────────┐
┌────────────────┐               │ src/inject/patch.js      │
│  src/asar.ts   │               │ （被注入进 Typora 的源码） │
│ 解包 / 打包     │               └──────────────────────────┘
└───────┬────────┘
        │                              ┌────────────────┐
        ▼                              │src/registry.ts │
%ProgramFiles%\Typora\  /  %LOCALAPPDATA%\Programs\Typora\  /  任意盘符下的浅层目录（见下）                 │HKCU 读写        │
+ %LOCALAPPDATA%\Programs\Typora\      │                 │
  resources\app.asar  ←─ 覆盖 ─────────└────────────────┘
  resources\app.asar.hapora-orig.bak  ← 首次执行时创建
```

运行期（Typora 进程内）：

```
Typora.exe 主进程
  └─ app.asar/<package.json:main>        ← 入口名从 package.json 读，不写死
       ├─ [注入] patch.js  ← 文件最前面（"use strict" 之后）：挂 3 组 Hook
       └─ require(... .jsc) ← 字节码
            └─ 读注册表 → 解密许可证 → 续期 → 渲染进程
                 ▲            ▲            ▲
   fs.* / crypto.createHash   publicDecrypt   electron.net.request
   （自校验放行，双层）        （许可证接管）   （续期 / 更新接管）
```

## 核心模块

| 模块 | 职责 |
|------|------|
| `src/hack.ts` | CLI 入口。参数解析、步骤编排、启动验收、失败回滚、输出报告。 |
| `src/typora.ts` | 定位安装目录（多来源候选：`--dir` / 注册表 App Paths 与文件关联 / PATH / 默认目录 / 卸载表 / 全盘浅扫描，命中即止）；检测与结束 Typora 进程；启动 Typora；把备份 / 成品写进安装目录（不可写时只对这一步用一次 UAC 提权）。 |
| `src/asar.ts` | `app.asar` 的解包 / 打包 / 读单文件，以及从包内 `package.json` 读 `main`。 |
| `src/patch.ts` | 补丁模板的加载与占位符渲染；把补丁注入到入口文件最前面；定义注册表值格式。 |
| `src/inject/patch.js` | 真正写进 Typora 的代码：自校验放行（读取层 + 哈希层）、许可证接管、续期/更新接管。ES5 语法。 |
| `src/config.ts` | 邮箱与序列号的可自定义项：默认值、`.env` 解析、来源优先级。 |
| `src/registry.ts` | `HKCU\SOFTWARE\Typora` 的读写（`execFile` 调 `reg.exe`，不过 shell）。 |

## 模块关系

- `hack.ts` 是唯一有副作用的编排者，其余模块都是工具。
- `patch.ts` 同时定义「补丁长什么样」和「自校验量怎么算」，是注入能否成功的关键；
  `inject/patch.js` 只负责运行时行为，两边的契约是 7 个占位符。
- `patch.ts` 与 `inject/patch.js` 必须成对修改：模板里少一个占位符，`loadTemplate()` 会直接报错。
- `config.ts` 的值只经由 `patch.ts` 的占位符流入补丁，不参与任何判定。

## 数据流

1. **读原始状态**：`hack` 从 `app.asar.hapora-orig.bak` 取 `package.json` → `main` → 该入口文件的原文
   （若备份不存在，则从当前 `app.asar` 剥掉补丁）。
2. **算自校验量**：对入口原文算 `sha256`，并把原文本身编成 base64 备用。
3. **渲染并注入**：替换占位符，插到入口文件 `"use strict"` 之后的**最前面**；
   量出注入后的字节长度，回填到定宽的 8 位长度占位符（回填不改变文件长度）。
4. **打包**：解包整个 asar 到用户临时目录 → 写入新的入口文件 → 重新打包成一份成品 `app.asar`（仍在临时目录里）。
5. **落盘**：`installFiles()` 把「备份（如需）」与「成品」写进安装目录。目录可写就直接复制；
   不可写（`%ProgramFiles%`）就用一次 UAC 提权，由一个临时 `.cmd` 批量完成这两次复制。
6. **写注册表**：`SLicense = base64("@@HAPORA_LICENSE@@") + "#0#" + M/D/YYYY`，`IDate = M/D/YYYY`。
7. **验收**：启动 Typora，只读最后一次启动的日志片段，等过启动 ~1s 的自校验窗口；
   命中 `hasL: true` 且无致命信号判成功；命中 `Integrity check failed` / `unfill due to renew fail`
   判「补丁导致的失败」→ 自动回滚 + 清注册表。

## 外部系统

| 外部系统 | 交互方式 | 说明 |
|----------|----------|------|
| Typora 安装目录 | 直接改文件 | `app.asar` 被整体替换，原始文件留在同目录的 `.hapora-orig.bak`；装到系统目录时这一步需要一次 UAC 提权 |
| Windows 注册表 | `reg.exe` | 只写 `HKCU\SOFTWARE\Typora` 下的 `SLicense` / `IDate`（用户级，永不需要提权） |
| Typora 自身日志 | 只读 | `%APPDATA%\Typora\typora.log`，用于验收 |
| 网络 | **不交互** | 补丁在进程内截断对许可证服务端与更新端点的请求，不出网 |

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
- **管理员权限只用于「往安装目录写文件」**：解包、注入、打包、写注册表、启动 Typora、读日志全都不需要提权；
  提权只发生在 `installFiles()` 里，且是「备份 + 成品」一次性完成的一次 UAC。详见 ADR-008。
- **定位不是「只认三个默认目录」**：按成本从低到高汇集候选（显式指定 → 注册表 App Paths/文件关联 →
  PATH → 默认目录 → 卸载表 → 全盘浅扫描），命中即止，每个候选都以「目录下有 `resources\app.asar`」为准。
  详见 ADR-009。
- **失败要响且要可逆**：补丁自检（占位符数量、长度回填、入口存在）任何一项不满足都直接抛错；
  启动验收把「不兼容」翻译成一次自动回滚，而不是留下一个启动即退的坏包。
