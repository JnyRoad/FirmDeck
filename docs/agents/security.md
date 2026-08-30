# 安全与配置

将 `backend/.env.example` 复制为 `backend/.env`；绝不提交密钥或渠道凭据。使用高强度
`APP_SECRET` 和最小权限的外部凭据。当前受支持的生产迁移路径以 SQLite 为前提。
