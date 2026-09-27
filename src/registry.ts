/**
 * Windows 注册表读写（仅 HKCU\SOFTWARE\Typora）。
 *
 * 使用 execFile 直接调用 reg.exe，不经过 shell，避免 `#`、`=`、`+`、`/`
 * 这类出现在 SLicense 里的字符被 shell 解析。
 */

import { execFileSync } from "node:child_process";

export const REG_PATH = "HKCU\\SOFTWARE\\Typora";

function reg(args: string[]): string {
  return execFileSync("reg", args, { encoding: "utf-8", windowsHide: true });
}

export function read(key: string): string | null {
  try {
    const out = reg(["query", REG_PATH, "/v", key]);
    const m = out.match(new RegExp(`${key}\\s+REG_\\w+\\s+(.*)`));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export function write(key: string, value: string, type = "REG_SZ"): void {
  reg(["add", REG_PATH, "/v", key, "/t", type, "/d", value, "/f"]);
}
