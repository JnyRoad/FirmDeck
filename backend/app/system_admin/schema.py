"""Strict request and response models for the installation-scoped control plane."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _StrictModel(BaseModel):
    """Reject fields outside the public control-plane contract."""

    model_config = ConfigDict(extra="forbid")


class SystemLoginRequest(_StrictModel):
    """Carry only the system login identifier and password supplied by the operator."""

    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1)


class SystemAdminRead(_StrictModel):
    """Expose the non-secret identity fields of one installation administrator."""

    id: str
    username: str
    display_name: str | None = None
    status: Literal["active", "disabled"]
    must_change_password: bool
    last_login_at: datetime | None = None
    created_at: datetime


class SystemLoginResponse(_StrictModel):
    """Return a dedicated system token and its safe administrator projection."""

    token: str
    scope: Literal["system"] = "system"
    system_admin: SystemAdminRead


class PasswordPolicy(_StrictModel):
    """Expose or accept one bounded password policy without credential material."""

    min_length: int = Field(ge=8, le=20)
    max_length: int = Field(ge=8, le=20)
    complexity_enabled: bool
    require_uppercase: bool
    require_lowercase: bool
    require_digit: bool
    require_special: bool


class SystemPasswordChangeRequest(_StrictModel):
    """Carry the current and replacement system password at the authenticated mutation boundary."""

    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=8, max_length=20)


class SystemPasswordPoliciesRead(_StrictModel):
    """Return the independent system and default-tenant password policies."""

    system: PasswordPolicy
    tenant_default: PasswordPolicy


class SystemPasswordPoliciesUpdate(SystemPasswordPoliciesRead):
    """Accept a full replacement for both installation password-policy scopes."""


class TenantPasswordPolicyRead(_StrictModel):
    """Return a tenant's inheritance mode, custom value, and resolved effective policy."""

    mode: Literal["inherit", "custom"]
    custom: PasswordPolicy | None = None
    effective: PasswordPolicy


class TenantPasswordPolicyUpdate(_StrictModel):
    """Accept either inheritance or a complete tenant-specific password policy override."""

    mode: Literal["inherit", "custom"]
    custom: PasswordPolicy | None = None


class InitialTenantAdminRequest(_StrictModel):
    """Validate the tenant-local administrator created during provisioning."""

    username: str = Field(min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    temporary_password: str = Field(min_length=8, max_length=20)


class TenantProvisionRequest(_StrictModel):
    """Validate an immutable tenant slug, display name, and initial administrator."""

    slug: str = Field(
        pattern=r"^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$",
        min_length=3,
        max_length=63,
    )
    display_name: str = Field(min_length=1, max_length=120)
    initial_admin: InitialTenantAdminRequest


class InitialTenantAdminRead(_StrictModel):
    """Expose only safe control metadata for a tenant's initial administrator."""

    id: str
    username: str
    display_name: str | None = None
    role: Literal["admin"] = "admin"
    must_change_password: bool


class InitialTenantAdminSummary(_StrictModel):
    """Expose tenant-admin identity metadata without credential-state terminology."""

    id: str
    username: str
    display_name: str | None = None
    role: Literal["admin"] = "admin"


class TenantControlSummary(_StrictModel):
    """Expose lifecycle and identity metadata without tenant business data."""

    id: str
    slug: str
    display_name: str
    status: Literal["active", "suspended"]
    lifecycle_version: int = Field(ge=1)
    initial_admin: InitialTenantAdminSummary | None = None
    suspended_at: datetime | None = None
    reactivated_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class TenantControlDetail(TenantControlSummary):
    """Add the bounded suspension reason to one tenant control projection."""

    suspension_reason: str | None = None


class TenantProvisionDetail(TenantControlDetail):
    """Return the one-time provisioning response with the admin password-change flag."""

    initial_admin: InitialTenantAdminRead | None = None


class TenantControlPage(_StrictModel):
    """Return a bounded, metadata-only tenant page and an optional continuation cursor."""

    items: list[TenantControlSummary]
    next_cursor: str | None = None


class TenantRenameRequest(_StrictModel):
    """Carry only the mutable tenant display name for a control-plane rename."""

    display_name: str = Field(min_length=1, max_length=120)


class TenantSuspendRequest(_StrictModel):
    """Carry the bounded operator reason required before suspending a tenant."""

    reason: str = Field(min_length=1, max_length=500)


class TemporaryPasswordRequest(_StrictModel):
    """Carry an opaque policy-compliant temporary password without a response projection."""

    temporary_password: str = Field(min_length=8, max_length=20)


class SystemControlAuditRead(_StrictModel):
    """Expose one allowlisted control audit row without request or credential payloads."""

    id: str
    actor_system_admin_id: str | None = None
    actor_label: str | None = None
    action: str
    target_type: Literal["system_admin", "tenant"]
    target_id: str | None = None
    result: Literal["succeeded", "rejected", "failed"]
    reason_code: str
    operator_reason: str | None = None
    status_before: Literal["active", "suspended"] | None = None
    status_after: Literal["active", "suspended"] | None = None
    lifecycle_version: int | None = Field(default=None, ge=1)
    request_id: str | None = None
    trace_id: str | None = None
    safe_params: dict[str, object] = Field(default_factory=dict)
    created_at: datetime


class SystemControlAuditPage(_StrictModel):
    """Return a bounded tenant-control audit page and an optional continuation cursor."""

    items: list[SystemControlAuditRead]
    next_cursor: str | None = None


class SystemRuntimeStatus(_StrictModel):
    """Project installation-owned Codex runtime state without execution content or secrets."""

    key: Literal["codex_a2a"]
    enabled: bool
    credential_configured: bool
    command: str
    workspace_root: str
    timeout_seconds: float = Field(gt=0)


__all__ = [
    "InitialTenantAdminRead",
    "InitialTenantAdminRequest",
    "InitialTenantAdminSummary",
    "PasswordPolicy",
    "SystemAdminRead",
    "SystemControlAuditPage",
    "SystemControlAuditRead",
    "SystemLoginRequest",
    "SystemLoginResponse",
    "SystemPasswordChangeRequest",
    "SystemPasswordPoliciesRead",
    "SystemPasswordPoliciesUpdate",
    "SystemRuntimeStatus",
    "TemporaryPasswordRequest",
    "TenantControlDetail",
    "TenantControlPage",
    "TenantControlSummary",
    "TenantPasswordPolicyRead",
    "TenantPasswordPolicyUpdate",
    "TenantProvisionDetail",
    "TenantProvisionRequest",
    "TenantRenameRequest",
    "TenantSuspendRequest",
]
