# Spec — hack CLI（`src/hack.ts` + `src/config.ts`）

## 要构建什么

- 目标：`pnpm hack` 一条命令把 Typora 变成已激活状态；同一入口提供回滚、状态与自动验收，
  并在版本不兼容时自动回滚，不留坏包。

## 行为

- 无参数执行：备份 → 取入口原文 → 注入 → 重新打包 → 写注册表 → 启动验收 → 报告。
- 安装目录不可写时（典型是 `%ProgramFiles%\Typora`）：解包 / 注入 / 打包全部在用户临时目录里完成，
  最后用**一次** UAC 提权把「备份 + 成品」复制进安装目录，其余步骤（写注册表、启动 Typora、读日志）
  仍以普通用户身份进行。目录可写时不提权。
- `--dir <路径>`：显式指定 Typora 安装根目录。指向的目录里没有 `resources\app.asar` 时**直接报错退出**，
  不回退到自动探测（显式指定必须被尊重，静默猜别处比报错更糟）。
- `--no-verify`：跳过启动验收（仍然打补丁），并在输出中提示跳过的风险。
- `--restore`：把 `app.asar` 从备份拷回，并清空注册表 `SLicense`。
- `--status`：只读打印安装路径、备份、入口名与是否已注入、注册表两个键、以及生效的邮箱/序列号。
- `--yes` / `-y`：跳过「Typora 正在运行」的确认。
- `--help` / `-h`：打印用法。
- 幂等：重复执行不会重复备份；Typora 被重装/升级后，备份会自动刷新。
- 配置：邮箱与序列号来自 `环境变量 > 仓库根目录 .env > src/config.ts 的默认值`。

## 输入 / 输出

- 输入：
  - 命令行标志；
  - Typora 安装目录下的 `resources\app.asar`。Typora 可能装在任意位置（D 盘、绿色版目录等），
    因此按「便宜 → 昂贵、命中即止」的顺序汇集候选，**每个候选都以该目录下存在 `resources\app.asar` 为准**：
    1. 显式指定：`--dir <路径>` 或环境变量 `HAPORA_TYPORA_DIR`（无效即报错，不回退）
    2. 注册表 `App Paths\Typora.exe`（HKLM / WOW6432Node / HKCU）与文件关联
       （`HKCR\Typora.md\shell\open\command`、`HKCR\Applications\Typora.exe\shell\open\command`）里的 exe 路径
    3. `where Typora.exe`（PATH）
    4. `%ProgramFiles%\Typora`、`%ProgramFiles(x86)%\Typora`、`%LOCALAPPDATA%\Programs\Typora`
    5. 注册表卸载表里 `DisplayName` 为 Typora 的 `InstallLocation` / `UninstallString`
    6. 全盘浅扫描：各固定盘根下的常见子目录（`Typora`、`Program Files\Typora`、`Apps\Typora` 等），
       再退化为深度 ≤3、目录数 ≤20000 的遍历（跳过 `Windows`、`AppData`、`$Recycle.Bin` 等噪声目录）
  - （及其同目录备份）；
  - 模板文件 `src/inject/patch.js`；
  - 可选的 `<repo>/.env`。
- 输出：
  - 覆盖后的 `app.asar`；
  - 首次执行时产生的 `app.asar.hapora-orig.bak`；
  - 注册表 `HKCU\SOFTWARE\Typora` 的 `SLicense` / `IDate`；
  - stdout 的步骤报告；
  - 验收时启动 Typora 进程并读取 `%APPDATA%\Typora\typora.log`。

## 约束

- 任何写操作之前必须先有可用的备份。
- 非 Windows 平台直接退出，不做降级。
- **只有「写安装目录」这一步可能需要管理员**：不得因为要提权就把整个 CLI 重跑一遍，
  也不得以管理员身份去启动 Typora 或读写日志。
- 提权必须是一次性的批量动作（备份与成品在同一次 UAC 里完成），不能弹两次。
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
- 验收判定必须**晚于启动 ~1s 的自校验窗口**：`hasL: true` 在 ~0.1s 出现，自校验在 ~1s 才跑完，
  仅凭 `hasL` 提前宣判会误报成功。
- 验收只能读**最后一次启动**的日志片段：`typora.log` 会轮转，按文件长度切片会读到上一次运行的内容。
- 验收失败且命中 `Integrity check failed` / `unfill due to renew fail`：判为补丁不兼容 → 自动回滚 + 清注册表。
- 40s 内既无激活标记也无致命信号：判为无法判定，补丁保留并提示手动观察。

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
- [x] 扫描逻辑（`scanRootsForTypora`）：根目录下深度 1 与深度 3 的 `Typora`（含 `resources\app.asar`）命中，
      深度 4 的与「名为 Typora 但没有 app.asar」的不命中。
- [ ] Typora 装在非默认位置（例如 `D:\Typora`、`D:\Software\Typora`）时，不带任何参数即可被自动找到。

## 完成定义

- 如何判定已完成：在未打补丁的 Typora 上一次 `pnpm hack` 成功，以上验收清单全部勾选；
  失败时命令以非零码退出并给出可读原因与回滚结果。
