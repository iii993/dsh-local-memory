/**
 * 通用子代理循环 —— 检索 / 写入 / 整理三个子代理共用这一份。
 *
 * 它只做三件事：驱动 `llm.stream`、用官方 `BlockAssembler` 拼 chunk、把工具调用交给调用方的
 * 白名单执行器。**它完全不理解业务** —— 记账和返回物构造都是调用方的事。
 *
 * 所有上限（轮数 / 单轮 token / 总超时）都由参数传入并在此强制执行：
 * 提示词层面的约束在压力下不可靠 —— 模型可以无视提示词，但没法无视 `for` 循环和 `AbortSignal`。
 *
 * `llm` 与 `agentDefaultModel` 都按**可选**服务取：拿不到就走 `unavailable`，
 * 绝不让"记忆"这件事整体瘫痪。所以这里需要 `ctx`，由入口文件传入。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolCallBlock, ToolSchema } from '@deepseek-ai/dsh-llm';
/** 三个子代理日志的公共字段。 */
export interface SubagentLog {
    turns: number;
    elapsedMs: number;
    stopReason: 'done' | 'budget' | 'context' | 'timeout' | 'error' | 'unavailable';
    error?: string;
}
/** 一次子代理运行的上限。 */
export interface SubagentLoopOptions {
    system: string;
    prompt: string;
    tools: ToolSchema[];
    maxTurns: number;
    maxTokens: number;
    timeoutMs: number;
}
/**
 * 跑一轮子代理，直到它不再调用工具、或撞上某个上限。
 *
 * 撞上限属于**半成功**：日志里已完成的动作照常返回，不整个回退 ——
 * 所以 `stopReason` 会把 `done` / `budget` / `context` / `timeout` / `error` / `unavailable` 分开报，
 * 调用方的返回物也要如实说明是哪一种。
 */
export declare function runSubagentLoop<L extends SubagentLog>(ctx: Context, opts: SubagentLoopOptions, log: L, execute: (call: ToolCallBlock, log: L) => Promise<{
    text: string;
    isError: boolean;
}>): Promise<void>;
