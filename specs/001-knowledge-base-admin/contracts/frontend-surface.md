# Contract: 前端表面（路由、菜单、i18n、组件边界）

## 路由与菜单

| 项 | 值 |
|---|---|
| 枚举 | `EnterpriseRoute.KnowledgeAdmin = '/enterprise/knowledge-admin'` |
| 路由 | `/enterprise/knowledge-admin`（列表）、`/enterprise/knowledge-admin/:kbId`（详情，`?tab=content|versions|grants|audit|settings` / 私有库 `content|branch|settings`，`?view=pub|<draftVersionId>`） |
| 守卫 | 非 `isEnterpriseAdmin` → `Navigate` 到 `EnterpriseRoute.Gallery`（与 `/enterprise/accounts` 一致） |
| 菜单 | `AppSidebar.SYSTEM_NAV` 追加 `{route: KnowledgeAdmin, labelId: 'shell.nav.knowledgeAdmin', icon: sys-knowledge.svg}`；仅 admin 渲染 |
| 作用域 | 页面不读 `readEmployeeScope`，不监听 agent-scope 事件 |

## i18n 命名空间 `knowledgeAdmin.*`（`en-US` canonical，`zh-CN` 同步）

- `nav.*`、`list.{title,description,stats.*,tabs.*,filters.*,columns.*,menu.*,empty}`
- `detail.{back,tabs.*,badges.*}`、`content.{viewer.*,banner.*,table.*,actions.*}`
- `versions.{title,subtitle,states.*,actions.*,meta.*,levels.*}`
- `review.{title,summary.*,hunk.*,actions.*,hints.*,toast.*}`
- `rebase.{title,intro,autoMerged,conflict,actions.*}`、`merge.{title,columns.*,actions.*,result.*}`
- `grants.*`（复用 `teamDetailPage.knowledge.*` 已有键的部分直接引用）、`audit.*`、`settings.*`
- `dialogs.{createKb,createDraft,publish,delete,unbind}.*`、`toast.*`
- 错误映射：`errors.knowledge.baselineStale`、`rebaseConflictsUnresolved`、`versionLevelInvalid`、`documentLineageMismatch`

Raw 边界：知识库名、描述、文档标题、草稿名、版本号、群组名、员工名、diff 行文本、审计 reason 一律
`RawContent` / `RawIdentifier`；不得进入 `values` 以外的位置。

## 组件边界与依赖方向

```text
pages/knowledge-admin/*  ──►  api/knowledgeAdmin.ts  ──►  api/tenant-client.ts
        │
        ├──►  components/knowledge/{TeamKnowledgePermissionMatrix, SharedKnowledgeConversionDialog, KnowledgeTypeBadge}
        ├──►  components/ui/*（shadcn）
        └──►  pages/knowledge-admin/review/*（纯函数 + ReviewEditor，无 API、无 i18n 副作用；文案由父组件注入）
```

- `api/knowledgeAdmin.ts` 是管理端唯一的 HTTP 调用点，函数与契约 A/B 一一对应，返回类型放在 `types/knowledgeAdmin.ts`。
- `review/lineDiff.ts`（LCS 行 diff）、`review/hunkModel.ts`（rows/hunks/pairing/字符级 ops）、`review/staging.ts`（暂存基线、接受/拒绝/撤销、位置偏移）为纯函数，必须有 Vitest。
- `ReviewEditor` 只接收 `{base, initialLines, staged, onChange}` 与文案 props，向上抛出 `{lines, staged, pendingCount}`；"应用到草稿"由 `ContentTab` 调 API。
- `MergeDialog` 接收 `RebasePreview.conflicts[i]`，输出 `{lineage_id, content_md}`；不调 API。

## 关键交互（与原型一致）

- 列表行点击进详情；`⋯` 菜单：编辑 / 版本管理 / 群组与权限（共享）或转换为共享（私有，archived 禁用）/ 导出备份 / 图谱检查 / 上线-下线 / 删除。
- 内容 Tab：`查看版本` 切换器；正式视图只读且隐藏草稿新增；草稿视图显示新增 / 修改 / 删除标记，删除可恢复；横幅含创建者、来源、基线、发布后版本号预览、原因；按钮：查看变更 / 发布此草稿 / 驳回。
- 审阅编辑器：直接编辑（含输入法组合、跨行选区删除 / 替换 / 粘贴）、整篇实时重算；块级接受（暂存折叠）/ 拒绝；行级 ↩ / ✕；选区撤销；整篇接受全部 / 拒绝全部 / 重置；顶部待审阅 / 已接受 / 已修改；应用到草稿。
- 发布框：版本递进下拉（patch 默认 / minor / major，显示结果号）、审阅状态；stale 时显示冲突数并提供变基（推荐）/ 仍然覆盖发布（红）/ 取消。
- 变基预览：逐篇"可自动合并"或"冲突"；冲突进入两栏合并（采用草稿 / 采用正式版 / 两者都保留 / 编辑此段），结果带 Git 标记可编辑，无残留标记方可完成。
- 版本 Tab 顺序：草稿置顶 → released 降序 → rejected。
