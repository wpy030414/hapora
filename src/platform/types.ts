/**
 * 平台抽象层的公共契约。
 *
 * 补丁本身（Windows/Linux 的 src/inject/patch.js）是平台无关的；真正随平台变的是这几件事：
 *   定位安装目录、进程检测与结束、启动、写入目标与提权、许可证存储、启动验收探针。
 * 三条路线按能力位选择：asar 注入（Windows/Linux）、Mach-O 补丁 + ad-hoc 重签（macOS，ADR-012；
 * 许可证存储仍是 ~/Library 下的记录文件，由补丁保证它永不过期）。
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const BACKUP_SUFFIX = ".hapora-orig.bak";

export interface TyporaInstall {
  /** 安装根目录（Windows/Linux 为安装目录；macOS 为 .app 包） */
  dir: string;
  /** 本平台被改写的目标文件：Windows/Linux 为 app.asar；macOS 为许可证记录文件 */
  target: string;
  /** target 的原始备份（target + BACKUP_SUFFIX） */
  backup: string;
  /** 启动用的可执行文件 */
  exe: string;
}

export interface CopyJob {
  from: string;
  to: string;
}

/** 写入许可证所需输入；具体格式由各平台实现决定（Windows：SLicense/IDate；macOS：伪造记录） */
export interface LicenseInput {
  email: string;
  licenseCode: string;
  now: Date;
}

export interface LicenseView {
  license: string | null;
  date: string | null;
}

/** 启动验收探针的结果状态。 */
export type ProbeState =
  /** 已确认激活并稳定 */
  | "activated"
  /** 激活被撤销（可归因于伪造内容，应当回滚） */
  | "lost"
  /** Typora 进程退出 */
  | "gone"
  /** 尚无法终判，继续轮询 */
  | "pending";

/** Mach-O 补丁路线的只读巡检结果（--status 与幂等判定用；永不写盘）。 */
export interface MachoInspection {
  /** 全部补丁目标已在全部切片就位 */
  patched: boolean;
  /** 部分就位（异常态：目标集变化后未补齐 / 二进制被部分替换） */
  partial: boolean;
  /** 签名形态（每次现跑 codesign，绝不缓存） */
  signature: "developer-id" | "adhoc" | "unknown";
  /** 包外二进制备份目录（在位才保证可还原） */
  backupDir: string | null;
  /** 逐站点细节（架构 / 偏移 / 状态），供人读 */
  detail: string;
}

/** Mach-O 补丁路线的一次落地结果。 */
export interface MachoApplyResult {
  /** created=新建备份并补丁；kept=沿用备份补丁；refreshed=升级后刷新备份再补丁；already=已打过零写入 */
  state: "created" | "kept" | "refreshed" | "already";
  /** 每个补丁点（目标名 × 架构 × 文件偏移——对重签后的磁盘文件现算，绝不沿用旧值） */
  sites: Array<{ name: string; arch: string; fileOffset: number }>;
  /** 包外二进制备份目录 */
  backupDir: string;
  /** 还原任务（二进制 + CodeResources 字节等价拷回 ⇒ Developer ID 签名自愈） */
  rollbackJobs: CopyJob[];
  /** 是否执行了 ad-hoc 重签 */
  resigned: boolean;
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

  /**
   * 是否走「解包 app.asar 注入补丁再打包」的路线（Windows/Linux）。
   * macOS 版是原生应用没有 asar，此位为 false。
   */
  readonly asarPatchSupported: boolean;

  /**
   * 是否走「Mach-O 二进制补丁 + ad-hoc 重签」路线（macOS，ADR-012）。
   * 其余平台为 false。
   */
  readonly machoPatchSupported: boolean;

  /** Mach-O 补丁的只读巡检（--status / 幂等判定用）；不支持的平台抛错。 */
  machoInspect(install: TyporaInstall): MachoInspection;

  /**
   * Mach-O 补丁的事务化落地：备份 → 补丁 → ad-hoc 重签 → 对重签后文件复检。
   * 符号缺失等一切不可推导情形在写盘之前抛错（宁失败不猜）。
   */
  machoApplyPatch(install: TyporaInstall, opts: { elevate: boolean }): MachoApplyResult;

  checkWriteAccess(targetPath: string): boolean;
  /** 把文件写进目标位置；不可写时由 elevate=true 走平台提权 */
  installFiles(jobs: CopyJob[], opts: { elevate: boolean }): void;

  /** 是否支持写入许可证；false 时 hack 必须在改动任何文件之前就退出 */
  readonly licenseSupported: boolean;
  /** 不支持写入许可证时给用户看的原因 */
  readonly licenseUnsupportedReason: string;
  readLicense(): LicenseView;
  /** 写入许可证；平台未实现时抛错 */
  writeLicense(input: LicenseInput): void;
  /** 清空许可证；平台未实现时为 no-op —— --restore 在任何平台都必须可用 */
  clearLicense(): void;

  /**
   * 启动验收探针：轮询当前激活观测。Windows 读 typora.log 的关键字（hasL 需过自校验
   * settle 窗口才算数）；macOS 读许可证记录文件是否仍带激活键 + 进程是否存活。
   */
  probeActivation(install: TyporaInstall, launchedAtMs: number): { state: ProbeState; detail: string };
}

/**
 * 把一个候选目录规范成安装信息（Windows/Linux 共用：判据是目录下存在
 * `resources/app.asar`，与后续解包步骤完全一致，因此定位出来的候选不会有误报）。
 */
export function makeInstall(dir: string, targetRel: string, exeRel: string): TyporaInstall | null {
  const clean = dir.trim().replace(/^"+|"+$/g, "").replace(/[\\/]+$/, "");
  if (!clean) return null;
  const target = join(clean, ...targetRel.split("/"));
  if (!existsSync(target)) return null;
  return {
    dir: clean,
    target,
    backup: target + BACKUP_SUFFIX,
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
