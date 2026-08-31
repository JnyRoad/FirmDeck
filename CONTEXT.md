# StaffDeck 项目上下文

本文件是仓库级上下文事实源。它定义项目术语、国际化边界和迁移期规则；领域术语与架构
决策分别由本文件和 `docs/adr/` 维护。若代码、测试或其他文档与这里的契约冲突，应在继续
开发前指出冲突并修正事实源，不要通过静默兼容掩盖差异。

## 项目定位

StaffDeck 是面向企业业务流程的数字员工运营平台。它同时包含 React/TypeScript 前端、
FastAPI/Python 后端、Harness/Agent 运行链路、持久化会话与任务、渠道/嵌入式边界，以及
桌面发布产物。国际化治理必须覆盖这些边界，而不只是可见的 DOM 文本。

## 术语

- **产品消息（product message）**：由 StaffDeck 开发者拥有、需要随界面语言变化的标签、
  状态、动作、校验、帮助、通知、错误、事件投影、无障碍文本、页面标题、下载前缀等。
- **语义消息 ID（MessageId）**：稳定、可读、由英文代码标识符组成的 BCP 47 无关键，例如
  `billing.invoice.itemCount`。英文或中文文案不是 ID；占位符名称也不是 ID。
- **MessageDescriptor**：`id` 加具名 `values` 的产品消息描述。用户输入、业务数据或 Agent
  原文只能作为 `values` 或独立 raw 内容传递，不能进入 `id`。
- **界面语言（ui locale）**：控制 StaffDeck 产品 UI、错误和事件投影的语言区域。
- **Agent 回复语言（agent reply locale）**：控制新生成 Agent 自然语言的语言区域，与界面语言
  独立。它不翻译用户输入、历史消息、知识原文、工具结果或 Agent 已生成的业务内容。
- **Raw 内容**：必须逐字保留的用户输入、员工/团队名称、知识库原文、文档内容、Agent 原始
  产出、密钥、路径、文件名、技术日志、追踪信息和第三方输出。
- **错误描述（ErrorDescriptor）**：稳定 `code`、安全具名 `params`、`retryable` 以及
  `request_id`/`trace_id`。自然语言异常和私有根因不属于公共 UI 契约。
- **系统事件（SystemEvent）**：稳定 `event_code`、安全 `params`、时间、关联 ID、可见性和
  必要的 `LanguageContext`；事件存储和重放不依赖已翻译自然语言。
- **兼容边界**：为迁移旧 source-key、旧自然语言错误或旧事件投影而保留的适配器。边界登记必须有
  owner、精确 scope、reason、telemetry、rollback boundary 和 removal conditions；其中 checker
  的每一条 ignore/allowlist 抑制还必须有精确 fingerprint 和 ISO 到期日。兼容边界内禁止新增调用方。
- **UNVERIFIED**：尚未由源码、自动测试、真实浏览器、真实第三方或发布环境验证的内容。不得
  用 mock、静态检查通过或计划文字替代验证证据。

## 国际化事实源与语言状态

- 正式支持的界面语言为 `zh-CN` 与 `en-US`，语言标签统一使用 BCP 47，禁止以 `zh_cn`、
  `en` 等别名写入持久化业务状态；输入适配器可由 `normalize_locale` 处理文档化别名。
- `en-US` 是目录结构、键集合和参数契约的 canonical catalog；它不是“把英文文案当键”。
  `zh-CN` 是现有用户和旧记录的兼容默认语言。新增正式语言必须另行完成目录、类型、测试、
  运行时和审核门禁，不得只复制一个目录。
- 开发、测试、CI 对缺失/非法消息 fail-fast；生产按运行时策略记录不含业务参数的诊断，依次
  尝试当前语言、`en-US` canonical、当前语言通用错误、canonical 通用错误，最后使用安全末级
  文案。任何 fallback 都不能把用户数据当产品文案翻译。
- 当前前端语义运行时由 `AppIntlProvider`/`useAppIntl` 和组件外的 `createAppTranslator` 提供，
  消息通过 `MessageDescriptor` 或类型化 `MessageId` 进入。`src/i18n/legacy/` 是迁移期兼容层，
  不是新代码入口。
- 当前后端语言上下文由不可变 `LanguageContext` 表示，包含独立的 `ui_locale`、
  `agent_reply_locale` 及各自解析来源。已有持久化快照优先于可变偏好；绑定会话中的回复语言
  冲突必须 fail-closed。

## 产品文本与原始内容边界

必须本地化的入口包括普通 JSX、表单标签/占位符/校验/帮助、按钮/菜单/状态、空/加载/错误、
Toast、弹窗、原生 alert/confirm/prompt、页面与路由标题、通知、剪贴板提示、下载产品前缀、
表格/图表/筛选/分页、`aria-*`/`title`/`alt`、iframe/postMessage 外壳、后端错误和事件投影。

不得翻译的入口包括用户输入、员工/团队/文档/知识库名称和原文、引用片段、Agent/工具/提供商
原始产出、密钥、路径、文件名的 raw 部分、技术日志、trace 和异常根因。使用 `RawContent`、
`RawIdentifier` 或后端 `RawSourceMarker` 只标记单个精确值；不得在父容器使用宽泛
`data-i18n-ignore`、通配 JSON Pointer 或 checker 排除项来吞掉相邻产品文本。

## 格式化与消息结构

- 日期、时间、数字、百分比、货币、列表、相对时间和排序必须由当前 locale、显式时区和业务
  单位通过 `Intl`/受支持 formatter 计算；业务代码不得散落固定 `en-US`、`zh-CN` 或时区。
- 复数、选择、性别和条件文本使用 ICU/MessageFormat 的具名变量与分支。禁止字符串拼接、
  `${count} item(s)`、数字占位符和动态构造消息 ID。每种语言必须保持变量名、结构和转义契约。
- 翻译资源只存短的产品消息模板，不存整段业务内容、HTML、用户数据、密钥、路径或 Agent 原文。

## 后端、事件与 Agent 契约

- 后端公共错误必须经错误注册表注册，返回稳定 `code`、安全 `params`、`retryable` 和请求/追踪
  标识；`message_key` 是语义键而非自然语言。前端按当前界面语言本地化，不能直接展示异常
  `str(exc)`、provider body 或硬编码中文/英文 detail。
- `InternalErrorContext` 只进入授权技术日志/诊断路径。根因、上游代码、异常类型和 raw message
  不能混入 `ErrorDescriptor`、普通 API response 或产品 Toast。
- 系统事件和异步状态使用注册的稳定 `event_code` 与具名参数。事件可以携带语言快照以供重放，
  但不得持久化依赖某一语言的自然语言投影。
- UI locale 和 Agent reply locale 在会话、消息、turn、任务、工具调用、流式响应、重试、恢复、
  handoff、群聊、渠道、公开运行和后台任务中保持独立且可追溯。切换 UI 语言不得改写历史业务
  数据或已绑定的回复语言。

## 兼容迁移与事实状态

迁移按“测试 RED → 最小实现 GREEN → 邻近回归 → 目录/契约检查 → 浏览器验收”推进。旧 runtime、
source-key、自然语言错误字段和 legacy event projection 只能在已登记边界内双读/双写；每次
提交必须减少或不增加兼容用量。删除条件通常是零调用、零旧记录依赖、双语言关键路径和真实
浏览器验收完成，并由对应测试与审查记录证明。

截至当前代次，语义目录/descriptor、raw 标记、前端非 DOM sink、后端错误/事件注册模型和
语言快照基础设施已有实现或聚焦测试；全仓页面迁移、所有 Agent 执行路径贯通、CI 工作流、
完整生产构建和真实浏览器矩阵仍须以实际验证结果为准。任何未执行部分必须写为 `UNVERIFIED`，
不得因为局部测试通过而宣称国际化治理完成。

## 权威规则入口

- 国际化规则：`docs/agents/i18n.md`
- 前端规则：`docs/agents/frontend.md`
- 后端规则：`docs/agents/backend.md`
- 发布门禁：`docs/agents/release.md`
- 架构决策：`docs/adr/ADR-001-i18n-runtime-and-catalog.md`、
  `docs/adr/ADR-002-error-event-localization.md`、
  `docs/adr/ADR-003-agent-language-context.md`
- 迁移清单、契约和验收资产：`specs/001-i18n-governance/` 与 `docs/i18n/`
