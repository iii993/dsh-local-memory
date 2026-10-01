import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sleep } from '../shared/async.js'
import { LOCK_STALE_MS, LOCK_SUFFIX, LOCK_TIMEOUT_MS } from '../shared/constants.js'
import { describeFsError, statOrNull } from '../shared/fsx.js'

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
export function readLockHolder(lock: string): { pid: number; host: string; at: number } | null {
  try {
    const raw = fs.readFileSync(lock, 'utf8')
    const parsed = JSON.parse(raw) as { pid?: unknown; host?: unknown; at?: unknown }
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string') return null
    return { pid: parsed.pid, host: parsed.host, at: typeof parsed.at === 'number' ? parsed.at : 0 }
  } catch {
    return null
  }
}

/**
 * 探测进程是否还活着（`signal 0` 只做权限与存在性检查，不真发信号）。
 *
 * `EPERM` 说明进程存在但当前用户没权限动它 —— 那也算活着，不能当陈旧锁清掉。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

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
export async function withFileLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  timeoutMs = LOCK_TIMEOUT_MS,
): Promise<T> {
  const lock = `${target}${LOCK_SUFFIX}`
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let fd: number | null = null
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx')
      // 把持有者信息写进锁文件，让**别人**能判断"持锁方是不是还活着"，
      // 而不是只能靠 mtime 猜（见下面 LOCK_STALE_MS 的处理）。
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }))
      } catch {
        /* 写不进去不影响持锁本身 */
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`创建写锁失败 —— ${describeFsError(error)}`)
      }
      const st = statOrNull(lock)
      if (st !== null && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // 光看时间不够 —— 持锁方可能只是**慢**（大库上重建整条 INDEX 链会很久），
        // 单纯按 10 秒判陈旧会把它正在持有的锁夺走，于是两个进程同时写。
        // 所以再加一道：只有**确认持有者进程已不存在**（或锁里没写持有者信息）才当陈旧锁清掉。
        const holder = readLockHolder(lock)
        if (holder === null || holder.host !== os.hostname() || !isProcessAlive(holder.pid)) {
          try {
            fs.rmSync(lock, { force: true })
          } catch {
            /* 忽略 */
          }
          continue
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `等待写锁超时(${timeoutMs}ms): 有另一个进程正在写同一个文件(${path.basename(target)})。` +
            `稍后重试；若确认没有别的进程在写, 可手动删除同目录下的 *${LOCK_SUFFIX} 文件。`,
        )
      }
      await sleep(25)
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* 忽略 */
    }
    try {
      fs.rmSync(lock, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}
