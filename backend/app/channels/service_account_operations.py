"""共享渠道账号 operation 写入门禁，位于 router 与数据库模型之间。"""

from __future__ import annotations

from sqlmodel import Session, select

from app.contracts.http import build_http_exception
from app.db.models import ChannelBinding, WeChatKfAccountOperation

WECHAT_KF_OPERATION_RECONCILABLE = frozenset({"prepared", "provider_inflight", "provider_applied"})
WECHAT_KF_OPERATION_BLOCKING = WECHAT_KF_OPERATION_RECONCILABLE | {"manual_review"}


def ensure_channel_binding_has_no_blocking_account_operation(
    db: Session,
    binding: ChannelBinding,
) -> None:
    """拒绝存在待恢复或人工裁决账号 operation 的微信客服 binding 写入。

    非微信客服 binding 直接通过。该函数只读当前事务；命中阻断状态时抛出不含 operation、provider
    或 Secret 参数的注册 `CHANNEL_CONFLICT`，不产生持久化副作用。
    """
    if binding.channel != "wechat_kf":
        return
    blocking = db.exec(
        select(WeChatKfAccountOperation.id).where(
            WeChatKfAccountOperation.tenant_id == binding.tenant_id,
            WeChatKfAccountOperation.binding_id == binding.id,
            WeChatKfAccountOperation.status.in_(WECHAT_KF_OPERATION_BLOCKING),
        )
    ).first()
    if blocking is not None:
        raise build_http_exception("CHANNEL_CONFLICT", status_code=409)


__all__ = [
    "WECHAT_KF_OPERATION_BLOCKING",
    "WECHAT_KF_OPERATION_RECONCILABLE",
    "ensure_channel_binding_has_no_blocking_account_operation",
]
