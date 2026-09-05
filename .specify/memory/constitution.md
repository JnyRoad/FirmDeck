<!--
Sync Impact Report
- Version change: (template, unversioned) → 1.0.0
- Modified principles: none (initial ratification)
- Added sections:
  - Core Principles I–VII（语义消息与双语目录；稳定错误与事件契约；语言上下文分离；
    多租户控制面与权限边界；知识域一致性；兼容边界登记制；验证优先的开发流程）
  - 技术栈与工程约束
  - 开发流程与质量门禁
  - Governance
- Removed sections: template placeholders
- Templates requiring updates: none（plan/spec/tasks 模板在运行时读取本文件，无需改动）
- Follow-up TODOs: none
- Sources: CONTEXT.md, docs/agents/{frontend,backend,i18n,release,git,security,domain}.md,
  docs/adr/ADR-001~004
-->

# StaffDeck Constitution

本宪法只固化 StaffDeck 特有的技术栈约束、架构边界、领域规则与取舍。通用工程原则由开发者
的全局规则提供，这里不重复；两者冲突时取更严的一方。事实源优先级：本宪法 → `CONTEXT.md`
与 `docs/adr/` → `docs/agents/*.md` → 代码注释。规格、计划与代码不得与上述事实源静默偏离，
发现冲突先修事实源再改代码。

## Core Principles

### I. 语义消息与双语目录（i18n）

- 正式界面语言只有 `zh-CN` 与 `en-US`，语言标签一律 BCP 47；`en-US` 是 canonical catalog
  （定义键集合、ICU 结构、具名参数），`zh-CN` 是旧用户兼容默认。新增语言必须走 locale
  registry、目录、类型、formatter、伪本地化与浏览器验收的完整流程，只加 JSON 不算支持。
- 每一处开发者拥有的产品消息（JSX、标题、表单、校验、Toast、原生对话框、`aria-*`/`title`/
  `alt`、下载前缀、iframe/postMessage 外壳、后端错误与事件投影、Agent 运行界面的阶段名与
  系统提示）MUST 使用稳定英文语义 `MessageId` + 具名 `values` 的 `MessageDescriptor`。文案
  不是键；禁止自然语言键、动态拼接键、数字占位符、`${}` 拼接和 `item(s)` 伪复数。
- 用户输入、员工/团队/知识库/文档名称与正文、引用片段、Agent/工具/provider 原文、密钥、
  路径、文件名 raw 部分、技术日志与 trace MUST 逐字保留，只能用精确的 `RawContent` /
  `RawIdentifier`（前端）或单个 JSON Pointer 的 `RawSourceMarker`（后端）标记，不得给父容器
  加宽泛忽略。
- 日期、时间、数字、百分比、货币、列表、相对时间与排序 MUST 经 `Intl` / 共享 formatter，
  显式传入当前 locale、时区与业务单位；业务代码禁止固定 locale 或时区常量。
- 开发、测试、CI 对缺失/非法消息 fail-fast；生产按"当前语言 → `en-US` canonical → 当前语言
  通用错误 → canonical 通用错误 → 安全末级文案"回退，且诊断日志不含业务参数。

理由：目录键、语言文案与参数契约分离，才能在开发期暴露漏翻、生产期安全回退，并避免把
业务数据误当产品文本翻译（ADR-001）。

### II. 稳定错误与事件契约

- 所有可到达 HTTP、SSE、Harness、工具、A2A/MCP、任务与 Agent UI 的产品错误 MUST 在
  `backend/app/contracts/error_registry.py` 注册，并以 `ErrorDescriptor` 传递稳定 `code`、安全
  具名 `params`、`retryable`、`request_id`、`trace_id`；`message_key` 是语义 ID，不是自然语言。
- 禁止公共响应直出 `str(exc)`、异常 message、provider body、自然语言 `detail` 或未注册 code；
  未知/参数不匹配的错误 MUST fail-closed 到注册的安全错误（通常 `INTERNAL_ERROR`）并保留
  request/trace。根因只进入 `InternalErrorContext` 与授权技术日志。
- 产品系统事件 MUST 使用 `SystemEvent` + `EventRegistry` 的稳定小写 `event_code`、具名
  `params`、UTC 时间、聚合/turn 关联、可见性与必要的 `LanguageContext`；存储、SSE、重试与
  重放传递代码与参数，不持久化依赖某一语言的最终显示文本。新 event code 必须注册并补
  正反例测试。

理由：机器契约、产品文案与私有诊断拆开，同一错误/事件才能在不同界面语言下稳定投影，且不
泄漏根因（ADR-002）。

### III. 语言上下文分离（UI locale / Agent reply locale）

- `ui_locale` 与 `agent_reply_locale` 是两个独立字段，存于不可变 `LanguageContext`，各自记录
  解析来源；UI locale 只影响产品文本、错误与事件投影，reply locale 只影响 Agent 新生成的
  自然语言，二者都不翻译输入、历史消息、知识原文、工具结果或日志。
- 在 turn claim / 任务开始前绑定快照，并沿 session、message、turn、task、tool call、stream、
  retry、recovery、handoff、team、channel、public run、scheduled/background job 与 outbox 传递；
  重试与恢复重用原快照，不从最新偏好重新推断。已有 session reply snapshot 是权威值，冲突的
  显式修改 MUST fail-closed；缺失快照只能走记录的兼容默认 `zh-CN`，不得猜测。
- 每新增一个 Agent 执行入口，MUST 同时补齐四种 UI/reply 组合与 raw 内容不变的契约测试。

理由：界面语言是 shell 偏好，回复语言是面向员工的业务行为；绑定二者会造成会话语气漂移与
重放不确定（ADR-003）。

### IV. 多租户控制面与权限边界

- 系统控制面（`SystemAdmin`、`SYSTEM_ADMIN_SECRET`、专用 token audience、`/system/*`）与租户
  数据面身份双向拒绝：系统管理员不能模拟租户用户，租户 token 不能进入系统 API。租户 slug
  不可变，不提供租户硬删除。
- 租户内权限只有三层：租户管理员（`User.role == "admin"`，租户内全权）、员工作用域
  （非管理员只能管理自己拥有的员工 `owner_user_id`，不能触碰 overall agent）、团队 owner
  （团队内绑定与授权，等价于管理员在该团队的权限）。新增管理页面 MUST 明确落在其中一层，
  不得发明第四种角色或让前端从常量/localStorage 推断当前租户。
- 租户 lifecycle（`active/suspended` + 单调 `lifecycle_version`）MUST 在每个副作用前校验；
  旧 generation 不得覆盖新 owner；结果无法证明的外部调用记为 `EXTERNAL_OUTCOME_UNKNOWN`，
  不自动重放。
- 密钥、hash、bearer/API key、provider 原文与租户业务内容不得进入审计、日志字段、argv 或
  环境示例值；`SYSTEM_ADMIN_SECRET` 必须与 `APP_SECRET` 不同且非空，缺失时 fail-closed。

理由：系统管理员不是"更大的租户管理员"，两个平面需要独立身份与最小权限（ADR-004）。

### V. 知识域一致性

- 共享知识库（`mode=shared`）只有一个正式版本指针 `published_version_id`；所有读取侧
  （群聊、员工检索、Agent 运行）MUST 只读该指针指向的 released 版本。草稿是分支：只有草稿名
  与基线（基于哪个正式版），不占版本号；版本号在发布时按语义化版本分配且必须高于现有最高
  正式版。
- 创建草稿、发布、驳回、回滚、变基、绑定/解绑、权限矩阵保存 MUST 带乐观锁
  （`expected_published_version_id` / `expected_revision`），冲突时拒绝并以稳定错误码投影，
  禁止静默覆盖；上述每个动作 MUST 写入 `knowledge_base_audit_events`，带幂等键。
- 私有知识库（`mode=dedicated`）采用员工分支模型：同一库根、每个员工独立 `head_version`，
  每次写入产生新分支版本；可见性同时依赖 `AgentKnowledgeBranch` 与 `AgentResourceBinding`。
  私有转共享 MUST 是单事务：成功则源库归档，失败则源库不变。
- 共享库的团队授权沿用 `reader < editor < publisher` 三级包含关系；删除共享库 MUST 连带清理
  团队绑定、成员授权与团队默认写入指针，不留悬挂数据。
- 知识库原文、文档正文与引用属于 raw 内容，任何语言切换、迁移或回滚都不得翻译或改写。

理由：正式指针 + 分支式草稿 + 乐观锁 + 审计，是多人协作下内容既不丢失也不被覆盖的最小
充分条件；私有分支模型解释了"每个员工看到的私有库可能不同"。

### VI. 兼容边界登记制

- 为迁移旧 source-key、自然语言错误字段、legacy event projection、`notify`、
  `data-i18n-ignore`、伪租户模型等保留的适配器 MUST 在 `docs/i18n/legacy-boundaries.json` /
  allowlist 登记：owner、精确 scope、reason、telemetry、rollback boundary、removal conditions；
  checker 的每条抑制还 MUST 有精确 fingerprint 与 ISO `expires`。
- 兼容边界内禁止新增调用方；每次提交兼容用量只减不增。删除条件是零调用、零旧记录依赖、
  双语言关键路径与真实浏览器验收完成，并由测试与审查记录证明。
- 迁移一律 additive：先保证旧 reader/client 可安全读取，再增字段与快照；回滚只恢复登记的
  旧投影或兼容默认，不删列、不清空快照、不翻译或改写历史内容。

理由：没有到期日与 owner 的兼容层会永久化；登记制让双轨成本可见、可收敛（ADR-001/002/003）。

### VII. 验证优先的开发流程

- 任何行为变更按"测试 RED → 最小实现 GREEN → 邻近回归 → 目录/契约检查 → 真实浏览器验收"
  推进；先写能失败的测试，再实现。
- 未由源码、自动测试、真实浏览器、真实第三方或发布环境验证的内容 MUST 标记 `UNVERIFIED`；
  mock、静态检查通过或计划文字不能替代验证证据，局部测试通过不得表述为全仓完成。
- 规格产物（`specs/<编号>-<短名>/` 的 spec.md、plan.md、tasks.md 及配套文件）与 `.specify/`
  是项目资产，随功能一起提交并进入 PR，与代码分开提交（`docs(specs): ...`）；
  `design-*.md` 是本地材料，默认不提交。机器本地状态由 `.specify/.gitignore` 与根
  `.gitignore` 排除。
- 禁用 `speckit-implement`；实现一律在隔离 worktree 中按 `tasks.md` 逐任务 TDD 执行，任务
  拆分 MUST 显式包含每个实现任务前置的测试任务。实现中发现 spec/plan 有误，先改 artifact
  再改代码。
- `git add` 显式列出文件，禁止 `git add .`/`-A`；提交前检查 `git diff --cached --name-only`
  与 `git diff --check`。

理由：本项目的 i18n、错误/事件与多租户边界都靠契约测试与浏览器矩阵守住；缺少证据的
"完成"会把兼容债务带进发布。

## 技术栈与工程约束

- 前端：React + TypeScript 严格模式，代码在 `frontend-enterprise/src/`，测试与实现同目录
  `*.test.ts(x)`；两空格缩进、单引号、分号、`PascalCase` 组件、`use...` Hook、`@/` 别名。
  新页面优先 shadcn/ui（`@/components/ui`，`cn()` 合并类名，`sonner` toast），不新增 Ant
  Design 组件；既有 Ant Design 页面不为替换而替换。图标先落 `src/assets/` 再引入，不在 JSX
  内联手写 SVG。有限取值字段先在 `enums` 定义再引用，不散落魔法字符串。
- 后端：Python 3.11+，代码在 `backend/app/`、测试在 `backend/tests/`；四空格、类型标注、
  `snake_case` 函数/模块、`PascalCase` 类，Ruff 行宽 100。会话运行时为 Harness v2；
  `backend/single_port_app.py` 支持单端口与桌面端。受支持的生产迁移路径以 SQLite 为前提，
  知识库内容纯数据库存储、原始上传文件不落盘。
- 版本：`backend/VERSION`（纯 semver）是唯一版本事实源，`pyproject.toml` 动态读取、不得手改；
  修改时同提交运行 `scripts/sync_version.py` 同步 `frontend-enterprise/package.json`。仅发布时
  改版本，1.0 之前破坏性变更也只递增 minor。
- 配置与密钥：`backend/.env.example` 复制为 `backend/.env`，绝不提交密钥或渠道凭据；使用
  高强度 `APP_SECRET` 与最小权限外部凭据。

## 开发流程与质量门禁

- 前端改动至少运行 `npm --prefix frontend-enterprise run i18n:check`、相关 Vitest、
  `npm --prefix frontend-enterprise run build`；改 Vite 环境变量用法时加 `run config:check`；
  可见 UI 改动 MUST 在浏览器按受影响路由与角色验证，并覆盖 `zh-CN` / `en-US`。
- 后端改动先跑相关测试，触及错误/事件/语言边界时至少运行
  `pytest backend/tests/test_error_contracts.py backend/tests/test_event_contracts.py
  backend/tests/test_language_context.py` 与 `scripts/i18n/check_python.py`；范围允许时运行全量
  `pytest backend/tests` 与 `ruff check backend`。检查无法执行时保留原始失败并标 `UNVERIFIED`。
- 发布门禁：目录键/ICU/参数零漂移、前后端契约测试通过、错误/事件已注册、语言快照在各执行
  路径一致、关键路由双语言真实浏览器验收、所有兼容边界有 owner/fingerprint/expires。任一项
  失败或无法运行即阻止发布或标 `UNVERIFIED`，构建成功与安装包生成不能替代门禁。
- 提交信息用英文 Conventional Commits（`feat(channels): add binding status`），保持聚焦，不加
  AI 署名；PR 说明意图与风险、关联工作、验证清单、受影响路由与角色，可见 UI 改动附截图。

## Governance

- 本宪法优先于 `docs/agents/*.md` 中与之冲突的表述；与 `CONTEXT.md` 或 ADR 冲突时，先在
  对应事实源提出修正并记录，不得静默覆盖任一方。
- 修订流程：提出变更 → 在 PR 中说明影响的原则、受影响的 spec/plan/tasks 与迁移方案 →
  评审通过后更新本文件并递增版本；同一 PR 内同步更新受影响的 ADR 或 `docs/agents/*.md`。
- 版本策略遵循语义化版本：MAJOR = 删除或重新定义原则（不向后兼容）；MINOR = 新增原则/章节
  或实质性扩展指导；PATCH = 措辞澄清与非语义修正。
- 合规审查：`speckit-plan` 的 Constitution Check 与 PR 评审 MUST 逐条对照本宪法；豁免必须
  在 plan.md 的 Complexity Tracking 中写明理由与更简单方案被否决的原因，并给出到期日。
- 本文件随 `.specify/` 纳入版本管理；修订按 `docs/agents/git.md` 的提交范围规则单独提交
  （`docs(constitution): ...`）。

**Version**: 1.0.0 | **Ratified**: 2026-09-01 | **Last Amended**: 2026-09-01
