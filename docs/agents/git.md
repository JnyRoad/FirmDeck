# Git 与 Pull Request

使用简洁的 Conventional Commit 提交信息，例如 `feat(channels): add binding
status`。保持提交聚焦。Pull Request 必须说明意图和风险、关联相关工作、列出验证、标识
受影响的路由和角色、为可见 UI 改动附上截图，并保留工作树中无关的改动。

## Git 提交范围

- `design-*.md`、`.specify/` 和 `specs/` 是本地设计与评审材料，默认不得加入暂存区、
  commit、PR 或 push。
- 执行 `git add` 时必须显式列出本次需要提交的代码、文档、配置和测试文件，不使用
  `git add .`、`git add -A` 或其他会顺带暂存无关文件的命令。
- 提交前必须检查 `git diff --cached --name-only`，确认不存在 `design-*.md`、`.specify/` 或
  `specs/` 下的文件，以及其他无关改动。
- 只有用户明确指定其中某一份文件需要提交时，才能把该文件加入提交范围。
