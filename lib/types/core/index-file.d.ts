/**
 * 每层目录的 `INDEX.md`：渲染、漂移检测、重建链。
 *
 * INDEX 是**派生数据** —— 内容全都能从文件系统重新算出来。这条性质决定了两处关键设计：
 *
 * 1. **宁可陈旧也不能写错**：读不到子项时（杀软扫描 / 文件被占用）一律放弃重建，
 *    绝不把"读不到"渲染成"这层是空的"。见 count-cache 里的 `listSubdirs`。
 * 2. **重建是有锁的**：INDEX 是多进程共享的产物，两个实例各写各的文件不冲突，
 *    但它们会重写同一批 INDEX —— 所以 `updateIndexChainLocked` 用一把全库锁串行化。
 */
/**
 * 读取本层 `INDEX.md` 顶部的 `> 说明:` 引用行（缺失时给空模板）。
 *
 * 注意模板必须与读取路径的结果**逐字符相同**：读回来的行会 `trimEnd()`，
 * 所以空模板也不能带尾随空格 —— 否则 `renderIndex` 不幂等，`indexIsStale` 会把
 * 每次刚重建好的 INDEX 又判成过时。
 */
export declare function readNoteLine(dir: string): string;
/** 从 `> 说明: xxx` 行里取 xxx。 */
export declare function noteContent(line: string): string;
/** Markdown 表格单元格转义。 */
export declare function escCell(s: string): string;
/** 链接目标里把会破坏 Markdown 链接的字符做百分号编码（中文可直用）。 */
export declare function linkTarget(name: string): string;
/**
 * 文件的「说明」：frontmatter.summary，缺失则回退正文首个标题。
 *
 * 这里用 `readTextPrefix`（open + read + close）而不是 `readFile`：实测 1000 个文件
 * 前者 203 ms、后者 275 ms —— `readFileSync` 内部自己还要 fstat 一次，比只读开头更贵。
 */
export declare function describeFile(abs: string): string;
/**
 * §7.5 渲染单层 `INDEX.md`（只列本层直接子项，保留原有 `> 说明:` 行）。
 *
 * @param root - 记忆库根目录。
 * @param dir - 要渲染的目录。
 * @param counts - {@link buildCountIndex} 算好的条目数表；省略则就地递归统计（单层调用时才划算）。
 */
export declare function renderIndex(root: string, dir: string, counts?: Map<string, number>): string;
/** 去掉 INDEX 结尾的"最后更新"行：它每天都变，不该让它把索引判成过时。 */
export declare function stripFooter(text: string): string;
/**
 * 判断本层 `INDEX.md` 是否与实际内容不一致（缺失、漏列条目、条目数变了、说明变了…）。
 *
 * 做法是**渲染一遍再比对**（忽略结尾的"最后更新"行）—— 比逐项检查更准，代价是本层一次
 * `readdir` 加本层文件的说明读取；子目录的递归条目数交给 {@link buildCountIndex} 一次遍历给出，
 * 不会退化成一目录一次递归。
 *
 * @param root - 记忆库根目录。
 * @param dir - 要检查的目录（绝对路径）。
 */
export declare function indexIsStale(root: string, dir: string): boolean;
/**
 * §7.5 重建单层 INDEX。
 *
 * @param root - 记忆库根目录。
 * @param dir - 要重建的目录。
 * @param counts - 可选的条目数表（见 {@link buildCountIndex}）。
 */
export declare function rebuildIndex(root: string, dir: string, counts?: Map<string, number>): void;
/**
 * §7.5 从 `startDir` 向上重建到根。
 *
 * 整条链复用**同一张**条目数表，所以一次写入只需要遍历全库一遍，而不是每层各遍历一遍。
 *
 * @returns 被更新的 INDEX 相对路径列表（从近到远）。
 */
export declare function updateIndexChain(root: string, startDir: string, counts?: Map<string, number>): string[];
/**
 * 带**全库 INDEX 链锁**地更新 INDEX 链。
 *
 * 为什么需要一把独立于内容锁的锁：两个 DSH 实例共享 MEMORY_ROOT 时，各写各的文件会各持
 * **自己那个文件**的锁（互不冲突），但随后都要重写**同一批 INDEX.md** —— 后写的一方会把
 * 先写的覆盖掉，连手写的 `> 说明:` 行也一起冲掉（那本是唯一的人工可写点）。
 * INDEX 是共享产物，就得用共享的锁。
 *
 * 粒度故意粗（全库一把）：INDEX 更新是低频操作，不值得为它做细粒度。
 * 加锁顺序固定为"先内容锁、后 INDEX 锁"，不存在交叉等待，所以不会死锁。
 */
export declare function updateIndexChainLocked(root: string, startDir: string, counts?: Map<string, number>): Promise<string[]>;
/**
 * §7.3.5 自底向上重建整棵子树的 INDEX，返回重建层数。
 *
 * @param counts - 可选的条目数表。调用方若紧接着还要 {@link updateIndexChain}，
 *   把同一张表传下去就能省掉一次全库遍历。
 */
export declare function reindexTree(root: string, dir: string, counts?: Map<string, number>): number;
export declare function reindexSubtree(root: string, dir: string, counts: Map<string, number>): number;
/**
 * §3.4 若根目录不存在则创建，并补上根 `INDEX.md`。
 *
 * ⚠️ 暂时留在入口文件里：它依赖 `rebuildIndex`，而 INDEX 相关代码还没搬进
 * `core/index-file.ts`。放进 `shared/paths.ts` 会形成 paths → index-file → paths 的循环，
 * 所以等 INDEX 整体搬完再把它挪过去。
 */
export declare function ensureRoot(root: string): void;
