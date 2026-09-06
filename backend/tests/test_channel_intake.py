import os
import threading
import time
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.channels.service_intake as intake_module
import app.core.agent_loop as agent_loop_module
from app.channels.adapters.base import ChannelInbound, ChannelInboundAttachment
from app.channels.service_dingtalk_inbox import (
    dingtalk_account_key,
    dingtalk_identity_scope,
    stage_dingtalk_inbound,
)
from app.channels.service_durable_inbox import StageDisposition
from app.channels.service_feishu_inbox import (
    feishu_account_key,
    feishu_identity_scope,
    stage_feishu_inbound,
)
from app.channels.service_identity import channel_username
from app.channels.service_intake import (
    _message_text,
    _session_lock,
    claim_staged_inbound,
    process_inbound,
    process_staged_inbound,
    sweep_stale_inbound_events,
)
from app.channels.service_intake import (
    _send_wechat_typing as _real_send_wechat_typing,
)
from app.channels.service_wecom_inbox import stage_wecom_inbound
from app.db.models import (
    ChannelBinding,
    ChannelDelivery,
    ChannelIdentity,
    ChannelInboundEvent,
    ChatSession,
    HumanHandoffRequest,
    Message,
    Tenant,
    User,
    new_id,
    utc_now,
)


def _test_engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _p2p_message(event_id: str = "evt_1", text: str = "你好") -> dict:
    return {
        "message_id": event_id,
        "from_user_id": "user_ab12cd34@im.wechat",
        "to_user_id": "bot_1@im.bot",
        "client_id": f"wx-{event_id}",
        "session_id": "user_ab12cd34@im.wechat#bot_1@im.bot",
        "message_type": 1,
        "message_state": 2,
        "context_token": f"ctx_{event_id}",
        "item_list": [{"type": 1, "text_item": {"text": text}}],
    }


def _group_message(event_id: str = "evt_g1", text: str = "群里问一句") -> dict:
    msg = _p2p_message(event_id, text)
    msg["group_id"] = "room_123456"
    msg["session_id"] = "room_123456"
    return msg


def _channel_language_snapshot() -> dict[str, object]:
    """Return one mixed snapshot resolved independently from channel defaults."""
    return {
        "version": 1,
        "ui_locale": "en-US",
        "agent_reply_locale": "zh-CN",
        "ui_locale_source": "channel_default",
        "agent_reply_locale_source": "channel_default",
    }


def _legacy_language_snapshot() -> dict[str, object]:
    """Return the controlled compatibility snapshot for a binding without locale hints."""
    return {
        "version": 1,
        "ui_locale": "zh-CN",
        "agent_reply_locale": "zh-CN",
        "ui_locale_source": "legacy_default",
        "agent_reply_locale_source": "legacy_default",
    }


def _seed_binding(engine, **overrides) -> str:
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        values = {
            "tenant_id": "tenant_demo",
            "agent_id": "agent_1",
            "channel": "wechat",
            "status": "active",
            "config_json": {"ilink_bot_id": "bot_1@im.bot"},
        }
        values.update(overrides)
        binding = ChannelBinding(**values)
        db.add(binding)
        db.commit()
        return binding.id


def _load_binding(engine, binding_id: str) -> ChannelBinding:
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        db.expunge(binding)
        return binding


def _set_tenant_lifecycle(engine, *, status: str, version: int) -> None:
    """Set the authoritative tenant state for a lifecycle boundary test without provider I/O."""
    with Session(engine) as db:
        tenant = db.get(Tenant, "tenant_demo")
        assert tenant is not None
        tenant.status = status
        tenant.lifecycle_version = version
        db.add(tenant)
        db.commit()


def _wecom_inbound(event_id: str, text: str = "hello") -> ChannelInbound:
    """Build one normalized WeCom callback payload whose provider account is test-controlled."""
    return ChannelInbound(
        channel="wecom",
        event_id=event_id,
        from_user_id="wecom-user-1",
        to_user_id="aib_bot1",
        session_id="wecom-user-1",
        group_id="",
        context_token="wecom-context-1",
        text=text,
        is_group=False,
        raw={"msgid": event_id},
        account_scope="corp-a",
    )


def _feishu_inbound(event_id: str, text: str = "hello") -> ChannelInbound:
    """Build a normalized Feishu callback payload for provider staging contracts."""
    return ChannelInbound(
        channel="feishu",
        event_id=event_id,
        from_user_id="ou_user_a",
        to_user_id="ou_bot_a",
        session_id="oc_chat_a",
        group_id="",
        context_token="om_message_a",
        text=text,
        is_group=False,
        raw={"event": {"message": {"message_id": event_id}}},
        account_scope="",
    )


def _dingtalk_inbound(event_id: str, text: str = "hello") -> ChannelInbound:
    """Build a normalized DingTalk callback payload for provider staging contracts."""
    return ChannelInbound(
        channel="dingtalk",
        event_id=event_id,
        from_user_id="staff-1",
        to_user_id="robot-1",
        session_id="conv-1",
        group_id="",
        context_token="https://example.test/reply",
        text=text,
        is_group=False,
        raw={"msgId": event_id},
        account_scope="tenant-a",
    )


def _provider_binding(engine, channel: str) -> str:
    """Seed one provider binding with all account-scope fields already pinned."""
    if channel == "wecom":
        return _seed_binding(
            engine,
            channel="wecom",
            config_json={"bot_id": "aib_bot1", "corp_id": "corp-a"},
        )
    if channel == "feishu":
        app_id, tenant_key = "cli_app_a", "tenant-a"
        return _seed_binding(
            engine,
            channel="feishu",
            config_json={"app_id": app_id},
            external_account_key=feishu_account_key(app_id),
            provider_tenant_key=tenant_key,
            identity_scope_key=feishu_identity_scope(app_id, tenant_key),
        )
    if channel == "dingtalk":
        client_id, tenant_key = "client-a", "tenant-a"
        return _seed_binding(
            engine,
            channel="dingtalk",
            config_json={"client_id": client_id},
            external_account_key=dingtalk_account_key(client_id),
            provider_tenant_key=tenant_key,
            identity_scope_key=dingtalk_identity_scope(client_id, tenant_key),
        )
    raise AssertionError(f"unsupported provider channel: {channel}")


def _stage_provider_callback(engine, channel: str, binding_id: str, event_id: str):
    """Invoke one provider staging function with its normal account-boundary arguments."""
    if channel == "wecom":
        return stage_wecom_inbound(
            db_engine=engine,
            binding_id=binding_id,
            expected_revision=0,
            account_scope="corp-a",
            inbound=_wecom_inbound(event_id),
        )
    if channel == "feishu":
        return stage_feishu_inbound(
            db_engine=engine,
            binding_id=binding_id,
            expected_revision=0,
            event_app_id="cli_app_a",
            tenant_key="tenant-a",
            inbound=_feishu_inbound(event_id),
            target={
                "message_id": event_id,
                "reply_in_thread": False,
                "receive_id_type": "open_id",
                "receive_id": "ou_user_a",
            },
        )
    if channel == "dingtalk":
        return stage_dingtalk_inbound(
            db_engine=engine,
            binding_id=binding_id,
            expected_revision=0,
            client_id="client-a",
            tenant_key="tenant-a",
            inbound=_dingtalk_inbound(event_id),
        )
    raise AssertionError(f"unsupported provider channel: {channel}")


def test_channel_only_attachment_uses_default_message_intent() -> None:
    binding = ChannelBinding(tenant_id="tenant_demo", agent_id="agent_1", channel="wecom")
    image = ChannelInbound(
        channel="wecom",
        event_id="evt-image",
        from_user_id="user-1",
        to_user_id="bot-1",
        session_id="user-1",
        group_id="",
        context_token="user-1",
        text="",
        is_group=False,
        raw={},
        attachments=[ChannelInboundAttachment(media_id="image", kind="image")],
    )
    file = ChannelInbound(
        **{
            **image.__dict__,
            "event_id": "evt-file",
            "attachments": [ChannelInboundAttachment(media_id="file", kind="file")],
        }
    )

    assert _message_text(binding, image) == "请读取并用一句话概括。"
    assert _message_text(binding, file) == "请读取并用一句话概括。"


class RecordingAgentLoop:
    """替代真实 AgentLoop：记录请求并模拟用户/助手消息落库。"""

    calls: list = []
    error: Exception | None = None

    def __init__(self, db, *, event_sink=None):
        self.db = db

    def handle_turn(self, request):
        type(self).calls.append(request)
        if type(self).error:
            raise type(self).error
        self.db.add(
            Message(
                id=new_id("msg"),
                tenant_id=request.tenant_id,
                session_id=request.session_id,
                role="user",
                content=request.message,
                metadata_json={"client_turn_id": request.client_turn_id or ""},
            )
        )
        self.db.add(
            Message(
                id=new_id("msg"),
                tenant_id=request.tenant_id,
                session_id=request.session_id,
                role="assistant",
                content="自动回复",
                metadata_json={},
            )
        )
        self.db.commit()


class TypingRecorder:
    """替代真实 typing 发送:记录 status 调用序列,隔离网络。"""

    calls: list[int] = []


def _record_typing(binding, ilink_user_id, context_token, status, **kwargs) -> None:
    TypingRecorder.calls.append(status)


@pytest.fixture(autouse=True)
def _fake_agent_loop(monkeypatch):
    RecordingAgentLoop.calls = []
    RecordingAgentLoop.error = None
    TypingRecorder.calls = []
    monkeypatch.setattr(agent_loop_module, "AgentLoop", RecordingAgentLoop)
    monkeypatch.setattr(intake_module, "_send_wechat_typing", _record_typing)
    yield


def test_inbound_runs_turn_and_marks_done() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_1"), db_engine=engine) is True
    assert len(RecordingAgentLoop.calls) == 1
    request = RecordingAgentLoop.calls[0]
    assert request.channel == "wechat"
    assert request.client_turn_id == "evt_1"
    assert request.agent_id == "agent_1"

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "done"

        chat_session = db.get(ChatSession, request.session_id)
        assert chat_session.channel == "wechat"
        assert chat_session.external_conv_id == "wechat_p2p_user_ab12cd34@im.wechat"
        assert chat_session.channel_target_json == {
            "to_user_id": "user_ab12cd34@im.wechat",
            "context_token": "ctx_evt_1",
        }
        # 渠道用户已开通并映射
        user = db.get(User, chat_session.user_id)
        assert user.username.startswith("wechat_user_ab12cd34")


def test_event_id_replay_is_idempotent() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_dup"), db_engine=engine) is True
    # 重放同一 event:唯一冲突直接返回,不再跑对话
    assert process_inbound(binding, _p2p_message("evt_dup"), db_engine=engine) is False
    assert len(RecordingAgentLoop.calls) == 1

    with Session(engine) as db:
        events = db.exec(select(ChannelInboundEvent)).all()
        assert len(events) == 1
        assert events[0].status == "done"


def test_channel_ingress_and_replay_reuse_one_language_snapshot() -> None:
    """Snapshot channel defaults once and keep replay plus external content byte-for-byte stable."""
    engine = _test_engine()
    binding_id = _seed_binding(
        engine,
        config_json={
            "ilink_bot_id": "bot_1@im.bot",
            "ui_locale": "en-US",
            "agent_reply_locale": "zh-CN",
        },
    )
    binding = _load_binding(engine, binding_id)
    payload = _p2p_message("evt_language_replay", "原始渠道内容《不要翻译》")

    assert process_inbound(binding, payload, db_engine=engine) is True
    assert len(RecordingAgentLoop.calls) == 1
    request = RecordingAgentLoop.calls[0]
    assert request.message == "原始渠道内容《不要翻译》"
    assert request.language_context is not None
    assert request.language_context.model_dump(mode="json") == _channel_language_snapshot()
    assert request.ui_locale == "en-US"
    assert request.agent_reply_locale == "zh-CN"

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.language_context_json == _channel_language_snapshot()
        chat_session = db.get(ChatSession, request.session_id)
        assert chat_session is not None
        assert chat_session.agent_reply_locale == "zh-CN"
        assert chat_session.agent_reply_locale_source == "channel_default"
        stored_binding = db.get(ChannelBinding, binding_id)
        assert stored_binding is not None
        stored_binding.config_json = {
            **stored_binding.config_json,
            "ui_locale": "zh-CN",
            "agent_reply_locale": "en-US",
        }
        db.add(stored_binding)
        db.commit()

    changed_binding = _load_binding(engine, binding_id)
    assert process_inbound(changed_binding, payload, db_engine=engine) is False
    assert len(RecordingAgentLoop.calls) == 1
    with Session(engine) as db:
        replayed = db.exec(select(ChannelInboundEvent)).one()
        assert replayed.language_context_json == _channel_language_snapshot()
        assert replayed.payload_json["item_list"][0]["text_item"]["text"] == (
            "原始渠道内容《不要翻译》"
        )


def test_channel_ingress_without_locale_uses_controlled_legacy_snapshot() -> None:
    """Resolve a versioned compatibility snapshot when an old binding has no locale settings."""
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    assert (
        process_inbound(
            binding,
            _p2p_message("evt_language_default", "原始旧渠道内容"),
            db_engine=engine,
        )
        is True
    )

    request = RecordingAgentLoop.calls[0]
    assert request.language_context is not None
    assert request.language_context.model_dump(mode="json") == _legacy_language_snapshot()
    assert request.message == "原始旧渠道内容"
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.language_context_json == _legacy_language_snapshot()


def test_recovered_channel_event_executes_with_its_persisted_language_snapshot() -> None:
    """Ignore changed binding defaults when resuming an already-snapshotted inbound event."""
    engine = _test_engine()
    binding_id = _seed_binding(
        engine,
        config_json={
            "ilink_bot_id": "bot_1@im.bot",
            "ui_locale": "zh-CN",
            "agent_reply_locale": "en-US",
        },
    )
    payload = _p2p_message("evt_language_recovery", "恢复的原始外部内容")
    with Session(engine) as db:
        event = ChannelInboundEvent(
            tenant_id="tenant_demo",
            binding_id=binding_id,
            channel="wechat",
            event_id="evt_language_recovery",
            payload_json=payload,
            target_json={
                "to_user_id": "user_ab12cd34@im.wechat",
                "context_token": "ctx_evt_language_recovery",
            },
            status="processing",
            processor_run_id=intake_module.current_processor_run_id(),
            language_context_json=_channel_language_snapshot(),
        )
        db.add(event)
        db.commit()
        event_id = event.id

    binding = _load_binding(engine, binding_id)
    assert (
        process_inbound(
            binding,
            payload,
            db_engine=engine,
            staged_event_pk=event_id,
        )
        is True
    )

    assert len(RecordingAgentLoop.calls) == 1
    request = RecordingAgentLoop.calls[0]
    assert request.language_context is not None
    assert request.language_context.model_dump(mode="json") == _channel_language_snapshot()
    assert request.message == "恢复的原始外部内容"
    with Session(engine) as db:
        recovered = db.get(ChannelInboundEvent, event_id)
        assert recovered is not None
        assert recovered.status == "done"
        assert recovered.language_context_json == _channel_language_snapshot()


def test_crash_recovery_dedup_marks_done_without_rerun() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)

    # 模拟崩溃现场:event 行丢失,但用户消息已带 client_turn_id 落库
    with Session(engine) as db:
        db.add(
            ChatSession(
                id="session_chan",
                tenant_id="tenant_demo",
                user_id="user_x",
                agent_id="agent_1",
                channel="wechat",
                external_conv_id="wechat_p2p_user_ab12cd34@im.wechat",
                channel_binding_id=binding_id,
            )
        )
        db.add(
            Message(
                id="msg_prev",
                tenant_id="tenant_demo",
                session_id="session_chan",
                role="user",
                content="你好",
                metadata_json={"client_turn_id": "evt_crash"},
            )
        )
        db.commit()

    binding = _load_binding(engine, binding_id)
    assert process_inbound(binding, _p2p_message("evt_crash"), db_engine=engine) is False
    assert RecordingAgentLoop.calls == []

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "done"


def test_sweep_finds_turn_in_migration_isolated_session() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    original_conv = "wechat_p2p_user_ab12cd34@im.wechat"
    with Session(engine) as db:
        db.add(
            ChatSession(
                id="session_isolated",
                tenant_id="tenant_demo",
                user_id="old_shared_user",
                agent_id="agent_1",
                channel="wechat",
                external_conv_id=(f"legacy_ambiguous_identity:session_isolated:{original_conv}"),
                channel_binding_id=binding_id,
            )
        )
        db.add(
            Message(
                id="msg_isolated_turn",
                tenant_id="tenant_demo",
                session_id="session_isolated",
                role="user",
                content="已落库",
                metadata_json={"client_turn_id": "evt_isolated"},
            )
        )
        db.commit()
    _seed_stale_event(
        engine,
        binding_id,
        "evt_isolated",
        status="processing",
        age_seconds=300,
        payload=_p2p_message("evt_isolated"),
        processor_run_id="old_process",
    )

    assert intake_module.sweep_stale_inbound_events(db_engine=engine) == 0
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        event = db.exec(
            select(ChannelInboundEvent).where(ChannelInboundEvent.event_id == "evt_isolated")
        ).one()
        assert event.status == "failed"
        assert event.error == "process_exit_incomplete_turn"


def test_group_message_uses_group_account_and_sender_prefix() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _group_message("evt_g1"), db_engine=engine) is True
    assert len(RecordingAgentLoop.calls) == 1
    request = RecordingAgentLoop.calls[0]
    assert request.message.startswith("[发送者: 微信用户 ")
    assert "群里问一句" in request.message

    with Session(engine) as db:
        chat_session = db.get(ChatSession, request.session_id)
        assert chat_session.external_conv_id == "wechat_group_room_123456"
        # 群消息回复投递到群会话而不是发言人
        assert chat_session.channel_target_json["to_user_id"] == "room_123456"
        group_user = db.get(User, chat_session.user_id)
        assert group_user.username == channel_username(
            "tenant_demo", "wechat", "group:room_123456", ""
        )


def test_failure_marks_event_failed_and_stages_error_notice() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)
    RecordingAgentLoop.error = RuntimeError("模型配置缺失")

    assert process_inbound(binding, _p2p_message("evt_err"), db_engine=engine) is False

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "failed"
        assert "模型配置缺失" in (event.error or "")

        notices = db.exec(
            select(ChannelDelivery).where(ChannelDelivery.kind == "error_notice")
        ).all()
        assert len(notices) == 1
        assert notices[0].status == "pending"
        assert notices[0].text == "处理出错，请稍后再试。"
        assert notices[0].target_json["to_user_id"] == "user_ab12cd34@im.wechat"


def test_harness_conflict_keeps_inbound_retryable_and_stages_terminal_notice(monkeypatch) -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    class ConflictAgentLoop:
        def __init__(self, db, *, event_sink=None):
            self.db = db

        def handle_turn(self, request):  # noqa: ANN001
            return SimpleNamespace(
                runtime_error_code="HARNESS_SESSION_BUSY",
                reply="当前会话仍有任务执行，请稍后重试。",
            )

    monkeypatch.setattr(agent_loop_module, "AgentLoop", ConflictAgentLoop)

    assert process_inbound(binding, _p2p_message("evt_conflict"), db_engine=engine) is False

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "received"
        assert event.processor_run_id is None
        notices = db.exec(select(ChannelDelivery).where(ChannelDelivery.kind == "notice")).all()
        assert len(notices) == 1
        assert notices[0].target_json["reaction_final"] is True
        assert notices[0].idempotency_key.endswith(":evt_conflict")


def test_legacy_dict_harness_conflict_is_also_retryable(monkeypatch) -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    class ConflictAgentLoop:
        def __init__(self, db, *, event_sink=None):
            self.db = db

        def handle_turn(self, request):  # noqa: ANN001
            return {"reply": "HARNESS_TURN_CONFLICT"}

    monkeypatch.setattr(agent_loop_module, "AgentLoop", ConflictAgentLoop)

    assert process_inbound(binding, _p2p_message("evt_legacy_conflict"), db_engine=engine) is False

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "received"
        assert event.processor_run_id is None
        notice = db.exec(select(ChannelDelivery).where(ChannelDelivery.kind == "notice")).one()
        assert notice.text == "HARNESS_TURN_CONFLICT"
        assert notice.target_json["reaction_final"] is True


def test_non_text_message_is_dropped_silently() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    image_msg = _p2p_message("evt_img")
    image_msg["item_list"] = [{"type": 2, "image_item": {"url": "https://x"}}]
    assert process_inbound(binding, image_msg, db_engine=engine) is False
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        assert db.exec(select(ChannelInboundEvent)).all() == []


def test_session_serial_lock_shared_per_session() -> None:
    assert _session_lock("s1") is _session_lock("s1")
    assert _session_lock("s1") is not _session_lock("s2")


def test_concurrent_inbound_same_conversation_is_serialized(tmp_path) -> None:
    # 文件库 + busy timeout,避免内存库单连接下的并发事务冲突
    engine = create_engine(
        f"sqlite:///{tmp_path / 'intake.db'}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    SQLModel.metadata.create_all(engine)
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    # 先串行跑一条,确保会话已锚定(并发锚定由唯一索引兜底,测试库无索引)
    assert process_inbound(binding, _p2p_message("evt_warm"), db_engine=engine) is True

    active = {"count": 0, "max": 0}
    guard = threading.Lock()

    class SlowLoop(RecordingAgentLoop):
        def handle_turn(self, request):
            with guard:
                active["count"] += 1
                active["max"] = max(active["max"], active["count"])
            time.sleep(0.05)
            with guard:
                active["count"] -= 1
            super().handle_turn(request)

    RecordingAgentLoop.calls = []
    original = agent_loop_module.AgentLoop
    agent_loop_module.AgentLoop = SlowLoop
    threads = [
        threading.Thread(
            target=process_inbound,
            args=(binding, _p2p_message(f"evt_c{index}")),
            kwargs={"db_engine": engine},
        )
        for index in range(4)
    ]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
    finally:
        agent_loop_module.AgentLoop = original

    assert len(RecordingAgentLoop.calls) == 4
    assert active["max"] == 1


def test_typing_wraps_handle_turn_success() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_t1"), db_engine=engine) is True
    assert TypingRecorder.calls == [1, 2]


def test_typing_cancelled_on_turn_failure() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)
    RecordingAgentLoop.error = RuntimeError("模型配置缺失")

    assert process_inbound(binding, _p2p_message("evt_t2"), db_engine=engine) is False
    assert TypingRecorder.calls == [1, 2]


class FakeTypingClient:
    def __init__(
        self,
        *,
        ticket: str = "ticket_1",
        get_config_error: Exception | None = None,
        send_error: Exception | None = None,
    ):
        self.ticket = ticket
        self.get_config_error = get_config_error
        self.send_error = send_error
        self.get_config_calls: list[tuple[str, str]] = []
        self.send_calls: list[tuple[str, str, int]] = []

    def get_config(self, ilink_user_id: str, context_token: str = "") -> dict:
        self.get_config_calls.append((ilink_user_id, context_token))
        if self.get_config_error:
            raise self.get_config_error
        return {"typing_ticket": self.ticket}

    def send_typing(self, ilink_user_id: str, typing_ticket: str, status: int = 1) -> None:
        self.send_calls.append((ilink_user_id, typing_ticket, status))
        if self.send_error:
            raise self.send_error


def test_typing_fetches_and_caches_ticket() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)
    client = FakeTypingClient()

    _real_send_wechat_typing(
        binding,
        "user_ab12cd34@im.wechat",
        "ctx_1",
        1,
        db_engine=engine,
        client_factory=lambda row: client,
    )

    assert client.get_config_calls == [("user_ab12cd34@im.wechat", "ctx_1")]
    assert client.send_calls == [("user_ab12cd34@im.wechat", "ticket_1", 1)]
    with Session(engine) as db:
        row = db.get(ChannelBinding, binding_id)
        assert row.config_json["typing_ticket"] == "ticket_1"


def test_typing_reuses_cached_ticket_without_get_config() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine, config_json={"typing_ticket": "cached_ticket"})
    binding = _load_binding(engine, binding_id)
    client = FakeTypingClient()

    _real_send_wechat_typing(
        binding,
        "user_1",
        "ctx_1",
        1,
        db_engine=engine,
        client_factory=lambda row: client,
    )

    assert client.get_config_calls == []
    assert client.send_calls == [("user_1", "cached_ticket", 1)]


def test_typing_skips_silently_when_get_config_fails() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)
    client = FakeTypingClient(get_config_error=RuntimeError("网络不通"))

    # 不抛异常、不发送、不写缓存
    _real_send_wechat_typing(
        binding,
        "user_1",
        "ctx_1",
        1,
        db_engine=engine,
        client_factory=lambda row: client,
    )

    assert client.send_calls == []
    with Session(engine) as db:
        row = db.get(ChannelBinding, binding_id)
        assert "typing_ticket" not in (row.config_json or {})


def test_typing_send_failure_clears_cached_ticket() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine, config_json={"typing_ticket": "stale_ticket"})
    binding = _load_binding(engine, binding_id)
    client = FakeTypingClient(send_error=RuntimeError("ticket 失效"))

    _real_send_wechat_typing(
        binding,
        "user_1",
        "ctx_1",
        1,
        db_engine=engine,
        client_factory=lambda row: client,
    )

    assert client.send_calls == [("user_1", "stale_ticket", 1)]
    with Session(engine) as db:
        row = db.get(ChannelBinding, binding_id)
        assert "typing_ticket" not in (row.config_json or {})


def test_typing_cancel_without_ticket_is_noop() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)
    client = FakeTypingClient()

    _real_send_wechat_typing(
        binding,
        "user_1",
        "ctx_1",
        2,
        db_engine=engine,
        client_factory=lambda row: client,
    )

    # cancel 不触发 get_config,无 ticket 直接跳过
    assert client.get_config_calls == []
    assert client.send_calls == []


def test_typing_noop_for_inactive_binding() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine, status="expired")
    binding = _load_binding(engine, binding_id)
    client = FakeTypingClient()

    _real_send_wechat_typing(
        binding,
        "user_1",
        "ctx_1",
        1,
        db_engine=engine,
        client_factory=lambda row: client,
    )

    assert client.get_config_calls == []
    assert client.send_calls == []


# ---------- 陈旧 processing 事件接管与启动 sweep ----------


def _seed_stale_event(
    engine,
    binding_id: str,
    event_id: str,
    *,
    status: str,
    age_seconds: float,
    payload: dict | None = None,
    processor_run_id: str | None = None,
    lease_seconds: float | None = None,
) -> None:
    from datetime import timedelta

    with Session(engine) as db:
        db.add(
            ChannelInboundEvent(
                tenant_id="tenant_demo",
                binding_id=binding_id,
                channel="wechat",
                event_id=event_id,
                payload_json=payload or {},
                status=status,
                processor_run_id=processor_run_id,
                processor_lease_expires_at=(
                    utc_now() + timedelta(seconds=lease_seconds)
                    if lease_seconds is not None
                    else None
                ),
                updated_at=utc_now() - timedelta(seconds=age_seconds),
            )
        )
        db.commit()


def test_stale_processing_event_is_taken_over() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_stale_event(engine, binding_id, "evt_stale", status="processing", age_seconds=300)
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_stale"), db_engine=engine) is True
    assert len(RecordingAgentLoop.calls) == 1
    with Session(engine) as db:
        events = db.exec(select(ChannelInboundEvent)).all()
        assert len(events) == 1
        assert events[0].status == "done"


def test_fresh_processing_event_is_not_killed() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_stale_event(
        engine,
        binding_id,
        "evt_fresh",
        status="processing",
        age_seconds=5,
        processor_run_id=intake_module.current_processor_run_id(),
    )
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_fresh"), db_engine=engine) is False
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "processing"


def test_current_run_processing_event_is_never_taken_over_by_age() -> None:
    from app.channels.service_intake import sweep_stale_inbound_events

    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_stale_event(
        engine,
        binding_id,
        "evt_long_turn",
        status="processing",
        age_seconds=900,
        payload=_p2p_message("evt_long_turn"),
        processor_run_id=intake_module.current_processor_run_id(),
    )
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_long_turn"), db_engine=engine) is False
    assert sweep_stale_inbound_events(db_engine=engine) == 0
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "processing"
        assert event.processor_run_id == intake_module.current_processor_run_id()


def test_other_process_active_lease_is_not_taken_over() -> None:
    from app.channels.service_intake import sweep_stale_inbound_events

    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_stale_event(
        engine,
        binding_id,
        "evt_active_lease",
        status="processing",
        age_seconds=900,
        payload=_p2p_message("evt_active_lease"),
        processor_run_id="other_live_process",
        lease_seconds=600,
    )

    assert sweep_stale_inbound_events(db_engine=engine) == 0
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "processing"
        assert event.processor_run_id == "other_live_process"


def test_other_process_expired_lease_is_taken_over() -> None:
    from app.channels.service_intake import sweep_stale_inbound_events

    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_stale_event(
        engine,
        binding_id,
        "evt_expired_lease",
        status="processing",
        age_seconds=900,
        payload=_p2p_message("evt_expired_lease"),
        processor_run_id="dead_process",
        lease_seconds=-1,
    )

    assert sweep_stale_inbound_events(db_engine=engine) == 1
    assert len(RecordingAgentLoop.calls) == 1
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "done"


def test_stale_claim_is_released_when_recovery_logic_raises(monkeypatch) -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_stale_event(
        engine,
        binding_id,
        "evt_recovery_error",
        status="processing",
        age_seconds=300,
        payload=_p2p_message("evt_recovery_error"),
        processor_run_id="old_process",
    )
    binding = _load_binding(engine, binding_id)

    monkeypatch.setattr(
        intake_module,
        "_find_turn_user_message_in_conv",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        intake_module,
        "resolve_or_provision_user",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("recovery db failure")),
    )
    with pytest.raises(RuntimeError, match="recovery db failure"):
        process_inbound(binding, _p2p_message("evt_recovery_error"), db_engine=engine)

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "processing"
        assert event.processor_run_id is None


@pytest.mark.skipif(not hasattr(os, "fork"), reason="requires fork")
def test_processor_run_id_changes_after_prefork() -> None:
    parent_run_id = intake_module.current_processor_run_id()
    read_fd, write_fd = os.pipe()
    child_pid = os.fork()
    if child_pid == 0:
        try:
            os.close(read_fd)
            child_run_id = intake_module.current_processor_run_id().encode()
            os.write(write_fd, child_run_id)
        finally:
            os.close(write_fd)
            os._exit(0)
    os.close(write_fd)
    child_run_id = os.read(read_fd, 128).decode()
    os.close(read_fd)
    _, status = os.waitpid(child_pid, 0)

    assert os.waitstatus_to_exitcode(status) == 0
    assert child_run_id
    assert child_run_id != parent_run_id


def test_concurrent_sweeps_claim_old_event_once(tmp_path) -> None:
    from app.channels.service_intake import sweep_stale_inbound_events

    db_path = tmp_path / "sweep.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    SQLModel.metadata.create_all(engine)
    binding_id = _seed_binding(engine)
    _seed_stale_event(
        engine,
        binding_id,
        "evt_sweep_race",
        status="processing",
        age_seconds=300,
        payload=_p2p_message("evt_sweep_race"),
        processor_run_id="old_process",
    )
    gate = threading.Barrier(2)
    results: list[int] = []
    errors: list[Exception] = []

    def sweep() -> None:
        try:
            gate.wait(timeout=5.0)
            results.append(sweep_stale_inbound_events(db_engine=engine))
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=sweep) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10.0)

    assert errors == []
    assert all(not thread.is_alive() for thread in threads)
    assert sum(results) == 1
    assert len(RecordingAgentLoop.calls) == 1
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "done"
        assert event.processor_run_id is None


def test_done_event_is_never_taken_over() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_stale_event(engine, binding_id, "evt_done", status="done", age_seconds=300)
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_done"), db_engine=engine) is False
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        assert db.exec(select(ChannelInboundEvent)).one().status == "done"


def test_startup_sweep_takes_over_stale_events() -> None:
    from app.channels.service_intake import sweep_stale_inbound_events

    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_stale_event(
        engine,
        binding_id,
        "evt_sweep",
        status="processing",
        age_seconds=300,
        payload=_p2p_message("evt_sweep"),
    )
    # 新鲜的与 done 的不应被接管
    _seed_stale_event(
        engine,
        binding_id,
        "evt_fresh",
        status="processing",
        age_seconds=5,
        processor_run_id=intake_module.current_processor_run_id(),
    )
    _seed_stale_event(engine, binding_id, "evt_done", status="done", age_seconds=300)

    taken = sweep_stale_inbound_events(db_engine=engine)
    assert taken == 1
    assert len(RecordingAgentLoop.calls) == 1
    with Session(engine) as db:
        by_event = {row.event_id: row.status for row in db.exec(select(ChannelInboundEvent)).all()}
        assert by_event == {"evt_sweep": "done", "evt_fresh": "processing", "evt_done": "done"}


# ---------- 崩溃恢复:turn 未完成窗口 ----------


def _seed_incomplete_turn(
    engine,
    binding_id: str,
    event_id: str,
    *,
    with_reply: bool,
    language_context_json: dict[str, object] | None = None,
) -> None:
    """Seed a recoverable durable turn with an optional immutable locale snapshot."""
    from datetime import timedelta

    with Session(engine) as db:
        db.add(
            ChatSession(
                id="session_incomplete",
                tenant_id="tenant_demo",
                user_id="user_x",
                agent_id="agent_1",
                channel="wechat",
                external_conv_id="wechat_p2p_user_ab12cd34@im.wechat",
                channel_binding_id=binding_id,
            )
        )
        db.add(
            Message(
                id="msg_turn_user",
                tenant_id="tenant_demo",
                session_id="session_incomplete",
                role="user",
                content="你好",
                metadata_json={"client_turn_id": event_id},
            )
        )
        if with_reply:
            db.add(
                Message(
                    id="msg_turn_reply",
                    tenant_id="tenant_demo",
                    session_id="session_incomplete",
                    role="assistant",
                    content="回复",
                    metadata_json={"turn_id": "msg_turn_user", "user_message_id": "msg_turn_user"},
                )
            )
        db.add(
            ChannelInboundEvent(
                tenant_id="tenant_demo",
                binding_id=binding_id,
                channel="wechat",
                event_id=event_id,
                payload_json={},
                status="processing",
                language_context_json=language_context_json,
                updated_at=utc_now() - timedelta(seconds=300),
            )
        )
        db.commit()


def test_incomplete_turn_marks_failed_and_notices_without_rerun() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_incomplete_turn(engine, binding_id, "evt_gap", with_reply=False)
    binding = _load_binding(engine, binding_id)

    # 不重跑:标记 failed + 中断通知投递
    assert process_inbound(binding, _p2p_message("evt_gap"), db_engine=engine) is False
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "failed"
        assert event.error == "process_exit_incomplete_turn"
        notices = db.exec(
            select(ChannelDelivery).where(ChannelDelivery.kind == "error_notice")
        ).all()
        assert len(notices) == 1
        assert notices[0].text == "上一条消息处理中断，请重新发送。"
        assert notices[0].session_id == "session_incomplete"


def test_repeated_incomplete_turn_recovery_stages_one_notice() -> None:
    from datetime import timedelta

    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_incomplete_turn(engine, binding_id, "evt_gap_repeat", with_reply=False)
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_gap_repeat"), db_engine=engine) is False
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        event.status = "processing"
        event.updated_at = utc_now() - timedelta(seconds=300)
        db.add(event)
        db.commit()

    assert process_inbound(binding, _p2p_message("evt_gap_repeat"), db_engine=engine) is False
    with Session(engine) as db:
        notices = db.exec(
            select(ChannelDelivery).where(ChannelDelivery.kind == "error_notice")
        ).all()
        assert len(notices) == 1
        assert notices[0].idempotency_key == f"channel-interrupted:{binding_id}:evt_gap_repeat"


def test_error_notice_uses_persisted_reply_locale_without_exposing_raw_exception() -> None:
    """Render a safe English error notice while retaining the raw cause only on the inbound row."""
    engine = _test_engine()
    snapshot = {
        "version": 1,
        "ui_locale": "zh-CN",
        "agent_reply_locale": "en-US",
        "ui_locale_source": "channel_default",
        "agent_reply_locale_source": "channel_default",
    }
    binding_id = _seed_binding(
        engine,
        config_json={
            "ilink_bot_id": "bot_1@im.bot",
            "ui_locale": "zh-CN",
            "agent_reply_locale": "en-US",
        },
    )
    binding = _load_binding(engine, binding_id)
    RecordingAgentLoop.error = RuntimeError("provider secret SKU-A/42")

    assert process_inbound(binding, _p2p_message("evt_error_en"), db_engine=engine) is False

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        delivery = db.exec(select(ChannelDelivery)).one()
        assert "provider secret SKU-A/42" in (event.error or "")
        assert delivery.text == "Something went wrong. Please try again later."
        assert "provider secret" not in delivery.text
        assert delivery.language_context_json == snapshot


def test_interrupted_recovery_reuses_event_reply_locale() -> None:
    """Recover an interrupted turn using its durable locale instead of changed binding defaults."""
    engine = _test_engine()
    snapshot = {
        "version": 1,
        "ui_locale": "zh-CN",
        "agent_reply_locale": "en-US",
        "ui_locale_source": "explicit_request",
        "agent_reply_locale_source": "explicit_request",
    }
    binding_id = _seed_binding(engine)
    _seed_incomplete_turn(
        engine,
        binding_id,
        "evt_gap_en",
        with_reply=False,
        language_context_json=snapshot,
    )
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_gap_en"), db_engine=engine) is False

    with Session(engine) as db:
        delivery = db.exec(select(ChannelDelivery)).one()
        assert delivery.text == "The previous message was interrupted. Please send it again."
        assert delivery.language_context_json == snapshot


def test_completed_turn_is_not_misflagged() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_incomplete_turn(engine, binding_id, "evt_done_turn", with_reply=True)
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_done_turn"), db_engine=engine) is False
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        # 已有完成回复:收敛为 done,不标 failed、不发通知
        assert event.status == "done"
        assert event.processed_at is not None
        assert db.exec(select(ChannelDelivery)).all() == []


def test_sweep_marks_incomplete_turn_failed_consistently() -> None:
    from app.channels.service_intake import sweep_stale_inbound_events

    engine = _test_engine()
    binding_id = _seed_binding(engine)
    _seed_incomplete_turn(engine, binding_id, "evt_gap_sweep", with_reply=False)
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        event.payload_json = _p2p_message("evt_gap_sweep")
        db.add(event)
        db.commit()

    taken = sweep_stale_inbound_events(db_engine=engine)
    # sweep 与运行时接管一致:不重跑,标 failed + 通知
    assert taken == 0
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "failed"
        assert event.error == "process_exit_incomplete_turn"
        assert db.exec(select(ChannelDelivery).where(ChannelDelivery.kind == "error_notice")).all()


def test_concurrent_sweeps_stage_one_incomplete_notice(tmp_path) -> None:
    from app.channels.service_intake import sweep_stale_inbound_events

    db_path = tmp_path / "incomplete-sweep.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    SQLModel.metadata.create_all(engine)
    binding_id = _seed_binding(engine)
    _seed_incomplete_turn(engine, binding_id, "evt_gap_race", with_reply=False)
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        event.payload_json = _p2p_message("evt_gap_race")
        event.processor_run_id = "old_process"
        db.add(event)
        db.commit()
    gate = threading.Barrier(2)
    errors: list[Exception] = []

    def sweep() -> None:
        try:
            gate.wait(timeout=5.0)
            sweep_stale_inbound_events(db_engine=engine)
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=sweep) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10.0)

    assert errors == []
    assert all(not thread.is_alive() for thread in threads)
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "failed"
        notices = db.exec(
            select(ChannelDelivery).where(ChannelDelivery.kind == "error_notice")
        ).all()
        assert len(notices) == 1


def test_inbound_attachment_download_failure_degrades_to_text(monkeypatch) -> None:
    """渠道附件下载异常时不阻塞文本轮,降级为纯文本处理。"""
    import app.channels.attachment_bridge as bridge_module
    from app.channels.adapters.base import ChannelInbound, ChannelInboundAttachment

    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    # 构造一个带附件的 wechat 入站消息(wechat 适配器未实现 download_media,
    # bridge 会返回空列表;这里进一步模拟 inbound_attachments_to_chat 抛异常
    # 来验证 intake 的 try/except 降级路径)
    inbound = ChannelInbound(
        channel="wechat",
        event_id="evt_att_fail",
        from_user_id="user_ab12cd34@im.wechat",
        to_user_id="bot_1@im.bot",
        session_id="user_ab12cd34@im.wechat#bot_1@im.bot",
        group_id="",
        context_token="ctx_att_fail",
        text="看这张图",
        is_group=False,
        raw={},
        attachments=[ChannelInboundAttachment(media_id="img_1", kind="image")],
    )

    # 让 inbound_attachments_to_chat 抛异常,验证 intake 降级
    def _boom(*_args, **_kwargs):
        raise RuntimeError("下载服务不可用")

    monkeypatch.setattr(bridge_module, "inbound_attachments_to_chat", _boom)

    assert process_inbound(binding, inbound, db_engine=engine) is True
    # 仍然执行了对话轮
    assert len(RecordingAgentLoop.calls) == 1
    request = RecordingAgentLoop.calls[0]
    # 降级为纯文本:attachments 为空列表
    assert request.attachments == []
    assert request.message == "看这张图"

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "done"


def test_inbound_with_attachments_passes_them_to_request(monkeypatch) -> None:
    """附件下载成功时,attachments 被填入 ChatTurnRequest。"""
    import app.channels.attachment_bridge as bridge_module
    from app.channels.adapters.base import ChannelInbound, ChannelInboundAttachment
    from app.session.session_schema import ChatAttachmentRead

    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    inbound = ChannelInbound(
        channel="wechat",
        event_id="evt_att_ok",
        from_user_id="user_ab12cd34@im.wechat",
        to_user_id="bot_1@im.bot",
        session_id="user_ab12cd34@im.wechat#bot_1@im.bot",
        group_id="",
        context_token="ctx_att_ok",
        text="",
        is_group=False,
        raw={},
        attachments=[ChannelInboundAttachment(media_id="img_1", kind="image")],
    )

    staged = ChatAttachmentRead(
        id="file_1",
        filename="img.jpg",
        content_type="image/jpeg",
        size=4,
        kind="image",
        sha256="abc",
        sandbox_path="/ws/x",
    )

    def _fake_bridge(*_args, **_kwargs):
        return [staged]

    monkeypatch.setattr(bridge_module, "inbound_attachments_to_chat", _fake_bridge)

    assert process_inbound(binding, inbound, db_engine=engine) is True
    request = RecordingAgentLoop.calls[0]
    assert len(request.attachments) == 1
    assert request.attachments[0].filename == "img.jpg"
    assert request.attachments[0].sha256 == "abc"


# ---------- Phase 6: tenant lifecycle gates at channel ingress ----------


def _stage_wecom_event(engine, event_id: str) -> tuple[str, str]:
    """Stage one provider event for lifecycle tests and return its binding/event primary keys."""
    binding_id = _seed_binding(
        engine,
        channel="wecom",
        config_json={"bot_id": "aib_bot1", "corp_id": "corp-a"},
    )
    result = stage_wecom_inbound(
        db_engine=engine,
        binding_id=binding_id,
        expected_revision=0,
        account_scope="corp-a",
        inbound=_wecom_inbound(event_id),
    )
    assert result.disposition is StageDisposition.STAGED
    assert result.event_pk is not None
    return binding_id, result.event_pk


def test_suspended_provider_callback_is_acknowledged_and_security_dropped() -> None:
    """A suspended tenant must ACK the provider while persisting no executable inbox event."""
    engine = _test_engine()
    binding_id = _seed_binding(
        engine,
        channel="wecom",
        config_json={"bot_id": "aib_bot1", "corp_id": "corp-a"},
    )
    _set_tenant_lifecycle(engine, status="suspended", version=2)

    result = stage_wecom_inbound(
        db_engine=engine,
        binding_id=binding_id,
        expected_revision=0,
        account_scope="corp-a",
        inbound=_wecom_inbound("evt_suspended_callback"),
    )

    assert result.disposition is StageDisposition.SECURITY_DROP
    assert result.should_ack is True
    assert result.error_code == "TENANT_SUSPENDED"
    with Session(engine) as db:
        assert db.exec(select(ChannelInboundEvent)).all() == []
        assert db.exec(select(ChatSession)).all() == []
        assert db.exec(select(Message)).all() == []


def test_suspended_direct_ingress_audit_scrubs_raw_payload_and_context_token() -> None:
    """Lifecycle-denied direct ingress must retain no provider body or reply token."""
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)
    raw = _p2p_message("evt_direct_denied", "private provider message")
    raw["provider_secret"] = "provider-secret-sentinel"
    _set_tenant_lifecycle(engine, status="suspended", version=2)

    assert process_inbound(binding, raw, db_engine=engine) is False

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "security_drop"
        assert "provider-secret-sentinel" not in str(event.payload_json)
        assert "private provider message" not in str(event.payload_json)
        assert "ctx_evt_direct_denied" not in str(event.target_json)
        assert "context_token" not in event.target_json


@pytest.mark.parametrize("channel", ("feishu", "dingtalk"))
def test_suspended_provider_callbacks_are_acknowledged_and_security_dropped(channel: str) -> None:
    """Every provider callback must drop suspended tenant work before durable inbox creation."""
    engine = _test_engine()
    binding_id = _provider_binding(engine, channel)
    _set_tenant_lifecycle(engine, status="suspended", version=2)

    result = _stage_provider_callback(engine, channel, binding_id, f"evt_{channel}_suspended")

    assert result.disposition is StageDisposition.SECURITY_DROP
    assert result.should_ack is True
    assert result.error_code == "TENANT_SUSPENDED"
    with Session(engine) as db:
        assert db.exec(select(ChannelInboundEvent)).all() == []
        assert db.exec(select(ChatSession)).all() == []
        assert db.exec(select(Message)).all() == []


@pytest.mark.parametrize("channel", ("wecom", "feishu", "dingtalk"))
def test_active_provider_admission_persists_tenant_lifecycle_version(channel: str) -> None:
    """A provider event records the exact active lifecycle generation used for admission."""
    engine = _test_engine()
    binding_id = _provider_binding(engine, channel)
    _set_tenant_lifecycle(engine, status="active", version=7)

    result = _stage_provider_callback(engine, channel, binding_id, f"evt_{channel}_versioned")

    assert result.disposition is StageDisposition.STAGED
    assert result.event_pk is not None
    with Session(engine) as db:
        event = db.get(ChannelInboundEvent, result.event_pk)
        assert event is not None
        assert event.tenant_lifecycle_version == 7


@pytest.mark.parametrize("channel", ("wecom", "feishu", "dingtalk"))
def test_provider_staging_rechecks_binding_revision_before_event_insert(
    monkeypatch,
    channel: str,
) -> None:
    """A binding change after admission must reject the callback before durable staging."""
    engine = _test_engine()
    binding_id = _provider_binding(engine, channel)
    original_admit = intake_module.admit_channel_lifecycle

    def mutate_binding_after_admission(db, **kwargs):
        decision = original_admit(db, **kwargs)
        binding = db.get(ChannelBinding, binding_id)
        assert binding is not None
        binding.status = "disabled"
        binding.config_revision = 1
        db.add(binding)
        db.flush()
        return decision

    monkeypatch.setattr(intake_module, "admit_channel_lifecycle", mutate_binding_after_admission)
    result = _stage_provider_callback(engine, channel, binding_id, f"evt_{channel}_stale_binding")

    assert result.disposition is StageDisposition.SECURITY_DROP
    with Session(engine) as db:
        assert db.exec(select(ChannelInboundEvent)).all() == []


def test_suspend_after_inbound_claim_terminalizes_event_before_agent_loop(monkeypatch) -> None:
    """A lifecycle transition after processor claim must stop the turn before any AgentLoop call."""
    engine = _test_engine()
    _binding_id, event_pk = _stage_wecom_event(engine, "evt_claim_suspend")
    original_process = intake_module.process_inbound

    def suspend_before_processing(binding, inbound, **kwargs):
        _set_tenant_lifecycle(engine, status="suspended", version=2)
        return original_process(binding, inbound, **kwargs)

    monkeypatch.setattr(intake_module, "process_inbound", suspend_before_processing)

    assert process_staged_inbound(event_pk, db_engine=engine) is False
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        event = db.get(ChannelInboundEvent, event_pk)
        assert event is not None
        assert event.status == "security_drop"
        assert event.error == "TENANT_SUSPENDED"
        assert db.exec(select(ChatSession)).all() == []
        assert db.exec(select(Message)).all() == []


def test_suspended_handoff_reply_does_not_resume_the_old_turn(monkeypatch) -> None:
    """A channel handoff reply must remain pending and avoid resume work after suspension."""
    from app.channels.service_feishu_inbox import feishu_identity_scope

    engine = _test_engine()
    with Session(engine) as db:
        db.add(
            Tenant(
                id="tenant_demo",
                name="Demo",
                status="suspended",
                lifecycle_version=2,
            )
        )
        binding = ChannelBinding(
            id="binding-feishu-handoff",
            tenant_id="tenant_demo",
            agent_id="agent_1",
            channel="feishu",
            status="active",
            config_json={"app_id": "cli_app_a"},
            external_account_key="feishu:app:10:cli_app_a",
            identity_scope_key=feishu_identity_scope("cli_app_a", "tenant-a"),
            provider_tenant_key="tenant-a",
        )
        session = ChatSession(
            id="session-handoff",
            tenant_id="tenant_demo",
            user_id="requester",
            agent_id="agent_1",
            channel="feishu",
            status="handoff",
            external_conv_id="feishu_p2p_requester",
            channel_binding_id=binding.id,
            channel_account_key=binding.external_account_key,
        )
        handoff = HumanHandoffRequest(
            id="handoff-suspended",
            tenant_id="tenant_demo",
            session_id=session.id,
            agent_id="agent_1",
            requester_user_id="requester",
            assignee_user_id="assignee",
            status="pending",
            pending_question="请确认处理结果",
        )
        notice = ChannelDelivery(
            id="delivery-handoff-notice",
            tenant_id="tenant_demo",
            binding_id=binding.id,
            session_id=f"handoff:{handoff.id}",
            message_id="feishu-notice-1",
            target_json={
                "receive_id_type": "open_id",
                "receive_id": "assignee-open-id",
                "handoff_id": handoff.id,
            },
            kind="handoff_notice",
            text="handoff",
            status="delivered",
            idempotency_key="handoff-notice-1",
        )
        db.add_all(
            [
                binding,
                session,
                handoff,
                notice,
                ChannelIdentity(
                    tenant_id="tenant_demo",
                    channel="feishu",
                    external_account_scope=binding.identity_scope_key,
                    external_user_id="assignee-open-id",
                    firmdeck_user_id="assignee",
                ),
            ]
        )
        db.commit()

    inbound = ChannelInbound(
        channel="feishu",
        event_id="feishu-handoff-reply-1",
        from_user_id="assignee-open-id",
        to_user_id="bot-open-id",
        session_id="assignee-open-id",
        group_id="",
        context_token="",
        text="已处理",
        is_group=False,
        parent_id="feishu-notice-1",
        raw={},
    )
    applied: list[str] = []

    def record_resume(*_args, **_kwargs):
        applied.append("resume")

    import app.api.chat as chat_api

    monkeypatch.setattr(chat_api, "_apply_handoff_reply", record_resume)
    binding = _load_binding(engine, "binding-feishu-handoff")

    assert process_inbound(binding, inbound, db_engine=engine) is False
    assert applied == []
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "security_drop"
        assert event.error == "TENANT_SUSPENDED"
        assert db.get(HumanHandoffRequest, "handoff-suspended").status == "pending"
        assert db.exec(select(ChannelDelivery).where(ChannelDelivery.kind == "handoff_ack")).all() == []


def test_handoff_resume_does_not_replay_after_fast_reactivation(monkeypatch) -> None:
    """A handoff admitted before suspension must not resume its old AgentLoop generation."""
    import app.api.chat as chat_api

    engine = _test_engine()
    binding_id = "binding-feishu-fast-reactivation"
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        binding = ChannelBinding(
            id=binding_id,
            tenant_id="tenant_demo",
            agent_id="agent_1",
            channel="feishu",
            status="active",
            config_json={"app_id": "cli_app_a"},
            external_account_key="feishu:app:10:cli_app_a",
            identity_scope_key=feishu_identity_scope("cli_app_a", "tenant-a"),
            provider_tenant_key="tenant-a",
        )
        session = ChatSession(
            id="session-fast-reactivation",
            tenant_id="tenant_demo",
            user_id="requester",
            agent_id="agent_1",
            channel="feishu",
            status="handoff",
            external_conv_id="feishu_p2p_requester",
            channel_binding_id=binding.id,
            channel_account_key=binding.external_account_key,
        )
        handoff = HumanHandoffRequest(
            id="handoff-fast-reactivation",
            tenant_id="tenant_demo",
            session_id=session.id,
            agent_id="agent_1",
            requester_user_id="requester",
            assignee_user_id="assignee",
            status="pending",
            pending_question="请确认处理结果",
        )
        notice = ChannelDelivery(
            id="delivery-fast-reactivation",
            tenant_id="tenant_demo",
            binding_id=binding.id,
            session_id=f"handoff:{handoff.id}",
            message_id="feishu-notice-fast-reactivation",
            target_json={
                "receive_id_type": "open_id",
                "receive_id": "assignee-open-id",
                "handoff_id": handoff.id,
            },
            kind="handoff_notice",
            text="handoff",
            status="delivered",
            idempotency_key="handoff-notice-fast-reactivation",
        )
        db.add_all(
            [
                binding,
                session,
                handoff,
                notice,
                ChannelIdentity(
                    tenant_id="tenant_demo",
                    channel="feishu",
                    external_account_scope=binding.identity_scope_key,
                    external_user_id="assignee-open-id",
                    firmdeck_user_id="assignee",
                ),
            ]
        )
        db.commit()

    pending_resume_ids: list[str] = []
    monkeypatch.setattr(chat_api, "engine", engine)
    monkeypatch.setattr(
        chat_api,
        "_resume_human_handoff_async",
        lambda handoff_id: pending_resume_ids.append(handoff_id),
    )
    monkeypatch.setattr(chat_api, "AgentLoop", RecordingAgentLoop)

    inbound = ChannelInbound(
        channel="feishu",
        event_id="feishu-handoff-fast-reactivation",
        from_user_id="assignee-open-id",
        to_user_id="bot-open-id",
        session_id="assignee-open-id",
        group_id="",
        context_token="",
        text="已处理",
        is_group=False,
        parent_id="feishu-notice-fast-reactivation",
        raw={},
    )
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, inbound, db_engine=engine) is False
    assert pending_resume_ids == ["handoff-fast-reactivation"]
    assert RecordingAgentLoop.calls == []

    _set_tenant_lifecycle(engine, status="suspended", version=2)
    _set_tenant_lifecycle(engine, status="active", version=3)
    chat_api._resume_human_handoff_worker(pending_resume_ids[0])

    assert RecordingAgentLoop.calls == []


def test_stale_inbound_completion_cannot_mark_done_after_lifecycle_transition() -> None:
    """A claimed inbound row must reject stale success after tenant version changes."""
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    with Session(engine) as db:
        event = ChannelInboundEvent(
            tenant_id="tenant_demo",
            tenant_lifecycle_version=1,
            binding_id=binding_id,
            channel="wechat",
            event_id="evt_stale_completion",
            payload_json={},
            target_json={},
            status="processing",
            processor_run_id=intake_module.current_processor_run_id(),
        )
        db.add(event)
        db.commit()
        event_id = event.id

    _set_tenant_lifecycle(engine, status="suspended", version=2)
    with Session(engine) as db:
        assert (
            intake_module._finish_owned_inbound(
                db,
                event_id,
                status="done",
                processed=True,
            )
            is False
        )

    with Session(engine) as db:
        event = db.get(ChannelInboundEvent, event_id)
        assert event is not None
        assert event.status != "done"


def test_inbound_side_effects_recheck_lifecycle_before_typing_cleanup(monkeypatch) -> None:
    """Typing cleanup must not call the provider after the turn crosses suspension."""
    engine = _test_engine()
    binding_id = _seed_binding(engine)
    binding = _load_binding(engine, binding_id)

    class SuspendingAgentLoop(RecordingAgentLoop):
        """Finish the local fake turn, then suspend before intake cleanup side effects."""

        def handle_turn(self, request):
            response = super().handle_turn(request)
            _set_tenant_lifecycle(engine, status="suspended", version=2)
            return response

    monkeypatch.setattr(agent_loop_module, "AgentLoop", SuspendingAgentLoop)

    assert process_inbound(binding, _p2p_message("evt_typing_after_suspend"), db_engine=engine) is False
    assert TypingRecorder.calls == [1]

    with Session(engine) as db:
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "security_drop"


def test_stale_inbound_recovery_does_not_replay_after_fast_reactivation() -> None:
    """Recovery must terminalize old ingress at its admission version across suspend/reactivate."""
    engine = _test_engine()
    _binding_id, event_pk = _stage_wecom_event(engine, "evt_fast_reactivation")
    assert claim_staged_inbound(event_pk, db_engine=engine) is True
    with Session(engine) as db:
        event = db.get(ChannelInboundEvent, event_pk)
        assert event is not None
        event.processor_run_id = "dead-processor"
        event.processor_lease_expires_at = utc_now() - timedelta(seconds=1)
        db.add(event)
        db.commit()

    _set_tenant_lifecycle(engine, status="suspended", version=2)
    _set_tenant_lifecycle(engine, status="active", version=3)

    assert sweep_stale_inbound_events(db_engine=engine) == 0
    assert RecordingAgentLoop.calls == []
    with Session(engine) as db:
        event = db.get(ChannelInboundEvent, event_pk)
        assert event is not None
        assert event.status == "security_drop"
        assert event.error == "TENANT_SUSPENDED"
        assert db.exec(select(ChatSession)).all() == []
        assert db.exec(select(Message)).all() == []
