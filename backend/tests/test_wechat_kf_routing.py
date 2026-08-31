"""微信客服账号级路由和通知目标的隔离契约。"""

from app.channels import service_intake
from app.channels.adapters.base import ChannelInbound
from app.db.models import ChannelBinding


def _inbound(account_scope: str) -> ChannelInbound:
    """构造一个不访问 provider 的微信客服入站消息。"""
    return ChannelInbound(
        channel="wechat_kf",
        event_id="msg-route-1",
        from_user_id="external-user-1",
        to_user_id="wk-account-1",
        session_id="external-user-1",
        group_id="",
        context_token="",
        text="route",
        is_group=False,
        raw={},
        account_scope=account_scope,
    )


def test_wechat_kf_processing_preserves_account_level_scope() -> None:
    """防止处理阶段把 corp/account 快照降级成 corp 级身份和会话作用域。"""
    binding = ChannelBinding(
        tenant_id="tenant_demo",
        agent_id="agent_1",
        channel="wechat_kf",
        status="active",
        identity_scope_key="ww-corp",
        config_json={"corp_id": "ww-corp"},
    )
    inbound = _inbound("ww-corp:wk-account-1")

    scope = service_intake._resolved_inbound_account_scope(binding, inbound)

    assert scope == "ww-corp:wk-account-1"


def test_wechat_kf_notice_target_does_not_require_legacy_context_token() -> None:
    """防止指令和系统 notice 因微信客服没有 context_token 而被静默丢弃。"""
    assert service_intake._valid_notice_target(
        "wechat_kf",
        {"to_user_id": "external-user-1", "open_kfid": "wk-account-1"},
    )
    assert not service_intake._valid_notice_target(
        "wechat_kf",
        {"to_user_id": "external-user-1"},
    )
