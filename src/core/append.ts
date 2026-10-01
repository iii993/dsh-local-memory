import { countOccurrences } from '../shared/text.js'

/**
 * `mode: "append"` 的**按要点去重**：把新增内容拆成"要点单元"，与既有正文逐单元比较，
 * 只追加没出现过的。
 *
 * 为什么按"要点单元"而不是按行：一条要点常常写成多行（续行、子列表）。按行比对会把
 * 同一件事的不同排版当成两条，越追加越臃肿；按单元比对才符合"一个文件 = 一个主题，
 * 3~8 条要点"的写法。
 */

/** 去重追加结果。 */
export interface AppendResult {
  body: string
  added: number
  skipped: number
}

/**
 * §7.4 按"要点"去重后追加。
 *
 * 去重单位不是"行"而是**单元**：代码块整块、标题单行、列表项单条、表格行单条、段落整段。
 * 因为按行去重会误伤 —— 旧文件里出现过 `import fs from 'node:fs'`，就会把新代码块里的同一行删掉；
 * 去重 key 还带上所属小节，避免 `## A / - 无` 与 `## B / - 无` 被误判成同一条。
 *
 * @param oldBody - 原正文。
 * @param addBody - 待追加正文。
 */
export function dedupeAppend(oldBody: string, addBody: string): AppendResult {
  const bySection = new Set<string>()
  const anywhere = new Set<string>()
  for (const unit of splitAppendUnits(oldBody)) {
    bySection.add(unit.key)
    anywhere.add(unit.anyKey)
  }
  const kept: string[] = []
  let added = 0
  let skipped = 0
  for (const unit of splitAppendUnits(addBody)) {
    // 带小节归属的单元只在同一小节内查重（这样 `## A / - 无` 与 `## B / - 无` 能各自保留）。
    // 但 append 内容自己**没写小节标题**时不能这么查：否则"单独补一条要点"永远匹配不上
    // 已有小节里的同一条，会静默加出重复内容（而且还会谎报 updated）。这种情况退回全文查重。
    const scoped = unit.scoped && unit.section !== ''
    const hit = scoped ? bySection.has(unit.key) : anywhere.has(unit.anyKey)
    if (hit) {
      skipped += 1
      continue
    }
    if (kept.length > 0) kept.push('')
    kept.push(...unit.lines)
    bySection.add(unit.key)
    anywhere.add(unit.anyKey)
    added += 1
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  return { body: kept.join('\n'), added, skipped }
}

/** 一个去重单元：代码块 / 标题 / 列表项 / 表格行 / 段落。 */
export interface AppendUnit {
  lines: string[]
  /** 完整去重 key（只有 `scoped` 的单元才带小节归属）。 */
  key: string
  /** 忽略小节归属的 key，用于"append 内容没写小节标题"时的全文查重。 */
  anyKey: string
  /** 该单元所属小节（`''` 表示它出现在任何标题之前）。 */
  section: string
  /** 是否带小节归属 —— 标题本身不带，因为它就是小节的开始。 */
  scoped: boolean
}

/** 造一个去重单元。 */
export function makeUnit(lines: string[], kind: string, section: string, text: string, scoped = true): AppendUnit {
  return {
    lines,
    section,
    scoped,
    key: scoped ? `${kind}\u0000${section}\u0000${text}` : `${kind}\u0000${text}`,
    anyKey: `${kind}\u0000${text}`,
  }
}

/** 列表符号归一化, 让 `* x` 与 `- x` 视为同一条要点。 */
export function normalizePoint(text: string): string {
  return text
    .trim()
    .replace(/^([-*+]|\d+[.)])\s+/, '- ')
    .replace(/\s+/g, ' ')
}

/** 把一个单元的正文切成去重单元。 */
export function splitAppendUnits(body: string): AppendUnit[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const units: AppendUnit[] = []
  let section = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (t === '') {
      i += 1
      continue
    }
    // 代码块: 整块作为一个单元(含内部空行与重复行), 内部完全不去重
    const fence = /^(`{3,}|~{3,})/.exec(t)
    if (fence !== null) {
      const mark = fence[1]
      const buf = [line.trimEnd()]
      i += 1
      while (i < lines.length) {
        const cur = lines[i]
        buf.push(cur.trimEnd())
        i += 1
        if (cur.trim().startsWith(mark)) break
      }
      units.push(makeUnit(buf, 'code', section, buf.map((l) => l.trim()).join('\n')))
      continue
    }
    // 标题: 定义当前小节
    if (/^#{1,6}\s+/.test(t)) {
      section = t
      units.push(makeUnit([line.trimEnd()], 'head', section, t, false))
      i += 1
      continue
    }
    // 列表项: 一条要点
    if (/^([-*+]|\d+[.)])\s+/.test(t)) {
      units.push(makeUnit([line.trimEnd()], 'point', section, normalizePoint(t)))
      i += 1
      continue
    }
    // 表格行
    if (t.startsWith('|')) {
      units.push(makeUnit([line.trimEnd()], 'row', section, t.replace(/\s+/g, ' ')))
      i += 1
      continue
    }
    // 其余: 连续普通行合成一个段落
    const buf = [line.trimEnd()]
    i += 1
    while (i < lines.length) {
      const t2 = lines[i].trim()
      if (
        t2 === '' ||
        /^#{1,6}\s+/.test(t2) ||
        /^([-*+]|\d+[.)])\s+/.test(t2) ||
        t2.startsWith('|') ||
        /^(`{3,}|~{3,})/.test(t2)
      ) {
        break
      }
      buf.push(lines[i].trimEnd())
      i += 1
    }
    units.push(makeUnit(buf, 'para', section, buf.map((l) => l.trim()).join('\n')))
  }
  return units
}
