"""共享知识库领域错误：为 HTTP 与 Agent 工具提供稳定代码和安全中文消息。"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from app.contracts.error_registry import (
    ERROR_REGISTRY,
    ErrorContractViolation,
    ErrorVisibility,
)
from app.contracts.errors import (
    ErrorDescriptor,
    ErrorOccurrence,
    InternalErrorContext,
    JsonValue,
)

KNOWLEDGE_CONTEXT_MISMATCH = "KNOWLEDGE_CONTEXT_MISMATCH"
KNOWLEDGE_GRANT_REQUIRED = "KNOWLEDGE_GRANT_REQUIRED"
KNOWLEDGE_DEFAULT_NOT_CONFIGURED = "KNOWLEDGE_DEFAULT_NOT_CONFIGURED"
KNOWLEDGE_PUBLISH_CONFLICT = "KNOWLEDGE_PUBLISH_CONFLICT"
KNOWLEDGE_VERSION_NOT_READY = "KNOWLEDGE_VERSION_NOT_READY"
KNOWLEDGE_MODE_INVALID = "KNOWLEDGE_MODE_INVALID"
KNOWLEDGE_BINDING_REVISION_CONFLICT = "KNOWLEDGE_BINDING_REVISION_CONFLICT"
KNOWLEDGE_IDEMPOTENCY_CONFLICT = "KNOWLEDGE_IDEMPOTENCY_CONFLICT"
KNOWLEDGE_IDEMPOTENCY_REQUIRED = "KNOWLEDGE_IDEMPOTENCY_REQUIRED"
KNOWLEDGE_CONVERSION_VALIDATION_FAILED = "KNOWLEDGE_CONVERSION_VALIDATION_FAILED"
KNOWLEDGE_VERSION_LEVEL_INVALID = "KNOWLEDGE_VERSION_LEVEL_INVALID"
KNOWLEDGE_BASELINE_STALE = "KNOWLEDGE_BASELINE_STALE"
KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED = "KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED"
KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH = "KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH"

_ERROR_DEFAULTS: dict[str, tuple[int, str]] = {
    KNOWLEDGE_CONTEXT_MISMATCH: (403, "当前会话与知识库上下文不匹配。"),
    KNOWLEDGE_GRANT_REQUIRED: (403, "当前员工没有执行此知识库操作所需的权限。"),
    KNOWLEDGE_DEFAULT_NOT_CONFIGURED: (400, "团队尚未配置默认写入知识库。"),
    KNOWLEDGE_PUBLISH_CONFLICT: (409, "知识库正式版本已变化，请基于最新版本重新操作。"),
    KNOWLEDGE_VERSION_NOT_READY: (409, "知识版本尚未完成处理或校验，暂不能发布。"),
    KNOWLEDGE_MODE_INVALID: (409, "当前知识库类型不支持此操作。"),
    KNOWLEDGE_BINDING_REVISION_CONFLICT: (409, "团队知识库配置已变化，请刷新后重试。"),
    KNOWLEDGE_IDEMPOTENCY_CONFLICT: (409, "同一幂等键已用于不同的知识库操作。"),
    KNOWLEDGE_IDEMPOTENCY_REQUIRED: (400, "Agent 知识库变更必须提供幂等键。"),
    KNOWLEDGE_CONVERSION_VALIDATION_FAILED: (409, "知识库转换后的资产校验失败。"),
    KNOWLEDGE_VERSION_LEVEL_INVALID: (400, "知识版本发布级别无效，仅支持 patch/minor/major。"),
    KNOWLEDGE_BASELINE_STALE: (409, "共享知识库正式版本已更新，请先变基后再发布，或确认强制覆盖。"),
    KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED: (409, "变基冲突尚未全部解决，请清除残留的冲突标记。"),
    KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH: (409, "变基缺少部分冲突文档的解决方案。"),
}

_SAFE_PARAM_SUFFIXES = (
    "_count",
    "_counts",
    "_id",
    "_ids",
    "_permission",
    "_revision",
    "_state",
    "_status",
    "_version",
)
_SAFE_PARAM_NAMES = {"count", "revision", "status", "version", "level"}


def _is_safe_param_value(value: Any) -> bool:
    """Accept bounded JSON metadata while rejecting opaque objects and unbounded collections."""
    if value is None or isinstance(value, str | bool | int | float):
        return not isinstance(value, str) or len(value) <= 256
    if isinstance(value, list):
        return len(value) <= 50 and all(_is_safe_param_value(item) for item in value)
    if isinstance(value, dict):
        return len(value) <= 50 and all(
            isinstance(key, str)
            and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", key) is not None
            and _is_safe_param_value(item)
            for key, item in value.items()
        )
    return False


def _safe_knowledge_params(details: Mapping[str, Any]) -> dict[str, JsonValue]:
    """Keep stable identifiers and bounded metadata, excluding source prose and provider bodies."""
    params: dict[str, JsonValue] = {}
    for name, value in details.items():
        stable_name = name in _SAFE_PARAM_NAMES or name.endswith(_SAFE_PARAM_SUFFIXES)
        if stable_name and _is_safe_param_value(value):
            params[name] = value
    return params


class KnowledgeError(RuntimeError):
    """可由 API 和 Harness 统一映射的知识库领域错误。"""

    def __init__(
        self,
        code: str,
        message: str | None = None,
        *,
        status_code: int | None = None,
        details: Mapping[str, Any] | None = None,
        retryable: bool = False,
        request_id: str | None = None,
        trace_id: str | None = None,
    ) -> None:
        """保存稳定代码、HTTP 状态和不含受保护内容的诊断标识。"""
        default_status, default_message = _ERROR_DEFAULTS.get(
            code,
            (400, "知识库操作失败。"),
        )
        self.code = code
        self.status_code = status_code or default_status
        self.message = message or default_message
        self.details = dict(details or {})
        self.retryable = retryable
        self.request_id = request_id
        self.trace_id = trace_id
        super().__init__(self.message)

    def to_descriptor(self) -> ErrorDescriptor:
        """Validate exact registry params before exposing a knowledge descriptor."""
        # Workflow: resolve the domain code before creating a descriptor; unknown or
        # internal values or mismatched params become the public-safe fallback.
        entry = ERROR_REGISTRY.get(self.code)
        safe_params = _safe_knowledge_params(self.details)
        if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
            fallback = ERROR_REGISTRY.require("INTERNAL_ERROR")
            return ErrorDescriptor(
                code=fallback.code,
                params={},
                retryable=fallback.retryable_default,
                request_id=self.request_id,
                trace_id=self.trace_id,
            )
        try:
            descriptor = ErrorDescriptor(
                code=entry.code,
                params=safe_params,
                retryable=self.retryable,
                request_id=self.request_id,
                trace_id=self.trace_id,
            )
            return ERROR_REGISTRY.validate(descriptor)
        except (ErrorContractViolation, ValueError, TypeError):
            fallback = ERROR_REGISTRY.require("INTERNAL_ERROR")
            return ErrorDescriptor(
                code=fallback.code,
                params={},
                retryable=fallback.retryable_default,
                request_id=self.request_id,
                trace_id=self.trace_id,
            )

    def to_occurrence(self) -> ErrorOccurrence:
        """Retain the legacy message and full details as private diagnostic context."""
        return ErrorOccurrence(
            descriptor=self.to_descriptor(),
            internal=InternalErrorContext(
                source="knowledge",
                exception_type=type(self).__name__,
                raw_message=self.message,
                upstream_code=self.code,
            ),
        )

    def to_public_payload(self) -> dict[str, JsonValue]:
        """Project only the registry-validated public descriptor and never legacy prose."""
        occurrence = self.to_occurrence()
        descriptor = occurrence.descriptor
        entry = ERROR_REGISTRY.get(descriptor.code)
        if entry is None or entry.visibility is not ErrorVisibility.PUBLIC:
            fallback = ERROR_REGISTRY.require("INTERNAL_ERROR")
            descriptor = ErrorDescriptor(
                code=fallback.code,
                params={},
                retryable=fallback.retryable_default,
                request_id=descriptor.request_id,
                trace_id=descriptor.trace_id,
            )
        return descriptor.model_dump(mode="json")


def knowledge_error(
    code: str,
    *,
    message: str | None = None,
    status_code: int | None = None,
    details: Mapping[str, Any] | None = None,
    retryable: bool = False,
    request_id: str | None = None,
    trace_id: str | None = None,
) -> KnowledgeError:
    """按稳定错误代码创建知识库异常，供服务层保持一致的失败语义。"""
    return KnowledgeError(
        code,
        message,
        status_code=status_code,
        details=details,
        retryable=retryable,
        request_id=request_id,
        trace_id=trace_id,
    )
