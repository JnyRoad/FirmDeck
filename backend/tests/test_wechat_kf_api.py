"""微信客服企业 API 的权限、账号和凭据公开契约。"""

from __future__ import annotations

import base64
import json
import tomllib
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from packaging.requirements import Requirement
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.api.channels as channels_api
from app.channels.adapters.wechat_kf import (
    WeChatKfAdapter,
    WeChatKfPermanentError,
    WeChatKfTransientError,
)
from app.channels.crypto import decrypt_channel_secret, encrypt_channel_secret
from app.db import get_session
from app.db import models as db_models
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


def _client(db_engine, *, raise_server_exceptions: bool = True) -> TestClient:
    """创建只挂载渠道企业路由的测试客户端；不启动后台服务。"""
    app = FastAPI()
    app.include_router(channels_api.router)

    def override_get_session():
        """为每个请求提供隔离会话；会话结束时自动关闭。"""
        with Session(db_engine) as db:
            yield db

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app, raise_server_exceptions=raise_server_exceptions)


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


def test_wechat_kf_is_hidden_until_setup_ui_is_ready_without_changing_existing_metadata() -> None:
    """Task 3 前隐藏微信客服 metadata，同时保持现有渠道 setup 与字段不变。"""
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

    assert "wechat_kf" not in by_channel
    assert by_channel["wechat"]["setup"] == "qrcode"
    assert by_channel["wecom"]["setup"] == "credentials"
    assert set(by_channel) == {"wechat", "wecom", "feishu", "dingtalk"}


def test_runtime_dependencies_list_defusedxml_once() -> None:
    """运行依赖不得重复声明同一 XML 安全解析器，以保持 lock 输入确定。"""
    pyproject = tomllib.loads(
        (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    )
    dependencies = pyproject["project"]["dependencies"]
    names = [Requirement(item).name.lower() for item in dependencies]

    assert names.count("defusedxml") == 1


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


def _wechat_kf_operation_model():
    """返回 durable account operation 模型；缺失时以明确断言保留 RED。"""
    model = getattr(db_models, "WeChatKfAccountOperation", None)
    assert model is not None, "WeChatKfAccountOperation durable intent model is missing"
    return model


def _wechat_kf_reconciler():
    """返回账号操作恢复入口；缺失时以明确断言保留 RED。"""
    reconcile = getattr(channels_api, "reconcile_wechat_kf_account_operations", None)
    assert callable(reconcile), "WeChat KF account operation reconciler is missing"
    return reconcile


def test_main_validation_handler_sanitizes_enterprise_query_and_body() -> None:
    """主应用企业路由的 query/body validation 必须统一返回安全 descriptor。"""
    from app.main import app

    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    previous_overrides = dict(app.dependency_overrides)

    def override_get_session():
        """为主应用 validation 测试提供隔离数据库会话。"""
        with Session(db_engine) as db:
            yield db

    app.dependency_overrides[get_session] = override_get_session
    rejected = "tenant-private-input"
    try:
        client = TestClient(app)
        missing_query = client.get(
            "/api/enterprise/channels/meta",
            headers=_auth(users["owner"]),
        )
        invalid_body = client.post(
            f"/api/enterprise/channels/{binding_id}/wechat_kf/callback-config",
            json={"corp_id": rejected},
            headers=_auth(users["owner"]),
        )
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)

    for response in (missing_query, invalid_body):
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert detail["code"] == "VALIDATION_ERROR"
        assert detail["message_key"] == "errors.common.validation"
        assert detail["params"]["error_count"] >= 1
        assert rejected not in response.text


def test_create_intent_survives_local_commit_failure_and_reconciles(
    monkeypatch,
) -> None:
    """远端 create 成功而本地提交失败时必须留下可恢复 intent，重启恢复后只建一条路由。"""
    operation_model = _wechat_kf_operation_model()
    reconcile = _wechat_kf_reconciler()
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    private_failure = "sqlite:///private/provider-create-commit"
    provider_calls = 0

    def create_account(self, binding, name: str, media_id: str) -> str:
        """模拟一次成功 provider create，并返回稳定账号 ID。"""
        nonlocal provider_calls
        provider_calls += 1
        return "wk-recovered-create"

    monkeypatch.setattr(
        channels_api.WeChatKfAdapter,
        "create_account_with_avatar",
        create_account,
    )
    real_commit = Session.commit
    failed = False

    def fail_final_local_commit(self) -> None:
        """只注入新账号本地落账失败，intent 独立提交保持真实。"""
        nonlocal failed
        creates_account = any(
            isinstance(row, WeChatKfAccount) and row.open_kfid == "wk-recovered-create"
            for row in self.new
        )
        if creates_account and not failed:
            failed = True
            raise RuntimeError(private_failure)
        real_commit(self)

    monkeypatch.setattr(Session, "commit", fail_final_local_commit)
    response = _client(db_engine, raise_server_exceptions=False).post(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/accounts",
        json={"tenant_id": "tenant_demo", "name": "恢复账号", "media_id": "media-create"},
        headers=_auth(users["owner"]),
    )
    monkeypatch.setattr(Session, "commit", real_commit)

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "CHANNEL_UPSTREAM_ERROR"
    assert private_failure not in response.text
    with Session(db_engine) as db:
        operation = db.exec(select(operation_model)).one()
        assert operation.kind == "create"
        assert operation.status == "provider_applied"
        assert operation.open_kfid == "wk-recovered-create"
        assert db.exec(select(WeChatKfAccount)).all() == []

    reconcile(db_engine=db_engine, adapter=WeChatKfAdapter())

    with Session(db_engine) as db:
        operation = db.exec(select(operation_model)).one()
        account = db.exec(select(WeChatKfAccount)).one()
        assert operation.status == "completed"
        assert account.open_kfid == "wk-recovered-create"
        assert account.name == "恢复账号"
    assert provider_calls == 1


def test_update_intent_replays_desired_local_state_without_second_provider_write(
    monkeypatch,
) -> None:
    """远端 update 已成功时，本地失败恢复必须重放期望状态而不重复 provider 写入。"""
    operation_model = _wechat_kf_operation_model()
    reconcile = _wechat_kf_reconciler()
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    with Session(db_engine) as db:
        db.add(
            WeChatKfAccount(
                tenant_id="tenant_demo",
                binding_id=binding_id,
                open_kfid="wk-update-replay",
                name="旧名称",
                agent_id="agent_1",
            )
        )
        db.commit()
    provider_calls = 0

    def update_account(self, binding, open_kfid: str, name: str, media_id=None) -> None:
        """记录唯一一次成功 provider update，不访问外部服务。"""
        nonlocal provider_calls
        provider_calls += 1

    monkeypatch.setattr(channels_api.WeChatKfAdapter, "update_account", update_account)
    real_commit = Session.commit
    failed = False

    def fail_final_local_commit(self) -> None:
        """只注入账号新名称本地提交失败，保留 provider-applied intent。"""
        nonlocal failed
        updates_account = any(
            isinstance(row, WeChatKfAccount)
            and row.open_kfid == "wk-update-replay"
            and row.name == "新名称"
            for row in self.dirty
        )
        if updates_account and not failed:
            failed = True
            raise RuntimeError("private-update-commit")
        real_commit(self)

    monkeypatch.setattr(Session, "commit", fail_final_local_commit)
    response = _client(db_engine, raise_server_exceptions=False).patch(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/account",
        json={
            "tenant_id": "tenant_demo",
            "open_kfid": "wk-update-replay",
            "name": "新名称",
            "media_id": "media-update",
        },
        headers=_auth(users["owner"]),
    )
    monkeypatch.setattr(Session, "commit", real_commit)

    assert response.status_code == 502
    with Session(db_engine) as db:
        operation = db.exec(select(operation_model)).one()
        assert operation.status == "provider_applied"
        assert operation.desired_name == "新名称"
        assert db.exec(select(WeChatKfAccount)).one().name == "旧名称"

    reconcile(db_engine=db_engine, adapter=WeChatKfAdapter())

    with Session(db_engine) as db:
        assert db.exec(select(operation_model)).one().status == "completed"
        assert db.exec(select(WeChatKfAccount)).one().name == "新名称"
    assert provider_calls == 1


def test_delete_tombstone_retries_after_restart_and_treats_provider_404_as_done(
    monkeypatch,
) -> None:
    """delete 暂时失败时保留 tombstone，重启重试遇到 provider 404 后幂等完成。"""
    operation_model = _wechat_kf_operation_model()
    reconcile = _wechat_kf_reconciler()
    from app.channels.adapters import wechat_kf as adapter_module

    not_found_error = getattr(adapter_module, "WeChatKfNotFoundError", None)
    assert not_found_error is not None, "provider 404 classification is missing"
    db_engine = _engine()
    users, binding_id = _seed(db_engine)
    with Session(db_engine) as db:
        db.add(
            WeChatKfAccount(
                tenant_id="tenant_demo",
                binding_id=binding_id,
                open_kfid="wk-delete-retry",
                name="待删除",
                agent_id="agent_1",
            )
        )
        db.commit()

    class RetryThenNotFoundAdapter(WeChatKfAdapter):
        """首次删除返回不确定传输失败，恢复重试返回 provider 404。"""

        def __init__(self) -> None:
            """初始化调用计数，不访问外部服务。"""
            super().__init__()
            self.calls = 0

        def delete_account(self, binding, open_kfid: str) -> None:
            """按调用顺序返回 transient 与 not-found。"""
            self.calls += 1
            if self.calls == 1:
                raise WeChatKfTransientError("private-provider-delete-timeout")
            raise not_found_error("provider account already absent")

    adapter = RetryThenNotFoundAdapter()
    monkeypatch.setattr(channels_api, "WeChatKfAdapter", lambda: adapter)
    response = _client(db_engine).delete(
        f"/api/enterprise/channels/{binding_id}/wechat_kf/account/wk-delete-retry",
        params={"tenant_id": "tenant_demo"},
        headers=_auth(users["owner"]),
    )

    assert response.status_code == 502
    assert "private-provider-delete-timeout" not in response.text
    with Session(db_engine) as db:
        operation = db.exec(select(operation_model)).one()
        account = db.exec(select(WeChatKfAccount)).one()
        assert operation.kind == "delete"
        assert operation.status == "provider_inflight"
        assert account.status == "deleting"

    reconcile(db_engine=db_engine, adapter=adapter)

    with Session(db_engine) as db:
        assert db.exec(select(operation_model)).one().status == "completed"
        assert db.exec(select(WeChatKfAccount)).all() == []
    assert adapter.calls == 2


def test_reconcile_does_not_log_unexpected_provider_or_secret_detail(caplog) -> None:
    """恢复器遇到未分类异常时只能记录 operation ID，不能写 provider URL 或 Secret。"""
    operation_model = _wechat_kf_operation_model()
    reconcile = _wechat_kf_reconciler()
    db_engine = _engine()
    _users, binding_id = _seed(db_engine)
    private_detail = "https://provider.invalid/token?secret=provider-private"
    with Session(db_engine) as db:
        db.add(
            WeChatKfAccount(
                tenant_id="tenant_demo",
                binding_id=binding_id,
                open_kfid="wk-log-redaction",
                name="旧名称",
                agent_id="agent_1",
            )
        )
        db.add(
            operation_model(
                tenant_id="tenant_demo",
                binding_id=binding_id,
                kind="update",
                status="prepared",
                open_kfid="wk-log-redaction",
                desired_name="新名称",
                binding_revision=0,
            )
        )
        db.commit()

    class UnexpectedFailureAdapter(WeChatKfAdapter):
        """抛出携带敏感详情的未分类异常，不访问真实 provider。"""

        def update_account(self, binding, open_kfid: str, name: str, media_id=None) -> None:
            """模拟 adapter 分类边界外的异常。"""
            raise RuntimeError(private_detail)

    reconcile(db_engine=db_engine, adapter=UnexpectedFailureAdapter())

    assert private_detail not in caplog.text
    assert "provider-private" not in caplog.text
