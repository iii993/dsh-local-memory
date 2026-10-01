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
export declare function pruneTrash(root: string): void;
/**
 * 把即将被覆盖/删除的文件备份到 `<root>/.trash/`。
 *
 * `replace` 是破坏性的，`memory_delete` 也没有回收站 —— 备份是最便宜的安全网。
 * 备份目录以 `.` 开头，所以不会污染 INDEX 和搜索结果；备份失败会抛错，
 * 宁可这次改不成，也不要静默丢掉原内容。
 */
export declare function backupBeforeOverwrite(root: string, abs: string): string | null;
/**
 * 备份任意类型的文件（含 PNG/PDF 等二进制附件）到 `<root>/.trash/`。
 *
 * 为什么不能让 `backupBeforeOverwrite` 包办：它走的是"读成文本再写回"，对二进制会读成
 * `null` 而**静默跳过** —— 目录递归删除时那些附件就无声消失了。README 把"能放截图等
 * 非文本附件"当卖点，所以目录备份这条路必须真正备得下来（用 `copyFileSync`，二进制安全）。
 *
 * @returns 备份的相对路径（`null` = 不是文件 / 越界 / 读不到）。
 */
export declare function backupAnyFile(root: string, abs: string): string | null;
/** 递归备份一个目录下的所有记忆文件（删除非空目录之前调用）。 */
export declare function backupTree(root: string, abs: string): void;
/** 统计 `.trash/` 里的备份数量与总大小（只报数，不自动清理）。 */
export declare function trashStats(root: string): {
    files: number;
    bytes: number;
};
