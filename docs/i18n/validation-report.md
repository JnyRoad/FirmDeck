# 国际化治理验证报告

状态：`COMPLETE_WITH_UNVERIFIED_BOUNDARIES`

## 基线与授权边界

- 基线/当前 `HEAD`：`a22231d00770ba6958f2a2bf1b0d65008bd858c3`，与 `origin/main` merge-base 一致。
- 工作分支：`feat/i18n-governance`，独立 Worktree。
- 当前修改尚未提交；未 push、未创建 PR、未 merge。
- 测试与浏览器使用本地/临时环境，未连接生产 SQLite，未创建或覆盖 `.env`。

## 最终架构状态

- 正式 UI locale：`zh-CN`、`en-US`；canonical catalog：`en-US`；测试 locale：`en-XA`。
- 两个正式 catalog 各 4342 个稳定语义键，ICU 结构、具名参数和键集一致；`en-XA` 从
  canonical catalog 生成并保持 4342 个测试消息。
- 后端生成契约：384 个 public error descriptors、68 个 events；前端从生成契约安全本地化。
- UI locale 与 Agent reply locale 独立；`LanguageContext` 在持久化、重试、恢复、handoff、
  scheduled/team/channel/public/General Skill/Tool/本地 A2A 链路中使用不可变快照。
- 全局 DOM observer、WeakMap、自然语言键、数字占位符与前端 legacy runtime 已删除。
- 保留 5 个精确后端兼容边界，禁止新消费者，有 owner、fingerprint、telemetry/audit signal、
  `0.6.0`/到期时间和移除条件。

架构详细见 `docs/i18n/architecture.md` 及 ADR-001/002/003。

## Clean-environment quickstart 结果

2026-08-30 使用独立 `/private/tmp/staffdeck-i18n-clean-venv-862a` Python 3.12 venv 与全新
`npm ci` 执行。默认 npm cache 因历史 root-owned 文件返回 `EPERM`；改用独立
`/private/tmp/staffdeck-npm-cache-862a` 后同一锁文件安装 574 packages 成功。

| 范围 | 命令 | 结果 |
|---|---|---|
| 前端 checker fixtures | `npm --prefix frontend-enterprise test -- scripts/i18n/checker.test.cjs` | 38 passed |
| 后端 checker fixtures | `.../bin/python -m pytest backend/tests/test_i18n_checker.py -q` | 18 passed |
| 聚合 i18n gate | `npm --prefix frontend-enterprise run i18n:check` | PASS；176 files / 4342 messages；241 Python files；contract/pseudo current |
| 前端全套 | `npm --prefix frontend-enterprise test` | 95 files / 656 tests passed |
| Vite 配置 | `npm --prefix frontend-enterprise run config:check` | PASS |
| TypeScript + 生产构建 | `npm --prefix frontend-enterprise run build` | PASS；2179 modules；仅 chunk-size warning |
| error contracts | `.../bin/python -m pytest backend/tests/test_error_contracts.py -q` | 12 passed |
| event contracts | `.../bin/python -m pytest backend/tests/test_event_contracts.py -q` | 4 passed |
| LanguageContext | `.../bin/python -m pytest backend/tests/test_language_context.py -q` | 9 passed |
| schema migration | `.../bin/python -m pytest backend/tests/test_i18n_contract_schema_migration.py -q` | 5 passed |
| 后端全套 | `.../bin/python -m pytest backend/tests -q` | 2525 passed，195 third-party/deprecation warnings，0 failures |
| release i18n Ruff | quickstart/quality.yml 声明的精确路径 | All checks passed |
| Playwright i18n | `npm --prefix frontend-enterprise run test:e2e:i18n` | 8 passed（沙箱外 Chromium，4.9s） |
| whitespace | `git diff --check` | PASS |

为了不隐藏仓库其他质量债务，额外执行了非 i18n 发布门禁的全后端
`ruff check backend`：它返回 1936 个既有通用风格诊断（1019 个可自动修复），主要是 B008、
UP045、RUF100、DTZ001 等。这不是国际化 checker 诊断，当前 quality workflow 也只将精确
i18n 路径的 Ruff 作为发布阻断项；本次未使用 broad ignore 掩盖这些债务。

## 浏览器与运行验收

- 真实本地前后端 Chrome：102/102 PASS，`zh-CN`/`en-US`、14 routes、3 viewports、
  admin/member/signed-out、locale 持久化、dialog/form/ARIA、权限状态；20 张成功截图。
- 专项 Playwright：8/8 PASS，额外覆盖 `en-XA`、iframe/postMessage、native prompt、raw 原文。
- 详细记录：`docs/i18n/browser-acceptance.md`。

## CI、规则与发布

- `quality.yml` 包含 static-i18n、frontend、backend-i18n、browser 四个 job，使用 `npm ci`。
- backend-i18n 安装 contract/dev 依赖，执行 Python checker、generated contract check、全后端 pytest
  及精确 i18n Ruff。
- release workflow 依赖可复用 quality workflow，不存在 `npm install` fallback。
- `CONTEXT.md`、`docs/agents/i18n.md`、backend/frontend/release 规则与 ADR 已固化新文本、
  错误码、Agent 语言、raw 边界、新语言、废弃键与验收流程。
- 用户可见会话标题不再兼作机器分类：新增稳定 `session_kind`，旧中文前缀仅用于精确迁移/
  读取兼容；团队黑板正文保持 raw，来源与标签进入结构化 metadata。
- Harness 恢复会话摘要直接使用持久化 reply locale 生成的恢复回复，不再拼接固定中文前缀。

## 已知边界与后续动作

- `UNVERIFIED`：真实 LLM/provider 对非中文 Agent reply contract 的遵循度。
- `THIRD_PARTY_CONSTRAINED` + `UNVERIFIED`：真实飞书/钉钉/企微/微信、远程 A2A/MCP/provider
  的 locale 协商；StaffDeck 已传递快照并保留远程原文，不能代替对端能力。
- `UNVERIFIED`：Firefox、WebKit、macOS/Windows/Linux 打包产物；当前无 `packaging/out`可启动。
- `UNVERIFIED`：Skill stream job store 当前是进程内存实现，跨进程真实恢复需待持久化
  store 落地后再验收。
- 新增语言必须通过 catalog/ICU/params 对等、伪本地化、浏览器矩阵与翻译审核；不得
  在业务代码增加 locale 分支或大范围忽略。

`docs/i18n/inventory.json` 的 15 项已全部对账为 `FIXED`、`THIRD_PARTY_CONSTRAINED` 或
`UNVERIFIED`，无 `OPEN`。
