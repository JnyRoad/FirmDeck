"""Define observable compatibility and fail-closed removal contracts for i18n migration."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol, cast

from app.contracts import projections
from app.contracts.error_registry import build_default_error_registry
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext
from app.i18n import language_context
from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)


class _ProjectionCompatibilityApi(Protocol):
    """Describe the explicit backend usage and removal API required from T065."""

    reset_compatibility_usage: Callable[[], None]
    get_compatibility_usage: Callable[[], dict[str, Any]]
    evaluate_compatibility_removal_readiness: Callable[..., dict[str, Any]]


class _LanguageCompatibilityApi(Protocol):
    """Describe dual-read/write helpers required during the additive schema window."""

    resolve_compatible_language_context: Callable[..., LanguageContext]
    language_context_write_fields: Callable[[LanguageContext], dict[str, Any]]


def _require_projection_compatibility_api() -> _ProjectionCompatibilityApi:
    """Return projection governance hooks or fail with the exact missing T065 capability."""
    required = (
        "reset_compatibility_usage",
        "get_compatibility_usage",
        "evaluate_compatibility_removal_readiness",
    )
    for function_name in required:
        if not callable(getattr(projections, function_name, None)):
            raise TypeError(
                f"backend compatibility governance is not implemented: {function_name}"
            )
    return cast(_ProjectionCompatibilityApi, projections)


def _require_language_compatibility_api() -> _LanguageCompatibilityApi:
    """Return dual-read/write hooks or fail with the exact missing T065 capability."""
    required = (
        "resolve_compatible_language_context",
        "language_context_write_fields",
    )
    for function_name in required:
        if not callable(getattr(language_context, function_name, None)):
            raise TypeError(
                f"language compatibility adapter is not implemented: {function_name}"
            )
    return cast(_LanguageCompatibilityApi, language_context)


def _knowledge_occurrence() -> ErrorOccurrence:
    """Build one safe registered occurrence with a seeded private cause for leakage checks."""
    return ErrorOccurrence(
        descriptor=ErrorDescriptor(
            code="KNOWLEDGE_UPSTREAM_TIMEOUT",
            params={"provider_id": "provider-1"},
            retryable=True,
            request_id="req-compat",
            trace_id="trace-compat",
        ),
        internal=InternalErrorContext(
            source="provider",
            exception_type="TimeoutError",
            raw_message="secret upstream timeout token=do-not-record",
        ),
    )


def test_public_compatibility_projection_reports_bounded_usage() -> None:
    """Count the registered projection boundary without retaining descriptor params or raw causes."""
    payload = projections.project_problem_details(
        _knowledge_occurrence(),
        build_default_error_registry(),
    )
    assert payload["code"] == "KNOWLEDGE_UPSTREAM_TIMEOUT"

    compatibility = _require_projection_compatibility_api()
    compatibility.reset_compatibility_usage()
    projections.project_problem_details(
        _knowledge_occurrence(),
        build_default_error_registry(),
    )
    usage = compatibility.get_compatibility_usage()
    boundary = usage["boundaries"]["LEGACY-PUBLIC-TEXT-PROJECTION"]

    assert usage["version"] == 1
    assert boundary["version"] == 1
    assert boundary["hits"] == 1
    assert "provider-1" not in repr(usage)
    assert "do-not-record" not in repr(usage)


def test_language_context_prefers_canonical_snapshot_and_dual_writes_for_old_reader() -> None:
    """Prefer the canonical snapshot while writing legacy scalar fields an old reader still consumes."""
    compatibility = _require_language_compatibility_api()
    canonical = LanguageContext(
        ui_locale=SupportedLocale.EN_US,
        agent_reply_locale=SupportedLocale.EN_US,
        ui_locale_source=LocaleResolutionSource.TASK_SNAPSHOT,
        agent_reply_locale_source=LocaleResolutionSource.TASK_SNAPSHOT,
    )

    resolved = compatibility.resolve_compatible_language_context(
        snapshot=canonical.model_dump(mode="json"),
        legacy_ui_locale="zh-CN",
        legacy_agent_reply_locale="zh-CN",
    )
    write_fields = compatibility.language_context_write_fields(resolved)

    assert resolved == canonical
    assert write_fields["language_context_json"] == canonical.model_dump(mode="json")
    assert write_fields["ui_locale"] == "en-US"
    assert write_fields["agent_reply_locale"] == "en-US"
    assert write_fields["agent_reply_locale_source"] == "task_snapshot"
    assert write_fields["agent_reply_locale"] == resolved.agent_reply_locale.value


def test_language_context_reads_legacy_fields_and_records_default_backfill() -> None:
    """Read old scalar records, backfill absent records deterministically, and expose fallback usage."""
    compatibility = _require_projection_compatibility_api()
    language_adapter = _require_language_compatibility_api()
    compatibility.reset_compatibility_usage()

    legacy = language_adapter.resolve_compatible_language_context(
        snapshot=None,
        legacy_ui_locale="en-US",
        legacy_agent_reply_locale="en-US",
    )
    backfilled = language_adapter.resolve_compatible_language_context(
        snapshot=None,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=None,
    )
    usage = compatibility.get_compatibility_usage()

    assert legacy.ui_locale is SupportedLocale.EN_US
    assert legacy.agent_reply_locale is SupportedLocale.EN_US
    assert backfilled.ui_locale is SupportedLocale.ZH_CN
    assert backfilled.agent_reply_locale is SupportedLocale.ZH_CN
    assert backfilled.ui_locale_source is LocaleResolutionSource.LEGACY_DEFAULT
    assert usage["boundaries"]["LEGACY-LANGUAGE-DEFAULT"]["hits"] == 1


def test_backend_removal_readiness_fails_closed_for_unknown_and_non_zero_usage() -> None:
    """Block removal when telemetry is missing or any exact compatibility boundary still has hits."""
    compatibility = _require_projection_compatibility_api()
    passing_gates = {
        "static_checks_passed": True,
        "browser_matrix_passed": True,
        "external_client_window_open": False,
    }

    unknown = compatibility.evaluate_compatibility_removal_readiness(
        usage=None,
        **passing_gates,
    )
    non_zero = compatibility.evaluate_compatibility_removal_readiness(
        usage={"version": 1, "known": True, "total_hits": 1, "boundaries": {}},
        **passing_gates,
    )
    inconsistent = compatibility.evaluate_compatibility_removal_readiness(
        usage={
            "version": 1,
            "known": True,
            "total_hits": 0,
            "boundaries": {
                "LEGACY-PUBLIC-TEXT-PROJECTION": {"version": 1, "hits": 1}
            },
        },
        **passing_gates,
    )

    assert unknown == {
        "ready": False,
        "blockers": ["usage_unknown"],
    }
    assert non_zero == {
        "ready": False,
        "blockers": ["usage_non_zero"],
    }
    assert inconsistent == {
        "ready": False,
        "blockers": ["usage_unknown"],
    }
