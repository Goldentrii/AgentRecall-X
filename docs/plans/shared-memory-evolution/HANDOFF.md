# 交给执行 agent 的任务书

请将本文件与 PLAN.md、ACCEPTANCE.json 放在一起。完整要求在另外两份文件；本文件是启动指令，不代替验收契约。

## 1. Role + Scope

你是 AgentRecall-X 的主 orchestrator。使用用户所说的 Flywood（仓库历史称 Plywood；先确认实际工具）编排实现、独立 review、修复与最终验收。

目标：本地／Supabase 权威记忆；跨 session、项目、设备和 agents 的受控共享；有证据、有版本、可回滚的经验更新。你必须完成工程验收，并诚实区分“进化机制已实现”和“进化效果已证明”。

不要只产出另一份计划。收到用户执行授权后，按 P0—P7 推进实际交付；无权限的生产操作保留为 owner 最后决策。

## 2. Context

- 仓库：https://github.com/Goldentrii/AgentRecall-X
- 计划基线：db6338a5d60a36ea9c38a58e1d22e8037d75f095，版本 3.4.51；必须重查当前代码。
- 原工作目录：E:/Users/tong/Documents/New project/AgentRecall-X；可在新机器 clone，不依赖这个路径。
- 计划文件：docs/plans/shared-memory-evolution/PLAN.md 和 ACCEPTANCE.json。
- 读取 AGENTS.md、ORCHESTRATOR-PROTOCOL.md；涉及 adapter 再完整读取其要求的设计／历史文件。旧模型与工具名不是当前能力证明。
- 原工作树有 root README 和四包 README 修改；保留并盘点，不覆盖、不假定已发布。
- 若 AgentRecall lifecycle 工具可用，先 session_start，结束有实质工作时 session_end。只保存非敏感摘要，不上传真实 transcript。

优先检查：core 的 types/root、storage/corrections、supabase、tools-logic/session-start/check-action/retier；SDK 实例；MCP 注册与 schemas；根 migration.sql。

## 3. What to build

1. 完整读三份交付文件，输出当前基线、差距和实际编排入口。
2. P0 冻结身份／scope／authority、实例级 repository、回执／CAS／撤回、迁移与 evaluator 契约。
3. 建立 DAG、独立工作树和 file owner matrix；使用真实工具编译 brief，修正错误前提后派发。
4. P1/P2 在同一冻结接口下并行；后续按依赖完成五工具贯通、交接、证据闭环、故障恢复、真实双主机与评测。
5. 逐项实现并运行 ACCEPTANCE.json 的 47 项验收；所有项当前都是 NOT_RUN。
6. 保存实际命令、环境、模型、SHA、原始输出、统计脚本、独立 review 和 feedback 回执。
7. 输出 reports/shared-memory-evolution/<run-id>/FINAL-REPORT.md 及全部证据，按计划规则计算结论。

主报告门槛：41 项工程、4 项进化、2 项发布准备。完整愿景需要全部通过；工程通过但效果未证明只能 PARTIAL_SUCCESS。

阶段出口见 PLAN 第 8 节；catalog 的 phases 是贡献阶段，full_case_ready_phase 是整项前置具备的最早阶段。P1/P2 先跑 repository contract 子集，不等待 P3 五工具或 P5 worker；子集通过不能把整项标 PASS。最终集成 commit 需重新验证，不能拼接旧版本结果。

## 4. What NOT to do

- 不把 mock、截图、编译成功、JSON 可解析、agent 自述当作真实共享／效果验收。
- 不伪造 Flywood/Plywood 命令、工具可用性、已运行模型或测试结果。
- 不让 implementation worker 修改自己的 frozen evaluator 或 held-out。
- 不静默降标准、缩分母、跳过 required 用例，或用更多 token 消耗代表进展。
- 不用生产记忆库做故障测试，不给普通 agent service_role，不读取／打印不必要的凭据。
- 不未经授权 push、publish、升版本、生产迁移、配置全局定时任务或进行付费批跑。
- 不声称 MCP check 自动拦截所有 host 工具。
- 不让显式用户禁令因时间、缺少证据或 learned tier 自动降级。

## 5. Verification

先构建独立验收者可以执行的命令入口，登记在 evidence manifest，再冻结。计划里没有把尚不存在的脚本冒充现有命令。

已有根脚本 npm run build、npm run lint、npm test 可用于基线；先检查实际 package.json。Windows 已观察到脚本／路径问题，不能假定当前全绿。

具体阈值全部见 PLAN 第 9—10 节和 catalog。关键包括：

- 两设备无共享缓存、两个实际 agents、真实隔离 Supabase。
- 0 越权泄露、0 committed 丢失、0 并发静默覆盖；撤回传到派生记忆。
- local 默认零网络；云不需要 embedding key；五工具同一权威源。
- 至少 150 独立任务 × 3 组 × 3 次运行；C−B 成功率至少 +5pp 且置信区间下界大于 0，并同时通过复发／成本／安全门槛。

unknown 成功判定按失败计；不相关注入的 unknown 按坏注入计，区间按任务聚类。token 成本门槛包含按冻结 N_use 摊销的学习／验证／失败重试费用，不仅统计 final prompt。

先估计并批准实验成本。凭据／真实host／预算缺失时，完成能安全做的部分，明确 BLOCKED 与具体所需输入，绝不伪造 PASS。若效果不显著，保留负结果，报告 EVOLUTION_NOT_DEMONSTRATED。

## 6. Report back

每个工作包报告：修改文件、commit、真实命令与退出码、通过／失败用例、证据路径、未解决问题、下一依赖。独立 reviewer 另报阻断项与修复验证，不由作者自签。

最终只回答有证据支持的结论：

- ENGINEERING_ACCEPTED：是／否。
- EVOLUTION_VALIDATED：是／否。
- READY_FOR_OWNER_RELEASE：是／否（不是发布授权）。
- 47 项逐项结果、关键指标及不确定性。
- README 允许宣称什么，仍不能宣称什么。
- 如何复现、回滚；需要 owner 的具体最后动作。

现在从 P0 开始；不要把本任务再次退回成泛泛建议。
