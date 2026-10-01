import fs from 'node:fs';
import path from 'node:path';
import { INDEX_FILE } from '../shared/constants.js';
import { MemoryError, describeFsError, readTextOrNull, statOrNull, writeFileAtomic } from '../shared/fsx.js';
import { safeResolve } from '../shared/paths.js';
import { toPosix, today } from '../shared/text.js';
import { dedupeAppend } from './append.js';
import { cachedCounts, shiftCounts } from './count-cache.js';
import { buildText, deriveTags, ensureFrontmatter, firstHeading, parseFrontmatter, } from './frontmatter.js';
import { updateIndexChainLocked } from './index-file.js';
import { withFileLock } from './lock.js';
import { invalidateSearchCache } from './search.js';
import { findSimilarNames } from './similar.js';
import { backupBeforeOverwrite, backupTree } from './trash.js';
/**
 * 写入一个记忆文件。`memory_write` 工具与写入子代理**共用这一份实现**。
 *
 * 调用方负责先 `ensureRoot(root)`。
 *
 * @throws MemoryError 语义错误（文件已存在 / 原文件读不出 / 检测到并发改动）—— 这类错误要原样传出去。
 */
export async function writeMemory(root, raw, content, mode) {
    if (!/\.md$/i.test(raw))
        throw new Error(`path 必须以 .md 结尾: ${raw}`);
    const target = safeResolve(root, raw);
    const rel = toPosix(path.relative(root, target));
    if (rel === '')
        throw new Error('path 不能是记忆库根目录');
    if (path.basename(target).toLowerCase() === INDEX_FILE.toLowerCase()) {
        throw new Error(`INDEX.md 由工具自动维护, 不能直接写入: ${rel}。` +
            '想让某个文件在 INDEX 里显示更好的说明, 请写它 frontmatter 的 summary 字段。');
    }
    const exists = fs.existsSync(target);
    if (exists && fs.statSync(target).isDirectory())
        throw new Error(`目标是目录, 不能写入: ${rel}`);
    if (mode === 'create' && exists) {
        throw new Error(`记忆已存在: ${rel}。改用 mode="append" 追加, 或 mode="replace" 覆盖。`);
    }
    let detail = '';
    let newFileSize = 0;
    // 用 box 而不是裸 let：闭包里的赋值不会被 TS 控制流分析追踪
    const box = { created: false };
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // 共享 MEMORY_ROOT 时"读-改-写"必须串行化, 否则两个进程会互相覆盖(见 withFileLock)
        await withFileLock(target, () => {
            // 锁外看到的 exists 只是快照: 两个进程同时 create 同一个文件时, 双方都看到 false
            // 并一起通过外层检查, 然后依次拿锁写入 —— 后者把前者静默覆盖。所以进锁后必须复查。
            const existsNow = fs.existsSync(target);
            if (!existsNow)
                box.created = true;
            if (mode === 'create' && existsNow) {
                throw new MemoryError(`记忆已存在: ${rel}。改用 mode="append" 追加, 或 mode="replace" 覆盖。`);
            }
            if (mode === 'append' && existsNow) {
                const before = statOrNull(target);
                const oldText = readTextOrNull(target);
                // 读失败绝不能当成"空文件"继续写 —— 那会把原记忆整段抹掉
                if (oldText === null) {
                    throw new MemoryError(`读取原记忆失败, 已中止写入以免覆盖: ${rel}`);
                }
                const oldFm = parseFrontmatter(oldText);
                const addFm = parseFrontmatter(content);
                const dedup = dedupeAppend(oldFm.body, addFm.body);
                const tags = [...oldFm.data.tags];
                for (const t of addFm.data.tags)
                    if (!tags.includes(t))
                        tags.push(t);
                if (tags.length === 0) {
                    const heading = firstHeading(oldFm.body);
                    for (const t of deriveTags(heading !== '' ? heading : path.basename(target))) {
                        if (!tags.includes(t))
                            tags.push(t);
                    }
                }
                const extra = [...oldFm.data.extra];
                for (const line of addFm.data.extra)
                    if (!extra.includes(line))
                        extra.push(line);
                // related 取**并集**：追加方提到的关联不该丢掉原有的
                const related = [...oldFm.data.related];
                for (const r of addFm.data.related)
                    if (!related.includes(r))
                        related.push(r);
                const merged = {
                    present: true,
                    tags,
                    // 没有任何新增时不假装"刚更新过"
                    updated: dedup.added > 0 ? today() : oldFm.data.updated !== '' ? oldFm.data.updated : today(),
                    source: addFm.data.source !== ''
                        ? addFm.data.source
                        : oldFm.data.source !== ''
                            ? oldFm.data.source
                            : '用户告知',
                    summary: oldFm.data.summary !== '' ? oldFm.data.summary : addFm.data.summary,
                    related,
                    // importance: 追加方显式标了就采用, 否则保留原来的（不因为一次追加就把标签抹掉）
                    importance: addFm.data.importance !== '' ? addFm.data.importance : oldFm.data.importance,
                    extra,
                };
                const body = dedup.body === '' ? oldFm.body : `${oldFm.body.replace(/\s+$/, '')}\n\n${dedup.body}`;
                // 乐观并发检查: 锁只能拦住"守规矩"的写入者(其它 DSH 实例), 拦不住编辑器里的手工修改
                const after = statOrNull(target);
                if (before !== null && after !== null && (after.mtimeMs !== before.mtimeMs || after.size !== before.size)) {
                    throw new MemoryError(`检测到 ${rel} 在本次读取后被其他进程改动过, 已中止写入以免覆盖对方的改动; 请重试。`);
                }
                backupBeforeOverwrite(root, target);
                writeFileAtomic(target, buildText(merged, body));
                detail =
                    dedup.added === 0
                        ? ', 内容无变化(要点已存在)'
                        : `, 新增 ${dedup.added} 条, 跳过重复 ${dedup.skipped} 条`;
            }
            else {
                // 只有真正覆盖已有内容时才备份; create 没有旧内容可留
                if (mode === 'replace' && existsNow)
                    backupBeforeOverwrite(root, target);
                // **强制把 updated 设为今天**：写入方（尤其是子代理）是 LLM，它不知道"今天是哪天"，
                // 只能从上下文里猜 —— 实测就写出过差一天的日期。而"这个文件刚刚被写入"是客观事实，
                // updated 就该反映它，不该由写入方凭印象填。
                const seeded = parseFrontmatter(ensureFrontmatter(content, path.basename(target)));
                writeFileAtomic(target, buildText({ ...seeded.data, present: true, updated: today() }, seeded.body));
                if (mode === 'append')
                    detail = ', 原文件不存在, 已新建';
            }
            newFileSize = fs.statSync(target).size;
        });
    }
    catch (error) {
        if (error instanceof MemoryError)
            throw error;
        throw new Error(`写入失败: ${rel} —— ${describeFsError(error)}`);
    }
    // 新增了文件 -> 从它所在目录一路到根每层 +1（增量，不重扫全库）。
    // 必须在 updateIndexChain 之前，并把维护过的表**显式传进去** ——
    // 不传的话它会自己全量重算，"增量"就白做了。
    // 用 Locked 版本：INDEX 是多进程共享的产物，得用共享的锁串行化（见 updateIndexChainLocked）
    if (box.created)
        shiftCounts(root, path.dirname(target), 1);
    const chain = await updateIndexChainLocked(root, path.dirname(target), cachedCounts(root));
    invalidateSearchCache(target);
    return {
        rel,
        detail,
        size: newFileSize,
        chain,
        similar: mode === 'create' ? findSimilarNames(path.dirname(target), path.basename(target)) : [],
    };
}
/**
 * 局部改写一个记忆文件。`memory_patch` 工具与写入/整理子代理**共用这一份实现**。
 *
 * @throws MemoryError 语义错误（文件不存在 / `old` 未找到或出现多次 / 检测到并发改动）。
 */
export async function patchMemory(root, raw, oldText, newText) {
    if (!/\.md$/i.test(raw))
        throw new Error(`path 必须以 .md 结尾: ${raw}`);
    const target = safeResolve(root, raw);
    const rel = toPosix(path.relative(root, target));
    if (rel === '')
        throw new Error('path 不能是记忆库根目录');
    if (path.basename(target).toLowerCase() === INDEX_FILE.toLowerCase()) {
        throw new Error(`INDEX.md 由工具自动维护, 不能直接改写: ${rel}。想让某个文件的说明更好看, 请改它 frontmatter 的 summary。`);
    }
    const needle = oldText.replace(/\r\n/g, '\n');
    if (needle === '')
        throw new Error('old 不能为空');
    const replacement = newText.replace(/\r\n/g, '\n');
    let delta = 0;
    let unchanged = false;
    const before = statOrNull(target);
    try {
        await withFileLock(target, () => {
            const text = readTextOrNull(target);
            if (text === null)
                throw new MemoryError(`记忆不存在: ${rel}。可用 memory_search 查找。`);
            const body = text.replace(/\r\n/g, '\n');
            const first = body.indexOf(needle);
            if (first < 0) {
                throw new MemoryError(`未找到要替换的文本 —— old 必须与文件内容逐字一致(含空白): ${rel}`);
            }
            if (body.indexOf(needle, first + needle.length) >= 0) {
                throw new MemoryError(`要替换的文本在 ${rel} 里出现了多次, 无法确定改哪一处; 请多带一点上下文让它唯一。`);
            }
            const patched = body.slice(0, first) + replacement + body.slice(first + needle.length);
            // 替换前后一模一样 = 新旧文本等价（例如只差被归一掉的换行）。
            // 这时**不要**备份、不要写盘、更不要刷新 updated —— 那会让"刚更新过"变成假信息。
            if (patched === body) {
                unchanged = true;
                return;
            }
            // 走 ensureFrontmatter 而不是直接 buildText({...data}): 外部手写的 .md 可能**没有 frontmatter**,
            // 那样 tags 会是 [] —— 既违反"tags 必填", 也绕过了 deriveTags 的文件名兜底。
            const rebuilt = parseFrontmatter(ensureFrontmatter(patched, path.basename(target)));
            // 与 memory_write 的 append 同款护栏: 锁拦不住编辑器里的手工修改
            const after = statOrNull(target);
            if (before !== null && after !== null && (after.mtimeMs !== before.mtimeMs || after.size !== before.size)) {
                throw new MemoryError(`检测到 ${rel} 在本次读取后被其他进程或编辑器改动过, 已中止改写以免覆盖; 请重试。`);
            }
            backupBeforeOverwrite(root, target);
            writeFileAtomic(target, buildText({ ...rebuilt.data, present: true, updated: today() }, rebuilt.body));
            // 用码点而不是 UTF-16 code unit: 一个 emoji 在 .length 里算 2, 报出来的数字会对不上
            delta = [...replacement].length - [...needle].length;
        });
    }
    catch (error) {
        if (error instanceof MemoryError)
            throw error;
        throw new Error(`改写失败: ${rel} —— ${describeFsError(error)}`);
    }
    // 等价替换：连 INDEX 都不用动（文件没变），直接如实报告
    if (unchanged)
        return { rel, delta, chain: [], unchanged: true };
    const chain = await updateIndexChainLocked(root, path.dirname(target));
    invalidateSearchCache(target);
    return { rel, delta, chain, unchanged: false };
}
/**
 * 删除一个记忆文件或目录。`memory_delete` 工具与两个子代理**共用这一份实现**。
 *
 * 删除前一定会往 `.trash/` 留一份（文件）或整棵树（目录）—— **所以删除是可逆的**，
 * 这正是子代理可以拥有删除权限的前提：误删可以恢复，而返回物会把删了什么、备份在哪讲清楚。
 *
 * @throws Error 语义错误（根目录 / INDEX.md / 目录非空且未 recursive）。
 */
export async function deleteMemory(root, raw, recursive) {
    if (raw === '')
        throw new Error('路径不能为空');
    const target = safeResolve(root, raw);
    const rel = toPosix(path.relative(root, target));
    if (rel === '')
        throw new Error('不能删除记忆库根目录');
    if (!fs.existsSync(target))
        throw new Error(`记忆不存在: ${rel}。可用 memory_search 查找。`);
    if (path.basename(target).toLowerCase() === INDEX_FILE.toLowerCase()) {
        throw new Error(`INDEX.md 由工具自动维护, 不能单独删除: ${rel}`);
    }
    const st = fs.statSync(target);
    let kind = '文件';
    // 用 box 而不是裸 let: 闭包里的赋值不会被 TS 控制流分析追踪, 裸 let 会被收窄成 null
    const box = { backup: null };
    if (st.isDirectory()) {
        kind = '目录';
        const children = fs.readdirSync(target);
        if (children.length > 0 && !recursive) {
            // 不要把隐藏项(如 .git)当"空目录"放过去 —— 那会整目录删掉且不需要 recursive
            const hidden = children.filter((n) => n.startsWith('.')).length;
            const hiddenTip = hidden > 0 ? `(其中 ${hidden} 个是隐藏条目, 例如 .git)` : '';
            throw new Error(`目录非空: ${rel}${hiddenTip}。确认要连同 ${children.length} 个条目一起删除时, 传 recursive=true。`);
        }
        await withFileLock(target, () => {
            backupTree(root, target);
            fs.rmSync(target, { recursive: true, force: true });
        });
    }
    else {
        await withFileLock(target, () => {
            box.backup = backupBeforeOverwrite(root, target);
            fs.unlinkSync(target);
        });
    }
    const parent = path.dirname(target);
    // 先减计数再更新链，并把维护过的表显式传进去（同上）
    shiftCounts(root, parent, -1);
    const chain = fs.existsSync(parent) ? await updateIndexChainLocked(root, parent, cachedCounts(root)) : [];
    invalidateSearchCache();
    return { rel, kind, backup: box.backup, chain };
}
