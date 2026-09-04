"""T079：性能验证（SC-007）。

对 A1 租户级知识库列表端点与 A2 版本对比（diff）端点做真实 HTTP 往返的性能断言，
复用 `test_knowledge_rebase.py` 的 `_http_client_for` TestClient 模式（挂载
`knowledge_admin_router`，覆盖 `get_session`/`get_current_user` 依赖）而非直接调用
路由函数，以便把序列化、依赖注入等端到端开销也计入测量。

- A1：200 个共享知识库（每库 1 个 released 版本 + 3 篇文档）fixture，用批量
  `db.add_all` + 单次 `commit()` 构造（避免逐行 `session.add()` 提交拖慢测试本身），
  对列表端点发起 ≥20 次请求，取 p95 断言 ≤ 2s（SC-007）。
- A2：1 篇 2000 行、约 10%（200 行）行变动的文档，对 diff 端点发起单次请求，断言
  ≤ 1s（SC-007）。

用 `pytest.mark.perf` 标记（已在 `backend/pyproject.toml` 的
`[tool.pytest.ini_options].markers` 注册），默认不在 CI 跳过；数值表与机器负载说明
见 `.superpowers/sdd/tasks/task-T079-report.md`。
"""

from __future__ import annotations

import math
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.api.knowledge_admin import router as knowledge_admin_router
from app.db import get_session
from app.db.models import (
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeDocument,
    Tenant,
    User,
)
from app.security.auth import get_current_user

TENANT_ID = "tenant_perf"
LIST_BASE_COUNT = 200
LIST_DOCS_PER_BASE = 3
LIST_REQUEST_COUNT = 25  # >= 20，符合契约要求

DIFF_TOTAL_LINES = 2000
DIFF_CHANGED_EVERY = 10  # 每 10 行改动 1 行 → 约 10% 行变动（200/2000）

# SC-007 硬性阈值。测量基线（见 task-T079-report.md）在正常负载下明显低于这两个
# 数字，留有充足余量以避免较慢/繁忙的 CI 机器上出现临界抖动导致的假阳性失败；
# 阈值本身仍取自 spec 原文，未达标视为阻塞。
LIST_P95_THRESHOLD_SECONDS = 2.0
DIFF_THRESHOLD_SECONDS = 1.0

KNOWLEDGE_BASES_PATH = "/api/enterprise/knowledge-admin/knowledge-bases"


def _admin_user() -> User:
    return User(
        id="user_admin", tenant_id=TENANT_ID, username="admin", role="admin", password_hash="x"
    )


def _http_client_for(engine) -> TestClient:
    """与 test_knowledge_rebase.py 相同的模式：挂载路由，覆盖 session/current_user 依赖。"""
    app = FastAPI()
    app.include_router(knowledge_admin_router)

    def override_get_session():
        with Session(engine) as request_db:
            yield request_db

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_current_user] = lambda: _admin_user()
    return TestClient(app)


def _new_engine():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _p95(samples: list[float]) -> float:
    """最近秩（nearest-rank）法计算 p95：排序后取第 ceil(0.95*N) 个（1-based）。"""
    ordered = sorted(samples)
    rank = max(1, math.ceil(0.95 * len(ordered)))
    return ordered[rank - 1]


def _seed_list_fixture(engine) -> None:
    """200 个共享知识库，每库 1 个 released 版本 + 3 篇文档；批量 add_all + 单次 commit。"""
    bases: list[KnowledgeBase] = []
    versions: list[KnowledgeBaseVersion] = []
    documents: list[KnowledgeDocument] = []
    for i in range(LIST_BASE_COUNT):
        kb_id = f"kb_perf_{i}"
        version_id = f"kbver_perf_{i}"
        bases.append(
            KnowledgeBase(
                id=kb_id,
                tenant_id=TENANT_ID,
                name=f"性能知识库 {i}",
                mode="shared",
                status="active",
                published_version_id=version_id,
            )
        )
        versions.append(
            KnowledgeBaseVersion(
                id=version_id,
                tenant_id=TENANT_ID,
                knowledge_base_id=kb_id,
                version="1.0.0",
                name=f"性能知识库 {i}",
                publication_state="released",
            )
        )
        for d in range(LIST_DOCS_PER_BASE):
            documents.append(
                KnowledgeDocument(
                    id=f"kdoc_perf_{i}_{d}",
                    tenant_id=TENANT_ID,
                    knowledge_base_id=kb_id,
                    knowledge_base_version_id=version_id,
                    filename=f"doc_{i}_{d}.md",
                    file_type="md",
                    status="ready",
                )
            )

    with Session(engine) as db:
        db.add(Tenant(id=TENANT_ID, name="Perf Tenant"))
        db.add_all(bases)
        db.add_all(versions)
        db.add_all(documents)
        db.commit()


def _build_diff_lines() -> tuple[list[str], list[str]]:
    base_lines = [
        f"line number {i} 性能测试正文内容占位填充文本，用于拉长单行长度模拟真实文档"
        for i in range(DIFF_TOTAL_LINES)
    ]
    target_lines = list(base_lines)
    for i in range(0, DIFF_TOTAL_LINES, DIFF_CHANGED_EVERY):
        target_lines[i] = target_lines[i] + " CHANGED"
    return base_lines, target_lines


def _seed_diff_fixture(engine) -> tuple[str, str]:
    """1 个共享库 + 1 个 released 基线版本 + 1 个 draft 目标版本，各含一篇 2000 行文档
    （同一 lineage_id，target 相对 base 约 10% 行变动）。返回 (kb_id, target_version_id)。
    """
    kb_id = "kb_perf_diff"
    base_version_id = "kbver_perf_diff_base"
    target_version_id = "kbver_perf_diff_target"
    base_lines, target_lines = _build_diff_lines()

    with Session(engine) as db:
        db.add(Tenant(id=TENANT_ID, name="Perf Tenant"))
        db.add(
            KnowledgeBase(
                id=kb_id,
                tenant_id=TENANT_ID,
                name="性能对比知识库",
                mode="shared",
                status="active",
                published_version_id=base_version_id,
            )
        )
        db.add(
            KnowledgeBaseVersion(
                id=base_version_id,
                tenant_id=TENANT_ID,
                knowledge_base_id=kb_id,
                version="1.0.0",
                name="性能对比知识库",
                publication_state="released",
            )
        )
        db.add(
            KnowledgeBaseVersion(
                id=target_version_id,
                tenant_id=TENANT_ID,
                knowledge_base_id=kb_id,
                version="1.1.0",
                name="性能对比知识库",
                publication_state="draft",
                parent_version_id=base_version_id,
            )
        )
        db.add(
            KnowledgeDocument(
                id="kdoc_perf_diff_base",
                tenant_id=TENANT_ID,
                knowledge_base_id=kb_id,
                knowledge_base_version_id=base_version_id,
                filename="big.md",
                file_type="md",
                title="Big",
                status="ready",
                metadata_json={"lineage_id": "L_big", "raw_text": "\n".join(base_lines)},
            )
        )
        db.add(
            KnowledgeDocument(
                id="kdoc_perf_diff_target",
                tenant_id=TENANT_ID,
                knowledge_base_id=kb_id,
                knowledge_base_version_id=target_version_id,
                filename="big.md",
                file_type="md",
                title="Big",
                status="ready",
                metadata_json={"lineage_id": "L_big", "raw_text": "\n".join(target_lines)},
            )
        )
        db.commit()
    return kb_id, target_version_id


@pytest.mark.perf
def test_list_endpoint_p95_latency_under_threshold() -> None:
    """A1：200 库 fixture 下，≥20 次真实 HTTP 请求的 p95 延迟 ≤ 2s（SC-007）。"""
    engine = _new_engine()
    _seed_list_fixture(engine)
    client = _http_client_for(engine)

    # 预热一次（排除首次连接池建立/查询计划等一次性开销），不计入 p95 样本。
    warmup = client.get(KNOWLEDGE_BASES_PATH, params={"tenant_id": TENANT_ID, "limit": 100})
    assert warmup.status_code == 200, warmup.text
    warmup_body = warmup.json()
    assert warmup_body["summary"]["total"] == LIST_BASE_COUNT
    assert warmup_body["summary"]["documents"] == LIST_BASE_COUNT * LIST_DOCS_PER_BASE

    samples: list[float] = []
    for _ in range(LIST_REQUEST_COUNT):
        t0 = time.perf_counter()
        response = client.get(KNOWLEDGE_BASES_PATH, params={"tenant_id": TENANT_ID, "limit": 100})
        t1 = time.perf_counter()
        assert response.status_code == 200, response.text
        samples.append(t1 - t0)

    p95 = _p95(samples)
    assert p95 <= LIST_P95_THRESHOLD_SECONDS, (
        f"A1 list endpoint p95={p95 * 1000:.1f}ms over {len(samples)} requests "
        f"exceeds SC-007 threshold {LIST_P95_THRESHOLD_SECONDS * 1000:.0f}ms; "
        f"samples(ms)={[round(s * 1000, 1) for s in samples]}"
    )


@pytest.mark.perf
def test_diff_endpoint_single_run_under_threshold() -> None:
    """A2：2000 行/约 10% 行变动的文档，单次 diff 请求 ≤ 1s（SC-007）。"""
    engine = _new_engine()
    kb_id, target_version_id = _seed_diff_fixture(engine)
    client = _http_client_for(engine)
    path = f"{KNOWLEDGE_BASES_PATH}/{kb_id}/versions/{target_version_id}/diff"
    params = {"tenant_id": TENANT_ID, "against": "published", "max_lines": 5000}

    # 预热一次，不计入断言的单次计时（避免把首次连接/导入开销算进单次预算）。
    warmup = client.get(path, params=params)
    assert warmup.status_code == 200, warmup.text

    t0 = time.perf_counter()
    response = client.get(path, params=params)
    elapsed = time.perf_counter() - t0

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["summary"]["modified"] == 1
    assert body["summary"]["added"] == 0
    assert body["summary"]["deleted"] == 0
    modified_doc = next(doc for doc in body["documents"] if doc["lineage_id"] == "L_big")
    assert modified_doc["truncated"] is False
    # 200 处孤立的单行改动，每处前后都被未变行隔开 → 200 个 change 块交替 200 个
    # equal 块（含末尾的一段未变行），共 400 个 hunk（equal+change）。
    assert len(modified_doc["hunks"]) == (DIFF_TOTAL_LINES // DIFF_CHANGED_EVERY) * 2

    assert elapsed <= DIFF_THRESHOLD_SECONDS, (
        f"A2 diff endpoint single-run latency={elapsed * 1000:.1f}ms exceeds SC-007 "
        f"threshold {DIFF_THRESHOLD_SECONDS * 1000:.0f}ms"
    )
