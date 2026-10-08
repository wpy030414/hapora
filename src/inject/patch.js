/* === hapora license patch === */
/*
 * 由 pnpm hack 注入到 Typora 入口文件的最前面（"use strict" 之后，见 src/patch.ts）。
 * 占位符只在下方各出现一次，勿在注释里重复书写。
 */
(function () {
  var fs = require("fs");
  var path = require("path");
  var crypto = require("crypto");
  var EventEmitter = require("events").EventEmitter;

  var APP_DIR = __dirname;
  var MARKER = "__HAPORA_MARKER__";
  var ENTRY_NAME = "__HAPORA_ENTRY__";
  var SELF_SHA256 = "__HAPORA_SELF_SHA256__";
  var SELF_B64 = "__HAPORA_SELF_B64__";
  var SELF_LEN = parseInt("__HAPORA_SELF_LEN__", 10);
  var LICENSE_KEY = "__HAPORA_LICENSE_KEY__";
  var LICENSE_EMAIL = "__HAPORA_EMAIL__";
  var PATCH_TAG = "/* === hapora license patch === */";

  /* ---------- 0. 环境信息（版本号与机器指纹） ---------- */
  function appVersion() {
    try {
      return JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version || "0.0.0";
    } catch (e) {
      return "0.0.0";
    }
  }
  function machineId() {
    try {
      var reg = require("native-reg");
      var a = reg.Access;
      var key = reg.openKey(reg.HKEY.LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Cryptography", a.READ, a.WOW64_64KEY);
      var v = reg.getValue(key, null, "MachineGuid");
      reg.closeKey(key);
      if (v) return String(v);
    } catch (e) { /* 回退到 reg.exe */ }
    try {
      var out = require("child_process").execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid /reg:64',
        { encoding: "utf8", windowsHide: true }
      );
      var m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m) return m[1];
    } catch (e) { /* 读取失败 */ }
    /* Linux：/etc/machine-id（systemd 标准，Ubuntu / Fedora / Arch 均适用） */
    try {
      var id = require("fs").readFileSync("/etc/machine-id", "utf8").trim();
      if (id && id.length >= 32) return id;
    } catch (e) { /* 回退到 dbus */ }
    try {
      var id = require("fs").readFileSync("/var/lib/dbus/machine-id", "utf8").trim();
      if (id && id.length >= 32) return id;
    } catch (e) { /* 读取失败 */ }
    return "";
  }
  /* 指纹必须是客户端自己算出来的那一份：sha256(MachineGuid + "typora") 的 base64 前 10 位，
   * 再把 [/=+-] 一律换成 "a"（Typora 自己就是这么做的，末尾的 replace 不能省——
   * 少了它，base64 里出现 / + = - 的机器（约一半）会因指纹对不上而拒绝我们伪造的载荷）。 */
  function fingerprint() {
    return crypto.createHash("sha256").update(machineId() + "typora").digest("base64")
      .slice(0, 10).replace(/[/=+-]/g, "a");
  }
  function fakeLicense() {
    return {
      deviceId: "0MA-",
      fingerprint: fingerprint(),
      email: LICENSE_EMAIL,
      license: LICENSE_KEY,
      version: "win|" + appVersion(),
      date: Date.now(),
      type: "",
    };
  }

  /* ---------- 1. 自校验放行 ----------
   * 启动约 1s 后 Typora 会：读 package.json 取 main → 读 main 指向的本文件 →
   * sha256 → 与随包发布的基准比对，不一致就记录 [LC] 并退出。
   * 两层放行：
   *   (a) 读取层——凡是读本文件，一律把「随包发布的内容」还回去，校验自然通过，
   *       而且与校验用什么算法、怎么比对无关；
   *   (b) 哈希层——万一读取走的是别的通道，就在 digest 上直接返回基准值兜底。
   */
  function normPath(p) {
    try {
      if (p && typeof p === "object" && !Buffer.isBuffer(p) && p.href) p = p.href;
      return String(p).replace(/\\/g, "/").toLowerCase();
    } catch (e) {
      return "";
    }
  }
  var ENTRY_NORM = normPath(path.join(APP_DIR, ENTRY_NAME));
  function isEntry(p) {
    return normPath(p) === ENTRY_NORM;
  }
  var pristine = null;
  function pristineBytes() {
    if (!pristine) pristine = Buffer.from(SELF_B64, "base64");
    return pristine;
  }
  function pristineAs(opt) {
    var enc = typeof opt === "string" ? opt : (opt && opt.encoding) || null;
    return enc ? pristineBytes().toString(enc) : pristineBytes();
  }

  var origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, opt) {
    if (isEntry(p)) return pristineAs(opt);
    return origReadFileSync.apply(this, arguments);
  };

  var origReadFile = fs.readFile;
  fs.readFile = function (p, opt, cb) {
    if (isEntry(p)) {
      if (typeof opt === "function") { cb = opt; opt = null; }
      var v = pristineAs(opt);
      process.nextTick(function () { cb(null, v); });
      return;
    }
    return origReadFile.apply(this, arguments);
  };

  if (fs.promises && typeof fs.promises.readFile === "function") {
    var origPromisesReadFile = fs.promises.readFile;
    fs.promises.readFile = function (p, opt) {
      if (isEntry(p)) return Promise.resolve(pristineAs(opt));
      return origPromisesReadFile.apply(this, arguments);
    };
  }

  function looksLikeSelf(d) {
    try {
      var len = typeof d === "string" ? Buffer.byteLength(d) : (d && d.length);
      if (len !== SELF_LEN) return false;
      if (typeof d === "string") return d.indexOf(PATCH_TAG) >= 0;
      return Buffer.isBuffer(d) && d.indexOf(PATCH_TAG) >= 0;
    } catch (e) {
      return false;
    }
  }
  var origCreateHash = crypto.createHash;
  crypto.createHash = function (alg) {
    var h = origCreateHash.apply(this, arguments);
    var hit = false;
    var ou = h.update, od = h.digest;
    h.update = function (d) {
      try {
        if (!hit && String(alg).toLowerCase() === "sha256" && looksLikeSelf(d)) hit = true;
      } catch (e) { /* 忽略 */ }
      return ou.apply(this, arguments);
    };
    h.digest = function (enc) {
      if (hit) {
        var b = Buffer.from(SELF_SHA256, "hex");
        return enc ? b.toString(String(enc)) : b;
      }
      return od.apply(this, arguments);
    };
    return h;
  };

  /* ---------- 2. 作废激活校验：劫持 publicDecrypt 的返回值 ----------
   * 许可证密文经 publicDecrypt 解密后即为许可证 JSON。
   * 对无法解密的密文直接返回本地构造的许可证载荷，于是任意 SLicense 都能通过本地校验。
   */
  var origPublicDecrypt = crypto.publicDecrypt;
  crypto.publicDecrypt = function () {
    try {
      var out = origPublicDecrypt.apply(this, arguments);
      if (out.toString("utf8").charAt(0) === "{") return out; /* 真实许可证：原样放行 */
    } catch (e) { /* 密文非法（长度不对 / 填充不对）→ 落入伪造载荷 */ }
    return Buffer.from(JSON.stringify(fakeLicense()), "utf8");
  };

  /* ---------- 3. 伪造许可证服务器响应 & 屏蔽更新检查 ---------- */
  var LICENSE_API = /\/api\/client\//;
  var RELEASE_JSON = /\/releases\/[^?#]*\.json/;

  function fakeResponse(url, statusCode, body) {
    var Readable = require("stream").Readable;
    var req = new EventEmitter();
    req.url = url;
    req.method = "POST";
    req.aborted = false;
    req.write = function () { return true; };
    req.abort = function () { this.aborted = true; };
    req.destroy = function () { this.aborted = true; };
    req.setHeader = function () {};
    req.getHeader = function () { return null; };
    req.removeHeader = function () {};
    req.followRedirect = function () {};
    req.end = function () {
      var self = this;
      process.nextTick(function () {
        if (self.aborted) return;
        var res = new Readable({ read: function () {} });
        res.statusCode = statusCode;
        res.statusMessage = "OK";
        res.headers = {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        };
        self.emit("response", res);
        res.push(Buffer.from(body, "utf8"));
        res.push(null);
      });
      return this;
    };
    return req;
  }

  try {
    var net = require("electron").net;
    if (net && typeof net.request === "function") {
      var origRequest = net.request;
      net.request = function (options) {
        var url = typeof options === "string" ? options : (options && (options.href || options.url)) || "";
        if (LICENSE_API.test(url)) {
          /* 续期 / 激活 / 反激活一律返回成功，msg 供下一次解密使用 */
          return fakeResponse(url, 200, JSON.stringify({
            success: true,
            code: 1,
            msg: Buffer.from(MARKER).toString("base64"),
          }));
        }
        if (RELEASE_JSON.test(url)) {
          /* 更新检查：回报「当前已是最新」，等价于屏蔽更新 */
          return fakeResponse(url, 200, JSON.stringify({
            name: "typora",
            version: appVersion(),
            releaseNoteLink: "",
            download: "",
            downloadCN: "",
            alternatives: {},
          }));
        }
        return origRequest.apply(net, arguments);
      };
    }
  } catch (e) { /* electron 不可用时静默降级 */ }
})();
/* === end hapora license patch === */
