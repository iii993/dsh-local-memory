# @dsh-external/tool-memory

给 DeepSeek Harness（DSH）用的**文件式长期记忆库**：把 agent 的长期记忆存成本机真实文件夹里的 Markdown 文件，而不是单个 JSONL 知识图谱。

无常驻进程、无外部二进制依赖（只用 `node:fs`）、无向量库、无 SQLite —— 装在 DSH 进程里的一个 cordis 插件。

## 为什么不用知识图谱 MCP

以官方的 `@modelcontextprotocol/server-memory` 为例，实测下来的问题：

| 问题 | 说明 |
|---|---|
| 每次查询 O(N) | `loadGraph()` 每搜一次就把整个文件读一遍并逐行 `JSON.parse`，无缓存无索引 |
| 上下文爆炸 | `search_nodes` 命中就返回**整个实体**（含全部 observations）。实测某个实体塞了 28 条，搜「抓包」一次吐出 28 条 |
| 分类被正文污染 | 匹配是三字段子串（name / entityType / observations），正文里提到「工具」的实体会被误捞进「工具」分类 |
| 没有真层级 | 「文件夹」只能靠 `entityType` 平铺 + 命名约定硬凑 |
| 没有相关性排序 | 命中过多时无法收窄 |
| 多一个常驻进程 | MCP 要单独起一个 node 进程 |

换成文件后的收益：**按需读取**（先拿文件名列表，再只读命中的那个）、真层级目录、文件名即索引、正文用 grep 兜底、零常驻进程、人可读可编辑可 git、还能放截图等非文本附件。

## 设计

```
<MEMORY_ROOT>/
├─ INDEX.md                    # 根清单
├─ 技能/
│  ├─ INDEX.md
│  └─ 浏览器/
│     ├─ INDEX.md
│     └─ chrome-devtools-抓包.md
├─ 电脑操作/
├─ 环境/
├─ 工具/
├─ API/
├─ 项目/
└─ 用户偏好/
```

三条核心规则：

1. **一个文件 = 一个主题**，建议 3~8 条要点。这是控制单次读取上下文量的关键。
2. **文件名里必须包含将来会被搜到的关键词** —— 文件名就是索引（配合 Everything / `memory_search`）。
3. **每层目录一个 `INDEX.md`，只列本层直接子项，不递归**。逐层下钻时每步的读取量都是常数级。

`INDEX.md` 的内容**全部由文件系统推导**，所以 `memory_reindex` 可以无损重建。唯一的人工可写点是每个 `INDEX.md` 顶部的 `> 说明:` 行（重建时保留）。想让某个文件在 INDEX 里显示更好的说明？写它 frontmatter 的 `summary` 字段 —— 单一数据源。

## 代码结构

依赖方向**单向**：`shared → core → subagent → tools → index`，没有循环。

```
src/
├─ shared/            纯工具，不认识"记忆"这个概念
│  ├─ constants.ts    保留名与上限（INDEX.md / .trash / .dshlock / 各超时 / 并发与字节上限）
│  ├─ text.ts         日期、显示宽度、尺寸格式化；isOutside（纯字符串判断）
│  ├─ fsx.ts          容错读、原子写、fs 错误的中文描述
│  ├─ async.ts        sleep / mapLimit
│  ├─ paths.ts        根目录解析与**路径越界防护**（safeResolve + 符号链接复查）
│  └─ types.ts        MemoryConfig
├─ core/              记忆库逻辑
│  ├─ frontmatter.ts  极小子集 YAML 的解析 / 渲染 / 写入侧净化 / 日期校验
│  ├─ count-cache.ts  目录条目数与增量缓存（"读不到" != "是空的"）
│  ├─ index-file.ts   INDEX 渲染、漂移检测、重建链、ensureRoot
│  ├─ search.ts       遍历、按 mtime+size 失效的内容缓存、匹配器、searchFiles
│  ├─ append.ts       append 模式的**按要点**去重
│  ├─ similar.ts      文件名相似度（Jaccard + 共同前缀），只产出候选
│  ├─ write.ts        writeMemory / patchMemory / deleteMemory（工具与子代理共用）
│  ├─ lock.ts         跨进程写锁（锁文件里记持有者 pid/host）
│  └─ trash.ts        .trash 回收站：备份、修剪、统计
├─ subagent/          三个子代理
│  ├─ kit.ts          共用内部工具（白名单 search/read）与文本助手
│  ├─ loop.ts         通用循环：驱动 llm.stream、拼 chunk、执行工具调用、卡三种上限
│  ├─ recall.ts       检索子代理
│  ├─ remember.ts     写入子代理（查重后决定 create/append/patch/delete）
│  └─ gc.ts           整理子代理（默认只读，apply 才给写工具）
├─ tools.ts           9 个工具的定义与注册
└─ index.ts           纯入口：name / inject / Config / apply（76 行）
```

`index.ts` 用 `export *` 把各模块的公开面原样透出，所以 `lib/index.js` 的导出清单与拆分前
（近 3900 行的单文件）**完全一致** —— 逐个列名一旦漏一个就会悄悄破坏兼容，而测试未必覆盖到。

记忆文件的格式：

```markdown
---
tags: [chrome-devtools, 抓包, 网络分析]
updated: 2026-09-27
source: 实测
summary: chrome-devtools 抓包的三条命令与两个坑
---

# chrome-devtools 抓包

## 要点

- `list_network_requests({ pageId, resourceTypes: ["xhr","fetch"] })` 只看接口
- 枚举**小写**：document/stylesheet/image/.../xhr/fetch/...

## 坑

- 响应体过长会被截断，用 `requestFilePath` / `responseFilePath` 导出
```

`tags` / `updated` / `source` 必填，`summary` 可选。`source` 取值：`实测` / `官方文档` / `用户告知` / `推断`。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_recall` | **子代理检索（默认入口）**。传自然语言意图，插件在**白板子代理**里跑检索（最多 6 轮 / 45 秒 / 单轮 2000 token），返回它**实际读过的文件原文**。返回物由操作日志决定、不是子代理的总结——不会被润色或漏掉；超出上限的文件只列路径并报数。读取时会留意**同一主题被写成多个文件**，发现就用 `memory_report` 报告（进返回物）。猜不到关键词时它有**两条退路**：读 `INDEX.md` 逐层导航、或用空 `query` 列目录——INDEX 只用于导航，**不会作为"内容"进返回物**。子代理不可用时自动回退到确定性检索并明确标注 |
| `memory_remember` | **写入（默认入口）**。把内容交给**写入子代理**：它先查重（避免同一主题堆出多个文件），再决定 `create` / `append` / `patch`，需要作废整条旧记忆时才 `delete`（**理由必填**）。返回物是客观操作记录 + **写入后盘上的实际内容**（回读，不是回显输入）。删除会醒目列出**理由和 `.trash/` 备份路径**——所以删除是**可恢复**的 |
| `memory_gc` | **体检 / 整理**。由整理子代理跑：找同主题多文件、可能过时的内容、缺失 frontmatter、命名不规范。默认**只读**；`apply: true` 才允许动手（重建 INDEX、补 frontmatter、**合并明显重复的文件**）。删除同样必须带理由并列出备份路径 |
| `memory_search` | 搜索。**返回文件路径 + 命中类型 + 大小 + 日期 + 一句话说明（`summary`，缺失时回退正文标题），不返回正文**，由模型决定读哪一个。⚠️ **一般不要直接用它**——探索性检索优先 `memory_recall`；只有需要自己核对候选列表、或 recall 的节选不够精确时才直接调。`query` 的命中范围 = 文件名 + `tags` + 正文（`updated`/`source` 等元数据排除在外，否则搜"实测"会全线命中）；**多词组合按分隔符（空格 / 斜杠 / 竖线 / 逗号）自动拆开 OR**——`"chrome 抓包"` = `chrome` 或 `抓包`，整串精确命中仍优先。长中文串（如 `"网络请求分析"`）**不做拆分**：那是语义判断，交给 `memory_recall` 的子代理；0 命中时会列出库里已有的相关 `tags` 作为跳板。`regex: true` 时按正则处理（等价 `gi`）。**`query` 传空串 = 列目录**（配 `scope` 用）。排序默认 `relevance`（文件名命中 > 标签命中 > 整串精确命中 > 正文命中数 > `updated`，**从不拿文件体积当权重**），`sort="updated"` 切成纯时间视图，`since="YYYY-MM-DD"` 只看某日之后的 |
| `memory_read` | 传文件返回内容；传目录返回该层 `INDEX.md`（逐层下钻入口）。发现索引漂移会自动重建该层并向上更新链 |
| `memory_write` | 写入。自动建目录、自动更新 INDEX 链；`mode=append` 按要点去重追加 |
| `memory_patch` | 局部改写：把文件里**唯一出现**的一段文本换成新文本。改错别字 / 更新某个数值用它，比"读全文再整文件覆盖"省上下文，也不容易误伤别处 |
| `memory_delete` | 删除文件/空目录并同步 INDEX；禁止删根目录、禁止单独删 `INDEX.md` |
| `memory_reindex` | 从实际文件系统重建 `INDEX.md`（修复 git 切换、手工增删造成的索引漂移） |

### 子代理检索：`memory_recall`

**为什么需要它**：主 agent 的**每一轮请求都要重发全部工具定义**——本机实测约 **50K token**。
按传统做法（读 INDEX → search → read → 再试一轮）做一次探索式检索要走 4~8 轮，
光这一项就是几百 K token 的重复提交；而且中间结果（读错的文件、30 条候选列表）会**永久留在主上下文**，
之后每轮对话都要再发一次。

`memory_recall` 把这段过程挪进一个**白板子代理**：它只挂 3 个工具（`memory_search` / `memory_read` / `memory_report`，几百 token）+ 一段极短系统提示，
由插件内部用 `llm.stream` 驱动。工具定义那一项的开销因此从 `轮数 × 50K` 变成 `轮数 × 0.5K`。

**硬性上限**（都在代码层，不依赖提示词——提示词层面的约束在压力下不可靠）：

| 项 | 值 | 说明 |
|---|---|---|
| 轮数 | 6 | 撞上限属于"半成功"：已读到的内容照常返回 |
| 总超时 | 45s | 同上 |
| 单文件返回 | 8 KB | 超出截断并标注 `已截断: 全文 X` |
| 返回文件数 | 默认 5，上限 8 | 超出的只列路径并报数，绝不静默丢弃 |
| 子代理单文件预览 | 6 KB | 它只需够判断相关性；读全文是插件替主 agent 做的 |

**两个关键设计**：

1. **工具走白名单**：只认 `memory_search` / `memory_read`。这同时挡住了递归（白名单里没有 `memory_recall` 自己）
   和工具泄漏（子代理碰不到 `memory_write`、`pwsh` 这些）。
2. **返回物由操作日志决定，不是子代理的总结**。子代理的表达能力只用于"决定读哪些"，
   返回的是插件按日志路径取回的原文——总结会漏会编，而"它实际读了哪些文件"是客观事实。
   返回物里还附一份**命中概览**（搜了什么、各命中几条），让主 agent 能判断这批内容是怎么被选出来的。

**降级**：`llm` 服务不可用、或首次调用就抛错时，自动回退到**零模型成本的确定性检索**
（拆词 + 多路 OR 打分，返回 Top-3 的说明 + 前 15 行），并在结果前明确标注。
撞上限或超时**不**降级——那属于半成功，日志里已读到的内容照常返回。

### frontmatter 字段

| 字段 | 必填 | 作用 |
|---|---|---|
| `tags` | ✅ | 检索关键词。**同义说法一并写进去**——检索是纯子串匹配，没有同义词扩展 |
| `updated` | ✅ | 日期。**由插件强制设为写入当天**：写入方（尤其是子代理）是 LLM，它不知道今天是几号，实测写出过差一天的日期 |
| `source` | ✅ | `实测` / `官方文档` / `用户告知` / `推断`。**这就是置信度**——前两者是验证过的事实，"推断"是猜想。不再另设 `confidence` 字段：多一个字段只会多一种和 `source` 矛盾的可能 |
| `summary` | — | 一句话说明，显示在上级 INDEX 的说明列（**单一数据源**） |
| `related` | — | **显式关联**的其它记忆路径（如 `["技能/浏览器/chrome-devtools-抓包.md"]`）。检索返回时会显示**引用**与**← 被引用**（反向引用只在已读到的文件范围内算，不为此扫全库） |
| `importance` | — | `高` / `低`，**缺省即"中"**。返回物会显示它，帮你决定先看哪条；**不参与检索排序**（排序规则要保持可解释） |

**为什么值得单独有 `related`**：靠 `tags` 和目录只能得到**隐式**关联——那是搜索引擎在猜。
而"这条是那条的前提""这两个必须一起看"是**作者才知道的事实**，需要一个字段明确表达。
它比 tags 强的地方在于：tags 说"可能相关"，`related` 说"我断言它们有关系"。

### 2000 文件规模的实测与两个没采纳的方案

| 操作（2000 文件 / 40 目录） | 耗时 |
|---|---|
| 冷缓存搜索 | **802 ms** |
| ↳ 其中只 `readdir` 全树 | 9 ms |
| ↳ 其中 `stat` 全部文件 | 171 ms |
| ↳ 其中读全部正文 | 404 ms |
| 热缓存搜索 | 189 ms |
| 一次写入 | 44 ms |

**① 没有把搜索缓存持久化到 `.cache/`**

只持久化"路径 + mtime + size"的话，能省掉的只有 `readdir` 那 **9 ms**——
`stat` 省不掉（要判断文件变没变），正文更省不掉（没有缓存正文）。**收益约 1%**，
却多一个可能与实际不符的状态文件。

要真省下那 400 ms 就必须连正文一起缓存，但那样 **Markdown 就不再是唯一数据源**：
索引和文件一旦不一致，搜索会给出"文件里根本没有的内容"。这个插件整个建立在
"文件夹就是数据库"上，不值得为 400 ms 破例。

**② 没有用"目录 mtime 没变"做计数缓存的失效信号**

这个方案**不成立**：父目录的 mtime **不反映子树变化**——在 `A/B/` 下新建文件只改 `B` 的 mtime，
`A` 的纹丝不动，于是 `visit(A)` 会复用旧的递归计数、**漏掉整棵子树**。

实际做法是**让写入方自己当失效信号**：写入路径本来就知道这次变了几个文件，
沿目录链 `±1` 即可（`shiftCounts`）。实测 2000 文件时省 2~9 ms（写入的 4%~20%），
**收益随库规模线性增长**，上万文件时才明显。
对外部改动（编辑器里手工增删）则**不信任缓存**：`updateIndexChain` 不传表时一律全量重算，
`memory_read` 的漂移检测与 `memory_reindex` 也走全量路径。

### 安全性：`.trash` 回收站与写锁

- **`replace` / `memory_patch` / `memory_delete` 覆盖或删除前，原文件都会先备份到 `<MEMORY_ROOT>/.trash/`**，
  文件名形如 `2026-09-28T00-01-30-123Z__技能__性能__xxx.md`（保留原相对路径，方便认领）。
  `.trash/` 以 `.` 开头，所以不进 `INDEX.md`、不进搜索、也不算记忆条目。
  **它有 200 份的数量上限**（超出时按时间顺序淘汰最旧的，见 `pruneTrash`）——所以不会无限膨胀，
  但也因此**不能当版本控制**，重要内容仍要另行备份。`memory_reindex` 的返回里会报出
  它当前的份数与体积，确认不需要时手动清空：

  ```powershell
  Remove-Item '<MEMORY_ROOT>\.trash\*' -Recurse -Force   # Windows
  ```
  ```bash
  rm -rf '<MEMORY_ROOT>/.trash/'*                        # Linux / macOS
  ```
- **`create` 的存在性检查在锁内复查**：锁外那次 `exists` 只是快照 —— 两个进程同时 `create` 同一个文件时
  双方都会看到"不存在"并一起通过检查，然后依次拿锁写入，后者静默覆盖前者。所以进锁后必须再查一次。
- **写操作用 `open(..., 'wx')` 建一个 `<文件>.dshlock` 轻量锁**把自己串行化。
  `isConcurrencySafe: false` 只管得住同一进程内的工具调度；多个 DSH 实例共享同一个 `MEMORY_ROOT` 时，
  两个 `append` 各自"读-改-写"会互相覆盖（原子写只保证文件不写坏，不保证内容不丢）。
  拿不到锁会短暂重试，超时（3 秒）和遇到陈旧锁（>10 秒，持有者进程崩了）都有明确中文提示。
- 锁之外还有**乐观并发检查**兜底：`append` / `patch` 落盘前复查 `mtime + size`，变了就中止写入。
  这道检查拦的是**不遵守锁**的修改者 —— 比如你正在编辑器里改同一个文件。

`replace` 依然是破坏性操作，有 `.trash` 兜底也**别把它当版本控制**：库要是不在 git 下，重要内容请定期提交或整体拷走。

所有 `path` 参数都会**逐段**做越界校验：拒绝 `..` 穿越、绝对路径越界，以及指向库外的符号链接（含指向**尚不存在目标**的悬空链接）。

写入一律走「临时文件 + `rename`」原子替换，避免写到一半留下半截文件；`memory_write` 的 `append` 按**单元**去重（代码块整块 / 标题 / 要点 / 段落），而不是按行——按行去重会把新代码块里与原文相同的行（比如 `import` 语句）静默删掉。

以 `.` 开头的隐藏文件与目录不进 `INDEX.md`、也不进搜索结果。

## 别人要用需要什么

**不需要任何额外的插件或 MCP。** 插件本体只 import 这么几样：

| 依赖 | 来源 | 要额外装吗 |
|---|---|---|
| `node:fs` / `node:os` / `node:path` | Node 内置 | 不用 |
| `@deepseek-ai/dsh-tools`（`defineTool`） | DSH 自带 | 不用 |
| `@deepseek-ai/schemastery`（声明 `Config`） | DSH 自带 | 不用 |
| `cordis`（插件宿主，仅类型） | DSH 自带 | 不用 |

没有常驻进程、没有外部二进制（不需要 `rg` / `es.exe`）、没有向量库、没有 SQLite。

**必需的三样：**

1. **DSH 本体** —— 插件只 `inject: ['tools']`，任何 profile 都能挂。
2. **Node ≥ 22.19**（见 `engines`）。
3. **clone 之后先在这个仓库目录跑一次 `pnpm install`**（`npm install` 也行）。

第 3 条不是可选项，是实测出来的硬前提：DSH 加载**本地插件**时，模块解析的起点是**插件自己的目录**
（即使它被 `link:` 到 profile 下，Node 也会 realpath 回源码目录）。所以插件目录里必须有能在
`node_modules` 里解析到的 `@deepseek-ai/dsh-tools`，否则激活直接失败：

```
probe-nodeps (@dsh-external/probe-nodeps): failed to import
Cannot find package '@deepseek-ai/dsh-tools' imported from ...\index.js
```

仓库里已经提交了构建产物 `lib/index.js`，所以 `pnpm build` 可以跳过；但 `pnpm install` 不能跳。

**可选（只是检索手感更好，缺了不影响功能）：**

- **Everything MCP**（`mcp__everything__search`）—— 全盘按文件名秒级搜索。注意 `es.exe` **不支持 GUI 的
  `path:` 运算符**，必须用 `in_path`（递归）/ `parent`（非递归）；没有它也能用 `memory_search` 同时搜文件名与正文。
- **任意 grep 工具** —— 正文兜底检索。

**还有一件事：告诉 agent 怎么用。** 插件只提供工具，"先读 `INDEX.md` 逐层下钻""一个文件一个主题
（3~8 条）""文件名要含关键词""别整目录读"这些规矩得写进 agent 的规则文件里，否则它会当普通文件系统乱翻。
本仓库提供了可直接复制的版本：[docs/AGENTS-记忆库规则.md](./docs/AGENTS-记忆库规则.md)，把它按需删减后
放进你自己的 `AGENTS.md` 即可。

## 安装

```bash
cd <本仓库>
pnpm install
pnpm build          # tsc -> lib/index.js
pnpm test           # 跑 test/check.mjs（22 项断言，含各回归用例）
```

然后在 DSH 里安装这个 bundle（用 `plugin_manager` 工具，`target` 传本仓库的绝对路径）：

```
plugin_manager({ action: "install_bundle", target: "<本仓库绝对路径>" })
```

或者手工在 profile 的 `package.json` 里加依赖和 bundle，再 `pnpm install`。

## 配置

`MEMORY_ROOT` 解析优先级（高 → 低）：

1. 环境变量 `DSH_MEMORY_DIR`
2. 插件 config 的 `memoryRoot`
3. `$DSH_HOME/memory`；`$DSH_HOME` 未设置时回退 `~/.dsh/memory`

```yaml
# profile 的 cordis.patch.yml
- insert:
    - id: tool-memory
      name: '@dsh-external/tool-memory'
      config:
        memoryRoot: 'D:\my-memory'
```

> 不要把记忆库放在 npm 包安装目录里：`npm update -g` / 重装会直接清空，记忆会全丢。

## 性能

测试方法：Windows / Node 24，同一台机器，与 git 历史里的版本对照。这台机器的 wall-time 波动能到 3 倍
（大概是杀软实时扫描），所以**一律取多次运行的"最小值"**（基准测试的常规做法：最小值最接近未被打断的真实耗时）。

### 1000 个文件 / 262 KB（12 次 × 3 组取最小）

| 操作 | 初版 | 现在 |
|---|---|---|
| 搜索（含正文） | 273 ms | **52 ms**（5.2×） |
| 搜索（仅文件名） | 243 ms | **44 ms**（5.5×） |
| 写一条记忆的索引开销 | 25 ms | 27 ms |
| 全库 `memory_reindex` | 255 ms | 362 ms |

### 真实规模：20 个文件 / 19 KB（40 次取最小）

| 操作 | 初版 | 现在 |
|---|---|---|
| 搜索（含正文） | 5.94 ms | **1.32 ms**（4.5×） |
| 搜索（仅文件名） | 19.52 ms | **6.14 ms**（3.2×） |
| 写一条记忆的索引开销 | 30.32 ms | **17.82 ms**（1.7×） |

### 搜索为什么快

- **限流并发 I/O** —— 目录树并发展开，`stat` / `readFile` 最多 32 个在飞。同步串行跑 1000 次 `stat` 要
  216 ms，并发后 40–65 ms（纯 `readdir` 只占 3 ms，瓶颈一直在 `stat`）。
- **正文缓存** —— 键是绝对路径，用 `mtime + size` 判失效，Map 的插入顺序当 LRU（上限 2000 条）。
- **匹配器只构造一次** —— 正则不是每个文件编译一次。
- **名称匹配避开 `path.relative`** —— `scope` 前缀在循环外算一次，循环里只做 `slice`。1000 个文件时
  这一处就差出约 90 ms（是加 scope 匹配时我自己引入、又测出来的回归）。
- 写工具落盘后主动失效对应缓存（`invalidateSearchCache`），所以不存在"文件改了还搜到旧内容"。

### 写入侧（之前没量过，补上）

写一条记忆的代价 = **重建它所在目录到根的整条 INDEX 链**。根 INDEX 的"条目数"列是递归统计，
所以每次写入都要摸一遍全库目录树。

- `updateIndexChain` 现在**复用同一张条目数表**（`buildCountIndex` 一次遍历），而不是每层各递归统计一遍
  （旧写法是 O(深度 × 库规模)）。1000 文件库上 35 → 27 ms。
- 但全库 `memory_reindex` 比初版**慢**了（255 → 362 ms）：初版用 `writeFileSync` 直接截断写，现在每个
  INDEX 都走"临时文件 + `rename`"原子写，201 个 INDEX 就是 201 次额外 I/O。**这是拿时间换"不会留下
  半截文件"，是故意的。**
- 结论：**连续写入会线性叠加**。agent 一口气 append 20 条记忆就是 20 次链更新（真实规模下约 0.36 秒，
  可接受；上千文件的库要留意）。

### 一个被证伪的旧结论

早先这里写过"`content=false` 比 `content=true` 还慢，因为读前 16 KB 用了
`openSync`+`readSync`+`closeSync` 三次系统调用"——**那个归因是错的**。实测 1000 个文件下
`readTextPrefix`（203 ms）反而比 `readFile`（275 ms）快，因为 `readFileSync` 内部自己还要 fstat 一次。
当初那组相反的数据来自"query 不命中的空结果路径"+ 测量噪声。`describeFile` 因此保留 `readTextPrefix`。

## 给 agent 的检索协议

成本从低到高，命中即停：

1. **目录导航**（最便宜）— `memory_read` 读 `INDEX.md`，逐层下钻，每次只读一个 INDEX。
2. **文件名检索** — `memory_search`，或 Everything 限定 `in_path` 到记忆库根（Everything 只搜文件名）。
3. **正文检索** — `grep` 工具搜记忆库目录（纯子串匹配，中文任意长度都能中）。
4. **读取** — 只读命中的那个文件，不要整目录读。

## License

MIT
