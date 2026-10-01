import fs from 'node:fs';
/**
 * 文件系统原语：容错读、原子写、错误描述。
 *
 * 这里所有 `...OrNull` 函数的约定是**失败返回 null 而不是抛**，因为调用方几乎总是
 * "读不到就跳过/回退"，而不是"读不到就崩"。反过来，`writeFileAtomic` 失败**必须**抛 ——
 * 静默写失败等于丢数据。
 */
/** 读取文本，失败返回 null。 */
export declare function readTextOrNull(p: string): string | null;
/** 带明确中文原因的业务错误：抛出后不会被外层再包一层 fs 错误说明。 */
export declare class MemoryError extends Error {
}
/** 取 stat，失败返回 null。 */
export declare function statOrNull(p: string): fs.Stats | null;
/** 读取文件开头至多 `max` 字节（用于只看 frontmatter），并去掉末尾被截断的多字节残片。 */
export declare function readTextPrefix(p: string, max: number): string;
/**
 * 原子写入：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接 `writeFileSync` 截断写时，写到一半被杀/磁盘满会留下半截文件；
 * rename 在同一分区上是原子的，读者要么看到旧内容要么看到新内容。
 */
export declare function writeFileAtomic(abs: string, text: string): void;
/** 把常见 fs 错误码翻成可操作的中文。 */
export declare function describeFsError(error: unknown): string;
export declare function realpathOrNull(p: string): string | null;
