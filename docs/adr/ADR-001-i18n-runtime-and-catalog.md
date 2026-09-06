# ADR-001：语义消息运行时与目录治理

- 状态：Accepted — staged rollout，整体迁移尚未完成
- 日期：2026-08-30
- 范围：前端产品消息、翻译目录、格式化、raw 内容边界

## 背景

FirmDeck 既有运行时曾以自然语言 source-key、数字占位符和全局 DOM observer 兼容旧页面。
这种方式无法可靠覆盖 Toast、原生对话框、页面标题、iframe/postMessage 和其他非 DOM 输出，
也会把用户输入、业务名称或 Agent 原文误判为可翻译产品文本。目录键、语言文案和参数契约
必须分离，才能在开发期暴露漏翻，在生产期安全回退，并支持未来增加语言。

## 决定

1. 产品消息使用稳定、可读的英文语义 ID，例如 `billing.invoice.itemCount`。英文文案是
   `en-US` 资源值，不是 ID；禁止中文/英文自然语言作键、动态构造键和数字占位符。
2. `en-US` 是 canonical catalog，负责键集合、ICU 消息结构和具名参数契约；`zh-CN` 是当前
   兼容默认目录。正式支持语言必须键集合、参数名、ICU 分支和转义结构对等。
3. React 组件内使用 `AppIntlProvider` 下的 `useAppIntl().t` 或 `MessageDescriptor`；组件外、
   Toast、原生对话框、下载和其他非 React 代码显式注入 `createAppTranslator`。`useAppIntl` 不得
   在组件外调用，旧 `useI18n` 仅限登记的迁移边界。
4. `MessageDescriptor` 只包含类型化 `MessageId` 和具名 `values`。值可以是安全的业务参数，
   但用户/业务 raw 内容不能进入 `id`；需要逐字保留的内容使用 `RawContent`/`RawIdentifier`
   和后端精确 raw marker。
5. 所有复数、选择、插值、日期、数字、货币和百分比使用 ICU/MessageFormat 与 `Intl`。禁止
   在业务代码拼接自然语言或固定地区参数；格式化必须接收当前 locale、明确时区和业务单位。
6. 目录检查必须拒绝重复键、键漂移、缺失/额外/未使用键、非法 ICU、参数结构不一致、自然
   语言 ID 和过宽忽略。开发、测试、CI 缺失键 fail-fast；生产按既定安全 fallback 顺序运行并
   记录不含业务参数的诊断。
7. legacy source-key/observer 仅作为有 owner、精确 scope、reason、telemetry、rollback boundary
   和 removal conditions 的兼容层；checker 的每一条 ignore/allowlist 抑制还必须有精确
   fingerprint 和 ISO expires。新代码不得新增使用，且必须逐项迁移后删除。

## 后果

- 产品文本从 DOM 扫描转为可在 DOM、非 DOM、API 投影和异步重放中复用的显式契约。
- 语言包可以独立审核和扩展，参数/ICU 结构错误在运行前暴露；翻译人员不需要把业务数据写进资源。
- 迁移期间必须维护新旧两条路径，且旧 source-key 的使用会暂时增加代码和检查复杂度。
- 仅凭静态检查不能证明 UI 完整；关键路由仍需两种正式语言和伪本地化的真实浏览器验收。

## 回滚

回滚边界是语义运行时的应用接入层，而不是回退目录或重写用户数据。若新运行时阻断关键
流程，可暂时将登记的旧调用方切回 legacy facade，同时保留 canonical catalog、descriptor
类型和检查结果；禁止恢复全局 observer 的新调用点或把 raw 数据加入翻译目录。数据库和用户
内容不因运行时回滚而翻译或改写。修复后重新通过聚焦测试、完整静态检查和浏览器矩阵，再继续
迁移；所有临时回滚必须记录 owner、触发原因和新的到期日。

## 验收边界

本 ADR 定义架构和门禁，不声明当前全仓迁移、CI、生产构建或真实浏览器已通过；这些结果须在
`docs/i18n/validation-report.md`、浏览器验收记录及 CI artifact 中分别证明，未执行项标记
`UNVERIFIED`。
