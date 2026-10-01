/**
 * 文件式长期记忆库 —— DeepSeek Harness 进程内 cordis 插件。
 *
 * 把 agent 的长期记忆从「单个 JSONL 知识图谱」改为「本机真实文件夹里的 Markdown 文件」：
 *
 * - **一个文件 = 一个主题**（建议 3~8 条要点），文件名必须含将来会被搜到的关键词
 * - **每层目录一个 `INDEX.md`**，只列本层直接子项（不递归），由工具自动维护
 * - `memory_search` 默认只返回**文件路径列表**，不返回正文 —— 由模型决定读哪一个，
 *   避免旧知识图谱方案「命中即吐出整个实体的全部观察」造成的上下文爆炸
 * - `MEMORY_ROOT` 解析优先级：`$DSH_MEMORY_DIR` > `config.memoryRoot` > `$DSH_HOME/memory`
 *   （`$DSH_HOME` 缺失时回退 `~/.dsh/memory`），代码里不硬编码任何本机绝对路径
 *
 * 不依赖任何外部二进制（只用 `node:fs`），不引入向量检索 / SQLite FTS5。
 *
 * ## 代码分布
 *
 * 依赖方向**单向**：`shared → core → subagent → tools → index`（无循环）。
 *
 * | 目录 | 职责 |
 * | --- | --- |
 * | `shared/` | 纯工具：常量、文本、fs 封装、异步、路径解析与越界防护 |
 * | `core/` | 记忆库逻辑：frontmatter、INDEX、检索、追加去重、写入、写锁、回收站 |
 * | `subagent/` | 三个子代理：`kit`（内部工具）/ `loop`（通用循环）/ `recall` / `remember` / `gc` |
 * | `tools.ts` | 9 个工具的定义与注册（主 agent 的全部入口） |
 * | `index.ts` | 本文件 —— 只保留"插件长什么样"：名字、注入的服务、config、`apply` |
 *
 * 本文件用 `export *` 把各模块的公开面原样透出，所以 `lib/index.js` 的导出清单与拆分前
 * （近 3900 行的单文件）**完全一致**，测试与外部调用方都不必改动。
 *
 * @module @dsh-external/tool-memory
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { MemoryConfig } from './shared/types.js';
export * from './shared/constants.js';
export * from './shared/text.js';
export * from './shared/fsx.js';
export * from './shared/async.js';
export * from './shared/types.js';
export * from './shared/paths.js';
export * from './core/lock.js';
export * from './core/trash.js';
export * from './core/frontmatter.js';
export * from './core/count-cache.js';
export * from './core/index-file.js';
export * from './core/search.js';
export * from './core/append.js';
export * from './core/similar.js';
export * from './core/write.js';
export * from './subagent/kit.js';
export * from './subagent/loop.js';
export * from './subagent/recall.js';
export * from './subagent/remember.js';
export * from './subagent/gc.js';
export * from './tools.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        tools: import('@deepseek-ai/dsh-tools').ToolRuntime;
    }
}
/** Cordis 插件名，供 loader 诊断。 */
export declare const name = "tool-memory";
/** 本插件注入的服务。 */
export declare const inject: string[];
/** 插件配置。`memoryRoot` 留空时走环境变量 / 默认值。 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    memoryRoot: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    memoryRoot: z<string, string, "defined">;
}>>, "plain">;
/** 应用插件：注册 9 个记忆工具（其中 3 个内部驱动子代理）。 */
export declare function apply(ctx: Context, config: MemoryConfig): void;
