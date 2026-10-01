/**
 * 9 个工具的定义与注册 —— 主 agent 面向记忆库的全部入口。
 *
 * 分三档，档位是**成本**而不是重要性：
 * - 默认入口：`memory_recall`（白板子代理代跑检索，把 4~8 轮挡在主上下文之外），
 *   以及写入侧的 `memory_remember` 与体检用的 `memory_gc` —— 这三个内部驱动子代理。
 * - 精确操作：`memory_search` / `memory_read`（自己核对候选与读正文时用）。
 * - 明确改写：`memory_write` / `memory_patch` / `memory_delete` / `memory_reindex`。
 *
 * 每个工具自己解析根目录并调 `ensureRoot`（而不是在注册时算一次）——
 * `MEMORY_ROOT` 由环境变量 / config 决定，跟着进程走；每次调用重算是为了不把"注册那一刻的
 * 快照"固化进闭包。工具描述写得长是**故意的**：模型只能看到工具描述，
 * 用法要点写在描述里比写在文档里有效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { refreshCounts } from './core/count-cache.js';
import { ensureRoot, indexIsStale, reindexTree, updateIndexChainLocked } from './core/index-file.js';
import { clampLimit, searchFiles, sinceSkipNote, splitQueryTerms, suggestTags } from './core/search.js';
import { findDuplicateGroups } from './core/similar.js';
import { trashStats } from './core/trash.js';
import { deleteMemory, patchMemory, writeMemory } from './core/write.js';
import { INDEX_FILE, TOP_LEVEL_DIRS } from './shared/constants.js';
import { readTextOrNull } from './shared/fsx.js';
import { resolveRoot, safeResolve } from './shared/paths.js';
import { formatSize, padCol, toPosix, today } from './shared/text.js';
import { GC_MAX_TOKENS, GC_MAX_TURNS, GC_TOTAL_TIMEOUT_MS, buildGcReport, executeGcTool, gcSystemPrompt, gcTools } from './subagent/gc.js';
import { runSubagentLoop as loop } from './subagent/loop.js';
import { RECALL_DEFAULT_FILES, RECALL_MAX_FILES, RECALL_MAX_TOKENS, RECALL_MAX_TURNS, RECALL_SYSTEM_PROMPT, RECALL_TOOLS, RECALL_TOTAL_TIMEOUT_MS, buildRecallReport, executeRecallTool, runDeterministicRecall } from './subagent/recall.js';
import { REMEMBER_MAX_TOKENS, REMEMBER_MAX_TURNS, REMEMBER_SYSTEM_PROMPT, REMEMBER_TOOLS, REMEMBER_TOTAL_TIMEOUT_MS, buildRememberReport, executeRememberTool } from './subagent/remember.js';
export const MEMORY_GUIDE = [
    '记忆库 = 本机真实文件夹里的 Markdown 文件: 一个文件一个主题(建议 3~8 条要点),',
    '文件名里必须含将来会被搜到的关键词; 每层目录一个 INDEX.md, 只列本层直接子项。',
    '顶层分类固定为: 技能 / 电脑操作 / 环境 / 工具 / API / 项目 / 用户偏好。',
].join('\n');
/**
 * 注册 9 个记忆工具（其中 3 个内部驱动子代理）。
 *
 * 这里**不**建根目录：每个工具在真正要动文件之前自己 `ensureRoot`。
 * 只有一个工具被调用时才建目录，比"插件加载即建目录"更不打扰用户。
 */
export function registerTools(ctx, config) {
    const rootOf = () => resolveRoot(config);
    // ── 7.3.1 memory_search ────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'memory_search',
        description: [
            '⚠️ **一般情况下不要直接用它** —— 探索性检索优先 `memory_recall`（白板子代理替你跑，把 4~8 轮检索挡在主上下文之外）。',
            '只有这几种情况才直接调用: ① 你要**自己核对候选列表**(确认某条记忆到底存不存在);',
            '② recall 返回的节选不够精确, 你想自己挑文件再读; ③ 已经知道确切关键词, 想一步拿到命中列表。',
            '',
            '在记忆库中搜索。默认返回**文件路径 + 命中类型 + 大小 + 日期 + 一句话说明**(不返回正文), 由你决定读哪一个。',
            MEMORY_GUIDE,
            '检索协议(成本从低到高, 命中即停): ① memory_read 逐层读 INDEX.md 导航;',
            '② memory_search 搜文件名+tags+正文(本工具); ③ 用 grep / Everything 之类工具直接搜记忆库目录;',
            '④ 最后才 memory_read 读命中的那个文件 —— 不要整目录读。',
            '命中范围: 文件名(相对 scope 的路径) + tags + 正文; updated/source 等元数据不计。',
            '不传 query 可当"列目录"用(配 scope): 如 query="" + scope="技能" 列出该分类下全部记忆。',
            '排序默认按相关度(文件名 > 标签 > 正文命中数 > 新鲜度), 从不拿文件体积当权重;',
            'sort="updated" 切成纯时间视图, since="YYYY-MM-DD" 只看某日之后的。',
            '⚠️ 匹配是纯子串, 没有同义词扩展: 搜"网络请求分析"不会命中"抓包"。找同义概念请换词,',
            '或在写入记忆时把同义关键词一并塞进 tags / 文件名。',
            '多词组合按分隔符(空格/斜杠/竖线/逗号)自动拆开 OR: "chrome 抓包" = chrome 或 抓包,',
            '整串精确命中仍优先。长中文串(如"网络请求分析")不做拆分 —— 那是语义判断, 交给 memory_recall 的子代理;',
            '0 命中时会列出库里已有的相关 tags 作为跳板。',
        ].join('\n'),
        parameters: {
            query: { type: 'string', description: '关键词(大小写不敏感子串, 中文任意长度都支持); regex=true 时是正则源码; 传空串 = 列目录(不按关键词过滤)' },
            scope: { type: 'string', description: '限定子目录(相对记忆库根), 例如 "技能/浏览器"' },
            content: { type: 'boolean', description: '是否同时搜正文与 tags; 默认 true。false 只搜文件名(更快)' },
            regex: { type: 'boolean', description: '把 query 当正则表达式处理(默认 false, 大小写不敏感)。例: "抓包|发包"、"断点.*调试"' },
            sort: { type: 'string', enum: ['relevance', 'updated'], description: 'relevance(默认, 相关度优先) / updated(纯按日期倒序, 用于"看看上周记了什么")' },
            since: { type: 'string', description: '只返回 updated >= since 的记忆, 格式 YYYY-MM-DD, 例 "2026-09-20"' },
            limit: { type: 'number', description: '最多返回条数, 默认 30, 上限 200' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            const root = rootOf();
            ensureRoot(root);
            const query = String(args.query ?? '').trim();
            const scopeRaw = String(args.scope ?? '').trim();
            const scopeAbs = scopeRaw === '' ? root : safeResolve(root, scopeRaw);
            if (!fs.existsSync(scopeAbs)) {
                throw new Error(`目录不存在: ${scopeRaw}。可用 memory_read({ path: "" }) 读根 INDEX.md 看有哪些分类。`);
            }
            if (!fs.statSync(scopeAbs).isDirectory())
                throw new Error(`scope 必须是目录: ${scopeRaw}`);
            const withBody = args.content !== false;
            const useRegex = args.regex === true;
            const sort = args.sort === 'updated' ? 'updated' : 'relevance';
            const since = String(args.since ?? '').trim();
            if (since !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
                throw new Error(`since 需要 YYYY-MM-DD 格式, 收到: "${since}"`);
            }
            const limit = clampLimit(args.limit);
            // stats 是出参: 函数会把"被 since 挡掉多少条"写回来(见 sinceSkipNote 的说明)
            const stats = {};
            const all = await searchFiles(root, scopeAbs, query, {
                searchBody: withBody,
                regex: useRegex,
                sort,
                since,
                stats,
            });
            const hits = all.slice(0, limit);
            const scopeLabel = scopeRaw === '' ? '/' : toPosix(path.relative(root, scopeAbs));
            const cond = [
                `限定 ${scopeLabel}`,
                query === '' ? '列目录' : withBody ? '含正文' : '仅文件名',
                query !== '' && useRegex ? '正则' : '',
                // 多词/长中文串的 query 会被自动拆开 OR, 结果里说明一下, 免得用户以为匹配变宽是 bug
                query !== '' && !useRegex && splitQueryTerms(query).length > 0
                    ? `已拆词(${splitQueryTerms(query).join(' / ')})`
                    : '',
                sort === 'updated' ? '按日期' : '',
                since !== '' ? `since ${since}` : '',
            ]
                .filter((s) => s !== '')
                .join(', ');
            const head = `记忆库: ${root}`;
            if (all.length === 0) {
                const lines = [
                    head,
                    query === ''
                        ? `该范围内没有记忆${since !== '' ? ` (since ${since})` : ''}(${cond})。`
                        : `未找到匹配 "${query}" 的文件(${cond})。`,
                ];
                // 0 命中时把库里**实际用过的**相关标签摆出来 —— 比让模型盲猜第二个关键词有用
                if (query !== '' && !useRegex) {
                    const tags = await suggestTags(root, scopeAbs, query);
                    if (tags.length > 0)
                        lines.push(`库里已有的相关标签(按字符重叠): ${tags.join(' / ')}`);
                }
                lines.push('提示: 检索是纯子串匹配、没有同义词扩展 —— 换个说法, 或直接用上面列出的标签再搜一次;', '也可以先 memory_read({ path: "" }) 读根 INDEX.md 看有哪些分类。');
                const skipped = sinceSkipNote(stats);
                if (skipped !== '')
                    lines.splice(2, 0, skipped);
                return lines.join('\n');
            }
            const rows = hits.map((h) => {
                const match = h.nameHit
                    ? '文件名命中'
                    : h.tagHits > 0 && h.bodyHits > 0
                        ? `标签×${h.tagHits} 正文×${h.bodyHits}`
                        : h.tagHits > 0
                            ? `标签命中 ×${h.tagHits}`
                            : `正文命中 ×${h.bodyHits}`;
                // 用 padCol 而不是 padTo: 文件名超过 48 列时 padTo 会原样返回,
                // 于是它和右邻的"命中类型"列粘在一起, 分不出列。
                const row = `  ${padCol(h.rel, 48)}${padCol(match, 18)}${padCol(formatSize(h.size), 10)}${h.updated !== '' ? h.updated : '—'}`;
                // 说明单独一行: 它才是"读哪一个"的主要依据, 但塞进表格会把行撑得太宽
                return h.desc !== '' ? `${row}\n      ${h.desc}` : row;
            });
            const title = all.length > hits.length
                ? `${query === '' ? '列出' : '命中'} ${all.length} 个文件, 已显示前 ${hits.length} 个(提高 limit 或收窄 scope 可看全部)`
                : `${query === '' ? '列出' : '找到'} ${all.length} 个文件`;
            return [
                head,
                `${title}(${cond}):`,
                ...(sinceSkipNote(stats) !== '' ? [sinceSkipNote(stats)] : []),
                ...rows,
                '提示: 用 memory_read({ path }) 读取命中的文件; path 传目录则返回该层 INDEX.md。',
            ].join('\n');
        },
    }));
    // ── 7.3.2 memory_read ──────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'memory_read',
        description: [
            '⚠️ **不要用它自己拼检索流程** —— 需要找东西时优先 `memory_recall`, 它会顺手把该读的文件读回来。',
            '直接读的典型场景: ① recall 已给出路径, 你要看全文; ② 传空串读根 INDEX.md, 了解分类结构。',
            '',
            '读取记忆。传文件返回其内容; 传目录返回该层 INDEX.md(逐层下钻入口)。',
            MEMORY_GUIDE,
            '逐层下钻时 path 传目录(如 "技能/浏览器"); 读具体记忆时传文件(如 "技能/浏览器/chrome-devtools-抓包.md")。',
        ].join('\n'),
        parameters: {
            path: { type: 'string', required: true, description: '相对记忆库根的路径(空串 = 根目录); 也可传记忆库内的绝对路径' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            const root = rootOf();
            ensureRoot(root);
            const raw = String(args.path ?? '').trim();
            const target = raw === '' ? root : safeResolve(root, raw);
            if (!fs.existsSync(target)) {
                throw new Error(`记忆不存在: ${raw}。可用 memory_search 查找。`);
            }
            if (fs.statSync(target).isDirectory()) {
                const idx = path.join(target, INDEX_FILE);
                // INDEX 缺失, 或与实际内容不一致(外部新建/删除文件造成的漂移) -> 重建这层并向上更新整条链
                if (indexIsStale(root, target))
                    await updateIndexChainLocked(root, target);
                const text = readTextOrNull(idx);
                if (text === null)
                    throw new Error(`读取失败: ${raw}`);
                return text;
            }
            const text = readTextOrNull(target);
            if (text === null)
                throw new Error(`读取失败: ${raw}`);
            return text;
        },
    }));
    // ── 7.3.3 memory_write ─────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'memory_write',
        description: [
            '写入一条记忆。自动建目录、自动更新 INDEX 链、append 模式自动去重。',
            MEMORY_GUIDE,
            '文件格式: frontmatter 必填 tags / updated / source, 可选 summary(一句话说明, 用于上级 INDEX 的说明列);',
            'source 取值: 实测 / 官方文档 / 用户告知 / 推断。正文用中文。',
            '存 API 记忆时用格式 `中文名  作用  英文名(需要传入的参数)`, 路径放 API/<类名>.md,',
            'tags 里带上 API差异 / 新版本API / 小版本差异 等关键词。',
            '不要用本工具写 INDEX.md —— 它由工具自动维护; 想改某文件在 INDEX 里的说明, 请写该文件 frontmatter 的 summary。',
        ].join('\n'),
        parameters: {
            path: { type: 'string', required: true, description: '相对记忆库根的路径, 必须以 .md 结尾' },
            content: { type: 'string', required: true, description: 'frontmatter + 正文(缺 frontmatter 会自动补全)' },
            mode: {
                type: 'string',
                enum: ['create', 'append', 'replace'],
                description: 'create(默认, 已存在则报错) / append(去重追加) / replace(整文件覆盖)',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
            const root = rootOf();
            ensureRoot(root);
            const raw = String(args.path ?? '').trim();
            const mode = args.mode ?? 'create';
            const r = await writeMemory(root, raw, String(args.content ?? ''), mode);
            const lines = [
                `已写入: ${r.rel} (mode=${mode}${r.detail}, ${formatSize(r.size)})`,
                `已更新 INDEX: ${r.chain.join(', ')}`,
            ];
            // 同目录已有高度相似的文件名 -> 提示可能是同一主题(只提示, 不阻止: 该不该合并需要语义判断)
            if (r.similar.length > 0) {
                lines.push(`⚠️ 同目录下已有相似文件名: ${r.similar.join(' / ')} —— 可能是同一个主题。` +
                    '若确认重复, 建议先用 memory_read 对比内容, 合并后把多余的那个用 memory_delete 去掉。');
            }
            const topLevel = r.rel.includes('/') ? r.rel.slice(0, r.rel.indexOf('/')) : '';
            if (topLevel !== '' && !TOP_LEVEL_DIRS.includes(topLevel)) {
                lines.push(`提示: 顶层分类「${topLevel}」不在标准词表中(${TOP_LEVEL_DIRS.join(' / ')}); 如确需新分类请先与用户确认。`);
            }
            if (mode === 'create') {
                lines.push('提示: 以后要记新东西优先用 memory_remember —— 它会先查重, 避免同一主题堆出多个文件。');
            }
            return lines.join('\n');
        },
    }));
    // ── 7.3.4 memory_delete ────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'memory_delete',
        description: [
            '删除记忆文件或空目录, 并同步更新 INDEX 链。',
            '保护: 不能删除记忆库根目录本身; 不能单独删除 INDEX.md(由工具维护)。',
            '删除非空目录必须显式传 recursive=true。',
            '删除前会把原文件备份到 <记忆库根>/.trash/ (以 . 开头, 不进 INDEX 也不进搜索), 相当于回收站。',
        ].join('\n'),
        parameters: {
            path: { type: 'string', required: true, description: '相对记忆库根的路径(文件或目录)' },
            recursive: { type: 'boolean', description: '递归删除非空目录, 默认 false' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
            const root = rootOf();
            ensureRoot(root);
            const r = await deleteMemory(root, String(args.path ?? '').trim(), args.recursive === true);
            return [
                `已删除${r.kind}: ${r.rel}`,
                `已更新 INDEX: ${r.chain.length > 0 ? r.chain.join(', ') : '(无)'}`,
                r.backup !== null ? `原内容已备份到 ${r.backup}（需要时可从这里恢复）` : '原内容已整目录备份到 .trash/',
            ].join('\n');
        },
    }));
    // ── 7.3.3b memory_patch ────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'memory_patch',
        description: [
            '局部改写一条记忆: 把文件里**唯一出现**的一段文本替换成新文本。',
            MEMORY_GUIDE,
            '改错别字 / 更新某个数值 / 替换一句话用这个 —— 比"read 全文 + replace 全文"省上下文, 也不容易误伤别处。',
            'old 必须与文件内容逐字一致(含空白), 且在文件里恰好出现一次:',
            '  出现 0 次 -> 报"未找到"; 出现多次 -> 报"不唯一", 请多带一点上下文让它唯一。',
            '改完保留原有 tags / summary / source, 并把 updated 刷新为今天。',
            '覆盖前原文件会备份到 <记忆库根>/.trash/ (以 . 开头, 不进 INDEX 也不进搜索)。',
        ].join('\n'),
        parameters: {
            path: { type: 'string', required: true, description: '相对记忆库根的 .md 路径' },
            old: { type: 'string', required: true, description: '要被替换的原文本, 必须与文件逐字一致且只出现一次' },
            new: { type: 'string', required: true, description: '替换后的文本; 传空串表示删掉这段' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
            const root = rootOf();
            ensureRoot(root);
            const r = await patchMemory(root, String(args.path ?? '').trim(), String(args.old ?? ''), String(args.new ?? ''));
            // 等价替换要如实说明: 以前这种情况也会刷新 updated, 让"刚更新过"变成假信息
            if (r.unchanged) {
                return `内容未变化: ${r.rel} —— 新旧文本等价, 已跳过写入(没刷新 updated, 也没做备份)。`;
            }
            return [
                `已改写: ${r.rel} (${r.delta >= 0 ? '+' : ''}${r.delta} 字符, 原内容备份在 .trash/)`,
                `已更新 INDEX: ${r.chain.join(', ')}`,
            ].join('\n');
        },
    }));
    // ── 7.3.5 memory_reindex ───────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'memory_reindex',
        description: [
            '从实际文件系统重建 INDEX.md, 用于修复外部增删(手工建文件、git 切换、外部编辑器)造成的索引不一致。',
            '重建时保留每个 INDEX.md 顶部的 `> 说明:` 行。',
        ].join('\n'),
        parameters: {
            scope: { type: 'string', description: '限定子目录(相对记忆库根), 默认全库' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
            const root = rootOf();
            ensureRoot(root);
            const scopeRaw = String(args.scope ?? '').trim();
            const scopeAbs = scopeRaw === '' ? root : safeResolve(root, scopeRaw);
            if (!fs.existsSync(scopeAbs))
                throw new Error(`目录不存在: ${scopeRaw}`);
            if (!fs.statSync(scopeAbs).isDirectory())
                throw new Error(`scope 必须是目录: ${scopeRaw}`);
            // 重建 INDEX 是"重新认识整个库"的时机, 顺手全量刷新计数缓存
            const counts = refreshCounts(root);
            const layers = reindexTree(root, scopeAbs, counts);
            if (scopeAbs !== root)
                await updateIndexChainLocked(root, path.dirname(scopeAbs), counts);
            const trash = trashStats(root);
            const trashTip = trash.files > 0
                ? `\n.trash/ 现有 ${trash.files} 份备份, 共 ${formatSize(trash.bytes)} —— 只增不删, 确认不需要后可手动清空。`
                : '';
            return `已重建 ${layers} 层 INDEX.md(范围: ${scopeRaw === '' ? '/' : toPosix(path.relative(root, scopeAbs))})。${trashTip}`;
        },
    }));
    // ── 7.4 三个子代理共用的执行器 ──────────────────────────────────────────────
    // 循环本体在 `subagent/loop.ts` —— 那里只能用参数拿到 ctx，所以这里把 ctx 绑进去，
    // 三个调用点的写法保持不变。
    /** 把 ctx 绑进通用子代理循环。 */
    const runSubagentLoop = (opts, log, execute) => loop(ctx, opts, log, execute);
    // ── 7.4.1 memory_recall ────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'memory_recall',
        description: [
            '用**白板子代理**做一次记忆检索, 返回它实际读过的文件原文(节选后)。',
            MEMORY_GUIDE,
            '⚠️ **探索性检索优先用这个**, 不要自己 memory_read(INDEX) → memory_search → memory_read 走 4~8 轮:',
            '主 agent 每一步请求都要重发全部工具定义(本机约 50K token); 子代理是白板, 只挂 2 个工具、几百 token。',
            '子代理在插件内部跑(最多 6 轮 / 45 秒), 主上下文只增加它读到的内容, 不承担检索过程。',
            '返回物 = **操作日志 + 按日志取回的原文**, 不是子代理的总结 —— 内容不会被润色或漏掉。',
            '命中过多时只返回前 N 个(默认 5)并列出其余路径; 要更精确的候选列表再用 memory_search。',
            '已知道精确关键词、只想核对候选时, 直接用 memory_search 更省事(少一层延迟)。',
            '子代理不可用(没模型/调用失败)时会自动回退到确定性检索, 并在结果前明确标注。',
        ].join('\n'),
        parameters: {
            intent: { type: 'string', required: true, description: '自然语言检索意图, 例 "找抓包相关的做法"' },
            scope: { type: 'string', description: '限定子目录(相对记忆库根), 如 "技能/浏览器"; 缩小范围能明显提高命中质量' },
            maxFiles: {
                type: 'number',
                description: `最多返回几个文件的原文, 默认 ${RECALL_DEFAULT_FILES}, 上限 ${RECALL_MAX_FILES}`,
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        // 只读 + 自带总超时, 可以并发
        isConcurrencySafe: () => true,
        async execute(args) {
            const root = rootOf();
            ensureRoot(root);
            const intent = String(args.intent ?? '').trim();
            if (intent === '')
                throw new Error('intent 不能为空');
            const scopeRaw = String(args.scope ?? '').trim();
            const scopeAbs = scopeRaw === '' ? root : safeResolve(root, scopeRaw);
            if (!fs.existsSync(scopeAbs)) {
                throw new Error(`目录不存在: ${scopeRaw}。可用 memory_read({ path: "" }) 读根 INDEX.md 看分类。`);
            }
            if (!fs.statSync(scopeAbs).isDirectory())
                throw new Error(`scope 必须是目录: ${scopeRaw}`);
            const maxFiles = Math.max(1, Math.min(RECALL_MAX_FILES, Math.floor(args.maxFiles ?? RECALL_DEFAULT_FILES)));
            const log = { reads: [], searches: [], notes: [], turns: 0, elapsedMs: 0, stopReason: 'done' };
            const prompt = scopeRaw === '' ? intent : `${intent}\n（限定在目录: ${scopeRaw}）`;
            await runSubagentLoop({
                system: RECALL_SYSTEM_PROMPT,
                prompt,
                tools: RECALL_TOOLS,
                maxTurns: RECALL_MAX_TURNS,
                maxTokens: RECALL_MAX_TOKENS,
                timeoutMs: RECALL_TOTAL_TIMEOUT_MS,
            }, log, (call, l) => executeRecallTool(root, call, l));
            // 只有"一个字都没读到 + 服务不可用/调用失败"才降级;
            // 撞上限或超时属于半成功, 照常返回日志里已读到的内容。
            if (log.reads.length === 0 && (log.stopReason === 'unavailable' || log.stopReason === 'error')) {
                const fallback = await runDeterministicRecall(root, scopeAbs, intent);
                return [
                    `⚠️ 检索子代理不可用（${log.error ?? log.stopReason}）, 已回退到确定性检索。`,
                    '结果可能不如子代理精确; 需要精确结果请用 memory_search 手动检索。',
                    '',
                    fallback,
                ].join('\n');
            }
            return buildRecallReport(root, log, maxFiles);
        },
    }));
    // ── 7.5.1 memory_remember ──────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'memory_remember',
        description: [
            '把一段内容**交给写入子代理**存进记忆库: 它先查重(避免在同一个主题上堆出多个文件), 再决定 create / append / patch。',
            MEMORY_GUIDE,
            '⚠️ **要记东西就用这个**, 不要自己 memory_write —— 手写会跳过查重, 结果是同一主题反复新建文件。',
            '子代理自己判断分类与文件名、补 frontmatter、把同义关键词写进 tags; 返回物是**客观的操作记录 + 写入后盘上的实际内容**,',
            '不是它的总结。它**没有删除权限**, 发现已有同主题内容时会明确报告"已存在"而不是重复写。单次约 10~30 秒。',
        ].join('\n'),
        parameters: {
            content: {
                type: 'string',
                required: true,
                description: '要记住的内容(自然语言即可: 一段结论、一条用户偏好、一次实测结果)',
            },
            topic: { type: 'string', description: '主题提示(可选), 如 "chrome-devtools 抓包"; 不传则由子代理从内容判断' },
            scope: { type: 'string', description: '限定顶层分类(可选), 如 "技能"; 不传则由子代理判断' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        // 会写文件, 不能并发
        isConcurrencySafe: () => false,
        async execute(args) {
            const root = rootOf();
            ensureRoot(root);
            const content = String(args.content ?? '').trim();
            if (content === '')
                throw new Error('content 不能为空');
            const topic = String(args.topic ?? '').trim();
            const scopeRaw = String(args.scope ?? '').trim();
            if (scopeRaw !== '') {
                const scopeAbs = safeResolve(root, scopeRaw);
                if (!fs.existsSync(scopeAbs) || !fs.statSync(scopeAbs).isDirectory()) {
                    throw new Error(`分类目录不存在: ${scopeRaw}。可用 memory_read({ path: "" }) 看根 INDEX.md。`);
                }
            }
            const log = {
                searches: [],
                reads: [],
                writes: [],
                deletes: [],
                notes: [],
                turns: 0,
                elapsedMs: 0,
                stopReason: 'done',
            };
            const prompt = [
                `今天是 ${today()}。`,
                '',
                '把下面这段内容记进记忆库:',
                '',
                content,
                topic !== '' ? `\n主题提示: ${topic}` : '',
                scopeRaw !== '' ? `限定分类: ${scopeRaw}` : '',
            ]
                .filter((s) => s !== '')
                .join('\n');
            await runSubagentLoop({
                system: REMEMBER_SYSTEM_PROMPT,
                prompt,
                tools: REMEMBER_TOOLS,
                maxTurns: REMEMBER_MAX_TURNS,
                maxTokens: REMEMBER_MAX_TOKENS,
                timeoutMs: REMEMBER_TOTAL_TIMEOUT_MS,
            }, log, (call, l) => executeRememberTool(root, call, l));
            // 写入没发生 + 服务不可用 => 必须报错。静默失败在这里最危险: 用户以为记住了。
            if (log.writes.length === 0 && (log.stopReason === 'unavailable' || log.stopReason === 'error')) {
                throw new Error(`写入子代理不可用(${log.error ?? log.stopReason})，没有写入任何内容。请改用 memory_write 手动写入。`);
            }
            return buildRememberReport(root, log);
        },
    }));
    // ── 7.6.1 memory_gc ────────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'memory_gc',
        description: [
            '给记忆库做**体检**（由整理子代理跑）: 找同主题多文件、可能过时的内容、缺失的 frontmatter、命名不规范等。',
            MEMORY_GUIDE,
            '默认**只读** —— 只报告问题，不改任何文件。加 `apply: true` 才允许动手: 重建 INDEX、补 frontmatter、',
            '以及**合并明显重复的文件**（把要点并进去后删掉多余的那个，删除有 .trash/ 备份、可恢复）。',
            '返回物会把**删了什么、为什么删、备份在哪**全部列出来 —— 合并是语义判断，合错了可以直接从备份恢复。单次约 20~60 秒。',
        ].join('\n'),
        parameters: {
            scope: { type: 'string', description: '限定范围(相对记忆库根的目录); 省略 = 全库' },
            apply: {
                type: 'boolean',
                description: '是否执行低风险修复(重建 INDEX / 补 frontmatter), 默认 false 只报告',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        // apply=true 时会改文件
        isConcurrencySafe: (args) => args.apply !== true,
        async execute(args) {
            const root = rootOf();
            ensureRoot(root);
            const apply = args.apply === true;
            const scopeRaw = String(args.scope ?? '').trim();
            if (scopeRaw !== '') {
                const scopeAbs = safeResolve(root, scopeRaw);
                if (!fs.existsSync(scopeAbs) || !fs.statSync(scopeAbs).isDirectory()) {
                    throw new Error(`目录不存在: ${scopeRaw}`);
                }
            }
            const log = {
                lists: [],
                searches: [],
                reads: [],
                findings: [],
                fixes: [],
                deletes: [],
                turns: 0,
                elapsedMs: 0,
                stopReason: 'done',
            };
            // **机械的字符串比较在插件里做完，再喂给子代理**。实测让子代理自己"看文件名找相似"
            // 会漏报: 它列完目录就停了。这里先把同目录下高度相似的组算出来, 它只负责读内容判断语义。
            const dupGroups = await findDuplicateGroups(root, scopeRaw === '' ? root : safeResolve(root, scopeRaw));
            const prompt = [
                `今天是 ${today()}。`,
                `体检范围: ${scopeRaw === '' ? '全库' : scopeRaw}`,
                apply ? '本次允许执行低风险修复（重建 INDEX / 补 frontmatter / 合并重复）。' : '本次只读，不要修改任何文件。',
                ...(dupGroups.length > 0
                    ? [
                        '',
                        `⚠️ 插件已预先算好 ${dupGroups.length} 组**疑似重复**（同目录、文件名高度相似）。`,
                        '这是你最该重点看的东西：逐组 memory_read 对比内容，然后报告 kind:"conflict"：',
                        ...dupGroups.map((g, i) => `  ${i + 1}. ${g.join('   |   ')}`),
                        '（读完若发现内容其实不重叠，也要报告说明"看着像但不是重复"——这同样是结论。）',
                    ]
                    : ['', '插件预先算过：没有发现同目录下文件名高度相似的文件组。']),
            ].join('\n');
            await runSubagentLoop({
                system: gcSystemPrompt(apply),
                prompt,
                tools: gcTools(apply),
                maxTurns: GC_MAX_TURNS,
                maxTokens: GC_MAX_TOKENS,
                timeoutMs: GC_TOTAL_TIMEOUT_MS,
            }, log, (call, l) => executeGcTool(root, call, l, apply));
            if (log.findings.length === 0 && log.fixes.length === 0 && (log.stopReason === 'unavailable' || log.stopReason === 'error')) {
                throw new Error(`整理子代理不可用(${log.error ?? log.stopReason})。`);
            }
            return buildGcReport(log, apply);
        },
    }));
}
