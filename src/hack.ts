/**
 * pnpm hack —— Typora 激活补丁的唯一入口。
 *
 * 做的事：
 *   1. 定位 Typora 安装目录，判断是否需要（首次/换版本后）留一份原始 app.asar 备份
 *   2. 从包内 package.json 读出入口文件名，把 src/inject/patch.js 注入其中，打包到临时目录
 *   3. 把备份与成品写进安装目录；写不动时只对这一批复制做一次平台提权（UAC / sudo）
 *   4. 写入许可证（Windows 为注册表 SLicense / IDate）
 *   5. 启动 Typora 并从 typora.log 验收；验收失败且可归因于补丁时自动回滚
 *
 * 不对 Typora 版本、入口文件名、字节码文件名、安装位置做任何硬编码假设。
 * 平台差异全部收敛在 src/platform/，本文件只做编排。
 *
 * 参数：
 *   --dir <路径> 显式指定 Typora 安装根目录（装在非常规位置时用）
 *   --no-verify  打完补丁后不启动验收（默认会验收）
 *   --restore    从备份回滚到原始 app.asar
 *   --status     只打印当前状态
 *   --yes, -y    跳过确认（Typora 正在运行时）
 */

import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { pack, readEntry, readMain, unpack } from "./asar.js";
import * as tp from "./typora.js";
import { loadConfig, LICENSE_SHAPE, repoRoot, type Config } from "./config.js";
import {
  inject, isPatched, stripPatch, loadTemplate,
  licenseValue, formatDate, LICENSE_MARKER,
} from "./patch.js";

const argv = process.argv.slice(2);
const has = (...names: string[]) => names.some((n) => argv.includes(n));

/** 取 `--flag value` 或 `--flag=value` 的值 */
function flagValue(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const START_MARKER = "------------------start------------------";
/** 自校验在启动约 1s 后触发，判定成功必须等它过去 */
const SETTLE_MS = 6000;
const VERIFY_TIMEOUT_MS = 45_000;

const say = (msg = "") => console.log(msg);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => console.log(`  ✗ ${msg}`);

/**
 * 判断备份该怎么处理（只看状态，不落盘——真正的写入统一在 installFiles 里做，可能要提权）：
 *   - 没有备份      → 建一份
 *   - 备份已过期    → 刷新（当前 asar 的入口与备份记录的不一致 ⇒ 被重装/升级过）
 *   - 当前已被改过  → 保留旧备份（它才是原始内容的来源）
 */
function planBackup(install: tp.TyporaInstall): "created" | "refreshed" | "kept" {
  if (!existsSync(install.backup)) return "created";
  const backedEntry = readMain(install.backup);
  const currentEntry = readMain(install.asar);
  const current = readEntry(install.asar, currentEntry);
  if (currentEntry !== backedEntry || (!isPatched(current) && current !== readEntry(install.backup, backedEntry))) {
    return "refreshed";
  }
  return "kept";
}

function printStatus(install: tp.TyporaInstall, config: Config): void {
  say("当前状态");
  say(`  安装目录    ${install.dir}`);
  say(`  备份        ${existsSync(install.backup) ? install.backup : "（无）"}`);
  try {
    const entry = readMain(install.asar);
    const patched = isPatched(readEntry(install.asar, entry));
    say(`  入口文件    ${entry}  ${patched ? "（已注入补丁）" : "（原始）"}`);
    if (existsSync(install.backup)) {
      const backedEntry = readMain(install.backup);
      if (backedEntry !== entry) say(`  ! 备份记录的是另一个入口：${backedEntry}（下次 hack 会刷新备份）`);
    }
  } catch (err) {
    say(`  入口文件    读取失败：${(err as Error).message}`);
  }
  const lic = tp.readLicense();
  say(`  SLicense    ${(lic.license ?? "").slice(0, 60) || "（空）"}`);
  say(`  IDate       ${lic.date ?? "（空）"}`);
  say(`  邮箱        ${config.email}`);
  say(`  序列号      ${config.licenseCode}`);
  say();
}

async function doRestore(install: tp.TyporaInstall, elevate: boolean): Promise<void> {
  if (!existsSync(install.backup)) {
    say(`找不到备份 ${install.backup}，无法回滚。`);
    process.exitCode = 1;
    return;
  }
  if (tp.isRunning()) {
    say("检测到 Typora 正在运行，先关闭它…");
    tp.kill();
    await new Promise((r) => setTimeout(r, 1500));
  }
  tp.installFiles([{ from: install.backup, to: install.asar }], { elevate });
  tp.clearLicense();
  ok("已从备份恢复 app.asar，并清空许可证记录");
  say("  重新打开 Typora 即回到未激活状态。");
}

type Verdict = { activated: boolean; fatal: boolean; detail: string };

/** 只取最后一次启动之后的日志片段，避免读到上一次运行的残留 */
function lastRunSegment(text: string): string {
  const i = text.lastIndexOf(START_MARKER);
  return i >= 0 ? text.slice(i) : "";
}

/**
 * 启动 Typora 并读日志验收。
 * fatal=true 表示失败可归因于补丁（自校验没放行 / 续期被判失败）⇒ 应当回滚。
 */
async function verify(install: tp.TyporaInstall): Promise<Verdict> {
  const logPath = tp.logPath();
  const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf-8") : "");

  const before = readLog();
  const beforeSegment = lastRunSegment(before);

  tp.launch(install);
  const startedAt = Date.now();
  let sawHasL = false;

  while (Date.now() - startedAt < VERIFY_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 700));
    const text = readLog();
    if (text === before) continue; // 还没有新日志
    const seg = lastRunSegment(text);
    if (!seg || seg === beforeSegment) continue; // 仍是上一次启动的片段

    if (/Integrity check failed/.test(seg)) {
      return { activated: false, fatal: true, detail: "自校验没放行（Integrity check failed）" };
    }
    if (/unfill due to renew fail/.test(seg)) {
      return { activated: false, fatal: true, detail: "续期被判失败（unfill due to renew fail）" };
    }
    if (/\[watch L\] hasL: true/.test(seg)) sawHasL = true;
    // hasL 在 ~0.1s 就出现，而自校验在 ~1s 才跑完，所以要等过了 settle 窗口才算数
    if (sawHasL && Date.now() - startedAt >= SETTLE_MS) {
      return { activated: true, fatal: false, detail: "[watch L] hasL: true（自校验后仍存活）" };
    }
  }
  return { activated: false, fatal: false, detail: `等待 ${VERIFY_TIMEOUT_MS / 1000}s 仍未在日志中看到激活标记` };
}

async function doHack(
  install: tp.TyporaInstall,
  config: Config,
  opts: { verify: boolean; yes: boolean; elevate: boolean },
): Promise<void> {
  say("Typora 激活补丁");
  say();

  if (tp.isRunning()) {
    if (!opts.yes) {
      say("Typora 正在运行。补丁需要替换 app.asar，请先关闭 Typora，");
      say("或在确认没有未保存内容后重新执行：  pnpm hack --yes");
      process.exitCode = 1;
      return;
    }
    say("检测到 Typora 正在运行，先关闭它…");
    tp.kill();
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 1. 备份（只定状态，落盘和补丁一起在最后一次性做掉）
  const backupState = planBackup(install);
  // 备份要（重新）建时，它的来源就是当前的 app.asar；否则以已有备份为准
  const source = backupState === "kept" ? install.backup : install.asar;

  // 2. 注入（入口名来自包内 package.json 的 main）
  const entryName = readMain(source);
  const original = stripPatch(readEntry(source, entryName));
  if (isPatched(original)) throw new Error("备份里的入口文件已含补丁，请先回滚");
  const result = inject(entryName, original, loadTemplate(), config);
  ok(`入口 ${entryName}：原始 ${Buffer.byteLength(original)}B → 注入后 ${result.selfLen}B`);
  if (!LICENSE_SHAPE.test(config.licenseCode)) {
    say(`  ! 序列号 ${config.licenseCode} 不匹配 Typora 的 ([A-Z0-9]{6}-){3}[A-Z0-9]{6} 形状，仅作展示用`);
  }

  // 3. 打包到临时目录 —— 全程在本用户可写的目录里做，不碰安装目录
  const work = mkdtempSync(join(tmpdir(), "hapora-"));
  try {
    const staged = join(work, "app.asar");
    await unpack(source, join(work, "unpacked"));
    writeFileSync(join(work, "unpacked", entryName), result.patched);
    await pack(join(work, "unpacked"), staged);

    // 4. 落盘 —— 唯一需要管理员权限的一步；备份先写、成品后写，一次做完
    const jobs: tp.CopyJob[] = [];
    if (backupState !== "kept") jobs.push({ from: install.asar, to: install.backup });
    jobs.push({ from: staged, to: install.asar });
    tp.installFiles(jobs, { elevate: opts.elevate });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (backupState === "created") ok(`已备份原始 app.asar → ${install.backup}`);
  else if (backupState === "refreshed") ok("检测到 Typora 被重装/升级，已刷新原始备份");
  else ok("已存在原始备份，跳过备份");
  ok(opts.elevate ? "app.asar 已重新打包，并提权写入安装目录" : "app.asar 已重新打包并写入安装目录");

  // 5. 许可证
  const today = new Date();
  tp.writeLicense({ license: licenseValue(today), date: formatDate(today) });
  ok(`许可证已写入（明文标记 ${LICENSE_MARKER}）`);

  // 6. 验收（失败且可归因于补丁时自动回滚）
  say();
  if (!opts.verify) {
    say("完成。重新打开 Typora 即为已激活状态。");
    say("跳过验收有风险：若该版本结构与补丁预期不符，Typora 会在启动约 1s 后自行退出。");
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
    say("  该 Typora 版本的结构与补丁预期不符，正在回滚到原始状态…");
    tp.kill();
    await new Promise((r) => setTimeout(r, 1000));
    try {
      tp.installFiles([{ from: install.backup, to: install.asar }], { elevate: opts.elevate });
      tp.clearLicense();
      ok("已回滚。你的 Typora 回到未激活状态，功能不受影响");
    } catch (err) {
      bad(`回滚失败（${(err as Error).message}），请手动执行：  pnpm hack --restore`);
    }
    say(`  请把 ${tp.logPath()} 里最后一次启动的日志提供给维护者。`);
  } else {
    say("  未发现补丁导致的错误，补丁已保留。可手动启动 Typora 观察是否正常。");
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

  // 后面都要改写安装目录里的 app.asar。写不了就提权，但只提权「写文件」那一步：
  // 打包在临时目录里做，Typora 仍以普通用户身份启动与验收。
  const elevate = !tp.checkWriteAccess(install.asar);
  if (elevate) {
    if (tp.isAdmin()) {
      say(`没有写入权限：${install.asar}`);
      say("  当前已具备管理员权限但仍无法写入，请检查文件是否被占用或磁盘是否可写。");
      process.exitCode = 1;
      return;
    }
    say(`${label}：Typora 位于需要管理员权限的目录（${install.dir}），改写 app.asar 需要提权。`);
    say("  打包会在临时目录里完成，提权只用来写入文件。");
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
