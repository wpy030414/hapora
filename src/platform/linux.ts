/**
 * 桌面 Linux 平台实现（Ubuntu / Fedora / Arch Desktop）。
 *
 * 各发行版的落点：
 *   - deb / rpm（官方包）：`/usr/share/typora`，`/usr/bin/typora` 是指向它的符号链接
 *   - Arch AUR：`/usr/share/typora`（旧包为 `/opt/typora`）
 *   - Flatpak：`<flatpak 根>/app/io.typora.Typora/current/active/files/typora`
 *   - Snap：`/snap/typora/current/typora`
 *   - AppImage：只读的 squashfs 单文件镜像，**本工具不支持**（无从改写其中的 app.asar）
 *
 * Linux 版是 Electron 应用（asar 路线），许可证落盘为 ~/.config/Typora/license.json，
 * 启动验收读 ~/.config/Typora/typora.log（与 Windows 相同的日志关键字）。
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { makeInstall, tryExec, type LicenseInput, type LicenseView, type TyporaInstall } from "./types.js";
import { createUnixPlatform, type UnixSpec } from "./unix.js";
import type { ScanSpec } from "./scan.js";
import { formatDate, licenseValue } from "../patch.js";

const ASAR_REL = "resources/app.asar";
const EXE_REL = "Typora";

const FLATPAK_REL = "app/io.typora.Typora/current/active/files/typora";

function resolveDir(raw: string): TyporaInstall | null {
  return makeInstall(raw, ASAR_REL, EXE_REL);
}

const SCAN_SPEC: ScanSpec = {
  names: ["typora"],
  probe: (dir) => existsSync(join(dir, ...ASAR_REL.split("/"))),
  commonSubdirs: ["typora", "Typora", "share/typora", "opt/typora", "lib/typora"],
  skip: [],
  maxDepth: 2,
  maxDirs: 5000,
};

const HOME = homedir();

/** 许可证数据目录：Electron userData 在 Linux 上默认 ~/.config/<app> */
const LICENSE_DIR = join(HOME, ".config", "Typora");
const LICENSE_FILE = join(LICENSE_DIR, "license.json");

function licenseRead(key: string): string | null {
  try {
    const raw = readFileSync(LICENSE_FILE, "utf-8");
    return (JSON.parse(raw) as Record<string, string>)[key] ?? null;
  } catch {
    return null;
  }
}

function licenseWrite(key: string, value: string): void {
  mkdirSync(LICENSE_DIR, { recursive: true });
  let data: Record<string, string> = {};
  try {
    const raw = readFileSync(LICENSE_FILE, "utf-8");
    data = JSON.parse(raw) as Record<string, string>;
  } catch {
    /* 文件不存在或格式错误，重置为空 */
  }
  data[key] = value;
  writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/** 验收 settle 窗口：自校验在启动约 1s 后触发，hasL 必须活过这个窗口才算数 */
const SETTLE_MS = 6000;

const spec: UnixSpec = {
  id: "linux",
  label: "Linux",

  candidates() {
    const dirs: string[] = [];
    // /usr/bin/typora 通常是指向安装目录里可执行文件的符号链接
    const which = tryExec("which", ["typora"]);
    const link = which?.split("\n")[0].trim();
    if (link) {
      const real = tryExec("readlink", ["-f", link])?.trim() || link;
      dirs.push(dirname(real));
    }
    const home = homedir();
    dirs.push(
      "/usr/share/typora",
      "/usr/lib/typora",
      "/usr/local/share/typora",
      "/opt/typora",
      "/opt/Typora",
      join("/var/lib/flatpak", FLATPAK_REL),
      "/snap/typora/current/typora",
      join(home, ".local", "share", FLATPAK_REL),
      join(home, ".local", "share", "typora"),
      join(home, ".local", "opt", "typora"),
      join(home, "Applications", "typora"),
    );
    return dirs;
  },

  resolve: resolveDir,

  scanRoots() {
    const home = homedir();
    return [
      "/usr/share",
      "/usr/lib",
      "/usr/local/share",
      "/opt",
      "/snap",
      join(home, ".local", "share"),
      join(home, ".local", "opt"),
      join(home, "Applications"),
    ];
  },
  scanSpec: SCAN_SPEC,

  asarPatchSupported: true,

  overrideHint:
    "请指向 Typora 安装根目录（其中含 resources/app.asar）。" +
    "注意 AppImage 是只读镜像，本工具不支持。",

  license: {
    licenseSupported: true,
    licenseUnsupportedReason: "",

    readLicense(): LicenseView {
      const sl = licenseRead("SLicense");
      const id = licenseRead("IDate");
      return { license: sl, date: id };
    },

    writeLicense(input: LicenseInput): void {
      licenseWrite("SLicense", licenseValue(input.now));
      licenseWrite("IDate", formatDate(input.now));
    },

    clearLicense(): void {
      licenseWrite("SLicense", "");
    },
  },

  probeActivation(_install, launchedAtMs) {
    const START_MARKER = "------------------start------------------";
    const logPath = join(HOME, ".config", "Typora", "typora.log");
    const text = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    const i = text.lastIndexOf(START_MARKER);
    const seg = i >= 0 ? text.slice(i) : "";
    if (/Integrity check failed/.test(seg)) {
      return { state: "lost", detail: `自校验没放行（Integrity check failed）。日志：${logPath}` };
    }
    if (/unfill due to renew fail/.test(seg)) {
      return { state: "lost", detail: `续期被判失败（unfill due to renew fail）。日志：${logPath}` };
    }
    if (/\[watch L\] hasL: true/.test(seg) && Date.now() - launchedAtMs >= SETTLE_MS) {
      return { state: "activated", detail: "[watch L] hasL: true（自校验后仍存活）" };
    }
    return { state: "pending", detail: "" };
  },
};

export const linuxPlatform = createUnixPlatform(spec);
