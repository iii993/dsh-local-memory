/**
 * 跨进程写锁。
 *
 * 同一进程内已由工具的 `isConcurrencySafe: false` 串行化；这把锁是为**两个 DSH 实例共享
 * 同一个 MEMORY_ROOT** 准备的。锁文件里记了持有者 pid/host，所以"陈旧锁"的判定不只看时间 ——
 * 见 {@link withFileLock} 里的说明。
 */
/**
 * 读锁文件里记录的持有者信息。读不到或格式不对返回 `null`（视为"不知道谁持有"）。
 */
export declare function readLockHolder(lock: string): {
    pid: number;
    host: string;
    at: number;
} | null;
/**
 * 探测进程是否还活着（`signal 0` 只做权限与存在性检查，不真发信号）。
 *
 * `EPERM` 说明进程存在但当前用户没权限动它 —— 那也算活着，不能当陈旧锁清掉。
 */
export declare function isProcessAlive(pid: number): boolean;
/**
 * 在读-改-写期间持有一个轻量文件锁。
 *
 * `isConcurrencySafe: false` 只在**同一进程**的工具调度层生效。多个 DSH 实例共享同一个
 * `MEMORY_ROOT` 时，两个 append 会各自"读-改-写"，后写的把先写的覆盖掉（原子写只保证
 * 文件不写坏，不保证内容不丢）。锁用 `open(..., 'wx')` 原子创建：拿不到就短暂重试，
 * 超时或遇到陈旧锁都有明确中文提示。
 *
 * 等待用 `await` 而不是 `Atomics.wait` —— 后者会停摆整个 DSH 进程的事件循环
 * （所有工具、定时器、I/O 回调一起等），最坏 3 秒。锁本来就是给**跨进程**用的
 * （同进程已由 `isConcurrencySafe: false` 串行化），没道理让同进程的其它工具陪跑。
 */
export declare function withFileLock<T>(target: string, fn: () => T | Promise<T>, timeoutMs?: number): Promise<T>;
