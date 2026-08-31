"""微信客服回调入口的安全、隔离、持久化和重放契约。"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib
import json
import struct
import threading
import time
from typing import Any
from urllib.parse import urlencode

import httpx
import pytest
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.channels.adapters.wechat_kf import WeChatKfAdapter
from app.channels.crypto import encrypt_channel_secret
from app.db.models import ChannelBinding, ChannelInboundEvent, Tenant, WeChatKfAccount


def _wechat_kf_api():
    """加载待实现的回调模块；缺失时用明确测试失败表达 RED，无副作用。"""
    try:
        return importlib.import_module("app.api.wechat_kf")
    except ModuleNotFoundError:
        pytest.fail("app.api.wechat_kf is not implemented")


def _encrypt(plaintext: str, aes_key: str, receive_id: str) -> str:
    """按企业微信兼容格式加密受控测试明文，不访问外部服务。"""
    key = base64.b64decode(aes_key + "=")
    payload = b"0123456789abcdef" + struct.pack("!I", len(plaintext.encode()))
    payload += plaintext.encode() + receive_id.encode()
    padding = 32 - len(payload) % 32
    payload += bytes((padding,)) * padding
    encryptor = Cipher(algorithms.AES(key), modes.CBC(key[:16])).encryptor()
    return base64.b64encode(encryptor.update(payload) + encryptor.finalize()).decode()


def _signature(token: str, timestamp: str, nonce: str, ciphertext: str) -> str:
    """为受控测试密文生成回调签名，无持久化副作用。"""
    values = sorted((token, timestamp, nonce, ciphertext))
    return hashlib.sha1("".join(values).encode(), usedforsecurity=False).hexdigest()


def _client(monkeypatch) -> tuple[TestClient, Any, str, dict[str, str]]:
    """创建隔离回调应用和已绑定账号；仅写内存数据库。"""
    api = _wechat_kf_api()
    db_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(db_engine)
    secrets = {
        "token": "callback-token-private",
        "aes_key": base64.b64encode(bytes(range(32))).decode().rstrip("="),
        "corp_id": "ww1234567890",
        "open_kfid": "wk1234567890",
    }
    with Session(db_engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_1",
            channel="wechat_kf",
            status="active",
            config_revision=7,
            credentials_enc=encrypt_channel_secret(
                '{"secret":"provider-private","callback_token":"callback-token-private",'
                f'"encoding_aes_key":"{secrets["aes_key"]}"}}'
            ),
            config_json={
                "corp_id": secrets["corp_id"],
                "ui_locale": "en-US",
                "agent_reply_locale": "zh-CN",
            },
        )
        db.add(binding)
        db.commit()
        db.refresh(binding)
        binding_id = binding.id
        db.add(
            WeChatKfAccount(
                tenant_id="tenant_demo",
                binding_id=binding.id,
                open_kfid=secrets["open_kfid"],
                agent_id="agent_1",
            )
        )
        db.commit()
    monkeypatch.setattr(api, "engine", db_engine)
    app = FastAPI()
    app.include_router(api.router)
    return TestClient(app), db_engine, binding_id, secrets


def _callback_xml(secrets: dict[str, str], *, receive_id: str | None = None) -> tuple[str, str]:
    """生成通知回调密文及其明文；不修改数据库或进程状态。"""
    plaintext = (
        "<xml><Event>kf_msg_or_event</Event><Token>sync-token</Token>"
        f"<OpenKfId>{secrets['open_kfid']}</OpenKfId></xml>"
    )
    return _encrypt(plaintext, secrets["aes_key"], receive_id or secrets["corp_id"]), plaintext


def _post_callback(
    client: TestClient,
    binding_id: str,
    secrets: dict[str, str],
    ciphertext: str,
    *,
    timestamp: str | None = None,
    nonce: str = "nonce",
):
    """发送受控回调请求并返回响应；只影响隔离测试应用。"""
    callback_timestamp = timestamp or str(int(time.time()))
    return client.post(
        f"/api/channels/wechat-kf/{binding_id}/callback",
        params={
            "msg_signature": _signature(secrets["token"], callback_timestamp, nonce, ciphertext),
            "timestamp": callback_timestamp,
            "nonce": nonce,
        },
        content=f"<xml><Encrypt><![CDATA[{ciphertext}]]></Encrypt></xml>",
    )


def test_callback_verification_returns_decrypted_echo(monkeypatch) -> None:
    """防止 GET 验证返回密文或绕过签名校验。"""
    client, _engine, binding_id, secrets = _client(monkeypatch)
    timestamp = str(int(time.time()))
    ciphertext = _encrypt("verified", secrets["aes_key"], secrets["corp_id"])

    response = client.get(
        f"/api/channels/wechat-kf/{binding_id}/callback",
        params={
            "msg_signature": _signature(secrets["token"], timestamp, "nonce", ciphertext),
            "timestamp": timestamp,
            "nonce": "nonce",
            "echostr": ciphertext,
        },
    )

    assert response.status_code == 200
    assert response.text == "verified"


@pytest.mark.parametrize(
    ("timestamp", "signature", "expected_status"),
    [
        (lambda: str(int(time.time())), "wrong", 403),
        (lambda: str(int(time.time()) - 301), None, 403),
        (lambda: str(int(time.time()) + 301), None, 403),
        (lambda: "not-an-integer", None, 400),
    ],
)
def test_callback_rejects_invalid_signature_or_timestamp_without_secret_echo(
    monkeypatch, timestamp, signature, expected_status
) -> None:
    """防止伪造或过期回调进入同步流程，并保证公共错误不回显秘密。"""
    client, _engine, binding_id, secrets = _client(monkeypatch)
    value = timestamp()
    ciphertext = _encrypt("verified", secrets["aes_key"], secrets["corp_id"])
    response = client.get(
        f"/api/channels/wechat-kf/{binding_id}/callback",
        params={
            "msg_signature": signature or _signature(secrets["token"], value, "nonce", ciphertext),
            "timestamp": value,
            "nonce": "nonce",
            "echostr": ciphertext,
        },
    )

    assert response.status_code == expected_status
    assert response.json()["detail"]["code"] in {"CHANNEL_BAD_REQUEST", "CHANNEL_FORBIDDEN"}
    assert secrets["token"] not in response.text
    assert secrets["aes_key"] not in response.text
    assert ciphertext not in response.text


@pytest.mark.parametrize(
    ("body", "expected_status"),
    [
        (b'<!DOCTYPE foo [<!ENTITY x "expanded">]><xml><Encrypt>&x;</Encrypt></xml>', 400),
        (b"<xml><Encrypt>not-base64</Encrypt></xml>", 403),
        (b"<xml></xml>", 400),
        (b"not-xml", 400),
    ],
)
def test_callback_rejects_malformed_or_unsafe_envelope(
    monkeypatch, body: bytes, expected_status: int
) -> None:
    """防止 DTD、实体、畸形 XML 或非法密文穿过公共回调入口。"""
    client, _engine, binding_id, _secrets = _client(monkeypatch)
    response = client.post(
        f"/api/channels/wechat-kf/{binding_id}/callback",
        params={"msg_signature": "signature", "timestamp": str(int(time.time())), "nonce": "n"},
        content=body,
    )

    assert response.status_code == expected_status
    assert response.json()["detail"]["code"] in {"CHANNEL_BAD_REQUEST", "CHANNEL_FORBIDDEN"}
    assert "XML" not in response.text


def test_callback_rejects_invalid_aes_payload_after_valid_signature(monkeypatch) -> None:
    """防止签名正确但不是合法 AES 帧的密文进入明文解析。"""
    client, _engine, binding_id, secrets = _client(monkeypatch)
    timestamp = str(int(time.time()))
    ciphertext = base64.b64encode(b"not-a-complete-aes-block").decode()
    response = client.post(
        f"/api/channels/wechat-kf/{binding_id}/callback",
        params={
            "msg_signature": _signature(secrets["token"], timestamp, "nonce", ciphertext),
            "timestamp": timestamp,
            "nonce": "nonce",
        },
        content=f"<xml><Encrypt>{ciphertext}</Encrypt></xml>",
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "CHANNEL_BAD_REQUEST"


async def _asgi_post_chunks(
    app,
    path: str,
    *,
    query: dict[str, str] | None = None,
    headers: list[tuple[bytes, bytes]] | None = None,
    chunks: list[bytes],
) -> tuple[int, bytes, int]:
    """向 ASGI 应用分块发送无缓冲请求，返回状态、响应体和实际读取块数。"""
    messages = [
        {
            "type": "http.request",
            "body": chunk,
            "more_body": index < len(chunks) - 1,
        }
        for index, chunk in enumerate(chunks)
    ]
    receive_calls = 0
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        """逐次返回受控请求块；超过准备块数后返回断开事件。"""
        nonlocal receive_calls
        receive_calls += 1
        if messages:
            return messages.pop(0)
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        """收集 ASGI 响应消息；只写当前测试内存。"""
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": urlencode(query or {}).encode(),
        "headers": headers or [],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
        "root_path": "",
    }
    await app(scope, receive, send)
    status = next(item["status"] for item in sent if item["type"] == "http.response.start")
    body = b"".join(item.get("body", b"") for item in sent if item["type"] == "http.response.body")
    return status, body, receive_calls


def test_callback_rejects_malicious_plaintext_and_wrong_corp(monkeypatch) -> None:
    """防止解密后的实体扩展或错误企业身份进入账号同步。"""
    client, _engine, binding_id, secrets = _client(monkeypatch)
    malicious = (
        '<!DOCTYPE foo [<!ENTITY x "expanded">]><xml><Event>&x;</Event>'
        f"<Token>sync-token</Token><OpenKfId>{secrets['open_kfid']}</OpenKfId></xml>"
    )
    malicious_cipher = _encrypt(malicious, secrets["aes_key"], secrets["corp_id"])
    malicious_response = _post_callback(client, binding_id, secrets, malicious_cipher)
    wrong_corp_cipher, _ = _callback_xml(secrets, receive_id="ww-other-corp")
    wrong_corp_response = _post_callback(client, binding_id, secrets, wrong_corp_cipher)

    assert malicious_response.status_code == 400
    assert malicious_response.json()["detail"]["code"] == "CHANNEL_BAD_REQUEST"
    assert wrong_corp_response.status_code == 403
    assert wrong_corp_response.json()["detail"]["code"] == "CHANNEL_FORBIDDEN"


def test_callback_rejects_oversized_sync_token_before_provider(monkeypatch) -> None:
    """防止解密载荷中的超长 provider token 穿过 XML 上限后进入同步请求。"""
    client, _engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()

    class FakeAdapter(WeChatKfAdapter):
        """若超长 token 到达 provider 层则使测试失败，无网络访问。"""

        def sync_messages(self, *args, **kwargs):
            """标记不应发生的 provider 同步调用。"""
            pytest.fail("oversized callback token reached provider")

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: FakeAdapter())
    plaintext = (
        "<xml><Event>kf_msg_or_event</Event>"
        f"<Token>{'x' * 4097}</Token>"
        f"<OpenKfId>{secrets['open_kfid']}</OpenKfId></xml>"
    )
    ciphertext = _encrypt(plaintext, secrets["aes_key"], secrets["corp_id"])

    response = _post_callback(client, binding_id, secrets, ciphertext)

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "CHANNEL_FORBIDDEN"


def test_callback_stages_once_with_immutable_language_and_advances_cursor(monkeypatch) -> None:
    """防止重复回调重复入站，并确保成功落盘后才推进账号游标。"""
    client, db_engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()

    class FakeAdapter(WeChatKfAdapter):
        """返回一页确定消息，不访问真实 provider。"""

        def sync_messages(self, binding, *, callback_token: str, cursor: str, open_kfid: str = ""):
            """模拟同步成功页，无外部副作用。"""
            return {
                "errcode": 0,
                "next_cursor": "cursor-1",
                "has_more": 0,
                "msg_list": [
                    {
                        "msgid": "msg-1",
                        "open_kfid": open_kfid,
                        "external_userid": "external-1",
                        "origin": 3,
                        "msgtype": "text",
                        "text": {"content": "原始内容《不要翻译》"},
                    }
                ],
            }

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: FakeAdapter())
    monkeypatch.setattr(api, "wake_staged_inbound_worker", lambda: None)
    ciphertext, _plaintext = _callback_xml(secrets)

    first = _post_callback(client, binding_id, secrets, ciphertext)
    second = _post_callback(client, binding_id, secrets, ciphertext)

    assert first.status_code == 200
    assert second.status_code == 200
    with Session(db_engine) as db:
        events = db.exec(select(ChannelInboundEvent)).all()
        assert len(events) == 1
        assert events[0].payload_json["inbound"]["text"] == "原始内容《不要翻译》"
        assert events[0].language_context_json == {
            "version": 1,
            "ui_locale": "en-US",
            "agent_reply_locale": "zh-CN",
            "ui_locale_source": "channel_default",
            "agent_reply_locale_source": "channel_default",
        }
        account = db.exec(select(WeChatKfAccount)).one()
        assert account.sync_cursor == "cursor-1"


def test_callback_rejects_unbound_account_without_cursor_change(monkeypatch) -> None:
    """防止同一企业的未绑定客服账号借用其他账号路由和游标。"""
    client, db_engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()
    secrets["open_kfid"] = "wk-unbound"

    class FakeAdapter(WeChatKfAdapter):
        """若错误进入同步则使测试失败，不访问真实 provider。"""

        def sync_messages(self, *args, **kwargs):
            """标记不应发生的同步调用，无外部副作用。"""
            pytest.fail("unbound account reached provider sync")

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: FakeAdapter())
    ciphertext, _plaintext = _callback_xml(secrets)
    response = _post_callback(client, binding_id, secrets, ciphertext)

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "CHANNEL_NOT_FOUND"
    with Session(db_engine) as db:
        account = db.exec(select(WeChatKfAccount)).one()
        assert account.sync_cursor == ""
        assert db.exec(select(ChannelInboundEvent)).all() == []


def test_callback_rejects_unbounded_provider_pagination_without_cursor_commit(monkeypatch) -> None:
    """防止 provider 的无穷分页耗尽 worker，并保证失败页不提交游标。"""
    client, db_engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()
    calls = 0

    class FakeAdapter(WeChatKfAdapter):
        """持续声明还有下一页，不访问真实 provider。"""

        def sync_messages(self, binding, *, callback_token: str, cursor: str, open_kfid: str = ""):
            """返回无穷分页标志，用于验证安全上限。"""
            nonlocal calls
            calls += 1
            return {
                "errcode": 0,
                "next_cursor": f"cursor-{calls}",
                "has_more": 1,
                "msg_list": [],
            }

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: FakeAdapter())
    ciphertext, _plaintext = _callback_xml(secrets)
    response = _post_callback(client, binding_id, secrets, ciphertext)

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "CHANNEL_UPSTREAM_ERROR"
    assert 1 < calls <= 20
    with Session(db_engine) as db:
        assert db.exec(select(WeChatKfAccount)).one().sync_cursor == ""


@pytest.mark.parametrize(
    "page",
    [
        {
            "errcode": 40001,
            "errmsg": "provider-secret-body",
            "msg_list": [],
            "next_cursor": "",
            "has_more": 0,
        },
        {"msg_list": [{}] * 1001, "next_cursor": "", "has_more": 0},
        {"msg_list": [], "next_cursor": "x" * 4097, "has_more": 0},
        {"msg_list": [], "next_cursor": "cursor", "has_more": 2},
        {"msg_list": [], "next_cursor": "", "has_more": 1},
    ],
)
def test_callback_rejects_provider_page_and_cursor_bounds(monkeypatch, page) -> None:
    """防止超限消息页、游标或不前进分页提交账号游标。"""
    client, db_engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()

    class FakeAdapter(WeChatKfAdapter):
        """返回受控畸形 provider 页，不访问真实 provider。"""

        def sync_messages(self, *args, **kwargs):
            """返回测试参数提供的单页，无外部副作用。"""
            return page

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: FakeAdapter())
    ciphertext, _plaintext = _callback_xml(secrets)

    response = _post_callback(client, binding_id, secrets, ciphertext)

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "CHANNEL_UPSTREAM_ERROR"
    assert "provider-secret-body" not in response.text
    with Session(db_engine) as db:
        assert db.exec(select(WeChatKfAccount)).one().sync_cursor == ""


def test_callback_rejects_oversized_payload_before_decryption(monkeypatch) -> None:
    """防止超限回调体进入 XML/AES 解析并占用过多内存。"""
    client, _engine, binding_id, _secrets = _client(monkeypatch)
    response = client.post(
        f"/api/channels/wechat-kf/{binding_id}/callback",
        params={"msg_signature": "x", "timestamp": str(int(time.time())), "nonce": "n"},
        content=b"x" * (1024 * 1024 + 1),
    )

    assert response.status_code in {400, 413}
    assert response.json()["detail"]["code"] == "CHANNEL_BAD_REQUEST"


def test_durable_daemon_polls_wechat_kf_events(monkeypatch) -> None:
    """防止微信客服 durable inbox 因未注册轮询渠道而永久停留在 received。"""
    client, db_engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()

    class FakeAdapter(WeChatKfAdapter):
        """返回一条受控消息以创建 durable inbox，不访问真实 provider。"""

        def sync_messages(self, binding, *, callback_token: str, cursor: str, open_kfid: str = ""):
            """模拟单页同步成功，无外部副作用。"""
            return {
                "errcode": 0,
                "next_cursor": "cursor-daemon",
                "has_more": 0,
                "msg_list": [
                    {
                        "msgid": "msg-daemon",
                        "open_kfid": open_kfid,
                        "external_userid": "external-daemon",
                        "origin": 3,
                        "msgtype": "text",
                        "text": {"content": "daemon"},
                    }
                ],
            }

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: FakeAdapter())
    monkeypatch.setattr(api, "wake_staged_inbound_worker", lambda: None)
    ciphertext, _plaintext = _callback_xml(secrets)
    assert _post_callback(client, binding_id, secrets, ciphertext).status_code == 200

    from app.channels import service_intake

    processed: list[str] = []
    monkeypatch.setattr(
        service_intake,
        "process_staged_inbound",
        lambda event_id, *, db_engine=None: processed.append(event_id) or True,
    )
    service_intake.run_staged_inbound_daemon(once=True, db_engine=db_engine)

    with Session(db_engine) as db:
        event_id = db.exec(select(ChannelInboundEvent.id)).one()
    assert processed == [event_id]


def test_replay_rejects_binding_revision_change(monkeypatch) -> None:
    """防止已暂存消息在凭据或账号代际变化后借用新配置继续处理。"""
    client, db_engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()

    class FakeAdapter(WeChatKfAdapter):
        """返回一条受控消息以创建 durable inbox，不访问真实 provider。"""

        def sync_messages(self, binding, *, callback_token: str, cursor: str, open_kfid: str = ""):
            """模拟单页同步成功，无外部副作用。"""
            return {
                "errcode": 0,
                "next_cursor": "cursor-revision",
                "has_more": 0,
                "msg_list": [
                    {
                        "msgid": "msg-revision",
                        "open_kfid": open_kfid,
                        "external_userid": "external-revision",
                        "origin": 3,
                        "msgtype": "text",
                        "text": {"content": "revision"},
                    }
                ],
            }

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: FakeAdapter())
    monkeypatch.setattr(api, "wake_staged_inbound_worker", lambda: None)
    ciphertext, _plaintext = _callback_xml(secrets)
    assert _post_callback(client, binding_id, secrets, ciphertext).status_code == 200

    from app.channels import service_intake

    with Session(db_engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        event = db.exec(select(ChannelInboundEvent)).one()
        assert binding is not None
        binding.config_revision += 1
        db.add(binding)
        db.commit()
        db.refresh(binding)
        with pytest.raises(ValueError, match="replay_account_mismatch"):
            service_intake._decode_and_validate_staged_event(event, binding)


def test_main_application_registers_callback_router() -> None:
    """防止生产应用启动时遗漏微信客服 GET/POST callback 路由。"""
    from app.main import app

    client = TestClient(app)
    get_response = client.get("/api/channels/wechat-kf/missing/callback")
    post_response = client.post("/api/channels/wechat-kf/missing/callback")

    assert get_response.status_code == 400
    assert post_response.status_code == 400
    assert get_response.json()["detail"]["code"] == "CHANNEL_BAD_REQUEST"
    assert post_response.json()["detail"]["code"] == "CHANNEL_BAD_REQUEST"


def test_callback_streaming_limit_stops_before_buffering_tail(monkeypatch) -> None:
    """无 Content-Length 的超限 callback 必须在越界块立即停止，不能读取剩余尾块。"""
    _client_instance, _db_engine, binding_id, _secrets = _client(monkeypatch)
    api = _wechat_kf_api()
    app = FastAPI()
    app.include_router(api.router)
    limit = api.CALLBACK_BODY_MAX_BYTES
    status, body, receive_calls = asyncio.run(
        _asgi_post_chunks(
            app,
            f"/api/channels/wechat-kf/{binding_id}/callback",
            query={"msg_signature": "x", "timestamp": str(int(time.time())), "nonce": "n"},
            chunks=[b"a" * limit, b"b", b"unread-tail"],
        )
    )

    assert status in {400, 413}
    assert json.loads(body)["detail"]["code"] == "CHANNEL_BAD_REQUEST"
    assert receive_calls == 2


def test_callback_content_length_limit_rejects_without_reading_body(monkeypatch) -> None:
    """声明 callback 正文超限时必须在第一次 receive 前拒绝。"""
    _client_instance, _db_engine, binding_id, _secrets = _client(monkeypatch)
    api = _wechat_kf_api()
    app = FastAPI()
    app.include_router(api.router)
    status, body, receive_calls = asyncio.run(
        _asgi_post_chunks(
            app,
            f"/api/channels/wechat-kf/{binding_id}/callback",
            query={"msg_signature": "x", "timestamp": str(int(time.time())), "nonce": "n"},
            headers=[(b"content-length", str(api.CALLBACK_BODY_MAX_BYTES + 1).encode())],
            chunks=[b"must-not-be-read"],
        )
    )

    assert status in {400, 413}
    assert json.loads(body)["detail"]["code"] == "CHANNEL_BAD_REQUEST"
    assert receive_calls == 0


def test_avatar_chunked_limit_rejects_before_multipart_parser(monkeypatch) -> None:
    """微信客服头像总请求超限时必须在 multipart parser 前停止读取。"""
    from starlette import formparsers

    from app.main import app

    parse_calls = 0
    real_parse = formparsers.MultiPartParser.parse

    async def record_parse(self):
        """记录 parser 是否被调用，并保持框架真实解析行为。"""
        nonlocal parse_calls
        parse_calls += 1
        return await real_parse(self)

    monkeypatch.setattr(formparsers.MultiPartParser, "parse", record_parse)
    boundary = "staffdeck-boundary"
    prefix = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="avatar.png"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode()
    request_limit = 2 * 1024 * 1024 + 64 * 1024
    multipart = prefix + b"x" * (request_limit + 32) + f"\r\n--{boundary}--\r\n".encode()
    status, body, receive_calls = asyncio.run(
        _asgi_post_chunks(
            app,
            "/api/enterprise/channels/chan-test/wechat_kf/avatar",
            headers=[(b"content-type", f"multipart/form-data; boundary={boundary}".encode())],
            chunks=[
                multipart[:request_limit],
                multipart[request_limit : request_limit + 1],
                multipart[request_limit + 1 :],
            ],
        )
    )

    assert status == 413
    assert json.loads(body)["detail"]["code"] == "CHANNEL_BAD_REQUEST"
    assert receive_calls == 2
    assert parse_calls == 0


def test_main_validation_handler_redacts_oversized_callback_query() -> None:
    """主应用必须把 callback query 校验错误投影为 descriptor 且不回显拒绝值。"""
    from app.main import app

    rejected = "signature-private-" + "x" * 129
    response = TestClient(app).get(
        "/api/channels/wechat-kf/chan-validation/callback",
        params={
            "msg_signature": rejected,
            "timestamp": str(int(time.time())),
            "nonce": "nonce",
            "echostr": "echo",
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "VALIDATION_ERROR",
        "message_key": "errors.common.validation",
        "params": {"error_count": 1},
        "retryable": False,
        "status": 422,
    }
    assert rejected not in response.text


@pytest.mark.parametrize(
    "malformed",
    [
        {
            "msgid": "text-legal_123",
            "open_kfid": "wk-legal_123",
            "external_userid": "wm-legal_123",
            "origin": 3,
            "msgtype": "text",
            "text": "not-an-object",
        },
        {
            "msgid": "file-legal_123",
            "open_kfid": "wk-legal_123",
            "external_userid": "wm-legal_123",
            "origin": 3,
            "msgtype": "file",
            "file": {"filename": "missing-media.pdf"},
        },
    ],
)
def test_supported_malformed_messages_fail_page_without_cursor_commit(
    monkeypatch, malformed
) -> None:
    """origin=3 的受支持格式畸形时必须失败整页，不能静默推进 cursor。"""
    client, db_engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()
    malformed = dict(malformed, open_kfid=secrets["open_kfid"])

    class FakeAdapter(WeChatKfAdapter):
        """返回一条受支持但畸形的 provider 消息，不访问外部服务。"""

        def sync_messages(self, *args, **kwargs):
            """返回固定单页，使 cursor 安全语义可观察。"""
            return {
                "errcode": 0,
                "next_cursor": "must-not-commit",
                "has_more": 0,
                "msg_list": [malformed],
            }

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: FakeAdapter())
    ciphertext, _plaintext = _callback_xml(secrets)
    response = _post_callback(client, binding_id, secrets, ciphertext)

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "CHANNEL_UPSTREAM_ERROR"
    with Session(db_engine) as db:
        assert db.exec(select(WeChatKfAccount)).one().sync_cursor == ""
        assert db.exec(select(ChannelInboundEvent)).all() == []


def test_unsupported_origin_is_ignored_while_cursor_advances(monkeypatch) -> None:
    """非客户来源消息保持来源无关忽略语义，并允许成功页推进 cursor。"""
    client, db_engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()

    class FakeAdapter(WeChatKfAdapter):
        """返回未知来源消息，不访问外部服务。"""

        def sync_messages(self, *args, **kwargs):
            """返回固定 ignored 消息页。"""
            return {
                "errcode": 0,
                "next_cursor": "ignored-origin-advanced",
                "has_more": 0,
                "msg_list": [
                    {
                        "msgid": "ignored-1",
                        "open_kfid": secrets["open_kfid"],
                        "external_userid": "external-1",
                        "origin": 5,
                        "msgtype": "text",
                        "text": {"content": "servicer"},
                    }
                ],
            }

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: FakeAdapter())
    ciphertext, _plaintext = _callback_xml(secrets)
    response = _post_callback(client, binding_id, secrets, ciphertext)

    assert response.status_code == 200
    with Session(db_engine) as db:
        assert db.exec(select(WeChatKfAccount)).one().sync_cursor == "ignored-origin-advanced"
        assert db.exec(select(ChannelInboundEvent)).all() == []


def test_slow_provider_sync_does_not_block_event_loop_health(monkeypatch) -> None:
    """慢 provider 分页必须在线程池运行，使同一事件循环仍可响应健康请求。"""
    _client_instance, _db_engine, binding_id, secrets = _client(monkeypatch)
    api = _wechat_kf_api()
    release = threading.Event()

    class SlowAdapter(WeChatKfAdapter):
        """阻塞 provider 同步直到外部计时器释放，用于观测事件循环调度。"""

        def sync_messages(self, binding, *, callback_token: str, cursor: str, open_kfid: str = ""):
            """等待固定门闩后返回空成功页；不访问真实 provider。"""
            release.wait(2.0)
            return {
                "errcode": 0,
                "next_cursor": "slow-cursor",
                "has_more": 0,
                "msg_list": [],
            }

    monkeypatch.setattr(api, "get_channel_adapter", lambda _channel: SlowAdapter())
    ciphertext, _plaintext = _callback_xml(secrets)
    timestamp = str(int(time.time()))
    params = {
        "msg_signature": _signature(secrets["token"], timestamp, "nonce", ciphertext),
        "timestamp": timestamp,
        "nonce": "nonce",
    }
    body = f"<xml><Encrypt>{ciphertext}</Encrypt></xml>"
    app = FastAPI()
    app.include_router(api.router)

    @app.get("/health-probe")
    async def health_probe() -> dict[str, str]:
        """返回事件循环存活标记，无副作用。"""
        return {"status": "ok"}

    async def exercise() -> tuple[float, int, int]:
        """并发发送慢 callback 与健康请求，并返回调度耗时和状态。"""
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            timer = threading.Timer(0.6, release.set)
            timer.start()
            started = time.monotonic()
            callback_task = asyncio.create_task(
                client.post(
                    f"/api/channels/wechat-kf/{binding_id}/callback",
                    params=params,
                    content=body,
                )
            )
            await asyncio.sleep(0)
            health = await client.get("/health-probe")
            elapsed = time.monotonic() - started
            callback = await callback_task
            timer.cancel()
            return elapsed, health.status_code, callback.status_code

    elapsed, health_status, callback_status = asyncio.run(exercise())

    assert health_status == 200
    assert callback_status == 200
    assert elapsed < 0.3
