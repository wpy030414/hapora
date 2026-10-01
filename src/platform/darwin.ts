/**
 * macOS 平台实现（arm64）。
 *
 * macOS 版 Typora 是原生 AppKit+WebKit 应用（非 Electron、无 asar，机制实证见
 * docs/researches/activation-mac.md）。路线（ADR-012）＝ Mach-O 补丁 + 记录伪造双管齐下：
 *   - Mach-O 补丁（darwin-macho.ts）：在 `-[LicenseManager renew]` 的 IMP 写 ret，
 *     断掉唯一会把激活打回的续期路径，改包后 ad-hoc 重签（entitlements 原样保留 +
 *     追加 disable-library-validation）。首次改包会触发 macOS 13+ 的 TCC
 *     「App Management」一次性授权弹窗，属预期交互。
 *   - 记录伪造（darwin-license.ts）：激活判定本身只看记录里 email/license 键非 nil，
 *     仍需伪造 ~/Library 下的许可证记录文件（lastTry 金丝雀见 LAST_TRY_HOURS_AGO）。
 *   - 启动验收：轮询记录文件是否仍带激活键 + 进程存活（窗口外 lastTry 的记录存活
 *     本身就是 renew 已被中和的自证）。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { tryExec, type TyporaInstall } from "./types.js";
import { createUnixPlatform, type UnixSpec } from "./unix.js";
import type { ScanSpec } from "./scan.js";
import {
  buildForgedRecord, LAST_TRY_HOURS_AGO, machineUuid, readRecord, recordLooksActivated, recordPath, writeRecord,
} from "./darwin-license.js";
import { applyMachOPatch, inspectMacho } from "./darwin-macho.js";

let recordPathCache: string | null = null;

/** 读 .app 包 Info.plist 的关键字段（bundle id / 可执行名）。失败返回 null。 */
function readBundleInfo(appDir: string): { bundleId: string; executable: string } | null {
  const plist = join(appDir, "Contents", "Info.plist");
  if (!existsSync(plist)) return null;
  const json = tryExec("plutil", ["-convert", "json", "-o", "-", plist]);
  if (!json) return null;
  try {
    const info = JSON.parse(json) as { CFBundleIdentifier?: string; CFBundleExecutable?: string };
    if (!info.CFBundleIdentifier || !info.CFBundleExecutable) return null;
    return { bundleId: info.CFBundleIdentifier, executable: info.CFBundleExecutable };
  } catch {
    return null;
  }
}

/** 把 .app 包路径规范成安装信息：target 是本机的许可证记录文件。 */
function bundleInstall(appDir: string): TyporaInstall | null {
  const info = readBundleInfo(appDir);
  if (!info) return null;
  const exe = join(appDir, "Contents", "MacOS", info.executable);
  if (!existsSync(exe)) return null;
  const uuid = machineUuid();
  if (!uuid) throw new Error("读不到 IOPlatformUUID（ioreg），无法定位许可证记录文件");
  const target = recordPath(info.bundleId, uuid);
  recordPathCache = target;
  return { dir: appDir, target, backup: target + ".hapora-orig.bak", exe };
}

/** 允许 --dir 指向 .app 本身，或包内的 Contents / Contents/Resources / Contents/MacOS。 */
function resolveBundle(raw: string): TyporaInstall | null {
  const cleaned = raw.trim().replace(/^"+|"+$/g, "").replace(/[\\/]+$/, "");
  if (!cleaned) return null;
  // 统一分隔符后再匹配，这样在任意宿主上都得到一致行为
  const norm = cleaned.replace(/\\/g, "/");
  const m = norm.match(/^(.*\.app)(?:\/Contents(?:\/(?:Resources|MacOS))?)?$/);
  return bundleInstall(m ? m[1]! : norm);
}

/** 浅扫描的结构判据：像个 .app 包即可（最终确认在 resolveBundle 里做 plutil 校验）。 */
function looksLikeAppBundle(dir: string): boolean {
  return existsSync(join(dir, "Contents", "Info.plist")) && existsSync(join(dir, "Contents", "MacOS"));
}

const SCAN_SPEC: ScanSpec = {
  names: ["typora.app"],
  probe: looksLikeAppBundle,
  commonSubdirs: ["Typora.app", "Applications/Typora.app"],
  skip: [],
  maxDepth: 2,
  maxDirs: 5000,
};

/** 验收 settle 窗口：renew 是网络往返（失败也要几秒才到 unfill），宽于 Windows 的 6s。 */
const SETTLE_MS = 8000;

const HOME = homedir();

const spec: UnixSpec = {
  id: "darwin",
  label: "macOS",

  asarPatchSupported: false,
  machoPatchSupported: true,

  macho: {
    machoInspect: (install) => inspectMacho(install),
    machoApplyPatch: (install, opts) => applyMachOPatch(install, opts),
  },

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
    dirs.push(join(HOME, "Applications", "Typora.app"));
    return dirs;
  },

  resolve: resolveBundle,

  scanRoots() {
    return ["/Applications", join(HOME, "Applications"), "/opt", "/usr/local"];
  },
  scanSpec: SCAN_SPEC,

  overrideHint: "macOS 上请指向 Typora.app 本身（或其 Contents 目录）。",

  license: {
    licenseSupported: true,
    licenseUnsupportedReason: "",

    readLicense() {
      const path = recordPathCache;
      if (!path) return { license: null, date: null };
      const rec = readRecord(path, machineUuid());
      const email = rec?.get("email");
      return {
        license: recordLooksActivated(rec) ? `已激活（${email}）` : null,
        date: rec?.get("installDate") instanceof Date
          ? (rec.get("installDate") as Date).toISOString().slice(0, 10)
          : null,
      };
    },

    writeLicense(input) {
      const path = recordPathCache;
      if (!path) throw new Error("尚未定位许可证记录文件（先运行定位）");
      const uuid = machineUuid();
      if (!uuid) throw new Error("读不到 IOPlatformUUID，无法派生记录密钥");
      const existing = readRecord(path, uuid);
      writeRecord(path, uuid, buildForgedRecord(input, existing, LAST_TRY_HOURS_AGO));
    },

    clearLicense() {
      /* 伪造值与备份对象是同一个文件：--restore 的备份还原即清除伪造，无需额外动作 */
    },
  },

  probeActivation(install, launchedAtMs) {
    const rec = readRecord(install.target, machineUuid());
    if (!recordLooksActivated(rec)) {
      return {
        state: "lost",
        detail: `许可证记录被 Typora 清除（unfill：续期被服务器拒绝或验签失败）。记录文件：${install.target}`,
      };
    }
    if (!tryExec("pgrep", ["-x", "Typora"])) {
      return { state: "gone", detail: "Typora 进程已退出" };
    }
    if (Date.now() - launchedAtMs < SETTLE_MS) return { state: "pending", detail: "" };
    return { state: "activated", detail: "许可证记录保持有效（email/license 键完整），Typora 存活" };
  },
};

export const darwinPlatform = createUnixPlatform(spec);
