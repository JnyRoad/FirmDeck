# Contract: 知识库管理端 HTTP API

前缀 `/api/enterprise`。所有端点要求租户 token；标注 **admin** 的端点额外 `ensure_tenant_admin`。
错误一律为注册的 `ErrorDescriptor`（`code` / `params` / `retryable` / `request_id` / `trace_id`）。
时间为 ISO-8601 UTC。分页统一 `offset` / `limit` / `total` / `has_more`。

## A. 新增端点（`backend/app/api/knowledge_admin.py`）

### A1 `GET /knowledge-admin/knowledge-bases` — 租户级列表 **admin**

Query: `tenant_id`（必填）、`mode=shared|dedicated`、`status=active|archived`、`owner_agent_id`、`team_id`、`q`（名称包含）、`offset=0`、`limit=20`（≤100）

Response `200`:
```json
{
  "items": [{
    "id": "kb_…", "name": "产品 FAQ 共享库", "description": "…", "mode": "shared", "status": "active",
    "capability_scope": "general",
    "published_version": "1.1.0", "published_version_id": "kbver_…",
    "draft_count": 1,
    "document_count": 4,
    "owner_agent": null,
    "bound_teams": [{"id": "team_…", "name": "客服一组", "is_default": true}],
    "branch": null,
    "updated_at": "…"
  }, {
    "id": "kb_…", "name": "客服话术库", "mode": "dedicated", "status": "active",
    "owner_agent": {"id": "ag_…", "name": "林晓"},
    "bound_teams": [], "published_version": null, "draft_count": 0, "document_count": 2,
    "branch": {"base_version": "3", "head_version": "5", "sync_state": "diverged"},
    "updated_at": "…"
  }],
  "summary": {"total": 6, "shared": 3, "dedicated": 3, "documents": 9},
  "total": 6, "offset": 0, "limit": 20, "has_more": false
}
```
Errors: `FORBIDDEN`（非 admin）。

### A1b `GET /knowledge-admin/knowledge-bases/{kb_id}` — 单库详情（admin-first） **admin**

Query: `tenant_id`（必填）

修复缺陷 1（`.superpowers/sdd/tasks/task-T077-report.md` Defect 1）：详情页此前复用员工侧
`GET /knowledge-bases/{kb_id}`，缺 `agent_id` 时该端点只对 open-gallery 库放行，导致管理员
打开任意共享/专用库详情一律 404（`KNOWLEDGE_BASE_VERSION_NOT_VISIBLE`）卡在 Loading。本端点
不要求 `agent_id`：管理员对租户内全部知识库（共享 *和* 专用）可见。

Response `200`：形状与 A1 `items[]` 的单个元素完全一致（同一个 `KnowledgeAdminListItem`，见
上）——`draft_count`/`document_count`/`owner_agent`/`bound_teams`/`branch` 的聚合口径与 A1
共用同一份 `listing.py` 投影逻辑，保证两端点不会漂移。

Errors: `KNOWLEDGE_BASE_NOT_FOUND`（404，知识库不存在**或**存在但属于别的租户——两种情况不
区分，existence-hiding）、`PERMISSION_TENANT_ADMIN_REQUIRED`（403，非 admin）。

### A2 `GET /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/diff` — 版本对比 **admin 或该库 history viewer**

Query: `tenant_id`、`against=base|published`（默认 `base`：对比 `parent_version_id`；`published`：对比当前正式版）、`max_lines=5000`

Response `200`: 见 data-model §4（`VersionDiff`）。超过 `max_lines` 的文档 `truncated=true` 且不含 `hunks`。
每篇文档新增 `base_document_id` / `target_document_id`（T080）：分别是该文档在 base/target 各自版本内的真实行 id，对应侧不存在（added 无 base）时为 `null`；供写回定位真实行，区别于可能指向源文档的 `lineage_id`（草稿文档是克隆行）。
`kind="deleted"` 时的 `target_document_id`：草稿内删除是软删除，目标版本里那一行仍在（`status='archived'`），返回其真实行 id 供"恢复"写回定位；只有目标版本内确实没有对应行时才为 `null`。
每篇文档同时新增 `base_updated_at` / `target_updated_at`（乐观锁字段补全轮次）：分别是 `base_document_id` / `target_document_id` 那一行 `updated_at.isoformat()`，与 `PUT /knowledge/documents/{id}` 的 `expected_updated_at` 完全同一格式，对应侧 document_id 为 `null` 时同样为 `null`；供前端写回（尤其"恢复"归档行——该行被 A2b 隐藏，前端拿不到它的 `updated_at`）时原样回传做乐观锁，不必再发额外请求获取该行的 `updated_at`。`kind="deleted"` 的 `target_updated_at` 与 `target_document_id` 同源，来自草稿内归档行。
`status='archived'` 的文档按 data-model §3 表示"该版本内已删除"，base/target 两侧一律视为**不存在**：草稿里归档一篇文档 → `kind="deleted"` 且计入 `summary.deleted`；草稿里恢复一篇基线中已归档的文档 → `kind="added"`。
Errors: `KNOWLEDGE_BASE_NOT_FOUND`（404，知识库或版本**不存在**）、`KNOWLEDGE_CONTEXT_MISMATCH`（403，资源存在但跨租户/跨库）。两个查找（知识库、版本）用同一套存在性策略，不再一个 403、一个 404。

与 A1b 的口径差异（非缺陷，`_load_admin_diff_base`/`_load_admin_diff_version` 与 `get_tenant_knowledge_base` 各自独立实现）：A1b 对"不存在"与"存在但跨租户"**都**折叠为 404（existence-hiding，调用方无法区分两种情况）；A2/A2b 则用 403 `KNOWLEDGE_CONTEXT_MISMATCH` 显式区分"资源存在但跨租户/跨库"与 404 的"压根不存在"，会向调用方泄漏该 `kb_id`/`version_id` 组合是否存在。两者都只在管理员/授权调用方可达（A2/A2b 的非 admin 路径还要求 `require_shared_knowledge_history_viewer`），泄漏面有限，但前端不应假设 A1b 与 A2/A2b 对同一个不可见资源返回相同的状态码。
管理员旁路（`_load_admin_diff_base`）不校验 `mode`，因此 A2/A2b 对 dedicated 库也可用；A3/A4/A5 相反，一律经 `_shared_base` 拒绝 dedicated 库（`KNOWLEDGE_MODE_INVALID`，409），前端不应在专用库详情页提供变基/审阅入口。

### A2b `GET /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/documents` — 版本文档全量列表 **admin 或该库 history viewer**

Query: `tenant_id`

鉴权与错误语义与 A2 完全一致（同一组 `_load_admin_diff_*` helper：admin 旁路不限制 mode，非 admin 走 `require_shared_knowledge_history_viewer`）。返回该版本内**全部**文档（含未改动的，不同于 A2 只返回有变化的），每项：
```json
[{
  "id": "kdoc_…", "lineage_id": "kdoc_…", "title": "…", "filename": "…",
  "status": "ready", "bucket_count": 3, "chunk_count": 12, "updated_at": "…"
}]
```
结果按 `title` 再 `id` 稳定排序。`lineage_id` 缺失（数据质量问题）时为 `null`，不报错。
`status='archived'` 的文档（草稿内已删除，data-model §3）与 A2 同口径排除在列表之外——行本身保留，只是对消费方不可见；因此本列表不会返回 `status="archived"` 的项。
Errors: 与 A2 完全一致——`KNOWLEDGE_BASE_NOT_FOUND`（404，不存在）、`KNOWLEDGE_CONTEXT_MISMATCH`（403，跨租户/跨库）。

### A3 `POST /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/rebase` — 变基预览 / 执行 **admin 或团队 manager**

Body:
```json
{"tenant_id": "…", "change_reason": "…", "expected_updated_at": "…", "idempotency_key": "…"}
```
行为：目标必须是 `draft`、`status='active'`（未被此前的变基替换）且 `is_stale`。无冲突 → 直接落库并返回 `RebaseResult`；有冲突 → `200` 返回 `RebasePreview`（`conflicts` 非空，不落库）。
`expected_updated_at`（可选，additive）：语义与 A5 完全一致——原样透传打开草稿时拿到的 `KnowledgeBaseVersionRead.updated_at`，按微秒精度精确相等比较；不给出则不校验，给出且不匹配（或无法解析）→ `KNOWLEDGE_PUBLISH_CONFLICT`。
仅共享库可用：dedicated 库 → `KNOWLEDGE_MODE_INVALID`（409）。
Errors: `KNOWLEDGE_VERSION_NOT_READY`（非草稿、未过期，或该快照已被变基替换——重复提交同一个 `version_id` 不会造出第二份草稿）、`KNOWLEDGE_PUBLISH_CONFLICT`（期间正式版再次变化，或 `expected_updated_at` 不匹配）、`KNOWLEDGE_MODE_INVALID`。

### A4 `POST /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/rebase/resolve` — 提交冲突解决并完成变基

Body:
```json
{
  "tenant_id": "…", "change_reason": "…", "expected_updated_at": "…", "idempotency_key": "…",
  "to_base_version_id": "kbver_…",
  "resolutions": [{"lineage_id": "kdoc_…", "content_md": "…完整合并结果…"}]
}
```
校验：目标仍是活动草稿（未被替换）；`to_base_version_id` 仍是当前正式版；`expected_updated_at`（可选）语义同 A3；每篇冲突文档都有 resolution；内容不含 `<<<<<<<` / `=======` / `>>>>>>>` 标记。
落库时每篇被写入的文档都走与在线编辑同一条重建路径（`document_card`/`section_tree`/buckets/chunks/discovery 与 `bucket_count`/`chunk_count` 一并刷新）；`delete` 动作按 data-model §3 软删除（`status='archived'`）并清理该版本内的派生行。
Response `200`: `RebaseResult`。新草稿的 `metadata` 继承旧快照的来源信息，但**不**继承 A5 的 `review` 块（旧快照的审阅统计对新草稿已失效）。
仅共享库可用：dedicated 库 → `KNOWLEDGE_MODE_INVALID`（409）。
Errors: `KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED`、`KNOWLEDGE_PUBLISH_CONFLICT`、`KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH`、`KNOWLEDGE_VERSION_NOT_READY`、`KNOWLEDGE_MODE_INVALID`。

### A5 `POST /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/review` — 写入审阅状态 **admin 或团队 manager**

Body: `{"tenant_id": "…", "staged": 4, "pending": 0, "documents_adjusted": 2, "expected_updated_at": "…"}`
Response `200`: `KnowledgeBaseVersionRead`（含 `metadata.review`）。审计 `draft_reviewed`，事件 `knowledge.draft.reviewed`。
Errors: `KNOWLEDGE_VERSION_NOT_READY`（非草稿）、`KNOWLEDGE_PUBLISH_CONFLICT`（`expected_updated_at` 不匹配或无法解析）。
`expected_updated_at` 语义：调用方必须原样透传打开草稿时拿到的 `KnowledgeBaseVersionRead.updated_at` 字符串（不得重新格式化/裁剪精度），服务端按微秒精度精确相等比较（非容差匹配）；解析失败（格式非法）与数值不相等一样统一折叠为 `KNOWLEDGE_PUBLISH_CONFLICT`（409），不返回 400，避免向调用方泄漏校验细节。A3/A4 复用同一套语义，区别只是那里为可选字段。
仅共享库可用：dedicated 库 → `KNOWLEDGE_MODE_INVALID`（409）；与 A2/A2b 的管理员旁路不同，前端不应在专用库详情页提供审阅入口。

### A6 `GET /knowledge-admin/teams` — 可绑定群组候选 **admin**

Query: `tenant_id`、`exclude_bound_to=kb_id`（可选）。Response: `[{id, name, member_count}]`。
（供"绑定新群组"下拉；替代当前恒为空的共享库候选逻辑。）
无独立的"查询某库已绑定群组"端点；`GrantsTab` 用本端点两次（一次不带 `exclude_bound_to` 取全部活跃群组、一次带 `exclude_bound_to=kb_id` 取未绑定候选）做差集得到已绑定群组 id 集合，再逐个调用既有 `listTeamBindings(team_id)` 取该群组在本库的绑定记录（修订号、矩阵）。

## B. 变更端点

### B1 `POST /knowledge-bases/{kb_id}/drafts`、`.../versions/{id}/publish`、`.../versions/{id}/reject`、`.../rollback`

- `team_id` 由必填改为 `str | null`：为 `null` 时要求调用者是租户管理员（`require_team_knowledge_manager` 旁路），审计 `team_id=null`、`details.actor_context="tenant_admin"`。
- `publish` 新增 body 字段：`level: "patch" | "minor" | "major"`（默认 `patch`）、`force_overwrite: bool`（默认 `false`）。草稿基线过期且未 `force_overwrite` → `KNOWLEDGE_BASELINE_STALE`；`force_overwrite=true` 时审计 `forced_overwrite=true`。
- `publish` 响应 `KnowledgeBaseVersionRead.version` 为新分配的 semver，`metadata.draft_name` 为来源草稿名。
- `drafts` 响应的 `version` 为草稿名（`draft-xxxx`）。
- `publish`/`reject` 都经 `SharedKnowledgeVersionService.require_writable_draft`：目标是已被变基替换的草稿快照（`status='archived'` 且 `metadata.superseded_by` 非空，data-model §2）时一律 `KNOWLEDGE_MODE_INVALID`（409，"该草稿已被变基替换，请打开最新的草稿快照。"），即使 `publication_state` 仍是 `draft`——防止过期页签发布或驳回一份已作废的快照。与 A3/A4/A5 把同一情形折叠为 `KNOWLEDGE_VERSION_NOT_READY` 不同：B1 复用 `require_writable_draft` 的默认错误码，未单独改写为 A5 的契约码。

### B2 `GET /knowledge-bases/{kb_id}/versions`

- 每项新增：`is_stale: bool`、`base_version: string|null`、`draft_name: string|null`、`next_version_preview: {"patch": "…", "minor": "…", "major": "…"}`（仅草稿）。
- 排序由服务端保证：进行中草稿（新在前）→ released 按 semver 降序 → rejected 按时间降序。
- 不返回 `status='archived'` 的行：变基替换掉的旧草稿快照（`metadata.superseded_by`）不是一份可操作的草稿。A1 的 `draft_count`、本列表的草稿条目数、`knowledge.version.published` 事件的 `stale_draft_count` 三者同口径，任何时刻都应一致。

### B3 `POST /knowledge/documents`（上传）、`PUT /knowledge/documents/{id}`、`DELETE`（归档）

- 共享库写入必须携带 `knowledge_base_version_id` 且为 `draft`（已有校验）；权限增加管理员旁路（无 `team_id` 时 admin 可写任意草稿）。
- 克隆与新建文档写入 `metadata.lineage_id`。

### B4 `DELETE /knowledge-bases/{kb_id}`（无 `agent_id`，admin）

- 共享库删除同事务清理 `team_knowledge_base_bindings`、`team_knowledge_base_grants`、`teams.default_knowledge_base_id`。（外部修复，research R6；本契约声明期望行为。）
- 若存在进行中草稿，响应 header/body 不阻止，但前端二次确认展示 `draft_count`（来自 A1）。

### B5 `PUT /teams/{team_id}/knowledge-bases/{kb_id}/grants`（不变）

沿用 `expected_revision` 乐观锁与全矩阵原子替换；前端批量设置只是客户端组装。

## C. 乐观锁与幂等约定

| 操作 | 锁 | 幂等 |
|---|---|---|
| 创建草稿 | `expected_published_version_id`（可选） | — |
| 发布 / 回滚 | `expected_published_version_id`（必填） | `idempotency_key` |
| 驳回 | — | `idempotency_key` |
| 变基 / 解决 | `to_base_version_id` 必须仍为当前正式版；`expected_updated_at`（可选，语义同 A5） | `idempotency_key` |
| 审阅写回 | `expected_updated_at` | — |
| 文档更新 | `expected_updated_at` | — |
| 权限矩阵 | `expected_revision` | — |
