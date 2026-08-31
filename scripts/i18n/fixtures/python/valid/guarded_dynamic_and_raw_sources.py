"""Valid guarded dynamic codes plus private diagnostics, prompts, and successful raw content."""

from __future__ import annotations

import logging

from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.errors import ErrorDescriptor, InternalErrorContext
from app.i18n.raw_source import RawSourceKind, RawSourceMarker
from registered_code_constants import REGISTERED_SHARED_ERROR

logger = logging.getLogger(__name__)
repair_model = None


class ToolResponse:
    """Stand in for a successful typed tool response with source-owned data."""


class AgentReply:
    """Stand in for a final Agent response with explicitly marked source-owned output."""


def descriptor_from_imported_constant() -> ErrorDescriptor:
    """Accept a statically resolvable imported constant that exists in the registry."""
    return ErrorDescriptor(code=REGISTERED_SHARED_ERROR, params={}, retryable=False)


def guarded_dynamic_descriptor(code: str) -> ErrorDescriptor:
    """Resolve a dynamic code through the registry before constructing its descriptor."""
    entry = ERROR_REGISTRY.get(code) or ERROR_REGISTRY.require("INTERNAL_ERROR")
    return ErrorDescriptor(
        code=entry.code, params={}, retryable=entry.retryable_default
    )


def retain_authorized_private_diagnostics() -> None:
    """Keep a caught exception in authorized diagnostics, logs, and prompt-only repair context."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        previous_error = str(exc)
        context = InternalErrorContext(source="fixture", raw_message=previous_error)
        logger.exception("private failure context=%r", context)
        repair_model.generate_json(
            "Repair the previous invalid output",
            {"previous_error": previous_error},
        )


def mark_successful_provider_output(raw_provider_output: object) -> ToolResponse:
    """Return successful source-owned provider data while marking its exact prompt location raw."""
    marker = RawSourceMarker(
        json_pointer="/tool_result/data",
        kind=RawSourceKind.TOOL_PROVIDER_OUTPUT,
    )
    return ToolResponse(
        success=True, data=raw_provider_output, raw_source_markers=[marker]
    )


def mark_successful_agent_output(raw_agent_output: str) -> AgentReply:
    """Keep successful Agent prose raw when its exact reply pointer is explicitly marked."""
    marker = RawSourceMarker(
        json_pointer="/reply",
        kind=RawSourceKind.AGENT_OUTPUT,
    )
    return AgentReply(reply=raw_agent_output, raw_source_markers=[marker])
