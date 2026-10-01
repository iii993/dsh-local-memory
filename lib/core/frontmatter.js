import { FM } from '../shared/constants.js';
import { today } from '../shared/text.js';
export function emptyFrontmatter() {
    return { present: false, tags: [], updated: '', source: '', summary: '', related: [], importance: '', extra: [] };
}
export function unquote(v) {
    if (v.length >= 2) {
        const a = v[0];
        const b = v[v.length - 1];
        if ((a === '"' && b === '"') || (a === "'" && b === "'"))
            return v.slice(1, -1);
    }
    return v;
}
export function parseTags(value) {
    const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    return inner
        .split(/[,，]/)
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
}
/**
 * §7.4 解析 frontmatter。
 *
 * @param text - 文件全文。
 * @returns frontmatter 数据与去掉 frontmatter 后的正文。
 */
export function parseFrontmatter(text) {
    const norm = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const lines = norm.split('\n');
    if (lines.length === 0 || lines[0].trim() !== FM)
        return { data: emptyFrontmatter(), body: norm };
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
        if (lines[i].trim() === FM) {
            end = i;
            break;
        }
    }
    if (end < 0)
        return { data: emptyFrontmatter(), body: norm };
    // 严格一点: 首块里必须至少有一个 `key:` 行, 否则开头的 --- 只是水平分隔线, 不是 frontmatter
    let hasKey = false;
    for (let i = 1; i < end; i += 1) {
        if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(lines[i])) {
            hasKey = true;
            break;
        }
    }
    if (!hasKey)
        return { data: emptyFrontmatter(), body: norm };
    const data = emptyFrontmatter();
    data.present = true;
    let lastKey = '';
    for (let i = 1; i < end; i += 1) {
        const line = lines[i];
        const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
        if (m === null) {
            // 块状列表: `tags:` 换行后跟 `  - a`(Obsidian 默认风格), 不能当成无法识别的行丢掉。
            // related 同样是数组字段, 共用这套解析。
            const item = /^\s+-\s+(.*)$/.exec(line);
            if (item !== null && (lastKey === 'tags' || lastKey === 'related')) {
                const v = unquote(item[1].trim());
                const target = lastKey === 'tags' ? data.tags : data.related;
                if (v !== '' && !target.includes(v))
                    target.push(v);
                continue;
            }
            if (line.trim() !== '')
                data.extra.push(line);
            continue;
        }
        const key = m[1].toLowerCase();
        const value = unquote(m[2].trim());
        if (key === 'tags') {
            data.tags = value === '' ? [] : parseTags(value);
            lastKey = 'tags';
        }
        else if (key === 'related') {
            data.related = value === '' ? [] : parseTags(value);
            lastKey = 'related';
        }
        else if (key === 'importance') {
            data.importance = value;
            lastKey = '';
        }
        else if (key === 'updated') {
            data.updated = value;
            lastKey = '';
        }
        else if (key === 'source') {
            data.source = value;
            lastKey = '';
        }
        else if (key === 'summary') {
            data.summary = value;
            lastKey = '';
        }
        else {
            data.extra.push(line);
            lastKey = '';
        }
    }
    const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
    return { data, body };
}
/** 正文里第一个 Markdown 标题。 */
export function firstHeading(body) {
    const m = /^#{1,6}\s+(.+?)\s*$/m.exec(body.replace(/\r\n/g, '\n'));
    return m === null ? '' : m[1].trim();
}
/** 从标题/文件名推导 tags（按非字母数字切分，最多 6 个；推导不出时回退整个基名）。 */
export function deriveTags(text) {
    const base = String(text ?? '').replace(/\.md$/i, '').trim();
    const tokens = base.split(/[^\p{L}\p{N}]+/u).filter((s) => s.length >= 2);
    const out = [];
    for (const t of tokens) {
        const v = t.length > 24 ? t.slice(0, 24) : t;
        if (!out.includes(v))
            out.push(v);
        if (out.length >= 6)
            break;
    }
    // tags 是必填字段, 不能因为文件名太短就留空
    if (out.length === 0 && base !== '')
        out.push(base.slice(0, 24));
    return out;
}
/**
 * 净化**数组型** frontmatter 值（tags / related 的元素）。
 *
 * frontmatter 是 YAML 的**极小子集**（零依赖手写解析），不支持"引号里的逗号不算分隔符"。
 * 所以 `tags: [a, b]` 里只要有一个值本身含半角逗号，往返解析就会把它切成两个 ——
 * 写进去再读出来就不是原来的东西了。
 *
 * 修法有两条路：① 写一个带引号状态的切分器；② 在**写入时**消除歧义。选 ②，
 * 因为 ① 会让这块本就手写的解析更脆，而 ② 对中文内容几乎无损、且绝不可能被误解析。
 * 半角逗号与顿号都换成全角顿号 `、`（它不参与任何分隔），方括号换成全角书名号。
 */
export function sanitizeListValue(v) {
    return v
        .replace(/[,\uFF0C]/g, '\u3001')
        .replace(/\[/g, '\u3010')
        .replace(/\]/g, '\u3011')
        .replace(/[\r\n]+/g, ' ')
        .trim();
}
/** 净化**单值** frontmatter 字段（source / summary / importance）：去掉换行即可。 */
export function sanitizeScalar(v) {
    return v.replace(/[\r\n]+/g, ' ').trim();
}
/**
 * 把 `updated` 规范成 `YYYY-MM-DD`；格式不对或**日期不存在**（如 `2026-02-30`）时回退到今天。
 *
 * 为什么不直接收下任意字符串：`updated` 是 `since` 过滤与 `sort:"updated"` 的依据，
 * 一个格式错误的值会让这些功能**静默失效** —— 用户只会觉得"怎么搜不到"。
 */
export function normalizeUpdated(v) {
    const t = sanitizeScalar(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
        const parts = t.split('-').map((s) => Number(s));
        const y = parts[0];
        const m = parts[1];
        const d = parts[2];
        const dt = new Date(Date.UTC(y, m - 1, d));
        // 闰年/月份天数都要真的对得上 —— new Date(2026, 1, 30) 会静默滚到 3 月
        if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d)
            return t;
    }
    return today();
}
/** 按规范渲染 frontmatter + 正文。 */
export function buildText(fm, body) {
    const out = [FM];
    out.push(`tags: [${fm.tags.map(sanitizeListValue).join(', ')}]`);
    out.push(`updated: ${fm.updated === '' ? today() : normalizeUpdated(fm.updated)}`);
    out.push(`source: ${fm.source !== '' ? sanitizeScalar(fm.source) : '用户告知'}`);
    if (fm.summary !== '')
        out.push(`summary: ${sanitizeScalar(fm.summary)}`);
    if (fm.related.length > 0)
        out.push(`related: [${fm.related.map(sanitizeListValue).join(', ')}]`);
    if (fm.importance !== '')
        out.push(`importance: ${sanitizeScalar(fm.importance)}`);
    for (const line of fm.extra)
        out.push(line);
    out.push(FM);
    const clean = body.replace(/^\n+/, '').replace(/\s+$/, '');
    return `${out.join('\n')}\n\n${clean}\n`;
}
/**
 * §7.4 校验并补全 `tags` / `updated` / `source`（并保留 `summary` 与自定义行）。
 *
 * @param text - 原始内容。
 * @param fallbackName - 没有标题时用来推导 tags 的文件名。
 * @returns 规范化后的完整文件文本。
 */
export function ensureFrontmatter(text, fallbackName = '') {
    const { data, body } = parseFrontmatter(text);
    const heading = firstHeading(body);
    const fm = {
        present: true,
        tags: data.tags.length > 0 ? data.tags : deriveTags(heading !== '' ? heading : fallbackName),
        updated: data.updated !== '' ? data.updated : today(),
        source: data.source !== '' ? data.source : '用户告知',
        summary: data.summary,
        related: data.related,
        importance: data.importance,
        extra: data.extra,
    };
    return buildText(fm, body);
}
