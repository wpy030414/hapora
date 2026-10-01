/**
 * Unix（macOS / Linux）平台实现的公共部分。
 *
 * 与 Windows 的差别集中在四处：进程检测/结束用 pgrep/pkill、启动直接 exec 可执行文件、
 * 提权用 `sudo -n`（绝不弹交互式密码提示）、验收/许可证由各平台通过 spec 覆盖
 * （macOS 已实证实现；Linux 尚无实证结论，维持「显式抛错」而不是猜一个位置写入：
 * 猜错了会产出「打了补丁但没激活」的半成品，比直接失败更难排查）。
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import {
  isPermissionError, probeWriteAccess, tryExec,
  type CopyJob, type LicenseInput, type LicenseView, type MachoApplyResult, type MachoInspection,
  type Platform, type ProbeState, type TyporaInstall,
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
  /** 显式指定无效时给用户的形态提示 */
  overrideHint: string;
  /** 是否走 asar 注入路线（macOS 原生应用为 false） */
  asarPatchSupported: boolean;
  /** 是否走 Mach-O 补丁路线（仅 darwin；缺省 false） */
  machoPatchSupported?: boolean;
  /** 平台自己的 Mach-O 补丁实现（可选；缺省为「显式失败」） */
  macho?: Partial<Pick<Platform, "machoInspect" | "machoApplyPatch">>;
  /** 平台自己的许可证实现（可选；缺省为「显式失败」） */
  license?: Partial<Pick<Platform, "licenseSupported" | "licenseUnsupportedReason" | "readLicense" | "writeLicense" | "clearLicense">>;
  /** 平台自己的启动验收探针（可选；缺省为恒 pending——由 CLI 的超时兜底） */
  probeActivation?: Platform["probeActivation"];
}

/** shell 单引号包裹（内部单引号转义成 '\''）。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 用 `sudo -n`（非交互）跑一段 shell 脚本；需要密码时立即失败而不是挂住。
 * 提权脚本必须一次性做完所有需要 root 的动作（备份 + 成品），绝不把整个 CLI 重跑。
 */
export function elevatedRun(lines: string[], desc: string): void {
  const work = mkdtempSync(join(tmpdir(), "hapora-elev-"));
  const script = join(work, "elevated.sh");
  try {
    writeFileSync(script, ["#!/bin/sh", "set -e", ...lines].join("\n") + "\n", { encoding: "utf-8", mode: 0o700 });
    if (tryExec("sudo", ["-n", "sh", script]) === null) {
      throw new Error(
        `${desc}需要管理员权限，且当前无法免密提权。\n` +
        `  请先执行 \`sudo -v\` 缓存凭据后再运行 pnpm hack，或给该目录写权限。`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 用 `sudo -n`（非交互）把一批文件复制进安装目录；需要密码时立即失败而不是挂住。 */
function elevatedCopyUnix(jobs: CopyJob[], dir: string): void {
  elevatedRun(
    jobs.map((job) => `cp -f ${shellQuote(job.from)} ${shellQuote(job.to)}`),
    `写入 ${dir} `,
  );
}

const LICENSE_UNSUPPORTED_LINUX =
  "本平台（Linux）的许可证存储位置尚未确认——Windows 用的是 HKCU\\SOFTWARE\\Typora 的注册表，\n" +
  "  macOS 用的是 ~/Library 下的加密许可证记录文件（已实证），而 Linux（Electron 版）的落点\n" +
  "  没有经过实证，猜着写会产出「打了补丁但没激活」且难以排查的半成品。\n" +
  "  因此这里选择显式失败，不改动任何文件。详见 docs/DECISIONS.md ADR-010 / ADR-011。";

export function createUnixPlatform(spec: UnixSpec): Platform {
  let locateErr = "";

  const license = spec.license ?? {};
  const probe: Platform["probeActivation"] =
    spec.probeActivation ?? (() => ({ state: "pending" as ProbeState, detail: "" }));
  const machoUnsupported = (): never => {
    throw new Error(`本平台（${spec.label}）不支持 Mach-O 补丁路线。`);
  };
  const macho = spec.macho ?? {};
  const machoInspect: Platform["machoInspect"] = macho.machoInspect ?? machoUnsupported;
  const machoApplyPatch: Platform["machoApplyPatch"] = macho.machoApplyPatch ?? machoUnsupported;

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

    asarPatchSupported: spec.asarPatchSupported,

    machoPatchSupported: spec.machoPatchSupported ?? false,

    machoInspect(install: TyporaInstall): MachoInspection {
      return machoInspect(install);
    },

    machoApplyPatch(install: TyporaInstall, opts: { elevate: boolean }): MachoApplyResult {
      return machoApplyPatch(install, opts);
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
      elevatedCopyUnix(jobs, dirname(jobs[0]!.to));
    },

    licenseSupported: license.licenseSupported ?? false,
    licenseUnsupportedReason: license.licenseUnsupportedReason ?? LICENSE_UNSUPPORTED_LINUX,

    readLicense: license.readLicense ?? ((): LicenseView => ({ license: null, date: null })),

    writeLicense: license.writeLicense ?? ((): void => { throw new Error(LICENSE_UNSUPPORTED_LINUX); }),

    clearLicense: license.clearLicense ?? ((): void => {
      /* 未实现存储 ⇒ 没有可清的东西；--restore 在此平台依然安全 */
    }),

    probeActivation: probe,
  };
}
