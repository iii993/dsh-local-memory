/**
 * 全局保留名与上限常量。
 *
 * 集中在一处，是为了让"哪些名字是保留的"一目了然 —— `.trash` / `.dshlock` 这类以 `.`
 * 开头的名字**必须**不被当成记忆文件，`INDEX.md` 是每层目录的清单名。改动其中任何一个，
 * 都会同时影响索引、搜索与备份三条路径。
 */

/** 每层目录的清单文件名。 */
export const INDEX_FILE = 'INDEX.md'

/** frontmatter 分隔符。 */
export const FM = '---'

/** 顶层分类词表（固定；需要新分类先与用户确认）。 */
export const TOP_LEVEL_DIRS = ['技能', '电脑操作', '环境', '工具', 'API', '项目', '用户偏好'] as const

/** 备份目录名。以 `.` 开头 → 不进 INDEX、不进搜索、不算记忆条目。 */
export const TRASH_DIR = '.trash'

/** 写锁文件后缀。同样以不是 `.md` 收尾 → 不会被当成记忆。 */
export const LOCK_SUFFIX = '.dshlock'

/** 等待写锁的最长时间。 */
export const LOCK_TIMEOUT_MS = 3000

/** 超过这个时长没被释放的锁视为**陈旧锁**（持有者进程崩了），会被清掉重试。 */
export const LOCK_STALE_MS = 10000

/** `.trash/` 的份数上限。超出时按文件名里的 ISO 时间戳删最旧的。 */
export const TRASH_MAX_FILES = 200

/**
 * INDEX 链的锁文件名（会生成 `<root>/__index_chain__.dshlock`）。
 *
 * 它不是记忆文件（不以 `.md` 结尾），所以不进 INDEX、不进搜索。
 */
export const INDEX_LOCK_NAME = '__index_chain__'

/** 同时在飞的 I/O 数量上限（防止文件多时 EMFILE）。 */
export const IO_CONCURRENCY = 32

/** 单文件内最多统计的命中次数 —— 病态正则可能匹配极多次，这里兜底。 */
export const MAX_HITS_PER_FILE = 5000

/**
 * 子代理上下文里累计内容的**总字节上限**。
 *
 * 单文件、单次读都有上限，但子代理可以读很多次 —— 没有这个总数上限，一次 recall 仍可能
 * 把几十万字节塞进它的上下文（进而撑爆这一次子代理调用的开销）。到顶后停止继续读，
 * 并在返回物里用 `stopReason: "context"` 说明。
 *
 * 放在 shared 而不是某个子代理模块里，是因为主循环与 gc 执行器都要用它。
 */
export const SUBAGENT_MAX_CONTEXT_BYTES = 256 * 1024
