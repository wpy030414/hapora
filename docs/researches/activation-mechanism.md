# Typora 激活机制研究报告

> 样本：Typora `1.14.10`（安装器版本 `42.2.0`），Electron `42.2.0` / Node `24.15.0`，Windows 11
> 安装路径：`%ProgramFiles%\Typora` 或 `%LOCALAPPDATA%\Programs\Typora`
> 研究方法：在明文入口 `launch.dist.js` 中注入探针（Hook `crypto`、`electron.net`、`fs`、`child_process`），
> 逐次启动读取 `%APPDATA%\Typora\typora.log`，用运行时可观测行为反推逻辑。

---

## 1. 软件结构

```
Typora.exe
└── resources/
    ├── app.asar                # 只有三个文件
    │   ├── launch.dist.js      # 明文入口（1383 B），注册 .jsc 加载器后 require 字节码
    │   ├── atom.compiled.dist.jsc   # V8 字节码（388344 B），全部业务逻辑
    │   └── package.json        # {"main":"launch.dist.js","version":"1.14.10"}
    ├── node_modules.asar       # electron-fetch / native-reg / fswin / spellchecker 等
    ├── lib.asar                # 前端库
    ├── page-dist/              # 渲染进程页面（license.html / welcome.html / window.html）
    ├── appsrc/ style/ updater/ assets/
    └── app.asar.hapora-orig.bak  # 本仓库留下的原始备份（首次执行 pnpm hack 时创建）
```

`launch.dist.js` 是整个 asar 里唯一的明文 JS，它做三件事：

1. `v8.setFlagsFromString("--no-lazy")` / `--no-flush-bytecode`；
2. 注册 `Module._extensions[".jsc" | ".cjsc"]`：读文件 → 修补 12..16 字节的 flag hash → 用
   `new vm.Script(<r-2 个零宽空格构成的假源码>, { cachedData })` 反序列化字节码；
3. `require("./atom.compiled.dist.jsc")`。

因此**补丁的唯一落点就是 `launch.dist.js`**——它在字节码之前执行，且是纯文本。

## 2. 许可证的存储

### 2.1 注册表 `HKCU\SOFTWARE\Typora`

| 键 | 类型 | 说明 |
|---|---|---|
| `SLicense` | REG_SZ | `<Base64 密文>#<状态位>#<日期 M/D/YYYY>` |
| `IDate` | REG_SZ | 安装日期，`M/D/YYYY` |

`SLicense` 的密文部分由客户端先做 Base64 解码再送进 RSA 解密；解码失败或长度不对也照样送进去，
由 OpenSSL 报错（实测 `ERROR error:04000070:RSA routines:OPENSSL_internal:DATA_LEN_NOT_EQUAL_TO_MOD_LEN`）。
解密失败时客户端会把 `SLicense` 写成服务端返回的失败原因原文（实测出现过
`This device has been deactivated#0#9/27/2026`）。

### 2.2 `%APPDATA%\Typora\profile.data`

内容是**整个 JSON 字符串的十六进制编码**（不是裸 JSON），字段包含 `uuid`、`version`、`_iD`、
`skipUpdate`、窗口位置、各类编辑器偏好等。`uuid` 在首次运行时生成。

## 3. 启动时的许可证流程

实测日志（已激活状态）：

```
[watch L]
[WindowsLicenseLocalStore] SLicense : <base64>#0#<date>
pure = undefined                     # 未启用纯 JS RSA，走原生 crypto
renew                                # 触发续期
[renewLicense]: {"v":"win|1.14.10","license":"…","l":"0MA-","u":"<uuid>","type":""}
[L] pass                             # 本地解密通过
[WindowsLicenseLocalStore] IDate : <date>
[L] installDate is …                # 试用期记账
[watch L] hasL: true
[renewLicense]: license renewed      # 续期成功
```

失败路径：

```
[renewL]: unfill due to renew fail
onUnfillLicense                      # hasL 会被改回 false
```

要点：

- **本地解密成功 → 立即 `hasL: true`**；但随后会发续期请求，**续期失败会把 hasL 打回 false**。
  所以只伪造本地许可证是不够的，必须让续期也「成功」。
- 解密函数在 `crypto.publicDecrypt` 与一份纯 JS RSA（`jsDecrypt`，含完整 ASN.1 / PKCS#1 填充实现）之间二选一，
  日志里的 `pure = undefined / pure = true / pure js failed` 就是这个分支。

## 4. 许可证密文的格式

启动时 Hook `crypto.publicDecrypt` 抓到的实参：

```
key  = -----BEGIN PUBLIC KEY----- MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A…（2048-bit RSA，标准 SPKI/PEM）
data = 256 字节 Buffer（Base64 解码后的密文）
```

解密结果是**一段纯 JSON**：

```json
{
  "deviceId": "0MA-",
  "fingerprint": "XXXXXXXXXX",
  "email": "<购买者邮箱>",
  "license": "<序列号，形状 ([A-Z0-9]{6}-){3}[A-Z0-9]{6}>",
  "version": "win|1.14.x",
  "date": "<Unix ms>",
  "type": ""
}
```

**本地校验不比对 `email` / `date` / `version` / 许可证号内容**（这几项逐个改成无意义值，仍然 `[L] pass`）。

但 **`fingerprint` 是硬校验**：必须与客户端自己算出来的那一份**逐字符相等**，否则报 `no info` +
`onUnfillLicense` + `hasL: false`，而且**不写任何错误日志**——表现就是「补丁装了，但没激活」。
早期「只要求能解析成 JSON」的结论是错的，原因见 §4.1：当时研究机算出的指纹恰好不含特殊字符，
把这条约束掩盖掉了。（复核方法：拿一份确定能通过的载荷，**只改 `fingerprint` 一个字段**，
其余原样——一票就能分辨。）

### 4.1 机器指纹

```
fingerprint = Base64(SHA256(MachineGuid + "typora"))[0..10].replace(/[/=+-]/g, "a")
MachineGuid = HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid（WOW64_64KEY）
```

**末尾那次替换必须写**，这是最容易漏的一步：客户端算完指纹后会再跑一次
`"<10 位>".replace(/[/=+-]/g, "a")`（实测抓到的调用：输入 `yvhGV/vuID`，模式 `/[/=+-]/`，替换串 `a`）。
base64 字母表里含 `+` `/` `=`，10 位前缀中出现它们的概率约一半，所以**约一半的机器**上少写这一步
就会静默失效，而另一部分机器上一切正常——这正是它极易被误判成「只在这台机器上坏」的原因。

本机实测（`MachineGuid = 383072f8-…-629f795d9725`）：

```
SHA256("…9725typora") → base64 = yvhGV/vuID29a/GE0xOFdLL10eH2mUngVHt8UmbkgCo=
slice(0, 10)                   = yvhGV/vuID     ← 少一次替换，被拒
.replace(/[/=+-]/g, "a")       = yvhGVavuID     ← 与许可证里的 fingerprint 完全一致
```

> 注意：`fingerprint` 用的是 `MachineGuid`，而续期请求里的 `u` 用的是 `profile.data` 的 `uuid`，两者不同源。

**另一条容易读错的地方**：启动时解密走的就是 `crypto.publicDecrypt`，但它发生在日志里
`[WindowsLicenseLocalStore] SLicense` 与 `pure = undefined` **之后约 125ms**——
`typora.log` 的毫秒计数**不等于** `process.uptime()`，两者相差约 120ms。
照日志时间戳推断「决定发生在解密之前」会得出完全错误的结论（这个坑也踩过）。

## 5. 联网协议

### 5.1 传输层

许可证请求由 `electron-fetch` 发出，最终落到 `electron.net.request`（Chromium 的 URLLoader）。

- 请求体走 `req.write()`，随后 `req.end()`；
- 响应被 electron-fetch 当作 Node 流处理（内部执行 `res.pipe(body)`），
  **伪造响应必须是真正的 `stream.Readable`**，否则会抛
  `FetchError: Invalid response: res.pipe is not a function`。
- 服务端地址取决于 `profile.data.useMirrorInCN`：为真时用 `https://dian.typora.com.cn`，否则 `https://store.typora.io`。

### 5.2 续期

```
POST {mirror}/api/client/renew
{"v":"win|1.14.10","license":"<来自许可证 JSON>","l":"<deviceId>","u":"<uuid>","type":""}

成功响应：{"success":true, "msg":"<新的 Base64 许可证密文>"}
失败响应：{"success":false,"msg":"This device has been deactivated"}
```

客户端在成功时会把 `msg#0#<日期>` 写回注册表 `SLicense`；失败时把 `msg` 原文写回，并在下一次启动
解析失败 —— 这就是「设备被反激活」在本地留下的痕迹。

### 5.3 激活 / 反激活

`POST {mirror}/api/client/activate`、`/api/client/deactivate`，请求头 `Content-Type: application/json`、
`Cache-Control: no-cache`。激活流程在客户端先做许可证号格式校验（字符集
`L23456789ABCDEFGHJKMNPQRSTUVWXYZ`、形状 `^([A-Z0-9]{6}-){3}[A-Z0-9]{6}$`、校验位 `checksum failed`），
再带上机器标签 `l`、指纹 `f`、uuid `u` 与服务端交互。

### 5.4 更新检查

```
GET https://typoraio.cn/releases/windows_64.json
```

响应是固定结构的 JSON：

```json
{"name":"typora","version":"1.14.10","releaseNoteLink":"…",
 "download":"…","downloadCN":"…","alternatives":{"6.1":{"version":"…"}, …}}
```

客户端比对 `version` 与自身版本决定是否提示更新。把这份 JSON 的 `version` 换成当前版本，
更新检查就会得出「已是最新」，不会有任何弹窗。

## 6. 自校验（反篡改）

这是本项目最花时间才定位到的一环。

**行为**：启动约 1 秒后，主进程会执行一次许可证控制器检查；如果它认为程序被改过，就往
`typora.log` 写：

```
ERROR … [LC] l
ERROR … Integrity check failed
```

紧接着自己 `app.quit()` —— 窗口一闪而过。

**机制**（用探针 + 主进程 Inspector 抓到的调用栈还原）：

```
Timeout._onTimeout          (jsc @ 0x76543)      ← 启动后 1000ms 的定时器
  └─ Aa()                   (jsc @ 0x76046 / 0x76059)
       ├─ fs.promises.readFile("…/app.asar/package.json")     ← 先取 main
       ├─ fs.promises.readFile("…/app.asar/<main>")           ← 再读入口文件
       └─ crypto.createHash("sha256").update(读到的 Buffer).digest(…)
```

即：**读 `package.json` 取出 `main`，读 `main` 指向的文件，算 sha256 与内置基准比对**。
基准值就是「该版本随包发布的入口文件内容的 sha256」——这一点由补丁的实测反证：
把入口改名但内容一字不改，校验照样失败（说明它只认 `main` 指定的那个路径）；
把 `main` 指向另一份内容相同的副本，校验通过。

几个反直觉的细节：

- 报错文案 `Integrity check failed` **不在 asar 里、也不在 `page-dist` 里**，全机器只有 `Typora.exe`
  里有一处同名前缀（属于 Electron 的 asar 校验，日志格式不同）。这说明它是运行时拼出来的、被
  应用自己的 logger 打出去，因此靠文本搜索找不到落点。
- 校验**没有**用 `readFileSync`，用的是 `fs.promises.readFile`；
- 校验**没有**读 asar header 的 `integrity` 字段，基准值是内置常量（改 header 无用）。

**结论**：只要动了入口文件，这个校验必然失败；所以补丁必须**同时伪造这次读取**。

顺带确认的无关噪声：日志里的 `net::ERR_FILE_NOT_FOUND` 与 `[LC]` 无关，未打补丁的原版也会出现。

## 7. 试用期

`IDate`（注册表）与 `profile.data._iD` 共同参与记账，日志给出
`[L] installDate is <date>, trail remains: N days`，试用期 15 天。
在本机实测中 `trailRemains` 恒为 0 —— 即使把 `IDate` 改成当天也不会回升，
说明该版本另有隐藏的记账点。因此**重置试用期这条捷径在本版本上不可用**，
这也是必须走「接管校验链路」的原因之一。

## 8. 结论：可行的接管点

在被改对象上，只有三个位置值得动，且全部位于明文入口文件里（顺序即执行顺序）：

| 位置 | 作用 |
|---|---|
| `fs.readFile(Sync)` / `fs.promises.readFile` + `crypto.createHash` | 把入口文件的读取「倒带」回随包发布的内容 / 直接返回基准哈希 ⇒ 通过第 6 节的自校验 |
| `crypto.publicDecrypt` | 让任意密文都能解出合法许可证 JSON，且 `fingerprint` 必须等于客户端自己算的那一份（§4.1）⇒ `[L] pass` / `hasL: true` |
| `electron.net.request` | 让续期返回 `{success:true}` ⇒ 不被 `onUnfillLicense` 打回；让更新 JSON 回报当前版本 ⇒ 无更新弹窗 |

三者都不需要网关、不需要 hosts、不需要改字节码。

**与版本无关的性质**：自校验的基准是「该版本自己那份入口文件」的哈希，而补丁在打包时就是按这份
实际内容现算的，所以基准天然对齐；入口名从 `package.json` 的 `main` 读取，注入位置固定在文件最前面，
不依赖入口里的任何语句形式。真正可能随版本变化、且无法从安装里推出来的是**许可证载荷的字段名**
与**接口路径**——这两项由 `pnpm hack` 的启动验收兜底：一旦不匹配，失败可归因于补丁，脚本会自动回滚。

---

*本报告仅用于软件逆向工程研究。*
