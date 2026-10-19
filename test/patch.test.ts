/**
 * patch.js 的行为测试：在 vm 沙箱里执行**真实渲染出的补丁**，用可控的 crypto / fs / electron
 * 桩复现 Typora 的三类 publicDecrypt 调用，断言接管语义。
 *
 * 为什么用 vm 而不是真机：真机验收（pnpm hack --yes）只覆盖启动瞬间，而本轮修复针对的是
 * 启动约 9 分钟后、Math.random() 命中高值分支时才触发的周期性 RSA 自检（见 ADR-014）。
 * 这类「延迟 + 概率」路径无法进 CI，只能用桩在秒级复现。真机取证作为最终确认另行进行。
 *
 * 被测对象是 src/patch.ts 的 inject() 渲染产物里切出的补丁段——不是手抄的副本，
 * 因此模板一改，这里立刻跟着变。
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as nodeCrypto from "node:crypto";
import * as nodeStream from "node:stream";
import { EventEmitter } from "node:events";

import { inject, loadTemplate, PATCH_BEGIN, PATCH_END, LICENSE_MARKER } from "../src/patch.js";
import { DEFAULTS } from "../src/config.js";

/** 假的入口原文：inject() 按它现算自校验基准（SELF_SHA256 / SELF_B64 / SELF_LEN）。 */
const FAKE_ENTRY = '"use strict";\n// typora fake entry for test\n';
const FAKE_ENTRY_NAME = "launch.dist.js";

/** 渲染补丁并切出 IIFE 段（占位符已替换成真实值）。 */
function renderPatch(config = DEFAULTS): string {
  const { patched } = inject(FAKE_ENTRY_NAME, FAKE_ENTRY, loadTemplate(), config);
  const begin = patched.indexOf(PATCH_BEGIN);
  const end = patched.indexOf(PATCH_END);
  assert.ok(begin >= 0 && end > begin, "渲染产物里必须含补丁标记");
  return patched.slice(begin, end + PATCH_END.length);
}

/** inject() 算出的自校验基准，供自校验放行测试比对。 */
function selfBaseline(config = DEFAULTS) {
  return inject(FAKE_ENTRY_NAME, FAKE_ENTRY, loadTemplate(), config);
}

/* ---------- 可控的 RSA 模拟器 ----------
 * 复现真实 publicDecrypt 的三种输入：
 *   1. 真实许可证密文（256B，合法）→ 解出许可证 JSON
 *   2. 自检密文（256B，合法）    → 解出固定的**非 JSON** 明文（Issue 的根因场景）
 *   3. hapora 标记（20B，非法）  → 抛 DATA_LEN_NOT_EQUAL_TO_MOD_LEN
 */
const REAL_LICENSE_CIPHER = Buffer.alloc(256, 0x11);
const SELFCHECK_CIPHER = Buffer.alloc(256, 0x22);
const MARKER_CIPHER = Buffer.from(LICENSE_MARKER, "utf8"); // 18 字节，长度非法（RSA 模长要求 256）

const REAL_LICENSE_JSON = JSON.stringify({
  deviceId: "0MA-",
  fingerprint: "REALFP0000",
  email: "buyer@example.com",
  license: "AAAAAA-BBBBBB-CCCCCC-DDDDDD",
  version: "win|1.14.10",
  date: 1_700_000_000_000,
  type: "",
});
/** 自检期望的固定明文：100 字节、非 JSON、不含 '{'（Issue 里 AI 反编译得到的形态）。 */
const SELFCHECK_PLAINTEXT = Buffer.concat([
  Buffer.from("typora-selfcheck-v1:", "utf8"),
  Buffer.alloc(82, 0xab),
]);

function makeRsaSimulator() {
  const calls: Array<{ dataLen: number; head: string }> = [];
  const publicDecrypt = (_key: unknown, data: Buffer) => {
    calls.push({ dataLen: data.length, head: data.subarray(0, 4).toString("hex") });
    if (data.length !== 256) {
      // 与真机日志一致的 OpenSSL 报错（研究报告 §3.1）
      throw new Error("error:04000070:RSA routines:OPENSSL_internal:DATA_LEN_NOT_EQUAL_TO_MOD_LEN");
    }
    if (data.equals(REAL_LICENSE_CIPHER)) return Buffer.from(REAL_LICENSE_JSON, "utf8");
    if (data.equals(SELFCHECK_CIPHER)) return Buffer.from(SELFCHECK_PLAINTEXT);
    throw new Error("error:04000070:RSA routines:OPENSSL_internal:DATA_LEN_NOT_EQUAL_TO_MOD_LEN");
  };
  return { publicDecrypt, calls };
}

/* ---------- vm 执行环境 ---------- */

interface RunOptions {
  config?: typeof DEFAULTS;
  /** native-reg 桩返回的 MachineGuid（决定指纹）；undefined 表示 native-reg 不可用 */
  machineGuid?: string;
  /** 额外要记录的路径读取（自校验放行测试用） */
  rsa?: ReturnType<typeof makeRsaSimulator>;
}

interface RunResult {
  crypto: Record<string, any>;
  fs: Record<string, any>;
  net: { request: (opts: any) => any; calls: string[] };
  rsaCalls: Array<{ dataLen: number; head: string }>;
}

function runPatch(opts: RunOptions = {}): RunResult {
  const rsa = opts.rsa ?? makeRsaSimulator();
  const config = opts.config ?? DEFAULTS;
  const code = renderPatch(config);

  // crypto 用真实模块的浅拷贝，只替换 publicDecrypt —— 避免污染测试进程的全局 crypto
  const cryptoStub: Record<string, any> = { ...nodeCrypto, publicDecrypt: rsa.publicDecrypt };

  const readPaths: string[] = [];
  const fsStub: Record<string, any> = {
    readFileSync: (p: any) => {
      readPaths.push(String(p));
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readFile: () => {},
    promises: { readFile: () => Promise.reject(new Error("ENOENT")) },
  };

  const netCalls: string[] = [];
  const electronStub = {
    net: {
      request: (options: any) => {
        const url = typeof options === "string" ? options : options?.href || options?.url || "";
        netCalls.push(String(url));
        return { passthrough: true, url };
      },
    },
  };

  const nativeRegStub =
    opts.machineGuid === undefined
      ? null
      : {
          Access: { READ: 1 },
          HKEY: { LOCAL_MACHINE: 1 },
          WOW64_64KEY: 1,
          openKey: () => ({}),
          getValue: () => opts.machineGuid,
          closeKey: () => {},
        };

  const fakeRequire = (name: string) => {
    switch (name) {
      case "crypto": return cryptoStub;
      case "fs": return fsStub;
      case "path": return { join: (...a: string[]) => a.join("/") };
      case "events": return { EventEmitter };
      case "stream": return nodeStream;
      case "electron": return electronStub;
      case "native-reg":
        if (!nativeRegStub) throw new Error("native-reg unavailable");
        return nativeRegStub;
      case "child_process":
        return { execSync: () => { throw new Error("reg.exe unavailable"); } };
      default: throw new Error(`unexpected require: ${name}`);
    }
  };

  const sandbox: Record<string, any> = {
    require: fakeRequire,
    process: { nextTick: process.nextTick.bind(process), uptime: () => 1, env: {}, platform: "win32" },
    Buffer,
    console,
    __dirname: "/fake/Typora/resources/app.asar",
    setTimeout,
    clearTimeout,
    readPaths,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: "patch.js" });

  return {
    crypto: cryptoStub,
    fs: fsStub,
    net: { request: electronStub.net.request, calls: netCalls },
    rsaCalls: rsa.calls,
  };
}

/* ================= 1. publicDecrypt 接管（本轮修复的核心） ================= */

test("自检密文：解密成功且明文非 JSON → 必须原样放行（不得替换成许可证）", () => {
  const r = runPatch();
  const out = r.crypto.publicDecrypt("KEY", SELFCHECK_CIPHER);
  assert.deepEqual(
    out,
    SELFCHECK_PLAINTEXT,
    "自检明文被篡改会导致 Typora 的 Buffer.equals 比较失败 → 撤销激活并清空 SLicense（Issue 现象）",
  );
  assert.notEqual(out.toString("utf8").charAt(0), "{", "自检明文不是 JSON");
});

test("真实许可证密文：解出 JSON → 原样放行", () => {
  const r = runPatch();
  const out = r.crypto.publicDecrypt("KEY", REAL_LICENSE_CIPHER);
  assert.equal(out.toString("utf8"), REAL_LICENSE_JSON);
  assert.equal(JSON.parse(out.toString("utf8")).email, "buyer@example.com");
});

test("hapora 标记密文：解密抛错 → 返回伪造许可证载荷", () => {
  const r = runPatch();
  const out = r.crypto.publicDecrypt("KEY", MARKER_CIPHER);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.email, DEFAULTS.email);
  assert.equal(parsed.license, DEFAULTS.licenseCode);
  assert.equal(parsed.deviceId, "0MA-");
  assert.equal(parsed.type, "");
  assert.ok(parsed.fingerprint, "伪造载荷必须带 fingerprint");
});

test("空 Buffer / 长度非法的密文 → 一律落回伪造载荷，不抛错", () => {
  const r = runPatch();
  for (const bad of [Buffer.alloc(0), Buffer.alloc(1, 1), Buffer.alloc(255, 3), Buffer.alloc(257, 4)]) {
    const out = r.crypto.publicDecrypt("KEY", bad);
    assert.doesNotThrow(() => JSON.parse(out.toString("utf8")), `长度 ${bad.length} 应返回合法 JSON`);
  }
});

test("配置里的邮箱与序列号会进入伪造载荷", () => {
  const config = { email: "custom@mail.test", licenseCode: "ZZZZZZ-YYYYYY-XXXXXX-WWWWWW" };
  const r = runPatch({ config });
  const parsed = JSON.parse(r.crypto.publicDecrypt("KEY", MARKER_CIPHER).toString("utf8"));
  assert.equal(parsed.email, config.email);
  assert.equal(parsed.license, config.licenseCode);
});

/* ================= 2. 指纹的 [/=+-] → "a" 替换（AGENTS.md 点名的静默失效陷阱） ================= */

test("指纹必须做 [/=+-]→a 替换：用会命中特殊字符的 MachineGuid 验证", () => {
  // 该 GUID 的 Base64(SHA256(guid+"typora"))[0..10] = "+tc+TtrMfF"，含两个 '+'
  const guid = "383072f8-e8f4-4a2c-9c1a-000000000004";
  const raw = nodeCrypto.createHash("sha256").update(guid + "typora").digest("base64").slice(0, 10);
  assert.match(raw, /[/=+-]/, "测试前提：该 GUID 的原始指纹前缀必须含特殊字符，否则测不到替换");

  const r = runPatch({ machineGuid: guid });
  const parsed = JSON.parse(r.crypto.publicDecrypt("KEY", MARKER_CIPHER).toString("utf8"));
  assert.equal(parsed.fingerprint, raw.replace(/[/=+-]/g, "a"), "指纹必须与客户端算法逐字符一致");
  assert.equal(parsed.fingerprint, "atcaTtrMfF");
  assert.doesNotMatch(parsed.fingerprint, /[/=+-]/, "清洗后不得残留特殊字符");
});

test("MachineGuid 读不到时指纹退化（已知失败模式，不得抛错）", () => {
  const r = runPatch({ machineGuid: undefined });
  const parsed = JSON.parse(r.crypto.publicDecrypt("KEY", MARKER_CIPHER).toString("utf8"));
  // 退化值 = SHA256("" + "typora") 前 10 位清洗后；客户端会因对不上而拒绝，但补丁本身不能崩
  const degraded = nodeCrypto.createHash("sha256").update("typora").digest("base64").slice(0, 10).replace(/[/=+-]/g, "a");
  assert.equal(parsed.fingerprint, degraded);
});

/* ================= 3. 自校验放行（双层，互为兜底） ================= */

test("哈希层：对「长度等于补丁后入口且含补丁标记」的数据算 sha256 → 返回随包发布内容的基准哈希", () => {
  const baseline = selfBaseline();
  const r = runPatch();
  // 构造命中条件：字节长度 = 补丁后入口长度，且含补丁标记
  const staged = Buffer.alloc(baseline.selfLen, 0x20);
  Buffer.from(PATCH_BEGIN, "utf8").copy(staged, 0);
  const digest = r.crypto.createHash("sha256").update(staged).digest("hex");
  assert.equal(digest, baseline.selfSha256, "哈希层必须把自检哈希倒带成随包发布内容的 sha256");
});

test("哈希层：普通数据（长度不符 / 无补丁标记）必须原样透传", () => {
  const r = runPatch();
  const data = Buffer.from("some unrelated payload", "utf8");
  const got = r.crypto.createHash("sha256").update(data).digest("hex");
  const want = nodeCrypto.createHash("sha256").update(data).digest("hex");
  assert.equal(got, want, "非自身数据的哈希不得被篡改（机器指纹就靠它）");
});

test("哈希层：机器指纹的 sha256 调用不受影响", () => {
  const guid = "383072f8-e8f4-4a2c-9c1a-000000000004";
  const r = runPatch({ machineGuid: guid });
  // 触发一次指纹计算（内部会 createHash("sha256").update(guid+"typora")）
  r.crypto.publicDecrypt("KEY", MARKER_CIPHER);
  const want = nodeCrypto.createHash("sha256").update(guid + "typora").digest("base64");
  const got = r.crypto.createHash("sha256").update(guid + "typora").digest("base64");
  assert.equal(got, want, "指纹哈希必须透传，否则指纹算错 → 静默失效");
});

test("读取层：读入口路径返回随包发布的原文（不是补丁后的内容）", async () => {
  const baseline = selfBaseline();
  const r = runPatch();
  const entryPath = "/fake/Typora/resources/app.asar/" + FAKE_ENTRY_NAME;
  const got = r.fs.readFileSync(entryPath);
  assert.equal(got.toString("utf8"), FAKE_ENTRY, "readFileSync 命中入口时必须倒带回原文");
  assert.equal(
    nodeCrypto.createHash("sha256").update(got).digest("hex"),
    baseline.selfSha256,
    "倒带后的内容哈希必须等于基准（这样 Typora 自校验才会通过）",
  );
  // 大小写不同也要命中（normPath 会转小写）
  assert.equal(r.fs.readFileSync("/fake/TYPORA/resources/app.asar/Launch.dist.js").toString("utf8"), FAKE_ENTRY);
});

test("读取层：非入口路径原样透传（不得影响 package.json 等其他读取）", () => {
  const r = runPatch();
  assert.throws(() => r.fs.readFileSync("/fake/Typora/resources/app.asar/package.json"), /ENOENT/);
});

/* ================= 4. 续期 / 更新接管 ================= */

test("续期：/api/client/* 返回 success:true 且 msg 是许可证标记的 base64", async () => {
  const r = runPatch();
  const req = r.net.request({ href: "https://store.typora.io/api/client/renew" });
  assert.equal(req.passthrough, undefined, "许可证接口不得透传到真实网络");
  const res: any = await new Promise((resolve) => {
    req.on("response", resolve);
    req.end();
  });
  assert.equal(res.statusCode, 200);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve());
  });
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(body.success, true);
  assert.equal(Buffer.from(body.msg, "base64").toString("utf8"), LICENSE_MARKER);
});

test("更新检查：/releases/*.json 回报当前版本 ⇒ 无更新提示", async () => {
  const r = runPatch();
  const req = r.net.request("https://typoraio.cn/releases/windows_64.json");
  const res: any = await new Promise((resolve) => {
    req.on("response", resolve);
    req.end();
  });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve());
  });
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(body.name, "typora");
  assert.equal(typeof body.version, "string");
});

test("其他 URL 原样透传（不得影响页面资源加载）", () => {
  const r = runPatch();
  const req = r.net.request({ href: "https://example.com/asset.png" });
  assert.equal(req.passthrough, true);
  assert.deepEqual(r.net.calls, ["https://example.com/asset.png"]);
});

test("请求在 end() 前被 abort → 不发出响应（避免幽灵事件）", async () => {
  const r = runPatch();
  const req = r.net.request({ href: "https://store.typora.io/api/client/renew" });
  let responded = false;
  req.on("response", () => { responded = true; });
  req.abort();
  req.end();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(responded, false);
});

/* ================= 5. 模板契约 ================= */

test("补丁保持 ES5：不得出现箭头函数 / let / const / 模板串 / class", () => {
  const code = renderPatch();
  // 去掉注释与字符串后检查语法形态（注释里允许出现这些词）
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  assert.doesNotMatch(stripped, /=>/, "不得使用箭头函数");
  assert.doesNotMatch(stripped, /\blet\s/, "不得使用 let");
  assert.doesNotMatch(stripped, /\bconst\s/, "不得使用 const");
  assert.doesNotMatch(stripped, /`/, "不得使用模板串");
  assert.doesNotMatch(stripped, /\bclass\s/, "不得使用 class");
});

test("每个占位符在模板里只出现一次（渲染契约）", () => {
  const template = loadTemplate();
  for (const slot of [
    "__HAPORA_SELF_SHA256__", "__HAPORA_SELF_B64__", "__HAPORA_SELF_LEN__",
    "__HAPORA_ENTRY__", "__HAPORA_MARKER__", "__HAPORA_LICENSE_KEY__", "__HAPORA_EMAIL__",
  ]) {
    const n = template.split(slot).length - 1;
    assert.equal(n, 1, `${slot} 必须恰好出现一次，实际 ${n} 次`);
  }
});

test("渲染后不得残留任何占位符", () => {
  const code = renderPatch();
  assert.doesNotMatch(code, /__HAPORA_[A-Z0-9_]+__/, "渲染后仍有未替换的占位符");
});
