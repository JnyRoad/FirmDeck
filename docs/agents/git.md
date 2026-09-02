# Git 与 Pull Request

使用简洁的 Conventional Commit 提交信息，例如 `feat(channels): add binding
status`。保持提交聚焦。Pull Request 必须说明意图和风险、关联相关工作、列出验证、标识
受影响的路由和角色、为可见 UI 改动附上截图，并保留工作树中无关的改动。

## Git 提交范围

- `specs/<编号>-<短名>/`（spec.md、plan.md、tasks.md 及 plan 阶段的配套文件）和
  `.specify/`（模板、脚本、`memory/constitution.md`）是项目资产，随对应功能一起提交、
  进入 PR。机器本地状态已由 `.specify/.gitignore`（`feature.json`）和根 `.gitignore`
  （`.specify/_unused/`）排除，不要手工加入。
- 原因：开发在 worktree 中进行，未跟踪文件不会跨 worktree 出现，worktree 清理时会一并
  丢失；只有纳入版本管理，规格才能作为唯一事实源被后续会话和评审引用。
- 规格文件与代码分开提交（`docs(specs): ...`），便于评审时区分需求变更与实现变更。
- `design-*.md` 仍是本地设计与评审材料，默认不得加入暂存区、commit、PR 或 push；只有
  用户明确指定时才能提交。
- 执行 `git add` 时必须显式列出本次需要提交的代码、文档、配置、测试和规格文件，不使用
  `git add .`、`git add -A` 或其他会顺带暂存无关文件的命令。
- 提交前必须检查 `git diff --cached --name-only`，确认不存在 `design-*.md` 以及其他与本次
  任务无关的改动。
