# Spec — 平台抽象层（`src/platform/`）

## 要构建什么

- 目标：把「随操作系统变化的事」从编排逻辑里分离出来，让 `src/hack.ts` 只表达语义动作与能力位分支，
  同一套 CLI 能在 Windows / macOS / 桌面 Linux 上复用。
- 平台是两类被改对象的承载方：**asar 路线**（Windows/Linux 的 Electron 应用，注入补丁）
  与 **Mach-O 路线**（macOS 的原生应用：二进制短路 `renew` + ad-hoc 重签 + 伪造许可证记录文件）。
  见 ADR-010、ADR-012。

## 职责边界

补丁本身（`publicDecrypt` hook、`electron.net` 拦截、fs/crypto 自校验放行）只属于 asar 路线；
Mach-O 的解析 / 补丁 / 重签 / 备份事务只属于 darwin（`darwin-macho.ts`，darwin 私有）。
真正随平台变化的是这些：

| # | 事项 | Windows | macOS | Linux |
|---|------|---------|-------|-------|
| 1 | 定位安装目录 | 注册表 / PATH / 盘符浅扫描 | Spotlight(`mdfind`) + `/Applications`、`~/Applications` | `which typora` + `/usr/share/typora` 等 + Flatpak/Snap |
| 2 | 安装根目录的形态 | 目录（含 `resources/app.asar`） | `.app` 包（bundle id 与可执行名读自 Info.plist） | 目录（含 `resources/app.asar`） |
| 3 | 进程检测 / 结束 | `tasklist` / `taskkill` | `pgrep -x` / `pkill -x` | 同 macOS |
| 4 | 启动 | `<dir>\Typora.exe` | `<app>/Contents/MacOS/<CFBundleExecutable>` | `<dir>/Typora` |
| 5 | 许可证记录（`target`） | `resources/app.asar` | `~/Library/Application Support/<bundle id>/.<指纹>` | `resources/app.asar` |
| 6 | 二进制补丁对象（Mach-O） | — | `<app>/Contents/MacOS/<可执行>`（ret 补丁）+ ad-hoc 重签 | — |
| 7 | 写入提权 | 一次 UAC | .app 属主为用户时无需提权；root 属主时一次 `sudo -n`（备份+覆盖+重签一批） | `sudo -n` |
| 8 | 许可证存储 | `HKCU\SOFTWARE\Typora` 的 `SLicense`/`IDate` | AES 加密的 keyed archive 记录文件（lastTry=−48h 金丝雀） | **未实现**（抛错，见 ADR-010） |
| 9 | 启动验收探针 | 读 `typora.log` 关键字 | 轮询记录文件是否仍带激活键 + 进程存活 | 无（恒 pending，由超时兜底） |
| 10 | `asarPatchSupported` | `true` | `false` | `true` |
| 11 | `machoPatchSupported` | `false` | `true` | `false` |

macOS 没有可用的验收日志：既不存在 `typora.log`，unified log 在启动路径也没有输出（已实测）。

## 行为

- `locate(overrideDir?)`：显式指定优先，无效即报错不回退；其余来源惰性求值、命中即止，
  每个候选以**平台自己的结构判据**为准（Windows/Linux：存在 `resources/app.asar`；
  macOS：`.app` 包内存在 `Contents/Info.plist` 与 `Contents/MacOS`）。
- `installFiles(jobs, { elevate })`：可写就直接复制；被拒或 `elevate=true` 时走平台提权。
  Unix 用 `sudo -n`（**非交互**），需要密码时立刻失败而不是挂住等待输入；
  通用 `elevatedRun(lines, desc)` 支持把 cp / codesign / xattr / chown 组进同一个一次性脚本。
- `machoInspect(install)`（只读）：双架构补丁字节状态（已补丁 / 部分 / 未补丁）、签名形态
  （developer-id / adhoc / unknown，每次现跑 `codesign -dv --verbose=2`）、包外备份在位性。
- `machoApplyPatch(install, { elevate })`（事务化）：解析定位（符号缺失⇒写盘前抛错）→
  状态机（created / kept / refreshed / already；已补丁但无备份⇒显式失败）→
  改动前导出 entitlements → 临时目录 stage → 一次性落盘（备份先于覆盖；安装后恢复执行位；
  root 属主时 chown 归还）→ ad-hoc 重签 → **对重签后的磁盘文件重新解析复检**；
  写盘后任一步失败从备份紧急还原并重抛。
- `writeLicense({ email, licenseCode, now })`：Windows 写注册表；macOS 生成并加密写入伪造记录
  （`lastTry = now − LAST_TRY_HOURS_AGO(48h)` 金丝雀，窗口外）；Linux **抛错**（见 ADR-010）。
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
- [x] **（2026-10-01 真机 · Mach-O 路线）** macOS arm64（Typora 1.14.5-dev）：`machoInspect`
      对原始包报「未补丁 / Developer ID / 无备份」；`applyMachOPatch` 后双架构补丁点首指令为
      `ret`/`retq`（与 `nm`/`otool` 逐一对账，arm64 vm `0x1000731f8`→文件偏移 `0x2071f8`、
      x86_64 `0x100089ed7`→`0x8ded7`；重签后偏移重排为 `0x2031f8`，复检正确捕获）。
- [x] **（2026-10-01 真机）** 符号定位纯函数与 `nm -arch <a> -U` 输出逐一对账；缺失符号
      （乱写的名字）在写盘前显式失败且不触碰任何文件。
- [x] **（2026-10-01 真机）** entitlements 导出（3 key）→ 注入 disable-library-validation（4 key）
      → `plutil -lint` OK；重签后 `codesign --verify --strict --verbose=2` 通过且
      `Signature=adhoc`。
- [x] **（2026-10-01 真机）** macOS 记录文件生成物以 `NSKeyedUnarchiver` 独立验证可解出
      `email`(String) / `license`(String) / `installDate`(NSDate) / `lastTry`(NSDate)
      （`lastTry` = hack 时刻 − 48h 金丝雀）。
- [ ] **（待真机）** Linux（Ubuntu/Fedora/Arch）上定位、改写与激活。
- [ ] **（待确认）** Linux 的许可证存储位置，据实测结论补上 `writeLicense`。
