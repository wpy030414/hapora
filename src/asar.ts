/**
 * app.asar 的解包 / 打包 / 读取单文件。
 *
 * 不对包内文件名做任何假设——入口名一律从包内 package.json 的 main 字段读出来。
 */

import { extractAll, createPackage, extractFile } from "@electron/asar";
import { mkdirSync, rmSync } from "node:fs";

export const PACKAGE_JSON = "package.json";

export async function unpack(asarPath: string, destDir: string): Promise<void> {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  await extractAll(asarPath, destDir);
}

export async function pack(srcDir: string, asarPath: string): Promise<void> {
  rmSync(asarPath, { force: true });
  await createPackage(srcDir, asarPath);
}

export function readEntry(asarPath: string, entry: string): string {
  return extractFile(asarPath, entry).toString("utf-8");
}

/**
 * 从包内 package.json 读出入口文件名。
 * Typora 的自校验也是先读它、再读 main 指向的文件，所以这里必须用同一个来源。
 */
export function readMain(asarPath: string): string {
  const pkg = JSON.parse(extractFile(asarPath, PACKAGE_JSON).toString("utf-8")) as { main?: string };
  if (!pkg.main || typeof pkg.main !== "string") {
    throw new Error(`app.asar 的 package.json 里没有可用的 main 字段`);
  }
  return pkg.main;
}
