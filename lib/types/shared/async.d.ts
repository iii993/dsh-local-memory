/** 异步小工具：睡一会儿、带并发上限的 map。 */
/** 异步小睡（锁等待用）。 */
export declare function sleep(ms: number): Promise<void>;
/**
 * 限流并发 map：最多 `limit` 个任务同时在飞，结果顺序与输入一致。
 */
export declare function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
