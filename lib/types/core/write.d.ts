/**
 * 三个改写入口：`writeMemory` / `patchMemory` / `deleteMemory`。
 *
 * 主 agent 工具与三个子代理**共用这一份实现** —— 权限差异只在"给不给工具"那一层，
 * 底层行为必须一致，否则"子代理删除更危险"之类的说法就站不住。
 *
 * 三条贯穿始终的约定：
 * 1. **改之前先备份**到 `.trash/`（`replace` 与删除尤其），失败就抛，宁可这次改不成；
 * 2. **先拿锁再复查**：锁外看到的 `exists` 只是快照，进锁后必须重新判断，
 *    否则两个进程同时 create 同一个文件会互相静默覆盖；
 * 3. **mtime+size 复查**：锁拦不住编辑器里的手工保存，写完前再比一次，被动过就中止。
 */
/** `memory_write` 支持的三种模式。 */
export type WriteMode = 'create' | 'append' | 'replace';
/** `writeMemory` 的结果。 */
export interface WriteResult {
    /** 相对记忆库根的路径。 */
    rel: string;
    /** 追回模式的补充说明，如 `, 新增 2 条, 跳过重复 1 条`。 */
    detail: string;
    /** 写入后的字节数。 */
    size: number;
    /** 被更新的 INDEX 链（从目标目录到根）。 */
    chain: string[];
    /** 同目录下高度相似的既有文件名（写入子代理据此判断是否该合并）。 */
    similar: string[];
}
/**
 * 写入一个记忆文件。`memory_write` 工具与写入子代理**共用这一份实现**。
 *
 * 调用方负责先 `ensureRoot(root)`。
 *
 * @throws MemoryError 语义错误（文件已存在 / 原文件读不出 / 检测到并发改动）—— 这类错误要原样传出去。
 */
export declare function writeMemory(root: string, raw: string, content: string, mode: WriteMode): Promise<WriteResult>;
/** `patchMemory` 的结果。 */
export interface PatchResult {
    rel: string;
    /** 替换前后的字符数差（按码点算）。 */
    delta: number;
    chain: string[];
    /**
     * 替换前后内容**完全一样**（等价替换），因此没有写盘、也没刷新 `updated`。
     *
     * 为什么要专门标出来：以前这种情况也会走完整流程并刷新 `updated`，
     * 于是"刚更新过"变成假信息 —— 而 `updated` 是 `since` 过滤与时间视图的依据。
     */
    unchanged: boolean;
}
/**
 * 局部改写一个记忆文件。`memory_patch` 工具与写入/整理子代理**共用这一份实现**。
 *
 * @throws MemoryError 语义错误（文件不存在 / `old` 未找到或出现多次 / 检测到并发改动）。
 */
export declare function patchMemory(root: string, raw: string, oldText: string, newText: string): Promise<PatchResult>;
/** `deleteMemory` 的结果。 */
export interface DeleteResult {
    rel: string;
    kind: '文件' | '目录';
    /** 备份在 `.trash/` 下的相对路径（目录备份返回 null）。需要时据此手工恢复。 */
    backup: string | null;
    chain: string[];
}
/**
 * 删除一个记忆文件或目录。`memory_delete` 工具与两个子代理**共用这一份实现**。
 *
 * 删除前一定会往 `.trash/` 留一份（文件）或整棵树（目录）—— **所以删除是可逆的**，
 * 这正是子代理可以拥有删除权限的前提：误删可以恢复，而返回物会把删了什么、备份在哪讲清楚。
 *
 * @throws Error 语义错误（根目录 / INDEX.md / 目录非空且未 recursive）。
 */
export declare function deleteMemory(root: string, raw: string, recursive: boolean): Promise<DeleteResult>;
