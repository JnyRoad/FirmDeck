# Data Model: knowledge-base-admin

原则：**只做 additive 变更**——不新增表、不删列；新语义通过既有列的取值约定与 `metadata_json` 承载。
表与字段引用 `backend/app/db/models.py`。

## 1. KnowledgeBase（`knowledge_bases`，不变）

| 字段 | 语义 |
|---|---|
| `mode` | `shared` / `dedicated` |
| `published_version_id` | 共享库唯一正式指针（读取侧只读它） |
| `status` | `active`（上线）/ `archived`（下线） |
| `metadata_json.owner_agent_id` | 私有库归属员工（列表用于"归属"列与过滤；P1 评估提升为列） |

## 2. KnowledgeBaseVersion（`knowledge_base_versions`，语义扩展）

| 字段 | 现状 | 本功能约定 |
|---|---|---|
| `version` | 建草稿时即分配 semver | **草稿**：`draft-<4 位十六进制>`（取版本 id 末 4 位；与同库既有 `version` 冲突时依次加长为 6、8 位）；**发布时**改写为按 level 递进的 semver；驳回保留草稿名 |
| `publication_state` | `draft` / `released` / `rejected` | 不变 |
| `parent_version_id` | 克隆来源 | 作为**草稿基线**；变基后更新为最新正式版 id |
| `source_team_id` | 必填团队 | 管理员直连时为 `NULL` |
| `metadata_json.draft_name` | — | 草稿名（发布后保留以追溯来源） |
| `metadata_json.published_from_draft` | — | 发布后 `true` |
| `metadata_json.version_level` | — | 发布时的递进级别 `patch` / `minor` / `major` |
| `metadata_json.review` | — | `{staged:int, pending:int, reviewed_at:iso, reviewed_by_user_id}` |
| `metadata_json.superseded_by` | — | 变基后旧快照指向新快照 id（旧快照 `status='archived'`） |
| `metadata_json.rebased_from` | — | 新快照记录 `{previous_version_id, from_base_version_id, to_base_version_id}` |

**派生字段（不落库，读时计算）**：`is_stale = publication_state=='draft' and parent_version_id != kb.published_version_id`；`base_version = parent.version`；`next_version_preview[level]`。

### 草稿状态机

```text
                创建草稿(基线=当前正式版)
   ┌────────────┐ ──────────────────────► ┌────────────┐
   │ (无)       │                          │ draft      │◄──┐ 编辑/上传/删除文档、审阅写回
   └────────────┘                          └─────┬──────┘   │ （草稿名不变）
                                                 │          │
                 基线过期且变基 ─────────────────┼──────────┘ 新快照 draft（旧快照 archived/superseded）
                                                 │
              发布(分配 semver, 移动正式指针) ────┼──► released（成为 published head）
              驳回 ───────────────────────────────┴──► rejected（快照保留，草稿名保留）
              回滚(移动正式指针到历史 released) ── 不改变任何版本状态，只改 kb.published_version_id
```

### 版本号分配规则

- 候选集合 = 该库全部 `released` 版本中可解析为 `v?MAJOR.MINOR.PATCH` 的标签；取最大三元组 `M.m.p`。
- `patch` → `M.m.(p+1)`；`minor` → `M.(m+1).0`；`major` → `(M+1).0.0`。空集合按 `1.0.0` 起算（现有创建流程已生成 `1.0.0`）。
- 若结果已存在（历史手工数据），继续按同级递进直到未占用。

## 3. KnowledgeDocument（`knowledge_documents`，语义扩展）

| 字段 | 本功能约定 |
|---|---|
| `knowledge_base_version_id` | 共享库写入必须指向 `draft` 版本 |
| `metadata_json.lineage_id` | 跨版本文档身份：克隆时继承，首次出现时 = 源文档 id；对比与变基按它配对 |
| `status` | 复用现有；草稿内"删除"= 该草稿版本内的文档 `status='archived'`（正式版对应文档不受影响） |

**草稿覆盖层（前端概念，服务端由版本级文档集合表达）**：草稿版本拥有自己的完整文档集合；相对基线的
"新增 / 修改 / 删除"由 `diff` 端点按 lineage 计算，不单独存储。

## 4. 对比结果（响应模型，不落库）

```text
VersionDiff
├── base_version_id / target_version_id / pairing ("lineage" | "filename")
├── summary { added, modified, deleted }
└── documents[]
    ├── lineage_id, title, kind ("added" | "modified" | "deleted"), truncated
    └── hunks[]  (kind="modified" 时)
        ├── type ("equal" | "change")
        ├── base_start, base_lines[], target_start, target_lines[]   # 行号 0-based
        └── pairs[]  # change 块内 [base_idx, target_idx] 的相似行配对（按顺序位置对齐，非编辑距离对齐），供字符级高亮
```

## 5. 变基结果（响应模型，不落库）

```text
RebasePreview
├── draft_version_id, from_base_version_id, to_base_version_id
├── auto_merged[]  { lineage_id, title, source: "ours" | "theirs" | "merged" }
└── conflicts[]
    ├── lineage_id, title
    └── blocks[]  { base_lines[], ours_lines[], theirs_lines[], context_before[], context_after[] }
RebaseResult
├── new_version (KnowledgeBaseVersionRead, 草稿名不变, parent = 最新正式版)
└── superseded_version_id
```

## 6. TeamKnowledgeBaseBinding / TeamKnowledgeBaseGrant（不变）

沿用 `revision` 乐观锁与 `permission ∈ {reader, editor, publisher}`；解绑撤销授权与默认指针的逻辑已存在。
删除共享库时需连带清理二者与 `Team.default_knowledge_base_id`（外部修复任务，见 research R6）。

## 7. KnowledgeBaseAuditEvent（`knowledge_base_audit_events`，新增 action 取值）

| action | 触发 | details |
|---|---|---|
| `draft_created` | 现有 | 新增 `actor_context: "team" \| "tenant_admin"` |
| `version_published` | 现有 | 新增 `draft_name`, `version_level`, `forced_overwrite: bool` |
| `draft_rejected` / `version_rolled_back` | 现有 | 不变 |
| `draft_rebased` | 新增 | `from_base_version`, `to_base_version`, `auto_merged_count`, `resolved_conflict_count` |
| `draft_reviewed` | 新增 | `staged`, `pending`, `documents_adjusted` |
| `document_uploaded` / `document_updated` / `document_archived` | 现有或新增 | `lineage_id`, `draft_name` |

## 8. 系统事件（EventRegistry，新增）

| event_code | params | 用途 |
|---|---|---|
| `knowledge.version.published` | `knowledge_base_id`, `version`, `stale_draft_count` | 通知其他草稿持有者基线过期（本期仅记录与站内派生提示） |
| `knowledge.draft.rebased` | `knowledge_base_id`, `draft_name`, `to_base_version` | 审计与通知 |
| `knowledge.draft.reviewed` | `knowledge_base_id`, `draft_name`, `staged`, `pending` | 发布框展示审阅状态 |

## 9. 错误码（error_registry，新增）

| code | message_key | HTTP | params |
|---|---|---|---|
| `KNOWLEDGE_BASELINE_STALE` | `errors.knowledge.baselineStale` | 409 | `base_version`, `published_version`, `conflict_count` |
| `KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED` | `errors.knowledge.rebaseConflictsUnresolved` | 409 | `document_count` |
| `KNOWLEDGE_VERSION_LEVEL_INVALID` | `errors.knowledge.versionLevelInvalid` | 400 | `level` |
| `KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH` | `errors.knowledge.documentLineageMismatch` | 409 | `lineage_id` |
