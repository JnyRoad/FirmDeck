"""微信客服无认证回调入口：验签、解密、限界同步并写入 durable inbox。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import struct
import time
from typing import Any

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from defusedxml import ElementTree as ET
from defusedxml.common import DefusedXmlException
from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlmodel import Session, select
from starlette.concurrency import run_in_threadpool
from starlette.types import ASGIApp, Receive, Scope, Send

from app.api.channels import _channel_http_error
from app.channels import binding_lifecycle_lock
from app.channels.adapters.base import get_channel_adapter
from app.channels.adapters.wechat_kf import (
    WeChatKfAdapter,
    WeChatKfMessageDisposition,
    WeChatKfPermanentError,
    WeChatKfTransientError,
    classify_wechat_kf_message,
    wechat_kf_credentials,
)
from app.channels.service_durable_inbox import StageDisposition
from app.channels.service_intake import wake_staged_inbound_worker
from app.channels.service_wechat_kf_inbox import stage_wechat_kf_inbound
from app.db import engine
from app.db.models import ChannelBinding, WeChatKfAccount, utc_now

router = APIRouter(prefix="/api/channels/wechat-kf", tags=["wechat-kf"])

CALLBACK_TIMESTAMP_MAX_AGE_SECONDS = 5 * 60
CALLBACK_BODY_MAX_BYTES = 1024 * 1024
CALLBACK_XML_MAX_BYTES = 256 * 1024
CALLBACK_MAX_PAGES = 20
CALLBACK_MAX_MESSAGES_PER_PAGE = 1000
CALLBACK_CURSOR_MAX_CHARS = 4096
CALLBACK_SYNC_TOKEN_MAX_CHARS = 4096
AVATAR_REQUEST_MAX_BYTES = 2 * 1024 * 1024 + 64 * 1024


class WeChatKfAvatarRequestLimitMiddleware:
    """Reject oversized avatar multipart requests before FastAPI parses the form."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap one ASGI application without reading any request eagerly."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Apply a streaming hard limit only to the WeChat客服 avatar upload route."""
        if not self._is_avatar_request(scope):
            await self.app(scope, receive, send)
            return

        content_length = self._content_length(scope)
        if content_length is not None and content_length > AVATAR_REQUEST_MAX_BYTES:
            await self._send_rejection(scope, send)
            return

        # Buffer at most the hard limit before calling the downstream app, so multipart parsing
        # cannot begin until the complete request has passed the total-size gate.
        consumed = 0
        buffered: list[dict[str, Any]] = []
        while True:
            message = await receive()
            if message.get("type") == "http.request":
                consumed += len(message.get("body", b""))
                if consumed > AVATAR_REQUEST_MAX_BYTES:
                    await self._send_rejection(scope, send)
                    return
            buffered.append(message)
            if message.get("type") != "http.request" or not message.get("more_body", False):
                break

        async def replay_receive() -> dict[str, Any]:
            """Replay only the already bounded request messages to the multipart parser."""
            if buffered:
                return buffered.pop(0)
            return {"type": "http.disconnect"}

        await self.app(scope, replay_receive, send)

    @staticmethod
    def _is_avatar_request(scope: Scope) -> bool:
        """Return whether the scope targets the single protected multipart route."""
        path = str(scope.get("path") or "")
        parts = path.rstrip("/").split("/")
        return (
            scope.get("type") == "http"
            and scope.get("method") == "POST"
            and len(parts) == 7
            and parts[:4] == ["", "api", "enterprise", "channels"]
            and parts[5:] == ["wechat_kf", "avatar"]
            and bool(parts[4])
        )

    @staticmethod
    def _content_length(scope: Scope) -> int | None:
        """Read a valid non-negative Content-Length from raw headers when present."""
        for name, value in scope.get("headers", []):
            if name.lower() != b"content-length":
                continue
            try:
                parsed = int(value.decode("ascii"))
            except (UnicodeDecodeError, ValueError):
                return AVATAR_REQUEST_MAX_BYTES + 1
            return parsed if parsed >= 0 else AVATAR_REQUEST_MAX_BYTES + 1
        return None

    @staticmethod
    async def _send_rejection(scope: Scope, send: Send) -> None:
        """Send the canonical bounded-request descriptor without framework detail."""
        projected = _channel_http_error(413, "wechat kf avatar request too large")
        response = JSONResponse(
            status_code=413,
            content={"detail": projected.detail},
        )
        await response(scope, receive=None, send=send)  # type: ignore[arg-type]


def _callback_signature(token: str, timestamp: str, nonce: str, ciphertext: str) -> str:
    """按企业微信回调协议计算签名；输入只在内存使用，无外部副作用。"""
    values = sorted((token, timestamp, nonce, ciphertext))
    # 企业微信固定要求 sha1(sort(token, timestamp, nonce, msg_encrypt))：
    # https://developer.work.weixin.qq.com/document/path/90968
    # usedforsecurity=False 只声明外部旧协议兼容；协议升级前不能改成 SHA-256 或 HMAC。
    return hashlib.sha1("".join(values).encode("utf-8"), usedforsecurity=False).hexdigest()


def _verify_callback(
    token: str,
    msg_signature: str,
    timestamp: str,
    nonce: str,
    ciphertext: str,
) -> None:
    """校验时间新鲜度与签名；失败只返回注册错误，原始字段不公开。"""
    try:
        callback_timestamp = int(timestamp)
    except (TypeError, ValueError) as exc:
        raise _channel_http_error(400, exc) from exc
    age_seconds = time.time() - callback_timestamp
    if abs(age_seconds) > CALLBACK_TIMESTAMP_MAX_AGE_SECONDS:
        raise _channel_http_error(403, "callback timestamp outside freshness window")
    expected = _callback_signature(token, timestamp, nonce, ciphertext)
    if not hmac.compare_digest(expected, msg_signature):
        raise _channel_http_error(403, "callback signature mismatch")


def _decrypt_callback_message(ciphertext: str, aes_key: str, corp_id: str) -> str:
    """解密并校验企业接收身份；不回显密文、密钥或 provider 明文。"""
    try:
        key = base64.urlsafe_b64decode(aes_key + "=")
        if len(key) != 32:
            raise ValueError("invalid callback AES key length")
        encrypted = base64.b64decode(ciphertext, validate=True)
        if not encrypted or len(encrypted) > CALLBACK_BODY_MAX_BYTES:
            raise ValueError("invalid callback ciphertext size")
        decryptor = Cipher(algorithms.AES(key), modes.CBC(key[:16])).decryptor()
        padded = decryptor.update(encrypted) + decryptor.finalize()
        if not padded:
            raise ValueError("empty callback plaintext")
        padding = padded[-1]
        if not 1 <= padding <= 32 or padded[-padding:] != bytes((padding,)) * padding:
            raise ValueError("invalid callback padding")
        payload = padded[:-padding]
        if len(payload) < 20:
            raise ValueError("callback frame too short")
        content_length = struct.unpack("!I", payload[16:20])[0]
        content_end = 20 + content_length
        if content_length > CALLBACK_XML_MAX_BYTES or content_end > len(payload):
            raise ValueError("callback frame length invalid")
        content = payload[20:content_end]
        receive_id = payload[content_end:].decode("utf-8")
        if not corp_id or receive_id != corp_id:
            raise PermissionError("callback receive identity mismatch")
        return content.decode("utf-8")
    except PermissionError as exc:
        raise _channel_http_error(403, exc) from exc
    except (ValueError, IndexError, struct.error, UnicodeDecodeError) as exc:
        raise _channel_http_error(400, exc) from exc


def _callback_binding(
    binding_id: str, *, allow_pending: bool = False
) -> tuple[ChannelBinding, dict[str, str]]:
    """读取可用微信客服绑定和私有凭据快照；数据库只读。"""
    with Session(engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        allowed_status = {"active", "pending"} if allow_pending else {"active"}
        if (
            binding is None
            or binding.channel != "wechat_kf"
            or binding.status not in allowed_status
        ):
            raise _channel_http_error(404, "wechat kf binding unavailable")
        try:
            credentials = wechat_kf_credentials(binding)
        except (WeChatKfPermanentError, ValueError, TypeError) as exc:
            raise _channel_http_error(400, exc) from exc
        db.expunge(binding)
    return binding, credentials


def _xml_text(root: ET.Element, name: str) -> str:
    """读取受控 XML 子节点文本并去除边缘空白，无副作用。"""
    node = root.find(name)
    return str(node.text or "").strip() if node is not None else ""


def _parse_callback_xml(data: str | bytes) -> ET.Element:
    """使用禁用 DTD、实体和外部引用的解析器读取有界 XML。"""
    raw = data.encode("utf-8") if isinstance(data, str) else data
    if not raw or len(raw) > CALLBACK_XML_MAX_BYTES:
        raise ValueError("callback XML size invalid")
    return ET.fromstring(
        raw,
        forbid_dtd=True,
        forbid_entities=True,
        forbid_external=True,
    )


def _save_account_cursor(account_id: str, cursor: str, expected_revision: int) -> None:
    """在整次分页成功后提交账号游标和连接状态；会写数据库。"""
    with Session(engine) as db:
        account = db.get(WeChatKfAccount, account_id)
        if account is None:
            raise _channel_http_error(409, "wechat kf account disappeared before cursor commit")
        account.sync_cursor = cursor
        account.last_sync_at = utc_now()
        account.last_error = None
        account.updated_at = utc_now()
        db.add(account)
        binding = db.get(ChannelBinding, account.binding_id)
        if binding is None or binding.config_revision != expected_revision:
            raise _channel_http_error(409, "wechat kf binding changed before cursor commit")
        binding.connected = True
        binding.last_connected_at = utc_now()
        binding.updated_at = utc_now()
        db.add(binding)
        db.commit()


def _save_account_error(account_id: str, error_code: str) -> None:
    """保存稳定同步错误码；只写数据库且不保留 provider 正文或异常文本。"""
    with Session(engine) as db:
        account = db.get(WeChatKfAccount, account_id)
        if account is None:
            return
        account.last_error = (
            error_code
            if error_code
            in {"CHANNEL_BAD_REQUEST", "CHANNEL_CONFLICT", "CHANNEL_UPSTREAM_ERROR"}
            else "INTERNAL_ERROR"
        )
        account.updated_at = utc_now()
        db.add(account)
        db.commit()


def _account_for_callback(binding: ChannelBinding, open_kfid: str) -> WeChatKfAccount:
    """按 tenant、binding、账号和活跃状态读取回调账号快照；数据库只读。"""
    with Session(engine) as db:
        account = db.exec(
            select(WeChatKfAccount).where(
                WeChatKfAccount.tenant_id == binding.tenant_id,
                WeChatKfAccount.binding_id == binding.id,
                WeChatKfAccount.open_kfid == open_kfid,
                WeChatKfAccount.status == "active",
            )
        ).first()
        if account is None:
            raise _channel_http_error(404, "wechat kf callback account not bound")
        db.expunge(account)
    return account


def _validate_sync_page(data: Any, current_cursor: str) -> tuple[list[dict[str, Any]], str, bool]:
    """校验 provider 消息页、游标和分页边界；不修改游标或数据库。"""
    if not isinstance(data, dict):
        raise _channel_http_error(502, "wechat kf sync response is not an object")
    try:
        error_code = int(data.get("errcode") or 0)
    except (TypeError, ValueError) as exc:
        raise _channel_http_error(502, exc) from exc
    if error_code != 0:
        raise _channel_http_error(502, f"wechat kf provider error code {error_code}")
    raw_messages = data.get("msg_list")
    if not isinstance(raw_messages, list) or len(raw_messages) > CALLBACK_MAX_MESSAGES_PER_PAGE:
        raise _channel_http_error(502, "wechat kf sync message page invalid")
    if any(not isinstance(item, dict) for item in raw_messages):
        raise _channel_http_error(502, "wechat kf sync message item invalid")
    try:
        has_more = int(data.get("has_more") or 0)
    except (TypeError, ValueError) as exc:
        raise _channel_http_error(502, exc) from exc
    if has_more not in {0, 1}:
        raise _channel_http_error(502, "wechat kf has_more outside allowed values")
    next_cursor_raw = data.get("next_cursor")
    if next_cursor_raw is not None and not isinstance(next_cursor_raw, str):
        raise _channel_http_error(502, "wechat kf next_cursor is not text")
    next_cursor = (next_cursor_raw or current_cursor).strip()
    if len(next_cursor) > CALLBACK_CURSOR_MAX_CHARS:
        raise _channel_http_error(502, "wechat kf next_cursor too large")
    if has_more == 1 and (not next_cursor or next_cursor == current_cursor):
        raise _channel_http_error(502, "wechat kf pagination did not advance")
    return raw_messages, next_cursor, has_more == 1


def _stage_sync_page(
    *,
    binding: ChannelBinding,
    account_scope: str,
    raw_messages: list[dict[str, Any]],
) -> bool:
    """规范化并暂存一页客户消息；写 durable inbox，失败不推进账号游标。"""
    staged = False
    for raw in raw_messages:
        normalized = classify_wechat_kf_message(raw, account_scope=account_scope)
        if normalized.disposition is WeChatKfMessageDisposition.INVALID:
            raise _channel_http_error(502, "wechat kf supported message payload invalid")
        if normalized.disposition is WeChatKfMessageDisposition.IGNORED:
            continue
        inbound = normalized.inbound
        if inbound is None:
            raise _channel_http_error(502, "wechat kf accepted message missing inbound")
        result = stage_wechat_kf_inbound(
            db_engine=engine,
            binding_id=binding.id,
            expected_revision=binding.config_revision,
            account_scope=account_scope,
            inbound=inbound,
        )
        if result.disposition not in {
            StageDisposition.STAGED,
            StageDisposition.DUPLICATE,
        }:
            raise _channel_http_error(409, result.error_code or "wechat kf staging rejected")
        staged = staged or result.disposition == StageDisposition.STAGED
    return staged


@router.get("/{binding_id}/callback")
def verify_callback_url(
    binding_id: str,
    msg_signature: str = Query("", max_length=128),
    timestamp: str = Query("", max_length=32),
    nonce: str = Query("", max_length=256),
    echostr: str = Query("", max_length=CALLBACK_BODY_MAX_BYTES),
) -> Response:
    """验证微信客服后台回调 URL；只返回已验签且已校验企业身份的明文。"""
    # 先拒绝缺失字段，避免查询绑定或解密无意义输入。
    if not all((msg_signature, timestamp, nonce, echostr)):
        raise _channel_http_error(400, "wechat kf callback query incomplete")
    # 再读取绑定私有配置并完成时间、签名、AES 与企业身份验证。
    binding, credentials = _callback_binding(binding_id, allow_pending=True)
    _verify_callback(
        credentials.get("callback_token", ""),
        msg_signature,
        timestamp,
        nonce,
        echostr,
    )
    plaintext = _decrypt_callback_message(
        echostr,
        credentials.get("encoding_aes_key", ""),
        str((binding.config_json or {}).get("corp_id") or "").strip(),
    )
    return Response(content=plaintext, media_type="text/plain")


@router.post("/{binding_id}/callback")
async def receive_callback(
    binding_id: str,
    request: Request,
    msg_signature: str = Query("", max_length=128),
    timestamp: str = Query("", max_length=32),
    nonce: str = Query("", max_length=256),
) -> Response:
    """验签并同步客户消息；先 durable stage，全批成功后提交账号游标。"""
    # 先限界请求元数据和正文，避免未认证输入消耗 XML/AES/数据库资源。
    if not all((msg_signature, timestamp, nonce)):
        raise _channel_http_error(400, "wechat kf callback query incomplete")
    body = await _read_bounded_callback_body(request)
    # XML/AES、生命周期锁、SQLite、同步 httpx 和分页均在线程池执行，避免阻塞事件循环。
    return await run_in_threadpool(
        _receive_callback_sync,
        binding_id,
        body,
        msg_signature,
        timestamp,
        nonce,
    )


async def _read_bounded_callback_body(request: Request) -> bytes:
    """Stream one callback body and reject as soon as its hard limit is crossed."""
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError as exc:
            raise _channel_http_error(400, exc) from exc
        if declared_length < 0:
            raise _channel_http_error(400, "negative callback content length")
        if declared_length > CALLBACK_BODY_MAX_BYTES:
            raise _channel_http_error(413, "wechat kf callback body too large")

    chunks: list[bytes] = []
    consumed = 0
    async for chunk in request.stream():
        consumed += len(chunk)
        if consumed > CALLBACK_BODY_MAX_BYTES:
            raise _channel_http_error(413, "wechat kf callback body too large")
        if chunk:
            chunks.append(chunk)
    return b"".join(chunks)


def _receive_callback_sync(
    binding_id: str,
    body: bytes,
    msg_signature: str,
    timestamp: str,
    nonce: str,
) -> Response:
    """Run verified callback parsing, sync pagination, staging, and cursor commit synchronously."""
    try:
        envelope = _parse_callback_xml(body)
    except (ET.ParseError, DefusedXmlException, ValueError) as exc:
        raise _channel_http_error(400, exc) from exc
    ciphertext = _xml_text(envelope, "Encrypt")
    if not ciphertext or len(ciphertext) > CALLBACK_BODY_MAX_BYTES:
        raise _channel_http_error(400, "wechat kf callback Encrypt invalid")

    # 再绑定配置代际并完成签名、解密、企业身份与明文 XML 验证。
    binding, credentials = _callback_binding(binding_id, allow_pending=True)
    callback_revision = binding.config_revision
    _verify_callback(
        credentials.get("callback_token", ""),
        msg_signature,
        timestamp,
        nonce,
        ciphertext,
    )
    plaintext = _decrypt_callback_message(
        ciphertext,
        credentials.get("encoding_aes_key", ""),
        str((binding.config_json or {}).get("corp_id") or "").strip(),
    )
    try:
        event = _parse_callback_xml(plaintext)
    except (ET.ParseError, DefusedXmlException, ValueError) as exc:
        raise _channel_http_error(400, exc) from exc
    if _xml_text(event, "Event") != "kf_msg_or_event":
        return Response(content="success", media_type="text/plain")
    callback_token = _xml_text(event, "Token")
    open_kfid = _xml_text(event, "OpenKfId")
    if (
        not callback_token
        or len(callback_token) > CALLBACK_SYNC_TOKEN_MAX_CHARS
        or not open_kfid
        or len(open_kfid) > 128
    ):
        raise _channel_http_error(403, "wechat kf callback account fields invalid")

    # 最后在 binding 生命周期锁内重读 fence、分页拉取、逐页 stage，并原子提交最终游标。
    staged = False
    with binding_lifecycle_lock(binding_id):
        binding, _fresh_credentials = _callback_binding(binding_id, allow_pending=True)
        if binding.config_revision != callback_revision:
            raise _channel_http_error(409, "wechat kf callback revision changed")
        account = _account_for_callback(binding, open_kfid)
        adapter = get_channel_adapter("wechat_kf")
        if not isinstance(adapter, WeChatKfAdapter):
            raise _channel_http_error(502, "wechat kf adapter unavailable")
        corp_id = str((binding.config_json or {}).get("corp_id") or "").strip()
        account_scope = f"{corp_id}:{open_kfid}"
        cursor = str(account.sync_cursor or "")
        for _page in range(CALLBACK_MAX_PAGES):
            try:
                data = adapter.sync_messages(
                    binding,
                    callback_token=callback_token,
                    cursor=cursor,
                    open_kfid=open_kfid,
                )
                messages, next_cursor, has_more = _validate_sync_page(data, cursor)
                staged = (
                    _stage_sync_page(
                        binding=binding,
                        account_scope=account_scope,
                        raw_messages=messages,
                    )
                    or staged
                )
                cursor = next_cursor
            except WeChatKfPermanentError as exc:
                _save_account_error(account.id, "CHANNEL_BAD_REQUEST")
                raise _channel_http_error(400, exc) from exc
            except WeChatKfTransientError as exc:
                _save_account_error(account.id, "CHANNEL_UPSTREAM_ERROR")
                raise _channel_http_error(502, exc) from exc
            if not has_more:
                break
        else:
            _save_account_error(account.id, "CHANNEL_UPSTREAM_ERROR")
            raise _channel_http_error(502, "wechat kf pagination limit exceeded")
        _save_account_cursor(account.id, cursor, binding.config_revision)
    if staged:
        wake_staged_inbound_worker()
    return Response(content="success", media_type="text/plain")
