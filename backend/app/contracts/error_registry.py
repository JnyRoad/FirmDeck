"""Registry and parameter-schema validation for stable product error codes."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.contracts.errors import ErrorDescriptor, JsonValue

ParamKind: TypeAlias = Literal["string", "integer", "number", "boolean"]


class ErrorVisibility(StrEnum):
    """Declare whether an error code may be projected to a normal product boundary."""

    PUBLIC = "public"
    INTERNAL = "internal"


class ErrorContractViolation(ValueError):
    """Raised when registry or descriptor data violates the stable product contract."""


class ErrorRegistryEntry(BaseModel):
    """Immutable registry metadata for one globally unique product error code."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    code: str = Field(pattern=r"^[A-Z][A-Z0-9_.-]{2,127}$")
    message_key: str
    default_http_status: int = Field(ge=400, le=599)
    retryable_default: bool
    params_schema: dict[str, ParamKind] = Field(default_factory=dict)
    visibility: ErrorVisibility = ErrorVisibility.PUBLIC

    @field_validator("message_key")
    @classmethod
    def validate_message_key(cls, value: str) -> str:
        """Require a stable semantic key with at least three lower-camel path segments."""
        import re

        if not re.fullmatch(r"[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){2,}", value):
            raise ValueError("message_key must be a stable semantic identifier")
        return value


def _matches_kind(value: JsonValue, kind: ParamKind) -> bool:
    """Check one safe JSON value against a registry kind without treating bool as an integer."""
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class ErrorRegistry:
    """Own registered error metadata and validate exact named parameter schemas."""

    def __init__(self) -> None:
        """Create an empty in-memory registry with no external side effects."""
        self._entries: dict[str, ErrorRegistryEntry] = {}

    def register(self, entry: ErrorRegistryEntry) -> None:
        """Register one unique code; duplicates fail so import order cannot silently change meaning."""
        if entry.code in self._entries:
            raise ErrorContractViolation(f"error code already registered: {entry.code}")
        self._entries[entry.code] = entry

    def get(self, code: str) -> ErrorRegistryEntry | None:
        """Return registry metadata without inventing a fallback or mutating registry state."""
        return self._entries.get(code)

    def require(self, code: str) -> ErrorRegistryEntry:
        """Return a known entry or raise a stable contract violation for caller diagnostics."""
        entry = self.get(code)
        if entry is None:
            raise ErrorContractViolation(f"unregistered error code: {code}")
        return entry

    def validate(self, descriptor: ErrorDescriptor) -> ErrorDescriptor:
        """Validate code, exact parameter names, and primitive parameter kinds."""
        entry = self.require(descriptor.code)
        expected_names = set(entry.params_schema)
        actual_names = set(descriptor.params)
        missing = sorted(expected_names - actual_names)
        unexpected = sorted(actual_names - expected_names)
        if missing:
            raise ErrorContractViolation(
                f"{descriptor.code} missing params: {', '.join(missing)}"
            )
        if unexpected:
            raise ErrorContractViolation(
                f"{descriptor.code} unexpected params: {', '.join(unexpected)}"
            )
        for name, kind in entry.params_schema.items():
            if not _matches_kind(descriptor.params[name], kind):
                raise ErrorContractViolation(
                    f"{descriptor.code} param {name} must be {kind}"
                )
        return descriptor

    def entries(self) -> tuple[ErrorRegistryEntry, ...]:
        """Return a deterministic immutable snapshot for coverage and catalog validation."""
        return tuple(self._entries[code] for code in sorted(self._entries))


def build_default_error_registry() -> ErrorRegistry:
    """Build the cross-domain registry used by current public compatibility adapters."""
    registry = ErrorRegistry()
    registry.register(
        ErrorRegistryEntry(
            code="INTERNAL_ERROR",
            message_key="errors.common.internal",
            default_http_status=500,
            retryable_default=False,
            params_schema={},
            visibility=ErrorVisibility.PUBLIC,
        )
    )
    registry.register(
        ErrorRegistryEntry(
            code="VALIDATION_ERROR",
            message_key="errors.common.validation",
            default_http_status=422,
            retryable_default=False,
            params_schema={"error_count": "integer"},
            visibility=ErrorVisibility.PUBLIC,
        )
    )
    registry.register(
        ErrorRegistryEntry(
            code="NOT_AUTHENTICATED",
            message_key="errors.publicApi.notAuthenticated",
            default_http_status=401,
            retryable_default=False,
            params_schema={},
            visibility=ErrorVisibility.PUBLIC,
        )
    )
    registry.register(
        ErrorRegistryEntry(
            code="KNOWLEDGE_UPSTREAM_TIMEOUT",
            message_key="errors.capability.knowledgeUpstreamTimeout",
            default_http_status=503,
            retryable_default=True,
            params_schema={"provider_id": "string"},
            visibility=ErrorVisibility.PUBLIC,
        )
    )
    knowledge_entries = (
        ("KNOWLEDGE_CONTEXT_MISMATCH", "contextMismatch", 403),
        ("KNOWLEDGE_GRANT_REQUIRED", "grantRequired", 403),
        ("KNOWLEDGE_DEFAULT_NOT_CONFIGURED", "defaultNotConfigured", 400),
        ("KNOWLEDGE_PUBLISH_CONFLICT", "publishConflict", 409),
        ("KNOWLEDGE_VERSION_NOT_READY", "versionNotReady", 409),
        ("KNOWLEDGE_MODE_INVALID", "modeInvalid", 409),
        ("KNOWLEDGE_BINDING_REVISION_CONFLICT", "bindingRevisionConflict", 409),
        ("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "idempotencyConflict", 409),
        ("KNOWLEDGE_IDEMPOTENCY_REQUIRED", "idempotencyRequired", 400),
        ("KNOWLEDGE_CONVERSION_VALIDATION_FAILED", "conversionValidationFailed", 409),
    )
    for code, key_suffix, status in knowledge_entries:
        # Compatibility adapters sanitize variable legacy details before projection;
        # a later versioned contract can promote stable per-code params to this schema.
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.knowledge.{key_suffix}",
                default_http_status=status,
                retryable_default=False,
                params_schema={},
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    # Harness capability invocations use one explicit failure sink.  Its product
    # branches expose no user/resource payload; provider and persistence causes stay
    # in the private diagnostic context of the invoker.
    harness_entries = (
        ("TOOL_NOT_AVAILABLE", "errors.tool.notAvailable", 404, False),
        ("CAPABILITY_NOT_ACTIVATED", "errors.capability.notActivated", 409, False),
        (
            "CAPABILITY_AUTHORIZATION_REVOKED",
            "errors.capability.authorizationRevoked",
            403,
            False,
        ),
        ("UNSUPPORTED_CAPABILITY", "errors.capability.unsupported", 400, False),
        ("HARNESS_TOOL_ERROR", "errors.harness.toolError", 500, False),
        ("HARNESS_ACTION_INVALID", "errors.harness.actionInvalid", 502, True),
        (
            "REQUIRED_CAPABILITY_NOT_INVOKED",
            "errors.harness.requiredCapabilityNotInvoked",
            409,
            False,
        ),
        (
            "KNOWLEDGE_SEARCH_BUDGET_EXHAUSTED",
            "errors.harness.knowledgeSearchBudgetExhausted",
            409,
            False,
        ),
        (
            "NON_RETRYABLE_ACTION_REPEATED",
            "errors.harness.nonRetryableActionRepeated",
            409,
            False,
        ),
        ("ACTION_BUDGET_EXHAUSTED", "errors.harness.actionBudgetExhausted", 409, True),
        ("SOP_STEP_TIMEOUT", "errors.harness.sopStepTimeout", 504, True),
        ("DEPENDENCY_WAITING", "errors.harness.dependencyWaiting", 409, True),
        ("SOP_NOT_AVAILABLE", "errors.harness.sopNotAvailable", 409, False),
        ("HANDOFF_NOT_ALLOWED", "errors.harness.handoffNotAllowed", 409, False),
        ("TOOL_CALL_OUTCOME_UNKNOWN", "errors.tool.callOutcomeUnknown", 409, False),
        (
            "UNSUPPORTED_INTERNAL_CAPABILITY",
            "errors.capability.unsupportedInternal",
            400,
            False,
        ),
        ("INVALID_ARGUMENTS", "errors.common.invalidArguments", 422, False),
        (
            "PUBLISHED_DELIVERABLE_NOT_FOUND",
            "errors.harness.publishedDeliverableNotFound",
            404,
            False,
        ),
        (
            "PUBLISHED_DELIVERABLE_CHANGED",
            "errors.harness.publishedDeliverableChanged",
            409,
            False,
        ),
        (
            "PUBLISHED_DELIVERABLE_LOCATION_CONFLICT",
            "errors.harness.publishedDeliverableLocationConflict",
            409,
            False,
        ),
        ("CAPABILITY_NOT_AVAILABLE", "errors.capability.notAvailable", 404, False),
        ("SKILL_NOT_AVAILABLE", "errors.skill.notAvailable", 404, False),
        ("CAPABILITY_SNAPSHOT_CHANGED", "errors.capability.snapshotChanged", 409, False),
        ("KNOWLEDGE_NOT_AVAILABLE", "errors.knowledge.notAvailable", 403, False),
        (
            "TOOL_RESULT_PERSIST_FAILED",
            "errors.harness.toolResultPersistFailed",
            500,
            False,
        ),
    )
    for code, message_key, status, retryable in harness_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=message_key,
                default_http_status=status,
                retryable_default=retryable,
                params_schema={},
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    # Workflow: keep each product boundary on a stable code before its natural-language
    # projection is introduced.  The table is intentionally data-only so review can compare
    # status, retryability, and named parameter contracts without following import order.
    model_entries = (
        ("MODEL_AUTH_MODE_UNSUPPORTED", "authModeUnsupported", 422, False, {}),
        ("MODEL_PROVIDER_UNSUPPORTED", "providerUnsupported", 422, False, {}),
        ("MODEL_PROTOCOL_UNSUPPORTED", "protocolUnsupported", 422, False, {}),
        ("MODEL_PROTOCOL_CONFLICT", "protocolConflict", 422, False, {}),
        ("MODEL_PROTOCOL_OPTIONS_INVALID", "protocolOptionsInvalid", 422, False, {}),
        ("MODEL_BASE_URL_INVALID", "baseUrlInvalid", 422, False, {}),
        ("MODEL_API_KEY_REQUIRED", "apiKeyRequired", 422, False, {}),
        ("MODEL_CONFIG_DEFAULT_MISSING", "configDefaultMissing", 400, False, {}),
        ("MODEL_CONFIG_DISABLED", "configDisabled", 409, False, {}),
        ("MODEL_CONFIG_VERIFICATION_REQUIRED", "configVerificationRequired", 409, False, {}),
        ("MODEL_VERIFICATION_STALE", "verificationStale", 409, False, {}),
        ("MODEL_CONFIG_NOT_FOUND", "configNotFound", 404, False, {"config_id": "string"}),
        ("MODEL_SUBSCRIPTION_API_KEY_FORBIDDEN", "subscriptionApiKeyForbidden", 422, False, {}),
        (
            "MODEL_SUBSCRIPTION_DIRECT_CONFIG_FORBIDDEN",
            "subscriptionDirectConfigForbidden",
            422,
            False,
            {},
        ),
        ("MODEL_EXTRA_BODY_UNSUPPORTED", "extraBodyUnsupported", 422, False, {}),
        ("MODEL_TEMPERATURE_INVALID", "temperatureInvalid", 422, False, {}),
        ("MODEL_MAX_OUTPUT_TOKENS_INVALID", "maxOutputTokensInvalid", 422, False, {}),
        ("MODEL_DEFAULT_CONFLICT", "defaultConflict", 409, False, {}),
        ("MODEL_CONNECTION_FAILED", "connectionFailed", 502, True, {}),
        ("MODEL_VERIFICATION_FAILED", "verificationFailed", 502, True, {}),
        ("MODEL_VERIFICATION_INTERNAL_ERROR", "verificationInternalError", 500, False, {}),
        ("MODEL_VERIFICATION_DEADLINE_EXCEEDED", "verificationDeadlineExceeded", 504, True, {}),
        ("MODEL_AUTHENTICATION_FAILED", "authenticationFailed", 401, False, {}),
        ("MODEL_PERMISSION_DENIED", "permissionDenied", 403, False, {}),
        ("MODEL_ENDPOINT_NOT_FOUND", "endpointNotFound", 404, False, {}),
        ("MODEL_RATE_LIMITED", "rateLimited", 429, True, {}),
        ("MODEL_TIMEOUT", "timeout", 504, True, {}),
        ("MODEL_INVALID_REQUEST", "invalidRequest", 422, False, {}),
        ("MODEL_UPSTREAM_CONFLICT", "upstreamConflict", 409, False, {}),
        ("MODEL_REQUEST_TOO_LARGE", "requestTooLarge", 413, False, {}),
        ("MODEL_UPSTREAM_UNAVAILABLE", "upstreamUnavailable", 503, True, {}),
        ("MODEL_UPSTREAM_ERROR", "upstreamError", 502, True, {}),
        ("MODEL_CANCELLED", "cancelled", 409, False, {}),
        ("MODEL_EMPTY_OUTPUT", "emptyOutput", 502, True, {}),
        ("MODEL_INVALID_JSON", "invalidJson", 502, False, {}),
        ("MODEL_INVALID_PROVIDER_RESPONSE", "invalidProviderResponse", 502, False, {}),
        ("MODEL_REQUEST_EMPTY", "requestEmpty", 422, False, {}),
        ("MODEL_TOO_MANY_IMAGES", "tooManyImages", 422, False, {}),
        ("MODEL_IMAGE_DATA_URL_INVALID", "imageDataUrlInvalid", 422, False, {}),
        ("MODEL_IMAGE_TOO_LARGE", "imageTooLarge", 413, False, {}),
        ("MODEL_SUBSCRIPTION_ACCESS_DENIED", "subscriptionAccessDenied", 403, False, {}),
        ("MODEL_SUBSCRIPTION_AUTH_REQUIRED", "subscriptionAuthRequired", 401, False, {}),
        ("MODEL_SUBSCRIPTION_BROWSER_UNAVAILABLE", "subscriptionBrowserUnavailable", 503, True, {}),
        ("MODEL_SUBSCRIPTION_NETWORK_UNAVAILABLE", "subscriptionNetworkUnavailable", 503, True, {}),
        ("MODEL_SUBSCRIPTION_QUOTA_EXCEEDED", "subscriptionQuotaExceeded", 429, True, {}),
        ("MODEL_SUBSCRIPTION_RUNTIME_FAILED", "subscriptionRuntimeFailed", 502, True, {}),
        (
            "MODEL_SUBSCRIPTION_RUNTIME_PROTOCOL_ERROR",
            "subscriptionRuntimeProtocolError",
            502,
            False,
            {},
        ),
        ("MODEL_SUBSCRIPTION_RUNTIME_TIMEOUT", "subscriptionRuntimeTimeout", 504, True, {}),
        ("MODEL_SUBSCRIPTION_RUNTIME_UNAVAILABLE", "subscriptionRuntimeUnavailable", 503, True, {}),
    )
    for code, key_suffix, status, retryable, params_schema in model_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.model.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    auth_entries = (
        ("AUTH_LOGIN_FIELDS_REQUIRED", "loginFieldsRequired", 400, False, {}),
        ("AUTH_PASSWORD_POLICY_VIOLATION", "passwordPolicyViolation", 400, False, {}),
        ("AUTH_INVALID_CREDENTIALS", "invalidCredentials", 401, False, {}),
        ("AUTH_AVATAR_NOT_FOUND", "avatarNotFound", 404, False, {}),
        ("AUTH_AVATAR_TOO_LARGE", "avatarTooLarge", 413, False, {}),
        ("AUTH_AVATAR_FORMAT_UNSUPPORTED", "avatarFormatUnsupported", 400, False, {}),
        ("AUTH_ACCOUNT_EXISTS", "accountExists", 409, False, {}),
        ("AUTH_API_CREDENTIAL_INACTIVE", "apiCredentialInactive", 409, False, {}),
        ("AUTH_API_CREDENTIAL_UNRECOVERABLE", "apiCredentialUnrecoverable", 409, False, {}),
        ("AUTH_ACCOUNT_NOT_FOUND", "accountNotFound", 404, False, {}),
        ("AUTH_SELF_ROLE_CHANGE_FORBIDDEN", "selfRoleChangeForbidden", 400, False, {}),
        ("AUTH_ADMIN_DELETE_FORBIDDEN", "adminDeleteForbidden", 400, False, {}),
        ("AUTH_ACCOUNT_API_CREDENTIAL_NOT_FOUND", "accountApiCredentialNotFound", 404, False, {}),
        ("AUTH_NOT_AUTHENTICATED", "notAuthenticated", 401, False, {}),
        ("AUTH_INVALID_USER_TOKEN", "invalidUserToken", 401, False, {}),
        ("AUTH_INVALID_TOKEN", "invalidToken", 401, False, {}),
        ("AUTH_INVALID_TOKEN_SIGNATURE", "invalidTokenSignature", 401, False, {}),
        ("AUTH_INVALID_TOKEN_PAYLOAD", "invalidTokenPayload", 401, False, {}),
        ("AUTH_TOKEN_EXPIRED", "tokenExpired", 401, False, {}),
        ("AUTH_INTERNAL_SERVICE_REQUIRED", "internalServiceRequired", 401, False, {}),
        ("AUTH_ADMIN_REQUIRED", "adminRequired", 403, False, {}),
        ("AUTH_TENANT_MISMATCH", "tenantMismatch", 403, False, {}),
        (
            "TEMPORARY_PASSWORD_CHANGE_REQUIRED",
            "temporaryPasswordChangeRequired",
            403,
            False,
            {},
        ),
        ("AUTH_CREDENTIAL_NOT_FOUND", "credentialNotFound", 404, False, {}),
        ("AUTH_CREDENTIAL_RECOVERY_FAILED", "credentialRecoveryFailed", 409, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in auth_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.auth.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    system_entries = (
        ("SYSTEM_AUTH_UNAVAILABLE", "errors.system.authUnavailable", 503, False, {}),
        (
            "SYSTEM_AUTH_INVALID_CREDENTIALS",
            "errors.systemAuth.invalidCredentials",
            401,
            False,
            {},
        ),
        ("SYSTEM_ADMIN_DISABLED", "errors.system.adminDisabled", 401, False, {}),
        ("SYSTEM_CONTROL_CONFLICT", "errors.system.controlConflict", 409, False, {}),
    )
    for code, message_key, status, retryable, params_schema in system_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=message_key,
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    security_entries = (
        ("TENANT_NOT_FOUND", "errors.tenant.notFound", 404, False, {"tenant_id": "string"}),
        ("TENANT_SUSPENDED", "errors.tenant.suspended", 403, False, {}),
        (
            "TENANT_LIFECYCLE_CHECK_FAILED",
            "errors.tenant.lifecycleCheckFailed",
            503,
            False,
            {},
        ),
        ("TENANT_WORK_TERMINALIZED", "errors.tenant.workTerminalized", 409, False, {}),
        ("EXTERNAL_OUTCOME_UNKNOWN", "errors.tenant.externalOutcomeUnknown", 409, False, {}),
        ("TENANT_MISMATCH", "errors.tenant.mismatch", 403, False, {}),
        ("AGENT_NOT_FOUND", "errors.agent.notFound", 404, False, {}),
        ("PERMISSION_TENANT_ADMIN_REQUIRED", "errors.permission.tenantAdminRequired", 403, False, {}),
        ("PERMISSION_AGENT_NOT_FOUND", "errors.permission.agentNotFound", 404, False, {}),
        ("PERMISSION_AGENT_ACCESS_DENIED", "errors.permission.agentAccessDenied", 403, False, {}),
        (
            "PERMISSION_OVERALL_AGENT_ADMIN_REQUIRED",
            "errors.permission.overallAgentAdminRequired",
            403,
            False,
            {},
        ),
        (
            "PERMISSION_AGENT_OWNER_OR_ADMIN_REQUIRED",
            "errors.permission.agentOwnerOrAdminRequired",
            403,
            False,
            {},
        ),
        ("PERMISSION_OPEN_GALLERY_ADMIN_REQUIRED", "errors.permission.openGalleryAdminRequired", 403, False, {}),
        ("PERMISSION_AGENT_COPY_DENIED", "errors.permission.agentCopyDenied", 403, False, {}),
    )
    for code, message_key, status, retryable, params_schema in security_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=message_key,
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    # Workflow: domain adapters keep their producer-specific code names, while this
    # registry remains the single source of message keys, status and safe parameters.
    # Keep user/resource identifiers out of these contracts unless a producer passes
    # a bounded, explicitly named value.
    agent_entries = (
        ("AGENT_ACCESS_FORBIDDEN", "accessForbidden", 403, False, {}),
        ("AGENT_CREDENTIAL_INACTIVE", "credentialInactive", 409, False, {}),
        ("AGENT_CREDENTIAL_NOT_FOUND", "credentialNotFound", 404, False, {}),
        ("AGENT_CREDENTIAL_RECOVERY_REQUIRED", "credentialRecoveryRequired", 409, False, {}),
        ("AGENT_GALLERY_UPDATE_FORBIDDEN", "galleryUpdateForbidden", 403, False, {}),
        ("AGENT_GLOBAL_RESOURCE_POOL", "globalResourcePool", 400, False, {}),
        ("AGENT_GLOBAL_SKILL_ROLLBACK_REQUIRED", "globalSkillRollbackRequired", 400, False, {}),
        ("AGENT_KNOWLEDGE_BASE_NOT_PUBLISHED", "knowledgeBaseNotPublished", 400, False, {}),
        ("AGENT_KNOWLEDGE_BRANCH_NOT_FOUND", "knowledgeBranchNotFound", 404, False, {}),
        ("AGENT_MANAGE_FORBIDDEN", "manageForbidden", 403, False, {}),
        ("AGENT_NAME_CONFLICT", "nameConflict", 409, False, {}),
        ("AGENT_NAME_REQUIRED", "nameRequired", 400, False, {}),
        (
            "AGENT_OPEN_GALLERY_CREDENTIAL_FORBIDDEN",
            "openGalleryCredentialForbidden",
            400,
            False,
            {},
        ),
        ("AGENT_OVERALL_BRANCH_UNAVAILABLE", "overallBranchUnavailable", 400, False, {}),
        ("AGENT_OVERALL_CREATE_FORBIDDEN", "overallCreateForbidden", 403, False, {}),
        ("AGENT_OVERALL_DELETE_FORBIDDEN", "overallDeleteForbidden", 400, False, {}),
        ("AGENT_OVERALL_MANAGE_FORBIDDEN", "overallManageForbidden", 403, False, {}),
        ("AGENT_OVERALL_ONLY_REQUIRED", "overallOnlyRequired", 403, False, {}),
        ("AGENT_OVERALL_TRUNK", "overallTrunk", 400, False, {}),
        ("AGENT_OVERALL_UNPUBLISH_FORBIDDEN", "overallUnpublishForbidden", 400, False, {}),
        ("AGENT_RESOURCES_REQUIRED", "resourcesRequired", 400, False, {}),
        ("AGENT_RESOURCE_COPY_FORBIDDEN", "resourceCopyForbidden", 403, False, {}),
        ("AGENT_RESOURCE_IMPORT_BUSY", "resourceImportBusy", 503, True, {}),
        ("AGENT_RESOURCE_NOT_FOUND", "resourceNotFound", 404, False, {}),
        ("AGENT_RESOURCE_SOURCE_TARGET_SAME", "resourceSourceTargetSame", 400, False, {}),
        ("AGENT_SKILL_BRANCH_NOT_FOUND", "skillBranchNotFound", 404, False, {}),
        ("AGENT_SKILL_NOT_PUBLISHED", "skillNotPublished", 400, False, {}),
        ("AGENT_SKILL_VERSION_NOT_FOUND", "skillVersionNotFound", 404, False, {}),
        ("AGENT_TIMEZONE_INVALID", "timezoneInvalid", 400, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in agent_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.agent.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    general_skill_entries = (
        ("GENERAL_SKILL_AGENT_SCOPE_REQUIRED", "agentScopeRequired", 400, False, {}),
        ("GENERAL_SKILL_CONTENT_INVALID_BASE64", "contentInvalidBase64", 400, False, {}),
        ("GENERAL_SKILL_CONTENT_REQUIRED", "contentRequired", 400, False, {}),
        ("GENERAL_SKILL_DIRECTORY_CONFLICT", "directoryConflict", 400, False, {}),
        ("GENERAL_SKILL_DOWNLOAD_FAILED", "downloadFailed", 400, True, {}),
        ("GENERAL_SKILL_DOWNLOAD_TIMEOUT", "downloadTimeout", 504, True, {}),
        ("GENERAL_SKILL_FIELD_REQUIRED", "fieldRequired", 400, False, {"field": "string"}),
        ("GENERAL_SKILL_FILENAME_REQUIRED", "filenameRequired", 400, False, {}),
        ("GENERAL_SKILL_FILE_PATH_INVALID", "filePathInvalid", 400, False, {}),
        ("GENERAL_SKILL_GITHUB_DOWNLOAD_FAILED", "githubDownloadFailed", 400, True, {}),
        ("GENERAL_SKILL_GITHUB_SOURCE_INVALID", "githubSourceInvalid", 400, False, {}),
        ("GENERAL_SKILL_NOT_FOUND", "notFound", 404, False, {}),
        ("GENERAL_SKILL_NOT_PUBLISHED", "notPublished", 400, False, {}),
        ("GENERAL_SKILL_NOT_VISIBLE", "notVisible", 404, False, {}),
        ("GENERAL_SKILL_PACKAGE_EMPTY", "packageEmpty", 400, False, {}),
        ("GENERAL_SKILL_PACKAGE_TOO_LARGE", "packageTooLarge", 413, False, {}),
        ("GENERAL_SKILL_PUBLISH_FORBIDDEN", "publishForbidden", 403, False, {}),
        ("GENERAL_SKILL_RAW_SOURCE_INVALID", "rawSourceInvalid", 400, False, {}),
        ("GENERAL_SKILL_REFERENCED_FILE_MISSING", "referencedFileMissing", 400, False, {}),
        ("GENERAL_SKILL_REMOTE_JSON_INVALID", "remoteJsonInvalid", 400, False, {}),
        ("GENERAL_SKILL_SKILL_FILE_EMPTY", "skillFileEmpty", 400, False, {}),
        ("GENERAL_SKILL_SKILL_FILE_REQUIRED", "skillFileRequired", 400, False, {}),
        ("GENERAL_SKILL_SLUG_CONFLICT", "slugConflict", 409, False, {}),
        ("GENERAL_SKILL_SLUG_IMMUTABLE", "slugImmutable", 400, False, {}),
        ("GENERAL_SKILL_SLUG_INVALID", "slugInvalid", 400, False, {}),
        ("GENERAL_SKILL_SOURCE_HTML_UNAVAILABLE", "sourceHtmlUnavailable", 400, False, {}),
        ("GENERAL_SKILL_SOURCE_INDIRECTION_LIMIT", "sourceIndirectionLimit", 400, False, {}),
        ("GENERAL_SKILL_SOURCE_INVALID", "sourceInvalid", 400, False, {}),
        ("GENERAL_SKILL_SOURCE_REDIRECT", "sourceRedirect", 400, False, {}),
        ("GENERAL_SKILL_SOURCE_UNSUPPORTED", "sourceUnsupported", 400, False, {}),
        ("GENERAL_SKILL_UPLOAD_FORMAT_INVALID", "uploadFormatInvalid", 400, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in general_skill_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.generalSkill.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    skill_entries = (
        ("SKILL_ACTIVE_VERSION_DELETE_FORBIDDEN", "activeVersionDeleteForbidden", 409, False, {}),
        ("SKILL_DOCX_INVALID", "docxInvalid", 400, False, {}),
        ("SKILL_DOCX_XML_INVALID", "docxXmlInvalid", 400, False, {}),
        ("SKILL_FILE_CONTENT_INVALID", "fileContentInvalid", 400, False, {}),
        ("SKILL_FILE_TEXT_MISSING", "fileTextMissing", 400, False, {}),
        ("SKILL_FILE_TOO_LARGE", "fileTooLarge", 413, False, {}),
        ("SKILL_FILE_TYPE_UNSUPPORTED", "fileTypeUnsupported", 400, False, {}),
        ("SKILL_GALLERY_NOT_VISIBLE", "galleryNotVisible", 404, False, {}),
        ("SKILL_HANDOFF_ASSIGNEE_EXTERNAL", "handoffAssigneeExternal", 400, False, {}),
        ("SKILL_HANDOFF_ASSIGNEE_NOT_FOUND", "handoffAssigneeNotFound", 400, False, {}),
        ("SKILL_HANDOFF_ASSIGNEE_UNREACHABLE", "handoffAssigneeUnreachable", 400, False, {}),
        ("SKILL_HANDOFF_CHANNEL_UNSUPPORTED", "handoffChannelUnsupported", 400, False, {}),
        ("SKILL_ID_CONFLICT", "idConflict", 409, False, {}),
        ("SKILL_ID_IMMUTABLE", "idImmutable", 400, False, {}),
        ("SKILL_JOB_NOT_FOUND", "jobNotFound", 404, False, {}),
        ("SKILL_NESTING_INVALID", "nestingInvalid", 400, False, {}),
        ("SKILL_NOT_FOUND", "notFound", 404, False, {}),
        ("SKILL_NOT_VISIBLE", "notVisible", 404, False, {}),
        ("SKILL_ONLY_OVERALL_DRAFT", "onlyOverallDraft", 403, False, {}),
        ("SKILL_PATH_ID_MISMATCH", "pathIdMismatch", 400, False, {}),
        ("SKILL_UPSTREAM_FAILURE", "upstreamFailure", 502, True, {}),
        ("SKILL_VERSION_NOT_FOUND", "versionNotFound", 404, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in skill_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.skill.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    scheduled_task_entries = (
        ("SCHEDULED_TASK_ACCESS_FORBIDDEN", "accessForbidden", 403, False, {}),
        ("SCHEDULED_TASK_AGENT_ACCESS_FORBIDDEN", "agentAccessForbidden", 403, False, {}),
        ("SCHEDULED_TASK_AGENT_UNAVAILABLE", "agentUnavailable", 404, False, {}),
        ("SCHEDULED_TASK_DAY_OF_MONTH_INVALID", "dayOfMonthInvalid", 400, False, {}),
        ("SCHEDULED_TASK_FIELD_REQUIRED", "fieldRequired", 400, False, {"field": "string"}),
        ("SCHEDULED_TASK_RUN_AT_REQUIRED", "runAtRequired", 400, False, {}),
        ("SCHEDULED_TASK_SOP_SNAPSHOT_FAILED", "sopSnapshotFailed", 400, False, {}),
        ("SCHEDULED_TASK_SOP_UNAVAILABLE", "sopUnavailable", 400, False, {}),
        ("SCHEDULED_TASK_TIMEZONE_INVALID", "timezoneInvalid", 400, False, {}),
        ("SCHEDULED_TASK_TIME_INVALID", "timeInvalid", 400, False, {}),
        ("SCHEDULED_TASK_TYPE_UNSUPPORTED", "typeUnsupported", 400, False, {}),
        ("SCHEDULED_TASK_WEEKDAYS_INVALID", "weekdaysInvalid", 400, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in scheduled_task_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.scheduledTask.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    team_entries = (
        ("TEAM_AGENT_INACTIVE", "agentInactive", 400, False, {}),
        ("TEAM_AGENT_NOT_FOUND", "agentNotFound", 404, False, {}),
        ("TEAM_AGENT_NOT_MEMBER", "agentNotMember", 404, False, {}),
        ("TEAM_MEMBER_DUPLICATE", "memberDuplicate", 409, False, {}),
        ("TEAM_MEMBER_NOT_FOUND", "memberNotFound", 404, False, {}),
        ("TEAM_MEMBER_ROLE_INVALID", "memberRoleInvalid", 400, False, {"role": "string"}),
        ("TEAM_NAME_CONFLICT", "nameConflict", 409, False, {}),
        ("TEAM_NAME_REQUIRED", "nameRequired", 400, False, {}),
        ("TEAM_NOT_FOUND", "notFound", 404, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in team_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.team.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    chat_entries = (
        ("CHAT_ATTACHMENT_INVALID", "attachmentInvalid", 400, False, {}),
        ("CHAT_ATTACHMENTS_REQUIRED", "attachmentsRequired", 400, False, {}),
        (
            "CHAT_ATTACHMENT_LIMIT_EXCEEDED",
            "attachmentLimitExceeded",
            400,
            False,
            {"max_count": "integer"},
        ),
        (
            "CHAT_ATTACHMENT_TOO_LARGE",
            "attachmentTooLarge",
            413,
            False,
            {"max_bytes": "integer"},
        ),
        ("CHAT_AGENT_ACCESS_FORBIDDEN", "agentAccessForbidden", 403, False, {}),
        ("CHAT_AGENT_REQUIRED", "agentRequired", 400, False, {}),
        ("CHAT_AGENT_UNAVAILABLE", "agentUnavailable", 404, False, {}),
        ("CHAT_ARTIFACT_CHANGED", "artifactChanged", 409, False, {}),
        ("CHAT_ARTIFACT_LOCATION_CONFLICT", "artifactLocationConflict", 409, False, {}),
        ("CHAT_ARTIFACT_NOT_FOUND", "artifactNotFound", 404, False, {}),
        ("CHAT_HANDOFF_ACCESS_FORBIDDEN", "handoffAccessForbidden", 403, False, {}),
        ("CHAT_HANDOFF_NOT_FOUND", "handoffNotFound", 404, False, {}),
        ("CHAT_HANDOFF_NOT_PENDING", "handoffNotPending", 409, False, {}),
        ("CHAT_HANDOFF_REPLY_REQUIRED", "handoffReplyRequired", 400, False, {}),
        ("CHAT_HANDOFF_SESSION_UNAVAILABLE", "handoffSessionUnavailable", 409, False, {}),
        ("CHAT_MESSAGE_NOT_FOUND", "messageNotFound", 404, False, {}),
        ("CHAT_MESSAGE_REQUIRED", "messageRequired", 400, False, {}),
        ("CHAT_SESSION_AGENT_CONFLICT", "sessionAgentConflict", 409, False, {}),
        ("CHAT_SESSION_NOT_FOUND", "sessionNotFound", 404, False, {}),
        ("CHAT_SESSION_TITLE_REQUIRED", "sessionTitleRequired", 400, False, {}),
        ("CHAT_TEAM_SESSION_READ_ONLY", "teamSessionReadOnly", 403, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in chat_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.chat.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    team_api_entries = (
        ("TEAM_MANAGE_FORBIDDEN", "manageForbidden", 403, False, {}),
        ("TEAM_TASK_NOT_FOUND", "taskNotFound", 404, False, {}),
        ("TEAM_MESSAGE_REQUIRED", "messageRequired", 400, False, {}),
        ("TEAM_LEADER_REQUIRED", "leaderRequired", 400, False, {}),
        ("TEAM_LEADER_UNAVAILABLE", "leaderUnavailable", 400, False, {}),
        ("TEAM_CHAT_SESSION_NOT_FOUND", "chatSessionNotFound", 404, False, {}),
        ("TEAM_CONVERSATION_NOT_FOUND", "conversationNotFound", 404, False, {}),
        ("TEAM_TASK_TITLE_REQUIRED", "taskTitleRequired", 400, False, {}),
        ("TEAM_TASK_STATUS_INVALID", "taskStatusInvalid", 400, False, {}),
        (
            "TEAM_TASK_AWARD_OVERRIDE_FORBIDDEN",
            "taskAwardOverrideForbidden",
            409,
            False,
            {},
        ),
        (
            "TEAM_TASK_REVIEW_OVERRIDE_FORBIDDEN",
            "taskReviewOverrideForbidden",
            409,
            False,
            {},
        ),
        ("TEAM_TASK_ANSWER_REQUIRED", "taskAnswerRequired", 400, False, {}),
        ("TEAM_TASK_INPUT_NOT_REQUESTED", "taskInputNotRequested", 409, False, {}),
        ("TEAM_TASK_ASSIGNEE_REQUIRED", "taskAssigneeRequired", 409, False, {}),
        (
            "TEAM_BLACKBOARD_ENTRY_NOT_FOUND",
            "blackboardEntryNotFound",
            404,
            False,
            {},
        ),
        ("TEAM_BLACKBOARD_STATUS_INVALID", "blackboardStatusInvalid", 400, False, {}),
        ("TEAM_BLACKBOARD_CONTENT_REQUIRED", "blackboardContentRequired", 400, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in team_api_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.team.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    scheduled_api_entries = (
        ("SCHEDULED_TASK_ARCHIVED", "archived", 400, False, {}),
        ("SCHEDULED_TASK_NOT_FOUND", "notFound", 404, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in scheduled_api_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.scheduledTask.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    # Knowledge discovery validation is raised at an API boundary after the domain
    # service has already retained its raw cause for private diagnostics.
    discovery_entries = (
        ("KNOWLEDGE_BASE_NOT_FOUND", "baseNotFound", 404, False, {}),
        ("KNOWLEDGE_DISCOVERY_VALIDATION_FAILED", "discoveryValidationFailed", 422, False, {}),
        ("KNOWLEDGE_DISCOVERY_CONFLICT", "discoveryConflict", 409, False, {}),
    )
    for code, key_suffix, status, retryable, params_schema in discovery_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=f"errors.knowledge.{key_suffix}",
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    # Workflow: public API, evolution, feedback, session, memory, knowledge, and UI
    # producers are registered as one reviewable contract before compatibility projection.
    # The names deliberately describe machine semantics; legacy natural-language details
    # remain outside this registry and are never used as a translation key.
    public_api_entries = (
        ("ADMIN_REQUIRED", "errors.publicApi.adminRequired", 403, False, {}),
        (
            "AGENT_KEY_READ_ONLY_CONFIG",
            "errors.publicApi.agentKeyReadOnlyConfig",
            403,
            False,
            {},
        ),
        ("AGENT_SCOPE_INVALID", "errors.publicApi.agentScopeInvalid", 400, False, {}),
        ("AGENT_SCOPE_MISMATCH", "errors.publicApi.agentScopeMismatch", 403, False, {}),
        ("API_CLIENT_EXISTS", "errors.publicApi.apiClientExists", 409, False, {}),
        ("API_CLIENT_INACTIVE", "errors.publicApi.apiClientInactive", 401, False, {}),
        ("API_CLIENT_NOT_FOUND", "errors.publicApi.apiClientNotFound", 404, False, {}),
        (
            "API_CLIENT_OWNER_MISSING",
            "errors.publicApi.apiClientOwnerMissing",
            401,
            False,
            {},
        ),
        (
            "API_CREDENTIAL_NOT_FOUND",
            "errors.publicApi.apiCredentialNotFound",
            404,
            False,
            {},
        ),
        ("API_KEY_EXPIRED", "errors.publicApi.apiKeyExpired", 401, False, {}),
        ("API_KEY_REQUIRED", "errors.publicApi.apiKeyRequired", 401, False, {}),
        ("API_KEY_REVOKED", "errors.publicApi.apiKeyRevoked", 401, False, {}),
        ("ARTIFACT_CHANGED", "errors.publicApi.artifactChanged", 409, False, {}),
        (
            "ARTIFACT_LOCATION_CONFLICT",
            "errors.publicApi.artifactLocationConflict",
            409,
            False,
            {},
        ),
        ("ARTIFACT_NOT_FOUND", "errors.publicApi.artifactNotFound", 404, False, {}),
        ("DOCUMENT_TOO_LARGE", "errors.publicApi.documentTooLarge", 413, False, {}),
        ("ETAG_MISMATCH", "errors.publicApi.etagMismatch", 412, False, {}),
        (
            "EXTERNAL_SESSION_CONFLICT",
            "errors.publicApi.externalSessionConflict",
            409,
            False,
            {},
        ),
        (
            "GALLERY_AGENT_NOT_FOUND",
            "errors.publicApi.galleryAgentNotFound",
            404,
            False,
            {},
        ),
        (
            "IDEMPOTENCY_CONFLICT",
            "errors.publicApi.idempotencyConflict",
            409,
            False,
            {},
        ),
        (
            "IDEMPOTENCY_KEY_INVALID",
            "errors.publicApi.idempotencyKeyInvalid",
            400,
            False,
            {},
        ),
        ("IF_MATCH_REQUIRED", "errors.publicApi.ifMatchRequired", 428, False, {}),
        ("INSUFFICIENT_SCOPE", "errors.publicApi.insufficientScope", 403, False, {}),
        ("INVALID_API_KEY", "errors.publicApi.invalidApiKey", 401, False, {}),
        ("INVALID_CURSOR", "errors.publicApi.invalidCursor", 400, False, {}),
        ("INVALID_JSON_PATCH", "errors.publicApi.invalidJsonPatch", 422, False, {}),
        ("INVALID_SOP", "errors.publicApi.invalidSop", 422, False, {}),
        ("INVALID_USER_TOKEN", "errors.publicApi.invalidUserToken", 401, False, {}),
        ("JOB_NOT_FINISHED", "errors.publicApi.jobNotFinished", 409, False, {}),
        ("JOB_NOT_FOUND", "errors.publicApi.jobNotFound", 404, False, {}),
        ("RUN_NOT_FOUND", "errors.publicApi.runNotFound", 404, False, {}),
        ("RUN_NOT_SUCCEEDED", "errors.publicApi.runNotSucceeded", 409, False, {}),
        ("SCOPE_ESCALATION", "errors.publicApi.scopeEscalation", 400, False, {}),
        ("SOP_DRAFT_NOT_FOUND", "errors.publicApi.sopDraftNotFound", 404, False, {}),
        ("SOP_ID_IMMUTABLE", "errors.publicApi.sopIdImmutable", 422, False, {}),
        ("SOP_NOT_FOUND", "errors.publicApi.sopNotFound", 404, False, {}),
        ("SOP_VALIDATION_FAILED", "errors.publicApi.sopValidationFailed", 422, False, {}),
        ("SOP_VERSION_NOT_FOUND", "errors.publicApi.sopVersionNotFound", 404, False, {}),
        ("TENANT_KEY_REQUIRED", "errors.publicApi.tenantKeyRequired", 403, False, {}),
        ("WEBHOOK_NOT_FOUND", "errors.publicApi.webhookNotFound", 404, False, {}),
        ("WEBHOOK_URL_INVALID", "errors.publicApi.webhookUrlInvalid", 422, False, {}),
    )
    for code, message_key, status, retryable, params_schema in public_api_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=message_key,
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    evolution_entries = (
        ("EVOLUTION_FEEDBACK_NOT_FOUND", "errors.evolution.feedbackNotFound", 404, False, {}),
        (
            "EVOLUTION_GENERAL_SKILL_NOT_FOUND",
            "errors.evolution.generalSkillNotFound",
            404,
            False,
            {},
        ),
        (
            "EVOLUTION_MODEL_NOT_CONFIGURED",
            "errors.evolution.modelNotConfigured",
            409,
            False,
            {},
        ),
        (
            "EVOLUTION_PROPOSAL_NOT_FOUND",
            "errors.evolution.proposalNotFound",
            404,
            False,
            {},
        ),
        (
            "EVOLUTION_PROPOSAL_NOT_REVIEWABLE",
            "errors.evolution.proposalNotReviewable",
            409,
            False,
            {},
        ),
        (
            "EVOLUTION_PROPOSAL_VALIDATION_FAILED",
            "errors.evolution.proposalValidationFailed",
            422,
            False,
            {},
        ),
        (
            "EVOLUTION_PUBLISHED_PROPOSAL_REQUIRES_ROLLBACK",
            "errors.evolution.publishedProposalRequiresRollback",
            409,
            False,
            {},
        ),
        (
            "EVOLUTION_ROLLBACK_UNAVAILABLE",
            "errors.evolution.rollbackUnavailable",
            409,
            False,
            {},
        ),
        (
            "EVOLUTION_SOP_FEEDBACK_NOT_FOUND",
            "errors.evolution.sopFeedbackNotFound",
            404,
            False,
            {},
        ),
        ("EVOLUTION_SOP_NOT_FOUND", "errors.evolution.sopNotFound", 404, False, {}),
    )
    for code, message_key, status, retryable, params_schema in evolution_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=message_key,
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    feedback_session_entries = (
        (
            "FEEDBACK_ANALYSIS_JOB_NOT_FOUND",
            "errors.feedback.analysisJobNotFound",
            404,
            False,
            {},
        ),
        ("FEEDBACK_NOT_FOUND", "errors.feedback.notFound", 404, False, {}),
        ("MEMORY_AGENT_NOT_FOUND", "errors.memory.agentNotFound", 404, False, {}),
        ("SESSION_AGENT_NOT_FOUND", "errors.session.agentNotFound", 404, False, {}),
        ("SESSION_NOT_FOUND", "errors.session.notFound", 404, False, {}),
    )
    for code, message_key, status, retryable, params_schema in feedback_session_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=message_key,
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    knowledge_api_entries = (
        ("KNOWLEDGE_AGENT_NOT_FOUND", "errors.knowledge.agentNotFound", 404, False, {}),
        (
            "KNOWLEDGE_BASELINE_STALE",
            "errors.knowledge.baselineStale",
            409,
            False,
            {
                "base_version": "string",
                "published_version": "string",
                "conflict_count": "integer",
            },
        ),
        (
            "KNOWLEDGE_BASE_VERSION_NOT_VISIBLE",
            "errors.knowledge.baseVersionNotVisible",
            404,
            False,
            {"knowledge_base_id": "string"},
        ),
        ("KNOWLEDGE_BUCKET_NOT_FOUND", "errors.knowledge.bucketNotFound", 404, False, {}),
        ("KNOWLEDGE_CHUNK_NOT_FOUND", "errors.knowledge.chunkNotFound", 404, False, {}),
        (
            "KNOWLEDGE_CONVERSION_INCOMPLETE",
            "errors.knowledge.conversionIncomplete",
            500,
            False,
            {},
        ),
        (
            "KNOWLEDGE_DISCOVERY_NOT_FOUND",
            "errors.knowledge.discoveryNotFound",
            404,
            False,
            {},
        ),
        (
            "KNOWLEDGE_DOCUMENT_BRANCH_COPY_NOT_FOUND",
            "errors.knowledge.documentBranchCopyNotFound",
            404,
            False,
            {},
        ),
        (
            "KNOWLEDGE_DOCUMENT_CONFLICT",
            "errors.knowledge.documentConflict",
            409,
            False,
            {},
        ),
        (
            "KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH",
            "errors.knowledge.documentLineageMismatch",
            409,
            False,
            {"lineage_id": "string"},
        ),
        (
            "KNOWLEDGE_DOCUMENT_NOT_FOUND",
            "errors.knowledge.documentNotFound",
            404,
            False,
            {},
        ),
        (
            "KNOWLEDGE_DOCUMENT_VALIDATION_FAILED",
            "errors.knowledge.documentValidationFailed",
            422,
            False,
            {},
        ),
        (
            "KNOWLEDGE_INGEST_JOB_NOT_FOUND",
            "errors.knowledge.ingestJobNotFound",
            404,
            False,
            {},
        ),
        ("KNOWLEDGE_NAME_CONFLICT", "errors.knowledge.nameConflict", 409, False, {}),
        ("KNOWLEDGE_NAME_REQUIRED", "errors.knowledge.nameRequired", 400, False, {}),
        (
            "KNOWLEDGE_OKF_CONCEPT_NOT_FOUND",
            "errors.knowledge.okfConceptNotFound",
            404,
            False,
            {"concept_id": "string"},
        ),
        ("KNOWLEDGE_OKF_IMPORT_EMPTY", "errors.knowledge.okfImportEmpty", 400, False, {}),
        ("KNOWLEDGE_OKF_IMPORT_FAILED", "errors.knowledge.okfImportFailed", 400, False, {}),
        (
            "KNOWLEDGE_OPEN_GALLERY_NOT_VISIBLE",
            "errors.knowledge.openGalleryNotVisible",
            404,
            False,
            {},
        ),
        (
            "KNOWLEDGE_OVERALL_AGENT_INVALID",
            "errors.knowledge.overallAgentInvalid",
            400,
            False,
            {},
        ),
        (
            "KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED",
            "errors.knowledge.rebaseConflictsUnresolved",
            409,
            False,
            {"document_count": "integer"},
        ),
        ("KNOWLEDGE_SCOPE_CONFLICT", "errors.knowledge.scopeConflict", 400, False, {}),
        (
            "KNOWLEDGE_VERSION_BINDING_MISSING",
            "errors.knowledge.versionBindingMissing",
            404,
            False,
            {},
        ),
        (
            "KNOWLEDGE_VERSION_LEVEL_INVALID",
            "errors.knowledge.versionLevelInvalid",
            400,
            False,
            {"level": "string"},
        ),
        (
            "KNOWLEDGE_VERSION_NOT_FOUND",
            "errors.knowledge.versionNotFound",
            404,
            False,
            {"version_id": "string"},
        ),
        (
            "KNOWLEDGE_VERSION_NOT_VISIBLE",
            "errors.knowledge.versionNotVisible",
            404,
            False,
            {
                "version_id": "string",
                "knowledge_base_id": "string",
                "scope": "string",
            },
        ),
    )
    for code, message_key, status, retryable, params_schema in knowledge_api_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=message_key,
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    ui_entries = (
        ("UI_NETWORK_PORT_IN_USE", "errors.ui.networkPortInUse", 409, False, {}),
        (
            "UI_RUNTIME_NETWORK_UNAVAILABLE",
            "errors.ui.runtimeNetworkUnavailable",
            503,
            True,
            {},
        ),
    )
    for code, message_key, status, retryable, params_schema in ui_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=message_key,
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )

    # Workflow: register shared channel/tool/A2A compatibility codes here so every worker
    # validates against one immutable source; their producers remain in their own domains.
    compatibility_entries = (
        (
            "AGENT_REPLY_LOCALE_CONFLICT",
            "errors.agent.replyLocaleConflict",
            409,
            False,
            {"requested": "string", "session": "string"},
        ),
        ("CHANNEL_BAD_REQUEST", "errors.channel.badRequest", 400, False, {}),
        ("CHANNEL_FORBIDDEN", "errors.channel.forbidden", 403, False, {}),
        ("CHANNEL_NOT_FOUND", "errors.channel.notFound", 404, False, {}),
        ("CHANNEL_CONFLICT", "errors.channel.conflict", 409, False, {}),
        ("CHANNEL_RATE_LIMITED", "errors.channel.rateLimited", 429, True, {}),
        ("CHANNEL_UPSTREAM_ERROR", "errors.channel.upstreamError", 502, True, {}),
        ("TOOL_BAD_REQUEST", "errors.tool.badRequest", 400, False, {}),
        ("TOOL_FORBIDDEN", "errors.tool.forbidden", 403, False, {}),
        ("TOOL_NOT_FOUND", "errors.tool.notFound", 404, False, {}),
        ("TOOL_CONFLICT", "errors.tool.conflict", 409, False, {}),
        ("TOOL_UPSTREAM_ERROR", "errors.tool.upstreamError", 502, True, {}),
        ("MCP_ERROR", "errors.tool.mcpError", 400, False, {}),
        ("MCP_PROBE_ERROR", "errors.tool.mcpProbeError", 500, False, {}),
        ("TIMEOUT", "errors.tool.timeout", 504, True, {}),
        ("PROBE_ERROR", "errors.tool.probeError", 500, False, {}),
        ("HTTP_ERROR", "errors.tool.httpError", 502, False, {}),
        ("MISSING_CONNECTION", "errors.tool.missingConnection", 400, False, {}),
        ("MCP_DISCOVER_ERROR", "errors.tool.mcpDiscoverError", 400, False, {}),
        ("MCP_DISCOVER_UNEXPECTED", "errors.tool.mcpDiscoverUnexpected", 500, False, {}),
        (
            "MCP_AUTHORIZATION_REQUIRED",
            "errors.tool.mcpOAuthAuthorizationRequired",
            401,
            False,
            {},
        ),
        (
            "MCP_OAUTH_CALLBACK_INVALID",
            "errors.tool.mcpOAuthCallbackInvalid",
            400,
            False,
            {},
        ),
        (
            "MCP_OAUTH_FLOW_EXPIRED",
            "errors.tool.mcpOAuthFlowExpired",
            410,
            False,
            {},
        ),
        (
            "MCP_TOKEN_REFRESH_FAILED",
            "errors.tool.mcpOAuthTokenRefreshFailed",
            401,
            False,
            {},
        ),
        (
            "MCP_INSUFFICIENT_SCOPE",
            "errors.tool.mcpOAuthInsufficientScope",
            403,
            False,
            {},
        ),
        (
            "MCP_OAUTH_PROVIDER_UNSUPPORTED",
            "errors.tool.mcpOAuthProviderUnsupported",
            400,
            False,
            {},
        ),
        (
            "MCP_OAUTH_FLOW_CONFLICT",
            "errors.tool.mcpOAuthFlowConflict",
            409,
            False,
            {},
        ),
        ("A2A_BAD_REQUEST", "errors.a2a.badRequest", 400, False, {}),
        ("A2A_UNAUTHORIZED", "errors.a2a.unauthorized", 401, False, {}),
        ("A2A_NOT_FOUND", "errors.a2a.notFound", 404, False, {}),
        ("A2A_DISABLED", "errors.a2a.disabled", 404, False, {}),
        ("A2A_INTERNAL_ERROR", "errors.a2a.internal", 500, True, {}),
        ("A2A_METHOD_NOT_FOUND", "errors.a2a.methodNotFound", 400, False, {}),
        ("A2A_ERROR", "errors.a2a.error", 500, True, {}),
        ("A2A_CANCELLED", "errors.a2a.cancelled", 409, False, {}),
        ("A2A_RECOVERY_INVALID", "errors.a2a.recoveryInvalid", 500, False, {}),
        ("A2A_RECOVERY_TOOL_MISSING", "errors.a2a.recoveryToolMissing", 500, False, {}),
        ("A2A_AGENT_CARD_ERROR", "errors.a2a.agentCardError", 500, True, {}),
        ("A2A_AGENT_CARD_INVALID", "errors.a2a.agentCardInvalid", 500, False, {}),
        ("A2A_TASK_INVALID", "errors.a2a.taskInvalid", 500, False, {}),
        ("A2A_TIMEOUT", "errors.a2a.timeout", 504, True, {}),
        ("A2A_RESPONSE_INVALID", "errors.a2a.responseInvalid", 500, False, {}),
        ("A2A_TASK_FAILED", "errors.a2a.taskFailed", 500, True, {}),
        ("A2A_ARTIFACT_TOO_LARGE", "errors.a2a.artifactTooLarge", 413, False, {}),
    )
    for code, message_key, status, retryable, params_schema in compatibility_entries:
        registry.register(
            ErrorRegistryEntry(
                code=code,
                message_key=message_key,
                default_http_status=status,
                retryable_default=retryable,
                params_schema=params_schema,
                visibility=ErrorVisibility.PUBLIC,
            )
        )
    return registry


ERROR_REGISTRY = build_default_error_registry()


__all__ = [
    "ERROR_REGISTRY",
    "ErrorContractViolation",
    "ErrorRegistry",
    "ErrorRegistryEntry",
    "ErrorVisibility",
    "ParamKind",
    "build_default_error_registry",
]
