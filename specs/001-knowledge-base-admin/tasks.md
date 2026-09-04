# Tasks: 租户管理端统一知识库管理（knowledge-base-admin）

**Input**: Design documents from `specs/001-knowledge-base-admin/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/knowledge-admin-api.md, contracts/frontend-surface.md, quickstart.md

**Tests**: 本功能强制 TDD——每个实现任务前面都有对应的、必须先失败的测试任务；测试任务不是可选项。
执行由 superpowers 流程（隔离 worktree + `test-driven-development`）承担，**禁止使用 `speckit-implement`**。

**Organization**: 按用户故事分组；US1–US3 为 P0（同一交付批次），US4–US5 为 P1。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1…US5）；Setup / Foundational / Polish 无标签
- 每个任务都写明精确文件路径（仓库根相对路径）

## Path Conventions

- 后端：`backend/app/…`，测试 `backend/tests/…`
- 前端：`frontend-enterprise/src/…`，测试与实现同目录 `*.test.ts(x)`

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 外部依赖确认、契约注册、i18n 命名空间、路由与菜单骨架

- [X] T001 验证外部修复是否已合入：检查 backend/app/api/knowledge_bases.py 的无 agent_id 删除分支是否已同事务清理 `TeamKnowledgeBaseBinding`、`TeamKnowledgeBaseGrant` 与 `Team.default_knowledge_base_id`（`git log --all -- backend/app/api/knowledge_bases.py` + 读代码）；把结论写入本文件 Notes；未合入则执行 T002/T003，已合入则跳过并勾选
- [X] T002 [兜底·测试] 在 backend/tests/test_knowledge_admin_delete_cleanup.py 编写失败测试：管理员删除共享库后绑定、授权、团队默认写入指针全部清理，私有库删除清理分支与资源绑定
- [X] T003 [兜底] 在 backend/app/api/knowledge_bases.py 删除分支实现同事务清理（仅当 T001 判定未合入）
- [X] T004 [P] [测试] 在 backend/tests/test_error_contracts.py 增加断言：`KNOWLEDGE_BASELINE_STALE`(409)、`KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED`(409)、`KNOWLEDGE_VERSION_LEVEL_INVALID`(400)、`KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH`(409) 已注册且 message_key 为 `errors.knowledge.*`
- [X] T005 [P] 在 backend/app/contracts/error_registry.py 注册上述四个错误码（含 params 名称：`base_version`/`published_version`/`conflict_count`、`document_count`、`level`、`lineage_id`）
- [X] T006 [P] [测试] 在 backend/tests/test_event_contracts.py 增加断言：`knowledge.version.published`、`knowledge.draft.rebased`、`knowledge.draft.reviewed` 已注册且 params schema 与 data-model.md §8 一致
- [X] T007 [P] 在 backend/app/contracts/event_registry.py 注册三个事件（与现有 `knowledge.ingest.*` 事件同处），声明 params schema、visibility，legacy projection 为 none
- [X] T008 [P] [测试] 在 frontend-enterprise/src/i18n/knowledgeAdmin.i18n.test.ts 编写失败测试：`knowledgeAdmin.*` 与 `errors.knowledge.{baselineStale,rebaseConflictsUnresolved,versionLevelInvalid,documentLineageMismatch}` 在 en-US 与 zh-CN 目录键集合对等且 ICU 参数一致
- [X] T009 [P] 在 frontend-enterprise/src/i18n/messages/en-US.json 与 zh-CN.json 新增 `knowledgeAdmin.*` 命名空间（按 contracts/frontend-surface.md 子域）与 `shell.nav.knowledgeAdmin`、四条 `errors.knowledge.*`
- [X] T010 [P] [测试] 在 frontend-enterprise/src/App.test.tsx 增加失败测试：admin 可打开 `/enterprise/knowledge-admin` 与 `/enterprise/knowledge-admin/:kbId`；非 admin 被重定向到 Gallery
- [X] T011 [P] [测试] 在 frontend-enterprise/src/components/AppSidebar.test.tsx 增加失败测试：admin 的系统管理组出现「知识库管理」，非 admin 不出现
- [X] T012 实现路由与菜单：frontend-enterprise/src/enums/routes.ts 增加 `KnowledgeAdmin`；frontend-enterprise/src/App.tsx 增加两条 admin-only 路由（占位页面组件）；frontend-enterprise/src/components/AppSidebar.tsx `SYSTEM_NAV` 追加项；新增 frontend-enterprise/src/assets/icons/sys-knowledge.svg
- [X] T013 [P] 新增 frontend-enterprise/src/enums/knowledge.ts（`KnowledgeBaseMode`、`PublicationState`、`KnowledgePermission`、`VersionLevel`）与 frontend-enterprise/src/types/knowledgeAdmin.ts（按 contracts/knowledge-admin-api.md 的响应类型）

---

## Phase 2: Foundational（阻塞所有用户故事）

**Purpose**: 后端六项核心能力与前端 API 层；全部先测试后实现

**⚠️ CRITICAL**: 未完成前不得开始任何用户故事

- [X] T014 [P] [测试] 在 backend/tests/test_knowledge_lineage.py 编写失败测试：新建文档写入 `metadata_json.lineage_id`；`clone_knowledge_version_assets` 克隆时继承 lineage；缺失 lineage 的历史文档对比时按 filename 回退并标 `pairing="filename"`
- [X] T015 实现 lineage：backend/app/agents/branching.py（`clone_knowledge_version_assets`）与 backend/app/knowledge/service.py（新建文档）写入/继承 `lineage_id`
- [X] T016 [P] [测试] 在 backend/tests/test_knowledge_version_labels.py 编写失败测试：建草稿 `version=draft-<4hex>` 且 `parent_version_id=published`；`publish(level)` 按 patch/minor/major 递进且高于现有最高 released；非法 level → `KNOWLEDGE_VERSION_LEVEL_INVALID`；驳回保留草稿名；草稿名与同库既有 `version` 冲突时自动加长为 6/8 位十六进制；手工数据已占用 `1.0.1` 时 patch 发布分配 `1.0.2`；`KnowledgeBaseVersionRead` 含 `is_stale`/`base_version`/`draft_name`/`next_version_preview`；版本列表顺序 草稿(新在前)→released(semver 降序)→rejected
- [X] T017 实现版本规则：backend/app/knowledge/versioning.py（草稿命名、`_next_shared_version_label(level)` 移到发布时、审计 details 增 `draft_name`/`version_level`）、backend/app/knowledge/schema.py（`SharedKnowledgePublishRequest.level`/`force_overwrite`，`KnowledgeBaseVersionRead` 新字段）、backend/app/api/knowledge_bases.py（versions 端点排序与投影）
- [X] T018 [P] [测试] 在 backend/tests/test_knowledge_admin_bypass.py 编写失败测试：租户 admin 不带 team_id 可 drafts/publish/reject/rollback 未绑定群组的共享库，审计 `team_id=None` 且 `details.actor_context="tenant_admin"`；非 admin 不带 team_id → `KNOWLEDGE_GRANT_REQUIRED`；文档上传/更新指向草稿时 admin 无 team 亦可写
- [X] T019 实现管理员旁路：backend/app/knowledge/management.py（`require_team_knowledge_manager` 的 team_id 可选分支）、backend/app/knowledge/schema.py（四个请求 `team_id: str | None`）、backend/app/api/knowledge_bases.py 与 backend/app/api/knowledge.py 调用点
- [X] T020 [P] [测试] 在 backend/tests/test_knowledge_admin_listing.py 编写失败测试：`GET /api/enterprise/knowledge-admin/knowledge-bases` 返回未绑定共享库与各员工私有库、`summary`、`draft_count`、`bound_teams`、`owner_agent`、`branch`；`mode`/`status`/`owner_agent_id`/`team_id`/`q` 过滤；`offset/limit/has_more`；非 admin 403；`GET /knowledge-admin/teams` 候选群组含 `exclude_bound_to`
- [X] T021 实现列表：backend/app/knowledge/listing.py（查询与聚合）、backend/app/api/knowledge_admin.py（A1、A6 路由，`ensure_tenant_admin`）、backend/app/main.py 注册路由、backend/app/knowledge/schema.py 响应模型
- [ ] T022 [P] [测试] 在 backend/tests/test_knowledge_diff.py 编写 fixture 失败测试：新增/修改/删除文档级清单；`hunks` 的 equal/change 块与行区间；change 块内相似度配对 `pairs`；`against=base|published`；`max_lines` 截断 `truncated=true`；非 admin 且非 history viewer 403
- [ ] T023 实现对比：backend/app/knowledge/diff.py（`difflib.SequenceMatcher(autojunk=False)`）与 backend/app/api/knowledge_admin.py A2 路由
- [ ] T024 [P] [测试] 在 backend/tests/test_knowledge_rebase.py 编写 fixture 失败测试：仅 ours 变/仅 theirs 变/双方不交叠 → 自动合并并直接落库（新快照、草稿名不变、`parent=published`、旧快照 `superseded_by`）；交叠 → 返回 `conflicts[]` 不落库；`resolve` 残留 `<<<<<<<` → `KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED`；`to_base_version_id` 已变 → `KNOWLEDGE_PUBLISH_CONFLICT`；缺 resolution → `KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH`；非 stale 草稿 → `KNOWLEDGE_VERSION_NOT_READY`；团队 owner 通过绑定团队（带 `team_id`）变基成功、非 owner 非 admin → `KNOWLEDGE_GRANT_REQUIRED`；审计 `draft_rebased` 与事件 `knowledge.draft.rebased`；publish stale 未 force → `KNOWLEDGE_BASELINE_STALE`，force → 审计 `forced_overwrite`
- [ ] T025 实现变基：backend/app/knowledge/rebase.py（三方合并、冲突块、落库）、backend/app/api/knowledge_admin.py A3/A4 路由、backend/app/knowledge/versioning.py（publish 的 stale 判定与 `force_overwrite`）、事件 `knowledge.version.published` 发出
- [ ] T026 [P] [测试] 在 backend/tests/test_knowledge_review_writeback.py 编写失败测试：`POST …/versions/{draft}/review` 写入 `metadata.review`；`expected_updated_at` 不匹配 → `KNOWLEDGE_PUBLISH_CONFLICT`；非草稿 → `KNOWLEDGE_VERSION_NOT_READY`；审计 `draft_reviewed` 与事件
- [ ] T027 实现审阅写回：backend/app/api/knowledge_admin.py A5 路由与 backend/app/knowledge/versioning.py
- [X] T028 [P] [测试] 在 frontend-enterprise/src/api/knowledgeAdmin.test.ts 编写失败测试（mock tenant client）：每个函数的 method/路径/query/body 与 contracts/knowledge-admin-api.md 一致
- [X] T029 实现 frontend-enterprise/src/api/knowledgeAdmin.ts（包住 `createTenantClient`，函数与契约 A/B 一一对应）

**Checkpoint**: 后端六项能力与前端 API 层就绪，用户故事可并行开始

---

## Phase 3: User Story 1 - 管理员总览并管理全部知识库 (Priority: P1) 🎯 MVP

**Goal**: 仅 admin 可见的列表页与详情骨架（设置 Tab），新建/上下线/删除

**Independent Test**: 管理员看到全部库并可筛选、进入详情改名、新建私有库需选员工；非 admin 被重定向（quickstart S1）

### Tests for User Story 1

- [ ] T030 [P] [US1] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/knowledgeAdminModel.test.ts 编写失败测试：排序、筛选谓词、统计、版本状态徽章文案选择、`nextVersionLabel(level)` 纯函数
- [ ] T031 [P] [US1] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/KnowledgeAdminListPage.test.tsx 编写失败测试：统计卡、类型页签、四类筛选与搜索、未绑定提示、行点击跳转、`⋯` 菜单项按 mode 差异、新建对话框（私有未选员工阻止）、下线/删除二次确认（展示 `draft_count`）
- [ ] T032 [P] [US1] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/KnowledgeAdminDetailPage.test.tsx 编写失败测试：按 mode 渲染 Tab 集、`?tab=` 与 URL 同步、面包屑返回、设置 Tab 保存名称/描述/能力范围、上线/下线、删除

### Implementation for User Story 1

- [ ] T033 [US1] 实现 frontend-enterprise/src/pages/knowledge-admin/knowledgeAdminModel.ts
- [ ] T034 [US1] 实现 frontend-enterprise/src/pages/knowledge-admin/KnowledgeAdminListPage.tsx 与 dialogs/CreateKnowledgeBaseDialog.tsx、dialogs/DeleteDialog.tsx（复用 `KnowledgeTypeBadge`、shadcn 组件、`RawContent`；行菜单「导出备份」「图谱检查」复用现有 `GET …/okf/export` 与 `POST …/okf/lint` 端点）
- [ ] T035 [US1] 实现 frontend-enterprise/src/pages/knowledge-admin/KnowledgeAdminDetailPage.tsx 与 shared/SettingsTab.tsx（其余 Tab 先占位），替换 T012 的占位组件

**Checkpoint**: US1 可独立演示（列表 + 详情设置）

---

## Phase 4: User Story 2 - 共享库草稿协作、审阅与发布 (Priority: P1)

**Goal**: 内容 Tab（版本切换、草稿工作区）、审阅编辑器（暂存/拒绝/直接编辑/行级/选区）、版本 Tab、发布框（level）、审计 Tab

**Independent Test**: quickstart S2 全流程；发布后正式版内容与审阅结果一致，版本号为修订号 +1

### Tests for User Story 2

- [X] T036 [P] [US2] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/review/lineDiff.test.ts 编写失败测试：LCS 行 diff、`splitLines('')=[]`、空/相同/全变输入
- [X] T037 [P] [US2] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/review/hunkModel.test.ts 编写失败测试：rows/hunks 构建（`insertAt`/`bs`/`bi`）、相似度配对 `alignHunk`、字符级 `charOps`/`innerHtml`、`restorePos`
- [X] T038 [P] [US2] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/review/staging.test.ts 编写失败测试：`stage` 更新暂存基线与后续记录偏移、`unstage` 精确校验与偏移回退、接受全部按降序、拒绝、重置、`pending`/`hasWork`
- [X] T039 [US2] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/review/ReviewEditor.test.tsx 编写失败测试：输入后整篇重算与光标保持；Enter 拆行/Backspace 合并/Delete；跨行选区 Backspace、insertText、粘贴多行；composition 期间不重绘、结束后同步；块接受折叠为 ✓ 行 + 撤销接受；红行 ↩ 恢复（配对替换 / 未配对插回）；绿行 ✕；选区撤销按钮启用与执行；新增文档整篇拒绝、删除文档拒绝恢复；顶部计数与 apply 可用性
- [ ] T040 [P] [US2] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/shared/ContentTab.test.tsx 编写失败测试：视图切换器；正式视图只读且隐藏草稿新增；草稿视图新增/修改/删除标记与恢复；横幅信息（创建者、来源、基线、发布后版本号预览、原因）与按钮；上传/编辑/删除请求携带草稿 `knowledge_base_version_id`
- [ ] T041 [P] [US2] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/shared/ContentTab.reviewApply.test.tsx 编写失败测试：「应用到草稿」按审阅结果调用文档更新（`content_md`+`expected_updated_at`）、新增拒绝归档、删除拒绝恢复，最后调用 review 端点；成功后 toast 与刷新；从发布框进入时应用后返回发布框；文档更新或 review 返回 `KNOWLEDGE_PUBLISH_CONFLICT` 时提示"草稿已被他人修改，请刷新后重新审阅"且不提交剩余写回
- [ ] T042 [P] [US2] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/shared/VersionsTab.test.tsx 编写失败测试：服务端顺序原样展示、草稿行 查看变更/发布/驳回、released 行回滚、当前正式版标记、创建草稿对话框（原因必填、来源上下文含"管理员直连"）
- [ ] T043 [P] [US2] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/dialogs/PublishDialog.test.tsx 编写失败测试：标题显示 `draft → next`；level 下拉切换更新结果号；审阅状态展示；非 stale 单按钮确认；stale 时展示冲突数与三按钮（变基/仍然覆盖发布/取消），覆盖发布调用 `force_overwrite=true`
- [ ] T044 [P] [US2] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/shared/AuditTab.test.tsx 编写失败测试：动作/群组/操作者/版本筛选、分页加载更多、raw 字段用 `RawContent`

### Implementation for User Story 2

- [X] T045 [P] [US2] 实现 frontend-enterprise/src/pages/knowledge-admin/review/lineDiff.ts
- [X] T046 [P] [US2] 实现 frontend-enterprise/src/pages/knowledge-admin/review/hunkModel.ts
- [X] T047 [P] [US2] 实现 frontend-enterprise/src/pages/knowledge-admin/review/staging.ts
- [X] T048 [US2] 实现 frontend-enterprise/src/pages/knowledge-admin/review/editorDom.ts（光标定位、行读取、选区映射）与 review/ReviewEditor.tsx（contenteditable 行编辑器、事件处理、暂存折叠渲染、行级/选区操作；文案由 props 注入）
- [ ] T049 [US2] 实现 frontend-enterprise/src/pages/knowledge-admin/shared/ContentTab.tsx（含审阅打开与写回、复用现有文档编辑对话框）
- [ ] T050 [US2] 实现 frontend-enterprise/src/pages/knowledge-admin/shared/VersionsTab.tsx 与 dialogs/CreateDraftDialog.tsx
- [ ] T051 [US2] 实现 frontend-enterprise/src/pages/knowledge-admin/dialogs/PublishDialog.tsx（stale 分支通过 `onRebase` 回调交给 US3）
- [ ] T052 [US2] 实现 frontend-enterprise/src/pages/knowledge-admin/shared/AuditTab.tsx
- [ ] T053 [US2] 在 frontend-enterprise/src/pages/knowledge-admin/KnowledgeAdminDetailPage.tsx 接入 ContentTab/VersionsTab/AuditTab，删除占位

**Checkpoint**: US1 + US2 可独立演示（quickstart S1、S2）

---

## Phase 5: User Story 3 - 多草稿并行与变基 (Priority: P1)

**Goal**: 基线过期提示、变基预览、逐行三方合并对话框、完成变基后发布

**Independent Test**: quickstart S3（两草稿改同一文档先后发布，第二个经变基 + 合并发布为下一个修订号，内容零丢失）

### Tests for User Story 3

- [ ] T054 [P] [US3] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/dialogs/RebaseDialog.test.tsx 编写失败测试：预览列出自动合并与冲突文档；无冲突直接完成并刷新；有冲突逐篇进入合并；全部解决后调用 `rebase/resolve`；服务端 `KNOWLEDGE_PUBLISH_CONFLICT` 时提示重新预览
- [ ] T055 [P] [US3] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/dialogs/MergeDialog.test.tsx 编写失败测试：非冲突段直接合并；冲突块两栏对照与四种选择（采用草稿/采用正式版/两者都保留/编辑此段）；结果区带 Git 标记可手动编辑；残留标记时「完成」禁用；输出 `{lineage_id, content_md}`
- [ ] T056 [P] [US3] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/shared/ContentTab.stale.test.tsx 编写失败测试：`is_stale` 草稿横幅显示"正式版已更新为 vX，本草稿基于 vY"，版本 Tab 同步标记
- [ ] T057 [P] [US3] [测试] 在 backend/tests/test_knowledge_rebase_flow.py 编写端到端失败测试（HTTP 级）：A、B 基于 1.0.0；A 改甲发布 1.0.1；B 改甲、乙发布 → `KNOWLEDGE_BASELINE_STALE`；rebase 返回甲冲突、乙自动；resolve 后发布 B → 1.0.2 且正式版含双方保留内容；审计链完整

### Implementation for User Story 3

- [ ] T058 [P] [US3] 实现 frontend-enterprise/src/pages/knowledge-admin/dialogs/MergeDialog.tsx（纯组件，不调 API）
- [ ] T059 [US3] 实现 frontend-enterprise/src/pages/knowledge-admin/dialogs/RebaseDialog.tsx 并接入 PublishDialog 的 `onRebase`
- [ ] T060 [US3] 在 frontend-enterprise/src/pages/knowledge-admin/shared/ContentTab.tsx 与 shared/VersionsTab.tsx 接入 stale 横幅与标记
- [ ] T061 [US3] 使 T057 端到端测试通过：按需修正 backend/app/knowledge/rebase.py 与 backend/app/knowledge/versioning.py（不新增行为，仅修复集成缺口）

**Checkpoint**: P0（US1–US3）完整可交付（quickstart S1–S3）

---

## Phase 6: User Story 4 - 群组绑定与成员权限 (Priority: P2)

**Goal**: 共享库详情「群组与权限」Tab：绑定/解绑/默认写入/矩阵（含批量）

**Independent Test**: quickstart S4

### Tests for User Story 4

- [ ] T062 [P] [US4] [测试] 在 frontend-enterprise/src/components/knowledge/TeamKnowledgePermissionMatrix.test.tsx 增加失败测试：新增批量设置（全部 reader/editor/撤销）后矩阵状态正确，且不影响 TeamDetailPage 既有用法
- [ ] T063 [P] [US4] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/shared/GrantsTab.test.tsx 编写失败测试：绑定群组候选来自 `GET /knowledge-admin/teams`；绑定后成员默认未授权；设为默认写入；解绑二次确认；保存矩阵携带 `expected_revision`，冲突时提示刷新

### Implementation for User Story 4

- [ ] T064 [US4] 扩展 frontend-enterprise/src/components/knowledge/TeamKnowledgePermissionMatrix.tsx 增加批量设置（可选 props，向后兼容）
- [ ] T065 [US4] 实现 frontend-enterprise/src/pages/knowledge-admin/shared/GrantsTab.tsx 并接入 KnowledgeAdminDetailPage.tsx

**Checkpoint**: US4 可独立演示

---

## Phase 7: User Story 5 - 私有库统一管理与转共享 (Priority: P2)

**Goal**: 私有库内容 Tab、分支 Tab、转共享向导入口、列表服务端分页 UI

**Independent Test**: quickstart S5

### Tests for User Story 5

- [ ] T066 [P] [US5] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/private/ContentTab.test.tsx 编写失败测试：横幅显示员工、分支头、同步状态；上传/编辑/删除后分支头 +1 且列表刷新
- [ ] T067 [P] [US5] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/private/BranchTab.test.tsx 编写失败测试：分支状态卡；从广场同步、发布到广场、回滚调用与刷新
- [ ] T068 [P] [US5] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/KnowledgeAdminDetailPage.convert.test.tsx 编写失败测试：私有库头部「转换为共享知识库」，archived 禁用；成功后跳转新库 `?tab=grants`
- [ ] T069 [P] [US5] [测试] 在 frontend-enterprise/src/pages/knowledge-admin/KnowledgeAdminListPage.pagination.test.tsx 编写失败测试：服务端分页参数、`has_more`、切页保留筛选

### Implementation for User Story 5

- [ ] T070 [P] [US5] 实现 frontend-enterprise/src/pages/knowledge-admin/private/ContentTab.tsx
- [ ] T071 [P] [US5] 实现 frontend-enterprise/src/pages/knowledge-admin/private/BranchTab.tsx
- [ ] T072 [US5] 在 frontend-enterprise/src/pages/knowledge-admin/KnowledgeAdminDetailPage.tsx 接入私有库 Tab 集与 `SharedKnowledgeConversionDialog`
- [ ] T073 [US5] 在 frontend-enterprise/src/pages/knowledge-admin/KnowledgeAdminListPage.tsx 接入 `Paginator`（服务端分页）

**Checkpoint**: 全部用户故事可独立演示

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T074 [P] 运行 `npm --prefix frontend-enterprise run i18n:check` 并补齐/修正 en-US 与 zh-CN 缺键、ICU 参数不一致
- [ ] T075 [P] 运行 `backend/.venv/bin/ruff check backend`、`backend/.venv/bin/python -m pytest backend/tests`、`backend/.venv/bin/python scripts/i18n/check_python.py`，修复失败
- [ ] T076 [P] 运行 `npm --prefix frontend-enterprise test` 与 `npm --prefix frontend-enterprise run build`，修复失败；确认 frontend-enterprise/src/pages/KnowledgePage.test.tsx 等既有员工侧知识库测试全部通过（FR-003）
- [ ] T077 按 quickstart.md S1–S5 在 `zh-CN` 与 `en-US` 各做一遍真实浏览器验收（含中文输入法、跨行选区、粘贴），记录结果与截图到 PR；未能运行的项标 `UNVERIFIED`
- [ ] T078 [P] 校对 specs/001-knowledge-base-admin/{spec,plan,contracts}/ 与实现的偏差，先改 artifact 再改代码；更新本文件 Notes 中的外部依赖结论
- [ ] T079 [P] 性能验证（SC-007）：在 backend/tests/test_knowledge_admin_perf.py 用 200 个知识库 fixture 断言列表端点 p95 ≤ 2s、2000 行文档 diff 端点 ≤ 1s；在 frontend-enterprise/src/pages/knowledge-admin/review/ReviewEditor.perf.test.tsx 断言 2000 行文档单次按键重绘 ≤ 50ms；结果写入 PR，未达标视为阻塞

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，可立即开始；T001 决定 T002/T003 是否执行
- **Foundational (Phase 2)**: 依赖 Setup；**阻塞全部用户故事**。内部依赖：T015 → T023/T025（lineage 是对比与变基的前提）；T017 → T025（publish 的 stale/force 在版本规则之上）；T019 与 T021 独立；T029 依赖 T013 类型
- **US1 (Phase 3)**: 依赖 Phase 2（T021、T029）
- **US2 (Phase 4)**: 依赖 Phase 2 与 US1 的 T035（详情骨架）；review/* 三个纯函数模块可与 US1 并行
- **US3 (Phase 5)**: 依赖 US2 的 T051（PublishDialog）与 Phase 2 的 T025
- **US4 (Phase 6)**: 依赖 US1 的 T035；与 US2/US3 独立
- **US5 (Phase 7)**: 依赖 US1 的 T035；与 US2/US3/US4 独立
- **Polish (Phase 8)**: 依赖所选用户故事完成

### 每个用户故事内部

- 测试任务先写并确认失败，再做实现任务
- 纯函数 → 组件 → 页面接入
- 故事完成并通过其 Independent Test 后再进入下一优先级

### Parallel Opportunities

- Setup：T004/T006/T008/T010/T011/T013 并行；T005/T007/T009 并行
- Foundational：T014/T016/T018/T020/T022/T024/T026/T028 八个测试任务并行；实现按依赖：T015、T017、T019、T021 并行 → T023、T025、T027 → T029
- US2：T036/T037/T038 与 T040–T044 并行；T045/T046/T047 并行
- US3：T054/T055/T056/T057 并行；T058 与 T060 并行
- US4/US5 可与 US2/US3 由不同人并行

---

## Parallel Example: Foundational

```bash
# 八个测试任务同时开写（不同文件）：
Task: "T014 backend/tests/test_knowledge_lineage.py"
Task: "T016 backend/tests/test_knowledge_version_labels.py"
Task: "T018 backend/tests/test_knowledge_admin_bypass.py"
Task: "T020 backend/tests/test_knowledge_admin_listing.py"
Task: "T022 backend/tests/test_knowledge_diff.py"
Task: "T024 backend/tests/test_knowledge_rebase.py"
Task: "T026 backend/tests/test_knowledge_review_writeback.py"
Task: "T028 frontend-enterprise/src/api/knowledgeAdmin.test.ts"
```

## Parallel Example: User Story 2

```bash
# 纯函数测试与实现可与页面测试并行：
Task: "T036 review/lineDiff.test.ts"  → "T045 review/lineDiff.ts"
Task: "T037 review/hunkModel.test.ts" → "T046 review/hunkModel.ts"
Task: "T038 review/staging.test.ts"   → "T047 review/staging.ts"
Task: "T040 shared/ContentTab.test.tsx" / "T042 shared/VersionsTab.test.tsx" / "T043 dialogs/PublishDialog.test.tsx" / "T044 shared/AuditTab.test.tsx"
```

---

## Implementation Strategy

### MVP First（US1）

1. Phase 1 Setup → Phase 2 Foundational（后端六项能力 + API 层）
2. Phase 3 US1 → 独立验证（quickstart S1）→ 可演示"统一总览"

### P0 交付批次（US1–US3）

3. Phase 4 US2 → quickstart S2；Phase 5 US3 → quickstart S3
4. 合并前跑 Phase 8 的 T074–T076，浏览器验收 T077 覆盖 S1–S3

### P1 增量（US4–US5）

5. Phase 6、Phase 7 可由不同人并行；各自通过 S4/S5 后合入；T077 补 S4/S5

---

## Traceability（需求 → 任务）

| 需求 | 任务 |
|---|---|
| FR-001 / FR-002 | T010–T012, T032, T035 |
| FR-003 | T076（回归） |
| FR-010 / FR-012 / FR-014 | T020, T021, T031, T034 |
| FR-011 | T020, T021（服务端分页，P0）；T069, T073（分页 UI，P1） |
| FR-013 | T031, T034 |
| FR-020 / FR-021 / FR-022 | T015–T019, T040, T049 |
| FR-023 / FR-030 / FR-031 / FR-032 / FR-033 / FR-034 | T016–T019, T042, T043, T050, T051 |
| FR-040 – FR-045 | T022, T023, T026, T027, T036–T053 |
| FR-050 – FR-053 | T006, T007, T016, T024, T025, T043, T051, T054–T061 |
| FR-060 / FR-061 | T020, T021（A6）, T062–T065 |
| FR-070 | T044, T052 |
| FR-071 | T001–T003, T032, T035 |
| FR-080 / FR-081 / FR-082 | T066–T072 |
| SC-007 | T079 |
| SC-008 | T016, T018, T024, T026 |
| 契约 A1–A6 | T020/T021, T022/T023, T024/T025, T026/T027 |
| 契约 B1–B4 | T016–T019, T014/T015, T001–T003 |

## Notes

- 外部依赖结论（T001 回填）：已合入 main（PR #25 fix/knowledge-base-delete-team-cleanup，含 backend/tests/test_knowledge_base_delete_cleanup.py）；T002/T003 无需执行，按"已合入"勾选。
- 每完成一个任务立即勾选 `[X]`，不攒批
- 实现中发现 spec/plan/contracts 有误：先停下改 artifact（T078 的原则），确认后再改代码
- 任何未真实运行的浏览器/输入法/第三方路径在 PR 中标 `UNVERIFIED`
