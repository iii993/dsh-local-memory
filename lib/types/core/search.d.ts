/**
 * 检索：目录遍历、按 mtime+size 失效的内容缓存、查询匹配器、`searchFiles`。
 *
 * 命中范围 = **文件名 + `tags` + 正文**，刻意不含 `updated`/`source` 这类元数据
 * （否则搜"实测"会全线命中）。匹配是**纯子串**、没有同义词扩展；多词按分隔符拆开 OR，
 * 长中文串**不**拆 —— 那是语义判断，交给 `memory_recall` 的白板子代理。
 *
 * 排序刻意保持**可解释**：文件名命中 > 标签命中 > 整串精确命中 > 正文命中数 > 日期。
 * 不引入权重打分，也不按文件体积加权 —— 用户要能一眼看懂"为什么这条排前面"。
 */
/** 一个文件的元信息。 */
export interface FileEntry {
    abs: string;
    rel: string;
    size: number;
    mtime: number;
}
/** 搜索用的正文缓存条目。 */
export interface ContentCacheEntry {
    mtimeMs: number;
    size: number;
    body: string;
    /** `tags` 以换行连接：标签是人工主题标注，命中它比正文撞词更能说明"这个文件讲什么"。 */
    tags: string;
    /** 原始标签数组。`suggestTags` 要逐个标签打分，不该去遍历 `tags` 那根拼好的串。 */
    tagList: string[];
    updated: string;
    /** 搜索结果里的"说明"列：`summary` 优先，缺失时回退正文首个标题。 */
    desc: string;
}
/**
 * 正文缓存：键为绝对路径，用 `mtime + size` 判失效；Map 的插入顺序当 LRU，超限就丢最旧的。
 *
 * 记忆库预期数百个文件、单个几 KB，全放内存也就几 MB；换来的是**重复搜索几乎不碰磁盘**。
 * 写工具落盘后会主动失效对应条目（见 {@link invalidateSearchCache}），所以不存在"改了还搜到旧内容"。
 */
export declare const contentCache: Map<string, ContentCacheEntry>;
export declare const CACHE_LIMIT = 2000;
/** 失效搜索缓存：传路径只失效该文件，不传则清空（删除目录后用）。 */
export declare function invalidateSearchCache(abs?: string): void;
export declare function cacheGet(abs: string, f: FileEntry): ContentCacheEntry | null;
export declare function cacheSet(abs: string, entry: ContentCacheEntry): void;
/** 读取一个文件的正文与前三个 frontmatter 字段（命中缓存则零 I/O）。 */
export declare function loadContent(f: FileEntry): Promise<ContentCacheEntry | null>;
/**
 * 把一句查询按**分隔符**拆成可 OR 的词。
 *
 * 只做这一种拆分，因为它是**无歧义的**：`"chrome 抓包"`、`"cookie/session"`、`"抓包|发包"`
 * 都是"我想同时找这几个词"的常见写法，而按整串做子串匹配必然 0 命中。
 *
 * **刻意不做**把长中文串切成 2-gram。那是**语义判断**（"网络请求分析"该切成哪些词），
 * 字符串切分做不好：切出来的 `络请`、`求分` 是噪音，还会让召回变宽、稀释精度。
 * 长意图的拆词交给子代理（它有语义理解），见 {@link RECALL_SYSTEM_PROMPT}。
 *
 * 返回空数组表示这个 query 不需要拆。
 */
export declare function splitQueryTerms(query: string): string[];
/** 搜索匹配器：默认大小写不敏感的子串（多词组合自动 OR）；`regex` 为真时按正则（`gi`）处理。 */
export interface SearchMatcher {
    /** 文本里是否出现过。 */
    test(text: string): boolean;
    /** 文本里出现了几次。 */
    count(text: string): number;
    /**
     * **整串**（未拆词）是否命中。
     *
     * 拆词只是兜底手段，排序时"精确命中"必须排在同文件 OR 计数更高的"仅拆词命中"之前 ——
     * 否则搜 "alpha beta" 时，一个分别出现 alpha 和 beta 的文件会盖过真正连写的那个。
     */
    exact(text: string): boolean;
    /** 是否为正则模式（用于提示文案）。 */
    readonly regex: boolean;
    /** 实际参与匹配的词（拆词后会有多个）。 */
    readonly terms: readonly string[];
    /** 是否发生了拆词 —— 调用方据此在结果里说明，免得用户以为匹配变宽是 bug。 */
    readonly split: boolean;
}
/**
 * 构造匹配器。正则只编译一次（**不是每个文件编译一次**），并对零宽匹配做了防死循环处理。
 *
 * @param query - 关键词或正则源码。
 * @param regex - 是否按正则处理。
 * @throws 正则语法无效时抛出中文错误。
 */
export declare function createSearchMatcher(query: string, regex: boolean): SearchMatcher;
/**
 * §7.4 递归列出记忆文件（排除 `INDEX.md` 与隐藏项）。
 *
 * 目录树并发展开、`stat` 限流并发发起 —— 实测比同步串行明显快（20 个文件的 stat 从约 3.2ms 降到约 0.5ms）。
 */
export declare function walkFiles(dir: string, root: string): Promise<FileEntry[]>;
/** 一条搜索命中。 */
export interface SearchHit {
    rel: string;
    nameHit: boolean;
    /** `tags` 命中次数。标签是人工标注的主题，比正文撞词更可信，排序时排在纯正文命中之前。 */
    tagHits: number;
    /**
     * 正文命中次数。
     *
     * **不含** `updated` / `source` 这类元数据字段 —— 否则搜"实测"或某个日期会让几乎所有文件命中。
     * 但 `tags` **要**参与（见 {@link tagHits}）：规则文档明确要求用 `tags` 里的关键词检索，
     * 把标签也排除掉的话那些关键词就永远搜不到了。
     */
    bodyHits: number;
    size: number;
    updated: string;
    /** 整串（未拆词）命中过文件名 / tags / 正文之一 —— 排序时排在"仅拆词命中"之前。 */
    exactHit: boolean;
    /** 一句话说明：`summary` 优先，缺失时回退正文首个标题（与 INDEX 说明列同源）。 */
    desc: string;
}
/** 搜索排序方式。 */
export type SearchSort = 'relevance' | 'updated';
/** 搜索选项。 */
export interface SearchOptions {
    /** 是否同时搜正文与 `tags`（默认 true）；`false` 只搜文件名。 */
    searchBody?: boolean;
    /** `query` 是否按正则处理（默认 false，大小写不敏感）。 */
    regex?: boolean;
    /** 排序：`relevance`（默认，文件名 > 标签 > 正文 > 新鲜度）或 `updated`（纯按日期倒序）。 */
    sort?: SearchSort;
    /** 只返回 `updated >= since` 的记忆（`YYYY-MM-DD`），用于"看看上周记了什么"。 */
    since?: string;
    /**
     * 出参：调用方传一个对象进来，函数把"被 `since` 挡掉的条数"写进去。
     *
     * 为什么需要它：**没有 `updated` 的文件本来能搜到，一加 `since` 就静默消失了**。
     * 被排除这件事必须让人看见，否则用户只会觉得"怎么搜不到"，而不会想到是日期缺失。
     */
    stats?: {
        missingDate?: number;
        olderThanSince?: number;
    };
}
/**
 * §7.3.1 搜索：文件名命中优先，其次标签命中，再正文命中数，最后 `updated` 降序。
 *
 * **从不拿文件体积当权重** —— 大文件不代表更相关，只代表读起来更贵；体积只在输出里展示。
 *
 * 文件遍历与读取都走限流并发 + 正文缓存，匹配器只构造一次（不是每个文件一次）。
 *
 * @param root - 记忆库根目录。
 * @param scopeAbs - 限定目录（绝对路径）。
 * @param query - 关键词；`regex` 为真时是正则源码；**传空串表示列目录**（不按关键词过滤）。
 * @param options - 见 {@link SearchOptions}。
 */
export declare function searchFiles(root: string, scopeAbs: string, query: string, options?: SearchOptions): Promise<SearchHit[]>;
/**
 * 0 命中时给模型一个跳板：从库里已有的 `tags` 里挑出与 query **字符重叠最多**的几个。
 *
 * 纯字符串打分，零依赖。它不解决"没有同义词扩展"这个根本限制，但能把
 * **库里实际用的说法**直接摆到模型面前 —— 比让它盲猜第二个关键词有用得多。
 */
export declare function suggestTags(root: string, scopeAbs: string, query: string, limit?: number): Promise<string[]>;
export declare function clampLimit(v: unknown): number;
/**
 * 把 `since` 挡掉的条数写成一句提示。
 *
 * 为什么必须专门说：**缺少 `updated` 的文件本来能搜到，一加 `since` 就静默消失了**。
 * 被排除这件事必须让人看见 —— 否则用户只会觉得"库里没有"，而不会想到是日期缺失。
 */
export declare function sinceSkipNote(stats: {
    missingDate?: number;
    olderThanSince?: number;
}): string;
