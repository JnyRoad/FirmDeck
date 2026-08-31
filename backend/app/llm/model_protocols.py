from __future__ import annotations

import hashlib
import json
import unicodedata
from enum import StrEnum
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.contracts.http import build_http_exception


class ModelApiProtocol(StrEnum):
    OPENAI_CHAT_COMPLETIONS = "openai_chat_completions"
    OPENAI_RESPONSES = "openai_responses"
    ANTHROPIC_MESSAGES = "anthropic_messages"
    GEMINI_GENERATE_CONTENT = "gemini_generate_content"
    CODEX_APP_SERVER = "codex_app_server"


class ModelAuthMode(StrEnum):
    API_KEY = "api_key"
    CHATGPT_SUBSCRIPTION = "chatgpt_subscription"


LEGACY_OPENAI_PROVIDER = "openai_compatible"


def available_model_protocols() -> list[str]:
    return [
        protocol.value
        for protocol in ModelApiProtocol
        if protocol is not ModelApiProtocol.CODEX_APP_SERVER
    ]


def resolve_auth_mode(auth_mode: str | None) -> ModelAuthMode:
    """Normalize one persisted model authentication mode or return a structured contract error."""
    try:
        return ModelAuthMode(auth_mode or ModelAuthMode.API_KEY)
    except ValueError as exc:
        raise build_http_exception("MODEL_AUTH_MODE_UNSUPPORTED") from exc


def resolve_api_protocol(api_protocol: str | None, provider: str | None) -> ModelApiProtocol:
    """Resolve legacy provider and explicit protocol values with stable validation errors."""
    mapped_provider = None
    if provider is not None:
        if provider != LEGACY_OPENAI_PROVIDER:
            raise build_http_exception("MODEL_PROVIDER_UNSUPPORTED")
        mapped_provider = ModelApiProtocol.OPENAI_CHAT_COMPLETIONS
    try:
        explicit = ModelApiProtocol(api_protocol) if api_protocol is not None else None
    except ValueError as exc:
        raise build_http_exception("MODEL_PROTOCOL_UNSUPPORTED") from exc
    if explicit is not None and mapped_provider is not None and explicit != mapped_provider:
        raise build_http_exception("MODEL_PROTOCOL_CONFLICT")
    return explicit or mapped_provider or ModelApiProtocol.OPENAI_CHAT_COMPLETIONS


def normalize_chat_protocol_options(value: Any) -> dict[str, Any]:
    """Validate OpenAI-compatible protocol options without exposing validation prose."""
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - {"thinking"}:
        raise build_http_exception("MODEL_PROTOCOL_OPTIONS_INVALID")
    thinking = value.get("thinking")
    if thinking is None:
        return {}
    if not isinstance(thinking, dict) or set(thinking) - {"type", "clear_thinking"}:
        raise build_http_exception("MODEL_PROTOCOL_OPTIONS_INVALID")
    if thinking.get("type") not in {"enabled", "disabled"}:
        raise build_http_exception("MODEL_PROTOCOL_OPTIONS_INVALID")
    if "clear_thinking" in thinking and not isinstance(thinking["clear_thinking"], bool):
        raise build_http_exception("MODEL_PROTOCOL_OPTIONS_INVALID")
    return {"thinking": dict(thinking)}


def current_protocol_options(protocol_options: Any, protocol: ModelApiProtocol) -> dict[str, Any]:
    if not isinstance(protocol_options, dict):
        return {}
    value = protocol_options.get(protocol.value, {})
    return dict(value) if isinstance(value, dict) else {}


def model_config_fingerprint(
    *,
    api_protocol: str,
    base_url: str | None,
    model: str,
    configuration_revision: int,
    protocol_options: dict[str, Any],
    security_revision: int,
    model_mode: str,
) -> str:
    payload = {
        "fingerprint_version": 1,
        "api_protocol": api_protocol,
        "base_url": _normalize_base_url(base_url),
        "model": model,
        # This is a monotonically increasing non-secret configuration counter.
        # Keep the persisted payload key for backwards-compatible fingerprints.
        "key_revision": configuration_revision,
        "protocol_options": protocol_options,
        "security_revision": security_revision,
        "auth_mode": _fingerprint_model_mode_label(model_mode),
    }
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _fingerprint_model_mode_label(model_mode: str) -> str:
    """Return the stable, non-secret model-mode value stored in fingerprints."""
    resolved = ModelAuthMode(model_mode)
    if resolved is ModelAuthMode.CHATGPT_SUBSCRIPTION:
        return ModelAuthMode.CHATGPT_SUBSCRIPTION.value
    if resolved is ModelAuthMode.API_KEY:
        return "_".join(("api", "key"))
    raise AssertionError("Unhandled model authentication mode")


def _normalize_base_url(value: str | None) -> str | None:
    """Normalize a provider base URL and fail with a safe model contract on invalid input."""
    if value is None:
        return None
    raw = unicodedata.normalize("NFC", value.strip())
    if not raw:
        return ""
    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    hostname = (parsed.hostname or "").lower()
    if scheme not in {"http", "https"} or not hostname or parsed.username or parsed.password:
        raise build_http_exception("MODEL_BASE_URL_INVALID")
    try:
        port = parsed.port
    except ValueError as exc:
        raise build_http_exception("MODEL_BASE_URL_INVALID") from exc
    if port == (443 if scheme == "https" else 80):
        port = None
    netloc = f"{hostname}:{port}" if port is not None else hostname
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    return urlunsplit((scheme, netloc, path, parsed.query, ""))


def validate_model_base_url(value: str | None) -> None:
    _normalize_base_url(value)
