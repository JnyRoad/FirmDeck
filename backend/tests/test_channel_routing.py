import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from typing import ClassVar

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.channels.service_intake as intake_module
import app.core.agent_loop as agent_loop_module
from app.channels.service_intake import process_inbound
from app.channels.service_outbox import stage_channel_delivery
from app.channels.service_routing import (
    HELP_TEXT,
    agent_names,
    help_text,
    mounted_agents,
    parse_command,
    resolve_current_agent,
    run_command,
)
from app.db.models import (
    AgentProfile,
    ChannelBinding,
    ChannelBindingAgent,
    ChannelConvState,
    ChannelDelivery,
    ChannelInboundEvent,
    ChatSession,
    Message,
    Tenant,
    User,
    WeChatKfAccountOperation,
    new_id,
)
from app.i18n.language_context import LanguageContext, LocaleResolutionSource


def _test_engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed_binding(engine, *, mounts: list[tuple[str, str, bool]] | None = None) -> str:
    """创建绑定与两个员工;mounts=(agent_id, name, is_default),None 表示存量绑定(无挂载行)。"""
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo", status="active", lifecycle_version=1))
        db.add(AgentProfile(id="agent_xz", tenant_id="tenant_demo", name="行政", metadata_json={}))
        db.add(AgentProfile(id="agent_cw", tenant_id="tenant_demo", name="财务", metadata_json={}))
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_xz",
            channel="wechat",
            status="active",
            config_json={"ilink_bot_id": "bot_1@im.bot"},
        )
        db.add(binding)
        db.flush()
        for index, (agent_id, _name, is_default) in enumerate(mounts or []):
            db.add(
                ChannelBindingAgent(
                    tenant_id="tenant_demo",
                    binding_id=binding.id,
                    agent_id=agent_id,
                    is_default=is_default,
                    sort_order=index,
                )
            )
        db.commit()
        return binding.id


def _load_binding(engine, binding_id: str) -> ChannelBinding:
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        db.expunge(binding)
        return binding


def _p2p_message(event_id: str, text: str) -> dict:
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


def _group_message(event_id: str, text: str, group_id: str = "room_123456") -> dict:
    msg = _p2p_message(event_id, text)
    msg["group_id"] = group_id
    msg["session_id"] = group_id
    return msg


class RecordingAgentLoop:
    calls: ClassVar[list] = []

    def __init__(self, db, *, event_sink=None):
        self.db = db

    def handle_turn(self, request):
        type(self).calls.append(request)
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
                content=f"{request.agent_id} 的回复",
                metadata_json={},
            )
        )
        self.db.commit()


@pytest.fixture(autouse=True)
def _fake_agent_loop(monkeypatch):
    RecordingAgentLoop.calls = []
    monkeypatch.setattr(agent_loop_module, "AgentLoop", RecordingAgentLoop)
    monkeypatch.setattr(intake_module, "_send_wechat_typing", lambda *args, **kwargs: None)
    yield


# ---------- 指令解析 ----------


def test_parse_command_non_command() -> None:
    assert parse_command("你好") is None
    assert parse_command("") is None
    assert parse_command("  ") is None
    assert parse_command("说 /员工 的事") is None


def test_parse_command_list() -> None:
    assert parse_command("/员工").kind == "list"
    assert parse_command("/list").kind == "list"
    assert parse_command("  /LIST  ").kind == "list"


def test_parse_command_current_and_help() -> None:
    assert parse_command("/当前").kind == "current"
    assert parse_command("/帮助").kind == "help"
    assert parse_command("/?").kind == "help"
    assert parse_command("/？").kind == "help"


def test_parse_command_switch() -> None:
    cmd = parse_command("/切换 财务")
    assert cmd.kind == "switch" and cmd.query == "财务"
    direct = parse_command("/财务")
    assert direct.kind == "switch" and direct.query == "财务"
    empty = parse_command("/切换")
    assert empty.kind == "switch" and empty.query == ""


def test_parse_command_unknown_slash_goes_help() -> None:
    assert parse_command("/foo bar").kind == "help"
    assert parse_command("/").kind == "help"


# ---------- 挂载集与指针 ----------


def test_mounted_agents_legacy_fallback() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)  # 无挂载行
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        mounts = mounted_agents(db, binding)
        assert [m.agent_id for m in mounts] == ["agent_xz"]
        assert mounts[0].is_default is True


def test_mounted_agents_ordering() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(
        engine, mounts=[("agent_cw", "财务", False), ("agent_xz", "行政", True)]
    )
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        mounts = mounted_agents(db, binding)
        assert [m.agent_id for m in mounts] == ["agent_cw", "agent_xz"]


def test_mounted_agents_ignores_deleted_agents() -> None:
    """孤儿挂载行(员工已删除)不应出现在挂载集里。"""
    engine = _test_engine()
    binding_id = _seed_binding(
        engine,
        mounts=[
            ("agent_xz", "行政", True),
            ("agent_gone", "已删除", False),
            ("agent_cw", "财务", False),
        ],
    )
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        mounts = mounted_agents(db, binding)
        assert [m.agent_id for m in mounts] == ["agent_xz", "agent_cw"]

        reply = run_command(db, binding, "wechat_p2p_u1", parse_command("/员工"))
        assert "agent_gone" not in reply
        assert "已删除" not in reply
        assert "1. 行政（默认/当前）" in reply
        assert "2. 财务" in reply


def test_mounted_agents_all_deleted_falls_back_to_binding_default() -> None:
    """挂载行全部指向已删除员工时,按存量绑定回退到 binding.agent_id。"""
    engine = _test_engine()
    binding_id = _seed_binding(
        engine, mounts=[("agent_gone", "已删除", True), ("agent_gone2", "也删了", False)]
    )
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        mounts = mounted_agents(db, binding)
        assert [m.agent_id for m in mounts] == ["agent_xz"]
        assert mounts[0].is_default is True


def test_resolve_current_agent_creates_pointer_at_default() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(
        engine, mounts=[("agent_xz", "行政", True), ("agent_cw", "财务", False)]
    )
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        current, reset = resolve_current_agent(db, binding, "wechat_p2p_u1")
        db.commit()
        assert current == "agent_xz"
        assert reset is False
        state = db.exec(select(ChannelConvState)).one()
        assert state.current_agent_id == "agent_xz"


def test_resolve_current_agent_resets_when_unmounted() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(
        engine, mounts=[("agent_xz", "行政", True), ("agent_cw", "财务", False)]
    )
    with Session(engine) as db:
        db.add(
            ChannelConvState(
                tenant_id="tenant_demo",
                binding_id=binding_id,
                external_conv_id="wechat_p2p_u1",
                current_agent_id="agent_gone",
            )
        )
        db.commit()
        binding = db.get(ChannelBinding, binding_id)
        current, reset = resolve_current_agent(db, binding, "wechat_p2p_u1")
        assert current == "agent_xz"
        assert reset is True


# ---------- 指令执行文本 ----------


def _command_setup(engine):
    binding_id = _seed_binding(
        engine, mounts=[("agent_xz", "行政", True), ("agent_cw", "财务", False)]
    )
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        db.expunge(binding)
        return binding


def test_run_command_list_marks_default_and_current() -> None:
    engine = _test_engine()
    binding = _command_setup(engine)
    with Session(engine) as db:
        reply = run_command(db, binding, "wechat_p2p_u1", parse_command("/员工"))
        lines = reply.splitlines()
        assert lines[0] == "可调度员工："
        assert "1. 行政（默认/当前）" in lines
        assert "2. 财务" in lines


def test_run_command_switch_and_current() -> None:
    engine = _test_engine()
    binding = _command_setup(engine)
    with Session(engine) as db:
        reply = run_command(db, binding, "wechat_p2p_u1", parse_command("/切换 财务"))
        db.commit()
        assert (
            reply == "已切换到「财务」，后续消息由 TA 回复。上下文各自独立，输入 /员工 查看列表。"
        )
        current, _ = resolve_current_agent(db, binding, "wechat_p2p_u1")
        assert current == "agent_cw"

        reply = run_command(db, binding, "wechat_p2p_u1", parse_command("/当前"))
        assert "「财务」" in reply

        again = run_command(db, binding, "wechat_p2p_u1", parse_command("/财务"))
        assert again == "当前已经是「财务」。"


def test_run_command_switch_unknown_and_empty() -> None:
    engine = _test_engine()
    binding = _command_setup(engine)
    with Session(engine) as db:
        reply = run_command(db, binding, "wechat_p2p_u1", parse_command("/切换 保安"))
        assert "没有找到员工「保安」" in reply
        reply = run_command(db, binding, "wechat_p2p_u1", parse_command("/切换"))
        assert reply.startswith("用法：/切换")


def test_run_command_help() -> None:
    engine = _test_engine()
    binding = _command_setup(engine)
    with Session(engine) as db:
        assert run_command(db, binding, "wechat_p2p_u1", parse_command("/帮助")) == HELP_TEXT


@pytest.mark.parametrize(
    ("channel", "label"),
    [("wechat", "微信"), ("wecom", "企业微信"), ("feishu", "飞书")],
)
def test_help_text_uses_actual_channel_name(channel: str, label: str) -> None:
    text = help_text(channel)
    assert f"把{label}账号绑定到你的 FirmDeck 账号" in text
    assert f"解除{label}账号与 FirmDeck 账号的绑定" in text


def _reply_context(locale: str) -> LanguageContext:
    """Build an immutable reply-locale snapshot for channel notice tests."""
    return LanguageContext(
        ui_locale="zh-CN" if locale == "en-US" else "en-US",
        agent_reply_locale=locale,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )


def test_channel_notice_descriptor_is_typed_and_preserves_raw_params() -> None:
    """Represent product chrome as code plus raw params before locale-specific rendering."""
    from app.channels.service_routing import ChannelNotice, render_channel_notice

    notice = ChannelNotice(code="routing.switched", params={"agent_name": "财务 SKU-A/42"})

    assert notice.code == "routing.switched"
    assert notice.params == {"agent_name": "财务 SKU-A/42"}
    assert "Switched to" in render_channel_notice(notice, _reply_context("en-US"))
    assert "财务 SKU-A/42" in render_channel_notice(notice, _reply_context("en-US"))
    assert "已切换" in render_channel_notice(notice, _reply_context("zh-CN"))


def test_run_command_uses_reply_locale_and_keeps_agent_names_raw() -> None:
    """Localize command chrome from the immutable reply locale without translating agent names."""
    engine = _test_engine()
    binding = _command_setup(engine)
    with Session(engine) as db:
        reply = run_command(
            db,
            binding,
            "wechat_p2p_u1",
            parse_command("/switch 财务"),
            language_context=_reply_context("en-US"),
        )

    assert "Switched to" in reply
    assert "财务" in reply
    assert "已切换" not in reply


# ---------- intake 集成 ----------


def _notices(engine) -> list[ChannelDelivery]:
    with Session(engine) as db:
        return db.exec(select(ChannelDelivery).where(ChannelDelivery.kind == "notice")).all()


def test_command_message_creates_no_session_and_notices_via_outbox() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(
        engine, mounts=[("agent_xz", "行政", True), ("agent_cw", "财务", False)]
    )
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_cmd1", "/员工"), db_engine=engine) is False
    assert RecordingAgentLoop.calls == []

    notices = _notices(engine)
    assert len(notices) == 1
    assert notices[0].session_id == "conv:wechat_p2p_user_ab12cd34@im.wechat"
    assert "可调度员工" in notices[0].text
    assert notices[0].status == "pending"

    with Session(engine) as db:
        assert db.exec(select(ChatSession)).all() == []
        event = db.exec(select(ChannelInboundEvent)).one()
        assert event.status == "done"


def test_switch_then_next_message_routes_to_new_agent_session() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(
        engine, mounts=[("agent_xz", "行政", True), ("agent_cw", "财务", False)]
    )
    binding = _load_binding(engine, binding_id)

    # 默认员工会话
    assert process_inbound(binding, _p2p_message("evt_1", "帮我订会议室"), db_engine=engine) is True
    assert RecordingAgentLoop.calls[-1].agent_id == "agent_xz"
    session_xz = RecordingAgentLoop.calls[-1].session_id

    # 切换到财务
    assert process_inbound(binding, _p2p_message("evt_2", "/切换 财务"), db_engine=engine) is False
    assert process_inbound(binding, _p2p_message("evt_3", "报销怎么走"), db_engine=engine) is True
    assert RecordingAgentLoop.calls[-1].agent_id == "agent_cw"
    session_cw = RecordingAgentLoop.calls[-1].session_id
    assert session_cw != session_xz

    # 切回行政:原会话还在(上下文独立保留)
    assert process_inbound(binding, _p2p_message("evt_4", "/切换 行政"), db_engine=engine) is False
    assert (
        process_inbound(binding, _p2p_message("evt_5", "会议室订好了吗"), db_engine=engine) is True
    )
    assert RecordingAgentLoop.calls[-1].agent_id == "agent_xz"
    assert RecordingAgentLoop.calls[-1].session_id == session_xz

    with Session(engine) as db:
        sessions = db.exec(select(ChatSession)).all()
        assert len(sessions) == 2
        by_agent = {s.agent_id: s for s in sessions}
        assert by_agent["agent_xz"].channel_binding_id == binding_id
        assert by_agent["agent_cw"].channel_binding_id == binding_id
    # 两次切换各产生一条 notice
    assert len(_notices(engine)) == 2


def test_group_pointer_independent_from_p2p() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(
        engine, mounts=[("agent_xz", "行政", True), ("agent_cw", "财务", False)]
    )
    binding = _load_binding(engine, binding_id)

    # 群里切到财务
    assert (
        process_inbound(binding, _group_message("evt_g1", "/切换 财务"), db_engine=engine) is False
    )
    assert (
        process_inbound(binding, _group_message("evt_g2", "群里问报销"), db_engine=engine) is True
    )
    assert RecordingAgentLoop.calls[-1].agent_id == "agent_cw"

    # 私聊仍是默认行政
    assert process_inbound(binding, _p2p_message("evt_p1", "私聊问行政"), db_engine=engine) is True
    assert RecordingAgentLoop.calls[-1].agent_id == "agent_xz"

    # 另一个群独立指针
    assert (
        process_inbound(
            binding, _group_message("evt_g3", "新群第一句", group_id="room_999"), db_engine=engine
        )
        is True
    )
    assert RecordingAgentLoop.calls[-1].agent_id == "agent_xz"


def test_legacy_binding_routes_to_binding_default_agent() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(engine)  # 无挂载行(存量 v1 绑定)
    binding = _load_binding(engine, binding_id)

    assert process_inbound(binding, _p2p_message("evt_l1", "你好"), db_engine=engine) is True
    assert RecordingAgentLoop.calls[-1].agent_id == "agent_xz"


def test_pointer_reset_notice_when_agent_unmounted() -> None:
    engine = _test_engine()
    binding_id = _seed_binding(
        engine, mounts=[("agent_xz", "行政", True), ("agent_cw", "财务", False)]
    )
    binding = _load_binding(engine, binding_id)

    # 切到财务后,把财务从挂载集移除
    assert process_inbound(binding, _p2p_message("evt_r1", "/切换 财务"), db_engine=engine) is False
    with Session(engine) as db:
        row = db.exec(
            select(ChannelBindingAgent).where(
                ChannelBindingAgent.binding_id == binding_id,
                ChannelBindingAgent.agent_id == "agent_cw",
            )
        ).one()
        db.delete(row)
        db.commit()

    assert process_inbound(binding, _p2p_message("evt_r2", "还在吗"), db_engine=engine) is True
    assert RecordingAgentLoop.calls[-1].agent_id == "agent_xz"
    notices = _notices(engine)
    assert any("已下线" in n.text and "「行政」" in n.text for n in notices)


def test_agent_names_lookup() -> None:
    engine = _test_engine()
    _seed_binding(engine)
    with Session(engine) as db:
        names = agent_names(db, "tenant_demo", ["agent_xz", "agent_cw", "agent_missing"])
        assert names == {"agent_xz": "行政", "agent_cw": "财务"}


# ---------- staging 直查优先 ----------


def test_staging_prefers_channel_binding_id() -> None:
    engine = _test_engine()
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo", status="active", lifecycle_version=1))
        # 绑定默认员工是行政,但会话属于财务(账号化路由后的状态)
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_xz",
            channel="wechat",
            status="active",
            created_by_user_id="user_owner",
            external_account_key="wechat:ilink_bot:legacy",
        )
        db.add(binding)
        db.commit()
        chat_session = ChatSession(
            id="session_routed",
            tenant_id="tenant_demo",
            agent_id="agent_cw",
            channel="wechat",
            external_conv_id="wechat_p2p_u1",
            channel_target_json={"to_user_id": "u1", "context_token": "ctx"},
            channel_account_key=binding.external_account_key,
            channel_binding_id=binding.id,
        )
        message = Message(
            id="msg_routed",
            tenant_id="tenant_demo",
            session_id="session_routed",
            role="assistant",
            content="财务回复",
        )
        db.add(chat_session)
        db.add(message)
        db.commit()

        stage_channel_delivery(db, chat_session, message)
        db.commit()
        deliveries = db.exec(select(ChannelDelivery)).all()
        assert len(deliveries) == 1
        assert deliveries[0].binding_id == binding.id


def test_staging_fallback_without_channel_binding_id() -> None:
    engine = _test_engine()
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo", status="active", lifecycle_version=1))
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_xz",
            channel="wechat",
            status="active",
            created_by_user_id="user_owner",
            external_account_key="wechat:ilink_bot:legacy",
        )
        db.add(binding)
        db.commit()
        chat_session = ChatSession(
            id="session_legacy",
            tenant_id="tenant_demo",
            agent_id="agent_xz",
            channel="wechat",
            external_conv_id="wechat_p2p_u1",
            channel_target_json={"to_user_id": "u1", "context_token": "ctx"},
            channel_account_key=binding.external_account_key,
        )
        message = Message(
            id="msg_legacy",
            tenant_id="tenant_demo",
            session_id="session_legacy",
            role="assistant",
            content="回复",
        )
        db.add(chat_session)
        db.add(message)
        db.commit()

        stage_channel_delivery(db, chat_session, message)
        db.commit()
        assert len(db.exec(select(ChannelDelivery)).all()) == 1
        assert db.get(ChatSession, chat_session.id).channel_binding_id == binding.id


def test_staging_skips_when_binding_id_points_to_disabled() -> None:
    engine = _test_engine()
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo", status="active", lifecycle_version=1))
        binding = ChannelBinding(
            tenant_id="tenant_demo", agent_id="agent_xz", channel="wechat", status="disabled"
        )
        db.add(binding)
        db.commit()
        chat_session = ChatSession(
            id="session_disabled",
            tenant_id="tenant_demo",
            agent_id="agent_xz",
            channel="wechat",
            channel_target_json={"to_user_id": "u1", "context_token": "ctx"},
            channel_binding_id=binding.id,
        )
        message = Message(
            id="msg_disabled",
            tenant_id="tenant_demo",
            session_id="session_disabled",
            role="assistant",
            content="回复",
        )
        db.add(chat_session)
        db.add(message)
        db.commit()

        stage_channel_delivery(db, chat_session, message)
        db.commit()
        delivery = db.exec(select(ChannelDelivery)).one()
        assert delivery.status == "failed"
        assert delivery.last_error == "binding_missing_or_inactive"


# ---------- API: 删除员工清理渠道挂载 ----------


def _make_agents_client(engine):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import app.api.agents as agents_api
    from app.db import get_session

    app = FastAPI()
    app.include_router(agents_api.enterprise_router)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def test_delete_agent_cleans_channel_mounts_and_repoints_default() -> None:
    """删除员工要移除其渠道挂载;默认挂载被删时 binding.agent_id 重指剩余首个挂载。"""
    engine = _test_engine()
    users = _seed_api_users(engine)
    with Session(engine) as db:
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_cw",
            channel="wechat",
            status="active",
            created_by_user_id="user_owner",
        )
        db.add(binding)
        db.flush()
        for index, (agent_id, is_default) in enumerate((("agent_cw", True), ("agent_xz", False))):
            db.add(
                ChannelBindingAgent(
                    tenant_id="tenant_demo",
                    binding_id=binding.id,
                    agent_id=agent_id,
                    is_default=is_default,
                    sort_order=index,
                )
            )
        db.commit()
        binding_id = binding.id

    client = _make_agents_client(engine)
    deleted = client.delete(
        "/api/enterprise/agents/agent_cw?tenant_id=tenant_demo",
        headers=_auth(users["owner"]),
    )
    assert deleted.status_code == 200

    with Session(engine) as db:
        mounts = db.exec(
            select(ChannelBindingAgent).where(ChannelBindingAgent.binding_id == binding_id)
        ).all()
        assert [m.agent_id for m in mounts] == ["agent_xz"]
        assert mounts[0].is_default is True  # 首个剩余挂载提升为默认
        binding = db.get(ChannelBinding, binding_id)
        assert binding.agent_id == "agent_xz"
        assert binding.config_revision == 1
        assert db.get(AgentProfile, "agent_cw") is None

        # /员工 列表不再出现已删除员工
        reply = run_command(db, binding, "wechat_p2p_u1", parse_command("/员工"))
        assert "财务" not in reply
        assert "1. 行政（默认/当前）" in reply


def test_delete_agent_last_mount_keeps_binding_agent() -> None:
    """删除绑定唯一挂载员工:挂载行清空,按存量绑定回退仍指向原默认(边界,不造员工)。"""
    engine = _test_engine()
    users = _seed_api_users(engine)
    with Session(engine) as db:
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_cw",
            channel="wechat",
            status="active",
            created_by_user_id="user_owner",
        )
        db.add(binding)
        db.flush()
        db.add(
            ChannelBindingAgent(
                tenant_id="tenant_demo",
                binding_id=binding.id,
                agent_id="agent_cw",
                is_default=True,
                sort_order=0,
            )
        )
        db.commit()
        binding_id = binding.id

    client = _make_agents_client(engine)
    deleted = client.delete(
        "/api/enterprise/agents/agent_cw?tenant_id=tenant_demo",
        headers=_auth(users["owner"]),
    )
    assert deleted.status_code == 200

    with Session(engine) as db:
        mounts = db.exec(
            select(ChannelBindingAgent).where(ChannelBindingAgent.binding_id == binding_id)
        ).all()
        assert mounts == []
        binding = db.get(ChannelBinding, binding_id)
        assert binding.agent_id == "agent_cw"  # 无剩余挂载可指,保持原值
        assert binding.config_revision == 1


@pytest.mark.parametrize("operation_status", ["manual_review", "provider_inflight"])
def test_delete_agent_is_atomic_when_wechat_kf_binding_operation_blocks(
    operation_status: str,
) -> None:
    """任一微信客服 binding 未决时，多 binding 员工删除必须零部分写入并返回安全 409。"""
    engine = _test_engine()
    users = _seed_api_users(engine)
    private_detail = "provider-secret-private https://provider.invalid/account"
    with Session(engine) as db:
        wechat_kf_binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_cw",
            channel="wechat_kf",
            status="active",
            config_revision=7,
            created_by_user_id="user_owner",
        )
        wechat_binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_cw",
            channel="wechat",
            status="active",
            config_revision=11,
            created_by_user_id="user_owner",
        )
        db.add_all([wechat_kf_binding, wechat_binding])
        db.flush()
        mounts = (
            (wechat_kf_binding.id, "agent_cw", True, 0),
            (wechat_kf_binding.id, "agent_xz", False, 1),
            (wechat_binding.id, "agent_cw", True, 0),
            (wechat_binding.id, "agent_rs", False, 1),
        )
        for binding_id, agent_id, is_default, sort_order in mounts:
            db.add(
                ChannelBindingAgent(
                    tenant_id="tenant_demo",
                    binding_id=binding_id,
                    agent_id=agent_id,
                    is_default=is_default,
                    sort_order=sort_order,
                )
            )
        operation = WeChatKfAccountOperation(
            tenant_id="tenant_demo",
            binding_id=wechat_kf_binding.id,
            kind="create" if operation_status == "manual_review" else "update",
            status=operation_status,
            open_kfid=None if operation_status == "manual_review" else "wk-pending-update",
            desired_name=private_detail,
            binding_revision=7,
            last_error_code="CHANNEL_CONFLICT",
        )
        db.add(operation)
        db.commit()
        operation_id = operation.id
        binding_ids = (wechat_kf_binding.id, wechat_binding.id)

    response = _make_agents_client(engine).delete(
        "/api/enterprise/agents/agent_cw?tenant_id=tenant_demo",
        headers=_auth(users["owner"]),
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "CHANNEL_CONFLICT"
    assert private_detail not in response.text
    assert "provider.invalid" not in response.text
    with Session(engine) as db:
        assert db.get(AgentProfile, "agent_cw") is not None
        stored_operation = db.get(WeChatKfAccountOperation, operation_id)
        assert stored_operation.status == operation_status
        assert stored_operation.binding_revision == 7
        stored_bindings = [db.get(ChannelBinding, binding_id) for binding_id in binding_ids]
        assert [(binding.agent_id, binding.config_revision) for binding in stored_bindings] == [
            ("agent_cw", 7),
            ("agent_cw", 11),
        ]
        stored_mounts = db.exec(
            select(ChannelBindingAgent).order_by(
                ChannelBindingAgent.binding_id,
                ChannelBindingAgent.sort_order,
            )
        ).all()
        assert [
            (mount.binding_id, mount.agent_id, mount.is_default, mount.sort_order)
            for mount in stored_mounts
        ] == sorted(mounts)


def test_delete_agent_succeeds_after_wechat_kf_operation_completed() -> None:
    """显式裁决完成后的 operation 不再阻断删除，路由改写必须推进 binding revision。"""
    engine = _test_engine()
    users = _seed_api_users(engine)
    with Session(engine) as db:
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_cw",
            channel="wechat_kf",
            status="active",
            config_revision=3,
            created_by_user_id="user_owner",
        )
        db.add(binding)
        db.flush()
        for index, (agent_id, is_default) in enumerate((("agent_cw", True), ("agent_xz", False))):
            db.add(
                ChannelBindingAgent(
                    tenant_id="tenant_demo",
                    binding_id=binding.id,
                    agent_id=agent_id,
                    is_default=is_default,
                    sort_order=index,
                )
            )
        operation = WeChatKfAccountOperation(
            tenant_id="tenant_demo",
            binding_id=binding.id,
            kind="create",
            status="completed",
            open_kfid="wk-resolved",
            desired_name="已裁决",
            binding_revision=2,
            completed_at=binding.updated_at,
        )
        db.add(operation)
        db.commit()
        binding_id = binding.id
        operation_id = operation.id

    response = _make_agents_client(engine).delete(
        "/api/enterprise/agents/agent_cw?tenant_id=tenant_demo",
        headers=_auth(users["owner"]),
    )

    assert response.status_code == 200
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        assert binding.agent_id == "agent_xz"
        assert binding.config_revision == 4
        assert db.get(WeChatKfAccountOperation, operation_id).status == "completed"
        assert db.get(AgentProfile, "agent_cw") is None
        mounts = db.exec(
            select(ChannelBindingAgent).where(ChannelBindingAgent.binding_id == binding_id)
        ).all()
        assert [(mount.agent_id, mount.is_default) for mount in mounts] == [("agent_xz", True)]


def test_delete_agent_blocks_legacy_default_wechat_kf_binding_operation() -> None:
    """无挂载行的存量默认 binding 也必须取得锁并受 manual-review guard 保护。"""
    engine = _test_engine()
    users = _seed_api_users(engine)
    with Session(engine) as db:
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_cw",
            channel="wechat_kf",
            status="active",
            config_revision=5,
            created_by_user_id="user_owner",
        )
        db.add(binding)
        db.flush()
        operation = WeChatKfAccountOperation(
            tenant_id="tenant_demo",
            binding_id=binding.id,
            kind="create",
            status="manual_review",
            desired_name="legacy-default-private",
            binding_revision=5,
            last_error_code="CHANNEL_CONFLICT",
        )
        db.add(operation)
        db.commit()
        binding_id = binding.id
        operation_id = operation.id

    response = _make_agents_client(engine).delete(
        "/api/enterprise/agents/agent_cw?tenant_id=tenant_demo",
        headers=_auth(users["owner"]),
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "CHANNEL_CONFLICT"
    with Session(engine) as db:
        assert db.get(AgentProfile, "agent_cw") is not None
        binding = db.get(ChannelBinding, binding_id)
        assert (binding.agent_id, binding.config_revision) == ("agent_cw", 5)
        assert db.get(WeChatKfAccountOperation, operation_id).status == "manual_review"


# ---------- 迁移回填 ----------


def test_binding_agents_backfill_is_idempotent(monkeypatch, tmp_path) -> None:
    from sqlalchemy import text as sa_text

    from app.db import database

    db_path = tmp_path / "backfill.db"
    engine = create_engine(f"sqlite:///{db_path}")
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(
            sa_text(
                "INSERT INTO channel_bindings (id, tenant_id, agent_id, channel, status, connected, created_at, updated_at) "
                "VALUES ('chan_legacy', 'tenant_demo', 'agent_xz', 'wechat', 'active', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
        )

    monkeypatch.setattr(database, "database_url", f"sqlite:///{db_path}")
    monkeypatch.setattr(database, "engine", engine)

    database._migrate_sqlite_skill_schema()
    with engine.begin() as conn:
        rows = conn.execute(sa_text("SELECT * FROM channel_binding_agents")).mappings().all()
        assert len(rows) == 1
        assert rows[0]["binding_id"] == "chan_legacy"
        assert rows[0]["agent_id"] == "agent_xz"
        assert rows[0]["is_default"] == 1

    # 重复执行:迁移记录存在,不再插入
    with engine.begin() as conn:
        conn.execute(sa_text("DELETE FROM channel_binding_agents"))
    database._migrate_sqlite_skill_schema()
    with engine.begin() as conn:
        rows = conn.execute(sa_text("SELECT * FROM channel_binding_agents")).mappings().all()
        assert rows == []
        applied = conn.execute(
            sa_text("SELECT id FROM app_data_migrations WHERE id = :id"),
            {"id": database._CHANNEL_BINDING_AGENTS_BACKFILL_MIGRATION_ID},
        ).first()
        assert applied is not None


# ---------- API:POST 自动挂载 / GET agents / PUT ----------


def _make_api_client(engine):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import app.api.channels as channels_api
    from app.db import get_session

    app = FastAPI()
    app.include_router(channels_api.router)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def _make_agent_channel_client(engine):
    """创建同时挂载员工与渠道路由的测试客户端；每个请求使用独立数据库 Session。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import app.api.agents as agents_api
    import app.api.channels as channels_api
    from app.db import get_session

    app = FastAPI()
    app.include_router(agents_api.enterprise_router)
    app.include_router(channels_api.router)

    def override_get_session():
        """为并发 API 请求提供独立 Session，退出请求时自动回滚未提交事务。"""
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def _seed_api_users(engine) -> dict[str, User]:
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo", status="active", lifecycle_version=1))
        owner = User(id="user_owner", tenant_id="tenant_demo", username="owner", password_hash="x")
        other = User(id="user_other", tenant_id="tenant_demo", username="other", password_hash="x")
        db.add(owner)
        db.add(other)
        for agent_id, name in (("agent_xz", "行政"), ("agent_cw", "财务"), ("agent_rs", "人事")):
            db.add(
                AgentProfile(
                    id=agent_id,
                    tenant_id="tenant_demo",
                    name=name,
                    metadata_json={"owner_user_id": owner.id},
                )
            )
        db.commit()
        for user in (owner, other):
            db.refresh(user)
            db.expunge(user)
        return {"owner": owner, "other": other}


def _auth(user: User) -> dict[str, str]:
    from app.security.auth import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user)}"}


def _concurrent_test_engine(tmp_path):
    """创建支持多连接并发的 WAL SQLite 测试库；数据库文件仅写入 pytest 临时目录。"""
    db_path = tmp_path / "channel-routing-concurrency.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 5.0},
    )
    SQLModel.metadata.create_all(engine)
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
        connection.commit()
    return engine


def _seed_agent_delete_concurrency_binding(engine) -> tuple[dict[str, User], str]:
    """创建可安全提升默认员工的双挂载 binding；提交测试租户、员工与路由数据。"""
    users = _seed_api_users(engine)
    with Session(engine) as db:
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_cw",
            channel="wechat",
            status="active",
            created_by_user_id="user_owner",
        )
        db.add(binding)
        db.flush()
        for index, (agent_id, is_default) in enumerate((("agent_cw", True), ("agent_xz", False))):
            db.add(
                ChannelBindingAgent(
                    tenant_id="tenant_demo",
                    binding_id=binding.id,
                    agent_id=agent_id,
                    is_default=is_default,
                    sort_order=index,
                )
            )
        db.commit()
        return users, binding.id


def test_post_binding_auto_mounts_default_agent() -> None:
    engine = _test_engine()
    users = _seed_api_users(engine)
    client = _make_api_client(engine)

    created = client.post(
        "/api/enterprise/channels",
        json={"tenant_id": "tenant_demo", "agent_id": "agent_xz", "channel": "wechat"},
        headers=_auth(users["owner"]),
    )
    assert created.status_code == 200
    binding_id = created.json()["id"]
    agents = created.json()["agents"]
    assert [(a["agent_id"], a["is_default"]) for a in agents] == [("agent_xz", True)]
    assert agents[0]["name"] == "行政"

    listed = client.get(
        f"/api/enterprise/channels/{binding_id}/agents?tenant_id=tenant_demo",
        headers=_auth(users["owner"]),
    )
    assert listed.status_code == 200
    assert [(a["agent_id"], a["name"], a["is_default"]) for a in listed.json()] == [
        ("agent_xz", "行政", True)
    ]


def test_get_agents_legacy_fallback() -> None:
    engine = _test_engine()
    users = _seed_api_users(engine)
    with Session(engine) as db:
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_xz",
            channel="wechat",
            status="active",
            created_by_user_id="user_owner",
        )
        db.add(binding)
        db.commit()
        binding_id = binding.id

    client = _make_api_client(engine)
    listed = client.get(
        f"/api/enterprise/channels/{binding_id}/agents?tenant_id=tenant_demo",
        headers=_auth(users["owner"]),
    )
    assert listed.status_code == 200
    assert [(a["agent_id"], a["is_default"]) for a in listed.json()] == [("agent_xz", True)]


def test_put_agents_replaces_mounts_and_normalizes_default() -> None:
    engine = _test_engine()
    users = _seed_api_users(engine)
    with Session(engine) as db:
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_xz",
            channel="wechat",
            status="active",
            created_by_user_id="user_owner",
        )
        db.add(binding)
        db.commit()
        binding_id = binding.id

    client = _make_api_client(engine)
    # 未标默认 → 取第一个
    updated = client.put(
        f"/api/enterprise/channels/{binding_id}?tenant_id=tenant_demo",
        json={"agents": [{"agent_id": "agent_cw"}, {"agent_id": "agent_xz"}]},
        headers=_auth(users["owner"]),
    )
    assert updated.status_code == 200
    payload = updated.json()
    assert [(a["agent_id"], a["is_default"]) for a in payload["agents"]] == [
        ("agent_cw", True),
        ("agent_xz", False),
    ]
    assert payload["agent_id"] == "agent_cw"

    # 多标默认 → 取首个标记
    updated = client.put(
        f"/api/enterprise/channels/{binding_id}?tenant_id=tenant_demo",
        json={
            "agents": [
                {"agent_id": "agent_xz", "is_default": True},
                {"agent_id": "agent_cw", "is_default": True},
            ]
        },
        headers=_auth(users["owner"]),
    )
    assert [(a["agent_id"], a["is_default"]) for a in updated.json()["agents"]] == [
        ("agent_xz", True),
        ("agent_cw", False),
    ]

    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        assert binding.agent_id == "agent_xz"
        assert binding.config_revision == 2
        mounts = db.exec(
            select(ChannelBindingAgent).where(ChannelBindingAgent.binding_id == binding_id)
        ).all()
        assert len(mounts) == 2


def test_binding_revision_claim_allows_only_one_stale_snapshot_winner(tmp_path) -> None:
    """两个进程快照使用同一 revision 时，数据库 CAS 只能允许第一个提交。"""
    import app.channels.service_routing_locks as routing_locks

    claim = getattr(routing_locks, "claim_channel_binding_revision", None)
    assert callable(claim), "durable binding revision claim is missing"
    engine = create_engine(
        f"sqlite:///{tmp_path / 'routing-revision-cas.db'}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(Tenant(id="tenant_cas", name="CAS"))
        binding = ChannelBinding(
            tenant_id="tenant_cas",
            agent_id="agent_cas",
            channel="wechat",
            config_revision=4,
        )
        db.add(binding)
        db.commit()
        binding_id = binding.id

    first = Session(engine)
    second = Session(engine)
    try:
        first_binding = first.get(ChannelBinding, binding_id)
        second_binding = second.get(ChannelBinding, binding_id)
        assert first_binding is not None and second_binding is not None
        assert claim(first, first_binding, 4)
        first.commit()
        assert not claim(second, second_binding, 4)
        second.rollback()
    finally:
        first.close()
        second.close()

    with Session(engine) as db:
        assert db.get(ChannelBinding, binding_id).config_revision == 5


def test_put_binding_concurrent_stale_snapshots_return_one_conflict_without_partial_state(
    tmp_path,
    monkeypatch,
) -> None:
    """模拟两个 worker 同时改名：仅一项提交，另一项稳定 409 且不覆盖胜者状态。"""
    import app.api.channels as channels_api
    import app.channels.service_routing_locks as routing_locks

    engine = _concurrent_test_engine(tmp_path)
    users = _seed_api_users(engine)
    with Session(engine) as db:
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_xz",
            channel="wechat",
            status="active",
            name="初始名称",
            created_by_user_id="user_owner",
        )
        db.add(binding)
        db.flush()
        db.add(
            ChannelBindingAgent(
                tenant_id="tenant_demo",
                binding_id=binding.id,
                agent_id="agent_xz",
                is_default=True,
                sort_order=0,
            )
        )
        db.commit()
        binding_id = binding.id

    barrier = threading.Barrier(2)
    real_claim = routing_locks.claim_channel_binding_revision

    def synchronized_claim(db, binding, expected_revision):
        barrier.wait(timeout=2)
        return real_claim(db, binding, expected_revision)

    monkeypatch.setattr(channels_api, "binding_lifecycle_lock", lambda _id: nullcontext())
    monkeypatch.setattr(channels_api, "claim_channel_binding_revision", synchronized_claim)
    client = _make_api_client(engine)

    def rename(name: str):
        return client.put(
            f"/api/enterprise/channels/{binding_id}?tenant_id=tenant_demo",
            json={"name": name},
            headers=_auth(users["owner"]),
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(rename, ("并发名称 A", "并发名称 B")))

    assert sorted(response.status_code for response in responses) == [200, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    winner = next(response for response in responses if response.status_code == 200)
    assert conflict.json()["detail"]["code"] == "CHANNEL_CONFLICT"
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        mounts = db.exec(
            select(ChannelBindingAgent).where(ChannelBindingAgent.binding_id == binding_id)
        ).all()
        assert binding.name == winner.json()["name"]
        assert binding.config_revision == 1
        assert [(row.agent_id, row.is_default) for row in mounts] == [("agent_xz", True)]


def test_put_agents_validations() -> None:
    engine = _test_engine()
    users = _seed_api_users(engine)
    with Session(engine) as db:
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_xz",
            channel="wechat",
            status="active",
            created_by_user_id="user_owner",
        )
        db.add(binding)
        db.commit()
        binding_id = binding.id

    client = _make_api_client(engine)
    # 非 manager 403
    forbidden = client.put(
        f"/api/enterprise/channels/{binding_id}?tenant_id=tenant_demo",
        json={"agents": [{"agent_id": "agent_xz"}]},
        headers=_auth(users["other"]),
    )
    assert forbidden.status_code == 403

    # 空列表 400
    empty = client.put(
        f"/api/enterprise/channels/{binding_id}?tenant_id=tenant_demo",
        json={"agents": []},
        headers=_auth(users["owner"]),
    )
    assert empty.status_code == 400

    # 未知 agent 404
    unknown = client.put(
        f"/api/enterprise/channels/{binding_id}?tenant_id=tenant_demo",
        json={"agents": [{"agent_id": "agent_xz"}, {"agent_id": "agent_nope"}]},
        headers=_auth(users["owner"]),
    )
    assert unknown.status_code == 404

    # 重复 agent 400
    duplicated = client.put(
        f"/api/enterprise/channels/{binding_id}?tenant_id=tenant_demo",
        json={"agents": [{"agent_id": "agent_xz"}, {"agent_id": "agent_xz"}]},
        headers=_auth(users["owner"]),
    )
    assert duplicated.status_code == 400


def test_create_binding_waits_for_agent_delete_and_leaves_no_late_route(
    monkeypatch,
    tmp_path,
) -> None:
    """删除锁内复核后并发创建不得逃逸为悬空 binding、mount 或 operation。"""
    import app.api.agents as agents_api
    import app.api.channels as channels_api

    engine = _concurrent_test_engine(tmp_path)
    users, original_binding_id = _seed_agent_delete_concurrency_binding(engine)
    delete_ready = threading.Event()
    release_delete = threading.Event()
    create_prevalidated = threading.Event()
    create_done = threading.Event()
    delete_responses: list = []
    create_responses: list = []
    real_operation_guard = agents_api.ensure_channel_binding_has_no_blocking_account_operation
    real_scope_guard = channels_api.ensure_agent_scope_manager

    def block_delete_after_guard(db, binding) -> None:
        """把删除停在最后 guard 与首个写入之间，以复现 reviewer 指定窗口。"""
        real_operation_guard(db, binding)
        if binding.id == original_binding_id:
            delete_ready.set()
            if not release_delete.wait(timeout=5.0):
                raise RuntimeError("delete barrier timed out")

    def mark_create_prevalidated(db, tenant_id, agent_id, current_user):
        """标记创建已读到待删员工；保持真实权限校验与数据库副作用。"""
        result = real_scope_guard(db, tenant_id, agent_id, current_user)
        if agent_id == "agent_cw":
            create_prevalidated.set()
        return result

    def delete_request() -> None:
        """在独立请求线程删除员工，并保留真实 HTTP 响应供主线程断言。"""
        response = _make_agent_channel_client(engine).delete(
            "/api/enterprise/agents/agent_cw?tenant_id=tenant_demo",
            headers=_auth(users["owner"]),
        )
        delete_responses.append(response)

    def create_request() -> None:
        """在删除临界区并发创建微信客服 binding，并记录请求完成时点。"""
        response = _make_agent_channel_client(engine).post(
            "/api/enterprise/channels",
            json={"tenant_id": "tenant_demo", "agent_id": "agent_cw", "channel": "wechat_kf"},
            headers=_auth(users["owner"]),
        )
        create_responses.append(response)
        create_done.set()

    monkeypatch.setattr(
        agents_api,
        "ensure_channel_binding_has_no_blocking_account_operation",
        block_delete_after_guard,
    )
    monkeypatch.setattr(channels_api, "ensure_agent_scope_manager", mark_create_prevalidated)

    # 先把删除精确停在旧 affected set 已复核、数据库尚未写入的 reviewer 窗口。
    delete_thread = threading.Thread(target=delete_request)
    delete_thread.start()
    assert delete_ready.wait(timeout=5.0)

    # 再让创建读到员工；旧实现会在删除释放前完成并允许补入 manual-review operation。
    create_thread = threading.Thread(target=create_request)
    create_thread.start()
    assert create_prevalidated.wait(timeout=5.0)
    escaped_before_release = create_done.wait(timeout=0.5)
    if escaped_before_release:
        escaped_binding_id = create_responses[0].json()["id"]
        with Session(engine) as db:
            db.add(
                WeChatKfAccountOperation(
                    tenant_id="tenant_demo",
                    binding_id=escaped_binding_id,
                    kind="create",
                    status="manual_review",
                    desired_name="private-provider-state",
                    binding_revision=0,
                    last_error_code="CHANNEL_CONFLICT",
                )
            )
            db.commit()
    release_delete.set()
    delete_thread.join(timeout=5.0)
    create_thread.join(timeout=5.0)

    # 正确锁序使删除先提交，随后创建在锁内重验时得到稳定未找到且不产生路由记录。
    assert not delete_thread.is_alive()
    assert not create_thread.is_alive()
    assert len(delete_responses) == 1
    assert len(create_responses) == 1
    assert delete_responses[0].status_code == 200
    assert create_responses[0].status_code == 404
    assert create_responses[0].json()["detail"]["code"] == "AGENT_NOT_FOUND"
    assert "private-provider-state" not in create_responses[0].text
    with Session(engine) as db:
        assert db.get(AgentProfile, "agent_cw") is None
        original = db.get(ChannelBinding, original_binding_id)
        assert (original.agent_id, original.config_revision) == ("agent_xz", 1)
        assert (
            db.exec(select(ChannelBinding).where(ChannelBinding.channel == "wechat_kf")).all() == []
        )
        assert (
            db.exec(
                select(ChannelBindingAgent).where(ChannelBindingAgent.agent_id == "agent_cw")
            ).all()
            == []
        )
        assert db.exec(select(WeChatKfAccountOperation)).all() == []


def test_mount_update_revalidates_agent_after_concurrent_delete(
    monkeypatch,
    tmp_path,
) -> None:
    """先取得 binding 锁的员工删除完成后，已预校验的挂载更新不得复活该员工路由。"""
    import app.api.agents as agents_api
    import app.api.channels as channels_api

    engine = _concurrent_test_engine(tmp_path)
    users, binding_id = _seed_agent_delete_concurrency_binding(engine)
    delete_ready = threading.Event()
    release_delete = threading.Event()
    update_prevalidated = threading.Event()
    delete_responses: list = []
    update_responses: list = []
    real_operation_guard = agents_api.ensure_channel_binding_has_no_blocking_account_operation
    real_scope_guard = channels_api.ensure_agent_scope_manager

    def block_delete_after_guard(db, binding) -> None:
        """让删除持有 binding 与 agent 锁等待，以压力测试更新的锁内重验。"""
        real_operation_guard(db, binding)
        if binding.id == binding_id:
            delete_ready.set()
            if not release_delete.wait(timeout=5.0):
                raise RuntimeError("delete barrier timed out")

    def mark_update_prevalidated(db, tenant_id, agent_id, current_user):
        """记录更新已在锁外看到待删员工，同时执行真实管理权限校验。"""
        result = real_scope_guard(db, tenant_id, agent_id, current_user)
        if agent_id == "agent_cw":
            update_prevalidated.set()
        return result

    def delete_request() -> None:
        """并发删除默认员工；响应由主线程检查稳定契约和最终状态。"""
        delete_responses.append(
            _make_agent_channel_client(engine).delete(
                "/api/enterprise/agents/agent_cw?tenant_id=tenant_demo",
                headers=_auth(users["owner"]),
            )
        )

    def update_request() -> None:
        """用已预校验的员工替换挂载，覆盖删除先持锁的反向并发顺序。"""
        update_responses.append(
            _make_agent_channel_client(engine).put(
                f"/api/enterprise/channels/{binding_id}?tenant_id=tenant_demo",
                json={"agents": [{"agent_id": "agent_cw"}, {"agent_id": "agent_xz"}]},
                headers=_auth(users["owner"]),
            )
        )

    monkeypatch.setattr(
        agents_api,
        "ensure_channel_binding_has_no_blocking_account_operation",
        block_delete_after_guard,
    )
    monkeypatch.setattr(channels_api, "ensure_agent_scope_manager", mark_update_prevalidated)

    delete_thread = threading.Thread(target=delete_request)
    delete_thread.start()
    assert delete_ready.wait(timeout=5.0)
    update_thread = threading.Thread(target=update_request)
    update_thread.start()
    assert update_prevalidated.wait(timeout=5.0)
    release_delete.set()
    delete_thread.join(timeout=5.0)
    update_thread.join(timeout=5.0)

    assert not delete_thread.is_alive()
    assert not update_thread.is_alive()
    assert delete_responses[0].status_code == 200
    assert update_responses[0].status_code == 404
    assert update_responses[0].json()["detail"]["code"] == "AGENT_NOT_FOUND"
    with Session(engine) as db:
        assert db.get(AgentProfile, "agent_cw") is None
        binding = db.get(ChannelBinding, binding_id)
        assert (binding.agent_id, binding.config_revision) == ("agent_xz", 1)
        assert (
            db.exec(
                select(ChannelBindingAgent).where(ChannelBindingAgent.agent_id == "agent_cw")
            ).all()
            == []
        )


def test_agent_delete_and_mount_update_reverse_order_has_no_deadlock(
    monkeypatch,
    tmp_path,
) -> None:
    """挂载更新先持 binding/agent 锁时，员工删除须有界结束且不得覆盖新路由。"""
    import app.api.agents as agents_api
    import app.api.channels as channels_api

    engine = _concurrent_test_engine(tmp_path)
    users, binding_id = _seed_agent_delete_concurrency_binding(engine)
    update_ready = threading.Event()
    release_update = threading.Event()
    delete_started = threading.Event()
    delete_done = threading.Event()
    update_responses: list = []
    delete_responses: list = []
    real_operation_guard = channels_api.ensure_channel_binding_has_no_blocking_account_operation
    real_affected_ids = agents_api._affected_channel_binding_ids

    def block_update_after_guard(db, binding) -> None:
        """把更新停在所有路由锁内且首个写入前，验证反向锁序不会成环。"""
        real_operation_guard(db, binding)
        if binding.id == binding_id:
            update_ready.set()
            if not release_update.wait(timeout=5.0):
                raise RuntimeError("update barrier timed out")

    def mark_delete_started(db, agent_id):
        """记录删除已取得初始 affected set；返回真实确定性 binding ID 集合。"""
        result = real_affected_ids(db, agent_id)
        if agent_id == "agent_cw":
            delete_started.set()
        return result

    def update_request() -> None:
        """先移除待删员工挂载；请求在首个写入前由 barrier 暂停。"""
        update_responses.append(
            _make_agent_channel_client(engine).put(
                f"/api/enterprise/channels/{binding_id}?tenant_id=tenant_demo",
                json={"agents": [{"agent_id": "agent_xz"}]},
                headers=_auth(users["owner"]),
            )
        )

    def delete_request() -> None:
        """在更新持锁期间删除员工，并标记请求退出以检测死锁。"""
        delete_responses.append(
            _make_agent_channel_client(engine).delete(
                "/api/enterprise/agents/agent_cw?tenant_id=tenant_demo",
                headers=_auth(users["owner"]),
            )
        )
        delete_done.set()

    monkeypatch.setattr(
        channels_api,
        "ensure_channel_binding_has_no_blocking_account_operation",
        block_update_after_guard,
    )
    monkeypatch.setattr(agents_api, "_affected_channel_binding_ids", mark_delete_started)

    update_thread = threading.Thread(target=update_request)
    update_thread.start()
    assert update_ready.wait(timeout=5.0)
    delete_thread = threading.Thread(target=delete_request)
    delete_thread.start()
    assert delete_started.wait(timeout=5.0)
    assert not delete_done.wait(timeout=0.1)
    release_update.set()
    update_thread.join(timeout=5.0)
    delete_thread.join(timeout=5.0)

    assert not update_thread.is_alive()
    assert not delete_thread.is_alive()
    assert update_responses[0].status_code == 200
    assert delete_responses[0].status_code == 200
    with Session(engine) as db:
        assert db.get(AgentProfile, "agent_cw") is None
        binding = db.get(ChannelBinding, binding_id)
        assert binding.agent_id == "agent_xz"
        mounts = db.exec(
            select(ChannelBindingAgent).where(ChannelBindingAgent.binding_id == binding_id)
        ).all()
        assert [(mount.agent_id, mount.is_default) for mount in mounts] == [("agent_xz", True)]


def test_agent_delete_rejects_when_affected_binding_set_grows(monkeypatch) -> None:
    """锁外快照后出现未锁 binding 时，删除必须稳定冲突且不删除员工。"""
    import app.api.agents as agents_api

    engine = _test_engine()
    users = _seed_api_users(engine)
    calls = 0
    real_affected_ids = agents_api._affected_channel_binding_ids

    def grow_after_snapshot(db, agent_id):
        nonlocal calls
        calls += 1
        result = real_affected_ids(db, agent_id)
        return result if calls == 1 else ("binding-appeared-in-other-worker",)

    monkeypatch.setattr(agents_api, "_affected_channel_binding_ids", grow_after_snapshot)
    response = _make_agent_channel_client(engine).delete(
        "/api/enterprise/agents/agent_cw?tenant_id=tenant_demo",
        headers=_auth(users["owner"]),
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "CHANNEL_CONFLICT"
    with Session(engine) as db:
        assert db.get(AgentProfile, "agent_cw") is not None
