"""Intentional raw diagnostic and fixed-locale Agent reply violations."""

from __future__ import annotations

CANCEL_REPLY = "已停止生成"
RECOVERY_REPLY = "本次响应中断，请重试发送。"


class AgentReply:
    """Stand in for a final Agent reply sink."""


class ChatTurnResponse:
    """Stand in for a typed chat response sink."""


def exception_final_reply() -> AgentReply:
    """Fixture violation: return a caught exception as the final Agent reply."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        return AgentReply(reply=str(exc))


def tool_failure_reply(tool_result: object) -> AgentReply:
    """Fixture violation: expose a Tool/provider diagnostic message as final prose."""
    return AgentReply(reply=tool_result.error.message)


def provider_failure_stream(provider_error: object) -> ChatTurnResponse:
    """Fixture violation: expose a Provider error attribute as a streamed fragment."""
    return ChatTurnResponse(reply_fragment=provider_error.message)


def cancel_agent_reply() -> str:
    """Fixture violation: return a fixed Chinese cancellation reply from an Agent sink."""
    return CANCEL_REPLY


def recover_agent_reply() -> ChatTurnResponse:
    """Fixture violation: publish a fixed Chinese recovery reply through a typed sink."""
    return ChatTurnResponse(reply=RECOVERY_REPLY)


def formatted_exception_reply() -> str:
    """Fixture violation: pass a caught exception into a final-reply formatter."""
    try:
        raise RuntimeError
    except RuntimeError as exc:
        return format_runtime_failure_reply(exc)


def format_runtime_failure_reply(exc: BaseException) -> str:
    """Fixture violation: a final-reply formatter accepts a raw exception value."""
    return f"Model call failed: {exc}"
