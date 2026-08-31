import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.memory.jobs as memory_jobs
from app.db.models import AgentEvent, ChatSession, Message, ModelConfig
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.llm.client import LLMClient
from app.memory.service import MemoryService
from app.session.session_schema import ChatTurnRequest, StepAgentResult


@pytest.mark.parametrize(
    ("source_messages", "memory_content", "memory_reason", "context"),
    [
        (
            [
                {"role": "user", "content": "Please keep replies concise."},
                {"role": "assistant", "content": "I will keep them concise."},
            ],
            "Prefers concise replies.",
            "The user stated a stable communication preference.",
            LanguageContext(
                ui_locale=SupportedLocale.ZH_CN,
                agent_reply_locale=SupportedLocale.ZH_CN,
                ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
                agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT,
            ),
        ),
        (
            [
                {"role": "user", "content": "以后请简洁回复。"},
                {"role": "assistant", "content": "好的，我会保持简洁。"},
            ],
            "偏好简洁回复。",
            "用户表达了稳定的沟通偏好。",
            LanguageContext(
                ui_locale=SupportedLocale.EN_US,
                agent_reply_locale=SupportedLocale.EN_US,
                ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
                agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT,
            ),
        ),
    ],
)
def test_memory_capture_preserves_source_language_independent_of_locale(
    monkeypatch,
    source_messages: list[dict[str, str]],
    memory_content: str,
    memory_reason: str,
    context: LanguageContext,
) -> None:
    """Keep source evidence and derived fact language independent from UI/reply locale."""
    captured: dict[str, object] = {}

    def fake_init(self, model_config):
        """Avoid constructing a real provider client in the unit test."""
        del self, model_config

    def fake_generate_json(self, system_prompt, payload):
        """Capture the exact extraction contract and return a source-language memory."""
        del self
        captured["system_prompt"] = system_prompt
        captured["payload"] = payload
        return {
            "memories": [
                {
                    "operation": "upsert",
                    "kind": "preference",
                    "key": "communication_style",
                    "content": memory_content,
                    "importance": 0.85,
                    "reason": memory_reason,
                }
            ],
            "updated_summary": "",
        }

    monkeypatch.setattr(LLMClient, "__init__", fake_init)
    monkeypatch.setattr(LLMClient, "generate_json", fake_generate_json)

    with _memory_test_session() as db:
        saved = MemoryService(db).capture_turn(
            ChatTurnRequest(
                tenant_id="tenant_demo",
                user_id="user_demo",
                message=source_messages[0]["content"],
                language_context=context,
            ),
            ChatSession(id="session_test", tenant_id="tenant_demo", user_id="user_demo"),
            StepAgentResult(),
            None,
            ModelConfig(
                tenant_id="tenant_demo",
                name="demo",
                api_key_encrypted="",
                model="demo",
            ),
            source_messages,
            language_context=context,
        )
        db.commit()
        saved_content = saved[0].content
        saved_reason = saved[0].metadata_json["reason"]

    system_prompt = str(captured["system_prompt"])
    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert "你是用户长期记忆" not in system_prompt
    assert "preserve the source language" in system_prompt.lower()
    assert payload["conversation_context"]["messages"] == source_messages
    assert payload["language_context"] == context.model_dump(mode="json")
    assert payload["memory_language_policy"] == {
        "content_language": "preserve_source_language",
        "reason_language": "preserve_source_language",
        "locale_context_role": "diagnostics_only",
        "translation": "forbidden",
    }
    assert payload["raw_source_markers"] == [
        {
            "json_pointer": "/conversation_context",
            "kind": "history",
            "policy": "preserve_verbatim",
        },
        {
            "json_pointer": "/existing_memories",
            "kind": "business_record",
            "policy": "preserve_verbatim",
        },
        {
            "json_pointer": "/step_result",
            "kind": "business_record",
            "policy": "preserve_verbatim",
        },
    ]
    assert "language_directive" not in payload
    assert saved_content == memory_content
    assert saved_reason == memory_reason


@pytest.mark.parametrize("persist_snapshot", [True, False])
def test_memory_worker_recovers_language_context_without_changing_history(
    monkeypatch,
    persist_snapshot: bool,
) -> None:
    """Forward a durable or legacy-recovered locale snapshot while retaining raw history."""
    captured: dict[str, object] = {}
    context = LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.SESSION_SNAPSHOT,
    )
    raw_messages = [
        {"role": "user", "content": "My preferred name is René."},
        {"role": "assistant", "content": "Understood, René."},
    ]
    test_engine = _memory_test_engine()
    request = ChatTurnRequest(
        tenant_id="tenant_demo",
        user_id="user_demo",
        client_turn_id="client_turn_memory",
        message=raw_messages[0]["content"],
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
        language_context=context if persist_snapshot else None,
    )

    # Workflow: seed the durable turn that the background worker must reconstruct.
    with Session(test_engine) as db:
        db.add_all(
            [
                ChatSession(
                    id="session_test",
                    tenant_id="tenant_demo",
                    user_id="user_demo",
                ),
                ModelConfig(
                    id="model_test",
                    tenant_id="tenant_demo",
                    name="demo",
                    api_key_encrypted="",
                    model="demo",
                ),
                AgentEvent(
                    tenant_id="tenant_demo",
                    session_id="session_test",
                    event_type="user_message_received",
                    payload_json={
                        "client_turn_id": "client_turn_memory",
                        "turn_id": "message_user",
                    },
                ),
                Message(
                    id="message_user",
                    tenant_id="tenant_demo",
                    session_id="session_test",
                    role="user",
                    content=raw_messages[0]["content"],
                ),
                Message(
                    id="message_assistant",
                    tenant_id="tenant_demo",
                    session_id="session_test",
                    role="assistant",
                    content=raw_messages[1]["content"],
                    metadata_json={"turn_id": "message_user"},
                ),
            ]
        )
        db.commit()

    def fake_capture_turn(self, *args, language_context):
        """Capture the worker-to-service handoff without invoking an external model."""
        del self
        captured["messages"] = args[-1]
        captured["language_context"] = language_context
        return []

    monkeypatch.setattr(memory_jobs, "engine", test_engine)
    monkeypatch.setattr(MemoryService, "capture_turn", fake_capture_turn)
    payload = {
        "request": request.model_dump(mode="json"),
        "language_context": context.model_dump(mode="json") if persist_snapshot else None,
        "session_id": "session_test",
        "step_result": StepAgentResult().model_dump(mode="json"),
        "tool_result": None,
        "model_config_id": "model_test",
    }

    memory_jobs.run_memory_capture_job(payload)

    assert captured["messages"] == raw_messages
    recovered = captured["language_context"]
    assert isinstance(recovered, LanguageContext)
    assert recovered.ui_locale is SupportedLocale.EN_US
    assert recovered.agent_reply_locale is SupportedLocale.EN_US
    if persist_snapshot:
        assert recovered == context
    else:
        assert recovered.ui_locale_source is LocaleResolutionSource.USER_PREFERENCE
        assert recovered.agent_reply_locale_source is LocaleResolutionSource.SESSION_SNAPSHOT


def _memory_test_engine():
    """Create an isolated in-memory database with the production SQLModel metadata."""
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(test_engine)
    return test_engine


def _memory_test_session() -> Session:
    """Open one isolated database session for memory extraction tests."""
    return Session(_memory_test_engine())
