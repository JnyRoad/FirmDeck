"""Canonical product error data and deliberately separate private diagnostic context."""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field
from typing_extensions import TypeAliasType

JsonScalar = TypeAliasType("JsonScalar", str | int | float | bool | None)
JsonValue = TypeAliasType(
    "JsonValue",
    JsonScalar | list["JsonValue"] | dict[str, "JsonValue"],
)


class ErrorDescriptor(BaseModel):
    """Stable and safe error fields allowed to cross FirmDeck product boundaries."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    code: str = Field(pattern=r"^[A-Z][A-Z0-9_.-]{2,127}$")
    params: dict[str, JsonValue] = Field(default_factory=dict)
    retryable: bool
    request_id: str | None = None
    trace_id: str | None = None


@dataclass(frozen=True, slots=True)
class InternalErrorContext:
    """Private diagnostic evidence retained for authorized logs, never embedded in descriptors."""

    source: str
    exception_type: str | None = None
    raw_message: str | None = None
    upstream_code: str | None = None
    upstream_status: int | None = None
    upstream_request_id: str | None = None
    diagnostic_reference: str | None = None
    side_effect_uncertain: bool = False


@dataclass(frozen=True, slots=True)
class ErrorOccurrence:
    """Pair one public-safe descriptor with an optional process-private diagnostic cause."""

    descriptor: ErrorDescriptor
    internal: InternalErrorContext | None = None


__all__ = [
    "ErrorDescriptor",
    "ErrorOccurrence",
    "InternalErrorContext",
    "JsonScalar",
    "JsonValue",
]
