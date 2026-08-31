from __future__ import annotations

import json
import logging
import mimetypes
import os
import queue
import subprocess
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import ValidationError
from sqlmodel import Session, select

from app.config import get_settings
from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext
from app.contracts.projections import project_public_error
from app.db import engine
from app.db.models import A2ATaskEvent, A2ATaskRun, utc_now
from app.i18n.language_context import (
    LanguageContext,
    LanguageContextInputs,
    resolve_language_context,
)

router = APIRouter(tags=["a2a-codex"])
logger = logging.getLogger(__name__)
_processes: dict[str, subprocess.Popen[str]] = {}
_process_lock = threading.Lock()
_submission_lock = threading.Lock()
_shutting_down = threading.Event()
_TERMINAL = {"completed", "failed", "canceled", "rejected", "input-required"}

_A2A_HTTP_CODES = {
    400: "A2A_BAD_REQUEST",
    401: "A2A_UNAUTHORIZED",
    404: "A2A_NOT_FOUND",
}


class _A2ARequestError(ValueError):
    """Represent malformed transport metadata without exposing parser diagnostics publicly."""


def _a2a_language_context(
    params: dict[str, Any],
    message: dict[str, Any],
) -> LanguageContext:
    """Resolve a typed A2A locale snapshot from standard metadata or explicit BCP 47 fields."""
    metadata_candidates = (
        params.get("metadata"),
        message.get("metadata"),
    )
    raw_context: object | None = params.get("language_context")
    if raw_context is None:
        raw_context = params.get("languageContext")
    if raw_context is None:
        raw_context = message.get("language_context")
    if raw_context is None:
        raw_context = message.get("languageContext")
    for metadata in metadata_candidates:
        if not isinstance(metadata, dict):
            continue
        if raw_context is None:
            raw_context = metadata.get("language_context")
        if raw_context is None:
            raw_context = metadata.get("languageContext")

    if raw_context is not None and not isinstance(raw_context, dict):
        raise _A2ARequestError("A2A language context must be a JSON object.")

    context_data = raw_context if isinstance(raw_context, dict) else {}
    snapshot_keys = {
        "version",
        "ui_locale",
        "agent_reply_locale",
        "ui_locale_source",
        "agent_reply_locale_source",
    }
    if snapshot_keys.issubset(context_data):
        try:
            return LanguageContext.model_validate(context_data)
        except ValidationError as exc:
            raise _A2ARequestError("A2A language context is invalid.") from exc

    def first_value(*keys: str) -> object | None:
        """Return the first explicitly supplied locale field without coercing user content."""
        for source in (context_data, params, message):
            for key in keys:
                if key in source:
                    return source[key]
        return None

    try:
        return resolve_language_context(
            LanguageContextInputs(
                explicit_ui_locale=first_value("ui_locale", "uiLocale"),
                explicit_agent_reply_locale=first_value(
                    "agent_reply_locale", "agentReplyLocale"
                ),
            )
        )
    except (TypeError, ValueError) as exc:
        raise _A2ARequestError("A2A locale fields are invalid.") from exc


def _task_language_context(task: A2ATaskRun) -> LanguageContext:
    """Read a durable task snapshot and fail closed to the recorded legacy default when absent."""
    raw_snapshot = task.language_context_json
    if isinstance(raw_snapshot, dict):
        try:
            return LanguageContext.model_validate(raw_snapshot)
        except ValidationError:
            pass
    return resolve_language_context(LanguageContextInputs())


def _language_metadata(task: A2ATaskRun) -> dict[str, Any]:
    """Build the stable A2A metadata extension without including private diagnostics."""
    return {"language_context": _task_language_context(task).model_dump(mode="json")}


def _codex_runtime_prompt(prompt: str, context: LanguageContext) -> str:
    """Add a locale-only runtime instruction while preserving the persisted raw user prompt."""
    return (
        "[StaffDeck language contract] Respond to the user in "
        f"{context.agent_reply_locale.value}. Keep user-provided text and source content raw.\n\n"
        f"{prompt}"
    )


def _project_a2a_error(
    code: str,
    *,
    raw_context: object | None = None,
    request_id: str | None = None,
    trace_id: str | None = None,
) -> dict[str, Any]:
    """Project one registered A2A error and fail closed on unknown legacy codes."""
    entry = ERROR_REGISTRY.get(code) or ERROR_REGISTRY.require("INTERNAL_ERROR")
    occurrence = ErrorOccurrence(
        descriptor=ErrorDescriptor(
            code=entry.code,
            params={},
            retryable=entry.retryable_default,
            request_id=request_id,
            trace_id=trace_id,
        ),
        internal=InternalErrorContext(
            source="a2a-codex-adapter",
            raw_message=str(raw_context) if raw_context is not None else None,
            upstream_code=code,
        ),
    )
    return project_public_error(occurrence, ERROR_REGISTRY)


def _project_persisted_a2a_error(error_json: object) -> dict[str, Any]:
    """Read a durable A2A error as canonical data without replaying raw prose."""
    if not isinstance(error_json, dict) or not error_json:
        return {}
    code = str(error_json.get("code") or "INTERNAL_ERROR")
    entry = ERROR_REGISTRY.get(code)
    raw_message = error_json.get("message")
    params = error_json.get("params", {})
    retryable = error_json.get(
        "retryable",
        entry.retryable_default if entry is not None else False,
    )
    request_id = error_json.get("request_id")
    trace_id = error_json.get("trace_id")
    if (
        entry is None
        or not isinstance(params, dict)
        or not isinstance(retryable, bool)
        or (request_id is not None and not isinstance(request_id, str))
        or (trace_id is not None and not isinstance(trace_id, str))
    ):
        return _project_a2a_error("INTERNAL_ERROR", raw_context=error_json)
    try:
        descriptor = ErrorDescriptor(
            code=code,
            params=params,
            retryable=retryable,
            request_id=request_id,
            trace_id=trace_id,
        )
    except ValueError:
        return _project_a2a_error("INTERNAL_ERROR", raw_context=error_json)
    occurrence = ErrorOccurrence(
        descriptor=descriptor,
        internal=InternalErrorContext(
            source="a2a-codex-adapter-persisted",
            raw_message=str(raw_message) if raw_message is not None else None,
            upstream_code=code,
        ),
    )
    return project_public_error(occurrence, ERROR_REGISTRY)


def _a2a_http_error(
    status_code: int,
    detail: object | None = None,
    *,
    code: str | None = None,
) -> HTTPException:
    """Return an HTTP error whose public detail is a canonical A2A descriptor."""
    resolved_code = code or _A2A_HTTP_CODES.get(status_code, "A2A_INTERNAL_ERROR")
    return HTTPException(
        status_code=status_code,
        detail=_project_a2a_error(resolved_code, raw_context=detail),
    )


@router.get("/.well-known/agent-card.json")
def codex_agent_card(request: Request) -> dict[str, Any]:
    settings = _enabled_settings()
    endpoint = str(request.base_url).rstrip("/") + "/api/a2a/codex"
    return {
        "name": "Codex CLI",
        "description": "Codex CLI exposed as a durable A2A agent.",
        "version": "1.0.0",
        "protocolVersion": "1.0",
        "supportedInterfaces": [
            {"url": endpoint, "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
        ],
        "capabilities": {"streaming": True, "pushNotifications": False},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain", "application/json", "application/octet-stream"],
        "skills": [
            {
                "id": "codex-cli",
                "name": "Codex CLI",
                "description": "Coding and knowledge work with file artifacts.",
                "tags": ["coding", "files", "analysis"],
            }
        ],
        "securitySchemes": ({"bearer": {"type": "http", "scheme": "bearer"}} if settings.codex_a2a_token else {}),
    }


@router.post("/api/a2a/codex")
def codex_a2a_rpc(
    request: Request,
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> Response:
    """Handle one JSON-RPC request while projecting locale and errors to stable metadata."""
    settings = _enabled_settings()
    _authorize(settings.codex_a2a_token, authorization)
    request_id = payload.get("id")
    method = str(payload.get("method") or "")
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    try:
        if method in {"SendMessage", "SendStreamingMessage"}:
            task, stream_after = _submit_message(params, request=request)
            if method == "SendStreamingMessage":
                return _stream_task(
                    task.id,
                    request_id=request_id,
                    after_event_id=last_event_id or str(stream_after),
                )
            return JSONResponse(_envelope(request_id, _task_payload(task, request=request)))
        if method == "GetTask":
            task = _require_task(str(params.get("id") or params.get("taskId") or ""))
            return JSONResponse(_envelope(request_id, _task_payload(task, request=request)))
        if method == "CancelTask":
            task = _require_task(str(params.get("id") or params.get("taskId") or ""))
            _cancel(task.id)
            with Session(engine) as db:
                task = db.get(A2ATaskRun, task.id)
                assert task is not None
                return JSONResponse(_envelope(request_id, _task_payload(task, request=request)))
        if method == "SubscribeToTask":
            task = _require_task(str(params.get("id") or params.get("taskId") or ""))
            return _stream_task(task.id, request_id=request_id, after_event_id=last_event_id)
        if method == "ListTasks":
            return JSONResponse(_envelope(request_id, _list_tasks(params, request=request)))
        return JSONResponse(
            _error_envelope(
                request_id,
                -32601,
                "A2A_METHOD_NOT_FOUND",
                raw_context=f"Unsupported A2A method: {method}",
            ),
            status_code=400,
        )
    except _A2ARequestError as exc:
        return JSONResponse(
            _error_envelope(
                request_id,
                -32602,
                "A2A_BAD_REQUEST",
                raw_context=exc,
            ),
            status_code=400,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Codex A2A request failed")
        return JSONResponse(
            _error_envelope(
                request_id,
                -32000,
                "A2A_INTERNAL_ERROR",
                raw_context=exc,
            ),
            status_code=500,
        )


@router.get("/api/a2a/codex/tasks/{task_id}/artifacts/{artifact_path:path}")
def codex_a2a_artifact(
    task_id: str,
    artifact_path: str,
    authorization: str | None = Header(default=None),
) -> FileResponse:
    settings = _enabled_settings()
    _authorize(settings.codex_a2a_token, authorization)
    task = _require_task(task_id)
    root = Path(str(task.request_json.get("workspace") or "")).resolve()
    target = (root / artifact_path).resolve()
    if root not in target.parents or not target.is_file():
        raise _a2a_http_error(status_code=404, detail="Artifact not found")
    return FileResponse(target, filename=target.name)


def recover_codex_a2a_tasks() -> None:
    settings = get_settings()
    if not settings.codex_a2a_enabled:
        return
    _shutting_down.clear()
    with Session(engine) as db:
        tasks = list(
            db.exec(
                select(A2ATaskRun).where(
                    A2ATaskRun.direction == "server",
                    A2ATaskRun.status.in_(["submitted", "working"]),
                )
            ).all()
        )
        ids = [task.id for task in tasks]
    for task_id in ids:
        _launch(task_id, recovery=True)


def stop_codex_a2a_tasks() -> None:
    """Stop CLI children while leaving durable tasks eligible for recovery."""

    _shutting_down.set()
    with _process_lock:
        processes = list(_processes.values())
    for process in processes:
        if process.poll() is None:
            process.terminate()
    for process in processes:
        if process.poll() is not None:
            continue
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()


def _submit_message(params: dict[str, Any], *, request: Request) -> tuple[A2ATaskRun, int]:
    with _submission_lock:
        return _submit_message_locked(params, request=request)


def _submit_message_locked(
    params: dict[str, Any], *, request: Request
) -> tuple[A2ATaskRun, int]:
    """Persist one inbound A2A message with its immutable locale snapshot before launching Codex."""
    message = params.get("message") if isinstance(params.get("message"), dict) else {}
    prompt = _message_text(message)
    if not prompt:
        raise RuntimeError("A2A message has no text part.")
    message_id = str(message.get("messageId") or message.get("message_id") or "").strip()
    if message_id:
        duplicate = _task_for_message_id(message_id)
        if duplicate is not None and duplicate.remote_task_id:
            latest = _latest_event_sequence(duplicate.id)
            return _require_task(duplicate.remote_task_id), max(latest - 1, 0)
    existing_id = str(message.get("taskId") or "").strip()
    if existing_id:
        with Session(engine) as db:
            existing = db.exec(
                select(A2ATaskRun).where(
                    A2ATaskRun.direction == "server",
                    A2ATaskRun.remote_task_id == existing_id,
                )
            ).first()
            if existing is None:
                raise RuntimeError("A2A continuation task was not found.")
            if existing.status not in _TERMINAL:
                raise RuntimeError("A2A task is still running.")
            stream_after = _latest_event_sequence(existing.id, db=db)
            language_context = _task_language_context(existing)
            language_snapshot = language_context.model_dump(mode="json")
            if existing.language_context_json != language_snapshot:
                existing.language_context_json = language_snapshot
            existing.status = "submitted"
            existing.finished_at = None
            existing.cancel_requested = False
            existing.request_json = {
                **existing.request_json,
                "prompt": prompt,
                "raw_prompt": _message_text(message),
                "resume": True,
            }
            existing.result_json = {}
            existing.error_json = {}
            existing.updated_at = utc_now()
            db.add(existing)
            db.commit()
            db.refresh(existing)
            if message_id:
                _append_event(
                    db,
                    existing,
                    "message_received",
                    {"messageId": message_id},
                    external_event_id=message_id,
                )
            _append_event(db, existing, "submitted", _status_update(existing, "submitted"))
            task_id = existing.id
        _launch(task_id)
        return _require_task(existing_id), stream_after

    settings = get_settings()
    language_context = _a2a_language_context(params, message)
    workspace_root = Path(settings.codex_a2a_workspace_root or "/tmp/staffdeck-codex-a2a")
    task_public_id = uuid.uuid4().hex
    workspace = (workspace_root / task_public_id).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    attachment_paths = _materialize_message_files(message, workspace)
    if attachment_paths:
        prompt += "\n\nAttached files are available at:\n" + "\n".join(
            f"- {path}" for path in attachment_paths
        )
    context_id = str(message.get("contextId") or uuid.uuid4().hex)
    task = A2ATaskRun(
        direction="server",
        tenant_id="a2a_codex",
        endpoint_url=str(request.base_url).rstrip("/") + "/api/a2a/codex",
        protocol_binding="JSONRPC",
        protocol_version="1.0",
        remote_task_id=task_public_id,
        context_id=context_id,
        invocation_id=message_id or None,
        status="submitted",
        request_json={
            "prompt": prompt,
            "raw_prompt": _message_text(message),
            "workspace": str(workspace),
            "resume": False,
        },
        language_context_json=language_context.model_dump(mode="json"),
        started_at=utc_now(),
    )
    with Session(engine) as db:
        db.add(task)
        db.commit()
        db.refresh(task)
        if message_id:
            _append_event(
                db,
                task,
                "message_received",
                {"messageId": message_id},
                external_event_id=message_id,
            )
        _append_event(db, task, "submitted", _status_update(task, "submitted"))
        task_id = task.id
    _launch(task_id)
    return _require_task(task_public_id), 0


def _launch(task_id: str, *, recovery: bool = False) -> None:
    thread = threading.Thread(
        target=_run_codex_task,
        args=(task_id,),
        kwargs={"recovery": recovery},
        daemon=True,
        name=f"codex-a2a-{task_id[-8:]}",
    )
    thread.start()


def _run_codex_task(task_id: str, *, recovery: bool = False) -> None:
    """Run or recover one local Codex task using its persisted locale snapshot."""
    settings = get_settings()
    with Session(engine) as db:
        task = db.get(A2ATaskRun, task_id)
        if task is None or task.cancel_requested:
            return
        prompt = str(task.request_json.get("prompt") or "")
        language_context = _task_language_context(task)
        language_snapshot = language_context.model_dump(mode="json")
        if task.language_context_json != language_snapshot:
            task.language_context_json = language_snapshot
        workspace = Path(str(task.request_json.get("workspace") or "")).resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        before = _workspace_snapshot(workspace)
        task.status = "working"
        task.recovery_attempts += 1 if recovery else 0
        task.updated_at = utc_now()
        db.add(task)
        db.commit()
        _append_event(db, task, "working", _status_update(task, "working"))
        codex_session_id = task.codex_session_id
        should_resume = bool(task.request_json.get("resume") or recovery) and codex_session_id

    runtime_prompt = _codex_runtime_prompt(prompt, language_context)
    command = [settings.codex_a2a_command, "exec"]
    if should_resume:
        command.extend(
            [
                "resume",
                "--json",
                "--skip-git-repo-check",
                str(codex_session_id),
                runtime_prompt,
            ]
        )
    else:
        command.extend(
            [
                "--json",
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                "-C",
                str(workspace),
                runtime_prompt,
            ]
        )
    started = time.monotonic()
    final_text = ""
    remote_failure: dict[str, Any] | None = None
    remote_diagnostic: str | None = None
    child_env = os.environ.copy()
    child_env.update(
        {
            "STAFFDECK_UI_LOCALE": language_context.ui_locale.value,
            "STAFFDECK_AGENT_REPLY_LOCALE": language_context.agent_reply_locale.value,
        }
    )
    try:
        process = subprocess.Popen(
            command,
            cwd=workspace,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=child_env,
        )
        with _process_lock:
            _processes[task_id] = process
        assert process.stdout is not None
        output_queue: queue.Queue[str | None] = queue.Queue()

        def read_output() -> None:
            assert process.stdout is not None
            for output_line in process.stdout:
                output_queue.put(output_line)
            output_queue.put(None)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()
        raw_output: list[str] = []
        while True:
            if time.monotonic() - started > settings.codex_a2a_timeout_seconds:
                process.terminate()
                raise TimeoutError("Codex CLI A2A task timed out.")
            with Session(engine) as db:
                current_task = db.get(A2ATaskRun, task_id)
                if current_task is None:
                    process.terminate()
                    return
                if current_task.cancel_requested:
                    process.terminate()
                    raise RuntimeError("Codex CLI A2A task was cancelled.")
            try:
                line = output_queue.get(timeout=0.25)
            except queue.Empty:
                if process.poll() is not None and not reader.is_alive():
                    break
                continue
            if line is None:
                break
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                raw_output.append(line.rstrip())
                continue
            with Session(engine) as db:
                task = db.get(A2ATaskRun, task_id)
                if task is None:
                    process.terminate()
                    return
                if task.cancel_requested:
                    process.terminate()
                    raise RuntimeError("Codex CLI A2A task was cancelled.")
                session_id = _codex_session_id(event)
                if session_id:
                    task.codex_session_id = session_id
                text = _codex_text(event)
                if text:
                    final_text = text
                classified_event = _classify_codex_event(event)
                if classified_event.get("error") is not None:
                    remote_failure = classified_event["error"]
                    remote_diagnostic = _remote_event_diagnostic(event)
                    logger.error(
                        "Codex CLI emitted a remote failure event",
                        extra={
                            "task_id": task_id,
                            "event_type": str(event.get("type") or "unknown"),
                            "remote_diagnostic": remote_diagnostic,
                        },
                    )
                task.updated_at = utc_now()
                db.add(task)
                db.commit()
                _append_event(
                    db,
                    task,
                    "codex_event",
                    {
                        "taskId": task.remote_task_id,
                        "contextId": task.context_id,
                        "codexEvent": classified_event,
                    },
                )
        return_code = process.wait(timeout=5)
        if _shutting_down.is_set():
            return
        if return_code != 0:
            diagnostic = "\n".join(raw_output[-20:]).strip()
            raise RuntimeError(diagnostic or f"Codex CLI exited with {return_code}.")

        artifacts = _collect_artifacts(workspace, before)
        with Session(engine) as db:
            task = db.get(A2ATaskRun, task_id)
            if task is None:
                return
            if remote_failure is not None:
                task.status = "failed"
                task.error_json = remote_failure
                task.result_json = {}
                task.finished_at = utc_now()
                task.updated_at = utc_now()
                db.add(task)
                db.commit()
                _append_event(db, task, "failed", _task_payload(task))
                return
            task.status = "completed"
            task.artifacts_json = artifacts
            task.result_json = {"text": final_text, "artifacts": artifacts}
            task.finished_at = utc_now()
            task.updated_at = utc_now()
            db.add(task)
            db.commit()
            _append_event(db, task, "completed", _task_payload(task))
    except Exception as exc:
        if _shutting_down.is_set():
            with Session(engine) as db:
                task = db.get(A2ATaskRun, task_id)
                if task is not None and task.status not in _TERMINAL:
                    task.status = "working"
                    task.error_json = _project_a2a_error(
                        "A2A_INTERNAL_ERROR",
                        raw_context="Service stopped; the durable task will resume on startup.",
                    )
                    task.updated_at = utc_now()
                    db.add(task)
                    db.commit()
                    _append_event(
                        db,
                        task,
                        "interrupted",
                        _status_update(task, "working"),
                    )
            return
        with Session(engine) as db:
            task = db.get(A2ATaskRun, task_id)
            if task is None:
                return
            cancelled = task.cancel_requested or "cancel" in str(exc).lower()
            task.status = "canceled" if cancelled else "failed"
            error_code = (
                "A2A_CANCELLED"
                if cancelled
                else "A2A_TIMEOUT"
                if isinstance(exc, TimeoutError)
                else "A2A_TASK_FAILED"
            )
            task.error_json = _project_a2a_error(error_code, raw_context=exc)
            if not cancelled:
                logger.exception("Codex A2A task failed", extra={"task_id": task_id})
            task.finished_at = utc_now()
            task.updated_at = utc_now()
            db.add(task)
            db.commit()
            _append_event(db, task, task.status, _task_payload(task))
    finally:
        with _process_lock:
            _processes.pop(task_id, None)


def _stream_task(
    task_id: str,
    *,
    request_id: Any,
    after_event_id: str | None,
) -> StreamingResponse:
    def generate() -> Iterator[str]:
        after = _event_sequence(after_event_id)
        last_heartbeat = time.monotonic()
        while True:
            emitted = False
            with Session(engine) as db:
                events = list(
                    db.exec(
                        select(A2ATaskEvent)
                        .where(A2ATaskEvent.run_id == task_id, A2ATaskEvent.sequence > after)
                        .order_by(A2ATaskEvent.sequence)
                    ).all()
                )
                task = db.get(A2ATaskRun, task_id)
            for event in events:
                after = event.sequence
                emitted = True
                yield f"id: {event.sequence}\ndata: {json.dumps(_envelope(request_id, event.data_json), ensure_ascii=False)}\n\n"
            if task is None or (task.status in _TERMINAL and not events):
                break
            if not emitted and time.monotonic() - last_heartbeat >= 10:
                yield ": keep-alive\n\n"
                last_heartbeat = time.monotonic()
            time.sleep(0.15)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _latest_event_sequence(task_id: str, *, db: Session | None = None) -> int:
    def find(session: Session) -> int:
        event = session.exec(
            select(A2ATaskEvent)
            .where(A2ATaskEvent.run_id == task_id)
            .order_by(A2ATaskEvent.sequence.desc())
        ).first()
        return event.sequence if event is not None else 0

    if db is not None:
        return find(db)
    with Session(engine) as session:
        return find(session)


def _cancel(task_id: str) -> None:
    with Session(engine) as db:
        task = db.get(A2ATaskRun, task_id)
        if task is None:
            raise _a2a_http_error(status_code=404, detail="Task not found")
        task.cancel_requested = True
        task.status = "canceled"
        task.finished_at = utc_now()
        task.updated_at = utc_now()
        db.add(task)
        db.commit()
        _append_event(db, task, "canceled", _task_payload(task))
    with _process_lock:
        process = _processes.get(task_id)
    if process and process.poll() is None:
        process.terminate()


def _require_task(task_public_id: str) -> A2ATaskRun:
    with Session(engine) as db:
        task = db.exec(
            select(A2ATaskRun).where(
                A2ATaskRun.direction == "server",
                A2ATaskRun.remote_task_id == task_public_id,
            )
        ).first()
        if task is None:
            raise _a2a_http_error(status_code=404, detail="Task not found")
        db.expunge(task)
        return task


def _task_for_message_id(message_id: str) -> A2ATaskRun | None:
    with Session(engine) as db:
        event = db.exec(
            select(A2ATaskEvent).where(A2ATaskEvent.external_event_id == message_id)
        ).first()
        task = db.get(A2ATaskRun, event.run_id) if event is not None else None
        if task is None:
            task = db.exec(
                select(A2ATaskRun).where(
                    A2ATaskRun.direction == "server",
                    A2ATaskRun.invocation_id == message_id,
                )
            ).first()
        if task is not None:
            db.expunge(task)
        return task


def _append_event(
    db: Session,
    task: A2ATaskRun,
    event_type: str,
    data: dict[str, Any],
    *,
    external_event_id: str | None = None,
) -> None:
    """Persist one A2A event with the task's stable locale metadata extension."""
    event_data = dict(data)
    metadata = event_data.get("metadata")
    event_metadata = dict(metadata) if isinstance(metadata, dict) else {}
    # The durable task snapshot is authoritative; provider-supplied metadata must
    # not be able to replace it with an unvalidated or diagnostic object.
    event_metadata["language_context"] = _task_language_context(task).model_dump(mode="json")
    event_data["metadata"] = event_metadata
    previous = db.exec(
        select(A2ATaskEvent)
        .where(A2ATaskEvent.run_id == task.id)
        .order_by(A2ATaskEvent.sequence.desc())
    ).first()
    db.add(
        A2ATaskEvent(
            tenant_id=task.tenant_id,
            run_id=task.id,
            sequence=(previous.sequence + 1) if previous else 1,
            external_event_id=external_event_id,
            event_type=event_type,
            data_json=event_data,
        )
    )
    db.commit()


def _task_payload(task: A2ATaskRun, *, request: Request | None = None) -> dict[str, Any]:
    """Project a durable task using raw successful output and stable locale/error metadata."""
    state = task.status
    public_error = _project_persisted_a2a_error(task.error_json)
    result_json = task.result_json if isinstance(task.result_json, dict) else {}
    message_text = str(result_json.get("text") or "")
    if public_error:
        message_text = str(public_error["code"])
    status: dict[str, Any] = {"state": state}
    if public_error:
        status["error"] = public_error
    if message_text:
        status["message"] = {
            "messageId": uuid.uuid4().hex,
            "role": "ROLE_AGENT",
            "parts": [{"text": message_text}],
        }
    artifacts = []
    for item in task.artifacts_json:
        path = str(item.get("path") or "")
        if not path:
            continue
        file_data = {
            "name": item.get("name") or Path(path).name,
            "mimeType": item.get("mime_type") or "application/octet-stream",
        }
        base_url = _artifact_base_url(task, request=request)
        if base_url:
            file_data["uri"] = (
                base_url
                + f"/api/a2a/codex/tasks/{task.remote_task_id}/artifacts/{quote(path)}"
            )
        artifacts.append(
            {
                "artifactId": str(item.get("artifact_id") or uuid.uuid4().hex),
                "name": file_data["name"],
                "parts": [{"file": file_data}],
            }
        )
    return {
        "id": task.remote_task_id,
        "contextId": task.context_id,
        "status": status,
        "artifacts": artifacts,
        "metadata": _language_metadata(task),
    }


def _status_update(task: A2ATaskRun, state: str) -> dict[str, Any]:
    """Build a status delta carrying only stable task identity and locale metadata."""
    return {
        "statusUpdate": {
            "taskId": task.remote_task_id,
            "contextId": task.context_id,
            "status": {"state": state},
            "final": state in _TERMINAL,
            "metadata": _language_metadata(task),
        }
    }


def _message_text(message: dict[str, Any]) -> str:
    texts = [
        str(part.get("text"))
        for part in message.get("parts") or []
        if isinstance(part, dict) and part.get("text") is not None
    ]
    return "\n".join(texts).strip()


def _materialize_message_files(message: dict[str, Any], workspace: Path) -> list[str]:
    import base64

    written: list[str] = []
    target_root = workspace / "attachments"
    for index, part in enumerate(message.get("parts") or [], start=1):
        if not isinstance(part, dict) or not isinstance(part.get("file"), dict):
            continue
        file_part = part["file"]
        encoded = file_part.get("bytes")
        if not isinstance(encoded, str) or not encoded:
            continue
        try:
            content = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise RuntimeError("A2A file part is not valid base64.") from exc
        filename = _safe_name(str(file_part.get("name") or f"attachment-{index}"))
        target_root.mkdir(parents=True, exist_ok=True)
        target = target_root / filename
        suffix = 2
        while target.exists():
            target = target_root / f"{Path(filename).stem}-{suffix}{Path(filename).suffix}"
            suffix += 1
        target.write_bytes(content)
        written.append(target.relative_to(workspace).as_posix())
    return written


def _codex_session_id(event: dict[str, Any]) -> str | None:
    """Extract a Codex session identifier from known successful lifecycle events only."""
    if str(event.get("type") or "") in {"thread.started", "session.started"}:
        return str(event.get("thread_id") or event.get("session_id") or event.get("id") or "") or None
    return None


def _codex_text(event: dict[str, Any]) -> str:
    """Extract successful agent text without treating remote error prose as product content."""
    item = event.get("item")
    if isinstance(item, dict) and str(item.get("type") or "") in {"agent_message", "message"}:
        return str(item.get("text") or item.get("content") or "")
    if str(event.get("type") or "") in {"message.completed", "turn.completed"}:
        return str(event.get("message") or event.get("text") or "")
    return ""


def _remote_event_diagnostic(event: dict[str, Any]) -> str | None:
    """Extract bounded remote failure evidence for private logs without returning it to clients."""
    candidates = (
        event.get("diagnostic"),
        event.get("message"),
        event.get("provider_message"),
        event.get("stderr"),
        event.get("error"),
    )
    for candidate in candidates:
        if candidate is None:
            continue
        if isinstance(candidate, dict):
            candidate = candidate.get("message") or candidate.get("detail") or candidate
        text = str(candidate).strip()
        if text:
            return text[:4000]
    return None


def _codex_event_is_failure(event: dict[str, Any]) -> bool:
    """Identify remote error/diagnostic events without interpreting successful agent content as failure."""
    event_type = str(event.get("type") or "").lower()
    return (
        event_type.startswith(("error", "diagnostic"))
        or event_type.endswith((".error", ".failed", ".failure", ".diagnostic"))
        or event.get("error") is not None
        or event.get("diagnostic") is not None
        or event.get("provider_error") is not None
    )


def _classify_codex_event(event: dict[str, Any]) -> dict[str, Any]:
    """Mark raw success explicitly and project remote error/diagnostic events to stable metadata."""
    if _codex_event_is_failure(event):
        failure_code = (
            "A2A_TIMEOUT"
            if "timeout" in str(event.get("type") or "").lower()
            else "A2A_TASK_FAILED"
        )
        return {
            "raw_success": False,
            "raw_source_allowed": False,
            "error": _project_a2a_error(
                failure_code,
                raw_context=_remote_event_diagnostic(event),
            ),
        }
    classified = dict(event)
    classified["raw_success"] = True
    classified["raw_source_allowed"] = True
    content = _codex_text(event)
    if content:
        classified["content"] = content
    return classified


def _workspace_snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        path.relative_to(root).as_posix(): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in root.rglob("*")
        if path.is_file() and ".git" not in path.parts
    }


def _collect_artifacts(root: Path, before: dict[str, tuple[int, int]]) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for path in root.rglob("*"):
        if not path.is_file() or ".git" in path.parts:
            continue
        relative = path.relative_to(root).as_posix()
        current = (path.stat().st_size, path.stat().st_mtime_ns)
        if before.get(relative) == current:
            continue
        artifacts.append(
            {
                "artifact_id": uuid.uuid4().hex,
                "path": relative,
                "name": path.name,
                "size": current[0],
                "mime_type": _mime_type(path),
            }
        )
    return artifacts


def _mime_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _safe_name(value: str) -> str:
    cleaned = "".join(
        character if character.isalnum() or character in {"-", "_", "."} else "-"
        for character in Path(value.replace("\\", "/")).name
    ).strip(".-")
    return cleaned[:180] or "attachment"


def _artifact_base_url(task: A2ATaskRun, *, request: Request | None) -> str:
    if request is not None:
        return str(request.base_url).rstrip("/")
    parsed = urlsplit(task.endpoint_url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")


def _list_tasks(params: dict[str, Any], *, request: Request) -> dict[str, Any]:
    requested_context = str(params.get("contextId") or "").strip()
    limit = min(max(int(params.get("pageSize") or 50), 1), 100)
    with Session(engine) as db:
        statement = select(A2ATaskRun).where(A2ATaskRun.direction == "server")
        if requested_context:
            statement = statement.where(A2ATaskRun.context_id == requested_context)
        tasks = list(db.exec(statement.order_by(A2ATaskRun.created_at.desc()).limit(limit)).all())
    return {"tasks": [_task_payload(task, request=request) for task in tasks]}


def _event_sequence(value: str | None) -> int:
    try:
        return max(int(value or 0), 0)
    except ValueError:
        return 0


def _envelope(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error_envelope(
    request_id: Any,
    code: int,
    product_code: str,
    *,
    raw_context: object | None = None,
) -> dict[str, Any]:
    """Build a JSON-RPC error envelope without exposing parser or provider diagnostics."""
    public_error = _project_a2a_error(
        product_code,
        raw_context=raw_context,
        request_id=request_id if isinstance(request_id, str) else None,
    )
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": code,
            "message": public_error["code"],
            "data": public_error,
        },
    }


def _enabled_settings():
    settings = get_settings()
    if not settings.codex_a2a_enabled:
        raise _a2a_http_error(
            status_code=404,
            detail="Codex A2A adapter is disabled",
            code="A2A_DISABLED",
        )
    return settings


def _authorize(expected: str, authorization: str | None) -> None:
    if expected and authorization != f"Bearer {expected}":
        raise _a2a_http_error(status_code=401, detail="Invalid A2A adapter credential")
