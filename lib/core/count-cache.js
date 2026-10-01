import fs from 'node:fs';
import path from 'node:path';
import { INDEX_FILE } from '../shared/constants.js';
/**
 * 目录条目数：一次遍历算出每个目录的**递归**记忆文件数，并缓存起来由写入方增量维护。
 *
 * 关键约定：**"读不到"不是"是空的"**。`listSubdirs` / `listMdFiles` 读失败返回 `null`，
 * `countMdFiles` / `buildCountIndex` 返回 `-1` —— 因为一次瞬时 I/O 失败（杀软扫描、
 * 文件被占用）如果被当成"这个目录空了"，渲染出来的 INDEX 会被无条件落盘，把条目永久擦掉。
 */
/**
 * 目录下直接子目录（排除隐藏），按中文排序。
 *
 * **读失败返回 `null`，而不是空数组** —— 这两件事必须分清：`[]` 是"这层确实没有子目录"，
 * `null` 是"我没读到"。杀软实时扫描、文件被占用、权限抖动都会让 `readdirSync` 瞬时失败；
 * 若在这里返回 `[]`，`renderIndex` 会把"读不到"渲染成"这层什么都没有"，再被
 * `rebuildIndex` 无条件落盘 —— 一次瞬时故障就永久擦掉 INDEX 里的条目（已实测复现）。
 */
export function listSubdirs(dir) {
    let items;
    try {
        items = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return null;
    }
    return items
        .filter((i) => i.isDirectory() && !i.name.startsWith('.'))
        .map((i) => i.name)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}
/** 目录下直接的记忆文件（排除 `INDEX.md`）。**读失败返回 `null`**，理由见 {@link listSubdirs}。 */
export function listMdFiles(dir) {
    let items;
    try {
        items = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return null;
    }
    return items
        .filter((i) => i.isFile() && !i.name.startsWith('.') && /\.md$/i.test(i.name) && i.name.toLowerCase() !== INDEX_FILE.toLowerCase())
        .map((i) => i.name)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}
/**
 * 递归统计目录下的记忆文件数（不含 `INDEX.md`）。
 *
 * **读失败返回 -1**，不是 0 —— 调用方必须区分"没读到"和"是空的"（见 {@link listSubdirs}）。
 */
export function countMdFiles(dir) {
    const files = listMdFiles(dir);
    const subs = listSubdirs(dir);
    if (files === null || subs === null)
        return -1;
    let n = files.length;
    for (const sub of subs) {
        const c = countMdFiles(path.join(dir, sub));
        if (c < 0)
            return -1;
        n += c;
    }
    return n;
}
/**
 * 一次遍历算出**每个目录**的递归记忆文件数。
 *
 * `renderIndex` 需要每个子目录的递归条目数。若对每个子目录各递归一次（`countMdFiles`），
 * 渲染根 INDEX 就是 O(子目录数 × 子树规模)；`updateIndexChain` 又要逐层渲染，
 * 于是**写一条记忆**退化成 O(深度 × 库规模) 的 readdir。这里自底向上一次算完，整条链复用同一张表。
 *
 * @param root - 记忆库根目录。
 * @returns 目录绝对路径 → 该目录下递归的记忆文件数。**读不到的目录记为 -1**（不是 0：
 *   0 是"这层是空的"，-1 是"没读到"，渲染方要能区分，见 {@link listSubdirs}）。
 */
export function buildCountIndex(root) {
    const counts = new Map();
    const visit = (dir) => {
        let items;
        try {
            items = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            counts.set(dir, -1);
            return -1;
        }
        let direct = 0;
        let total = 0;
        for (const item of items) {
            if (item.name.startsWith('.'))
                continue;
            if (item.isDirectory()) {
                const sub = visit(path.join(dir, item.name));
                // 子层读不到 -> 本层计数也不可信，一并标 -1（否则本层会报出一个偏小的数）
                if (sub < 0) {
                    counts.set(dir, -1);
                    return -1;
                }
                total += sub;
                continue;
            }
            if (!item.isFile())
                continue;
            if (!/\.md$/i.test(item.name))
                continue;
            if (item.name.toLowerCase() === INDEX_FILE.toLowerCase())
                continue;
            direct += 1;
        }
        total += direct;
        counts.set(dir, total);
        return total;
    };
    visit(root);
    return counts;
}
/**
 * 每个记忆库根的**递归计数缓存**（目录绝对路径 → 递归文件数）。
 *
 * 存在的理由：`updateIndexChain` 需要每个目录的**递归**条目数，而算它必须遍历整棵树 ——
 * 于是"写一条记忆"的代价退化成 O(库规模)（实测 2000 文件约 11ms，占一次写入的 ~8%）。
 * 但写入路径其实**知道到底变了多少**（新增一个文件 = 从它所在目录一路到根每层 +1），
 * 所以这里缓存计数，由写入方增量维护，读的时候 O(深度)。
 *
 * **为什么不用"目录 mtime 没变就复用"**：父目录的 mtime **不反映子树变化**。
 * 在 `A/B/` 下新建文件只会改 `B` 的 mtime，`A` 的纹丝不动 —— 按 mtime 命中缓存会让
 * `visit(A)` 直接复用旧 total，**漏掉整棵子树的变化**。失效信号必须来自写入方，
 * 不能来自文件系统这种间接证据。
 *
 * 外部改动（编辑器里手工增删）不归这里管：`memory_read` 检测到 INDEX 漂移时会调
 * `rebuildIndex` 全量重算并刷新这张表。
 */
export const countCache = new Map();
/** 取计数表：有缓存用缓存，没有就全量算一次并缓存。 */
export function cachedCounts(root) {
    const hit = countCache.get(root);
    if (hit !== undefined)
        return hit;
    const fresh = buildCountIndex(root);
    countCache.set(root, fresh);
    return fresh;
}
/** 清空计数缓存。测试用；生产路径上"库被外部大改"由 `memory_reindex` → `refreshCounts` 兜住。 */
export function clearCountCache() {
    countCache.clear();
}
/** 全量重算并覆盖缓存（`memory_reindex` 用）。 */
export function refreshCounts(root) {
    const fresh = buildCountIndex(root);
    countCache.set(root, fresh);
    return fresh;
}
/**
 * 沿目录链把递归计数整体偏移 `delta`（新增文件 +1，删除 -1）。
 *
 * 只动**从 startDir 到 root 这条链**，其余目录的计数不变 —— 这正是增量维护的全部内容。
 */
export function shiftCounts(root, startDir, delta) {
    const cache = countCache.get(root);
    // 还没建过表就什么都不用做：下次取表时会全量算，那时已经包含了本次变化
    if (cache === undefined)
        return;
    let dir = startDir;
    for (;;) {
        const cur = cache.get(dir);
        if (cur !== undefined)
            cache.set(dir, Math.max(0, cur + delta));
        if (dir === root)
            break;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
}
