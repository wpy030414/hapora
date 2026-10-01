/**
 * 安装目录的「浅扫描」兜底：在一组根目录下找 Typora 的安装目录。
 *
 * 平台无关；「像不像 Typora 安装」的判据由各平台通过 probe 提供
 * （Windows/Linux：目录下存在 resources/app.asar；macOS：.app 包结构）。
 * 两道保险避免在大目录树上卡死：深度上限与目录数上限；外加一份噪声目录跳过表。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ScanSpec {
  /** 会被当作安装目录的目录名（小写比较） */
  names: string[];
  /** 「这个目录是 Typora 安装」的判据（快速结构检查即可，最终确认由 locate 的 resolve 做） */
  probe(dir: string): boolean;
  /** 相对根目录的常见子目录，先按名字碰运气 */
  commonSubdirs: string[];
  /** 目录名跳过表（小写） */
  skip: string[];
  maxDepth: number;
  maxDirs: number;
}

/** 常见的噪声/系统目录，各平台通用，可再叠加平台自己的。 */
export const COMMON_SKIP = [
  "node_modules", ".git", ".cache", ".npm", ".cargo", ".rustup", ".gradle",
  "proc", "sys", "dev", "run", "tmp", "var", "boot", "lost+found",
];

export function scanRootsForInstall(roots: string[], spec: ScanSpec): string[] {
  const skip = new Set([...COMMON_SKIP, ...spec.skip]);
  const names = new Set(spec.names);

  // 第一轮：常见子目录，命中就返回，避免一上来就遍历
  const hits: string[] = [];
  for (const root of roots) {
    for (const sub of spec.commonSubdirs) {
      const p = join(root, sub);
      if (spec.probe(p)) hits.push(p);
    }
  }
  if (hits.length) return hits;

  // 第二轮：深度受限的 BFS
  let budget = spec.maxDirs;
  const queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));
  while (queue.length && budget-- > 0) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限 / 已失效的目录，跳过
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();
      if (skip.has(name)) continue;
      const child = join(dir, entry.name);
      if (names.has(name) && spec.probe(child)) {
        hits.push(child);
        continue;
      }
      if (depth + 1 < spec.maxDepth) queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return hits;
}
