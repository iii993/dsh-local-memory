import { ToolSchema } from '@deepseek-ai/dsh-llm'
import fs from 'node:fs'
import path from 'node:path'
import { SUBAGENT_MAX_CONTEXT_BYTES } from '../shared/constants.js'
import { readTextOrNull } from '../shared/fsx.js'
import { formatSize, toPosix } from '../shared/text.js'
import { parseFrontmatter } from '../core/frontmatter.js'
import { stripFooter } from '../core/index-file.js'
import { createSearchMatcher, searchFiles, walkFiles } from '../core/search.js'
import { isIndexPath, subagentRead, subagentSearch, truncateUtf8 } from './kit.js'

/**
 * 检索子代理：把"看 INDEX、试关键词、决定读哪个"这一串挪到主上下文之外。
 *
 * 主 agent 每一步请求都要重发全部工具定义（本机约 50K token），而白板子代理只挂 3 个工具、
 * 几百 token —— 一次 recall 等于把 4~8 轮检索的**工具定义开销**从主上下文里去掉。
 *
 * **返回物由操作日志决定**（日志里读过哪些文件就返回哪些），不是子代理的总结：
 * 总结会漏、会编，日志是客观的。所以 `buildRecallReport` 只认日志。
 */

/** 子代理最多几轮工具调用。硬上限，不靠提示词（压力下提示词约束不可靠）。 */
export const RECALL_MAX_TURNS = 6

/** 单次 `memory_recall` 默认返回几个文件的原文。 */
export const RECALL_DEFAULT_FILES = 5

/** `maxFiles` 的上限。超出就报告"还有 N 个未返回"，让主 agent 自己决定是否精确定位。 */
export const RECALL_MAX_FILES = 8

/** 返回物里单个文件的字节上限，超出则截断并显式标注。 */
export const RECALL_MAX_FILE_BYTES = 8 * 1024

/** 整个子代理的总超时。 */
export const RECALL_TOTAL_TIMEOUT_MS = 45_000

/** 子代理单次回复的 token 上限。它不需要长输出（提示词要求只回"完成"）。 */
export const RECALL_MAX_TOKENS = 2000

/** 降级路径返回的文件数。 */
export const FALLBACK_FILES = 3

/** 降级路径每个文件返回的行数。 */
export const FALLBACK_LINES = 15

/** 子代理检索的操作日志。**返回物由它决定**，不是子代理的自然语言输出。 */
export interface RecallLog {
  /** 成功读取的文件，按调用顺序（含未进入返回物的）。 */
  reads: { path: string; bytes: number }[]
  /** 每次搜索的 query 与命中数，用于生成"命中概览"。 */
  searches: { query: string; hits: number; topPaths: string[] }[]
  /**
   * 子代理**主动报告的发现**（疑似冲突 / 重复 / 过时）。
   *
   * 为什么需要它：返回物由操作日志决定，子代理的自然语言不进返回物。所以"我发现这两个文件
   * 讲的是同一件事"这种判断，必须有一条**结构化的**通道才能传回主 agent —— 这就是这条通道。
   * 它只写进返回物，不改任何文件；合并与否由主 agent 决定。
   */
  notes: { kind: string; note: string; paths: string[] }[]
  /** 实际消耗的轮数。 */
  turns: number
  /** 整个子代理花了多少毫秒。放进返回物 —— 调用方有权知道自己等了多久。 */
  elapsedMs: number
  /** 终止原因。`budget`/`timeout` 属于"半成功"——照常返回已读到的文件，不整个回退。 */
  stopReason: 'done' | 'budget' | 'context' | 'timeout' | 'error' | 'unavailable'
  /** `stopReason` 为 `error` / `unavailable` 时的原因。 */
  error?: string
}

/**
 * 给子代理的工具定义：**只传参数名和一句话说明**，不传完整 description。
 *
 * 系统提示词里已经交代过这两个工具，在 schema 里重复一遍只会推高它的每轮开销 ——
 * 而"每轮开销低"正是这个子代理存在的理由。
 */
export const RECALL_TOOLS: ToolSchema[] = [
  {
    name: 'memory_search',
    description: '搜记忆库(文件名+tags+正文), 返回路径列表与一句话说明; **query 传空串 = 列出该目录下所有文件**',
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
    description: '读一个记忆文件的全文; 传目录(或空串)则返回该层 INDEX.md',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对记忆库根的 .md 路径' } },
      required: ['path'],
    },
  },
  {
    name: 'memory_report',
    description: '报告一个发现(疑似重复/冲突/过时), 只写进返回物, 不改任何文件',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'conflict(同主题多文件) / stale(可能过时) / missing(该有但没有) / note(其它)' },
        note: { type: 'string', description: '一句话说明你发现了什么' },
        paths: { type: 'array', items: { type: 'string' }, description: '涉及的文件路径(可省)' },
      },
      required: ['kind', 'note'],
    },
  },
]

/** 读子代理的系统提示词。**必须短** —— 长提示词会推高它的每轮成本，直接吃掉收益。 */
export const RECALL_SYSTEM_PROMPT = [
  '你是记忆检索子代理。你有三个工具：',
  '- memory_search(query, scope?)：搜文件名+tags+正文，返回路径列表与一句话说明。',
  '- memory_read(path)：读文件内容。',
  '- memory_report(kind, note, paths?)：报告一个发现，只写进最终返回物，不改任何文件。',
  '',
  '任务：根据用户意图找到相关记忆，读出需要的内容。',
  '',
  '检索规则：',
  '- 先 search，从路径与说明判断哪些相关，再 read。不要盲读。',
  '- 检索是**纯子串匹配**：不要把几个词拼进一个 query（如 "chrome 抓包"），那必然 0 命中。',
  '- 拆成单个词分别搜，**先搜区分度最高的**（专有名词 / 英文标识 > 通用中文词）。',
  '- 某个词 0 命中就换一个更短更通用的词再试，不要重复同样的词。',
  '- 找不到词的时候有两条退路，**别硬猜**：',
  '  ① memory_read("") 读根 INDEX.md，看有哪些分类和条目说明；也可以 memory_read("技能") 读某层的 INDEX。',
  '     INDEX 不进返回物（它是导航不是内容），但能告诉你该用什么词。',
  '  ② memory_search({ query: "", scope: "技能" }) 列出该目录下所有文件，直接扫文件名。',
  '- 读到文件后，若它写了 `related:`，**顺着读一下** —— 那是作者断言的关联，比 tags 更可信。',
  '',
  '冲突检查（**别跳过**）：',
  '- 读文件时留意"同一主题被写成了多个文件"：文件名高度相似，或内容明显重叠。',
  '- 一旦发现就用 memory_report({ kind: "conflict", paths: [...], note: "..." }) 报告。',
  '- 也欢迎报告别的发现：kind:"stale"（内容可能过时）、kind:"missing"（该有但没有）。',
  '- **不要试图合并或改写任何文件** —— 你只读不写；要不要合并由主 agent 决定。',
  '',
  '预算：',
  `- 最多 ${RECALL_MAX_TURNS} 轮工具调用，用完必须停。`,
  '- 找到足够的内容就停，不要追求穷尽。',
  '- 结束时不要写总结或解释，只回复"完成"。',
].join('\n')

/**
 * 执行子代理请求的一个工具调用。
 *
 * **走白名单**：只认 `memory_search` / `memory_read` / `memory_report`。任何意外名字都返回错误字符串
 * 而不是执行 —— 这同时挡住了递归（白名单里没有 `memory_recall`）和工具泄漏。
 */
export async function executeRecallTool(
  root: string,
  call: { name: string; arguments: string },
  log: RecallLog,
): Promise<{ text: string; isError: boolean }> {
  let args: Record<string, unknown>
  try {
    args = call.arguments.trim() === '' ? {} : (JSON.parse(call.arguments) as Record<string, unknown>)
  } catch {
    return { text: `工具参数不是合法 JSON: ${call.arguments.slice(0, 200)}`, isError: true }
  }

  if (call.name === 'memory_search') {
    return subagentSearch(root, args, (query, hits, topPaths) => {
      log.searches.push({ query, hits, topPaths })
    })
  }
  if (call.name === 'memory_read') {
    return subagentRead(
      root,
      args,
      (rel, bytes) => {
        log.reads.push({ path: rel, bytes })
      },
      // INDEX 放开: 猜不到关键词时它是唯一的退路, 而它本来就不会进返回物
      // (buildRecallReport 把 INDEX 当导航过滤掉), 代价只是可能多花一轮。
      true,
    )
  }
  if (call.name === 'memory_report') {
    const kind = String(args.kind ?? '').trim()
    const note = String(args.note ?? '').trim()
    if (kind === '' || note === '') return { text: 'kind 与 note 都不能为空', isError: true }
    const paths = Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : []
    log.notes.push({ kind, note, paths })
    return { text: '已记进返回物。', isError: false }
  }

  return {
    text: `没有这个工具: ${call.name}。只能用 memory_search / memory_read / memory_report。`,
    isError: true,
  }
}

/**
 * 把操作日志变成返回物（设计文档 §4.2）。
 *
 * 这是整个方案的落点：子代理的表达能力只用于"决定读哪些"，不用于"复述读到了什么"。
 */
export function buildRecallReport(root: string, log: RecallLog, maxFiles: number): string {
  // 按被读取的顺序去重，排除 INDEX
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const r of log.reads) {
    if (r.path === '' || isIndexPath(r.path) || seen.has(r.path)) continue
    seen.add(r.path)
    ordered.push(r.path)
  }
  const shown = ordered.slice(0, maxFiles)
  const omitted = ordered.slice(maxFiles)

  const stopNote =
    log.stopReason === 'budget'
      ? `（到达 ${RECALL_MAX_TURNS} 轮上限提前结束）`
      : log.stopReason === 'context'
        ? `（工具返回内容累计超过 ${formatSize(SUBAGENT_MAX_CONTEXT_BYTES)}，提前结束）`
        : log.stopReason === 'timeout'
          ? `（总超时 ${RECALL_TOTAL_TIMEOUT_MS / 1000}s 提前结束）`
          : ''

  const elapsedNote = Number.isFinite(log.elapsedMs) ? ` / 耗时 ${(log.elapsedMs / 1000).toFixed(1)}s` : ''
  const head: string[] = [
    `记忆检索结果（子代理执行 ${log.turns} 轮 / ${log.searches.length} 次搜索 / 读取 ${ordered.length} 个文件${elapsedNote}）${stopNote}`,
  ]
  if (log.searches.length > 0) {
    head.push('', '命中概览:')
    for (const s of log.searches) {
      head.push(`  "${s.query}" → ${s.hits} 条命中`)
    }
  }
  // 子代理主动报告的发现放在文件之前 —— 它比"读到了什么"更需要主 agent 先看到
  const notes = log.notes ?? []
  if (notes.length > 0) {
    head.push('', `⚠️ 子代理报告了 ${notes.length} 项发现（它没有改任何文件）:`)
    for (const n of notes) {
      const where = n.paths.length > 0 ? `  [${n.paths.join(' / ')}]` : ''
      head.push(`  · ${n.kind}: ${n.note}${where}`)
    }
  }
  if (ordered.length === 0) {
    head.push('', '子代理没有读到任何文件。可能这个意图在记忆库里没有对应内容。')
    if (log.error !== undefined) head.push(`（终止原因: ${log.error}）`)
    return head.join('\n')
  }

  const parts: string[] = [head.join('\n')]
  let total = 0
  // 先把每个文件的 frontmatter 取出来：importance 要显示，related 要用来算引用关系。
  // 正文与 frontmatter 只读一次（这里本来就要读正文）。
  const infos: {
    rel: string
    text: string
    bytes: number
    truncated: boolean
    importance: string
    related: string[]
  }[] = []
  for (const rel of shown) {
    const abs = path.join(root, ...rel.split('/'))
    const raw = readTextOrNull(abs)
    const fm = raw === null ? null : parseFrontmatter(raw).data
    const cut = truncateUtf8(raw ?? '(文件在检索后被删除或移动了)', RECALL_MAX_FILE_BYTES)
    total += cut.bytes
    infos.push({
      rel,
      text: cut.text,
      bytes: cut.bytes,
      truncated: cut.truncated,
      importance: fm === null ? '' : fm.importance,
      related: fm === null ? [] : fm.related,
    })
  }
  // 反向引用**只在已读到的文件范围内算** —— 想知道"全库谁引用了我"得扫一遍库，那个代价不值。
  // 引用写法可能是完整相对路径，也可能只写了文件名，所以两种都认。
  const citedBy = new Map<string, string[]>()
  for (const info of infos) {
    for (const target of info.related) {
      const need = target.replace(/\\/g, '/').toLowerCase()
      const hit = infos.find((i) => i.rel.toLowerCase() === need || i.rel.toLowerCase().endsWith(`/${need}`))
      if (hit === undefined || hit.rel === info.rel) continue
      const list = citedBy.get(hit.rel)
      if (list === undefined) citedBy.set(hit.rel, [info.rel])
      else if (!list.includes(info.rel)) list.push(info.rel)
    }
  }
  for (const info of infos) {
    const notes: string[] = []
    // 重要性放最前：读的人先要知道"这条值不值得细看"
    if (info.importance !== '') notes.push(`重要性 ${info.importance}`)
    if (info.related.length > 0) notes.push(`引用 → ${info.related.join(' / ')}`)
    const cited = citedBy.get(info.rel)
    if (cited !== undefined && cited.length > 0) notes.push(`← 被引用（${cited.join(' / ')}）`)
    const sizeNote = info.truncated ? `已截断: 全文 ${formatSize(info.bytes)}` : formatSize(info.bytes)
    parts.push(
      '',
      '─'.repeat(60),
      `## ${info.rel}   ${sizeNote}${notes.length > 0 ? `   【${notes.join('；')}】` : ''}`,
      '',
      info.text,
    )
  }

  const tail: string[] = ['', '─'.repeat(60)]
  tail.push(`共返回 ${shown.length} 个文件, ${formatSize(total)}。`)
  if (omitted.length > 0) {
    tail.push('', `另有 ${omitted.length} 个已读取但未返回（超出上限 ${maxFiles}）:`)
    for (const rel of omitted) tail.push(`  ${rel}`)
    tail.push('', '需要时用 memory_read({ path: "..." }) 精确取回。')
  }
  parts.push(tail.join('\n'))
  return parts.join('\n')
}

/**
 * 把一句自然语言意图拆成可 OR 的检索词（**只给降级路径用**）。
 *
 * 和 {@link splitQueryTerms} 的区别：这里**额外补 2-gram**。因为降级路径没有子代理、
 * 没有语义理解，字符串切分是它唯一的手段，只能靠宽松召回 + 打分排序把它兜住。
 * 正式检索路径不这么做 —— 那里由子代理负责拆词，见 {@link RECALL_SYSTEM_PROMPT}。
 */
export function splitIntent(intent: string): string[] {
  const terms = intent
    .split(/[\s,，、。；;：:!！?？"'“”‘’()（）\[\]{}<>《》/\\|+*·\-—_~@#$%^&]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  // 长中文串没有空格可拆，补一层 2-gram 提高召回（噪音由打分排序吸收）
  const grams: string[] = []
  for (const t of terms) {
    if (/^[\u4e00-\u9fa5]+$/.test(t) && t.length >= 4) {
      for (let i = 0; i + 2 <= t.length; i += 1) grams.push(t.slice(i, i + 2))
    }
  }
  return [...new Set([...terms, ...grams])].slice(0, 12)
}

/**
 * 降级路径：零模型成本的确定性检索（设计文档 §4.7）。
 *
 * `llm` 服务不可用、首次调用就抛错时走这里。`memory_recall` 必须仍然可用 ——
 * 记忆功能不能因为模型不可用而瘫痪。
 */
export async function runDeterministicRecall(root: string, scopeAbs: string, intent: string): Promise<string> {
  const terms = splitIntent(intent)
  if (terms.length === 0) return '没能从意图里拆出可检索的词，请换一种说法或直接 memory_search。'
  const scored = new Map<string, { rel: string; desc: string; updated: string; score: number }>()
  for (const term of terms) {
    const hits = await searchFiles(root, scopeAbs, term, { searchBody: true })
    hits.forEach((h, index) => {
      // 多路 OR + 简单加权：文件名命中权重最高，其次标签，再正文次数，最后是排名本身
      const score = (h.nameHit ? 100 : 0) + h.tagHits * 10 + h.bodyHits + Math.max(0, 20 - index)
      const prev = scored.get(h.rel)
      if (prev === undefined || score > prev.score) {
        scored.set(h.rel, { rel: h.rel, desc: h.desc, updated: h.updated, score })
      }
    })
  }
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score)
  if (ranked.length === 0) {
    return `确定性检索也没找到相关记忆（试过: ${terms.join(' / ')}）。`
  }
  const out: string[] = [`确定性检索命中 ${ranked.length} 个（试过: ${terms.join(' / ')}）:`]
  for (const item of ranked.slice(0, FALLBACK_FILES)) {
    out.push('', `## ${item.rel}   ${item.updated !== '' ? item.updated : '—'}`, `说明: ${item.desc}`)
    const raw = readTextOrNull(path.join(root, ...item.rel.split('/')))
    if (raw !== null) {
      const body = stripFooter(raw)
      const lines = body.split('\n').slice(0, FALLBACK_LINES)
      out.push('```', ...lines, body.split('\n').length > FALLBACK_LINES ? '...' : '', '```')
    }
  }
  if (ranked.length > FALLBACK_FILES) {
    out.push('', `还有 ${ranked.length - FALLBACK_FILES} 个未显示。`)
  }
  return out.join('\n')
}
