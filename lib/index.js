import z from '@deepseek-ai/schemastery';
import { registerTools } from './tools.js';
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
/** Cordis 插件名，供 loader 诊断。 */
export const name = 'tool-memory';
/** 本插件注入的服务。 */
export const inject = ['tools'];
/** 插件配置。`memoryRoot` 留空时走环境变量 / 默认值。 */
export const Config = z.object({
    memoryRoot: z.string().default(''),
});
/** 应用插件：注册 9 个记忆工具（其中 3 个内部驱动子代理）。 */
export function apply(ctx, config) {
    registerTools(ctx, config);
}
