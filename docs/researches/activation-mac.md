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

### 伪造配方（ADR-012 路线：二进制补丁 + 记录伪造双管齐下）

```
dict = {
  email:       <NSString，来自 .env / 默认值>,
  license:     <NSString，展示用序列号 —— 启动判定只看非 nil，不校验内容>,
  lastTry:     <NSDate = now - 48h（金丝雀，刻意落在 [1,12) 窗口之外）>,
  installDate: <保留原值>,
  ...其余原有键原样保留（如 finger）...
}
```

防线的机制边界（实测结论）：

- 记录路线时代的主防线是「`lastTry` 落在窗口内不发请求」，但任何静态值都会随时间滑出窗口
  ——**单靠记录不是长期解**（这正是 ADR-012 改走二进制补丁的动因）。
- 曾尝试的第二道防线「`license` 用非字符串类型污染请求体，使 renew 序列化失败」**已被证伪**：
  请求体为空时服务器仍可能回 `200`，`sendPost` 判定 `statusCode == 200` 为真而响应体解析为空串，
  `resp[@"success"]` 为 nil ⇒ 仍走 `unfill`。该污染还会让许可证面板的序列号一栏显示为空，故已弃用。
- **现行防线（ADR-012）**：二进制补丁短路 `renew`（§10），记录永不过期。`lastTry = now − 48h`
  金丝雀的价值：(a) 窗口外的记录存活本身就是「renew 已被中和」的自证（每次 hack 验收自动证明）；
  (b) 补丁因升级失效时，下一次启动**立刻可见地** unfill，而非 10 小时后静默过期。
  若 `.env` 配的是**真实有效**的序列号，续期会成功，本就不受该窗口限制。

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
| 自校验 | 启动 ~1s 后 sha256 校验入口文件 | 无（无需绕过；改的是二进制本身，无完整性自检） |
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

> **路线修订**：§4 已证明记录路线的激活有效期 = `lastTry` 窗口（约 10 小时静默失效），
> 与 Windows 的「一次激活、永久有效」不对齐。自 ADR-012 起，macOS 改走「Mach-O 二进制补丁」
> 路线：短路 `-[LicenseManager renew]`，配合 §10 的补丁点与重签配方实现永久激活。
> 本节「不触碰 /Applications」的表述由 §10 / ADR-012 取代；§1–§8 的机制结论不受影响。

## 10. Mach-O 补丁点与重签名（ADR-012 路线的实证依据）

样本仍是 `1.14.5-dev`（build 7776）。本节全部命令对**原始**（未 hack）二进制可复现。

### 10.1 补丁目标为什么是 `renew` 而不是别的

- `unfillLicense` 的全部调用点：renew 回调（服务器 `success=false` / 验签失败）+ 手动输码
  `activate:` 失败。后者是用户主动行为，不设防。
- `quickValidateLicense:` 只在手动输码流程（全二进制唯一调用点），启动路径不经过——补它无意义。
- 启动判定（§3）只看记录里 `email`/`license` 键非 nil，无日期逻辑 ⇒ **伪造记录仍不可省**；
  补丁的作用只有一个：让唯一会打回激活的 `renew` 永不运行 ⇒ 记录永不过期。
- 在方法 IMP 首指令写 `ret` 覆盖**所有** `objc_msgSend` 派发路径（调用方走 selref，
  不存在绕过 IMP 的直连调用）；等长替换 ⇒ 任何后续指令与偏移都不漂移。

### 10.2 符号定位（版本无关，无任何硬编码偏移）

二进制**未剥离本地符号**，两个架构的符号表都直接给出方法 IMP 的虚拟地址：

```sh
BIN=/Applications/Typora.app/Contents/MacOS/Typora
nm -arch arm64 -U "$BIN" | grep '\[LicenseManager renew\]'
#   00000001000731f8 t -[LicenseManager renew]
nm -arch x86_64 -U "$BIN" | grep '\[LicenseManager renew\]'
#   0000000100089ed7 t -[LicenseManager renew]
```

程序化定位法则（darwin-macho.ts 的实现依据）：解析 fat 头（大端）取各切片偏移 →
在切片内解析 `LC_SYMTAB`，按符号名精确匹配取 `n_value`（vm 地址）→ 按**包含性**映射到文件偏移
（找 `vmaddr ≤ n_value < vmaddr+vmsize` 且 `(n_value−vmaddr) < filesize` 且可执行
（`maxprot & 0x4`）的 `LC_SEGMENT_64`；`fileOffset = 切片偏移 + seg.fileoff + (n_value − seg.vmaddr`）。
不按段名匹配，天然兼容 `__TEXT` / `__TEXT_EXEC` / 多 `__TEXT` 段布局。

### 10.3 补丁点表与原始字节（1.14.5-dev 实测）

| 切片 | vm 地址 | 文件偏移 | 原始字节 | 原指令 | 补丁字节 | 补丁指令 |
| --- | --- | --- | --- | --- | --- | --- |
| arm64（切片 @0x194000） | `0x1000731f8` | `0x2071f8` | `ff 83 03 d1` | `sub sp, sp, #0xe0` | `c0 03 5f d6` | `ret` |
| x86_64（切片 @0x4000） | `0x100089ed7` | `0x8ded7` | `55` | `pushq %rbp` | `c3` | `retq` |

复核命令：

```sh
otool -arch arm64  -tV "$BIN" | sed -n '/^-\[LicenseManager renew\]:/,+3p'   # 首条 sub sp,sp,#0xe0
otool -arch x86_64 -tV "$BIN" | sed -n '/^-\[LicenseManager renew\]:/,+3p'   # 首条 pushq %rbp
```

序言安全性论证：两处 `ret` 都落在任何压栈/栈帧调整**之前**，直接原样返回（调用约定不破坏，
`x0`/`rax` 残留值无影响——方法返回 void）。本二进制是 plain arm64（非 arm64e），
无指针认证问题；即便未来换成 arm64e，裸 `ret` 在 IMP 入口同样成立（补丁点先于任何 `paciasp`）。
ret 编码按 cputype 分派：arm64/arm64e（`0x…0C`）⇒ `c0 03 5f d6`；x86_64（`0x…07`）⇒ `c3`。

**幂等性判定只看「目标偏移处字节是否已是 ret 模式」**，不校验被覆盖的原始内容
（版本无关性）；被覆盖的原字节记入备份 manifest 仅供事后诊断。

### 10.4 重签名配方（改包后必须；entitlements 一增一保）

改写二进制后原 Developer ID 签名失效，且 arm64 macOS 内核强制要求有效签名 ⇒ 必须 ad-hoc 重签。
两条硬约束：

1. **保留原 entitlements 并只追加一项** `com.apple.security.cs.disable-library-validation`：
   原签名无此项 ⇒ library validation 生效 ⇒ 团队签名的 `Sparkle.framework` 会被拒绝加载进
   ad-hoc 宿主（dyld 按「同 Team 或 Apple」判）。加上此项后 Sparkle 照常加载。
   其余三项原样保留（`allow-dyld-environment-variables` / `allow-jit` /
   `allow-unsigned-executable-memory`）——只做最小 delta。
2. **保持 hardened runtime**（`--options runtime`），不整个放弃 runtime（那是对原始安全姿态
   更大的偏离）；也不用 `--deep`（会剥掉 Sparkle 自身的 Developer ID 签名，且两个 ad-hoc
   二进制在 library validation 下同样过不了同队校验——无收益纯破坏）。

```sh
APP=/Applications/Typora.app
# 1. 导出原 entitlements（XML plist 落 stdout，元数据落 stderr；必须在改动前导出——旧签名是唯一来源）
codesign -d --entitlements - --xml "$APP" > /tmp/ent.xml
grep -o '<key>' /tmp/ent.xml | wc -l   # 原始为 3（输出是单行 XML，grep -c 数的是行数，须用 -o | wc -l）
# 2. 注入 disable-library-validation（插到最外层 </dict> 前），并 lint 把关
#    （实现见 darwin-macho.ts：文本插入 + plutil -lint；此处手工等价）
plutil -lint /tmp/ent2.xml     # 4 个 key 后应 OK
# 3. ad-hoc 重签（对 bundle 整体，绝不裸签可执行文件；无 --deep / --timestamp / --identifier）
codesign --force --sign - --options runtime --entitlements /tmp/ent2.xml "$APP"
# 4. 验签与形态判据
codesign --verify --strict --verbose=2 "$APP"          # … valid on disk / … satisfied its Designated Requirement
codesign -dv "$APP" 2>&1 | grep -E 'Signature|TeamIdentifier'   # Signature=adhoc
codesign -d --entitlements - --xml "$APP" | grep -o '<key>' | wc -l   # 4（原 3 + disable-library-validation）
```

**重签会重排胖文件布局**（切片偏移/尺寸可能变化）⇒ 一切字节复核（补丁自检、幂等判定、
`--status`）都必须对重签后的**磁盘文件重新解析定位**，绝不复用旧偏移。

### 10.5 还原 = 字节等价拷贝（无需再签）

备份 `Contents/MacOS/Typora` 与 `Contents/_CodeSignature/CodeResources` 的原始字节，
还原时逐字节拷回 ⇒ 内嵌 CodeDirectory 与资源封印都是原件 ⇒ Developer ID 签名自动恢复有效：

```sh
codesign -dv "$APP" 2>&1 | grep Authority    # 还原后重新出现 Developer ID Application: Abner Lee
codesign --verify --strict "$APP" && echo OK
```

### 10.6 环境注意

- macOS 13+ 首次由终端改写 .app 包内容会触发 TCC「App Management」一次性授权弹窗
  （写入探测也可能触发）；拒绝后表现为 EPERM。属预期交互，不规避。
- 若包上带 `com.apple.quarantine`（本机无），ad-hoc 签名 + 隔离属性会被 Gatekeeper 拦，
  落盘时顺带 `xattr -d com.apple.quarantine`（防御性）。
- 重签后 Sparkle 的应用内自动更新大概率失效（宿主 designated requirement 变为 ad-hoc）。
  这与 Windows 路线「伪造更新检查使 asar 不被替换」语义等价：**补丁不会被自动更新静默覆盖**；
  手动升级（下载新包覆盖）后二进制换新，重跑 `pnpm hack` 即恢复（备份状态机会识别为 refreshed）。
- `codesign` / `plutil` / `nm` / `otool` 依赖 Xcode Command Line Tools（`xcode-select --install`）。
