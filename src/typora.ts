/**
 * Typora 安装定位、备份管理，以及在系统目录（需要管理员）下的写入。
 *
 * 写入是唯一需要管理员权限的动作：解包 / 注入 / 打包全在 %TEMP% 里完成，
 * 最后只把成品复制进安装目录。目录不可写时用一次 UAC 提权把这批复制做完，
 * 其余流程（写注册表、启动 Typora、读日志验收）仍以普通用户身份进行。
 */

import { existsSync, copyFileSync, writeFileSync, unlinkSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";

export const BACKUP_SUFFIX = ".hapora-orig.bak";

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

export function locate(): TyporaInstall | null {
  const candidates: string[] = [];

  // 1. 系统级安装
  const pf = process.env["ProgramFiles"];
  if (pf) candidates.push(join(pf, "Typora"));
  const pf86 = process.env["ProgramFiles(x86)"];
  if (pf86) candidates.push(join(pf86, "Typora"));

  // 2. 用户级安装
  const local = process.env.LOCALAPPDATA;
  if (local) candidates.push(join(local, "Programs", "Typora"));

  for (const dir of candidates) {
    const resources = join(dir, "resources");
    const asar = join(resources, "app.asar");
    if (existsSync(asar)) {
      return { dir, resources, asar, backup: asar + BACKUP_SUFFIX };
    }
  }

  _locateErr = "未找到 Typora 安装。";
  return null;
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
