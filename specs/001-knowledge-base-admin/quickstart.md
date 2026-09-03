# Quickstart: 验证 knowledge-base-admin

## 前置

```bash
# 后端
python3 -m venv backend/.venv && backend/.venv/bin/python -m pip install -e "backend[dev]"
# 前端
npm --prefix frontend-enterprise ci
```

启动方式见 `docs/agents/local-runtime.md`。以租户管理员（`role=admin`）登录。

## 自动化门禁（每次改动后）

```bash
backend/.venv/bin/python -m pytest backend/tests/test_knowledge_admin_listing.py backend/tests/test_knowledge_version_labels.py backend/tests/test_knowledge_admin_bypass.py backend/tests/test_knowledge_diff.py backend/tests/test_knowledge_rebase.py backend/tests/test_knowledge_review_writeback.py
backend/.venv/bin/python -m pytest backend/tests/test_error_contracts.py backend/tests/test_event_contracts.py backend/tests/test_language_context.py
backend/.venv/bin/python scripts/i18n/check_python.py
backend/.venv/bin/ruff check backend
npm --prefix frontend-enterprise run i18n:check
npm --prefix frontend-enterprise test -- knowledge-admin
npm --prefix frontend-enterprise run build
```

## 端到端场景（按 spec 用户故事，`zh-CN` 与 `en-US` 各跑一遍）

### S1 统一总览（US1）
1. 准备：1 个未绑定群组的共享库、2 名员工各 1 个私有库。
2. 侧栏「知识库管理」→ 列表出现全部 3 个库，统计卡 3/1/2/文档数正确，未绑定库带提示。
3. 按"私有 + 员工 A"筛选只剩 A 的库；按群组筛选只剩绑定库。
4. 新建私有库不选员工 → 阻止；选员工后创建 → 跳转详情。
5. 用非 admin 账号访问 `/enterprise/knowledge-admin` → 被重定向。

### S2 草稿审阅与发布（US2）
1. 共享库正式版 1.0.0 → 创建草稿（原因必填）→ 横幅显示草稿名 `draft-xxxx`、基线 1.0.0、发布后 1.0.1。
2. 草稿视图上传 1 篇、修改 1 篇、删除 1 篇；正式视图看不到新增篇。
3. 查看变更：计数 1/1/1；修改篇行级红绿且字符级高亮。
4. 接受第 1 块 → 折叠为 ✓ 普通文本；撤销接受 → 恢复；拒绝第 2 块 → 回到基线。
5. 直接在绿色行末输入文字、回车拆行、退格合并、跨两行选中后按删除、粘贴多行、中文输入法输入 → 标记实时重算、光标不跳。
6. 接受全部 → "全部已审阅"，应用到草稿可点 → 应用 → 审计出现"draft_reviewed"。
7. 发布：默认 1.0.1，切 minor 显示 1.1.0；确认后版本列表顶部为新正式版，审计"version_published"含草稿名与级别。

### S3 并发与变基（US3）
1. 草稿 A、B 均基于 1.0.0；A 改文档甲；B 改文档甲与乙。
2. 发布 A → 1.0.1。打开 B 发布框 → 显示"基线已过期"，冲突文档 1 篇，按钮：变基（推荐）/ 仍然覆盖发布 / 取消。
3. 变基预览：乙"可自动合并"，甲"冲突"→ 打开合并：逐块选择或编辑；有残留标记时"完成"禁用。
4. 完成变基 → B 草稿名不变、基线 1.0.1；发布 B → 1.0.2，正式版同时含 A 与 B 保留的内容。
5. 审计含 `draft_rebased`（from/to、自动合并数、解决冲突数）。

### S4 群组与权限（US4，P1）
绑定群组 → 成员未授权；批量设 reader 保存；修改 revision 后再保存 → 冲突提示；设默认写入；解绑 → 授权撤销。

### S5 私有库与转共享（US5，P1）
统一页打开员工私有库 → 上传后分支头 +1；从广场同步 / 发布到广场；转共享向导（原因必填）→ 源库归档、新库带绑定。

## 记录要求

- 每个场景记录：环境、语言、结果、截图（可见 UI 改动）。
- 未能真实运行的项（输入法、浏览器矩阵、第三方）在 PR 中标 `UNVERIFIED`，不得写"已支持"。
