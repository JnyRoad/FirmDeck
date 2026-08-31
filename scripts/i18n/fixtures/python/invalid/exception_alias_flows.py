"""Eight public projections of current exception aliases that governance must reject."""

from __future__ import annotations


class ToolError:
    """Stand in for a typed public tool error without executing application imports."""


class ToolProbeResponse:
    """Stand in for the public tool-probe response model."""


class MCPDiscoverResponse:
    """Stand in for the public MCP discovery response model."""


class StreamJobs:
    """Stand in for the SSE job store whose failures are relayed to clients."""

    def fail(self, job_id: str, message: str) -> None:
        """Represent the public failure sink; the fixture never executes this body."""


stream_jobs = StreamJobs()


def typed_tool_client_failure():
    """Fixture violation: project str(exc) through a typed tool response."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        return ToolProbeResponse(error=ToolError(message=str(exc)))


def typed_tool_unexpected_failure():
    """Fixture violation: project repr(exc) through a typed tool response."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        return ToolProbeResponse(error=ToolError(message=repr(exc)))


def typed_http_probe_failure():
    """Fixture violation: project an exception f-string through a typed tool response."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        return ToolProbeResponse(error=ToolError(message=f"{exc}"))


def typed_mcp_discovery_failure():
    """Fixture violation: project format(exc) through a typed MCP response."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        return MCPDiscoverResponse(
            error=ToolError(
                message="{}".format(exc)  # noqa: UP032 - fixture covers format leakage.
            )
        )


def typed_mcp_unexpected_failure():
    """Fixture violation: project percent-formatted exception through a typed MCP response."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        return MCPDiscoverResponse(
            error=ToolError(
                message="%s" % exc  # noqa: UP031 - fixture covers percent leakage.
            )
        )


def distill_stream_failure(job_id: str) -> None:
    """Fixture violation: expose str(exc) through the SSE job failure sink."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        stream_jobs.fail(job_id, str(exc))


def rewrite_stream_failure(job_id: str) -> None:
    """Fixture violation: expose repr(exc) through the SSE job failure sink."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        stream_jobs.fail(job_id, repr(exc))


def persist_a2a_failure(task) -> None:
    """Persist a raw exception only so the paired public payload can expose the data-flow defect."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        task.error_json = {"message": f"{exc}"}


def public_a2a_payload(task) -> dict[str, object]:
    """Fixture violation: project persisted exception text into an A2A status message."""
    message_text = str(task.error_json.get("message") or "")
    status: dict[str, object] = {}
    if message_text:
        status["message"] = {"parts": [{"text": message_text}]}
    return {"status": status}
