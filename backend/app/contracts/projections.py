"""Safe transport projections for canonical errors and bounded compatibility consumers."""

from __future__ import annotations

from threading import Lock
from typing import Any

from app.contracts.error_registry import (
    ErrorContractViolation,
    ErrorRegistry,
    ErrorVisibility,
)
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext

_COMPATIBILITY_USAGE_VERSION = 1
_COMPATIBILITY_BOUNDARIES = frozenset(
    {"LEGACY-LANGUAGE-DEFAULT", "LEGACY-PUBLIC-TEXT-PROJECTION"}
)
_compatibility_usage: dict[str, int] = {}
_compatibility_usage_lock = Lock()


def _record_compatibility_usage(boundary_id: str, hits: int = 1) -> None:
    """Increment only an approved boundary/count pair without accepting business payloads."""
    if boundary_id not in _COMPATIBILITY_BOUNDARIES:
        raise ValueError(f"unregistered compatibility boundary: {boundary_id}")
    if not isinstance(hits, int) or isinstance(hits, bool) or hits <= 0:
        return
    with _compatibility_usage_lock:
        _compatibility_usage[boundary_id] = (
            _compatibility_usage.get(boundary_id, 0) + hits
        )


def reset_compatibility_usage() -> None:
    """Clear process-local counters for controlled tests or a fresh worker lifecycle only."""
    with _compatibility_usage_lock:
        _compatibility_usage.clear()


def get_compatibility_usage() -> dict[str, Any]:
    """Return a versioned snapshot containing only exact boundary IDs and aggregate counts."""
    with _compatibility_usage_lock:
        boundaries = {
            boundary_id: {
                "version": _COMPATIBILITY_USAGE_VERSION,
                "hits": hits,
            }
            for boundary_id, hits in sorted(_compatibility_usage.items())
        }
    return {
        "version": _COMPATIBILITY_USAGE_VERSION,
        "known": True,
        "total_hits": sum(boundary["hits"] for boundary in boundaries.values()),
        "boundaries": boundaries,
    }


def _known_compatibility_usage(usage: dict[str, Any] | None) -> bool:
    """Accept the current aggregate; zero usage must also match every boundary count."""
    if not isinstance(usage, dict):
        return False
    total_hits = usage.get("total_hits")
    if not (
        usage.get("known") is True
        and usage.get("version") == _COMPATIBILITY_USAGE_VERSION
        and isinstance(total_hits, int)
        and not isinstance(total_hits, bool)
        and total_hits >= 0
    ):
        return False
    if total_hits > 0:
        return True
    boundaries = usage.get("boundaries")
    if not isinstance(boundaries, dict):
        return False
    boundary_hits = 0
    for boundary_id, boundary in boundaries.items():
        if boundary_id not in _COMPATIBILITY_BOUNDARIES or not isinstance(boundary, dict):
            return False
        hits = boundary.get("hits")
        if (
            boundary.get("version") != _COMPATIBILITY_USAGE_VERSION
            or not isinstance(hits, int)
            or isinstance(hits, bool)
            or hits < 0
        ):
            return False
        boundary_hits += hits
    return boundary_hits == total_hits


def evaluate_compatibility_removal_readiness(
    *,
    usage: dict[str, Any] | None,
    static_checks_passed: bool,
    browser_matrix_passed: bool,
    external_client_window_open: bool,
) -> dict[str, Any]:
    """Fail closed unless usage is known and zero and every independent gate is closed."""
    blockers: list[str] = []
    if not _known_compatibility_usage(usage):
        blockers.append("usage_unknown")
    elif usage["total_hits"] > 0:
        blockers.append("usage_non_zero")
    if not static_checks_passed:
        blockers.append("static_checks_failed")
    if not browser_matrix_passed:
        blockers.append("browser_matrix_failed")
    if external_client_window_open:
        blockers.append("external_client_window_open")
    return {"ready": not blockers, "blockers": blockers}


def _fallback_descriptor(descriptor: ErrorDescriptor, registry: ErrorRegistry) -> ErrorDescriptor:
    """Preserve request/trace linkage while replacing unregistered or invalid data with safe defaults."""
    fallback = registry.require("INTERNAL_ERROR")
    return ErrorDescriptor(
        code=fallback.code,
        params={},
        retryable=fallback.retryable_default,
        request_id=descriptor.request_id,
        trace_id=descriptor.trace_id,
    )


def _safe_public_descriptor(
    occurrence: ErrorOccurrence,
    registry: ErrorRegistry,
) -> ErrorDescriptor:
    """Validate a public descriptor and fail closed to INTERNAL_ERROR on every contract defect."""
    descriptor = occurrence.descriptor
    entry = registry.get(descriptor.code)
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        return _fallback_descriptor(descriptor, registry)
    try:
        return registry.validate(descriptor)
    except ErrorContractViolation:
        return _fallback_descriptor(descriptor, registry)


def project_public_error(
    occurrence: ErrorOccurrence,
    registry: ErrorRegistry,
) -> dict[str, Any]:
    """Serialize only safe canonical fields; InternalErrorContext is deliberately unreachable."""
    _record_compatibility_usage("LEGACY-PUBLIC-TEXT-PROJECTION")
    descriptor = _safe_public_descriptor(occurrence, registry)
    return descriptor.model_dump(mode="json")


def project_public_error_payload(
    candidate: object,
    registry: ErrorRegistry,
    *,
    source: str,
    default_code: str = "INTERNAL_ERROR",
    default_retryable: bool | None = None,
    request_id: str | None = None,
    trace_id: str | None = None,
) -> dict[str, Any]:
    """Project legacy or partially structured error data without publishing raw prose.

    Durable records may contain pre-contract ``message``/``detail`` fields or malformed
    provider payloads.  This adapter accepts only a registered public code, a parameter
    mapping validated by the registry, a boolean retry flag, and string request/trace
    linkage.  Any defect falls back to ``INTERNAL_ERROR`` while preserving only valid
    linkage supplied by the caller or candidate.
    """

    fallback_entry = registry.get(default_code) or registry.require("INTERNAL_ERROR")
    fallback_request_id = request_id if isinstance(request_id, str) else None
    fallback_trace_id = trace_id if isinstance(trace_id, str) else None

    def fallback(
        *,
        candidate_request_id: object = None,
        candidate_trace_id: object = None,
    ) -> dict[str, Any]:
        safe_request_id = (
            candidate_request_id
            if isinstance(candidate_request_id, str)
            else fallback_request_id
        )
        safe_trace_id = (
            candidate_trace_id
            if isinstance(candidate_trace_id, str)
            else fallback_trace_id
        )
        occurrence = ErrorOccurrence(
            descriptor=ErrorDescriptor(
                code=fallback_entry.code,
                params={},
                retryable=fallback_entry.retryable_default,
                request_id=safe_request_id,
                trace_id=safe_trace_id,
            ),
            internal=InternalErrorContext(
                source=source,
                raw_message=(
                    str(candidate.get("message"))
                    if isinstance(candidate, dict) and candidate.get("message") is not None
                    else None
                ),
            ),
        )
        return project_public_error(occurrence, registry)

    if not isinstance(candidate, dict) or not candidate:
        return fallback()

    candidate_request_id = candidate.get("request_id", request_id)
    candidate_trace_id = candidate.get("trace_id", trace_id)
    if (candidate_request_id is not None and not isinstance(candidate_request_id, str)) or (
        candidate_trace_id is not None and not isinstance(candidate_trace_id, str)
    ):
        return fallback(
            candidate_request_id=candidate_request_id,
            candidate_trace_id=candidate_trace_id,
        )

    code = candidate.get("code")
    if not isinstance(code, str):
        return fallback(
            candidate_request_id=candidate_request_id,
            candidate_trace_id=candidate_trace_id,
        )
    entry = registry.get(code)
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        return fallback(
            candidate_request_id=candidate_request_id,
            candidate_trace_id=candidate_trace_id,
        )

    params = candidate.get("params", {})
    retryable = candidate.get(
        "retryable",
        default_retryable if default_retryable is not None else entry.retryable_default,
    )
    if not isinstance(params, dict) or not isinstance(retryable, bool):
        return fallback(
            candidate_request_id=candidate_request_id,
            candidate_trace_id=candidate_trace_id,
        )
    try:
        descriptor = ErrorDescriptor(
            code=code,
            params=params,
            retryable=retryable,
            request_id=candidate_request_id,
            trace_id=candidate_trace_id,
        )
    except (TypeError, ValueError):
        return fallback(
            candidate_request_id=candidate_request_id,
            candidate_trace_id=candidate_trace_id,
        )
    occurrence = ErrorOccurrence(
        descriptor=descriptor,
        internal=InternalErrorContext(
            source=source,
            raw_message=(
                str(candidate.get("message"))
                if candidate.get("message") is not None
                else None
            ),
            upstream_code=code,
        ),
    )
    return project_public_error(occurrence, registry)


def project_public_result_payload(
    candidate: object,
    registry: ErrorRegistry,
    *,
    source: str,
    request_id: str | None = None,
    trace_id: str | None = None,
    default_retryable: bool | None = None,
) -> dict[str, Any]:
    """Recursively project nested errors while preserving successful business output."""
    projected = _project_public_result_value(
        candidate,
        registry,
        source=source,
        request_id=request_id,
        trace_id=trace_id,
        default_retryable=default_retryable,
    )
    return projected if isinstance(projected, dict) else {}


def _project_public_result_value(
    candidate: object,
    registry: ErrorRegistry,
    *,
    source: str,
    request_id: str | None,
    trace_id: str | None,
    default_retryable: bool | None,
) -> object:
    """Walk JSON result containers and canonicalize every field named ``error``."""
    if isinstance(candidate, dict):
        projected: dict[Any, Any] = {}
        for key, value in candidate.items():
            if key == "error":
                projected[key] = (
                    value
                    if value in (None, {})
                    else project_public_error_payload(
                        value,
                        registry,
                        source=source,
                        default_retryable=default_retryable,
                        request_id=request_id,
                        trace_id=trace_id,
                    )
                )
            else:
                projected[key] = _project_public_result_value(
                    value,
                    registry,
                    source=source,
                    request_id=request_id,
                    trace_id=trace_id,
                    default_retryable=default_retryable,
                )
        return projected
    if isinstance(candidate, list):
        return [
            _project_public_result_value(
                item,
                registry,
                source=source,
                request_id=request_id,
                trace_id=trace_id,
                default_retryable=default_retryable,
            )
            for item in candidate
        ]
    return candidate


def project_problem_details(
    occurrence: ErrorOccurrence,
    registry: ErrorRegistry,
) -> dict[str, Any]:
    """Project RFC-style metadata plus canonical code/params without a natural-language detail."""
    _record_compatibility_usage("LEGACY-PUBLIC-TEXT-PROJECTION")
    descriptor = _safe_public_descriptor(occurrence, registry)
    entry = registry.require(descriptor.code)
    return {
        "type": f"urn:firmdeck:error:{descriptor.code.lower()}",
        "title": descriptor.code,
        "status": entry.default_http_status,
        "code": descriptor.code,
        "message_key": entry.message_key,
        "params": descriptor.params,
        "retryable": descriptor.retryable,
        "request_id": descriptor.request_id,
        "trace_id": descriptor.trace_id,
    }


__all__ = [
    "evaluate_compatibility_removal_readiness",
    "get_compatibility_usage",
    "project_problem_details",
    "project_public_error",
    "project_public_error_payload",
    "project_public_result_payload",
    "reset_compatibility_usage",
]
