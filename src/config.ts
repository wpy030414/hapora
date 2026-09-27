/**
 * 可自定义项：许可证邮箱与序列号。
 *
 * 来源优先级：环境变量 > 仓库根目录的 .env > 内置默认值。
 * .env 不入库（见 .gitignore），默认值写在代码里，因此不配置也能直接跑。
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface Config {
  email: string;
  licenseCode: string;
}

export const DEFAULTS: Config = {
  email: "krkr@xrl.im",
  licenseCode: "POWER0-ED0000-BY0000-XRL000",
};

/** Typora 对序列号的形状要求 */
export const LICENSE_SHAPE = /^([A-Z0-9]{6}-){3}[A-Z0-9]{6}$/;

export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadConfig(envPath = join(repoRoot(), ".env")): Config {
  const file = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf-8")) : {};
  const pick = (key: string, fallback: string) => process.env[key] ?? file[key] ?? fallback;
  return {
    email: pick("EMAIL", DEFAULTS.email),
    licenseCode: pick("CODE", DEFAULTS.licenseCode),
  };
}
