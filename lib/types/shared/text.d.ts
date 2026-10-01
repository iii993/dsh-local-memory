/** 纯文本工具：日期、路径展示、尺寸与**显示宽度**（CJK 全角算 2 格）。与文件系统无关。 */
/** 当天日期，`YYYY-MM-DD`。 */
export declare function today(): string;
/** Windows 反斜杠统一成 POSIX 斜杠（对外展示与 INDEX 链接用）。 */
export declare function toPosix(p: string): string;
/** 字节数转人类可读。 */
export declare function formatSize(bytes: number): string;
/** 去掉 `.md` 扩展名的文件名。 */
export declare function stripMdExt(name: string): string;
/** 统计 `needle` 在 `haystack` 中出现的次数（大小写不敏感子串）。 */
export declare function countOccurrences(haystack: string, needle: string): number;
/** 终端显示宽度（中日韩全角字符算 2）。 */
export declare function displayWidth(s: string): number;
/** 按显示宽度右补空格。 */
export declare function padTo(s: string, width: number): string;
/**
 * 同 {@link padTo}，但**已经达到或超过 width 时也补一个空格**。
 *
 * 差别只在溢出这一种情况，而它恰好会被看见：多列拼在一行时，超长的那一列会和右邻列
 * **粘在一起** —— 实测过长文件名后直接跟着 `正文命中 ×0`，读起来像文件名的一部分。
 * 宁可让这一行宽一点、列不对齐，也不要让两列分不开。
 */
export declare function padCol(s: string, width: number): string;
/**
 * `path.relative(root, target)` 的结果是否指向 root 之外。
 *
 * 注意不能写成 `rel.startsWith('..')` —— 那会把**合法文件名** `..foo` 误判为越界。
 *
 * 放在 text 而不是 paths 里，是因为它只用字符串与 `path`：`core/index-file` 需要它，
 * 而 `paths` 需要 `index-file` 的 `rebuildIndex`，两处互引就成了环。
 */
export declare function isOutside(rel: string): boolean;
