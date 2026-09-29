/**
 * Unix（macOS / Linux）平台实现的公共部分。
 *
 * 与 Windows 的差别集中在四处：进程检测/结束用 pgrep/pkill、启动直接 exec 可执行文件、
 * 提权用 `sudo -n`（绝不弹交互式密码提示）、许可证存储**尚未实现**。
 *
 * 许可证存储刻意做成「显式抛错」而不是猜一个位置写入：猜错了会产出「打了补丁但没激活」
 * 的半成品，比直接失败更难排查。--restore 在未实现平台上仍是安全的 no-op。
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import {
  isPermissionError, probeWriteAccess, tryExec,
  type CopyJob, type LicenseValues, type LicenseView, type Platform, type TyporaInstall,
} from "./types.js";
import { scanRootsForInstall, type ScanSpec } from "./scan.js";

export interface UnixSpec {
  id: "darwin" | "linux";
  label: string;
  /** 自动定位时按优先级返回候选安装根 */
  candidates(): string[];
  /** 把一个候选路径解析成安装信息（macOS 需要处理 .app 包内的子路径） */
  resolve(raw: string): TyporaInstall | null;
  /** 兜底浅扫描的根目录 */
  scanRoots(): string[];
  scanSpec: ScanSpec;
  /** 验收日志路径 */
  logPath(): string;
  /** 显式指定无效时给用户的形态提示 */
  overrideHint: string;
}

/** 用 `sudo -n`（非交互）把一批文件复制进安装目录；需要密码时立即失败而不是挂住。 */
function elevatedCopyUnix(jobs: CopyJob[], dir: string): void {
  const work = mkdtempSync(join(tmpdir(), "hapora-elev-"));
  const script = join(work, "elevated-copy.sh");
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  try {
    const lines = ["#!/bin/sh", "set -e"];
    for (const job of jobs) lines.push(`cp -f ${quote(job.from)} ${quote(job.to)}`);
    writeFileSync(script, lines.join("\n") + "\n", { encoding: "utf-8", mode: 0o700 });

    if (tryExec("sudo", ["-n", "sh", script]) === null) {
      throw new Error(
        `写入 ${dir} 需要管理员权限，且当前无法免密提权。\n` +
        `  请先执行 \`sudo -v\` 缓存凭据后再运行 pnpm hack，或给该目录写权限。`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const LICENSE_UNSUPPORTED =
  "本平台（macOS / Linux）的许可证存储位置尚未确认——Windows 用的是 HKCU\\SOFTWARE\\Typora，\n" +
  "  而 macOS / Linux 的落点（文件 / plist / keychain）没有经过实证，猜着写会产出「打了补丁却没激活」\n" +
  "  且难以排查的半成品。因此这里选择显式失败，不改动任何文件。详见 docs/DECISIONS.md ADR-010。";

export function createUnixPlatform(spec: UnixSpec): Platform {
  let locateErr = "";

  return {
    id: spec.id,
    label: spec.label,

    locate(overrideDir?: string): TyporaInstall | null {
      locateErr = "";

      // 显式指定：给了就必须有效，无效就报错——宁可让用户改路径，也不要静默猜到别处去
      const override = (overrideDir ?? process.env["HAPORA_TYPORA_DIR"] ?? "").trim();
      if (override) {
        const inst = spec.resolve(override);
        if (inst) return inst;
        locateErr = `指定的安装目录无效：${override}\n  ${spec.overrideHint}`;
        return null;
      }

      const tried: string[] = [];
      // 惰性求值：命中即止，浅扫描只在前面落空时才跑
      const sources: Array<[string, () => string[]]> = [
        ["常见安装位置与 PATH", spec.candidates],
        ["浅扫描", () => scanRootsForInstall(spec.scanRoots(), spec.scanSpec)],
      ];

      for (const [label, gather] of sources) {
        tried.push(label);
        for (const raw of gather()) {
          const inst = spec.resolve(raw);
          if (inst) return inst;
        }
      }

      locateErr =
        `未找到 Typora 安装（已尝试：${tried.join("、")}）。\n` +
        `  若 Typora 装在非常规位置，请显式指定安装根目录：\n` +
        `    pnpm hack --dir "/path/to/Typora"\n` +
        `  ${spec.overrideHint}\n` +
        `  或设置环境变量 HAPORA_TYPORA_DIR。`;
      return null;
    },

    locateError: () => locateErr,

    isRunning: () => tryExec("pgrep", ["-x", "Typora"]) !== null,

    kill(): void {
      tryExec("pkill", ["-x", "Typora"]);
    },

    launch(install: TyporaInstall): void {
      spawn(install.exe, [], { detached: true, stdio: "ignore" }).unref();
    },

    isAdmin: () => typeof process.getuid === "function" && process.getuid() === 0,

    logPath: () => spec.logPath(),

    checkWriteAccess: (asarPath: string) => probeWriteAccess(asarPath),

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
      elevatedCopyUnix(jobs, dirname(jobs[0].to));
    },

    licenseSupported: false,
    licenseUnsupportedReason: LICENSE_UNSUPPORTED,

    readLicense: (): LicenseView => ({ license: null, date: null }),

    writeLicense(_values: LicenseValues): void {
      throw new Error(LICENSE_UNSUPPORTED);
    },

    clearLicense(): void {
      /* 未实现存储 ⇒ 没有可清的东西；--restore 在此平台依然安全 */
    },
  };
}
