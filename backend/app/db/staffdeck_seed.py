from __future__ import annotations

import json
from collections.abc import Iterable
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, TypeVar
from uuid import NAMESPACE_URL, uuid5

from sqlmodel import Session, SQLModel, select

from app.agents.branching import (
    agent_private_metadata,
    ensure_open_gallery_binding,
    open_gallery_metadata,
)
from app.capability_scope import normalize_capability_scope
from app.db.models import (
    AgentKnowledgeBranch,
    AgentProfile,
    AgentResourceBinding,
    AgentSkillBranch,
    AgentSkillBranchVersion,
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
    SkillVersion,
    Tool,
    User,
    utc_now,
)

TENANT_ID = "tenant_demo"
ADMIN_USER_ID = "admin"
ADMIN_USERNAME = "admin"
ADMIN_DISPLAY_NAME = "Administrator"
SEED_SOURCE = "staffdeck_admin_gallery_seed"
FIXTURE_PATH = Path(__file__).resolve().parent / "seed_fixtures" / "staffdeck_admin_gallery_seed.json"
EXPANDED_FIXTURE_PATH = (
    Path(__file__).resolve().parent / "seed_fixtures" / "staffdeck_expanded_gallery_seed.json"
)

SELECTED_AGENT_NAMES = {
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
USER_EDITABLE_AGENT_METADATA_KEYS = {
    "avatar_image",
    "avatar_kind",
    "avatar_preset",
    "avatar_text",
    "avatar_tone",
}
TENANT_TEMPLATE_EXCLUDED_FIXTURE_KEYS = frozenset(
    {
        "knowledge_documents",
        "knowledge_buckets",
        "knowledge_chunks",
        "knowledge_concepts",
        "knowledge_discovery_suggestions",
        "knowledge_ingest_jobs",
    }
)

JsonDict = dict[str, Any]
ModelT = TypeVar("ModelT", bound=SQLModel)


@dataclass(frozen=True)
class SeedPrincipal:
    """Describe the tenant and administrator that own one curated template run."""

    tenant_id: str
    admin_user_id: str
    admin_username: str
    admin_display_name: str


_DEFAULT_SEED_PRINCIPAL = SeedPrincipal(
    tenant_id=TENANT_ID,
    admin_user_id=ADMIN_USER_ID,
    admin_username=ADMIN_USERNAME,
    admin_display_name=ADMIN_DISPLAY_NAME,
)
_seed_principal: ContextVar[SeedPrincipal] = ContextVar(
    "staffdeck_seed_principal", default=_DEFAULT_SEED_PRINCIPAL
)


def seed_staffdeck_admin_gallery(session: Session) -> None:
    """Seed the curated StaffDeck gallery package as admin-owned resources."""

    seed_staffdeck_tenant_gallery(
        session,
        tenant_id=TENANT_ID,
        admin_user_id=ADMIN_USER_ID,
        admin_username=ADMIN_USERNAME,
        admin_display_name=ADMIN_DISPLAY_NAME,
    )


def seed_staffdeck_tenant_gallery(
    session: Session,
    *,
    tenant_id: str,
    admin_user_id: str,
    admin_username: str,
    admin_display_name: str,
) -> None:
    """Flush the curated gallery into one tenant using its supplied administrator identity.

    All rows remain attached to ``session`` and this function never commits. Invalid owner input
    fails before rows are added; database integrity failures remain visible to the caller's
    enclosing provisioning transaction.
    """
    principal = _validated_seed_principal(
        tenant_id, admin_user_id, admin_username, admin_display_name
    )
    context_token = _seed_principal.set(principal)
    try:
        _seed_staffdeck_gallery_for_current_principal(session)
    finally:
        _seed_principal.reset(context_token)


def _seed_staffdeck_gallery_for_current_principal(session: Session) -> None:
    """Populate all curated resource kinds for the principal already bound to this call context."""

    data = _load_seed_fixtures((FIXTURE_PATH, EXPANDED_FIXTURE_PATH))
    if not data:
        return
    if _seed_tenant_id() != TENANT_ID:
        data = _tenant_scoped_fixture_data(data, _seed_tenant_id())
    id_maps: dict[str, dict[str, str]] = {
        "agent": {},
        "skill": {},
        "skill_business": {},
        "general_skill": {},
        "tool": {},
        "knowledge_base": {},
        "knowledge_base_version": {},
        "knowledge_document": {},
        "knowledge_bucket": {},
    }

    agents = [
        row for row in data.get("agent_profiles", []) if row.get("name") in SELECTED_AGENT_NAMES
    ]
    selected_agent_ids = {str(row.get("id") or "") for row in agents}
    active_bindings = [
        row
        for row in data.get("agent_resource_bindings", [])
        if row.get("status") == "active" and str(row.get("agent_id") or "") in selected_agent_ids
    ]
    resource_ids = _resource_ids_by_type(active_bindings)
    if _seed_tenant_id() != TENANT_ID:
        _reject_seed_resource_conflicts(session, data, agents, resource_ids)

    _seed_agents(session, agents, id_maps)
    _seed_skills(session, data.get("skills", []), data.get("skill_versions", []), resource_ids, id_maps)
    _seed_general_skills(session, data.get("general_skills", []), resource_ids, id_maps)
    _seed_tools(session, data.get("tools", []), resource_ids, id_maps)
    _seed_knowledge(session, data, resource_ids, id_maps)
    session.flush()
    _seed_agent_resource_bindings(session, active_bindings, id_maps)
    _seed_skill_branches(
        session,
        data.get("agent_skill_branches", []),
        data.get("agent_skill_branch_versions", []),
        id_maps,
    )
    _seed_knowledge_branches(session, active_bindings, id_maps)
    session.flush()
    _publish_gallery_resources(session, id_maps)
    _sync_seed_agents_to_current_admin(session, id_maps)


def _load_seed_fixtures(paths: Iterable[Path]) -> JsonDict:
    """Load every immutable curated fixture into one in-memory payload without changing it."""
    merged: JsonDict = {}
    for path in paths:
        fixture = json.loads(path.read_text(encoding="utf-8"))
        for key, value in fixture.items():
            if isinstance(value, list):
                merged.setdefault(key, []).extend(value)
            elif key not in merged:
                merged[key] = value
    return merged


def _validated_seed_principal(
    tenant_id: str,
    admin_user_id: str,
    admin_username: str,
    admin_display_name: str,
) -> SeedPrincipal:
    """Normalize required tenant owner fields before any fixture row is added to a session."""
    normalized = SeedPrincipal(
        tenant_id=tenant_id.strip(),
        admin_user_id=admin_user_id.strip(),
        admin_username=admin_username.strip(),
        admin_display_name=admin_display_name.strip(),
    )
    if not all(
        (
            normalized.tenant_id,
            normalized.admin_user_id,
            normalized.admin_username,
            normalized.admin_display_name,
        )
    ):
        raise ValueError("Tenant template seed requires a tenant and complete administrator identity")
    return normalized


def _current_seed_principal() -> SeedPrincipal:
    """Return the call-scoped owner, defaulting direct legacy helpers to the demo seed principal."""
    return _seed_principal.get()


def _seed_tenant_id() -> str:
    """Provide the current template tenant ID to lower-level fixture writers."""
    return _current_seed_principal().tenant_id


def _seed_admin_user_id() -> str:
    """Provide the current template owner's durable user ID to metadata builders."""
    return _current_seed_principal().admin_user_id


def _seed_admin_username() -> str:
    """Provide the current template owner's username to metadata builders."""
    return _current_seed_principal().admin_username


def _seed_admin_display_name() -> str:
    """Provide the current template owner's display name to metadata builders."""
    return _current_seed_principal().admin_display_name


def _tenant_scoped_fixture_data(data: JsonDict, tenant_id: str) -> JsonDict:
    """Copy only reusable template resources with deterministic IDs and no demo business records."""
    template_data = deepcopy(data)
    for key in TENANT_TEMPLATE_EXCLUDED_FIXTURE_KEYS:
        template_data[key] = []
    source_ids = {
        str(row["id"])
        for rows in template_data.values()
        if isinstance(rows, list)
        for row in rows
        if isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"]
    }
    id_map = {
        source_id: f"template_{uuid5(NAMESPACE_URL, f'staffdeck:{tenant_id}:{source_id}').hex}"
        for source_id in source_ids
    }
    return _replace_fixture_ids(template_data, id_map)


def _replace_fixture_ids(value: Any, id_map: dict[str, str]) -> Any:
    """Recursively replace exact fixture IDs in copied structured data without altering prose values."""
    if isinstance(value, dict):
        return {key: _replace_fixture_ids(item, id_map) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace_fixture_ids(item, id_map) for item in value]
    if isinstance(value, str):
        replaced = value
        for source_id, tenant_id in sorted(id_map.items(), key=lambda item: len(item[0]), reverse=True):
            replaced = replaced.replace(source_id, tenant_id)
        return replaced
    return value


def _reject_seed_resource_conflicts(
    session: Session,
    data: JsonDict,
    agents: list[JsonDict],
    resource_ids: dict[str, set[str]],
) -> None:
    """Reject reserved natural-key collisions before any curated template row is written."""
    for row in agents:
        _reject_seed_slot_conflict(session, AgentProfile, row, "name")

    selected_skill_ids: set[str] = set()
    for row in data.get("skills", []):
        if str(row.get("id") or "") in resource_ids.get("skill", set()):
            _reject_seed_slot_conflict(session, Skill, row, "skill_id")
            selected_skill_ids.add(str(row.get("skill_id") or ""))
    for row in data.get("skill_versions", []):
        if str(row.get("skill_id") or "") in selected_skill_ids:
            _reject_seed_slot_conflict(
                session,
                SkillVersion,
                row,
                "skill_id",
                secondary_key="version",
            )

    for fixture_key, resource_type, model, natural_key in (
        ("general_skills", "general_skill", GeneralSkill, "slug"),
        ("tools", "tool", Tool, "name"),
        ("knowledge_bases", "knowledge_base", KnowledgeBase, "name"),
    ):
        for row in data.get(fixture_key, []):
            if str(row.get("id") or "") in resource_ids.get(resource_type, set()):
                _reject_seed_slot_conflict(session, model, row, natural_key)

    selected_knowledge_ids = resource_ids.get("knowledge_base", set())
    for row in data.get("knowledge_base_versions", []):
        if str(row.get("knowledge_base_id") or "") in selected_knowledge_ids:
            _reject_seed_slot_conflict(
                session,
                KnowledgeBaseVersion,
                row,
                "knowledge_base_id",
                secondary_key="version",
            )


def _reject_seed_slot_conflict(
    session: Session,
    model: type[ModelT],
    row: JsonDict,
    natural_key: str,
    *,
    secondary_key: str | None = None,
) -> None:
    """Reject an occupied deterministic ID or natural key unless it is the same seed-managed row."""
    source_id = str(row.get("id") or "")
    key_value = str(row.get(natural_key) or "")
    if not source_id or not key_value:
        return
    predicates = [
        getattr(model, "tenant_id") == _seed_tenant_id(),
        getattr(model, natural_key) == key_value,
    ]
    if secondary_key is not None:
        secondary_value = str(row.get(secondary_key) or "")
        if not secondary_value:
            return
        predicates.append(getattr(model, secondary_key) == secondary_value)
    existing_by_id = session.get(model, source_id)
    existing_by_key = session.exec(select(model).where(*predicates)).first()
    for existing in (existing_by_id, existing_by_key):
        if existing is not None and not _is_seed_managed(existing, source_id):
            raise ValueError("Tenant already has a non-template resource using a reserved key")


def _seed_agents(session: Session, rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]) -> None:
    for row in rows:
        source_id = str(row.get("id") or "")
        name = str(row.get("name") or "").strip()
        if not source_id or not name:
            continue
        existing_by_id = session.get(AgentProfile, source_id)
        existing_by_name = session.exec(
            select(AgentProfile).where(AgentProfile.tenant_id == _seed_tenant_id(), AgentProfile.name == name)
        ).first()
        existing = _seed_update_target(existing_by_id, existing_by_name, source_id)
        metadata = _agent_metadata(row.get("metadata_json"))
        if existing:
            existing_metadata = existing.metadata_json or {}
            metadata.update(
                {
                    key: existing_metadata[key]
                    for key in USER_EDITABLE_AGENT_METADATA_KEYS
                    if key in existing_metadata
                }
            )
        payload = {
            "tenant_id": _seed_tenant_id(),
            "name": name,
            "description": row.get("description"),
            "persona_prompt": row.get("persona_prompt"),
            "is_overall": bool(row.get("is_overall", False)),
            "status": row.get("status") or "active",
            "metadata_json": metadata,
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
            id_maps["agent"][source_id] = existing.id
        elif existing_by_id or existing_by_name:
            continue
        else:
            agent = AgentProfile(id=source_id, **payload)
            session.add(agent)
            id_maps["agent"][source_id] = source_id


def _seed_skills(
    session: Session,
    skill_rows: Iterable[JsonDict],
    version_rows: Iterable[JsonDict],
    resource_ids: dict[str, set[str]],
    id_maps: dict[str, dict[str, str]],
) -> None:
    selected_ids = resource_ids.get("skill", set())
    selected_skill_ids: set[str] = set()
    for row in skill_rows:
        source_id = str(row.get("id") or "")
        if source_id not in selected_ids:
            continue
        skill_id = str(row.get("skill_id") or "").strip()
        if not skill_id:
            continue
        existing_by_id = session.get(Skill, source_id)
        existing_by_skill_id = session.exec(
            select(Skill).where(Skill.tenant_id == _seed_tenant_id(), Skill.skill_id == skill_id)
        ).first()
        existing = _seed_update_target(existing_by_id, existing_by_skill_id, source_id)
        content = _json_object(row.get("content_json"))
        _apply_curated_skill_runtime_defaults(skill_id, content)
        content.update({"skill_id": skill_id, "name": row.get("name"), "version": row.get("version") or "1.0.0"})
        payload = {
            "tenant_id": _seed_tenant_id(),
            "skill_id": skill_id,
            "version": row.get("version") or "1.0.0",
            "name": row.get("name") or skill_id,
            "business_domain": row.get("business_domain"),
            "description": row.get("description"),
            "content_json": content,
            "status": "published",
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
            target_id = existing.id
        elif existing_by_id or existing_by_skill_id:
            continue
        else:
            skill = Skill(id=source_id, **payload)
            session.add(skill)
            target_id = source_id
        id_maps["skill"][source_id] = target_id
        id_maps["skill_business"][skill_id] = skill_id
        selected_skill_ids.add(skill_id)
    session.flush()

    for row in version_rows:
        skill_id = str(row.get("skill_id") or "").strip()
        if skill_id not in selected_skill_ids:
            continue
        version = str(row.get("version") or "1.0.0")
        source_id = str(row.get("id") or "")
        existing_by_id = session.get(SkillVersion, source_id)
        existing_by_version = session.exec(
            select(SkillVersion).where(
                SkillVersion.tenant_id == _seed_tenant_id(),
                SkillVersion.skill_id == skill_id,
                SkillVersion.version == version,
            )
        ).first()
        existing = _seed_update_target(existing_by_id, existing_by_version, source_id)
        content = _json_object(row.get("content_json"))
        _apply_curated_skill_runtime_defaults(skill_id, content)
        content.update({"skill_id": skill_id, "name": row.get("name"), "version": version})
        payload = {
            "tenant_id": _seed_tenant_id(),
            "skill_id": skill_id,
            "version": version,
            "name": row.get("name") or skill_id,
            "business_domain": row.get("business_domain"),
            "description": row.get("description"),
            "content_json": content,
            "status": "published",
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
        elif existing_by_id or existing_by_version:
            continue
        else:
            session.add(SkillVersion(id=source_id, **payload))


def _seed_general_skills(
    session: Session,
    rows: Iterable[JsonDict],
    resource_ids: dict[str, set[str]],
    id_maps: dict[str, dict[str, str]],
) -> None:
    selected_ids = resource_ids.get("general_skill", set())
    for row in rows:
        source_id = str(row.get("id") or "")
        if source_id not in selected_ids:
            continue
        slug = str(row.get("slug") or "").strip()
        if not slug:
            continue
        existing_by_id = session.get(GeneralSkill, source_id)
        existing_by_slug = session.exec(
            select(GeneralSkill).where(
                GeneralSkill.tenant_id == _seed_tenant_id(), GeneralSkill.slug == slug
            )
        ).first()
        existing = _seed_update_target(existing_by_id, existing_by_slug, source_id)
        payload = {
            "tenant_id": _seed_tenant_id(),
            "slug": slug,
            "name": row.get("name") or slug,
            "description": row.get("description"),
            "homepage": row.get("homepage"),
            "skill_markdown": row.get("skill_markdown") or "",
            "skill_files_json": _json_list(row.get("skill_files_json")),
            "metadata_json": _open_gallery_seed_metadata(row.get("metadata_json")),
            "status": "published",
            "capability_scope": normalize_capability_scope(
                row.get("capability_scope")
                if row.get("capability_scope") is not None
                else getattr(existing, "capability_scope", None)
            ),
            "permissions_json": _json_object(row.get("permissions_json")),
            "runtime_config_json": _json_object(row.get("runtime_config_json")),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
            id_maps["general_skill"][source_id] = existing.id
        elif existing_by_id or existing_by_slug:
            continue
        else:
            session.add(GeneralSkill(id=source_id, **payload))
            id_maps["general_skill"][source_id] = source_id


def _seed_tools(
    session: Session,
    rows: Iterable[JsonDict],
    resource_ids: dict[str, set[str]],
    id_maps: dict[str, dict[str, str]],
) -> None:
    selected_ids = resource_ids.get("tool", set())
    for row in rows:
        source_id = str(row.get("id") or "")
        if source_id not in selected_ids:
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        existing_by_id = session.get(Tool, source_id)
        existing_by_name = session.exec(
            select(Tool).where(Tool.tenant_id == _seed_tenant_id(), Tool.name == name)
        ).first()
        existing = _seed_update_target(existing_by_id, existing_by_name, source_id)
        config = _json_object(row.get("config_json"))
        if name == "contract.archive_query":
            config = {**config, "execution": {"timeout_seconds": 20}}
        payload = {
            "tenant_id": _seed_tenant_id(),
            "name": name,
            "display_name": row.get("display_name"),
            "description": row.get("description"),
            "bucket": row.get("bucket") or "未分桶",
            "tool_type": row.get("tool_type") or "http",
            "method": row.get("method") or "POST",
            "url": row.get("url") or "",
            "headers_json": _json_object(row.get("headers_json")),
            "auth_json": _json_object(row.get("auth_json")),
            "config_json": config,
            "input_schema": _json_object(row.get("input_schema")),
            "output_schema": _json_object(row.get("output_schema")),
            "allowed_skills_json": _json_list(row.get("allowed_skills_json")),
            "mcp_server_id": row.get("mcp_server_id"),
            "capability_scope": normalize_capability_scope(
                row.get("capability_scope")
                if row.get("capability_scope") is not None
                else getattr(existing, "capability_scope", None)
            ),
            "capability_scope_inherited": bool(
                row.get("capability_scope_inherited")
                if row.get("capability_scope_inherited") is not None
                else getattr(existing, "capability_scope_inherited", True)
            ),
            "enabled": bool(row.get("enabled", True)),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
            id_maps["tool"][source_id] = existing.id
        elif existing_by_id or existing_by_name:
            continue
        else:
            session.add(Tool(id=source_id, **payload))
            id_maps["tool"][source_id] = source_id


def _apply_curated_skill_runtime_defaults(skill_id: str, content: JsonDict) -> None:
    if skill_id != "leave_apply_v1":
        return
    nodes = content.get("nodes")
    if not isinstance(nodes, list):
        return
    for node in nodes:
        if not isinstance(node, dict) or node.get("node_id") != "check_policy":
            continue
        scope = _json_object(node.get("knowledge_scope"))
        scope.setdefault("query_fields", ["leave_type"])
        node["knowledge_scope"] = scope


def _seed_knowledge(
    session: Session,
    data: JsonDict,
    resource_ids: dict[str, set[str]],
    id_maps: dict[str, dict[str, str]],
) -> None:
    selected_ids = resource_ids.get("knowledge_base", set())
    for row in data.get("knowledge_bases", []):
        source_id = str(row.get("id") or "")
        if source_id not in selected_ids:
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        existing_by_id = session.get(KnowledgeBase, source_id)
        existing_by_name = session.exec(
            select(KnowledgeBase).where(
                KnowledgeBase.tenant_id == _seed_tenant_id(), KnowledgeBase.name == name
            )
        ).first()
        existing = _seed_update_target(existing_by_id, existing_by_name, source_id)
        payload = {
            "tenant_id": _seed_tenant_id(),
            "name": name,
            "description": row.get("description"),
            "status": row.get("status") or "active",
            "capability_scope": normalize_capability_scope(
                row.get("capability_scope")
                if row.get("capability_scope") is not None
                else getattr(existing, "capability_scope", None)
            ),
            "metadata_json": _open_gallery_seed_metadata(row.get("metadata_json")),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
            id_maps["knowledge_base"][source_id] = existing.id
        elif existing_by_id or existing_by_name:
            continue
        else:
            session.add(KnowledgeBase(id=source_id, **payload))
            id_maps["knowledge_base"][source_id] = source_id
    session.flush()

    _seed_knowledge_versions(session, data.get("knowledge_base_versions", []), id_maps)
    _seed_knowledge_documents(session, data.get("knowledge_documents", []), id_maps)
    _seed_knowledge_buckets(session, data.get("knowledge_buckets", []), id_maps)
    _seed_knowledge_chunks(session, data.get("knowledge_chunks", []), id_maps)
    _seed_knowledge_concepts(session, data.get("knowledge_concepts", []), id_maps)
    _seed_knowledge_discovery(session, data.get("knowledge_discovery_suggestions", []), id_maps)
    _seed_knowledge_jobs(session, data.get("knowledge_ingest_jobs", []), id_maps)


def _seed_knowledge_versions(
    session: Session, rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]
) -> None:
    for row in rows:
        kb_id = id_maps["knowledge_base"].get(str(row.get("knowledge_base_id") or ""))
        if not kb_id:
            continue
        knowledge_base = session.get(KnowledgeBase, kb_id)
        version = str(row.get("version") or "1.0.0")
        source_id = str(row.get("id") or "")
        existing_by_id = session.get(KnowledgeBaseVersion, source_id)
        existing_by_version = session.exec(
            select(KnowledgeBaseVersion).where(
                KnowledgeBaseVersion.tenant_id == _seed_tenant_id(),
                KnowledgeBaseVersion.knowledge_base_id == kb_id,
                KnowledgeBaseVersion.version == version,
            )
        ).first()
        existing = _seed_update_target(existing_by_id, existing_by_version, source_id)
        payload = {
            "tenant_id": _seed_tenant_id(),
            "knowledge_base_id": kb_id,
            "version": version,
            "name": row.get("name") or version,
            "description": row.get("description"),
            "status": row.get("status") or "active",
            "capability_scope": normalize_capability_scope(
                row.get("capability_scope")
                if row.get("capability_scope") is not None
                else getattr(
                    existing,
                    "capability_scope",
                    getattr(knowledge_base, "capability_scope", None),
                )
            ),
            "metadata_json": _open_gallery_seed_metadata(row.get("metadata_json")),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
            id_maps["knowledge_base_version"][source_id] = existing.id
        elif existing_by_id or existing_by_version:
            continue
        else:
            session.add(KnowledgeBaseVersion(id=source_id, **payload))
            id_maps["knowledge_base_version"][source_id] = source_id
    session.flush()


def _seed_knowledge_documents(
    session: Session, rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]
) -> None:
    for row in rows:
        kb_id = id_maps["knowledge_base"].get(str(row.get("knowledge_base_id") or ""))
        kb_ver_id = id_maps["knowledge_base_version"].get(str(row.get("knowledge_base_version_id") or ""))
        if not kb_id or not kb_ver_id:
            continue
        source_id = str(row.get("id") or "")
        existing = session.get(KnowledgeDocument, source_id)
        payload = {
            "tenant_id": _seed_tenant_id(),
            "knowledge_base_id": kb_id,
            "knowledge_base_version_id": kb_ver_id,
            "filename": row.get("filename") or "document",
            "file_type": row.get("file_type") or "text",
            "title": row.get("title"),
            "status": row.get("status") or "ready",
            "bucket_count": int(row.get("bucket_count") or 0),
            "chunk_count": int(row.get("chunk_count") or 0),
            "metadata_json": _seed_metadata(row.get("metadata_json")),
            "error": row.get("error"),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
            id_maps["knowledge_document"][source_id] = existing.id
        else:
            session.add(KnowledgeDocument(id=source_id, **payload))
            id_maps["knowledge_document"][source_id] = source_id
    session.flush()


def _seed_knowledge_buckets(
    session: Session, rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]
) -> None:
    for row in rows:
        kb_id = id_maps["knowledge_base"].get(str(row.get("knowledge_base_id") or ""))
        kb_ver_id = id_maps["knowledge_base_version"].get(str(row.get("knowledge_base_version_id") or ""))
        doc_id = id_maps["knowledge_document"].get(str(row.get("document_id") or ""))
        if not kb_id or not kb_ver_id or not doc_id:
            continue
        source_id = str(row.get("id") or "")
        existing = session.get(KnowledgeBucket, source_id)
        payload = {
            "tenant_id": _seed_tenant_id(),
            "knowledge_base_id": kb_id,
            "knowledge_base_version_id": kb_ver_id,
            "document_id": doc_id,
            "bucket_key": row.get("bucket_key") or source_id,
            "title": row.get("title") or "Untitled",
            "summary": row.get("summary") or "",
            "token_estimate": int(row.get("token_estimate") or 0),
            "metadata_json": _seed_metadata(row.get("metadata_json")),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
            id_maps["knowledge_bucket"][source_id] = existing.id
        else:
            session.add(KnowledgeBucket(id=source_id, **payload))
            id_maps["knowledge_bucket"][source_id] = source_id
    session.flush()


def _seed_knowledge_chunks(
    session: Session, rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]
) -> None:
    for row in rows:
        kb_id = id_maps["knowledge_base"].get(str(row.get("knowledge_base_id") or ""))
        kb_ver_id = id_maps["knowledge_base_version"].get(str(row.get("knowledge_base_version_id") or ""))
        doc_id = id_maps["knowledge_document"].get(str(row.get("document_id") or ""))
        bucket_id = id_maps["knowledge_bucket"].get(str(row.get("bucket_id") or ""))
        if not kb_id or not kb_ver_id or not doc_id or not bucket_id:
            continue
        existing = session.get(KnowledgeChunk, str(row.get("id") or ""))
        payload = {
            "tenant_id": _seed_tenant_id(),
            "knowledge_base_id": kb_id,
            "knowledge_base_version_id": kb_ver_id,
            "document_id": doc_id,
            "bucket_id": bucket_id,
            "chunk_index": int(row.get("chunk_index") or 0),
            "content": row.get("content") or "",
            "summary": row.get("summary"),
            "source_ref": row.get("source_ref"),
            "metadata_json": _seed_metadata(row.get("metadata_json")),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
        else:
            session.add(KnowledgeChunk(id=str(row.get("id") or ""), **payload))


def _seed_knowledge_concepts(
    session: Session, rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]
) -> None:
    for row in rows:
        kb_id = id_maps["knowledge_base"].get(str(row.get("knowledge_base_id") or ""))
        kb_ver_id = id_maps["knowledge_base_version"].get(str(row.get("knowledge_base_version_id") or ""))
        if not kb_id or not kb_ver_id:
            continue
        doc_id = id_maps["knowledge_document"].get(str(row.get("document_id") or ""))
        concept_id = row.get("concept_id") or str(row.get("id") or "")
        existing = session.get(KnowledgeConcept, str(row.get("id") or "")) or session.exec(
            select(KnowledgeConcept).where(
                KnowledgeConcept.tenant_id == _seed_tenant_id(),
                KnowledgeConcept.knowledge_base_version_id == kb_ver_id,
                KnowledgeConcept.concept_id == concept_id,
            )
        ).first()
        payload = {
            "tenant_id": _seed_tenant_id(),
            "knowledge_base_id": kb_id,
            "knowledge_base_version_id": kb_ver_id,
            "document_id": doc_id,
            "concept_id": concept_id,
            "concept_type": row.get("concept_type") or "Concept",
            "title": row.get("title") or concept_id,
            "description": row.get("description"),
            "content_md": row.get("content_md") or "",
            "frontmatter_json": _json_object(row.get("frontmatter_json")),
            "links_json": _json_list(row.get("links_json")),
            "citations_json": _json_list(row.get("citations_json")),
            "source_refs_json": _json_list(row.get("source_refs_json")),
            "status": row.get("status") or "active",
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
        else:
            session.add(KnowledgeConcept(id=str(row.get("id") or ""), **payload))


def _seed_knowledge_discovery(
    session: Session, rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]
) -> None:
    for row in rows:
        kb_id = id_maps["knowledge_base"].get(str(row.get("knowledge_base_id") or ""))
        kb_ver_id = id_maps["knowledge_base_version"].get(str(row.get("knowledge_base_version_id") or ""))
        doc_id = id_maps["knowledge_document"].get(str(row.get("document_id") or ""))
        bucket_id = id_maps["knowledge_bucket"].get(str(row.get("bucket_id") or ""))
        if not kb_id or not kb_ver_id or not doc_id:
            continue
        existing = session.get(KnowledgeDiscoverySuggestion, str(row.get("id") or ""))
        payload = {
            "tenant_id": _seed_tenant_id(),
            "knowledge_base_id": kb_id,
            "knowledge_base_version_id": kb_ver_id,
            "document_id": doc_id,
            "bucket_id": bucket_id,
            "suggestion_type": row.get("suggestion_type") or "suggestion",
            "title": row.get("title") or "Suggestion",
            "status": row.get("status") or "pending",
            "payload_json": _json_object(row.get("payload_json")),
            "source_refs_json": _json_list(row.get("source_refs_json")),
            "reason": row.get("reason"),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
        else:
            session.add(KnowledgeDiscoverySuggestion(id=str(row.get("id") or ""), **payload))


def _seed_knowledge_jobs(
    session: Session, rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]
) -> None:
    for row in rows:
        kb_id = id_maps["knowledge_base"].get(str(row.get("knowledge_base_id") or ""))
        kb_ver_id = id_maps["knowledge_base_version"].get(str(row.get("knowledge_base_version_id") or ""))
        doc_id = id_maps["knowledge_document"].get(str(row.get("document_id") or ""))
        if not kb_id or not kb_ver_id:
            continue
        existing = session.get(KnowledgeIngestJob, str(row.get("id") or ""))
        payload = {
            "tenant_id": _seed_tenant_id(),
            "knowledge_base_id": kb_id,
            "knowledge_base_version_id": kb_ver_id,
            "document_id": doc_id,
            "filename": row.get("filename") or "document",
            "status": row.get("status") or "completed",
            "stage": row.get("stage") or "completed",
            "progress": float(row.get("progress") or 0),
            "error": row.get("error"),
            "metadata_json": _seed_metadata(row.get("metadata_json")),
            "started_at": _parse_datetime(row.get("started_at")),
            "finished_at": _parse_datetime(row.get("finished_at")),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
        else:
            session.add(KnowledgeIngestJob(id=str(row.get("id") or ""), **payload))


def _seed_agent_resource_bindings(
    session: Session, rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]
) -> None:
    for row in rows:
        agent_id = id_maps["agent"].get(str(row.get("agent_id") or ""))
        resource_type = str(row.get("resource_type") or "")
        resource_id = _mapped_resource_id(resource_type, str(row.get("resource_id") or ""), id_maps)
        if not agent_id or not resource_id:
            continue
        metadata = agent_private_metadata(agent_id, _seed_metadata(row.get("metadata_json")))
        existing = session.exec(
            select(AgentResourceBinding).where(
                AgentResourceBinding.tenant_id == _seed_tenant_id(),
                AgentResourceBinding.agent_id == agent_id,
                AgentResourceBinding.resource_type == resource_type,
                AgentResourceBinding.resource_id == resource_id,
            )
        ).first()
        payload = {
            "tenant_id": _seed_tenant_id(),
            "agent_id": agent_id,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "status": "active",
            "metadata_json": metadata,
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
        else:
            session.add(AgentResourceBinding(id=str(row.get("id") or ""), **payload))


def _seed_skill_branches(
    session: Session,
    branch_rows: Iterable[JsonDict],
    version_rows: Iterable[JsonDict],
    id_maps: dict[str, dict[str, str]],
) -> None:
    branch_keys: set[tuple[str, str]] = set()
    for row in branch_rows:
        agent_id = id_maps["agent"].get(str(row.get("agent_id") or ""))
        skill_id = str(row.get("skill_id") or "")
        if not agent_id or skill_id not in id_maps["skill_business"]:
            continue
        branch_keys.add((agent_id, skill_id))
        existing = session.get(AgentSkillBranch, str(row.get("id") or "")) or session.exec(
            select(AgentSkillBranch).where(
                AgentSkillBranch.tenant_id == _seed_tenant_id(),
                AgentSkillBranch.agent_id == agent_id,
                AgentSkillBranch.skill_id == skill_id,
            )
        ).first()
        payload = {
            "tenant_id": _seed_tenant_id(),
            "agent_id": agent_id,
            "skill_id": skill_id,
            "source_skill_id": row.get("source_skill_id") or skill_id,
            "base_version": row.get("base_version") or "1.0.0",
            "head_version": row.get("head_version") or row.get("base_version") or "1.0.0",
            "content_json": _json_object(row.get("content_json")),
            "status": row.get("status") or "active",
            "sync_state": row.get("sync_state") or "synced",
            "metadata_json": agent_private_metadata(agent_id, _seed_metadata(row.get("metadata_json"))),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
        else:
            session.add(AgentSkillBranch(id=str(row.get("id") or ""), **payload))
    session.flush()

    for row in version_rows:
        agent_id = id_maps["agent"].get(str(row.get("agent_id") or ""))
        skill_id = str(row.get("skill_id") or "")
        version = str(row.get("version") or "1.0.0")
        if not agent_id or (agent_id, skill_id) not in branch_keys:
            continue
        existing = session.get(AgentSkillBranchVersion, str(row.get("id") or "")) or session.exec(
            select(AgentSkillBranchVersion).where(
                AgentSkillBranchVersion.tenant_id == _seed_tenant_id(),
                AgentSkillBranchVersion.agent_id == agent_id,
                AgentSkillBranchVersion.skill_id == skill_id,
                AgentSkillBranchVersion.version == version,
            )
        ).first()
        payload = {
            "tenant_id": _seed_tenant_id(),
            "agent_id": agent_id,
            "skill_id": skill_id,
            "source_skill_id": row.get("source_skill_id") or skill_id,
            "version": version,
            "base_version": row.get("base_version") or "1.0.0",
            "content_json": _json_object(row.get("content_json")),
            "status": row.get("status") or "active",
            "sync_state": row.get("sync_state") or "synced",
            "change_summary": row.get("change_summary"),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
        else:
            session.add(AgentSkillBranchVersion(id=str(row.get("id") or ""), **payload))


def _seed_knowledge_branches(
    session: Session, binding_rows: Iterable[JsonDict], id_maps: dict[str, dict[str, str]]
) -> None:
    for row in binding_rows:
        if row.get("resource_type") != "knowledge_base":
            continue
        agent_id = id_maps["agent"].get(str(row.get("agent_id") or ""))
        kb_id = id_maps["knowledge_base"].get(str(row.get("resource_id") or ""))
        if not agent_id or not kb_id:
            continue
        kb = session.get(KnowledgeBase, kb_id)
        current_version = _knowledge_version_with_seed_content(session, kb_id, agent_id)
        if kb:
            kb_metadata = dict(kb.metadata_json or {})
            kb_metadata["current_version"] = current_version
            kb.metadata_json = kb_metadata
            kb.updated_at = utc_now()
            session.add(kb)
        existing = session.exec(
            select(AgentKnowledgeBranch).where(
                AgentKnowledgeBranch.tenant_id == _seed_tenant_id(),
                AgentKnowledgeBranch.agent_id == agent_id,
                AgentKnowledgeBranch.knowledge_base_id == kb_id,
            )
        ).first()
        payload = {
            "tenant_id": _seed_tenant_id(),
            "agent_id": agent_id,
            "knowledge_base_id": kb_id,
            "base_version": current_version,
            "head_version": current_version,
            "status": "active",
            "sync_state": "synced",
            "metadata_json": agent_private_metadata(agent_id, _seed_metadata(row.get("metadata_json"))),
        }
        if existing:
            _apply_payload(existing, payload)
            existing.updated_at = utc_now()
            session.add(existing)
        else:
            branch_id = (
                "template_"
                + uuid5(
                    NAMESPACE_URL,
                    f"staffdeck:{_seed_tenant_id()}:knowledge-branch:{agent_id}:{kb_id}",
                ).hex
            )
            session.add(AgentKnowledgeBranch(id=branch_id, **payload))


def _knowledge_version_with_seed_content(session: Session, kb_id: str, agent_id: str) -> str:
    documents = session.exec(
        select(KnowledgeDocument).where(
            KnowledgeDocument.tenant_id == _seed_tenant_id(),
            KnowledgeDocument.knowledge_base_id == kb_id,
            KnowledgeDocument.knowledge_base_version_id != None,
        )
    ).all()
    fallback_version: str | None = None
    for document in documents:
        version = session.get(KnowledgeBaseVersion, document.knowledge_base_version_id)
        if not version:
            continue
        fallback_version = fallback_version or version.version
        if (version.metadata_json or {}).get("owner_agent_id") == agent_id:
            return version.version
        if f"branch.{agent_id}." in version.version:
            return version.version
    if fallback_version:
        return fallback_version
    kb = session.get(KnowledgeBase, kb_id)
    if kb:
        return str((kb.metadata_json or {}).get("current_version") or "1.0.0")
    return "1.0.0"


def _publish_gallery_resources(session: Session, id_maps: dict[str, dict[str, str]]) -> None:
    """Publish only dedicated templates; shared knowledge remains team-grant-only."""
    metadata = _open_gallery_seed_metadata({})
    for resource_type, model, map_key in (
        ("skill", Skill, "skill"),
        ("general_skill", GeneralSkill, "general_skill"),
        ("tool", Tool, "tool"),
        ("knowledge_base", KnowledgeBase, "knowledge_base"),
    ):
        for resource_id in set(id_maps[map_key].values()):
            resource = session.get(model, resource_id)
            if resource is None:
                continue
            if (
                resource_type == "knowledge_base"
                and getattr(resource, "mode", "dedicated") != "dedicated"
            ):
                continue
            if hasattr(resource, "metadata_json"):
                resource.metadata_json = _open_gallery_seed_metadata(getattr(resource, "metadata_json", None))
                resource.updated_at = utc_now()
                session.add(resource)
            ensure_open_gallery_binding(
                session,
                _seed_tenant_id(),
                resource_type,
                resource_id,
                "active",
                metadata_json=metadata,
            )


def _sync_seed_agents_to_current_admin(
    session: Session, id_maps: dict[str, dict[str, str]]
) -> None:
    admin = session.exec(
        select(User).where(
            User.tenant_id == _seed_tenant_id(), User.username == _seed_admin_username()
        )
    ).first()
    if not admin:
        return
    admin_metadata = {
        "owner_user_id": admin.id,
        "owner_username": admin.username,
        "owner_display_name": admin.display_name or _seed_admin_display_name(),
        "created_by_user_id": admin.id,
        "created_by_username": admin.username,
        "created_by": admin.username,
        "created_by_display_name": admin.display_name or _seed_admin_display_name(),
        "creator_name": admin.username,
    }
    for agent_id in set(id_maps["agent"].values()):
        agent = session.get(AgentProfile, agent_id)
        if agent is None:
            continue
        metadata = dict(agent.metadata_json or {})
        metadata.update(admin_metadata)
        metadata["published_to_gallery"] = True
        metadata["gallery_published_by"] = admin.username
        metadata["seed_source"] = SEED_SOURCE
        metadata["managed_by_seed"] = True
        agent.metadata_json = metadata
        agent.updated_at = utc_now()
        session.add(agent)


def _resource_ids_by_type(rows: Iterable[JsonDict]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for row in rows:
        resource_type = str(row.get("resource_type") or "")
        resource_id = str(row.get("resource_id") or "")
        if resource_type and resource_id:
            result.setdefault(resource_type, set()).add(resource_id)
    return result


def _mapped_resource_id(
    resource_type: str, source_id: str, id_maps: dict[str, dict[str, str]]
) -> str | None:
    map_key = {
        "skill": "skill",
        "general_skill": "general_skill",
        "tool": "tool",
        "knowledge_base": "knowledge_base",
    }.get(resource_type)
    if map_key is None:
        return None
    return id_maps[map_key].get(source_id)


def _agent_metadata(value: Any) -> JsonDict:
    metadata = _seed_metadata(value)
    metadata.update(
        {
            "published_to_gallery": True,
            "gallery_published_by": _seed_admin_username(),
            "seed_source": SEED_SOURCE,
            "managed_by_seed": True,
        }
    )
    metadata.pop("scope", None)
    metadata.pop("visibility", None)
    metadata.pop("owner_agent_id", None)
    metadata.pop("created_from_agent", None)
    return metadata


def _open_gallery_seed_metadata(value: Any) -> JsonDict:
    metadata = open_gallery_metadata(_seed_metadata(value))
    metadata["seed_source"] = SEED_SOURCE
    metadata["managed_by_seed"] = True
    return metadata


def _seed_metadata(value: Any) -> JsonDict:
    metadata = _json_object(value)
    metadata.update(
        {
            "owner_user_id": _seed_admin_user_id(),
            "owner_username": _seed_admin_username(),
            "owner_display_name": _seed_admin_display_name(),
            "created_by_user_id": _seed_admin_user_id(),
            "created_by_username": _seed_admin_username(),
            "created_by": _seed_admin_username(),
            "created_by_display_name": _seed_admin_display_name(),
            "creator_name": _seed_admin_username(),
        }
    )
    return metadata


def _seed_update_target(
    existing_by_id: ModelT | None,
    existing_by_key: ModelT | None,
    source_id: str,
) -> ModelT | None:
    if (
        existing_by_id is not None
        and existing_by_key is not None
        and getattr(existing_by_id, "id", None) != getattr(existing_by_key, "id", None)
    ):
        return existing_by_key if _is_seed_managed(existing_by_key, source_id) else None
    for candidate in (existing_by_id, existing_by_key):
        if candidate is not None and _is_seed_managed(candidate, source_id):
            return candidate
    return None


def _is_seed_managed(row: object, source_id: str) -> bool:
    if getattr(row, "id", None) == source_id:
        return True
    metadata = getattr(row, "metadata_json", None) or {}
    if not isinstance(metadata, dict):
        return False
    return metadata.get("seed_source") == SEED_SOURCE or metadata.get("managed_by_seed") is True


def _json_object(value: Any) -> JsonDict:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def _json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return list(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return list(parsed) if isinstance(parsed, list) else []
    return []


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip())
        except ValueError:
            return None
    return None


def _apply_payload(row: Any, payload: JsonDict) -> None:
    for key, value in payload.items():
        setattr(row, key, value)
