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
 * Linux 版是 Electron 应用（asar 路线），许可证落盘为 ~/.config/Typora/<指纹>，
 * 指纹 = Base64(SHA256(machineId + "typora"))[0..10]（[/=+-]→"a"，同 Windows 公式）。
 * 文件内容是整段 JSON 的**十六进制编码**（同 profile.data）：hex(`{"SLicense":"<值>"}`)，
 * 其中 SLicense = `base64(marker)#0#M/D/YYYY`（无 IDate 键，日期已并入 SLicense 尾段）。
 * 读写都必须先解/编 hex，否则 Typora 启动时读不出（现象是恒 no info）。
 * 启动验收读 ~/.config/Typora/typora.log（与 Windows 相同的日志关键字）。
 */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { makeInstall, tryExec, type LicenseInput, type LicenseView, type TyporaInstall } from "./types.js";
import { createUnixPlatform, type UnixSpec } from "./unix.js";
import type { ScanSpec } from "./scan.js";
import { licenseValue } from "../patch.js";

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

/** 许可证文件名指纹：Base64(SHA256(machineId + "typora"))[0..10]，[/=+-]→"a"（同 Windows 公式） */
function linuxFingerprint(): string {
  let mid = "";
  try {
    mid = readFileSync("/etc/machine-id", "utf-8").trim();
  } catch {
    /* 回退到 dbus */
  }
  if (!mid) {
    try {
      mid = readFileSync("/var/lib/dbus/machine-id", "utf-8").trim();
    } catch {
      /* 读取失败 */
    }
  }
  return createHash("sha256").update(mid + "typora").digest("base64")
    .substring(0, 10).replace(/[/=+-]/g, "a");
}

let licensePathCache: string | null = null;

function licensePath(): string {
  if (!licensePathCache) {
    licensePathCache = join(LICENSE_DIR, linuxFingerprint());
  }
  return licensePathCache;
}

/**
 * 读许可证文件。Typora 在 Linux 上把整个 JSON 存成**十六进制编码**（同 profile.data），
 * 即文件内容是 `Buffer.from(json).toString("hex")`，读取时先解 hex 再 JSON.parse。
 */
function licenseRead(): { sl: string | null } {
  try {
    const hex = readFileSync(licensePath(), "utf-8").trim();
    const json = Buffer.from(hex, "hex").toString("utf-8");
    const data = JSON.parse(json) as Record<string, string>;
    return { sl: data["SLicense"] ?? null };
  } catch {
    return { sl: null };
  }
}

function licenseWriteSLicense(value: string): void {
  mkdirSync(LICENSE_DIR, { recursive: true });
  let data: Record<string, string> = {};
  try {
    const hex = readFileSync(licensePath(), "utf-8").trim();
    data = JSON.parse(Buffer.from(hex, "hex").toString("utf-8")) as Record<string, string>;
  } catch {
    /* 文件不存在或格式错误，重置为空 */
  }
  data["SLicense"] = value;
  // 写回十六进制编码（与 Typora 自己的存储格式一致，否则启动时读不出来）
  writeFileSync(licensePath(), Buffer.from(JSON.stringify(data), "utf-8").toString("hex"), "utf-8");
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
    licenseStorageLabel: () => `指纹文件（hex 编码）→ ${licensePath()}`,

    readLicense(): LicenseView {
      const { sl } = licenseRead();
      // SLicense 形如 `base64(marker)#0#M/D/YYYY`，日期在第二段之后（无独立 IDate 键）
      const parts = sl ? sl.split("#") : [];
      return { license: sl, date: parts.length >= 3 ? parts.slice(2).join("#") : null };
    },

    writeLicense(input: LicenseInput): void {
      licenseWriteSLicense(licenseValue(input.now));
    },

    clearLicense(): void {
      licenseWriteSLicense("");
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
