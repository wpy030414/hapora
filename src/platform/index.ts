/**
 * 平台选择。所有平台相关的差异都收敛在这里选出的 Platform 对象上。
 */

import { windowsPlatform } from "./windows.js";
import { darwinPlatform } from "./darwin.js";
import { linuxPlatform } from "./linux.js";
import type { Platform } from "./types.js";

export type {
  Platform, TyporaInstall, CopyJob, LicenseInput, LicenseView, ProbeState,
  MachoInspection, MachoApplyResult,
} from "./types.js";

/** 当前平台实现。不支持的平台直接抛错（调用方在 main 里统一转成非零码退出）。 */
export function platform(): Platform {
  switch (process.platform) {
    case "win32":
      return windowsPlatform;
    case "darwin":
      return darwinPlatform;
    case "linux":
      return linuxPlatform;
    default:
      throw new Error(`不支持的平台：${process.platform}（本工具支持 Windows / macOS / 桌面 Linux）`);
  }
}
