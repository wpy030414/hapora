/**
 * 平台选择。所有平台相关的差异都收敛在这里选出的 Platform 对象上。
 *
 * 选择顺序：`--platform` 显式指定 > 环境变量 HAPORA_PLATFORM > process.platform 自动检测。
 * 显式指定优先，使 WSL 里的 Linux 宿主可以操作 Windows 侧安装的 Typora。
 */

import { windowsPlatform } from "./windows.js";
import { darwinPlatform } from "./darwin.js";
import { linuxPlatform } from "./linux.js";
import type { Platform } from "./types.js";

export type {
  Platform, TyporaInstall, CopyJob, LicenseInput, LicenseView, ProbeState,
  MachoInspection, MachoApplyResult,
} from "./types.js";

const ALIASES: Record<string, string> = {
  win32: "win32",
  windows: "win32",
  win: "win32",
  darwin: "darwin",
  macos: "darwin",
  mac: "darwin",
  linux: "linux",
};

const SUPPORTED_HINT = "可选值：windows / macos / linux";

export function normalizePlatformId(raw: string): string | null {
  return ALIASES[raw.trim().toLowerCase()] ?? null;
}

let selectedId: string | null = null;

/** 由 CLI 在启动时调用；无效值直接抛错（调用方转成非零码退出）。 */
export function selectPlatform(raw: string): void {
  const id = normalizePlatformId(raw);
  if (!id) throw new Error(`不支持的平台：${raw}（${SUPPORTED_HINT}）`);
  selectedId = id;
}

function currentId(): string {
  const fromEnv = process.env["HAPORA_PLATFORM"]?.trim();
  if (fromEnv) {
    const id = normalizePlatformId(fromEnv);
    if (!id) throw new Error(`HAPORA_PLATFORM 的值无效：${fromEnv}（${SUPPORTED_HINT}）`);
    return id;
  }
  return process.platform;
}

/** 当前选中的平台 id（规范化后）。 */
export function platformId(): string {
  return selectedId ?? currentId();
}

/** 当前平台实现。不支持的平台直接抛错（调用方在 main 里统一转成非零码退出）。 */
export function platform(): Platform {
  switch (platformId()) {
    case "win32":
      return windowsPlatform;
    case "darwin":
      return darwinPlatform;
    case "linux":
      return linuxPlatform;
    default:
      throw new Error(`不支持的平台：${platformId()}（本工具支持 Windows / macOS / 桌面 Linux）`);
  }
}
