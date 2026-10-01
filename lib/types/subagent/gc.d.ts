import { ToolSchema } from '@deepseek-ai/dsh-llm';
/**
 * 整理子代理：找同主题多文件、过时内容、缺失 frontmatter、命名不规范。
 *
 * 默认**只读**；`apply: true` 才给写工具，而且执行器里还有第二道拦截（不只靠"不给工具"）。
 * 另外：**同目录下的相似文件名由插件预先算好**（`findDuplicateGroups`）塞进提示词 ——
 * 机械的字符串比较归代码，语义判断归子代理。实测把这件事全交给子代理会漏：它列完目录就停了。
 */
export declare const GC_MAX_TURNS = 10;
export declare const GC_MAX_TOKENS = 3000;
export declare const GC_TOTAL_TIMEOUT_MS = 90000;
export declare const GC_MAX_FINDINGS = 20;
/** 整理子代理的操作日志。 */
export interface GcLog {
    /** 列过的目录：范围 + 文件数。 */
    lists: {
        scope: string;
        count: number;
    }[];
    searches: {
        query: string;
        hits: number;
    }[];
    reads: {
        path: string;
    }[];
    /** 体检查出的问题。 */
    findings: {
        kind: string;
        note: string;
        paths: string[];
    }[];
    /** 实际执行的低风险修复。 */
    fixes: {
        kind: string;
        detail: string;
    }[];
    /** 实际发生的删除（合并掉的多余文件）。每条带理由与备份路径。 */
    deletes: {
        path: string;
        reason: string;
        backup: string | null;
    }[];
    turns: number;
    elapsedMs: number;
    stopReason: 'done' | 'budget' | 'context' | 'timeout' | 'error' | 'unavailable';
    error?: string;
}
/**
 * 整理子代理的工具白名单。
 *
 * `memory_patch` 与 `memory_delete` 只在 `apply` 时给出 —— 只读体检不该拥有改写能力（`executeGcTool`
 * 里还有第二道拦截，不只靠"不给工具"）。早先这里写着"任何情况下都没有 memory_delete"，是过时的。
 * `apply: true` 时会给，且删除必须带 `reason`、一定先备份到 `.trash/`、备份路径会进报告。
 */
export declare function gcTools(apply: boolean): ToolSchema[];
/** 整理子代理的系统提示词。**必须短**（每轮都要重发）。 */
export declare function gcSystemPrompt(apply: boolean): string;
/** 执行整理子代理请求的一个工具调用。 */
export declare function executeGcTool(root: string, call: {
    name: string;
    arguments: string;
}, log: GcLog, apply: boolean): Promise<{
    text: string;
    isError: boolean;
}>;
/** 把整理子代理的操作日志变成返回物。 */
export declare function buildGcReport(log: GcLog, apply: boolean): string;
