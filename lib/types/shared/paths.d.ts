import type { MemoryConfig } from './types.js';
/**
 * 记忆库根目录解析与**路径越界防护**。
 *
 * 所有对外接收路径的入口都必须走 `safeResolve` —— 模型给的是字符串，里面可能有 `..`、
 * 绝对路径，或经过符号链接指到库外。这里把"解析 + 校验 + 符号链接复查"收成一处，
 * 免得每个工具各写一遍、漏掉某一种。
 */
/**
 * 解析记忆库根目录，优先级：`$DSH_MEMORY_DIR` > `config.memoryRoot` > `$DSH_HOME/memory`。
 *
 * 不含任何硬编码的本机绝对路径：`$DSH_HOME` 未设置时回退 `~/.dsh/memory`。
 *
 * @param config - 插件行的 config。
 * @returns 绝对路径的记忆库根目录（不保证已存在）。
 */
export declare function resolveRoot(config?: MemoryConfig): string;
/**
 * 把 `raw` 解析到 `root` 之内并校验不越界（拒绝 `..` 穿越、绝对路径越界、符号链接逃逸）。
 *
 * 空路径解析为 `root` 本身（合法，仍在记忆库之内）；是否允许空路径由各工具自行判断。
 *
 * @param root - 记忆库根目录。
 * @param raw - 用户/模型给的路径。
 * @returns 绝对路径。
 * @throws 路径越界时抛出中文错误。
 */
export declare function safeResolve(root: string, raw: string): string;
/**
 * 逐段检查 `target` 相对 `root` 的每一级：只要有一级是符号链接，就解析它的真实路径并复核仍在库内。
 *
 * 必须用 `lstatSync` 而不是 `existsSync` —— 后者会跟随链接，指向**尚不存在目标**的悬空链接
 * 会返回 false，于是被当成"普通新路径"放行，最终写入落到记忆库之外。
 */
export declare function assertNoSymlinkEscape(root: string, target: string, raw: string): void;
