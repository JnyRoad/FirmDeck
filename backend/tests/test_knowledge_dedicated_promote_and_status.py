"""T077 缺陷 C、D：专用库"发布到广场为模板"后的归属保留，与转换后列表状态的一致性。

缺陷 C（`promote-to-overall`）：`promote_knowledge_branch_to_overall` 曾把
`open_gallery_metadata()` 直接套在专用库自己的 `KnowledgeBase.metadata_json` 上，而该函数
会无条件 `pop("owner_agent_id")`。归属标记一掉，`listing.py::_owner_agent_id` 就再也找不到
归属员工，A1/A1b 的 `owner_agent`/`branch`/`published_version` 全变空，前端回滚按钮取到空
`agent_id`、请求被后端当成"没指定范围"而 404 `KNOWLEDGE_AGENT_NOT_FOUND`。

缺陷 D（转换为共享后的状态）：转换只把源专用库的员工分支置为 `archived`（`sync_state
='converted'`），不动 `KnowledgeBase.status`。A1 列表此前直接读 `KnowledgeBase.status`，
继续报 `active`，与详情页显示的"已下线"矛盾。修复后两处共用
`listing.effective_knowledge_base_status` 这一份派生规则。

链路通过 `fastapi.testclient.TestClient` 驱动真实端点，验证阶段用独立 `Session(engine)` 读取。
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.api.knowledge_admin import router as knowledge_admin_router
from app.api.knowledge_bases import router as knowledge_bases_router
from app.db import get_session
from app.db.models import (
    AgentKnowledgeBranch,
    AgentProfile,
    AgentResourceBinding,
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Tenant,
    User,
)
from app.knowledge.conversion import KnowledgeConversionService
from app.security.auth import get_current_user

TENANT_ID = "tenant_demo"
OWNER_AGENT_ID = "agent_owner"
BASE_ID = "kb_dedicated_promote"


def _admin_user() -> User:
    return User(
        id="user_admin", tenant_id=TENANT_ID, username="admin", role="admin", password_hash="x"
    )


def _engine() -> Any:
    """隔离的内存 SQLite engine，建好全部表。"""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _http_client_for(engine: Any) -> TestClient:
    """挂上员工侧知识库路由与管理端列表路由，会话与当前用户按测试 engine 覆盖。"""
    app = FastAPI()
    app.include_router(knowledge_bases_router)
    app.include_router(knowledge_admin_router)

    def override_get_session():
        with Session(engine) as request_db:
            yield request_db

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = lambda: _admin_user()
    return TestClient(app)


def _seed_dedicated_base(engine: Any) -> None:
    """一个归属 `agent_owner`、分支活跃在 v2 的专用库，外加租户的整体智能体。

    整体智能体是广场上架（`ensure_open_gallery_binding`）的落点，缺了它 promote 无法把
    资源标成广场可见。
    """
    with Session(engine) as db:
        db.add(Tenant(id=TENANT_ID, slug="tenant-demo", name="Demo", lifecycle_version=1))
        db.add(AgentProfile(id="agent_overall", tenant_id=TENANT_ID, name="整体", is_overall=True))
        db.add(AgentProfile(id=OWNER_AGENT_ID, tenant_id=TENANT_ID, name="林晓"))
        db.add(
            KnowledgeBase(
                id=BASE_ID,
                tenant_id=TENANT_ID,
                name="林晓的专用库",
                mode="dedicated",
                status="active",
                metadata_json={
                    "owner_agent_id": OWNER_AGENT_ID,
                    "scope": "agent_private",
                    "visibility": "agent_private",
                    "created_from_agent": True,
                    "current_version": "2",
                },
            )
        )
        for label in ("1", "2"):
            db.add(
                KnowledgeBaseVersion(
                    id=f"kbver_promote_{label}",
                    tenant_id=TENANT_ID,
                    knowledge_base_id=BASE_ID,
                    version=label,
                    name="林晓的专用库",
                    publication_state="released",
                )
            )
        db.add(
            AgentKnowledgeBranch(
                id="agentkb_owner",
                tenant_id=TENANT_ID,
                agent_id=OWNER_AGENT_ID,
                knowledge_base_id=BASE_ID,
                base_version="2",
                head_version="2",
                sync_state="synced",
                status="active",
            )
        )
        # 私有绑定：转换为共享库时会连同分支一起归档，缺了它转换直接判定"分支不在用"。
        db.add(
            AgentResourceBinding(
                id="agentres_owner_kb",
                tenant_id=TENANT_ID,
                agent_id=OWNER_AGENT_ID,
                resource_type="knowledge_base",
                resource_id=BASE_ID,
                status="active",
                metadata_json={"scope": "agent_private", "visibility": "agent_private"},
            )
        )
        db.add(
            KnowledgeDocument(
                id="kdoc_promote_0",
                tenant_id=TENANT_ID,
                knowledge_base_id=BASE_ID,
                knowledge_base_version_id="kbver_promote_2",
                filename="playbook.md",
                file_type="md",
                title="话术手册",
                status="ready",
                metadata_json={"lineage_id": "L_PLAYBOOK", "raw_text": "话术第一条"},
            )
        )
        db.commit()


def _admin_list_item(client: TestClient, kb_id: str) -> dict[str, Any]:
    """从 A1 列表里取指定知识库那一项。"""
    response = client.get(
        "/api/enterprise/knowledge-admin/knowledge-bases",
        params={"tenant_id": TENANT_ID, "limit": 100},
    )
    assert response.status_code == 200, response.text
    return next(item for item in response.json()["items"] if item["id"] == kb_id)


def _admin_detail(client: TestClient, kb_id: str) -> dict[str, Any]:
    """A1b 单库详情。"""
    response = client.get(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{kb_id}",
        params={"tenant_id": TENANT_ID},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_promote_to_overall_keeps_owner_agent_and_rollback_still_works() -> None:
    """发布到广场为模板后，专用库仍保留归属员工，A1 照常展示，回滚照常可用。"""
    engine = _engine()
    _seed_dedicated_base(engine)
    client = _http_client_for(engine)

    promote = client.post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/promote-to-overall",
        params={"tenant_id": TENANT_ID, "agent_id": OWNER_AGENT_ID},
    )
    assert promote.status_code == 200, promote.text

    # 元数据：广场标记生效，但归属员工不被抹掉。
    with Session(engine) as verify_db:
        base = verify_db.get(KnowledgeBase, BASE_ID)
        assert base is not None
        metadata = base.metadata_json or {}
        assert metadata.get("owner_agent_id") == OWNER_AGENT_ID
        assert metadata.get("scope") == "open_gallery"
        assert metadata.get("visibility") == "open_gallery"
        # 私有标记必须清掉，否则广场可见性判定会把它当成私有资源。
        assert "created_from_agent" not in metadata

    # A1 列表：归属员工与分支信息仍在。
    item = _admin_list_item(client, BASE_ID)
    assert item["owner_agent"] == {"id": OWNER_AGENT_ID, "name": "林晓"}
    assert item["branch"] is not None
    assert _admin_detail(client, BASE_ID)["owner_agent"] == item["owner_agent"]

    # 回滚：前端从 `metadata.owner_agent_id` 取 agent_id，元数据还在才不会退化成空串 404。
    rollback = client.post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/rollback",
        json={"tenant_id": TENANT_ID, "agent_id": OWNER_AGENT_ID, "version": "1"},
    )
    assert rollback.status_code == 200, rollback.text
    assert rollback.json()["head_version"] == "1"


def test_admin_list_reports_archived_after_convert_to_shared() -> None:
    """转换为共享库后，源专用库在 A1 列表与 A1b 详情里都应报 `archived`。"""
    engine = _engine()
    _seed_dedicated_base(engine)
    client = _http_client_for(engine)

    assert _admin_list_item(client, BASE_ID)["status"] == "active"

    with Session(engine) as db:
        KnowledgeConversionService(db).convert_to_shared(
            tenant_id=TENANT_ID,
            source_knowledge_base_id=BASE_ID,
            source_agent_id=OWNER_AGENT_ID,
            name="团队话术知识",
            change_reason="开放给团队",
            actor_user_id="user_admin",
        )
        db.commit()

    # 前置事实：转换只归档了分支，知识库行本身仍是 active——状态必须由分支派生出来。
    with Session(engine) as verify_db:
        branch = verify_db.exec(
            select(AgentKnowledgeBranch).where(
                AgentKnowledgeBranch.knowledge_base_id == BASE_ID,
                AgentKnowledgeBranch.agent_id == OWNER_AGENT_ID,
            )
        ).one()
        assert branch.status == "archived"
        assert branch.sync_state == "converted"
        source = verify_db.get(KnowledgeBase, BASE_ID)
        assert source is not None and source.status == "active"

    item = _admin_list_item(client, BASE_ID)
    assert item["status"] == "archived"
    assert _admin_detail(client, BASE_ID)["status"] == "archived"
