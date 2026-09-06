"""Tenant-local assertions for the curated default employee template."""

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import firmdeck_seed
from app.db.models import (
    AgentKnowledgeBranch,
    AgentProfile,
    AgentResourceBinding,
    GeneralSkill,
    KnowledgeBase,
    KnowledgeBaseVersion,
    KnowledgeBucket,
    KnowledgeChunk,
    KnowledgeConcept,
    KnowledgeDiscoverySuggestion,
    KnowledgeDocument,
    KnowledgeIngestJob,
    Skill,
    Tenant,
    Tool,
    User,
)
from app.db.tenant_template import seed_default_tenant_template

EXPECTED_EMPLOYEE_NAMES = {
    "IT",
    "人事",
    "法务",
    "行政",
    "财务",
    "销售",
    "市场",
    "采购",
    "项目管理",
    "数据分析",
}

RESOURCE_MODELS = {
    "skill": Skill,
    "general_skill": GeneralSkill,
    "knowledge_base": KnowledgeBase,
    "tool": Tool,
}


def _session_with_tenants() -> tuple[Session, User, User]:
    """Create two isolated tenants and their administrators for a real template seed test."""
    engine = create_engine("sqlite:///:memory:")
    SQLModel.metadata.create_all(engine)
    session = Session(engine)
    first_admin = User(
        id="user_first_admin",
        tenant_id="tenant_first",
        username="first-admin",
        display_name="First Admin",
        role="admin",
        password_hash="test",
    )
    second_admin = User(
        id="user_second_admin",
        tenant_id="tenant_second",
        username="second-admin",
        display_name="Second Admin",
        role="admin",
        password_hash="test",
    )
    session.add(Tenant(id="tenant_first", slug="first", name="First Enterprise"))
    session.add(Tenant(id="tenant_second", slug="second", name="Second Enterprise"))
    session.add(first_admin)
    session.add(second_admin)
    session.commit()
    return session, first_admin, second_admin


def test_default_tenant_template_is_complete_idempotent_and_isolated() -> None:
    """Seed two tenants, retain exactly ten scoped employees, and never reuse their resource IDs."""
    session, first_admin, second_admin = _session_with_tenants()
    try:
        seed_default_tenant_template(session, "tenant_first", first_admin)
        seed_default_tenant_template(session, "tenant_second", second_admin)
        session.flush()

        first_agents = session.exec(
            select(AgentProfile).where(AgentProfile.tenant_id == "tenant_first")
        ).all()
        second_agents = session.exec(
            select(AgentProfile).where(AgentProfile.tenant_id == "tenant_second")
        ).all()

        assert {agent.name for agent in first_agents} == EXPECTED_EMPLOYEE_NAMES
        assert {agent.name for agent in second_agents} == EXPECTED_EMPLOYEE_NAMES
        assert {agent.id for agent in first_agents}.isdisjoint({agent.id for agent in second_agents})
        assert {agent.metadata_json["owner_user_id"] for agent in first_agents} == {
            "user_first_admin"
        }
        assert {agent.metadata_json["owner_user_id"] for agent in second_agents} == {
            "user_second_admin"
        }

        first_bindings = session.exec(
            select(AgentResourceBinding).where(AgentResourceBinding.tenant_id == "tenant_first")
        ).all()
        second_bindings = session.exec(
            select(AgentResourceBinding).where(AgentResourceBinding.tenant_id == "tenant_second")
        ).all()
        assert first_bindings
        assert second_bindings
        assert {binding.id for binding in first_bindings}.isdisjoint(
            {binding.id for binding in second_bindings}
        )
        for binding in [*first_bindings, *second_bindings]:
            resource = session.get(RESOURCE_MODELS[binding.resource_type], binding.resource_id)
            assert resource is not None
            assert resource.tenant_id == binding.tenant_id
        for model in (
            KnowledgeDocument,
            KnowledgeBucket,
            KnowledgeChunk,
            KnowledgeConcept,
            KnowledgeDiscoverySuggestion,
            KnowledgeIngestJob,
        ):
            assert not session.exec(select(model).where(model.tenant_id == "tenant_first")).all()
            assert not session.exec(select(model).where(model.tenant_id == "tenant_second")).all()

        first_snapshot = sorted(
            (binding.id, binding.agent_id, binding.resource_type, binding.resource_id)
            for binding in first_bindings
        )
        seed_default_tenant_template(session, "tenant_first", first_admin)
        session.flush()
        first_after_retry = session.exec(
            select(AgentResourceBinding).where(AgentResourceBinding.tenant_id == "tenant_first")
        ).all()
        assert sorted(
            (binding.id, binding.agent_id, binding.resource_type, binding.resource_id)
            for binding in first_after_retry
        ) == first_snapshot
    finally:
        session.close()


def test_default_tenant_template_rejects_an_admin_from_another_tenant() -> None:
    """Reject a mismatched principal before it can add partial tenant template rows."""
    session, first_admin, second_admin = _session_with_tenants()
    try:
        with pytest.raises(
            ValueError, match="Tenant administrator does not belong to the requested tenant"
        ):
            seed_default_tenant_template(session, "tenant_first", second_admin)

        assert not session.exec(
            select(AgentProfile).where(AgentProfile.tenant_id == "tenant_first")
        ).all()
        assert first_admin.tenant_id == "tenant_first"
    finally:
        session.close()


def test_default_tenant_template_rejects_reserved_resource_conflict_before_writes() -> None:
    """Reject a tenant-owned natural-key collision without leaving any curated employee rows."""
    session, first_admin, _second_admin = _session_with_tenants()
    try:
        session.add(
            Skill(
                tenant_id="tenant_first",
                skill_id="leave_apply_v1",
                version="custom",
                name="Custom leave flow",
                content_json={},
                status="published",
            )
        )
        session.commit()

        with pytest.raises(ValueError, match="reserved key"):
            seed_default_tenant_template(session, "tenant_first", first_admin)

        assert not session.exec(
            select(AgentProfile).where(AgentProfile.tenant_id == "tenant_first")
        ).all()
        assert not session.exec(
            select(AgentResourceBinding).where(
                AgentResourceBinding.tenant_id == "tenant_first"
            )
        ).all()
    finally:
        session.close()


def test_default_tenant_template_ids_and_embedded_references_are_tenant_deterministic() -> None:
    """Rebuild the same tenant twice with stable branch IDs and no fixture-agent references."""
    first_session, first_admin, _ = _session_with_tenants()
    second_session, second_admin, _ = _session_with_tenants()
    try:
        seed_default_tenant_template(first_session, "tenant_first", first_admin)
        seed_default_tenant_template(second_session, "tenant_first", second_admin)
        first_session.flush()
        second_session.flush()

        first_branch_ids = {
            row.id
            for row in first_session.exec(
                select(AgentKnowledgeBranch).where(
                    AgentKnowledgeBranch.tenant_id == "tenant_first"
                )
            ).all()
        }
        second_branch_ids = {
            row.id
            for row in second_session.exec(
                select(AgentKnowledgeBranch).where(
                    AgentKnowledgeBranch.tenant_id == "tenant_first"
                )
            ).all()
        }
        assert first_branch_ids
        assert first_branch_ids == second_branch_ids

        raw = firmdeck_seed._load_seed_fixtures(
            (firmdeck_seed.FIXTURE_PATH, firmdeck_seed.EXPANDED_FIXTURE_PATH)
        )
        fixture_agent_ids = {
            str(row["id"])
            for row in raw.get("agent_profiles", [])
            if row.get("name") in EXPECTED_EMPLOYEE_NAMES
        }
        versions = first_session.exec(
            select(KnowledgeBaseVersion).where(
                KnowledgeBaseVersion.tenant_id == "tenant_first"
            )
        ).all()
        assert versions
        assert all(
            source_id not in version.version
            for version in versions
            for source_id in fixture_agent_ids
        )
    finally:
        first_session.close()
        second_session.close()
