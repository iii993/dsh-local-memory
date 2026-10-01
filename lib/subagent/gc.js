import fs from 'node:fs';
import { SUBAGENT_MAX_CONTEXT_BYTES } from '../shared/constants.js';
import { describeFsError } from '../shared/fsx.js';
import { safeResolve } from '../shared/paths.js';
import { formatSize } from '../shared/text.js';
import { reindexTree } from '../core/index-file.js';
import { walkFiles } from '../core/search.js';
import { deleteMemory, patchMemory } from '../core/write.js';
import { subagentRead, subagentSearch } from './kit.js';
/**
 * 整理子代理：找同主题多文件、过时内容、缺失 frontmatter、命名不规范。
 *
 * 默认**只读**；`apply: true` 才给写工具，而且执行器里还有第二道拦截（不只靠"不给工具"）。
 * 另外：**同目录下的相似文件名由插件预先算好**（`findDuplicateGroups`）塞进提示词 ——
 * 机械的字符串比较归代码，语义判断归子代理。实测把这件事全交给子代理会漏：它列完目录就停了。
 */
export const GC_MAX_TURNS = 10;
export const GC_MAX_TOKENS = 3000;
export const GC_TOTAL_TIMEOUT_MS = 90_000;
export const GC_MAX_FINDINGS = 20;
/**
 * 整理子代理的工具白名单。
 *
 * `memory_patch` 与 `memory_delete` 只在 `apply` 时给出 —— 只读体检不该拥有改写能力（`executeGcTool`
 * 里还有第二道拦截，不只靠"不给工具"）。早先这里写着"任何情况下都没有 memory_delete"，是过时的。
 * `apply: true` 时会给，且删除必须带 `reason`、一定先备份到 `.trash/`、备份路径会进报告。
 */
export function gcTools(apply) {
    const tools = [
        {
            name: 'memory_read',
            description: '传目录(或空串)返回该层 INDEX.md; 传文件返回内容',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string', description: '相对记忆库根的路径; 空串 = 根目录' } },
                required: ['path'],
            },
        },
        {
            name: 'memory_search',
            description: '搜记忆库; **query 传空串 = 列出该目录下的全部文件**(配 scope 用), 用来盘点',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '关键词; 空串 = 列目录' },
                    scope: { type: 'string', description: '限定子目录, 如 "技能/浏览器"' },
                },
                required: ['query'],
            },
        },
        {
            name: 'memory_reindex',
            description: '从文件系统重建 INDEX.md(修复索引漂移; 安全操作)',
            parameters: {
                type: 'object',
                properties: { scope: { type: 'string', description: '限定范围(相对记忆库根的目录), 省略 = 全库' } },
            },
        },
    ];
    if (apply) {
        tools.push({
            name: 'memory_patch',
            description: '局部改写: 把文件里唯一出现的 old 换成 new(用于补 frontmatter 缺失字段)',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '相对记忆库根的 .md 路径' },
                    old: { type: 'string', description: '要被替换的原文, 必须逐字一致且只出现一次' },
                    new: { type: 'string', description: '替换后的文本' },
                },
                required: ['path', 'old', 'new'],
            },
        });
        tools.push({
            name: 'memory_delete',
            description: '删除一个记忆文件(自动备份到 .trash/, 可恢复)。**合并掉多余文件时才用; reason 必填**',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '相对记忆库根的 .md 路径' },
                    reason: { type: 'string', description: '为什么删: 例如"要点已并入 技能/x.md"' },
                },
                required: ['path', 'reason'],
            },
        });
    }
    tools.push({
        name: 'memory_report',
        description: '报告一个发现(问题清单就是靠它汇总的), 只写进返回物',
        parameters: {
            type: 'object',
            properties: {
                kind: { type: 'string', description: 'conflict(同主题多文件) / stale(过时) / missing(该有但没有) / note(其它)' },
                note: { type: 'string', description: '一句话说明, 并给出你的建议' },
                paths: { type: 'array', items: { type: 'string' }, description: '涉及的文件路径' },
            },
            required: ['kind', 'note'],
        },
    });
    return tools;
}
/** 整理子代理的系统提示词。**必须短**（每轮都要重发）。 */
export function gcSystemPrompt(apply) {
    return [
        '你是记忆库整理子代理。工具见 schema。',
        '',
        '任务：给记忆库做一次体检，把问题**报告**出来（memory_report）。',
        '',
        '按顺序做：',
        '1. memory_read("") 读根 INDEX.md，再逐层 memory_read 各分类，了解结构。',
        '2. 用 memory_search({query:"", scope:"技能"}) 这类调用列出各分类下的文件清单。',
        '3. 找这几类问题，**每发现一处就 memory_report 一条**：',
        '   - kind:"conflict" —— **同一主题被写成了多个文件**（文件名高度相似、或内容重叠）。',
        '     必须在 note 里说明它们各自讲了什么、你建议保留哪个。这是最重要的一类。',
        '   - kind:"stale" —— 内容明显过时（写着"待验证"/"TODO"，或日期很久远且与现状冲突）。',
        '   - kind:"missing" —— 该有但没有（缺 tags/summary/related、某分类下文件很多却没有说明）。',
        '   - kind:"note" —— 其它（命名不规范、单个文件要点远超 8 条、顶层分类不在词表里）。',
        '     也要提 **related 悬空**：`related:` 里引用了不存在的文件（路径写错，或目标已被删）。',
        '- **聚焦你被要求的范围**：`scope` 之外的目录，只在你顺带发现严重问题时用一行附注提一下，',
        '  不要把别处的问题算作本次体检查出的项。',
        '4. ' +
            (apply
                ? '处理**明显重复**的文件（这是你最有价值的动作）：① 挑一个**保留**的，把另一个独有的要点用 ' +
                    'memory_write(mode:"append") 并进去；② 确认合并结果没问题后，用 memory_delete 删掉被并入的那个，' +
                    'reason 写"要点已并入 X"。③ **内容不重叠的不要删** —— 那可能是不同主题而不是重复；拿不准就只报告，不合并。'
                : '**本次是只读体检**：不要写入、不要修改、不要删除，只报告。'),
        '5. 另外：索引漂移用 memory_reindex 修；frontmatter 缺字段（缺 tags/updated/source/summary）用 memory_patch 补。',
        '',
        `最多 ${GC_MAX_TURNS} 轮工具调用。报告完就停，结束时不要写总结，只回复"完成"。`,
    ].join('\n');
}
/** 执行整理子代理请求的一个工具调用。 */
export async function executeGcTool(root, call, log, apply) {
    let args;
    try {
        args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
    }
    catch {
        return { text: `工具参数不是合法 JSON: ${call.arguments.slice(0, 200)}`, isError: true };
    }
    if (call.name === 'memory_search') {
        const query = String(args.query ?? '');
        // 「空 query + scope」是盘点用法：把这次列目录记进日志，返回物据此说明"查了哪些范围"
        if (query.trim() === '') {
            const scopeRaw = String(args.scope ?? '').trim();
            let scopeAbs = root;
            try {
                scopeAbs = scopeRaw === '' ? root : safeResolve(root, scopeRaw);
            }
            catch (error) {
                return { text: `scope 不合法: ${describeFsError(error)}`, isError: true };
            }
            if (!fs.existsSync(scopeAbs) || !fs.statSync(scopeAbs).isDirectory()) {
                return { text: `目录不存在: ${scopeRaw}`, isError: true };
            }
            const files = await walkFiles(scopeAbs, root);
            log.lists.push({ scope: scopeRaw === '' ? '/' : scopeRaw, count: files.length });
            if (files.length === 0)
                return { text: `(${scopeRaw === '' ? '/' : scopeRaw}) 下没有记忆文件。`, isError: false };
            const shown = files.slice(0, 60);
            const lines = shown.map((f) => `  ${f.rel}`);
            if (files.length > shown.length)
                lines.push(`  ...还有 ${files.length - shown.length} 个`);
            return { text: `${scopeRaw === '' ? '/' : scopeRaw} 下 ${files.length} 个文件:\n${lines.join('\n')}`, isError: false };
        }
    }
    if (call.name === 'memory_search') {
        return subagentSearch(root, args, (query, hits) => {
            log.searches.push({ query, hits });
        });
    }
    if (call.name === 'memory_read') {
        return subagentRead(root, args, (rel) => {
            log.reads.push({ path: rel });
        }, true);
    }
    if (call.name === 'memory_reindex') {
        const scopeRaw = String(args.scope ?? '').trim();
        try {
            const scopeAbs = scopeRaw === '' ? root : safeResolve(root, scopeRaw);
            if (!fs.existsSync(scopeAbs))
                return { text: `目录不存在: ${scopeRaw}`, isError: true };
            const layers = reindexTree(root, scopeAbs);
            const label = scopeRaw === '' ? '/' : scopeRaw;
            log.fixes.push({ kind: 'reindex', detail: `${label} 重建 ${layers} 层 INDEX.md` });
            return { text: `已重建 ${layers} 层 INDEX.md(${label})。`, isError: false };
        }
        catch (error) {
            return { text: `重建失败: ${describeFsError(error)}`, isError: true };
        }
    }
    if (call.name === 'memory_patch') {
        if (!apply) {
            return { text: '本次是只读体检(apply=false), 不允许改写。请把问题写进 memory_report。', isError: true };
        }
        const raw = String(args.path ?? '').trim();
        const oldText = String(args.old ?? '');
        if (raw === '' || oldText === '')
            return { text: 'path 与 old 都不能为空', isError: true };
        try {
            const r = await patchMemory(root, raw, oldText, String(args.new ?? ''));
            const sign = r.delta >= 0 ? '+' : '';
            log.fixes.push({ kind: 'patch', detail: `${r.rel} 改写 ${sign}${r.delta} 字符` });
            return { text: `已改写 ${r.rel}。`, isError: false };
        }
        catch (error) {
            return { text: `改写被拒: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
    }
    if (call.name === 'memory_delete') {
        if (!apply) {
            return { text: '本次是只读体检(apply=false), 不允许删除。请把重复情况写进 memory_report。', isError: true };
        }
        const raw = String(args.path ?? '').trim();
        const reason = String(args.reason ?? '').trim();
        if (raw === '')
            return { text: 'path 不能为空', isError: true };
        if (reason === '') {
            return { text: 'reason 不能为空 —— 删除必须说明理由, 它会写进返回物给主 agent 看。', isError: true };
        }
        try {
            const r = await deleteMemory(root, raw, false);
            log.deletes.push({ path: r.rel, reason, backup: r.backup });
            const tip = r.backup !== null ? `（备份在 ${r.backup}，可恢复）` : '';
            return { text: `已删除 ${r.rel}${tip}。`, isError: false };
        }
        catch (error) {
            return { text: `删除被拒: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
    }
    if (call.name === 'memory_report') {
        const kind = String(args.kind ?? '').trim();
        const note = String(args.note ?? '').trim();
        if (kind === '' || note === '')
            return { text: 'kind 与 note 都不能为空', isError: true };
        if (log.findings.length >= GC_MAX_FINDINGS) {
            return { text: `发现条数已达上限 ${GC_MAX_FINDINGS}, 不再记录。请直接结束。`, isError: false };
        }
        log.findings.push({
            kind,
            note,
            paths: Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : [],
        });
        return { text: '已记进返回物。', isError: false };
    }
    return { text: `没有这个工具: ${call.name}。`, isError: true };
}
/** 把整理子代理的操作日志变成返回物。 */
export function buildGcReport(log, apply) {
    const elapsedNote = Number.isFinite(log.elapsedMs) ? ` / 耗时 ${(log.elapsedMs / 1000).toFixed(1)}s` : '';
    const stopNote = log.stopReason === 'budget'
        ? `（到达 ${GC_MAX_TURNS} 轮上限提前结束）`
        : log.stopReason === 'context'
            ? `（工具返回内容累计超过 ${formatSize(SUBAGENT_MAX_CONTEXT_BYTES)}，提前结束）`
            : log.stopReason === 'timeout'
                ? `（总超时 ${GC_TOTAL_TIMEOUT_MS / 1000}s 提前结束）`
                : '';
    const head = [
        `记忆库体检结果（子代理执行 ${log.turns} 轮${elapsedNote}${apply ? ' / 已允许低风险修复' : ' / 只读'}）${stopNote}`,
    ];
    if (log.lists.length > 0) {
        head.push('', '盘点的范围:');
        for (const l of log.lists)
            head.push(`  ${l.scope} → ${l.count} 个文件`);
    }
    if (log.findings.length === 0) {
        head.push('', '✅ 没有发现问题。');
    }
    else {
        // 按 kind 分组，让"同主题多文件"这类最要紧的问题一眼可见
        const order = ['conflict', 'stale', 'missing', 'note'];
        const kinds = [...new Set(log.findings.map((f) => f.kind))];
        kinds.sort((a, b) => {
            const ia = order.indexOf(a);
            const ib = order.indexOf(b);
            return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
        });
        head.push('', `发现 ${log.findings.length} 项问题:`);
        for (const kind of kinds) {
            const group = log.findings.filter((f) => f.kind === kind);
            const label = kind === 'conflict'
                ? '同主题多文件（建议合并 —— 需要你自己判断）'
                : kind === 'stale'
                    ? '可能过时'
                    : kind === 'missing'
                        ? '该有但没有'
                        : '其它';
            head.push('', `  [${kind}] ${label}:`);
            for (const f of group) {
                head.push(`    · ${f.note}`);
                if (f.paths.length > 0)
                    head.push(`      涉及: ${f.paths.join(' / ')}`);
            }
        }
    }
    if (log.fixes.length > 0 || log.deletes.length > 0) {
        if (log.fixes.length > 0) {
            head.push('', '已执行的修复:');
            for (const f of log.fixes)
                head.push(`  · [${f.kind}] ${f.detail}`);
        }
        if (log.deletes.length > 0) {
            head.push('', `🗑️ 合并后删除了 ${log.deletes.length} 个文件（都有 .trash/ 备份，可恢复）:`);
            for (const d of log.deletes) {
                head.push(`  · ${d.path}`);
                head.push(`      理由: ${d.reason}`);
                if (d.backup !== null)
                    head.push(`      备份: ${d.backup}`);
            }
            head.push('', '⚠️ 合并是**语义判断**。如果上面哪一条合错了，用 memory_read 确认后从备份恢复。');
        }
    }
    else if (apply) {
        head.push('', '没有执行任何修复（子代理没做，或认为不需要）。');
    }
    else {
        head.push('', '本次只读。要执行低风险修复（重建 INDEX / 补 frontmatter）请用 apply: true 重跑。');
        head.push('**合并或删除文件不会自动执行** —— 请根据上面的清单用 memory_patch / memory_write / memory_delete 自己决定。');
    }
    if (log.error !== undefined)
        head.push('', `（终止原因: ${log.error}）`);
    return head.join('\n');
}
