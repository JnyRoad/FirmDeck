# 后端开发

- 后端代码位于 `backend/app/`，测试位于 `backend/tests/`。支持的会话运行时为 Harness
  v2；`backend/single_port_app.py` 支持单端口和桌面端运行时。
- 使用 `python3 -m venv backend/.venv` 和
  `backend/.venv/bin/python -m pip install -e "backend[dev]"` 安装缺失的后端依赖。
- 使用 Python 3.11+、四空格缩进、类型标注、`snake_case` 函数与模块，以及 `PascalCase`
  类名。Ruff 的单行长度限制为 100 个字符。
- 先用相关测试验证已改动的后端路径；当改动范围和依赖条件允许时，再运行
  `backend/.venv/bin/python -m pytest backend/tests` 和
  `backend/.venv/bin/ruff check backend`。

## 国际化、错误与事件契约

后端只负责稳定机器契约、语言上下文和诊断证据，不负责把产品自然语言硬编码到公共响应。
架构依据为根 `CONTEXT.md`、`docs/adr/ADR-002-error-event-localization.md` 和
`docs/adr/ADR-003-agent-language-context.md`。

### 公共错误

- 所有可到达 HTTP、SSE、Harness、工具、A2A/MCP、任务和 Agent UI 的产品错误，必须由
  `backend/app/contracts/error_registry.py` 注册，并通过 `ErrorDescriptor`/相应 projection
  传递稳定 `code`、安全具名 `params`、`retryable`、`request_id` 和 `trace_id`。
- `message_key` 使用稳定英文语义 ID（如 `errors.knowledge.publishConflict`），不是中文/英文
  文案，也不是异常文本。参数名称和类型必须与注册表、前端目录及测试完全一致；禁止把用户输入、
  provider body 或整段业务内容作为 message key/params。
- `InternalErrorContext` 仅用于授权技术日志和诊断关联，允许保留异常类型、上游代码、原始
  message、状态和副作用不确定性，但绝不序列化到公共 descriptor、产品事件或最终 UI 文案。
- 禁止直接返回 `str(exc)`、Python exception message、provider response body、自然语言 `detail`
  或未注册 code。未知、非法或参数不匹配的错误必须 fail-closed 到注册的安全错误（通常为
  `INTERNAL_ERROR`），同时保留 request/trace 以便排查。
- 领域异常可以在内部保留兼容 message，但公共投影必须经过注册表和安全参数筛选。兼容字段只在
  登记的迁移边界中双写，禁止新增调用方依赖自然语言字段。

### 系统事件和异步状态

- 产品系统事件使用 `SystemEvent` 与 `EventRegistry` 的稳定小写 `event_code`、具名 `params`、
  UTC `occurred_at`、聚合/turn 关联、可见性和必要的 `LanguageContext`；事件 code 和 params
  不包含已翻译自然语言。
- 新 event code 必须注册、声明参数 schema/visibility/legacy projection，补齐正反例测试；需要
  Agent 语言的事件必须携带不可变语言快照。禁止以当前浏览器语言重新解释历史事件或保存最终显示句子。
- `EventLog.record_system_event` 校验通过后才允许落库和向公共 sink 投影；sink 的旧 event type
  仅是明确登记的兼容出口。异常技术日志保留根因，但 sink 失败不得改写业务成功/失败语义。

### Agent 语言上下文

- `ui_locale` 与 `agent_reply_locale` 是两个独立的 BCP 47 值，不得使用一个字段代替另一个。
  UI locale 只影响产品错误/事件/UI，Agent reply locale 只影响新生成自然语言；不得翻译输入、
  历史消息、知识/文档原文、引用、工具结果、密钥、路径或技术日志。
- 在 turn claim/任务开始前解析并绑定 `LanguageContext`，随后贯穿 session、message、turn、task、
  tool call、stream、retry、recovery、handoff、team、channel、public run、scheduled/background
  job 和 outbox。重试、恢复和重放必须使用原 snapshot，不从最新用户偏好重新推断。
- 解析优先级和来源必须使用 `backend/app/i18n/language_context.py` 的实现；已有 durable/session
  snapshot 优先，绑定 session 的 reply locale 冲突必须 fail-closed。缺失快照只能走记录的兼容默认
  `zh-CN`，不能猜测语言。
- 每增加一个 Agent 执行入口，必须同时添加四种 UI/reply 组合、流式/重试/恢复（适用时）和 raw
  内容不变的契约测试。无法运行的真实渠道、provider 或 Agent 运行路径必须标记 `UNVERIFIED`。

### 后端国际化检查

修改上述边界时，先添加能失败的 contract/fixture 测试，再实现最小变更；至少运行：

```bash
backend/.venv/bin/python -m pytest backend/tests/test_error_contracts.py backend/tests/test_event_contracts.py backend/tests/test_language_context.py
backend/.venv/bin/python scripts/i18n/check_python.py
```

再按改动范围运行完整后端测试和 Ruff。若检查脚本、依赖、外部 provider 或真实 Agent 链路无法
执行，报告必须保留原始失败并标记 `UNVERIFIED`，不得改成通过。
