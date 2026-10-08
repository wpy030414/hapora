# AGENTS.md

本仓库是对 Typora 激活机制的逆向研究与激活工具，入口只有一个：`pnpm hack`。
支持 Windows / macOS（arm64）/ 桌面 Linux；三个平台均已完整实现——Windows、macOS（arm64）、
Linux（Ubuntu 26.04 / Typora 1.14.9，WSL2）均有真机验收，Fedora / Arch 与 Flatpak 形态机制同构、待真机验收。

## 概述

- 本项目是什么：三份逆向研究报告（`docs/researches/`）+ 一个激活脚本（`src/`）。
- 交付物：`pnpm hack` 让本机 Typora 进入已激活状态；`pnpm hack --restore` 回滚。
- **两个平台是两类被改对象**：Windows/Linux 的 Typora 是 Electron 应用（改 asar 注入补丁）；
  macOS 的是原生 AppKit+WebKit 应用（无 asar，改 Mach-O 二进制短路 `renew` 并 ad-hoc 重签，
  再伪造 `~/Library` 下的许可证记录文件——见 ADR-012）。

## 边界与范围

- 范围内：
  - 定位 Typora 安装（含非默认位置），备份与恢复被改对象（asar / Mach-O 二进制 + 签名 / 许可证记录文件）。
  - asar 路线（Windows/Linux）：从包内 `package.json` 的 `main` 读出入口文件，生成并注入补丁源码。
  - Mach-O 路线（macOS，ADR-012）：运行时解析符号表定位 `-[LicenseManager renew]` 的 IMP，
    等长写入 `ret` 短路续期；ad-hoc 重签（entitlements 原样保留 + 追加
    `disable-library-validation`）；按原生格式伪造 AES 加密的许可证记录文件（lastTry 金丝雀）。
  - 写入许可证：Windows 为 `HKCU\SOFTWARE\Typora` 下的 `SLicense` / `IDate`。
  - 启动 Typora 并按平台验收（Windows 读 `typora.log`；macOS 轮询记录状态）；失败且可归因时自动回滚。
  - 从 `.env` 读取可自定义的邮箱与序列号。
  - 平台差异（定位 / 进程 / 启动 / 验收探针 / 提权 / 许可证存储）由 `src/platform/` 承担。
- 非目标（明确排除）：
  - 不搭建本地许可证网关、不改 hosts、不替换 DNS。
  - 不修改 V8 字节码（`.jsc`）——asar 路线的改动都落在明文入口上。
  - 不做「跨重启/跨升级自动保活」：macOS 手动升级 Typora 后补丁即失效（重跑 `pnpm hack` 恢复，
    备份状态机会自动刷新备份）；不为此引入常驻组件。
  - 不支持 AppImage（只读 squashfs 镜像）、移动端与 Windows 以外的非桌面发行版。
  - 不做通用「逆向框架」或 GUI。

## Agent 操作指南

- 如何理解本项目：先读 `docs/researches/activation-win.md`（Windows）与
  `docs/researches/activation-mac.md`（macOS）、`docs/researches/activation-linux.md`（Linux）
  了解被改对象的机制，再读 `docs/ARCHITECTURE.md` 了解本仓库如何落刀。
- 全局规则 / 约定：
  - **禁止硬编码 Typora 的文件名与版本相关常量**：asar 路线的入口名一律走 `package.json` 的 `main`，
    macOS 的 bundle id / 可执行名走 `Info.plist`，自校验基准与长度在打包时现算，
    许可证字段值走 `src/config.ts`；macOS 记录文件名由本机 `IOPlatformUUID` 派生。
  - `src/inject/patch.js` 是被注入到 Typora 里的源码，**保持 ES5 语法**（它跑在 Typora 的模块作用域里），
    只允许在其中使用 `__HAPORA_*__` 形式的占位符，且每个占位符全文件只出现一次。
  - 自校验放行必须**同时保留读取层（fs）与哈希层（crypto.createHash）**：
    两层各自都足以单独通过校验，互为兜底。
  - 伪造载荷里的 `fingerprint`（Windows/Linux）**必须逐字符等于客户端自己算的那一份**，即
    `Base64(SHA256(machineId + "typora"))[0..10].replace(/[/=+-]/g, "a")`——Windows 的 `machineId`
    是 `MachineGuid`，Linux 是 `/etc/machine-id`（回退 `/var/lib/dbus/machine-id`）；
    末尾那次替换不能省，否则补丁会在一半的机器上静默失效（现象是「装了补丁但没激活」且无任何报错）。
  - **Linux 许可证文件的编码有两条硬约束**（`src/platform/linux.ts`）：文件落在
    `~/.config/Typora/<指纹>`（文件名即上面的 fingerprint），内容是**整段 JSON 的十六进制编码**
    （同 `profile.data`），且只有 `SLicense` 一个键（无 `IDate`，日期并入 `SLicense` 尾段
    `base64#0#M/D/YYYY`）。踩错编码（写成裸 JSON）时 Typora 读不出 `SLicense`，日志恒 `no info`
    + `hasL: false` 且**无任何报错**——与「改了却没激活」的半成品现象完全一致。读写都必须先解/编 hex。
    Linux 版直接复用 Windows 的 LocalStore（日志类名仍是 `[WindowsLicenseLocalStore]`），
    激活链路（`publicDecrypt` 接管、`electron.net` 续期接管、fs/createHash 自校验放行）与 Windows 逐字一致，
    `patch.js` 无需为 Linux 特化（续期请求里的 `v` 由 Typora 自己按 `process.platform` 现算）。
  - **macOS 记录文件的编码有两条硬约束**（`src/platform/darwin-license.ts`）：binary plist 的
    int marker 低 4 位是 log2(字节数)（4 字节是 `0x12` 不是 `0x13`）；`NS.time` 必须 real 编码。
    踩错时 `NSKeyedUnarchiver` **静默返回 nil**（现象是「伪造被无视、状态未激活」且无报错）——
    验证必须以 `NSKeyedUnarchiver` 为准，`plistlib` 会放过这两种错。
  - **Mach-O 补丁（`src/platform/darwin-macho.ts`）的硬规则**（ADR-012）：
    - 唯一允许的 Typora 字面量 = `MACHO_TARGETS` 里的选择器符号名与各 CPU 的 ret 编码，
      **禁止出现任何指令偏移 / vm 地址常量**——一律运行时解析符号表定位（含性映射，不按段名）；
    - 只允许**等长补丁**（首指令换 ret），任何会改变文件长度的方案都不做；
    - entitlements **原样保留、只追加 `disable-library-validation`**，且必须 `plutil -lint`
      把关；entitlements 只信 `codesign -d` 导出，不解析二进制内的 DER blob；
    - **重签会重排胖文件布局**：一切字节复核 / 幂等判定 / `--status` 检查都必须对重签后的
      磁盘文件重新解析定位，**绝不缓存偏移**（manifest 里的偏移仅作诊断，身份只认 sha256）；
    - 安装 staged 二进制后必须显式 `chmod` 回原执行位（`copyFileSync` 沿用源 mode，
      staged 文件无执行位——此坑真机踩过，现象是 `spawn EACCES`）；
    - 二进制备份在**包外**（`<app>.hapora-orig.bak/`：二进制 + CodeResources +
      entitlements + manifest）；还原 = 字节等价拷回（Developer ID 签名自愈，无需再签）；
      `--restore` 后必须能验证回 `Authority=Developer ID Application`。
  - **管理员权限只允许用在「往安装目录写文件」这一步（asar / Mach-O 路线）**：解包 / 注入 /
    打包 / 补丁生成 / entitlements 准备 / 写许可证 / 启动 Typora / 读日志都必须在普通权限下完成；
    提权是「备份 + 成品 + 重签」一次性完成的一次提权（Windows 一次 UAC，Unix 一次 `sudo -n`），
    不许把整个 CLI 提权重跑。macOS 的记录备份永远走用户态（~/Library 恒可写，
    混入 sudo 批次会被 chown 成 root）。
  - **平台差异只允许出现在 `src/platform/`**：定位 / 进程 / 启动 / 验收探针 / 提权 / 许可证存储
    这几件事，其余逻辑必须平台无关；`src/hack.ts` 里按**能力位**（`asarPatchSupported` /
    `machoPatchSupported`）分支，不得出现平台名判断。`src/registry.ts` 只许 Windows 实现使用。
  - **未实现的平台能力必须显式失败**：不得「猜一个位置写进去」——尤其许可证存储，
    猜错会产出「改了却没激活」且无任何报错的状态。宁可在改动文件之前退出。
  - `sudo` 只允许用 `-n`（非交互），绝不能出现会等待输入密码的形式（会挂住 CLI）。
  - 被改对象必须先备份再改写；任何时候都要保证 `--restore` 可用。
  - 修改补丁 / 伪造逻辑后必须跑一次 `pnpm hack --yes` 验收：
    Windows / Linux（asar 路线）的判据是日志中同时满足 `[watch L] hasL: true`、`[renewLicense]: license renewed`，
    且启动 1s 后**没有** `Integrity check failed`、没有 `onUnfillLicense`、进程不退出
    （日志路径：Windows `%APPDATA%\Typora\typora.log`，Linux `~/.config/Typora/typora.log`）；
    macOS 的判据是验收探针报「许可证记录保持有效……Typora 存活」（记录被 unfill 清除即失败），
    且 `lastTry` 金丝雀在续期窗口之外——窗口外记录存活本身就是 renew 已被短路的自证。
  - 文档更新遵循 `scaffold-docs`：README / AGENTS 不写实现细节，实现细节进 `docs/`。
  - **仓库内不得携带任何截图或二进制图片**（`*.png` / `*.jpg` / `*.gif` / `*.webp` / `*.bmp` 等）。
    需要留证的场景一律写成可复现的文字判据（日志关键字、命令、期望输出），由验收过程现场产生。

## 目录速查

- `src/hack.ts` — CLI 入口，编排定位 → 备份 → （asar 路线：注入/打包/落盘；Mach-O 路线：
  二进制补丁/ad-hoc 重签）→ 写许可证 → 验收/回滚。按能力位分支，不含平台名判断。
- `src/typora.ts` — 平台无关门面，把语义动作转给当前平台实现。
- `src/platform/` — 平台层：`index.ts`（选择）、`types.ts`（契约与公共工具）、`scan.ts`（浅扫描）、
  `unix.ts`（Unix 公共部分）、`windows.ts` / `darwin.ts` / `linux.ts`（各平台实现）、
  `darwin-license.ts`（macOS 许可证记录文件的编解码与伪造）、`darwin-macho.ts`
  （Mach-O 解析 / ret 补丁 / entitlements 与重签 / 备份事务，darwin 私有）。
- `src/patch.ts` — 补丁模板的加载、占位符渲染、注入与剥除；Windows 许可证值的格式定义。
- `src/inject/patch.js` — 真正被注入到 Typora 入口文件的代码（仅 asar 路线）。
- `src/config.ts` — 邮箱 / 序列号的可自定义项，来源优先级与默认值。
- `src/asar.ts` — `app.asar` 解包 / 打包 / 读单文件 / 读 `main`（仅 asar 路线）。
- `src/registry.ts` — `HKCU\SOFTWARE\Typora` 读写 + 通用只读查询（仅 Windows 实现使用）。
- `.env.example` — 可自定义项的模板（`.env` 本身不入库）。
- `docs/researches/activation-win.md` — Windows（Electron）机制研究报告。
- `docs/researches/activation-mac.md` — macOS（原生）机制研究报告。
- `docs/researches/activation-linux.md` — Linux（Electron）机制研究报告。
- `docs/PRD.md` / `docs/ARCHITECTURE.md` / `docs/DECISIONS.md` — 产品目标、结构、决策记录。
- `docs/specs/` — 各模块的行为规格（含可复现的验收判据）。
