import { ToolSchema } from '@deepseek-ai/dsh-llm'
import path from 'node:path'
import { SUBAGENT_MAX_CONTEXT_BYTES } from '../shared/constants.js'
import { readTextOrNull } from '../shared/fsx.js'
import { formatSize, toPosix } from '../shared/text.js'
import { parseFrontmatter } from '../core/frontmatter.js'
import { deleteMemory, patchMemory, writeMemory } from '../core/write.js'
import { RECALL_MAX_FILE_BYTES } from './recall.js'
import { subagentRead, subagentSearch, truncateUtf8 } from './kit.js'

/**
 * 写入子代理：先查重，再决定 create / append / patch，整条作废时才 delete。
 *
 * 它**有删除权限** —— 依据是删除有三条护栏：① 一定先备份到 `.trash/`；② `reason` 必填且
 * 原样进返回物；③ 返回物把"删了什么、备份在哪"列出来。对子代理来说删除是**可逆**的。
 * 但要知道：**爆炸半径等于 MEMORY_ROOT 有多宽**。
 *
 * 返回物同样是"客观操作记录 + **写入后回读的实际内容**"，不是它自己声称写了什么。
 */

export const REMEMBER_MAX_TURNS = 8

export const REMEMBER_MAX_TOKENS = 3000

export const REMEMBER_TOTAL_TIMEOUT_MS = 60_000

/** 单次写入的正文上限。超了说明它该拆成多个文件。 */
export const REMEMBER_MAX_WRITE_BYTES = 16 * 1024

/** 写入子代理的操作日志。返回物同样由它决定。 */
export interface RememberLog {
  /** 写之前做的查重搜索。 */
  searches: { query: string; hits: number }[]
  /** 查重时读过的既有文件。 */
  reads: { path: string }[]
  /** 实际发生的写入。 */
  writes: { path: string; mode: string; detail: string }[]
  /**
   * 实际发生的删除。**每条都带理由和备份路径** —— 子代理有删除权限的前提是
   * "删了什么、为什么删、去哪儿恢复"三件事都进返回物。
   */
  deletes: { path: string; reason: string; backup: string | null }[]
  /** 子代理主动报告的发现（例如"已有同主题，没有重复写"）。 */
  notes: { kind: string; note: string; paths: string[] }[]
  turns: number
  elapsedMs: number
  stopReason: 'done' | 'budget' | 'context' | 'timeout' | 'error' | 'unavailable'
  error?: string
}

/**
 * 写入子代理的工具白名单。
 *
 * **包含 `memory_delete`**，但有两条约束：① `reason` 必填，理由会原样进返回物；
 * ② 删除前一定备份到 `.trash/`。没有这两条就不该给它删除权，有了这两条，误删是可恢复
 * 且可见的 —— 而"不能删"会让它没法作废一条彻底过时的记忆，那才是真的功能缺失。
 */
export const REMEMBER_TOOLS: ToolSchema[] = [
  {
    name: 'memory_search',
    description: '查重: 搜记忆库(文件名+tags+正文), 返回路径列表与一句话说明',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词' },
        scope: { type: 'string', description: '限定子目录, 如 "技能/浏览器"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_read',
    description: '读一个记忆文件; 传目录则返回该层 INDEX.md(可用来挑分类)',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对记忆库根的路径; 空串 = 根目录' } },
      required: ['path'],
    },
  },
  {
    name: 'memory_write',
    description: '写入记忆文件。mode: create(新建, 已存在则报错) / append(按要点去重追加) / replace(整文件覆盖)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对记忆库根的 .md 路径, 如 "技能/浏览器/chrome-devtools-抓包.md"' },
        content: { type: 'string', description: 'frontmatter + 正文(缺 frontmatter 会自动补全)' },
        mode: { type: 'string', description: 'create / append / replace' },
      },
      required: ['path', 'content', 'mode'],
    },
  },
  {
    name: 'memory_patch',
    description: '局部改写: 把文件里唯一出现的 old 换成 new(更新某个数值/措辞时用它, 比整文件覆盖安全)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对记忆库根的 .md 路径' },
        old: { type: 'string', description: '要被替换的原文, 必须与文件逐字一致且只出现一次' },
        new: { type: 'string', description: '替换后的文本' },
      },
      required: ['path', 'old', 'new'],
    },
  },
  {
    name: 'memory_delete',
    description: '删除一个记忆文件(自动备份到 .trash/, 可恢复)。**reason 必填, 会原样进返回物**',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对记忆库根的 .md 路径' },
        reason: { type: 'string', description: '为什么删: 说清它被哪个文件取代了, 或为什么整条作废' },
      },
      required: ['path', 'reason'],
    },
  },
  {
    name: 'memory_report',
    description: '报告一个发现(例如"已有同主题, 未重复写"), 只写进返回物, 不改文件',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'duplicate(已有同主题) / conflict(同主题多文件) / note(其它)' },
        note: { type: 'string', description: '一句话说明' },
        paths: { type: 'array', items: { type: 'string' }, description: '涉及的文件路径(可省)' },
      },
      required: ['kind', 'note'],
    },
  },
]

/** 写入子代理的系统提示词。**必须短**（每轮都要重发）。 */
export const REMEMBER_SYSTEM_PROMPT = [
  '你是记忆写入子代理。你有五个工具：',
  '- memory_search(query, scope?)：查已有记忆，返回路径与一句话说明。',
  '- memory_read(path)：读文件内容；传目录（或空串）返回该层 INDEX.md，可用来挑分类。',
  '- memory_write(path, content, mode)：mode = create(新建) / append(按要点去重追加) / replace(整文件覆盖)。',
  '- memory_patch(path, old, new)：把文件里**唯一出现**的一段文本换成新文本。',
  '- memory_delete(path, reason)：**删除一个记忆文件**（自动备份到 .trash/，可恢复）。reason 必填。',
  '- memory_report(kind, note, paths?)：报告发现，只写进返回物，不改文件。',
  '',
  '任务：把用户给的内容正确地写进记忆库。',
  '',
  '流程（**必须先查重，不许直接 create**）：',
  '1. 先用 2~3 个**不同的**关键词 memory_search，看有没有同主题的既有文件。',
  '   检索是纯子串匹配，拆成单词分别搜，不要把几个词拼进一个 query。',
  '2. 有相关的就 memory_read 看内容：',
  '   - 已经覆盖了 → **不要再写**，用 memory_report({kind:"duplicate"}) 说明，然后停。',
  '   - 缺一部分 → 用 mode:"append" 把缺的那几条补上。',
  '   - 数值/措辞过时 → 用 memory_patch 精确替换。',
  '   - **整条作废**（内容已完全被别的文件取代，或本来就是错的，patch 表达不了）→ 才用 memory_delete。',
  '3. 确实没有 → 用 mode:"create" 新建。',
  '',
  '删除的规矩（删得起，但要说得清）：',
  '- 删之前**必须 memory_read 确认内容** —— 不许只凭 search 返回的那行说明就删。',
  '- 能 append / patch 解决的，就不要删。删除是最后手段，不是首选。',
  '- reason 要写"它被什么取代了"或"为什么整条作废"，这句话会原样给主 agent 看。',
  '',
  '写入规范（**硬要求**）：',
  '- 一个文件 = 一个主题，3~8 条要点。不相关的东西不要塞进同一个文件。',
  '- 顶层分类只能从这里选：技能 / 电脑操作 / 环境 / 工具 / API / 项目 / 用户偏好。',
  '- 文件名 `<主题>-<细分>.md`，**必须含将来会被搜到的关键词**（文件名就是索引）。',
  '- frontmatter 必填：tags（3~6 个）/ updated（今天）/ source（实测 / 官方文档 / 用户告知 / 推断）。',
  '- frontmatter 可选但很有用：',
  '  · related: [其它记忆的路径] —— 这条**依赖**或**补充**了哪些记忆。',
  '    它比 tags 强：tags 只是"可能相关"，related 是"我断言它们有关系"，检索时会被一并带出来。',
  '    用相对记忆库根的路径，如 "技能/浏览器/chrome-devtools-抓包.md"。',
  '  · importance: 高 / 低 —— **只在这条确实比同类重要或次要时才写**，不确定就不写（缺省即"中"）。',
  '    别给什么都标"高"：那样这个字段就废了，读的人反而分不出重点。',
  '- **同义关键词一并写进 tags**（如"抓包/网络请求/请求分析/network"）——',
  '  检索没有同义词扩展，这是唯一能提高命中率的办法。',
  '- 正文用中文、`- ` 要点列表。用户给的内容原样保留，不要自己改写或"润色"。',
  '',
  '预算：',
  `- 最多 ${REMEMBER_MAX_TURNS} 轮工具调用。`,
  '- 写完就停。结束时不要写总结，只回复"完成"。',
].join('\n')

/**
 * 执行写入子代理请求的一个工具调用。
 *
 * ⚠️ **白名单里包含 `memory_delete`**。早先这里的注释写着"没有 delete"，是过时的 ——
 * 会给它是因为删除有三条护栏：① 一定先备份到 `.trash/`；② `reason` 必填且原样进返回物；
 * ③ 返回物把"删了什么、备份在哪"列出来。所以对子代理而言删除是**可逆**的。
 * 但要清醒：**爆炸半径等于 `MEMORY_ROOT` 有多宽** —— 库越大，一次误删涉及的范围越大。
 */
export async function executeRememberTool(
  root: string,
  call: { name: string; arguments: string },
  log: RememberLog,
): Promise<{ text: string; isError: boolean }> {
  let args: Record<string, unknown>
  try {
    args = call.arguments.trim() === '' ? {} : (JSON.parse(call.arguments) as Record<string, unknown>)
  } catch {
    return { text: `工具参数不是合法 JSON: ${call.arguments.slice(0, 200)}`, isError: true }
  }

  if (call.name === 'memory_search') {
    return subagentSearch(root, args, (query, hits) => {
      log.searches.push({ query, hits })
    })
  }
  if (call.name === 'memory_read') {
    return subagentRead(
      root,
      args,
      (rel) => {
        log.reads.push({ path: rel })
      },
      true,
    )
  }
  if (call.name === 'memory_write') {
    const raw = String(args.path ?? '').trim()
    const content = String(args.content ?? '')
    const mode = String(args.mode ?? 'create').trim()
    if (raw === '') return { text: 'path 不能为空', isError: true }
    if (content.trim() === '') return { text: 'content 不能为空', isError: true }
    if (mode !== 'create' && mode !== 'append' && mode !== 'replace') {
      return { text: `mode 只能是 create / append / replace, 收到 "${mode}"`, isError: true }
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > REMEMBER_MAX_WRITE_BYTES) {
      return {
        text: `内容太大(${formatSize(bytes)}), 单次上限 ${formatSize(REMEMBER_MAX_WRITE_BYTES)}。请拆成多个文件分别写。`,
        isError: true,
      }
    }
    try {
      const r = await writeMemory(root, raw, content, mode)
      log.writes.push({ path: r.rel, mode, detail: r.detail })
      const similar = r.similar.length > 0 ? ` ⚠️ 同目录已有相似文件名: ${r.similar.join(' / ')}` : ''
      return { text: `已写入 ${r.rel} (mode=${mode}${r.detail}, ${formatSize(r.size)})。${similar}`, isError: false }
    } catch (error) {
      return { text: `写入被拒: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  }
  if (call.name === 'memory_patch') {
    const raw = String(args.path ?? '').trim()
    const oldText = String(args.old ?? '')
    const newText = String(args.new ?? '')
    if (raw === '') return { text: 'path 不能为空', isError: true }
    if (oldText === '') return { text: 'old 不能为空', isError: true }
    try {
      const r = await patchMemory(root, raw, oldText, newText)
      const sign = r.delta >= 0 ? '+' : ''
      log.writes.push({ path: r.rel, mode: 'patch', detail: `, ${sign}${r.delta} 字符` })
      return { text: `已改写 ${r.rel} (${sign}${r.delta} 字符, 原内容已备份到 .trash/)。`, isError: false }
    } catch (error) {
      return { text: `改写被拒: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  }
  if (call.name === 'memory_delete') {
    const raw = String(args.path ?? '').trim()
    const reason = String(args.reason ?? '').trim()
    if (raw === '') return { text: 'path 不能为空', isError: true }
    if (reason === '') {
      return { text: 'reason 不能为空 —— 删除必须说明理由, 它会写进返回物给主 agent 看。', isError: true }
    }
    try {
      const r = await deleteMemory(root, raw, false)
      log.deletes.push({ path: r.rel, reason, backup: r.backup })
      const tip = r.backup !== null ? `（备份在 ${r.backup}，可恢复）` : ''
      return { text: `已删除 ${r.rel}${tip}。`, isError: false }
    } catch (error) {
      return { text: `删除被拒: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  }
  if (call.name === 'memory_report') {
    const kind = String(args.kind ?? '').trim()
    const note = String(args.note ?? '').trim()
    if (kind === '' || note === '') return { text: 'kind 与 note 都不能为空', isError: true }
    log.notes.push({
      kind,
      note,
      paths: Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : [],
    })
    return { text: '已记进返回物。', isError: false }
  }

  return {
    text: `没有这个工具: ${call.name}。只能用 memory_search / memory_read / memory_write / memory_patch / memory_report。`,
    isError: true,
  }
}

/**
 * 把写入子代理的操作日志变成返回物。
 *
 * 和检索一样：**子代理的自然语言不进返回物**。返回的是"它查了什么、写了哪个文件、写成什么样"——
 * 最后那段是**从盘上读回来的实际内容**（不是回显它传入的 content），所以追加去重、frontmatter
 * 补全之后真实落了什么，主 agent 一眼能看到。
 */
export function buildRememberReport(root: string, log: RememberLog): string {
  const elapsedNote = Number.isFinite(log.elapsedMs) ? ` / 耗时 ${(log.elapsedMs / 1000).toFixed(1)}s` : ''
  const stopNote =
    log.stopReason === 'budget'
      ? `（到达 ${REMEMBER_MAX_TURNS} 轮上限提前结束）`
      : log.stopReason === 'context'
        ? `（工具返回内容累计超过 ${formatSize(SUBAGENT_MAX_CONTEXT_BYTES)}，提前结束）`
        : log.stopReason === 'timeout'
          ? `（总超时 ${REMEMBER_TOTAL_TIMEOUT_MS / 1000}s 提前结束）`
        : ''
  const head: string[] = [
    `记忆写入结果（子代理执行 ${log.turns} 轮 / ${log.searches.length} 次查重 / ${log.writes.length} 次写入${log.deletes.length > 0 ? ` / ${log.deletes.length} 次删除` : ''}${elapsedNote}）${stopNote}`,
  ]
  const notesBlock = (): void => {
    if (log.notes.length === 0) return
    head.push('', `子代理报告了 ${log.notes.length} 项:`)
    for (const n of log.notes) {
      const where = n.paths.length > 0 ? `  [${n.paths.join(' / ')}]` : ''
      head.push(`  · ${n.kind}: ${n.note}${where}`)
    }
  }
  /** 删除要**醒目**：理由 + 备份路径都给全，"可恢复"才是真的可操作。 */
  const deletesBlock = (): void => {
    if (log.deletes.length === 0) return
    head.push('', `🗑️ 删除了 ${log.deletes.length} 个文件（都有 .trash/ 备份，可恢复）:`)
    for (const d of log.deletes) {
      head.push(`  · ${d.path}`)
      head.push(`      理由: ${d.reason}`)
      if (d.backup !== null) head.push(`      备份: ${d.backup}`)
    }
  }
  if (log.writes.length === 0 && log.deletes.length === 0) {
    head.push('', '⚠️ 子代理**没有写入也没有删除任何文件**。')
    notesBlock()
    if (log.error !== undefined) head.push(`（终止原因: ${log.error}）`)
    return head.join('\n')
  }
  deletesBlock()
  if (log.writes.length > 0) {
    head.push('', '写入:')
    for (const w of log.writes) head.push(`  · ${w.path}  (mode=${w.mode}${w.detail})`)
  }
  if (log.searches.length > 0 || log.reads.length > 0) {
    head.push('', '查重过程:')
    for (const s of log.searches) head.push(`  "${s.query}" → ${s.hits} 条`)
    for (const r of log.reads) head.push(`  读了 ${r.path}`)
  }
  notesBlock()
  // 落盘内容的**实际**结果（读回来，而不是回显输入）
  const last = log.writes[log.writes.length - 1]
  if (last !== undefined) {
    const abs = path.join(root, ...last.path.split('/'))
    const text = readTextOrNull(abs)
    if (text !== null) {
      const cut = truncateUtf8(text, RECALL_MAX_FILE_BYTES)
      head.push(
        '',
        '─'.repeat(60),
        `## ${last.path}   写入后的实际内容   ${formatSize(cut.bytes)}${cut.truncated ? '（已截断）' : ''}`,
        '',
        cut.text,
      )
    }
  }
  return head.join('\n')
}
