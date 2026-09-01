from __future__ import annotations

import base64
import json
import threading
import time
import uuid
from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from pydantic import ValidationError
from sqlalchemy import update
from sqlmodel import Session, select

from app.config import get_settings
from app.contracts.error_registry import ERROR_REGISTRY, ErrorVisibility
from app.contracts.errors import (
    ErrorDescriptor,
    ErrorOccurrence,
    InternalErrorContext,
    JsonValue,
)
from app.db.models import A2ATaskEvent, A2ATaskRun, Tenant, Tool, utc_now
from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    resolve_compatible_language_context,
    resolve_language_context,
)
from app.security.tenant import (
    TenantExecutionKind,
    TenantLifecycleDecision,
    TenantLifecycleDenied,
    require_active_tenant,
    require_matching_admission_version,
)

_TERMINAL_STATES = {"completed", "failed", "canceled", "cancelled", "rejected"}
_INTERRUPTED_STATES = {"input-required", "auth-required"}
_LIFECYCLE_ERROR_CODES = {
    "TENANT_SUSPENDED",
    "TENANT_NOT_FOUND",
    "TENANT_LIFECYCLE_CHECK_FAILED",
    "TENANT_WORK_TERMINALIZED",
    "EXTERNAL_OUTCOME_UNKNOWN",
}
_RUN_LOCKS: dict[str, threading.RLock] = {}
_RUN_LOCKS_GUARD = threading.Lock()
_WORKER_LEASE_SECONDS = 15 * 60


class A2AClientError(RuntimeError):
    """A2A failure with a stable descriptor and private remote diagnostic context."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        params: dict[str, JsonValue] | None = None,
        retryable: bool = False,
        request_id: str | None = None,
        trace_id: str | None = None,
    ) -> None:
        """Capture remote prose privately while preserving stable correlation metadata."""
        super().__init__(message)
        # Workflow: resolve remote codes through the product registry before creating
        # a descriptor; unregistered remote values remain private diagnostic context.
        entry = ERROR_REGISTRY.get(code)
        safe_params = params or {}
        safe_retryable = retryable
        if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
            entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
            safe_params = {}
            safe_retryable = entry.retryable_default
        self.code = entry.code
        self.occurrence = ErrorOccurrence(
            descriptor=ErrorDescriptor(
                code=entry.code,
                params=safe_params,
                retryable=safe_retryable,
                request_id=request_id,
                trace_id=trace_id,
            ),
            internal=InternalErrorContext(
                source="a2a",
                exception_type=type(self).__name__,
                raw_message=message,
                upstream_code=code,
                upstream_request_id=request_id,
            ),
        )

    def to_public_payload(
        self,
        *,
        request_id: str | None = None,
        trace_id: str | None = None,
    ) -> dict[str, Any]:
        """Serialize canonical fields and fill boundary correlation when the provider lacks it."""
        descriptor = self.occurrence.descriptor.model_copy(
            update={
                "request_id": self.occurrence.descriptor.request_id or request_id,
                "trace_id": self.occurrence.descriptor.trace_id or trace_id,
            }
        )
        return descriptor.model_dump(mode="json")


class A2AClient:
    """A durable A2A v1 client with streaming, polling and continuation support."""

    def __init__(
        self,
        db: Session,
        tool: Tool,
        *,
        headers: dict[str, str],
        timeout_seconds: float | None = None,
        agent_id: str | None = None,
        session_id: str | None = None,
        invocation_id: str | None = None,
        language_context: LanguageContext | dict[str, Any] | None = None,
        worker_owner: str | None = None,
        worker_generation: int | None = None,
    ) -> None:
        """Bind one A2A client to an immutable locale snapshot for all sends and retries."""
        self.db = db
        self.tool = tool
        self.headers = dict(headers)
        self.config = tool.config_json if isinstance(tool.config_json, dict) else {}
        settings = get_settings()
        configured_timeout = _positive_float(
            (self.config.get("execution") or {}).get("timeout_seconds")
            if isinstance(self.config.get("execution"), dict)
            else None,
            settings.a2a_task_timeout_seconds,
        )
        self.timeout_seconds = max(
            1.0,
            min(configured_timeout, timeout_seconds)
            if timeout_seconds is not None
            else configured_timeout,
        )
        self.poll_interval = _positive_float(
            self.config.get("poll_interval_seconds"), settings.a2a_poll_interval_seconds
        )
        self.agent_id = agent_id
        self.session_id = session_id
        self.invocation_id = invocation_id
        self.language_context = _coerce_language_context(language_context)
        self.worker_owner = worker_owner
        self.worker_generation = worker_generation
        self.endpoint_url = tool.url
        self.protocol_binding = "JSONRPC"
        self.protocol_version = str(self.config.get("a2a_version") or "1.0")
        self.agent_card: dict[str, Any] = {}

    def execute(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """Execute one A2A call under the invocation lock and its bound language context."""
        lock_key = self._invocation_lock_key()
        with _run_lock(lock_key):
            return self._execute_locked(arguments)

    def _execute_locked(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """Create or resume a durable A2A run without re-resolving its locale on retries."""
        existing = self._existing_invocation()
        if existing is not None:
            return self._resume_existing(existing)
        # Check before discovery so a suspended tenant cannot contact an Agent Card endpoint.
        admission_version = self._require_new_admission()
        self._discover_agent()
        # Re-read after discovery so a concurrent lifecycle transition cannot admit a new run.
        admission_version = self._require_new_admission()
        continuation = self._continuation(arguments)
        message = self._message(arguments, continuation)
        run = A2ATaskRun(
            owner_scope="tenant",
            direction="client",
            tenant_id=self.tool.tenant_id,
            system_runtime_key=None,
            tenant_lifecycle_version=admission_version,
            tool_id=self.tool.id,
            agent_id=self.agent_id,
            session_id=self.session_id,
            invocation_id=self.invocation_id,
            endpoint_url=self.endpoint_url,
            agent_card_url=self._agent_card_url(),
            protocol_binding=self.protocol_binding,
            protocol_version=self.protocol_version,
            remote_task_id=continuation.get("task_id"),
            context_id=continuation.get("context_id"),
            status="submitted",
            request_json={"arguments": arguments, "message": message},
            agent_card_json=self.agent_card,
            language_context_json=self.language_context.model_dump(mode="json"),
            started_at=utc_now(),
        )
        self.db.add(run)
        self.db.commit()
        self.db.refresh(run)
        self._event(run, "submitted", {"message": message})

        deadline = time.monotonic() + self.timeout_seconds
        try:
            # Recheck immediately before the first outbound provider side effect.
            self._require_run_admission(run)
            result = self._send(run, message, deadline=deadline)
            return self._finalize(run, result)
        except A2AClientError as exc:
            self._persist_run_error(run, exc, event_type="failed")
            raise
        except httpx.HTTPError as exc:
            unknown = A2AClientError(
                "EXTERNAL_OUTCOME_UNKNOWN",
                str(exc),
                retryable=False,
                request_id=self.invocation_id,
                trace_id=self.session_id,
            )
            self._persist_run_error(run, unknown, event_type="failed")
            raise unknown from exc

    def _existing_invocation(self) -> A2ATaskRun | None:
        if not self.invocation_id:
            return None
        return self.db.exec(
            select(A2ATaskRun)
            .where(
                A2ATaskRun.direction == "client",
                A2ATaskRun.owner_scope == "tenant",
                A2ATaskRun.tenant_id == self.tool.tenant_id,
                A2ATaskRun.tool_id == self.tool.id,
                A2ATaskRun.invocation_id == self.invocation_id,
            )
            .order_by(A2ATaskRun.created_at.desc())
        ).first()

    def _resume_existing(self, run: A2ATaskRun) -> dict[str, Any]:
        """Restore endpoint, request and locale state from one durable outbound A2A run."""
        self.endpoint_url = run.endpoint_url or self.tool.url
        self.protocol_binding = run.protocol_binding or "JSONRPC"
        self.protocol_version = run.protocol_version or self.protocol_version
        self.agent_card = dict(run.agent_card_json or {})
        self.language_context = _coerce_language_context(run.language_context_json)
        snapshot = self.language_context.model_dump(mode="json")
        if run.language_context_json != snapshot:
            run.language_context_json = snapshot
            run.updated_at = utc_now()
            self.db.add(run)
            self.db.commit()

        if run.status in _TERMINAL_STATES | _INTERRUPTED_STATES:
            if run.status in {"failed", "rejected"}:
                error = run.error_json or {}
                raise A2AClientError(
                    str(error.get("code") or "A2A_TASK_FAILED"),
                    str(error.get("message") or f"A2A Task {run.status}。"),
                )
            if run.status in {"canceled", "cancelled"}:
                raise A2AClientError("A2A_CANCELLED", "A2A Task 已取消。")
            return self._response_from_run(run)

        request = run.request_json if isinstance(run.request_json, dict) else {}
        message = request.get("message")
        if not isinstance(message, dict):
            arguments = request.get("arguments")
            if not isinstance(arguments, dict):
                raise A2AClientError("A2A_RECOVERY_INVALID", "A2A 恢复记录缺少原始请求。")
            message = self._message(arguments, self._continuation(arguments))

        run.recovery_attempts += 1
        run.updated_at = utc_now()
        self.db.add(run)
        self.db.commit()
        self._event(
            run,
            "recovery_started",
            {"attempt": run.recovery_attempts, "task_id": run.remote_task_id},
        )
        deadline = time.monotonic() + self.timeout_seconds
        try:
            # An existing unfinished run can only resume with the exact owner admission that created it.
            self._require_run_admission(run)
            if not self.agent_card:
                # Discovery is itself a provider request, so fence it independently of later sends.
                self._require_run_admission(run)
                self._discover_agent()
                self._require_run_admission(run)
            if run.remote_task_id:
                seed = run.result_json if isinstance(run.result_json, dict) else {}
                if not _task_state(seed):
                    seed = {
                        "id": run.remote_task_id,
                        "contextId": run.context_id,
                        "status": {"state": run.status or "working"},
                    }
                result = self._wait_if_needed(run, seed, deadline=deadline)
            else:
                # Reuse the original messageId. A2A servers use it as the
                # idempotency identity when the first response was lost.
                result = self._send(run, message, deadline=deadline)
            return self._finalize(run, result)
        except A2AClientError as exc:
            self._persist_run_error(run, exc, event_type="recovery_failed")
            raise
        except httpx.HTTPError as exc:
            unknown = A2AClientError(
                "EXTERNAL_OUTCOME_UNKNOWN",
                str(exc),
                retryable=False,
                request_id=self.invocation_id,
                trace_id=self.session_id,
            )
            self._persist_run_error(run, unknown, event_type="recovery_failed")
            raise unknown from exc

    def _response_from_run(self, run: A2ATaskRun) -> dict[str, Any]:
        """Return a replay-safe response with the durable locale metadata extension."""
        task = run.result_json if isinstance(run.result_json, dict) else {}
        return {
            "a2a_run_id": run.id,
            "task_id": run.remote_task_id,
            "context_id": run.context_id,
            "state": run.status,
            "awaiting_input": run.status == "input-required",
            "task": task,
            "message": _status_message(task),
            "artifacts": list(run.artifacts_json or []),
            "metadata": _language_metadata(self.language_context),
        }

    def _require_new_admission(self) -> int:
        """Admit a new tenant-owned call and return its authoritative lifecycle version."""
        try:
            decision = self._read_active_tenant(
                TenantExecutionKind.A2A_CLIENT_SUBMIT,
                self.invocation_id or self.tool.id,
            )
        except TenantLifecycleDenied as denied:
            self._raise_lifecycle_error(denied)
        return decision.lifecycle_version

    def _require_run_admission(
        self,
        run: A2ATaskRun,
        *,
        execution_kind: TenantExecutionKind = TenantExecutionKind.A2A_CLIENT_SUBMIT,
        denial_code: str = "TENANT_WORK_TERMINALIZED",
    ) -> None:
        """Require the durable run's tenant and lifecycle version before an outbound side effect."""
        self._renew_worker_claim(run)
        try:
            decision = self._read_active_tenant(execution_kind, run.invocation_id or run.id)
            require_matching_admission_version(decision, run.tenant_lifecycle_version)
        except TenantLifecycleDenied as denied:
            self._raise_lifecycle_error(denied, code=denial_code)

    def _read_active_tenant(
        self,
        execution_kind: TenantExecutionKind,
        correlation_id: str,
    ) -> TenantLifecycleDecision:
        """Refresh the local session and read one current active tenant decision without side effects."""
        # Provider callbacks may update the tenant through another database connection; expire the
        # identity map so each boundary observes that committed state rather than a cached row.
        self.db.expire_all()
        return require_active_tenant(
            self.db,
            self.tool.tenant_id,
            execution_kind,
            correlation_id,
        )

    def _raise_lifecycle_error(
        self,
        denied: TenantLifecycleDenied,
        *,
        code: str | None = None,
    ) -> None:
        """Convert a central lifecycle denial into a public-safe A2A error without raw evidence."""
        resolved_code = code or denied.code
        raise A2AClientError(
            resolved_code,
            resolved_code,
            retryable=False,
            request_id=self.invocation_id,
            trace_id=self.session_id,
        ) from None

    def _check_run_admission(
        self,
        run: A2ATaskRun,
        *,
        execution_kind: TenantExecutionKind = TenantExecutionKind.A2A_CLIENT_SUBMIT,
    ) -> None:
        """Perform a raw lifecycle decision for callers that classify an already-started outcome."""
        self._renew_worker_claim(run)
        decision = self._read_active_tenant(execution_kind, run.invocation_id or run.id)
        require_matching_admission_version(decision, run.tenant_lifecycle_version)

    def _renew_worker_claim(self, run: A2ATaskRun) -> None:
        """Renew the durable recovery claim and reject a stale worker generation."""
        if self.worker_owner is None or self.worker_generation is None:
            return
        lease_until = utc_now() + timedelta(seconds=_WORKER_LEASE_SECONDS)
        result = self.db.exec(
            update(A2ATaskRun)
            .where(
                A2ATaskRun.id == run.id,
                A2ATaskRun.worker_owner == self.worker_owner,
                A2ATaskRun.worker_generation == self.worker_generation,
                A2ATaskRun.cancel_requested == False,
            )
            .values(worker_lease_until=lease_until, updated_at=utc_now())
        )
        self.db.commit()
        if getattr(result, "rowcount", 0) != 1:
            raise A2AClientError(
                "TENANT_WORK_TERMINALIZED",
                "A2A recovery worker no longer owns this run.",
                retryable=False,
                request_id=self.invocation_id,
                trace_id=self.session_id,
            )
        run.worker_lease_until = lease_until

    def _worker_owned_update(self, statement: Any) -> Any:
        """Bind a durable update to this recovery worker when one is present."""
        if self.worker_owner is None or self.worker_generation is None:
            return statement
        return statement.where(
            A2ATaskRun.worker_owner == self.worker_owner,
            A2ATaskRun.worker_generation == self.worker_generation,
        )

    def _persist_run_error(
        self,
        run: A2ATaskRun,
        error: A2AClientError,
        *,
        event_type: str,
    ) -> None:
        """Terminalize this worker's non-cancelled run without overwriting another terminal owner."""
        payload = error.to_public_payload(
            request_id=self.invocation_id,
            trace_id=self.session_id,
        )
        now = utc_now()
        statement = update(A2ATaskRun).where(
            A2ATaskRun.id == run.id,
            A2ATaskRun.status.not_in(["failed", "rejected", "canceled", "cancelled"]),
        )
        statement = self._worker_owned_update(statement).values(
            status="failed",
            error_json=payload,
            finished_at=now,
            updated_at=now,
            worker_owner=None,
            worker_lease_until=None,
        )
        result = self.db.exec(statement)
        self.db.commit()
        if getattr(result, "rowcount", 0) != 1:
            return
        self.db.expire_all()
        persisted = self.db.get(A2ATaskRun, run.id)
        if persisted is not None:
            self._event(persisted, event_type, payload)

    def _persist_active_result(
        self,
        run: A2ATaskRun,
        *,
        values: dict[str, Any],
    ) -> bool:
        """CAS one result write against the current tenant lifecycle and worker generation."""
        active_tenant = select(Tenant.id).where(
            Tenant.id == run.tenant_id,
            Tenant.status == "active",
            Tenant.lifecycle_version == run.tenant_lifecycle_version,
        ).exists()
        statement = update(A2ATaskRun).where(
            A2ATaskRun.id == run.id,
            A2ATaskRun.owner_scope == "tenant",
            A2ATaskRun.direction == "client",
            A2ATaskRun.tenant_id == run.tenant_id,
            A2ATaskRun.tenant_lifecycle_version == run.tenant_lifecycle_version,
            A2ATaskRun.cancel_requested == False,
            A2ATaskRun.status.not_in(["failed", "rejected", "canceled", "cancelled"]),
            active_tenant,
        )
        statement = self._worker_owned_update(statement).values(**values)
        result = self.db.exec(statement)
        self.db.commit()
        return getattr(result, "rowcount", 0) == 1

    def _invocation_lock_key(self) -> str:
        identity = self.invocation_id or uuid.uuid4().hex
        return f"{self.tool.tenant_id}:{self.tool.id}:{identity}"

    def _discover_agent(self) -> None:
        if self.config.get("discover_agent_card", True) is False:
            return
        card_url = self._agent_card_url()
        try:
            with httpx.Client(timeout=min(self.timeout_seconds, 15.0)) as client:
                response = client.get(card_url, headers=self.headers)
                response.raise_for_status()
                card = response.json()
        except Exception as exc:
            if self.config.get("require_agent_card") is True:
                raise A2AClientError("A2A_AGENT_CARD_ERROR", str(exc)) from exc
            return
        if not isinstance(card, dict):
            raise A2AClientError("A2A_AGENT_CARD_INVALID", "Agent Card 必须是 JSON 对象。")
        self.agent_card = card
        interfaces = card.get("supportedInterfaces") or card.get("supported_interfaces")
        if isinstance(interfaces, list):
            selected = next(
                (
                    item
                    for item in interfaces
                    if isinstance(item, dict)
                    and str(item.get("protocolBinding") or item.get("protocol_binding") or "").upper()
                    in {"JSONRPC", "JSON-RPC"}
                    and str(item.get("url") or "").strip()
                ),
                None,
            )
            if selected:
                self.endpoint_url = str(selected["url"]).strip()
                self.protocol_binding = "JSONRPC"
                self.protocol_version = str(
                    selected.get("protocolVersion")
                    or selected.get("protocol_version")
                    or self.protocol_version
                )
        elif str(card.get("url") or "").strip():
            self.endpoint_url = str(card["url"]).strip()

    def _send(
        self,
        run: A2ATaskRun,
        message: dict[str, Any],
        *,
        deadline: float,
    ) -> dict[str, Any]:
        streaming = bool(
            (self.agent_card.get("capabilities") or {}).get("streaming")
            if isinstance(self.agent_card.get("capabilities"), dict)
            else False
        )
        if self.config.get("streaming") is False:
            streaming = False
        if streaming:
            try:
                last = self._stream_method(
                    run, "SendStreamingMessage", self._send_params(message), deadline=deadline
                )
                if last is not None:
                    return self._wait_if_needed(run, last, deadline=deadline)
            except (A2AClientError, httpx.HTTPError) as exc:
                if isinstance(exc, A2AClientError) and exc.code in _LIFECYCLE_ERROR_CODES:
                    raise
                # Once SendStreamingMessage starts, the provider may have accepted the business
                # request. A second SendMessage would be a replay, not a safe capability fallback.
                raise A2AClientError(
                    "EXTERNAL_OUTCOME_UNKNOWN",
                    str(exc),
                    retryable=False,
                    request_id=self.invocation_id,
                    trace_id=self.session_id,
                ) from exc
            raise A2AClientError(
                "EXTERNAL_OUTCOME_UNKNOWN",
                "A2A streaming send ended without a result.",
                retryable=False,
                request_id=self.invocation_id,
                trace_id=self.session_id,
            )
        result = self._rpc(
            "SendMessage",
            self._send_params(message),
            deadline=deadline,
            run=run,
        )
        self._record_result(run, result, event_type="message_result")
        return self._wait_if_needed(run, result, deadline=deadline)

    def _wait_if_needed(
        self,
        run: A2ATaskRun,
        result: dict[str, Any],
        *,
        deadline: float,
    ) -> dict[str, Any]:
        task = _task_from_event(result)
        if task is None:
            return result
        self._update_task_identity(run, task)
        state = _task_state(task)
        if state in _TERMINAL_STATES | _INTERRUPTED_STATES:
            return task
        if not run.remote_task_id:
            raise A2AClientError("A2A_TASK_INVALID", "working Task 缺少 task id。")

        capabilities = self.agent_card.get("capabilities")
        can_stream = isinstance(capabilities, dict) and bool(capabilities.get("streaming"))
        if can_stream and self.config.get("subscribe", True) is not False:
            try:
                streamed = self._stream_method(
                    run,
                    "SubscribeToTask",
                    {"id": run.remote_task_id},
                    deadline=deadline,
                )
                if streamed is not None:
                    streamed_task = _task_from_event(streamed) or streamed
                    if _task_state(streamed_task) in _TERMINAL_STATES | _INTERRUPTED_STATES:
                        return streamed_task
            except (A2AClientError, httpx.HTTPError) as exc:
                # Do not hide a lifecycle fence as an ordinary streaming capability fallback.
                if isinstance(exc, A2AClientError) and exc.code in _LIFECYCLE_ERROR_CODES:
                    raise
                self._event(run, "subscribe_fallback", {})

        while time.monotonic() < deadline:
            self.db.refresh(run)
            if run.cancel_requested:
                self._cancel_remote(run, deadline=deadline)
                raise A2AClientError("A2A_CANCELLED", "A2A 任务已取消。")
            polled = self._rpc(
                "GetTask",
                {"id": run.remote_task_id},
                deadline=deadline,
                run=run,
            )
            self._record_result(run, polled, event_type="task_polled")
            task = _task_from_event(polled) or polled
            self._update_task_identity(run, task)
            if _task_state(task) in _TERMINAL_STATES | _INTERRUPTED_STATES:
                return task
            time.sleep(min(self.poll_interval, max(deadline - time.monotonic(), 0.0)))
        self._cancel_remote(run, deadline=deadline, best_effort=True)
        raise A2AClientError("A2A_TIMEOUT", f"A2A Task 超过 {self.timeout_seconds:g} 秒未完成。")

    def _stream_method(
        self,
        run: A2ATaskRun,
        method: str,
        params: dict[str, Any],
        *,
        deadline: float,
    ) -> dict[str, Any] | None:
        # Streaming opens a remote request, so admission must be checked immediately before it.
        self._require_run_admission(run)
        payload = self._payload(method, params)
        headers = dict(self.headers)
        headers["Accept"] = "text/event-stream"
        if run.last_event_id:
            headers["Last-Event-ID"] = run.last_event_id
        last: dict[str, Any] | None = None
        accumulated_task: dict[str, Any] | None = None
        timeout = max(deadline - time.monotonic(), 0.1)
        with httpx.Client(timeout=timeout) as client, client.stream(
            "POST", self.endpoint_url, headers=headers, json=payload
        ) as response:
                response.raise_for_status()
                for event_id, data in _iter_sse(response.iter_lines()):
                    if time.monotonic() >= deadline:
                        break
                    if not data:
                        continue
                    try:
                        envelope = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(envelope, dict) and isinstance(envelope.get("error"), dict):
                        error = envelope["error"]
                        raise A2AClientError(
                            "A2A_ERROR", str(error.get("message") or "A2A 流返回错误。")
                        )
                    result = envelope.get("result") if isinstance(envelope, dict) else None
                    if not isinstance(result, dict):
                        continue
                    last = result
                    run.last_event_id = event_id or run.last_event_id
                    self._record_result(run, result, event_type="stream_event", event_id=event_id)
                    task = _task_from_event(result)
                    if task is not None:
                        accumulated_task = _merge_task(accumulated_task, task)
                        self._update_task_identity(run, task)
                        if _task_state(task) in _TERMINAL_STATES | _INTERRUPTED_STATES:
                            return accumulated_task
        return accumulated_task or last

    def _rpc(
        self,
        method: str,
        params: dict[str, Any],
        *,
        deadline: float,
        run: A2ATaskRun | None = None,
    ) -> dict[str, Any]:
        """Send one JSON-RPC request after rechecking tenant ownership and lifecycle admission."""
        if run is not None:
            self._require_run_admission(run)
        timeout = max(deadline - time.monotonic(), 0.1)
        with httpx.Client(timeout=timeout) as client:
            response = client.post(
                self.endpoint_url,
                headers=self.headers,
                json=self._payload(method, params),
            )
            response.raise_for_status()
            envelope = response.json()
        if not isinstance(envelope, dict):
            raise A2AClientError("A2A_RESPONSE_INVALID", "A2A 响应不是 JSON 对象。")
        if isinstance(envelope.get("error"), dict):
            error = envelope["error"]
            raise A2AClientError("A2A_ERROR", str(error.get("message") or "A2A Agent 返回错误。"))
        result = envelope.get("result")
        if not isinstance(result, dict):
            raise A2AClientError("A2A_RESPONSE_INVALID", "A2A 响应缺少 result 对象。")
        return result

    def _cancel_remote(
        self, run: A2ATaskRun, *, deadline: float, best_effort: bool = False
    ) -> None:
        if not run.remote_task_id:
            return
        try:
            result = self._rpc(
                "CancelTask",
                {"id": run.remote_task_id},
                deadline=deadline,
                run=run,
            )
            self._record_result(run, result, event_type="cancelled")
        except A2AClientError as exc:
            # A lifecycle error is authoritative even on a best-effort timeout cancellation.
            if not best_effort or exc.code in _LIFECYCLE_ERROR_CODES:
                raise
        except Exception:
            if not best_effort:
                raise

    def _finalize(self, run: A2ATaskRun, result: dict[str, Any]) -> dict[str, Any]:
        """Persist a successful A2A result and return raw business output plus stable metadata."""
        task = _task_from_event(result) or result
        state = _task_state(task) or "completed"
        try:
            # A remote response has already been received; a changed lifecycle makes its outcome
            # unsafe to report as an ordinary success or retryable failure.
            self._check_run_admission(run)
        except TenantLifecycleDenied as denied:
            self._raise_lifecycle_error(denied, code="EXTERNAL_OUTCOME_UNKNOWN")
        artifacts = _artifacts(task)
        artifacts = self._hydrate_artifacts(run, artifacts)
        now = utc_now()
        remote_task_id = str(task.get("id") or task.get("taskId") or run.remote_task_id or "") or None
        context_id = str(task.get("contextId") or run.context_id or "") or None
        if not self._persist_active_result(
            run,
            values={
                "status": state,
                "result_json": task,
                "artifacts_json": artifacts,
                "remote_task_id": remote_task_id,
                "context_id": context_id,
                "finished_at": (
                    now if state in _TERMINAL_STATES | _INTERRUPTED_STATES else None
                ),
                "updated_at": now,
                "worker_owner": None if state in _TERMINAL_STATES | _INTERRUPTED_STATES else run.worker_owner,
                "worker_lease_until": (
                    None if state in _TERMINAL_STATES | _INTERRUPTED_STATES else run.worker_lease_until
                ),
            },
        ):
            unknown = A2AClientError(
                "EXTERNAL_OUTCOME_UNKNOWN",
                "A2A result lost its lifecycle or worker fence before persistence.",
                retryable=False,
                request_id=self.invocation_id,
                trace_id=self.session_id,
            )
            self._persist_run_error(run, unknown, event_type="failed")
            raise unknown
        self.db.expire_all()
        persisted = self.db.get(A2ATaskRun, run.id)
        if persisted is None:
            raise A2AClientError("A2A_TASK_FAILED", "A2A durable run disappeared.")
        run = persisted
        self._event(run, state, {"task": task, "artifacts": artifacts})
        if state in {"failed", "rejected"}:
            message = _status_message(task) or f"A2A Task {state}。"
            raise A2AClientError("A2A_TASK_FAILED", message)
        if state in {"canceled", "cancelled"}:
            raise A2AClientError("A2A_CANCELLED", "A2A Task 已取消。")
        return {
            "a2a_run_id": run.id,
            "task_id": run.remote_task_id,
            "context_id": run.context_id,
            "state": state,
            "awaiting_input": state == "input-required",
            "task": task,
            "message": _status_message(task),
            "artifacts": artifacts,
            "metadata": _language_metadata(self.language_context),
        }

    def _continuation(self, arguments: dict[str, Any]) -> dict[str, str | None]:
        task_id = str(arguments.get("taskId") or arguments.get("task_id") or "").strip() or None
        context_id = (
            str(arguments.get("contextId") or arguments.get("context_id") or "").strip() or None
        )
        if not task_id and self.session_id:
            previous = self.db.exec(
                select(A2ATaskRun)
                .where(
                    A2ATaskRun.direction == "client",
                    A2ATaskRun.tenant_id == self.tool.tenant_id,
                    A2ATaskRun.tool_id == self.tool.id,
                    A2ATaskRun.session_id == self.session_id,
                    A2ATaskRun.status.in_(["input-required", "auth-required"]),
                )
                .order_by(A2ATaskRun.updated_at.desc())
            ).first()
            if previous:
                task_id = previous.remote_task_id
                context_id = previous.context_id
        return {"task_id": task_id, "context_id": context_id}

    def _message(
        self, arguments: dict[str, Any], continuation: dict[str, str | None]
    ) -> dict[str, Any]:
        """Build an A2A message while leaving user-provided parts untouched."""
        supplied = arguments.get("message")
        if isinstance(supplied, dict):
            message = dict(supplied)
        else:
            text = arguments.get("text") or arguments.get("query")
            if text is None:
                text = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
            message = {"role": "ROLE_USER", "parts": [{"text": str(text)}]}
        message.setdefault("messageId", uuid.uuid4().hex)
        message.setdefault("role", "ROLE_USER")
        if continuation.get("task_id"):
            message["taskId"] = continuation["task_id"]
        if continuation.get("context_id"):
            message["contextId"] = continuation["context_id"]
        return message

    def _send_params(self, message: dict[str, Any]) -> dict[str, Any]:
        """Build SendMessage params with locale control metadata separate from raw message parts."""
        modes = self.config.get("accepted_output_modes")
        if not isinstance(modes, list) or not modes:
            modes = ["text/plain", "application/json"]
        return {
            "message": message,
            "configuration": {"acceptedOutputModes": [str(item) for item in modes]},
            "metadata": _language_metadata(self.language_context),
        }

    def _payload(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params}

    def _agent_card_url(self) -> str:
        configured = str(self.config.get("agent_card_url") or "").strip()
        if configured:
            return configured
        parsed = urlsplit(self.tool.url)
        return urlunsplit((parsed.scheme, parsed.netloc, "/.well-known/agent-card.json", "", ""))

    def _record_result(
        self,
        run: A2ATaskRun,
        result: dict[str, Any],
        *,
        event_type: str,
        event_id: str | None = None,
    ) -> None:
        task = _task_from_event(result)
        state = _task_state(task) if task is not None else ""
        try:
            self._check_run_admission(run)
        except TenantLifecycleDenied as denied:
            # A provider response with a known non-terminal Task can be terminalized safely; a
            # terminal/shape-less response cannot prove what happened after suspension.
            code = (
                "TENANT_WORK_TERMINALIZED"
                if state and state not in _TERMINAL_STATES
                else "EXTERNAL_OUTCOME_UNKNOWN"
            )
            self._raise_lifecycle_error(denied, code=code)
        values: dict[str, Any] = {"updated_at": utc_now()}
        if task:
            values["remote_task_id"] = (
                str(task.get("id") or task.get("taskId") or run.remote_task_id or "") or None
            )
            values["context_id"] = str(task.get("contextId") or run.context_id or "") or None
            if state:
                values["status"] = state
        if not self._persist_active_result(run, values=values):
            code = (
                "TENANT_WORK_TERMINALIZED"
                if state and state not in _TERMINAL_STATES
                else "EXTERNAL_OUTCOME_UNKNOWN"
            )
            error = A2AClientError(
                code,
                code,
                retryable=False,
                request_id=self.invocation_id,
                trace_id=self.session_id,
            )
            self._persist_run_error(run, error, event_type="failed")
            raise error
        self.db.expire_all()
        persisted = self.db.get(A2ATaskRun, run.id)
        if persisted is not None:
            run = persisted
        self._event(run, event_type, result, event_id=event_id)

    def _update_task_identity(
        self, run: A2ATaskRun, task: dict[str, Any], *, commit: bool = True
    ) -> None:
        run.remote_task_id = str(task.get("id") or task.get("taskId") or run.remote_task_id or "") or None
        run.context_id = str(task.get("contextId") or run.context_id or "") or None
        if commit:
            run.updated_at = utc_now()
            self.db.add(run)
            self.db.commit()

    def _event(
        self,
        run: A2ATaskRun,
        event_type: str,
        data: dict[str, Any],
        *,
        event_id: str | None = None,
    ) -> None:
        """Persist an outbound lifecycle event with stable locale metadata and raw success data."""
        event_data = dict(data)
        event_metadata = event_data.get("metadata")
        metadata = dict(event_metadata) if isinstance(event_metadata, dict) else {}
        context = self.language_context or resolve_language_context(LanguageContextInputs())
        # The local durable snapshot is authoritative; never replay a provider's
        # unvalidated metadata in place of the locale bound to this invocation.
        metadata["language_context"] = context.model_dump(mode="json")
        event_data["metadata"] = metadata
        last = self.db.exec(
            select(A2ATaskEvent)
            .where(A2ATaskEvent.run_id == run.id)
            .order_by(A2ATaskEvent.sequence.desc())
        ).first()
        self.db.add(
            A2ATaskEvent(
                run_id=run.id,
                sequence=(last.sequence + 1) if last else 1,
                external_event_id=event_id,
                event_type=event_type,
                data_json=event_data,
            )
        )
        self.db.commit()

    def _hydrate_artifacts(
        self,
        run: A2ATaskRun,
        artifacts: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Fetch remote artifact bytes only while the tenant run remains admitted."""
        hydrated: list[dict[str, Any]] = []
        max_bytes = int(self.config.get("artifact_max_bytes") or 25 * 1024 * 1024)
        for artifact in artifacts:
            value = json.loads(json.dumps(artifact))
            for part in value.get("parts") or []:
                if not isinstance(part, dict):
                    continue
                file_part = part.get("file")
                if not isinstance(file_part, dict) or file_part.get("bytes"):
                    continue
                uri = str(file_part.get("uri") or "").strip()
                if not uri or urlsplit(uri).scheme not in {"http", "https"}:
                    continue
                try:
                    # Artifact hydration is another provider request and must not cross a lifecycle fence.
                    self._check_run_admission(run)
                except TenantLifecycleDenied as denied:
                    self._raise_lifecycle_error(denied, code="EXTERNAL_OUTCOME_UNKNOWN")
                with httpx.Client(timeout=min(self.timeout_seconds, 60.0)) as client:
                    response = client.get(uri, headers=self.headers)
                    response.raise_for_status()
                    content = response.content
                try:
                    # The GET itself is an external boundary; a transition during download must
                    # prevent these bytes from being attached to an ordinary completed result.
                    self._check_run_admission(run)
                except TenantLifecycleDenied as denied:
                    self._raise_lifecycle_error(denied, code="EXTERNAL_OUTCOME_UNKNOWN")
                if len(content) > max_bytes:
                    raise A2AClientError("A2A_ARTIFACT_TOO_LARGE", "A2A Artifact 超过大小限制。")
                file_part["bytes"] = base64.b64encode(content).decode("ascii")
            hydrated.append(value)
        return hydrated


def _coerce_language_context(
    value: LanguageContext | dict[str, Any] | None,
) -> LanguageContext:
    """Normalize a caller or durable snapshot and fail closed to the legacy zh-CN default."""
    try:
        return resolve_compatible_language_context(
            snapshot=value,
            legacy_ui_locale=None,
            legacy_agent_reply_locale=None,
        )
    except (TypeError, ValueError, ValidationError):
        return resolve_language_context(LanguageContextInputs())


def _language_metadata(context: LanguageContext | None) -> dict[str, Any]:
    """Return the standard A2A metadata extension for one stable locale snapshot."""
    snapshot = context or resolve_language_context(LanguageContextInputs())
    return {"language_context": snapshot.model_dump(mode="json")}


def _iter_sse(lines: Iterator[str]) -> Iterator[tuple[str | None, str]]:
    event_id: str | None = None
    data_lines: list[str] = []
    for raw in lines:
        line = raw.rstrip("\r")
        if not line:
            if data_lines:
                yield event_id, "\n".join(data_lines)
            event_id = None
            data_lines = []
        elif line.startswith("id:"):
            event_id = line[3:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        yield event_id, "\n".join(data_lines)


def _run_lock(key: str) -> threading.RLock:
    with _RUN_LOCKS_GUARD:
        return _RUN_LOCKS.setdefault(key, threading.RLock())


def _task_from_event(value: dict[str, Any]) -> dict[str, Any] | None:
    if isinstance(value.get("task"), dict):
        return value["task"]
    if isinstance(value.get("statusUpdate"), dict):
        update = value["statusUpdate"]
        return {
            "id": update.get("taskId"),
            "contextId": update.get("contextId"),
            "status": update.get("status"),
        }
    if isinstance(value.get("artifactUpdate"), dict):
        update = value["artifactUpdate"]
        return {
            "id": update.get("taskId"),
            "contextId": update.get("contextId"),
            "artifacts": [update.get("artifact")],
        }
    if isinstance(value.get("status"), (dict, str)) and (value.get("id") or value.get("taskId")):
        return value
    return None


def _merge_task(
    current: dict[str, Any] | None,
    update: dict[str, Any],
) -> dict[str, Any]:
    """Merge A2A status/artifact deltas without discarding prior task data."""

    merged = dict(current or {})
    for key, value in update.items():
        if key == "artifacts" and isinstance(value, list):
            existing = [item for item in merged.get("artifacts") or [] if isinstance(item, dict)]
            by_id = {
                str(item.get("artifactId") or item.get("artifact_id") or index): item
                for index, item in enumerate(existing)
            }
            for index, artifact in enumerate(value):
                if not isinstance(artifact, dict):
                    continue
                artifact_id = str(
                    artifact.get("artifactId")
                    or artifact.get("artifact_id")
                    or len(by_id) + index
                )
                by_id[artifact_id] = artifact
            merged["artifacts"] = list(by_id.values())
        elif value is not None:
            merged[key] = value
    return merged


def _task_state(task: dict[str, Any]) -> str:
    status = task.get("status")
    if isinstance(status, dict):
        status = status.get("state")
    value = str(status or task.get("state") or "").strip().lower().replace("_", "-")
    return value.removeprefix("task-state-")


def _status_message(task: dict[str, Any]) -> str | None:
    status = task.get("status")
    message = status.get("message") if isinstance(status, dict) else None
    if isinstance(message, dict):
        parts = message.get("parts") or []
        texts = [str(part.get("text")) for part in parts if isinstance(part, dict) and part.get("text")]
        return "\n".join(texts) or None
    if isinstance(message, str):
        return message
    return None


def _artifacts(task: dict[str, Any]) -> list[dict[str, Any]]:
    value = task.get("artifacts")
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _positive_float(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback
