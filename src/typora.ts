/**
 * Typora 安装定位与备份管理。
 */

import { existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

export const BACKUP_SUFFIX = ".hapora-orig.bak";

export interface TyporaInstall {
  dir: string;
  resources: string;
  asar: string;
  backup: string;
}

export function locate(): TyporaInstall | null {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const dir = join(local, "Programs", "Typora");
  const resources = join(dir, "resources");
  const asar = join(resources, "app.asar");
  if (!existsSync(asar)) return null;
  return { dir, resources, asar, backup: asar + BACKUP_SUFFIX };
}

export function backup(install: TyporaInstall): void {
  copyFileSync(install.asar, install.backup);
}

export function restore(install: TyporaInstall): boolean {
  if (!existsSync(install.backup)) return false;
  copyFileSync(install.backup, install.asar);
  return true;
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
