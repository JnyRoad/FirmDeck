"""Focused T075 coverage for Agent, Skill, scheduled-task and team errors."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.agents.branching import require_overall_agent
from app.api import agents, general_skills, skills
from app.contracts.domain_http import domain_http_error
from app.db.models import GeneralSkill
from app.general_skills.runner import GeneralSkillReader
from app.llm import LLMClient, LLMError
from app.scheduled_tasks.service import _normalize_schedule_type
from app.teams.service import add_member


class _EmptyResult:
    """Minimal SQLModel result stub for pure missing-resource guard tests."""

    def first(self):
        return None


class _MissingResourceDB:
    """Return an existing tenant but no requested product resource."""

    def get(self, model, identifier):
        return object() if getattr(model, "__name__", "") == "Tenant" else None

    def exec(self, statement):
        return _EmptyResult()


def _assert_canonical(exc: HTTPException, code: str) -> None:
    """Require the public detail to be a stable descriptor and never raw exception prose."""
    assert isinstance(exc.detail, dict)
    assert exc.detail["code"] == code
    assert "message" not in exc.detail
    assert "detail" not in exc.detail
    assert "raw" not in repr(exc.detail)


def test_domain_adapter_keeps_caught_cause_private() -> None:
    """A provider/path cause may be logged privately but cannot reach HTTP detail."""
    exc = domain_http_error(
        "GENERAL_SKILL_REMOTE_JSON_INVALID",
        source="test",
        status_code=400,
        cause=ValueError("provider-secret /private/source.json"),
    )

    _assert_canonical(exc, "GENERAL_SKILL_REMOTE_JSON_INVALID")
    internal = exc._internal_error_context
    assert internal.raw_message == "provider-secret /private/source.json"
    assert "provider-secret" not in repr(exc.detail)
    assert "/private/source.json" not in repr(exc.detail)


def test_agent_resource_errors_use_canonical_codes_without_identifiers() -> None:
    """Agent missing/resource failures do not expose employee or resource identifiers."""
    with pytest.raises(HTTPException) as missing_agent:
        agents._get_agent(_MissingResourceDB(), "tenant-1", "employee-secret")
    _assert_canonical(missing_agent.value, "AGENT_NOT_FOUND")
    assert "employee-secret" not in repr(missing_agent.value.detail)

    with pytest.raises(HTTPException) as missing_resource:
        agents._ensure_resource_exists(
            _MissingResourceDB(),
            "tenant-1",
            SimpleNamespace(resource_type="tool", resource_id="tool-secret"),
        )
    _assert_canonical(missing_resource.value, "AGENT_RESOURCE_NOT_FOUND")
    assert "tool-secret" not in repr(missing_resource.value.detail)


def test_skill_and_general_skill_boundaries_use_registered_codes() -> None:
    """File import and SOP lookup errors remain localizable without raw file data."""
    with pytest.raises(HTTPException) as skill_file:
        skills._extract_uploaded_skill_file("payload.secret", b"not-a-document")
    _assert_canonical(skill_file.value, "SKILL_FILE_TYPE_UNSUPPORTED")

    with pytest.raises(HTTPException) as general_file:
        general_skills._decode_base64_payload("not-base64")
    _assert_canonical(general_file.value, "GENERAL_SKILL_CONTENT_INVALID_BASE64")


def test_schedule_and_team_validation_use_named_safe_params() -> None:
    """Safe enum/field metadata is named; arbitrary user input never becomes message text."""
    with pytest.raises(HTTPException) as schedule:
        _normalize_schedule_type("provider-controlled-value")
    _assert_canonical(schedule.value, "SCHEDULED_TASK_TYPE_UNSUPPORTED")
    assert schedule.value.detail["params"] == {}

    with pytest.raises(HTTPException) as team:
        add_member(None, None, agent_id="employee-secret", role="provider-controlled-role")
    _assert_canonical(team.value, "TEAM_MEMBER_ROLE_INVALID")
    assert team.value.detail["params"] == {"role": "unknown"}


def test_general_skill_reader_does_not_return_llm_cause(monkeypatch: pytest.MonkeyPatch) -> None:
    """The natural-language reply is localized, while the raw LLM failure stays diagnostic-only."""
    monkeypatch.setattr(LLMClient, "__init__", lambda self, model_config: None)

    def fail_generate(self, system_prompt, payload):
        raise LLMError("provider-secret /private/model-response")

    monkeypatch.setattr(LLMClient, "generate_json", fail_generate)
    response = GeneralSkillReader().read(
        GeneralSkill(
            tenant_id="tenant-1",
            slug="safe-skill",
            name="Raw employee name",
            skill_markdown="# Raw business content",
            status="published",
        ),
        "Raw user input",
        SimpleNamespace(),
    )

    assert response.stderr == ""
    assert response.structured_result["error_code"] == "GENERAL_SKILL_READ_FAILED"
    assert "provider-secret" not in repr(response.model_dump())
    assert "/private/model-response" not in repr(response.model_dump())


def test_overall_resource_guard_projects_canonical_error() -> None:
    """Agent branch guards use the same descriptor contract as API routes."""
    with pytest.raises(HTTPException) as exc:
        require_overall_agent(_MissingResourceDB(), "tenant-1", "employee-secret")
    _assert_canonical(exc.value, "AGENT_OVERALL_ONLY_REQUIRED")
