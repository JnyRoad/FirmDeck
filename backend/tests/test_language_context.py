"""Tests for immutable UI/Agent language snapshots and exact raw-source markers."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    LocaleResolutionSource,
    ReplyLocaleConflict,
    SupportedLocale,
    normalize_locale,
    resolve_language_context,
)
from app.i18n.raw_source import RawSourceKind, RawSourceMarker


def test_normalize_locale_accepts_documented_transport_aliases_only() -> None:
    """Normalize narrow adapter aliases while rejecting pseudo and unsupported locales."""
    assert normalize_locale("zh-CN") is SupportedLocale.ZH_CN
    assert normalize_locale("zh_cn") is SupportedLocale.ZH_CN
    assert normalize_locale("zh") is SupportedLocale.ZH_CN
    assert normalize_locale("en-US") is SupportedLocale.EN_US
    assert normalize_locale("EN_us") is SupportedLocale.EN_US
    assert normalize_locale("en") is SupportedLocale.EN_US
    assert normalize_locale(None) is None

    with pytest.raises(ValueError, match="unsupported locale"):
        normalize_locale("en-XA")
    with pytest.raises(ValueError, match="unsupported locale"):
        normalize_locale("fr-FR")


@pytest.mark.parametrize(
    ("inputs", "expected_ui", "expected_reply", "ui_source", "reply_source"),
    [
        (
            LanguageContextInputs(
                explicit_ui_locale="en-US",
                explicit_agent_reply_locale="zh-CN",
                user_ui_locale="zh-CN",
                user_agent_reply_locale="en-US",
            ),
            SupportedLocale.EN_US,
            SupportedLocale.ZH_CN,
            LocaleResolutionSource.EXPLICIT_REQUEST,
            LocaleResolutionSource.EXPLICIT_REQUEST,
        ),
        (
            LanguageContextInputs(
                user_ui_locale="en-US",
                user_agent_reply_locale="en-US",
                channel_default_locale="zh-CN",
            ),
            SupportedLocale.EN_US,
            SupportedLocale.EN_US,
            LocaleResolutionSource.USER_PREFERENCE,
            LocaleResolutionSource.USER_PREFERENCE,
        ),
        (
            LanguageContextInputs(channel_default_locale="en-US", transport_locale="zh-CN"),
            SupportedLocale.EN_US,
            SupportedLocale.EN_US,
            LocaleResolutionSource.CHANNEL_DEFAULT,
            LocaleResolutionSource.CHANNEL_DEFAULT,
        ),
        (
            LanguageContextInputs(transport_locale="en-US"),
            SupportedLocale.EN_US,
            SupportedLocale.EN_US,
            LocaleResolutionSource.TRANSPORT_HINT,
            LocaleResolutionSource.TRANSPORT_HINT,
        ),
        (
            LanguageContextInputs(),
            SupportedLocale.ZH_CN,
            SupportedLocale.ZH_CN,
            LocaleResolutionSource.LEGACY_DEFAULT,
            LocaleResolutionSource.LEGACY_DEFAULT,
        ),
    ],
)
def test_new_execution_resolution_is_deterministic_and_independent(
    inputs: LanguageContextInputs,
    expected_ui: SupportedLocale,
    expected_reply: SupportedLocale,
    ui_source: LocaleResolutionSource,
    reply_source: LocaleResolutionSource,
) -> None:
    """Resolve UI and reply locale independently using the documented precedence order."""
    context = resolve_language_context(inputs)

    assert context.ui_locale is expected_ui
    assert context.agent_reply_locale is expected_reply
    assert context.ui_locale_source is ui_source
    assert context.agent_reply_locale_source is reply_source


def test_existing_session_reply_locale_is_authoritative_and_conflicts_fail_closed() -> None:
    """Keep an existing session stable and reject an explicit locale mutation in a normal turn."""
    context = resolve_language_context(
        LanguageContextInputs(
            explicit_ui_locale="en-US",
            session_agent_reply_locale="zh-CN",
            user_agent_reply_locale="en-US",
        )
    )

    assert context.ui_locale is SupportedLocale.EN_US
    assert context.agent_reply_locale is SupportedLocale.ZH_CN
    assert context.agent_reply_locale_source is LocaleResolutionSource.SESSION_SNAPSHOT

    with pytest.raises(ReplyLocaleConflict) as exc_info:
        resolve_language_context(
            LanguageContextInputs(
                explicit_agent_reply_locale="en-US",
                session_agent_reply_locale="zh-CN",
            )
        )
    assert exc_info.value.code == "AGENT_REPLY_LOCALE_CONFLICT"
    assert exc_info.value.params == {"requested": "en-US", "session": "zh-CN"}


def test_durable_snapshot_is_reused_without_consulting_mutable_preferences() -> None:
    """Resume durable work from its exact immutable snapshot despite later preference changes."""
    snapshot = LanguageContext(
        ui_locale="en-US",
        agent_reply_locale="zh-CN",
        ui_locale_source="explicit_request",
        agent_reply_locale_source="session_snapshot",
    )

    resolved = resolve_language_context(
        LanguageContextInputs(
            durable_snapshot=snapshot,
            user_ui_locale="zh-CN",
            user_agent_reply_locale="en-US",
            transport_locale="zh-CN",
        )
    )

    assert resolved is snapshot
    assert resolved.model_dump(mode="json") == {
        "version": 1,
        "ui_locale": "en-US",
        "agent_reply_locale": "zh-CN",
        "ui_locale_source": "explicit_request",
        "agent_reply_locale_source": "session_snapshot",
    }
    with pytest.raises(ValidationError):
        resolved.agent_reply_locale = SupportedLocale.EN_US


def test_raw_source_marker_is_exact_and_preserve_only() -> None:
    """Mark one exact JSON pointer without creating a broad ignore or translation instruction."""
    marker = RawSourceMarker(
        json_pointer="/messages/0/content",
        kind=RawSourceKind.USER_INPUT,
    )

    assert marker.model_dump(mode="json") == {
        "json_pointer": "/messages/0/content",
        "kind": "user_input",
        "policy": "preserve_verbatim",
    }
    with pytest.raises(ValidationError, match="wildcard"):
        RawSourceMarker(json_pointer="/messages/*/content", kind=RawSourceKind.USER_INPUT)
    with pytest.raises(ValidationError, match="JSON pointer"):
        RawSourceMarker(json_pointer="messages/0/content", kind=RawSourceKind.USER_INPUT)
