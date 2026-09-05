"""T077 缺陷 A：上传入库的文档必须带 `metadata_json.raw_text`，对比与变基才有真实基线。

缺陷现象：`KnowledgeService._run_ingest_job` 建文档时只写 `section_tree`/`document_card`，
不写 `raw_text`；而 A2 对比与变基三路合并共用的 `diff.py::_document_text` 只认 `raw_text`。
于是任何"只上传过、没在线编辑过"的文档在首次对比时基线为空——整篇被判成新增（全绿），
变基更会因为两侧 hunk 都落在同一个零宽区间 `[0, 0)` 而不判交叠，把双方正文首尾相接拼在
一起当作"合并结果"，既不报冲突也不给管理员解决的机会。

本文件按 HTTP 端到端链路覆盖三条断言：

1. 走真实上传端点入库、随后首次在线编辑的文档，A2 对比是带红/绿双侧的 `modified`，
   而不是整篇全绿的 `added`；
2. 上传（未在线编辑）的文档被两个草稿分别改成互相矛盾的内容后，变基必须报冲突，
   而不是静默拼接；
3. 历史数据（只有 `section_tree`、没有 `raw_text` 的旧行）按大纲节点重建正文参与对比。

链路通过 `fastapi.testclient.TestClient` 驱动，验证阶段一律用独立 `Session(engine)` 读取，
理由与 `test_knowledge_rebase_flow.py` 顶部说明一致。入库作业本身不走后台线程队列：
`enqueue_async_job` 会用全局 engine 另开会话，测试里改为显式在测试 engine 上跑同一个
`_run_ingest_job`，被测代码路径完全一致。
"""

from __future__ import annotations

import base64
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.api import knowledge as knowledge_api
from app.api.knowledge import router as knowledge_router
from app.api.knowledge_admin import router as knowledge_admin_router
from app.api.knowledge_bases import router as knowledge_bases_router
from app.db import get_session
from app.db.models import (
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Team,
    TeamKnowledgeBaseBinding,
    Tenant,
    User,
)
from app.knowledge.diff import _document_text
from app.knowledge.service import KnowledgeService
from app.security.auth import get_current_user

BASE_ID = "kb_ingest_raw_text"
V1_ID = "kbver_ingest_v1"
UPLOAD_TEXT = "# 退款政策\n\n开箱七天内可无理由退货。\n\n运费由买家承担。"


def _admin_user() -> User:
    return User(
        id="user_admin", tenant_id="tenant_demo", username="admin", role="admin", password_hash="x"
    )


def _engine() -> Any:
    """隔离的内存 SQLite engine，建好全部表。"""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _http_client_for(engine: Any) -> TestClient:
    """挂上共享库、知识管理端与文档端三个路由，会话与当前用户按测试 engine 覆盖。"""
    app = FastAPI()
    app.include_router(knowledge_bases_router)
    app.include_router(knowledge_admin_router)
    app.include_router(knowledge_router)

    def override_get_session():
        with Session(engine) as request_db:
            yield request_db

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = lambda: _admin_user()
    return TestClient(app)


def _seed_shared_base(engine: Any) -> None:
    """一个已发布 v1.0.0（暂无文档）的共享库，外加一个可作为写入上下文的团队绑定。"""
    with Session(engine) as db:
        db.add(Tenant(id="tenant_demo", slug="tenant-demo", name="Demo", lifecycle_version=1))
        version = KnowledgeBaseVersion(
            id=V1_ID,
            tenant_id="tenant_demo",
            knowledge_base_id=BASE_ID,
            version="1.0.0",
            name="共享知识库",
            publication_state="released",
        )
        db.add(version)
        db.add(
            KnowledgeBase(
                id=BASE_ID,
                tenant_id="tenant_demo",
                name="共享知识库",
                mode="shared",
                status="active",
                published_version_id=V1_ID,
            )
        )
        db.add(
            Team(
                id="team_content",
                tenant_id="tenant_demo",
                name="内容团队",
                owner_user_id="user_admin",
            )
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


def _upload_into_version(
    client: TestClient, engine: Any, *, version_id: str, filename: str, text: str
) -> str:
    """走真实上传端点建入库作业，再在测试 engine 上同步执行该作业，返回新文档 id。

    上传端点把入库丢进后台线程队列（`enqueue_async_job`），那条路径会用全局 engine 开新
    会话、读不到测试库；这里由测试显式调用同一个 `_run_ingest_job`，被测的建文档代码路径
    与线上完全一致。
    """
    response = client.post(
        "/api/enterprise/knowledge/documents",
        json={
            "tenant_id": "tenant_demo",
            "knowledge_base_id": BASE_ID,
            "knowledge_base_version_id": version_id,
            "filename": filename,
            "content_base64": base64.b64encode(text.encode("utf-8")).decode("ascii"),
        },
    )
    assert response.status_code == 200, response.text
    job_id = response.json()["id"]
    with Session(engine) as ingest_db:
        # 直接调私有实现：这正是被测的建文档代码路径，线上由后台队列的 run_ingest_job 调它。
        KnowledgeService(ingest_db)._run_ingest_job(job_id)
    with Session(engine) as verify_db:
        job_document_id = verify_db.exec(
            select(KnowledgeDocument.id).where(
                KnowledgeDocument.knowledge_base_version_id == version_id,
                KnowledgeDocument.filename == filename,
            )
        ).one()
    return job_document_id


@pytest.fixture(autouse=True)
def _inline_ingest_queue(monkeypatch: pytest.MonkeyPatch) -> None:
    """禁掉后台队列：入库由测试在测试 engine 上显式驱动，避免线程去动全局库。"""
    monkeypatch.setattr(knowledge_api, "enqueue_async_job", lambda *args, **kwargs: None)


def _create_draft(client: TestClient, *, reason: str, expected_published_version_id: str) -> str:
    """基于给定正式版建一份共享草稿，返回草稿版本 id。"""
    response = client.post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/drafts",
        json={
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": reason,
            "expected_published_version_id": expected_published_version_id,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _publish(client: TestClient, *, draft_id: str, expected_published_version_id: str) -> str:
    """发布草稿并返回新正式版 id。"""
    response = client.post(
        f"/api/enterprise/knowledge-bases/{BASE_ID}/versions/{draft_id}/publish",
        json={
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "expected_published_version_id": expected_published_version_id,
            "change_reason": "发布",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _diff(client: TestClient, version_id: str) -> dict[str, Any]:
    """取该版本相对其父版本的 A2 对比结果。"""
    response = client.get(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}/versions/{version_id}/diff",
        params={"tenant_id": "tenant_demo", "against": "base"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _document_in_version(client: TestClient, version_id: str, filename: str) -> dict[str, Any]:
    """在 A2b 文档列表里按文件名取一行，用于拿到该版本内的真实行 id。"""
    response = client.get(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}/versions/{version_id}/documents",
        params={"tenant_id": "tenant_demo"},
    )
    assert response.status_code == 200, response.text
    return next(item for item in response.json() if item["filename"] == filename)


def test_first_edit_of_uploaded_document_diffs_as_modified_with_removed_lines() -> None:
    """只上传过、首次在线编辑的文档，对比应是带红/绿双侧的 `modified`，不是整篇全绿。

    缺陷未修时上传行没有 `raw_text`，基线正文为空，这一篇会被判成 `added`（前端全绿显示），
    完全看不出改了哪一行。
    """
    engine = _engine()
    _seed_shared_base(engine)
    client = _http_client_for(engine)

    # 上传后立刻发布为 v1.0.1，让这篇文档成为"从未在线编辑过"的正式基线。
    seed_draft = _create_draft(client, reason="上传基线文档", expected_published_version_id=V1_ID)
    document_id = _upload_into_version(
        client, engine, version_id=seed_draft, filename="refund.md", text=UPLOAD_TEXT
    )

    # 入库即写 raw_text，与在线编辑写回同一个键、同一套归一化。
    with Session(engine) as verify_db:
        stored = verify_db.get(KnowledgeDocument, document_id)
        assert stored is not None
        assert (stored.metadata_json or {}).get("raw_text") == UPLOAD_TEXT

    baseline_id = _publish(client, draft_id=seed_draft, expected_published_version_id=V1_ID)

    draft_id = _create_draft(client, reason="首次编辑", expected_published_version_id=baseline_id)
    row = _document_in_version(client, draft_id, "refund.md")
    edit_response = client.put(
        f"/api/enterprise/knowledge/documents/{row['id']}",
        json={"tenant_id": "tenant_demo", "content_md": UPLOAD_TEXT.replace("七天", "十四天")},
    )
    assert edit_response.status_code == 200, edit_response.text

    diff = _diff(client, draft_id)
    assert diff["summary"] == {"added": 0, "modified": 1, "deleted": 0}
    entry = diff["documents"][0]
    change_hunks = [hunk for hunk in entry["hunks"] if hunk["type"] == "change"]
    assert len(change_hunks) == 1, "只改了一行，应只有一个变更块"
    assert change_hunks[0]["base_lines"] == ["开箱七天内可无理由退货。"]
    assert change_hunks[0]["target_lines"] == ["开箱十四天内可无理由退货。"]
    assert change_hunks[0]["pairs"], "同一行的改写应配对，供前端做字符级高亮"
    # 未改动的行仍以 equal 块出现在两侧，证明基线不是空正文。
    equal_lines = [
        line for hunk in entry["hunks"] if hunk["type"] == "equal" for line in hunk["base_lines"]
    ]
    assert "# 退款政策" in equal_lines


def test_rebase_over_uploaded_document_raises_conflict_instead_of_concatenating() -> None:
    """两个草稿改同一篇"只上传过"的文档时，变基必须报冲突而不是把两侧正文拼起来。"""
    engine = _engine()
    _seed_shared_base(engine)
    client = _http_client_for(engine)

    # 先把上传的文档发布进正式版 v1.0.1，作为后续两个草稿共同的基线。
    seed_draft = _create_draft(client, reason="上传基线文档", expected_published_version_id=V1_ID)
    _upload_into_version(
        client, engine, version_id=seed_draft, filename="refund.md", text=UPLOAD_TEXT
    )
    baseline_id = _publish(client, draft_id=seed_draft, expected_published_version_id=V1_ID)

    draft_a = _create_draft(client, reason="A 改退货天数", expected_published_version_id=baseline_id)
    draft_b = _create_draft(client, reason="B 改退货天数", expected_published_version_id=baseline_id)

    def _edit(version_id: str, text: str) -> None:
        row = _document_in_version(client, version_id, "refund.md")
        response = client.put(
            f"/api/enterprise/knowledge/documents/{row['id']}",
            json={"tenant_id": "tenant_demo", "content_md": text},
        )
        assert response.status_code == 200, response.text

    _edit(draft_a, UPLOAD_TEXT.replace("七天", "十四天"))
    published_a = _publish(client, draft_id=draft_a, expected_published_version_id=baseline_id)

    _edit(draft_b, UPLOAD_TEXT.replace("七天", "三十天"))

    preview = client.post(
        f"/api/enterprise/knowledge-admin/knowledge-bases/{BASE_ID}/versions/{draft_b}/rebase",
        json={
            "tenant_id": "tenant_demo",
            "team_id": "team_content",
            "change_reason": "B 变基",
        },
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["status"] == "conflicts", "改同一行必须报冲突，不能静默落库"
    assert body["to_base_version_id"] == published_a
    assert len(body["conflicts"]) == 1
    blocks = body["conflicts"][0]["blocks"]
    assert blocks and blocks[0]["ours_lines"] and blocks[0]["theirs_lines"]

    # 草稿正文没有被"合并"改写，更没有出现两侧正文首尾相接的拼接结果。
    with Session(engine) as verify_db:
        row = verify_db.exec(
            select(KnowledgeDocument).where(
                KnowledgeDocument.knowledge_base_version_id == draft_b,
                KnowledgeDocument.filename == "refund.md",
            )
        ).one()
        content = (row.metadata_json or {}).get("raw_text", "")
        assert content.count("# 退款政策") == 1
        assert "十四天" not in content


def test_legacy_document_without_raw_text_diffs_from_section_tree() -> None:
    """历史行只有 `section_tree` 时，正文按大纲节点重建，不再被当成空正文。"""
    legacy = KnowledgeDocument(
        id="kdoc_legacy",
        tenant_id="tenant_demo",
        knowledge_base_id=BASE_ID,
        knowledge_base_version_id=V1_ID,
        filename="legacy.md",
        file_type="md",
        title="历史文档",
        status="ready",
        metadata_json={
            "lineage_id": "L_LEGACY",
            "section_tree": [
                {"section_id": "sec_1", "title": "退款政策", "content": "# 退款政策\n\n七天无理由。"},
                {"section_id": "sec_2", "title": "运费", "summary": "运费由买家承担。"},
            ],
        },
    )
    assert _document_text(legacy) == (
        "# 退款政策\n\n七天无理由。\n\n## 运费\n\n运费由买家承担。"
    )


def test_document_without_any_text_source_is_empty_not_fabricated() -> None:
    """三路都取不到正文时返回空串——对比据此判定"未变"，不会伪造出一次整篇替换。"""
    empty = KnowledgeDocument(
        id="kdoc_empty",
        tenant_id="tenant_demo",
        knowledge_base_id=BASE_ID,
        knowledge_base_version_id=V1_ID,
        filename="empty.md",
        file_type="md",
        title="空文档",
        status="ready",
        metadata_json={"lineage_id": "L_EMPTY", "section_tree": "not-a-list"},
    )
    assert _document_text(empty) == ""
