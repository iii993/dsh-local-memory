import fs from 'node:fs'
import path from 'node:path'

/**
 * 文件系统原语：容错读、原子写、错误描述。
 *
 * 这里所有 `...OrNull` 函数的约定是**失败返回 null 而不是抛**，因为调用方几乎总是
 * "读不到就跳过/回退"，而不是"读不到就崩"。反过来，`writeFileAtomic` 失败**必须**抛 ——
 * 静默写失败等于丢数据。
 */

/** 读取文本，失败返回 null。 */
export function readTextOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** 带明确中文原因的业务错误：抛出后不会被外层再包一层 fs 错误说明。 */
export class MemoryError extends Error {}

/** 取 stat，失败返回 null。 */
export function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

/** 读取文件开头至多 `max` 字节（用于只看 frontmatter），并去掉末尾被截断的多字节残片。 */
export function readTextPrefix(p: string, max: number): string {
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(max)
      const read = fs.readSync(fd, buf, 0, max, 0)
      return buf.subarray(0, read).toString('utf8').replace(/\uFFFD+$/, '')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * 原子写入：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接 `writeFileSync` 截断写时，写到一半被杀/磁盘满会留下半截文件；
 * rename 在同一分区上是原子的，读者要么看到旧内容要么看到新内容。
 */
export function writeFileAtomic(abs: string, text: string): void {
  const tmp = path.join(
    path.dirname(abs),
    `.dsh-memory-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, abs)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error
  }
}

/** 把常见 fs 错误码翻成可操作的中文。 */
export function describeFsError(error: unknown): string {
  const e = error as NodeJS.ErrnoException
  if (e === null || typeof e !== 'object' || typeof e.code !== 'string') {
    return error instanceof Error ? error.message : String(error)
  }
  switch (e.code) {
    case 'ENOENT':
      return '路径不存在(父级可能是个同名文件)'
    case 'EPERM':
    case 'EACCES':
      return '没有权限(文件可能被占用、只读或被安全软件锁定)'
    case 'ENOSPC':
      return '磁盘空间不足'
    case 'EBUSY':
      return '文件被占用'
    case 'EISDIR':
      return '目标是一个目录'
    case 'ENOTDIR':
      return '路径中间有同名文件'
    case 'EINVAL':
    case 'ENAMETOOLONG':
    case 'UNKNOWN':
      return '路径非法(可能含 Windows 保留名/非法字符, 或过长)'
    default:
      return `${e.code}: ${e.message}`
  }
}

export function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}
