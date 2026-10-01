# AGENTS.md

本仓库是对 Typora 激活机制的逆向研究与激活工具，入口只有一个：`pnpm hack`。
支持 Windows / macOS（arm64）/ 桌面 Linux；**Windows 与 macOS 已完整实现（均有真机验收）**，
桌面 Linux（Electron 版）的许可证存储尚无实证结论，会在改动任何文件之前显式失败（见 ADR-010）。

## 概述

- 本项目是什么：两份逆向研究报告（`docs/researches/`）+ 一个激活脚本（`src/`）。
- 交付物：`pnpm hack` 让本机 Typora 进入已激活状态；`pnpm hack --restore` 回滚。
- **两个平台是两类被改对象**：Windows/Linux 的 Typora 是 Electron 应用（改 asar 注入补丁）；
  macOS 的是原生 AppKit+WebKit 应用（无 asar、无注入点，只伪造 `~/Library` 下的许可证记录文件）。

## 边界与范围

- 范围内：
  - 定位 Typora 安装（含非默认位置），备份与恢复被改对象（asar / 许可证记录文件）。
  - asar 路线（Windows/Linux）：从包内 `package.json` 的 `main` 读出入口文件，生成并注入补丁源码。
  - 记录路线（macOS）：按原生格式生成 AES 加密的许可证记录文件（见 `docs/researches/activation-mac.md`）。
  - 写入许可证：Windows 为 `HKCU\SOFTWARE\Typora` 下的 `SLicense` / `IDate`。
  - 启动 Typora 并按平台验收（Windows 读 `typora.log`；macOS 轮询记录状态）；失败且可归因时自动回滚。
  - 从 `.env` 读取可自定义的邮箱与序列号。
  - 平台差异（定位 / 进程 / 启动 / 验收探针 / 提权 / 许可证存储）由 `src/platform/` 承担。
- 非目标（明确排除）：
  - 不搭建本地许可证网关、不改 hosts、不替换 DNS。
  - 不修改 V8 字节码（`.jsc`）——asar 路线的改动都落在明文入口上。
  - 不改动 macOS 的 `/Applications/Typora.app`（代码签名 + hardened runtime + Sealed Resources；
    记录路线完全不需要碰它）。
  - 不支持 AppImage（只读 squashfs 镜像）、移动端与 Windows 以外的非桌面发行版。
  - 不做通用「逆向框架」或 GUI。

## Agent 操作指南

- 如何理解本项目：先读 `docs/researches/activation-mechanism.md`（Windows）与
  `docs/researches/activation-mac.md`（macOS）了解被改对象的机制，再读 `docs/ARCHITECTURE.md`
  了解本仓库如何落刀。
- 全局规则 / 约定：
  - **禁止硬编码 Typora 的文件名与版本相关常量**：asar 路线的入口名一律走 `package.json` 的 `main`，
    macOS 的 bundle id / 可执行名走 `Info.plist`，自校验基准与长度在打包时现算，
    许可证字段值走 `src/config.ts`；macOS 记录文件名由本机 `IOPlatformUUID` 派生。
  - `src/inject/patch.js` 是被注入到 Typora 里的源码，**保持 ES5 语法**（它跑在 Typora 的模块作用域里），
    只允许在其中使用 `__HAPORA_*__` 形式的占位符，且每个占位符全文件只出现一次。
  - 自校验放行必须**同时保留读取层（fs）与哈希层（crypto.createHash）**：
    两层各自都足以单独通过校验，互为兜底。
  - 伪造载荷里的 `fingerprint`（Windows）**必须逐字符等于客户端自己算的那一份**，即
    `Base64(SHA256(MachineGuid + "typora"))[0..10].replace(/[/=+-]/g, "a")`——
    末尾那次替换不能省，否则补丁会在一半的机器上静默失效（现象是「装了补丁但没激活」且无任何报错）。
  - **macOS 记录文件的编码有两条硬约束**（`src/platform/darwin-license.ts`）：binary plist 的
    int marker 低 4 位是 log2(字节数)（4 字节是 `0x12` 不是 `0x13`）；`NS.time` 必须 real 编码。
    踩错时 `NSKeyedUnarchiver` **静默返回 nil**（现象是「伪造被无视、状态未激活」且无报错）——
    验证必须以 `NSKeyedUnarchiver` 为准，`plistlib` 会放过这两种错。
  - **管理员权限只允许用在「往安装目录写文件」这一步（asar 路线）**：解包 / 注入 / 打包 / 写许可证 /
    启动 Typora / 读日志都必须在普通权限下完成；提权是「备份 + 成品」一次性完成的一次提权
    （Windows 一次 UAC，Linux 一次 `sudo -n`），不许把整个 CLI 提权重跑。
    macOS 记录路线**不需要任何提权**（只写用户目录）。
  - **平台差异只允许出现在 `src/platform/`**：定位 / 进程 / 启动 / 验收探针 / 提权 / 许可证存储
    这几件事，其余逻辑必须平台无关；`src/hack.ts` 里按**能力位**（`asarPatchSupported`）分支，
    不得出现平台名判断。`src/registry.ts` 只许 Windows 实现使用。
  - **未实现的平台能力必须显式失败**：不得「猜一个位置写进去」——尤其许可证存储，
    猜错会产出「改了却没激活」且无任何报错的状态。宁可在改动文件之前退出。
  - `sudo` 只允许用 `-n`（非交互），绝不能出现会等待输入密码的形式（会挂住 CLI）。
  - 被改对象必须先备份再改写；任何时候都要保证 `--restore` 可用。
  - 修改补丁 / 伪造逻辑后必须跑一次 `pnpm hack --yes` 验收：
    Windows 的判据是日志中同时满足 `[watch L] hasL: true`、`[renewLicense]: license renewed`，
    且启动 1s 后**没有** `Integrity check failed`、没有 `onUnfillLicense`、进程不退出；
    macOS 的判据是验收探针报「许可证记录保持有效……Typora 存活」（记录被 unfill 清除即失败）。
  - 文档更新遵循 `scaffold-docs`：README / AGENTS 不写实现细节，实现细节进 `docs/`。
  - **仓库内不得携带任何截图或二进制图片**（`*.png` / `*.jpg` / `*.gif` / `*.webp` / `*.bmp` 等）。
    需要留证的场景一律写成可复现的文字判据（日志关键字、命令、期望输出），由验收过程现场产生。

## 目录速查

- `src/hack.ts` — CLI 入口，编排定位 → 备份 → （asar 路线：注入/打包/落盘）→ 写许可证 → 验收/回滚。
  按能力位分支，不含平台名判断。
- `src/typora.ts` — 平台无关门面，把语义动作转给当前平台实现。
- `src/platform/` — 平台层：`index.ts`（选择）、`types.ts`（契约与公共工具）、`scan.ts`（浅扫描）、
  `unix.ts`（Unix 公共部分）、`windows.ts` / `darwin.ts` / `linux.ts`（各平台实现）、
  `darwin-license.ts`（macOS 许可证记录文件的编解码与伪造，darwin 私有）。
- `src/patch.ts` — 补丁模板的加载、占位符渲染、注入与剥除；Windows 许可证值的格式定义。
- `src/inject/patch.js` — 真正被注入到 Typora 入口文件的代码（仅 asar 路线）。
- `src/config.ts` — 邮箱 / 序列号的可自定义项，来源优先级与默认值。
- `src/asar.ts` — `app.asar` 解包 / 打包 / 读单文件 / 读 `main`（仅 asar 路线）。
- `src/registry.ts` — `HKCU\SOFTWARE\Typora` 读写 + 通用只读查询（仅 Windows 实现使用）。
- `.env.example` — 可自定义项的模板（`.env` 本身不入库）。
- `docs/researches/activation-mechanism.md` — Windows（Electron）机制研究报告。
- `docs/researches/activation-mac.md` — macOS（原生）机制研究报告。
- `docs/PRD.md` / `docs/ARCHITECTURE.md` / `docs/DECISIONS.md` — 产品目标、结构、决策记录。
- `docs/specs/` — 各模块的行为规格（含可复现的验收判据）。
