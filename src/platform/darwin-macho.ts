/**
 * macOS Mach-O 二进制补丁（darwin 平台私有，机制依据见 docs/researches/activation-mac.md §10）。
 *
 * 路线（ADR-012）：在 `-[LicenseManager renew]` 的 IMP 首指令处写 `ret`，使续期永不发生——
 * 唯一会把激活打回的路径（renew → 服务器拒绝 → unfillLicense 物理清空记录）被连根断掉，
 * 伪造的许可证记录从此永不过期，与 Windows 路线的一次激活永久有效语义对齐。
 *
 * 本文件分三部分（与 darwin-license.ts 同风格，零新依赖，任何意外结构显式抛错、绝不猜）：
 *   1. fat / Mach-O 最小解析器：定位符号表里的方法 IMP，映射到文件偏移（版本无关，零硬编码偏移）；
 *   2. ret 补丁的规划 / 应用 / 状态读取（纯函数；等长替换，任何偏移都不漂移）；
 *   3. entitlements 导出注入、codesign 重签与备份事务（见下半部分）。
 *
 * 本模块唯一允许出现的 Typora 字面量：MACHO_TARGETS 里的选择器符号名，以及各 CPU 的 ret 编码。
 */

import { spawnSync } from "node:child_process";

/* ---------------- Mach-O 解析（纯函数） ---------------- */

/** 补丁目标：逆向所得的方法符号名（LC_SYMTAB 里做精确匹配）。 */
export const MACHO_TARGETS = {
  /** 唯一会把激活打回的续期入口；短路它 ⇒ 记录永不过期（研究报告 §10.1 的选型论证）。 */
  renew: "-[LicenseManager renew]",
} as const;

export type MachoTarget = keyof typeof MACHO_TARGETS;

/** fat 文件里的一个切片（或 thin 单片）。cputype 保留原始值（0x0100000c = arm64，0x01000007 = x86_64）。 */
export interface FatSlice {
  cpuType: number;
  offset: number;
  size: number;
}

/** 符号定位结果：方法 IMP 的 vm 地址与映射后的绝对文件偏移。 */
export interface SymbolSite {
  name: string;
  cpuType: number;
  vmAddr: number;
  fileOffset: number;
}

/** 一次补丁：把 site 入口处的 current 字节换成 patch（ret 编码；等长）。 */
export interface PatchOp {
  site: SymbolSite;
  /** 当前盘上的入口字节（诊断 / manifest 用）。 */
  current: Buffer;
  /** 要写入的 ret 编码。 */
  patch: Buffer;
}

// Mach-O 常量（结构定义，非 Typora 特有）
const FAT_MAGIC = 0xcafebabe; // fat_header（大端）
const FAT_MAGIC_64 = 0xcafebabf; // fat_arch_64 变体
const MH_MAGIC_64 = 0xfeedfacf; // mach_header_64（小端）
const MH_CIGAM_64 = 0xcffaedfe; // 字节交换过的魔数 ⇒ 大端切片，显式不支持
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;
const VM_PROT_EXECUTE = 0x4;

/** cputype → 人话（错误信息与日志用）。 */
export function archName(cpuType: number): string {
  if (cpuType === 0x0100000c) return "arm64";
  if (cpuType === 0x01000007) return "x86_64";
  return `cputype:0x${cpuType.toString(16)}`;
}

/**
 * 解析 fat 头（0xcafebabe，大端）成切片清单；thin 单文件视为单切片。
 * 越界、未知魔数、fat_arch_64 变体一律抛错——宁可失败也不猜。
 */
export function parseSlices(buf: Buffer): FatSlice[] {
  if (buf.length < 32) throw new Error(`文件太小（${buf.length}B），不是 Mach-O`);

  const magicBE = buf.readUInt32BE(0);
  if (magicBE === FAT_MAGIC_64) {
    throw new Error("fat_arch_64（0xcafebabf）布局未实证，按显式失败处理（见研究报告 §10.2）");
  }
  if (magicBE === FAT_MAGIC) {
    const nfat = buf.readUInt32BE(4);
    const need = 8 + nfat * 20;
    if (nfat < 1 || need > buf.length) throw new Error(`fat 头损坏：nfat_arch=${nfat}，文件仅 ${buf.length}B`);
    const slices: FatSlice[] = [];
    for (let i = 0; i < nfat; i++) {
      const base = 8 + i * 20;
      const cpuType = buf.readInt32BE(base);
      const offset = buf.readUInt32BE(base + 8);
      const size = buf.readUInt32BE(base + 12);
      if (offset < 0 || size <= 0 || offset + size > buf.length) {
        throw new Error(`fat_arch[${i}]（${archName(cpuType)}）越界：offset=${offset} size=${size}，文件 ${buf.length}B`);
      }
      slices.push({ cpuType, offset, size });
    }
    return slices;
  }

  const magicLE = buf.readUInt32LE(0);
  if (magicLE === MH_CIGAM_64) throw new Error("切片是字节交换（大端）魔数，不支持");
  if (magicLE === MH_MAGIC_64) return [{ cpuType: buf.readInt32LE(4), offset: 0, size: buf.length }];
  throw new Error(`不是 Mach-O（魔数 0x${magicBE.toString(16)} / 0x${magicLE.toString(16)}）`);
}

interface SegmentInfo {
  vmAddr: number;
  vmSize: number;
  fileOff: number;
  fileSize: number;
  maxProt: number;
}

interface SymtabInfo {
  symOff: number;
  nSyms: number;
  strOff: number;
  strSize: number;
}

/** 解析单个切片：校验 mach_header_64、收集 LC_SEGMENT_64 与唯一的 LC_SYMTAB。 */
function parseSliceCommands(buf: Buffer, slice: FatSlice): { segments: SegmentInfo[]; symtab: SymtabInfo } {
  const base = slice.offset;
  const magic = buf.readUInt32LE(base);
  if (magic !== MH_MAGIC_64) {
    throw new Error(`切片 ${archName(slice.cpuType)} 的魔数是 0x${magic.toString(16)}，不是 mach_header_64`);
  }
  const ncmds = buf.readUInt32LE(base + 16);
  const sizeofcmds = buf.readUInt32LE(base + 20);
  const cmdsEnd = base + 32 + sizeofcmds;
  if (cmdsEnd > base + slice.size || cmdsEnd > buf.length) {
    throw new Error(`切片 ${archName(slice.cpuType)} 的 load commands 越界（sizeofcmds=${sizeofcmds}）`);
  }

  const segments: SegmentInfo[] = [];
  let symtab: SymtabInfo | null = null;
  let cursor = base + 32;
  for (let i = 0; i < ncmds; i++) {
    if (cursor + 8 > cmdsEnd) throw new Error(`切片 ${archName(slice.cpuType)} 的 load command #${i} 越界`);
    const cmd = buf.readUInt32LE(cursor);
    const cmdsize = buf.readUInt32LE(cursor + 4);
    if (cmdsize < 8 || cursor + cmdsize > cmdsEnd) {
      throw new Error(`切片 ${archName(slice.cpuType)} 的 load command #${i} 尺寸非法（${cmdsize}）`);
    }
    if (cmd === LC_SEGMENT_64 && cmdsize >= 72) {
      segments.push({
        vmAddr: Number(buf.readBigUInt64LE(cursor + 24)),
        vmSize: Number(buf.readBigUInt64LE(cursor + 32)),
        fileOff: Number(buf.readBigUInt64LE(cursor + 40)),
        fileSize: Number(buf.readBigUInt64LE(cursor + 48)),
        maxProt: buf.readInt32LE(cursor + 56),
      });
    } else if (cmd === LC_SYMTAB) {
      if (symtab) throw new Error(`切片 ${archName(slice.cpuType)} 出现多个 LC_SYMTAB，结构未实证`);
      symtab = {
        symOff: buf.readUInt32LE(cursor + 8),
        nSyms: buf.readUInt32LE(cursor + 12),
        strOff: buf.readUInt32LE(cursor + 16),
        strSize: buf.readUInt32LE(cursor + 20),
      };
    }
    cursor += cmdsize;
  }
  if (!symtab) throw new Error(`切片 ${archName(slice.cpuType)} 没有 LC_SYMTAB，无法定位符号`);
  return { segments, symtab };
}

/** 读 NUL 界定的 C 字符串（越界到 bound 为止仍无 NUL ⇒ 抛错）。 */
function readCStr(buf: Buffer, start: number, bound: number): string {
  const end = buf.indexOf(0, start);
  if (end < 0 || end >= bound) throw new Error(`符号名越界（offset=${start}，无 NUL 终止）`);
  return buf.toString("utf-8", start, end);
}

/** vm 地址 → 绝对文件偏移：按包含性找可执行段，不按段名（兼容 __TEXT / __TEXT_EXEC / 多段布局）。 */
function vmToFile(segments: SegmentInfo[], slice: FatSlice, vmAddr: number): number {
  for (const seg of segments) {
    const inVm = vmAddr >= seg.vmAddr && vmAddr < seg.vmAddr + seg.vmSize;
    const inFile = vmAddr - seg.vmAddr < seg.fileSize;
    if (inVm && inFile && (seg.maxProt & VM_PROT_EXECUTE) !== 0) {
      return slice.offset + seg.fileOff + (vmAddr - seg.vmAddr);
    }
  }
  throw new Error(`vm 地址 0x${vmAddr.toString(16)} 不落在任何可执行段内`);
}

/**
 * 在所有切片的符号表里按名字精确查找，返回每个 (名字 × 切片) 的定位结果。
 * 任一名字在任一切片缺失 ⇒ 抛错（附每片诊断）——绝不带着只补一半的切片写盘（Rosetta 安全）。
 */
export function locateSymbols(buf: Buffer, names: string[]): SymbolSite[] {
  const slices = parseSlices(buf);
  const sites: SymbolSite[] = [];
  const missing: string[] = [];

  for (const slice of slices) {
    const { segments, symtab } = parseSliceCommands(buf, slice);
    const symEnd = slice.offset + symtab.symOff + symtab.nSyms * 16;
    const strEnd = slice.offset + symtab.strOff + symtab.strSize;
    if (symEnd > slice.offset + slice.size || strEnd > slice.offset + slice.size) {
      throw new Error(`切片 ${archName(slice.cpuType)} 的符号表/字符串表越界`);
    }

    for (const name of names) {
      let hit: SymbolSite | null = null;
      for (let i = 0; i < symtab.nSyms; i++) {
        const entry = slice.offset + symtab.symOff + i * 16;
        const strx = buf.readUInt32LE(entry);
        const nSect = buf.readUInt8(entry + 5);
        const nValue = Number(buf.readBigUInt64LE(entry + 8));
        if (strx === 0 || strx >= symtab.strSize) continue;
        const symName = readCStr(buf, slice.offset + symtab.strOff + strx, strEnd);
        if (symName !== name) continue;
        if (nValue === 0 || nSect === 0) continue; // 非定义符号（如 ghost/Undef），跳过
        if (hit && hit.vmAddr !== nValue) {
          // 实测：链接器会对同名符号发「常规 + 别名」两条表目（n_value 相同、n_type 不同）——
          // 同地址是别名，放行；不同地址才是真歧义。
          throw new Error(`切片 ${archName(slice.cpuType)} 里 ${name} 解析到多个不同地址，结构有歧义`);
        }
        if (!hit) hit = { name, cpuType: slice.cpuType, vmAddr: nValue, fileOffset: vmToFile(segments, slice, nValue) };
      }
      if (!hit) {
        missing.push(`${archName(slice.cpuType)} 切片缺少 \`${name}\``);
      } else {
        sites.push(hit);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `未能在符号表定位补丁目标（该版本可能已 strip 符号或重命名类）：\n  ` +
      missing.join("\n  ") +
      `\n  重新定位方法见 docs/researches/activation-mac.md §10.2；本机未做任何改动。`,
    );
  }
  return sites;
}

/** 各 CPU 的 `ret` 编码（cputype 低 8 位分派；arm64e 同样用裸 ret——补丁点先于任何 paciasp）。 */
export function retBytesFor(cpuType: number): Buffer {
  const base = cpuType & 0xff;
  if (base === 0x0c) return Buffer.from([0xc0, 0x03, 0x5f, 0xd6]); // arm64: ret
  if (base === 0x07) return Buffer.from([0xc3]); // x86_64: retq
  throw new Error(`架构 ${archName(cpuType)} 的 ret 编码未实证，按显式失败处理`);
}

/** 规划补丁：对每个定位点，取当前盘上字节与目标 ret 编码（不写盘）。 */
export function planRetPatches(buf: Buffer, names: string[]): PatchOp[] {
  return locateSymbols(buf, names).map((site) => {
    const patch = retBytesFor(site.cpuType);
    const current = buf.subarray(site.fileOffset, site.fileOffset + patch.length);
    if (current.length !== patch.length) throw new Error(`补丁点越界：${site.name}（${archName(site.cpuType)}）`);
    return { site, current: Buffer.from(current), patch };
  });
}

/** 应用补丁（纯函数：返回副本，入参不动；等长覆盖，任何偏移不漂移）。 */
export function applyPatches(buf: Buffer, ops: PatchOp[]): Buffer {
  const out = Buffer.from(buf);
  for (const op of ops) {
    if (op.site.fileOffset + op.patch.length > out.length) throw new Error("补丁写入点越界");
    op.patch.copy(out, op.site.fileOffset);
  }
  return out;
}

/** 读取当前状态：每个 (名字 × 切片) 的入口是否已是 ret 模式（幂等判定；不校验被覆盖的原始内容）。 */
export function readPatchState(buf: Buffer, names: string[]): Array<{ site: SymbolSite; patched: boolean }> {
  return planRetPatches(buf, names).map((op) => ({ site: op.site, patched: op.current.equals(op.patch) }));
}

/* ---------------- entitlements 与 codesign ---------------- */

/** 重签时要追加的唯一 entitlement（研究报告 §10.4 的硬约束之一）。 */
const ENT_DISABLE_LIB_VALIDATION = "com.apple.security.cs.disable-library-validation";

/** 跑外部工具；不抛错，成败与 stdout/stderr 交给调用方（codesign -dv 的元数据在 stderr）。 */
function runTool(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf-8" });
  if (r.error) {
    return {
      ok: false,
      stdout: "",
      stderr: `无法执行 ${cmd}（${r.error.message}）——需要 Xcode Command Line Tools（xcode-select --install）`,
    };
  }
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * 从当前有效签名导出 entitlements（XML plist）。
 * 必须在改动二进制之前调用——旧签名是唯一可靠来源；二进制内的 DER blob 格式无契约，不解析。
 */
export function dumpEntitlementsXml(appDir: string): string {
  const r = runTool("codesign", ["-d", "--entitlements", "-", "--xml", appDir]);
  if (!r.ok) throw new Error(`导出 entitlements 失败：${r.stderr.trim()}`);
  const start = r.stdout.indexOf("<?xml");
  if (start < 0) throw new Error("codesign 未输出 XML entitlements（原签名可能没有 entitlements）");
  return r.stdout.slice(start);
}

/**
 * 幂等追加 disable-library-validation：插到**最外层** `</dict>`（最后一个）之前。
 * 纯文本变换（5 行、保形），合法性由 lintPlistFile 在使用前把关——不引入 plist 解析器。
 */
export function withDisableLibraryValidation(xml: string): string {
  if (xml.includes(ENT_DISABLE_LIB_VALIDATION)) return xml;
  const last = xml.lastIndexOf("</dict>");
  if (last < 0) throw new Error("entitlements 里没有 </dict>，结构意外");
  const inject = `<key>${ENT_DISABLE_LIB_VALIDATION}</key><true/>`;
  return xml.slice(0, last) + inject + xml.slice(last);
}

/** `plutil -lint` 把关：插入后的 entitlements 必须是合法 plist 才允许交给 codesign。 */
export function lintPlistFile(path: string): void {
  const r = runTool("plutil", ["-lint", path]);
  if (!r.ok) throw new Error(`entitlements 文件不是合法 plist：${(r.stdout + r.stderr).trim()}`);
}

/**
 * ad-hoc 重签（对 bundle 整体，绝不裸签可执行文件）。
 * 配方（研究报告 §10.4）：保留原 entitlements + 追加 disable-library-validation、保持 hardened runtime；
 * 刻意不用 --deep（会剥掉 Sparkle 的 Developer ID 签名）/ --timestamp（ad-hoc 无意义）/ --identifier。
 */
export function resignAdhoc(appDir: string, entFile: string): void {
  const r = runTool("codesign", [
    "--force", "--sign", "-", "--options", "runtime", "--entitlements", entFile, appDir,
  ]);
  if (!r.ok) {
    throw new Error(`ad-hoc 重签失败：${(r.stdout + r.stderr).trim()}\n  二进制已改但重签失败，应立即从备份还原。`);
  }
}

/** `codesign --verify --strict`。对嵌套框架同样成立（Sparkle 未被触碰、原签名仍有效）。 */
export function verifyStrict(appDir: string): boolean {
  return runTool("codesign", ["--verify", "--strict", "--verbose=2", appDir]).ok;
}

/** 签名形态：ad-hoc（hapora 重签过）/ developer-id（原始）/ unknown。每次现跑，绝不缓存。 */
export function signatureKind(appDir: string): "developer-id" | "adhoc" | "unknown" {
  // 新版 codesign 默认档不打印 Signature=/Authority= 行，须 --verbose=2 以上
  const r = runTool("codesign", ["-dv", "--verbose=2", appDir]);
  if (!r.ok) return "unknown";
  const meta = r.stdout + r.stderr;
  if (meta.includes("Signature=adhoc")) return "adhoc";
  if (meta.includes("Authority=Developer ID Application:")) return "developer-id";
  return "unknown";
}

/** 带 quarantine 的 ad-hoc 应用会被 Gatekeeper 拦：有则删（防御性；正常安装的本机应用没有）。 */
export function removeQuarantine(appDir: string): boolean {
  const probe = runTool("xattr", ["-p", "com.apple.quarantine", appDir]);
  if (!probe.ok) return false;
  return runTool("xattr", ["-d", "com.apple.quarantine", appDir]).ok;
}
