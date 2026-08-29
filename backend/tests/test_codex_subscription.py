from __future__ import annotations

import base64
import importlib
import json
from datetime import timedelta
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.db.models import ModelConfig, utc_now
from app.llm.client import LLMClient


def _jwt_with_account(account_id: str) -> str:
    payload = json.dumps(
        {"https://api.openai.com/auth": {"chatgpt_account_id": account_id}},
        separators=(",", ":"),
    ).encode("utf-8")
    encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"header.{encoded}.signature"


def _subscription_module() -> Any:
    return importlib.import_module("app.codex_subscription.app_server")


class _MemoryStore:
    def __init__(self) -> None:
        self.credential: Any = None

    def load(self) -> Any:
        return self.credential

    def save(self, credential: Any) -> None:
        self.credential = credential

    def clear(self) -> None:
        self.credential = None


class _FakeOAuthClient:
    def __init__(self) -> None:
        self.exchanges: list[dict[str, str]] = []
        self.refreshes: list[str] = []

    def exchange_authorization_code(self, *, code: str, code_verifier: str) -> dict[str, Any]:
        self.exchanges.append({"code": code, "code_verifier": code_verifier})
        return {
            "access_token": _jwt_with_account("account-private"),
            "refresh_token": "refresh-private",
            "expires_in": 3600,
            "plan_type": "plus",
        }

    def refresh(self, refresh_token: str) -> dict[str, Any]:
        self.refreshes.append(refresh_token)
        return {
            "access_token": _jwt_with_account("account-private"),
            "refresh_token": "refresh-rotated-private",
            "expires_in": 3600,
        }


class _FakeLoopbackServer:
    def __init__(self) -> None:
        self.callback: Any = None
        self.started = False
        self.stopped = False

    def start(self, callback: Any) -> None:
        self.callback = callback
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def complete(self, *, code: str | None, state: str | None, error: str | None = None) -> Any:
        assert self.callback is not None
        return self.callback(code=code, state=state, error=error)


def _service(
    module: Any,
    *,
    store: _MemoryStore | None = None,
    oauth_client: _FakeOAuthClient | None = None,
    browser_opener: Any = None,
) -> tuple[Any, _MemoryStore, _FakeOAuthClient, _FakeLoopbackServer, list[str]]:
    opened_urls: list[str] = []
    loopback_server = _FakeLoopbackServer()
    service = module.ChatGPTSubscriptionService(
        credential_store=store or _MemoryStore(),
        oauth_client=oauth_client or _FakeOAuthClient(),
        callback_server_factory=lambda: loopback_server,
        browser_opener=browser_opener or opened_urls.append,
    )
    return service, service._credential_store, service._oauth_client, loopback_server, opened_urls


def test_direct_oauth_uses_pkce_loopback_callback_and_never_exposes_secrets() -> None:
    module = _subscription_module()
    service, store, oauth_client, loopback_server, opened_urls = _service(module)

    pending = service.start_login()

    assert pending.to_dict() == {
        "status": "pending",
        "plan_type": None,
        "message": "请在浏览器中完成 ChatGPT 授权。",
    }
    assert loopback_server.started is True
    assert len(opened_urls) == 1
    parsed_url = urlsplit(opened_urls[0])
    query = parse_qs(parsed_url.query)
    assert parsed_url.scheme == "https"
    assert parsed_url.netloc == "auth.openai.com"
    assert parsed_url.path == "/oauth/authorize"
    assert query["redirect_uri"] == ["http://localhost:1455/auth/callback"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["scope"] == ["openid profile email offline_access"]
    assert not hasattr(service, "_transport")

    completed = loopback_server.complete(code="authorization-code-private", state=query["state"][0])

    assert completed.success is True
    assert service.account_status().status == "connected"
    assert store.credential.account_id == "account-private"
    assert oauth_client.exchanges[0]["code"] == "authorization-code-private"
    public_state = f"{pending.to_dict()}{service.account_status().to_dict()}{completed.message}"
    assert "authorization-code-private" not in public_state
    assert "refresh-private" not in public_state
    assert "account-private" not in public_state


def test_direct_oauth_rejects_mismatched_callback_state_and_cleans_pending_login() -> None:
    module = _subscription_module()
    service, store, oauth_client, loopback_server, _ = _service(module)

    service.start_login()
    completed = loopback_server.complete(code="authorization-code-private", state="wrong-state")

    assert completed.success is False
    assert service.account_status().status == "requires_login"
    assert loopback_server.stopped is True
    assert store.credential is None
    assert oauth_client.exchanges == []


def test_direct_oauth_cancel_and_logout_remove_pending_or_saved_credentials() -> None:
    module = _subscription_module()
    service, store, _, loopback_server, opened_urls = _service(module)

    assert service.start_login().status == "pending"
    assert service.cancel_login().status == "requires_login"
    assert loopback_server.stopped is True
    assert service.account_status().status == "requires_login"

    service.start_login()
    state = parse_qs(urlsplit(opened_urls[-1]).query)["state"][0]
    assert loopback_server.complete(code="authorization-code-private", state=state).success is True
    assert store.credential is not None
    assert service.logout().status == "requires_login"
    assert store.credential is None


def test_sql_store_encrypts_subscription_tokens_outside_model_api_key_fields(monkeypatch, tmp_path) -> None:
    module = _subscription_module()
    engine = create_engine(f"sqlite:///{tmp_path / 'subscription.db'}")
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(module, "engine", engine)
    store = module.SqlSubscriptionCredentialStore()
    credential = module.SubscriptionCredential(
        access_token=_jwt_with_account("account-private"),
        refresh_token="refresh-private",
        account_id="account-private",
        access_token_expires_at=utc_now() + timedelta(hours=1),
        plan_type="plus",
    )

    store.save(credential)

    with Session(engine) as db:
        row = db.get(module.CodexSubscriptionCredential, "default")
        assert row is not None
        assert "refresh-private" not in row.credential_encrypted
        assert "account-private" not in row.credential_encrypted
    assert store.load().refresh_token == "refresh-private"


def test_expiring_subscription_refreshes_before_openai_client_creation(monkeypatch) -> None:
    module = _subscription_module()
    store = _MemoryStore()
    store.credential = module.SubscriptionCredential(
        access_token=_jwt_with_account("account-private"),
        refresh_token="refresh-private",
        account_id="account-private",
        access_token_expires_at=utc_now() + timedelta(seconds=30),
        plan_type="plus",
    )
    oauth_client = _FakeOAuthClient()
    service, _, _, _, _ = _service(module, store=store, oauth_client=oauth_client)
    created: list[dict[str, Any]] = []

    class _OpenAI:
        def __init__(self, **kwargs: Any) -> None:
            created.append(kwargs)

    monkeypatch.setattr(module, "OpenAI", _OpenAI)

    service.create_openai_client(timeout_seconds=42)

    assert oauth_client.refreshes == ["refresh-private"]
    assert created[0]["base_url"] == "https://chatgpt.com/backend-api/codex"
    assert created[0]["default_headers"]["User-Agent"] == "StaffDeck"
    assert created[0]["default_headers"]["ChatGPT-Account-ID"] == "account-private"
    assert store.credential.refresh_token == "refresh-rotated-private"


def test_revoked_refresh_clears_credential_without_exposing_subscription_secrets() -> None:
    module = _subscription_module()
    store = _MemoryStore()
    store.credential = module.SubscriptionCredential(
        access_token=_jwt_with_account("account-private"),
        refresh_token="refresh-private",
        account_id="account-private",
        access_token_expires_at=utc_now() + timedelta(seconds=30),
        plan_type="plus",
    )

    class _RevokedOAuthClient(_FakeOAuthClient):
        def refresh(self, refresh_token: str) -> dict[str, Any]:
            raise module.CodexSubscriptionError("MODEL_SUBSCRIPTION_REFRESH_FAILED")

    service, _, _, _, _ = _service(module, store=store, oauth_client=_RevokedOAuthClient())

    with pytest.raises(module.CodexSubscriptionError) as exc_info:
        service.create_openai_client(timeout_seconds=42)

    assert exc_info.value.code == "MODEL_SUBSCRIPTION_REFRESH_FAILED"
    assert store.credential is None
    assert "refresh-private" not in str(exc_info.value)
    assert "account-private" not in str(exc_info.value)


def test_llm_client_uses_direct_subscription_responses_client_without_model_api_key_decryption(
    monkeypatch,
) -> None:
    client_module = importlib.import_module("app.llm.client")
    created: list[float] = []
    upstream_client = SimpleNamespace()

    class _SubscriptionService:
        def create_openai_client(self, *, timeout_seconds: float) -> Any:
            created.append(timeout_seconds)
            return upstream_client

    monkeypatch.setattr(client_module, "get_codex_subscription_service", lambda: _SubscriptionService())
    monkeypatch.setattr(
        client_module,
        "decrypt_secret",
        lambda _: pytest.fail("subscription models must not decrypt a model API key"),
    )

    client = LLMClient(
        ModelConfig(
            tenant_id="tenant-1",
            name="ChatGPT subscription",
            auth_mode="chatgpt_subscription",
            api_protocol="codex_app_server",
            api_key_encrypted="model-key-must-not-be-read",
            model="gpt-5.1-codex",
        )
    )

    assert client.client is upstream_client
    assert client.driver.request_kind == "codex.subscription.responses"
    assert created == [client.timeout_seconds]


def test_subscription_error_mapper_distinguishes_access_quota_and_network_failures() -> None:
    protocol_module = importlib.import_module("app.llm.protocol_drivers")

    for status_code, expected in ((401, "MODEL_SUBSCRIPTION_AUTH_REQUIRED"), (403, "MODEL_SUBSCRIPTION_ACCESS_DENIED"), (429, "MODEL_SUBSCRIPTION_QUOTA_EXCEEDED"), (503, "MODEL_SUBSCRIPTION_NETWORK_UNAVAILABLE")):
        error = type("ProviderError", (Exception,), {"status_code": status_code})("provider failure")
        assert protocol_module.subscription_protocol_call_error(error).code == expected
