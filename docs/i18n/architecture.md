# StaffDeck 国际化架构

## 目标与边界

StaffDeck 将国际化定义为产品契约，不是渲染后的文本替换。产品自有 UI、错误、系统事件与
Agent 控制提示可本地化；用户输入、员工/团队名、知识库/文档原文、Agent/工具/provider 原始产出、
标识符、路径、密钥和技术日志不翻译。

## 前端消息流

1. `src/i18n/locales.ts` 维护 BCP 47 locale registry、默认值和 fallback chain。
2. `en-US.json` 是 canonical catalog，`zh-CN.json` 必须与其键集、ICU AST 和具名参数完全一致。
3. `AppIntlProvider` 在 React render 边界本地化；Toast、clipboard、native dialog、title、download、
   iframe/postMessage 等受控非 DOM sink 使用 imperative translator。
4. `MessageId` 仅允许稳定英文语义键；不允许自然语言键、动态键、数字占位符或字符串拼接复数。
5. `en-XA` 由 canonical catalog 生成，只用于测试漏翻、拼接、长文本和布局，不出现在生产语言切换器。

raw 内容通过小范围 `RawContent` / `RawIdentifier` 边界渲染。边界不允许包住产品 chrome，
checker 拒绝宽泛 ignore。

## 持久化业务内容与机器语义

- 会话标题是用户可见业务内容，不再承载团队、计划任务或技能测试等机器分类；
  `ChatSession.session_kind` 保存稳定英文类型，标题保存团队名、任务名或技能名原文。
- 旧数据仅通过 `session_kinds.py` 中的精确前缀谓词和启动迁移回填兼容；新写入不得构造
  `团队 … · TL 对话`、`计划任务：…` 等产品语言前缀。
- 团队黑板正文保持员工/Agent 原始内容；来源团队、任务、标签等产品结构写入 metadata，
  不再把固定中文 Markdown 包装持久化到业务正文。
- UI locale 切换只改变产品 chrome 和格式化，不重写既有标题、黑板、历史消息或其他业务数据。

## 后端错误与事件

- `ERROR_REGISTRY` 是 public error 的唯一事实源：`code` + exact `params` + `retryable` + HTTP status + visibility。
- `EVENT_REGISTRY` 是 product event 的唯一事实源：`event_code` + exact `params` + visibility + raw policy。
- `scripts/i18n/export_contract.py` 生成前端 `backendContract.ts`；禁止维护第二张手工 code-to-copy 表。
- 前端只本地化已注册、public、参数类型/集合精确的 descriptor；未知/畸形输入安全回退。
- `str(exc)`、provider message、traceback 只进入私有日志/诊断上下文，不进入产品/public payload。

兼容字段只能从注册安全 descriptor 投影，不能从原异常或远程文本生成。所有剩余兼容边界在
`docs/i18n/legacy-boundaries.json` 中有 owner、精确 scope、fingerprint、telemetry、回滚边界和移除条件。

## UI locale 与 Agent reply locale

`LanguageContext` 同时保存 `ui_locale` 和 `agent_reply_locale` 及其来源。

- UI locale 决定产品 chrome、错误、事件、日期/数字格式。
- Agent reply locale 决定员工/Agent 自然语言输出。
- snapshot 在耐久执行前持久化；重试、恢复、流式、handoff、scheduled、team、channel/public、
  General Skill、Tool 与 A2A 复用原 snapshot，不重新读取当前 UI 偏好。
- Harness task frame/run 与 A2A task run 都保存同一 snapshot；本地 Codex adapter 在首次执行、续接和
  恢复时重新注入 `language_prompt_contract`，而不是依赖当前进程或 UI 状态。
- `language_prompt_contract` 进入所有一方可控 Agent/LLM stage；raw-source marker 防止翻译历史、用户内容与工具结果。

远程 A2A/MCP/provider 能力是第三方边界：StaffDeck 传递 context 并持久化恢复，但真实对端是否遵循
reply locale 必须通过集成测试验证，不得从本地 mock 推断。

## 格式化、缺失与回退

- 日期、时间、数字、货币、百分比、单位、列表和排序使用当前 BCP 47 locale，时区/货币为显式业务输入。
- 复数、select 和插值使用 ICU；参数名和语义在每个 catalog 中一致。
- 开发/测试对缺失键 fail closed；生产使用受控 fallback chain，不显示 raw key 或后端自然文本。

## 持续治理

`npm run i18n:check` 聚合：

1. TypeScript/JSX 产品 sink、ARIA、native dialog、Toast、fixed locale、manual formatting、动态/自然语言键、宽泛 ignore；
2. Python public error/event、非结构 payload、raw exception 泄露、固定 Agent reply locale、产品 trace/prompt 边界；
3. catalog duplicate/missing/extra/stale/unused/ICU/params 漂移；
4. generated backend contract 与 pseudo catalog 漂移。

CI 再执行前端全测试/构建、后端全 pytest、精确 i18n Ruff 和 Chromium 矩阵；release 依赖同一
quality workflow。新语言必须先注册 locale，创建完整 catalog，通过 ICU/params/pseudo/browser/review 后才能
进入生产切换器。
