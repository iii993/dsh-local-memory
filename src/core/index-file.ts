import fs from 'node:fs'
import path from 'node:path'
import { INDEX_FILE, INDEX_LOCK_NAME } from '../shared/constants.js'
import { readTextOrNull, readTextPrefix, statOrNull, writeFileAtomic } from '../shared/fsx.js'
import { isOutside, today, toPosix } from '../shared/text.js'
import { withFileLock } from './lock.js'
import {
  buildCountIndex,
  cachedCounts,
  countMdFiles,
  listMdFiles,
  listSubdirs,
  refreshCounts,
} from './count-cache.js'
import { firstHeading, parseFrontmatter } from './frontmatter.js'

/**
 * 每层目录的 `INDEX.md`：渲染、漂移检测、重建链。
 *
 * INDEX 是**派生数据** —— 内容全都能从文件系统重新算出来。这条性质决定了两处关键设计：
 *
 * 1. **宁可陈旧也不能写错**：读不到子项时（杀软扫描 / 文件被占用）一律放弃重建，
 *    绝不把"读不到"渲染成"这层是空的"。见 count-cache 里的 `listSubdirs`。
 * 2. **重建是有锁的**：INDEX 是多进程共享的产物，两个实例各写各的文件不冲突，
 *    但它们会重写同一批 INDEX —— 所以 `updateIndexChainLocked` 用一把全库锁串行化。
 */

/**
 * 读取本层 `INDEX.md` 顶部的 `> 说明:` 引用行（缺失时给空模板）。
 *
 * 注意模板必须与读取路径的结果**逐字符相同**：读回来的行会 `trimEnd()`，
 * 所以空模板也不能带尾随空格 —— 否则 `renderIndex` 不幂等，`indexIsStale` 会把
 * 每次刚重建好的 INDEX 又判成过时。
 */
export function readNoteLine(dir: string): string {
  const text = readTextOrNull(path.join(dir, INDEX_FILE))
  if (text === null) return '> 说明:'
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim().startsWith('>')) return line.trimEnd()
  }
  return '> 说明:'
}

/** 从 `> 说明: xxx` 行里取 xxx。 */
export function noteContent(line: string): string {
  const m = /^>\s*说明\s*[:：]\s*(.*)$/.exec(line.trim())
  return m === null ? '' : m[1].trim()
}

/** Markdown 表格单元格转义。 */
export function escCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/** 链接目标里把会破坏 Markdown 链接的字符做百分号编码（中文可直用）。 */
export function linkTarget(name: string): string {
  return name.replace(/[% ()[\]<>#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/**
 * 文件的「说明」：frontmatter.summary，缺失则回退正文首个标题。
 *
 * 这里用 `readTextPrefix`（open + read + close）而不是 `readFile`：实测 1000 个文件
 * 前者 203 ms、后者 275 ms —— `readFileSync` 内部自己还要 fstat 一次，比只读开头更贵。
 */
export function describeFile(abs: string): string {
  const text = readTextPrefix(abs, 16384)
  const { data, body } = parseFrontmatter(text)
  if (data.summary !== '') return data.summary
  const h = firstHeading(body)
  return h !== '' ? h : '—'
}

/**
 * §7.5 渲染单层 `INDEX.md`（只列本层直接子项，保留原有 `> 说明:` 行）。
 *
 * @param root - 记忆库根目录。
 * @param dir - 要渲染的目录。
 * @param counts - {@link buildCountIndex} 算好的条目数表；省略则就地递归统计（单层调用时才划算）。
 */
export function renderIndex(root: string, dir: string, counts?: Map<string, number>): string {
  const rel = toPosix(path.relative(root, dir))
  const title = rel === '' ? '/' : `${rel}/`
  const note = readNoteLine(dir)
  const subdirs = listSubdirs(dir)
  const files = listMdFiles(dir)
  // 读不到就不渲染（见 listSubdirs 的说明）。抛出去由调用方决定怎么处理：
  // indexIsStale 会放弃判断，updateIndexChain 会跳过这层 —— 但**绝不能把"读不到"写成"是空的"**。
  if (subdirs === null || files === null) {
    throw new Error(`无法读取目录内容，放弃重建 INDEX：${toPosix(path.relative(root, dir)) || '/'}`)
  }
  const lines: string[] = []
  lines.push(`# INDEX — ${title}`)
  lines.push('')
  lines.push('<!-- 本文件仅列本层直接子项；深入请进入子文件夹查看其自身的 INDEX.md。 -->')
  lines.push(note)
  lines.push('<!-- 以下内容由工具自动生成，请勿手工编辑。想让某个文件显示更好的说明，请写它 frontmatter 的 summary 字段。 -->')
  lines.push('')
  lines.push('## 子文件夹')
  lines.push('')
  lines.push('| 名称 | 说明 | 条目数 |')
  lines.push('|---|---|---|')
  // 本层没有子文件夹时不再输出 "(本层无子文件夹) | 0" 占位行 —— 只有表头就是空, 占位行纯噪音
  for (const sub of subdirs) {
    const subAbs = path.join(dir, sub)
    const n = counts?.get(subAbs) ?? countMdFiles(subAbs)
    // 计数不可信（-1 = 那次 readdir 没读到）时整体放弃渲染，理由同 listSubdirs
    if (n < 0) throw new Error(`子目录条目数不可信，放弃重建 INDEX：${toPosix(path.relative(root, subAbs))}`)
    const subNote = noteContent(readNoteLine(subAbs))
    lines.push(`| [${escCell(sub)}/](./${linkTarget(sub)}/INDEX.md) | ${escCell(subNote !== '' ? subNote : '—')} | ${n} |`)
  }
  lines.push('')
  lines.push('## 本层文件')
  lines.push('')
  lines.push('| 文件 | 说明 |')
  lines.push('|---|---|')
  for (const f of files) {
    lines.push(`| [${escCell(f)}](./${linkTarget(f)}) | ${escCell(describeFile(path.join(dir, f)))} |`)
  }
  lines.push('')
  lines.push('---')
  lines.push(`最后更新：${today()}`)
  lines.push('')
  return lines.join('\n')
}

/** 去掉 INDEX 结尾的"最后更新"行：它每天都变，不该让它把索引判成过时。 */
export function stripFooter(text: string): string {
  return text.replace(/最后更新：[^\n]*\n?/g, '')
}

/**
 * 判断本层 `INDEX.md` 是否与实际内容不一致（缺失、漏列条目、条目数变了、说明变了…）。
 *
 * 做法是**渲染一遍再比对**（忽略结尾的"最后更新"行）—— 比逐项检查更准，代价是本层一次
 * `readdir` 加本层文件的说明读取；子目录的递归条目数交给 {@link buildCountIndex} 一次遍历给出，
 * 不会退化成一目录一次递归。
 *
 * @param root - 记忆库根目录。
 * @param dir - 要检查的目录（绝对路径）。
 */
export function indexIsStale(root: string, dir: string): boolean {
  const current = readTextOrNull(path.join(dir, INDEX_FILE))
  if (current === null) return true
  let rendered: string
  try {
    rendered = renderIndex(root, dir, buildCountIndex(dir))
  } catch {
    // 读不到内容就**不判定为过时**：宁可让索引暂时陈旧，也绝不能拿"读不到"当依据去触发重建 ——
    // 那正是把好索引覆盖成空索引的路径（见 listSubdirs 的说明）。
    return false
  }
  return stripFooter(current) !== stripFooter(rendered)
}

/**
 * §7.5 重建单层 INDEX。
 *
 * @param root - 记忆库根目录。
 * @param dir - 要重建的目录。
 * @param counts - 可选的条目数表（见 {@link buildCountIndex}）。
 */
export function rebuildIndex(root: string, dir: string, counts?: Map<string, number>): void {
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(path.join(dir, INDEX_FILE), renderIndex(root, dir, counts))
}

/**
 * §7.5 从 `startDir` 向上重建到根。
 *
 * 整条链复用**同一张**条目数表，所以一次写入只需要遍历全库一遍，而不是每层各遍历一遍。
 *
 * @returns 被更新的 INDEX 相对路径列表（从近到远）。
 */
export function updateIndexChain(root: string, startDir: string, counts?: Map<string, number>): string[] {
  // **不传表就全量重算，并写回缓存**（refreshCounts，而不是 buildCountIndex）。
  // 调用方可能是"外部改动后重建索引"（编辑器里手工增删过文件），那种情况缓存是旧的；
  // 重算完必须把新表存回去 —— 否则之后走 cachedCounts 的写入路径又会用到陈旧的计数，
  // 形成"读时修好、写时写坏"的循环。
  // 写入路径自己确知刚改了什么，会显式传入维护过的表（见 writeMemory / deleteMemory）。
  const table = counts ?? refreshCounts(root)
  const updated: string[] = []
  let dir = path.resolve(startDir)
  for (;;) {
    const rel = path.relative(root, dir)
    if (isOutside(rel)) break
    try {
      rebuildIndex(root, dir, table)
      updated.push(rel === '' ? INDEX_FILE : toPosix(path.join(rel, INDEX_FILE)))
    } catch {
      // 这层读不到就停在这里：留一份旧 INDEX 远好过写一份错的；
      // 也不该因为派生数据渲染失败，就让内容写入整体失败。
      break
    }
    if (rel === '') break
    dir = path.dirname(dir)
  }
  return updated
}

/**
 * 带**全库 INDEX 链锁**地更新 INDEX 链。
 *
 * 为什么需要一把独立于内容锁的锁：两个 DSH 实例共享 MEMORY_ROOT 时，各写各的文件会各持
 * **自己那个文件**的锁（互不冲突），但随后都要重写**同一批 INDEX.md** —— 后写的一方会把
 * 先写的覆盖掉，连手写的 `> 说明:` 行也一起冲掉（那本是唯一的人工可写点）。
 * INDEX 是共享产物，就得用共享的锁。
 *
 * 粒度故意粗（全库一把）：INDEX 更新是低频操作，不值得为它做细粒度。
 * 加锁顺序固定为"先内容锁、后 INDEX 锁"，不存在交叉等待，所以不会死锁。
 */
export async function updateIndexChainLocked(
  root: string,
  startDir: string,
  counts?: Map<string, number>,
): Promise<string[]> {
  return withFileLock(path.join(root, INDEX_LOCK_NAME), () => updateIndexChain(root, startDir, counts))
}

/**
 * §7.3.5 自底向上重建整棵子树的 INDEX，返回重建层数。
 *
 * @param counts - 可选的条目数表。调用方若紧接着还要 {@link updateIndexChain}，
 *   把同一张表传下去就能省掉一次全库遍历。
 */
export function reindexTree(root: string, dir: string, counts?: Map<string, number>): number {
  // 重建 INDEX 正是"重新认识整个库"的时机，顺手全量刷新计数缓存
  return reindexSubtree(root, dir, counts ?? refreshCounts(root))
}

export function reindexSubtree(root: string, dir: string, counts: Map<string, number>): number {
  let count = 0
  const subs = listSubdirs(dir)
  // 读不到子目录就放弃这一层的重建（见 listSubdirs 的说明），让调用方看到失败
  if (subs === null) throw new Error(`无法读取目录内容，放弃重建 INDEX：${toPosix(path.relative(root, dir)) || '/'}`)
  for (const sub of subs) count += reindexSubtree(root, path.join(dir, sub), counts)
  rebuildIndex(root, dir, counts)
  return count + 1
}

/**
 * §3.4 若根目录不存在则创建，并补上根 `INDEX.md`。
 *
 * ⚠️ 暂时留在入口文件里：它依赖 `rebuildIndex`，而 INDEX 相关代码还没搬进
 * `core/index-file.ts`。放进 `shared/paths.ts` 会形成 paths → index-file → paths 的循环，
 * 所以等 INDEX 整体搬完再把它挪过去。
 */
export function ensureRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true })
  if (!fs.existsSync(path.join(root, INDEX_FILE))) rebuildIndex(root, root)
}
