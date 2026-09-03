# Implementation Plan: 租户管理端统一知识库管理（knowledge-base-admin）

**Branch**: `001-knowledge-base-admin`（开发分支建议 `feat/knowledge-base-admin`；规格编写于 `claude/knowledge-base-admin-design-057e6c`） | **Date**: 2026-09-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-knowledge-base-admin/spec.md`；交互事实源：可交互原型 https://claude.ai/code/artifact/4539f582-ac66-4d62-bb50-b07aa3c1f57f

## Summary

在租户管理端新增仅管理员可见的「知识库管理」（列表 + 详情），统一管理共享库与私有库，并为共享库提供
Git 式协作：草稿即分支（不占版本号）、编辑器式变更审阅（接受 = 暂存 / 拒绝 / 直接编辑 / 行级恢复 /
选区撤销）、基线过期时的变基与逐行三方合并、发布时按语义化版本分配号。技术路线：后端以现有知识域
服务为基础做**加法**——新增租户级列表、版本对比、变基三个服务模块与一个管理端路由，放宽共享库治理
门禁允许租户管理员直连，版本号分配从建稿时移到发布时；前端新增独立页面模块 `pages/knowledge-admin/`，
复用现有权限矩阵、转共享对话框与文档编辑器，新增纯前端的审阅编辑器与合并对话框（diff 由服务端计算，
编辑期由前端本地重算）。

## Technical Context

**Language/Version**: 后端 Python 3.11+；前端 TypeScript（严格模式）/ React 19 + Vite

**Primary Dependencies**: 后端 FastAPI、SQLModel/SQLAlchemy、Pydantic v2、标准库 `difflib`（行级 diff 与三方合并）；前端 react-router、shadcn/ui、Tailwind v4、`react-intl` 语义运行时（`useAppIntl`/`MessageDescriptor`）、sonner

**Storage**: SQLite（现有 `knowledge_bases` / `knowledge_base_versions` / `knowledge_documents` / `team_knowledge_base_bindings` / `team_knowledge_base_grants` / `knowledge_base_audit_events`），本功能只做 additive 变更（`metadata_json` 字段 + 版本 `version` 列语义扩展），不新增表

**Testing**: 后端 pytest（contract/fixture 先行）+ Ruff；前端 Vitest + `i18n:check` + `build`；关键路由双语言真实浏览器验收（`zh-CN` / `en-US`）

**Target Platform**: Web（租户管理端，桌面浏览器为主，≥900px 主布局，≤900px 折叠侧栏）

**Project Type**: Web application（backend + frontend-enterprise）

**Performance Goals**: 200 个知识库的列表首屏 ≤2s（服务端分页，默认 20/页）；单篇 2000 行文档的行级 diff ≤1s（服务端 `difflib` + 前端仅对当前编辑文档本地重算）；审阅编辑器按键到重绘 ≤50ms（文档 ≤2000 行）

**Constraints**: 读取侧只读 `published_version_id`；所有治理写操作带乐观锁与审计；公共错误必须注册；UI 文案全部经 `MessageDescriptor`；知识原文为 raw 内容不翻译；不引入新第三方 diff 库（标准库足够，避免依赖审查）

**Scale/Scope**: 单租户 ≤500 知识库、每库 ≤200 篇文档、单篇 ≤5000 行；新增后端端点 6 个、变更 5 个；前端新增 1 个页面模块（2 页 + 5 Tab + 6 对话框 + 审阅编辑器），i18n 新增约 180 条键

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 本设计如何满足 | 状态 |
|---|---|---|
| I 语义消息与双语目录 | 新增 UI 文案全部放在 `knowledgeAdmin.*` 命名空间，`en-US` canonical 与 `zh-CN` 同步；知识库/文档名与正文用 `RawContent`/`RawIdentifier`；日期用共享 formatter；diff 行内容是 raw 文本，不进目录 | PASS |
| II 稳定错误与事件契约 | 新增错误码 `KNOWLEDGE_BASELINE_STALE`、`KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED`、`KNOWLEDGE_VERSION_LEVEL_INVALID`、`KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH` 注册到 `error_registry.py`；新增事件 `knowledge.version_published`、`knowledge.draft_rebased`、`knowledge.draft_reviewed` 注册到 EventRegistry；公共响应只含 code/params | PASS |
| III 语言上下文分离 | 本功能不新增 Agent 执行入口，不改 `LanguageContext`；管理端只用 `ui_locale`；不在任何接口传递 reply locale | PASS（无新入口） |
| IV 多租户控制面与权限边界 | 页面与所有新端点 `ensure_tenant_admin`；`require_team_knowledge_manager` 增加"管理员 + team_id 为空"旁路，不引入新角色；不触碰系统控制面 | PASS |
| V 知识域一致性 | 正式指针语义不变；草稿改为分支语义（`version` 列存草稿名，`parent_version_id` 作基线）；发布/驳回/回滚/变基/审阅写回全部带乐观锁并写审计；删除连带清理依赖独立修复任务（见 Complexity Tracking） | PASS（有外部依赖） |
| VI 兼容边界登记制 | 不新增 legacy 调用；已发布版本标签不动；草稿标签新语义为 additive；旧 `team_id` 必填的请求继续可用 | PASS |
| VII 验证优先的开发流程 | tasks 阶段要求每个实现任务前置测试任务；浏览器矩阵未跑前标 `UNVERIFIED`；规格产物随功能提交 | PASS |

**Gate 结论**：通过，无需豁免。外部依赖一项：共享库删除悬挂数据修复由独立会话进行（状态 `UNVERIFIED`），本功能的删除路径以该修复为前置；若其未合入，本功能在 P0 内自行包含该清理逻辑（见 research R6）。

## Project Structure

### Documentation (this feature)

```text
specs/001-knowledge-base-admin/
├── plan.md              # 本文件
├── research.md          # Phase 0：技术决策
├── data-model.md        # Phase 1：实体与状态机（additive 变更）
├── quickstart.md        # Phase 1：验证指南
├── contracts/
│   ├── knowledge-admin-api.md   # 新增 / 变更 HTTP 端点契约
│   └── frontend-surface.md      # 路由、菜单、i18n 命名空间、组件边界
└── tasks.md             # Phase 2（/speckit-tasks 生成）
```

### Source Code (repository root)

```text
backend/
├── app/
│   ├── api/
│   │   ├── knowledge_admin.py        # 新增：/api/enterprise/knowledge-admin/* 路由（列表、对比、变基、审阅写回）
│   │   ├── knowledge_bases.py        # 变更：publish 接受 level；drafts/publish/reject/rollback 的 team_id 可选（admin）
│   │   ├── knowledge.py              # 变更：文档上传/更新在共享库必须指向 draft version（已支持，补管理员旁路）
│   │   └── teams.py                  # 不变
│   ├── knowledge/
│   │   ├── listing.py                # 新增：租户级列表查询（过滤、分页、归属/绑定摘要）
│   │   ├── diff.py                   # 新增：版本对比（文档级清单 + 行级差异，difflib）
│   │   ├── rebase.py                 # 新增：草稿变基（克隆最新正式版 + 逐文档三方合并 + 冲突清单）
│   │   ├── versioning.py             # 变更：草稿命名、发布时分配 semver、基线过期判定、审阅状态
│   │   ├── management.py             # 变更：require_team_knowledge_manager 管理员旁路
│   │   ├── schema.py                 # 变更：新增请求/响应模型
│   │   └── audit.py                  # 不变（新增 action 字符串常量）
│   ├── contracts/error_registry.py   # 变更：新增 4 个错误码
│   └── events/…                      # 变更：注册 3 个 event_code
└── tests/
    ├── test_knowledge_admin_listing.py
    ├── test_knowledge_version_labels.py
    ├── test_knowledge_admin_bypass.py
    ├── test_knowledge_diff.py
    ├── test_knowledge_rebase.py
    └── test_knowledge_review_writeback.py

frontend-enterprise/src/
├── pages/knowledge-admin/
│   ├── KnowledgeAdminListPage.tsx
│   ├── KnowledgeAdminDetailPage.tsx  # 按 mode 渲染共享 / 私有 Tab 集
│   ├── shared/{ContentTab,VersionsTab,GrantsTab,AuditTab,SettingsTab}.tsx
│   ├── private/{ContentTab,BranchTab}.tsx
│   ├── dialogs/{CreateKnowledgeBaseDialog,CreateDraftDialog,PublishDialog,RebaseDialog,MergeDialog,DeleteDialog}.tsx
│   ├── review/{ReviewEditor.tsx,lineDiff.ts,hunkModel.ts,editorDom.ts,staging.ts}   # 纯前端，无 API 依赖
│   └── knowledgeAdminModel.ts        # 视图模型 / 排序 / 版本号工具（纯函数，可单测）
├── api/knowledgeAdmin.ts             # 新增：唯一的管理端 API 调用层（包住 createTenantClient）
├── components/knowledge/             # 复用：TeamKnowledgePermissionMatrix、SharedKnowledgeConversionDialog、KnowledgeTypeBadge
├── components/AppSidebar.tsx         # 变更：SYSTEM_NAV 增加 knowledge-admin 项
├── App.tsx                           # 变更：两条 admin-only 路由
├── enums/routes.ts                   # 变更：EnterpriseRoute.KnowledgeAdmin
├── enums/knowledge.ts                # 新增：mode / publication_state / permission / version level 枚举
└── i18n/messages/{en-US,zh-CN}.json  # 变更：knowledgeAdmin.* 命名空间
```

**Structure Decision**: Web application 双项目结构。后端新增能力独立成 `listing.py` / `diff.py` / `rebase.py` 三个只依赖模型与 `difflib` 的服务模块，路由层 `knowledge_admin.py` 只做鉴权、参数校验与投影；前端新增独立页面模块，通过唯一的 `api/knowledgeAdmin.ts` 访问后端，审阅编辑器与合并对话框为纯前端组件，不直接调用 API。依赖方向单向：`pages → api → tenant-client`、`pages → components/knowledge`、`review/* → 无内部依赖`；后端 `api → knowledge services → db.models`，不反向。

## 模块职责与分期

| 模块 | 一句话职责 | 分期 |
|---|---|---|
| `knowledge/listing.py` | 以租户为范围列出知识库并附归属员工、绑定群组、草稿数、文档数摘要，支持过滤与分页 | P0 |
| `knowledge/versioning.py`（变更） | 草稿命名与基线、发布时按 level 分配版本号、基线过期判定、审阅状态读写 | P0 |
| `knowledge/management.py`（变更） | 允许租户管理员在无团队上下文下管理共享库 | P0 |
| `knowledge/diff.py` | 计算两个版本之间的文档级清单与逐篇行级 diff | P0 |
| `knowledge/rebase.py` | 把草稿变更重放到最新正式版：自动合并、冲突清单、冲突解决写回 | P0 |
| `api/knowledge_admin.py` | 管理端路由：列表、对比、变基、审阅写回 | P0 |
| 前端列表页 + 共享库详情（内容 / 版本 / 审计 / 设置）+ 审阅编辑器 + 发布 / 变基 / 合并对话框 | 用户故事 1–3 | P0 |
| 前端「群组与权限」Tab（复用矩阵） | 用户故事 4 | P1 |
| 前端私有库详情 + 转共享向导（复用对话框） | 用户故事 5 | P1 |
| 列表服务端分页 UI、`owner_agent_id` 可查询化 | 规模化 | P1 |

## 测试策略（TDD）

- 后端：每个新端点先写 contract 测试（请求/响应 schema、错误码、乐观锁冲突、审计落库），再写 fixture 驱动的服务测试（`diff.py`、`rebase.py` 用纯文本 fixture 覆盖新增 / 修改 / 删除 / 冲突 / 自动合并）；最后跑 `test_error_contracts.py`、`test_event_contracts.py` 与 `scripts/i18n/check_python.py`。
- 前端：`knowledgeAdminModel.ts`、`review/lineDiff.ts`、`review/hunkModel.ts`、`review/staging.ts` 为纯函数，先写 Vitest；页面级测试覆盖 admin-only 路由重定向、列表筛选、版本切换器、接受 / 拒绝 / 应用、发布框 stale 分支、变基预览与合并完成；`i18n:check` 与 `build` 必跑。
- 浏览器验收：按 quickstart.md 场景在 `zh-CN` / `en-US` 各跑一遍；输入法组合、跨行选区、粘贴属于必须真机验证项，未跑标 `UNVERIFIED`。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| （无宪法违例）外部依赖：共享库删除连带清理 | FR-071 要求删除不留悬挂数据 | 该缺陷由独立会话修复，状态 `UNVERIFIED`；tasks 中以"若未合入则在本功能内实现同一清理"兜底，不做重复实现 |
