# StaffDeck Agent 规则路由

本文件仅用于路由项目规则。不要预加载规则文件；仅按当前任务读取下表选中的文件。当任务
跨越多个范围时，读取所有匹配的文件。

| 任务范围 | 读取 |
|---|---|
| 读取、修改、测试或调试后端代码 | `docs/agents/domain.md` + `docs/agents/backend.md` |
| 读取、修改、测试或调试前端代码 | `docs/agents/domain.md` + `docs/agents/frontend.md` |
| 修改 UI 文案、本地化或语言区域行为 | `docs/agents/i18n.md`（修改前端代码时还需读取 `docs/agents/frontend.md`） |
| 运行本地应用 | `docs/agents/local-runtime.md` |
| 修改配置、凭据或安全敏感行为 | `docs/agents/security.md` |
| 编写或整理项目文档 | `docs/agents/documentation.md` |
| 编写涉及领域术语或 ADR 的项目文档 | `docs/agents/domain.md` + `docs/agents/documentation.md` |
| 创建或管理 Issue | `docs/agents/issue-tracker.md` + `docs/agents/triage-labels.md` |
| 提交、推送、创建或审查 Pull Request | `docs/agents/git.md` |
| 准备带版本号的发布或修改应用版本 | `docs/agents/release.md` |

如无路由匹配，无需加载项目专项规则。仅当任务发生变化，或对话上下文不再包含已读规则时，
重新读取相应文件。
