"""T057：变基端到端流程（HTTP 路由级），覆盖 US3 Independent Test 的完整链路。

草稿 A、B 都基于 v1.0.0；A 只改文档甲并先发布（→ v1.0.1）；B 改文档甲和乙，此时发布
被拒（`KNOWLEDGE_BASELINE_STALE`，`conflict_count == 1`，仅甲交叠）；对 B 调用变基预览
（A3）得到甲冲突、乙自动合并；解决甲的冲突并调用 resolve（A4）完成变基（草稿名不变、
基线更新为 v1.0.1）；再次发布该草稿成功获得 v1.0.2，正式版内容同时包含 A 对甲的改动与
B 保留的改动；全链路审计（`draft_created` x2、`version_published` x2、`draft_rebased`）
与 `knowledge.version.published` 事件完整。

修复轮次 1：整条链路（建草稿 → 发布 → stale 拒绝 → A3 预览 → A4 resolve → 再发布）
必须通过真实 HTTP 请求（`fastapi.testclient.TestClient`）驱动，而不是直接调用路由函数——
后者会绕过 FastAPI 的请求/响应序列化、依赖注入与真实的会话生命周期边界，掩盖跨请求持久化
问题（参见 `test_knowledge_rebase.py` 中"修复轮次 1"一节的说明）。这里复用该文件已验证过的
`_http_client_for` 写法：独立 sqlite 引擎 + `get_session` 覆盖为每请求一个新 `Session(engine)`、
`get_current_user` 覆盖为租户管理员；处理请求的会话由路由自己 `db.commit()`，测试验证阶段
一律使用另一个独立会话读取，不依赖测试自身提交或路由内部会话对象。

编辑草稿文档正文（`_set_document_text`）不在 T057 要求转换的四个端点（建草稿/发布/A3/A4）
范围内——目前没有对应的公开 HTTP 端点，因此保留为直接 DB 写入，只是改为通过独立 `Session
(engine)` 完成，与被测路由的请求会话互不干扰。

本文件与 `test_knowledge_rebase.py` 的分工：后者逐个覆盖变基/发布各步骤的边界与鉴权
（非 stale 拒绝、残留冲突标记、to_base 又变化、team owner 与非 owner 等），偏单元/集成
颗粒度；本文件只跑一条完整链路，验证各步骤真实串联时的最终产物（发布后的版本号与正式版
文档内容、完整审计链），不重复覆盖前者已验证的边界分支。
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
    AgentEvent,
    KnowledgeBase,
    KnowledgeBaseAuditEvent,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    Tenant,
    User,
)
from app.knowledge.errors import KNOWLEDGE_BASELINE_STALE
from app.security.auth import get_current_user

BASE_ID = "kb_rebase_flow"
V1_ID = "kbver_v1"


def _admin_user() -> User:
    return User(
        id="user_admin", tenant_id="tenant_demo", username="admin", role="admin", password_hash="x"
    )


def _http_client_for(engine: Any) -> TestClient:
    app = FastAPI()
    app.include_router(knowledge_bases_router)
    app.include_router(knowledge_admin_router)

    def override_get_session():
        with Session(engine) as request_db:
            yield request_db

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = lambda: _admin_user()
    return TestClient(app)


def _seed_base(engine: Any) -> None:
    """v1.0.0（已发布）含文档甲、乙，绑定一个团队。"""
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", slug="tenant-demo", name="Demo", lifecycle_version=1))
        v1 = KnowledgeBaseVersion(
            id=V1_ID,
            tenant_id="tenant_demo",
            knowledge_base_id=BASE_ID,
            version="1.0.0",
            name="共享知识库",
            publication_state="released",
        )
        base = KnowledgeBase(
            id=BASE_ID,
            tenant_id="tenant_demo",
            name="共享知识库",
            mode="shared",
            status="active",
            published_version_id=v1.id,
        )
        db.add(base)
        db.add(v1)
        db.add(
            KnowledgeDocument(
                id="kdoc_v1_jia",
                tenant_id="tenant_demo",
                knowledge_base_id=BASE_ID,
                knowledge_base_version_id=V1_ID,
                filename="jia.md",
                file_type="md",
                title="文档甲",
                status="ready",
                metadata_json={"lineage_id": "L_JIA", "raw_text": "原文第一行\n原文第二行"},
            )
        )
        db.add(
            KnowledgeDocument(
                id="kdoc_v1_yi",
                tenant_id="tenant_demo",
                knowledge_base_id=BASE_ID,
                knowledge_base_version_id=V1_ID,
                filename="yi.md",
                file_type="md",
                title="文档乙",
                status="ready",
                metadata_json={"lineage_id": "L_YI", "raw_text": "乙原文"},
            )
        )
        db.add(
            Team(id="team_content", tenant_id="tenant_demo", name="内容团队", owner_user_id="user_admin")
        )
        db.add(
            TeamKnowledgeBaseBinding(
                id="teamkb_content",
                tenant_id="tenant_demo",
                team_id="team_content",
                knowledge_base_id=BASE_ID,
                status="active",
                created_by_user_id="user_admin",
            )
        )
        db.commit()


def _set_document_text(engine: Any, *, version_id: str, lineage_id: str, text: str) -> None:
    with Session(engine) as db:
        rows = db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.tenant_id == "tenant_demo",
                KnowledgeDocument.knowledge_base_version_id == version_id,
            )
        ).all()
        target = next(doc for doc in rows if (doc.metadata_json or {}).get("lineage_id") == lineage_id)
        metadata = dict(target.metadata_json or {})
        metadata["raw_text"] = text
        target.metadata_json = metadata
        db.add(target)
        db.commit()


def _document_text(engine: Any, *, version_id: str, lineage_id: str) -> str:
    with Session(engine) as db:
        rows = db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.tenant_id == "tenant_demo",
                KnowledgeDocument.knowledge_base_version_id == version_id,
            )
        ).all()
        target = next(doc for doc in rows if (doc.metadata_json or {}).get("lineage_id") == lineage_id)
        return (target.metadata_json or {}).get("raw_text", "")


def test_two_drafts_concurrent_edit_rebase_resolve_and_publish_end_to_end_over_http() -> None:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    _seed_base(engine)
    client = _http_client_for(engine)

    def _post(path: str, json: dict[str, Any]) -> dict[str, Any]:
        response = client.post(path, json=json)
        assert response.status_code == 200, response.text
        return response.json()

    # 草稿 A、B 都基于 v1.0.0。
    draft_a = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/drafts",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "A 分支：改甲",
            "expected_published_version_id": V1_ID,
        },
    )
    draft_b = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/drafts",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "B 分支：改甲、乙",
            "expected_published_version_id": V1_ID,
        },
    )
    draft_a_id = draft_a["id"]
    draft_b_id = draft_b["id"]
    draft_b_original_name = draft_b["draft_name"]

    # A 只改文档甲。
    _set_document_text(
        engine, version_id=draft_a_id, lineage_id="L_JIA", text="原文第一行-A改\n原文第二行"
    )

    # A 先发布 → v1.0.1。
    published_a = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/versions/{draft_a_id}/publish",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "expected_published_version_id": V1_ID,
            "change_reason": "发布 A 分支",
        },
    )
    assert published_a["version"] == "1.0.1"
    published_a_id = published_a["id"]

    # B 改文档甲（与 A 交叠同一行）和乙（B 独占）。
    _set_document_text(
        engine, version_id=draft_b_id, lineage_id="L_JIA", text="原文第一行-B改\n原文第二行"
    )
    _set_document_text(engine, version_id=draft_b_id, lineage_id="L_YI", text="乙原文-B改")

    # 此时 B 的基线（v1.0.0）已落后于正式版（v1.0.1）：发布应被拒绝并提示需要变基。
    # 断言真实的 HTTP 状态码与响应体 `detail`（领域 `KnowledgeError` 经路由映射为
    # `HTTPException` 后的公开错误载荷），而不是绕过路由直接捕获异常。
    stale_response = client.post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/versions/{draft_b_id}/publish",
        json={
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "expected_published_version_id": published_a_id,
            "change_reason": "尝试直接发布 B 分支",
        },
    )
    assert stale_response.status_code == 409
    detail = stale_response.json()["detail"]
    assert detail["code"] == KNOWLEDGE_BASELINE_STALE
    assert detail["params"]["base_version"] == "1.0.0"
    assert detail["params"]["published_version"] == "1.0.1"
    assert detail["params"]["conflict_count"] == 1  # 仅甲交叠，乙可自动合并

    # A3：变基预览——甲冲突、乙可自动合并；不落库。
    preview = _post(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}/versions/{draft_b_id}/rebase",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "B 变基到 v1.0.1",
        },
    )
    assert preview["status"] == "conflicts", "无冲突时不应直接返回落库结果"
    assert [item["lineage_id"] for item in preview["conflicts"]] == ["L_JIA"]
    assert [item["lineage_id"] for item in preview["auto_merged"]] == ["L_YI"]
    assert preview["to_base_version_id"] == published_a_id
    conflict_blocks = preview["conflicts"][0]["blocks"]
    assert conflict_blocks, "冲突文档应带回可展示的交叠块"
    assert conflict_blocks[0]["ours_lines"] and conflict_blocks[0]["theirs_lines"]

    # A4：解决甲的冲突（保留双方改动），完成变基。
    rebase_result = _post(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}/versions/{draft_b_id}/rebase/resolve",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "解决甲冲突并完成变基",
            "to_base_version_id": preview["to_base_version_id"],
            "resolutions": [
                {"lineage_id": "L_JIA", "content_md": "原文第一行-A改-B改\n原文第二行"}
            ],
        },
    )
    rebased_draft = rebase_result["new_version"]
    rebased_draft_id = rebased_draft["id"]
    assert rebased_draft["draft_name"] == draft_b_original_name  # 草稿名保留
    assert rebased_draft["parent_version_id"] == published_a_id  # 基线更新
    assert rebased_draft["publication_state"] == "draft"
    assert rebase_result["superseded_version_id"] == draft_b_id

    # 变基后立即发布不应再被 stale 拒绝，并获得下一个版本号 v1.0.2。
    published_b = _post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/versions/{rebased_draft_id}/publish",
        {
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "expected_published_version_id": published_a_id,
            "change_reason": "发布变基后的 B 分支",
        },
    )
    assert published_b["version"] == "1.0.2"
    published_b_id = published_b["id"]

    # 正式版内容：甲同时含 A、B 的改动；乙为 B 保留的改动。独立验证会话读取，
    # 不依赖处理请求的会话或测试自身提交。
    assert _document_text(engine, version_id=published_b_id, lineage_id="L_JIA") == (
        "原文第一行-A改-B改\n原文第二行"
    )
    assert _document_text(engine, version_id=published_b_id, lineage_id="L_YI") == "乙原文-B改"

    # 审计链完整：两次草稿创建、两次发布、一次变基，且每条都挂在正确的版本上
    # （不依赖时间戳/id 排序——同一事务内多条记录的 created_at 可能相同，用
    # 「事件与目标版本 id 的对应关系」而不是「时间先后」来证明链路完整更稳健）。
    with Session(engine) as verify_db:
        audit_events = verify_db.exec(
            select(KnowledgeBaseAuditEvent).where(
                KnowledgeBaseAuditEvent.knowledge_base_id == BASE_ID
            )
        ).all()
        actions = [row.action for row in audit_events]
        assert actions.count("draft_created") == 2
        assert actions.count("version_published") == 2
        assert actions.count("draft_rebased") == 1

        events_by_version: dict[str, list[str]] = {}
        for row in audit_events:
            events_by_version.setdefault(row.knowledge_base_version_id, []).append(row.action)
        # 发布是原地状态迁移（同一行 draft -> released），所以 published_a_id ==
        # draft_a_id、published_b_id == rebased_draft_id；每个版本 id 上应能看到它
        # 依次经历的全部事件。
        assert published_a_id == draft_a_id
        assert published_b_id == rebased_draft_id
        assert events_by_version[draft_a_id] == ["draft_created", "version_published"]
        assert events_by_version[draft_b_id] == ["draft_created"]  # B 的原始草稿被变基替换，未被直接发布
        assert events_by_version[rebased_draft_id] == ["draft_rebased", "version_published"]

        published_events = verify_db.exec(
            select(AgentEvent).where(AgentEvent.event_type == "knowledge.version.published")
        ).all()
        assert {event.payload_json["params"]["version"] for event in published_events} == {
            "1.0.1",
            "1.0.2",
        }
