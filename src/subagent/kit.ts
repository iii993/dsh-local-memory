import fs from 'node:fs'
import path from 'node:path'
import { INDEX_FILE } from '../shared/constants.js'
import { describeFsError, readTextOrNull } from '../shared/fsx.js'
import { safeResolve } from '../shared/paths.js'
import { formatSize, toPosix } from '../shared/text.js'
import { parseFrontmatter } from '../core/frontmatter.js'
import { searchFiles, suggestTags, walkFiles } from '../core/search.js'

/** 单次 `memory_read` 返回给子代理的正文上限（超出部分截断并标注）。 */
export const RECALL_PREVIEW_BYTES = 6 * 1024

/** 单次 `memory_search` 最多列给子代理的条数。 */
export const RECALL_SEARCH_PREVIEW = 12

/**
 * 三个子代理共用的**内部工具**与文本助手。
 *
 * 它们是**给子代理用**的，不是给主 agent 的工具：返回物做成"给模型看的一段文本"，
 * 而不是结构化对象；并且会把读过的文件记进调用方给的日志里 ——
 * 最终返回物由**日志**决定，不是子代理的总结，所以这一步不能漏。
 */

/** 是否是清单文件（INDEX.md 不算"读到的内容"）。 */
export function isIndexPath(rel: string): boolean {
  return path.basename(rel).toLowerCase() === INDEX_FILE.toLowerCase()
}

/** 按字节截断到上限，并给出"是否截断 + 全文大小"的标注。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return { text, truncated: false, bytes }
  // 按字符切到字节上限之下，避免把多字节字符劈成半个
  let cut = text.length
  while (cut > 0 && Buffer.byteLength(text.slice(0, cut), 'utf8') > maxBytes) {
    cut -= Math.max(1, Math.floor(cut / 16))
  }
  return { text: text.slice(0, cut), truncated: true, bytes }
}

/** 子代理共用的 `memory_search` 实现。`record` 把这次搜索记进各自的日志。 */
export async function subagentSearch(
  root: string,
  args: Record<string, unknown>,
  record: (query: string, hits: number, topPaths: string[]) => void,
): Promise<{ text: string; isError: boolean }> {
  const query = String(args.query ?? '').trim()
  const scopeRaw = String(args.scope ?? '').trim()
  let scopeAbs = root
  try {
    scopeAbs = scopeRaw === '' ? root : safeResolve(root, scopeRaw)
  } catch (error) {
    return { text: `scope 不合法: ${describeFsError(error)}`, isError: true }
  }
  if (!fs.existsSync(scopeAbs) || !fs.statSync(scopeAbs).isDirectory()) {
    return { text: `目录不存在: ${scopeRaw}`, isError: true }
  }
  // 空 query = 列目录（与主 agent 的 memory_search 同一约定）。
  // 这是"想不出关键词"时的第二条退路：直接扫文件名，比硬猜同义词有效。
  if (query === '') {
    const label = scopeRaw === '' ? '/' : scopeRaw
    const files = await walkFiles(scopeAbs, root)
    record('', files.length, files.slice(0, 5).map((f) => f.rel))
    if (files.length === 0) return { text: `(${label}) 下没有记忆文件。`, isError: false }
    const shown = files.slice(0, RECALL_SEARCH_PREVIEW * 2)
    const lines = shown.map((f) => `  ${f.rel}`)
    if (files.length > shown.length) lines.push(`  ...还有 ${files.length - shown.length} 个`)
    return { text: `${label} 下 ${files.length} 个文件:\n${lines.join('\n')}`, isError: false }
  }
  const hits = await searchFiles(root, scopeAbs, query, { searchBody: true })
  record(query, hits.length, hits.slice(0, 5).map((h) => h.rel))
  if (hits.length === 0) {
    // 0 命中时把库里**实际用过的**相关 tags 摆出来 —— 子代理据此换词，比让它盲猜有用
    const tags = await suggestTags(root, scopeAbs, query)
    const hint = tags.length > 0 ? `库里相关的标签: ${tags.join(' / ')}` : '换个说法再试。'
    return { text: `"${query}" 没有命中。${hint}`, isError: false }
  }
  const shown = hits.slice(0, RECALL_SEARCH_PREVIEW)
  const lines = shown.map((h, i) => {
    const where = h.nameHit ? '文件名' : h.tagHits > 0 ? `标签×${h.tagHits}` : `正文×${h.bodyHits}`
    return `${i + 1}. ${h.rel}  [${where}]  ${h.updated !== '' ? h.updated : '—'}  ${h.desc}`
  })
  if (hits.length > shown.length) lines.push(`...还有 ${hits.length - shown.length} 条未列出`)
  return { text: `"${query}" 命中 ${hits.length} 个:\n${lines.join('\n')}`, isError: false }
}

/**
 * 子代理共用的 `memory_read` 实现。
 *
 * `allowIndex` 给写入/整理子代理开：它们需要读 INDEX.md 才能挑分类、才能看出索引漂移；
 * 检索子代理则不该把 INDEX 当成"读到的内容"。
 */
export function subagentRead(
  root: string,
  args: Record<string, unknown>,
  record: (rel: string, bytes: number) => void,
  allowIndex = false,
): { text: string; isError: boolean } {
  const raw = String(args.path ?? '').trim()
  if (raw === '') return { text: 'path 不能为空', isError: true }
  let abs: string
  try {
    abs = safeResolve(root, raw)
  } catch (error) {
    return { text: `path 不合法: ${describeFsError(error)}`, isError: true }
  }
  const rel = toPosix(path.relative(root, abs))
  // 传目录 = 读该层 INDEX.md（写入子代理靠它挑分类）
  if (rel === '' || fs.existsSync(abs) === false || fs.statSync(abs).isDirectory()) {
    const dirAbs = rel === '' ? root : abs
    const indexPath = path.join(dirAbs, INDEX_FILE)
    const indexText = readTextOrNull(indexPath)
    if (indexText === null) return { text: `目录 ${raw === '' ? '/' : raw} 下没有 INDEX.md`, isError: true }
    const listed = toPosix(path.relative(root, indexPath))
    if (allowIndex) record(listed, Buffer.byteLength(indexText, 'utf8'))
    return { text: indexText, isError: false }
  }
  if (!allowIndex && isIndexPath(rel)) {
    return { text: `${raw} 是目录清单(INDEX), 不是记忆内容, 不需要读。`, isError: false }
  }
  const text = readTextOrNull(abs)
  if (text === null) return { text: `读不到这个文件: ${raw}`, isError: true }
  const cut = truncateUtf8(text, RECALL_PREVIEW_BYTES)
  record(rel, cut.bytes)
  return {
    text: cut.truncated ? `${cut.text}\n\n[预览到此为止, 全文 ${formatSize(cut.bytes)}]` : cut.text,
    isError: false,
  }
}
