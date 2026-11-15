/**
 * 删除操作的 Windows 安全封装。
 *
 * 为什么需要它（真机故障记录：`ENOTEMPTY ... rmdir 'hapora-KGoSdi'`）：
 *   - Windows 上的一次删除，只有在**最后一个**打开该文件的句柄关闭后才真正生效。刚写完、
 *     刚被复制过、正被实时扫描（Defender）或索引服务摸过的目录，收尾时偶发 ENOTEMPTY 是常态；
 *     Linux/macOS 的 unlink 是「名字立刻消失、引用归零后回收」，几乎不会出现同样的表现。
 *   - Node 的 `fs.rm` 本就为这一现象准备了退避重试（EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM，
 *     且仅在 `recursive` 时生效），但 `maxRetries` 默认是 **0**——等于不重试，第一次撞上就抛。
 *
 * 两条原则：
 *   1. 临时目录的收尾永远不该让运行失败：活已经干完了，抛错只会顶替掉 try 里的真实错误、
 *      并把本来成功的一次运行变成退出码 1。用 rmTreeBestEffort / rmFileBestEffort。
 *   2. 有语义的删除（unpack 前清空目标目录、pack 前删旧产物、写权限探测的探针文件）
 *      必须失败得很响，但同样先退避重试再放弃。用 rmTree / rmFile。
 */

import { rmSync } from "node:fs";

/** 值得重试的错误码：全部是「暂时被占用」，等句柄关闭后同一调用就能成功。 */
const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM", "EACCES"]);

/** 重试次数与线性退避步长（最坏累计约 2.7s，足够等一次杀软扫描收尾，又不至于把退出拖太久）。 */
const RETRIES = 10;
const RETRY_DELAY_MS = 50;

/** 同步睡眠（这里的调用点都在同步流程里，不能用 await）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const codeOf = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? "";

/** 删目录树：退避重试，仍失败就抛。 */
export function rmTree(target: string): void {
  rmSync(target, { recursive: true, force: true, maxRetries: RETRIES, retryDelay: RETRY_DELAY_MS });
}

/** 删单个文件：`fs.rm` 的重试只对 recursive 生效，所以这里自己退避。 */
export function rmFile(target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(target, { force: true });
      return;
    } catch (err) {
      if (codeOf(err) === "ENOENT") return; // 已被别处删掉，等价于成功
      if (attempt >= RETRIES || !RETRYABLE.has(codeOf(err))) throw err;
      sleepSync(RETRY_DELAY_MS);
    }
  }
}

/** 删目录树，失败只警告不抛——专用于 finally 里的临时目录收尾。 */
export function rmTreeBestEffort(target: string): void {
  try {
    rmTree(target);
  } catch (err) {
    warn("临时目录", target, err);
  }
}

/** 删单个文件，失败只警告不抛。 */
export function rmFileBestEffort(target: string): void {
  try {
    rmFile(target);
  } catch (err) {
    warn("临时文件", target, err);
  }
}

/** 收尾失败不该脏了正常输出，但也不该静默——留一行线索，且明确写出不影响结果。 */
function warn(what: string, target: string, err: unknown): void {
  const code = codeOf(err) || "unknown";
  console.warn(`  ! ${what}清理失败（${code}），已忽略（残留可手工删除）：${target}`);
}
