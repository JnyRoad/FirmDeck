"""Intentional indirect exception flows across product responses, jobs, events, and audit APIs."""

from __future__ import annotations


class SkillResponse:
    """Stand in for a typed Skill response carrying public warnings."""


class JobResponse:
    """Stand in for an authenticated job response carrying a persisted error."""


class TerminalQueue:
    """Stand in for the terminal queue consumed by a public SSE response."""

    def put(self, value: object) -> None:
        """Accept one fixture value without executing any queue behavior."""


class EventLog:
    """Stand in for the legacy product event persistence boundary."""

    def record(self, *args: object) -> None:
        """Accept fixture event arguments without persisting them."""


class Span:
    """Stand in for a span whose failure payload is exposed by an authenticated endpoint."""

    def fail(self, error: BaseException) -> None:
        """Accept one fixture error without emitting an actual span."""


terminal = TerminalQueue()
event_log = EventLog()
span = Span()
router = None


def queued_sse_failure() -> None:
    """Fixture violation: relay a caught exception through an indirect terminal queue."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        terminal.put(("error", {"message": str(exc)}))


def webhook_job_failure() -> None:
    """Fixture violation: relay a local exception serialization through a webhook event."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        raw_message = repr(exc)
        emit_job_event("job.failed", {"message": raw_message})


def legacy_event_failure() -> None:
    """Fixture violation: persist a formatted exception through EventLog.record."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        event_log.record("tenant", "session", "run_failed", {"error": f"{exc}"})


def public_span_failure() -> None:
    """Fixture violation: hand a caught exception to a span exposed by a product endpoint."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        span.fail(exc)


def typed_skill_warning() -> SkillResponse:
    """Fixture violation: collect exception prose and return it through a typed response."""
    warnings: list[str] = []
    try:
        raise RuntimeError
    except RuntimeError as exc:
        warnings.append(f"Skill repair failed: {exc}")
    return SkillResponse(warnings=warnings)


def persist_job_failure(row: object) -> None:
    """Fixture violation: persist exception prose in a field later returned by an endpoint."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        row.error = str(exc)


@router.get("/jobs/{job_id}")
def authenticated_job_error(row: object) -> JobResponse:
    """Fixture violation: expose a field known to persist raw exception prose."""
    return JobResponse(error=row.error)


def emit_job_event(event_type: str, payload: dict[str, object]) -> None:
    """Accept fixture event data without dispatching a real webhook."""
