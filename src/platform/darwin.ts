/**
 * macOS 平台实现（arm64）。
 *
 * Typora 在 macOS 上是 .app 包：app.asar 位于 `Contents/Resources/app.asar`，
 * 可执行文件是 `Contents/MacOS/Typora`。因此「安装根目录」指的是 .app 包本身。
 *
 * 验收日志路径按 Electron 的 userData 惯例推断（`~/Library/Application Support/Typora/`），
 * **未在真机验证**。
 *
 * 注意：macOS 版可能启用 Electron 的 asar integrity（Info.plist 里内嵌 app.asar 哈希）
 * 与代码签名；若如此，改写 app.asar 会导致启动失败。本仓库尚未在 arm64 真机上验证这一点。
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { makeInstall, tryExec, type TyporaInstall } from "./types.js";
import { createUnixPlatform, type UnixSpec } from "./unix.js";
import type { ScanSpec } from "./scan.js";

const ASAR_REL = "Contents/Resources/app.asar";
const EXE_REL = "Contents/MacOS/Typora";

/** 允许 --dir 指向 .app 本身，或包内的 Contents / Contents/Resources / Contents/MacOS。 */
function resolveBundle(raw: string): TyporaInstall | null {
  const cleaned = raw.trim().replace(/^"+|"+$/g, "").replace(/[\\/]+$/, "");
  if (!cleaned) return null;
  // 统一分隔符后再匹配，这样在任意宿主上都得到一致行为
  const norm = cleaned.replace(/\\/g, "/");
  const m = norm.match(/^(.*\.app)(?:\/Contents(?:\/(?:Resources|MacOS))?)?$/);
  return makeInstall(m ? m[1] : norm, ASAR_REL, EXE_REL);
}

const SCAN_SPEC: ScanSpec = {
  names: ["typora.app"],
  asarRel: ASAR_REL,
  commonSubdirs: ["Typora.app", "Applications/Typora.app"],
  skip: [],
  maxDepth: 2,
  maxDirs: 5000,
};

const spec: UnixSpec = {
  id: "darwin",
  label: "macOS",

  candidates() {
    const dirs: string[] = [];
    // Spotlight：能找到装在任何位置的 .app
    const found = tryExec("mdfind", ["kMDItemCFBundleIdentifier == 'abnerworks.Typora'"]);
    if (found) {
      for (const line of found.split("\n")) {
        const p = line.trim();
        if (p) dirs.push(p);
      }
    }
    dirs.push("/Applications/Typora.app");
    dirs.push(join(homedir(), "Applications", "Typora.app"));
    return dirs;
  },

  resolve: resolveBundle,

  scanRoots() {
    return ["/Applications", join(homedir(), "Applications"), "/opt", "/usr/local"];
  },
  scanSpec: SCAN_SPEC,

  logPath() {
    return join(homedir(), "Library", "Application Support", "Typora", "typora.log");
  },

  overrideHint: "macOS 上请指向 Typora.app 本身（或其 Contents/Resources 目录）。",
};

export const darwinPlatform = createUnixPlatform(spec);
