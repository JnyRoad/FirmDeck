"""微信客服企业 API 的权限、账号和凭据公开契约。"""

from __future__ import annotations

import base64
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.api.channels as channels_api
from app.channels.adapters.wechat_kf import WeChatKfPermanentError
from app.channels.crypto import decrypt_channel_secret, encrypt_channel_secret
from app.db import get_session
from app.db.models import AgentProfile, ChannelBinding, Tenant, User, WeChatKfAccount
from app.security.auth import create_access_token


def _engine():
    """创建隔离内存数据库；仅在测试进程内持久化。"""
    value = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(value)
    return value


def _client(db_engine) -> TestClient:
    """创建只挂载渠道企业路由的测试客户端；不启动后台服务。"""
    app = FastAPI()
    app.include_router(channels_api.router)

    def override_get_session():
        """为每个请求提供隔离会话；会话结束时自动关闭。"""
        with Session(db_engine) as db:
            yield db

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def _seed(db_engine) -> tuple[dict[str, User], str]:
    """写入租户、所有者、旁观者和待配置绑定，返回授权主体与绑定 ID。"""
    with Session(db_engine) as db:
        db.add(Tenant(id="tenant_demo", name="Demo"))
        db.add(Tenant(id="tenant_other", name="Other"))
        owner = User(id="owner", tenant_id="tenant_demo", username="owner", password_hash="x")
        other = User(id="other", tenant_id="tenant_demo", username="other", password_hash="x")
        outsider = User(
            id="outsider",
            tenant_id="tenant_other",
            username="outsider",
            password_hash="x",
        )
        agent = AgentProfile(
            id="agent_1",
            tenant_id="tenant_demo",
            name="客服员工",
            metadata_json={"owner_user_id": owner.id, "owner_username": owner.username},
        )
        binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_1",
            channel="wechat_kf",
            status="pending",
            credentials_enc=encrypt_channel_secret("{}"),
            created_by_user_id=owner.id,
        )
        db.add_all([owner, other, outsider, agent, binding])
        db.commit()
        db.refresh(owner)
        db.refresh(other)
        db.refresh(outsider)
        db.refresh(binding)
        for row in (owner, other, outsider, binding):
            db.expunge(row)
        return {"owner": owner, "other": other, "outsider": outsider}, binding.id


def _auth(user: User) -> dict[str, str]:
    """为隔离用户生成测试 Bearer header，不写外部状态。"""
    return {"Authorization": f"Bearer {create_access_token(user)}"}


def test_wechat_kf_is_supported_without_changing_existing_metadata() -> None:
    """防止新增渠道覆盖原渠道的 setup 或 credential metadata。"""
    db_engine = _engine()
    users, _ = _seed(db_engine)
    payload = (
        _client(db_engine)
        .get(
            "/api/enterprise/channels/meta",
            params={"tenant_id": "tenant_demo"},
            headers=_auth(users["owner"]),
        )
        .json()
    )
    by_channel = {item["channel"]: item for item in payload}

    assert "wechat_kf" in by_channel
    assert by_channel["wechat"]["setup"] == "qrcode"
    assert by_channel["wecom"]["setup"] == "credentials"
    assert by_channel["wechat_kf"]["setup"] == "wechat_kf"
    assert {field["key"] for field in by_channel["wechat_kf"]["credential_fields"]} >= {
        "corp_id",
        "secret",
    }


def test_callback_config_and_credentials_encrypt_secrets_without_echo(monkeypatch) -> None:
    """防止回调预配置被凭据保存覆盖，并阻止 provider Secret 出现在公共响应。"""
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    client = _client(db_engine)
    monkeypatch.setattr(
        channels_api.WeChatKfTokenProvider,
        "get",
        lambda self, binding: "access-token",
    )

    prepared = client.post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/callback-config",
        json={"tenant_id": "tenant_demo", "corp_id": "ww1234567890"},
        headers=_auth(users["owner"]),
    )
    saved = client.post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/credentials",
        json={
            "tenant_id": "tenant_demo",
            "corp_id": "ww1234567890",
            "secret": "provider-secret-private",
        },
        headers=_auth(users["owner"]),
    )

    assert prepared.status_code == 200
    assert prepared.json()["callback_path"].endswith(f"/{binding_id}/callback")
    assert len(prepared.json()["callback_token"]) >= 24
    assert len(prepared.json()["encoding_aes_key"]) == 43
    assert saved.status_code == 200
    assert saved.json()["channel"] == "wechat_kf"
    assert saved.json()["status"] == "active"
    assert "provider-secret-private" not in saved.text
    assert "credentials" not in saved.text
    with Session(db_engine) as db:
        binding = db.get(ChannelBinding, binding_id)
        assert binding is not None
        credentials = json.loads(decrypt_channel_secret(binding.credentials_enc))
        assert credentials["secret"] == "provider-secret-private"
        assert credentials["callback_token"] == prepared.json()["callback_token"]
        assert credentials["encoding_aes_key"] == prepared.json()["encoding_aes_key"]


def test_wechat_kf_management_requires_binding_permission(monkeypatch) -> None:
    """防止同租户非管理员读取账号或改写凭据。"""
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    client = _client(db_engine)
    response = client.get(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/accounts",
        params={"tenant_id": "tenant_demo"},
        headers=_auth(users["other"]),
    )
    cross_tenant = client.get(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/accounts",
        params={"tenant_id": "tenant_demo"},
        headers=_auth(users["outsider"]),
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "CHANNEL_FORBIDDEN"
    assert cross_tenant.status_code == 403
    assert cross_tenant.json()["detail"]["code"] == "TENANT_MISMATCH"


def test_callback_config_rejects_corp_bound_to_another_binding() -> None:
    """防止两个绑定共享同一企业回调身份并混淆租户或账号游标。"""
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    with Session(db_engine) as db:
        second_binding = ChannelBinding(
            tenant_id="tenant_demo",
            agent_id="agent_1",
            channel="wechat_kf",
            status="pending",
            created_by_user_id=users["owner"].id,
        )
        db.add(second_binding)
        db.commit()
        db.refresh(second_binding)
        second_id = second_binding.id
    client = _client(db_engine)
    request = {"tenant_id": "tenant_demo", "corp_id": "ww1234567890"}

    first = client.post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/callback-config",
        json=request,
        headers=_auth(users["owner"]),
    )
    second = client.post(
        f"/api/enterprise/channels/{second_id}/wechat_kf/callback-config",
        json=request,
        headers=_auth(users["owner"]),
    )

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "CHANNEL_CONFLICT"


def test_account_list_select_create_update_delete_and_contact_way(monkeypatch) -> None:
    """防止账号 CRUD 混淆本地绑定、provider 账号及返回的咨询链接。"""
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    client = _client(db_engine)
    calls: list[tuple[str, str]] = []

    monkeypatch.setattr(
        channels_api.WeChatKfAdapter,
        "list_accounts",
        lambda self, binding: [
            {"open_kfid": "wk-existing", "name": "Existing"},
            {"open_kfid": "wk-created", "name": "Created"},
        ],
    )
    monkeypatch.setattr(
        channels_api.WeChatKfAdapter,
        "create_account_with_avatar",
        lambda self, binding, name, media_id: "wk-created",
    )
    monkeypatch.setattr(
        channels_api.WeChatKfAdapter,
        "update_account",
        lambda self, binding, open_kfid, name, media_id=None: calls.append(("update", open_kfid)),
    )
    monkeypatch.setattr(
        channels_api.WeChatKfAdapter,
        "delete_account",
        lambda self, binding, open_kfid: calls.append(("delete", open_kfid)),
    )
    monkeypatch.setattr(
        channels_api.WeChatKfAdapter,
        "contact_way",
        lambda self, binding, *, open_kfid, scene: "https://work.weixin.qq.com/kf/demo",
    )

    listed = client.get(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/accounts",
        params={"tenant_id": "tenant_demo"},
        headers=_auth(users["owner"]),
    )
    selected = client.post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/account",
        json={"tenant_id": "tenant_demo", "open_kfid": "wk-existing"},
        headers=_auth(users["owner"]),
    )
    created = client.post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/accounts",
        json={"tenant_id": "tenant_demo", "name": "Created", "media_id": "media-1"},
        headers=_auth(users["owner"]),
    )
    updated = client.patch(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/account",
        json={"tenant_id": "tenant_demo", "open_kfid": "wk-created", "name": "Renamed"},
        headers=_auth(users["owner"]),
    )
    contact = client.post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/contact-way",
        params={
            "tenant_id": "tenant_demo",
            "open_kfid": "wk-existing",
            "scene": "staffdeck",
        },
        headers=_auth(users["owner"]),
    )
    deleted = client.delete(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/account/wk-created",
        params={"tenant_id": "tenant_demo"},
        headers=_auth(users["owner"]),
    )

    assert listed.status_code == 200
    assert [item["open_kfid"] for item in listed.json()["accounts"]] == [
        "wk-existing",
        "wk-created",
    ]
    assert selected.status_code == 200
    assert created.status_code == 200
    assert updated.status_code == 200
    updated_accounts = {item["open_kfid"]: item for item in updated.json()["wechat_kf_accounts"]}
    assert updated_accounts["wk-created"]["name"] == "Renamed"
    assert contact.json() == {"url": "https://work.weixin.qq.com/kf/demo"}
    assert deleted.status_code == 200
    assert calls == [("update", "wk-created"), ("delete", "wk-created")]
    with Session(db_engine) as db:
        accounts = db.exec(select(WeChatKfAccount)).all()
        assert [row.open_kfid for row in accounts] == ["wk-existing"]


def test_avatar_upload_enforces_size_and_returns_only_media_id(monkeypatch) -> None:
    """防止超限头像到达 provider，并阻止上传响应混入 provider 原文。"""
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    client = _client(db_engine)
    monkeypatch.setattr(
        channels_api.WeChatKfAdapter,
        "upload_avatar",
        lambda self, binding, content, filename, content_type: "media-avatar",
    )

    uploaded = client.post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/avatar",
        params={"tenant_id": "tenant_demo"},
        files={"file": ("avatar.png", b"png-bytes", "image/png")},
        headers=_auth(users["owner"]),
    )
    too_large = client.post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/avatar",
        params={"tenant_id": "tenant_demo"},
        files={"file": ("avatar.png", b"x" * (2 * 1024 * 1024 + 1), "image/png")},
        headers=_auth(users["owner"]),
    )

    assert uploaded.status_code == 200
    assert uploaded.json() == {"media_id": "media-avatar"}
    assert too_large.status_code in {400, 413}
    assert too_large.json()["detail"]["code"] == "CHANNEL_BAD_REQUEST"


def test_credentials_validate_corp_and_aes_bounds_before_provider(monkeypatch) -> None:
    """防止非法 corp ID、AES key 或超长字段进入 provider 验证。"""
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    client = _client(db_engine)
    calls = 0

    def fail_if_called(self, binding):
        """记录不应发生的 provider 调用，无外部副作用。"""
        nonlocal calls
        calls += 1
        return "token"

    monkeypatch.setattr(channels_api.WeChatKfTokenProvider, "get", fail_if_called)
    invalid = client.post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/credentials",
        json={
            "tenant_id": "tenant_demo",
            "corp_id": "bad corp",
            "secret": "x" * 513,
            "callback_token": "x",
            "encoding_aes_key": base64.b64encode(b"short").decode(),
        },
        headers=_auth(users["owner"]),
    )

    assert invalid.status_code in {400, 422}
    if invalid.status_code == 400:
        assert invalid.json()["detail"]["code"] == "CHANNEL_BAD_REQUEST"
    assert calls == 0


def test_binding_read_never_exposes_private_provider_error() -> None:
    """防止账号同步的 provider body、URL 或异常文本通过绑定读取接口回显。"""
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    private_error = "provider-secret-body https://provider.invalid/token"
    with Session(db_engine) as db:
        db.add(
            WeChatKfAccount(
                tenant_id="tenant_demo",
                binding_id=binding_id,
                open_kfid="wk-private-error",
                agent_id="agent_1",
                last_error=private_error,
            )
        )
        db.commit()

    response = _client(db_engine).get(
        "/api/enterprise/channels",
        params={"tenant_id": "tenant_demo"},
        headers=_auth(users["owner"]),
    )

    assert response.status_code == 200
    assert private_error not in response.text
    assert "provider.invalid" not in response.text
    assert "last_error" not in response.text


def test_provider_exception_is_projected_without_public_body(monkeypatch) -> None:
    """防止 provider 异常正文通过账号管理 API 的公共错误 detail 回显。"""
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    private_error = "provider-secret-body https://provider.invalid/token"

    def raise_provider_error(self, binding):
        """Raise one controlled provider error without network access."""
        raise WeChatKfPermanentError(private_error)

    monkeypatch.setattr(
        channels_api.WeChatKfAdapter,
        "list_accounts",
        raise_provider_error,
    )

    response = _client(db_engine).get(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/accounts",
        params={"tenant_id": "tenant_demo"},
        headers=_auth(users["owner"]),
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "CHANNEL_BAD_REQUEST"
    assert private_error not in response.text
    assert "provider.invalid" not in response.text
