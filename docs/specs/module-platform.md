# Spec — 平台抽象层（`src/platform/`）

## 要构建什么

- 目标：把「随操作系统变化的六件事」从编排逻辑里分离出来，让 `src/hack.ts` 只表达语义动作，
  同一套补丁流程能在 Windows / macOS / 桌面 Linux 上复用。

## 职责边界

补丁本身是平台无关的（`publicDecrypt` hook、`electron.net` 拦截、fs/crypto 自校验放行）。
真正随平台变化的只有这六件：

| # | 事项 | Windows | macOS | Linux |
|---|------|---------|-------|-------|
| 1 | 定位安装目录 | 注册表 / PATH / 盘符浅扫描 | Spotlight(`mdfind`) + `/Applications`、`~/Applications` | `which typora` + `/usr/share/typora` 等 + Flatpak/Snap |
| 2 | 安装根目录的形态 | 目录（含 `resources/app.asar`） | `.app` 包（asar 在 `Contents/Resources/`） | 目录（含 `resources/app.asar`） |
| 3 | 进程检测 / 结束 | `tasklist` / `taskkill` | `pgrep -x` / `pkill -x` | 同 macOS |
| 4 | 启动 | `<dir>\Typora.exe` | `<app>/Contents/MacOS/Typora` | `<dir>/Typora` |
| 5 | 写入安装目录（提权） | 一次 UAC（临时 `.cmd` + `Start-Process -Verb RunAs`） | `sudo -n` | `sudo -n` |
| 6 | 许可证存储 | `HKCU\SOFTWARE\Typora` 的 `SLicense`/`IDate` | **未实现**（抛错） | **未实现**（抛错） |

验收日志路径也随平台变：Windows `%APPDATA%\Typora\typora.log`、
macOS `~/Library/Application Support/Typora/typora.log`、Linux `~/.config/Typora/typora.log`
（后两者按 Electron userData 惯例推断，**未在真机验证**）。

## 行为

- `locate(overrideDir?)`：与 Windows 同一套语义——显式指定优先，无效即报错不回退；
  其余来源惰性求值、命中即止，每个候选都以「该目录下存在平台对应的 asar 路径」为准。
- `installFiles(jobs, { elevate })`：可写就直接复制；被拒或 `elevate=true` 时走平台提权。
  Unix 用 `sudo -n`（**非交互**），需要密码时立刻失败而不是挂住等待输入。
- `writeLicense(values)`：Windows 写注册表；macOS/Linux **抛错**，见 ADR-010。
- `clearLicense()`：清空许可证。未实现存储的平台是 no-op —— `--restore` 在任何平台都必须可用。
- `readLicense()`：未实现存储的平台返回 `{ license: null, date: null }`，供 `--status` 展示。

## 约束

- 平台实现的失败必须显式：不得「猜一个位置写进去」，也不得静默降级成「补丁打了但没激活」。
- `sudo` 绝不使用会等待密码的形式（会挂住 CLI）。
- 浅扫描必须同时设「深度上限」与「目录数上限」，并跳过系统/噪声目录。
- 新增平台 = 只加一个 `src/platform/<id>.ts` 与 `index.ts` 里的一行分支，不得改 `hack.ts` 的流程。

## 验收标准

- [x] `scanRootsForInstall` 对两套 asar 相对路径（`resources/app.asar` 与
      `Contents/Resources/app.asar`）都能扫到：深度上限内命中、超出深度或缺少 asar 的不命中。
- [x] macOS `locate` 接受 `.app`、`Contents`、`Contents/Resources`、`Contents/MacOS` 四种形态并归一到同一个 `.app`。
- [x] macOS/Linux 的 `locate` 无效路径返回 null 并给出形态提示。
- [x] macOS/Linux 的 `writeLicense` 抛错、`clearLicense` 不抛、`readLicense` 返回 null。
- [ ] **（待真机）** macOS arm64 上 `pnpm hack` 能定位、改写并激活；需先确认 asar integrity / 代码签名是否阻断。
- [ ] **（待真机）** Linux（Ubuntu/Fedora/Arch）上同上。
- [ ] **（待确认）** macOS/Linux 的许可证存储位置，据实测结论补上 `writeLicense`。
