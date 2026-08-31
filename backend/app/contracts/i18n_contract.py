"""Build and validate the versioned backend contract consumed by frontend i18n tooling."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.event_registry import (
    EVENT_REGISTRY,
    RAW_SOURCE_EVENT_TYPES,
)

CONTRACT_SCHEMA_VERSION = 1
_MESSAGE_KEY_PATTERN = re.compile(r"[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){2,}")
_ERROR_FIELDS = frozenset(
    {"code", "message_key", "status", "retryable", "params", "visibility"}
)
_EVENT_FIELDS = frozenset(
    {
        "event_code",
        "message_key",
        "params",
        "visibility",
        "raw_source_allowed",
        "requires_language_context",
        "legacy_event_type",
    }
)


def _error_contract_entry(entry: Any) -> dict[str, Any]:
    """Project one backend error registry entry into the language-neutral export shape."""
    return {
        "code": entry.code,
        "message_key": entry.message_key,
        "status": entry.default_http_status,
        "retryable": entry.retryable_default,
        "params": dict(sorted(entry.params_schema.items())),
        "visibility": entry.visibility.value,
    }


def _event_contract_entry(entry: Any) -> dict[str, Any]:
    """Project one backend event registry entry into the frontend-consumable export shape."""
    return {
        "event_code": entry.event_code,
        "message_key": entry.message_key,
        "params": dict(sorted(entry.params_schema.items())),
        "visibility": entry.visibility.value,
        "raw_source_allowed": entry.raw_source_allowed,
        "requires_language_context": entry.requires_language_context,
        "legacy_event_type": entry.legacy_event_type,
    }


def build_i18n_contract() -> dict[str, Any]:
    """Build a deterministic snapshot of both backend registries for generation and CI checks."""
    # Workflow: sort entries and parameter names at the source boundary so generated artifacts do
    # not change with Python import order or dictionary insertion order.
    return {
        "schema_version": CONTRACT_SCHEMA_VERSION,
        "errors": [_error_contract_entry(entry) for entry in ERROR_REGISTRY.entries()],
        "events": [_event_contract_entry(entry) for entry in EVENT_REGISTRY.entries()],
    }


def _require_mapping(value: Any, *, name: str) -> Mapping[str, Any]:
    """Require an object-shaped contract section and raise a path-oriented validation error."""
    if not isinstance(value, Mapping):
        raise TypeError(f"{name} must be an object")
    return value


def _validate_message_key(value: Any, *, path: str, allow_none: bool = False) -> None:
    """Validate semantic message IDs while keeping natural-language keys out of artifacts."""
    if value is None and allow_none:
        return
    if not isinstance(value, str) or not _MESSAGE_KEY_PATTERN.fullmatch(value):
        raise ValueError(f"{path}.message_key must be a stable semantic identifier")


def _validate_params(value: Any, *, path: str) -> dict[str, str]:
    """Validate the exact primitive parameter schema exported by a registry entry."""
    mapping = _require_mapping(value, name=f"{path}.params")
    allowed = {"string", "integer", "number", "boolean"}
    result: dict[str, str] = {}
    for name, kind in mapping.items():
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", name):
            raise ValueError(f"{path}.params contains an invalid parameter name")
        if kind not in allowed:
            raise ValueError(f"{path}.params.{name} has an invalid parameter type")
        result[name] = str(kind)
    return result


def validate_i18n_contract(contract: Mapping[str, Any]) -> None:
    """Validate generated contract shape, registry parity, and public event localization policy."""
    # Workflow: validate shape first, then compare every record to the live registry so a stale or
    # hand-edited generated artifact cannot silently widen codes or parameter schemas.
    if not isinstance(contract, Mapping):
        raise TypeError("contract must be an object")
    if set(contract) != {"schema_version", "errors", "events"}:
        raise ValueError("contract has unexpected top-level fields")
    if contract["schema_version"] != CONTRACT_SCHEMA_VERSION:
        raise ValueError("contract schema_version is unsupported")

    errors = contract["errors"]
    events = contract["events"]
    if not isinstance(errors, list) or not isinstance(events, list):
        raise TypeError("contract errors/events must be arrays")

    expected_errors = {
        entry.code: _error_contract_entry(entry) for entry in ERROR_REGISTRY.entries()
    }
    actual_error_codes: set[str] = set()
    for index, item in enumerate(errors):
        path = f"errors[{index}]"
        mapping = _require_mapping(item, name=path)
        if set(mapping) != _ERROR_FIELDS:
            raise ValueError(f"{path} has unexpected fields")
        code = mapping.get("code")
        if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_.-]{2,127}", code):
            raise ValueError(f"{path}.code is not a stable error code")
        if code in actual_error_codes:
            raise ValueError(f"duplicate error code: {code}")
        actual_error_codes.add(code)
        _validate_message_key(mapping.get("message_key"), path=path)
        if not isinstance(mapping.get("status"), int) or not 400 <= mapping["status"] <= 599:
            raise TypeError(f"{path}.status is invalid")
        if not isinstance(mapping.get("retryable"), bool):
            raise TypeError(f"{path}.retryable is invalid")
        _validate_params(mapping.get("params"), path=path)
        if mapping.get("visibility") not in {"public", "internal"}:
            raise ValueError(f"{path}.visibility is invalid")
        expected_error = expected_errors.get(code)
        if expected_error is None:
            raise ValueError(f"{path} does not match ERROR_REGISTRY for {code}")
        if dict(mapping).get("params") != expected_error["params"]:
            raise ValueError(f"{path}.params does not match ERROR_REGISTRY for {code}")
        if dict(mapping) != expected_error:
            raise ValueError(f"{path} does not match ERROR_REGISTRY for {code}")
    if actual_error_codes != set(expected_errors):
        raise ValueError("error contract does not match ERROR_REGISTRY code set")

    expected_events = {
        entry.event_code: _event_contract_entry(entry) for entry in EVENT_REGISTRY.entries()
    }
    actual_event_codes: set[str] = set()
    for index, item in enumerate(events):
        path = f"events[{index}]"
        mapping = _require_mapping(item, name=path)
        if set(mapping) != _EVENT_FIELDS:
            raise ValueError(f"{path} has unexpected fields")
        event_code = mapping.get("event_code")
        if not isinstance(event_code, str) or not re.fullmatch(
            r"[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}", event_code
        ):
            raise ValueError(f"{path}.event_code is not stable")
        if event_code in actual_event_codes:
            raise ValueError(f"duplicate event code: {event_code}")
        actual_event_codes.add(event_code)
        raw_allowed = mapping.get("raw_source_allowed") is True
        allow_missing_message = raw_allowed or mapping.get("visibility") == "internal"
        _validate_message_key(
            mapping.get("message_key"),
            path=path,
            allow_none=allow_missing_message,
        )
        _validate_params(mapping.get("params"), path=path)
        if mapping.get("visibility") not in {"public", "internal"}:
            raise ValueError(f"{path}.visibility is invalid")
        if not isinstance(mapping.get("requires_language_context"), bool):
            raise TypeError(f"{path}.requires_language_context is invalid")
        legacy_event_type = mapping.get("legacy_event_type")
        if legacy_event_type is not None and not isinstance(legacy_event_type, str):
            raise ValueError(f"{path}.legacy_event_type is invalid")
        if mapping.get("visibility") == "public" and not raw_allowed and not mapping.get(
            "message_key"
        ):
            raise ValueError(f"{path}.message_key is required for public non-raw events")
        if raw_allowed and legacy_event_type not in RAW_SOURCE_EVENT_TYPES:
            raise ValueError(f"{path}.raw_source_allowed is not an approved raw event")
        expected_event = expected_events.get(event_code)
        if expected_event is None:
            raise ValueError(f"{path} does not match EVENT_REGISTRY for {event_code}")
        if dict(mapping).get("params") != expected_event["params"]:
            raise ValueError(f"{path}.params does not match EVENT_REGISTRY for {event_code}")
        if dict(mapping) != expected_event:
            raise ValueError(f"{path} does not match EVENT_REGISTRY for {event_code}")
    if actual_event_codes != set(expected_events):
        raise ValueError("event contract does not match EVENT_REGISTRY code set")


__all__ = [
    "CONTRACT_SCHEMA_VERSION",
    "build_i18n_contract",
    "validate_i18n_contract",
]
