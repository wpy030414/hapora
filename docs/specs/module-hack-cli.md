# Spec — hack CLI（`src/hack.ts` + `src/config.ts`）

## 要构建什么

- 目标：`pnpm hack` 一条命令把 Typora 变成已激活状态；同一入口提供回滚、状态与自动验收，
  并在版本不兼容时自动回滚，不留坏包。

## 行为

- 无参数执行（按平台能力位 `asarPatchSupported` / `machoPatchSupported` 分流）：
  - **asar 路线（Windows/Linux）**：备份 → 取入口原文 → 注入 → 重新打包 → 写许可证 → 启动验收 → 报告；
  - **Mach-O 路线（macOS，ADR-012）**：备份许可证记录（用户态）→ 二进制补丁 + ad-hoc 重签（事务化）→
    伪造记录（`lastTry` 金丝雀 = −48h，续期窗口外）→ 启动验收 → 报告。首次改包可能触发一次
    TCC「App Management」授权弹窗（属预期交互）。
- 安装目录不可写时（典型是 `%ProgramFiles%\Typora` / `/usr/share/typora` / root 属主的 `.app`）：
  解包 / 注入 / 打包 / 补丁生成 / entitlements 准备全部在用户临时目录里完成，最后用**一次**平台提权把
  「备份 + 成品（+ Mach-O 路线的重签）」落盘，其余步骤（写许可证、启动 Typora、读验收信号）仍以
  普通用户身份进行。目录可写时不提权。
- `--dir <路径>`：显式指定 Typora 安装根目录。指向的路径不符合平台结构（没有 `resources\app.asar` /
  不是 `.app` 包）时**直接报错退出**，不回退到自动探测（显式指定必须被尊重，静默猜别处比报错更糟）。
- `--no-verify`：跳过启动验收（仍然改写），并在输出中提示跳过的风险。
- `--restore`：把被改对象从备份拷回（asar / Mach-O 二进制 + CodeResources 字节等价拷回 ⇒
  Developer ID 签名自愈 / 许可证记录），并清空许可证记录。二进制还原与记录还原分开走
  （记录文件必须保持用户属主，不混入提权批次）。
- `--status`：只读打印安装路径、目标文件、备份、状态（asar 路线：入口名与是否已注入、`SLicense`/`IDate`；
  Mach-O 路线：二进制补丁状态 / 签名形态（ad-hoc 或 Developer ID）/ 二进制备份、许可证是否已激活、
  安装日期）、以及生效的邮箱/序列号。
- `--yes` / `-y`：跳过「Typora 正在运行」的确认。
- `--help` / `-h`：打印用法。
- 幂等：重复执行不重复备份（记录备份始终指向最早的原始记录；二进制备份按哈希判定
  kept/refreshed，已补丁且签名完好时报「已打过补丁，跳过」零写入）；Typora 被重装/升级后备份自动刷新。
- 配置：邮箱与序列号来自 `环境变量 > 仓库根目录 .env > src/config.ts 的默认值`。

## 输入 / 输出

- 输入：
  - 命令行标志；
  - Typora 的 `app.asar`。它可能装在任意位置（D 盘、绿色版目录、`.app` 包等），
    定位规则按「便宜 → 昂贵、命中即止」组织，**每个候选都以该目录下存在平台对应的 asar 路径为准**：
    1. 显式指定：`--dir <路径>` 或环境变量 `HAPORA_TYPORA_DIR`（无效即报错，不回退）
    2. 平台自带的索引：Windows 注册表（`App Paths` / 文件关联 / 卸载表）、macOS Spotlight（`mdfind`）、
       Linux `which typora`
    3. PATH
    4. 平台常见默认目录
    5. 浅扫描：平台相关的一组根目录 + 常见子目录，再退化为有深度与目录数上限的遍历
    各平台的具体候选见 spec `module-platform.md`。
  - （及其同目录备份）；
  - 模板文件 `src/inject/patch.js`（仅 asar 路线）；
  - 可选的 `<repo>/.env`。
- 输出（按平台能力位 `asarPatchSupported` / `machoPatchSupported` 分流）：
  - **asar 路线（Windows/Linux）**：覆盖后的 `app.asar`；首次执行时产生的
    `app.asar.hapora-orig.bak`；许可证记录写注册表 `HKCU\SOFTWARE\Typora` 的 `SLicense` / `IDate`；
    验收时启动 Typora 进程并读取 `%APPDATA%\Typora\typora.log`。
  - **Mach-O 路线（macOS）**：ret 补丁后的 `Contents/MacOS/<可执行>`（等长替换、ad-hoc 重签、
    entitlements 原样保留 + 追加 disable-library-validation）；包外
    `<.app>.hapora-orig.bak/`（原始二进制 + CodeResources + entitlements + manifest）；
    覆盖 `~/Library/Application Support/<bundle id>/.<指纹>` 并留同名 `.hapora-orig.bak` 备份
    （`lastTry` = −48h 金丝雀）；验收轮询记录状态与进程存活。
  - Linux 的许可证存储尚无实证结论，在改动任何文件之前直接失败（见 ADR-010）。
  - stdout 的步骤报告。

## 约束

- 任何写操作之前必须先有可用的备份。
- 支持的平台：Windows / macOS / 桌面 Linux。不支持的平台以非零码退出，不做降级。
- 平台差异（定位 / 进程 / 启动 / 验收探针 / 提权 / 许可证存储）全部由 `src/platform/` 提供，
  本入口只按**能力位**（`asarPatchSupported` / `machoPatchSupported`）分支，不得出现平台名判断。
- 许可证存储未实现的平台（当前是 Linux）：**在改动任何文件之前**以非零码退出并说明原因，
  不得产出「改了却没激活」的半成品。`--status` 与 `--restore` 不受此限。
- **只有「往安装目录写文件」这一步可能需要管理员（asar 与 Mach-O 路线）**：不得因为要提权就把
  整个 CLI 重跑一遍，也不得以管理员身份去启动 Typora 或读验收信号。macOS 的记录备份永远走用户态。
- 提权必须是一次性的批量动作（备份与成品在同一次 UAC / `sudo -n` 里完成，Mach-O 路线含重签），
  不能弹两次。
- 提权被拒（用户在 UAC 里点「否」）→ 非零码退出并说明「什么都没写」。
- 找到 Typora、读包、注入、打包这些步骤不得要求任何额外权限。
- 找不到 Typora 安装、或包内 `package.json` 没有 `main`，以非零码退出；
  定位失败时必须列出**已尝试的来源**，并提示用 `--dir` / `HAPORA_TYPORA_DIR` 显式指定。
- 临时工作目录必须在 `finally` 中清理，失败路径不留残渣。
- 仅当失败**可归因于补丁**时才回滚；环境性的失败（例如根本没等到日志）保留补丁并提示。
- 序列号形状不符只警告，不阻断。

## 边界条件

- Typora 正在运行：无 `--yes` 时提示后退出（非零码）；有 `--yes` 时结束进程，等待 1.5s 再继续。
- `--status` 只读，任何情况下都不提权、不弹 UAC。
- 目录可写（用户级安装）→ 直接复制，不得出现 UAC 弹窗。
- 目录不可写且当前进程已是管理员 → 不弹 UAC，直接报「已提权仍写不进去」并退出。
- 提权后的复制若因文件被占用等原因失败 → 报错并指出目标可能被占用，不能静默成功。
- 备份已存在且其中已是打过补丁的入口：视为异常，直接报错，不产出坏包。
- 备份不存在但当前 `app.asar` 已被打过补丁：先剥离补丁得到原始内容，再重新注入。
- 备份记录的是另一个入口名（换过版本）：刷新备份。
- 显式指定的目录里没有 `resources\app.asar`：非零码退出并说明原因，**不**回退到自动探测。
- 定位是惰性的：某个来源命中后，其后的来源（尤其是全盘扫描）不得被执行。
- 查询不存在的注册表键是常态，`reg.exe` 的报错不得泄漏到用户终端（`stdio.stderr` 需静默）。
- 中文 Windows 上 `reg query /ve` 的默认值标签是 `(默认)` 而非 `(Default)`：解析默认值不得依赖标签文案。
- 注入后的长度回填导致字节数变化：报错，不打包。
- **[Windows] 验收判定必须晚于启动 ~1s 的自校验窗口**：`hasL: true` 在 ~0.1s 出现，
  自校验在 ~1s 才跑完，仅凭 `hasL` 提前宣判会误报成功。
- **[Windows] 验收只能读最后一次启动的日志片段**：`typora.log` 会轮转，按文件长度切片会读到上一次运行的内容。
- **[macOS] 验收以记录文件状态为准**：unfill 会把记录清写成只剩 `installDate`（可观测的失败信号），
  过了 settle 窗口仍带 `email`/`license` 键且进程存活才算成功；`--restore` 后必须还原到 hack 前的原始记录。
  记录的 `lastTry` 是 **−48h 金丝雀（续期窗口外）**——窗口外记录存活本身就是 `renew` 已被二进制补丁
  短路的自证；补丁因升级失效时，下一次启动**立刻可见地** unfill（而非 10 小时后静默过期）。
- 验收失败且命中致命信号（Windows：`Integrity check failed` / `unfill due to renew fail`；
  macOS：记录被 unfill 清除或进程退出）：判为本次改动不兼容 → 自动回滚（macOS 额外还原
  二进制 + CodeResources，字节等价 ⇒ Developer ID 签名自愈）+ 清许可证。
- 40s 内既无激活信号也无致命信号：判为无法判定，改动保留并提示手动观察。

## 验收标准

- [x] 在干净的 Typora `1.14.10` 上执行 `pnpm hack --yes`，输出 `✓ 激活成功：…（自校验后仍存活）`。
- [x] **安装在 `%ProgramFiles%\Typora`（非管理员终端）** 时执行 `pnpm hack --yes`：只弹一次 UAC，
      同样输出 `✓ 激活成功`，且 `app.asar` 的写入时间被更新。
- [x] 同一次提权里同时写入备份与成品（`--status`/日志可见只发生一次提权）。
- [x] 执行后 `typora.log` 中同时出现 `[L] pass`、`[watch L] hasL: true`、`[renewLicense]: license renewed`，
      且不出现 `Integrity check failed` 与 `onUnfillLicense`，进程不退出。
- [x] Typora 主窗口持续存在，界面上没有 `UNREGISTERED` 水印。
- [x] 许可证对话框显示「已使用以下序列号激活」，邮箱与序列号等于配置值。
- [x] 重复执行 `pnpm hack` 不报错，且仍只保留一份备份。
- [x] 人为制造不兼容（关掉自校验放行的两层）：`pnpm hack` 报验收失败并把 `app.asar` 还原成备份内容。
- [x] `pnpm hack --restore` 后重新启动 Typora 回到未激活状态。
- [x] `pnpm hack --status` 不改动任何文件。
- [x] 改 `.env` 里的 `EMAIL` / `CODE` 后重新 hack，许可证对话框显示新值。
- [x] Typora 装在默认位置时 `pnpm hack --status` 能定位到它，且耗时在百毫秒级（走注册表 App Paths，不触发全盘扫描）。
- [x] `pnpm hack --dir <无 app.asar 的目录>`：报错「该目录下没有 resources\app.asar」并以非零码退出，不回退自动探测。
- [x] 扫描逻辑（`scanRootsForInstall`，见 `module-platform.md`）：根目录下深度 1 与深度 3 的 `Typora`
      （含 `resources\app.asar`）命中，深度 4 的与「名为 Typora 但没有 app.asar」的不命中。
- [ ] Typora 装在非默认位置（例如 `D:\Typora`、`D:\Software\Typora`）时，不带任何参数即可被自动找到。
- [x] **（2026-10-01 真机 · macOS arm64 / Typora 1.14.5-dev · Mach-O 路线）** `pnpm hack --yes`
      输出补丁点定位（arm64 / x86_64 双架构）、`✓ 已写入 ret 补丁，并对重签后的磁盘文件复检一致`、
      `✓ 已重签名（ad-hoc…）` 与 `✓ 激活成功：许可证记录保持有效（email/license 键完整），Typora 存活`。
- [x] **（真机）补丁字节判据**：`otool -arch arm64 -tV <二进制> | grep -A2 '^\-\[LicenseManager renew\]'`
      首条指令为 `ret`；`x86_64` 为 `retq`；hack 内部对重签后的磁盘文件重新解析复核一致
      （重签会重排胖文件：arm64 偏移 `0x2071f8`→`0x2031f8`，复检正确跟随）。
- [x] **（真机）签名判据**：`codesign --verify --strict --verbose=2 /Applications/Typora.app` 通过
      （`valid on disk` / `satisfies its Designated Requirement`）；`codesign -dv` 显示 `Signature=adhoc`；
      entitlements = 4 key（原 3 + `disable-library-validation`）。
- [x] **（真机）金丝雀判据**：启动后记录的 `lastTry` 仍为 hack 时刻 −48h（续期窗口外）且
      `email`/`license` 键完整——证明 `renew` 根本没有运行（研究报告 §8 的 openssl 命令可独立复核）。
- [x] **（真机）还原判据**：`pnpm hack --restore` 后 `renew` 入口回到原始序言（`sub sp, sp, #0xe0`）、
      二进制与备份逐字节一致（`cmp` 通过）、`codesign -dv` 重新显示
      `Authority=Developer ID Application: Abner Lee (9HWK5273G4)` 且 `codesign --verify --strict` 通过
      （无需再签，字节等价自愈）；记录回到 hack 前（`--status` 显示未激活）。
- [x] **（真机）幂等**：连续两次 `pnpm hack --yes`，第二次报「二进制已打过补丁，跳过写入（签名校验通过）」，
      零写入、仍只有一份备份目录；记录备份沿用既有 `.hapora-orig.bak`。
- [x] **（真机）** macOS 记录生成物以 `NSKeyedUnarchiver` 独立验证可解出 `email`(String) /
      `license`(String) / `installDate`(NSDate) / `lastTry`(NSDate)；许可证面板显示配置的邮箱与序列号。
- [x] **（真机）** macOS `pnpm hack --status` 显示「已补丁（renew 短路）/ ad-hoc / 备份在 / 已激活（邮箱）」。
- [ ] **（人工长稳判据）** 打补丁后关机静置 ≥48 小时再启动 Typora，`pnpm hack --status` 仍显示已激活
      （无 renew 网络请求、记录不被 unfill）。

## 完成定义

- 如何判定已完成：在未打补丁的 Typora 上一次 `pnpm hack` 成功，以上验收清单全部勾选；
  失败时命令以非零码退出并给出可读原因与回滚结果。
