/** 单次 `memory_read` 返回给子代理的正文上限（超出部分截断并标注）。 */
export declare const RECALL_PREVIEW_BYTES: number;
/** 单次 `memory_search` 最多列给子代理的条数。 */
export declare const RECALL_SEARCH_PREVIEW = 12;
/**
 * 三个子代理共用的**内部工具**与文本助手。
 *
 * 它们是**给子代理用**的，不是给主 agent 的工具：返回物做成"给模型看的一段文本"，
 * 而不是结构化对象；并且会把读过的文件记进调用方给的日志里 ——
 * 最终返回物由**日志**决定，不是子代理的总结，所以这一步不能漏。
 */
/** 是否是清单文件（INDEX.md 不算"读到的内容"）。 */
export declare function isIndexPath(rel: string): boolean;
/** 按字节截断到上限，并给出"是否截断 + 全文大小"的标注。 */
export declare function truncateUtf8(text: string, maxBytes: number): {
    text: string;
    truncated: boolean;
    bytes: number;
};
/** 子代理共用的 `memory_search` 实现。`record` 把这次搜索记进各自的日志。 */
export declare function subagentSearch(root: string, args: Record<string, unknown>, record: (query: string, hits: number, topPaths: string[]) => void): Promise<{
    text: string;
    isError: boolean;
}>;
/**
 * 子代理共用的 `memory_read` 实现。
 *
 * `allowIndex` 给写入/整理子代理开：它们需要读 INDEX.md 才能挑分类、才能看出索引漂移；
 * 检索子代理则不该把 INDEX 当成"读到的内容"。
 */
export declare function subagentRead(root: string, args: Record<string, unknown>, record: (rel: string, bytes: number) => void, allowIndex?: boolean): {
    text: string;
    isError: boolean;
};
