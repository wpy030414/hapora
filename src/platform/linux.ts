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
 * Linux 版是 Electron 应用（asar 路线成立），但许可证存储位置尚未实证，writeLicense
 * 维持显式失败（见 unix.ts / ADR-010）。
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

import { makeInstall, tryExec, type TyporaInstall } from "./types.js";
import { createUnixPlatform, type UnixSpec } from "./unix.js";
import type { ScanSpec } from "./scan.js";

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
};

export const linuxPlatform = createUnixPlatform(spec);
