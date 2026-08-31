# 发布与版本管理

平台发布产物位于 `packaging/`。

`backend/VERSION`（纯 semver）是唯一的版本事实来源。
`backend/pyproject.toml` 会动态读取它；绝不编辑其版本字段。修改 `backend/VERSION` 时，
在同一次提交中运行 `scripts/sync_version.py`，使 `frontend-enterprise/package.json` 保持同步。

仅在发布时修改版本。兼容性修复使用 patch，向后兼容的新功能使用 minor，破坏性变更使用
major；在 1.0 之前，破坏性变更也递增 minor。发布流程：更新版本、同步版本、提交、合并、
打上对应的 `vX.Y.Z` 标签，然后推送该标签。

## 国际化发布门禁

国际化架构和当前迁移状态见根 `CONTEXT.md` 及 `docs/adr/`。发布说明、构建成功或桌面安装包
生成本身，都不能替代国际化门禁。发布候选至少必须具备以下证据；其中任一任务未接入、失败或
无法在目标环境运行，都必须阻止发布或明确标记 `UNVERIFIED`，不得宣称已完整支持。

1. `en-US` canonical catalog 与每个正式语言（当前 `zh-CN`）键集合、ICU 结构、具名参数、
   转义和类型检查通过；重复、缺失、额外、未使用、失效和漂移键为零。
2. 前端 `npm --prefix frontend-enterprise run i18n:check`、相关 Vitest、生产 `build` 和
   后端错误/事件/语言上下文契约测试通过；静态检查不能被新增宽泛 ignore 或过期 allowlist 绕过。
3. 后端错误 code/event_code 已注册，公共响应不暴露自然语言异常或 private cause；request/trace
   诊断链路仍可用。Agent 的 UI/reply locale 快照在适用的 session、stream、retry、recovery、
   handoff、team、channel、scheduled/public/background 路径中保持一致。
4. 关键路由按两种正式语言、用户角色、权限、正常/空/加载/错误状态、无障碍属性、响应式视口、
   原生对话框、Toast、iframe/postMessage、剪贴板、下载和伪本地化完成真实浏览器验收。mock 或
   静态检查只能作为补充；第三方嵌入、真实 provider 和未运行的 packaged runtime 标记
   `UNVERIFIED`。
5. 所有兼容边界均有 owner、reason、fingerprint、expires、使用信号和移除条件；发布不得新增
   legacy source-key、observer、自然语言错误字段或无期限 allowlist；每条抑制必须有精确 fingerprint、
   owner、reason 和 ISO expires。废弃键和兼容 projection
   的删除需有上一周期零使用证据及回滚方案。

## 迁移、回滚与版本同步

- 语言/错误/事件/schema 迁移必须先保证旧 reader/client 可安全读取，再增加 canonical 字段和
  snapshot；不能为了发布翻译或改写既有用户、Agent、知识库、工具或日志内容。
- 发布回滚以应用版本、兼容 projection 和 additive schema 边界为单位。可以恢复登记的旧投影或
  `zh-CN` 缺失快照默认，但不能让当前 UI locale 覆盖已绑定 Agent reply locale，也不能恢复异常
  直出或删除诊断证据。回滚触发原因、影响、owner 和重新验证条件必须写入发布记录。
- 新增正式语言必须在版本变更中同步 locale registry、目录、类型/提取产物、formatter、伪本地化、
  浏览器验收和翻译审核；只增加 JSON 文件不构成可发布语言。
- 当前仓库工作流是否已经接入上述全部质量 job，以 `.github/workflows/` 的实际配置和 CI artifact
  为准；本规则是发布要求，不把尚未存在的 job 视为已通过。
