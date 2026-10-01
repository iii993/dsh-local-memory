import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { createToolResultMessage } from '@deepseek-ai/dsh-llm/message';
import { SUBAGENT_MAX_CONTEXT_BYTES } from '../shared/constants.js';
import { formatSize } from '../shared/text.js';
/**
 * 跑一轮子代理，直到它不再调用工具、或撞上某个上限。
 *
 * 撞上限属于**半成功**：日志里已完成的动作照常返回，不整个回退 ——
 * 所以 `stopReason` 会把 `done` / `budget` / `context` / `timeout` / `error` / `unavailable` 分开报，
 * 调用方的返回物也要如实说明是哪一种。
 */
export async function runSubagentLoop(ctx, opts, log, execute) {
    const started = Date.now();
    try {
        // llm 按**可选**服务取：拿不到就走降级路径，绝不让记忆功能整体瘫痪
        const llm = ctx.get('llm');
        if (llm === undefined) {
            log.stopReason = 'unavailable';
            log.error = 'llm 服务未挂载';
            return;
        }
        const selection = ctx.get('agentDefaultModel')?.currentSelection();
        if (selection === undefined || selection.provider === '' || selection.model === '') {
            log.stopReason = 'unavailable';
            log.error = '拿不到可用模型(agentDefaultModel 未配置 provider/model)';
            return;
        }
        const messages = [{ role: 'user', content: [{ type: 'text', text: opts.prompt }] }];
        const deadline = Date.now() + opts.timeoutMs;
        // 累计工具返回的字节数。只卡轮数不够 —— 一轮里可以发多次调用，乘起来没有上界。
        let contextBytes = 0;
        for (let turn = 0; turn < opts.maxTurns; turn += 1) {
            log.turns = turn + 1;
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                log.stopReason = 'timeout';
                return;
            }
            // 拼装交给官方的 BlockAssembler —— 它是 agent loop 用的同一套算法，
            // 不自己拼 tool-call-delta 的 JSON 片段。
            const assembler = new BlockAssembler();
            try {
                const stream = llm.stream({
                    provider: selection.provider,
                    model: selection.model,
                    system: opts.system,
                    messages,
                    tools: opts.tools,
                    maxTokens: opts.maxTokens,
                    signal: AbortSignal.timeout(remaining),
                });
                for await (const chunk of stream)
                    assembler.push(chunk);
            }
            catch (error) {
                log.stopReason = 'error';
                log.error = error instanceof Error ? error.message : String(error);
                return;
            }
            const calls = assembler.blocks().filter((b) => b.type === 'tool-call');
            // 没有工具调用 = 子代理认为完事
            if (calls.length === 0) {
                log.stopReason = 'done';
                return;
            }
            messages.push(assembler.message({ provider: selection.provider, model: selection.model }));
            for (const call of calls) {
                const result = await execute(call, log);
                const bytes = Buffer.byteLength(result.text, 'utf8');
                // 累计上限：**在 push 之前判断**，超了就整个停下，而不是先把超长内容喂给模型再说。
                // 这也是一种"半成功"—— 已经收集到的结果照常返回，不整个回退。
                if (contextBytes + bytes > SUBAGENT_MAX_CONTEXT_BYTES) {
                    log.stopReason = 'context';
                    log.error = `工具返回内容累计将超过 ${formatSize(SUBAGENT_MAX_CONTEXT_BYTES)}，提前结束`;
                    return;
                }
                contextBytes += bytes;
                messages.push(createToolResultMessage({
                    callId: call.id,
                    content: [{ type: 'text', text: result.text }],
                    isError: result.isError,
                }));
            }
        }
        // 撞上限属于"半成功"：日志里已完成的动作照常返回，不整个回退
        log.stopReason = 'budget';
    }
    finally {
        log.elapsedMs = Date.now() - started;
    }
}
