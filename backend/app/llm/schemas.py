from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_serializer


class ModelConfigCreateRequest(BaseModel):
    tenant_id: str
    name: str
    auth_mode: str = "api_key"
    provider: Optional[str] = None
    api_protocol: Optional[str] = None
    base_url: Optional[str] = None
    api_key: str = Field(default="", repr=False)
    model: str
    temperature: float = 0.2
    max_output_tokens: int = 8192
    extra_body: dict[str, Any] = Field(default_factory=dict)
    protocol_options: Optional[dict[str, Any]] = None
    is_default: bool = False
    enabled: bool = True


class ModelConfigUpdateRequest(BaseModel):
    tenant_id: str
    name: Optional[str] = None
    auth_mode: Optional[str] = None
    provider: Optional[str] = None
    api_protocol: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = Field(default=None, repr=False)
    model: Optional[str] = None
    temperature: Optional[float] = None
    max_output_tokens: Optional[int] = None
    extra_body: Optional[dict[str, Any]] = None
    protocol_options: Optional[dict[str, Any]] = None
    is_default: Optional[bool] = None
    enabled: Optional[bool] = None


class ModelConfigRead(BaseModel):
    id: str
    tenant_id: str
    name: str
    provider: str
    auth_mode: str
    api_protocol: str
    base_url: Optional[str]
    api_key_masked: str
    model: str
    temperature: float
    max_output_tokens: int
    extra_body: dict[str, Any]
    protocol_options: dict[str, Any]
    legacy_unmapped_options: dict[str, Any]
    trust_status: str
    verification_attempt_status: str
    config_revision: int
    security_revision: int
    is_default: bool
    enabled: bool
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class CodexSubscriptionAccountRead(BaseModel):
    status: str
    plan_type: Optional[str] = None
    message: str


class ModelCapabilityTestResult(BaseModel):
    id: str
    success: bool
    error_code: Optional[str] = None


class ModelProviderErrorDetail(BaseModel):
    code: str
    message: str
    message_key: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)
    upstream_status: Optional[int] = None
    provider_code: Optional[str] = None
    provider_message: Optional[str] = None
    upstream_body: Optional[str] = None
    request_id: Optional[str] = None
    trace_id: Optional[str] = None
    retryable: bool = False

    @model_serializer(mode="wrap")
    def serialize_public(self, handler: Any) -> dict[str, Any]:
        """Strip provider prose and expose only canonical model error metadata on the wire."""
        payload = handler(self)
        payload["message"] = self.code
        for field in ("provider_code", "provider_message", "upstream_body"):
            payload.pop(field, None)
        return payload


class ModelConfigTestResponse(BaseModel):
    success: bool
    message: str
    activated: bool = False
    model: Optional[ModelConfigRead] = None
    output: Optional[str] = None
    attempt_id: Optional[str] = None
    trust_status: Optional[str] = None
    attempt_status: Optional[str] = None
    capabilities: list[ModelCapabilityTestResult] = Field(default_factory=list)
    error: Optional[ModelProviderErrorDetail] = None


class ModelListModelsRequest(BaseModel):
    tenant_id: str
    api_protocol: str
    base_url: Optional[str] = None
    # Absent for the ChatGPT/Codex subscription channel, which needs no API key.
    api_key: Optional[str] = None


class ModelOption(BaseModel):
    id: str
    label: str


class ModelListModelsResponse(BaseModel):
    success: bool
    models: list[ModelOption] = Field(default_factory=list)
    error: Optional[ModelProviderErrorDetail] = None
