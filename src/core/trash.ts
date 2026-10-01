import fs from 'node:fs'
import path from 'node:path'
import { TRASH_DIR, TRASH_MAX_FILES } from '../shared/constants.js'
import { statOrNull, readTextOrNull, writeFileAtomic } from '../shared/fsx.js'
import { isOutside, toPosix } from '../shared/text.js'

/**
 * `.trash/` 回收站：覆盖或删除之前的最后一道安全网。
 *
 * 它是**安全网而不是版本控制** —— 有 `TRASH_MAX_FILES` 的份数上限，超出会按时间淘汰最旧的，
 * 所以重要内容仍要另行备份。备份目录以 `.` 开头，因此不进 INDEX、不进搜索、不算记忆条目。
 */

/**
 * 把 `.trash/` 修剪到上限以内。
 *
 * 备份文件名以 `2026-09-28T00-01-30-123Z__` 开头，**字典序就是时间序**，不用解析时间。
 * 这是防止 `replace` / `delete` 频繁的库把垃圾无限堆下去 —— `.trash` 是安全网，不是版本控制。
 */
export function pruneTrash(root: string): void {
  const dir = path.join(root, TRASH_DIR)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  if (names.length <= TRASH_MAX_FILES) return
  names.sort()
  for (const name of names.slice(0, names.length - TRASH_MAX_FILES)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      /* 单个删不掉不影响其余 */
    }
  }
}

/**
 * 把即将被覆盖/删除的文件备份到 `<root>/.trash/`。
 *
 * `replace` 是破坏性的，`memory_delete` 也没有回收站 —— 备份是最便宜的安全网。
 * 备份目录以 `.` 开头，所以不会污染 INDEX 和搜索结果；备份失败会抛错，
 * 宁可这次改不成，也不要静默丢掉原内容。
 */
export function backupBeforeOverwrite(root: string, abs: string): string | null {
  const text = readTextOrNull(abs)
  if (text === null) return null
  const rel = toPosix(path.relative(root, abs))
  if (rel === '' || isOutside(rel)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `${stamp}__${rel.replace(/\//g, '__')}`
  const dest = path.join(root, TRASH_DIR, name)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  writeFileAtomic(dest, text)
  pruneTrash(root)
  // 返回备份的相对路径: 调用方(尤其是子代理)要能告诉主 agent"删掉的东西在哪、怎么恢复"
  return `${TRASH_DIR}/${name}`
}

/**
 * 备份任意类型的文件（含 PNG/PDF 等二进制附件）到 `<root>/.trash/`。
 *
 * 为什么不能让 `backupBeforeOverwrite` 包办：它走的是"读成文本再写回"，对二进制会读成
 * `null` 而**静默跳过** —— 目录递归删除时那些附件就无声消失了。README 把"能放截图等
 * 非文本附件"当卖点，所以目录备份这条路必须真正备得下来（用 `copyFileSync`，二进制安全）。
 *
 * @returns 备份的相对路径（`null` = 不是文件 / 越界 / 读不到）。
 */
export function backupAnyFile(root: string, abs: string): string | null {
  const st = statOrNull(abs)
  if (st === null || !st.isFile()) return null
  const rel = toPosix(path.relative(root, abs))
  if (rel === '' || isOutside(rel)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `${stamp}__${rel.replace(/\//g, '__')}`
  const dest = path.join(root, TRASH_DIR, name)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(abs, dest)
  pruneTrash(root)
  return `${TRASH_DIR}/${name}`
}

/** 递归备份一个目录下的所有记忆文件（删除非空目录之前调用）。 */
export function backupTree(root: string, abs: string): void {
  let items: fs.Dirent[]
  try {
    items = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    if (item.name.startsWith('.')) continue
    const child = path.join(abs, item.name)
    if (item.isDirectory()) backupTree(root, child)
    // **不再限定 `.md`**：目录删除是整棵 rmSync，截图/PDF 这类附件同样会消失，
    // 而 backupBeforeOverwrite 只读文本（二进制读成 null 就静默跳过）。这里走二进制安全的那个。
    else if (item.isFile()) backupAnyFile(root, child)
  }
}

/** 统计 `.trash/` 里的备份数量与总大小（只报数，不自动清理）。 */
export function trashStats(root: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (dir: string): void => {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) walk(abs)
      else if (item.isFile()) {
        files += 1
        bytes += statOrNull(abs)?.size ?? 0
      }
    }
  }
  walk(path.join(root, TRASH_DIR))
  return { files, bytes }
}
