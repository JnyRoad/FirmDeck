"""Stage normalized WeChat客服 messages into the durable replay inbox.

The callback/API layer supplies a binding generation and account scope. This module validates
those immutable fences, persists one replay envelope, and performs no Agent execution.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any

from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlmodel import Session, select

from app.channels.adapters.base import ChannelInbound, ChannelInboundAttachment
from app.channels.service_durable_inbox import (
    StageDisposition,
    StageResult,
    channel_ingress_language_context,
)
from app.db.models import ChannelBinding, ChannelInboundEvent, WeChatKfAccount, new_id

ENVELOPE_VERSION = 1
MAX_ENVELOPE_BYTES = 256 * 1024


def encode_replay_envelope(
    inbound: ChannelInbound, *, account_scope: str
) -> dict[str, Any]:
    """Serialize one normalized message with the immutable provider account scope."""
    return {
        "schema_version": ENVELOPE_VERSION,
        "account": {"scope": account_scope.strip()},
        "inbound": asdict(inbound),
    }


def decode_replay_envelope(payload: object) -> ChannelInbound:
    """Restore a typed WeChat客服 message from a versioned, scope-bound replay envelope.

    The function has no side effects. Unknown fields, malformed attachments, wrong channels, and
    missing or inconsistent account scopes raise stable ``ValueError`` codes before replay.
    """
    if not isinstance(payload, dict) or payload.get("schema_version") != ENVELOPE_VERSION:
        raise ValueError("unsupported_envelope_version")
    account = payload.get("account")
    account_scope = (
        str(account.get("scope") or "").strip() if isinstance(account, dict) else ""
    )
    if not account_scope:
        raise ValueError("invalid_envelope_account")
    normalized = payload.get("inbound")
    allowed_fields = set(ChannelInbound.__dataclass_fields__)
    if not isinstance(normalized, dict) or not set(normalized) <= allowed_fields:
        raise ValueError("invalid_envelope_inbound")
    raw_attachments = normalized.get("attachments") or []
    if not isinstance(raw_attachments, list) or any(
        not isinstance(attachment, dict) for attachment in raw_attachments
    ):
        raise ValueError("invalid_envelope_attachments")
    try:
        normalized_copy = dict(normalized)
        normalized_copy["attachments"] = [
            ChannelInboundAttachment(**attachment) for attachment in raw_attachments
        ]
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid_envelope_attachments") from exc
    try:
        inbound = ChannelInbound(**normalized_copy)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid_envelope_inbound") from exc
    if inbound.channel != "wechat_kf":
        raise ValueError("invalid_envelope_channel")
    if inbound.account_scope != account_scope:
        raise ValueError("invalid_envelope_account")
    return inbound


def _expected_account_scope(binding: ChannelBinding, inbound: ChannelInbound) -> str:
    """Derive the current account scope for the message's target客服 account."""
    from app.channels.service_identity import external_account_scope

    corp_id = str((binding.config_json or {}).get("corp_id") or "").strip()
    if corp_id and inbound.to_user_id:
        return f"{corp_id}:{inbound.to_user_id}"
    return external_account_scope(None, binding)


def stage_wechat_kf_inbound(
    *,
    db_engine,
    binding_id: str,
    expected_revision: int,
    account_scope: str,
    inbound: ChannelInbound,
) -> StageResult:
    """Persist one normalized message after binding, revision, tenant, and account fences.

    A staged event is committed before the caller acknowledges the provider. Duplicate delivery
    returns the first event identifier. Invalid identity/payload/fences are safe security drops;
    database failures return ``NACK`` so the provider may retry.
    """
    normalized_scope = account_scope.strip()
    if (
        inbound.channel != "wechat_kf"
        or not inbound.event_id
        or not inbound.to_user_id
        or not normalized_scope
        or inbound.account_scope != normalized_scope
    ):
        return StageResult(StageDisposition.SECURITY_DROP, error_code="invalid_event_identity")

    # Serialize and bound the complete replay envelope before opening a database transaction.
    envelope = encode_replay_envelope(inbound, account_scope=normalized_scope)
    try:
        encoded_size = len(
            json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
    except (TypeError, ValueError):
        return StageResult(StageDisposition.SECURITY_DROP, error_code="invalid_event_payload")
    if encoded_size > MAX_ENVELOPE_BYTES:
        return StageResult(StageDisposition.SECURITY_DROP, error_code="event_payload_too_large")

    try:
        with Session(db_engine) as db:
            # Re-read mutable binding state inside the write transaction before trusting callback data.
            binding = db.get(ChannelBinding, binding_id)
            if (
                not binding
                or binding.channel != "wechat_kf"
                or binding.status != "active"
                or binding.config_revision != expected_revision
                or _expected_account_scope(binding, inbound) != normalized_scope
            ):
                return StageResult(
                    StageDisposition.SECURITY_DROP,
                    error_code="binding_fence_mismatch",
                )

            # Require an active routing row owned by the same tenant and binding as the callback.
            account = db.exec(
                select(WeChatKfAccount).where(
                    WeChatKfAccount.tenant_id == binding.tenant_id,
                    WeChatKfAccount.binding_id == binding.id,
                    WeChatKfAccount.open_kfid == inbound.to_user_id,
                    WeChatKfAccount.status == "active",
                )
            ).first()
            if not account:
                return StageResult(
                    StageDisposition.SECURITY_DROP,
                    error_code="account_fence_mismatch",
                )

            # Persist raw replay data, outbound target, generation, and language snapshot atomically.
            event = ChannelInboundEvent(
                id=new_id("chevt"),
                tenant_id=binding.tenant_id,
                binding_id=binding.id,
                channel="wechat_kf",
                event_id=inbound.event_id,
                payload_json=envelope,
                config_revision=expected_revision,
                target_json={
                    "to_user_id": inbound.from_user_id,
                    "open_kfid": inbound.to_user_id,
                },
                status="received",
                language_context_json=channel_ingress_language_context(binding).model_dump(
                    mode="json"
                ),
            )
            db.add(event)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                existing = db.exec(
                    select(ChannelInboundEvent).where(
                        ChannelInboundEvent.binding_id == binding_id,
                        ChannelInboundEvent.event_id == inbound.event_id,
                    )
                ).first()
                if existing:
                    return StageResult(StageDisposition.DUPLICATE, event_pk=existing.id)
                return StageResult(
                    StageDisposition.NACK,
                    error_code="inbox_integrity_error",
                )
            return StageResult(StageDisposition.STAGED, event_pk=event.id)
    except SQLAlchemyError:
        return StageResult(StageDisposition.NACK, error_code="inbox_database_error")
