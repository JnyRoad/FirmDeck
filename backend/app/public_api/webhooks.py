from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import and_, or_, update
from sqlmodel import Session, select

from app.async_jobs import enqueue_async_job
from app.config import get_settings
from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.projections import project_public_error_payload
from app.db import engine, get_session
from app.db.models import (
    APICredential,
    Tenant,
    WebhookDelivery,
    WebhookEndpoint,
    new_id,
    utc_now,
)
from app.public_api.auth import PublicPrincipal, require_scopes
from app.public_api.errors import PublicAPIError
from app.public_api.schemas import WebhookCreate, WebhookRead
from app.security.encryption import decrypt_secret, encrypt_secret
from app.security.tenant import (
    TenantLifecycleDecision,
    TenantLifecycleDenied,
    require_active_tenant,
    require_matching_admission_version,
)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
logger = logging.getLogger(__name__)


def _read(row: WebhookEndpoint) -> WebhookRead:
    return WebhookRead(
        id=row.id,
        name=row.name,
        url=row.url,
        events=list(row.events_json or []),
        status=row.status,
        secret_masked="whsec_********",
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _validate_webhook_url(raw: str) -> str:
    parsed = urlsplit(raw.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise PublicAPIError(422, "WEBHOOK_URL_INVALID", "Webhook URL must be HTTP or HTTPS.")
    if parsed.username or parsed.password or parsed.fragment:
        raise PublicAPIError(422, "WEBHOOK_URL_INVALID", "Webhook URL contains forbidden parts.")
    return raw.strip()


def _require_webhook_lifecycle(
    db: Session,
    delivery: WebhookDelivery,
) -> TenantLifecycleDecision:
    """Require the delivery tenant to remain active at its admitted version."""
    decision = require_active_tenant(
        db,
        tenant_id=delivery.tenant_id,
        execution_kind="channel.delivery",
        correlation_id=delivery.id,
    )
    return require_matching_admission_version(
        decision,
        delivery.tenant_lifecycle_version,
    )


def _require_tenant_admission(
    db: Session,
    tenant_id: str,
    *,
    correlation_id: str,
) -> TenantLifecycleDecision:
    """Read one active tenant decision before creating a webhook-owned durable row."""
    return require_active_tenant(
        db,
        tenant_id=tenant_id,
        execution_kind="channel.delivery",
        correlation_id=correlation_id,
    )


@router.get("", response_model=list[WebhookRead])
def list_webhooks(
    principal: PublicPrincipal = Depends(require_scopes("webhooks:read")),
    db: Session = Depends(get_session),
) -> list[WebhookRead]:
    if not principal.client_id:
        return []
    rows = db.exec(
        select(WebhookEndpoint)
        .where(
            WebhookEndpoint.tenant_id == principal.tenant_id,
            WebhookEndpoint.client_id == principal.client_id,
        )
        .order_by(WebhookEndpoint.created_at.desc())
    ).all()
    return [_read(row) for row in rows]


@router.post("", response_model=dict, status_code=201)
def create_webhook(
    request: WebhookCreate,
    principal: PublicPrincipal = Depends(require_scopes("webhooks:write")),
    db: Session = Depends(get_session),
) -> dict:
    if not principal.client_id or principal.agent_id:
        raise PublicAPIError(403, "TENANT_KEY_REQUIRED", "A tenant key is required.")
    secret = f"whsec_{secrets.token_urlsafe(32)}"
    row = WebhookEndpoint(
        tenant_id=principal.tenant_id,
        client_id=principal.client_id,
        name=request.name.strip(),
        url=_validate_webhook_url(str(request.url)),
        secret_encrypted=encrypt_secret(secret),
        events_json=sorted(set(request.events)),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {**_read(row).model_dump(mode="json"), "secret": secret}


@router.post("/{endpoint_id}:pause", response_model=WebhookRead)
def pause_webhook(
    endpoint_id: str,
    principal: PublicPrincipal = Depends(require_scopes("webhooks:write")),
    db: Session = Depends(get_session),
) -> WebhookRead:
    row = _owned_endpoint(db, principal, endpoint_id)
    row.status = "paused"
    row.updated_at = utc_now()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _read(row)


@router.patch("/{endpoint_id}", response_model=WebhookRead)
def update_webhook(
    endpoint_id: str,
    request: WebhookCreate,
    principal: PublicPrincipal = Depends(require_scopes("webhooks:write")),
    db: Session = Depends(get_session),
) -> WebhookRead:
    row = _owned_endpoint(db, principal, endpoint_id)
    row.name = request.name.strip()
    row.url = _validate_webhook_url(str(request.url))
    row.events_json = sorted(set(request.events))
    row.updated_at = utc_now()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _read(row)


@router.post("/{endpoint_id}:resume", response_model=WebhookRead)
def resume_webhook(
    endpoint_id: str,
    principal: PublicPrincipal = Depends(require_scopes("webhooks:write")),
    db: Session = Depends(get_session),
) -> WebhookRead:
    row = _owned_endpoint(db, principal, endpoint_id)
    row.status = "active"
    row.updated_at = utc_now()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _read(row)


@router.post("/{endpoint_id}:test", response_model=dict, status_code=202)
def test_webhook(
    endpoint_id: str,
    principal: PublicPrincipal = Depends(require_scopes("webhooks:write")),
    db: Session = Depends(get_session),
) -> dict:
    row = _owned_endpoint(db, principal, endpoint_id)
    admission = _require_tenant_admission(
        db,
        principal.tenant_id,
        correlation_id=new_id("webhook-test-admission"),
    )
    event_id = f"evt_test_{secrets.token_hex(12)}"
    delivery = WebhookDelivery(
        tenant_id=principal.tenant_id,
        tenant_lifecycle_version=admission.lifecycle_version,
        endpoint_id=row.id,
        event_id=event_id,
        event_type="webhook.test",
        payload_json={
            "id": event_id,
            "type": "webhook.test",
            "created_at": utc_now().isoformat() + "Z",
            "data": {"endpoint_id": row.id},
        },
        next_attempt_at=utc_now(),
    )
    db.add(delivery)
    db.commit()
    db.refresh(delivery)
    enqueue_webhook_deliveries([delivery.id])
    return {"delivery_id": delivery.id, "event_id": event_id, "status": delivery.status}


@router.delete("/{endpoint_id}", status_code=204)
def delete_webhook(
    endpoint_id: str,
    principal: PublicPrincipal = Depends(require_scopes("webhooks:write")),
    db: Session = Depends(get_session),
) -> None:
    row = _owned_endpoint(db, principal, endpoint_id)
    db.delete(row)
    db.commit()


@router.get("/{endpoint_id}/deliveries", response_model=list[dict])
def list_webhook_deliveries(
    endpoint_id: str,
    principal: PublicPrincipal = Depends(require_scopes("webhooks:read")),
    db: Session = Depends(get_session),
) -> list[dict]:
    """Return delivery audit rows with canonical errors and no persisted exception prose."""
    _owned_endpoint(db, principal, endpoint_id)
    rows = db.exec(
        select(WebhookDelivery)
        .where(WebhookDelivery.endpoint_id == endpoint_id)
        .order_by(WebhookDelivery.created_at.desc())
        .limit(100)
    ).all()
    deliveries: list[dict[str, object]] = []
    for row in rows:
        error = _delivery_error(row)
        deliveries.append(
            {
                "id": row.id,
                "event_id": row.event_id,
                "event_type": row.event_type,
                "status": row.status,
                "attempt_count": row.attempt_count,
                "last_status_code": row.last_status_code,
                "last_error": error.get("code") if row.last_error else None,
                "error": error,
                "created_at": row.created_at,
                "delivered_at": row.delivered_at,
            }
        )
    return deliveries


def _owned_endpoint(
    db: Session, principal: PublicPrincipal, endpoint_id: str
) -> WebhookEndpoint:
    row = db.get(WebhookEndpoint, endpoint_id)
    if (
        not row
        or row.tenant_id != principal.tenant_id
        or row.client_id != principal.client_id
    ):
        raise PublicAPIError(404, "WEBHOOK_NOT_FOUND", "Webhook endpoint not found.")
    return row


def event_matches(patterns: list[str], event_type: str) -> bool:
    for pattern in patterns:
        if pattern == "*" or pattern == event_type:
            return True
        if pattern.endswith(".*") and event_type.startswith(pattern[:-1]):
            return True
    return False


def stage_webhook_deliveries(
    db: Session,
    *,
    tenant_id: str,
    admission_version: int | None = None,
    credential_id: str,
    event_id: str,
    event_type: str,
    payload: dict,
    commit: bool = True,
) -> list[str]:
    """Stage matching deliveries and optionally commit a standalone admission transaction.

    Public job event publication passes ``commit=False`` so event and delivery rows
    share one unit of work.  Direct callers use the default standalone commit.
    """
    credential = db.get(APICredential, credential_id)
    if not credential:
        return []
    try:
        admission = _require_tenant_admission(
            db,
            tenant_id,
            correlation_id=new_id("webhook-admission"),
        )
        if admission_version is not None:
            require_matching_admission_version(admission, admission_version)
    except TenantLifecycleDenied:
        # Event publication must remain durable even when suspension suppresses its delivery.
        if commit:
            db.rollback()
        return []
    endpoints = db.exec(
        select(WebhookEndpoint).where(
            WebhookEndpoint.tenant_id == tenant_id,
            WebhookEndpoint.client_id == credential.client_id,
            WebhookEndpoint.status == "active",
        )
    ).all()
    delivery_ids: list[str] = []
    for endpoint in endpoints:
        if not event_matches(list(endpoint.events_json or []), event_type):
            continue
        delivery = WebhookDelivery(
            tenant_id=tenant_id,
            tenant_lifecycle_version=admission.lifecycle_version,
            endpoint_id=endpoint.id,
            event_id=event_id,
            event_type=event_type,
            payload_json=payload,
            next_attempt_at=utc_now(),
        )
        db.add(delivery)
        db.flush()
        delivery_ids.append(delivery.id)
    if commit:
        db.commit()
    return delivery_ids


def enqueue_webhook_deliveries(delivery_ids: list[str]) -> None:
    for delivery_id in delivery_ids:
        enqueue_async_job("public_api.webhook", deliver_webhook, delivery_id)


def _terminalize_delivery_lifecycle_denial(
    db: Session,
    delivery: WebhookDelivery,
    owner: str,
    denial: TenantLifecycleDenied,
) -> bool:
    """Abandon one claimed delivery after a lifecycle denial without scheduling a retry."""
    terminal_values: dict[str, object] = {
        "status": "abandoned",
        "next_attempt_at": None,
        "last_error": denial.code,
        "delivered_at": None,
        "delivery_owner": None,
        "lease_expires_at": None,
        "updated_at": utc_now(),
    }
    # Preserve first-class lifecycle evidence when a newer schema provides it;
    # current pre-migration rows retain the same stable evidence in last_error.
    if hasattr(WebhookDelivery, "terminal_reason"):
        terminal_values["terminal_reason"] = denial.code
    if hasattr(WebhookDelivery, "outcome_unknown"):
        terminal_values["outcome_unknown"] = False
    result = db.exec(
        update(WebhookDelivery)
        .where(
            WebhookDelivery.id == delivery.id,
            WebhookDelivery.status == "sending",
            WebhookDelivery.delivery_owner == owner,
        )
        .values(**terminal_values)
        .execution_options(synchronize_session=False)
    )
    if getattr(result, "rowcount", 0) != 1:
        db.rollback()
        return False
    db.commit()
    return True


def _terminalize_expired_sending_delivery(
    db: Session,
    delivery: WebhookDelivery,
    *,
    now: datetime | None = None,
) -> bool:
    """Recover an expired sending lease as terminal unknown work, never as a retry.

    Once a receiver request may have started, a lease expiry cannot establish that the
    receiver did not accept it.  Startup or duplicate-worker recovery therefore clears
    the lease and records a non-retryable outcome.  A concurrent lifecycle denial wins
    the terminal reason while retaining the same unknown-outcome evidence.
    """
    recovery_at = now or utc_now()
    delivery_id = delivery.id
    admission_version = delivery.tenant_lifecycle_version
    terminal_reason = "EXTERNAL_OUTCOME_UNKNOWN"
    try:
        _require_webhook_lifecycle(db, delivery)
    except TenantLifecycleDenied as denial:
        db.rollback()
        terminal_reason = denial.code
    else:
        db.rollback()

    terminal_values: dict[str, object] = {
        "status": "abandoned",
        "next_attempt_at": None,
        "last_error": terminal_reason,
        "delivered_at": None,
        "delivery_owner": None,
        "lease_expires_at": None,
        "updated_at": recovery_at,
    }
    if hasattr(WebhookDelivery, "terminal_reason"):
        terminal_values["terminal_reason"] = terminal_reason
    if hasattr(WebhookDelivery, "outcome_unknown"):
        terminal_values["outcome_unknown"] = True
    result = db.exec(
        update(WebhookDelivery)
        .where(
            WebhookDelivery.id == delivery_id,
            WebhookDelivery.status == "sending",
            WebhookDelivery.tenant_lifecycle_version == admission_version,
            WebhookDelivery.lease_expires_at.is_not(None),
            WebhookDelivery.lease_expires_at <= recovery_at,
        )
        .values(**terminal_values)
        .execution_options(synchronize_session=False)
    )
    if getattr(result, "rowcount", 0) != 1:
        db.rollback()
        return False
    db.commit()
    return True


def deliver_webhook(delivery_id: str) -> None:
    """Deliver one leased webhook and retain only canonical retry metadata on failure."""
    with Session(engine) as db:
        owner = f"whlease_{secrets.token_hex(12)}"
        now = utc_now()
        existing = db.get(WebhookDelivery, delivery_id)
        if (
            existing is not None
            and existing.status == "sending"
            and existing.lease_expires_at is not None
            and existing.lease_expires_at <= now
        ):
            # An expired in-flight request has an unknown remote outcome.  It must
            # be terminalized before any new claim can be considered.
            _terminalize_expired_sending_delivery(db, existing, now=now)
            return
        claim = db.exec(
            update(WebhookDelivery)
            .where(
                WebhookDelivery.id == delivery_id,
                WebhookDelivery.status.in_(["queued", "retrying"]),
                or_(
                    WebhookDelivery.next_attempt_at.is_(None),
                    WebhookDelivery.next_attempt_at <= now,
                ),
                or_(
                    WebhookDelivery.lease_expires_at.is_(None),
                    WebhookDelivery.lease_expires_at <= now,
                ),
            )
            .values(
                status="sending",
                delivery_owner=owner,
                lease_expires_at=now
                + timedelta(seconds=get_settings().public_api_webhook_timeout_seconds + 30),
                updated_at=now,
            )
            .execution_options(synchronize_session=False)
        )
        if getattr(claim, "rowcount", 0) != 1:
            db.rollback()
            return
        db.commit()
        delivery = db.get(WebhookDelivery, delivery_id)
        if delivery is None:
            return
        # Recheck after the lease commit before reading secrets or preparing a receiver call.
        try:
            _require_webhook_lifecycle(db, delivery)
        except TenantLifecycleDenied as denial:
            db.rollback()
            _terminalize_delivery_lifecycle_denial(db, delivery, owner, denial)
            return
        db.rollback()
        endpoint = db.get(WebhookEndpoint, delivery.endpoint_id)
        if not endpoint or endpoint.status != "active":
            _finish_webhook_delivery(
                db,
                delivery,
                owner,
                {
                    "status": "abandoned",
                    "last_error": "INTERNAL_ERROR",
                    "next_attempt_at": None,
                },
            )
            return
        body = json.dumps(delivery.payload_json, ensure_ascii=False, separators=(",", ":"))
        attempt_count = delivery.attempt_count + 1
        endpoint_url = endpoint.url
        event_id = delivery.event_id
        timestamp = str(int(datetime_now_timestamp()))
        signature = hmac.new(
            decrypt_secret(endpoint.secret_encrypted).encode("utf-8"),
                f"{timestamp}.{body}".encode(),
            hashlib.sha256,
        ).hexdigest()
        # Endpoint lookup opened a read transaction. Close it before the final lifecycle
        # decision so a suspension committed after the lookup cannot be hidden by the
        # endpoint-read snapshot.
        db.rollback()
        try:
            _require_webhook_lifecycle(db, delivery)
        except TenantLifecycleDenied as denial:
            db.rollback()
            _terminalize_delivery_lifecycle_denial(db, delivery, owner, denial)
            return
        # The rollback expires ORM state, so copy every value needed by the
        # network call first.  No attribute access that could refresh the row is
        # allowed between this point and httpx.post.
        # The final check is intentionally adjacent to the network call; no transaction spans it.
        db.rollback()
        side_effect_started = False
        try:
            side_effect_started = True
            response = httpx.post(
                endpoint_url,
                content=body.encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "X-FirmDeck-Event-ID": event_id,
                    "X-FirmDeck-Timestamp": timestamp,
                    "X-FirmDeck-Signature": f"v1={signature}",
                },
                timeout=get_settings().public_api_webhook_timeout_seconds,
            )
            delivery.attempt_count = attempt_count
            delivery.last_status_code = response.status_code
            if 200 <= response.status_code < 300:
                delivery.status = "delivered"
                delivery.delivered_at = utc_now()
                delivery.last_error = None
            else:
                _schedule_retry(delivery, f"HTTP {response.status_code}")
        except Exception as exc:
            logger.exception("webhook delivery failed delivery_id=%s", delivery.id)
            delivery.attempt_count = attempt_count
            _schedule_retry(delivery, str(exc))
        _finish_webhook_delivery(
            db,
            delivery,
            owner,
            {
                "status": delivery.status,
                "attempt_count": delivery.attempt_count,
                "next_attempt_at": delivery.next_attempt_at,
                "last_status_code": delivery.last_status_code,
                "last_error": delivery.last_error,
                "delivered_at": delivery.delivered_at,
            },
            outcome_unknown=side_effect_started,
        )


def _finish_webhook_delivery(
    db: Session,
    delivery: WebhookDelivery,
    owner: str,
    values: dict[str, object],
    *,
    outcome_unknown: bool = False,
) -> bool:
    """Fence completion against owner, generation, and the current tenant lifecycle state.

    A denied post-call completion is terminalized as abandoned with no next retry.  The
    caller supplies ``outcome_unknown`` when the receiver request has already started;
    the flag is retained in the safe internal error evidence where the row has no
    dedicated outcome column.
    """

    # A network call may have changed the tenant in another transaction.  Discard any
    # uncommitted response bookkeeping before reading the authoritative lifecycle row.
    db.rollback()
    try:
        decision = _require_webhook_lifecycle(db, delivery)
    except TenantLifecycleDenied as denial:
        db.rollback()
        denied_values = {
            "status": "abandoned",
            "next_attempt_at": None,
            "last_error": denial.code,
            "delivered_at": None,
            "delivery_owner": None,
            "lease_expires_at": None,
            "updated_at": utc_now(),
        }
        if outcome_unknown:
            # WebhookDelivery predates a separate outcome column; the stable code and
            # cleared retry timestamp are the durable, non-sensitive terminal evidence.
            denied_values["last_status_code"] = values.get("last_status_code")
        if hasattr(WebhookDelivery, "terminal_reason"):
            denied_values["terminal_reason"] = denial.code
        if hasattr(WebhookDelivery, "outcome_unknown"):
            denied_values["outcome_unknown"] = outcome_unknown
        result = db.exec(
            update(WebhookDelivery)
            .where(
                WebhookDelivery.id == delivery.id,
                WebhookDelivery.status == "sending",
                WebhookDelivery.delivery_owner == owner,
            )
            .values(**denied_values)
            .execution_options(synchronize_session=False)
        )
        if getattr(result, "rowcount", 0) != 1:
            db.rollback()
            return False
        db.commit()
        return False

    # The lifecycle read above is a separate decision boundary.  Close its read
    # transaction before the correlated completion UPDATE so the predicate below
    # evaluates the latest tenant status/version rather than that old snapshot.
    db.rollback()
    result = db.exec(
        update(WebhookDelivery)
        .where(
            WebhookDelivery.id == delivery.id,
            WebhookDelivery.status == "sending",
            WebhookDelivery.delivery_owner == owner,
            WebhookDelivery.tenant_lifecycle_version == decision.lifecycle_version,
            select(Tenant.id)
            .where(
                Tenant.id == WebhookDelivery.tenant_id,
                Tenant.status == "active",
                Tenant.lifecycle_version == WebhookDelivery.tenant_lifecycle_version,
            )
            .exists(),
        )
        .values(
            **values,
            delivery_owner=None,
            lease_expires_at=None,
            updated_at=utc_now(),
        )
        .execution_options(synchronize_session=False)
    )
    if getattr(result, "rowcount", 0) != 1:
        db.rollback()
        current = db.get(WebhookDelivery, delivery.id)
        if (
            current is not None
            and current.status == "sending"
            and current.delivery_owner == owner
        ):
            try:
                _require_webhook_lifecycle(db, current)
            except TenantLifecycleDenied as denial:
                db.rollback()
                _terminalize_delivery_lifecycle_denial(db, current, owner, denial)
        return False
    db.commit()
    return True


def _delivery_error(delivery: WebhookDelivery) -> dict[str, object]:
    """Project one stored webhook error and preserve request/trace linkage from its event payload."""
    if not delivery.last_error:
        return {}
    payload_data = delivery.payload_json.get("data") if isinstance(delivery.payload_json, dict) else None
    payload_data = payload_data if isinstance(payload_data, dict) else {}
    request_id = payload_data.get("request_id")
    trace_id = payload_data.get("trace_id")
    return project_public_error_payload(
        {
            "code": delivery.last_error,
            "retryable": delivery.status == "retrying",
        },
        ERROR_REGISTRY,
        source="public-api-webhook-delivery",
        default_retryable=delivery.status == "retrying",
        request_id=request_id if isinstance(request_id, str) else None,
        trace_id=trace_id if isinstance(trace_id, str) else None,
    )


def _schedule_retry(delivery: WebhookDelivery, error: object) -> None:
    """Persist only a stable error code before scheduling a webhook retry."""
    candidate = error if isinstance(error, dict) else {"message": str(error)}
    projected = project_public_error_payload(
        candidate,
        ERROR_REGISTRY,
        source="public-api-webhook-retry",
        default_retryable=True,
    )
    delivery.last_error = str(projected["code"])
    if delivery.attempt_count >= get_settings().public_api_webhook_max_attempts:
        delivery.status = "abandoned"
        delivery.next_attempt_at = None
        return
    delay_seconds = min(8 * 60 * 60, 60 * (5 ** max(0, delivery.attempt_count - 1)))
    delivery.status = "retrying"
    delivery.next_attempt_at = utc_now() + timedelta(seconds=delay_seconds)


def datetime_now_timestamp() -> int:
    return int(datetime.now(UTC).timestamp())


def enqueue_due_webhook_deliveries() -> None:
    with Session(engine) as db:
        now = utc_now()
        rows = db.exec(
            select(WebhookDelivery).where(
                or_(
                    and_(
                        WebhookDelivery.status.in_(  # type: ignore[attr-defined]
                            ["queued", "retrying"]
                        ),
                        WebhookDelivery.next_attempt_at <= now,
                    ),
                    and_(
                        WebhookDelivery.status == "sending",
                        WebhookDelivery.lease_expires_at.is_not(None),
                        WebhookDelivery.lease_expires_at <= now,
                    ),
                )
            )
        ).all()
        dispatchable: list[str] = []
        for row in rows:
            if row.status == "sending":
                # The request may already have reached the receiver; recovery is
                # terminal and deliberately never re-enqueues this delivery.
                _terminalize_expired_sending_delivery(db, row, now=now)
                continue
            try:
                _require_webhook_lifecycle(db, row)
            except TenantLifecycleDenied as denial:
                db.rollback()
                # Recovery is discovery only: stale/suspended rows become terminal and
                # are never made eligible again by a later reactivation.
                terminal_values: dict[str, object] = {
                    "status": "abandoned",
                    "next_attempt_at": None,
                    "last_error": denial.code,
                    "delivery_owner": None,
                    "lease_expires_at": None,
                    "delivered_at": None,
                    "updated_at": utc_now(),
                }
                if hasattr(WebhookDelivery, "terminal_reason"):
                    terminal_values["terminal_reason"] = denial.code
                if hasattr(WebhookDelivery, "outcome_unknown"):
                    terminal_values["outcome_unknown"] = False
                db.exec(
                    update(WebhookDelivery)
                    .where(
                        WebhookDelivery.id == row.id,
                        WebhookDelivery.status.in_(["queued", "retrying"]),
                        WebhookDelivery.tenant_lifecycle_version
                        == row.tenant_lifecycle_version,
                    )
                    .values(**terminal_values)
                    .execution_options(synchronize_session=False)
                )
                continue
            dispatchable.append(row.id)
        db.commit()
    enqueue_webhook_deliveries(dispatchable)
