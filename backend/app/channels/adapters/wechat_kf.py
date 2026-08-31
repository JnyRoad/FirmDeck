"""Adapt WeChat Customer Service provider payloads to StaffDeck's channel data plane.

This module owns provider authentication, bounded media/text transport, account administration,
and inbound normalization. Callback verification and API routing belong to the later API task.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import threading
import time
from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePath
from typing import Any
from urllib.parse import unquote

import httpx
from cryptography.fernet import InvalidToken

from app.channels.adapters.base import (
    ChannelInbound,
    ChannelInboundAttachment,
    register_channel_adapter,
)
from app.channels.crypto import decrypt_channel_secret
from app.channels.media import MAX_CHANNEL_MEDIA_BYTES
from app.db.models import ChannelBinding

WECOM_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin"
TOKEN_REFRESH_SKEW_SECONDS = 300
TEXT_LIMIT_BYTES = 2048
WECOM_KF_IMAGE_MAX_BYTES = 2 * 1024 * 1024
WECOM_KF_FILE_MAX_BYTES = 20 * 1024 * 1024
_TOKEN_ERROR_CODES = {40014, 42001}
_RATE_LIMIT_ERROR_CODES = {45009, 45011}


class WeChatKfPermanentError(RuntimeError):
    """Report a provider or configuration error that should not be retried unchanged."""

    retryable = False


class WeChatKfNotFoundError(WeChatKfPermanentError):
    """Report that a provider account is already absent for idempotent deletion."""


class WeChatKfTransientError(RuntimeError):
    """Report a transport, token, or rate-limit failure that is safe to retry."""

    retryable = True


class WeChatKfMessageDisposition(StrEnum):
    """Classify provider messages without conflating unsupported and malformed payloads."""

    ACCEPTED = "accepted"
    IGNORED = "ignored"
    INVALID = "invalid"


@dataclass(frozen=True)
class WeChatKfNormalizedMessage:
    """Carry one normalization disposition and its accepted inbound value, if any."""

    disposition: WeChatKfMessageDisposition
    inbound: ChannelInbound | None = None


def _provider_error_code(payload: object) -> int:
    """Return the provider error code, treating malformed values as a transient response failure."""
    if not isinstance(payload, dict):
        raise WeChatKfTransientError("微信客服接口响应无效")
    try:
        return int(payload.get("errcode") or 0)
    except (TypeError, ValueError) as exc:
        raise WeChatKfTransientError("微信客服接口响应无效") from exc


def _provider_error_message(payload: dict[str, Any], error_code: int) -> str:
    """Build bounded diagnostic context from trusted provider error fields without credentials."""
    return str(payload.get("errmsg") or error_code)[:500]


def wechat_kf_credentials(binding: ChannelBinding) -> dict[str, str]:
    """Decrypt one binding's JSON credentials without exposing them outside adapter memory.

    The function has no persistent side effects. Missing, undecryptable, or non-object payloads
    raise a permanent configuration error before any provider request is attempted.
    """
    if not binding.credentials_enc:
        raise WeChatKfPermanentError("微信客服凭证未配置")
    try:
        credentials = json.loads(decrypt_channel_secret(binding.credentials_enc))
    except (InvalidToken, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise WeChatKfPermanentError("微信客服凭证无效") from exc
    if not isinstance(credentials, dict):
        raise WeChatKfPermanentError("微信客服凭证无效")
    return {str(key): str(value) for key, value in credentials.items()}


class WeChatKfTokenProvider:
    """Cache access tokens per immutable binding revision and refresh them before expiry."""

    def __init__(self, client_factory=httpx.Client) -> None:
        """Initialize an in-memory cache; construction performs no network or persistent writes."""
        self._client_factory = client_factory
        self._cache: dict[tuple[str, int], tuple[str, float]] = {}
        self._lock = threading.Lock()

    def invalidate(self, binding: ChannelBinding) -> None:
        """Drop only the current binding revision's token after provider rejection."""
        with self._lock:
            self._cache.pop((binding.id, binding.config_revision), None)

    def get(self, binding: ChannelBinding) -> str:
        """Return a cached token or fetch one using the binding's corporation and secret.

        A successful fetch mutates only the process-local cache. Configuration/provider errors are
        permanent; HTTP, malformed-response, and empty-token failures are transient.
        """
        key = (binding.id, binding.config_revision)
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(key)
            if cached and cached[1] > now:
                return cached[0]

        config = dict(binding.config_json or {})
        credentials = wechat_kf_credentials(binding)
        corp_id = str(config.get("corp_id") or "").strip()
        secret = credentials.get("secret", "").strip()
        if not corp_id or not secret:
            raise WeChatKfPermanentError("微信客服企业 ID 或 Secret 缺失")

        request_failed = False
        try:
            with self._client_factory(timeout=15.0) as client:
                response = client.get(
                    f"{WECOM_API_BASE}/gettoken",
                    params={"corpid": corp_id, "corpsecret": secret},
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError):
            # Leave the secret-bearing httpx exception scope before creating the stable error.
            request_failed = True
        if request_failed:
            raise WeChatKfTransientError("获取微信客服 access_token 失败")
        error_code = _provider_error_code(payload)
        if error_code in _TOKEN_ERROR_CODES:
            raise WeChatKfTransientError("微信客服 access_token 请求失效")
        if error_code in _RATE_LIMIT_ERROR_CODES:
            raise WeChatKfTransientError(
                "获取微信客服 access_token 限流: "
                f"{_provider_error_message(payload, error_code)}"
            )
        if error_code:
            raise WeChatKfPermanentError(
                "获取微信客服 access_token 失败: "
                f"{_provider_error_message(payload, error_code)}"
            )
        token = str(payload.get("access_token") or "").strip()
        if not token:
            raise WeChatKfTransientError("微信客服 access_token 响应为空")
        try:
            expires_in = int(payload.get("expires_in") or 7200)
        except (TypeError, ValueError) as exc:
            raise WeChatKfTransientError("微信客服 access_token 有效期无效") from exc
        refresh_after = max(0, expires_in - TOKEN_REFRESH_SKEW_SECONDS)
        with self._lock:
            self._cache[key] = (token, now + refresh_after)
        return token


def normalize_wechat_kf_message(
    raw: dict[str, Any], *, account_scope: str = ""
) -> ChannelInbound | None:
    """Return the accepted inbound value while preserving the adapter compatibility API."""
    return classify_wechat_kf_message(raw, account_scope=account_scope).inbound


def classify_wechat_kf_message(
    raw: dict[str, Any], *, account_scope: str = ""
) -> WeChatKfNormalizedMessage:
    """Classify and normalize one customer-originated provider message.

    Unsupported origins and message types are ignored. Once provider origin 3 selects a supported
    type, missing identity or malformed nested content is invalid so callers can quarantine or
    stop cursor advancement. The function performs no I/O or persistent writes.
    """
    if not isinstance(raw, dict):
        return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.IGNORED)
    try:
        if int(raw.get("origin") or 0) != 3:
            return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.IGNORED)
    except (TypeError, ValueError):
        return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.IGNORED)
    message_type = str(raw.get("msgtype") or "").strip()
    if message_type not in {"text", "image", "file", "mixed"}:
        return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.IGNORED)
    message_id = str(raw.get("msgid") or "").strip()
    external_user_id = str(raw.get("external_userid") or "").strip()
    open_kfid = str(raw.get("open_kfid") or "").strip()
    if not message_id or not external_user_id or not open_kfid:
        return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)

    text = ""
    attachments: list[ChannelInboundAttachment] = []
    if message_type == "text":
        text_payload = raw.get("text")
        if not isinstance(text_payload, dict):
            return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)
        content = text_payload.get("content")
        if not isinstance(content, str) or not content.strip():
            return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)
        text = content.strip()
    elif message_type in {"image", "file"}:
        attachments = _wechat_kf_attachments(raw, message_id, message_type)
        if not attachments:
            return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)
    elif message_type == "mixed":
        mixed = raw.get("mixed")
        if not isinstance(mixed, dict):
            return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)
        items = mixed.get("msg_item")
        if not isinstance(items, list) or not items:
            return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)
        for item in items:
            if not isinstance(item, dict):
                return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)
            item_type = str(item.get("msgtype") or "").strip()
            if item_type == "text":
                text_payload = item.get("text")
                if not isinstance(text_payload, dict):
                    return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)
                content = text_payload.get("content")
                if not isinstance(content, str) or not content.strip():
                    return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)
                value = content.strip()
                text = f"{text}\n{value}".strip() if text else value
            elif item_type in {"image", "file"}:
                item_attachments = _wechat_kf_attachments(item, message_id, item_type)
                if not item_attachments:
                    return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.INVALID)
                attachments.extend(item_attachments)
    if not text and not attachments:
        return WeChatKfNormalizedMessage(WeChatKfMessageDisposition.IGNORED)
    return WeChatKfNormalizedMessage(
        WeChatKfMessageDisposition.ACCEPTED,
        ChannelInbound(
            channel="wechat_kf",
            event_id=message_id,
            from_user_id=external_user_id,
            to_user_id=open_kfid,
            session_id=external_user_id,
            group_id="",
            context_token=open_kfid,
            text=text,
            is_group=False,
            raw=raw,
            account_scope=account_scope,
            attachments=attachments,
        ),
    )


def _wechat_kf_attachments(
    raw: dict[str, Any], message_id: str, message_type: str
) -> list[ChannelInboundAttachment]:
    """Convert one trusted image/file item into bounded deferred-download metadata."""
    info = raw.get(message_type) or {}
    if not isinstance(info, dict):
        return []
    media_id = str(info.get("media_id") or info.get("file_id") or "").strip()
    if not media_id:
        return []
    if message_type == "image":
        return [
            ChannelInboundAttachment(
                media_id=media_id,
                kind="image",
                filename=f"{message_id}.jpg",
                content_type="image/jpeg",
                download_params={
                    "media_id": media_id,
                    "provider_max_bytes": WECOM_KF_IMAGE_MAX_BYTES,
                },
            )
        ]
    filename = str(
        info.get("filename")
        or info.get("file_name")
        or info.get("name")
        or f"{message_id}.bin"
    ).strip()
    content_type = str(info.get("content_type") or info.get("mime_type") or "").strip()
    content_type = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return [
        ChannelInboundAttachment(
            media_id=media_id,
            kind="file",
            filename=filename,
            content_type=content_type,
            download_params={
                "media_id": media_id,
                "provider_max_bytes": WECOM_KF_FILE_MAX_BYTES,
            },
        )
    ]


def _split_utf8_text(text: str, limit: int = TEXT_LIMIT_BYTES) -> list[str]:
    """Split text on Unicode code-point boundaries so every encoded chunk fits ``limit`` bytes."""
    if limit <= 0:
        raise ValueError("UTF-8 chunk limit must be positive")
    chunks: list[str] = []
    current: list[str] = []
    current_bytes = 0
    for character in text:
        character_bytes = len(character.encode("utf-8"))
        if character_bytes > limit:
            raise ValueError("UTF-8 chunk limit cannot contain one code point")
        if current and current_bytes + character_bytes > limit:
            chunks.append("".join(current))
            current = []
            current_bytes = 0
        current.append(character)
        current_bytes += character_bytes
    if current:
        chunks.append("".join(current))
    return chunks


def _filename_from_content_disposition(value: str) -> str:
    """Extract a percent-decoded filename while removing provider-supplied path components."""
    if not value:
        return ""
    match = re.search(
        r"filename\*=UTF-8''([^;]+)|filename=\"?([^;\"]+)",
        value,
        re.IGNORECASE,
    )
    if not match:
        return ""
    filename = unquote((match.group(1) or match.group(2) or "").strip()).strip()
    return PurePath(filename.replace("\\", "/")).name[:255]


class WeChatKfAdapter:
    """Provide StaffDeck's normalized and outbound operations for WeChat客服."""

    def __init__(self, token_provider: WeChatKfTokenProvider | None = None) -> None:
        """Use the supplied token provider or create one process-local provider cache."""
        self._tokens = token_provider or WeChatKfTokenProvider()

    def normalize(self, raw: dict[str, Any]) -> ChannelInbound | None:
        """Normalize a raw provider message without assigning a binding-specific scope."""
        return normalize_wechat_kf_message(raw)

    def _post(
        self, binding: ChannelBinding, path: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        """POST JSON and classify not-found, token, rate, permanent, and transient failures.

        The call performs network I/O. Expired tokens invalidate only this binding revision;
        transport, malformed JSON, token, and rate-limit failures are retryable.
        """
        token = self._tokens.get(binding)
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.post(
                    f"{WECOM_API_BASE}{path}",
                    params={"access_token": token},
                    json=body,
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                raise WeChatKfNotFoundError("微信客服账号不存在") from None
            raise WeChatKfTransientError("微信客服接口请求失败") from None
        except (httpx.HTTPError, ValueError):
            raise WeChatKfTransientError("微信客服接口请求失败") from None
        error_code = _provider_error_code(payload)
        if error_code == 404:
            raise WeChatKfNotFoundError("微信客服账号不存在")
        if error_code in _TOKEN_ERROR_CODES:
            self._tokens.invalidate(binding)
            raise WeChatKfTransientError("微信客服 access_token 已失效")
        if error_code in _RATE_LIMIT_ERROR_CODES:
            raise WeChatKfTransientError(
                f"微信客服接口限流: {_provider_error_message(payload, error_code)}"
            )
        if error_code:
            raise WeChatKfPermanentError(
                f"微信客服接口失败: {_provider_error_message(payload, error_code)}"
            )
        return payload

    def download_media(
        self,
        binding: ChannelBinding,
        attachment: ChannelInboundAttachment,
        *,
        max_bytes: int = 0,
    ) -> bytes:
        """Download one image/file within both StaffDeck and provider byte limits.

        Successful responses may update the in-memory descriptor's safe filename and MIME type.
        Network/empty/malformed responses are transient, provider validation errors are permanent,
        and size violations propagate as ``ValueError`` without retaining partial content.
        """
        media_id = str(
            attachment.download_params.get("media_id") or attachment.media_id
        ).strip()
        if not media_id:
            raise WeChatKfPermanentError("微信客服附件缺少 media_id")
        provider_limit = int(
            attachment.download_params.get("provider_max_bytes") or MAX_CHANNEL_MEDIA_BYTES
        )
        limit = min(max_bytes or MAX_CHANNEL_MEDIA_BYTES, provider_limit)
        token = self._tokens.get(binding)
        try:
            with httpx.Client(timeout=20.0) as client, client.stream(
                "GET",
                f"{WECOM_API_BASE}/media/get",
                params={"access_token": token, "media_id": media_id},
            ) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                disposition = response.headers.get("content-disposition", "")
                response_filename = _filename_from_content_disposition(disposition)
                if response_filename:
                    attachment.filename = response_filename
                if content_type and "application/octet-stream" not in content_type.lower():
                    attachment.content_type = content_type.split(";", 1)[0].strip()
                elif attachment.filename:
                    attachment.content_type = (
                        mimetypes.guess_type(attachment.filename)[0] or attachment.content_type
                    )
                content_length = int(response.headers.get("content-length") or 0)
                if content_length > limit:
                    raise ValueError(f"微信客服附件超过大小上限: size>{limit}")
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes(64 * 1024):
                    total += len(chunk)
                    if total > limit:
                        raise ValueError(f"微信客服附件超过大小上限: size>{limit}")
                    chunks.append(chunk)
                downloaded = b"".join(chunks)
        except (httpx.HTTPError, ValueError) as exc:
            if isinstance(exc, ValueError) and "超过大小上限" in str(exc):
                raise
            raise WeChatKfTransientError("下载微信客服附件失败") from exc
        if "application/json" in content_type.lower():
            try:
                payload = json.loads(downloaded)
            except json.JSONDecodeError as exc:
                raise WeChatKfTransientError("微信客服附件下载响应无效") from exc
            error_code = _provider_error_code(payload)
            if error_code in _TOKEN_ERROR_CODES:
                self._tokens.invalidate(binding)
                raise WeChatKfTransientError("微信客服 access_token 已失效")
            if error_code in _RATE_LIMIT_ERROR_CODES:
                raise WeChatKfTransientError(
                    f"下载微信客服附件限流: {_provider_error_message(payload, error_code)}"
                )
            raise WeChatKfPermanentError(
                f"下载微信客服附件失败: {_provider_error_message(payload, error_code)}"
            )
        if not downloaded:
            raise WeChatKfTransientError("微信客服附件下载内容为空")
        return downloaded

    def sync_messages(
        self,
        binding: ChannelBinding,
        *,
        callback_token: str,
        cursor: str,
        open_kfid: str = "",
    ) -> dict[str, Any]:
        """Fetch one provider message page for the selected or legacy configured客服 account."""
        config = dict(binding.config_json or {})
        body: dict[str, Any] = {
            "open_kfid": open_kfid or str(config.get("open_kfid") or ""),
            "token": callback_token,
            "limit": 1000,
            "voice_format": 0,
        }
        if cursor:
            body["cursor"] = cursor
        return self._post(binding, "/kf/sync_msg", body)

    def validate_account(self, binding: ChannelBinding) -> None:
        """Verify that the application can manage the binding's configured客服 account."""
        config = dict(binding.config_json or {})
        open_kfid = str(config.get("open_kfid") or "").strip()
        payload = self._post(binding, "/kf/account/list", {"offset": 0, "limit": 100})
        accounts = payload.get("account_list") or []
        if not any(
            str(account.get("open_kfid") or "").strip() == open_kfid
            and account.get("manage_privilege") is not False
            for account in accounts
            if isinstance(account, dict)
        ):
            raise WeChatKfPermanentError("应用无权管理该微信客服账号")

    def list_accounts(self, binding: ChannelBinding) -> list[dict[str, Any]]:
        """List all manageable客服 accounts with a fixed 50-page safety bound."""
        accounts: list[dict[str, Any]] = []
        offset = 0
        limit = 100
        for _page in range(50):
            payload = self._post(
                binding, "/kf/account/list", {"offset": offset, "limit": limit}
            )
            page = [
                item for item in payload.get("account_list") or [] if isinstance(item, dict)
            ]
            accounts.extend(page)
            if len(page) < limit:
                return accounts
            offset += limit
        raise WeChatKfTransientError("微信客服账号列表分页超过安全上限")

    def create_account(self, binding: ChannelBinding, name: str) -> str:
        """Reject avatar-less account creation because the provider requires a media ID."""
        raise WeChatKfPermanentError("创建微信客服账号需要头像 media_id")

    def create_account_with_avatar(
        self, binding: ChannelBinding, name: str, media_id: str
    ) -> str:
        """Create a named客服 account from an uploaded avatar media ID and return ``open_kfid``."""
        normalized_name = name.strip()
        normalized_media_id = media_id.strip()
        if not normalized_name or len(normalized_name) > 16 or not normalized_media_id:
            raise WeChatKfPermanentError("微信客服账号名称不能为空且不能超过 16 个字符")
        payload = self._post(
            binding,
            "/kf/account/add",
            {"name": normalized_name, "media_id": normalized_media_id},
        )
        open_kfid = str(payload.get("open_kfid") or "").strip()
        if not open_kfid:
            raise WeChatKfTransientError("微信客服创建账号响应缺少 open_kfid")
        return open_kfid

    def delete_account(self, binding: ChannelBinding, open_kfid: str) -> None:
        """Delete one non-empty provider客服 account identifier."""
        normalized_open_kfid = open_kfid.strip()
        if not normalized_open_kfid:
            raise WeChatKfPermanentError("客服账号 ID 不能为空")
        self._post(binding, "/kf/account/del", {"open_kfid": normalized_open_kfid})

    def update_account(
        self,
        binding: ChannelBinding,
        open_kfid: str,
        name: str,
        media_id: str | None = None,
    ) -> None:
        """Update one客服 account's required name and optional uploaded avatar."""
        normalized_open_kfid = open_kfid.strip()
        normalized_name = name.strip()
        if not normalized_open_kfid or not normalized_name or len(normalized_name) > 16:
            raise WeChatKfPermanentError(
                "客服账号 ID 和名称不能为空，名称不能超过 16 个字符"
            )
        body = {"open_kfid": normalized_open_kfid, "name": normalized_name}
        if media_id:
            body["media_id"] = media_id.strip()
        self._post(binding, "/kf/account/update", body)

    def upload_avatar(
        self,
        binding: ChannelBinding,
        data: bytes,
        filename: str,
        content_type: str = "image/jpeg",
    ) -> str:
        """Upload avatar bytes and return the provider media ID.

        The call performs bounded-time network I/O but does not persist bytes locally. HTTP,
        malformed JSON, and missing media IDs are transient; provider validation is permanent.
        """
        if not data or len(data) > WECOM_KF_IMAGE_MAX_BYTES:
            raise WeChatKfPermanentError("微信客服头像必须为非空且不超过 2 MiB")
        token = self._tokens.get(binding)
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.post(
                    f"{WECOM_API_BASE}/media/upload",
                    params={"access_token": token, "type": "image"},
                    files={"media": (filename, data, content_type)},
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise WeChatKfTransientError("上传微信客服头像失败") from exc
        error_code = _provider_error_code(payload)
        if error_code in _TOKEN_ERROR_CODES:
            self._tokens.invalidate(binding)
            raise WeChatKfTransientError("微信客服 access_token 已失效")
        if error_code in _RATE_LIMIT_ERROR_CODES:
            raise WeChatKfTransientError(
                f"上传微信客服头像限流: {_provider_error_message(payload, error_code)}"
            )
        if error_code:
            raise WeChatKfPermanentError(
                f"上传微信客服头像失败: {_provider_error_message(payload, error_code)}"
            )
        media_id = str(payload.get("media_id") or "").strip()
        if not media_id:
            raise WeChatKfTransientError("微信客服头像上传响应缺少 media_id")
        return media_id

    def contact_way(
        self, binding: ChannelBinding, *, open_kfid: str, scene: str = "staffdeck"
    ) -> str:
        """Create a provider consultation URL for one non-empty客服 account."""
        normalized_open_kfid = open_kfid.strip()
        if not normalized_open_kfid:
            raise WeChatKfPermanentError("客服账号 ID 不能为空")
        payload = self._post(
            binding,
            "/kf/add_contact_way",
            {"open_kfid": normalized_open_kfid, "scene": scene},
        )
        url = str(payload.get("url") or "").strip()
        if not url:
            raise WeChatKfTransientError("微信客服咨询链接响应为空")
        return url

    def send(
        self,
        binding: ChannelBinding,
        target: dict[str, Any],
        text: str,
        *,
        idempotency_key: str | None = None,
    ) -> None:
        """Send byte-bounded text chunks with deterministic per-chunk provider message IDs.

        The function performs one network write per non-empty chunk. Invalid targets fail before
        writes; provider errors propagate with their retry classification.
        """
        to_user = str(target.get("to_user_id") or "").strip()
        open_kfid = str(target.get("open_kfid") or "").strip()
        if not to_user or not open_kfid:
            raise WeChatKfPermanentError("微信客服投递目标无效")
        normalized_key = str(idempotency_key or "").strip()
        if not normalized_key:
            raise WeChatKfPermanentError("微信客服投递缺少幂等键")
        key = hashlib.sha256(normalized_key.encode("utf-8")).hexdigest()[:32]

        # Split before the first write so every provider request respects its UTF-8 byte limit.
        chunks = _split_utf8_text(text)
        for index, chunk in enumerate(chunks):
            message_id = key
            if index:
                message_id = hashlib.sha256(f"{key}:{index}".encode()).hexdigest()[:32]
            self._post(
                binding,
                "/kf/send_msg",
                {
                    "touser": to_user,
                    "open_kfid": open_kfid,
                    "msgid": message_id,
                    "msgtype": "text",
                    "text": {"content": chunk},
                },
            )

    def start_ingress(self, binding_id: str) -> None:
        """Leave ingress lifecycle to the callback API task; this adapter starts no worker."""

    def stop_ingress(self, binding_id: str) -> None:
        """Leave ingress lifecycle to the callback API task; this adapter owns no worker."""


register_channel_adapter("wechat_kf", WeChatKfAdapter())
