"""专用知识库转换为新共享谱系的服务与 API 回归测试。"""

from __future__ import annotations

import inspect
from dataclasses import dataclass

import pytest
from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agents.branching import ensure_agent_private_knowledge_branch
from app.api import knowledge_bases as knowledge_bases_api
from app.db.models import (
    AgentKnowledgeBranch,
    AgentProfile,
    AgentResourceBinding,
    KnowledgeBase,
    KnowledgeBaseAuditEvent,
    KnowledgeBaseVersion,
    KnowledgeBucket,
    KnowledgeChunk,
    KnowledgeConcept,
    KnowledgeDiscoverySuggestion,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    Tenant,
    User,
)
from app.knowledge import conversion as conversion_module
from app.knowledge.schema import KnowledgeBaseConvertToSharedRequest


@dataclass(frozen=True)
class _ConversionFixture:
    """转换测试使用的来源谱系、员工分支和目标团队标识。"""

    source_base_id: str
    source_version_id: str
    source_agent_id: str
    sibling_agent_id: str
    team_id: str


def _session() -> Session:
    """创建隔离的 SQLite 内存会话。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _admin_user() -> User:
    """返回有权把员工专用知识转为组织共享资产的租户管理员。"""
    return User(
        id="user-admin",
        tenant_id="tenant_demo",
        username="admin",
        role="admin",
        password_hash="test",
    )


def _seed_dedicated_lineage(db: Session) -> _ConversionFixture:
    """建立一份带五类资产的专用版本和一个不应受影响的兄弟分支。"""
    source_agent_id = "agent-source"
    sibling_agent_id = "agent-sibling"
    db.add(Tenant(id="tenant_demo", name="Demo"))
    db.add(AgentProfile(id=source_agent_id, tenant_id="tenant_demo", name="来源员工"))
    db.add(AgentProfile(id=sibling_agent_id, tenant_id="tenant_demo", name="兄弟员工"))
    source = KnowledgeBase(
        id="kb-dedicated-source",
        tenant_id="tenant_demo",
        name="员工内容资料",
        description="长期积累的专用资料",
        mode="dedicated",
    )
    db.add(source)
    db.flush()
    selected_branch = ensure_agent_private_knowledge_branch(
        db,
        "tenant_demo",
        source_agent_id,
        source,
    )
    source_version = db.exec(
        select(KnowledgeBaseVersion).where(
            KnowledgeBaseVersion.tenant_id == "tenant_demo",
            KnowledgeBaseVersion.knowledge_base_id == source.id,
            KnowledgeBaseVersion.version == selected_branch.head_version,
        )
    ).one()

    # 兄弟员工模拟从同一历史模板派生的独立实例；转换只允许归档所选实例。
    db.add(
        AgentKnowledgeBranch(
            id="branch-sibling",
            tenant_id="tenant_demo",
            agent_id=sibling_agent_id,
            knowledge_base_id=source.id,
            base_version=source_version.version,
            head_version=source_version.version,
            status="active",
        )
    )
    db.add(
        AgentResourceBinding(
            id="binding-sibling",
            tenant_id="tenant_demo",
            agent_id=sibling_agent_id,
            resource_type="knowledge_base",
            resource_id=source.id,
            status="active",
        )
    )
    document = KnowledgeDocument(
        id="doc-source",
        tenant_id="tenant_demo",
        knowledge_base_id=source.id,
        knowledge_base_version_id=source_version.id,
        filename="content.md",
        file_type="markdown",
        title="内容方法",
        status="ready",
        bucket_count=1,
        chunk_count=1,
    )
    bucket = KnowledgeBucket(
        id="bucket-source",
        tenant_id="tenant_demo",
        knowledge_base_id=source.id,
        knowledge_base_version_id=source_version.id,
        document_id=document.id,
        bucket_key="content-method",
        title="内容方法",
        summary="摘要",
    )
    db.add(document)
    db.add(bucket)
    db.add(
        KnowledgeChunk(
            id="chunk-source",
            tenant_id="tenant_demo",
            knowledge_base_id=source.id,
            knowledge_base_version_id=source_version.id,
            document_id=document.id,
            bucket_id=bucket.id,
            chunk_index=0,
            content="先研究用户问题，再形成内容。",
        )
    )
    db.add(
        KnowledgeConcept(
            id="concept-source",
            tenant_id="tenant_demo",
            knowledge_base_id=source.id,
            knowledge_base_version_id=source_version.id,
            document_id=document.id,
            concept_id="method/content",
            concept_type="method",
            title="内容方法",
            content_md="# 内容方法",
            source_refs_json=[{"document_id": document.id}],
        )
    )
    db.add(
        KnowledgeDiscoverySuggestion(
            id="suggestion-source",
            tenant_id="tenant_demo",
            knowledge_base_id=source.id,
            knowledge_base_version_id=source_version.id,
            document_id=document.id,
            bucket_id=bucket.id,
            suggestion_type="link",
            title="关联选题库",
            source_refs_json=[{"document_id": document.id}],
        )
    )
    team = Team(
        id="team-content",
        tenant_id="tenant_demo",
        name="内容团队",
        owner_user_id="user-admin",
    )
    db.add(team)
    db.commit()
    return _ConversionFixture(
        source_base_id=source.id,
        source_version_id=source_version.id,
        source_agent_id=source_agent_id,
        sibling_agent_id=sibling_agent_id,
        team_id=team.id,
    )


def _asset_counts(
    db: Session,
    *,
    knowledge_base_id: str,
    version_id: str,
) -> dict[str, int]:
    """读取转换必须逐项保持的五类资产数量。"""
    models = {
        "documents": KnowledgeDocument,
        "buckets": KnowledgeBucket,
        "chunks": KnowledgeChunk,
        "concepts": KnowledgeConcept,
        "suggestions": KnowledgeDiscoverySuggestion,
    }
    return {
        name: len(
            db.exec(
                select(model.id).where(
                    model.knowledge_base_id == knowledge_base_id,
                    model.knowledge_base_version_id == version_id,
                )
            ).all()
        )
        for name, model in models.items()
    }


def test_conversion_copies_assets_binds_team_and_archives_only_selected_source() -> None:
    """成功转换创建新共享正式版，并仅归档发起员工的专用实例。"""
    module = conversion_module
    with _session() as db:
        fixture = _seed_dedicated_lineage(db)
        result = module.KnowledgeConversionService(db).convert_to_shared(
            tenant_id="tenant_demo",
            source_knowledge_base_id=fixture.source_base_id,
            source_agent_id=fixture.source_agent_id,
            source_version_id=None,
            name="团队内容知识",
            description="团队统一内容方法",
            change_reason="将成熟内容方法开放给团队",
            team_ids=[fixture.team_id],
            default_for_team_id=fixture.team_id,
            actor_user_id="user-admin",
        )
        db.commit()

        shared = db.get(KnowledgeBase, result.shared_knowledge_base_id)
        release = db.get(KnowledgeBaseVersion, result.released_version_id)
        selected_branch = db.exec(
            select(AgentKnowledgeBranch).where(
                AgentKnowledgeBranch.agent_id == fixture.source_agent_id,
                AgentKnowledgeBranch.knowledge_base_id == fixture.source_base_id,
            )
        ).one()
        selected_binding = db.exec(
            select(AgentResourceBinding).where(
                AgentResourceBinding.agent_id == fixture.source_agent_id,
                AgentResourceBinding.resource_type == "knowledge_base",
                AgentResourceBinding.resource_id == fixture.source_base_id,
            )
        ).one()
        sibling_branch = db.get(AgentKnowledgeBranch, "branch-sibling")
        sibling_binding = db.get(AgentResourceBinding, "binding-sibling")
        team = db.get(Team, fixture.team_id)
        team_binding = db.exec(
            select(TeamKnowledgeBaseBinding).where(
                TeamKnowledgeBaseBinding.team_id == fixture.team_id,
                TeamKnowledgeBaseBinding.knowledge_base_id == result.shared_knowledge_base_id,
            )
        ).one()
        audit = db.get(KnowledgeBaseAuditEvent, result.audit_event_id)

        assert shared is not None and shared.mode == "shared"
        assert shared.published_version_id == release.id
        assert release is not None and release.publication_state == "released"
        assert _asset_counts(
            db,
            knowledge_base_id=shared.id,
            version_id=release.id,
        ) == {"documents": 1, "buckets": 1, "chunks": 1, "concepts": 1, "suggestions": 1}
        assert selected_branch.status == "archived"
        assert selected_binding.status == "archived"
        assert sibling_branch is not None and sibling_branch.status == "active"
        assert sibling_binding is not None and sibling_binding.status == "active"
        # FR-082：源专用库本身也要下线，不能只归档分支——否则员工侧写路径（例如
        # `_resolve_upload_knowledge_base` 里 `status == "archived"` 那道闸）永远看不到
        # 已转换的事实，仍会当作活跃库放行写入。
        assert db.get(KnowledgeBase, fixture.source_base_id).status == "archived"
        assert team_binding.status == "active"
        assert team is not None and team.default_knowledge_base_id == shared.id
        assert audit is not None and audit.action == "dedicated_converted"


def test_clone_failure_preserves_source_and_removes_partial_shared_lineage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """复制异常回滚新共享谱系，来源分支和绑定继续可用。"""
    module = conversion_module

    def fail_clone(*args, **kwargs):
        """模拟底层复制在写入共享资产前失败。"""
        raise RuntimeError("injected clone failure")

    monkeypatch.setattr(module, "clone_knowledge_version_assets", fail_clone)
    with _session() as db:
        fixture = _seed_dedicated_lineage(db)
        with pytest.raises(RuntimeError, match="injected clone failure"):
            module.KnowledgeConversionService(db).convert_to_shared(
                tenant_id="tenant_demo",
                source_knowledge_base_id=fixture.source_base_id,
                source_agent_id=fixture.source_agent_id,
                name="失败的共享知识",
                change_reason="验证失败补偿",
                actor_user_id="user-admin",
            )

        branch = db.exec(
            select(AgentKnowledgeBranch).where(
                AgentKnowledgeBranch.agent_id == fixture.source_agent_id,
                AgentKnowledgeBranch.knowledge_base_id == fixture.source_base_id,
            )
        ).one()
        binding = db.exec(
            select(AgentResourceBinding).where(
                AgentResourceBinding.agent_id == fixture.source_agent_id,
                AgentResourceBinding.resource_id == fixture.source_base_id,
            )
        ).one()
        shared = db.exec(select(KnowledgeBase).where(KnowledgeBase.mode == "shared")).all()

        assert branch.status == "active"
        assert binding.status == "active"
        assert shared == []
        # 失败必须整体回滚：源库行也不能被提前标记为下线（savepoint 保证）。
        assert db.get(KnowledgeBase, fixture.source_base_id).status == "active"


def test_asset_count_mismatch_rolls_back_conversion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """任一资产类型少于来源时，转换不得发布或归档来源。"""
    module = conversion_module
    original_clone = module.clone_knowledge_version_assets

    def drop_one_chunk(*args, **kwargs):
        """先真实复制，再删除一个目标 chunk 以触发数量校验。"""
        bound = inspect.signature(original_clone).bind(*args, **kwargs)
        original_clone(*args, **kwargs)
        db = bound.arguments["db"]
        target_base_id = bound.arguments["target_knowledge_base_id"]
        target_version_id = bound.arguments["target_version_id"]
        chunk = db.exec(
            select(KnowledgeChunk).where(
                KnowledgeChunk.knowledge_base_id == target_base_id,
                KnowledgeChunk.knowledge_base_version_id == target_version_id,
            )
        ).one()
        db.delete(chunk)
        db.flush()

    monkeypatch.setattr(module, "clone_knowledge_version_assets", drop_one_chunk)
    with _session() as db:
        fixture = _seed_dedicated_lineage(db)
        with pytest.raises(module.KnowledgeConversionValidationError, match="asset counts"):
            module.KnowledgeConversionService(db).convert_to_shared(
                tenant_id="tenant_demo",
                source_knowledge_base_id=fixture.source_base_id,
                source_agent_id=fixture.source_agent_id,
                name="数量不一致的共享知识",
                change_reason="验证资产数量",
                actor_user_id="user-admin",
            )

        branch = db.exec(
            select(AgentKnowledgeBranch).where(
                AgentKnowledgeBranch.agent_id == fixture.source_agent_id,
                AgentKnowledgeBranch.knowledge_base_id == fixture.source_base_id,
            )
        ).one()
        assert branch.status == "active"
        assert db.exec(select(KnowledgeBase).where(KnowledgeBase.mode == "shared")).all() == []
        assert db.get(KnowledgeBase, fixture.source_base_id).status == "active"


def test_audit_event_failure_after_archive_write_rolls_back_conversion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`source_base.status = "archived"` 写入之后、savepoint 退出之前失败也要整体回滚。

    前面两个失败用例都在克隆/校验阶段触发，从未真正执行到归档语句，没能证明
    `begin_nested()` 覆盖了归档写入本身。这里把失败点挪到归档之后（审计事件写入），
    验证源库状态、来源分支和共享谱系依旧被完整回滚，并且会话在异常后仍可正常复用
    （重试同一笔转换应当成功）。
    """
    module = conversion_module
    with _session() as db:
        fixture = _seed_dedicated_lineage(db)
        service = module.KnowledgeConversionService(db)
        original_append_event = service.audit.append_event

        def fail_append_event(*args, **kwargs):
            """模拟归档写入之后、savepoint 退出前发生的失败（例如审计落库异常）。"""
            raise RuntimeError("injected audit failure")

        monkeypatch.setattr(service.audit, "append_event", fail_append_event)

        with pytest.raises(RuntimeError, match="injected audit failure"):
            service.convert_to_shared(
                tenant_id="tenant_demo",
                source_knowledge_base_id=fixture.source_base_id,
                source_agent_id=fixture.source_agent_id,
                name="审计失败的共享知识",
                change_reason="验证归档后失败回滚",
                actor_user_id="user-admin",
            )

        assert db.get(KnowledgeBase, fixture.source_base_id).status == "active"
        branch = db.exec(
            select(AgentKnowledgeBranch).where(
                AgentKnowledgeBranch.agent_id == fixture.source_agent_id,
                AgentKnowledgeBranch.knowledge_base_id == fixture.source_base_id,
            )
        ).one()
        assert branch.status == "active"
        assert db.exec(select(KnowledgeBase).where(KnowledgeBase.mode == "shared")).all() == []

        # 会话在异常后依旧可用：撤掉失败注入，同一个 session 上重试应当成功。
        monkeypatch.setattr(service.audit, "append_event", original_append_event)
        result = service.convert_to_shared(
            tenant_id="tenant_demo",
            source_knowledge_base_id=fixture.source_base_id,
            source_agent_id=fixture.source_agent_id,
            name="重试成功的共享知识",
            change_reason="验证会话重试可用",
            actor_user_id="user-admin",
        )
        db.commit()

        assert db.get(KnowledgeBase, fixture.source_base_id).status == "archived"
        assert db.get(KnowledgeBase, result.shared_knowledge_base_id) is not None


def test_conversion_endpoint_returns_shared_base_release_and_archival_projection() -> None:
    """管理端点返回新共享库、首个正式版、绑定和来源归档状态。"""
    with _session() as db:
        fixture = _seed_dedicated_lineage(db)
        response = knowledge_bases_api.convert_knowledge_base_to_shared(
            fixture.source_base_id,
            KnowledgeBaseConvertToSharedRequest(
                tenant_id="tenant_demo",
                agent_id=fixture.source_agent_id,
                name="端点转换知识",
                description="由管理端转换",
                change_reason="供团队统一读取",
                team_bindings=[fixture.team_id],
                default_for_team_id=fixture.team_id,
            ),
            db,
            _admin_user(),
        )

        assert response.source_knowledge_base_id == fixture.source_base_id
        assert response.source_version_id == fixture.source_version_id
        assert response.new_knowledge_base.mode == "shared"
        assert response.new_knowledge_base.bound_team_count == 1
        assert response.released_version.is_published_head is True
        assert response.binding_ids
        assert response.default_for_team_id == fixture.team_id
        assert response.source_archived is True
        assert response.audit_event_id


def test_conversion_endpoint_rejects_cross_tenant_team_without_archiving_source() -> None:
    """初始团队跨租户时端点 fail closed，来源专用分支保持活动。"""
    with _session() as db:
        fixture = _seed_dedicated_lineage(db)
        db.add(Tenant(id="tenant_other", name="Other"))
        db.add(
            Team(
                id="team-other",
                tenant_id="tenant_other",
                name="其他团队",
                owner_user_id="other-admin",
            )
        )
        db.commit()

        with pytest.raises(HTTPException) as exc_info:
            knowledge_bases_api.convert_knowledge_base_to_shared(
                fixture.source_base_id,
                KnowledgeBaseConvertToSharedRequest(
                    tenant_id="tenant_demo",
                    agent_id=fixture.source_agent_id,
                    name="不应创建的共享库",
                    change_reason="跨租户验证",
                    team_bindings=["team-other"],
                ),
                db,
                _admin_user(),
            )

        branch = db.exec(
            select(AgentKnowledgeBranch).where(
                AgentKnowledgeBranch.agent_id == fixture.source_agent_id,
                AgentKnowledgeBranch.knowledge_base_id == fixture.source_base_id,
            )
        ).one()
        assert exc_info.value.status_code == 404
        assert branch.status == "active"
        assert db.exec(select(KnowledgeBase).where(KnowledgeBase.mode == "shared")).all() == []
        assert db.get(KnowledgeBase, fixture.source_base_id).status == "active"


def test_conversion_endpoint_rejects_a_bound_shared_base_as_reverse_conversion() -> None:
    """已绑定团队的共享库不能作为专用来源再次执行反向转换。"""
    module = conversion_module
    with _session() as db:
        fixture = _seed_dedicated_lineage(db)
        first = module.KnowledgeConversionService(db).convert_to_shared(
            tenant_id="tenant_demo",
            source_knowledge_base_id=fixture.source_base_id,
            source_agent_id=fixture.source_agent_id,
            name="已绑定共享知识",
            change_reason="首次转换",
            team_ids=[fixture.team_id],
            actor_user_id="user-admin",
        )
        db.commit()

        with pytest.raises(HTTPException) as exc_info:
            knowledge_bases_api.convert_knowledge_base_to_shared(
                first.shared_knowledge_base_id,
                KnowledgeBaseConvertToSharedRequest(
                    tenant_id="tenant_demo",
                    agent_id=fixture.source_agent_id,
                    name="不允许的反向转换",
                    change_reason="验证共享模式不可逆",
                ),
                db,
                _admin_user(),
            )

        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["code"] == "KNOWLEDGE_MODE_INVALID"


def test_archived_source_base_rejects_employee_document_upload() -> None:
    """FR-082 落地验证：转换后旧的 `knowledge_base_id`（书签/缓存）写入统一 404。

    A1/A1b 已经通过 `effective_knowledge_base_status` 把源库显示成"已下线"（T077 缺陷
    D），但员工侧写路径（`app.api.knowledge.upload_document` →
    `_resolve_upload_knowledge_base`）读的是 `KnowledgeBase.status` 原始列，不经过那层
    派生。源库行不落 `archived` 时，这道闸形同虚设，仍会放行写入。
    """
    import base64

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.knowledge import router as knowledge_router
    from app.db import get_session
    from app.security.auth import get_current_user

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        fixture = _seed_dedicated_lineage(db)
        conversion_module.KnowledgeConversionService(db).convert_to_shared(
            tenant_id="tenant_demo",
            source_knowledge_base_id=fixture.source_base_id,
            source_agent_id=fixture.source_agent_id,
            name="端点归档验证共享知识",
            change_reason="验证员工写路径统一 404",
            team_ids=[fixture.team_id],
            actor_user_id="user-admin",
        )
        db.commit()
        assert db.get(KnowledgeBase, fixture.source_base_id).status == "archived"

    app = FastAPI()
    app.include_router(knowledge_router)

    def override_get_session():
        with Session(engine) as request_db:
            yield request_db

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = _admin_user
    client = TestClient(app)

    response = client.post(
        "/api/enterprise/knowledge/documents",
        json={
            "tenant_id": "tenant_demo",
            "knowledge_base_id": fixture.source_base_id,
            "filename": "late-upload.md",
            "content_base64": base64.b64encode(b"late content").decode("ascii"),
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "KNOWLEDGE_BASE_NOT_FOUND"
