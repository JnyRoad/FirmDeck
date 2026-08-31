from __future__ import annotations

from typing import Any, Literal, Optional
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator

from app.capability_scope import CapabilityScope
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
from app.i18n.language_context import LanguageContext
from app.tools.mcp_oauth_policy import validate_mcp_oauth_redirect_uri


class ToolExecutionPolicy(BaseModel):
    timeout_seconds: float = Field(ge=1, le=3600)


class ToolCreateRequest(BaseModel):
    tenant_id: str
    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    bucket: str = "未分桶"
    tool_type: Literal["http", "a2a", "mcp"] = "http"
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = "POST"
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    auth: dict[str, Any] = Field(default_factory=dict)
    mcp_config: dict[str, Any] = Field(default_factory=dict)
    execution_policy: Optional[ToolExecutionPolicy] = None
    input_schema: dict[str, Any] = Field(default_factory=dict)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    allowed_skills: list[str] = Field(default_factory=list)
    capability_scope: CapabilityScope = "general"
    enabled: bool = True


class ToolUpdateRequest(ToolCreateRequest):
    capability_scope: Optional[CapabilityScope] = None


class ToolRead(BaseModel):
    id: str
    tenant_id: str
    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    bucket: str
    tool_type: str
    method: str
    url: str
    headers: dict[str, Any]
    auth: dict[str, Any]
    mcp_config: dict[str, Any]
    execution_policy: Optional[ToolExecutionPolicy] = None
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    allowed_skills: list[str]
    mcp_server_id: Optional[str] = None
    capability_scope: CapabilityScope
    enabled: bool
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class ToolBucketRead(BaseModel):
    bucket: str
    total: int
    enabled_count: int
    disabled_count: int
    tool_ids: list[str] = Field(default_factory=list)


class ToolCall(BaseModel):
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    # Server-only immutable locale context; never serialize it as provider arguments.
    language_context: LanguageContext | None = Field(default=None, exclude=True)


class ToolError(BaseModel):
    """Canonical Tool error with a deprecated safe message and excluded diagnostic context."""

    code: str
    message: str
    params: dict[str, JsonValue] = Field(default_factory=dict)
    retryable: bool = False
    request_id: str | None = None
    trace_id: str | None = None
    deprecated_fields: list[Literal["message"]] = Field(default_factory=lambda: ["message"])
    internal_context: InternalErrorContext | None = Field(
        default=None,
        exclude=True,
        repr=False,
    )

    def model_post_init(self, __context: Any, /) -> None:
        """Retain legacy prose only for internal consumers and private diagnostic inspection."""
        raw_message = self.message
        if self.internal_context is None and raw_message != self.code:
            self.internal_context = InternalErrorContext(
                source="tool",
                raw_message=raw_message,
                upstream_code=self.code,
            )

    @model_serializer(mode="wrap")
    def serialize_public(self, handler: Any) -> dict[str, Any]:
        """Serialize the legacy message as a stable code while excluding private diagnostics."""
        payload = handler(self)
        # Workflow: use the same registry-resolved descriptor for every public field;
        # remote/raw codes and prose never cross the Tool result boundary.
        descriptor = self.to_descriptor()
        payload["code"] = descriptor.code
        payload["params"] = descriptor.params
        payload["retryable"] = descriptor.retryable
        payload["message"] = descriptor.code
        payload["deprecated_fields"] = ["message"]
        return payload

    @classmethod
    def from_occurrence(cls, occurrence: ErrorOccurrence) -> "ToolError":
        """Create a ToolError from an already projected occurrence without reintroducing prose."""
        descriptor = occurrence.descriptor
        return cls(
            code=descriptor.code,
            message=descriptor.code,
            params=descriptor.params,
            retryable=descriptor.retryable,
            request_id=descriptor.request_id,
            trace_id=descriptor.trace_id,
            internal_context=occurrence.internal,
        )

    def to_descriptor(self) -> ErrorDescriptor:
        """Validate exact registry params before a Tool error can cross a public boundary."""
        # Workflow: resolve dynamic tool codes before descriptor construction and
        # fail closed for unregistered/internal remote values or mismatched params.
        entry = ERROR_REGISTRY.get(self.code)
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
                params=self.params,
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
        """Pair public-safe Tool metadata with its excluded diagnostic context."""
        return ErrorOccurrence(
            descriptor=self.to_descriptor(),
            internal=self.internal_context,
        )


class MCPAppDescriptor(BaseModel):
    server_id: str
    resource_uri: str
    tool_name: str
    visibility: list[str] = Field(default_factory=lambda: ["model", "app"])
    mime_type: str = "text/html;profile=mcp-app"
    tenant_id: Optional[str] = None
    agent_id: Optional[str] = None
    session_id: Optional[str] = None
    active_skill_id: Optional[str] = None
    initial_result: Optional[Any] = None
    initial_meta: dict[str, Any] = Field(default_factory=dict)


class ToolResult(BaseModel):
    tool_name: str
    success: bool
    data: Optional[Any] = None
    error: Optional[ToolError] = None
    mcp_app: Optional[MCPAppDescriptor] = None
    mcp_metadata: dict[str, Any] = Field(default_factory=dict)


class ToolTestRequest(BaseModel):
    tenant_id: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolProbeRequest(BaseModel):
    tenant_id: str
    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    bucket: str = "技能自发现工具"
    tool_type: Literal["http", "a2a", "mcp"] = "http"
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = "POST"
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    auth: dict[str, Any] = Field(default_factory=dict)
    mcp_config: dict[str, Any] = Field(default_factory=dict)
    execution_policy: Optional[ToolExecutionPolicy] = None
    input_schema: dict[str, Any] = Field(default_factory=dict)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    sample_arguments: dict[str, Any] = Field(default_factory=dict)


class ToolProbeResponse(BaseModel):
    success: bool
    status_code: Optional[int] = None
    data_preview: Optional[Any] = None
    inferred_output_schema: dict[str, Any] = Field(default_factory=dict)
    error: Optional[ToolError] = None


MCPTransport = Literal["stdio", "streamable_http", "sse", "builtin"]
MCPAppsMode = Literal["disabled", "auto"]
MCPAuthMode = Literal["none", "oauth_personal"]


class MCPServerConnection(BaseModel):
    """MCP Server 连接配置（对齐标准 MCP Client 的连接语义）。"""

    transport: MCPTransport = "streamable_http"
    url: Optional[str] = None
    headers: dict[str, str] = Field(default_factory=dict)
    command: Optional[str] = None
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    cwd: Optional[str] = None


class MCPServerCreateRequest(BaseModel):
    tenant_id: str
    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    bucket: str = "MCP 工具"
    connection: MCPServerConnection = Field(default_factory=MCPServerConnection)
    apps_mode: MCPAppsMode = "disabled"
    auth_mode: MCPAuthMode = "none"
    oauth_client_id: Optional[str] = None
    oauth_client_metadata_url: Optional[str] = None
    oauth_redirect_uri: Optional[str] = None
    capability_scope: CapabilityScope = "general"
    enabled: bool = True

    @model_validator(mode="after")
    def validate_oauth_policy(self) -> "MCPServerCreateRequest":
        """Keep personal OAuth on its supported transport and public client shapes."""
        if self.auth_mode != "oauth_personal":
            return self
        if self.connection.transport != "streamable_http" or not self.connection.url:
            raise ValueError("personal OAuth requires a streamable_http MCP server URL")
        if self.oauth_client_id and self.oauth_client_metadata_url:
            raise ValueError("configure only one OAuth client identification mode")
        if self.oauth_client_metadata_url:
            metadata = urlparse(self.oauth_client_metadata_url)
            if metadata.scheme != "https" or not metadata.netloc or metadata.path in {"", "/"}:
                raise ValueError("OAuth client metadata URL must use HTTPS with a non-root path")
        if self.oauth_redirect_uri:
            self.oauth_redirect_uri = validate_mcp_oauth_redirect_uri(self.oauth_redirect_uri)
        return self


class MCPServerUpdateRequest(MCPServerCreateRequest):
    capability_scope: Optional[CapabilityScope] = None


class MCPDiscoveredTool(BaseModel):
    name: str
    title: str = ""
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    annotations: dict[str, Any] = Field(default_factory=dict)
    meta: dict[str, Any] = Field(default_factory=dict)
    app: Optional[dict[str, Any]] = None
    # 该工具是否已同步为 Tool 行
    imported: bool = False
    tool_id: Optional[str] = None
    enabled: Optional[bool] = None
    capability_scope: Optional[CapabilityScope] = None


class MCPServerRead(BaseModel):
    id: str
    tenant_id: str
    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    bucket: str
    connection: MCPServerConnection
    apps_mode: MCPAppsMode = "disabled"
    auth_mode: MCPAuthMode = "none"
    oauth_client_id: Optional[str] = None
    oauth_client_metadata_url: Optional[str] = None
    oauth_redirect_uri: Optional[str] = None
    apps_negotiated: bool = False
    negotiated_capabilities: dict[str, Any] = Field(default_factory=dict)
    capability_scope: CapabilityScope
    enabled: bool
    last_synced_at: Optional[str] = None
    tool_count: int = 0
    created_at: str
    updated_at: str


class MCPDiscoverRequest(BaseModel):
    tenant_id: str
    # 未保存前用连接配置直接探测；已保存则可只传 server_id
    connection: Optional[MCPServerConnection] = None
    apps_mode: MCPAppsMode = "disabled"


class MCPDiscoverResponse(BaseModel):
    success: bool
    tools: list[MCPDiscoveredTool] = Field(default_factory=list)
    server_capabilities: dict[str, Any] = Field(default_factory=dict)
    server_info: dict[str, Any] = Field(default_factory=dict)
    error: Optional[ToolError] = None


class MCPAppResourceRead(BaseModel):
    server_id: str
    uri: str
    mime_type: str
    text: str
    meta: dict[str, Any] = Field(default_factory=dict)


class MCPAppToolCallRequest(BaseModel):
    tenant_id: str
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    agent_id: Optional[str] = None
    session_id: Optional[str] = None
    active_skill_id: Optional[str] = None
    confirm_side_effect: bool = False


class MCPAppToolCallResponse(BaseModel):
    success: bool
    result: Optional[ToolResult] = None
    requires_confirmation: bool = False
    error: Optional[ToolError] = None


class MCPSyncRequest(BaseModel):
    tenant_id: str
    # 需要导入/更新的工具名；为空表示导入全部发现到的工具
    tool_names: Optional[list[str]] = None
    capability_scope_overrides: dict[str, CapabilityScope] = Field(default_factory=dict)


class MCPSyncResponse(BaseModel):
    success: bool
    imported: list[str] = Field(default_factory=list)
    updated: list[str] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)
    error: Optional[ToolError] = None
