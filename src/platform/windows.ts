/**
 * Windows 平台实现。
 *
 * 定位：显式指定 → 注册表 App Paths / 文件关联 → PATH → 默认目录 → 卸载表 → 全盘浅扫描。
 * 写入：目录不可写时用一次 UAC 提权批量复制（备份 + 成品一次完成）。
 * 许可证：HKCU\SOFTWARE\Typora 的 SLicense / IDate。
 * 验收：读 %APPDATA%\Typora\typora.log 的关键字（hasL / Integrity check failed / unfill）。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";

import * as reg from "../registry.js";
import { formatDate, licenseValue } from "../patch.js";
import {
  isPermissionError, makeInstall, probeWriteAccess, tryExec,
  type CopyJob, type LicenseInput, type LicenseView, type Platform, type ProbeState, type TyporaInstall,
} from "./types.js";
import { scanRootsForInstall, type ScanSpec } from "./scan.js";

const ASAR_REL = "resources/app.asar";
const EXE_REL = "Typora.exe";

/**
 * Running the Windows implementation from a WSL host: Windows paths must be mapped to the
 * /mnt/<drive> view for Node's fs, and Windows executables must be invoked with an explicit
 * .exe suffix. Actual Windows hosts keep the native behaviour (every helper is identity).
 */
const IS_WSL =
  process.platform === "linux" &&
  !!(process.env["WSL_DISTRO_NAME"] || process.env["WSL_INTEROP"]);

let _locateErr = "";

/** A path as the host filesystem sees it (WSL: /mnt/c/...; Windows: unchanged). */
function toHostPath(raw: string): string {
  if (!IS_WSL || !raw || raw.startsWith("/")) return raw;
  const converted = tryExec("wslpath", ["-u", raw])?.trim();
  if (converted) return converted;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(raw);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, "/")}`;
  return raw.replace(/\\/g, "/");
}

/** A host path as Windows tools see it (WSL: C:\...; Windows: unchanged). */
function toWindowsPath(raw: string): string {
  if (!IS_WSL) return raw;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) return raw;
  const converted = tryExec("wslpath", ["-w", raw])?.trim();
  if (converted) return converted;
  const mount = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(raw);
  if (mount) return `${mount[1]!.toUpperCase()}:\\${(mount[2] ?? "").replace(/\//g, "\\")}`;
  return raw;
}

/** True when a host path lives on a Windows-visible drive. */
function isWindowsVisible(p: string): boolean {
  return !IS_WSL || /^\/mnt\/[a-z](?:\/|$)/i.test(p);
}

/** Windows environment variable; under WSL it is resolved through cmd.exe. */
function winEnv(name: string): string | undefined {
  const own = process.env[name];
  if (own) return own;
  if (!IS_WSL) return undefined;
  const out = tryExec("cmd.exe", ["/c", "echo", `%${name}%`])?.trim();
  if (!out || out === `%${name}%`) return undefined;
  return out;
}

/** 从「exe 路径」或「命令行」里解出安装目录。 */
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
  return p.toLowerCase().endsWith(".exe") ? win32.dirname(p) : null;
}

const CUV = "Microsoft\\Windows\\CurrentVersion";

/** 注册表 App Paths 与文件关联里的候选目录（官方安装器一定会写，最可靠）。 */
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
  const out = tryExec("where.exe", ["Typora.exe"]);
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^INFO:/i.test(l))
    .map((p) => win32.dirname(p));
}

/** 三个默认安装位置。 */
function defaultCandidates(): string[] {
  const dirs: string[] = [];
  const pf = winEnv("ProgramFiles");
  if (pf) dirs.push(win32.join(pf, "Typora"));
  const pf86 = winEnv("ProgramFiles(x86)");
  if (pf86) dirs.push(win32.join(pf86, "Typora"));
  const local = winEnv("LOCALAPPDATA");
  if (local) dirs.push(win32.join(local, "Programs", "Typora"));
  return dirs;
}

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

const SCAN_SKIP = [
  "windows", "$recycle.bin", "system volume information", "programdata", "recovery",
  "perflogs", "config.msi", "msocache", "appdata", "$windows.~bt", "$windows.~ws",
  "onedrivetemp", "intel", "amd", "nvidia",
];

const SCAN_SPEC: ScanSpec = {
  names: ["typora"],
  probe: (dir) => existsSync(join(dir, ...ASAR_REL.split("/"))),
  commonSubdirs: COMMON_SUBDIRS,
  skip: SCAN_SKIP,
  maxDepth: 3,
  maxDirs: 20000,
};

function driveRoots(): string[] {
  const roots: string[] = [];
  if (IS_WSL) {
    for (let c = "c".charCodeAt(0); c <= "z".charCodeAt(0); c++) {
      const root = `/mnt/${String.fromCharCode(c)}`;
      if (existsSync(root)) roots.push(root);
    }
    return roots;
  }
  for (let c = "C".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

/** 全盘浅扫描（供定位的最后一环使用）。 */
export function scanDrives(): string[] {
  return scanRootsForInstall(driveRoots(), SCAN_SPEC);
}

/* ---------------- 写入（唯一需要管理员权限的一步） ---------------- */

const ELEVATED_OK = "HAPORA-OK";

/**
 * 用一次 UAC 提权，把一批文件复制进安装目录。
 *
 * 把复制动作写成一个临时 .cmd（路径全绝对、无 shell 转义问题），
 * 用 Start-Process -Verb RunAs 以管理员身份执行并等它退出。
 * 成败不看 PowerShell 的退出码（-Verb RunAs 下不可靠），只看 .cmd 留下的标记文件。
 */
function elevatedCopy(jobs: CopyJob[]): void {
  if (IS_WSL) {
    elevatedCopyWsl(jobs);
    return;
  }

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

    runElevatedHelper(helper, status);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * WSL variant: the elevated .cmd must itself live on a Windows-visible drive, and every
 * path inside it must be a Windows path. WSL-only sources (e.g. the staged asar in /tmp)
 * are copied into %TEMP% first.
 */
function elevatedCopyWsl(jobs: CopyJob[]): void {
  const winTemp = winEnv("TEMP") ?? winEnv("TMP");
  if (!winTemp) throw new Error("读不到 Windows 的 TEMP 目录，无法准备提权脚本。");
  const dir = mkdtempSync(join(toHostPath(winTemp), "hapora-elev-"));
  const helper = join(dir, "elevated-copy.cmd");
  const status = join(dir, "status.txt");
  try {
    const lines = ["@echo off"];
    jobs.forEach((job, i) => {
      if (!isWindowsVisible(job.to)) {
        throw new Error(`提权写入目标不在 Windows 可访问的路径下：${job.to}`);
      }
      let from = job.from;
      if (!isWindowsVisible(from)) {
        const staged = join(dir, `${i}-${basename(from)}`);
        copyFileSync(from, staged);
        from = staged;
      }
      lines.push(`copy /y "${toWindowsPath(from)}" "${toWindowsPath(job.to)}" >nul 2>&1`);
      lines.push("if errorlevel 1 exit /b 1");
    });
    lines.push(`echo ${ELEVATED_OK}> "${toWindowsPath(status)}"`, "exit /b 0");
    writeFileSync(helper, lines.join("\r\n") + "\r\n", "utf-8");

    runElevatedHelper(toWindowsPath(helper), status);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runElevatedHelper(helper: string, status: string): void {
  const script =
    `$p = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', '"${helper}"' ` +
    `-Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
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
}

export const windowsPlatform: Platform = {
  id: "win32",
  label: "Windows",

  locate(overrideDir?: string): TyporaInstall | null {
    _locateErr = "";

    // 显式指定：给了就必须有效，无效就报错——宁可让用户改路径，也不要静默猜到别处去
    const override = (overrideDir ?? process.env["HAPORA_TYPORA_DIR"] ?? "").trim();
    if (override) {
      const inst = makeInstall(toHostPath(override), ASAR_REL, EXE_REL);
      if (inst) return inst;
      _locateErr =
        `指定的安装目录无效：${override}\n` +
        `  该目录下没有 resources\\app.asar（请确认指向 Typora 安装根目录，而非 resources 或 exe 本身）。` +
        (IS_WSL ? "\n  WSL 里可写 Windows 路径 C:\\... 或挂载路径 /mnt/c/...。" : "");
      return null;
    }

    const tried: string[] = [];
    // 惰性求值：命中即止，代价最大的全盘扫描只在前面全部落空时才跑
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
        const inst = makeInstall(toHostPath(dir), ASAR_REL, EXE_REL);
        if (inst) return inst;
      }
    }

    _locateErr =
      `未找到 Typora 安装（已尝试：${tried.join("、")}）。\n` +
      `  若 Typora 装在非常规位置，请显式指定安装根目录：\n` +
      `    pnpm hack --dir "D:\\path\\to\\Typora"\n` +
      `  或设置环境变量 HAPORA_TYPORA_DIR。`;
    return null;
  },

  locateError: () => _locateErr,

  isRunning(): boolean {
    const out = tryExec("tasklist.exe", ["/FI", "IMAGENAME eq Typora.exe", "/NH"]);
    return !!out && /Typora\.exe/i.test(out);
  },

  kill(): void {
    try {
      execFileSync("taskkill.exe", ["/IM", "Typora.exe", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* 没有在运行 */
    }
  },

  launch(install: TyporaInstall): void {
    // A detached spawn failure is an async 'error' event; swallow it so verification can
    // report 'gone' and roll back instead of crashing the CLI (same as the Unix path).
    spawn(install.exe, [], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  },

  isAdmin(): boolean {
    try {
      execFileSync("net.exe", ["session"], { windowsHide: true, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },

  asarPatchSupported: true,

  machoPatchSupported: false,

  machoInspect(): never {
    throw new Error("本平台（Windows）不支持 Mach-O 补丁路线。");
  },

  machoApplyPatch(): never {
    throw new Error("本平台（Windows）不支持 Mach-O 补丁路线。");
  },

  checkWriteAccess: (targetPath: string) => probeWriteAccess(targetPath),

  installFiles(jobs: CopyJob[], opts: { elevate: boolean }): void {
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
  },

  licenseSupported: true,
  licenseUnsupportedReason: "",
  licenseStorageLabel: () => "注册表（SLicense / IDate）",

  readLicense(): LicenseView {
    return { license: reg.read("SLicense"), date: reg.read("IDate") };
  },

  writeLicense(input: LicenseInput): void {
    reg.write("SLicense", licenseValue(input.now));
    reg.write("IDate", formatDate(input.now));
  },

  clearLicense(): void {
    reg.write("SLicense", "");
  },

  /** 验收探针：读 typora.log 本次启动片段里的关键字（从 hack.ts 的 verify 下沉而来，行为不变）。 */
  probeActivation(_install: TyporaInstall, launchedAtMs: number): { state: ProbeState; detail: string } {
    const START_MARKER = "------------------start------------------";
    const SETTLE_MS = 6000; // 自校验在启动约 1s 后触发，hasL 必须活过这个窗口才算数
    const appData = winEnv("APPDATA");
    const logPath = join(appData ? toHostPath(appData) : "", "Typora", "typora.log");
    const text = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    const i = text.lastIndexOf(START_MARKER);
    const seg = i >= 0 ? text.slice(i) : "";
    if (/Integrity check failed/.test(seg)) {
      return { state: "lost", detail: `自校验没放行（Integrity check failed）。日志：${logPath}` };
    }
    if (/unfill due to renew fail/.test(seg)) {
      return { state: "lost", detail: `续期被判失败（unfill due to renew fail）。日志：${logPath}` };
    }
    if (/\[watch L\] hasL: true/.test(seg) && Date.now() - launchedAtMs >= SETTLE_MS) {
      return { state: "activated", detail: "[watch L] hasL: true（自校验后仍存活）" };
    }
    return { state: "pending", detail: "" };
  },
};
