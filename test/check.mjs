/**
 * 自测脚本(零依赖): node test/check.mjs
 *
 * 全程在项目内的临时目录 `.test-tmp` 里跑, 不碰真实记忆库。
 * 标 [回归] 的用例对应代码审查中发现过、已修复的问题。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveRoot,
  safeResolve,
  ensureRoot,
  parseFrontmatter,
  ensureFrontmatter,
  dedupeAppend,
  rebuildIndex,
  reindexTree,
  updateIndexChain,
  buildCountIndex,
  indexIsStale,
  searchFiles,
  createSearchMatcher,
  invalidateSearchCache,
  withFileLock,
  backupBeforeOverwrite,
  trashStats,
  splitIntent,
  splitQueryTerms,
  suggestTags,
  findSimilarNames,
  executeRecallTool,
  buildRecallReport,
  runDeterministicRecall,
  executeRememberTool,
  buildRememberReport,
  executeGcTool,
  buildGcReport,
  gcTools,
  gcSystemPrompt,
  writeMemory,
  deleteMemory,
  findDuplicateGroups,
  cachedCounts,
  refreshCounts,
  clearCountCache,
  buildText,
  countMdFiles,
  walkFiles,
  firstHeading,
  deriveTags,
  today,
  countOccurrences,
  displayWidth,
  padTo,
  padCol,
  normalizeUpdated,
  sinceSkipNote,
  patchMemory,
} from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(here, '..', '.test-tmp')
const OUTSIDE = path.join(here, '..', '.test-tmp-outside')

let passed = 0
let skipped = 0
function ok(label) {
  passed += 1
  process.stdout.write(`  ok    ${label}\n`)
}
function skip(label) {
  skipped += 1
  process.stdout.write(`  skip  ${label}\n`)
}

function reset() {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(OUTSIDE, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  // 目录计数缓存按**根路径**索引, 而所有测试共用同一个 TMP —— 不清就会串到上一个测试的数据
  clearCountCache()
}

function write(rel, text) {
  const abs = path.join(TMP, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
  return abs
}

function read(rel) {
  return fs.readFileSync(path.join(TMP, rel), 'utf8')
}

const root = TMP

// ── 1. MEMORY_ROOT 解析 ──────────────────────────────────────────────────────
reset()
const savedEnv = process.env.DSH_MEMORY_DIR
const savedHome = process.env.DSH_HOME
delete process.env.DSH_MEMORY_DIR
process.env.DSH_HOME = `${TMP}-home`
assert.equal(resolveRoot(), path.resolve(`${TMP}-home`, 'memory'), '默认应为 $DSH_HOME/memory')
assert.equal(resolveRoot({ memoryRoot: path.join(TMP, 'cfg') }), path.resolve(TMP, 'cfg'), 'config 应生效')
process.env.DSH_MEMORY_DIR = path.join(TMP, 'env')
assert.equal(resolveRoot({ memoryRoot: path.join(TMP, 'cfg') }), path.resolve(TMP, 'env'), '环境变量优先级应最高')
delete process.env.DSH_MEMORY_DIR
delete process.env.DSH_HOME
assert.ok(resolveRoot().endsWith(path.join('.dsh', 'memory')), 'DSH_HOME 缺失时应回退 ~/.dsh/memory')
process.env.DSH_MEMORY_DIR = savedEnv ?? ''
if (savedEnv === undefined) delete process.env.DSH_MEMORY_DIR
if (savedHome !== undefined) process.env.DSH_HOME = savedHome
ok('resolveRoot: env > config > $DSH_HOME/memory > ~/.dsh/memory')

// ── 2. 路径安全 ──────────────────────────────────────────────────────────────
reset()
assert.equal(safeResolve(root, 'a/b.md'), path.join(root, 'a', 'b.md'))
assert.equal(safeResolve(root, ''), root, '空路径 = 记忆库根')
assert.throws(() => safeResolve(root, '../escape.md'), /越出记忆库范围/, '应拒绝 .. 穿越')
assert.throws(() => safeResolve(root, path.join(root, '..', 'x.md')), /越出记忆库范围/, '应拒绝绝对路径越界')
assert.equal(safeResolve(root, '..foo/a.md'), path.join(root, '..foo', 'a.md'), '..foo 是合法文件名, 不该误拒')
ok('safeResolve: 解析 + 拒绝 .. 穿越 / 绝对越界 / 空路径回根')

// ── 3. frontmatter ───────────────────────────────────────────────────────────
const withFm = ['---', 'tags: [a, b, 抓包]', 'updated: 2026-09-27', 'source: 实测', 'summary: 一句话', '---', '', '# 标题', '', '- 要点'].join('\n')
const parsed = parseFrontmatter(withFm)
assert.deepEqual(parsed.data.tags, ['a', 'b', '抓包'])
assert.equal(parsed.data.updated, '2026-09-27')
assert.equal(parsed.data.source, '实测')
assert.equal(parsed.data.summary, '一句话')
assert.equal(firstHeading(parsed.body), '标题')
ok('parseFrontmatter: 解析 tags/updated/source/summary + 正文')

const noFm = '# chrome-devtools-抓包\n\n- 要点一\n'
const fixed = parseFrontmatter(ensureFrontmatter(noFm, 'chrome-devtools-抓包.md'))
assert.equal(fixed.data.source, '用户告知', '缺失 source 应补默认值')
assert.equal(fixed.data.updated, today(), '缺失 updated 应补当天')
assert.ok(fixed.data.tags.includes('抓包'), 'tags 应从标题推导')
assert.ok(ensureFrontmatter(noFm, 'x.md').includes('# chrome-devtools-抓包'), '正文应保留')
ok('ensureFrontmatter: 自动补 tags / updated / source')

assert.deepEqual(deriveTags('chrome-devtools-抓包.md'), ['chrome', 'devtools', '抓包'])
ok('deriveTags: 连字符切分')

// ── 4. 去重追加 ──────────────────────────────────────────────────────────────
const dedup = dedupeAppend('- A\n- B\n', '- B\n- C\n- D\n')
assert.equal(dedup.added, 2, '应只新增 C / D')
assert.equal(dedup.skipped, 1, '应跳过重复的 B')
assert.ok(dedup.body.includes('- C') && dedup.body.includes('- D'))
assert.ok(!dedup.body.includes('- B'), '重复要点不应再次出现')
ok('dedupeAppend: 完全相同的要点不重复追加')

// ── 5. INDEX 只含本层 ────────────────────────────────────────────────────────
reset()
write('技能/浏览器/a-抓包.md', ensureFrontmatter('# A 抓包\n\n- 一\n', 'a-抓包.md'))
write('技能/浏览器/b-发包.md', '---\ntags: [b]\nupdated: 2026-09-20\nsource: 实测\nsummary: B 的说明\n---\n\n# B 发包\n\n- 二\n')
write('技能/逆向/c-断点.md', ensureFrontmatter('# C 断点\n', 'c-断点.md'))
write('环境/d.md', ensureFrontmatter('# D\n', 'd.md'))
ensureRoot(root)
const layers = reindexTree(root, root)
assert.equal(layers, 5, '应重建 根 / 技能 / 技能-浏览器 / 技能-逆向 / 环境 共 5 层')

const rootIdx = read('INDEX.md')
assert.ok(rootIdx.includes('技能/') && rootIdx.includes('环境/'), '根 INDEX 应列顶层目录')
assert.ok(!rootIdx.includes('浏览器'), '根 INDEX 不应递归出现二级目录')
assert.ok(!rootIdx.includes('a-抓包.md'), '根 INDEX 不应出现深层文件')
assert.ok(/\|\s*3\s*\|/.test(rootIdx), '根 INDEX 的技能条目数应为 3(递归统计)')

const skillIdx = read('技能/INDEX.md')
assert.ok(skillIdx.includes('浏览器/') && skillIdx.includes('逆向/'), '技能 INDEX 应列两个子目录')
assert.ok(!skillIdx.includes('a-抓包.md'), '技能 INDEX 不应列深层文件')

const browserIdx = read('技能/浏览器/INDEX.md')
assert.ok(browserIdx.includes('a-抓包.md') && browserIdx.includes('b-发包.md'), '浏览器 INDEX 应列本层两个文件')
assert.ok(!browserIdx.includes('c-断点.md'), '浏览器 INDEX 不应出现其他目录的文件')
assert.ok(browserIdx.includes('B 的说明'), '说明列应取 frontmatter.summary')
assert.ok(browserIdx.includes('A 抓包'), '无 summary 时应回退正文标题')
assert.equal(countMdFiles(path.join(root, '技能')), 3, '技能 下应递归 3 个记忆文件')
ok('INDEX.md: 每层只列本层直接子项, 说明列取 summary / 回退标题')

// ── 6. updateIndexChain ─────────────────────────────────────────────────────
reset()
write('项目/游戏/x.md', ensureFrontmatter('# X\n', 'x.md'))
ensureRoot(root)
const chain = updateIndexChain(root, path.join(root, '项目', '游戏'))
assert.deepEqual(chain, ['项目/游戏/INDEX.md', '项目/INDEX.md', 'INDEX.md'])
ok('updateIndexChain: 从所在目录一路更新到根')

// ── 7. 说明行保留 ────────────────────────────────────────────────────────────
reset()
ensureRoot(root)
let idx = read('INDEX.md')
fs.writeFileSync(path.join(root, 'INDEX.md'), idx.replace(/^> 说明:.*$/m, '> 说明: 我的根说明'), 'utf8')
write('工具/a.md', ensureFrontmatter('# A\n', 'a.md'))
rebuildIndex(root, root)
assert.ok(read('INDEX.md').includes('> 说明: 我的根说明'), 'rebuildIndex 应保留顶部的说明行')
ok('rebuildIndex: 保留人工可写的 `> 说明:` 行')

// ── 8. 搜索排序 ──────────────────────────────────────────────────────────────
reset()
write('技能/浏览器/chrome-devtools-抓包.md', '---\ntags: [x]\nupdated: 2026-09-01\nsource: 实测\n---\n\n# 抓包\n\n- 抓包一次\n')
write('环境/浏览器MCP隔离.md', '---\ntags: [x]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 隔离\n\n- 抓包 抓包 抓包\n')
write('工具/无关.md', '---\ntags: [x]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 无关\n')
ensureRoot(root)
const hits = await searchFiles(root, root, '抓包', { searchBody: true })
assert.equal(hits.length, 2, '无关文件不应命中')
assert.equal(hits[0].rel, '技能/浏览器/chrome-devtools-抓包.md', '文件名命中应排第一')
assert.equal(hits[0].nameHit, true)
assert.equal(hits[1].nameHit, false)
assert.equal(hits[1].bodyHits, 3, '正文命中次数应统计')
assert.equal((await searchFiles(root, root, '浏览器', { searchBody: false })).length, 2, 'content=false 只搜文件名')
ok('searchFiles: 文件名命中优先 > 正文命中数 > updated; content=false 只搜文件名')

assert.ok((await walkFiles(root, root)).every((f) => !f.rel.endsWith('INDEX.md')), 'walkFiles 应排除 INDEX.md')
ok('walkFiles: 排除 INDEX.md 与隐藏项')

assert.equal(countOccurrences('Chrome CHROME chrome', 'chrome'), 3)
assert.equal(countOccurrences('断点调试', '断点'), 1)
assert.equal(displayWidth('抓包ab'), 6)
assert.equal(padTo('抓包', 6), '抓包  ', '中文按显示宽度补空格, 不是按字符数')
// padTo 溢出时原样返回 → 多列拼一行时超长的那列会和右邻列**粘在一起**
// (实活体验收实测: 长文件名后直接跟着 "正文命中 ×0")。padCol 溢出时补一个空格。
assert.equal(padTo('abcdef', 3), 'abcdef', 'padTo 溢出时原样返回')
assert.equal(padCol('abcdef', 3), 'abcdef ', 'padCol 溢出时补一个空格, 避免与右邻列粘连')
assert.equal(padCol('ab', 5), 'ab   ', 'padCol 未溢出时与 padTo 一致')
ok('padCol: 溢出处补一个空格, 避免超长文件名与右邻列粘连')
ok('countOccurrences: 大小写不敏感, 中文任意长度可中')

// ── 9. [回归] append 不再按"行"去重 ──────────────────────────────────────────
const codeBlock = dedupeAppend(
  '# T\n\n```js\nimport fs from "node:fs"\nconst a = 1\n```\n',
  '```js\nimport fs from "node:fs"\nconst b = 2\n```\n',
)
assert.ok(codeBlock.body.includes('const b = 2'), '代码块内容不该被丢掉')
assert.ok(codeBlock.body.includes('import fs from "node:fs"'), '代码块里与原文相同的行必须保留')
ok('[回归] append: 代码块整体去重, 不破坏内部重复行')

const crossSection = dedupeAppend('## A\n- 无\n', '## B\n- 无\n')
assert.ok(crossSection.body.includes('## B'), '新小节标题应保留')
assert.ok(crossSection.body.includes('- 无'), '新小节里的同名要点应保留')
ok('[回归] append: 跨小节的同名要点不再被吞')

const symbolDedup = dedupeAppend('- 要点\n', '* 要点\n')
assert.equal(symbolDedup.added, 0, '* 与 - 应视为同一条要点')
assert.equal(symbolDedup.skipped, 1)
ok('[回归] append: `* x` 与 `- x` 归一化后能去重')

// 单行 append(不带小节标题)必须能认出已有小节里的同一条要点 —— 实测踩到过:
// 内容逐字相同却报"新增 1 条", 往记忆库里加出重复行, 还把 updated 改了
const oneLiner = dedupeAppend('## 小节\n\n- 已有要点\n- 另一条\n', '- 已有要点\n')
assert.equal(oneLiner.added, 0, '不带小节标题的单行 append 应认出重复')
assert.equal(oneLiner.skipped, 1)
assert.equal(oneLiner.body, '', '重复时不应产生任何新内容')
ok('[回归] append: 单行补充要点时能匹配到已有小节里的同一条')

const oneLinerNew = dedupeAppend('## 小节\n\n- 已有要点\n', '- 全新要点\n')
assert.equal(oneLinerNew.added, 1, '确实没有的要点仍应加上')
assert.equal(oneLinerNew.skipped, 0)
ok('[回归] append: 全文查重不会把真正的新要点也吞掉')

// ── 10. [回归] frontmatter 健壮性 ────────────────────────────────────────────
assert.deepEqual(deriveTags('x.md'), ['x'], '短文件名也要给出兜底 tag')
assert.ok(!ensureFrontmatter('', 'x.md').includes('tags: []'), 'tags 不能是空数组')
ok('[回归] tags 必填: 推导不出时用文件名兜底')

const blockYaml = parseFrontmatter('---\ntags:\n  - a\n  - b\nupdated: 2026-01-01\nsource: 实测\n---\n\n# T\n')
assert.deepEqual(blockYaml.data.tags, ['a', 'b'], '应支持 Obsidian 风格的块状 tags')
assert.equal(blockYaml.data.extra.length, 0, '块列表行不该落进 extra')
ok('[回归] frontmatter: 支持块状 YAML 列表 tags')

const customFm = parseFrontmatter('---\ntags: [a]\nupdated: 2026-01-01\nsource: 实测\ncustom: 保留我\n---\n\n# T\n')
assert.deepEqual(customFm.data.extra, ['custom: 保留我'], '自定义字段应进 extra')
assert.ok(ensureFrontmatter('---\ntags: [a]\nupdated: 2026-01-01\nsource: 实测\ncustom: 保留我\n---\n\n# T\n', 't.md').includes('custom: 保留我'), '重排时应保留自定义字段')
ok('[回归] frontmatter: 自定义字段不丢失')

const horizontalRule = parseFrontmatter('---\n\n# 标题\n\n---\n\n正文要点\n')
assert.equal(horizontalRule.data.present, false, '--- 水平线不该被当成 frontmatter')
assert.ok(horizontalRule.body.includes('# 标题'), '标题应留在正文里')
assert.equal(firstHeading(horizontalRule.body), '标题')
ok('[回归] frontmatter: `---` 水平线不误判')

// ── 11. 命中范围: tags 参与, updated/source 不参与 ───────────────────────────
reset()
write('a/t.md', '---\ntags: [独一无二标签]\nupdated: 2026-01-01\nsource: 实测\n---\n\n# T\n\n- 正文里没有那个词\n')
ensureRoot(root)
const tagOnly = await searchFiles(root, root, '独一无二标签', { searchBody: true })
assert.equal(tagOnly.length, 1, 'tags 里的词必须能搜到(规则文档要求用标签关键词检索)')
assert.equal(tagOnly[0].tagHits, 1)
assert.equal(tagOnly[0].bodyHits, 0)
const sourcePollution = (await searchFiles(root, root, '实测', { searchBody: true })).filter((h) => h.bodyHits > 0 || h.tagHits > 0)
assert.equal(sourcePollution.length, 0, 'source 里的"实测"不该算命中(否则几乎全线命中)')
const datePollution = (await searchFiles(root, root, '2026-01-01', { searchBody: true })).filter((h) => h.bodyHits > 0 || h.tagHits > 0)
assert.equal(datePollution.length, 0, 'updated 不该算命中')
ok('命中范围: tags 参与检索, updated/source 等元数据仍被排除')

// ── 12. [回归] 符号链接逃逸 ──────────────────────────────────────────────────
reset()
fs.mkdirSync(OUTSIDE, { recursive: true })
let symlinkOk = false
try {
  fs.symlinkSync(path.join(OUTSIDE, 'victim.md'), path.join(root, 'dangling.md'), 'file')
  symlinkOk = true
} catch (error) {
  if (error?.code !== 'EPERM') throw error
}
if (symlinkOk) {
  assert.throws(() => safeResolve(root, 'dangling.md'), /越出记忆库范围/, '悬空链接必须被拒')
  fs.symlinkSync(OUTSIDE, path.join(root, 'dirlink'), 'dir')
  assert.throws(() => safeResolve(root, 'dirlink/x.md'), /越出记忆库范围/, '指向库外的目录链接必须被拒')
  fs.mkdirSync(path.join(root, 'a'), { recursive: true })
  fs.symlinkSync(path.join(root, 'a'), path.join(root, 'inlink'), 'dir')
  assert.equal(safeResolve(root, 'inlink/x.md'), path.join(root, 'inlink', 'x.md'), '指向库内的链接应放行')
  ok('[回归] safeResolve: 悬空/越界符号链接被拒, 库内链接放行')
} else {
  skip('[回归] 符号链接用例(Windows 需要开发者模式或管理员权限)')
}

// ── 13. [回归] 隐藏项不进 INDEX ──────────────────────────────────────────────
reset()
write('a/.secret.md', ensureFrontmatter('# 隐藏\n', 'secret.md'))
write('a/正常.md', ensureFrontmatter('# 正常\n', '正常.md'))
ensureRoot(root)
reindexTree(root, root)
assert.ok(!read('a/INDEX.md').includes('.secret.md'), '隐藏文件不该进 INDEX')
assert.ok(read('a/INDEX.md').includes('正常.md'))
assert.ok((await walkFiles(root, root)).every((f) => !path.basename(f.abs).startsWith('.')), '搜索也不该看到隐藏文件')
ok('[回归] 隐藏 .md 既不进 INDEX 也不进搜索(口径统一)')

// ── 14. 正则搜索 ─────────────────────────────────────────────────────────────
reset()
write('a/抓包与发包.md', '---\ntags: [x]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 抓包与发包\n\n- list_network_requests 抓包\n- 断点调试放行\n')
write('a/无关.md', '---\ntags: [x]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 无关\n\n- 什么都没有\n')
ensureRoot(root)
const reHits = await searchFiles(root, root, '抓包|发包', { regex: true })
assert.equal(reHits.length, 1, '正则应命中 抓包与发包.md')
assert.equal(reHits[0].rel, 'a/抓包与发包.md')
assert.equal((await searchFiles(root, root, '断点.*放行', { regex: true })).length, 1, '正则应能匹配正文里的跨词内容')
assert.equal((await searchFiles(root, root, 'LIST_NETWORK', { regex: true })).length, 1, '正则大小写不敏感')
// 行为变化: `|` 现在是**分隔符**(拆成 OR), 不再是必须字面匹配的字符 —— 此前 regex=false 时
// "抓包|发包" 必然 0 命中, 现在能正常 OR。真想搜字面量 `|` 请用 regex=true 并转义。
assert.equal((await searchFiles(root, root, '抓包|发包', { regex: false })).length, 1, 'regex=false 时 | 是分隔符, 拆成 抓包 OR 发包')
assert.throws(() => createSearchMatcher('([', true), /正则表达式无效/, '无效正则应给中文错误')
assert.equal(createSearchMatcher('^', true).count('abc'), 1, '零宽匹配不该死循环')
ok('正则搜索: 支持 | 与 .*、大小写不敏感、语法错误中文提示、零宽匹配有防护')

// ── 15. 正文缓存 ─────────────────────────────────────────────────────────────
reset()
const cacheFile = write('a/缓存.md', '---\ntags: [x]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 缓存\n\n- 第一版内容\n')
ensureRoot(root)
assert.equal((await searchFiles(root, root, '第一版', { searchBody: true })).length, 1, '首次搜索应命中')
assert.equal((await searchFiles(root, root, '第一版', { searchBody: true })).length, 1, '二次搜索(走缓存)仍应命中')
await new Promise((resolve) => setTimeout(resolve, 20))
fs.writeFileSync(cacheFile, '---\ntags: [x]\nupdated: 2026-09-28\nsource: 实测\n---\n\n# 缓存\n\n- 第二版内容\n', 'utf8')
assert.equal((await searchFiles(root, root, '第一版', { searchBody: true })).length, 0, '文件变了旧内容不该再命中(缓存须失效)')
assert.equal((await searchFiles(root, root, '第二版', { searchBody: true })).length, 1, '新内容应命中')
invalidateSearchCache()
assert.equal((await searchFiles(root, root, '第二版', { searchBody: true })).length, 1, '清缓存后仍应命中')
ok('正文缓存: mtime/size 判失效, 外部改动不会搜到旧内容')

// ── 16. 并发遍历与限流 ───────────────────────────────────────────────────────
reset()
for (let i = 0; i < 40; i += 1) {
  write(`批量/子${i % 5}/文件${i}.md`, ensureFrontmatter(`# 文件${i}\n\n- 内容 ${i}\n`, `文件${i}.md`))
}
ensureRoot(root)
assert.equal((await walkFiles(root, root)).length, 40, '并发遍历应找全 40 个文件')
assert.equal((await searchFiles(root, root, '内容 7', { searchBody: true })).length, 1, '40 个文件里应命中 1 个')
ok('并发遍历与限流: 40 个文件仍完整且正确')

// ── 17. tags 检索与标签优先排序 ──────────────────────────────────────────────
reset()
write('API/Foo.md', '---\ntags: [API差异, 新版本API]\nupdated: 2026-09-27\nsource: 实测\nsummary: Foo 的新旧差异\n---\n\n# Foo\n\n- 正文不包含那个词\n')
write('API/Bar.md', '---\ntags: [普通]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# Bar\n\n- 正文里有关键词 API差异 一次\n')
ensureRoot(root)
const mixed = await searchFiles(root, root, 'API差异', { searchBody: true })
assert.equal(mixed.length, 2, '标签与正文都应能搜到')
assert.equal(mixed[0].rel, 'API/Foo.md', '标签命中应排在纯正文命中之前')
assert.equal(mixed[0].tagHits, 1)
assert.equal(mixed[0].bodyHits, 0)
assert.equal(mixed[0].desc, 'Foo 的新旧差异', 'desc 应取 frontmatter.summary')
assert.equal(mixed[1].tagHits, 0)
assert.equal(mixed[1].bodyHits, 1)
assert.equal((await searchFiles(root, root, 'API差异', { searchBody: false })).length, 0, 'content=false 时 tags 也不搜')
ok('tags 检索: 能搜到、优先于正文命中、desc 取 summary')

// ── 18. 搜索结果带"说明" ─────────────────────────────────────────────────────
reset()
write('a/无摘要.md', '---\ntags: [x]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 我的标题\n\n- 关键词 命中词\n')
ensureRoot(root)
const descHit = (await searchFiles(root, root, '命中词', { searchBody: true }))[0]
assert.equal(descHit.desc, '我的标题', '没有 summary 时应回退正文首个标题')
ok('搜索结果说明: 无 summary 时回退正文标题(与 INDEX 说明列同源)')

// ── 19. nameHit 只匹配相对 scope 的路径 ──────────────────────────────────────
reset()
write('技能/浏览器/a.md', '---\ntags: [x]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# A\n\n- 无关正文\n')
ensureRoot(root)
const scopeDir = path.join(root, '技能', '浏览器')
assert.equal((await searchFiles(root, root, '技能', { searchBody: true })).length, 1, '从根搜"技能"应命中')
assert.equal((await searchFiles(root, scopeDir, '技能', { searchBody: true })).length, 0, 'scope 到子目录后不该再命中父目录名')
assert.equal((await searchFiles(root, scopeDir, '浏览器', { searchBody: true })).length, 0, '也不该命中 scope 自身的目录名')
assert.equal((await searchFiles(root, scopeDir, 'a.md', { searchBody: true })).length, 1, '相对 scope 的文件名仍应命中')
ok('[回归] nameHit 只匹配相对 scope 的路径(此前 scope 内搜父目录名会全线命中)')

// ── 20. INDEX 条目数一次算完 ─────────────────────────────────────────────────
reset()
write('分类1/子1/a.md', ensureFrontmatter('# A\n', 'a.md'))
write('分类1/子1/b.md', ensureFrontmatter('# B\n', 'b.md'))
write('分类1/子2/c.md', ensureFrontmatter('# C\n', 'c.md'))
write('分类2/d.md', ensureFrontmatter('# D\n', 'd.md'))
ensureRoot(root)
const counts = buildCountIndex(root)
assert.equal(counts.get(root), 4, '根应统计 4 个')
assert.equal(counts.get(path.join(root, '分类1')), 3, '分类1 递归 3 个')
assert.equal(counts.get(path.join(root, '分类1', '子1')), 2)
assert.equal(counts.get(path.join(root, '分类2')), 1)
assert.equal(counts.get(path.join(root, '分类2', '不存在')), undefined)
ok('buildCountIndex: 一次遍历算全每个目录的递归条目数')

// ── 21. INDEX 漂移检测与自愈 ─────────────────────────────────────────────────
reset()
write('a/原有.md', ensureFrontmatter('# 原有\n', '原有.md'))
ensureRoot(root)
updateIndexChain(root, path.join(root, 'a'))
assert.equal(indexIsStale(root, path.join(root, 'a')), false, '刚重建好不该判为过时')
assert.equal(indexIsStale(root, root), false, '根也应一致')
write('a/外部新增.md', ensureFrontmatter('# 外部新增\n', '外部新增.md'))
assert.equal(indexIsStale(root, path.join(root, 'a')), true, '漏列本层文件应判为过时')
assert.equal(indexIsStale(root, root), true, '子树条目数变了, 根也应判为过时')
updateIndexChain(root, path.join(root, 'a'))
assert.equal(indexIsStale(root, root), false, '重建后应恢复一致')
assert.ok(read('a/INDEX.md').includes('外部新增.md'))
ok('[回归] indexIsStale + 链重建: 外部新增文件造成的索引漂移能被发现并修复')

// ── 22. 时间视图: sort='updated' 与 since ────────────────────────────────────
reset()
write('a/旧.md', '---\ntags: [x]\nupdated: 2026-09-01\nsource: 实测\n---\n\n# 旧\n\n- 关键词甲\n')
write('a/新.md', '---\ntags: [x]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 新\n\n- 关键词甲\n')
write('a/更旧.md', '---\ntags: [x]\nupdated: 2026-08-01\nsource: 实测\n---\n\n# 更旧\n\n- 关键词甲\n')
ensureRoot(root)
const byTime = await searchFiles(root, root, '关键词甲', { sort: 'updated' })
assert.deepEqual(
  byTime.map((h) => h.updated),
  ['2026-09-27', '2026-09-01', '2026-08-01'],
  'sort=updated 应按日期倒序, 不看命中数',
)
const sinceHits = await searchFiles(root, root, '关键词甲', { since: '2026-09-01' })
assert.equal(sinceHits.length, 2, 'since 应过滤掉更早的')
assert.equal(sinceHits[0].updated, '2026-09-27')
ok('[新增] 时间视图: sort="updated" 纯按日期倒序, since="YYYY-MM-DD" 只看之后的')

// ── 23. query 为空 = 列目录 ──────────────────────────────────────────────────
assert.equal((await searchFiles(root, root, '')).length, 3, '空 query 应列出全部记忆')
assert.equal((await searchFiles(root, root, '', { since: '2026-09-10' })).length, 1, '列目录也支持 since')
assert.equal((await searchFiles(root, root, '', { sort: 'updated' }))[0].updated, '2026-09-27')
ok('[新增] query 传空串 = 列目录(可配 scope / since / sort 使用)')

// ── 24. 空目录不再输出占位行 ─────────────────────────────────────────────────
reset()
ensureRoot(root)
assert.ok(read('INDEX.md').includes('## 子文件夹'), '表头应保留')
assert.ok(!read('INDEX.md').includes('本层无子文件夹'), '空目录不该有 "(本层无子文件夹) | 0" 占位行')
assert.ok(!read('INDEX.md').includes('本层无文件'), '空文件表也不该有占位行')
ok('[回归] INDEX: 空目录/空文件表不再输出占位行')

// ── 25. 写锁 ────────────────────────────────────────────────────────────────
reset()
const lockTarget = path.join(root, 'a', 'x.md')
fs.mkdirSync(path.dirname(lockTarget), { recursive: true })
let ran = 0
await withFileLock(lockTarget, () => {
  ran += 1
})
assert.equal(ran, 1)
assert.ok(!fs.existsSync(`${lockTarget}.dshlock`), '正常结束后锁应被释放')

const lockPath = `${lockTarget}.dshlock`
fs.writeFileSync(lockPath, '', 'utf8')
// 等待锁期间事件循环不能被阻塞: 定时器应照常触发(此前用 Atomics.wait 会停摆整个进程)
let ticked = false
const ticker = setTimeout(() => {
  ticked = true
}, 50)
await assert.rejects(() => withFileLock(lockTarget, () => {}, 200), /等待写锁超时/, '锁被占住且未陈旧时应超时')
clearTimeout(ticker)
assert.ok(ticked, '等待锁期间事件循环不应被阻塞(定时器照常触发)')
assert.ok(fs.existsSync(lockPath), '超时后不该毁掉别人的锁')
fs.rmSync(lockPath, { force: true })
ok('[新增] 写锁: 拿锁/放锁正常, 被占住时异步等待后超时, 且不阻塞事件循环')

fs.writeFileSync(lockPath, '', 'utf8')
const past = new Date(Date.now() - 60000)
fs.utimesSync(lockPath, past, past)
await withFileLock(lockTarget, () => {
  ran += 1
})
assert.equal(ran, 2, '陈旧锁应被清掉后成功拿锁')
assert.ok(!fs.existsSync(lockPath))
ok('[新增] 写锁: 陈旧锁(持有者崩了)会被自动清理')

// ── 26. .trash 备份 ─────────────────────────────────────────────────────────
reset()
const origin = write('a/原件.md', '---\ntags: [x]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 原件\n\n- 内容\n')
ensureRoot(root)
backupBeforeOverwrite(root, origin)
const trashDir = path.join(root, '.trash')
const backups = fs.readdirSync(trashDir)
assert.equal(backups.length, 1, '应产生 1 份备份')
assert.ok(backups[0].endsWith('__a__原件.md'), `备份名应含原相对路径: ${backups[0]}`)
assert.equal(
  fs.readFileSync(path.join(trashDir, backups[0]), 'utf8'),
  fs.readFileSync(origin, 'utf8'),
  '备份内容应与原文一致',
)
reindexTree(root, root)
assert.ok(!read('INDEX.md').includes('.trash'), '.trash 不该进 INDEX')
assert.equal((await walkFiles(root, root)).length, 1, '.trash 里的备份不该被当成记忆条目')
const stats = trashStats(root)
assert.equal(stats.files, 1, 'trashStats 应数出 1 份备份')
assert.ok(stats.bytes > 0, 'trashStats 应报出体积')
assert.deepEqual(trashStats(path.join(root, 'a')), { files: 0, bytes: 0 }, '没有 .trash 时应返回 0/0')
ok('[新增] .trash 备份: 覆盖/删除前留底, 不污染 INDEX 与搜索, 且能统计体积')

// ── 27. 锁必须真正串行化 ─────────────────────────────────────────────────────
reset()
const serialTarget = path.join(root, 'a', 's.md')
fs.mkdirSync(path.dirname(serialTarget), { recursive: true })
const order = []
await Promise.all([
  withFileLock(serialTarget, async () => {
    order.push('a-start')
    await new Promise((resolve) => setTimeout(resolve, 80))
    order.push('a-end')
  }),
  withFileLock(serialTarget, () => {
    order.push('b-start')
    order.push('b-end')
  }),
])
assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'], '锁必须让并发写入串行化, 而不是交错')
ok('[新增] 写锁: 并发写入被真正串行化(第二个等第一个放锁)')

// ── 28. patch 路径不该写出 tags: [] ──────────────────────────────────────────
const handWritten = '# 手写的记忆\n\n- 这里有个错别字\n'
const afterPatch = handWritten.replace('错别字', '正确词')
const rebuiltFm = parseFrontmatter(ensureFrontmatter(afterPatch, '手写的记忆.md')).data
assert.ok(rebuiltFm.tags.length > 0, 'patch 一个无 frontmatter 的文件后, tags 不该为空')
assert.ok(!ensureFrontmatter(afterPatch, '手写的记忆.md').includes('tags: []'), 'patch 落盘不该写出 tags: []')
assert.ok(rebuiltFm.source !== '', 'source 也该被补上')
ok('[回归] memory_patch: 对手写的无 frontmatter 文件会补全 tags/source, 而不是写出 tags: []')

// ── 29. splitIntent: 意图拆词 ────────────────────────────────────────────────
const t1 = splitIntent('chrome-devtools 抓包, 发包')
assert.ok(t1.includes('chrome') && t1.includes('devtools'), '带连字符的词会拆成部件(子串匹配下同样命中 chrome-devtools-xxx.md)')
assert.ok(t1.includes('抓包'), '中文词应保留')
assert.ok(t1.every((t) => t.length >= 2), '不应保留长度 <2 的词')
assert.ok(splitIntent('找抓包相关的做法').length > 1, '长中文串应补 2-gram 提高召回')
assert.deepEqual(splitIntent('抓包'), ['抓包'], '单个词应原样返回')
ok('[新增] splitIntent: 长中文意图能拆出可 OR 的检索词(含 2-gram 补召回)')

// ── 30. 子代理工具白名单 ─────────────────────────────────────────────────────
reset()
write('a/抓包.md', '---\ntags: [抓包]\nupdated: 2026-09-27\nsource: 实测\nsummary: 抓包的做法\n---\n\n# 抓包\n\n- 要点一\n- 要点二\n')
ensureRoot(root)
updateIndexChain(root, path.join(root, 'a'))

const rlog = { reads: [], searches: [], turns: 0, stopReason: 'done' }
const okSearch = await executeRecallTool(root, { name: 'memory_search', arguments: JSON.stringify({ query: '抓包' }) }, rlog)
assert.equal(okSearch.isError, false, '允许的工具应执行')
assert.equal(rlog.searches.length, 1, '搜索要进日志')
assert.equal(rlog.searches[0].hits, 1)
const okRead = await executeRecallTool(root, { name: 'memory_read', arguments: JSON.stringify({ path: 'a/抓包.md' }) }, rlog)
assert.equal(okRead.isError, false)
assert.equal(rlog.reads.length, 1)
assert.equal(rlog.reads[0].path, 'a/抓包.md')

const denyWrite = await executeRecallTool(root, { name: 'memory_write', arguments: '{}' }, rlog)
assert.equal(denyWrite.isError, true, '写工具必须在白名单外')
const denyRecur = await executeRecallTool(root, { name: 'memory_recall', arguments: '{}' }, rlog)
assert.equal(denyRecur.isError, true, '不能让子代理递归调用自己')
const denyUnknown = await executeRecallTool(root, { name: 'pwsh', arguments: '{}' }, rlog)
assert.equal(denyUnknown.isError, true, '宿主工具不该被子代理碰到')
assert.equal(rlog.reads.length, 1, '被拒的调用不该写进日志')
assert.equal((await executeRecallTool(root, { name: 'memory_search', arguments: '{bad' }, rlog)).isError, true, '非法 JSON 应报错')
const escape = await executeRecallTool(root, { name: 'memory_read', arguments: JSON.stringify({ path: '../../windows/win.ini' }) }, rlog)
assert.equal(escape.isError, true, '越界路径必须被拒')
// 行为变化: INDEX 现在**放开**了(猜不到关键词时它是唯一退路)。它会进 reads,
// 但**不会进返回物** —— buildRecallReport 把它当导航过滤掉, 这才是"导航不是内容"的落点。
const idxRead = await executeRecallTool(root, { name: 'memory_read', arguments: JSON.stringify({ path: 'a/INDEX.md' }) }, rlog)
assert.equal(idxRead.isError, false, '放开后应能读 INDEX.md')
assert.ok(idxRead.text.length > 0, '应返回 INDEX 内容')
assert.ok(
  !buildRecallReport(root, rlog, 5).includes('## a/INDEX.md'),
  'INDEX 仍不得作为"内容"出现在返回物里',
)
ok('[新增] 子代理工具执行: 白名单拦写工具/递归/宿主工具, 越界路径被拒, INDEX 不计入读取')

// ── 31. 返回物由日志决定 ─────────────────────────────────────────────────────
reset()
for (let i = 1; i <= 7; i += 1) {
  write(`a/文件${i}.md`, `---\ntags: [t]\nupdated: 2026-09-2${i}\nsource: 实测\n---\n\n# 文件${i}\n\n- 内容 ${i}\n`)
}
ensureRoot(root)
const rlog2 = { reads: [], searches: [{ query: 'x', hits: 3, topPaths: [] }], turns: 2, stopReason: 'done' }
rlog2.reads.push({ path: 'a/文件1.md', bytes: 10 })
rlog2.reads.push({ path: 'a/文件1.md', bytes: 10 })
rlog2.reads.push({ path: 'a/INDEX.md', bytes: 5 })
rlog2.reads.push({ path: 'a/文件2.md', bytes: 10 })
const report = buildRecallReport(root, rlog2, 5)
assert.ok(report.includes('## a/文件1.md'), '应返回读到的文件原文')
assert.ok(!report.includes('## a/INDEX.md'), 'INDEX 不该出现在返回物里')
assert.equal(report.split('## a/文件1.md').length - 1, 1, '重复读取应去重')
assert.ok(report.includes('子代理执行 2 轮'), '应报告轮数')
assert.ok(report.includes('命中概览'), '应给客观的命中概览而非子代理的总结')

const rlog3 = { reads: [], searches: [], turns: 1, stopReason: 'done' }
for (let i = 1; i <= 7; i += 1) rlog3.reads.push({ path: `a/文件${i}.md`, bytes: 10 })
const capped = buildRecallReport(root, rlog3, 3)
assert.equal(capped.split('\n## a/文件').length - 1, 3, 'maxFiles 应生效')
assert.ok(capped.includes('另有 4 个已读取但未返回'), '被省略的必须报数, 不能让主 agent 以为这就是全部')
ok('[新增] 返回物: 日志驱动(去重/排除 INDEX/上限/报告省略), 不依赖子代理的自然语言')

// ── 32. 截断标注 与 半成功 ───────────────────────────────────────────────────
reset()
write('a/大文件.md', `---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 大文件\n\n${'x'.repeat(9000)}\n`)
ensureRoot(root)
const rlog4 = { reads: [{ path: 'a/大文件.md', bytes: 9000 }], searches: [], turns: 1, stopReason: 'done' }
const cut = buildRecallReport(root, rlog4, 5)
assert.ok(cut.includes('已截断'), '超过 8KB 必须显式标注截断')
assert.ok(cut.length < 11000, '返回物本身要被截断住, 不能把整个文件塞回主上下文')

const rlog5 = { reads: [{ path: 'a/大文件.md', bytes: 9000 }], searches: [], turns: 6, stopReason: 'budget' }
const half = buildRecallReport(root, rlog5, 5)
assert.ok(half.includes('到达 6 轮上限提前结束'), '撞上限应说明原因')
assert.ok(half.includes('## a/大文件.md'), '撞上限属于半成功, 已读到的内容照常返回')
ok('[新增] 返回物: 单文件超 8KB 截断标注; 撞轮数上限属半成功仍返回已读内容')

// ── 33. 降级路径: 确定性检索 ─────────────────────────────────────────────────
reset()
write('a/抓包做法.md', '---\ntags: [抓包, network]\nupdated: 2026-09-27\nsource: 实测\nsummary: 抓包怎么做\n---\n\n# 抓包做法\n\n- 用 devtools\n- 用代理\n')
write('b/无关.md', '---\ntags: [其他]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 无关\n\n- 没有关键词\n')
ensureRoot(root)
const fb = await runDeterministicRecall(root, root, '抓包 做法')
assert.ok(fb.includes('抓包做法.md'), '降级检索应命中相关文件')
assert.ok(fb.includes('确定性检索命中'), '应说明这是确定性检索')
const fbNone = await runDeterministicRecall(root, root, 'zzz 完全不存在的词')
assert.ok(fbNone.includes('没找到') || fbNone.includes('没能'), '无命中要明确说明, 不能静默返回空')
ok('[新增] 降级路径: 零模型成本的确定性检索可用(含无命中提示)')

// ── 34. 多词/长串查询自动拆词(实测到的硬伤) ──────────────────────────────────
reset()
write('技能/浏览器/chrome-devtools-抓包.md', '---\ntags: [chrome-devtools, 抓包]\nupdated: 2026-09-27\nsource: 实测\nsummary: 抓包做法\n---\n\n# chrome-devtools 抓包\n\n- list_network_requests\n')
write('技能/逆向/js-reverse-断点.md', '---\ntags: [js-reverse, 断点]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# js-reverse 断点\n\n- 条件断点\n')
ensureRoot(root)
// 修复前这几个全是 0 命中
assert.equal((await searchFiles(root, root, 'chrome 抓包', { searchBody: true })).length, 1, '"chrome 抓包" 应能命中(拆词 OR)')
assert.equal((await searchFiles(root, root, '抓包 chrome', { searchBody: true })).length, 1, '词序不该影响结果')
assert.equal((await searchFiles(root, root, '断点调试', { searchBody: true })).length, 0, '长中文串不做 2-gram 拆分(那是语义判断, 交给子代理拆词, 保住精度)')
assert.equal((await searchFiles(root, root, '抓包', { searchBody: true })).length, 1, '单词查询不受影响')
const mo = createSearchMatcher('chrome 抓包', false)
assert.equal(mo.split, true, '多词 query 应标记为已拆词')
assert.deepEqual([...mo.terms], ['chrome', '抓包'])
const mono = createSearchMatcher('抓包', false)
assert.equal(mono.split, false, '单词不该标记为拆词')
assert.deepEqual(splitQueryTerms('抓包'), [], '单词无需拆词')
assert.deepEqual(splitQueryTerms('chrome 抓包'), ['chrome', '抓包'])
assert.deepEqual(splitQueryTerms('cookie/session'), ['cookie', 'session'], '斜杠是分隔符')
assert.deepEqual(splitQueryTerms('抓包|发包'), ['抓包', '发包'], '竖线是分隔符')
assert.deepEqual(splitQueryTerms('网络请求分析'), [], '长中文串不拆 —— 那是语义判断, 交给子代理拆词')
ok('[修复] 按分隔符(空格/斜杠/竖线/逗号)拆词 OR —— 此前 "chrome 抓包" 必 0 命中')

// ── 35. 拆词只是兜底: 整串精确优先 ───────────────────────────────────────────
reset()
write('a/整串.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# A\n\n- alpha beta 连写\n')
write('b/拆开.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# B\n\n- alpha 在这里\n- beta 也在\n')
ensureRoot(root)
const exactFirst = await searchFiles(root, root, 'alpha beta', { searchBody: true })
assert.equal(exactFirst[0].rel, 'a/整串.md', '整串精确命中的文件必须排第一')
assert.equal(exactFirst[0].bodyHits, 1, '精确命中时按整串计数, 不是 OR 求和')
ok('[修复] 拆词不牺牲精度: 整串精确命中永远优先, 计数也用整串')

// ── 36. suggestTags 与 findSimilarNames ─────────────────────────────────────
reset()
write('a/chrome-devtools-抓包.md', '---\ntags: [chrome-devtools, 抓包, 网络分析]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# A\n\n- x\n')
write('b/无关.md', '---\ntags: [烹饪]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# B\n\n- y\n')
ensureRoot(root)
const tagHints = await suggestTags(root, root, '抓包')
assert.ok(tagHints.includes('抓包'), '应把库里实际用过的相关标签摆出来')
assert.ok(tagHints.every((t) => t.length >= 2), '返回的必须是完整标签, 不能是单个字符')
assert.ok(!tagHints.includes('烹'), '不该把无关标签也算上')
const similarNames = findSimilarNames(path.join(root, 'a'), 'chrome-devtools-抓包分析.md')
assert.ok(similarNames.includes('chrome-devtools-抓包.md'), '高度相似的文件名应被识别')
assert.deepEqual(findSimilarNames(path.join(root, 'b'), '完全无关的名字.md'), [], '不相似的不该误报')
ok('[新增] suggestTags 给 0 命中的检索一个跳板; findSimilarNames 提示疑似同主题')

// ── 37. .trash 保留上限 ─────────────────────────────────────────────────────
reset()
write('a/原件.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 原件\n\n- x\n')
ensureRoot(root)
for (let i = 0; i < 205; i += 1) backupBeforeOverwrite(root, path.join(root, 'a', '原件.md'))
const trashCount = fs.readdirSync(path.join(root, '.trash')).length
assert.ok(trashCount <= 200, `.trash 应被修剪到 200 以内, 实际 ${trashCount}`)
assert.ok(trashCount >= 190, `不该删过头, 实际 ${trashCount}`)
ok('[新增] .trash 超过 200 份时自动删最旧的(此前只增不删, 会线性膨胀)')

// ── 38. 写入子代理: 真写入 / 删除必须带理由且可恢复 ──────────────────────────
reset()
const rlog6 = { searches: [], reads: [], writes: [], deletes: [], notes: [], turns: 0, elapsedMs: 1, stopReason: 'done' }
const w1 = await executeRememberTool(
  root,
  { name: 'memory_write', arguments: JSON.stringify({ path: '技能/测试-写入.md', content: '# 测试\n\n- 要点一\n', mode: 'create' }) },
  rlog6,
)
assert.equal(w1.isError, false, `写入应成功: ${w1.text}`)
assert.equal(rlog6.writes.length, 1)
assert.equal(rlog6.writes[0].path, '技能/测试-写入.md')
assert.ok(fs.existsSync(path.join(root, '技能', '测试-写入.md')), '文件应真的落盘')
const d1 = await executeRememberTool(root, { name: 'memory_delete', arguments: JSON.stringify({ path: '技能/测试-写入.md' }) }, rlog6)
assert.equal(d1.isError, true, '缺 reason 的删除必须被拒')
assert.equal(rlog6.deletes.length, 0)
const d2 = await executeRememberTool(
  root,
  { name: 'memory_delete', arguments: JSON.stringify({ path: '技能/测试-写入.md', reason: '要点已并入 别处' }) },
  rlog6,
)
assert.equal(d2.isError, false, `带 reason 的删除应成功: ${d2.text}`)
assert.equal(rlog6.deletes.length, 1)
assert.equal(rlog6.deletes[0].reason, '要点已并入 别处')
assert.ok(rlog6.deletes[0].backup !== null, '删除必须留下备份路径')
assert.ok(fs.existsSync(path.join(root, ...rlog6.deletes[0].backup.split('/'))), '备份必须真的存在 —— 这是"删除可逆"的实证')
assert.equal(
  (await executeRememberTool(root, { name: 'memory_delete', arguments: JSON.stringify({ path: '../../x.md', reason: 'r' }) }, rlog6)).isError,
  true,
  '越界路径必须被拒',
)
assert.equal((await executeRememberTool(root, { name: 'pwsh', arguments: '{}' }, rlog6)).isError, true, '宿主工具必须在白名单外')
ok('[新增] 写入子代理: 真写入; 删除必须带理由且留可恢复备份; 越界/白名单外被拒')

// ── 39. 写入返回物: 删除醒目 + 回读落盘内容 ──────────────────────────────────
// 单独起一套日志: 上一节的文件已经被删了, 复用它会读不到落盘内容
reset()
ensureRoot(root)
const rlog7 = { searches: [], reads: [], writes: [], deletes: [], notes: [], turns: 0, elapsedMs: 1, stopReason: 'done' }
await executeRememberTool(
  root,
  { name: 'memory_write', arguments: JSON.stringify({ path: 'a/旧.md', content: '# 旧\n\n- x\n', mode: 'create' }) },
  rlog7,
)
await executeRememberTool(
  root,
  { name: 'memory_delete', arguments: JSON.stringify({ path: 'a/旧.md', reason: '要点已并入 a/新.md' }) },
  rlog7,
)
await executeRememberTool(
  root,
  { name: 'memory_write', arguments: JSON.stringify({ path: 'a/新.md', content: '# 新\n\n- y\n', mode: 'create' }) },
  rlog7,
)
const rrep = buildRememberReport(root, rlog7)
assert.ok(rrep.includes('删除了 1 个文件'), '返回物必须把删除列出来')
assert.ok(rrep.includes('要点已并入 a/新.md'), '删除理由必须进返回物')
assert.ok(rrep.includes('.trash/'), '必须给出备份路径 —— 可恢复才是真的')
assert.ok(rrep.includes('写入后的实际内容'), '要回读落盘内容, 而不是回显传入的 content')
ok('[新增] 写入返回物: 删除醒目列出(理由+备份路径), 并回读实际落盘内容')

// ── 40. 整理子代理: 只读既不给写工具也拒绝调用 ───────────────────────────────
reset()
write('a/x.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# X\n\n- 内容\n')
ensureRoot(root)
const gtoolsReadOnly = gcTools(false)
assert.ok(!gtoolsReadOnly.some((t) => t.name === 'memory_delete'), '只读模式不该给删除工具')
assert.ok(!gtoolsReadOnly.some((t) => t.name === 'memory_patch'), '只读模式不该给改写工具')
const gtoolsApply = gcTools(true)
assert.ok(gtoolsApply.some((t) => t.name === 'memory_delete'), 'apply 模式应给删除工具')
assert.ok(gtoolsApply.some((t) => t.name === 'memory_patch'), 'apply 模式应给改写工具')

const glog = { lists: [], searches: [], reads: [], findings: [], fixes: [], deletes: [], turns: 0, elapsedMs: 1, stopReason: 'done' }
const denyDel = await executeGcTool(root, { name: 'memory_delete', arguments: JSON.stringify({ path: 'a/x.md', reason: 'r' }) }, glog, false)
assert.equal(denyDel.isError, true, 'apply=false 时删除必须被拒(哪怕白名单被绕过)')
assert.ok(fs.existsSync(path.join(root, 'a', 'x.md')), '文件不该被删')
const noReason = await executeGcTool(root, { name: 'memory_delete', arguments: JSON.stringify({ path: 'a/x.md' }) }, glog, true)
assert.equal(noReason.isError, true, 'apply=true 但缺 reason 仍须被拒')
const allowDel = await executeGcTool(
  root,
  { name: 'memory_delete', arguments: JSON.stringify({ path: 'a/x.md', reason: '重复内容, 已并入 b/y.md' }) },
  glog,
  true,
)
assert.equal(allowDel.isError, false, `apply=true 且带 reason 应允许: ${allowDel.text}`)
assert.equal(glog.deletes.length, 1)
assert.ok(!fs.existsSync(path.join(root, 'a', 'x.md')), '文件应被删除')
const grep = buildGcReport(glog, true)
assert.ok(grep.includes('合并后删除了 1 个文件'), '体检报告必须列出删除')
assert.ok(grep.includes('重复内容, 已并入 b/y.md'), '删除理由必须进报告')
ok('[新增] 整理子代理: 只读模式既不给写工具也拒绝调用; apply 时删除仍需理由, 报告列出删除')

// ── 41. 检索子代理可读 INDEX / 列目录(猜不到词时的两条退路) ─────────────────
reset()
write('技能/浏览器/chrome-devtools-抓包.md', '---\ntags: [chrome-devtools, 抓包]\nupdated: 2026-09-27\nsource: 实测\nsummary: 抓包做法\n---\n\n# chrome-devtools 抓包\n\n- list_network_requests\n')
ensureRoot(root)
updateIndexChain(root, path.join(root, '技能', '浏览器'))
const ilog = { reads: [], searches: [], notes: [], turns: 0, elapsedMs: 0, stopReason: 'done' }
// 直接传 INDEX.md 路径: 放开后应能读到
const byPath = await executeRecallTool(root, { name: 'memory_read', arguments: JSON.stringify({ path: '技能/浏览器/INDEX.md' }) }, ilog)
assert.equal(byPath.isError, false, `放开后应能读 INDEX.md: ${byPath.text}`)
assert.ok(byPath.text.includes('chrome-devtools'), 'INDEX 应列出该层的文件名')
// 传目录同样能读到(不必写出 /INDEX.md)
const byDir = await executeRecallTool(root, { name: 'memory_read', arguments: JSON.stringify({ path: '技能/浏览器' }) }, ilog)
assert.equal(byDir.isError, false)
assert.ok(byDir.text.includes('chrome-devtools'))
// 父层 INDEX 列的是子目录, 同样可读 —— 逐层下钻靠它
const byParent = await executeRecallTool(root, { name: 'memory_read', arguments: JSON.stringify({ path: '技能/INDEX.md' }) }, ilog)
assert.equal(byParent.isError, false)
assert.ok(byParent.text.includes('浏览器'), '上层 INDEX 应列出子目录')
// 空 query 列目录(第二条退路)
const listed = await executeRecallTool(root, { name: 'memory_search', arguments: JSON.stringify({ query: '', scope: '技能' }) }, ilog)
assert.equal(listed.isError, false, `空 query 应能列目录: ${listed.text}`)
assert.ok(listed.text.includes('chrome-devtools-抓包.md'), '应列出文件名')
// 但 INDEX 绝不作为"内容"进返回物
const irep = buildRecallReport(root, ilog, 5)
assert.ok(!irep.includes('## 技能/INDEX.md'), 'INDEX 不该作为内容出现在返回物里')
ok('[修复] 检索子代理可读 INDEX 与列目录(猜不到词时的两条退路); INDEX 仍不进返回物')

// ── 42. 写入强制 updated=今天; findDuplicateGroups 预计算相似组 ──────────────
reset()
ensureRoot(root)
// 实测发现的缺陷: 写入子代理是 LLM, 它不知道"今天是哪天", 实测写出过差一天的日期
await writeMemory(root, 'a/x.md', '---\ntags: [t]\nupdated: 1999-01-01\nsource: 实测\n---\n\n# X\n\n- 内容\n', 'create')
const xText = fs.readFileSync(path.join(root, 'a', 'x.md'), 'utf8')
assert.ok(xText.includes(`updated: ${today()}`), 'updated 应被强制设为今天')
assert.ok(!xText.includes('1999-01-01'), '写入方填的错日期应被覆盖')

write('b/记忆库-文件式方案.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# A\n')
write('b/记忆库-文件式方案详解.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# B\n')
write('b/完全无关.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# C\n')
ensureRoot(root)
const groups = await findDuplicateGroups(root, path.join(root, 'b'))
assert.equal(groups.length, 1, `应只找出 1 组相似, 实际 ${JSON.stringify(groups)}`)
assert.equal(groups[0].length, 2, '该组应有 2 个文件')
assert.ok(groups[0].every((p) => p.startsWith('b/')), '返回的应是相对记忆库根的路径, 不是 basename')
assert.deepEqual(await findDuplicateGroups(root, path.join(root, 'a')), [], '单文件目录不该报重复')
ok('[修复] 写入强制 updated=今天(子代理不知道日期); findDuplicateGroups 预计算相似组')

// ── 43. gc 提示词: apply 模式要讲清合并流程 ─────────────────────────────────
const gcPromptApply = gcSystemPrompt(true)
assert.ok(gcPromptApply.includes('memory_delete'), 'apply 模式的提示词应提到删除')
assert.ok(gcPromptApply.includes('合并'), '应说明合并流程')
assert.ok(gcSystemPrompt(false).includes('只读'), '只读模式的提示词应写明只读')
ok('[新增] gc 提示词: apply 模式说明合并流程(删除需 reason), 只读模式写明只读')

// ── 44. frontmatter 新字段: related / importance ─────────────────────────────
const fmText = [
  '---',
  'tags: [a, b]',
  'updated: 2026-09-27',
  'source: 实测',
  'related: [x/y.md, z.md]',
  'importance: 高',
  '---',
  '',
  '# T',
  '',
  '- 要点',
  '',
].join('\n')
const fmParsed = parseFrontmatter(fmText)
assert.deepEqual(fmParsed.data.related, ['x/y.md', 'z.md'], 'related 应被解析成数组')
assert.equal(fmParsed.data.importance, '高')
assert.ok(!fmParsed.data.extra.some((l) => l.includes('related')), 'related 不该落进 extra')
const fmRebuilt = buildText(fmParsed.data, fmParsed.body)
assert.ok(fmRebuilt.includes('related: [x/y.md, z.md]'), '渲染应保留 related')
assert.ok(fmRebuilt.includes('importance: 高'), '渲染应保留 importance')
const fmRound = parseFrontmatter(fmRebuilt)
assert.equal(buildText(fmRound.data, fmRound.body), fmRebuilt, '解析/渲染往返应幂等')
const fmBlock = parseFrontmatter('---\ntags:\n  - a\nrelated:\n  - p/q.md\n  - r.md\n---\n\n# B\n')
assert.deepEqual(fmBlock.data.related, ['p/q.md', 'r.md'], 'related 应支持块状列表(Obsidian 风格)')
const fmBare = parseFrontmatter('---\ntags: [a]\n---\n\n# C\n')
assert.deepEqual(fmBare.data.related, [], 'related 缺省为空数组')
assert.equal(fmBare.data.importance, '', 'importance 缺省为空(即"中")')
ok('[新增] frontmatter: related(数组, 支持块状列表) 与 importance(可选) 的解析/渲染/幂等')

// ── 45. append 合并 related/importance ───────────────────────────────────────
reset()
ensureRoot(root)
await writeMemory(root, 'a/x.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\nrelated: [old.md]\nimportance: 高\n---\n\n# X\n\n- 原有\n', 'create')
await writeMemory(root, 'a/x.md', '---\ntags: [t2]\nupdated: 2026-09-27\nsource: 实测\nrelated: [new.md]\n---\n\n- 新增一条\n', 'append')
const fmMerged = parseFrontmatter(fs.readFileSync(path.join(root, 'a', 'x.md'), 'utf8')).data
assert.deepEqual(fmMerged.related, ['old.md', 'new.md'], 'related 应取并集, 不丢原有')
assert.equal(fmMerged.importance, '高', '追加方没标 importance 时应保留原值')
ok('[新增] append 合并: related 取并集, importance 不被一次追加抹掉')

// ── 46. 计数缓存: 增量维护必须与全量重算一致 ─────────────────────────────────
reset()
clearCountCache()
for (let i = 0; i < 5; i += 1) {
  write(`d${i % 2}/f${i}.md`, '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# F\n\n- x\n')
}
ensureRoot(root)
assert.equal(cachedCounts(root).get(root), 5, '全量算出的根计数应为 5')
await writeMemory(root, 'd0/new.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# N\n\n- y\n', 'create')
assert.equal(cachedCounts(root).get(root), 6, '新增后根计数应 +1(增量, 未重扫全库)')
assert.equal(cachedCounts(root).get(path.join(root, 'd0')), 4, 'd0 的计数也应 +1')
assert.equal(cachedCounts(root).get(path.join(root, 'd1')), 2, 'd1 不该受影响')
await deleteMemory(root, 'd0/new.md', false)
assert.equal(cachedCounts(root).get(root), 5, '删除后根计数应 -1')
// 关键断言: 增量维护的结果必须与"全量重算"逐项一致, 否则缓存就成了错的数据源
const incr = [...cachedCounts(root).entries()].sort()
const full = [...refreshCounts(root).entries()].sort()
assert.deepEqual(incr, full, '增量维护的结果必须与全量重算完全一致')
ok('[新增] 计数缓存: 写入/删除增量维护, 结果与全量重算逐项一致(写入不再 O(全库))')

// ── 47. findDuplicateGroups: 共同前缀也是一条判据 ───────────────────────────
reset()
ensureRoot(root)
// 实测发现的漏报: 纯字符集 Jaccard 对中文长文件名太苛刻。
// Jaccard("记忆库-旧知识图谱方案已废弃", "记忆库-文件式方案") 只有 0.353 —— 明显同族却不报。
write('c/记忆库-旧知识图谱方案已废弃.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# A\n')
write('c/记忆库-文件式方案.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# B\n')
write('c/Motrix-MCP配置与RPC密钥.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# C\n')
write('c/Motrix-安装与任务状态.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# D\n')
write('c/完全另起一题.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# E\n')
ensureRoot(root)
const dupGroups = await findDuplicateGroups(root, path.join(root, 'c'))
assert.equal(dupGroups.length, 2, `应找出 2 组(记忆库-* / Motrix-*), 实际 ${JSON.stringify(dupGroups)}`)
assert.ok(dupGroups.every((g) => g.length === 2), '每组应为 2 个文件')
for (const g of dupGroups) {
  assert.ok(!g.some((p) => p.includes('完全另起一题')), '无关文件不该被并进来')
}
ok('[修复] findDuplicateGroups: 共同前缀也是判据(纯 Jaccard 漏报中文长文件名)')

// ── 48. 瞬时 readdir 失败不得擦掉 INDEX(fail-closed) ────────────────────────
reset()
ensureRoot(root)
write('q/a.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# A\n\n- x\n')
write('q/b.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# B\n\n- y\n')
ensureRoot(root)
updateIndexChain(root, path.join(root, 'q'))
assert.ok(read('q/INDEX.md').includes('a.md'), '前置: INDEX 里应有 a.md')
// 注入一次瞬时失败(模拟杀软实时扫描 / 文件被占用 / 权限抖动)
const origReaddir = fs.readdirSync
let injected = 0
fs.readdirSync = function (p, opts) {
  if (String(p) === path.join(root, 'q')) {
    injected += 1
    const e = new Error('EBUSY: resource busy or locked')
    e.code = 'EBUSY'
    throw e
  }
  return origReaddir.call(this, p, opts)
}
try {
  assert.equal(indexIsStale(root, path.join(root, 'q')), false, '读不到时不该判定 INDEX 过时')
  assert.equal(updateIndexChain(root, path.join(root, 'q')).length, 0, '读不到时不该重建任何一层')
  assert.equal(countMdFiles(path.join(root, 'q')), -1, '读不到时计数返回 -1, 与"空目录的 0"区分开')
} finally {
  fs.readdirSync = origReaddir
}
assert.ok(injected > 0, '前置: 故障确实注入过')
assert.ok(read('q/INDEX.md').includes('a.md'), '瞬时读失败绝不能把 INDEX 条目擦掉(修复前会擦成 0 条)')
assert.equal(countMdFiles(path.join(root, 'q')), 2, '故障解除后计数恢复正常')
ok('[修复] 瞬时 readdir 失败不再擦掉 INDEX(fail-closed): 读不到 != 是空的')

// ── 49. 自愈路径必须刷新计数缓存(否则"读时修好、写时写坏") ──────────────────
reset()
clearCountCache()
ensureRoot(root)
await writeMemory(root, 'x/one.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 1\n\n- a\n', 'create')
assert.equal(cachedCounts(root).get(root), 1, '前置: 缓存里 1 个')
// 外部(编辑器)新增一个文件, 完全不经过工具 -> 缓存与磁盘失同步
write('x/外部新增.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 2\n\n- b\n')
assert.equal(cachedCounts(root).get(root), 1, '前置: 此时缓存确实陈旧')
// memory_read 的自愈路径
if (indexIsStale(root, path.join(root, 'x'))) updateIndexChain(root, path.join(root, 'x'))
assert.equal(cachedCounts(root).get(root), 2, '自愈后缓存必须一起刷新, 否则下次写入会用旧计数把 INDEX 写坏')
await writeMemory(root, 'y/two.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# 3\n\n- c\n', 'create')
assert.equal(cachedCounts(root).get(root), 3, '后续写入继续基于正确计数')
const rows = (read('INDEX.md').match(/\|\s*\[x\/\]/g) ?? []).length
assert.equal(rows, 1, '根 INDEX 应列出 x/ 一行')
ok('[修复] 自愈路径刷新计数缓存(此前"读时修好、写时写坏"循环)')

// ── 50. 目录递归删除要连非 md 附件一起备份 ──────────────────────────────────
reset()
ensureRoot(root)
await writeMemory(root, 'd/a.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# A\n\n- x\n', 'create')
// 放一个真正的"二进制附件"(PNG 头 + 任意字节), 不是文本
fs.writeFileSync(path.join(root, 'd', 'screenshot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]))
await deleteMemory(root, 'd', true)
const trashed = fs.readdirSync(path.join(root, '.trash'))
assert.ok(
  trashed.some((n) => n.includes('screenshot.png')),
  `非 md 附件必须一起备份(此前会静默消失), 实际: ${trashed.join(', ')}`,
)
assert.ok(trashed.some((n) => n.includes('a.md')), 'md 文件同样要备份')
const pngBackup = trashed.find((n) => n.includes('screenshot.png'))
assert.equal(
  fs.readFileSync(path.join(root, '.trash', pngBackup)).length,
  11,
  '二进制内容要原样备份(用 copyFileSync, 不是读成文本)',
)
ok('[修复] 目录递归删除连非 md 附件一起备份(此前附件绕过 .trash 静默消失)')

// ── 51. A8: frontmatter 值净化 + updated 格式校验 ───────────────────────────
const dirtyFm = {
  present: true,
  tags: ['a,b', 'c[d]'],
  updated: '2026-02-30', // 格式对, 但 2026 年 2 月没有 30 号
  source: '实测\n换行',
  summary: 'x\ny',
  related: ['p,q.md'],
  importance: '高',
  extra: [],
}
const dirtyText = buildText(dirtyFm, '# T\n\n- x\n')
const cleanFm = parseFrontmatter(dirtyText).data
assert.equal(cleanFm.tags.length, 2, `含逗号的 tag 不该被切成 3 个, 实际 ${JSON.stringify(cleanFm.tags)}`)
assert.deepEqual(cleanFm.related, ['p、q.md'], 'related 里的半角逗号应被净化成顿号(不参与分隔)')
assert.equal(cleanFm.updated, today(), '2026-02-30 是无效日期, 应回退到今天')
assert.equal(cleanFm.source, '实测 换行', 'source 里的换行应被压成空格')
assert.equal(cleanFm.summary, 'x y', 'summary 里的换行应被压成空格')
// 净化之后必须幂等, 否则每次写入都会漂移
const cleanRound = parseFrontmatter(dirtyText)
const cleanAgain = buildText(cleanRound.data, cleanRound.body)
assert.equal(buildText(parseFrontmatter(cleanAgain).data, parseFrontmatter(cleanAgain).body), cleanAgain)
// 闰年边界: 2024-02-29 合法, 2026-02-29 不合法
assert.equal(normalizeUpdated('2024-02-29'), '2024-02-29', '闰年 2-29 是合法日期')
assert.equal(normalizeUpdated('2026-02-29'), today(), '平年 2-29 应回退')
assert.equal(normalizeUpdated('2026-13-01'), today(), '13 月应回退')
assert.equal(normalizeUpdated('乱七八糟'), today(), '非日期应回退')
ok('[新增] A8: frontmatter 值净化(逗号/方括号不再破坏解析) + updated 日期真实性校验')

// ── 52. A8: since 挡掉的文件必须上报 ────────────────────────────────────────
reset()
ensureRoot(root)
write('s/有日期.md', '---\ntags: [t]\nupdated: 2026-09-27\nsource: 实测\n---\n\n# A\n\n- 关键词\n')
write('s/无日期.md', '---\ntags: [t]\nsource: 实测\n---\n\n# B\n\n- 关键词\n')
write('s/很旧.md', '---\ntags: [t]\nupdated: 2020-01-01\nsource: 实测\n---\n\n# C\n\n- 关键词\n')
ensureRoot(root)
const sinceFilterStats = {}
const sinceFiltered = await searchFiles(root, root, '关键词', { searchBody: true, since: '2026-09-01', stats: sinceFilterStats })
assert.equal(sinceFiltered.length, 1, '只有带新日期的那个该命中')
assert.equal(sinceFilterStats.missingDate, 1, '应记录 1 个缺少 updated 的(它们本来能搜到, 不该静默消失)')
assert.equal(sinceFilterStats.olderThanSince, 1, '应记录 1 个日期早于 since 的')
assert.equal(sinceSkipNote({}), '', '没有排除项时不加噪音')
assert.ok(sinceSkipNote(sinceFilterStats).includes('缺少 updated'), '提示里要说清排除原因')
ok('[新增] A8: since 挡掉的文件数会分别记账并上报(缺日期 != 日期太早)')

// ── 53. A8: patchMemory 等价替换不写盘、不刷 updated ────────────────────────
reset()
ensureRoot(root)
const patchFixed = '---\ntags: [t]\nupdated: 2020-01-01\nsource: 实测\n---\n\n# A\n\n- 旧值\n'
write('p/a.md', patchFixed)
const prSame = await patchMemory(root, 'p/a.md', '旧值', '旧值')
assert.equal(prSame.unchanged, true, '等价替换应标记为无变化')
assert.equal(read('p/a.md'), patchFixed, '文件内容不该变')
assert.ok(read('p/a.md').includes('updated: 2020-01-01'), '尤其不该刷新 updated')
assert.equal(fs.existsSync(path.join(root, '.trash')), false, '也不该产生备份')
const prReal = await patchMemory(root, 'p/a.md', '旧值', '新值')
assert.equal(prReal.unchanged, false, '真正改写时 unchanged 应为 false')
assert.ok(read('p/a.md').includes(`updated: ${today()}`), '真正改写后才刷新 updated')
ok('[新增] A8: patchMemory 等价替换不写盘、不刷 updated、不产生备份')

fs.rmSync(TMP, { recursive: true, force: true })
fs.rmSync(OUTSIDE, { recursive: true, force: true })
process.stdout.write(`\n全部通过: ${passed} 项${skipped > 0 ? `, 跳过 ${skipped} 项` : ''}\n`)
