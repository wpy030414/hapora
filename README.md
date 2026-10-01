# hapora

对 Typora 激活机制做逆向分析，并用**一个命令**让它变成已激活状态。
支持 Windows / macOS（arm64）/ 桌面 Linux；**Windows 与 macOS 已完整实现**，
Linux（Electron 版）的许可证存储尚无实证结论，会在改动任何文件之前明确报错（见 ADR-010）。

## 这是什么？

- 定位：一份 Typora 激活机制的逆向研究报告 + 配套的本地激活工具。
- 解决的核心问题：Typora 采用联网激活（RSA 密文许可证 + 12 小时续期 + 服务端设备绑定）。
  本仓库不搭建任何本地网关、不改 hosts、不伪造 DNS。
- **两套平台机制**（Typora 在两端根本不是同一种程序）：
  - **Windows / Linux（Electron 版）**：改包内明文入口 `launch.dist.js`，在进程内接管
    许可证校验链路与更新检查链路（补丁 + 写注册表）。
  - **macOS（原生版）**：原生 AppKit + WebKit 应用，没有 asar 也没有可注入的入口。
    走 **Mach-O 二进制补丁路线**（ADR-012）：在二进制 `-[LicenseManager renew]`（唯一会把
    激活打回的续期入口）写等长的 `ret` 指令使其永不运行，ad-hoc 重签名（entitlements 原样保留 +
    追加 `disable-library-validation`），再伪造 `~/Library` 下的许可证记录文件——
    **一次激活、永久有效**，与 Windows 语义对齐；原始二进制与签名备份在包外，`--restore`
    逐字节还原即恢复官方 Developer ID 签名。

## 为什么存在？

- 研究：把 Typora 的许可证存储、解密、续期、自校验、更新检查这条链路完整讲清楚（见 `docs/researches/`）。
- 实用：本机 Typora 长期可用，不需要反复重装或重置试用期。

## 如何安装和运行？

前置要求：Node.js ≥ 20、pnpm、已安装 Typora。

```bash
pnpm install            # 国内网络可加 --registry=https://registry.npmmirror.com
pnpm hack               # 激活（默认会自动验收，失败则回滚）
pnpm hack --no-verify   # 只打补丁，不启动验收
pnpm hack --restore     # 回滚到原始状态
pnpm hack --status      # 只看状态，不改动
pnpm hack --dir "D:\Software\Typora"   # 装在非常规位置时显式指定安装目录
```

安装目录的探测顺序：`--dir` / `HAPORA_TYPORA_DIR` → 注册表（Windows）/ Spotlight（macOS）/ `which`（Linux）
→ PATH → 常见默认目录 → 卸载记录 → 各盘浅扫描。命中即止，因此装在 D 盘或绿色目录通常也能自动找到；
实在找不到时用 `--dir` 指定，或设置环境变量 `HAPORA_TYPORA_DIR`。

执行 `pnpm hack` 时若 Typora 正在运行，需要先关闭它，或加 `--yes` 让脚本自行结束进程。

### 自定义邮箱与序列号

仓库根目录的 `.env`（不入库，模板见 `.env.example`）：

```ini
EMAIL=krkr@xrl.im
CODE=POWER0-ED0000-BY0000-XRL000
```

不提供就用代码里的默认值（即上面这两个）。优先级：环境变量 > `.env` > 默认值。

> 序列号与邮箱只写进本地的伪造记录；两个平台在**启动路径**上都不校验它们的内容，
> 因此这里填什么都能通过——填成自己的信息只是让「我的许可证」对话框看起来顺眼
> （macOS 上序列号会原样显示在许可证面板）。

## 当前状态

- 阶段：可用（Windows 针对 Typora `1.14.10` / Electron `42.2.0`；macOS 针对原生版 `1.14.5-dev`，arm64 真机实测）。
- 版本无关性：
  - Windows/Linux：入口文件名从包内 `package.json` 的 `main` 读取，注入位置固定在文件最前面，
    自校验基准在打包时按实际内容现算，**不针对某个 Typora 版本写死任何常量**；
  - macOS：bundle id 与可执行名读自 `Info.plist`，记录文件名由本机 `IOPlatformUUID` 派生，
    Mach-O 补丁点运行时解析符号表定位（**零硬编码偏移**）；
  - 换版本后若结构不兼容，`pnpm hack` 会验收失败并自动回滚，不会留下坏状态。
- 验收判据（全部由 `pnpm hack` 现场产生，仓库不携带任何截图）：
  - **Windows/Linux**：`typora.log` 中出现 `[L] pass` 与 `[watch L] hasL: true`；出现
    `[renewLicense]: license renewed`，且**不出现** `Integrity check failed`、`onUnfillLicense`；
    启动约 1s 的自校验窗口过去后进程仍在；主窗口无 `UNREGISTERED` 水印。
  - **macOS**：双架构 `renew` 入口首指令为 `ret`/`retq`；`codesign --verify --strict` 通过
    （ad-hoc）；启动后许可证记录文件仍完整携带 `email`/`license` 键且进程存活——记录的
    `lastTry` 落在续期窗口**之外**，存活本身就是 `renew` 已被短路的自证；`--restore` 能把
    二进制与记录逐字节还原（Developer ID 签名自愈）。
- 已知限制：
  - **macOS 手动升级 Typora 后补丁失效**：升级会换掉二进制，下一次启动立刻可见地被打回
    （`lastTry` 金丝雀使失效可见而非静默），重跑 `pnpm hack` 即恢复（备份状态机自动刷新）。
    ad-hoc 重签后 Sparkle 应用内自动更新大概率失效——这与 Windows 路线「伪造更新检查」
    语义等价：补丁不会被自动更新静默覆盖；需要升级时手动下载。
    首次改包会触发一次 macOS 的「App Management」授权弹窗。
  - Linux（Electron 版）的许可证存储尚无实证结论，会在改动文件**之前**直接失败，而不是留下半成品。
  - 不支持 AppImage（只读镜像）。
  - 伪造的许可证载荷字段名（Windows：`deviceId` / `fingerprint` / `email` / `license` /
    `version` / `date` / `type`；macOS：记录字典的 `email` / `license` / `lastTry`）来自实测；
    若上游改字段名或存储格式，验收会失败并回滚。
  - 许可证服务端接口按 `/api/client/*` 前缀匹配、更新检查按 `/releases/*.json` 匹配；
    路径规则若大改同样会由验收兜住。

## 核心技术

- 语言 / 运行时：TypeScript + Node.js（`tsx` 直跑，无构建步骤）。
- 关键依赖：`@electron/asar`（解包/打包 `app.asar`，仅 asar 路线使用）。
- 手法：
  - Windows/Linux：注入 `launch.dist.js`（asar 内唯一的明文入口），在
    `require("./atom.compiled.dist.jsc")` 之前挂接 `crypto.publicDecrypt`、`crypto.createHash`
    与 `electron.net.request`；
  - macOS：自研 fat/Mach-O 最小解析器（运行时在符号表里定位 `-[LicenseManager renew]` 的 IMP，
    等长写入 `ret`，arm64/x86_64 双架构）+ entitlements 导出注入与 `codesign` 重签封装 +
    binary plist 编解码器与 AES-256-CBC 记录伪造（详见 `docs/researches/activation-mac.md` §10）。

详细设计见 `docs/`。
