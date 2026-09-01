"""Central password-policy resolution and validation for system and tenant credentials."""

from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session

from app.db.models import InstallationPasswordPolicy, TenantPasswordPolicy, utc_now

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 20
SYSTEM_POLICY_SCOPE = "system"
TENANT_DEFAULT_POLICY_SCOPE = "tenant_default"


@dataclass(frozen=True, slots=True)
class PasswordPolicy:
    """Represent one validated password rule set with bounded length and optional complexity."""

    min_length: int = MIN_PASSWORD_LENGTH
    max_length: int = MAX_PASSWORD_LENGTH
    complexity_enabled: bool = False
    require_uppercase: bool = True
    require_lowercase: bool = True
    require_digit: bool = True
    require_special: bool = True


def validate_password(password: object, policy: PasswordPolicy) -> bool:
    """Return whether one raw password satisfies every enabled policy condition without mutation."""
    if not isinstance(password, str) or not policy.min_length <= len(password) <= policy.max_length:
        return False
    if not policy.complexity_enabled:
        return True
    return (
        (not policy.require_uppercase or any(character.isupper() for character in password))
        and (not policy.require_lowercase or any(character.islower() for character in password))
        and (not policy.require_digit or any(character.isdigit() for character in password))
        and (not policy.require_special or any(not character.isalnum() for character in password))
    )


def policy_from_values(
    min_length: int,
    max_length: int,
    complexity_enabled: bool,
    require_uppercase: bool,
    require_lowercase: bool,
    require_digit: bool,
    require_special: bool,
) -> PasswordPolicy:
    """Construct a policy only when its persisted or requested bounds and flags are safe."""
    if (
        not isinstance(min_length, int)
        or isinstance(min_length, bool)
        or not isinstance(max_length, int)
        or isinstance(max_length, bool)
        or not MIN_PASSWORD_LENGTH <= min_length <= max_length <= MAX_PASSWORD_LENGTH
        or any(
            not isinstance(flag, bool)
            for flag in (
                complexity_enabled,
                require_uppercase,
                require_lowercase,
                require_digit,
                require_special,
            )
        )
    ):
        raise ValueError("invalid password policy")
    return PasswordPolicy(
        min_length=min_length,
        max_length=max_length,
        complexity_enabled=complexity_enabled,
        require_uppercase=require_uppercase,
        require_lowercase=require_lowercase,
        require_digit=require_digit,
        require_special=require_special,
    )


def installation_policy(db: Session, scope: str) -> PasswordPolicy:
    """Resolve a durable installation policy, falling back to the approved development default."""
    record = db.get(InstallationPasswordPolicy, scope)
    if record is None:
        return PasswordPolicy()
    return policy_from_values(
        record.min_length,
        record.max_length,
        record.complexity_enabled,
        record.require_uppercase,
        record.require_lowercase,
        record.require_digit,
        record.require_special,
    )


def effective_tenant_policy(db: Session, tenant_id: str) -> PasswordPolicy:
    """Resolve one tenant override or the durable tenant-default policy without changing records."""
    record = db.get(TenantPasswordPolicy, tenant_id)
    if record is None or record.mode == "inherit":
        return installation_policy(db, TENANT_DEFAULT_POLICY_SCOPE)
    if record.mode != "custom" or None in (
        record.min_length,
        record.max_length,
        record.complexity_enabled,
        record.require_uppercase,
        record.require_lowercase,
        record.require_digit,
        record.require_special,
    ):
        raise ValueError("invalid tenant password policy")
    return policy_from_values(
        record.min_length,
        record.max_length,
        record.complexity_enabled,
        record.require_uppercase,
        record.require_lowercase,
        record.require_digit,
        record.require_special,
    )


def save_installation_policy(db: Session, scope: str, policy: PasswordPolicy) -> PasswordPolicy:
    """Persist one validated installation policy in the caller transaction and return its value."""
    record = db.get(InstallationPasswordPolicy, scope) or InstallationPasswordPolicy(scope=scope)
    _apply_policy(record, policy)
    db.add(record)
    return policy


def save_tenant_policy(
    db: Session, tenant_id: str, mode: str, custom: PasswordPolicy | None
) -> PasswordPolicy:
    """Persist tenant inheritance or a complete custom override and return the effective rules."""
    if (
        mode not in {"inherit", "custom"}
        or (mode == "custom" and custom is None)
        or (mode == "inherit" and custom is not None)
    ):
        raise ValueError("invalid tenant password policy")
    record = db.get(TenantPasswordPolicy, tenant_id) or TenantPasswordPolicy(tenant_id=tenant_id)
    record.mode = mode
    if custom is None:
        record.min_length = None
        record.max_length = None
        record.complexity_enabled = None
        record.require_uppercase = None
        record.require_lowercase = None
        record.require_digit = None
        record.require_special = None
    else:
        _apply_policy(record, custom)
    record.updated_at = utc_now()
    db.add(record)
    return custom if custom is not None else installation_policy(db, TENANT_DEFAULT_POLICY_SCOPE)


def _apply_policy(record: object, policy: PasswordPolicy) -> None:
    """Copy one complete policy to a mutable persistence record without committing the session."""
    record.min_length = policy.min_length
    record.max_length = policy.max_length
    record.complexity_enabled = policy.complexity_enabled
    record.require_uppercase = policy.require_uppercase
    record.require_lowercase = policy.require_lowercase
    record.require_digit = policy.require_digit
    record.require_special = policy.require_special
    record.updated_at = utc_now()


__all__ = [
    "MAX_PASSWORD_LENGTH",
    "MIN_PASSWORD_LENGTH",
    "SYSTEM_POLICY_SCOPE",
    "TENANT_DEFAULT_POLICY_SCOPE",
    "PasswordPolicy",
    "effective_tenant_policy",
    "installation_policy",
    "policy_from_values",
    "save_installation_policy",
    "save_tenant_policy",
    "validate_password",
]
