# Typora macOS 版激活机制逆向研究

- 样本：Typora `1.14.5-dev`（build 7776，官网渠道，`/Applications/Typora.app`），macOS arm64 真机。
- 方法：静态反汇编（`otool -tV -arch arm64`）+ Mach-O 常量提取（自写脚本解析 `__DATA` 的 CFString 结构）+ 对本机真实许可证记录文件做 AES 解密实证。全部结论均有可复现判据（见 §8）。
- 姊妹篇：Windows 版机制见 `activation-mechanism.md`（Electron 1.14.10 实证）。**两平台架构完全不同**，Windows 的结论不可迁移到 macOS。

## 1. 软件结构：macOS 版不是 Electron

这是本研究最重要的结论，推翻了本仓库早期文档（ADR-010、module-platform.md）的假设：

| 证据 | 判据 |
| --- | --- |
| 无 Electron 框架 | `Contents/Frameworks/` 只有 `Sparkle.framework` |
| 原生二进制 | `otool -L` 链接 `WebKit` / `Cocoa` / `AppKit` / `QuartzCore` 等系统框架；`strings` 中 "electron" 出现 0 次 |
| 无 asar | 包内不存在任何 `.asar` / `.jsc`；`Contents/Resources/` 是 `TypeMark/`（前端资源：`index.html`、`assets`、`page-dist` 等）+ 各语言 `lproj` |
| 渲染层 | WKWebView（偏好里有 `WKWebView_ver`；激活态经 `window._options.hasLicense=true` 注入前端） |
| 签名 | Developer ID（Team `9HWK5273G4`）+ hardened runtime + Sealed Resources（改包内任何文件都会使资源封印失效） |
| entitlements | `allow-dyld-environment-variables` / `allow-jit` / `allow-unsigned-executable-memory`；**无** `disable-library-validation` ⇒ library validation 生效，DYLD 注入第三方 dylib 会被拒绝 |

主进程逻辑全在 `Contents/MacOS/Typora`（约 3.3MB universal Mach-O）的 Objective-C 代码里，
许可证逻辑集中在 `LicenseManager` 类（43 个方法）。**没有明文入口文件、没有 JS 层可以注入**——
Windows 的「改 app.asar」路线在 macOS 上不存在落点。

## 2. 许可证存储：AES 加密的 keyed-archive 字典

### 2.1 存储位置与文件名

```
~/Library/Application Support/abnerworks.Typora/.<fingerprint>
```

- 目录名 = bundle id（`abnerworks.Typora`，来自 Info.plist 的 `CFBundleIdentifier`）。
- `fingerprint = Base64(SHA256(IOPlatformUUID))[0..10]`，再做字符替换 `/=+-` → `a`（与 Windows 的
  `.replace(/[/=+-]/g, "a")` 同构）。注意与 Windows 的两点差异：**输入是裸 IOPlatformUUID**
  （Windows 是 `MachineGuid + "typora"`），且不额外拼后缀。
- 另有一个旧版固定名文件 `.<Base64(SHA256(""))[0..10]>` = `.47DEQpj8HB`——该常量硬编码在二进制中，
  `-[LicenseManager fingerPrintOld]` 直接返回它。`readLicenseInfo` 在「上次运行版本 < 1.0.9」时会把旧文件
  迁移到新文件（`calcInstallDateFromOldConfig` / `writeLicenseInfo`）。

### 2.2 文件格式（已实测解密本机文件验证）

```
文件字节 = AES-256-CBC(零 IV, PKCS7) 加密的 NSKeyedArchive(NSMutableDictionary)
key      = SHA256(IOPlatformUUID + "typora-license") 的原始 32 字节
```

推导依据：`+[Crypto decryptAES:]` 反汇编——`rawMachineId`（IOPlatformExpertDevice 的
IOPlatformUUID）拼接字面量 `"typora-license"`，`rawHash:` 后取前 32 字节（`w4=0x20`）作为
CCCrypt 的 key；`x5=0`（IV 为 NULL ⇒ 全零 IV）、`w2=1`（PKCS7）。

解密后的明文是标准 NSKeyedArchive binary plist（`bplist00` 头、`$version=100000`、
`$archiver=NSKeyedArchiver`、`$top.root` 指向 `NSMutableDictionary`）。

本机实测的字典键（未激活态）：`finger`（字符串）、`installDate`（NSDate，Apple 纪元 2001-01-01 的
double 秒）；激活后还会出现 `email`、`license`、`lastTry`（NSDate）、`sig` / `oldSig` / `oldFinger`
（仅在线写入时使用，见 §4）。

### 2.3 生成记录文件的两个编码硬约束（实测踩坑）

自己拼 binary plist 时有两条极易踩的坑，`plistlib` 等宽容解析器**不会**报错，只有客户端用的
`NSKeyedUnarchiver` 会**静默返回 nil**（表现为「伪造被无视、状态回到未激活」，无任何报错）：

1. **int 的 marker 低 4 位是 log2(字节数)**：1 字节 `0x10`、2 字节 `0x11`、**4 字节 `0x12`、
   8 字节 `0x13`**。写成「`0x10 + 宽度 - 1`」会把 4 字节整数错标成 8 字节，解析器多读 4 字节，
   `$version` 与 `NS.time` 等一并损坏。
2. **`NS.time` 必须编码为 real（`0x23` 双精度）**：它语义上是 double；若某次时间戳恰好是整秒，
   退化成整数编码同样会让解档失败。

验证手段（以 `NSKeyedUnarchiver` 为准，而非 plistlib）：

```sh
swift -e 'import Foundation; let d = try! Data(contentsOf: URL(fileURLWithPath: "/tmp/plain.plist"));
         print(try NSKeyedUnarchiver.unarchiveTopLevelObjectWithData(d) as Any)'
#   期望输出形如 ["email": …, "license": …, "installDate": …, "lastTry": …]；为 nil 即编码不合格
```

## 3. 启动路径：不校验序列号内容，只看键是否存在

`-[LicenseManager start]` → `readLicenseInfo` → `renew`（§4）。`readLicenseInfo` 反汇编还原：

```objc
dict = [self _readLicenseInfo:recordFilePathNew];   // 解密 + NSKeyedUnarchiver，失败给空 dict
// （版本迁移逻辑：prevVersion 存在且 < 1.0.9 时从旧文件迁移）
self._hasLicense = @((dict[@"email"] != nil) && (dict[@"license"] != nil));   // 只判非 nil！
[self ensureInstallDate];
[self postNotification];    // 通知 UI：window._options.hasLicense=true
```

关键结论：

- **激活判定 = dict 里 `email` 与 `license` 两个键非 nil**。不比对类型、不比对内容、不做指纹匹配。
- 序列号的形状 / 字符集 / 校验位校验（`quickValidateLicense:`，见 §5）**只在用户手动输码的
  `activate:with:force:callback:` 流程里调用**（全二进制唯一调用点），启动路径完全不经过。
- 试用记账：`installDate` + `dayRemains` / `validateDevTrailEnd`；无 license 时按安装日起算。

因此伪造记录文件只需让 `email` / `license` 键非 nil 即可通过启动判定。

## 4. 续期（renew）：唯一会把激活打回的路径

`-[LicenseManager renew]` 反汇编还原（请求体键 `v` / `license` / `deviceId` / `u` 等，
端点 `POST {store.typora.io | dian.typora.com.cn}/api/client/renew`）：

```objc
if (!self._hasLicense.boolValue) return;
lastTry = self._licenseDict[@"lastTry"];
if (lastTry && !launchFromDifferentVer) {
    hours = [[NSCalendar currentCalendar] components:NSHourCalendarUnit
                fromDate:lastTry toDate:[NSDate new] options:0].hour;
    if (1 <= hours && hours < 12) return;      // 只有这个窗口内不续期！
}
// 否则（lastTry 缺失 / 版本升级首启 / hours<1 或 >=12）：
self._licenseDict[@"lastTry"] = now;           // 只改内存
[self sendPost:@"api/client/renew" data:body host:host callback:^(ok, resp) {
    if (!ok) {                 // 网络层失败（含镜像自动重试后仍失败）
        dict[@"failedCounts"] += 1;            // 只计数，不打回 —— 宽容分支
        return;
    }
    if (!resp[@"success"].boolValue) [self unfillLicense];        // 服务器明确拒绝
    else if (![self writeLicenseInfo:email license sig ...])     // 验签失败同样
        [self unfillLicense];
}];
```

要点：

1. **服务器明确 `success=false` 或写入验签失败 → `unfillLicense`**：清空 `_hasLicense`、把内存 dict
   重置为只剩 `installDate`，并 `writeLicenseInfo` + `writeLicenseInfoOld` **写回两个记录文件**
   （伪造痕迹被物理清除）。
2. **网络失败是宽容的**：`+[Utils objToJsonString:]` 用 `NSJSONSerialization` 序列化请求体；
   **值类型为 `NSDate` 等非 JSON 类型时序列化必然失败**，请求体为空，服务器对空体必然回非 200，
   `sendPost` 的回调 `ok = (statusCode == 200)` 为假 → 走宽容分支（不打回）。
3. **`1 ≤ hours(lastTry→now) < 12` 内不发请求**；`< 1h`、`≥ 12h`、`lastTry` 缺失、版本升级首启
   都会发起续期。任何静态的 `lastTry` 值都会随时间滑出窗口，单靠它不是长期解。

### 伪造配方（本仓库 darwin 实现的依据）

```
dict = {
  email:       <NSString，来自 .env / 默认值>,
  license:     <NSString，展示用序列号 —— 启动判定只看非 nil，不校验内容>,
  lastTry:     <NSDate = now - 2h —— 落在「1 ≤ hours < 12」窗口，启动时干脆不发请求>,
  installDate: <保留原值>,
  ...其余原有键原样保留（如 finger）...
}
```

防线的机制边界（实测结论）：

- `lastTry` 窗口是**唯一有效**的防线：窗口内不发 renew，激活保持。
- 曾尝试的第二道防线「`license` 用非字符串类型污染请求体，使 renew 序列化失败」**已被证伪**：
  请求体为空时服务器仍可能回 `200`，`sendPost` 判定 `statusCode == 200` 为真而响应体解析为空串，
  `resp[@"success"]` 为 nil ⇒ 仍走 `unfill`。该污染还会让许可证面板的序列号一栏显示为空，故已弃用。
- 因此激活有效期 = `lastTry` 窗口长度：**关机的机器在距上次 hack 超过 12 小时后重启会重新续期**，
  服务器对伪造序列号返回 `success=false` ⇒ `unfill` ⇒ 重跑 `pnpm hack` 即恢复。
  若 `.env` 配的是**真实有效**的序列号，续期会成功，则不受该窗口限制。

## 5. 本地校验算法（仅供输码流程，伪造不需要，但记录备查）

`quickValidateLicense:`（仅 `activate:` 调用）：

1. 形状正则：`^([A-Z0-9]{6}-){3}[A-Z0-9]{6}$`（与 Windows 相同）。
2. 字符集合法性：合法字符表 `L23456789ABCDEFGHJKMNPQRSTUVWXYZ`；实现是
   `split(by: charset) join ""` 与 `replace("-", "")` 的等值比较（对含 `-` 的合法序列号恒成立，
   实际拦截的是表外字符），失败打日志 `contains illegal char`。
3. 校验位（`genCheckSum:`）：取序列号去掉 `-` 后的 24 字符；偶数下标（0,2,…,12 共 7 个）与奇数下标
   （1,3,…,13 共 7 个）各按字符在合法表中的下标求和；两位校验字符 =
   `表[sumEven % 32] ++ 表[sumOdd % 32]`，必须等于去 `-` 序列号的第 22、23 位。失败打日志
   `checksum failed`。**注意：下标 14–21 的 8 个字符不参与校验，且整个过程与机器指纹无关。**

## 6. verifySig（在线写入时的服务器签名）

`-[LicenseManager verifySig:]`：把 dict 中除 `sig` / `oldSig` / `oldFinger` 之外的非空字段按 key
排序、拼接后验签（RSA，公钥在二进制内）。调用点唯一：`writeLicenseInfo:with:from:`（处理
activate / renew 的**服务器响应**时）。**启动读取路径不验签**——伪造文件不经过此方法。

## 7. 与 Windows 版的机制对照

| 维度 | Windows（Electron） | macOS（原生） |
| --- | --- | --- |
| 入口/落点 | `app.asar` 明文入口 JS，注入 hook | 无注入点；许可证逻辑在 Mach-O 里 |
| 存储 | 注册表 `HKCU\SOFTWARE\Typora` 的 `SLicense`/`IDate` | `~/Library/Application Support/<bundle id>/.<fingerprint>` AES plist |
| 本地判定 | RSA `publicDecrypt` 出 JSON，fingerprint 逐字符硬校验 | dict 里 `email`/`license` 键非 nil 即可 |
| fingerprint | `Base64(SHA256(MachineGuid+"typora"))[0..10]` 清洗 | `Base64(SHA256(IOPlatformUUID))[0..10]` 清洗，兼作记录文件名 |
| 续期失败 | 即 unfill | 网络/非 200 宽容；仅 `success=false` 或验签失败 unfill |
| 自校验 | 启动 ~1s 后 sha256 校验入口文件 | 无（改不动二进制也无需绕过） |
| 验收日志 | `%APPDATA%\Typora\typora.log` | 无文件日志；unified log 在启动路径无输出 ⇒ 本仓库改用「记录文件状态轮询」验收 |

## 8. 可复现判据

以下命令在本机（1.14.5-dev）可全部复现上述结论：

```sh
# 1. 非 Electron 结构
ls /Applications/Typora.app/Contents/Frameworks/            # 只有 Sparkle.framework
otool -L /Applications/Typora.app/Contents/MacOS/Typora | head   # WebKit/Cocoa，无 Electron

# 2. 许可证记录文件与指纹推导（IOPlatformUUID = DBBDF79C-… 时）
ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID
node -e 'const c=require("crypto");console.log(c.createHash("sha256").update("DBBDF79C-F2D2-5B80-98C5-B6B5F3D5E9A6").digest("base64").slice(0,10))'
#   → dqDZvcWQNA，即实际存在的文件名 ~/Library/Application\ Support/abnerworks.Typora/.dqDZvcWQNA

# 3. 解密记录文件（AES-256-CBC，零 IV，PKCS7；key=SHA256(uuid+"typora-license")）
KEY=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update("DBBDF79C-F2D2-5B80-98C5-B6B5F3D5E9A6"+"typora-license").digest("hex")')
openssl enc -d -aes-256-cbc -K $KEY -iv 00000000000000000000000000000000 \
  -in ~/Library/Application\ Support/abnerworks.Typora/.dqDZvcWQNA | head -c 8 | xxd
#   → 62 70 6c 69 73 74 30 30  ("bplist00")

# 4. 关键方法清单（arm64）
otool -oV -arch arm64 /Applications/Typora.app/Contents/MacOS/Typora | grep -A80 INSTANCE_METHODS_LicenseManager
otool -tV -arch arm64 /Applications/Typora.app/Contents/MacOS/Typora | less   # 反汇编 readLicenseInfo / renew / Crypto decryptAES: 等

# 5. 启动路径无日志（验收不能依赖 unified log）
open -a Typora; sleep 4
log show --last 20s --predicate 'process == "Typora"' --info   # 无许可证相关输出
```

## 9. 对本仓库的意义

macOS 的「hack」与 Windows 语义对齐（让本机 Typora 进入已激活状态）但路线完全不同：
**不触碰 `/Applications` 里的 Typora.app**（无提权、无签名破坏、升级免疫），只伪造
`~/Library` 下的许可证记录文件。详见 `docs/DECISIONS.md` ADR-011。
