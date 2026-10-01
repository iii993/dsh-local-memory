import path from 'node:path'

/** 纯文本工具：日期、路径展示、尺寸与**显示宽度**（CJK 全角算 2 格）。与文件系统无关。 */

/** 当天日期，`YYYY-MM-DD`。 */
export function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Windows 反斜杠统一成 POSIX 斜杠（对外展示与 INDEX 链接用）。 */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/** 字节数转人类可读。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)}KB`
  return `${(kb / 1024).toFixed(1)}MB`
}

/** 去掉 `.md` 扩展名的文件名。 */
export function stripMdExt(name: string): string {
  return name.replace(/\.md$/i, '')
}

/** 统计 `needle` 在 `haystack` 中出现的次数（大小写不敏感子串）。 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  let count = 0
  let idx = h.indexOf(n)
  while (idx >= 0) {
    count += 1
    idx = h.indexOf(n, idx + n.length)
  }
  return count
}

/** 终端显示宽度（中日韩全角字符算 2）。 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}

/** 按显示宽度右补空格。 */
export function padTo(s: string, width: number): string {
  const w = displayWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

/**
 * 同 {@link padTo}，但**已经达到或超过 width 时也补一个空格**。
 *
 * 差别只在溢出这一种情况，而它恰好会被看见：多列拼在一行时，超长的那一列会和右邻列
 * **粘在一起** —— 实测过长文件名后直接跟着 `正文命中 ×0`，读起来像文件名的一部分。
 * 宁可让这一行宽一点、列不对齐，也不要让两列分不开。
 */
export function padCol(s: string, width: number): string {
  const w = displayWidth(s)
  return w >= width ? `${s} ` : s + ' '.repeat(width - w)
}

/**
 * `path.relative(root, target)` 的结果是否指向 root 之外。
 *
 * 注意不能写成 `rel.startsWith('..')` —— 那会把**合法文件名** `..foo` 误判为越界。
 *
 * 放在 text 而不是 paths 里，是因为它只用字符串与 `path`：`core/index-file` 需要它，
 * 而 `paths` 需要 `index-file` 的 `rebuildIndex`，两处互引就成了环。
 */
export function isOutside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}
