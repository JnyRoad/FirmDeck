# 多租户

FirmDeck 是多租户系统。任何新功能默认在租户上下文内开发；按单租户假设编写的代码
（无 `tenant_id` 归属、无租户过滤、无生命周期检查）视为缺陷，不是可选优化。架构依据为
根 `CONTEXT.md` 术语与 `docs/adr/ADR-004-system-tenant-control-plane.md`。

## 数据所有权

- 所有业务数据模型、表、查询、API 和后台任务必须以 `tenant_id` 作用域隔离；列表/详情/
  更新/删除查询必须带租户过滤条件，禁止仅凭主键跨租户读写。
- 不属于任何租户的安装级资源必须显式声明系统面归属（如 `owner_scope=system`），二选一，
  不允许「无主」数据；禁止创建伪租户表达系统运行时。
- 租户 `slug` 创建后不可变；不提供租户硬删除。

## 权威租户上下文

- 服务端认证解析出的 tenant principal 是唯一权威租户上下文。后端路由通过
  `backend/app/security/auth.py` 的 `require_current_tenant` 等依赖校验请求租户与当前用户
  一致，不信任调用方声称的 `tenant_id`。
- 前端只能使用 `frontend-enterprise/src/contexts/TenantSessionContext.tsx` 提供的租户会话；
  不得从固定常量、旧 `localStorage` 或用户可编辑参数推断当前租户。

## 生命周期与副作用前检查

- 租户生命周期为 `active/suspended`，携带单调递增 `lifecycle_version`
  （`backend/app/db/models.py` 的 `Tenant`）。
- HTTP admission、流式输出、job/webhook、scheduled、channel、Harness/team、tenant-owned
  A2A 及其 recovery，必须在各自副作用前通过 `backend/app/security/tenant.py` 的
  `require_active_tenant` 取得 `TenantLifecycleDecision`；durable 工作必须保存 admission 时的
  `lifecycle_version`，恢复或续写前用 `require_matching_admission_version` 校验，旧 generation
  不能覆盖新 owner。
- 新增异步执行边界必须注册 `TenantExecutionKind`，不得绕过中央 admission 门直接查表判断。
- 无法安全 fence 的执行路径应暂停并返回注册的稳定错误（如 `TENANT_SUSPENDED`、
  `TENANT_NOT_FOUND`、`TENANT_MISMATCH`），而不是绕过 active/version/owner 检查。已开始且
  结果无法证明的外部调用记录 `EXTERNAL_OUTCOME_UNKNOWN`，不得自动重放。

## 系统面与租户面隔离

- 系统管理员控制面（`/system/*`、`backend/app/security/system_admin_auth.py`）与租户数据面
  双向隔离：租户 token 与系统 token 双向拒绝，功能不得跨面复用凭据、session 或 UI 状态。
- 系统管理员不能模拟租户用户，也不能把系统 token 转发到租户 API；租户管理员只管理其租户
  内数据。

## 测试门禁

- 新功能测试必须包含跨租户隔离用例：租户 A 的用户不可见、不可改租户 B 的数据（含列表、
  详情、更新、删除和后台任务路径）。
- 涉及异步/durable 边界时，必须补暂停租户拒绝用例和 admission version 过期拒绝用例。
- 无法运行真实渠道、provider 或完整生命周期链路时，报告标记 `UNVERIFIED`，不得用 mock
  结果宣称隔离已验证。
