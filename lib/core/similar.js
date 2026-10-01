import fs from 'node:fs';
import path from 'node:path';
import { INDEX_FILE } from '../shared/constants.js';
import { stripMdExt, toPosix } from '../shared/text.js';
import { walkFiles } from './search.js';
/**
 * 文件名相似度：给"疑似同一主题"提供**候选**。
 *
 * 两条判据，满足其一即可：① 字符集 Jaccard ≥ 0.6；② **共同前缀**够长且占短名的比例够大。
 * 第二条是补上来的 —— 纯 Jaccard 对中文长文件名太苛刻：实测
 * `Jaccard("记忆库-旧知识图谱方案已废弃", "记忆库-文件式方案") = 0.353`，
 * 人一眼就看出同族，却落在阈值之下。共同前缀越短越吃亏，而人靠的恰恰是共享前缀。
 *
 * 这里只产出候选：**该不该合并是语义判断，交给整理子代理**（它会读内容再下结论）。
 */
/**
 * 同目录下与新文件名**高度相似**的既有记忆（用于提示"这可能是同一个主题"）。
 *
 * 用字符集的 Jaccard 相似度，零依赖。相似度 ≥ 0.6 视为疑似重复。
 * 这只是**提示**，不阻止写入 —— 判断"该不该合并"需要语义理解，不该由字符串相似度替用户决定。
 */
export function findSimilarNames(dir, baseName) {
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    const targetChars = new Set([...stripMdExt(baseName)]);
    if (targetChars.size === 0)
        return [];
    const out = [];
    for (const name of names) {
        if (name === baseName || !/\.md$/i.test(name))
            continue;
        if (name.toLowerCase() === INDEX_FILE.toLowerCase())
            continue;
        const otherChars = new Set([...stripMdExt(name)]);
        let inter = 0;
        for (const ch of targetChars)
            if (otherChars.has(ch))
                inter += 1;
        const union = targetChars.size + otherChars.size - inter;
        if (union > 0 && inter / union >= 0.6)
            out.push(name);
    }
    return out;
}
/** 判定"同族文件名"的共同前缀下限（按字符计）。 */
export const DUP_PREFIX_MIN = 4;
/** 共同前缀还得占较短那个名字的这个比例，避免极短名字（"A-x" / "A-y"）被误并成一组。 */
export const DUP_PREFIX_RATIO = 0.3;
/** 两个字符串的公共前缀长度（按字符，不按字节）。 */
export function commonPrefixLength(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i])
        i += 1;
    return i;
}
/**
 * 找出**同目录下**彼此高度相似的记忆文件，按"是否已存在同主题"分组。
 *
 * 给整理子代理预先算好、直接喂进 prompt —— **机械的字符串比较归代码，语义判断归子代理**。
 * 实测把这件事交给子代理会漏：它列完目录就停了，不会逐对比文件名，于是
 * "文件名里就写着已废弃"、"3.6KB 只讲一个主题"这类问题全被报成"没有发现问题"。
 *
 * @param root - 记忆库根目录。
 * @param scopeAbs - 检查范围的绝对路径。
 * @param minScore - 字符集 Jaccard 相似度阈值，默认 0.6（与 `findSimilarNames` 一致）。
 * @returns 每个元素是一组互相似的相对路径（已去重、已排序）；无重复时返回空数组。
 */
export async function findDuplicateGroups(root, scopeAbs, minScore = 0.6) {
    const files = await walkFiles(scopeAbs, root);
    // 按目录分组：只在**同目录**内比较（跨目录同名文件通常是不同分类下的不同主题）
    const byDir = new Map();
    for (const f of files) {
        const dir = toPosix(path.dirname(f.rel));
        const list = byDir.get(dir);
        if (list === undefined)
            byDir.set(dir, [f.rel]);
        else
            list.push(f.rel);
    }
    // 并查集：相似是**传递**的（a~b、b~c 就该归成一组），否则同一条链会被拆成好几对
    const parent = new Map();
    const find = (x) => {
        let r = x;
        for (;;) {
            const up = parent.get(r);
            if (up === undefined || up === r)
                break;
            r = up;
        }
        parent.set(x, r);
        return r;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb)
            parent.set(ra, rb);
    };
    const pairs = [];
    for (const rels of byDir.values()) {
        if (rels.length < 2)
            continue;
        for (let i = 0; i < rels.length; i += 1) {
            for (let j = i + 1; j < rels.length; j += 1) {
                const relA = rels[i];
                const relB = rels[j];
                const nameA = stripMdExt(path.basename(relA));
                const nameB = stripMdExt(path.basename(relB));
                // 两条判据，满足其一即算"疑似同族"：
                //   ① 字符集 Jaccard >= minScore
                //   ② **共同前缀**够长、且占较短名字的比例够大
                // 纯 Jaccard 对中文长文件名太苛刻：实测
                //   Jaccard("记忆库-旧知识图谱方案已废弃", "记忆库-文件式方案") = 0.353
                //   Jaccard("Motrix-MCP配置与RPC密钥", "Motrix-安装与任务状态") = 0.381
                // 两对都明显同族，却都落在 0.6 阈值之下（共同前缀越短越吃亏）。而人一眼就看出的
                // 恰恰是"共享前缀"这件事，所以把它单列成一条判据。
                const sa = new Set([...nameA]);
                const sb = new Set([...nameB]);
                let inter = 0;
                for (const ch of sa)
                    if (sb.has(ch))
                        inter += 1;
                const unionSize = sa.size + sb.size - inter;
                const jaccardHit = unionSize > 0 && inter / unionSize >= minScore;
                const prefix = commonPrefixLength(nameA, nameB);
                const prefixHit = prefix >= DUP_PREFIX_MIN && prefix >= Math.min(nameA.length, nameB.length) * DUP_PREFIX_RATIO;
                if (!jaccardHit && !prefixHit)
                    continue;
                pairs.push([relA, relB]);
                parent.set(relA, relA);
                parent.set(relB, relB);
                union(relA, relB);
            }
        }
    }
    if (pairs.length === 0)
        return [];
    const groups = new Map();
    for (const [a, b] of pairs) {
        for (const p of [a, b]) {
            const r = find(p);
            const list = groups.get(r);
            if (list === undefined)
                groups.set(r, [p]);
            else if (!list.includes(p))
                list.push(p);
        }
    }
    return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort());
}
