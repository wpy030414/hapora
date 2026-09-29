/**
 * Typora 安装定位、备份管理，以及在系统目录（需要管理员）下的写入。
 *
 * 写入是唯一需要管理员权限的动作：解包 / 注入 / 打包全在 %TEMP% 里完成，
 * 最后只把成品复制进安装目录。目录不可写时用一次 UAC 提权把这批复制做完，
 * 其余流程（写注册表、启动 Typora、读日志验收）仍以普通用户身份进行。
 */

import {
  existsSync, copyFileSync, writeFileSync, unlinkSync, mkdtempSync, readFileSync, rmSync, readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";

import * as reg from "./registry.js";

export const BACKUP_SUFFIX = ".hapora-orig.bak";

/**
 * 定位 Typora 安装目录。
 *
 * Typora 默认装到 %ProgramFiles%\Typora，但也可以装到 D 盘、绿色版解压目录等任何位置。
 * 因此这里按「先便宜、后昂贵，命中即止」的顺序汇集候选，**每个候选都只以
 * 该目录下是否存在 resources\app.asar 为准**（与后续步骤用的判据完全一致）：
 *
 *   1. 显式指定：#dir 参数或 HAPORA_TYPORA_DIR 环境变量（宁可报错也不静默猜）
 *   2. 注册表 App Paths\Typora.exe / 文件关联 —— 官方安装器写入，最可靠
 *   3. PATH 上的 Typora.exe（where）
 *   4. 三个默认安装目录
 *   5. 注册表卸载表 InstallLocation（按 DisplayName 匹配，兜住 GUID 命名的键）
 *   6. 全盘浅扫描：各固定盘根下的常见子目录，再退化为深度受限的目录遍历
 *
 * 前 5 步都很便宜（几次 reg 查询 / 目录存在性判断），第 6 步只在前面全部落空时才跑。
 */

export interface TyporaInstall {
  dir: string;
  resources: string;
  asar: string;
  backup: string;
}

let _locateErr = "";

/** 上一次 locate() 返回 null 的原因，供调用方展示给用户。 */
export function locateError(): string {
  return _locateErr;
}

/** 把一个候选目录规范成安装信息；目录里没有 resources\app.asar 就返回 null。 */
function installAt(rawDir: string): TyporaInstall | null {
  const dir = rawDir.trim().replace(/^"+|"+$/g, "").replace(/[\\/]+$/, "");
  if (!dir) return null;
  const resources = join(dir, "resources");
  const asar = join(resources, "app.asar");
  return existsSync(asar) ? { dir, resources, asar, backup: asar + BACKUP_SUFFIX } : null;
}

/**
 * 从「exe 路径」或「命令行」里解出安装目录。
 * 接受 `C:\...\Typora.exe`、`"C:\...\Typora.exe" "%1"`、`"C:\...\uninstall.exe"` 等形态。
 */
function dirFromExe(raw: string | null): string | null {
  if (!raw) return null;
  let p = raw.trim();
  const quoted = p.match(/^"([^"]*\.exe)"/i);
  if (quoted) {
    p = quoted[1];
  } else {
    const end = p.toLowerCase().indexOf(".exe");
    if (end < 0) return null;
    p = p.slice(0, end + 4);
  }
  return p.toLowerCase().endsWith(".exe") ? dirname(p) : null;
}

const CUV = "Microsoft\\Windows\\CurrentVersion";

/** 注册表 App Paths / 文件关联里的候选目录（官方安装器一定会写，最可靠）。 */
function registryCandidates(): string[] {
  const dirs: string[] = [];
  for (const hive of ["HKLM\\SOFTWARE", "HKLM\\SOFTWARE\\WOW6432Node", "HKCU\\SOFTWARE"]) {
    const d = dirFromExe(reg.queryValue(`${hive}\\${CUV}\\App Paths\\Typora.exe`));
    if (d) dirs.push(d);
  }
  for (const key of [
    "HKCR\\Typora.md\\shell\\open\\command",
    "HKCR\\Applications\\Typora.exe\\shell\\open\\command",
  ]) {
    const d = dirFromExe(reg.queryValue(key));
    if (d) dirs.push(d);
  }
  return dirs;
}

interface RegBlock {
  key: string;
  values: Record<string, string>;
}

/** 把 `reg query KEY /s` 的输出切成「键路径 + 该键的值」的块。 */
function parseRegTree(text: string): RegBlock[] {
  const blocks: RegBlock[] = [];
  let cur: RegBlock | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const value = line.match(/^(\(Default\)|[^\s]+)\s+REG_\w+\s+(.*)$/);
    if (value) {
      if (cur) cur.values[value[1]] = value[2].trim();
      continue;
    }
    if (/^HKEY_/i.test(line)) {
      cur = { key: line, values: {} };
      blocks.push(cur);
    }
  }
  return blocks;
}

/** 卸载表里 DisplayName 为 Typora 的条目：取 InstallLocation / UninstallString 的所在目录。 */
function uninstallCandidates(): string[] {
  const dirs: string[] = [];
  for (const base of [
    `HKLM\\SOFTWARE\\${CUV}\\Uninstall`,
    `HKLM\\SOFTWARE\\WOW6432Node\\${CUV}\\Uninstall`,
    `HKCU\\SOFTWARE\\${CUV}\\Uninstall`,
  ]) {
    for (const block of parseRegTree(reg.queryTree(base))) {
      const name = block.values["DisplayName"];
      if (!name || name.trim().toLowerCase() !== "typora") continue;
      const loc = block.values["InstallLocation"];
      if (loc) dirs.push(loc);
      const fromUninstaller = dirFromExe(block.values["UninstallString"] ?? null);
      if (fromUninstaller) dirs.push(fromUninstaller);
    }
  }
  return dirs;
}

/** PATH 上的 Typora.exe。 */
function pathCandidates(): string[] {
  try {
    const out = execFileSync("where", ["Typora.exe"], {
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => dirname(p));
  } catch {
    return [];
  }
}

/** 三个默认安装位置。 */
function defaultCandidates(): string[] {
  const dirs: string[] = [];
  const pf = process.env["ProgramFiles"];
  if (pf) dirs.push(join(pf, "Typora"));
  const pf86 = process.env["ProgramFiles(x86)"];
  if (pf86) dirs.push(join(pf86, "Typora"));
  const local = process.env.LOCALAPPDATA;
  if (local) dirs.push(join(local, "Programs", "Typora"));
  return dirs;
}

/** 全盘浅扫描的常见相对路径，先按名字碰运气，避免一上来就遍历。 */
const COMMON_SUBDIRS = [
  "Typora",
  "Program Files\\Typora",
  "Program Files (x86)\\Typora",
  "Apps\\Typora",
  "Software\\Typora",
  "Tools\\Typora",
  "Programs\\Typora",
  "Portable\\Typora",
  "Green\\Typora",
];

/** 遍历时跳过的目录名（系统目录与体积大的噪声目录），避免全盘扫描过慢。 */
const SCAN_SKIP = new Set([
  "windows", "$recycle.bin", "system volume information", "programdata", "recovery",
  "perflogs", "config.msi", "msocache", "node_modules", ".git", ".cache", "appdata",
  "$windows.~bt", "$windows.~ws", "onedrivetemp", "intel", "amd", "nvidia",
]);
const SCAN_MAX_DEPTH = 3;
/** 遍历目录数的上限，防止在超大目录树上卡死 */
const SCAN_MAX_DIRS = 20000;

function driveRoots(): string[] {
  const roots: string[] = [];
  for (let c = "C".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

/**
 * 在一组根目录下浅扫描 Typora 安装：先试常见子目录，仍无果再按深度受限的 BFS
 * 找名为 Typora 的目录。导出出来是为了能在本地对扫描逻辑做可复现的验证。
 */
export function scanRootsForTypora(roots: string[]): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    for (const sub of COMMON_SUBDIRS) {
      const p = join(root, sub);
      if (existsSync(join(p, "resources", "app.asar"))) hits.push(p);
    }
  }
  if (hits.length) return hits;

  let budget = SCAN_MAX_DIRS;
  const queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));
  while (queue.length && budget-- > 0) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限 / 已失效的目录，跳过
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();
      if (SCAN_SKIP.has(name)) continue;
      const child = join(dir, entry.name);
      if (name === "typora" && existsSync(join(child, "resources", "app.asar"))) {
        hits.push(child);
        continue;
      }
      if (depth + 1 < SCAN_MAX_DEPTH) queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return hits;
}

function scanDrives(): string[] {
  return scanRootsForTypora(driveRoots());
}

export function locate(overrideDir?: string): TyporaInstall | null {
  _locateErr = "";

  // 1. 显式指定：给了就必须有效，无效就报错——宁可让用户改路径，也不要静默猜到别处去
  const override = (overrideDir ?? process.env["HAPORA_TYPORA_DIR"] ?? "").trim();
  if (override) {
    const inst = installAt(override);
    if (inst) return inst;
    _locateErr =
      `指定的安装目录无效：${override}\n` +
      `  该目录下没有 resources\\app.asar（请确认指向 Typora 安装根目录，而非 resources 或 exe 本身）。`;
    return null;
  }

  const tried: string[] = [];

  // 惰性求值：每个来源只在轮到它时才去收集候选，命中即止。
  // 顺序按「便宜 → 昂贵」排：默认目录比卸载表轻，全盘扫描最重。
  const sources: Array<[string, () => string[]]> = [
    ["注册表 App Paths / 文件关联", registryCandidates],
    ["PATH", pathCandidates],
    ["默认安装目录", defaultCandidates],
    ["注册表卸载表", uninstallCandidates],
    ["全盘浅扫描", scanDrives],
  ];

  for (const [label, gather] of sources) {
    tried.push(label);
    for (const dir of gather()) {
      const inst = installAt(dir);
      if (inst) return inst;
    }
  }

  _locateErr =
    `未找到 Typora 安装（已尝试：${tried.join("、")}）。\n` +
    `  若 Typora 装在非常规位置，请显式指定安装根目录：\n` +
    `    pnpm hack --dir "D:\\path\\to\\Typora"\n` +
    `  或设置环境变量 HAPORA_TYPORA_DIR。`;
  return null;
}

/** 探测目标 asar 所在目录是否有写入权限。 */
export function checkWriteAccess(asarPath: string): boolean {
  const probe = asarPath + ".hapora-write-test";
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** 检测当前进程是否以管理员权限运行（Windows）。 */
export function isAdmin(): boolean {
  try {
    execFileSync("net", ["session"], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface CopyJob {
  from: string;
  to: string;
}

/** 提权复制的结果标记文件内容 */
const ELEVATED_OK = "HAPORA-OK";

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EACCES";
}

/**
 * 用一次 UAC 提权，把一批文件复制进安装目录。
 *
 * 具体做法：把复制动作写成一个临时 .cmd（路径全部绝对、不带任何 shell 转义问题），
 * 再用 Start-Process -Verb RunAs 以管理员身份执行它，并等它退出。
 * 成败不看 PowerShell 的退出码（-Verb RunAs 下它并不可靠），只看 .cmd 自己留下的标记文件。
 */
function elevatedCopy(jobs: CopyJob[]): void {
  const dir = mkdtempSync(join(tmpdir(), "hapora-elev-"));
  const helper = join(dir, "elevated-copy.cmd");
  const status = join(dir, "status.txt");
  try {
    const lines = ["@echo off"];
    for (const job of jobs) {
      lines.push(`copy /y "${job.from}" "${job.to}" >nul 2>&1`);
      lines.push("if errorlevel 1 exit /b 1");
    }
    lines.push(`echo ${ELEVATED_OK}> "${status}"`, "exit /b 0");
    writeFileSync(helper, lines.join("\r\n") + "\r\n", "utf-8");

    const script =
      `$p = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', '"${helper}"' ` +
      `-Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
    try {
      execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer }).stderr ?? "").trim();
      throw new Error(
        `提权失败（可能是在 UAC 弹窗里点了「否」）。${stderr ? `powershell: ${stderr}` : ""}`.trim(),
      );
    }

    if (!existsSync(status) || readFileSync(status, "utf-8").trim() !== ELEVATED_OK) {
      throw new Error("提权后的复制没有完成（目标文件可能被占用或磁盘只读）");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 把成品写进安装目录 —— 所有需要写权限的落点都走这里。
 *
 * elevate=false 时直接复制；true 时直接走提权。
 * 另外无论调用方怎么判断，复制真的被拒了都会自动退到提权一次，避免因 ACL 细节误判而失败。
 */
export function installFiles(jobs: CopyJob[], opts: { elevate: boolean }): void {
  if (jobs.length === 0) return;
  if (!opts.elevate) {
    try {
      for (const job of jobs) copyFileSync(job.from, job.to);
      return;
    } catch (err) {
      if (!isPermissionError(err)) throw err;
    }
  }
  elevatedCopy(jobs);
}

export function isRunning(): boolean {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Typora.exe", "/NH"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    return /Typora\.exe/i.test(out);
  } catch {
    return false;
  }
}

export function kill(): void {
  try {
    execFileSync("taskkill", ["/IM", "Typora.exe", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {
    /* 没有在运行 */
  }
}

export function launch(install: TyporaInstall): void {
  spawn(join(install.dir, "Typora.exe"), [], { detached: true, stdio: "ignore" }).unref();
}
