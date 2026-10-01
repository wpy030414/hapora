/**
 * macOS 许可证记录文件的读写与伪造（darwin 平台私有，机制依据见 docs/researches/activation-mac.md）。
 *
 * 记录文件 = AES-256-CBC（零 IV、PKCS7）加密的 NSKeyedArchive(NSMutableDictionary)：
 *   key    = SHA256(IOPlatformUUID + "typora-license") 的原始 32 字节
 *   文件名 = "." + Base64(SHA256(IOPlatformUUID))[0..10]（"/=+-" 替换为 "a"）
 *   目录   = ~/Library/Application Support/<CFBundleIdentifier>/
 *
 * 本文件实现三件事：
 *   1. binary plist 的最小编解码器（封闭类型集：dict / array / string / date / bool / int / UID 引用）；
 *   2. NSKeyedArchive(NSMutableDictionary) 的组装与解引用；
 *   3. 记录文件的解密读取、加密写入与伪造生成。
 */

import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/* ---------------- 机器标识与密钥派生 ---------------- */

let cachedUuid: string | null = null;

/** IOPlatformUUID（macOS 的 MachineGuid 等价物）。读不到返回空串——密钥会随之失配，调用方须显式失败。 */
export function machineUuid(): string {
  if (cachedUuid !== null) return cachedUuid;
  try {
    const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    cachedUuid = m ? m[1] : "";
  } catch {
    cachedUuid = "";
  }
  return cachedUuid;
}

/** 记录文件名里的指纹：Base64(SHA256(uuid))[0..10]，"/=+-" → "a"（与客户端 fingerPrintNew 一致）。 */
export function fingerprint(uuid: string): string {
  const b64 = createHash("sha256").update(uuid, "utf-8").digest("base64");
  return b64.slice(0, 10).replace(/[/=+-]/g, "a");
}

/** AES 密钥：SHA256(uuid + 盐) 的原始 32 字节。盐是客户端的密钥派生常量（逆向所得）。 */
function deriveKey(uuid: string): Buffer {
  return createHash("sha256").update(`${uuid}typora-license`, "utf-8").digest();
}

/** 记录文件路径（不校验存在性）。 */
export function recordPath(bundleId: string, uuid: string): string {
  return join(homedir(), "Library", "Application Support", bundleId, `.${fingerprint(uuid)}`);
}

/* ---------------- binary plist 最小编解码 ---------------- */

/** plist 里的 Date 纪元：2001-01-01T00:00:00Z。 */
const APPLE_EPOCH_MS = 978307200000;

/** 编码时用于表达「UID 引用数组」的内部形态（NS.keys / NS.objects / __uids__）。 */
interface UidArray {
  readonly __uids__: number[];
}
const isUidArray = (v: unknown): v is UidArray =>
  v !== null && typeof v === "object" && !Array.isArray(v) && "__uids__" in (v as object);

export type PLValue = string | Date | number | boolean | PLValue[] | UidArray | { [key: string]: PLValue };

/** 解码时的 UID（NSKeyedArchive 引用，由 decodeKeyedArchive 解引用）。 */
export class PlistUid {
  constructor(readonly value: number) {}
}

function beInt(n: number, width: number): Buffer {
  const b = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) {
    b[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return b;
}

/** 容器/字符串的 count：小于 15 放 marker 低 4 位，否则 0xF + 独立 int 编码。 */
function countBytes(n: number): Buffer {
  if (n < 15) return Buffer.from([n]);
  const w = n < 0x100 ? 1 : n < 0x10000 ? 2 : 4;
  return Buffer.concat([Buffer.from([0xf]), Buffer.from([0x10 + (w - 1)]), beInt(n, w)]);
}

/** 序列化为 binary plist。容器（array/dict）的元素是固定宽度的对象表引用，因此先收集对象再统一序列化。 */
function encodeBplist(root: PLValue): Buffer {
  type Obj =
    | { t: "bool"; v: boolean }
    | { t: "int"; v: number }
    | { t: "real"; v: number }
    | { t: "string"; v: string }
    | { t: "date"; v: Date }
    | { t: "uid"; v: number }
    | { t: "array"; items: number[] }
    | { t: "dict"; entries: Array<[number, number]> };

  const objs: Obj[] = [];
  const intern = new Map<string, number>(); // 字符串去重，贴近 Apple 输出

  const add = (o: Obj): number => {
    objs.push(o);
    return objs.length - 1;
  };
  const addString = (s: string): number => {
    const hit = intern.get(s);
    if (hit !== undefined) return hit;
    const idx = add({ t: "string", v: s });
    intern.set(s, idx);
    return idx;
  };
  const addValue = (v: PLValue): number => {
    if (typeof v === "boolean") return add({ t: "bool", v });
    if (typeof v === "number") return Number.isInteger(v) ? add({ t: "int", v }) : add({ t: "real", v });
    if (typeof v === "string") return addString(v);
    if (v instanceof Date) return add({ t: "date", v });
    if (v instanceof PlistUid) return add({ t: "uid", v: v.value });
    if (Array.isArray(v)) return add({ t: "array", items: v.map(addValue) });
    if (isUidArray(v)) return add({ t: "array", items: v.__uids__.map((u) => add({ t: "uid", v: u })) });
    // 普通 dict
    const entries = Object.keys(v).map((k) => [addString(k), addValue((v as { [key: string]: PLValue })[k]!)] as [number, number]);
    return add({ t: "dict", entries });
  };

  const top = addValue(root);
  const refWidth = objs.length < 0x100 ? 1 : 2;
  /** marker 低 4 位是内联 count；count ≥ 15 时写 0xF 并跟独立 int 编码。 */
  const markerWithCount = (base: number, n: number): Buffer => {
    if (n < 15) return Buffer.from([base | n]);
    const w = n < 0x100 ? 1 : n < 0x10000 ? 2 : 4;
    return Buffer.concat([Buffer.from([base | 0xf]), Buffer.from([0x10 + (w - 1)]), beInt(n, w)]);
  };

  const serialize = (o: Obj): Buffer => {
    switch (o.t) {
      case "bool":
        return Buffer.from([o.v ? 0x09 : 0x08]);
      case "int": {
        const v = o.v;
        const w = v < 0x100 ? 1 : v < 0x10000 ? 2 : v < 0x100000000 ? 4 : 8;
        return Buffer.concat([Buffer.from([0x10 + (w - 1)]), beInt(v, w)]);
      }
      case "real": {
        const b = Buffer.alloc(8);
        b.writeDoubleBE(o.v, 0);
        return Buffer.concat([Buffer.from([0x23]), b]);
      }
      case "string": {
        const ascii = /^[\x00-\x7f]*$/.test(o.v);
        const payload = ascii ? Buffer.from(o.v, "latin1") : Buffer.from(o.v, "utf16le").swap16();
        return Buffer.concat([markerWithCount(ascii ? 0x50 : 0x60, o.v.length), payload]);
      }
      case "date": {
        const b = Buffer.alloc(8);
        b.writeDoubleBE((o.v.getTime() - APPLE_EPOCH_MS) / 1000, 0);
        return Buffer.concat([Buffer.from([0x33]), b]);
      }
      case "uid": {
        const w = o.v < 0x100 ? 1 : o.v < 0x10000 ? 2 : 3;
        return Buffer.concat([Buffer.from([0x80 + (w - 1)]), beInt(o.v, w)]);
      }
      case "array":
        return Buffer.concat([
          markerWithCount(0xa0, o.items.length),
          ...o.items.map((i) => beInt(i, refWidth)),
        ]);
      case "dict":
        return Buffer.concat([
          markerWithCount(0xd0, o.entries.length),
          ...o.entries.map(([k]) => beInt(k, refWidth)),
          ...o.entries.map(([, v]) => beInt(v, refWidth)),
        ]);
    }
  };

  const blobs = objs.map(serialize);
  let total = 8;
  for (const b of blobs) total += b.length;
  const offsetWidth = total < 0x100 ? 1 : total < 0x10000 ? 2 : 4;

  const chunks: Buffer[] = [Buffer.from("bplist00", "latin1")];
  const offsets: number[] = [];
  let cursor = 8;
  for (const b of blobs) {
    offsets.push(cursor);
    chunks.push(b);
    cursor += b.length;
  }
  for (const off of offsets) chunks.push(beInt(off, offsetWidth));
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(offsetWidth, 6);
  trailer.writeUInt8(refWidth, 7);
  trailer.writeBigUInt64BE(BigInt(objs.length), 8);
  trailer.writeBigUInt64BE(BigInt(top), 16);
  trailer.writeBigUInt64BE(BigInt(cursor), 24); // offset table 起始 = 对象区结束处
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

/** 解析 binary plist。支持本文件编码的全部类型；其它 marker 抛错（调用方按「读不到」处理）。 */
function decodeBplist(buf: Buffer): PLValue {
  if (buf.subarray(0, 8).toString("latin1") !== "bplist00") throw new Error("not a bplist");
  const tail = buf.subarray(buf.length - 32);
  const offsetWidth = tail.readUInt8(6); // trailer：5B unused + sortVersion + offsetSize + refSize + 3×8B
  const refWidth = tail.readUInt8(7);
  const numObjects = Number(tail.readBigUInt64BE(8));
  const topObject = Number(tail.readBigUInt64BE(16));
  const tableOffset = Number(tail.readBigUInt64BE(24));

  const readRefAt = (p: number): number => {
    let v = 0;
    for (let i = 0; i < refWidth; i++) v = v * 256 + buf.readUInt8(p + i);
    return v;
  };
  const objOffset = (idx: number): number => {
    let v = 0;
    for (let i = 0; i < offsetWidth; i++) v = v * 256 + buf.readUInt8(tableOffset + idx * offsetWidth + i);
    return v;
  };
  const readCount = (p: number): { count: number; next: number } => {
    const marker = buf.readUInt8(p);
    if ((marker & 0x0f) !== 0x0f) return { count: marker & 0x0f, next: p + 1 };
    const w = 2 ** (buf.readUInt8(p + 1) & 0x0f);
    let v = 0;
    for (let i = 0; i < w; i++) v = v * 256 + buf.readUInt8(p + 2 + i);
    return { count: v, next: p + 2 + w };
  };

  const cache = new Map<number, PLValue>();

  const parse = (idx: number): PLValue => {
    const hit = cache.get(idx);
    if (hit !== undefined) return hit;
    const p = objOffset(idx);
    const marker = buf.readUInt8(p);
    const kind = marker >> 4;

    let result: PLValue;
    switch (kind) {
      case 0x0: {
        if (marker === 0x08) result = false;
        else if (marker === 0x09) result = true;
        else throw new Error(`bplist marker 0x${marker.toString(16)} unsupported`);
        break;
      }
      case 0x1: {
        const w = 2 ** (marker & 0x0f);
        let v = 0;
        for (let i = 0; i < w; i++) v = v * 256 + buf.readUInt8(p + 1 + i);
        result = v;
        break;
      }
      case 0x2: {
        const w = 2 ** (marker & 0x0f);
        result = w === 8 ? buf.readDoubleBE(p + 1) : buf.readFloatBE(p + 1);
        break;
      }
      case 0x3: {
        if (marker !== 0x33) throw new Error(`bplist marker 0x${marker.toString(16)} unsupported`);
        result = new Date(APPLE_EPOCH_MS + buf.readDoubleBE(p + 1) * 1000);
        break;
      }
      case 0x5:
      case 0x6: {
        const { count, next } = readCount(p);
        result =
          kind === 0x5
            ? buf.toString("latin1", next, next + count)
            : buf.subarray(next, next + count * 2).swap16().toString("utf16le");
        break;
      }
      case 0x8: {
        const w = (marker & 0x0f) + 1;
        let v = 0;
        for (let i = 0; i < w; i++) v = v * 256 + buf.readUInt8(p + 1 + i);
        result = new PlistUid(v);
        break;
      }
      case 0xa: {
        const { count, next } = readCount(p);
        const items: PLValue[] = [];
        for (let i = 0; i < count; i++) items.push(parse(readRefAt(next + i * refWidth)));
        result = items;
        break;
      }
      case 0xd: {
        const { count, next } = readCount(p);
        const obj: { [key: string]: PLValue } = {};
        for (let i = 0; i < count; i++) {
          const key = parse(readRefAt(next + i * refWidth));
          const val = parse(readRefAt(next + (count + i) * refWidth));
          const keyStr =
            typeof key === "string" ? key : key instanceof PlistUid ? `uid:${key.value}` : String(key);
          obj[keyStr] = val;
        }
        result = obj;
        break;
      }
      default:
        throw new Error(`bplist marker 0x${marker.toString(16)} unsupported`);
    }
    cache.set(idx, result);
    return result;
  };

  if (topObject >= numObjects) throw new Error("bad top object");
  return parse(topObject);
}

/* ---------------- NSKeyedArchive(NSMutableDictionary) 的组装与解引用 ---------------- */

const CLASS_CHAINS = {
  mutableDict: ["NSMutableDictionary", "NSDictionary", "NSObject"],
  string: ["NSString", "NSObject"],
  date: ["NSDate", "NSObject"],
} as const;

/**
 * 按 Typora 实测的存档形态组装 keyed archive（研究报告 §2.2）：
 *   $objects[0]="$null"；[1]=根 dict 的 {NS.keys, NS.objects, $class}；
 *   其后是各键、各值（string 裸放、date 用 {NS.time,$class} 包装）与 $class 条目。
 */
function encodeKeyedArchive(dict: Map<string, PLValue>): Buffer {
  const objects: PLValue[] = ["$null", null as unknown as PLValue]; // [1] 先占位
  const rootIdx = 1;
  const stringIdx = new Map<string, number>();
  const classIdx = new Map<string, number>();

  const add = (v: PLValue): number => {
    objects.push(v);
    return objects.length - 1;
  };
  const addString = (s: string): number => {
    const hit = stringIdx.get(s);
    if (hit !== undefined) return hit;
    const idx = add(s);
    stringIdx.set(s, idx);
    return idx;
  };
  const addClass = (chain: readonly string[]): number => {
    const name = chain[0]!;
    const hit = classIdx.get(name);
    if (hit !== undefined) return hit;
    const idx = add({ $classname: name, $classes: [...chain] });
    classIdx.set(name, idx);
    return idx;
  };
  const addValue = (v: PLValue): number => {
    if (typeof v === "string") return addString(v);
    if (v instanceof Date) {
      const cls = addClass(CLASS_CHAINS.date);
      const entry: { [key: string]: PLValue } = { $class: uidOf(cls) };
      entry["NS.time"] = (v.getTime() - APPLE_EPOCH_MS) / 1000;
      return add(entry);
    }
    if (typeof v === "boolean" || typeof v === "number") return add(v);
    throw new Error(`记录值类型不支持：${typeof v}`);
  };
  const uidOf = (idx: number): PlistUid => new PlistUid(idx);

  const keyRefs: number[] = [];
  const valRefs: number[] = [];
  for (const [k, v] of dict) {
    keyRefs.push(addString(k));
    valRefs.push(addValue(v));
  }
  const dictClass = addClass(CLASS_CHAINS.mutableDict);
  objects[rootIdx] = {
    "NS.keys": { __uids__: keyRefs },
    "NS.objects": { __uids__: valRefs },
    $class: uidOf(dictClass),
  };

  return encodeBplist({ $version: 100000, $archiver: "NSKeyedArchiver", $top: { root: uidOf(rootIdx) }, $objects: objects });
}

/** 解开 NSKeyedArchive，取根 NSMutableDictionary 的键值（UID 全部解引用，NS.time 解包为 Date）。 */
function decodeKeyedArchive(buf: Buffer): Map<string, PLValue> {
  const top = decodeBplist(buf) as { [key: string]: PLValue };
  const objects = top["$objects"] as PLValue[];
  const rootRef = (top["$top"] as { [key: string]: PLValue })["root"];

  const resolve = (v: PLValue): PLValue => {
    if (v instanceof PlistUid) return resolve(objects[v.value]!);
    return v;
  };

  const out = new Map<string, PLValue>();
  const root = resolve(rootRef) as { [key: string]: PLValue } | null;
  if (!root || root["NS.keys"] === undefined) return out;
  const keys = root["NS.keys"] as PlistUid[];
  const vals = root["NS.objects"] as PlistUid[];
  for (let i = 0; i < keys.length; i++) {
    const k = resolve(keys[i]!);
    if (typeof k !== "string") continue;
    const v = resolve(vals[i]!);
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && "NS.time" in v) {
      out.set(k, new Date(APPLE_EPOCH_MS + (v["NS.time"] as number) * 1000));
    } else {
      out.set(k, v);
    }
  }
  return out;
}

/* ---------------- 记录文件读写与伪造 ---------------- */

export type LicenseRecord = Map<string, PLValue>;

/** 读记录文件并解密解档；不存在 / 解密失败 / 结构不对都返回 null（视为「没有记录」）。 */
export function readRecord(path: string, uuid: string): LicenseRecord | null {
  let cipher: Buffer;
  try {
    cipher = readFileSync(path);
  } catch {
    return null;
  }
  try {
    const dec = createDecipheriv("aes-256-cbc", deriveKey(uuid), Buffer.alloc(16));
    const plain = Buffer.concat([dec.update(cipher), dec.final()]);
    return decodeKeyedArchive(plain);
  } catch {
    return null;
  }
}

/** 把记录加密写盘（目录不存在则创建；文件权限沿用 umask，记录文件无敏感增量）。 */
export function writeRecord(path: string, uuid: string, record: LicenseRecord): void {
  const plain = encodeKeyedArchive(record);
  const enc = createCipheriv("aes-256-cbc", deriveKey(uuid), Buffer.alloc(16));
  const out = Buffer.concat([enc.update(plain), enc.final()]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out);
}

/**
 * 生成伪造记录（研究报告 §4 的配方）：
 *   email / license 键非 nil        ⇒ 启动判定（readLicenseInfo）通过；
 *   license 用 Date 类型污染        ⇒ renew 请求体无法 JSON 序列化，兜底走网络失败宽容分支；
 *   lastTry = now - 2h              ⇒ 落在「1 ≤ hours < 12」的不续期窗口，启动时干脆不发请求。
 * 原有键（installDate / finger 等）原样保留，保证与 Typora 自己的写入互不干扰。
 */
export function buildForgedRecord(
  input: { email: string; licenseCode: string; now: Date },
  existing: LicenseRecord | null,
): LicenseRecord {
  const rec = new Map(existing ?? []);
  const twoHoursAgo = new Date(input.now.getTime() - 2 * 3600 * 1000);
  rec.set("email", input.email);
  rec.set("license", twoHoursAgo); // 类型污染：值是什么无所谓，键非 nil 即可，类型不是 string 就行
  rec.set("lastTry", twoHoursAgo);
  if (!rec.has("installDate")) rec.set("installDate", input.now);
  rec.delete("failedCounts");
  return rec;
}

/** 记录是否呈现「已激活」（email 与 license 键均存在——与客户端判定完全一致）。 */
export function recordLooksActivated(rec: LicenseRecord | null): boolean {
  return !!rec && rec.get("email") != null && rec.get("license") != null;
}
