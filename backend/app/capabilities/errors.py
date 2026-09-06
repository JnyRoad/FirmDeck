from __future__ import annotations

import json
import re
from dataclasses import dataclass

from app.contracts.error_registry import ERROR_REGISTRY, ErrorVisibility
from app.contracts.errors import (
    ErrorDescriptor,
    ErrorOccurrence,
    InternalErrorContext,
    JsonValue,
)


@dataclass(frozen=True)
class CapabilityErrorInfo:
    """Provider failure with a canonical public descriptor and private diagnostic prose."""

    code: str
    message: str
    retryable: bool
    request_id: str | None = None
    trace_id: str | None = None
    params: dict[str, JsonValue] | None = None
    provider_id: str | None = None
    extensions: dict[str, object] | None = None

    def to_descriptor(self) -> ErrorDescriptor:
        """Build the stable provider-facing descriptor without legacy or diagnostic prose."""
        # Workflow: resolve provider codes through the registry and fail closed for
        # unknown/internal values; provider-specific named params remain bounded data.
        entry = ERROR_REGISTRY.get(self.code)
        safe_params = self.params or {}
        if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
            entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
            safe_params = {}
        return ErrorDescriptor(
            code=entry.code,
            params=safe_params,
            retryable=self.retryable,
            request_id=self.request_id,
            trace_id=self.trace_id,
        )

    def to_occurrence(self) -> ErrorOccurrence:
        """Pair safe provider data with the raw legacy message for private diagnostics only."""
        return ErrorOccurrence(
            descriptor=self.to_descriptor(),
            internal=InternalErrorContext(
                source="capability_provider",
                raw_message=self.message,
                upstream_code=self.code,
                upstream_request_id=self.request_id,
            ),
        )

    def to_payload(self) -> dict[str, object]:
        """Project the deprecated v1 provider payload without exposing raw diagnostic prose."""
        if not self.request_id:
            raise ValueError("provider errors require request_id")
        extensions = self.extensions or {}
        for namespace, value in extensions.items():
            if (
                not re.fullmatch(r"[a-z][a-z0-9_]*", namespace)
                or namespace in {"core", "firmdeck"}
                or not isinstance(value, dict)
            ):
                raise ValueError(f"invalid provider error extension namespace: {namespace}")
        try:
            encoded = json.dumps(extensions, ensure_ascii=True, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ValueError("provider error extensions must be JSON") from exc
        if len(encoded.encode("utf-8")) > 64 * 1024:
            raise ValueError("provider error extensions exceed the 64 KiB limit")
        descriptor = self.to_descriptor()
        return {
            "error_code": descriptor.code,
            # TODO(i18n-governance): remove the v1 message field after provider v2 adoption.
            "message": descriptor.code,
            "retryable": descriptor.retryable,
            "request_id": descriptor.request_id,
            "trace_id": descriptor.trace_id,
            "params": descriptor.params,
            "provider_id": self.provider_id,
            "extensions": self.extensions or {},
            "deprecated_fields": ["message"],
        }


class CapabilityProviderError(RuntimeError):
    """Stable provider failure; callers must branch on code/retryable."""

    def __init__(self, info: CapabilityErrorInfo) -> None:
        super().__init__(info.message)
        self.info = info


__all__ = ["CapabilityErrorInfo", "CapabilityProviderError"]
