import fsp from 'node:fs/promises';
import path from 'node:path';
import { INDEX_FILE, IO_CONCURRENCY, MAX_HITS_PER_FILE } from '../shared/constants.js';
import { mapLimit } from '../shared/async.js';
import { countOccurrences, toPosix } from '../shared/text.js';
import { firstHeading, parseFrontmatter } from './frontmatter.js';
/**
 * 正文缓存：键为绝对路径，用 `mtime + size` 判失效；Map 的插入顺序当 LRU，超限就丢最旧的。
 *
 * 记忆库预期数百个文件、单个几 KB，全放内存也就几 MB；换来的是**重复搜索几乎不碰磁盘**。
 * 写工具落盘后会主动失效对应条目（见 {@link invalidateSearchCache}），所以不存在"改了还搜到旧内容"。
 */
export const contentCache = new Map();
export const CACHE_LIMIT = 2000;
/** 失效搜索缓存：传路径只失效该文件，不传则清空（删除目录后用）。 */
export function invalidateSearchCache(abs) {
    if (abs === undefined)
        contentCache.clear();
    else
        contentCache.delete(abs);
}
export function cacheGet(abs, f) {
    const hit = contentCache.get(abs);
    if (hit === undefined)
        return null;
    if (hit.mtimeMs !== f.mtime || hit.size !== f.size) {
        contentCache.delete(abs);
        return null;
    }
    // 命中后重新插入, 维持 LRU 顺序
    contentCache.delete(abs);
    contentCache.set(abs, hit);
    return hit;
}
export function cacheSet(abs, entry) {
    contentCache.set(abs, entry);
    if (contentCache.size > CACHE_LIMIT) {
        const oldest = contentCache.keys().next().value;
        if (oldest !== undefined)
            contentCache.delete(oldest);
    }
}
/** 读取一个文件的正文与前三个 frontmatter 字段（命中缓存则零 I/O）。 */
export async function loadContent(f) {
    const cached = cacheGet(f.abs, f);
    if (cached !== null)
        return cached;
    let raw;
    try {
        raw = await fsp.readFile(f.abs, 'utf8');
    }
    catch {
        contentCache.delete(f.abs);
        return null;
    }
    const { data, body } = parseFrontmatter(raw);
    const entry = {
        mtimeMs: f.mtime,
        size: f.size,
        body,
        tags: data.tags.join('\n'),
        tagList: data.tags,
        updated: data.updated,
        desc: data.summary !== '' ? data.summary : firstHeading(body),
    };
    cacheSet(f.abs, entry);
    return entry;
}
/**
 * 把一句查询按**分隔符**拆成可 OR 的词。
 *
 * 只做这一种拆分，因为它是**无歧义的**：`"chrome 抓包"`、`"cookie/session"`、`"抓包|发包"`
 * 都是"我想同时找这几个词"的常见写法，而按整串做子串匹配必然 0 命中。
 *
 * **刻意不做**把长中文串切成 2-gram。那是**语义判断**（"网络请求分析"该切成哪些词），
 * 字符串切分做不好：切出来的 `络请`、`求分` 是噪音，还会让召回变宽、稀释精度。
 * 长意图的拆词交给子代理（它有语义理解），见 {@link RECALL_SYSTEM_PROMPT}。
 *
 * 返回空数组表示这个 query 不需要拆。
 */
export function splitQueryTerms(query) {
    const bySeparator = query
        .split(/[\s,，、;；|/\\]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);
    return bySeparator.length > 1 ? bySeparator : [];
}
/**
 * 构造匹配器。正则只编译一次（**不是每个文件编译一次**），并对零宽匹配做了防死循环处理。
 *
 * @param query - 关键词或正则源码。
 * @param regex - 是否按正则处理。
 * @throws 正则语法无效时抛出中文错误。
 */
export function createSearchMatcher(query, regex) {
    if (!regex) {
        const needle = query.toLowerCase();
        const terms = splitQueryTerms(query);
        if (terms.length === 0) {
            return {
                regex: false,
                terms: [query],
                split: false,
                test: (text) => text.toLowerCase().includes(needle),
                exact: (text) => text.toLowerCase().includes(needle),
                count: (text) => countOccurrences(text, query),
            };
        }
        const lowerTerms = terms.map((t) => t.toLowerCase());
        return {
            regex: false,
            terms,
            split: true,
            exact: (text) => text.toLowerCase().includes(needle),
            // 整串精确命中永远优先; 只有精确不中才回落到"任一词命中"
            test: (text) => {
                const lower = text.toLowerCase();
                if (lower.includes(needle))
                    return true;
                return lowerTerms.some((t) => lower.includes(t));
            },
            count: (text) => {
                const exact = countOccurrences(text, query);
                if (exact > 0)
                    return exact;
                return terms.reduce((sum, t) => sum + countOccurrences(text, t), 0);
            },
        };
    }
    let re;
    try {
        re = new RegExp(query, 'gi');
    }
    catch (error) {
        throw new Error(`正则表达式无效: ${query} —— ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
        regex: true,
        terms: [query],
        split: false,
        test(text) {
            re.lastIndex = 0;
            return re.test(text);
        },
        exact(text) {
            re.lastIndex = 0;
            return re.test(text);
        },
        count(text) {
            re.lastIndex = 0;
            let n = 0;
            while (n < MAX_HITS_PER_FILE) {
                const m = re.exec(text);
                if (m === null)
                    break;
                n += 1;
                // 零宽匹配(如 `^`、`a*`)不会推进 lastIndex, 必须自己让步, 否则死循环
                if (m.index === re.lastIndex)
                    re.lastIndex += 1;
            }
            return n;
        },
    };
}
/** 递归收集记忆文件的绝对路径（排除 `INDEX.md`、隐藏项与非 `.md`）。 */
async function collectMdPaths(dir, out) {
    let items;
    try {
        items = await fsp.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    const subdirs = [];
    for (const item of items) {
        if (item.name.startsWith('.'))
            continue;
        const abs = path.join(dir, item.name);
        if (item.isDirectory()) {
            subdirs.push(abs);
            continue;
        }
        if (!item.isFile())
            continue;
        if (!/\.md$/i.test(item.name))
            continue;
        if (item.name.toLowerCase() === INDEX_FILE.toLowerCase())
            continue;
        out.push(abs);
    }
    await Promise.all(subdirs.map((sub) => collectMdPaths(sub, out)));
}
/**
 * §7.4 递归列出记忆文件（排除 `INDEX.md` 与隐藏项）。
 *
 * 目录树并发展开、`stat` 限流并发发起 —— 实测比同步串行明显快（20 个文件的 stat 从约 3.2ms 降到约 0.5ms）。
 */
export async function walkFiles(dir, root) {
    const paths = [];
    await collectMdPaths(dir, paths);
    const entries = await mapLimit(paths, IO_CONCURRENCY, async (abs) => {
        try {
            const st = await fsp.stat(abs);
            return { abs, rel: toPosix(path.relative(root, abs)), size: st.size, mtime: st.mtimeMs };
        }
        catch {
            return null;
        }
    });
    return entries.filter((e) => e !== null);
}
/**
 * §7.3.1 搜索：文件名命中优先，其次标签命中，再正文命中数，最后 `updated` 降序。
 *
 * **从不拿文件体积当权重** —— 大文件不代表更相关，只代表读起来更贵；体积只在输出里展示。
 *
 * 文件遍历与读取都走限流并发 + 正文缓存，匹配器只构造一次（不是每个文件一次）。
 *
 * @param root - 记忆库根目录。
 * @param scopeAbs - 限定目录（绝对路径）。
 * @param query - 关键词；`regex` 为真时是正则源码；**传空串表示列目录**（不按关键词过滤）。
 * @param options - 见 {@link SearchOptions}。
 */
export async function searchFiles(root, scopeAbs, query, options = {}) {
    const searchBody = options.searchBody !== false;
    const sort = options.sort ?? 'relevance';
    const since = options.since ?? '';
    const matcher = query === '' ? null : createSearchMatcher(query, options.regex === true);
    const files = await walkFiles(scopeAbs, root);
    const contents = await mapLimit(files, IO_CONCURRENCY, (f) => loadContent(f));
    const hits = [];
    // 名称匹配只看**相对 scope** 的路径：否则 scope 到 "技能/浏览器" 后搜 "技能" 会命中该目录下全部文件。
    // `f.rel` 已经相对 root 且必然以 scopePrefix 开头，所以直接切片 —— 在循环里对每个文件调
    // `path.relative` 要贵得多（1000 个文件实测差出约 90 ms）。
    const scopePrefix = toPosix(path.relative(root, scopeAbs));
    const cut = scopePrefix === '' ? 0 : scopePrefix.length + 1;
    files.forEach((f, index) => {
        const content = contents[index];
        if (content === null)
            return;
        // 时间过滤：ISO 日期串的字典序就是时间序。
        // 挡掉的原因要分别记账 —— "没有日期"和"日期太早"是完全不同的问题。
        if (since !== '') {
            if (content.updated === '') {
                if (options.stats !== undefined)
                    options.stats.missingDate = (options.stats.missingDate ?? 0) + 1;
                return;
            }
            if (content.updated < since) {
                if (options.stats !== undefined)
                    options.stats.olderThanSince = (options.stats.olderThanSince ?? 0) + 1;
                return;
            }
        }
        const nameHit = matcher !== null && matcher.test(cut === 0 ? f.rel : f.rel.slice(cut));
        // tags 参与命中(规则文档要求用标签关键词检索), 但不含 updated/source 等元数据
        const tagHits = matcher !== null && searchBody ? matcher.count(content.tags) : 0;
        const bodyHits = matcher !== null && searchBody ? matcher.count(content.body) : 0;
        if (matcher !== null && !nameHit && tagHits === 0 && bodyHits === 0)
            return;
        const nameCandidate = cut === 0 ? f.rel : f.rel.slice(cut);
        const exactHit = matcher !== null &&
            (matcher.exact(nameCandidate) || (searchBody && (matcher.exact(content.tags) || matcher.exact(content.body))));
        hits.push({
            rel: f.rel,
            nameHit,
            tagHits,
            bodyHits,
            exactHit,
            size: f.size,
            updated: content.updated,
            desc: content.desc,
        });
    });
    if (sort === 'updated') {
        // 纯时间视图: "看看上周记了什么"
        hits.sort((a, b) => {
            if (a.updated !== b.updated)
                return a.updated < b.updated ? 1 : -1;
            return a.rel.localeCompare(b.rel, 'zh-Hans-CN');
        });
    }
    else {
        hits.sort((a, b) => {
            if (a.nameHit !== b.nameHit)
                return a.nameHit ? -1 : 1;
            if (a.tagHits !== b.tagHits)
                return b.tagHits - a.tagHits;
            // 精确命中优先于 OR 计数: 否则搜 "alpha beta" 时, 分别出现两词的文件会盖过真正连写的那个
            if (a.exactHit !== b.exactHit)
                return a.exactHit ? -1 : 1;
            if (a.bodyHits !== b.bodyHits)
                return b.bodyHits - a.bodyHits;
            if (a.updated !== b.updated)
                return a.updated < b.updated ? 1 : -1;
            return a.rel.localeCompare(b.rel, 'zh-Hans-CN');
        });
    }
    return hits;
}
/**
 * 0 命中时给模型一个跳板：从库里已有的 `tags` 里挑出与 query **字符重叠最多**的几个。
 *
 * 纯字符串打分，零依赖。它不解决"没有同义词扩展"这个根本限制，但能把
 * **库里实际用的说法**直接摆到模型面前 —— 比让它盲猜第二个关键词有用得多。
 */
export async function suggestTags(root, scopeAbs, query, limit = 8) {
    const queryChars = new Set([...query.toLowerCase()].filter((ch) => /[\w\u4e00-\u9fa5]/.test(ch)));
    if (queryChars.size === 0)
        return [];
    const needle = query.toLowerCase();
    // 英文按"词"匹配: 字母级的字符重叠对英文太宽松(搜 cookie 会把含 n/o/e 的 Node 也算上)
    const asciiWords = needle.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
    const pureAscii = /^[\x20-\x7e]+$/.test(query);
    const files = await walkFiles(scopeAbs, root);
    const contents = await mapLimit(files, IO_CONCURRENCY, (f) => loadContent(f));
    const scored = new Map();
    for (const content of contents) {
        if (content === null)
            continue;
        for (const tag of content.tagList) {
            const lower = tag.toLowerCase();
            let score;
            if (lower.includes(needle)) {
                // 标签直接包含整个 query —— 这正是模型该拿去重搜的词
                score = 1000;
            }
            else {
                const tagChars = new Set([...lower]);
                let inter = 0;
                for (const ch of tagChars)
                    if (queryChars.has(ch))
                        inter += 1;
                const charScore = tagChars.size === 0 ? 0 : inter / tagChars.size;
                const wordScore = asciiWords.length > 0 && asciiWords.some((w) => lower.includes(w)) ? 0.9 : 0;
                // 纯英文 query 只看词, 不看字符 —— 否则任何含相同字母的短标签都会挤进来
                score = pureAscii ? wordScore : Math.max(charScore, wordScore);
            }
            if (score <= 0)
                continue;
            const prev = scored.get(tag) ?? 0;
            if (score > prev)
                scored.set(tag, score);
        }
    }
    return [...scored.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
        .slice(0, limit)
        .map(([tag]) => tag);
}
export function clampLimit(v) {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 30;
    if (n < 1)
        return 1;
    if (n > 200)
        return 200;
    return n;
}
/**
 * 把 `since` 挡掉的条数写成一句提示。
 *
 * 为什么必须专门说：**缺少 `updated` 的文件本来能搜到，一加 `since` 就静默消失了**。
 * 被排除这件事必须让人看见 —— 否则用户只会觉得"库里没有"，而不会想到是日期缺失。
 */
export function sinceSkipNote(stats) {
    const miss = stats.missingDate ?? 0;
    const old = stats.olderThanSince ?? 0;
    if (miss === 0 && old === 0)
        return '';
    const bits = [];
    if (miss > 0)
        bits.push(`${miss} 个缺少 updated 字段、无法参与时间筛选`);
    if (old > 0)
        bits.push(`${old} 个日期早于 since`);
    return `⚠️ 另有 ${bits.join('；')}，已从结果中排除。`;
}
