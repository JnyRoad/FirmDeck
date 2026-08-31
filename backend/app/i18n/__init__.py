"""Backend internationalization primitives shared across execution boundaries."""

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

__all__ = [
    "LanguageContext",
    "LanguageContextInputs",
    "LocaleResolutionSource",
    "RawSourceKind",
    "RawSourceMarker",
    "ReplyLocaleConflict",
    "SupportedLocale",
    "normalize_locale",
    "resolve_language_context",
]
