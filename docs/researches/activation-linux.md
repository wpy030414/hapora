# Typora Linux 版激活机制逆向研究

> 样本：Typora `1.14.9`（官方 deb，`typora_1.14.9_amd64.deb`），Ubuntu `26.04.1 LTS`（WSL2，内核 `6.6.87.2-microsoft-standard-WSL2`），Node `v22.23.3`（宿主注入用）
> 安装路径：`/usr/share/typora`（`/usr/bin/typora` 是指向 `/usr/share/typora/Typora` 的符号链接）
> 研究方法：与 Windows 篇一致——在明文入口 `launch.dist.js` 注入探针（Hook `crypto`、`fs`、`electron.net`、`Module._load`），
> 逐次启动读取 `~/.config/Typora/typora.log`，用运行时可观测行为反推逻辑；并对许可证存储文件做逐格式的 A/B 试写。
> 姊妹篇：Windows 版见 `activation-win.md`（1.14.10）、macOS 版见 `activation-mac.md`（原生 1.14.5-dev）。
> **Linux 与 Windows 同为 Electron 结构，激活链路几乎逐字一致**；真正的差异只有两处：许可证的**载体**与**编码**。

---

## 0. 结论速览（先看这里）

| 维度 | Windows | Linux | 差异 |
|---|---|---|---|
| 被改对象 | Electron `app.asar` | Electron `app.asar` | **相同** |
| 明文入口 | `launch.dist.js`（1383 B） | `launch.dist.js`（1383 B） | **相同** |
| 业务逻辑 | `atom.compiled.dist.jsc`（V8 字节码） | `atom.compiled.dist.jsc`（V8 字节码） | **相同** |
| 许可证载体 | 注册表 `HKCU\SOFTWARE\Typora` | 文件 `~/.config/Typora/<指纹>` | **不同** |
| 许可证编码 | 注册表 REG_SZ 明文 | 整段 JSON 的**十六进制编码** | **不同（关键坑）** |
| 许可证键 | `SLicense` + `IDate` 两键 | 只有 `SLicense`（日期并入其尾段） | 略不同 |
| SLicense 值 | `base64(密文)#0#M/D/YYYY` | `base64(密文)#0#M/D/YYYY` | **相同** |
| 机器指纹源 | `MachineGuid`（注册表） | `/etc/machine-id` | **不同** |
| 指纹公式 | `Base64(SHA256(id+"typora"))[0..10]` 清洗 | 同左 | **相同** |
| 本地解密 | `crypto.publicDecrypt`（`pure=undefined`） | `crypto.publicDecrypt`（`pure=undefined`） | **相同** |
| 日志类名 | `[WindowsLicenseLocalStore]` | `[WindowsLicenseLocalStore]`（**仍是这个**） | 见 §6 |
| 日志路径 | `%APPDATA%\Typora\typora.log` | `~/.config/Typora/typora.log` | 路径不同，**关键字相同** |
| 自校验 | 启动 ~1s，`fs.promises.readFile` + `createHash` | 同左 | **相同** |

**一句话**：Windows 篇 §3/§4/§5/§6 的机制结论在 Linux 上**全部成立**；补丁的三个接管点
（`fs`/`crypto.createHash` 自校验放行、`crypto.publicDecrypt` 许可证接管、`electron.net.request` 续期接管）
一字不改即可复用。落地时只需要把「写注册表」换成「写十六进制编码的指纹文件」，并把指纹源从
`MachineGuid` 换成 `/etc/machine-id`。

---

## 1. 软件结构

与 Windows 完全同构：

```
/usr/share/typora/
├── Typora                          # Electron 主可执行文件
├── resources/
│   ├── app.asar                    # 只有三个文件
│   │   ├── launch.dist.js          # 明文入口（1383 B），注册 .jsc 加载器后 require 字节码
│   │   ├── atom.compiled.dist.jsc  # V8 字节码（379 KB），全部业务逻辑
│   │   └── package.json            # {"main":"launch.dist.js","version":"1.14.9"}
│   ├── lib.asar                    # 前端库（8 MB）
│   ├── node_modules.asar           # electron-fetch / native-reg 等（15 MB）
│   ├── page-dist/ appsrc/ style/ updater/ assets/ locales/
│   └── app.asar.hapora-orig.bak    # 本仓库留下的原始备份
```

`launch.dist.js` 与 Windows 版逐字节同构：`v8.setFlagsFromString("--no-lazy"/"--no-flush-bytecode")`
→ 注册 `Module._extensions[".jsc"]` 加载器 → `require("./atom.compiled.dist.jsc")`。
**补丁的唯一落点仍然是 `launch.dist.js`**。

> 附带确认：`node_modules.asar` 里带 `native-reg`（Windows 注册表模块），在 Linux 上 `require` 会抛错，
> 因此 `patch.js` 的 `machineId()` 在 Linux 上必然走 `native-reg`/`reg.exe` 两条 catch 之后的
> `/etc/machine-id` 回退分支。

---

## 2. 许可证的存储（本篇的核心差异）

### 2.1 文件位置：`~/.config/Typora/<指纹>`

Electron 的 `app.getPath("userData")` 在 Linux 上是 `~/.config/Typora`。许可证文件不是固定名，
而是**以机器指纹命名**（与 macOS 的记录文件同思路）：

```
指纹 = Base64(SHA256(machineId + "typora"))[0..10].replace(/[/=+-]/g, "a")
machineId = /etc/machine-id 的内容（32 位小写 hex，systemd 标准）
```

本机实测：

```
/etc/machine-id = 99f372a56f7e4bb49b0d5a59ca0c93de
SHA256(machineId + "typora") → base64 = 1KmPnt1Apv...（前 10 位无特殊字符，无需清洗）
⇒ 许可证文件名 = 1KmPnt1Apv
```

指纹公式与 Windows **完全一致**，只是把 `MachineGuid` 换成 `/etc/machine-id`。末尾的
`[/=+-]→"a"` 清洗同样不能省（base64 前缀约一半概率含这些字符）。

### 2.2 文件编码：整段 JSON 的十六进制（**最大的坑**）

文件内容**不是**裸 JSON，而是**把整个 JSON 字符串再做一次 hex 编码**——与同目录 `profile.data`
的编码方式完全一致：

```
磁盘字节（可读文本）：  7b22534c6963656e7365223a22227d
hex 解码后：            {"SLicense":""}
```

因此读写许可证文件都必须**先解 hex 再 JSON.parse**（读）、**先 JSON.stringify 再编 hex**（写）。
写错编码是本篇调查中耗时最久的一环，现象见 §2.4。

### 2.3 文件内的 JSON 结构：只有 `SLicense`，无 `IDate`

```json
{ "SLicense": "<Base64 密文>#0#<日期 M/D/YYYY>" }
```

与 Windows 注册表相比：

- `SLicense` 的**值格式完全相同**：`base64(密文)#<状态位>#<日期>`。
- **没有独立的 `IDate` 键**——日期已经在 `SLicense` 尾段里。`--status` 展示时从
  `SLicense` 按 `#` 切分取第三段即可（`src/platform/linux.ts` 的 `readLicense` 就是这么做的）。
- 本工具写入的 `SLicense` 值与 Windows 一致：`base64("@@HAPORA_LICENSE@@")#0#<今日>`
  （即 `src/patch.ts` 的 `licenseValue()`）。这个明文标记会经 `publicDecrypt` 接管后返回伪造载荷，
  密文本身能否 RSA 解密并不重要（见 §3）。

### 2.4 编码写错时的现象（务必记住）

如果把文件写成**裸 JSON**（`{"SLicense":"..."}` 而非其 hex），Typora 读文件 → 尝试 hex 解码 →
得到的不是合法 JSON → 读不出 `SLicense` → 日志打 `no info` → `onUnfillLicense` → `hasL: false`，
**并且不会有任何报错**。这与 Windows 篇 §4「fingerprint 不匹配」的静默失效是同一类陷阱：
「补丁装了、进程活着、但就是没激活，且无错误日志」。

> 调查弯路备忘：早期一度怀疑「Linux 不走 `crypto.publicDecrypt`、改走纯 JS RSA 或字节码内解密」，
> 因为把探针装在 `publicDecrypt` 上、却用**裸 JSON** 写许可证，探针从不触发。真相是：
> 编码写错 ⇒ Typora 连 `SLicense` 都读不出来 ⇒ 根本没走到解密那一步。改用 hex 编码后，
> `publicDecrypt` 接管立刻生效（§3）。**先保证 Typora 能读到 SLicense，再谈解密。**

---

## 3. 启动时的许可证流程（与 Windows 逐字一致）

用正确的 hex 编码写入 `SLicense` 后，启动 Typora，`~/.config/Typora/typora.log` 实测片段：

```
------------------start------------------
typora version: 1.14.9
[watch L]
pure = undefined                              # 未启用纯 JS RSA，走原生 crypto.publicDecrypt
renew                                         # 触发续期
[renewLicense]: {"v":"linux|1.14.9","license":"POWER0-ED0000-BY0000-XRL000","l":"0MA-","u":"4d0b9224-...","type":""}
[L] pass                                      # 本地解密通过（publicDecrypt 接管生效）
[L] installDate is 10/8/2026, trail remains: 15 days
[watch L] hasL: true                          # ← 激活成功
[renewLicense]: license renewed               # 续期成功（electron.net 接管生效）
ls put SLicense                               # 回写 SLicense（ls = LocalStore）
```

要点（全部继承 Windows 篇 §3）：

- **本地解密成功 → `hasL: true`**；随后发续期请求，续期失败会 `onUnfillLicense` 把 `hasL` 打回
  `false`。所以必须同时接管 `publicDecrypt`（本地）与 `electron.net.request`（续期）。
- `pure = undefined` 表示走原生 `crypto.publicDecrypt`（`atom.compiled.dist.jsc` 里另有 `jsDecrypt`
  纯 JS RSA 分支，`pure = true` 时启用）。本样本走原生分支，`patch.js` 的 `publicDecrypt` hook 命中。
- 续期请求里的 `v` 字段是 **Typora 自己按 `process.platform` 现算的**（这里是 `linux|1.14.9`），
  与 `patch.js` 里 `fakeLicense().version` 无关——因此 `fakeLicense` 的 `version` 写成 `"win|"` 还是
  `"linux|"` 都不影响激活（本地校验也不比对 `version`，见 Windows 篇 §4）。**实测证明：
  `patch.js` 无需为 Linux 特化 `version` 字段。**

### 3.1 本地解密的 RSA 报错（反证 publicDecrypt 确实被调用）

当 `SLicense` 的 base64 部分**不是合法 RSA 密文**（例如本工具写的 `base64("@@HAPORA_LICENSE@@")`，
解码后只有 20 字节）时，原生 `crypto.publicDecrypt` 会抛：

```
ERROR error:04000070:RSA routines:OPENSSL_internal:DATA_LEN_NOT_EQUAL_TO_MOD_LEN
```

这与 Windows 篇 §2.1 记录的报错**一模一样**。`patch.js` 的 hook 正是 `try { 原生解密 } catch { 返回伪造 }`，
这个报错被 catch 吞掉、落入伪造载荷，于是 `[L] pass`。这条报错的存在本身就是「Linux 确实调用了
`crypto.publicDecrypt`」的铁证。

---

## 4. 机器指纹

```
fingerprint = Base64(SHA256(machineId + "typora"))[0..10].replace(/[/=+-]/g, "a")
machineId   = /etc/machine-id        （systemd 标准；回退 /var/lib/dbus/machine-id）
```

与 Windows 唯一的差别是 `machineId` 的来源：Windows 是 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`，
Linux 是 `/etc/machine-id`。公式、长度、清洗规则完全相同。

`patch.js` 的 `machineId()` 已按「`native-reg` → `reg.exe` → `/etc/machine-id` → `/var/lib/dbus/machine-id`」
顺序回退（Linux 上前两条必失败，走第三条）。**指纹必须与 Typora 自己算的逐字符相等**，否则
`no info` + `hasL: false` 且无错误日志（Windows 篇 §4.1 的硬校验在 Linux 上同样成立）。

> 注意：续期请求里的 `u` 用的是 `profile.data` 的 `uuid`（本机 `4d0b9224-8a4a-463d-846c-b02095da719a`），
> 与指纹不同源——这点也与 Windows 篇 §4.1 的脚注一致。

---

## 5. 联网协议与自校验（与 Windows 相同）

- **续期 / 激活 / 反激活**：`electron.net.request` 发往 `{mirror}/api/client/{renew,activate,deactivate}`，
  请求体含 `v`/`license`/`l`(deviceId)/`u`(uuid)/`type`。`patch.js` 对 `/api/client/` 一律回
  `{success:true, code:1, msg:base64(marker)}`，续期即「成功」，`hasL` 不被打回。
- **更新检查**：`{mirror}/releases/*.json`，`patch.js` 回报「当前已是最新」，无更新弹窗。
- **自校验**：启动 ~1s 后读 `package.json` 取 `main` → 读入口文件 → `crypto.createHash("sha256")`
  与内置基准比对。探针实测确认 Linux 上 `createHash` 被调用（是启动路径里**唯一**被调用的 crypto 函数）。
  `patch.js` 的读取层（`fs.readFile*` 命中入口返回原文）+ 哈希层（`createHash` 命中自己返回基准）
  双层放行照常生效，`Integrity check failed` 不出现。

---

## 6. 一个反直觉的发现：日志类名仍是 `[WindowsLicenseLocalStore]`

`atom.compiled.dist.jsc` 的字符串表里，许可证本地存储的日志前缀是 `[WindowsLicenseLocalStore]`，
在 Linux 上**原样出现**（没有 `LinuxLicenseLocalStore`）。这说明 Typora 的 Linux 版直接复用了
Windows 的 LocalStore 类，只是把「注册表读写」换成了「`~/.config/Typora/<指纹>` 文件的 hex 读写」。

> 对 ADR-010 的修正：当初「`[WindowsLicenseLocalStore]` 这个类名本身就说明每个平台一套实现」的推断，
> 在 Linux 上被证伪——**类名相同、实现载体不同**。真正随平台变的只有「存到哪、怎么编码」，
> 而非「一个平台一个类」。这也解释了为什么 Linux 的激活链路能与 Windows 逐字对齐。

启动路径里还观察到 `ls put SLicense`（`ls` = LocalStore 实例），对应「把 SLicense 写回存储」的动作。

---

## 7. 分发形态与可写性

| 形态 | 安装位置 | app.asar 可写 | 本工具 |
|---|---|---|---|
| deb / rpm（官方） | `/usr/share/typora` | root 属主，需一次 `sudo -n` 提权 | **支持**（已实测） |
| AUR | `/usr/share/typora` 或 `/opt/typora` | 同上 | 支持（同结构） |
| Flatpak | `<flatpak 根>/app/io.typora.Typora/.../typora` | 沙箱内 | 定位已支持，未实测 |
| Snap | `/snap/typora/current/typora` | **只读 squashfs** | **不支持**（无从改写 app.asar） |
| AppImage | `/tmp/.mount_*/` | **只读 squashfs** | **不支持** |

实测用的是官方 deb（`/usr/share/typora`，`app.asar` 401406 B）。Snap 版经确认 `resources/app.asar`
位于只读文件系统（`touch` 报 `Read-only file system`），与 AppImage 同属不可改写，故排除。

---

## 8. 落地清单（本仓库据此实现）

1. **`src/platform/linux.ts`**：
   - `linuxFingerprint()` 读 `/etc/machine-id`（回退 dbus）算指纹，定位 `~/.config/Typora/<指纹>`。
   - `licenseRead` / `licenseWriteSLicense` **先解/编 hex 再 JSON**（§2.2 的坑）。
   - `readLicense` 从 `SLicense` 尾段切出日期填 `IDate` 展示位（§2.3）。
   - `probeActivation` 读 `~/.config/Typora/typora.log`，关键字与 Windows 完全相同
     （`[watch L] hasL: true` / `Integrity check failed` / `unfill due to renew fail`），settle 窗口 6s。
2. **`src/inject/patch.js`**：`machineId()` 增加 `/etc/machine-id` 回退（§4）。其余三个接管点
   **一字未改**即复用（§0、§3、§5）。`fakeLicense().version` 无需为 Linux 特化（§3 实测）。
3. **`src/hack.ts` / `src/platform/unix.ts`**：无改动。`licenseSupported()` 返回 `true` 后，
   Linux 自动进入与 Windows 相同的 asar 路线。

### 验收判据（Ubuntu 26.04.1 / Typora 1.14.9 实测通过）

```
pnpm hack --yes
  ✓ 入口 launch.dist.js：原始 1383B → 注入后 12275B
  ✓ app.asar 已重新打包并写入安装目录
  ✓ 许可证已写入
  ✓ 激活成功：[watch L] hasL: true（自校验后仍存活）      # exit 0

pnpm hack --status
  入口文件  launch.dist.js（已注入补丁）
  SLicense  QEBIQVBPUkFfTElDRU5TRUBA#0#10/8/2026
  IDate     10/8/2026                                    # 从 SLicense 尾段切出

pnpm hack --restore
  ✓ 已从备份恢复 app.asar，并清空许可证记录
  cmp app.asar app.asar.hapora-orig.bak → 字节一致

日志（成功启动段）同时满足：
  [L] pass、[watch L] hasL: true、[renewLicense]: license renewed
  且无 Integrity check failed、无 unfill due to renew fail
```

---

## 9. 未覆盖 / 待验证

- **Fedora 44（rpm）**：机制上与 deb 同构（同为 `/usr/share/typora` + 同一份 `.jsc`），
  指纹源 `/etc/machine-id` 亦为 systemd 标准，预期一致；本轮受限于 WSL 商店仅有 Ubuntu 26.04，
  Fedora 真机验收待补（判据同 §8）。
- **Flatpak**：定位逻辑已含其路径，但沙箱内 `~/.config` 映射到 `~/.var/app/io.typora.Typora/config`，
  指纹文件落点需单独实测。
- **纯 JS RSA 分支（`pure = true`）**：本样本走原生 `publicDecrypt`，未触发 `jsDecrypt`；
  若某发行版/版本改走纯 JS 分支，`patch.js` 的 `publicDecrypt` hook 将落空，需另行接管（届时日志会出现
  `pure = true` / `pure js failed`，可据此判断）。

---

*本报告仅用于软件逆向工程研究。*
