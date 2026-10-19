/**
 * 回归对照：钉死 ADR-014 的 bug（周期性 RSA 自检明文被误替换 → 激活被撤销）。
 *
 * 这个文件的存在只有一个目的：证明 test/patch.test.ts 里那条「自检密文原样放行」的断言
 * **不是假阳性**——它必须能区分旧判据与新判据。做法是把两种判据并排跑同一组输入：
 *
 *   旧判据（有 bug）：解密成功且明文以 '{' 开头才放行，否则返回伪造载荷
 *                    ⇒ 自检密文的合法非 JSON 明文被换成许可证 JSON ⇒ Buffer.equals 失败 ⇒ 撤销激活
 *   新判据（已修复）：解密成功一律放行，只有抛错才伪造
 *
 * 再断言当前 src/inject/patch.js 渲染出的补丁采用的是新判据。
 * 真机取证（沙箱 Typora + 强制触发自检）作为最终确认，见 docs/DECISIONS.md ADR-014。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { inject, loadTemplate, LICENSE_MARKER, PATCH_BEGIN, PATCH_END } from "../src/patch.js";
import { DEFAULTS } from "../src/config.js";

/** 自检密文解出的合法明文：非 JSON、不以 '{' 开头（Issue 里 AI 反编译得到的形态）。 */
const SELFCHECK_PLAINTEXT = Buffer.concat([Buffer.from("typora-selfcheck-v1:", "utf8"), Buffer.alloc(82, 0xab)]);
const REAL_LICENSE_JSON = Buffer.from('{"deviceId":"0MA-","email":"a@b.c"}', "utf8");
const FAKE_LICENSE_JSON = Buffer.from(JSON.stringify({ deviceId: "0MA-", fingerprint: "F", email: DEFAULTS.email }), "utf8");

/** 旧判据：只有明文以 '{' 开头才原样返回，其余（含合法自检明文）一律替换成伪造载荷。 */
function oldPolicy(decrypted: Buffer | null, threw: boolean): Buffer {
  if (!threw && decrypted && decrypted.toString("utf8").charAt(0) === "{") return decrypted;
  return FAKE_LICENSE_JSON;
}

/** 新判据：解密成功原样返回（透明），只有抛错才伪造。 */
function newPolicy(decrypted: Buffer | null, threw: boolean): Buffer {
  if (!threw && decrypted) return decrypted;
  return FAKE_LICENSE_JSON;
}

test("旧判据在自检密文上产生 bug：合法明文被替换（复现 Issue 现象）", () => {
  const out = oldPolicy(SELFCHECK_PLAINTEXT, false);
  assert.deepEqual(out, FAKE_LICENSE_JSON, "旧判据把自检明文换成了许可证 JSON");
  assert.notDeepEqual(out, SELFCHECK_PLAINTEXT);
  // Typora 的自检是 decrypted.equals(expected)；被替换后必然为 false ⇒ 撤销激活
  assert.equal(out.equals(SELFCHECK_PLAINTEXT), false, "equals 比较失败 ⇒ onUnfillLicense ⇒ SLicense 被清空");
});

test("新判据在自检密文上正确：合法明文透明放行（equals 通过）", () => {
  const out = newPolicy(SELFCHECK_PLAINTEXT, false);
  assert.deepEqual(out, SELFCHECK_PLAINTEXT);
  assert.equal(out.equals(SELFCHECK_PLAINTEXT), true, "自检通过 ⇒ 激活不被撤销");
});

test("两种判据在真实许可证与非法标记上行为一致（修复不改变既有正确路径）", () => {
  // 真实许可证（JSON）：两者都原样放行
  assert.deepEqual(oldPolicy(REAL_LICENSE_JSON, false), REAL_LICENSE_JSON);
  assert.deepEqual(newPolicy(REAL_LICENSE_JSON, false), REAL_LICENSE_JSON);
  // 非法标记（抛错）：两者都伪造
  assert.deepEqual(oldPolicy(null, true), FAKE_LICENSE_JSON);
  assert.deepEqual(newPolicy(null, true), FAKE_LICENSE_JSON);
});

test("当前 patch.js 模板采用新判据（成功即 return，不以 '{' 为条件）", () => {
  const { patched } = inject("launch.dist.js", '"use strict";\n', loadTemplate(), DEFAULTS);
  const begin = patched.indexOf(PATCH_BEGIN);
  const end = patched.indexOf(PATCH_END);
  const code = patched.slice(begin, end + PATCH_END.length);

  // 定位 publicDecrypt 接管段
  const hook = code.slice(code.indexOf("crypto.publicDecrypt = function"));
  const body = hook.slice(0, hook.indexOf("/* ---------- 3."));

  // 新判据的特征：try 块里直接 return 原实现结果，catch 里返回伪造
  assert.match(body, /return origPublicDecrypt\.apply\(this, arguments\);/, "必须在 try 里直接返回原实现结果");
  // 旧判据的特征（以 '{' 开头才放行）必须已消失
  assert.doesNotMatch(body, /charAt\(0\)\s*===\s*"\{"/, "旧的『以 { 开头才放行』判据必须已移除");
  assert.doesNotMatch(body, /\[0\]\s*===\s*123/, "不得以任何形式保留『首字节是 {』判据");
});

test("标记密文长度确实非法（这是伪造分支的唯一触发条件）", () => {
  const len = Buffer.from(LICENSE_MARKER, "utf8").length;
  assert.notEqual(len, 256, "标记不是 256 字节 ⇒ publicDecrypt 必抛 DATA_LEN_NOT_EQUAL_TO_MOD_LEN");
  assert.ok(len < 256, `实际 ${len} 字节，远小于 RSA 模长`);
});
