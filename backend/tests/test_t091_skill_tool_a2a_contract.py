"""RED tests for the T091 stream, tool, knowledge, and outbound A2A contracts."""

from __future__ import annotations

import json

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.a2a import codex_adapter
from app.db.models import A2ATaskRun, Tenant, Tool
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.knowledge.errors import KnowledgeError
from app.skills.stream_jobs import SkillStreamJobStore
from app.tools import a2a_recovery
from app.tools.a2a_recovery import _recovery_error_payload
from app.tools.tool_schema import ToolError


def test_tool_error_fails_closed_when_known_code_has_extra_params() -> None:
    """Known Tool codes must use the registry's exact parameter set."""
    error = ToolError(
        code="MCP_ERROR",
        message="remote secret must stay private",
        params={"transport": "stdio"},
    )

    assert error.to_descriptor().code == "INTERNAL_ERROR"
    assert error.to_descriptor().params == {}
    assert "remote secret" not in repr(error.model_dump(mode="json"))


def test_knowledge_error_fails_closed_when_known_code_has_extra_params() -> None:
    """Knowledge descriptors must reject bounded-but-unregistered legacy details."""
    error = KnowledgeError(
        "KNOWLEDGE_MODE_INVALID",
        message="provider detail must stay private",
        details={"knowledge_base_id": "kb-private"},
    )

    assert error.to_descriptor().code == "INTERNAL_ERROR"
    assert error.to_public_payload()["code"] == "INTERNAL_ERROR"
    assert "provider detail" not in repr(error.to_public_payload())


def test_skill_stream_failure_is_a_descriptor_and_status_has_no_raw_text() -> None:
    """Skill SSE failures/statuses must carry stable metadata, never legacy prose."""
    store = SkillStreamJobStore()
    job = store.create("skill.distill", "tenant_demo", "user_demo")
    store.append(job.id, "status", {"text": "正在调用模型生成新技能"})
    store.fail(job.id, "SKILL_UPSTREAM_FAILURE", raw_context=RuntimeError("provider secret"))

    snapshot, events = store.snapshot(job.id)
    assert snapshot is not None
    assert snapshot.error is not None
    assert snapshot.error.code == "SKILL_UPSTREAM_FAILURE"
    assert events[0].data["code"] == "sop.generate.learning"
    assert "text" not in events[0].data
    assert "provider secret" not in repr(events)


def test_codex_remote_error_event_is_projected_but_success_event_keeps_raw_content() -> None:
    """Codex event classification must preserve successful content and hide remote diagnostics."""
    raw_text = "customer response must remain byte-for-byte / source.md"
    success = codex_adapter._classify_codex_event(
        {"type": "item.completed", "item": {"type": "agent_message", "text": raw_text}}
    )
    failure = codex_adapter._classify_codex_event(
        {
            "type": "error",
            "message": "provider token=do-not-publish",
            "error": {"code": "remote_secret"},
        }
    )

    assert success["raw_success"] is True
    assert success["content"] == raw_text
    assert failure["error"]["code"] == "A2A_TASK_FAILED"
    assert "provider token" not in json.dumps(failure)


def test_a2a_recovery_locale_conflict_uses_exact_registry_params() -> None:
    """Recovery locale conflicts must use requested/session, not legacy snapshot fields."""
    payload = _recovery_error_payload(
        "AGENT_REPLY_LOCALE_CONFLICT",
        params={"requested": "en-US", "session": "zh-CN"},
    )

    assert payload["code"] == "AGENT_REPLY_LOCALE_CONFLICT"
    assert payload["params"] == {"requested": "en-US", "session": "zh-CN"}


def test_a2a_recovery_passes_the_durable_language_snapshot_to_tool_executor(
    monkeypatch,
) -> None:
    """Resume an outbound A2A invocation with its persisted locale, not a default."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    context = LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )
    with Session(engine) as db:
        db.add_all(
            [
                Tenant(id="tenant-a2a-recovery", name="A2A recovery"),
                Tool(
                    id="tool-a2a-recovery",
                    tenant_id="tenant-a2a-recovery",
                    name="a2a.recovery",
                    tool_type="a2a",
                    method="POST",
                    url="https://agent.example.test/a2a",
                    enabled=True,
                ),
                A2ATaskRun(
                    id="a2arun-language-recovery",
                    owner_scope="tenant",
                    direction="client",
                    tenant_id="tenant-a2a-recovery",
                    system_runtime_key=None,
                    tenant_lifecycle_version=1,
                    tool_id="tool-a2a-recovery",
                    invocation_id="invocation-a2a-recovery",
                    endpoint_url="https://agent.example.test/a2a",
                    status="submitted",
                    request_json={"arguments": {"text": "raw input"}},
                    language_context_json=context.model_dump(mode="json"),
                ),
            ]
        )
        db.commit()

    captured: dict[str, object] = {}

    def fake_execute(self, *args, **kwargs):
        """Capture the recovery boundary without contacting the remote Agent."""
        del self, args
        captured.update(kwargs)
        return None

    monkeypatch.setattr(a2a_recovery, "engine", engine)
    monkeypatch.setattr(a2a_recovery.ToolExecutor, "execute", fake_execute)

    a2a_recovery._recover_one("a2arun-language-recovery")

    assert captured["language_context"] == context
