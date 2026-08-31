from __future__ import annotations

import importlib
import json
import traceback
from typing import Any, ClassVar

import httpx
import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.channels.adapters.base import ChannelInbound, ChannelInboundAttachment
from app.channels.crypto import encrypt_channel_secret
from app.channels.service_durable_inbox import StageDisposition
from app.db import models as db_models
from app.db.models import ChannelBinding, ChannelInboundEvent, Tenant


def _wechat_kf_adapter_module():
    """Load the adapter lazily so the pre-implementation suite reports a focused RED."""
    try:
        return importlib.import_module("app.channels.adapters.wechat_kf")
    except ModuleNotFoundError:
        pytest.fail("WeChat Customer Service adapter is not implemented")


def _wechat_kf_inbox_module():
    """Load the durable inbox lazily so missing production code is an assertion failure."""
    try:
        return importlib.import_module("app.channels.service_wechat_kf_inbox")
    except ModuleNotFoundError:
        pytest.fail("WeChat Customer Service durable inbox is not implemented")


def _wechat_kf_account_model():
    """Resolve the account model lazily while keeping the RED test collectable."""
    model = getattr(db_models, "WeChatKfAccount", None)
    if model is None:
        pytest.fail("WeChatKfAccount model is not implemented")
    return model


def _test_engine():
    """Create an isolated in-memory SQLite database with the current model metadata."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed_binding_and_account(engine, *, revision: int = 7) -> ChannelBinding:
    """Persist one active binding/account pair and return its detached binding snapshot."""
    account_model = _wechat_kf_account_model()
    corp_id = "ww-tenant-a"
    open_kfid = "wk-support"
    with Session(engine) as db:
        db.add(Tenant(id="tenant_a", name="Tenant A"))
        binding = ChannelBinding(
            id="chan_wechat_kf",
            tenant_id="tenant_a",
            agent_id="agent_a",
            channel="wechat_kf",
            status="active",
            config_json={
                "corp_id": corp_id,
                "open_kfid": open_kfid,
                "ui_locale": "en-US",
                "agent_reply_locale": "zh-CN",
            },
            identity_scope_key=f"{corp_id}:{open_kfid}",
            config_revision=revision,
        )
        db.add(binding)
        db.add(
            account_model(
                id="wka_support",
                tenant_id="tenant_a",
                binding_id=binding.id,
                open_kfid=open_kfid,
                agent_id="agent_a",
            )
        )
        db.commit()
        db.refresh(binding)
        return binding


def _inbound(
    event_id: str = "msg-1",
    *,
    open_kfid: str = "wk-support",
    account_scope: str = "ww-tenant-a:wk-support",
    text: str = "hello",
) -> ChannelInbound:
    """Build a normalized customer-service message with explicit account identity."""
    return ChannelInbound(
        channel="wechat_kf",
        event_id=event_id,
        from_user_id="external-user",
        to_user_id=open_kfid,
        session_id="external-user",
        group_id="",
        context_token=open_kfid,
        text=text,
        is_group=False,
        raw={"msgid": event_id},
        account_scope=account_scope,
    )


def test_wechat_kf_model_enforces_binding_and_tenant_account_uniqueness() -> None:
    """Duplicate routing rows cannot alias one provider account across bindings or tenants."""
    account_model = _wechat_kf_account_model()
    engine = _test_engine()
    with Session(engine) as db:
        db.add(
            account_model(
                tenant_id="tenant_a",
                binding_id="binding_a",
                open_kfid="wk-1",
            )
        )
        db.commit()
        db.add(
            account_model(
                tenant_id="tenant_b",
                binding_id="binding_a",
                open_kfid="wk-1",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
        db.add(
            account_model(
                tenant_id="tenant_a",
                binding_id="binding_b",
                open_kfid="wk-1",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()


def test_wechat_kf_identity_keys_keep_accounts_isolated() -> None:
    """Identity scope and stable account keys include both corporation and客服 account IDs."""
    from app.channels.service_identity import (
        external_account_key,
        external_account_scope,
        legacy_external_account_keys,
    )

    engine = _test_engine()
    binding = _seed_binding_and_account(engine)
    with Session(engine) as db:
        stored = db.get(ChannelBinding, binding.id)
        assert external_account_scope(db, stored) == "ww-tenant-a:wk-support"
    assert external_account_key(
        "wechat_kf", {"corp_id": "ww-tenant-a", "open_kfid": "wk-support"}
    ) == "wechat_kf:corp:11:ww-tenant-a:kf:10:wk-support"
    assert legacy_external_account_keys(
        "wechat_kf", {"corp_id": "ww-tenant-a", "open_kfid": "wk-support"}
    ) == set()


@pytest.mark.parametrize(
    ("raw", "expected_text", "expected_kinds"),
    [
        (
            {
                "msgid": "text-1",
                "open_kfid": "wk-1",
                "external_userid": "external-1",
                "origin": 3,
                "msgtype": "text",
                "text": {"content": " hello "},
            },
            "hello",
            [],
        ),
        (
            {
                "msgid": "image-1",
                "open_kfid": "wk-1",
                "external_userid": "external-1",
                "origin": 3,
                "msgtype": "image",
                "image": {"media_id": "media-image"},
            },
            "",
            ["image"],
        ),
        (
            {
                "msgid": "file-1",
                "open_kfid": "wk-1",
                "external_userid": "external-1",
                "origin": 3,
                "msgtype": "file",
                "file": {"media_id": "media-file", "filename": "报价单.pdf"},
            },
            "",
            ["file"],
        ),
        (
            {
                "msgid": "mixed-1",
                "open_kfid": "wk-1",
                "external_userid": "external-1",
                "origin": 3,
                "msgtype": "mixed",
                "mixed": {
                    "msg_item": [
                        {"msgtype": "text", "text": {"content": "请查收"}},
                        {
                            "msgtype": "file",
                            "file": {"media_id": "media-file", "name": "报告.docx"},
                        },
                    ]
                },
            },
            "请查收",
            ["file"],
        ),
    ],
)
def test_wechat_kf_normalizes_supported_customer_messages(
    raw: dict[str, Any], expected_text: str, expected_kinds: list[str]
) -> None:
    """Supported customer messages retain text, account identity, and attachment metadata."""
    module = _wechat_kf_adapter_module()
    inbound = module.normalize_wechat_kf_message(raw, account_scope="corp:wk-1")

    assert inbound is not None
    assert inbound.channel == "wechat_kf"
    assert inbound.text == expected_text
    assert inbound.account_scope == "corp:wk-1"
    assert [attachment.kind for attachment in inbound.attachments] == expected_kinds
    if inbound.attachments and inbound.attachments[0].kind == "file":
        assert inbound.attachments[0].content_type != "application/octet-stream"


@pytest.mark.parametrize(
    "raw",
    [
        {"origin": 5, "msgid": "servicer", "open_kfid": "wk", "external_userid": "u"},
        {
            "origin": 3,
            "msgid": "bad-text",
            "open_kfid": "wk",
            "external_userid": "u",
            "msgtype": "text",
            "text": "not-an-object",
        },
        {
            "origin": 3,
            "msgid": "bad-mixed",
            "open_kfid": "wk",
            "external_userid": "u",
            "msgtype": "mixed",
            "mixed": {"msg_item": "not-a-list"},
        },
        {
            "origin": 3,
            "msgid": "bad-file",
            "open_kfid": "wk",
            "external_userid": "u",
            "msgtype": "file",
            "file": "not-an-object",
        },
    ],
)
def test_wechat_kf_normalization_rejects_untrusted_or_malformed_messages(
    raw: dict[str, Any],
) -> None:
    """Servicer-originated and malformed payloads never enter the customer message plane."""
    module = _wechat_kf_adapter_module()
    assert module.normalize_wechat_kf_message(raw) is None


def test_wechat_kf_utf8_split_never_exceeds_provider_byte_limit() -> None:
    """Outbound chunks preserve Unicode text while respecting the byte-based provider limit."""
    module = _wechat_kf_adapter_module()
    text = "中" * 1000 + "abc"
    chunks = module._split_utf8_text(text)

    assert "".join(chunks) == text
    assert len(chunks) == 2
    assert all(len(chunk.encode("utf-8")) <= module.TEXT_LIMIT_BYTES for chunk in chunks)
    assert module._split_utf8_text("") == []


def test_wechat_kf_token_provider_caches_by_binding_revision() -> None:
    """A token is reused within one binding revision and refreshed after reconfiguration."""
    module = _wechat_kf_adapter_module()
    calls: list[dict[str, str]] = []

    class FakeResponse:
        """Return a complete successful provider token response."""

        def raise_for_status(self) -> None:
            """Represent a successful HTTP status without side effects."""

        def json(self) -> dict[str, Any]:
            """Return a distinct token so cache behavior is externally observable."""
            return {
                "errcode": 0,
                "access_token": f"token-{len(calls)}",
                "expires_in": 7200,
            }

    class FakeClient:
        """Capture token requests without contacting the provider."""

        def __enter__(self):
            """Expose this fake as the synchronous client context value."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake context without external side effects."""

        def get(self, _url: str, *, params: dict[str, str]) -> FakeResponse:
            """Record the provider credentials used for one token request."""
            calls.append(params)
            return FakeResponse()

    provider = module.WeChatKfTokenProvider(client_factory=lambda **_kwargs: FakeClient())
    binding = ChannelBinding(
        id="chan-token",
        tenant_id="tenant_a",
        agent_id="agent_a",
        channel="wechat_kf",
        credentials_enc=encrypt_channel_secret(json.dumps({"secret": "secret-a"})),
        config_json={"corp_id": "corp-a"},
        config_revision=1,
    )

    assert provider.get(binding) == "token-1"
    assert provider.get(binding) == "token-1"
    assert len(calls) == 1
    binding.config_revision = 2
    assert provider.get(binding) == "token-2"
    assert len(calls) == 2


def test_wechat_kf_corrupt_credentials_are_permanent_configuration_errors() -> None:
    """Corrupt encrypted credentials never leak the cryptography exception contract."""
    module = _wechat_kf_adapter_module()
    binding = ChannelBinding(
        id="chan-corrupt",
        tenant_id="tenant_a",
        agent_id="agent_a",
        channel="wechat_kf",
        credentials_enc="not-a-valid-fernet-token",
    )

    with pytest.raises(module.WeChatKfPermanentError) as captured:
        module.wechat_kf_credentials(binding)

    assert captured.value.retryable is False


@pytest.mark.parametrize(
    ("error_code", "expected_retryable"),
    [(42001, True), (45009, True), (45011, True), (40013, False)],
)
def test_wechat_kf_token_provider_classifies_provider_errors(
    error_code: int, expected_retryable: bool
) -> None:
    """Token expiry and rate limits are retryable while invalid provider credentials are not."""
    module = _wechat_kf_adapter_module()

    class FakeResponse:
        """Return one provider error from an otherwise successful HTTP response."""

        def raise_for_status(self) -> None:
            """Represent a successful HTTP status without side effects."""

        def json(self) -> dict[str, Any]:
            """Expose the selected provider error code."""
            return {"errcode": error_code, "errmsg": "provider rejected token request"}

    class FakeClient:
        """Serve the token error without contacting the provider."""

        def __enter__(self):
            """Expose this fake as the synchronous client context value."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake context without external side effects."""

        def get(self, _url: str, *, params: dict[str, str]) -> FakeResponse:
            """Require the complete token request before returning the provider error."""
            assert params == {"corpid": "corp-a", "corpsecret": "secret-a"}
            return FakeResponse()

    provider = module.WeChatKfTokenProvider(client_factory=lambda **_kwargs: FakeClient())
    binding = ChannelBinding(
        id=f"chan-token-error-{error_code}",
        tenant_id="tenant_a",
        agent_id="agent_a",
        channel="wechat_kf",
        credentials_enc=encrypt_channel_secret(json.dumps({"secret": "secret-a"})),
        config_json={"corp_id": "corp-a"},
    )
    expected_error = (
        module.WeChatKfTransientError
        if expected_retryable
        else module.WeChatKfPermanentError
    )

    with pytest.raises(expected_error) as captured:
        provider.get(binding)

    assert captured.value.retryable is expected_retryable


def test_wechat_kf_token_transport_traceback_redacts_secret() -> None:
    """A token HTTP failure traceback never retains the query-string corporation secret."""
    module = _wechat_kf_adapter_module()
    secret = "trace-secret-must-not-appear"

    class FailingResponse:
        """Raise an HTTP status error whose request URL contains the sensitive query."""

        def raise_for_status(self) -> None:
            """Reproduce httpx's URL-bearing HTTPStatusError."""
            request = httpx.Request(
                "GET",
                f"{module.WECOM_API_BASE}/gettoken?corpid=corp-a&corpsecret={secret}",
            )
            response = httpx.Response(500, request=request)
            raise httpx.HTTPStatusError("provider failed", request=request, response=response)

        def json(self) -> dict[str, Any]:
            """Remain unreachable because status validation fails first."""
            return {}

    class FailingClient:
        """Return the URL-bearing failure without contacting the provider."""

        def __enter__(self):
            """Expose this fake as the synchronous client context value."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake context without external side effects."""

        def get(self, _url: str, *, params: dict[str, str]) -> FailingResponse:
            """Confirm the secret crossed the HTTP boundary before reproducing failure."""
            assert params["corpsecret"] == secret
            return FailingResponse()

    provider = module.WeChatKfTokenProvider(client_factory=lambda **_kwargs: FailingClient())
    binding = ChannelBinding(
        id="chan-token-trace",
        tenant_id="tenant_a",
        agent_id="agent_a",
        channel="wechat_kf",
        credentials_enc=encrypt_channel_secret(json.dumps({"secret": secret})),
        config_json={"corp_id": "corp-a"},
    )

    with pytest.raises(module.WeChatKfTransientError) as captured:
        provider.get(binding)

    formatted = "".join(traceback.format_exception(captured.value))
    assert secret not in formatted


def test_wechat_kf_provider_errors_are_classified_for_retry(monkeypatch) -> None:
    """Expired tokens and rate limits are retryable while provider validation errors are not."""
    module = _wechat_kf_adapter_module()
    binding = ChannelBinding(
        id="chan-errors",
        tenant_id="tenant_a",
        agent_id="agent_a",
        channel="wechat_kf",
    )

    class TokenProvider:
        """Supply a stable token and expose invalidation as observable state."""

        def __init__(self) -> None:
            """Initialize the invalidation counter without external side effects."""
            self.invalidations = 0

        def get(self, _binding: ChannelBinding) -> str:
            """Return the token used by the fake provider calls."""
            return "token"

        def invalidate(self, _binding: ChannelBinding) -> None:
            """Record token invalidation requested by the adapter."""
            self.invalidations += 1

    tokens = TokenProvider()
    adapter = module.WeChatKfAdapter(tokens)

    class FakeResponse:
        """Expose a mutable provider JSON result with a successful HTTP status."""

        payload: ClassVar[dict[str, Any]] = {}

        def raise_for_status(self) -> None:
            """Represent a successful HTTP status without side effects."""

        def json(self) -> dict[str, Any]:
            """Return the provider result selected by the test."""
            return dict(self.payload)

    class FakeClient:
        """Return the selected provider result without network access."""

        def __enter__(self):
            """Expose this fake as the client context value."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake context without external side effects."""

        def post(self, *_args, **_kwargs) -> FakeResponse:
            """Return one response whose payload is controlled by the test."""
            return FakeResponse()

    monkeypatch.setattr(module.httpx, "Client", lambda **_kwargs: FakeClient())
    FakeResponse.payload = {"errcode": 42001, "errmsg": "expired"}
    with pytest.raises(module.WeChatKfTransientError):
        adapter._post(binding, "/kf/account/list", {})
    assert tokens.invalidations == 1

    FakeResponse.payload = {"errcode": 45009, "errmsg": "rate limited"}
    with pytest.raises(module.WeChatKfTransientError):
        adapter._post(binding, "/kf/account/list", {})

    FakeResponse.payload = {"errcode": 40058, "errmsg": "invalid parameter"}
    with pytest.raises(module.WeChatKfPermanentError) as captured:
        adapter._post(binding, "/kf/account/list", {})
    assert captured.value.retryable is False


def test_wechat_kf_media_download_uses_safe_provider_metadata(monkeypatch) -> None:
    """Binary downloads honor limits and infer MIME from a path-stripped provider filename."""
    module = _wechat_kf_adapter_module()
    adapter = module.WeChatKfAdapter()
    binding = ChannelBinding(tenant_id="tenant_a", agent_id="agent_a", channel="wechat_kf")
    monkeypatch.setattr(adapter._tokens, "get", lambda _binding: "token")

    class FakeResponse:
        """Stream one bounded binary provider response."""

        headers: ClassVar[dict[str, str]] = {
            "content-type": "application/octet-stream",
            "content-disposition": "attachment; filename*=UTF-8''..%2F%E6%8A%A5%E5%91%8A.docx",
            "content-length": "7",
        }

        def __enter__(self):
            """Expose the response inside the streaming context."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake response without external side effects."""

        def raise_for_status(self) -> None:
            """Represent a successful HTTP status without side effects."""

        def iter_bytes(self, _size: int):
            """Yield the complete provider payload in one bounded chunk."""
            return iter([b"payload"])

    class FakeClient:
        """Capture the media request without contacting WeCom."""

        def __enter__(self):
            """Expose this fake as the HTTP client context value."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake client without external side effects."""

        def stream(self, method: str, url: str, *, params: dict[str, str]) -> FakeResponse:
            """Validate the provider media endpoint and return a bounded response."""
            assert method == "GET"
            assert url.endswith("/media/get")
            assert params == {"access_token": "token", "media_id": "media-file"}
            return FakeResponse()

    monkeypatch.setattr(module.httpx, "Client", lambda **_kwargs: FakeClient())
    attachment = ChannelInboundAttachment(
        media_id="media-file",
        kind="file",
        filename="fallback.bin",
        content_type="application/octet-stream",
        download_params={"provider_max_bytes": 20 * 1024 * 1024},
    )

    assert adapter.download_media(binding, attachment, max_bytes=8) == b"payload"
    assert attachment.filename == "报告.docx"
    assert attachment.content_type == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )


def test_wechat_kf_media_upload_and_account_operations_use_provider_contract(monkeypatch) -> None:
    """Avatar, account CRUD, and contact-way operations emit the documented provider payloads."""
    module = _wechat_kf_adapter_module()
    adapter = module.WeChatKfAdapter()
    binding = ChannelBinding(tenant_id="tenant_a", agent_id="agent_a", channel="wechat_kf")
    monkeypatch.setattr(adapter._tokens, "get", lambda _binding: "token")

    class UploadResponse:
        """Return one successful media upload result."""

        def raise_for_status(self) -> None:
            """Represent a successful HTTP status without side effects."""

        def json(self) -> dict[str, Any]:
            """Return the provider media identifier."""
            return {"errcode": 0, "media_id": "media-avatar"}

    class UploadClient:
        """Capture upload parameters without contacting the provider."""

        def __enter__(self):
            """Expose this fake as the client context value."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake client without external side effects."""

        def post(self, _url: str, **kwargs) -> UploadResponse:
            """Validate upload type and multipart filename before succeeding."""
            assert kwargs["params"] == {"access_token": "token", "type": "image"}
            assert kwargs["files"]["media"] == ("avatar.png", b"png", "image/png")
            return UploadResponse()

    monkeypatch.setattr(module.httpx, "Client", lambda **_kwargs: UploadClient())
    assert adapter.upload_avatar(binding, b"png", "avatar.png", "image/png") == "media-avatar"

    calls: list[tuple[str, dict[str, Any]]] = []

    def post(_binding: ChannelBinding, path: str, body: dict[str, Any]) -> dict[str, Any]:
        """Record account requests and return operation-specific provider fields."""
        calls.append((path, body))
        if path == "/kf/account/list":
            return {"account_list": [{"open_kfid": "wk-1", "name": "客服"}]}
        if path == "/kf/account/add":
            return {"open_kfid": "wk-created"}
        if path == "/kf/add_contact_way":
            return {"url": "https://work.weixin.qq.com/kf/example"}
        return {"errcode": 0}

    monkeypatch.setattr(adapter, "_post", post)
    assert adapter.list_accounts(binding)[0]["open_kfid"] == "wk-1"
    assert adapter.create_account_with_avatar(binding, "新客服", "media-avatar") == "wk-created"
    adapter.update_account(binding, "wk-created", "新名称", "media-next")
    adapter.delete_account(binding, "wk-created")
    assert adapter.contact_way(binding, open_kfid="wk-created") == (
        "https://work.weixin.qq.com/kf/example"
    )
    assert calls[1:] == [
        ("/kf/account/add", {"name": "新客服", "media_id": "media-avatar"}),
        (
            "/kf/account/update",
            {"open_kfid": "wk-created", "name": "新名称", "media_id": "media-next"},
        ),
        ("/kf/account/del", {"open_kfid": "wk-created"}),
        (
            "/kf/add_contact_way",
            {"open_kfid": "wk-created", "scene": "staffdeck"},
        ),
    ]


@pytest.mark.parametrize(
    "data",
    [b"", b"x" * (2 * 1024 * 1024 + 1)],
    ids=["empty", "oversized"],
)
def test_wechat_kf_avatar_upload_rejects_invalid_size_before_network(
    monkeypatch, data: bytes
) -> None:
    """Empty and oversized avatars fail locally before an HTTP client is constructed."""
    module = _wechat_kf_adapter_module()
    adapter = module.WeChatKfAdapter()
    binding = ChannelBinding(tenant_id="tenant_a", agent_id="agent_a", channel="wechat_kf")
    monkeypatch.setattr(adapter._tokens, "get", lambda _binding: "token")
    client_calls: list[str] = []

    class UploadResponse:
        """Return success if the production code incorrectly reaches the network."""

        def raise_for_status(self) -> None:
            """Represent a successful HTTP status without side effects."""

        def json(self) -> dict[str, Any]:
            """Expose a media ID so only local validation can satisfy the test."""
            return {"errcode": 0, "media_id": "should-not-upload"}

    class UploadClient:
        """Record an improper network boundary crossing."""

        def __enter__(self):
            """Expose this fake as the synchronous client context value."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake context without external side effects."""

        def post(self, *_args, **_kwargs) -> UploadResponse:
            """Record the improper provider write and return success."""
            client_calls.append("post")
            return UploadResponse()

    def client_factory(**_kwargs) -> UploadClient:
        """Record construction so validation must happen before the client boundary."""
        client_calls.append("construct")
        return UploadClient()

    monkeypatch.setattr(module.httpx, "Client", client_factory)

    with pytest.raises(module.WeChatKfPermanentError):
        adapter.upload_avatar(binding, data, "avatar.png", "image/png")

    assert client_calls == []


def test_wechat_kf_send_requires_idempotency_key_before_provider_write(monkeypatch) -> None:
    """Missing delivery identity fails closed before any provider request is emitted."""
    module = _wechat_kf_adapter_module()
    adapter = module.WeChatKfAdapter()
    binding = ChannelBinding(tenant_id="tenant_a", agent_id="agent_a", channel="wechat_kf")
    monkeypatch.setattr(adapter._tokens, "get", lambda _binding: "token")
    requests: list[dict[str, Any]] = []

    class FakeResponse:
        """Return provider success if the missing-key guard is bypassed."""

        def raise_for_status(self) -> None:
            """Represent a successful HTTP status without side effects."""

        def json(self) -> dict[str, Any]:
            """Return the complete successful provider shape."""
            return {"errcode": 0, "errmsg": "ok"}

    class FakeClient:
        """Capture improper send requests without external I/O."""

        def __enter__(self):
            """Expose this fake as the synchronous client context value."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake context without external side effects."""

        def post(self, _url: str, **kwargs) -> FakeResponse:
            """Record the provider JSON body if validation is bypassed."""
            requests.append(kwargs["json"])
            return FakeResponse()

    monkeypatch.setattr(module.httpx, "Client", lambda **_kwargs: FakeClient())

    with pytest.raises(module.WeChatKfPermanentError):
        adapter.send(
            binding,
            {"to_user_id": "external-user", "open_kfid": "wk-support"},
            "reply",
        )

    assert requests == []


def test_wechat_kf_send_requests_keep_chunk_ids_stable_across_retry(monkeypatch) -> None:
    """Real send requests use distinct byte-bounded chunk IDs that repeat deterministically."""
    module = _wechat_kf_adapter_module()
    adapter = module.WeChatKfAdapter()
    binding = ChannelBinding(tenant_id="tenant_a", agent_id="agent_a", channel="wechat_kf")
    monkeypatch.setattr(adapter._tokens, "get", lambda _binding: "token")
    requests: list[dict[str, Any]] = []

    class FakeResponse:
        """Return one successful provider send response."""

        def raise_for_status(self) -> None:
            """Represent a successful HTTP status without side effects."""

        def json(self) -> dict[str, Any]:
            """Return the complete successful provider shape."""
            return {"errcode": 0, "errmsg": "ok"}

    class FakeClient:
        """Capture provider requests while keeping adapter send logic real."""

        def __enter__(self):
            """Expose this fake as the synchronous client context value."""
            return self

        def __exit__(self, *_args) -> None:
            """Close the fake context without external side effects."""

        def post(self, url: str, **kwargs) -> FakeResponse:
            """Record only valid WeChat客服 send requests."""
            assert url.endswith("/kf/send_msg")
            assert kwargs["params"] == {"access_token": "token"}
            requests.append(kwargs["json"])
            return FakeResponse()

    monkeypatch.setattr(module.httpx, "Client", lambda **_kwargs: FakeClient())
    target = {"to_user_id": "external-user", "open_kfid": "wk-support"}
    text = "中" * 800

    adapter.send(binding, target, text, idempotency_key="delivery-1")
    adapter.send(binding, target, text, idempotency_key="delivery-1")

    assert len(requests) == 4
    first_attempt = requests[:2]
    retry_attempt = requests[2:]
    assert [request["msgid"] for request in first_attempt] == [
        request["msgid"] for request in retry_attempt
    ]
    assert len({request["msgid"] for request in first_attempt}) == 2
    assert all(len(request["msgid"]) == 32 for request in first_attempt)
    assert "".join(request["text"]["content"] for request in first_attempt) == text
    assert all(
        len(request["text"]["content"].encode("utf-8")) <= module.TEXT_LIMIT_BYTES
        for request in first_attempt
    )


def test_wechat_kf_replay_restores_attachment_dataclasses() -> None:
    """Replay decoding restores typed attachments and rejects cross-channel envelopes."""
    module = _wechat_kf_inbox_module()
    payload = {
        "schema_version": 1,
        "account": {"scope": "corp:wk-1"},
        "inbound": {
            "channel": "wechat_kf",
            "event_id": "file-1",
            "from_user_id": "external-1",
            "to_user_id": "wk-1",
            "session_id": "external-1",
            "group_id": "",
            "context_token": "wk-1",
            "text": "",
            "is_group": False,
            "raw": {},
            "account_scope": "corp:wk-1",
            "attachments": [{"media_id": "media-file", "kind": "file", "filename": "a.txt"}],
        },
    }

    inbound = module.decode_replay_envelope(payload)

    assert isinstance(inbound.attachments[0], ChannelInboundAttachment)
    assert inbound.attachments[0].media_id == "media-file"
    payload["inbound"]["channel"] = "wecom"
    with pytest.raises(ValueError, match="invalid_envelope_channel"):
        module.decode_replay_envelope(payload)


def test_wechat_kf_stage_persists_language_snapshot_and_deduplicates() -> None:
    """Staging stores one immutable replay event and acknowledges an identical retry."""
    module = _wechat_kf_inbox_module()
    engine = _test_engine()
    binding = _seed_binding_and_account(engine)

    first = module.stage_wechat_kf_inbound(
        db_engine=engine,
        binding_id=binding.id,
        expected_revision=7,
        account_scope="ww-tenant-a:wk-support",
        inbound=_inbound(text="first"),
    )
    duplicate = module.stage_wechat_kf_inbound(
        db_engine=engine,
        binding_id=binding.id,
        expected_revision=7,
        account_scope="ww-tenant-a:wk-support",
        inbound=_inbound(text="changed retry"),
    )

    assert first.disposition is StageDisposition.STAGED
    assert duplicate.disposition is StageDisposition.DUPLICATE
    assert duplicate.event_pk == first.event_pk
    with Session(engine) as db:
        events = db.exec(select(ChannelInboundEvent)).all()
        assert len(events) == 1
        assert events[0].payload_json["inbound"]["text"] == "first"
        assert events[0].tenant_id == "tenant_a"
        assert events[0].target_json == {
            "to_user_id": "external-user",
            "open_kfid": "wk-support",
        }
        assert events[0].language_context_json == {
            "version": 1,
            "ui_locale": "en-US",
            "agent_reply_locale": "zh-CN",
            "ui_locale_source": "channel_default",
            "agent_reply_locale_source": "channel_default",
        }


@pytest.mark.parametrize(
    "mutation",
    [
        "cross_account",
        "payload_scope",
        "payload_open_kfid",
        "target",
        "tenant",
        "channel",
        "revision",
    ],
)
def test_wechat_kf_stage_duplicate_requires_same_immutable_fences(mutation: str) -> None:
    """An event-ID collision is acknowledged only when every immutable account fence matches."""
    module = _wechat_kf_inbox_module()
    account_model = _wechat_kf_account_model()
    engine = _test_engine()
    binding = _seed_binding_and_account(engine)
    first = module.stage_wechat_kf_inbound(
        db_engine=engine,
        binding_id=binding.id,
        expected_revision=7,
        account_scope="ww-tenant-a:wk-support",
        inbound=_inbound(text="first"),
    )
    assert first.disposition is StageDisposition.STAGED

    retry_scope = "ww-tenant-a:wk-support"
    retry = _inbound(text="retry")
    with Session(engine) as db:
        existing = db.get(ChannelInboundEvent, first.event_pk)
        if mutation == "cross_account":
            db.add(
                account_model(
                    id="wka_other",
                    tenant_id="tenant_a",
                    binding_id=binding.id,
                    open_kfid="wk-other",
                    agent_id="agent_a",
                )
            )
            retry_scope = "ww-tenant-a:wk-other"
            retry = _inbound(open_kfid="wk-other", account_scope=retry_scope, text="retry")
        elif mutation == "payload_scope":
            payload = dict(existing.payload_json)
            payload["account"] = {"scope": "ww-tenant-a:wk-tampered"}
            existing.payload_json = payload
            db.add(existing)
        elif mutation == "payload_open_kfid":
            payload = dict(existing.payload_json)
            payload["inbound"] = {
                **payload["inbound"],
                "to_user_id": "wk-tampered",
            }
            existing.payload_json = payload
            db.add(existing)
        elif mutation == "target":
            retry.from_user_id = "external-other"
            retry.session_id = "external-other"
        elif mutation == "tenant":
            existing.tenant_id = "tenant-other"
            db.add(existing)
        elif mutation == "channel":
            existing.channel = "wecom"
            db.add(existing)
        else:
            existing.config_revision = 8
            db.add(existing)
        db.commit()

    collision = module.stage_wechat_kf_inbound(
        db_engine=engine,
        binding_id=binding.id,
        expected_revision=7,
        account_scope=retry_scope,
        inbound=retry,
    )

    assert collision.disposition is StageDisposition.SECURITY_DROP
    assert collision.error_code == "duplicate_fence_mismatch"


@pytest.mark.parametrize(
    ("mutation", "expected_error"),
    [
        ("revision", "binding_fence_mismatch"),
        ("scope", "binding_fence_mismatch"),
        ("account", "account_fence_mismatch"),
        ("tenant", "account_fence_mismatch"),
    ],
)
def test_wechat_kf_stage_fails_closed_on_security_fence_changes(
    mutation: str, expected_error: str
) -> None:
    """Revision, scope, active-account, and tenant drift are dropped before persistence."""
    module = _wechat_kf_inbox_module()
    account_model = _wechat_kf_account_model()
    engine = _test_engine()
    binding = _seed_binding_and_account(engine)
    account_scope = "ww-tenant-a:wk-support"
    expected_revision = 7
    with Session(engine) as db:
        stored_binding = db.get(ChannelBinding, binding.id)
        account = db.get(account_model, "wka_support")
        if mutation == "revision":
            stored_binding.config_revision = 8
            db.add(stored_binding)
        elif mutation == "scope":
            account_scope = "ww-tenant-a:wk-other"
        elif mutation == "account":
            account.status = "disabled"
            db.add(account)
        else:
            account.tenant_id = "tenant_other"
            db.add(account)
        db.commit()

    result = module.stage_wechat_kf_inbound(
        db_engine=engine,
        binding_id=binding.id,
        expected_revision=expected_revision,
        account_scope=account_scope,
        inbound=_inbound(account_scope=account_scope),
    )

    assert result.disposition is StageDisposition.SECURITY_DROP
    assert result.error_code == expected_error
    with Session(engine) as db:
        assert db.exec(select(ChannelInboundEvent)).all() == []


def test_wechat_kf_stage_rejects_oversized_or_unserializable_envelopes() -> None:
    """Untrusted replay payloads are bounded and serialization failures become security drops."""
    module = _wechat_kf_inbox_module()
    engine = _test_engine()
    binding = _seed_binding_and_account(engine)
    oversized = _inbound(text="x" * (module.MAX_ENVELOPE_BYTES + 1))
    unserializable = _inbound(event_id="msg-unserializable")
    unserializable.raw = {"bad": object()}

    too_large = module.stage_wechat_kf_inbound(
        db_engine=engine,
        binding_id=binding.id,
        expected_revision=7,
        account_scope="ww-tenant-a:wk-support",
        inbound=oversized,
    )
    invalid = module.stage_wechat_kf_inbound(
        db_engine=engine,
        binding_id=binding.id,
        expected_revision=7,
        account_scope="ww-tenant-a:wk-support",
        inbound=unserializable,
    )

    assert too_large.error_code == "event_payload_too_large"
    assert invalid.error_code == "invalid_event_payload"
    assert too_large.disposition is StageDisposition.SECURITY_DROP
    assert invalid.disposition is StageDisposition.SECURITY_DROP
