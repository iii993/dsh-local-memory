/**
 * 文件名相似度：给"疑似同一主题"提供**候选**。
 *
 * 两条判据，满足其一即可：① 字符集 Jaccard ≥ 0.6；② **共同前缀**够长且占短名的比例够大。
 * 第二条是补上来的 —— 纯 Jaccard 对中文长文件名太苛刻：实测
 * `Jaccard("记忆库-旧知识图谱方案已废弃", "记忆库-文件式方案") = 0.353`，
 * 人一眼就看出同族，却落在阈值之下。共同前缀越短越吃亏，而人靠的恰恰是共享前缀。
 *
 * 这里只产出候选：**该不该合并是语义判断，交给整理子代理**（它会读内容再下结论）。
 */
/**
 * 同目录下与新文件名**高度相似**的既有记忆（用于提示"这可能是同一个主题"）。
 *
 * 用字符集的 Jaccard 相似度，零依赖。相似度 ≥ 0.6 视为疑似重复。
 * 这只是**提示**，不阻止写入 —— 判断"该不该合并"需要语义理解，不该由字符串相似度替用户决定。
 */
export declare function findSimilarNames(dir: string, baseName: string): string[];
/** 判定"同族文件名"的共同前缀下限（按字符计）。 */
export declare const DUP_PREFIX_MIN = 4;
/** 共同前缀还得占较短那个名字的这个比例，避免极短名字（"A-x" / "A-y"）被误并成一组。 */
export declare const DUP_PREFIX_RATIO = 0.3;
/** 两个字符串的公共前缀长度（按字符，不按字节）。 */
export declare function commonPrefixLength(a: string, b: string): number;
/**
 * 找出**同目录下**彼此高度相似的记忆文件，按"是否已存在同主题"分组。
 *
 * 给整理子代理预先算好、直接喂进 prompt —— **机械的字符串比较归代码，语义判断归子代理**。
 * 实测把这件事交给子代理会漏：它列完目录就停了，不会逐对比文件名，于是
 * "文件名里就写着已废弃"、"3.6KB 只讲一个主题"这类问题全被报成"没有发现问题"。
 *
 * @param root - 记忆库根目录。
 * @param scopeAbs - 检查范围的绝对路径。
 * @param minScore - 字符集 Jaccard 相似度阈值，默认 0.6（与 `findSimilarNames` 一致）。
 * @returns 每个元素是一组互相似的相对路径（已去重、已排序）；无重复时返回空数组。
 */
export declare function findDuplicateGroups(root: string, scopeAbs: string, minScore?: number): Promise<string[][]>;
