from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from openai import OpenAI
from sqlmodel import Session

from app.config import get_settings
from app.db import engine
from app.db.models import CodexSubscriptionCredential, utc_now
from app.security.encryption import decrypt_secret, encrypt_secret

_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/oauth/authorize"
_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"
_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
_REDIRECT_URI = "http://localhost:1455/auth/callback"
_OAUTH_SCOPE = "openid profile email offline_access"
_PENDING_LOGIN_SECONDS = 10 * 60
_REFRESH_SKEW_SECONDS = 120


class CodexSubscriptionError(Exception):
    """表示可安全展示的 ChatGPT 订阅授权或运行时错误码。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class CodexSubscriptionAccount:
    """保存可发送给浏览器的订阅状态，不包含任何 OAuth 机密。"""

    status: str
    plan_type: str | None
    message: str

    def to_dict(self) -> dict[str, str | None]:
        """将状态转换为既有 API 响应结构。"""
        return {
            "status": self.status,
            "plan_type": self.plan_type,
            "message": self.message,
        }


@dataclass(frozen=True)
class SubscriptionCredential:
    """表示仅在服务端内存中使用的 ChatGPT 订阅令牌包。"""

    access_token: str
    refresh_token: str
    account_id: str
    access_token_expires_at: datetime
    plan_type: str | None


@dataclass(frozen=True)
class CallbackCompletion:
    """表示 loopback 回调完成结果，消息可安全呈现给浏览器。"""

    success: bool
    message: str


@dataclass
class _PendingAuthorization:
    """保存一次性 PKCE 状态，完成、取消或过期后立即丢弃。"""

    state: str
    code_verifier: str
    created_at: float
    server: LoopbackCallbackServer


class CredentialStore(Protocol):
    """定义订阅凭据的最小持久化接口。"""

    def load(self) -> SubscriptionCredential | None: ...

    def save(self, credential: SubscriptionCredential) -> None: ...

    def clear(self) -> None: ...


class OAuthTokenClient(Protocol):
    """定义授权码交换和刷新令牌的外部边界。"""

    def exchange_authorization_code(self, *, code: str, code_verifier: str) -> dict[str, Any]: ...

    def refresh(self, refresh_token: str) -> dict[str, Any]: ...


class LoopbackCallbackServer(Protocol):
    """定义本机 OAuth 回调监听器，避免业务逻辑依赖 HTTP 实现细节。"""

    def start(
        self,
        callback: Callable[[str | None, str | None, str | None], CallbackCompletion],
    ) -> None: ...

    def stop(self) -> None: ...


class SqlSubscriptionCredentialStore:
    """使用现有加密设施持久化单个安装级订阅令牌包。"""

    def load(self) -> SubscriptionCredential | None:
        """读取并解密凭据；损坏或不可解密记录按未登录处理。"""
        with Session(engine) as db:
            row = db.get(CodexSubscriptionCredential, "default")
            if row is None:
                return None
            try:
                payload = json.loads(decrypt_secret(row.credential_encrypted))
            except (TypeError, ValueError, json.JSONDecodeError):
                return None
        return _credential_from_stored_payload(payload, row)

    def save(self, credential: SubscriptionCredential) -> None:
        """加密后原子替换安装级凭据，调用方永不接触密文细节。"""
        payload = {
            "access_token": credential.access_token,
            "refresh_token": credential.refresh_token,
            "account_id": credential.account_id,
        }
        encrypted = encrypt_secret(json.dumps(payload, separators=(",", ":")))
        with Session(engine) as db:
            row = db.get(CodexSubscriptionCredential, "default")
            if row is None:
                row = CodexSubscriptionCredential(
                    credential_encrypted=encrypted,
                    access_token_expires_at=credential.access_token_expires_at,
                    plan_type=credential.plan_type,
                )
            else:
                row.credential_encrypted = encrypted
                row.access_token_expires_at = credential.access_token_expires_at
                row.plan_type = credential.plan_type
                row.updated_at = utc_now()
            db.add(row)
            db.commit()

    def clear(self) -> None:
        """删除当前安装保存的订阅令牌，使后续请求必须重新授权。"""
        with Session(engine) as db:
            row = db.get(CodexSubscriptionCredential, "default")
            if row is not None:
                db.delete(row)
                db.commit()


class _OpenAIOAuthTokenClient:
    """调用 ChatGPT OAuth 令牌端点，并把上游细节收敛为安全错误码。"""

    def __init__(self, timeout_seconds: float) -> None:
        """保存有限网络超时，避免授权回调线程无限等待。"""
        self._timeout_seconds = timeout_seconds

    def exchange_authorization_code(self, *, code: str, code_verifier: str) -> dict[str, Any]:
        """用一次性授权码换取令牌包；失败不回显授权码或上游正文。"""
        return self._request_token(
            {
                "grant_type": "authorization_code",
                "client_id": _OAUTH_CLIENT_ID,
                "redirect_uri": _REDIRECT_URI,
                "code": code,
                "code_verifier": code_verifier,
            },
            failure_code="MODEL_SUBSCRIPTION_AUTH_FAILED",
        )

    def refresh(self, refresh_token: str) -> dict[str, Any]:
        """刷新订阅凭据；网络故障与凭据失效使用不同的安全错误码。"""
        return self._request_token(
            {
                "grant_type": "refresh_token",
                "client_id": _OAUTH_CLIENT_ID,
                "refresh_token": refresh_token,
            },
            failure_code="MODEL_SUBSCRIPTION_REFRESH_FAILED",
        )

    def _request_token(self, payload: dict[str, str], *, failure_code: str) -> dict[str, Any]:
        """发送令牌请求并只返回结构化 JSON；不记录凭据或上游文本。"""
        try:
            response = httpx.post(
                _TOKEN_ENDPOINT,
                data=payload,
                timeout=self._timeout_seconds,
                headers={"User-Agent": "StaffDeck"},
            )
        except httpx.HTTPError as exc:
            raise CodexSubscriptionError("MODEL_SUBSCRIPTION_NETWORK_UNAVAILABLE") from exc
        if response.status_code >= 500:
            raise CodexSubscriptionError("MODEL_SUBSCRIPTION_NETWORK_UNAVAILABLE")
        if response.status_code >= 400:
            raise CodexSubscriptionError(failure_code)
        try:
            body = response.json()
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise CodexSubscriptionError(failure_code) from exc
        if not isinstance(body, dict):
            raise CodexSubscriptionError(failure_code)
        return body


class _ThreadedLoopbackCallbackServer:
    """在 `localhost:1455` 接收单次 OAuth 回调且绝不写入回调查询日志。"""

    def __init__(self) -> None:
        """初始化尚未绑定端口的监听器状态。"""
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(
        self,
        callback: Callable[[str | None, str | None, str | None], CallbackCompletion],
    ) -> None:
        """绑定 loopback 端口并在后台提供一次性回调 HTTP 服务。"""
        server_callback = callback

        class CallbackHandler(BaseHTTPRequestHandler):
            """只处理本功能定义的 OAuth 回调路径。"""

            def do_GET(self) -> None:
                """验证回调参数并返回不包含 OAuth 数据的完成页面。"""
                parsed = urlsplit(self.path)
                if parsed.path != "/auth/callback":
                    self.send_error(404)
                    return
                query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=10)
                result = server_callback(
                    _single_query_value(query, "code"),
                    _single_query_value(query, "state"),
                    _single_query_value(query, "error"),
                )
                body = _callback_page(result.success).encode("utf-8")
                self.send_response(200 if result.success else 400)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: Any) -> None:
                """禁用默认访问日志，避免 URL 查询参数泄漏到普通日志。"""
                return

        server = ThreadingHTTPServer(("127.0.0.1", 1455), CallbackHandler)
        server.daemon_threads = True
        self._server = server
        self._thread = threading.Thread(
            target=server.serve_forever,
            daemon=True,
            name="chatgpt-oauth-loopback",
        )
        self._thread.start()

    def stop(self) -> None:
        """停止监听并释放 loopback 端口；可重复调用。"""
        server = self._server
        self._server = None
        self._thread = None
        if server is None:
            return
        server.shutdown()
        server.server_close()


class ChatGPTSubscriptionService:
    """协调直接 ChatGPT 浏览器授权、凭据刷新和订阅 OpenAI 客户端创建。"""

    def __init__(
        self,
        *,
        credential_store: CredentialStore | None = None,
        oauth_client: OAuthTokenClient | None = None,
        callback_server_factory: Callable[[], LoopbackCallbackServer] | None = None,
        browser_opener: Callable[[str], Any] | None = None,
        timeout_seconds: float = 30.0,
        monotonic_clock: Callable[[], float] | None = None,
    ) -> None:
        """注入可测试边界；默认使用加密数据库、官方授权端点和本机浏览器。"""
        self._credential_store = credential_store or SqlSubscriptionCredentialStore()
        self._oauth_client = oauth_client or _OpenAIOAuthTokenClient(timeout_seconds)
        self._callback_server_factory = callback_server_factory or _ThreadedLoopbackCallbackServer
        self._browser_opener = browser_opener or webbrowser.open
        self._monotonic_clock = monotonic_clock or time.monotonic
        self._pending: _PendingAuthorization | None = None
        self._lock = threading.RLock()

    def account_status(self) -> CodexSubscriptionAccount:
        """返回当前安全订阅状态，不触发本机 Codex 检测或外部令牌调用。"""
        with self._lock:
            self._expire_pending_locked()
            if self._pending is not None:
                return _pending_account()
            credential = self._credential_store.load()
            if credential is not None:
                return _connected_account(credential.plan_type)
            return _requires_login_account()

    def start_login(self) -> CodexSubscriptionAccount:
        """启动 PKCE 浏览器登录；先成功绑定回调端口，再打开授权网站。"""
        with self._lock:
            self._expire_pending_locked()
            if self._pending is not None:
                return _pending_account()
            state = secrets.token_urlsafe(32)
            code_verifier = secrets.token_urlsafe(64)
            server = self._callback_server_factory()
            try:
                server.start(self._complete_callback)
            except OSError as exc:
                raise CodexSubscriptionError("MODEL_SUBSCRIPTION_CALLBACK_UNAVAILABLE") from exc
            self._pending = _PendingAuthorization(
                state=state,
                code_verifier=code_verifier,
                created_at=self._monotonic_clock(),
                server=server,
            )
            try:
                opened = self._browser_opener(_authorization_url(state, code_verifier))
            except Exception as exc:
                self._discard_pending_locked()
                raise CodexSubscriptionError("MODEL_SUBSCRIPTION_BROWSER_UNAVAILABLE") from exc
            if opened is False:
                self._discard_pending_locked()
                raise CodexSubscriptionError("MODEL_SUBSCRIPTION_BROWSER_UNAVAILABLE")
            return _pending_account()

    def cancel_login(self) -> CodexSubscriptionAccount:
        """取消等待中的浏览器授权并释放其 loopback 端口。"""
        with self._lock:
            self._discard_pending_locked()
            return _requires_login_account()

    def logout(self) -> CodexSubscriptionAccount:
        """删除保存的订阅凭据并取消未完成授权。"""
        with self._lock:
            self._discard_pending_locked()
            self._credential_store.clear()
            return _requires_login_account()

    def create_openai_client(self, *, timeout_seconds: float) -> OpenAI:
        """取得已刷新凭据的 ChatGPT Codex Responses 客户端，失败只抛安全码。"""
        with self._lock:
            credential = self._credential_store.load()
            if credential is None:
                raise CodexSubscriptionError("MODEL_SUBSCRIPTION_AUTH_REQUIRED")
            if credential.access_token_expires_at <= utc_now() + timedelta(seconds=_REFRESH_SKEW_SECONDS):
                credential = self._refresh_credential_locked(credential)
            return OpenAI(
                api_key=credential.access_token,
                base_url=_CODEX_BASE_URL,
                timeout=timeout_seconds,
                max_retries=0,
                default_headers={
                    "User-Agent": "StaffDeck",
                    "ChatGPT-Account-ID": credential.account_id,
                },
            )

    def close(self) -> None:
        """在应用停止时仅关闭临时回调监听器，不删除持久授权。"""
        with self._lock:
            self._discard_pending_locked()

    def _complete_callback(
        self,
        code: str | None,
        state: str | None,
        error: str | None,
    ) -> CallbackCompletion:
        """校验一次性 state 并交换令牌；所有失败都销毁 pending PKCE 状态。"""
        with self._lock:
            self._expire_pending_locked()
            pending = self._pending
            if pending is None or not state or not secrets.compare_digest(state, pending.state):
                self._discard_pending_locked()
                return CallbackCompletion(False, "授权未完成，请返回 StaffDeck 后重新连接。")
            if error or not code:
                self._discard_pending_locked()
                return CallbackCompletion(False, "授权未完成，请返回 StaffDeck 后重新连接。")
            try:
                token_payload = self._oauth_client.exchange_authorization_code(
                    code=code,
                    code_verifier=pending.code_verifier,
                )
                credential = _credential_from_token_payload(token_payload)
                self._credential_store.save(credential)
            except CodexSubscriptionError:
                self._discard_pending_locked()
                return CallbackCompletion(False, "授权未完成，请返回 StaffDeck 后重新连接。")
            self._discard_pending_locked()
            return CallbackCompletion(True, "已连接 ChatGPT 订阅，可以关闭此页面。")

    def _refresh_credential_locked(
        self,
        credential: SubscriptionCredential,
    ) -> SubscriptionCredential:
        """刷新即将过期令牌，只有完整有效的新令牌才能替换旧加密记录。"""
        try:
            payload = self._oauth_client.refresh(credential.refresh_token)
            refreshed = _credential_from_token_payload(
                payload,
                previous=credential,
                failure_code="MODEL_SUBSCRIPTION_REFRESH_FAILED",
            )
        except CodexSubscriptionError as exc:
            if exc.code == "MODEL_SUBSCRIPTION_REFRESH_FAILED":
                self._credential_store.clear()
            raise
        self._credential_store.save(refreshed)
        return refreshed

    def _expire_pending_locked(self) -> None:
        """在状态读取和操作入口处清理超过十分钟的 PKCE 尝试。"""
        pending = self._pending
        if pending is None:
            return
        if self._monotonic_clock() - pending.created_at >= _PENDING_LOGIN_SECONDS:
            self._discard_pending_locked()

    def _discard_pending_locked(self) -> None:
        """销毁内存中的 state/verifier 并释放关联 loopback 监听器。"""
        pending = self._pending
        self._pending = None
        if pending is not None:
            pending.server.stop()


_subscription_service: ChatGPTSubscriptionService | None = None
_subscription_service_lock = threading.Lock()


def get_codex_subscription_service() -> ChatGPTSubscriptionService:
    """返回进程共享的直接 OAuth 服务；不读取或启动本机 Codex。"""
    global _subscription_service
    with _subscription_service_lock:
        if _subscription_service is None:
            settings = get_settings()
            _subscription_service = ChatGPTSubscriptionService(
                timeout_seconds=settings.codex_subscription_timeout_seconds,
            )
        return _subscription_service


def stop_codex_subscription_service() -> None:
    """关闭进程共享服务的临时资源，供应用关闭与测试重置使用。"""
    global _subscription_service
    with _subscription_service_lock:
        if _subscription_service is not None:
            _subscription_service.close()
        _subscription_service = None


def _credential_from_stored_payload(
    payload: Any,
    row: CodexSubscriptionCredential,
) -> SubscriptionCredential | None:
    """将解密后的数据库 JSON 还原为可信凭据，字段不完整时拒绝使用。"""
    if not isinstance(payload, dict):
        return None
    access_token = payload.get("access_token")
    refresh_token = payload.get("refresh_token")
    account_id = payload.get("account_id")
    if not all(isinstance(value, str) and value for value in (access_token, refresh_token, account_id)):
        return None
    return SubscriptionCredential(
        access_token=access_token,
        refresh_token=refresh_token,
        account_id=account_id,
        access_token_expires_at=row.access_token_expires_at,
        plan_type=row.plan_type,
    )


def _credential_from_token_payload(
    payload: dict[str, Any],
    *,
    previous: SubscriptionCredential | None = None,
    failure_code: str = "MODEL_SUBSCRIPTION_AUTH_FAILED",
) -> SubscriptionCredential:
    """验证令牌端点结果并从访问令牌声明提取 ChatGPT 账户标识。"""
    access_token = payload.get("access_token")
    refresh_token = payload.get("refresh_token") or (previous.refresh_token if previous else None)
    if not isinstance(access_token, str) or not isinstance(refresh_token, str):
        raise CodexSubscriptionError(failure_code)
    account_id = _chatgpt_account_id(access_token) or (previous.account_id if previous else None)
    if not account_id:
        raise CodexSubscriptionError(failure_code)
    try:
        expires_in = int(payload.get("expires_in", 0))
    except (TypeError, ValueError) as exc:
        raise CodexSubscriptionError(failure_code) from exc
    if expires_in <= 0:
        raise CodexSubscriptionError(failure_code)
    plan_type = payload.get("plan_type")
    return SubscriptionCredential(
        access_token=access_token,
        refresh_token=refresh_token,
        account_id=account_id,
        access_token_expires_at=utc_now() + timedelta(seconds=expires_in),
        plan_type=str(plan_type) if isinstance(plan_type, str) else (previous.plan_type if previous else None),
    )


def _chatgpt_account_id(access_token: str) -> str | None:
    """从 JWT 的公开声明段读取 ChatGPT 账户 ID，不校验或记录令牌内容。"""
    parts = access_token.split(".")
    if len(parts) < 2:
        return None
    try:
        encoded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(encoded))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    auth_claim = payload.get("https://api.openai.com/auth")
    account_id = auth_claim.get("chatgpt_account_id") if isinstance(auth_claim, dict) else None
    return account_id if isinstance(account_id, str) and account_id else None


def _authorization_url(state: str, code_verifier: str) -> str:
    """构造 PKCE 授权地址，状态和 verifier 仅保留在服务端 pending 状态中。"""
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode("ascii")).digest()
    ).decode("ascii").rstrip("=")
    parameters = {
        'response_type': 'code',
        'client_id': _OAUTH_CLIENT_ID,
        'redirect_uri': _REDIRECT_URI,
        'scope': _OAUTH_SCOPE,
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
    }
    return f"{_AUTHORIZATION_ENDPOINT}?{urlencode(parameters)}"


def _single_query_value(query: dict[str, list[str]], key: str) -> str | None:
    """仅接受查询参数的单一非空值，避免歧义参数进入授权处理。"""
    values = query.get(key)
    if not values or len(values) != 1:
        return None
    value = values[0]
    return value if value else None


def _callback_page(success: bool) -> str:
    """生成固定回调页面，不把 URL、授权码或错误详情写回浏览器。"""
    if success:
        title = "ChatGPT 授权已完成"
        message = "可以返回 StaffDeck 继续配置模型。"
    else:
        title = "ChatGPT 授权未完成"
        message = "请返回 StaffDeck 后重新发起授权。"
    return f"<!doctype html><html><head><title>{title}</title></head><body><h1>{title}</h1><p>{message}</p></body></html>"


def _connected_account(plan_type: str | None) -> CodexSubscriptionAccount:
    """创建已连接状态的安全展示文本。"""
    return CodexSubscriptionAccount(
        status="connected",
        plan_type=plan_type,
        message="已连接 ChatGPT 订阅",
    )


def _pending_account() -> CodexSubscriptionAccount:
    """创建等待浏览器确认的安全展示文本。"""
    return CodexSubscriptionAccount(
        status="pending",
        plan_type=None,
        message="请在浏览器中完成 ChatGPT 授权。",
    )


def _requires_login_account() -> CodexSubscriptionAccount:
    """创建尚未授权或授权已失效时的安全展示文本。"""
    return CodexSubscriptionAccount(
        status="requires_login",
        plan_type=None,
        message="尚未连接 ChatGPT 订阅",
    )
