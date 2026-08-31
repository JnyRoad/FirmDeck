"""Contract tests for locale propagation through Skill authoring paths."""

from __future__ import annotations

from types import SimpleNamespace

from app.api import skills as skills_api
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.skills.skill_distiller import SkillDistiller
from app.skills.skill_editor import SkillEditor
from app.skills.skill_reflection import reflect_skill_response_stream
from app.skills.skill_schema import (
    SkillCard,
    SkillDistillRequest,
    SkillDistillResponse,
    SkillRewriteRequest,
)
from app.skills.stream_jobs import SkillStreamJobStore


def _language_context(locale: SupportedLocale) -> LanguageContext:
    """Build a deterministic request snapshot for one supported locale."""
    return LanguageContext(
        ui_locale=locale,
        agent_reply_locale=locale,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )


def _skill_card() -> SkillCard:
    """Build the smallest valid graph used by Skill authoring contract tests."""
    return SkillCard.model_validate(
        {
            "skill_id": "language-contract",
            "name": "Language contract",
            "version": "1.0.0",
            "business_domain": "general",
            "description": "A raw skill fixture.",
            "trigger_intents": ["run"],
            "user_utterance_examples": ["run"],
            "goal": ["return a result"],
            "required_info": [],
            "slot_filling_policy": {
                "enabled": True,
                "multi_slot_per_turn": True,
                "extract_scope": "all_skill_expected_user_info",
                "skip_satisfied_steps": True,
            },
            "response_rules": [],
            "nodes": [
                {
                    "node_id": "reply",
                    "type": "response",
                    "name": "Reply",
                    "instruction": "Return the result.",
                    "optional": False,
                    "condition": None,
                    "expected_user_info": [],
                    "allowed_actions": ["answer_user"],
                    "capability_refs": {},
                    "knowledge_scope": {},
                    "retry_policy": {},
                    "metadata": {},
                    "sub_sop_id": None,
                }
            ],
            "edges": [],
            "start_node_id": "reply",
            "terminal_node_ids": ["reply"],
            "interruption_policy": {},
        }
    )


def test_skill_requests_carry_independent_locale_fields_and_snapshot() -> None:
    """Distill and rewrite requests must accept the two locale dimensions and one snapshot."""
    context = _language_context(SupportedLocale.EN_US)
    distill = SkillDistillRequest(
        tenant_id="tenant_demo",
        title="Raw title",
        raw_content="Raw source content",
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.ZH_CN,
        language_context=context,
    )
    rewrite = SkillRewriteRequest(
        tenant_id="tenant_demo",
        current_skill=_skill_card(),
        instruction="Raw rewrite instruction",
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.ZH_CN,
        language_context=context,
    )

    assert distill.ui_locale is SupportedLocale.EN_US
    assert distill.agent_reply_locale is SupportedLocale.ZH_CN
    assert distill.language_context == context
    assert rewrite.ui_locale is SupportedLocale.EN_US
    assert rewrite.agent_reply_locale is SupportedLocale.ZH_CN
    assert rewrite.language_context == context


def test_skill_model_payload_contains_language_contract_and_raw_markers() -> None:
    """Both authoring prompts must receive the reply locale while protecting source-owned values."""
    context = _language_context(SupportedLocale.EN_US)
    distill_request = SkillDistillRequest(
        tenant_id="tenant_demo",
        title="原始标题",
        raw_content="原始流程正文",
        language_context=context,
    )
    rewrite_request = SkillRewriteRequest(
        tenant_id="tenant_demo",
        current_skill=_skill_card(),
        instruction="保留原文中的标识符",
        language_context=context,
    )

    distill_payload = SkillDistiller()._payload(distill_request)  # noqa: SLF001
    rewrite_payload = SkillEditor()._payload(rewrite_request)  # noqa: SLF001

    for payload in (distill_payload, rewrite_payload):
        assert payload["language_context"]["agent_reply_locale"] == "en-US"
        assert payload["language_directive"]["new_prose_locale"] == "en-US"
        pointers = {marker["json_pointer"] for marker in payload["raw_source_markers"]}
        assert "/title" in pointers or "/current_skill" in pointers
        assert "/raw_content" in pointers or "/instruction" in pointers


def test_reflection_payload_preserves_the_same_language_snapshot() -> None:
    """Reflection retries must keep the original snapshot instead of reading mutable preferences."""
    context = _language_context(SupportedLocale.EN_US)
    captured: list[dict[str, object]] = []

    class FakeClient:
        """Capture reflection input and return a passing review without provider side effects."""

        def generate_text(self, _prompt: str, payload: dict[str, object]) -> str:
            captured.append(payload)
            return '{"passed": true, "summary": "ok"}'

    response = SkillDistillResponse(draft_skill=_skill_card(), language_context=context)
    events = reflect_skill_response_stream(
        client=FakeClient(),
        source_kind="distill",
        source_payload={"language_context": context.model_dump(mode="json")},
        response=response,
        candidate_skill=response.draft_skill,
        current_warnings=[],
        tool_suggestions=[],
        normalize_response=lambda raw: response,
        language_context=context,
    )
    list(events)

    assert captured
    assert captured[0]["language_context"]["agent_reply_locale"] == "en-US"
    assert captured[0]["language_directive"]["new_prose_locale"] == "en-US"


def test_reflection_compatibility_messages_follow_reply_locale() -> None:
    """Reflection-owned status and fallback warning prose must use the bound reply locale."""
    context = _language_context(SupportedLocale.EN_US)

    class FailingClient:
        """Force the deterministic reflection failure branch without exposing provider text."""

        def generate_text(self, _prompt: str, _payload: dict[str, object]) -> str:
            raise ValueError("private provider diagnostic")

    response = SkillDistillResponse(draft_skill=_skill_card(), language_context=context)
    events = reflect_skill_response_stream(
        client=FailingClient(),
        source_kind="distill",
        source_payload={},
        response=response,
        candidate_skill=response.draft_skill,
        current_warnings=[],
        tool_suggestions=[],
        normalize_response=lambda raw: response,
        language_context=context,
    )

    emitted = list(events)
    status_texts = [
        str(event["data"].get("text"))
        for event in emitted
        if event.get("event") == "status" and isinstance(event.get("data"), dict)
    ]

    assert status_texts[0].startswith("Validating the Skill result")
    assert status_texts[-1] == "Validation failed; the current Skill draft was preserved."


def test_skill_job_locale_comes_from_request_before_user_preference() -> None:
    """A durable job must snapshot explicit request locales before the user's mutable preference."""
    request = SkillDistillRequest(
        tenant_id="tenant_demo",
        title="Raw title",
        raw_content="Raw content",
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
    )
    user = SimpleNamespace(
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=SupportedLocale.ZH_CN,
    )

    context = skills_api._skill_language_context(request, user)  # noqa: SLF001

    assert context.ui_locale is SupportedLocale.EN_US
    assert context.agent_reply_locale is SupportedLocale.EN_US
    assert context.ui_locale_source is LocaleResolutionSource.EXPLICIT_REQUEST
    assert context.agent_reply_locale_source is LocaleResolutionSource.EXPLICIT_REQUEST


def test_skill_stream_replay_keeps_locale_and_drops_legacy_status_prose() -> None:
    """Replayable SSE keeps the job snapshot and only approved raw output."""
    context = _language_context(SupportedLocale.EN_US)
    store = SkillStreamJobStore()
    job = store.create("skill.distill", "tenant_demo", "user_demo", language_context=context)

    store.append(job.id, "status", {"text": "模型正在生成技能"})
    store.append(job.id, "chunk", {"content": "用户原始技能内容"})

    snapshot, events = store.snapshot(job.id)

    assert snapshot is not None
    assert snapshot.language_context == context
    assert events[0].data["language_context"]["agent_reply_locale"] == "en-US"
    assert "text" not in events[0].data
    assert events[1].data["raw_success"] is True
    assert events[1].data["content"] == "用户原始技能内容"
    assert events[1].data["language_context"]["ui_locale"] == "en-US"


def test_skill_worker_restores_job_locale_after_request_serialization() -> None:
    """A worker restores the queued snapshot when request JSON omits private context."""
    context = _language_context(SupportedLocale.EN_US)
    store = SkillStreamJobStore()
    job = store.create("skill.rewrite", "tenant_demo", "user_demo", language_context=context)
    request = SkillDistillRequest(
        tenant_id="tenant_demo",
        title="Raw title",
        raw_content="Raw content",
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=SupportedLocale.ZH_CN,
    )

    original_store = skills_api.stream_jobs
    skills_api.stream_jobs = store
    try:
        restored = skills_api._bind_skill_request_to_job_locale(  # noqa: SLF001
            job.id,
            request,
        )
    finally:
        skills_api.stream_jobs = original_store

    assert restored.language_context == context


def test_skill_job_creation_persists_locale_in_queue_metadata(monkeypatch) -> None:
    """Durable enqueue metadata and worker args must both retain the immutable request snapshot."""
    request = SkillDistillRequest(
        tenant_id="tenant_demo",
        title="Raw title",
        raw_content="Raw content",
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
    )
    user = SimpleNamespace(
        id="user_demo",
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=SupportedLocale.ZH_CN,
    )
    store = SkillStreamJobStore()
    captured: dict[str, object] = {}

    def fake_enqueue(
        name: str,
        function: object,
        *args: object,
        metadata: dict[str, object],
    ) -> None:
        """Capture the queue contract without starting an asynchronous worker."""
        captured.update({"name": name, "function": function, "args": args, "metadata": metadata})

    monkeypatch.setattr(skills_api, "stream_jobs", store)
    monkeypatch.setattr(skills_api, "enqueue_async_job", fake_enqueue)

    job_id = skills_api._start_distill_stream_job(request, user)  # noqa: SLF001
    metadata = captured["metadata"]
    args = captured["args"]

    assert isinstance(metadata, dict)
    assert metadata["language_context"]["agent_reply_locale"] == "en-US"
    assert isinstance(args, tuple)
    assert args[1]["ui_locale"] == "en-US"
    assert args[1]["agent_reply_locale"] == "en-US"
    assert store.get(job_id).language_context.agent_reply_locale is SupportedLocale.EN_US
