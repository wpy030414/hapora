/**
 * pnpm hack —— Typora 激活工具的唯一入口。
 *
 * 做的事（按平台能力自动裁剪）：
 *   1. 定位 Typora 安装（Windows/Linux 为含 app.asar 的目录；macOS 为 .app 包）
 *   2. [asar 路线，Windows/Linux] 把 src/inject/patch.js 注入明文入口、重新打包、
 *      连同备份一起写进安装目录；写不动时只对这一批复制做一次平台提权（UAC / sudo）
 *   3. [Mach-O 路线，macOS] 在二进制 `-[LicenseManager renew]` 入口写 ret 补丁并 ad-hoc
 *      重签（包外备份，字节等价可还原）；首次改包可能触发 TCC「App Management」
 *      一次性授权弹窗，属预期交互
 *   4. 写入许可证（Windows 为注册表 SLicense / IDate；macOS 为加密记录文件，
 *      lastTry 金丝雀落在续期窗口之外——记录存活本身即证明补丁生效）
 *   5. 启动 Typora 验收（Windows 读 typora.log 关键字；macOS 轮询记录状态与进程存活）；
 *      验收失败且可归因时自动回滚
 *
 * 不对 Typora 版本、入口文件名、字节码文件名、安装位置、补丁偏移做任何硬编码假设。
 * 平台差异全部收敛在 src/platform/，本文件只做编排（按能力位分支，不按平台名）。
 *
 * 参数：
 *   --dir <路径> 显式指定 Typora 安装根目录（装在非常规位置时用）
 *   --no-verify  做完后不启动验收（默认会验收）
 *   --restore    从备份回滚
 *   --status     只打印当前状态
 *   --yes, -y    跳过确认（Typora 正在运行时）
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { pack, readEntry, readMain, unpack } from "./asar.js";
import * as tp from "./typora.js";
import { loadConfig, LICENSE_SHAPE, repoRoot, type Config } from "./config.js";
import { inject, isPatched, stripPatch, loadTemplate } from "./patch.js";

const argv = process.argv.slice(2);
const has = (...names: string[]) => names.some((n) => argv.includes(n));

/** 取 `--flag value` 或 `--flag=value` 的值 */
function flagValue(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const VERIFY_TIMEOUT_MS = 45_000;

const say = (msg = "") => console.log(msg);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => console.log(`  ✗ ${msg}`);

/** 改写对象的措辞：asar 路线是 app.asar，Mach-O 路线是 Typora 二进制 */
const TARGET_LABEL = tp.asarPatchSupported() ? "app.asar" : "Typora 二进制";

/**
 * [asar 路线] 判断备份该怎么处理（只看状态，不落盘——真正的写入统一在 installFiles 里做）：
 *   - 没有备份      → 建一份
 *   - 备份已过期    → 刷新（当前 asar 的入口与备份记录的不一致 ⇒ 被重装/升级过）
 *   - 当前已被改过  → 保留旧备份（它才是原始内容的来源）
 */
function planAsarBackup(install: tp.TyporaInstall): "created" | "refreshed" | "kept" {
  if (!existsSync(install.backup)) return "created";
  const backedEntry = readMain(install.backup);
  const currentEntry = readMain(install.target);
  const current = readEntry(install.target, currentEntry);
  if (currentEntry !== backedEntry || (!isPatched(current) && current !== readEntry(install.backup, backedEntry))) {
    return "refreshed";
  }
  return "kept";
}

/**
 * [记录路线] macOS 的备份规划：备份对象是许可证记录文件（随用户数据走，与 Typora 版本无关），
 * 因此只有「首次创建」与「沿用已有备份」两种状态——已有备份永远指向最早的原始记录。
 */
function planRecordBackup(install: tp.TyporaInstall): "created" | "kept" {
  return existsSync(install.backup) ? "kept" : "created";
}

function printStatus(install: tp.TyporaInstall, config: Config): void {
  say("当前状态");
  say(`  安装目录    ${install.dir}`);
  say(`  目标文件    ${install.target}`);
  say(`  备份        ${existsSync(install.backup) ? install.backup : "（无）"}`);
  if (tp.asarPatchSupported()) {
    try {
      const entry = readMain(install.target);
      const patched = isPatched(readEntry(install.target, entry));
      say(`  入口文件    ${entry}  ${patched ? "（已注入补丁）" : "（原始）"}`);
      if (existsSync(install.backup)) {
        const backedEntry = readMain(install.backup);
        if (backedEntry !== entry) say(`  ! 备份记录的是另一个入口：${backedEntry}（下次 hack 会刷新备份）`);
      }
    } catch (err) {
      say(`  入口文件    读取失败：${(err as Error).message}`);
    }
  }
  if (tp.machoPatchSupported()) {
    try {
      const insp = tp.machoInspect(install);
      say(`  二进制补丁  ${insp.patched ? "已补丁（renew 短路）" : insp.partial ? "部分补丁（异常，重跑 pnpm hack 补齐）" : "未补丁"}`);
      say(`  签名        ${insp.signature === "adhoc" ? "ad-hoc（hapora 重签）" : insp.signature === "developer-id" ? "Developer ID（原始）" : "未知"}`);
      say(`  二进制备份  ${insp.backupDir ?? "（无）"}`);
    } catch (err) {
      say(`  二进制补丁  巡检失败：${(err as Error).message}`);
    }
  }
  const lic = tp.readLicense();
  if (tp.asarPatchSupported()) {
    say(`  SLicense    ${(lic.license ?? "").slice(0, 60) || "（空）"}`);
    say(`  IDate       ${lic.date ?? "（空）"}`);
  } else {
    say(`  许可证状态  ${lic.license ?? "未激活"}`);
    if (lic.date) say(`  安装日期    ${lic.date}`);
  }
  say(`  邮箱        ${config.email}`);
  say(`  序列号      ${config.licenseCode}`);
  say();
}

async function doRestore(install: tp.TyporaInstall, elevate: boolean): Promise<void> {
  // Mach-O 路线：优先还原二进制 + CodeResources（字节等价拷回 ⇒ Developer ID 签名自愈，无需再签）
  let machoJobs: tp.CopyJob[] = [];
  if (tp.machoPatchSupported()) {
    const insp = tp.machoInspect(install);
    if (insp.backupDir) {
      machoJobs = [
        { from: join(insp.backupDir, basename(install.exe)), to: install.exe },
        { from: join(insp.backupDir, "CodeResources"), to: join(install.dir, "Contents", "_CodeSignature", "CodeResources") },
      ];
    } else if (insp.patched || insp.partial) {
      bad(`二进制已打补丁但备份缺失，无法还原二进制（可重装 Typora 恢复原始签名）。`);
      process.exitCode = 1;
    } else {
      say("二进制未打补丁，跳过二进制还原。");
    }
  }

  if (!existsSync(install.backup)) {
    if (machoJobs.length === 0) {
      say(`找不到备份 ${install.backup}，无法回滚。`);
      process.exitCode = 1;
      return;
    }
    say(`许可证记录备份不存在（${install.backup}），仅还原二进制。`);
  }

  if (tp.isRunning()) {
    say("检测到 Typora 正在运行，先关闭它…");
    tp.kill();
    await new Promise((r) => setTimeout(r, 1500));
  }
  // 二进制还原与记录还原分开走：记录文件在 ~ 下必须保持用户属主，不能混进提权批次
  if (machoJobs.length > 0) tp.installFiles(machoJobs, { elevate });
  if (existsSync(install.backup)) tp.installFiles([{ from: install.backup, to: install.target }], { elevate: false });
  tp.clearLicense();
  if (machoJobs.length > 0) {
    const sig = tp.machoInspect(install).signature;
    ok(`已还原二进制与签名：${sig === "developer-id" ? "Developer ID（原始）" : sig}；许可证记录已还原`);
  } else {
    ok(`已从备份恢复${TARGET_LABEL}，并清空许可证记录`);
  }
  say("  重新打开 Typora 即回到未激活状态。");
}

type Verdict = { activated: boolean; fatal: boolean; detail: string };

/**
 * 启动 Typora 并轮询平台验收探针。
 * fatal=true 表示失败可归因于本次改动（激活被撤销 / 自校验没放行 / 进程退出）⇒ 应当回滚。
 */
async function verify(install: tp.TyporaInstall): Promise<Verdict> {
  tp.launch(install);
  const startedAt = Date.now();
  while (Date.now() - startedAt < VERIFY_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 700));
    const probe = tp.probeActivation(install, startedAt);
    if (probe.state === "activated") return { activated: true, fatal: false, detail: probe.detail };
    if (probe.state === "lost" || probe.state === "gone") {
      return { activated: false, fatal: true, detail: probe.detail };
    }
  }
  return { activated: false, fatal: false, detail: `等待 ${VERIFY_TIMEOUT_MS / 1000}s 仍未确认激活` };
}

async function doHack(
  install: tp.TyporaInstall,
  config: Config,
  opts: { verify: boolean; yes: boolean; elevate: boolean },
): Promise<void> {
  say("Typora 激活");
  say();

  if (tp.isRunning()) {
    if (!opts.yes) {
      say("Typora 正在运行。激活需要重启 Typora 使改动生效，请先关闭它，");
      say("或在确认没有未保存内容后重新执行：  pnpm hack --yes");
      process.exitCode = 1;
      return;
    }
    say("检测到 Typora 正在运行，先关闭它…");
    tp.kill();
    await new Promise((r) => setTimeout(r, 1500));
  }

  const asarRoute = tp.asarPatchSupported();
  const machoRoute = tp.machoPatchSupported();
  let backupState: "created" | "refreshed" | "kept";
  let machoRollbackJobs: tp.CopyJob[] = [];

  if (asarRoute) {
    // ---- asar 路线（Windows/Linux）：备份 → 注入 → 临时目录打包 → 落盘 ----

    // 1. 备份（只定状态，落盘和补丁一起在最后一次性做掉）
    backupState = planAsarBackup(install);
    // 备份要（重新）建时，它的来源就是当前的 app.asar；否则以已有备份为准
    const source = backupState === "kept" ? install.backup : install.target;

    // 2. 注入（入口名来自包内 package.json 的 main）
    const entryName = readMain(source);
    const original = stripPatch(readEntry(source, entryName));
    if (isPatched(original)) throw new Error("备份里的入口文件已含补丁，请先回滚");
    const result = inject(entryName, original, loadTemplate(), config);
    ok(`入口 ${entryName}：原始 ${Buffer.byteLength(original)}B → 注入后 ${result.selfLen}B`);

    // 3. 打包到临时目录 —— 全程在本用户可写的目录里做，不碰安装目录
    const work = mkdtempSync(join(tmpdir(), "hapora-"));
    try {
      const staged = join(work, "app.asar");
      await unpack(source, join(work, "unpacked"));
      writeFileSync(join(work, "unpacked", entryName), result.patched);
      await pack(join(work, "unpacked"), staged);

      // 4. 落盘 —— 唯一需要管理员权限的一步；备份先写、成品后写，一次做完
      const jobs: tp.CopyJob[] = [];
      if (backupState !== "kept") jobs.push({ from: install.target, to: install.backup });
      jobs.push({ from: staged, to: install.target });
      tp.installFiles(jobs, { elevate: opts.elevate });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    if (backupState === "created") ok(`已备份原始 app.asar → ${install.backup}`);
    else if (backupState === "refreshed") ok("检测到 Typora 被重装/升级，已刷新原始备份");
    else ok("已存在原始备份，跳过备份");
    ok(opts.elevate ? "app.asar 已重新打包，并提权写入安装目录" : "app.asar 已重新打包并写入安装目录");
  } else if (machoRoute) {
    // ---- Mach-O 路线（macOS）：二进制补丁 + 重签 → 伪造记录 ----

    if (!existsSync(install.target)) {
      bad(`许可证记录文件不存在：${install.target}`);
      say("  Typora 至少要完整启动过一次才会生成它。请先启动 Typora 再重新执行。");
      process.exitCode = 1;
      return;
    }

    // 1. 记录备份独立走用户态（~/Library 永远可写，绝不混入二进制的提权批次——混入会被 chown 成 root）
    backupState = planRecordBackup(install);
    if (backupState === "created") {
      tp.installFiles([{ from: install.target, to: install.backup }], { elevate: false });
      ok(`已备份原始许可证记录 → ${install.backup}`);
    } else {
      ok("已存在原始记录备份，跳过备份（它始终指向最早的原始状态）");
    }

    // 2. 二进制补丁（事务化：定位 → 备份 → 覆盖 → ad-hoc 重签 → 复检；失败自动紧急还原）
    const macho = tp.machoApplyPatch(install, { elevate: opts.elevate });
    machoRollbackJobs = macho.rollbackJobs;
    ok(`已定位补丁点：${macho.sites.map((s) => `${s.name}（${s.arch} @0x${s.fileOffset.toString(16)}）`).join("、")}`);
    if (macho.state === "already") {
      ok("二进制已打过补丁，跳过写入（签名校验通过）");
    } else {
      ok("已写入 ret 补丁，并对重签后的磁盘文件复检一致");
      if (macho.resigned) ok("已重签名（ad-hoc：原 entitlements 原样保留 + 追加 disable-library-validation）");
      if (macho.state === "created") ok(`已备份原始二进制与签名 → ${macho.backupDir}`);
      else if (macho.state === "refreshed") ok("检测到 Typora 被重装/升级，已刷新二进制备份");
      else ok("已存在二进制备份，跳过备份");
    }
  } else {
    // 其余平台（记录路线遗留位）：能力位模型下当前无平台落在此分支，防御性退出
    bad("当前平台没有可用的激活路线（既不支持 asar 注入，也不支持 Mach-O 补丁）。");
    process.exitCode = 1;
    return;
  }

  // 5. 许可证（格式由平台实现决定：Windows 写注册表 SLicense/IDate；macOS 伪造记录文件）
  const now = new Date();
  tp.writeLicense({ email: config.email, licenseCode: config.licenseCode, now });
  if (!LICENSE_SHAPE.test(config.licenseCode)) {
    say(`  ! 序列号 ${config.licenseCode} 不匹配 Typora 的 ([A-Z0-9]{6}-){3}[A-Z0-9]{6} 形状，仅作展示用`);
  }
  ok(asarRoute ? "许可证已写入注册表（SLicense / IDate）" : `许可证记录已伪造 → ${install.target}`);

  // 6. 验收（失败且可归因于本次改动时自动回滚）
  say();
  if (!opts.verify) {
    say("完成。重新打开 Typora 即为已激活状态。");
    if (asarRoute) {
      say("跳过验收有风险：若该版本结构与补丁预期不符，Typora 会在启动约 1s 后自行退出。");
    } else if (machoRoute) {
      say("跳过验收有风险：若补丁与该版本结构不符，Typora 可能启动失败或激活被撤销。");
    } else {
      say("跳过验收有风险：若该版本结构与预期不符，激活会在启动后被 Typora 自行撤销。");
    }
    return;
  }

  say("启动 Typora 验收…");
  const verdict = await verify(install);
  if (verdict.activated) {
    ok(`激活成功：${verdict.detail}`);
    return;
  }

  bad(`验收未通过：${verdict.detail}`);
  if (verdict.fatal) {
    say("  激活被 Typora 撤销或进程异常，正在回滚到原始状态…");
    tp.kill();
    await new Promise((r) => setTimeout(r, 1000));
    try {
      // 二进制还原与记录还原分开：记录文件必须保持用户属主，不能混进提权批次
      if (machoRollbackJobs.length > 0) tp.installFiles(machoRollbackJobs, { elevate: opts.elevate });
      tp.installFiles([{ from: install.backup, to: install.target }], { elevate: false });
      tp.clearLicense();
      ok(
        machoRollbackJobs.length > 0
          ? "已回滚：二进制与签名还原为原始 Developer ID 状态，许可证记录已还原"
          : "已回滚。你的 Typora 回到未激活状态，功能不受影响",
      );
    } catch (err) {
      bad(`回滚失败（${(err as Error).message}），请手动执行：  pnpm hack --restore`);
    }
    say(`  请把以下信息连同目标文件状态提供给维护者：${verdict.detail}`);
  } else {
    say("  未发现可归因的错误，改动已保留。可手动启动 Typora 观察是否正常。");
  }
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (has("--help", "-h")) {
    say("用法：pnpm hack [--dir <Typora安装目录>] [--no-verify] [--restore] [--status] [--yes]");
    say("  --dir <路径>  显式指定 Typora 安装根目录（装在非常规位置时使用；也可用环境变量 HAPORA_TYPORA_DIR）");
    say("可自定义：仓库根目录 .env 里的 EMAIL / CODE（也可用环境变量覆盖）");
    return;
  }

  let label: string;
  try {
    label = tp.platformLabel();
  } catch (err) {
    say((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const install = tp.locate(flagValue("--dir"));
  if (!install) {
    say(tp.locateError());
    process.exitCode = 1;
    return;
  }

  // --status 只读，不写任何东西，也不需要许可证存储可用
  if (has("--status")) return printStatus(install, config);

  // 后面都要改写目标文件（app.asar / Typora 二进制）。写不了就提权，但只提权「写文件」那一步：
  // asar 路线的打包在临时目录里做；Mach-O 路线的补丁与 entitlements 也在临时目录里准备。
  // Mach-O 路线必须探测二进制所在目录——install.target 是 ~/Library 的记录文件，恒可写，
  // 探它会误判「无需提权」，然后真正写包时才 EPERM。
  const elevate = !tp.checkWriteAccess(tp.machoPatchSupported() ? install.exe : install.target);
  if (elevate) {
    if (tp.isAdmin()) {
      say(`没有写入权限：${install.exe}`);
      say("  当前已具备管理员权限但仍无法写入，请检查文件是否被占用或磁盘是否可写。");
      process.exitCode = 1;
      return;
    }
    say(`${label}：Typora 位于需要管理员权限的目录（${install.dir}），改写${TARGET_LABEL}需要提权。`);
    if (tp.machoPatchSupported()) {
      say("  补丁与 entitlements 在临时目录里准备，提权一次性用于备份 + 写入 + 重签。");
    } else {
      say("  打包会在临时目录里完成，提权只用来写入文件。");
    }
    say();
  }

  if (has("--restore")) return doRestore(install, elevate);

  // 许可证存储未实现的平台：在改动任何文件之前就退出，
  // 避免留下「打了补丁却没激活」的半成品（比直接失败更难排查）。
  if (!tp.licenseSupported()) {
    say(tp.licenseUnsupportedReason());
    process.exitCode = 1;
    return;
  }

  say(`平台：${label}；邮箱 ${config.email}，序列号 ${config.licenseCode}（来自 ${join(repoRoot(), ".env")} 或默认值）`);
  return doHack(install, config, { verify: !has("--no-verify"), yes: has("--yes", "-y"), elevate });
}

main().catch((err) => {
  console.error(`失败：${err?.message ?? err}`);
  process.exitCode = 1;
});
