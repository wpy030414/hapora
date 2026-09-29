# hapora

对 Typora 激活机制做逆向分析，并用**一个命令**让它变成已激活状态。
支持 Windows / macOS（arm64）/ 桌面 Linux；**目前只有 Windows 的许可证存储有实现**，
其余两个平台会在改动任何文件之前明确报错（见 `docs/DECISIONS.md` ADR-010）。

## 这是什么？

- 定位：一份 Typora 激活机制的逆向研究报告 + 配套的本地补丁工具。
- 解决的核心问题：Typora 采用联网激活（RSA 密文许可证 + 12 小时续期 + 服务端设备绑定）。
  本仓库不搭建任何本地网关、不改 hosts、不伪造 DNS，而是**直接修改 Typora 自身的启动脚本**，
  在进程内把许可证校验链路和更新检查链路接管掉。

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

> 序列号与邮箱只写进本地伪造的许可证载荷；Typora 在解密路径上并不校验它们的内容，
> 因此这里填什么都能通过——填成自己的信息只是让「我的许可证」对话框看起来顺眼。

## 当前状态

- 阶段：可用（针对 Typora `1.14.10` / Electron `42.2.0` 实测通过）。
- 版本无关性：入口文件名从包内 `package.json` 的 `main` 读取，注入位置固定在文件最前面，
  自校验基准在打包时按实际内容现算，因此**不针对某个 Typora 版本写死任何常量**。
  换版本后若结构不兼容，`pnpm hack` 会验收失败并自动回滚，不会留下一个启动即退的坏包。
- 验收判据（全部由 `pnpm hack` 现场产生，仓库不携带任何截图）：
  - `typora.log` 中出现 `[L] pass` 与 `[watch L] hasL: true`；
  - 出现 `[renewLicense]: license renewed`，且**不出现** `Integrity check failed`、`onUnfillLicense`；
  - 启动约 1s 的自校验窗口过去后进程仍在（`pnpm hack` 的验收会一直等到这一步才判成功）；
  - 主窗口标题为 `Typora`，界面无 `UNREGISTERED` 水印；`帮助 → 我的序列号` 显示「已使用以下序列号激活」。
- 已知限制：
  - 仅 Windows 可完整激活。macOS（arm64）与桌面 Linux 的定位 / 进程 / 启动已就绪，
    但许可证存储还没实证结论，因此这两个平台会在改动文件**之前**直接失败，而不是留下半成品。
  - macOS 还需在真机上确认 Electron 的 asar integrity 与代码签名是否会阻断改写。
  - 不支持 AppImage（只读镜像）。
  - 伪造的许可证载荷字段名（`deviceId` / `fingerprint` / `email` / `license` / `version` /
    `date` / `type`）来自 `1.14.x` 的实测；若上游改字段名，验收会失败并回滚。
  - 许可证服务端接口按 `/api/client/*` 前缀匹配、更新检查按 `/releases/*.json` 匹配；
    路径规则若大改同样会由验收兜住。

## 核心技术

- 语言 / 运行时：TypeScript + Node.js（`tsx` 直跑，无构建步骤）。
- 关键依赖：`@electron/asar`（解包/打包 `app.asar`）。
- 手法：注入 `launch.dist.js`（asar 内唯一的明文入口），在 `require("./atom.compiled.dist.jsc")` 之前
  挂接 `crypto.publicDecrypt`、`crypto.createHash` 与 `electron.net.request`。

详细设计见 `docs/`。
