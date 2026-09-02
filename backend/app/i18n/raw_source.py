"""Exact markers for source-owned content that must remain verbatim."""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator


class RawSourceKind(StrEnum):
    """Source-data classes that product localization must never rewrite."""

    USER_INPUT = "user_input"
    HISTORY = "history"
    KNOWLEDGE = "knowledge"
    TOOL_PROVIDER_OUTPUT = "tool_provider_output"
    BUSINESS_RECORD = "business_record"
    IDENTIFIER = "identifier"
    PATH = "path"
    DIAGNOSTIC = "diagnostic"


class RawSourceMarker(BaseModel):
    """Mark one exact payload location with a preserve-verbatim policy."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    json_pointer: str
    kind: RawSourceKind
    policy: Literal["preserve_verbatim"] = "preserve_verbatim"

    @field_validator("json_pointer")
    @classmethod
    def validate_json_pointer(cls, value: str) -> str:
        """Reject broad wildcards and malformed RFC 6901 escape sequences."""
        if "*" in value:
            raise ValueError("raw source marker cannot contain a wildcard")
        if value and not value.startswith("/"):
            raise ValueError("json_pointer must be an absolute JSON pointer")
        if re.search(r"~(?:[^01]|$)", value):
            raise ValueError("json_pointer contains an invalid JSON pointer escape")
        return value


__all__ = ["RawSourceKind", "RawSourceMarker"]
