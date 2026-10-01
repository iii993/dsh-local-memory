/** 异步小工具：睡一会儿、带并发上限的 map。 */

/** 异步小睡（锁等待用）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 限流并发 map：最多 `limit` 个任务同时在飞，结果顺序与输入一致。
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
