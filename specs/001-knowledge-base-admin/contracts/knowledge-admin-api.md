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

### A2 `GET /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/diff` — 版本对比 **admin 或该库 history viewer**

Query: `tenant_id`、`against=base|published`（默认 `base`：对比 `parent_version_id`；`published`：对比当前正式版）、`max_lines=5000`

Response `200`: 见 data-model §4（`VersionDiff`）。超过 `max_lines` 的文档 `truncated=true` 且不含 `hunks`。
每篇文档新增 `base_document_id` / `target_document_id`（T080）：分别是该文档在 base/target 各自版本内的真实行 id，对应侧不存在（added 无 base、deleted 无 target）时为 `null`；供写回定位真实行，区别于可能指向源文档的 `lineage_id`（草稿文档是克隆行）。
Errors: `KNOWLEDGE_BASE_NOT_FOUND`、`KNOWLEDGE_CONTEXT_MISMATCH`。

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
Errors: `KNOWLEDGE_BASE_NOT_FOUND`、`KNOWLEDGE_CONTEXT_MISMATCH`。

### A3 `POST /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/rebase` — 变基预览 / 执行 **admin 或团队 manager**

Body:
```json
{"tenant_id": "…", "change_reason": "…", "idempotency_key": "…"}
```
行为：目标必须是 `draft` 且 `is_stale`。无冲突 → 直接落库并返回 `RebaseResult`；有冲突 → `200` 返回 `RebasePreview`（`conflicts` 非空，不落库）。
Errors: `KNOWLEDGE_VERSION_NOT_READY`（非草稿或未过期）、`KNOWLEDGE_PUBLISH_CONFLICT`（期间正式版再次变化）。

### A4 `POST /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/rebase/resolve` — 提交冲突解决并完成变基

Body:
```json
{
  "tenant_id": "…", "change_reason": "…", "idempotency_key": "…",
  "to_base_version_id": "kbver_…",
  "resolutions": [{"lineage_id": "kdoc_…", "content_md": "…完整合并结果…"}]
}
```
校验：`to_base_version_id` 仍是当前正式版；每篇冲突文档都有 resolution；内容不含 `<<<<<<<` / `=======` / `>>>>>>>` 标记。
Response `200`: `RebaseResult`。
Errors: `KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED`、`KNOWLEDGE_PUBLISH_CONFLICT`、`KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH`。

### A5 `POST /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/review` — 写入审阅状态 **admin 或团队 manager**

Body: `{"tenant_id": "…", "staged": 4, "pending": 0, "documents_adjusted": 2, "expected_updated_at": "…"}`
Response `200`: `KnowledgeBaseVersionRead`（含 `metadata.review`）。审计 `draft_reviewed`，事件 `knowledge.draft.reviewed`。
Errors: `KNOWLEDGE_VERSION_NOT_READY`（非草稿）、`KNOWLEDGE_PUBLISH_CONFLICT`（`expected_updated_at` 不匹配）。

### A6 `GET /knowledge-admin/teams` — 可绑定群组候选 **admin**

Query: `tenant_id`、`exclude_bound_to=kb_id`（可选）。Response: `[{id, name, member_count}]`。
（供"绑定新群组"下拉；替代当前恒为空的共享库候选逻辑。）

## B. 变更端点

### B1 `POST /knowledge-bases/{kb_id}/drafts`、`.../versions/{id}/publish`、`.../versions/{id}/reject`、`.../rollback`

- `team_id` 由必填改为 `str | null`：为 `null` 时要求调用者是租户管理员（`require_team_knowledge_manager` 旁路），审计 `team_id=null`、`details.actor_context="tenant_admin"`。
- `publish` 新增 body 字段：`level: "patch" | "minor" | "major"`（默认 `patch`）、`force_overwrite: bool`（默认 `false`）。草稿基线过期且未 `force_overwrite` → `KNOWLEDGE_BASELINE_STALE`；`force_overwrite=true` 时审计 `forced_overwrite=true`。
- `publish` 响应 `KnowledgeBaseVersionRead.version` 为新分配的 semver，`metadata.draft_name` 为来源草稿名。
- `drafts` 响应的 `version` 为草稿名（`draft-xxxx`）。

### B2 `GET /knowledge-bases/{kb_id}/versions`

- 每项新增：`is_stale: bool`、`base_version: string|null`、`draft_name: string|null`、`next_version_preview: {"patch": "…", "minor": "…", "major": "…"}`（仅草稿）。
- 排序由服务端保证：进行中草稿（新在前）→ released 按 semver 降序 → rejected 按时间降序。

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
| 变基 / 解决 | `to_base_version_id` 必须仍为当前正式版 | `idempotency_key` |
| 审阅写回 | `expected_updated_at` | — |
| 文档更新 | `expected_updated_at` | — |
| 权限矩阵 | `expected_revision` | — |
