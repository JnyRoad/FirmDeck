"""Versioned StaffDeck product events with safe, locale-independent payloads."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.contracts.errors import JsonValue
from app.i18n.language_context import LanguageContext


class EventVisibility(StrEnum):
    """Declare whether a product event may cross a normal public boundary."""

    PUBLIC = "public"
    INTERNAL = "internal"


class SystemEvent(BaseModel):
    """Carry one immutable product event without localized text or private diagnostics."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[2] = 2
    event_code: str = Field(pattern=r"^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$")
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    params: dict[str, JsonValue] = Field(default_factory=dict)
    request_id: str | None = None
    trace_id: str | None = None
    tenant_id: str
    aggregate_type: str
    aggregate_id: str
    turn_id: str | None = None
    client_turn_id: str | None = None
    visibility: EventVisibility
    language_context: LanguageContext | None = None

    @field_validator("occurred_at")
    @classmethod
    def require_timezone_aware_timestamp(cls, value: datetime) -> datetime:
        """Require an aware timestamp and normalize it to UTC without external side effects."""
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("occurred_at must be timezone-aware")
        return value.astimezone(UTC)


__all__ = ["EventVisibility", "SystemEvent"]
