from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.api import general_skills as general_skills_api
from app.db.models import ChatSession
from app.general_skills.schema import GeneralSkillRunRequest, GeneralSkillRunResponse
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.session.session_schema import ChatTurnResponse


def _english_context() -> LanguageContext:
    """Build the explicit English snapshot used by the route propagation tests."""
    return LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
        agent_reply_locale_source=LocaleResolutionSource.EXPLICIT_REQUEST,
    )


def _request(*, operation: str = "execute", query: str = "raw query") -> GeneralSkillRunRequest:
    """Build a General Skill request with an immutable explicit locale snapshot."""
    context = _english_context()
    return GeneralSkillRunRequest(
        tenant_id="tenant_demo",
        agent_id="agent_demo",
        user_id="user_demo",
        query=query,
        operation=operation,
        ui_locale=context.ui_locale,
        agent_reply_locale=context.agent_reply_locale,
        language_context=context,
    )


def _patch_sync_route(monkeypatch) -> None:
    """Stub authorization and resource lookup so sync route tests isolate locale propagation."""
    monkeypatch.setattr(
        general_skills_api,
        "_get_general_skill",
        lambda *_args, **_kwargs: SimpleNamespace(status="published"),
    )
    monkeypatch.setattr(
        general_skills_api,
        "_general_skill_snapshot",
        lambda row: row,
    )
    monkeypatch.setattr(
        general_skills_api,
        "_get_request_model",
        lambda *_args, **_kwargs: SimpleNamespace(id="model_demo"),
    )
    monkeypatch.setattr(
        general_skills_api,
        "require_agent_scope_viewer",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        general_skills_api,
        "_ensure_general_skill_visible",
        lambda *_args, **_kwargs: None,
    )


def test_sync_read_route_passes_explicit_language_context_to_reader(monkeypatch) -> None:
    """Keep explicit UI and reply locales when the synchronous read route invokes the reader."""
    _patch_sync_route(monkeypatch)
    captured: dict[str, object] = {}

    class FakeReader:
        """Capture the route-to-reader language boundary without an LLM call."""

        def read(self, skill, query, model_config, **kwargs):
            captured.update({"skill": skill, "query": query, **kwargs})
            return GeneralSkillRunResponse(
                skill_slug="raw-skill",
                operation="read",
                reply="raw reader reply",
            )

    monkeypatch.setattr(general_skills_api, "GeneralSkillReader", FakeReader)
    context = _english_context()

    response = general_skills_api.run_general_skill(
        "raw-skill",
        _request(operation="read", query="用户原始 query"),
        object(),
        SimpleNamespace(id="user_demo"),
    )

    assert captured["query"] == "用户原始 query"
    assert captured["language_context"] == context
    assert response.language_context == context


def test_explicit_locale_fields_are_resolved_into_one_snapshot() -> None:
    """Turn scalar locale fields into the same explicit snapshot used by downstream runners."""
    request = GeneralSkillRunRequest(
        tenant_id="tenant_demo",
        query="raw query",
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
    )

    normalized = general_skills_api._general_skill_request_with_language_context(request)

    assert normalized.language_context is not None
    assert normalized.language_context.ui_locale is SupportedLocale.EN_US
    assert normalized.language_context.agent_reply_locale is SupportedLocale.EN_US
    assert (
        normalized.language_context.ui_locale_source
        is LocaleResolutionSource.EXPLICIT_REQUEST
    )
    assert (
        normalized.language_context.agent_reply_locale_source
        is LocaleResolutionSource.EXPLICIT_REQUEST
    )


def test_sync_execute_route_passes_explicit_language_context_to_runner(monkeypatch) -> None:
    """Keep explicit UI and reply locales when the synchronous execute route invokes the runner."""
    _patch_sync_route(monkeypatch)
    captured: dict[str, object] = {}

    class FakeRunner:
        """Capture the route-to-runner language boundary without running a sandbox."""

        def run(self, skill, query, model_config, user_id, max_attempts, event_sink, **kwargs):
            captured.update(
                {
                    "skill": skill,
                    "query": query,
                    "user_id": user_id,
                    "max_attempts": max_attempts,
                    "event_sink": event_sink,
                    **kwargs,
                }
            )
            return GeneralSkillRunResponse(skill_slug="raw-skill", reply="raw runner reply")

    monkeypatch.setattr(general_skills_api, "GeneralSkillRunner", FakeRunner)
    context = _english_context()

    response = general_skills_api.run_general_skill(
        "raw-skill",
        _request(query="用户原始 execute query"),
        object(),
        SimpleNamespace(id="user_demo"),
    )

    assert captured["query"] == "用户原始 execute query"
    assert captured["language_context"] == context
    assert response.language_context == context


async def _consume_stream(response) -> str:
    """Consume a StreamingResponse body in the same way the API test client does."""
    chunks = [chunk async for chunk in response.body_iterator]
    return "".join(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk for chunk in chunks)


def test_stream_execute_persists_locale_and_forwards_raw_query(monkeypatch) -> None:
    """Persist the debug session reply locale and pass the same snapshot into the Harness turn."""
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(test_engine)
    captured: dict[str, object] = {}
    context = _english_context()

    monkeypatch.setattr(general_skills_api, "engine", test_engine)
    monkeypatch.setattr(
        general_skills_api,
        "_get_general_skill",
        lambda *_args, **_kwargs: SimpleNamespace(status="published", name="Raw Skill", slug="raw-skill"),
    )
    monkeypatch.setattr(
        general_skills_api,
        "_general_skill_snapshot",
        lambda row: row,
    )
    monkeypatch.setattr(
        general_skills_api,
        "_get_request_model",
        lambda *_args, **_kwargs: SimpleNamespace(id="model_demo"),
    )
    monkeypatch.setattr(
        general_skills_api,
        "require_agent_scope_viewer",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        general_skills_api,
        "_ensure_general_skill_visible",
        lambda *_args, **_kwargs: None,
    )

    def fake_handle_turn(self, request):
        captured["request"] = request
        return ChatTurnResponse(
            reply="raw harness reply",
            session_id=request.session_id or "",
            language_context=request.language_context,
            session_state={
                "session_id": request.session_id or "",
                "tenant_id": request.tenant_id,
                "status": "active",
            },
        )

    monkeypatch.setattr(general_skills_api.AgentLoop, "handle_turn", fake_handle_turn)
    request = _request(query="原始 Skill 查询 /keep", operation="execute")

    with Session(test_engine) as db:
        response = general_skills_api.run_general_skill_stream(
            "raw-skill",
            request,
            db,
            SimpleNamespace(id="user_demo"),
        )
        body = __import__("asyncio").run(_consume_stream(response))
        debug_session = db.exec(select(ChatSession)).one()

    harness_request = captured["request"]
    assert harness_request.language_context == context
    assert harness_request.ui_locale is SupportedLocale.EN_US
    assert harness_request.agent_reply_locale is SupportedLocale.EN_US
    assert harness_request.message == "/skill raw-skill 原始 Skill 查询 /keep"
    assert debug_session.agent_reply_locale == "en-US"
    assert debug_session.agent_reply_locale_source == "explicit_request"
    assert '"language_context"' in body
    assert '"agent_reply_locale": "en-US"' in body
