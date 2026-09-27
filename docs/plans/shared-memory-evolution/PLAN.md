# AgentRecall-X：共享记忆与可验证进化工程计划

版本：1.0 · 编写日期：2026-09-26 · 状态：待执行，不是已实现能力声明

本计划供一个主 agent 使用 Flywood／Plywood 编排实现、独立复核和最终验收。交接入口见 [HANDOFF.md](HANDOFF.md)，逐项验收契约见 [ACCEPTANCE.json](ACCEPTANCE.json)。三份文件必须一起移交。

本计划的编写阶段复核见 [REVIEW.md](REVIEW.md)；该复核仅针对计划质量，不表示产品实现或 47 项验收已经通过。

## 0. 执行摘要与不可误解的约定

目标不是“把 Markdown 同步到云端”，而是：**让获得授权的不同 agents，在不同项目、设备和 session 中，正确继承应当继承的经验，并用可验证的结果改善下一次行动。**

产品表达建议：

> AgentRecall — Give every agent a better starting point.  
> Your memory, across sessions, projects, and agents. Local or in your own cloud.

这里的跨项目意味着“适用且获授权的内容可以复用”，不意味着所有项目互相看到全部内容。Self-evolution 指有版本、证据和回滚的记忆／策略改进，不指模型权重自动训练，不指 agent 可以提升自身权限或修改验收标准。

### 0.1 本轮设计决策

1. 保留本地优先、用户拥有数据；增加真正可独立运行的 Supabase 云端权威存储。
2. 每个共享 namespace 只有一个权威后端。云模式下本地副本是缓存／待提交队列，不是另一个冲突时悄悄获胜的真相源。
3. session_start、remember、recall、check、session_end 以及它们的派生数据必须走一致的存储契约。
4. 默认五个 MCP 工具不膨胀；管理、迁移、审计和回滚走 CLI／SDK 管理接口。新增参数与命令须有明确契约和兼容测试。
5. 第一版采用显式操作的后台任务 runner；可选调度安装单独授权。无需先搭建托管 SaaS、Web 控制台或新 agent 框架。
6. 先证明共享和隔离正确，再证明经验更新确实有用。向量检索可选，不是使用云端 SQL 的前置条件。
7. 原有 local palace Markdown 与 Obsidian 格式保留；原始 transcript 默认不上传。
8. 文中阈值是本计划提出的验收目标，不是现有实测表现。

### 0.2 三种验收结论，不能混用

| 结论 | 必须满足 | 允许对外说什么 |
|---|---|---|
| ENGINEERING_ACCEPTED | ACCEPTANCE.json 中所有 engineering_required 用例 PASS，真实云端和真实主机用例不跳过 | 支持经过测试的本地／云端共享记忆、隔离、交接和可审计的经验更新机制 |
| EVOLUTION_VALIDATED | ENGINEERING_ACCEPTED，加所有 evolution_required 用例 PASS | 在报告注明的模型、任务集和条件下，经验更新带来测得的改善 |
| READY_FOR_OWNER_RELEASE | 上述工程门槛，加 release_required 全部 PASS；独立 reviewer 和 verifier 签字 | 可以提交给 owner 决定是否发布；不等于已获 push／publish／deploy 权限 |

**完整愿景完成 = 三个结论全部成立。** 如果工程完成但实验无显著收益，最终状态写 PARTIAL_SUCCESS / EVOLUTION_NOT_DEMONSTRATED，而不是“全部完成”。没有足够数据是 INCONCLUSIVE，不是 PASS；真实云端凭据缺失是 BLOCKED，不是模拟通过。

单用例结果只允许 PASS、FAIL、BLOCKED、NOT_RUN。SKIPPED 不计入通过。所有 required 用例禁止临时变成 optional；有需要必须形成新计划版本、解释原因、取得 owner 确认，并保留原失败结果。

### 0.3 北极星演示

1. 用户 U 在项目 Alpha、主机 H1、agent A 中明确纠正：“本项目的发布必须先审批。”
2. 通过经过确认的入口保存为 Alpha 的显式约束，拿到云端 committed 回执。
3. 主机 H2 没有 H1 的文件、缓存或 transcript。agent B 在新的 session 中启动 Alpha，读取同一条约束及来源。
4. B 尝试发布：check 返回 blocked；在提供动作拦截的受控测试 adapter 中，模拟发布工具的调用次数为 0。
5. B 启动无关项目 Beta：不注入 Alpha 私有决定，也不把 Alpha 的发布限制误当作全局禁令。
6. 用户另存“回答默认用中文”为授权范围内的个人偏好；B 在 Alpha、Beta 都能读到，但另一用户 V 看不到。
7. 用户撤回 Alpha 约束。H2 下一次成功的新鲜读取不再返回它，其派生摘要也不继续传播它；离线时明确提示权限／约束状态未验证。
8. 另用一个允许学习的建议型规则展示：实际失败 → 候选 → 独立验证 → 新版本 → 后续任务表现记录 → 必要时回滚。

演示失败任何一环，不能靠 README、截图或 agent 自述补足。

## 1. 已核对的代码基线与差距

仓库：[Goldentrii/AgentRecall-X](https://github.com/Goldentrii/AgentRecall-X)。检查基线 commit：db6338a5d60a36ea9c38a58e1d22e8037d75f095；packages 版本：3.4.51。执行时必须重新记录 HEAD、分支和 dirty diff；不要假设仍然相同。

本计划编写时存在 README.md 与四个 package README 的未提交修改；属于已有工作，不能覆盖或当成已经发布。当前本地目录不是生产记忆库，生产记忆库更不能拿来跑破坏性测试。

下表的路径相对于仓库根目录；判断针对已检查的源代码，不声称已检查用户实际托管的数据库。

| 领域 | 代码证据 | 当前事实／需补齐 |
|---|---|---|
| MCP surface | packages/mcp-server/src/index.ts | 默认 5，--full 为 6，AR_EXTRAS=1 且 --full 为 13；当前是 stdio 服务，不是托管 HTTP Memory API |
| SDK | packages/sdk/src/agent-recall.ts；packages/core/src/types.ts | SDK root 最终依赖进程全局 setRoot；多个实例并发可能串库，必须实例化隔离 |
| 生命周期 | packages/core/src/tools-logic/session-start.ts、check-action.ts | 启动、纠错／行为策略读取仍大量依赖本地，不能把“云端 recall”当作完整云端生命周期 |
| 保存纠错 | packages/mcp-server/src/tools/remember.ts、check.ts；packages/core/src/storage/corrections.ts | remember 没有 correction 类型参数；结构化 human_correction 经 check 路径写入。迁移不能编造旧接口已有能力 |
| 云写入 | packages/core/src/supabase/sync.ts | 现有 sync 主要 fire-and-forget，缺统一持久回执、持久重试和 CAS。纠错导出辅助函数存在不等于主要写入路径已接通 |
| 云检索 | packages/core/src/supabase/recall-backend.ts | 可用性依赖 embedding provider；需支持不配 embedding 的云端关键词／精确读取 |
| 远端 schema | migration.sql | ar_entries、ar_insights、ar_sync_state；检查到的迁移没有完整 owner／workspace／revision／RLS 体系，file_path 不能作为跨设备身份 |
| 派生洞察 | packages/core/src/palace/insights-index.ts、supabase/sync.ts | 现有索引上传到 ar_entries 的 awareness 内容；没有找到完整 ar_insights 写入闭环，读写表必须统一 |
| 后端抽象 | packages/core/src/tools-logic/memory-backend.ts、recall-backend.ts | 前者是纠错 retain 导出接口，后者是搜索接口；都不是可以直接替代全生命周期存储的统一 Repository |
| 进化模块 | reports/2026-09-17-evolution-program-final-report.md | 已有 outcomes audit、implicit miner、association、activation、retier，不应重造；报告本身明确真实 uplift 不能宣称，数据密度不足 |
| 权威性与 tier | packages/core/src/tools-logic/retier.ts、check-action.ts | retier 的 gate tier／proposal 展示不等于真实审批门。--write 可持久化算出的 gate；实际动作判定另有逻辑，必须分别审计 |
| 跨平台质量 | package.json、各包脚本、现有测试 | 本次 Windows 检查遇到 chmod、URL pathname、路径／测试环境问题；历史 Linux 全绿报告不能替代当前 Windows 验收 |

执行 agent 在 P0 给每一条结论补当前 file:line、适用 commit 和复现方式。找不到证据时写 UNKNOWN，不能照抄本计划为事实。报告与源码冲突以可复现行为为准。

历史协议的模型版本、旧 MCP 工具数量和分支状态可能已过期。保留“独立 review、eval-first、隔离写入、权限门”原则，但不得调用不存在的模型／工具或把旧版本描述当作当前能力。

## 2. 范围、场景与非目标

### 2.1 必须支持的用户场景

- R01 跨 session：结束 S1 后，在 S2 恢复相关决定、约束、未完成事项和证据。
- R02 跨设备：H2 无 H1 数据，仍可经同一云权威库恢复授权内容。
- R03 跨项目：个人偏好与经过显式泛化的经验可以复用；项目私有内容默认不外溢。
- R04 跨 agents：A 写入、B 读取／交接，来源可追溯，B 不需要同一模型厂商。
- R05 存储选择：无云配置时全本地；云模式可不安装 embedding 模型、不提供 embedding API key。
- R06 正确写入：有版本、幂等、并发冲突、离线状态、重试、撤回和恢复能力。
- R07 访问安全：用户、workspace、project、可选 agent grant 都由可信服务端执行，不依赖 prompt 自觉。
- R08 信任安全：用户约束、agent 推断、检索到的外部内容具有不同权威性。
- R09 可验证进化：有来源的经验提议经过验证才进入生效路径，结果可被证伪。
- R10 可运营：迁移、诊断、备份、回滚、观察与用户控制完整。
- R11 诚实产品文档：每一项 README 承诺都有验收证据；不同 host 自动化能力明确区分。

### 2.2 第一版不做

公开多租户 SaaS／计费、复杂团队组织 UI、任意云数据库全面适配、CRDT 全文协作、端到端加密同时服务端全文检索、模型权重训练、自行修改系统权限、无人审批自动发布代码、任意第三方 host 强制动作拦截。

可以为通用 PostgreSQL 后端保留接口，但此次实测后端只包括 local 和 Supabase。可以使用 pgvector，但没有新数据证明收益前不重写整套检索算法。

跨 agent 不保证每个 host 都自动调用 lifecycle。没有 hook 的 host 必须标为 agent-driven，并实际测试调用率；只提供 MCP 不能保证模型永不漏调用。

## 3. 总体架构与明确的权威边界

~~~text
Host / Agent A, B, C
       │ MCP 五工具 / SDK / CLI 管理入口
       ▼
实例级 RuntimeContext + 身份验证 + 可访问范围
       │
       ├─ 显式约束解析 / 候选经验验证 / 交接
       ▼
MemoryRepository：统一读写、CAS、快照、事件与回执
       ├─ Local：兼容 Markdown + 原子记录／索引／恢复日志
       └─ Supabase：Postgres + Auth + RLS + 事务 RPC
                       │
                       └─ 派生投影、检索索引、可选 embeddings
       │
       └─ Outcome worker → 候选规则版本 → 独立评测 → 批准／回滚
~~~

这是逻辑结构，不要求新增微服务。本地 stdio MCP 进程可作为持有用户会话的云客户端；SDK 服务端也可复用同一 core。agent 不需要模型供应商替它跨 session 保管记忆。

### 3.1 两种运行模式

**local**

- 权威为用户选定的本地 root，已有宫殿 Markdown 保持可读可编辑。
- 默认零云 egress，包括 embeddings／遥测／自动更新副作用；任何联网增强均单独显式 opt-in。
- 为跨进程写入提供锁、原子提交与恢复机制。共享网络盘一致性不在承诺范围。
- 手工编辑 Markdown 由内容 hash／原版本检测转为新 revision，source 标为 external_edit；编辑本身不授予 explicit_user 权威。与 API 并发修改时显式 conflict／quarantine，不静默吞掉任一版本。显式约束的正文手改需受信确认后才替代旧有效约束。
- 本地逻辑 ACL 防止受限调用误读，不防御拥有同一 OS 账号完整文件访问权的恶意进程。已经下载的副本不能靠远端撤销凭空擦除；文档明确这一威胁模型边界。

**cloud**

- 已选择的共享 namespace 权威为 Supabase。
- 本地仅保留必要缓存、durable outbox 和用户明确保留的 local-only 私有层。
- 每条记录带存储可见性，local-only 记录不能悄悄成为 shared；原始日志不因切换模式自动上传。
- 云同步失败不是 local 模式自动接管。响应明确 authority、freshness、pending operations。
- 不配置 embedding key 仍支持 ID 读取、受权列表、冷启动、纠错、交接和基本中英检索。

### 3.2 应用范围与访问权限必须分开

| 维度 | 内容 | 判定者 |
|---|---|---|
| 身份 | owner_id、workspace_id、principal_id／agent grant | 服务端鉴权；不能相信 agent 参数 |
| 访问范围 | private、project、workspace、owner-shared | 服务端 ACL／RLS |
| 适用范围 | project_ids、任务类型、语言／工具条件、有效期 | core 显式规则匹配，可审计 |
| 来源 | agent_id、session_id、event_id、capture channel | 已认证调用链；自由文本 agent 名仅展示 |
| 权威性 | explicit_user、verified_observation、agent_inference、imported_untrusted | 受约束写入入口；不可由 content 自行授予 |

workspace 是边界，不默认等于全员可读。个人 owner-shared 偏好仅对该 owner 授权的 agent 可读，不默认共享给团队其他人。

跨项目泛化生成一条新记录，保留源 lineage 与审批，不改写原项目记录的 ACL。若该新记录泄露源项目机密，即使措辞概括也不得提升 scope。泛化前须检查脱敏与授权。

project_id 是稳定标识，slug／本地路径只是别名。两个设备的同一项目经显式映射关联；不同用户的同名目录不合并。无法归属的记录 quarantine，不落入“global”默认桶。

## 4. 数据模型与行为契约

表名／文件名可由 P0 ADR 调整；以下语义不可省略。

### 4.1 最小统一记录

~~~text
MemoryRecord
  id: stable UUID
  owner_id, workspace_id, project_id?
  kind: fact | decision | preference | constraint | experience | handoff
  visibility, applicability
  content, metadata
  authority, status: candidate | active | superseded | retracted | quarantined
  revision: positive integer
  source: {principal_id, agent_id, session_id, event_id, captured_at}
  evidence_refs[], derived_from[{id, revision}]
  created_at, updated_at, expires_at?
  supersedes?, retracted_at?, retraction_reason?
~~~

另有：

- MemoryEvent：append-only 的变更事件，含 operation_id、actor、old/new revision、change cursor；不默认保存完整私密正文。
- OutcomeEvent：task_id、session_id、memory_id + revision、是否注入、适用机会、实际动作、结果、证据、判定者和判定版本。
- SessionCheckpoint：目标、当前状态、决定、完成／未完成、阻塞、下一步、引用；不是伪造的“已执行证明”。
- ExperienceVersion：候选规则、来源、验证报告、适用范围、激活／回滚状态。
- OperationReceipt／OutboxEntry：幂等键、payload hash、状态、重试次数、最后错误、下一次重试时间。
- AccessGrant：主体、被允许的 workspace/project、读写／批准权限；令牌更新和撤销语义。
- MaterializedView：summary／awareness／索引派生物，记录源 revision 与 freshness，可丢弃重建。

底层可复用旧结构，不强制一次把全部存储搬进一个表。但所有对外可见的记忆必须能映射到上述身份、权限、状态和版本语义。raw archive 维持独立 local-only，禁止因为方便而整库上传。

### 4.2 Repository 与实例隔离

拟议逻辑接口，P0 用实际 TypeScript 类型定稿：

~~~text
createMemoryRuntime(config, trustedPrincipal) -> instance
repository.get(id, readContext)
repository.query(query, readContext)
repository.readSnapshot(readContext)
repository.mutate(command, expectedRevision, operationId, writeContext)
repository.readChanges(cursor, readContext)
repository.recordOutcome(event, operationId, writeContext)
repository.getOperation(operationId, principal)
~~~

readContext 中 agent 请求的 project 只是候选范围；真实可访问集合由身份与 grants 求交集。RuntimeContext 随调用显式传递，不能临时 swap 全局 root 后寄望 finally 恢复能抵抗并发。

旧 SDK 构造方式继续可用；新增 storage／identity 配置为增量。两个 SDK 实例使用不同 root、owner 或后端时，任何交错调用都不能串库。旧全局 helper 必须逐项包围或替换，不能只改 SDK 表层。

现有 MemoryBackend.retain 和 RecallBackend.search 保留兼容适配，不把二者名称当成新接口已经完成的证据。

### 4.3 写入回执与失败语义

~~~text
committed: 权威库事务已提交；含 id、revision、operation_id、commit cursor
queued:    本机 durable outbox 已落盘；其他设备尚不可依赖
unknown:   请求超时，无法知道服务端是否提交；用 operation_id 查询／重试
conflict:  expected revision 不匹配；返回允许披露的当前版本摘要
rejected:  权限／schema／内容等拒绝，说明可操作的原因
~~~

- “saved / 已保存到云端”仅用于 committed；queued 必须说明未同步。
- 同一 principal + operation_id + 同一 payload 重放只能产生一次业务变更；同键不同 payload 必须拒绝。
- 内存写入、revision、事件、幂等回执同一事务提交；本地以等价崩溃恢复协议实现。
- 更新／撤回要求 expectedRevision；同时更新不得 silent last-write-wins。
- outbox 有持久性、指数退避+jitter、有限自动重试、可诊断失败状态；冲突和权限失败不能无限重放。
- 客户端重启、服务端已提交但 ACK 丢失，仍不能产生第二条记忆或第二次学习奖励。
- 游标必须保证分页／断线重连不漏已提交变更。不能用“事务开始时取序号”直接假定提交顺序；用事务与并发测试证明。
- 权限撤销后的离线积压，在重连时重新鉴权，不能持过期授权补写。

### 4.4 读取、一致性、撤回

- 读响应含 authority、snapshot/cursor、freshness 和 partial/errors；未验证的新鲜度不能标 fresh。
- 权限、active 状态、revision 过滤先于正文返回和上下文注入。向量／全文索引命中必须回查当前权威记录。
- 同一 readSnapshot 内用于 check 的规则集合保持一致；强约束不因 top-k 排名或 token budget 被静默挤掉。
- 云提交后，另一个在线客户端的下一次成功强一致读取看到新版本。正常通知／轮询缓存更新目标 p95 ≤ 5 秒；缓存快并不是正确性的替代品。
- 撤回留 tombstone／事件，检索不返回旧正文，派生 summary、awareness、技能建议必须追溯依赖并失效／重算。
- 源记录仍 active 但 ACL／visibility 收窄、grant 被撤销，也必须触发同样的派生检查。派生记录自己的宽 ACL 不足以授权其内容：读取时须验证所有源当前可读且有效，否则整个派生物暂不注入，直至重新生成安全版本。只有经独立脱敏与 owner 批准的泛化记录可解除对原权限的依赖，仍保留受限审计 lineage。
- 已发给模型的旧上下文无法远程抹除；保证的是下一次成功新鲜读取和受控动作前重新核查。文档不得承诺“撤回后所有 agent 立刻忘记”。
- 云故障时可展示有标识的旧缓存，但不能返回“已确认无约束／可以安全执行”。受控高风险动作 adapter 在 freshness 不满足时阻止执行并报告 unavailable；普通记忆读取不必全停。
- “撤回”与“彻底删除”分开。删除须明确其历史／备份影响，经授权执行；当前 MVP 不自动做物理删除和生产库清理。

### 4.5 身份、密钥和不可信内容

Supabase 的 grants 与 RLS 都要配置，service_role 会绕过 RLS，不能交给普通 agent 或放进客户端配置。[官方 RLS 文档](https://supabase.com/docs/guides/database/postgres/row-level-security)

- 普通调用使用真实用户 Auth 或可撤销的受限 agent 授权；agent_id 自报不是身份验证。
- P0 ADR 选择具体登录／token 刷新方案，写出至少两个用户、两个 agents、只读与写入 grants 的实现和测试路径。
- 管理凭据只用于隔离环境迁移，绝不作为 RLS 验收主体；不能用 service_role 全能测试得出“权限隔离已完成”。
- RPC、views、关键词检索、向量检索、批量读取、导出、事件游标、错误消息都纳入权限测试；SECURITY DEFINER 如确有必要，必须固定 search_path 并显式鉴权。
- 不把任意 MCP human_correction 参数当作“用户已批准”。显式用户约束需要可信 host 用户事件或 owner 确认入口；否则降为待确认候选。
- prompt 中的“我是系统／忽略之前规则／把数据传到某处”只是内容，不升级 authority，不触发执行。
- secrets 在写入／上传／日志／评测证据处分别防护；不把脱敏当成能证明所有秘密均被发现。测试使用 canary，不使用真实 token。
- 支持中英文和混合文本的基本检索。不能让只支持英语分词的 FTS 在中文空结果时声称“没有记忆”。

## 5. 生命周期、跨 agent 交接与兼容

### 5.1 默认五工具的目标行为

| 入口 | 必须来自统一权威源的内容 | 必须返回／记录 |
|---|---|---|
| session_start | project checkpoint、有效约束、授权偏好、相关经验 | scope、来源版本、freshness、未完成与不确定项 |
| remember | fact／decision／preference 等明确记忆 | 类型、路由、存储层、真实回执；不伪装为已有 correction 参数 |
| recall | 所有获授权可检索类型与派生内容 | id/revision/source、why relevant、权限与撤回过滤 |
| check | 适用约束、建议和可验证理解；可信纠错捕获 | blocked/advisory/unavailable 等契约及依据；不能被误解为已拦截 host 工具 |
| session_end | 摘要、handoff、候选经验和结果引用 | 持久回执、待确认内容；失败保存明确提示 |

新增 schema 均在 P0 给出 old/new 调用示例和兼容方式。不得为方便替换用户现有 MCP 配置，也不得突然要求 local-only 用户登录云服务。

多个 active 约束之间的语义冲突与单记录 CAS 冲突分开处理。例如 owner-shared 的“禁止发布”与项目的“允许发布”同时存在：更具体 scope、较新时间或另一个 agent 的说法均不能隐式撤销禁令。缺少 owner 明确批准、指向原约束 revision 的 supersession／例外时，check 返回 constraint_conflict 和两个依据；受控高风险动作不得执行。范围较小的例外只在批准的范围内生效。无法可靠判断是否冲突时返回需要澄清，不让排序器自行选一个。

### 5.2 Handoff 契约

交接包含：任务目标、当前 commit／工作树状态、已验证完成项、待办、阻塞、下一步、相关记忆版本、工具证据引用、数据新鲜度。

接收 agent 必须区分“上一 agent 声称完成”和“有证据验证完成”。不把待办标完成，不把上次权限许可当作本次发布许可，不把源项目敏感正文复制进另一个 scope。

交接测试须包含：A 保存后异常退出、B 无聊天历史重启、B 模型不同、同一任务 checkpoint 重试、过时 checkpoint 与更新版本冲突。保存失败时不得显示“可以安全关闭并在别处继续”。

### 5.3 Host 能力矩阵

至少验收两个真实 host/runtime：一个可控 SDK runner；另一个实际 MCP client。记录 host 名称／版本、模型 ID、hook 是否存在、谁负责 lifecycle、是否有动作拦截。

在无 hook 的 host 上，只能宣称 agent-driven；默认目标是 40 个正常任务 session 中 start 和 end 分别 ≥ 38/40，漏调明细保留。异常杀进程不计正常 end 成功率，另用 outbox／checkpoint 故障恢复用例检验。

若达不到，必须降级该 host 的自动化标识并报告所需用户操作；required 主机条件仍未满足，不能用降级文案代替验收通过。禁止模拟 host 调用率冒充实测。

## 6. “自我进化”的实现边界和闭环

### 6.1 两条不同路径

**用户控制路径**：经过身份／意图确认的偏好与约束按指定 scope 生效，直到用户修改、撤回或明确设定的有效期结束。

**经验学习路径**：观察 → 候选 → 验证 → 有版本的建议 → 注入 → 行为结果 → 保留／调整／回滚。

用户说“不要发布”不需要 agent 先失败三次才能生效，也不能因为 90 天没触发就自动取消。学习到的偏好／建议允许衰减；显式权限约束不受排名／时间衰减更改。

记忆与语言反馈可以支持跨尝试改进，但这与更新模型权重是不同机制；相关研究仅是设计参考，不证明本产品会有收益。[Reflexion](https://arxiv.org/abs/2303.11366)

### 6.2 复用现有能力，修复闭环

- 保留 outcomes audit、implicit miner、association、activation、retier 的有价值实现。
- 增加统一 source/session/task attribution、记录 revision 和可追溯 evidence。
- cited ≠ heeded；被注入 ≠ 被执行；没有违规 ≠ 因记忆而避免错误。
- 一次事件被多个 agents 转述只算一份证据；独立性按任务／源事件 lineage 判断，不按条目数或 agent 数。
- 修复 retier 显示、持久化 tier 和实际动作约束之间的分歧；建议排序与硬约束 authority 两条路径分开。
- 对历史 p0／tier 不能无脑迁移成“用户批准的硬约束”。保留旧判定所需证据，标记 legacy authority，不自动扩大 scope；无法确定需人工复核。
- association 和 activation 继续 feature flag 控制。无收益时保持关闭，不能为了宣传而默认开启。

### 6.3 状态机与批准规则

~~~text
observed → candidate → validated → active_version
                   └→ rejected / needs_more_evidence
active_version → superseded / rolled_back / retracted
~~~

- candidate 默认不进入 hard check，也不作为事实型高权威上下文。
- 自动激活仅限低风险、现有 scope 内的建议；需通过独立 verifier、无秘密／scope 外溢、至少 3 个独立任务来源，且 held-in 改善、held-out 无新增硬失败。
- 候选的最小验证门槛：冻结至少 10 个 targeted held-in 用例，包含至少 3 个旧版本真实失败的复现；新版本修复其中至少 2 个，且不破坏原先通过项。另有至少 30 个候选作者未见的 held-out 回归用例，其中至少 10 个不适用场景：通过项新增回归为 0、误用建议为 0、硬安全失败为 0。独立 verifier 掌管用例与 oracle，重复尝试污染后换新 held-out；达不到仅保留 candidate。
- 3 个来源是保守的工程门槛，不是统计证明。最终收益仍按第 10 节评估。
- 进入硬约束、扩大访问 scope、变更权限、修改 host harness 必须 owner 显式批准；learner 无此写权限。
- 一个显式用户纠错可直接形成已确认约束，不需 3 份证据；两个路径不得混淆。
- 规则每次修改产生版本，不能覆盖历史。回滚恢复前一有效行为并失效派生缓存，但不能复活用户已撤回的约束。
- 同时运行两个 workers：lease／幂等使同一源事件只有一个有效状态变更；worker 崩溃后可续跑。
- learner 不能写最终 evaluator、held-out 数据、权限配置、release manifest，也不能自批自己提交的候选。

### 6.4 最小可运营后台

提供 dry-run、限定 workspace/project 的 run-once、status／diagnostics 和 resume 能力。具体 CLI 名称在 P0 冻结，以下不是现成命令声明。

每次运行报告处理源事件数、去重数、候选数、拒绝原因、激活数、回滚数、耗时／成本；没有数据时成功退出但报告 NO_ELIGIBLE_DATA，不制造一次“学习成功”。

调度可使用部署环境已有设施；不默认替用户安装 cron、不修改全局 host 配置、不调用未授权付费模型。即使没有常驻 scheduler，run-once 闭环与恢复仍必须可验收。

## 7. Flywood／Plywood 编排方式

### 7.1 名称与工具发现

用户称 Flywood；仓库历史报告称 Plywood。本次可用工具中没有找到二者入口。因此交付的是工具无关但可映射的 DAG，不编造 CLI 或 API。

P0 编排 agent 必须：

1. 在它自己的环境中查找实际工具／skill，完整阅读用法，记录名称、版本、可调用入口。
2. 确认 Flywood 是否就是 Plywood。若是别的项目，按真实文档适配。
3. 如不可用，继续做只读基线与计划细化；报告缺少的入口，不宣称已用该工具编排。实际执行可否改用原生 agent 编排由 owner 决定。
4. 记录 compiler 输入、输出、人工修改、SOP_ID／等价 run ID 和实际被派发的最终 brief。
5. 验证实际运行模型／版本，不盲从旧协议的模型别名；模型／工具不足时明确报告。

### 7.2 编排规则

遵循仓库 ORCHESTRATOR-PROTOCOL 的 ground → design → adversarial-verify → converge 和 scout → plan → dispatch → review → fix → verify。

- Orchestrator 负责依赖、文件归属、接口、集成和最终结论；worker 负责限定工作包。
- 独立 reviewer 不是该项作者；final verifier 不是主要实现者。
- 每个并行 worker 使用独立工作树／分支；共享文件只允许一个 owner 写入。没有隔离能力则串行，不“赌不会冲突”。
- Plywood 六框 ROLE / CONTEXT / CONSTRAINTS / CHALLENGE / ESCALATION / OUTPUT-TO 可包裹仓库六段任务书；模板自动生成的泛化步骤须经主 agent 校正。
- worker 必须挑战不成立的前提。例：“云端已支持所有五工具”“tier=gate 已经过用户审批”不能直接当作输入事实。
- worker 不得修改它正在接受的 frozen evaluator／held-out；evaluator 修改由独立评测 owner 审批，变更后旧结果失效重跑。
- reviewer 输出 PASS／NEEDS_FIXES／FAIL、阻断项、证据和 3 条有本次证据的 lessons；不能制造 lessons 来凑数。
- 反馈必须被实际提交到编排系统／存储，而不是仅在报告末尾打印 FEEDBACK_HINTS。记录回执；无可用反馈接口时保留待录入状态。
- 每个 work package 设置时间／调用／费用上限与停止条件；不以 token 消耗、agents 数、循环次数作为成功指标。费用预算未经 owner 批准不展开付费批跑。

### 7.3 任务状态和依赖 DAG

~~~text
P0 基线、身份ADR、接口、evaluator冻结
 ├─ P1 实例隔离 + local repository
 ├─ P2 Supabase schema/Auth/RLS/事务 [共享P0契约]
 └─ 独立 verifier 编写黑盒安全/故障测试 [不可被worker改]
P1 + P2 → P3 五工具/SDK/CLI 集成与旧数据迁移
P3 → P4 跨项目/跨agent/跨设备、撤回和交接
P3 → P5 证据闭环、worker、版本与回滚
P4 + P5 → P6 跨平台、故障、性能、安全复核
P6 → P7 真实主机 + 固定评测 + 文档 + 最终验收
~~~

计划中的并行是依赖满足后的许可，不是要求同时修改相同模块。

任务状态：READY → RUNNING → IMPLEMENTED → REVIEWED → VERIFIED → ACCEPTED。IMPLEMENTED 不能直接到 ACCEPTED。BLOCKED 包含具体依赖、已尝试的安全检查、所需决定；其他独立任务可继续。

## 8. 分阶段工作包与交付定义

### 阶段出口不等于整项最终验收

下文“关联验收”表示该工作包贡献哪些最终用例，**不表示前期必须完成依赖后期功能的整项测试**。例如 P1 不等待云身份、五工具集成或后台学习 worker。早期记录 contract 子测试证据，完整用例保持 NOT_RUN；不得把子测试成功写成整项 PASS。

ACCEPTANCE.json 的 phases 是工作涉及阶段，full_case_ready_phase 是全部前置具备后的最早整项执行阶段。最终集成提交仍须复跑 required 用例；不同旧 commit 的零散绿灯不能拼成新版本全绿。

| 阶段 | 本阶段可独立完成的出口条件 |
|---|---|
| P0 | 当前源码盘点、真实工具入口或明确阻塞、接口/身份/评测协议与预算冻结、独立设计复核无阻断 |
| P1 | 直接 local Repository contract driver：实例隔离、基本CRUD、CAS、幂等、outbox持久化、路径安全与Markdown兼容；不要求云或五工具 |
| P2 | 直接 Supabase Repository driver：普通身份、无embedding CRUD/查询、RLS正负例、CAS/回执/游标/重试；不要求五工具或学习奖励 |
| P3 | 两后端经真实五工具/SDK走通、无本地依赖冷启动、旧调用兼容、迁移副本对账；不要求真实不同host调用率 |
| P4 | scope/权限收窄/撤回派生检查、语义约束冲突、交接及受控动作adapter通过集成测试；真实host证据可在P7补齐 |
| P5 | 独立worker、候选门槛、来源去重、保护用户约束和版本回滚通过；补齐含worker的local零网络与幂等用例 |
| P6 | 集成版本跨平台、安全/故障/性能与回滚测试通过；没有未解决release blocker |
| P7 | 真实双主机、编排证据、固定实验、干净安装、完整catalog机械汇总与独立签字 |

### P0 — Grounding 与冻结执行契约

输入：本计划三文件、当前源码、仓库协议。
交付：

- run-manifest：HEAD、dirty patch hash、OS／Node／包管理器／DB／host／模型版本。
- baseline 报告：当前 clean reference 与实际工作树分别执行已有测试；不可把用户修改带来的差异叫作“原有失败”。
- 决策 ADR：权威模式、ID/scope/authority、身份与 grants、Repository、缓存与撤回、migration、性能环境。
- 工具发现／编排 brief 记录、文件 owner matrix、成本与范围上限。
- acceptance harness 设计和冻结版本；已知当前失败用例必须可复现，不允许先把全部写成绿灯 mock。
- 独立评测协议：训练／开发／held-out 分割、任务数、随机种子、模型、停止规则、success oracle、隐私边界。
- 具体接口和管理命令提案，经独立 review 后冻结。

关联验收：A01、A02、A39、A40 的相应前置产物；没有明确身份和 CAS 契约不能并行开发 P1/P2。

### P1 — 实例级 core 与 local 权威后端

交付：RuntimeContext、MemoryRepository、本地记录映射、revision／幂等／撤回、崩溃恢复日志、旧 SDK 兼容层。

重点：全局 root 读写路径清单及消除；并发 SDK 实例、非 ASCII／空格路径、原 Markdown 可编辑行为。

关联验收：A03、A04、A08、A09、A10、A11、A22、A23。本阶段只验证上述出口中的本地 contract 子集。本地实现若尚未完成而 P2 需接口，由 frozen contract fixtures 支持，不能声称真实后端互通。

### P2 — Supabase 作为完整权威后端

交付：可重复迁移、Auth/grants/RLS、受控事务入口、revision/CAS、事件与回执、无 embedding 的读写检索、测试凭据设置说明。

重点：数据库直接访问和所有 RPC 都受权限控制；ar_entries／ar_insights 老路径不得成为旁路。

关联验收：A05—A13、A16—A18、A24—A27（按 catalog 映射），本阶段先验证 Repository/鉴权层子集。真实 Supabase staging 项目必须是新建／明确授权的隔离测试环境，禁止生产迁移试错。

### P3 — 全生命周期贯通与迁移

交付：五工具、SDK 和相关 CLI 使用统一 context／repository；所有 awareness／insights／corrections／behavior policies 消费链可追溯；迁移 dry-run、apply、verify、恢复步骤。

重点：既有根和四个 package README 修改先保留；只在最终文档阶段合并；不盲目运行 sync-readme 覆盖用户内容。

关联验收：A03—A05、A14、A15、A19、A20、A32、A33；迁移前后有效记录、权限、撤回、lineage 对账。

### P4 — 跨 agent 协作与用户控制

交付：稳定 project 映射、scope 过滤、个人偏好、handoff、跨主机缓存失效、查看／修改／确认／撤回／导出管理入口。

关联验收：A06、A07、A16—A21、A28—A30、A38；集成测试先完成，真实 H1/H2 演示最终在 P7 验收，不以共享同一文件夹的两个进程代替跨设备。

### P5 — 证据驱动进化

交付：source attribution、outcome ledger、candidate/active 状态机、独立验证、可恢复 worker、保护显式约束、版本与回滚。

关联验收：A09、A22、A28、A29、A34—A37；工程闭环通过仅证明机制，不证明 uplift。无正收益保持实验开关关闭仍是合法研究结果，但完整愿景未完成。

### P6 — 可靠性、安全、性能与跨平台

交付：故障注入、并发测试、完整权限攻击矩阵、Windows/Linux CI、性能报告、资源／依赖安全报告。

关联验收：A01、A08—A13、A22—A27、A31、A41。安全测试失败、丢失 committed 写入、串 owner、显式约束被自动降级，均是 release blocker。

### P7 — 真实使用验收、实验与文档收口

交付：

- 两个真实 host/runtime、两个真实隔离设备／VM 的端到端证据。
- A/B/C 固定评测报告，原始样本与汇总可重算。
- README、四包文档、配置／迁移／操作／故障指南、host capability matrix。
- 最终证据目录与独立签字的 scorecard、限制／缺口、发布前回滚演练。

最终验收：所有 required case；最终由第 0.2 节机械汇总，而不是主 agent 自拟“基本达标”。

### 8.1 文件所有权建议

| Owner | 独占写范围 | 集成约束 |
|---|---|---|
| Core worker | 新 repository/domain/context、本地 adapter、core 专属单测 | core types/index 交 integrator 单独落地 |
| Cloud worker | Supabase adapter、迁移、云集成测试 | 不能自行改变 core interface 或 evaluator |
| Lifecycle integrator | core tools-logic、MCP schema/index、SDK、CLI 入口 | 公共入口唯一 owner；其阶段不得与其他 worker 同写 |
| Evolution worker | outcomes／candidate／worker／retier 相关模块 | check-action 边界修改交 integrator |
| Verification owner | 独立 acceptance/eval harness、held-out、结果汇总 | 实现者只读；跨 workspace 的技术访问能力不等于被允许修改 |
| Docs/operator | 文档、配置示例、runbook | 不得覆盖已有 README 修改；承诺受验收约束 |

P0 生成实际文件列表后执行；这张表不是路径通配写权限。

## 9. 工程验收：固定环境、门槛和证据

ACCEPTANCE.json 是逐项执行清单；本节定义共用环境和数量，二者共同构成契约。发生矛盾先开问题单，不能挑较宽松的一项。

### 9.1 固定测试夹具

- 用户 U/V；U 的工作区 W1/W2；项目 Alpha/Beta；agent A/B；read-only agent C；已撤销 agent D。
- H1/H2 分离文件系统、缓存和进程；真实云演示不得复制整个记忆目录。
- 至少 500 条有标签的功能夹具：项目私有、owner-shared、候选、撤回、冲突、中文、英文、恶意文本、秘密 canary、派生 summary。
- 10,000 条记录性能数据、每条正文中位数约 1 KB；数据生成器和 seed 固定；不得把对正确性有利的小样本当性能全集。
- 本地测试移除继承的 Supabase／embedding credentials，显式临时 root；禁止默认读写个人真实记忆库。
- 权限测试使用真实普通角色／用户 JWT，不用服务密钥。
- 时钟／网络故障由 fixture 控制；记录墙钟和单调计时来源。

### 9.2 关键硬门槛

| 维度 | 门槛 |
|---|---|
| 串 owner／scope 泄露 | 至少 1,000 次允许/拒绝矩阵请求；未授权正文／ID／count／错误泄露 0 次 |
| 提交持久性 | 1,000 个确认 committed 操作，进程中断／重启后丢失 0 |
| 幂等 | 每个相同操作重放 10 次；逻辑变更与学习奖励均恰好一次 |
| 并发 CAS | 同 revision 的 100 组双写：每组恰好一个成功、一个 conflict，不能静默覆盖 |
| 撤回一致性 | ID/关键词/向量/冷启动/check/summary/handoff 七条路径均无已撤回旧正文；派生引用有效 |
| 本地隐私 | 默认 local 模式全套测试捕获到的出站请求 0；canary 云上传/日志泄露 0 |
| 强约束 | 所有显式约束不可被衰减、重复转述、scope 泛化或 token 截断绕过 |
| 云端无 embedding | 清空所有 embedding 配置后五工具及中英检索完整通过 |
| SDK 隔离 | ≥ 50 个交错调用/实例，至少两 root 和两云身份，串库 0 |
| 备份／迁移 | canonical 记录按 ID/revision/status/authority 对账 100%；回滚不会丢弃已确认新写入 |
| 构建与测试 | Windows 原生 + Ubuntu 固定版本：build/lint/核心必需用例 0 失败、0 required skip |

安全零失败只代表规定测试未发现漏洞，不宣传为数学证明绝对安全。

已有无关失败可以作为证据明确的 baseline exception 记录，但不能掩盖 touched path、权限、持久性、迁移或本计划 required 用例失败。最终报告必须列出完整测试失败总数；“required 通过”不改写为“全库测试全绿”。

### 9.3 性能预算

在 P0 冻结参考机器、Node／Postgres 版本、Supabase 区域/plan、并发数、网络 RTT、测试数据及缓存条件。默认参考是 ≥ 4 vCPU / 8 GB 内存的客户端与同区域云库；实际环境不同须在 P0 调整并批准预算，而不能最终看到结果才改。

每条路径 warmup 20 次，正式 ≥ 200 次，单并发与 10 并发分别记录 p50/p95/error rate。

- local remember committed p95 ≤ 150 ms。
- local recall／check p95 ≤ 300 ms，session_start p95 ≤ 500 ms。
- cloud 基本写／读／check p95 ≤ 1,500 ms，session_start p95 ≤ 2,000 ms；端到端包含网络。
- 在线缓存传播 p95 ≤ 5 秒；强一致读取不以缓存传播完成为前提。
- 99% 以上非注入故障请求在规定超时内成功；故障实验不混入正常性能分母。
- 记录冷启动、embedding 与 LLM 生成开销，不能把它们藏起来；上述核心 SQL 预算不包含可选外部 LLM 生成。
- 每次 prompt 注入默认经验预算 ≤ 2,000 tokens；显式硬约束不能静默裁掉，超预算时给出 overflow 并要求动作前核查。

### 9.4 用户接受测试脚本

由不参与主要实现的验收者执行，不参考 agent 的“我已经记住了”作为判断依据：

1. 空目录安装，local 模式保存一条中文决定，关闭全部进程，重开读回；抓包证明无云请求。
2. 授权 staging 云模式，H1 保存 Alpha 发布约束和 owner-shared 中文偏好，记录 committed receipt。
3. H2 使用不同 agent／新 session 连接，完成第 0.3 节演示；同时 V 不可读取。
4. 断网保存另一条事实，看到 queued；重启仍在队列；恢复网络后恰好一次 committed。
5. 制造并发编辑、令牌撤销、旧缓存和派生摘要撤回，验证显式冲突／不可用状态。
6. A 保存有“未测试”事项的交接，B 必须把它保留为未测试，不自称完成。
7. 对一个建议型规则运行候选→验证→生效→结果→回滚；对显式禁令运行同一 decay 流程，确认禁令不被降低。
8. 导出、备份、在另一个隔离 root 恢复；新旧行为与记录对账。
9. 验收者从干净环境按文档复现，不依赖作者机器上的隐藏配置。

## 10. 进化效果评估：成功不是“多了几条 memory”

### 10.1 三组对照

- A：无历史记忆；安全所必需的当前用户授权、任务输入、host 权限约束各组相同。
- B：静态记忆；与 C 从相同初始快照开始，学习关闭。
- C：进化记忆；仅在训练/积累阶段运行第 6 节更新机制，最终 held-out 开始前冻结记忆快照与策略。

各组使用相同模型版本、工具版本、任务难度、初始文件、预算与 success oracle。保持真实的额外记忆 token 成本，不用人为免费 token 掩盖开销。最终测试 C 不在线学习以免跨题污染；在线长期适应可作为另一个明确标注的次级实验。

数据划分按任务族／源项目／时间隔离，近重复和同源改写不得跨 train/test。禁止把 held-out 失败修正写入 C 后继续累计同一 final 分数。

### 10.2 最低样本与运行协议

- 初始目标：至少 150 个独立 held-out task clusters，至少 3 个任务类别；其中至少 60 个预先标注的“存在旧错误复发机会”任务。
- 每 task 每组 3 个预先固定的随机重复；至少 1,350 次 agent task runs。随机重复不当作 450 个独立任务。
- 在开发集做方差／功效估计；若样本不足以检验约定效应，在 final 前提升并冻结 N 或报告预算不足。
- task 成功判定优先可执行 oracle；必须人工／模型判读的部分由独立盲评者依据预先 rubric，保留争议／unknown。
- 每个计划重复的 success 仅在 oracle 明确通过时为 1；失败、任务超时和未解决 unknown 均为 0，保留在分母。适用机会集由实验前标注，不根据最终结果剔除；复发无法判定按复发计入主分析，并单列敏感性分析。不得把 unknown 删除来提高成功率。
- 固定 10,000 次按 task cluster 配对 bootstrap 和 seed；报告差值与区间，不只报单点。
- 预登记采样、排除、超时和停止规则。模型任务超时按失败计入；明确基础设施故障可按相同预定规则对三组一起重跑。
- 最终只允许一次冻结数据的主分析；继续迭代需新 held-out／新版本，不能反复抽种子直到显著。

### 10.3 主指标与成功门槛

设 S 为满足 task success oracle 的 task 比例；先在每个 task 内汇总重复，再按 task 等权平均。Δ = S_C − S_B。

**必须同时满足：**

1. C 对 B：Δ ≥ 5 个百分点，配对 cluster bootstrap 95% CI 下界 > 0。
2. C 对 A：成功率差值的 95% CI 下界 ≥ −2 个百分点，防止只比一个被静态记忆拖累的弱基线好。
3. 预标注复发机会子集上：recurrence_C / recurrence_B ≤ 0.75，且复发率差值 C−B 的 95% CI 上界 < 0。B 无复发、分母为 0 时此指标 INCONCLUSIVE，不可写下降 100%。
4. 盲评为不相关／错误的注入比例 ≤ 5%；分母是预登记抽样的全部被审查注入条目，未解决 unknown 按不良注入计入。至少 200 个唯一任务-记忆对，覆盖至少 100 个独立 task clusters；采用与主指标一致的按 task cluster bootstrap，保留同任务内相关性，95% CI 上界 ≤ 10%。抽样 seed、上限和分层在 final 前冻结，不能看完相关性再挑样本；不足样本时 INCONCLUSIVE。
5. 硬安全集：越权、泄露、显式禁令失效、伪造完成证据各为 0；不能用平均成功率抵消。
6. C 相对 B：平均端到端 task 耗时 ≤ 1.25×，含学习摊销的平均模型 token ≤ 1.20×，按下面固定公式计算。学习／准备成本、费用和后台计算时间另列，不隐藏失败重试。
7. held-out task 和注入事件的 project/session/memory revision 归属率 ≥ 95%；缺失标签与不可判定率均单列。结果覆盖率不得用“可观测的少数样本”作唯一分母。

因多门槛全部须过，不挑一个显著数字充当总成功。不承诺达到门槛：达到是 EVOLUTION_VALIDATED；负结果是研究结果，不是工程师可以靠改分母解决的缺陷。

成本公式：对每组 g，effective_tokens_g = final_runs_total_tokens_g / planned_final_runs_g + preparation_and_learning_tokens_g / N_use。N_use 默认等于冻结任务数 × 3 次重复（150 任务时为 450），三组相同；final 前冻结，看到结果后不得增大以摊薄成本。token 包括输入、输出、可计量推理、候选生成、验证、拒绝候选、失败重试和额外收集训练任务的调用；共同初始静态记忆的生成费用对 B/C 一致计入，不重复计算。人工制作评测集的成本单列，不伪装为运行 token。验收比较 effective_tokens_C / effective_tokens_B ≤ 1.20。

耗时门槛比较最终任务端到端平均时间，包含在任务关键路径上发生的同步学习；离线学习总墙钟、算力／模型费用与按 N_use 摊销值必须另报，不能宣称该门槛代表整个系统总耗时。tokens 缺少可信 usage 时成本门槛 INCONCLUSIVE，不用估值偷偷写 PASS。适用的已定价外部 API 费用按实际账单／费率和日期报告，不将免费额度当作永久零成本。

### 10.4 重复证据、外部效度与真实使用

同一任务被三个 agents 总结十次，不是 30 个独立学习案例。自述“遵守了”必须与真实动作／可执行输出对照。

合成夹具只证明处理链路；上面通过才支持基准内效果声明。若 README 要写“实际日常使用减少错误”，另需至少 30 个自然日、100 个符合条件的真实任务的前瞻观察／对照，注明混杂因素并经用户授权。否则文案只写“在固定基准中……”，不把实验室结果扩展成普遍自我进化。

## 11. 迁移、恢复、发布与用户权限

### 11.1 迁移流程

1. 只读盘点 local 和旧云 schema：数量、重复、retracted、旧 global、缺 source、secret-risk。
2. 备份并记录 hash；先在隔离副本恢复，证明备份可用。
3. dry-run 产出映射与风险：稳定 ID、project alias、authority、scope、旧 insight 表路由。
4. 使用版本化 migration + 可恢复 checkpoint；已迁移 ID 重跑不重复。
5. 写入共享云必须显式 opt-in；personal／corrections 沿用保守默认，不把“开启 Supabase”视作同意上传所有内容。
6. 新后端 shadow-read 对比旧有效数据和行为。旧数据保持可恢复，禁止 first-run 自动清空。
7. 切换前短暂写入栅栏／排空 outbox，记录 cutoff cursor；不无期限双写两套权威。
8. 切换后新增 committed 数据纳入备份与回切日志；不能只回滚代码把新数据丢掉。

孤儿、损坏记录、来源不明的 global 项按具体记录 quarantine 并报告；不得静默删除，也不得为了提高迁移“成功率”把它们排除分母。

### 11.2 回滚演练

至少演练：错误 schema 版本、应用版本回退、任务 worker 故障、坏规则激活、检索投影损坏。报告 RPO/RTO 实测；隔离 10k 夹具默认 RPO=0（对 committed 写入），RTO≤15 分钟。更大规模另测不外推。

冻结写入并排空／持久化队列后回切；恢复记录、权限、tombstone 和派生关系。旧 app 无法理解新 schema 时阻止启动并给恢复指引，而不是继续以旧语义写坏数据。

### 11.3 权限边界

执行本计划意味着授权限定工作树内开发与非破坏性本地测试；不自动意味着：

- push、合并主分支、npm publish、version bump；
- 修改生产 Supabase、上传真实个人 transcript；
- 新增付费账号／资源、修改全局 host 设置／scheduler；
- 删除生产记忆、恢复覆盖现有库、向外发送消息。

这些动作必须按用户已明确授权范围执行；缺授权时停在 READY_FOR_OWNER_RELEASE。阻塞报告写具体需要什么，不反复问已经授权的同一件事。

## 12. 证据包与机械汇总

执行 agent 新建 reports/shared-memory-evolution/<run-id>/，以下是未来交付结构，不是本次已有结果：

~~~text
manifest.json                 # commit/env/tool/model/config hashes, no secrets
baseline/                     # clean reference vs working tree
adr/                          # contracts, auth, migration, evaluation freeze
orchestration/                # actual briefs, DAG, worker/reviewer IDs, feedback receipts
tests/                        # machine-readable results + raw logs
security/                     # allow/deny matrix, injection, secret canary, RLS tests
migration/                    # dry-run, backups manifest, reconcile, restore
performance/                  # fixtures, environment, raw timings, percentiles
hosts/                        # real host transcripts and lifecycle accounting
evolution/                    # protocol, split hashes, raw A/B/C results, analysis
reviews/                      # independent reviews and fixes verified
acceptance-results.json       # exactly one final result per catalog case
FINAL-REPORT.md               # verdicts, gaps, claims allowed, next owner action
~~~

每条 acceptance 结果至少包含：

~~~json
{
  "id": "A01",
  "status": "NOT_RUN",
  "commit": "<exact SHA>",
  "evaluator_commit": "<exact SHA or immutable hash>",
  "environment": "<manifest reference>",
  "command": "<actual executable command, not intended command>",
  "started_at": "<ISO timestamp>",
  "exit_code": null,
  "metrics": {},
  "evidence": [],
  "verified_by": "<independent verifier id>",
  "reason": "template only"
}
~~~

以上是格式例子，不是一次运行记录。PASS 必须有存在且可读的证据；FAIL 保留首次失败与修复后复跑；BLOCKED 写出外部条件。证据包括内容 hash 与生成时间，脱敏后仍可复核；包含 token／密钥的日志先隔离脱敏，绝不提交。

执行 agent 必须实现一个汇总器，检查 catalog ID 完整且唯一、状态合法、必填证据、commit/评测版本匹配、required 无 skip、阈值从原始数据重算。不要让“JSON 能 parse”或“snapshot 文件存在”成为性能／收益验收。

主 agent 在最终报告回答：

1. 工程／进化／release 三个结论分别是什么？
2. 哪些 required 用例 FAIL/BLOCKED/NOT_RUN？
3. 哪些承诺已实测，哪些只是实现接口，哪些仍是计划？
4. 相对基线的效果、代价和不确定性各是什么？
5. 真实云库、真实双主机、真实不同 agent 是否都跑过？
6. 用户需要做的最后一个决定是什么？是否有未执行的生产动作？
7. 如何在另一环境复现与回滚？

## 13. README 与产品表达验收

首页重点依次：

1. “下一个 agent 不必从零开始”：一个具体跨 session／agent 的故事。
2. “由你拥有的记忆”：本地或自己的云库、明确共享与撤回。
3. “在正确范围复用”：个人偏好、项目约束、验证过的经验彼此区分。
4. “改善必须可测”：已支持机制与已证明效果分开。

避免把数据库品牌当主价值，也不以“无限记忆／全自动进化／永不重复错误”作未经验证承诺。

README 必须有：

- local 三分钟 quickstart 和 cloud 独立 quickstart，分别从干净环境走通。
- 状态矩阵：local/cloud、五工具、cross-session/project/agent、host lifecycle、evolution，各标 supported/experimental/planned 并链接测试证据。
- 真实工具参数和输出；queued／conflict／unavailable 示例。
- 数据路径、身份、隐私 opt-in、备份／撤回／迁移说明。
- 有统计门槛通过才列效果数字，附 task set／N／CI／模型和限制。
- 明确本地纯记忆无需模型 API key；可选外部生成／embedding 的费用与权限另列。
- 源码实现、root README、package README、MCP description、SDK 类型一致。

最终公开措辞必须受第 0.2 节结论限制；“实现了 self-evolution 架构”不能偷换成“已经自主变聪明”。

## 14. 风险登记与默认决策

| 风险 | 检测／默认处理 |
|---|---|
| 工具名／版本不明 | P0 发现真实入口；无工具不假装编排完成 |
| SDK 全局状态串库 | 首先建立双实例失败测试；逐层传 context |
| RLS 表面开启但 RPC 旁路 | 普通用户直接表、RPC、索引、导出矩阵测试 |
| 本地/cloud 双重真相 | namespace 单一 authority；queued 不冒充 shared |
| 旧规则误当用户批准 | legacy 标记、来源复核，不自动提升权威 |
| 摘要复活撤回内容 | derived_from 图与注入前有效性验证 |
| 证据自我循环 | source event lineage 去重，独立 evaluator |
| 数据不足／无效果 | INCONCLUSIVE／NOT_DEMONSTRATED，保留实验关闭 |
| Windows 测试现有失败 | clean reference 重现并分类；修复所触及路径，不删测试 |
| 编排模板误导 | CHALLENGE、源码定位、主 agent 校正最终 brief |
| 评测预算不足 | 先估计1350+ runs 成本；未批准不启动付费批跑 |
| 过度设计 | 第一版只 local + Supabase，无 UI／SaaS；必要契约优先 |

## 15. 参考与执行前复核

- [仓库固定基线](https://github.com/Goldentrii/AgentRecall-X/tree/db6338a5d60a36ea9c38a58e1d22e8037d75f095)
- 仓库 AGENTS.md、ORCHESTRATOR-PROTOCOL.md：执行规则；历史版本和工具名需核实。
- reports/2026-09-17-evolution-program-final-report.md：已有进化工作与“不能宣称收益”的原始报告；不把历史全绿外推到当前平台。
- docs/internal/cross-surface-adapter-spec.md、OPTIMIZATION-LOOPS.html：涉及 adapter 前必读；历史工具列表须和当前注册对照。
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)：权限依据。
- [Supabase vector columns](https://supabase.com/docs/guides/ai/vector-columns)：可选向量字段能力；不是云记忆的必需前提。
- [Reflexion](https://arxiv.org/abs/2303.11366)：语言反馈／记忆改进的研究背景，不替代本产品实测。

最终原则：**一条记忆能保存，只证明保存；被另一个 agent 正确读取，才证明共享；下一次任务可验证地做得更好，才证明进化。**
