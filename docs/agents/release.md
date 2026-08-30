# 发布与版本管理

平台发布产物位于 `packaging/`。

`backend/VERSION`（纯 semver）是唯一的版本事实来源。
`backend/pyproject.toml` 会动态读取它；绝不编辑其版本字段。修改 `backend/VERSION` 时，
在同一次提交中运行 `scripts/sync_version.py`，使 `frontend-enterprise/package.json` 保持同步。

仅在发布时修改版本。兼容性修复使用 patch，向后兼容的新功能使用 minor，破坏性变更使用
major；在 1.0 之前，破坏性变更也递增 minor。发布流程：更新版本、同步版本、提交、合并、
打上对应的 `vX.Y.Z` 标签，然后推送该标签。
