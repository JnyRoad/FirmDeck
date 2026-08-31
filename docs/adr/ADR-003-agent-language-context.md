# ADR-003：Agent 回复语言上下文与持久快照

- 状态：Accepted — staged rollout，端到端传播尚未完成
- 日期：2026-08-30
- 范围：界面语言、Agent 回复语言、会话/任务/流式/渠道/团队上下文

## 背景

界面语言是产品 shell 的显示偏好，Agent 回复语言是面向员工或用户的自然语言行为。把两者
绑定会让用户切换菜单语言时意外改变会话语气，或者在重试、恢复、后台任务、群聊和渠道中
出现前后语言漂移。仅在前端保存偏好也无法保证后端 Agent、工具调用和事件重放使用同一语言。

## 决定

1. 每次执行使用不可变 `LanguageContext`，独立保存 `ui_locale`、`agent_reply_locale` 和两者
   的解析来源。语言标签采用 BCP 47；当前正式值为 `zh-CN` 与 `en-US`，旧用户兼容默认是 `zh-CN`。
2. 新执行按显式请求、用户偏好、渠道默认、传输提示、兼容默认的确定顺序解析；已有 durable
   snapshot 优先于一切可变偏好。已有 session reply snapshot 是权威值，冲突的显式修改必须
   fail-closed，并以稳定冲突代码投影。
3. 在 turn claim/执行前绑定快照，并沿 session、message、turn、task、tool call、stream、event、
   retry、recovery、handoff、team、channel、public run、scheduled/background job 和 outbox 传递。
   重试和恢复重用原 snapshot，不在新请求中重新猜测语言。
4. Agent prompt/运行阶段只对新生成的自然语言施加 `agent_reply_locale` 指令；用户输入、历史
   消息、知识/文档原文、引用、工具/provider 输出、密钥、路径和技术日志通过精确 raw marker
   保持不变。UI locale 只控制产品文本、错误和事件投影。
5. 持久化使用 additive migration、可重复 backfill 和旧 reader 兼容；不能为了补齐字段翻译或
   改写已有业务内容。快照字段应可审计来源和版本，未知/非法 locale 必须拒绝或进入明确默认
   适配器，而不是默默接受任意字符串。
6. 每个执行路径必须有四种 UI/reply 组合的测试，至少覆盖私聊、群聊、流式、重试、恢复、handoff、
   定时任务、团队运行、渠道、公开运行和工具调用。真实浏览器与外部渠道不可运行时标记
   `UNVERIFIED`，不得从单元测试推断已贯通。

## 后果

- 产品 UI 和 Agent 业务沟通可以分别切换，且重放/恢复具有确定语言语义。
- session/turn/task/event 数据增加快照和迁移成本；任何新入口都必须显式接收或继承 context，
  不能从全局 locale 或当前浏览器偏好读取。
- Agent 输出和 source content 的测试边界更清晰，但需要区分“新生成 prose”与“引用原文”，并
  在工具、摘要、handoff 和异步 worker 中持续传递 raw markers。

## 回滚

回滚可在入口层将缺失快照的旧调用方解析为 `zh-CN` 兼容默认，并保留已写入的 immutable snapshot；
不得用当前 UI locale 覆盖已有 reply snapshot，也不得删除新增列、清空快照或翻译历史内容。若某个
异步/渠道路径无法安全继承 context，应暂停该路径的 Agent 发送并返回稳定安全错误，保留 request/trace
用于修复，而不是降级为猜测语言。schema 回滚必须遵循 additive migration 的旧 reader 边界。

## 验收边界

locale normalization、解析来源、冲突和数据库 additive migration 已有基础实现/测试；session、
turn、Agent prompt、stream、retry、recovery、team、channel、public/scheduled 等全链路传播是否
完成，必须由各路径测试、运行记录和真实浏览器/渠道验收确认。未验证的运行时、第三方渠道和真实
Agent 输出均标记 `UNVERIFIED`。
