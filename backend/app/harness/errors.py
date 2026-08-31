from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.contracts.error_registry import ERROR_REGISTRY, ErrorVisibility
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext
from app.harness.contracts import HarnessToolError, JsonValue


class HarnessExecutionError(RuntimeError):
    """Expected Harness failure with separate public metadata and private diagnostic prose."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: Mapping[str, JsonValue] | None = None,
        request_id: str | None = None,
        trace_id: str | None = None,
        internal: InternalErrorContext | None = None,
    ) -> None:
        """Construct a safe legacy Harness error and retain the supplied prose privately."""
        super().__init__(message)
        # Workflow: resolve dynamic harness codes before constructing the public
        # descriptor; retain raw execution prose only in the private error context.
        entry = ERROR_REGISTRY.get(code)
        safe_details = dict(details or {})
        safe_retryable = retryable
        if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
            entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
            safe_details = {}
            safe_retryable = entry.retryable_default
        self.occurrence = ErrorOccurrence(
            descriptor=ErrorDescriptor(
                code=entry.code,
                params=safe_details,
                retryable=safe_retryable,
                request_id=request_id,
                trace_id=trace_id,
            ),
            internal=internal
            or InternalErrorContext(
                source="harness",
                exception_type=type(self).__name__,
                raw_message=message,
                upstream_code=code,
            ),
        )
        # HarnessToolError is the private in-process control surface used by the
        # executor and tests to branch on precise sandbox/filesystem failure
        # semantics. Only occurrence/to_public_payload may collapse non-public
        # codes to INTERNAL_ERROR at a transport boundary.
        self.error = HarnessToolError(
            code=code,
            message=message,
            retryable=retryable,
            details=dict(details or {}),
        )

    def to_public_payload(self) -> dict[str, Any]:
        """Serialize canonical fields plus the explicit v1 message compatibility marker."""
        payload = self.occurrence.descriptor.model_dump(mode="json")
        payload["message"] = self.occurrence.descriptor.code
        payload["deprecated_fields"] = ["message"]
        return payload


def harness_error(
    code: str,
    message: str,
    *,
    retryable: bool = False,
    details: Mapping[str, JsonValue] | None = None,
    request_id: str | None = None,
    trace_id: str | None = None,
    internal: InternalErrorContext | None = None,
) -> HarnessExecutionError:
    """Create a HarnessExecutionError while keeping the historical constructor boundary."""
    return HarnessExecutionError(
        code,
        message,
        retryable=retryable,
        details=details,
        request_id=request_id,
        trace_id=trace_id,
        internal=internal,
    )


__all__ = ["HarnessExecutionError", "harness_error"]
