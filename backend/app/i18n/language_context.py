"""Immutable UI/Agent locale snapshots and deterministic boundary resolution."""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.contracts.projections import _record_compatibility_usage


class SupportedLocale(StrEnum):
    """Locales that may persist in StaffDeck production records."""

    ZH_CN = "zh-CN"
    EN_US = "en-US"


class LocaleResolutionSource(StrEnum):
    """Auditable source used to choose one locale without changing its semantics."""

    EXPLICIT_REQUEST = "explicit_request"
    SESSION_SNAPSHOT = "session_snapshot"
    USER_PREFERENCE = "user_preference"
    CHANNEL_DEFAULT = "channel_default"
    TRANSPORT_HINT = "transport_hint"
    TASK_SNAPSHOT = "task_snapshot"
    LEGACY_DEFAULT = "legacy_default"


class LanguageContext(BaseModel):
    """Versioned immutable locale snapshot carried by one execution."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: int = Field(default=1, ge=1, le=1)
    ui_locale: SupportedLocale
    agent_reply_locale: SupportedLocale
    ui_locale_source: LocaleResolutionSource
    agent_reply_locale_source: LocaleResolutionSource


class LanguageContextInputs(BaseModel):
    """All ordered boundary candidates used to resolve one execution snapshot."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    explicit_ui_locale: str | None = None
    explicit_agent_reply_locale: str | None = None
    durable_snapshot: LanguageContext | None = None
    session_agent_reply_locale: str | None = None
    user_ui_locale: str | None = None
    user_agent_reply_locale: str | None = None
    channel_default_locale: str | None = None
    transport_locale: str | None = None


class ReplyLocaleConflict(ValueError):
    """Stable fail-closed conflict raised when a turn tries to mutate a bound session locale."""

    code = "AGENT_REPLY_LOCALE_CONFLICT"

    def __init__(self, *, requested: SupportedLocale, session: SupportedLocale) -> None:
        """Retain only safe normalized locale parameters for later error projection."""
        self.params = {"requested": requested.value, "session": session.value}
        super().__init__(
            "explicit agent reply locale conflicts with the existing session snapshot"
        )


_LOCALE_ALIASES: dict[str, SupportedLocale] = {
    "zh": SupportedLocale.ZH_CN,
    "zh-cn": SupportedLocale.ZH_CN,
    "en": SupportedLocale.EN_US,
    "en-us": SupportedLocale.EN_US,
}


def normalize_locale(value: str | SupportedLocale | None) -> SupportedLocale | None:
    """Normalize the documented narrow transport aliases into production BCP 47 tags."""
    if value is None:
        return None
    if isinstance(value, SupportedLocale):
        return value
    normalized = value.strip().replace("_", "-").lower()
    locale = _LOCALE_ALIASES.get(normalized)
    if locale is None:
        raise ValueError(f"unsupported locale: {value}")
    return locale


def _first_locale(
    candidates: tuple[tuple[str | None, LocaleResolutionSource], ...],
) -> tuple[SupportedLocale, LocaleResolutionSource]:
    """Return the first present normalized candidate or the deterministic legacy default."""
    for raw_locale, source in candidates:
        locale = normalize_locale(raw_locale)
        if locale is not None:
            return locale, source
    return SupportedLocale.ZH_CN, LocaleResolutionSource.LEGACY_DEFAULT


def resolve_language_context(inputs: LanguageContextInputs) -> LanguageContext:
    """Resolve an execution snapshot while keeping UI and Agent reply choices independent."""
    # Workflow: durable work reuses its exact snapshot before any mutable preference is inspected.
    if inputs.durable_snapshot is not None:
        return inputs.durable_snapshot

    ui_locale, ui_source = _first_locale(
        (
            (inputs.explicit_ui_locale, LocaleResolutionSource.EXPLICIT_REQUEST),
            (inputs.user_ui_locale, LocaleResolutionSource.USER_PREFERENCE),
            (inputs.channel_default_locale, LocaleResolutionSource.CHANNEL_DEFAULT),
            (inputs.transport_locale, LocaleResolutionSource.TRANSPORT_HINT),
        )
    )

    # Workflow: an existing session reply snapshot wins, and explicit mutation fails closed.
    session_locale = normalize_locale(inputs.session_agent_reply_locale)
    explicit_reply_locale = normalize_locale(inputs.explicit_agent_reply_locale)
    if session_locale is not None:
        if explicit_reply_locale is not None and explicit_reply_locale is not session_locale:
            raise ReplyLocaleConflict(requested=explicit_reply_locale, session=session_locale)
        reply_locale = session_locale
        reply_source = LocaleResolutionSource.SESSION_SNAPSHOT
    else:
        reply_locale, reply_source = _first_locale(
            (
                (inputs.explicit_agent_reply_locale, LocaleResolutionSource.EXPLICIT_REQUEST),
                (inputs.user_agent_reply_locale, LocaleResolutionSource.USER_PREFERENCE),
                (inputs.channel_default_locale, LocaleResolutionSource.CHANNEL_DEFAULT),
                (inputs.transport_locale, LocaleResolutionSource.TRANSPORT_HINT),
            )
        )

    resolved = LanguageContext(
        ui_locale=ui_locale,
        agent_reply_locale=reply_locale,
        ui_locale_source=ui_source,
        agent_reply_locale_source=reply_source,
    )
    if (
        resolved.ui_locale_source is LocaleResolutionSource.LEGACY_DEFAULT
        or resolved.agent_reply_locale_source is LocaleResolutionSource.LEGACY_DEFAULT
    ):
        _record_compatibility_usage("LEGACY-LANGUAGE-DEFAULT")
    return resolved


def resolve_compatible_language_context(
    *,
    snapshot: LanguageContext | dict[str, Any] | None,
    legacy_ui_locale: str | None,
    legacy_agent_reply_locale: str | None,
) -> LanguageContext:
    """Prefer a canonical snapshot, otherwise map legacy scalar fields into one snapshot."""
    # 1. Canonical persisted state always wins over mutable compatibility columns.
    if isinstance(snapshot, LanguageContext):
        return snapshot
    if snapshot is not None:
        return LanguageContext.model_validate(snapshot)

    # 2. Old-reader scalar fields are interpreted through the canonical resolver.
    return resolve_language_context(
        LanguageContextInputs(
            user_ui_locale=legacy_ui_locale,
            session_agent_reply_locale=legacy_agent_reply_locale,
        )
    )


def language_context_write_fields(context: LanguageContext) -> dict[str, Any]:
    """Dual-write the canonical snapshot plus scalar fields required by old readers."""
    return {
        "language_context_json": context.model_dump(mode="json"),
        "ui_locale": context.ui_locale.value,
        "agent_reply_locale": context.agent_reply_locale.value,
        "agent_reply_locale_source": context.agent_reply_locale_source.value,
    }


__all__ = [
    "LanguageContext",
    "LanguageContextInputs",
    "LocaleResolutionSource",
    "ReplyLocaleConflict",
    "SupportedLocale",
    "language_context_write_fields",
    "normalize_locale",
    "resolve_compatible_language_context",
    "resolve_language_context",
]
