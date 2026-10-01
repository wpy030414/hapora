/**
 * 平台无关的门面：hack.ts 只与本文件打交道，平台差异全部下沉到 src/platform/。
 *
 * 之所以留这一层而不是让 hack.ts 直接 import platform：
 *   1. 编排层不必关心「现在是哪个平台」，只调用语义化动作（定位 / 结束进程 / 写入 / 写许可证）；
 *   2. 每个动作在调用时才解析当前平台，便于测试与未来替换实现。
 */

import { platform } from "./platform/index.js";
import type {
  TyporaInstall, CopyJob, LicenseInput, LicenseView, ProbeState,
} from "./platform/types.js";

export type { TyporaInstall, CopyJob, LicenseInput, LicenseView, ProbeState };

/** 当前平台的展示名（用于输出）。 */
export const platformLabel = (): string => platform().label;

export const locate = (overrideDir?: string): TyporaInstall | null => platform().locate(overrideDir);
export const locateError = (): string => platform().locateError();

export const isRunning = (): boolean => platform().isRunning();
export const kill = (): void => platform().kill();
export const launch = (install: TyporaInstall): void => platform().launch(install);
export const isAdmin = (): boolean => platform().isAdmin();

/** 是否走「改写 app.asar」的补丁路线；false（macOS）= 只伪造许可证存储 */
export const asarPatchSupported = (): boolean => platform().asarPatchSupported;

export const checkWriteAccess = (targetPath: string): boolean => platform().checkWriteAccess(targetPath);
export const installFiles = (jobs: CopyJob[], opts: { elevate: boolean }): void =>
  platform().installFiles(jobs, opts);

export const licenseSupported = (): boolean => platform().licenseSupported;
export const licenseUnsupportedReason = (): string => platform().licenseUnsupportedReason;
export const readLicense = (): LicenseView => platform().readLicense();
export const writeLicense = (input: LicenseInput): void => platform().writeLicense(input);
export const clearLicense = (): void => platform().clearLicense();

export const probeActivation = (install: TyporaInstall, launchedAtMs: number): { state: ProbeState; detail: string } =>
  platform().probeActivation(install, launchedAtMs);
