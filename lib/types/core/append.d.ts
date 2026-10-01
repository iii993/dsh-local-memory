/**
 * `mode: "append"` 的**按要点去重**：把新增内容拆成"要点单元"，与既有正文逐单元比较，
 * 只追加没出现过的。
 *
 * 为什么按"要点单元"而不是按行：一条要点常常写成多行（续行、子列表）。按行比对会把
 * 同一件事的不同排版当成两条，越追加越臃肿；按单元比对才符合"一个文件 = 一个主题，
 * 3~8 条要点"的写法。
 */
/** 去重追加结果。 */
export interface AppendResult {
    body: string;
    added: number;
    skipped: number;
}
/**
 * §7.4 按"要点"去重后追加。
 *
 * 去重单位不是"行"而是**单元**：代码块整块、标题单行、列表项单条、表格行单条、段落整段。
 * 因为按行去重会误伤 —— 旧文件里出现过 `import fs from 'node:fs'`，就会把新代码块里的同一行删掉；
 * 去重 key 还带上所属小节，避免 `## A / - 无` 与 `## B / - 无` 被误判成同一条。
 *
 * @param oldBody - 原正文。
 * @param addBody - 待追加正文。
 */
export declare function dedupeAppend(oldBody: string, addBody: string): AppendResult;
/** 一个去重单元：代码块 / 标题 / 列表项 / 表格行 / 段落。 */
export interface AppendUnit {
    lines: string[];
    /** 完整去重 key（只有 `scoped` 的单元才带小节归属）。 */
    key: string;
    /** 忽略小节归属的 key，用于"append 内容没写小节标题"时的全文查重。 */
    anyKey: string;
    /** 该单元所属小节（`''` 表示它出现在任何标题之前）。 */
    section: string;
    /** 是否带小节归属 —— 标题本身不带，因为它就是小节的开始。 */
    scoped: boolean;
}
/** 造一个去重单元。 */
export declare function makeUnit(lines: string[], kind: string, section: string, text: string, scoped?: boolean): AppendUnit;
/** 列表符号归一化, 让 `* x` 与 `- x` 视为同一条要点。 */
export declare function normalizePoint(text: string): string;
/** 把一个单元的正文切成去重单元。 */
export declare function splitAppendUnits(body: string): AppendUnit[];
