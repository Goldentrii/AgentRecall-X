# 计划编写阶段复核记录

完成日期：2026-09-27（Europe/Berlin）。本文件不是运行实现验收报告。

## 复核范围与结论

- /root/acceptance_review：独立审查阶段依赖、47项验收、对照实验、统计样本、成本及unknown计分。初审 NEEDS_FIXES，修订后 PASS。
- /root/architecture_review：独立审查云权威、权限、派生缓存、用户约束与本地编辑语义，抽查相关源码。初审 NEEDS_FIXES，修订后 PASS。
- 两位 reviewer 均未参与本文档的编写修改；复核仅针对计划，不证明未来实现已经满足要求。

## 已关闭的问题

1. 前期阶段曾要求后期才具备的完整验收：新增阶段出口表和 full_case_ready_phase，子测试成功不算整项 PASS。
2. 注入样本存在任务内相关性：改用 task-cluster bootstrap，而非把所有任务-记忆对当独立样本。
3. 学习成本摊销定义不明确：补 effective_tokens 公式与冻结 N_use，计入验证、失败重试及候选处理。
4. unknown 有被移出分母的空间：成功 unknown 按失败，复发 unknown 按复发，相关性 unknown 按不良注入。
5. 源仍 active 但权限收窄可能经摘要泄露：派生物读取重验全部源当前授权，A16/A18覆盖。
6. CAS 无法解决不同记录的语义约束冲突：新增 constraint_conflict 和 owner 批准例外语义，A28覆盖。
7. Markdown手改可能误提升权威：定义 external_edit、revision、并发冲突和本地OS威胁边界，A03覆盖。

另外细化了逐候选的 targeted/held-out 验证门槛；独立验收review已检查与A34一致。

## 结构检查

已通过JSON解析、47个唯一用例ID、41/4/2 gate计数、必填字段、阶段与完整前置映射、11项需求覆盖、正文ID引用和主交接链接检查。

全部产品验收项的 initial_status 均为 NOT_RUN。本次没有执行云端迁移、实现新运行时、跑1350次实验、push或publish。Flywood/Plywood实际入口由未来执行环境在P0确认；本次未声称使用它完成编排。

## 交付指纹

下列SHA-256用于识别交付版本，不代表数字签名。修改文档后需重新核对；PLAN最终追加了本复核链接。

| 文件 | SHA-256 |
|---|---|
| PLAN.md | E2C898B15C87A855E2BEC150EBEBF38F0867B4AF5FC0E141E13E0A9D1D8192A0 |
| ACCEPTANCE.json | 72C407D1D9B44BF906FA14ACC07856BC97881DD3B7EB3099B821D2C58D4FAA7E |
| HANDOFF.md | 238453FCA2B74F6130D6DF55EC2BF7D078F3B023CC480E9AB3FB2824DD511314 |

当前仓库已有的root和四包README修改保持不动。用户移交整个shared-memory-evolution目录即可；执行agent从HANDOFF.md开始。

