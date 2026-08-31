"""Build the immutable language and raw-source contract attached to every Agent prompt."""

from __future__ import annotations

from collections.abc import Sequence

from app.i18n.language_context import (
    LanguageContext,
    LocaleResolutionSource,
    SupportedLocale,
)
from app.i18n.raw_source import RawSourceMarker


def resolve_prompt_language_context(
    language_context: LanguageContext | None,
) -> LanguageContext:
    """Return the supplied immutable snapshot or the explicit legacy zh-CN compatibility snapshot."""
    if language_context is not None:
        return language_context
    return LanguageContext(
        ui_locale=SupportedLocale.ZH_CN,
        agent_reply_locale=SupportedLocale.ZH_CN,
        ui_locale_source=LocaleResolutionSource.LEGACY_DEFAULT,
        agent_reply_locale_source=LocaleResolutionSource.LEGACY_DEFAULT,
    )


def language_prompt_contract(
    language_context: LanguageContext | None,
    raw_source_markers: Sequence[RawSourceMarker],
) -> dict[str, object]:
    """Serialize one reply-locale directive plus exact source-owned JSON pointers for a stage."""
    context = resolve_prompt_language_context(language_context)
    locale = context.agent_reply_locale.value
    return {
        "language_context": context.model_dump(mode="json"),
        "language_directive": {
            "new_prose_locale": locale,
            "source_content_policy": "preserve_verbatim",
            "instruction": (
                f"Write only newly generated user-facing prose in {locale}. "
                "Content at raw_source_markers is source-owned: preserve every marked value "
                "verbatim, including its language, spelling, punctuation, paths, identifiers, "
                "citations, and provider output. Do not rewrite marked source content."
            ),
        },
        "raw_source_markers": [
            marker.model_dump(mode="json") for marker in raw_source_markers
        ],
    }


def localized_compat_text(
    language_context: LanguageContext | None,
    *,
    zh_cn: str,
    en_us: str,
) -> str:
    """Select a developer-owned compatibility message from the reply locale without touching raw data."""
    context = resolve_prompt_language_context(language_context)
    if context.agent_reply_locale is SupportedLocale.EN_US:
        return en_us
    return zh_cn


def localized_cancelled_reply(language_context: LanguageContext | None) -> str:
    """Return the cancellation reply in the immutable Agent reply locale."""
    return localized_compat_text(
        language_context,
        zh_cn="已停止生成",
        en_us="Generation stopped.",
    )


def localized_interrupted_reply(language_context: LanguageContext | None) -> str:
    """Return the interrupted-turn reply in the immutable Agent reply locale."""
    return localized_compat_text(
        language_context,
        zh_cn="本次响应中断，请重试发送。",
        en_us="This response was interrupted. Please send your message again to retry.",
    )


def localized_recovery_reply(language_context: LanguageContext | None) -> str:
    """Return the orphan-run recovery reply in the immutable Agent reply locale."""
    return localized_compat_text(
        language_context,
        zh_cn=(
            "本轮执行因服务重启或执行协程中断而终止。已保留当前 SOP 步骤和已填写信息，"
            "请重新发送上一条消息以继续。"
        ),
        en_us=(
            "This run ended because the service restarted or execution was interrupted. "
            "Your current SOP step and entered information were preserved. "
            "Send your previous message again to continue."
        ),
    )


__all__ = [
    "language_prompt_contract",
    "localized_cancelled_reply",
    "localized_compat_text",
    "localized_interrupted_reply",
    "localized_recovery_reply",
    "resolve_prompt_language_context",
]
