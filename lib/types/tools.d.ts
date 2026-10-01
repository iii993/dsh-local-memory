import { Context } from '@deepseek-ai/cordis';
import type { MemoryConfig } from './shared/types.js';
export declare const MEMORY_GUIDE: string;
/**
 * 注册 9 个记忆工具（其中 3 个内部驱动子代理）。
 *
 * 这里**不**建根目录：每个工具在真正要动文件之前自己 `ensureRoot`。
 * 只有一个工具被调用时才建目录，比"插件加载即建目录"更不打扰用户。
 */
export declare function registerTools(ctx: Context, config: MemoryConfig): void;
