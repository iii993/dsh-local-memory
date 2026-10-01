import { ToolSchema } from '@deepseek-ai/dsh-llm';
/**
 * 检索子代理：把"看 INDEX、试关键词、决定读哪个"这一串挪到主上下文之外。
 *
 * 主 agent 每一步请求都要重发全部工具定义（本机约 50K token），而白板子代理只挂 3 个工具、
 * 几百 token —— 一次 recall 等于把 4~8 轮检索的**工具定义开销**从主上下文里去掉。
 *
 * **返回物由操作日志决定**（日志里读过哪些文件就返回哪些），不是子代理的总结：
 * 总结会漏、会编，日志是客观的。所以 `buildRecallReport` 只认日志。
 */
/** 子代理最多几轮工具调用。硬上限，不靠提示词（压力下提示词约束不可靠）。 */
export declare const RECALL_MAX_TURNS = 6;
/** 单次 `memory_recall` 默认返回几个文件的原文。 */
export declare const RECALL_DEFAULT_FILES = 5;
/** `maxFiles` 的上限。超出就报告"还有 N 个未返回"，让主 agent 自己决定是否精确定位。 */
export declare const RECALL_MAX_FILES = 8;
/** 返回物里单个文件的字节上限，超出则截断并显式标注。 */
export declare const RECALL_MAX_FILE_BYTES: number;
/** 整个子代理的总超时。 */
export declare const RECALL_TOTAL_TIMEOUT_MS = 45000;
/** 子代理单次回复的 token 上限。它不需要长输出（提示词要求只回"完成"）。 */
export declare const RECALL_MAX_TOKENS = 2000;
/** 降级路径返回的文件数。 */
export declare const FALLBACK_FILES = 3;
/** 降级路径每个文件返回的行数。 */
export declare const FALLBACK_LINES = 15;
/** 子代理检索的操作日志。**返回物由它决定**，不是子代理的自然语言输出。 */
export interface RecallLog {
    /** 成功读取的文件，按调用顺序（含未进入返回物的）。 */
    reads: {
        path: string;
        bytes: number;
    }[];
    /** 每次搜索的 query 与命中数，用于生成"命中概览"。 */
    searches: {
        query: string;
        hits: number;
        topPaths: string[];
    }[];
    /**
     * 子代理**主动报告的发现**（疑似冲突 / 重复 / 过时）。
     *
     * 为什么需要它：返回物由操作日志决定，子代理的自然语言不进返回物。所以"我发现这两个文件
     * 讲的是同一件事"这种判断，必须有一条**结构化的**通道才能传回主 agent —— 这就是这条通道。
     * 它只写进返回物，不改任何文件；合并与否由主 agent 决定。
     */
    notes: {
        kind: string;
        note: string;
        paths: string[];
    }[];
    /** 实际消耗的轮数。 */
    turns: number;
    /** 整个子代理花了多少毫秒。放进返回物 —— 调用方有权知道自己等了多久。 */
    elapsedMs: number;
    /** 终止原因。`budget`/`timeout` 属于"半成功"——照常返回已读到的文件，不整个回退。 */
    stopReason: 'done' | 'budget' | 'context' | 'timeout' | 'error' | 'unavailable';
    /** `stopReason` 为 `error` / `unavailable` 时的原因。 */
    error?: string;
}
/**
 * 给子代理的工具定义：**只传参数名和一句话说明**，不传完整 description。
 *
 * 系统提示词里已经交代过这两个工具，在 schema 里重复一遍只会推高它的每轮开销 ——
 * 而"每轮开销低"正是这个子代理存在的理由。
 */
export declare const RECALL_TOOLS: ToolSchema[];
/** 读子代理的系统提示词。**必须短** —— 长提示词会推高它的每轮成本，直接吃掉收益。 */
export declare const RECALL_SYSTEM_PROMPT: string;
/**
 * 执行子代理请求的一个工具调用。
 *
 * **走白名单**：只认 `memory_search` / `memory_read` / `memory_report`。任何意外名字都返回错误字符串
 * 而不是执行 —— 这同时挡住了递归（白名单里没有 `memory_recall`）和工具泄漏。
 */
export declare function executeRecallTool(root: string, call: {
    name: string;
    arguments: string;
}, log: RecallLog): Promise<{
    text: string;
    isError: boolean;
}>;
/**
 * 把操作日志变成返回物（设计文档 §4.2）。
 *
 * 这是整个方案的落点：子代理的表达能力只用于"决定读哪些"，不用于"复述读到了什么"。
 */
export declare function buildRecallReport(root: string, log: RecallLog, maxFiles: number): string;
/**
 * 把一句自然语言意图拆成可 OR 的检索词（**只给降级路径用**）。
 *
 * 和 {@link splitQueryTerms} 的区别：这里**额外补 2-gram**。因为降级路径没有子代理、
 * 没有语义理解，字符串切分是它唯一的手段，只能靠宽松召回 + 打分排序把它兜住。
 * 正式检索路径不这么做 —— 那里由子代理负责拆词，见 {@link RECALL_SYSTEM_PROMPT}。
 */
export declare function splitIntent(intent: string): string[];
/**
 * 降级路径：零模型成本的确定性检索（设计文档 §4.7）。
 *
 * `llm` 服务不可用、首次调用就抛错时走这里。`memory_recall` 必须仍然可用 ——
 * 记忆功能不能因为模型不可用而瘫痪。
 */
export declare function runDeterministicRecall(root: string, scopeAbs: string, intent: string): Promise<string>;
