from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from test_shared_knowledge_versions import (
    _admin_user,
    _bind_team,
    _create_draft,
    _owner_user,
    _seed_shared_base,
)
from test_teams_api import _test_session

from app.api.knowledge_bases import (
    create_shared_knowledge_draft,
    list_knowledge_base_versions,
    publish_shared_knowledge_version,
    reject_shared_knowledge_version,
)
from app.db.models import KnowledgeBaseVersion
from app.knowledge.errors import KNOWLEDGE_VERSION_LEVEL_INVALID, KnowledgeError
from app.knowledge.schema import (
    SharedKnowledgeDraftCreateRequest,
    SharedKnowledgePublishRequest,
    SharedKnowledgeRejectRequest,
)
from app.knowledge.versioning import SharedKnowledgeVersionService, _draft_version_label


def test_create_draft_names_branch_from_version_id_hex_and_keeps_published_parent() -> None:
    """草稿名取自版本 id 末 4 位十六进制，且基线为当前正式版。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        draft = _create_draft(db, expected_published_version_id=released.id)

    assert draft.version.startswith("draft-")
    suffix = draft.version.removeprefix("draft-")
    assert len(suffix) == 4
    assert all(char in "0123456789abcdef" for char in suffix)
    assert draft.version == f"draft-{draft.id.rsplit('_', 1)[-1][-4:]}"
    assert draft.parent_version_id == released.id
    assert draft.metadata_json["draft_name"] == draft.version
    assert base.mode == "shared"


def test_draft_version_label_lengthens_to_six_then_eight_hex_on_collision() -> None:
    """草稿名与既有标签冲突时依次加长为 6 位、8 位十六进制。"""
    version_id = "kbver_1234567890abcdef"

    assert _draft_version_label(version_id, []) == "draft-cdef"
    assert _draft_version_label(version_id, ["draft-cdef"]) == "draft-abcdef"
    assert (
        _draft_version_label(version_id, ["draft-cdef", "draft-abcdef"])
        == "draft-90abcdef"
    )


def test_publish_draft_assigns_semver_by_level_above_current_max_released() -> None:
    """发布按 patch/minor/major 在现有最高正式版本上递进，默认级别为 patch。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        service = SharedKnowledgeVersionService(db)

        draft_patch = _create_draft(
            db, expected_published_version_id=released.id, reason="补丁修订"
        )
        draft_patch_name = draft_patch.version
        published_patch = service.publish_draft(
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            draft_version_id=draft_patch.id,
            expected_published_version_id=released.id,
            actor_type="user",
            actor_id="user_admin",
            source_team_id="team_content",
            change_reason="默认级别发布",
        )
        db.commit()
        db.refresh(published_patch)
        assert published_patch.version == "1.0.1"
        assert published_patch.metadata_json["version_level"] == "patch"
        assert published_patch.metadata_json["draft_name"] == draft_patch_name
        assert published_patch.metadata_json["published_from_draft"] is True

        draft_minor = _create_draft(
            db, expected_published_version_id=published_patch.id, reason="次版本修订"
        )
        published_minor = service.publish_draft(
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            draft_version_id=draft_minor.id,
            expected_published_version_id=published_patch.id,
            actor_type="user",
            actor_id="user_admin",
            source_team_id="team_content",
            change_reason="次版本发布",
            level="minor",
        )
        db.commit()
        db.refresh(published_minor)
        assert published_minor.version == "1.1.0"

        draft_major = _create_draft(
            db, expected_published_version_id=published_minor.id, reason="主版本修订"
        )
        published_major = service.publish_draft(
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            draft_version_id=draft_major.id,
            expected_published_version_id=published_minor.id,
            actor_type="user",
            actor_id="user_admin",
            source_team_id="team_content",
            change_reason="主版本发布",
            level="major",
        )
        db.commit()
        db.refresh(published_major)
        assert published_major.version == "2.0.0"


def test_publish_draft_rejects_invalid_level() -> None:
    """非法 level 必须映射为稳定的 KNOWLEDGE_VERSION_LEVEL_INVALID 领域错误。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        draft = _create_draft(db, expected_published_version_id=released.id)
        service = SharedKnowledgeVersionService(db)

        with pytest.raises(KnowledgeError) as invalid_level:
            service.publish_draft(
                tenant_id="tenant_demo",
                knowledge_base_id=base.id,
                draft_version_id=draft.id,
                expected_published_version_id=released.id,
                actor_type="user",
                actor_id="user_admin",
                source_team_id="team_content",
                change_reason="非法级别",
                level="urgent",  # type: ignore[arg-type]
            )

    assert invalid_level.value.code == KNOWLEDGE_VERSION_LEVEL_INVALID
    assert invalid_level.value.details == {"level": "urgent"}


def test_publish_route_rejects_invalid_level_as_domain_error_not_422() -> None:
    """发布路由必须让非法 level 打到领域校验，而不是被 Pydantic 折叠成通用 422。

    SharedKnowledgePublishRequest.level 曾经是 Literal["patch","minor","major"]，
    这会让 FastAPI 在请求体校验阶段就拒绝非法值，经全局
    request_validation_error_handler 转成通用 VALIDATION_ERROR（422，
    params.error_count），永远到不了 SharedKnowledgeVersionService.publish_draft
    里的 KNOWLEDGE_VERSION_LEVEL_INVALID（400，params.level）判断。这里改为 str，
    并直接调用路由函数（而非只调用 service）验证契约要求的错误码、状态码与
    params.level 都正确透出。
    """
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        _bind_team(db, base)
        owner = _owner_user()

        draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="待发布",
                expected_published_version_id=released.id,
            ),
            db=db,
            current_user=owner,
        )

        request = SharedKnowledgePublishRequest(
            tenant_id="tenant_demo",
            team_id="team_content",
            expected_published_version_id=released.id,
            change_reason="非法级别",
            level="urgent",
        )
        with pytest.raises(HTTPException) as invalid_level:
            publish_shared_knowledge_version(
                base.id,
                draft.id,
                request,
                db=db,
                current_user=owner,
            )

    assert invalid_level.value.status_code == 400
    assert invalid_level.value.detail["code"] == KNOWLEDGE_VERSION_LEVEL_INVALID
    assert invalid_level.value.detail["params"] == {"level": "urgent"}


def test_reject_draft_keeps_its_branch_name() -> None:
    """驳回草稿不得改写草稿分支名。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        draft = _create_draft(db, expected_published_version_id=released.id)
        original_name = draft.version
        service = SharedKnowledgeVersionService(db)

        rejected = service.reject_draft(
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            draft_version_id=draft.id,
            actor_type="user",
            actor_id="user_admin",
            source_team_id="team_content",
            change_reason="来源不足",
        )

    assert rejected.publication_state == "rejected"
    assert rejected.version == original_name


def test_publish_patch_advances_past_manually_seeded_released_label() -> None:
    """手工数据已占用 1.0.1（released）时，patch 发布直接分配 1.0.2。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        db.add(
            KnowledgeBaseVersion(
                id="kbver_manual_101",
                tenant_id="tenant_demo",
                knowledge_base_id=base.id,
                version="1.0.1",
                name=base.name,
                publication_state="released",
            )
        )
        db.commit()

        draft = _create_draft(db, expected_published_version_id=released.id)
        service = SharedKnowledgeVersionService(db)
        published = service.publish_draft(
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            draft_version_id=draft.id,
            expected_published_version_id=released.id,
            actor_type="user",
            actor_id="user_admin",
            source_team_id="team_content",
            change_reason="跳过手工占用标签",
        )
        db.commit()
        db.refresh(published)

    assert published.version == "1.0.2"


def test_publish_patch_skips_label_occupied_by_non_released_row() -> None:
    """计算出的候选标签被非 released 状态的历史行占用时，须继续按同级递进。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        db.add(
            KnowledgeBaseVersion(
                id="kbver_manual_rejected_101",
                tenant_id="tenant_demo",
                knowledge_base_id=base.id,
                version="1.0.1",
                name=base.name,
                publication_state="rejected",
            )
        )
        db.commit()

        draft = _create_draft(db, expected_published_version_id=released.id)
        service = SharedKnowledgeVersionService(db)
        published = service.publish_draft(
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            draft_version_id=draft.id,
            expected_published_version_id=released.id,
            actor_type="user",
            actor_id="user_admin",
            source_team_id="team_content",
            change_reason="跳过被占用的候选标签",
        )
        db.commit()
        db.refresh(published)

    # 1.0.0 released 是基线；naive patch 候选 1.0.1 已被非 released 行占用，须继续递进到 1.0.2。
    assert published.version == "1.0.2"


def test_version_read_model_reports_baseline_and_next_version_preview_for_draft() -> None:
    """草稿的 API 投影须回显基线标签、来源草稿名与三档下一版本预览。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        _bind_team(db, base)
        owner = _owner_user()

        draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="筹备下一版本",
                expected_published_version_id=released.id,
            ),
            db=db,
            current_user=owner,
        )

    assert draft.version.startswith("draft-")
    assert draft.is_stale is False
    assert draft.base_version == "1.0.0"
    assert draft.draft_name == draft.version
    assert draft.next_version_preview == {
        "patch": "1.0.1",
        "minor": "1.1.0",
        "major": "2.0.0",
    }


def test_version_read_model_flags_stale_draft_after_baseline_moves() -> None:
    """草稿基线落后于最新正式版时，读模型须标记 is_stale 并刷新预览。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        _bind_team(db, base)
        owner = _owner_user()

        stale_draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="并行修改",
                expected_published_version_id=released.id,
            ),
            db=db,
            current_user=owner,
        )
        advancing_draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="先行发布",
                expected_published_version_id=released.id,
            ),
            db=db,
            current_user=owner,
        )
        published = publish_shared_knowledge_version(
            base.id,
            advancing_draft.id,
            SharedKnowledgePublishRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                expected_published_version_id=released.id,
                change_reason="发布领先草稿",
            ),
            db=db,
            current_user=owner,
        )
        assert published.version == "1.0.1"

        versions = list_knowledge_base_versions(
            base.id,
            tenant_id="tenant_demo",
            agent_id=None,
            db=db,
            current_user=owner,
        )
        stale_item = next(item for item in versions if item["id"] == stale_draft.id)

    assert stale_item["is_stale"] is True
    assert stale_item["base_version"] == "1.0.0"
    assert stale_item["next_version_preview"] == {
        "patch": "1.0.2",
        "minor": "1.1.0",
        "major": "2.0.0",
    }


def test_reject_endpoint_preserves_draft_branch_name_in_read_model() -> None:
    """驳回草稿后 API 投影仍保留原始草稿分支名。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        _bind_team(db, base)
        owner = _owner_user()

        draft = create_shared_knowledge_draft(
            base.id,
            SharedKnowledgeDraftCreateRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="待核实",
                expected_published_version_id=released.id,
            ),
            db=db,
            current_user=owner,
        )
        original_name = draft.version

        rejected = reject_shared_knowledge_version(
            base.id,
            draft.id,
            SharedKnowledgeRejectRequest(
                tenant_id="tenant_demo",
                team_id="team_content",
                change_reason="来源不足",
            ),
            db=db,
            current_user=owner,
        )

    assert rejected.publication_state == "rejected"
    assert rejected.version == original_name
    assert rejected.draft_name == original_name


def test_versions_endpoint_orders_drafts_then_released_then_rejected() -> None:
    """列表须按 草稿(新在前) → released(语义版本降序) → rejected(时间降序) 排序。"""
    with _test_session() as db:
        base, released = _seed_shared_base(db)
        t0 = datetime(2025, 1, 1, tzinfo=UTC)

        released_v2 = KnowledgeBaseVersion(
            id="kbver_manual_120",
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            version="1.2.0",
            name=base.name,
            publication_state="released",
            created_at=t0 + timedelta(minutes=1),
        )
        # 1.10.0 数值上大于 1.2.0，用于验证排序按语义版本数值而非字符串比较。
        released_v3 = KnowledgeBaseVersion(
            id="kbver_manual_1100",
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            version="1.10.0",
            name=base.name,
            publication_state="released",
            created_at=t0 + timedelta(minutes=2),
        )
        draft_a = KnowledgeBaseVersion(
            id="kbver_manual_draft_a",
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            version="draft-aaaa",
            name=base.name,
            publication_state="draft",
            parent_version_id=released.id,
            metadata_json={"draft_name": "draft-aaaa"},
            created_at=t0 + timedelta(minutes=3),
        )
        draft_b = KnowledgeBaseVersion(
            id="kbver_manual_draft_b",
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            version="draft-bbbb",
            name=base.name,
            publication_state="draft",
            parent_version_id=released.id,
            metadata_json={"draft_name": "draft-bbbb"},
            created_at=t0 + timedelta(minutes=4),
        )
        rejected_x = KnowledgeBaseVersion(
            id="kbver_manual_rejected_x",
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            version="draft-xxxx",
            name=base.name,
            publication_state="rejected",
            parent_version_id=released.id,
            metadata_json={"draft_name": "draft-xxxx"},
            created_at=t0 + timedelta(minutes=5),
        )
        rejected_y = KnowledgeBaseVersion(
            id="kbver_manual_rejected_y",
            tenant_id="tenant_demo",
            knowledge_base_id=base.id,
            version="draft-yyyy",
            name=base.name,
            publication_state="rejected",
            parent_version_id=released.id,
            metadata_json={"draft_name": "draft-yyyy"},
            created_at=t0 + timedelta(minutes=6),
        )
        db.add_all([released_v2, released_v3, draft_a, draft_b, rejected_x, rejected_y])
        base.published_version_id = released_v3.id
        db.add(base)
        db.commit()

        versions = list_knowledge_base_versions(
            base.id,
            tenant_id="tenant_demo",
            agent_id=None,
            db=db,
            current_user=_admin_user(),
        )

    assert [item["id"] for item in versions] == [
        draft_b.id,
        draft_a.id,
        released_v3.id,
        released_v2.id,
        released.id,
        rejected_y.id,
        rejected_x.id,
    ]
