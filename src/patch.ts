/**
 * 补丁源码的渲染与注入。
 *
 * 注入代码见 src/inject/patch.js，插在入口文件的最前面（"use strict" 之后），
 * 因此不依赖字节码文件名、也不依赖入口里的任何语句形式。
 *
 * 需要在打包前算出来的量：
 *   SELF_SHA256   入口文件随包发布的内容的 sha256 —— Typora 自校验内置的正是这个基准
 *   SELF_B64      同一份内容（base64），补丁用它把读取结果「倒带」回原始内容
 *   SELF_LEN      补丁后的字节长度，用于识别「正在被哈希的就是我自己」
 *   ENTRY         入口文件名（相对 asar 根），补丁按它构造绝对路径做匹配
 *   LICENSE_KEY   由内容派生的合成许可证号，替掉任何真实序列号
 *
 * 长度回填必须定宽：先用 8 个 0 占位，量出最终长度后再替换成同宽数字，
 * 这样第二次替换不会改变文件长度。
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const PATCH_BEGIN = "/* === hapora license patch === */";
export const PATCH_END = "/* === end hapora license patch === */";

/** 许可证标记：写进注册表 SLicense 的明文，补丁会把它当作密文原样接收 */
export const LICENSE_MARKER = "@@HAPORA_LICENSE@@";

const SLOT = {
  sha256: "__HAPORA_SELF_SHA256__",
  b64: "__HAPORA_SELF_B64__",
  len: "__HAPORA_SELF_LEN__",
  entry: "__HAPORA_ENTRY__",
  marker: "__HAPORA_MARKER__",
  key: "__HAPORA_LICENSE_KEY__",
  email: "__HAPORA_EMAIL__",
} as const;

const LEN_PLACEHOLDER = "00000000";
const STRICT_DIRECTIVE = /^(?:﻿)?\s*["']use strict["']\s*;?\s*/;

function templatePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "inject", "patch.js");
}

export function loadTemplate(): string {
  const source = readFileSync(templatePath(), "utf-8");
  for (const slot of Object.values(SLOT)) {
    if (!source.includes(slot)) throw new Error(`补丁模板缺少占位符 ${slot}`);
  }
  return source;
}

/** 从（可能已打过补丁的）入口源码中剥出原始内容 */
export function stripPatch(source: string): string {
  const begin = source.indexOf(PATCH_BEGIN);
  if (begin < 0) return source;
  const end = source.indexOf(PATCH_END);
  if (end < 0) return source;
  const after = end + PATCH_END.length;
  return source.slice(0, begin) + source.slice(source[after] === "\n" ? after + 1 : after);
}

export function isPatched(source: string): boolean {
  return source.includes(PATCH_BEGIN);
}

export interface InjectResult {
  patched: string;
  selfSha256: string;
  selfLen: number;
}

/** 渲染补丁并注入到入口源码最前面 */
export function inject(
  entryName: string,
  original: string,
  template: string,
  config: { email: string; licenseCode: string },
): InjectResult {
  const bytes = Buffer.from(original, "utf-8");
  const selfSha256 = createHash("sha256").update(bytes).digest("hex");

  const rendered = template
    .replaceAll(SLOT.sha256, selfSha256)
    .replaceAll(SLOT.b64, bytes.toString("base64"))
    .replaceAll(SLOT.entry, entryName)
    .replaceAll(SLOT.marker, LICENSE_MARKER)
    .replaceAll(SLOT.key, config.licenseCode)
    .replaceAll(SLOT.email, config.email)
    .replaceAll(SLOT.len, LEN_PLACEHOLDER);

  const occurrences = rendered.split(LEN_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`长度占位符 ${LEN_PLACEHOLDER} 在补丁里出现 ${occurrences} 次，必须是 1 次`);
  }

  const directive = STRICT_DIRECTIVE.exec(original);
  const at = directive ? directive[0].length : 0;
  const staged = original.slice(0, at) + rendered + "\n" + original.slice(at);

  const selfLen = Buffer.byteLength(staged, "utf-8");
  const patched = staged.replace(LEN_PLACEHOLDER, String(selfLen).padStart(LEN_PLACEHOLDER.length, "0"));
  if (Buffer.byteLength(patched, "utf-8") !== selfLen) {
    throw new Error("长度回填后字节数发生变化");
  }

  return { patched, selfSha256, selfLen };
}

/** 写进许可证存储的值（Windows 上是注册表 SLicense）：明文标记的 base64 + 状态 + 日期 */
export function licenseValue(date = new Date()): string {
  const b64 = Buffer.from(LICENSE_MARKER, "utf-8").toString("base64");
  return `${b64}#0#${formatDate(date)}`;
}

export function formatDate(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}
