# ADR-004：系统租户控制面与 A2A 所有权

- 状态：Accepted
- 日期：2026-08-31
- 范围：系统管理员、租户生命周期、租户登录、异步执行边界、A2A 所有权

## 背景

原有 `admin` 是租户内角色，不能安全地承担创建、暂停或恢复其他租户的职责。把租户管理继续
放在租户数据面会产生两个问题：租户身份可越权进入系统控制面，以及系统凭据可能被误用于租户
业务接口。原有 Codex A2A 又曾以 `a2a_codex` 伪租户表达系统运行时，混淆了安装级资源与租户
业务数据的所有权。

当前项目仍处于开发阶段，没有需要保留的生产 A2A 历史数据，因此无需为伪租户模型增加运行时
兼容分支。

## 决定

1. 引入独立的 `SystemAdmin` 控制面。系统管理员使用专用 `SYSTEM_ADMIN_SECRET`、token audience、
   路由、前端 session 和 `/system/*` UI；租户 token 与系统 token 双向拒绝。系统管理员不能模拟
   租户用户，也不能把系统 token 转发到租户 API。
2. 第一个系统管理员只能由本机 CLI 在正常 startup/migration 完成后创建。开发初始化固定创建
   `sysadmin` / `sysadmin`，并强制首次登录修改；修改前的 token 只能访问身份读取、修改密码和只读
   密码策略接口，不能读取租户、修改策略或执行其它系统控制操作。
   系统管理员密码恢复只允许本机 CLI 通过无回显 prompt 输入新密码，不能作为 argv、环境示例值
   或日志字段，并使旧 token 失效。固定初始化凭据不得作为生产部署机制。
3. 系统控制台支持租户创建、列表/详情、显示名修改、初始管理员密码重置、暂停、恢复和审计。
   租户 slug 创建后不可变；不提供租户硬删除。租户管理员仍只管理其租户内数据。
4. 租户登录由 slug、租户内用户名和密码共同解析。服务端返回的 tenant principal 是唯一权威
   上下文；前端不得从固定常量、旧 localStorage 或用户可编辑参数推断当前租户。
5. tenant lifecycle 采用 `active/suspended` 与单调递增 `lifecycle_version`。HTTP admission、流式
   输出、job/webhook、scheduled、channel、Harness/team、tenant-owned A2A 及其 recovery 都必须
   在各自副作用前检查 active 与原 admission version；旧 generation 不能覆盖新 owner。已经开始
   且结果无法证明的外部调用记录 `EXTERNAL_OUTCOME_UNKNOWN`，不得自动重放。
6. `A2ATaskRun` 只有两种互斥 owner shape：
   - tenant outbound client：`owner_scope=tenant`、真实 `tenant_id`、原 lifecycle version；
   - installation Codex server：`owner_scope=system`、`system_runtime_key=codex_a2a`、无 tenant。
   Codex A2A 只受安装级 enabled、非空专用 bearer credential 和 system owner 状态机控制，不解析
   租户生命周期，不创建 `a2a_codex` 或任何保留租户。
7. 暂停能力只有在 lifecycle matrix、迁移、错误/事件契约、隔离浏览器和安全检查完成后才能作为
   可依赖的生产控制。mock provider 不能证明真实第三方链路，未运行的 provider 必须标为
   `UNVERIFIED`。

## 运维边界

- `SYSTEM_ADMIN_SECRET` 必须与 `APP_SECRET` 不同、非空且无首尾空白；缺失时系统 HTTP 认证
  fail-closed，不回退到租户 secret。
- `CODEX_A2A_ENABLED=true` 时必须同时配置非空、无首尾空白的 `CODEX_A2A_TOKEN`；状态接口只能
  返回是否已配置，不得返回 token、prompt、workspace 内容或执行结果。
- 新开发环境直接使用新 schema。仍含旧 A2A 伪租户/schema 的开发数据库必须先确认精确路径，再
  由操作者明确授权重建；不得在 startup 中自动删除、改写或兼容迁移伪租户数据。
- 系统审计只保存 actor、目标、动作、结果、生命周期版本、操作原因和 correlation；不得保存密码、
  hash、bearer/API key、provider 原文或租户业务内容。

## 后果

- 系统控制面与租户数据面具有独立身份和最小权限边界，系统管理员不再是“更大的租户管理员”。
- 所有 durable worker 需要保存 admission/owner generation 并以条件更新完成，迁移和测试成本提高。
- 暂停后恢复只允许新登录和新工作；暂停前已终结或结果未知的工作不会因恢复而重放。
- Codex A2A 不再出现在租户列表中，也不能借用租户 UI、tenant token 或租户生命周期。

## 回滚

可以关闭系统控制面入口或 `CODEX_A2A_ENABLED`，但保留新增表、列和审计，不回退为 tenant-admin
授权、不重新创建伪租户、不删除 lifecycle 证据。若某个异步边界无法安全 fence，应暂停该执行
路径并返回稳定错误，而不是绕过 active/version/owner 检查。
