# Spec — 平台抽象层（`src/platform/`）

## 要构建什么

- 目标：把「随操作系统变化的事」从编排逻辑里分离出来，让 `src/hack.ts` 只表达语义动作与能力位分支，
  同一套 CLI 能在 Windows / macOS / 桌面 Linux 上复用。
- 平台是两类被改对象的承载方：**asar 路线**（Windows/Linux 的 Electron 应用，注入补丁）
  与**记录路线**（macOS 的原生应用，伪造许可证记录文件）。见 ADR-010、ADR-011。

## 职责边界

补丁本身（`publicDecrypt` hook、`electron.net` 拦截、fs/crypto 自校验放行）只属于 asar 路线；
真正随平台变化的是这些：

| # | 事项 | Windows | macOS | Linux |
|---|------|---------|-------|-------|
| 1 | 定位安装目录 | 注册表 / PATH / 盘符浅扫描 | Spotlight(`mdfind`) + `/Applications`、`~/Applications` | `which typora` + `/usr/share/typora` 等 + Flatpak/Snap |
| 2 | 安装根目录的形态 | 目录（含 `resources/app.asar`） | `.app` 包（bundle id 与可执行名读自 Info.plist） | 目录（含 `resources/app.asar`） |
| 3 | 进程检测 / 结束 | `tasklist` / `taskkill` | `pgrep -x` / `pkill -x` | 同 macOS |
| 4 | 启动 | `<dir>\Typora.exe` | `<app>/Contents/MacOS/<CFBundleExecutable>` | `<dir>/Typora` |
| 5 | 被改写的目标（`target`） | `resources/app.asar` | `~/Library/Application Support/<bundle id>/.<指纹>` | `resources/app.asar` |
| 6 | 写入提权 | 一次 UAC | **不需要**（只写用户目录） | `sudo -n` |
| 7 | 许可证存储 | `HKCU\SOFTWARE\Typora` 的 `SLicense`/`IDate` | AES 加密的 keyed archive 记录文件 | **未实现**（抛错，见 ADR-010） |
| 8 | 启动验收探针 | 读 `typora.log` 关键字 | 轮询记录文件是否仍带激活键 + 进程存活 | 无（恒 pending，由超时兜底） |
| 9 | `asarPatchSupported` | `true` | **`false`** | `true` |

macOS 没有可用的验收日志：既不存在 `typora.log`，unified log 在启动路径也没有输出（已实测）。

## 行为

- `locate(overrideDir?)`：显式指定优先，无效即报错不回退；其余来源惰性求值、命中即止，
  每个候选以**平台自己的结构判据**为准（Windows/Linux：存在 `resources/app.asar`；
  macOS：`.app` 包内存在 `Contents/Info.plist` 与 `Contents/MacOS`）。
- `installFiles(jobs, { elevate })`：可写就直接复制；被拒或 `elevate=true` 时走平台提权。
  Unix 用 `sudo -n`（**非交互**），需要密码时立刻失败而不是挂住等待输入。
- `writeLicense({ email, licenseCode, now })`：Windows 写注册表；macOS 生成并加密写入伪造记录；
  Linux **抛错**（见 ADR-010）。
- `clearLicense()`：清空许可证。macOS 是 no-op（伪造与备份是同一个文件，`--restore` 的备份还原
  即清除伪造）；Linux（未实现存储）同样是 no-op —— `--restore` 在任何平台都必须可用。
- `readLicense()`：供 `--status` 展示。Windows 返回 `SLicense`/`IDate`；macOS 返回
  「已激活（邮箱）/ 未激活」与安装日期。
- `probeActivation(install, launchedAtMs)`：验收探针，返回
  `activated | lost | gone | pending`。Windows 读日志关键字（`lost` 携日志路径）；
  macOS 解密记录文件判 `email`/`license` 键是否仍在（`lost` 即发生了 unfill），并查进程存活。

## 约束

- 平台实现的失败必须显式：不得「猜一个位置写进去」，也不得静默降级成「改了却没激活」。
- `sudo` 绝不使用会等待密码的形式（会挂住 CLI）。
- 浅扫描必须同时设「深度上限」与「目录数上限」，并跳过系统/噪声目录。
- 平台差异（含能力位与探针）只允许出现在本层；`hack.ts` 按能力位分支，不出现平台名。
- 新增平台 = 加一个 `src/platform/<id>.ts` 与 `index.ts` 里的一行分支，不改 `hack.ts` 的编排结构。

## 验收标准

- [x] `scanRootsForInstall` 对平台结构判据（asar 路径 / `.app` 包）都能扫到：深度上限内命中、超出深度或结构不符的不命中。
- [x] macOS `locate` 接受 `.app`、`Contents`、`Contents/Resources`、`Contents/MacOS` 四种形态并归一到同一个 `.app`。
- [x] 各平台 `locate` 无效路径返回 null 并给出形态提示。
- [x] Linux 的 `writeLicense` 抛错、`clearLicense` 不抛、`readLicense` 返回 null。
- [x] **（2026-10-01 真机）** macOS arm64（Typora 1.14.5-dev）上 `pnpm hack --yes` 定位、伪造记录并激活成功：
  验收探针报「许可证记录保持有效（email/license 键完整），Typora 存活」；`--restore` 可完整还原；
  重复执行幂等（沿用已有备份）。
- [x] **（2026-10-01 真机）** macOS 记录文件生成物以 `NSKeyedUnarchiver` 独立验证可解出
  `email`(String) / `license`(String) / `installDate`(NSDate) / `lastTry`(NSDate)。
- [ ] **（待真机）** Linux（Ubuntu/Fedora/Arch）上定位、改写与激活。
- [ ] **（待确认）** Linux 的许可证存储位置，据实测结论补上 `writeLicense`。
