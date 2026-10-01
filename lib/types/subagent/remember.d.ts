import { ToolSchema } from '@deepseek-ai/dsh-llm';
/**
 * 写入子代理：先查重，再决定 create / append / patch，整条作废时才 delete。
 *
 * 它**有删除权限** —— 依据是删除有三条护栏：① 一定先备份到 `.trash/`；② `reason` 必填且
 * 原样进返回物；③ 返回物把"删了什么、备份在哪"列出来。对子代理来说删除是**可逆**的。
 * 但要知道：**爆炸半径等于 MEMORY_ROOT 有多宽**。
 *
 * 返回物同样是"客观操作记录 + **写入后回读的实际内容**"，不是它自己声称写了什么。
 */
export declare const REMEMBER_MAX_TURNS = 8;
export declare const REMEMBER_MAX_TOKENS = 3000;
export declare const REMEMBER_TOTAL_TIMEOUT_MS = 60000;
/** 单次写入的正文上限。超了说明它该拆成多个文件。 */
export declare const REMEMBER_MAX_WRITE_BYTES: number;
/** 写入子代理的操作日志。返回物同样由它决定。 */
export interface RememberLog {
    /** 写之前做的查重搜索。 */
    searches: {
        query: string;
        hits: number;
    }[];
    /** 查重时读过的既有文件。 */
    reads: {
        path: string;
    }[];
    /** 实际发生的写入。 */
    writes: {
        path: string;
        mode: string;
        detail: string;
    }[];
    /**
     * 实际发生的删除。**每条都带理由和备份路径** —— 子代理有删除权限的前提是
     * "删了什么、为什么删、去哪儿恢复"三件事都进返回物。
     */
    deletes: {
        path: string;
        reason: string;
        backup: string | null;
    }[];
    /** 子代理主动报告的发现（例如"已有同主题，没有重复写"）。 */
    notes: {
        kind: string;
        note: string;
        paths: string[];
    }[];
    turns: number;
    elapsedMs: number;
    stopReason: 'done' | 'budget' | 'context' | 'timeout' | 'error' | 'unavailable';
    error?: string;
}
/**
 * 写入子代理的工具白名单。
 *
 * **包含 `memory_delete`**，但有两条约束：① `reason` 必填，理由会原样进返回物；
 * ② 删除前一定备份到 `.trash/`。没有这两条就不该给它删除权，有了这两条，误删是可恢复
 * 且可见的 —— 而"不能删"会让它没法作废一条彻底过时的记忆，那才是真的功能缺失。
 */
export declare const REMEMBER_TOOLS: ToolSchema[];
/** 写入子代理的系统提示词。**必须短**（每轮都要重发）。 */
export declare const REMEMBER_SYSTEM_PROMPT: string;
/**
 * 执行写入子代理请求的一个工具调用。
 *
 * ⚠️ **白名单里包含 `memory_delete`**。早先这里的注释写着"没有 delete"，是过时的 ——
 * 会给它是因为删除有三条护栏：① 一定先备份到 `.trash/`；② `reason` 必填且原样进返回物；
 * ③ 返回物把"删了什么、备份在哪"列出来。所以对子代理而言删除是**可逆**的。
 * 但要清醒：**爆炸半径等于 `MEMORY_ROOT` 有多宽** —— 库越大，一次误删涉及的范围越大。
 */
export declare function executeRememberTool(root: string, call: {
    name: string;
    arguments: string;
}, log: RememberLog): Promise<{
    text: string;
    isError: boolean;
}>;
/**
 * 把写入子代理的操作日志变成返回物。
 *
 * 和检索一样：**子代理的自然语言不进返回物**。返回的是"它查了什么、写了哪个文件、写成什么样"——
 * 最后那段是**从盘上读回来的实际内容**（不是回显它传入的 content），所以追加去重、frontmatter
 * 补全之后真实落了什么，主 agent 一眼能看到。
 */
export declare function buildRememberReport(root: string, log: RememberLog): string;
