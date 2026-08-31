from __future__ import annotations

import threading

from sqlmodel import Session, select

from app.contracts.error_registry import ERROR_REGISTRY, ErrorContractViolation, ErrorVisibility
from app.contracts.errors import ErrorDescriptor
from app.db import engine
from app.db.models import A2ATaskRun, ChatSession, HarnessInvocationRecord, Tool, utc_now
from app.i18n.language_context import resolve_compatible_language_context
from app.tools.tool_executor import ToolExecutor
from app.tools.tool_schema import ToolCall

_RECOVERABLE_STATES = {"submitted", "working"}


def _recovery_error_payload(
    code: str,
    *,
    params: dict[str, object] | None = None,
) -> dict[str, object]:
    """Build durable recovery failures from the exact public error registry contract."""
    entry = ERROR_REGISTRY.get(code)
    if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        params = {}
    try:
        descriptor = ErrorDescriptor(
            code=entry.code,
            params=dict(params or {}),
            retryable=entry.retryable_default,
        )
        descriptor = ERROR_REGISTRY.validate(descriptor)
    except (ErrorContractViolation, TypeError, ValueError):
        entry = ERROR_REGISTRY.require("INTERNAL_ERROR")
        descriptor = ErrorDescriptor(
            code=entry.code,
            params={},
            retryable=entry.retryable_default,
        )
    return descriptor.model_dump(mode="json")


def recover_a2a_client_tasks() -> None:
    """Resume durable outbound A2A tasks after an application restart."""

    with Session(engine) as db:
        run_ids = list(
            db.exec(
                select(A2ATaskRun.id).where(
                    A2ATaskRun.direction == "client",
                    A2ATaskRun.status.in_(_RECOVERABLE_STATES),
                )
            ).all()
        )
    for run_id in run_ids:
        threading.Thread(
            target=_recover_one,
            args=(str(run_id),),
            name=f"a2a-client-recovery-{run_id}",
            daemon=True,
        ).start()


def _recover_one(run_id: str) -> None:
    with Session(engine) as db:
        run = db.get(A2ATaskRun, run_id)
        if run is None or run.direction != "client" or run.status not in _RECOVERABLE_STATES:
            return
        if not run.tool_id or not run.invocation_id:
            run.status = "failed"
            run.error_json = _recovery_error_payload("A2A_RECOVERY_INVALID")
            run.finished_at = utc_now()
            run.updated_at = utc_now()
            db.add(run)
            db.commit()
            return
        tool = db.get(Tool, run.tool_id)
        if tool is None:
            run.status = "failed"
            run.error_json = _recovery_error_payload("A2A_RECOVERY_TOOL_MISSING")
            run.finished_at = utc_now()
            run.updated_at = utc_now()
            db.add(run)
            db.commit()
            return
        invocation = db.exec(
            select(HarnessInvocationRecord)
            .where(
                HarnessInvocationRecord.tenant_id == run.tenant_id,
                HarnessInvocationRecord.call_id == run.invocation_id,
            )
            .order_by(HarnessInvocationRecord.started_at.desc())
        ).first()
        language_context = resolve_compatible_language_context(
            snapshot=(
                run.language_context_json
                or (invocation.language_context_json if invocation is not None else None)
            ),
            legacy_ui_locale=None,
            legacy_agent_reply_locale=None,
        )
        session = db.get(ChatSession, run.session_id) if run.session_id else None
        if (
            session is not None
            and session.agent_reply_locale is not None
            and session.agent_reply_locale != language_context.agent_reply_locale.value
        ):
            run.status = "failed"
            run.error_json = _recovery_error_payload(
                "AGENT_REPLY_LOCALE_CONFLICT",
                params={
                    "requested": language_context.agent_reply_locale.value,
                    "session": session.agent_reply_locale,
                },
            )
            run.finished_at = utc_now()
            run.updated_at = utc_now()
            db.add(run)
            db.commit()
            return
        run.language_context_json = language_context.model_dump(mode="json")
        db.add(run)
        db.commit()
        request = run.request_json if isinstance(run.request_json, dict) else {}
        arguments = request.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        ToolExecutor(db).execute(
            tenant_id=run.tenant_id,
            tool_call=ToolCall(name=tool.name, arguments=arguments),
            agent_id=run.agent_id,
            session_id=run.session_id,
            invocation_id=run.invocation_id,
            language_context=language_context,
        )
