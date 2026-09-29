/**
 * 平台抽象层的公共契约。
 *
 * 补丁本身（src/inject/patch.js 的 publicDecrypt hook、electron.net 拦截、fs/crypto 自校验放行）
 * 是平台无关的；真正随平台变的是这六件事：
 *   定位安装目录、进程检测与结束、启动、验收日志路径、写入安装目录（提权）、许可证存储。
 * 前四件事在本层各平台实现；第五件按平台用 UAC / sudo；第六件目前只有 Windows 有实现。
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export const BACKUP_SUFFIX = ".hapora-orig.bak";

export interface TyporaInstall {
  /** 安装根目录（Windows/Linux 为安装目录；macOS 为 .app 包） */
  dir: string;
  /** app.asar 所在目录 */
  resources: string;
  asar: string;
  backup: string;
  /** 启动用的可执行文件 */
  exe: string;
}

export interface CopyJob {
  from: string;
  to: string;
}

/** 写入许可证所需的值；格式由 src/patch.ts 决定，平台只负责落盘 */
export interface LicenseValues {
  /** 展示用明文标记 */
  license: string;
  /** 展示用日期 */
  date: string;
}

export interface LicenseView {
  license: string | null;
  date: string | null;
}

export interface Platform {
  readonly id: string;
  readonly label: string;

  locate(overrideDir?: string): TyporaInstall | null;
  /** 上一次 locate() 返回 null 的原因 */
  locateError(): string;

  isRunning(): boolean;
  kill(): void;
  launch(install: TyporaInstall): void;
  /** 当前进程是否已具备管理员/root 权限 */
  isAdmin(): boolean;

  /** 验收要读的日志文件路径 */
  logPath(): string;

  checkWriteAccess(asarPath: string): boolean;
  /** 把文件写进安装目录；不可写时由 elevate=true 走平台提权 */
  installFiles(jobs: CopyJob[], opts: { elevate: boolean }): void;

  /** 是否支持写入许可证；false 时 hack 必须在改动任何文件之前就退出 */
  readonly licenseSupported: boolean;
  /** 不支持写入许可证时给用户看的原因 */
  readonly licenseUnsupportedReason: string;
  readLicense(): LicenseView;
  /** 写入许可证；平台未实现时抛错 */
  writeLicense(values: LicenseValues): void;
  /** 清空许可证；平台未实现时为 no-op —— --restore 在任何平台都必须可用 */
  clearLicense(): void;
}

/**
 * 把一个候选目录规范成安装信息。
 * 目录里没有 `resources/app.asar`（macOS 为 `Contents/Resources/app.asar`）就返回 null ——
 * 这条判据与后续解包步骤完全一致，因此定位出来的候选不会有误报。
 */
export function makeInstall(dir: string, asarRel: string, exeRel: string): TyporaInstall | null {
  const clean = dir.trim().replace(/^"+|"+$/g, "").replace(/[\\/]+$/, "");
  if (!clean) return null;
  const asar = join(clean, ...asarRel.split("/"));
  if (!existsSync(asar)) return null;
  return {
    dir: clean,
    resources: dirname(asar),
    asar,
    backup: asar + BACKUP_SUFFIX,
    exe: join(clean, ...exeRel.split("/")),
  };
}

/** 目录写入权限探测：真写一个空文件再删掉。 */
export function probeWriteAccess(path: string): boolean {
  const probe = path + ".hapora-write-test";
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** 跑一个外部命令并返回 stdout；失败（非零退出 / 命令不存在）返回 null，不抛错。 */
export function tryExec(cmd: string, args: string[]): string | null {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out;
  } catch {
    return null;
  }
}

/** 是否是「没有写权限」类错误（据此决定要不要退到提权）。 */
export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EACCES";
}
