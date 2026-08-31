# ADR-002：错误与系统事件的稳定契约及本地化

- 状态：Accepted — staged rollout，生产调用方迁移尚未完成
- 日期：2026-08-30
- 范围：后端错误、系统事件、异步状态、前端本地化投影、诊断日志

## 背景

直接把 Python 异常、provider 返回体或硬编码中文/英文 detail 放进 API，会造成语言混杂、
客户端无法稳定判断错误、敏感根因泄漏和历史事件无法按当前界面语言重放。错误和事件需要把
机器契约、产品文案与私有诊断拆开，同时保留兼容旧客户端的可观测迁移路径。

## 决定

1. 公共错误使用 `ErrorDescriptor`：注册的全局 `code`、安全具名 `params`、`retryable`、
   `request_id` 和 `trace_id`。注册表同时声明 `message_key`、默认 HTTP 状态、参数类型和
   可见性；`message_key` 只能是稳定语义 ID，不能是自然语言。
2. 前端按当前 `ui_locale` 将已知 `code`/`message_key` 和 `params` 映射到 canonical/正式目录。
   不把 `detail`、`str(exc)`、provider body 或用户可控字符串当最终 UI；未知/损坏错误使用安全
   本地化通用错误，并展示必要的 request/trace 标识。
3. `InternalErrorContext` 只供授权日志和诊断链路保存异常类型、上游代码、私有 raw message、
   状态和不确定副作用等根因。它不能序列化进普通公共 descriptor，也不能成为 Toast 文案。
4. 产品系统事件使用版本化 `SystemEvent` 和 `EventRegistry`：稳定小写 `event_code`、安全
   具名 `params`、UTC 时间、聚合/turn 关联、可见性和必要的 `LanguageContext`。存储、SSE、
   重试、异步任务和重放传递代码与参数，不依赖某个语言的自然语言投影。
5. legacy 自然语言字段或旧 event type 只允许在登记的兼容 projection 中保留。兼容 projection
   必须限制字段、保留 request/trace 关联、拒绝未注册代码和不匹配参数，并具备 owner、telemetry、
   指纹、到期日和删除条件；新生产者不得使用旧字段。
6. 后端边界静态检查和契约测试必须阻止未注册错误/事件、自然语言 response、异常直出和不安全
   参数；技术日志仍保留可诊断根因，但不得通过翻译丢弃或泄露根因。

## 后果

- API、事件、前端和诊断可以独立演进；同一错误或事件能够在不同界面语言下稳定投影。
- 客户端必须实现 code/params 映射，不能依赖历史自然语言 detail；错误目录与后端 registry 需要
  一起审核，参数名和类型变更属于契约变更。
- 兼容期会存在 canonical descriptor 与旧投影的双轨成本；事件重放必须保留快照和关联 ID，
  不能只保存最终显示文本。

## 回滚

若新 descriptor 投影导致旧客户端无法运行，回滚只恢复已登记的旧 projection 或兼容字段，
同时继续发送稳定 `code`/`params`，不恢复异常直出。若 registry/参数校验阻断请求，先切换到
`INTERNAL_ERROR` 安全 fallback 并保留 request/trace，再修复注册表或迁移调用方。不得删除私有
诊断字段、清空事件历史或把 raw cause 复制到公共 `detail`。回滚必须有版本边界和移除日期。

## 验收边界

错误/事件基础模型和部分 registry 测试已有实现；所有 API、Harness、Tool、A2A、MCP、任务、
SSE 和前端映射是否已完成迁移必须由对应契约测试与真实运行证据确认。未覆盖的 producer、
第三方 provider 和生产客户端兼容性均为 `UNVERIFIED`，不能以模型单测代替。
