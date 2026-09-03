# Research: knowledge-base-admin

所有决策均基于仓库当前代码事实（路径与行号为调研时快照）与已发布原型。

## R1 租户级全量列表如何提供

- **Decision**: 新增 `GET /api/enterprise/knowledge-admin/knowledge-bases`（`ensure_tenant_admin`），由 `knowledge/listing.py` 直接按 `tenant_id` 查询 `KnowledgeBase`，联表统计：正式版本号、进行中草稿数（`publication_state='draft'`）、文档数（正式版本或分支头版本）、绑定群组（`TeamKnowledgeBaseBinding.status='active'`）、归属员工（私有库：`metadata_json.owner_agent_id` → `AgentProfile.name`）。支持 `mode` / `status` / `owner_agent_id` / `team_id` / `q` 过滤与 `offset`/`limit` 分页。
- **Rationale**: 现有 `GET /api/enterprise/knowledge-bases` 无员工上下文时走 `is_open_gallery_resource` 过滤（`knowledge_bases.py:1582`，`branching.py:293`），改它会影响员工侧与广场语义；管理端单独端点风险最小。
- **Alternatives**: 给旧端点加 `scope=tenant` 参数——被拒：该端点已有三套返回语义，再加一套会让 `_management_knowledge_base_versions` 更难维护。

## R2 共享库治理的管理员旁路

- **Decision**: `require_team_knowledge_manager` 增加分支：当 `team_id is None` 且 `is_admin_user(current_user)` 时，跳过团队与绑定校验，返回 `team=None, binding=None` 的上下文；`SharedKnowledgeDraftCreateRequest` / `Publish` / `Reject` / `Rollback` 的 `team_id` 改为 `str | None`。审计事件 `team_id=None`，`details.actor_context="tenant_admin"`。
- **Rationale**: 未绑定群组的共享库目前无法做任何版本操作；管理员本就是团队 owner 的超集（`management.py:49`）。
- **Alternatives**: 新增独立 admin 端点集——被拒：重复 4 条路由与全部乐观锁/审计逻辑。

## R3 草稿命名与版本号分配时机

- **Decision**: 保留 `knowledge_base_versions.version` 列作为显示标签，不加列、不迁移：
  - 建草稿：`version = f"draft-{short_id}"`（取版本 id 末 4 位十六进制），`parent_version_id = published_version_id`（即基线），`metadata_json.draft_name` 同值。
  - 发布：`versioning.publish_draft(level: Literal['patch','minor','major']='patch')` 计算现有 released 中最大的 semver 三元组并按 level 递进，写入 `version`，`metadata_json.draft_name` 保留来源草稿名，`metadata_json.published_from_draft=True`。
  - 驳回：保留草稿名。
  - `_next_shared_version_label`（`versioning.py:50`）改为发布时调用并接受 level。
- **Rationale**: 唯一约束 `(tenant, kb, version)` 对草稿名同样成立；不需要 schema 迁移；已发布历史标签不受影响（VI 兼容）。
- **Alternatives**: 新增 `draft_name` 列并让 `version` 可空——被拒：需要 additive migration 与旧 reader 处理，收益仅是字段更"干净"。

## R4 基线过期判定与提示

- **Decision**: 派生字段，不新增存储：`KnowledgeBaseVersionRead.is_stale = (publication_state=='draft' and parent_version_id != knowledge_base.published_version_id)`；同时 `base_version` 投影 `parent` 的 `version` 标签。发布时若 stale 且未带 `force_overwrite=true` → `KNOWLEDGE_BASELINE_STALE`（409，params: `base_version`, `published_version`, `conflict_count`）。提示"正式版已更新"由前端在草稿横幅与发布框根据 `is_stale` 展示；后端注册事件 `knowledge.version_published`（params: `knowledge_base_id`, `version`, `stale_draft_count`）供后续推送复用。
- **Rationale**: 读时派生零迁移，且与现有 `expected_published_version_id` CAS 互补（CAS 防并发，stale 防语义覆盖）。
- **Alternatives**: 发布时批量写 `stale=True` 到其他草稿——被拒：多一处写放大与一致性维护。

## R5 文档跨版本身份（对比与变基的前提）

- **Decision**: 版本资产克隆（`branching.clone_knowledge_version_assets`）时，为每篇文档写入 `metadata_json.lineage_id`（源文档已有则继承，否则以源文档 id 作为 lineage）。`diff.py` 与 `rebase.py` 按 `lineage_id` 配对文档；缺失 lineage 的历史数据回退按 `filename` 配对，并在响应里标 `pairing="filename"`。
- **Rationale**: 当前克隆后文档 id 不同，无法判断"同一篇"；lineage 是 additive、可回填。
- **Alternatives**: 按 title 配对——被拒：title 可编辑，配对不稳定。

## R6 共享库删除连带清理

- **Decision**: 依赖独立修复任务（删除时同事务清理 `TeamKnowledgeBaseBinding`、`TeamKnowledgeBaseGrant`、`Team.default_knowledge_base_id`）。tasks 中加一条"验证该修复已合入"的前置任务；若未合入，则在本功能 P0 内实现同一清理并补测试，不做两份。
- **Rationale**: 避免重复实现与合并冲突。

## R7 版本对比算法与放置位置

- **Decision**: 服务端 `knowledge/diff.py`：文档级用 lineage 集合运算得出 added / modified / deleted；行级用 `difflib.SequenceMatcher(autojunk=False)` 产出 opcodes → hunks（`equal` / `replace` / `insert` / `delete`），每个 hunk 附 base 行区间与 target 行区间；对 `replace` 块内的行按相似度（`SequenceMatcher.ratio() ≥ 0.5`，顺序对齐）配对，输出 `pairs` 供前端做字符级高亮。响应即原型的 hunk 模型。前端审阅编辑器在编辑期用本地 LCS 行 diff 重算（原型已验证），只在打开与应用时调用服务端。
- **Rationale**: 标准库足够，行为与 VS Code 的"整篇重算"一致；不引入第三方 diff 依赖。
- **Alternatives**: 全部前端计算——被拒：发布确认框与通知需要服务端可用的摘要；`diff-match-patch` 等库——被拒：额外依赖审查成本。

## R8 变基与三方合并

- **Decision**: `POST /knowledge-admin/knowledge-bases/{kb}/versions/{draft}/rebase`：
  1. 校验 draft 是 stale 的草稿；
  2. 以 `published_version` 为 theirs、`draft.parent_version` 为 base、`draft` 为 ours；按 lineage 分三类：仅 ours 变 → 直接采用 ours；仅 theirs 变 → 采用 theirs；双方都变 → 三方合并（`difflib` 对 base→ours 与 base→theirs 的 opcodes 做区间交叠检测：不交叠的块各自应用，交叠块产出冲突 `{base_lines, ours_lines, theirs_lines}`）；
  3. 无冲突：创建新草稿快照（克隆最新正式版资产，应用合并结果），`parent_version_id = published_version_id`，草稿名不变（旧快照标记 `superseded_by`），返回新版本；有冲突：返回 `conflicts[]`（不落库），前端逐块解决后调用 `.../rebase/resolve`，body 携带每篇冲突文档的最终 `content_md`，服务端校验无残留 `<<<<<<<`/`>>>>>>>` 标记后执行同上落库；
  4. 审计 `draft_rebased`（details: `from_base`, `to_base`, `auto_merged`, `resolved_conflicts`）。
- **Rationale**: 与原型语义一致；"新快照 + 保留草稿名"符合 Git rebase 产生新提交的模型；两步接口让冲突解决在前端完成而服务端保持无状态。
- **Alternatives**: 服务端保存"解决中"状态——被拒：多一个状态机；一次性接口要求前端预先解决冲突——被拒：前端在未拿到冲突清单前无法解决。

## R9 审阅写回

- **Decision**: 审阅编辑器的"应用到草稿"复用文档更新接口：对每篇被调整的文档调用 `PUT /api/enterprise/knowledge/documents/{id}`（`content_md` + `expected_updated_at`，指向草稿版本），新增文档拒绝 → `DELETE`/归档该草稿文档，删除拒绝 → 恢复；最后调用 `POST /knowledge-admin/.../versions/{draft}/review`（body: `staged`, `pending`, `expected_updated_at`）把审阅状态写入 `metadata_json.review`，并写审计 `draft_reviewed`。
- **Rationale**: 文档内容写入路径已存在且带乐观锁；审阅状态只是版本级元数据。
- **Alternatives**: 单个"批量写回"端点——被拒：需要事务性批量文档写入的新机制，超出必要。

## R10 前端架构与复用

- **Decision**: 新建 `pages/knowledge-admin/` 模块与唯一 API 层 `api/knowledgeAdmin.ts`（包住 `createTenantClient`，把现有内联路径收敛为命名函数）。复用 `TeamKnowledgePermissionMatrix`（群组与权限 Tab）、`SharedKnowledgeConversionDialog`（转共享）、`KnowledgeTypeBadge`、现有文档编辑对话框；`SharedKnowledgeVersionsDialog` 不复用（其"必选团队"模型与新规则冲突），版本 Tab 新写。审阅编辑器按原型实现：contenteditable 行编辑器 + 本地 LCS + 暂存基线模型，纯函数拆到 `review/*.ts` 便于 Vitest。
- **Rationale**: 现有页面 `KnowledgePage.tsx` 4000+ 行且绑定员工作用域，直接扩展不可维护；独立模块 + 单一 API 层符合宪法的依赖方向。
- **Alternatives**: 在 `KnowledgePage` 上加管理员模式——被拒。

## R11 路由、菜单与权限

- **Decision**: `EnterpriseRoute.KnowledgeAdmin = '/enterprise/knowledge-admin'`；`App.tsx` 增加两条路由（列表、`:kbId`），非 admin 重定向到 Gallery（与 `/enterprise/accounts` 一致，`App.tsx:770`）；`AppSidebar.SYSTEM_NAV` 追加项，图标落 `src/assets/icons/sys-knowledge.svg`。Tab 通过 `?tab=` 查询参数保存。
- **Rationale**: 与现有 admin-only 页面模式一致。

## R12 i18n 与 raw 边界

- **Decision**: 命名空间 `knowledgeAdmin.*`（子域 `nav`、`list`、`detail`、`content`、`versions`、`review`、`rebase`、`merge`、`grants`、`audit`、`settings`、`dialogs`、`toast`、`errors`）；版本号、草稿名、知识库/文档名、diff 行文本一律 `RawContent`/`RawIdentifier`；新错误码映射到 `errors.knowledge.baselineStale` 等。
- **Rationale**: 宪法 I/II。

## R13 性能与分页

- **Decision**: 列表默认 `limit=20`，前端 `Paginator` 复用；diff 端点对 >5000 行文档返回 `truncated=true` 与文档级摘要，前端提示"在编辑器中打开"；审阅编辑器仅对当前编辑文档重算。
