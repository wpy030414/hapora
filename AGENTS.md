# AGENTS.md

本仓库是对 Typora（Windows）激活机制的逆向研究与补丁工具，入口只有一个：`pnpm hack`。

## 概述

- 本项目是什么：一份逆向研究报告（`docs/researches/`）+ 一个把补丁写进 Typora `app.asar` 的脚本（`src/`）。
- 交付物：`pnpm hack` 让本机 Typora 进入已激活状态；`pnpm hack --restore` 回滚。

## 边界与范围

- 范围内：
  - 定位 Typora 安装目录、备份与恢复原始 `app.asar`。
  - 从包内 `package.json` 的 `main` 读出入口文件，生成并注入补丁源码。
  - 写入 `HKCU\SOFTWARE\Typora` 下的 `SLicense` / `IDate`。
  - 启动 Typora 并从 `%APPDATA%\Typora\typora.log` 验收；失败且可归因于补丁时自动回滚。
  - 从 `.env` 读取可自定义的邮箱与序列号。
- 非目标（明确排除）：
  - 不搭建本地许可证网关、不改 hosts、不替换 DNS。
  - 不修改 V8 字节码（`.jsc`）——所有改动都落在明文入口上。
  - 不做跨平台支持。
  - 不做通用「逆向框架」或 GUI。

## Agent 操作指南

- 如何理解本项目：先读 `docs/researches/activation-mechanism.md` 了解被改对象的机制，
  再读 `docs/ARCHITECTURE.md` 了解本仓库如何落刀。
- 全局规则 / 约定：
  - **禁止硬编码 Typora 的文件名与版本相关常量**：入口名一律走 `package.json` 的 `main`，
    自校验基准与长度在打包时现算，许可证字段值走 `src/config.ts`。
  - `src/inject/patch.js` 是被注入到 Typora 里的源码，**保持 ES5 语法**（它跑在 Typora 的模块作用域里），
    只允许在其中使用 `__HAPORA_*__` 形式的占位符，且每个占位符全文件只出现一次。
  - 自校验放行必须**同时保留读取层（fs）与哈希层（crypto.createHash）**：
    两层各自都足以单独通过校验，互为兜底。
  - 补丁必须先备份再改写；任何时候都要保证 `--restore` 可用。
  - 修改补丁后必须跑一次 `pnpm hack --yes`，验收标准是日志中同时满足
    `[watch L] hasL: true`、`[renewLicense]: license renewed`，且启动 1s 后**没有**
    `Integrity check failed`、没有 `onUnfillLicense`、进程不退出。
  - 文档更新遵循 `scaffold-docs`：README / AGENTS 不写实现细节，实现细节进 `docs/`。
  - **仓库内不得携带任何截图或二进制图片**（`*.png` / `*.jpg` / `*.gif` / `*.webp` / `*.bmp` 等）。
    需要留证的场景一律写成可复现的文字判据（日志关键字、命令、期望输出），由验收过程现场产生。

## 目录速查

- `src/hack.ts` — CLI 入口，编排备份 → 注入 → 打包 → 写注册表 → 验收/回滚。
- `src/patch.ts` — 补丁模板的加载、占位符渲染、注入与剥除；注册表值的格式定义。
- `src/inject/patch.js` — 真正被注入到 Typora 入口文件的代码。
- `src/config.ts` — 邮箱 / 序列号的可自定义项，来源优先级与默认值。
- `src/asar.ts` — `app.asar` 解包 / 打包 / 读单文件 / 读 `main`。
- `src/registry.ts` — `HKCU\SOFTWARE\Typora` 读写。
- `src/typora.ts` — 安装定位、备份/恢复、进程检测与启动。
- `.env.example` — 可自定义项的模板（`.env` 本身不入库）。
- `docs/researches/activation-mechanism.md` — 逆向研究报告（被改对象的机制）。
- `docs/PRD.md` / `docs/ARCHITECTURE.md` / `docs/DECISIONS.md` — 产品目标、结构、决策记录。
- `docs/specs/` — 各模块的行为规格（含可复现的验收判据）。
