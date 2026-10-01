/**
 * frontmatter 的解析与渲染。
 *
 * 这是 YAML 的一个**极小子集**，零依赖手写 —— 所以不支持"引号里的逗号不算分隔符"这类语法。
 * 与之配套的是写入侧的净化（见 sanitizeListValue）：与其把解析器写成状态机，不如在写入时
 * 就消除歧义。三个必填字段的兜底都在这层，任何写入路径（工具 / 三个子代理）都走它。
 */
/** 记忆文件的 frontmatter。 */
export interface Frontmatter {
    /** 原文件是否本来就有 frontmatter。 */
    present: boolean;
    tags: string[];
    updated: string;
    source: string;
    summary: string;
    /**
     * **显式关联**的其它记忆（相对记忆库根的路径）。
     *
     * tags 与目录只能给出**隐式**关联（那是搜索引擎在猜），`related` 是**作者断言**的
     * "这条依赖那条 / 这条是那条的补充"。检索子代理读到本文件时会顺带把被引用的文件带上，
     * 反向引用则在**已读范围内**算出来（不为此扫全库）。
     */
    related: string[];
    /**
     * 重要性：`高` / `低`；**缺省即"中"**，所以只有确实有高低之分时才写。
     *
     * 用途是**帮读的人排序**（返回物会显示它），**不参与检索排序** —— 排序规则保持可解释，
     * 否则"为什么这条排在前面"会变成一句说不清的话。
     */
    importance: string;
    /** 未识别的自定义行，原样保留。 */
    extra: string[];
}
export declare function emptyFrontmatter(): Frontmatter;
export declare function unquote(v: string): string;
export declare function parseTags(value: string): string[];
/**
 * §7.4 解析 frontmatter。
 *
 * @param text - 文件全文。
 * @returns frontmatter 数据与去掉 frontmatter 后的正文。
 */
export declare function parseFrontmatter(text: string): {
    data: Frontmatter;
    body: string;
};
/** 正文里第一个 Markdown 标题。 */
export declare function firstHeading(body: string): string;
/** 从标题/文件名推导 tags（按非字母数字切分，最多 6 个；推导不出时回退整个基名）。 */
export declare function deriveTags(text: string): string[];
/**
 * 净化**数组型** frontmatter 值（tags / related 的元素）。
 *
 * frontmatter 是 YAML 的**极小子集**（零依赖手写解析），不支持"引号里的逗号不算分隔符"。
 * 所以 `tags: [a, b]` 里只要有一个值本身含半角逗号，往返解析就会把它切成两个 ——
 * 写进去再读出来就不是原来的东西了。
 *
 * 修法有两条路：① 写一个带引号状态的切分器；② 在**写入时**消除歧义。选 ②，
 * 因为 ① 会让这块本就手写的解析更脆，而 ② 对中文内容几乎无损、且绝不可能被误解析。
 * 半角逗号与顿号都换成全角顿号 `、`（它不参与任何分隔），方括号换成全角书名号。
 */
export declare function sanitizeListValue(v: string): string;
/** 净化**单值** frontmatter 字段（source / summary / importance）：去掉换行即可。 */
export declare function sanitizeScalar(v: string): string;
/**
 * 把 `updated` 规范成 `YYYY-MM-DD`；格式不对或**日期不存在**（如 `2026-02-30`）时回退到今天。
 *
 * 为什么不直接收下任意字符串：`updated` 是 `since` 过滤与 `sort:"updated"` 的依据，
 * 一个格式错误的值会让这些功能**静默失效** —— 用户只会觉得"怎么搜不到"。
 */
export declare function normalizeUpdated(v: string): string;
/** 按规范渲染 frontmatter + 正文。 */
export declare function buildText(fm: Frontmatter, body: string): string;
/**
 * §7.4 校验并补全 `tags` / `updated` / `source`（并保留 `summary` 与自定义行）。
 *
 * @param text - 原始内容。
 * @param fallbackName - 没有标题时用来推导 tags 的文件名。
 * @returns 规范化后的完整文件文本。
 */
export declare function ensureFrontmatter(text: string, fallbackName?: string): string;
