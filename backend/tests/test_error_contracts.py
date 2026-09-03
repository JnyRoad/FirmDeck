"""Contract tests for stable product errors and private diagnostic causes."""

from __future__ import annotations

from pathlib import Path

import pytest
from scripts.i18n.check_python import _registered_contracts_from_source, check_python_files

from app.api.knowledge_bases import _knowledge_public_error
from app.contracts.error_registry import (
    ERROR_REGISTRY,
    ErrorContractViolation,
    ErrorRegistry,
    ErrorRegistryEntry,
    ErrorVisibility,
)
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext
from app.contracts.http import build_http_exception
from app.contracts.projections import project_public_error
from app.llm.schemas import ModelProviderErrorDetail

_T084_EXPECTED_ENTRIES = {
    "AGENT_REPLY_LOCALE_CONFLICT": (
        "errors.agent.replyLocaleConflict",
        409,
        False,
        {"requested": "string", "session": "string"},
    ),
    # Public API/authentication boundaries.
    "ADMIN_REQUIRED": ("errors.publicApi.adminRequired", 403, False, {}),
    "AGENT_KEY_READ_ONLY_CONFIG": ("errors.publicApi.agentKeyReadOnlyConfig", 403, False, {}),
    "AGENT_SCOPE_INVALID": ("errors.publicApi.agentScopeInvalid", 400, False, {}),
    "AGENT_SCOPE_MISMATCH": ("errors.publicApi.agentScopeMismatch", 403, False, {}),
    "API_CLIENT_EXISTS": ("errors.publicApi.apiClientExists", 409, False, {}),
    "API_CLIENT_INACTIVE": ("errors.publicApi.apiClientInactive", 401, False, {}),
    "API_CLIENT_NOT_FOUND": ("errors.publicApi.apiClientNotFound", 404, False, {}),
    "API_CLIENT_OWNER_MISSING": ("errors.publicApi.apiClientOwnerMissing", 401, False, {}),
    "API_CREDENTIAL_NOT_FOUND": ("errors.publicApi.apiCredentialNotFound", 404, False, {}),
    "API_KEY_EXPIRED": ("errors.publicApi.apiKeyExpired", 401, False, {}),
    "API_KEY_REQUIRED": ("errors.publicApi.apiKeyRequired", 401, False, {}),
    "API_KEY_REVOKED": ("errors.publicApi.apiKeyRevoked", 401, False, {}),
    "ARTIFACT_CHANGED": ("errors.publicApi.artifactChanged", 409, False, {}),
    "ARTIFACT_LOCATION_CONFLICT": ("errors.publicApi.artifactLocationConflict", 409, False, {}),
    "ARTIFACT_NOT_FOUND": ("errors.publicApi.artifactNotFound", 404, False, {}),
    "DOCUMENT_TOO_LARGE": ("errors.publicApi.documentTooLarge", 413, False, {}),
    "ETAG_MISMATCH": ("errors.publicApi.etagMismatch", 412, False, {}),
    "EXTERNAL_SESSION_CONFLICT": ("errors.publicApi.externalSessionConflict", 409, False, {}),
    "GALLERY_AGENT_NOT_FOUND": ("errors.publicApi.galleryAgentNotFound", 404, False, {}),
    "IDEMPOTENCY_CONFLICT": ("errors.publicApi.idempotencyConflict", 409, False, {}),
    "IDEMPOTENCY_KEY_INVALID": ("errors.publicApi.idempotencyKeyInvalid", 400, False, {}),
    "IF_MATCH_REQUIRED": ("errors.publicApi.ifMatchRequired", 428, False, {}),
    "INSUFFICIENT_SCOPE": ("errors.publicApi.insufficientScope", 403, False, {}),
    "INVALID_API_KEY": ("errors.publicApi.invalidApiKey", 401, False, {}),
    "INVALID_CURSOR": ("errors.publicApi.invalidCursor", 400, False, {}),
    "INVALID_JSON_PATCH": ("errors.publicApi.invalidJsonPatch", 422, False, {}),
    "INVALID_SOP": ("errors.publicApi.invalidSop", 422, False, {}),
    "INVALID_USER_TOKEN": ("errors.publicApi.invalidUserToken", 401, False, {}),
    "JOB_NOT_FINISHED": ("errors.publicApi.jobNotFinished", 409, False, {}),
    "JOB_NOT_FOUND": ("errors.publicApi.jobNotFound", 404, False, {}),
    "RUN_NOT_FOUND": ("errors.publicApi.runNotFound", 404, False, {}),
    "RUN_NOT_SUCCEEDED": ("errors.publicApi.runNotSucceeded", 409, False, {}),
    "SCOPE_ESCALATION": ("errors.publicApi.scopeEscalation", 400, False, {}),
    "SOP_DRAFT_NOT_FOUND": ("errors.publicApi.sopDraftNotFound", 404, False, {}),
    "SOP_ID_IMMUTABLE": ("errors.publicApi.sopIdImmutable", 422, False, {}),
    "SOP_NOT_FOUND": ("errors.publicApi.sopNotFound", 404, False, {}),
    "SOP_VALIDATION_FAILED": ("errors.publicApi.sopValidationFailed", 422, False, {}),
    "SOP_VERSION_NOT_FOUND": ("errors.publicApi.sopVersionNotFound", 404, False, {}),
    "TENANT_KEY_REQUIRED": ("errors.publicApi.tenantKeyRequired", 403, False, {}),
    "WEBHOOK_NOT_FOUND": ("errors.publicApi.webhookNotFound", 404, False, {}),
    "WEBHOOK_URL_INVALID": ("errors.publicApi.webhookUrlInvalid", 422, False, {}),
    # Evolution, feedback, session and memory API boundaries.
    "EVOLUTION_FEEDBACK_NOT_FOUND": ("errors.evolution.feedbackNotFound", 404, False, {}),
    "EVOLUTION_GENERAL_SKILL_NOT_FOUND": ("errors.evolution.generalSkillNotFound", 404, False, {}),
    "EVOLUTION_MODEL_NOT_CONFIGURED": ("errors.evolution.modelNotConfigured", 409, False, {}),
    "EVOLUTION_PROPOSAL_NOT_FOUND": ("errors.evolution.proposalNotFound", 404, False, {}),
    "EVOLUTION_PROPOSAL_NOT_REVIEWABLE": ("errors.evolution.proposalNotReviewable", 409, False, {}),
    "EVOLUTION_PROPOSAL_VALIDATION_FAILED": (
        "errors.evolution.proposalValidationFailed",
        422,
        False,
        {},
    ),
    "EVOLUTION_PUBLISHED_PROPOSAL_REQUIRES_ROLLBACK": (
        "errors.evolution.publishedProposalRequiresRollback",
        409,
        False,
        {},
    ),
    "EVOLUTION_ROLLBACK_UNAVAILABLE": ("errors.evolution.rollbackUnavailable", 409, False, {}),
    "EVOLUTION_SOP_FEEDBACK_NOT_FOUND": ("errors.evolution.sopFeedbackNotFound", 404, False, {}),
    "EVOLUTION_SOP_NOT_FOUND": ("errors.evolution.sopNotFound", 404, False, {}),
    "FEEDBACK_ANALYSIS_JOB_NOT_FOUND": ("errors.feedback.analysisJobNotFound", 404, False, {}),
    "FEEDBACK_NOT_FOUND": ("errors.feedback.notFound", 404, False, {}),
    "MEMORY_AGENT_NOT_FOUND": ("errors.memory.agentNotFound", 404, False, {}),
    "SESSION_AGENT_NOT_FOUND": ("errors.session.agentNotFound", 404, False, {}),
    "SESSION_NOT_FOUND": ("errors.session.notFound", 404, False, {}),
    # Knowledge API boundaries.  Version visibility keeps the full safe context
    # because both the API and the UI need to distinguish version and scope.
    "KNOWLEDGE_AGENT_NOT_FOUND": ("errors.knowledge.agentNotFound", 404, False, {}),
    "KNOWLEDGE_BASE_VERSION_NOT_VISIBLE": (
        "errors.knowledge.baseVersionNotVisible",
        404,
        False,
        {"knowledge_base_id": "string"},
    ),
    "KNOWLEDGE_BUCKET_NOT_FOUND": ("errors.knowledge.bucketNotFound", 404, False, {}),
    "KNOWLEDGE_CHUNK_NOT_FOUND": ("errors.knowledge.chunkNotFound", 404, False, {}),
    "KNOWLEDGE_CONVERSION_INCOMPLETE": ("errors.knowledge.conversionIncomplete", 500, False, {}),
    "KNOWLEDGE_DISCOVERY_NOT_FOUND": ("errors.knowledge.discoveryNotFound", 404, False, {}),
    "KNOWLEDGE_DOCUMENT_BRANCH_COPY_NOT_FOUND": (
        "errors.knowledge.documentBranchCopyNotFound",
        404,
        False,
        {},
    ),
    "KNOWLEDGE_DOCUMENT_CONFLICT": ("errors.knowledge.documentConflict", 409, False, {}),
    "KNOWLEDGE_DOCUMENT_NOT_FOUND": ("errors.knowledge.documentNotFound", 404, False, {}),
    "KNOWLEDGE_DOCUMENT_VALIDATION_FAILED": (
        "errors.knowledge.documentValidationFailed",
        422,
        False,
        {},
    ),
    "KNOWLEDGE_INGEST_JOB_NOT_FOUND": ("errors.knowledge.ingestJobNotFound", 404, False, {}),
    "KNOWLEDGE_NAME_CONFLICT": ("errors.knowledge.nameConflict", 409, False, {}),
    "KNOWLEDGE_NAME_REQUIRED": ("errors.knowledge.nameRequired", 400, False, {}),
    "KNOWLEDGE_OKF_CONCEPT_NOT_FOUND": (
        "errors.knowledge.okfConceptNotFound",
        404,
        False,
        {"concept_id": "string"},
    ),
    "KNOWLEDGE_OKF_IMPORT_EMPTY": ("errors.knowledge.okfImportEmpty", 400, False, {}),
    "KNOWLEDGE_OKF_IMPORT_FAILED": ("errors.knowledge.okfImportFailed", 400, False, {}),
    "KNOWLEDGE_OPEN_GALLERY_NOT_VISIBLE": (
        "errors.knowledge.openGalleryNotVisible",
        404,
        False,
        {},
    ),
    "KNOWLEDGE_OVERALL_AGENT_INVALID": ("errors.knowledge.overallAgentInvalid", 400, False, {}),
    "KNOWLEDGE_SCOPE_CONFLICT": ("errors.knowledge.scopeConflict", 400, False, {}),
    "KNOWLEDGE_VERSION_BINDING_MISSING": (
        "errors.knowledge.versionBindingMissing",
        404,
        False,
        {},
    ),
    "KNOWLEDGE_VERSION_NOT_FOUND": (
        "errors.knowledge.versionNotFound",
        404,
        False,
        {"version_id": "string"},
    ),
    "KNOWLEDGE_VERSION_NOT_VISIBLE": (
        "errors.knowledge.versionNotVisible",
        404,
        False,
        {
            "version_id": "string",
            "knowledge_base_id": "string",
            "scope": "string",
        },
    ),
    # UI runtime boundary.
    "UI_NETWORK_PORT_IN_USE": ("errors.ui.networkPortInUse", 409, False, {}),
    "UI_RUNTIME_NETWORK_UNAVAILABLE": ("errors.ui.runtimeNetworkUnavailable", 503, True, {}),
}

_T007_EXPECTED_ENTRIES = {
    "SYSTEM_AUTH_UNAVAILABLE": ("errors.system.authUnavailable", 503, False, {}),
    "SYSTEM_AUTH_INVALID_CREDENTIALS": (
        "errors.systemAuth.invalidCredentials",
        401,
        False,
        {},
    ),
    "SYSTEM_ADMIN_DISABLED": ("errors.system.adminDisabled", 401, False, {}),
    "SYSTEM_CONTROL_CONFLICT": ("errors.system.controlConflict", 409, False, {}),
    "TEMPORARY_PASSWORD_CHANGE_REQUIRED": (
        "errors.auth.temporaryPasswordChangeRequired",
        403,
        False,
        {},
    ),
    "TENANT_SUSPENDED": ("errors.tenant.suspended", 403, False, {}),
    "TENANT_LIFECYCLE_CHECK_FAILED": (
        "errors.tenant.lifecycleCheckFailed",
        503,
        False,
        {},
    ),
    "TENANT_WORK_TERMINALIZED": ("errors.tenant.workTerminalized", 409, False, {}),
    "EXTERNAL_OUTCOME_UNKNOWN": ("errors.tenant.externalOutcomeUnknown", 409, False, {}),
}

# knowledge-base-admin (data-model.md §9): draft baseline/rebase/publish error contracts.
_KNOWLEDGE_ADMIN_EXPECTED_ENTRIES = {
    "KNOWLEDGE_BASELINE_STALE": (
        "errors.knowledge.baselineStale",
        409,
        False,
        {
            "base_version": "string",
            "published_version": "string",
            "conflict_count": "integer",
        },
    ),
    "KNOWLEDGE_REBASE_CONFLICTS_UNRESOLVED": (
        "errors.knowledge.rebaseConflictsUnresolved",
        409,
        False,
        {"document_count": "integer"},
    ),
    "KNOWLEDGE_VERSION_LEVEL_INVALID": (
        "errors.knowledge.versionLevelInvalid",
        400,
        False,
        {"level": "string"},
    ),
    "KNOWLEDGE_DOCUMENT_LINEAGE_MISMATCH": (
        "errors.knowledge.documentLineageMismatch",
        409,
        False,
        {"lineage_id": "string"},
    ),
}


def build_registry() -> ErrorRegistry:
    """Build a small isolated registry; it has no process-global or database side effects."""
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
            code="KNOWLEDGE_DOCUMENT_NOT_FOUND",
            message_key="errors.knowledge.documentNotFound",
            default_http_status=404,
            retryable_default=False,
            params_schema={"document_id": "string"},
            visibility=ErrorVisibility.PUBLIC,
        )
    )
    return registry


def test_t084_global_registry_covers_current_public_error_contracts() -> None:
    """Require each current public producer code to have exact registry metadata."""
    for code, (message_key, status, retryable, params_schema) in _T084_EXPECTED_ENTRIES.items():
        entry = ERROR_REGISTRY.require(code)
        assert (entry.message_key, entry.default_http_status, entry.retryable_default) == (
            message_key,
            status,
            retryable,
        )
        assert entry.params_schema == params_schema


def test_t007_system_tenant_error_contracts_are_registered_with_safe_public_shapes() -> None:
    """Require every planned auth and lifecycle error to be public, unique, and parameter-safe."""
    entries = ERROR_REGISTRY.entries()
    assert len(entries) == len({entry.code for entry in entries})
    for code, (message_key, status, retryable, params_schema) in _T007_EXPECTED_ENTRIES.items():
        entry = ERROR_REGISTRY.require(code)
        assert entry.visibility is ErrorVisibility.PUBLIC
        assert (entry.message_key, entry.default_http_status, entry.retryable_default) == (
            message_key,
            status,
            retryable,
        )
        assert entry.params_schema == params_schema


def test_knowledge_admin_error_contracts_are_registered_with_safe_public_shapes() -> None:
    """Require every knowledge-base-admin draft/rebase/publish error to be public and parameter-exact."""
    entries = ERROR_REGISTRY.entries()
    assert len(entries) == len({entry.code for entry in entries})
    for code, (
        message_key,
        status,
        retryable,
        params_schema,
    ) in _KNOWLEDGE_ADMIN_EXPECTED_ENTRIES.items():
        entry = ERROR_REGISTRY.require(code)
        assert entry.visibility is ErrorVisibility.PUBLIC
        assert (entry.message_key, entry.default_http_status, entry.retryable_default) == (
            message_key,
            status,
            retryable,
        )
        assert entry.params_schema == params_schema


def test_t084_registry_contains_no_duplicate_codes() -> None:
    """Keep the shared registry deterministic when multiple domain batches are merged."""
    entries = ERROR_REGISTRY.entries()
    assert len(entries) == len({entry.code for entry in entries})


def test_t084_backend_python_gate_has_no_unresolved_error_contracts() -> None:
    """Require every backend public error constructor to be registered and statically guarded."""
    repository_root = Path(__file__).resolve().parents[2]
    registry_path = repository_root / "backend" / "app" / "contracts" / "error_registry.py"
    registered_contracts = _registered_contracts_from_source(registry_path)
    diagnostics = check_python_files(
        sorted((repository_root / "backend" / "app").rglob("*.py")),
        registered_error_codes=set(registered_contracts),
        registered_error_params=registered_contracts,
    )
    assert diagnostics == []


def test_t084_knowledge_base_visibility_uses_base_scoped_contract() -> None:
    """Keep the base-level missing-version error distinct from version-level visibility."""
    exception = _knowledge_public_error(
        "KNOWLEDGE_BASE_VERSION_NOT_VISIBLE",
        404,
        params={"knowledge_base_id": "kb-42"},
    )

    assert exception.status_code == 404
    assert exception.detail["code"] == "KNOWLEDGE_BASE_VERSION_NOT_VISIBLE"
    assert exception.detail["message_key"] == "errors.knowledge.baseVersionNotVisible"
    assert exception.detail["params"] == {"knowledge_base_id": "kb-42"}


def test_descriptor_serializes_only_stable_safe_fields() -> None:
    """Verify canonical wire data contains code/params/retryability and trace linkage only."""
    descriptor = ErrorDescriptor(
        code="KNOWLEDGE_DOCUMENT_NOT_FOUND",
        params={"document_id": "doc-42"},
        retryable=False,
        request_id="req-1",
        trace_id="trace-1",
    )

    assert descriptor.model_dump(mode="json") == {
        "code": "KNOWLEDGE_DOCUMENT_NOT_FOUND",
        "params": {"document_id": "doc-42"},
        "retryable": False,
        "request_id": "req-1",
        "trace_id": "trace-1",
    }


def test_registry_validates_exact_named_parameter_schema() -> None:
    """Reject missing, extra, and type-incompatible params before they reach a public boundary."""
    registry = build_registry()
    valid = ErrorDescriptor(
        code="KNOWLEDGE_DOCUMENT_NOT_FOUND",
        params={"document_id": "doc-42"},
        retryable=False,
    )

    assert registry.validate(valid).code == valid.code
    with pytest.raises(ErrorContractViolation, match="missing params"):
        registry.validate(valid.model_copy(update={"params": {}}))
    with pytest.raises(ErrorContractViolation, match="unexpected params"):
        registry.validate(valid.model_copy(update={"params": {"document_id": "doc", "raw": "x"}}))
    with pytest.raises(ErrorContractViolation, match="document_id"):
        registry.validate(valid.model_copy(update={"params": {"document_id": 42}}))


def test_registry_rejects_duplicate_codes_and_natural_language_message_keys() -> None:
    """Keep codes globally unique and message keys semantic rather than locale prose."""
    registry = build_registry()
    with pytest.raises(ErrorContractViolation, match="already registered"):
        registry.register(registry.require("INTERNAL_ERROR"))
    with pytest.raises(ValueError, match="message_key"):
        ErrorRegistryEntry(
            code="BAD_MESSAGE_KEY",
            message_key="Something went wrong",
            default_http_status=500,
            retryable_default=False,
            params_schema={},
            visibility=ErrorVisibility.PUBLIC,
        )


def test_unknown_code_projects_to_registered_safe_fallback() -> None:
    """Map unregistered failures to INTERNAL_ERROR without exposing arbitrary code or params."""
    registry = build_registry()
    occurrence = ErrorOccurrence(
        descriptor=ErrorDescriptor(
            code="UNREGISTERED_PROVIDER_FAILURE",
            params={"provider_message": "secret upstream response"},
            retryable=True,
            request_id="req-unknown",
            trace_id="trace-unknown",
        ),
        internal=InternalErrorContext(
            source="provider",
            exception_type="RuntimeError",
            raw_message="secret upstream response",
        ),
    )

    payload = project_public_error(occurrence, registry)

    assert payload == {
        "code": "INTERNAL_ERROR",
        "params": {},
        "retryable": False,
        "request_id": "req-unknown",
        "trace_id": "trace-unknown",
    }


def test_private_cause_never_enters_public_projection() -> None:
    """Retain diagnostics in the occurrence while excluding seeded raw text from serialization."""
    registry = build_registry()
    occurrence = ErrorOccurrence(
        descriptor=ErrorDescriptor(
            code="KNOWLEDGE_DOCUMENT_NOT_FOUND",
            params={"document_id": "doc-42"},
            retryable=False,
            request_id="req-2",
            trace_id="trace-2",
        ),
        internal=InternalErrorContext(
            source="knowledge",
            exception_type="DatabaseError",
            raw_message="password=do-not-leak; /private/path.sqlite",
            upstream_status=503,
            diagnostic_reference="diag-42",
        ),
    )

    payload = project_public_error(occurrence, registry)

    assert occurrence.internal is not None
    assert occurrence.internal.raw_message.startswith("password=")
    assert "password" not in repr(payload)
    assert "private/path" not in repr(payload)


def test_http_exception_uses_registered_structured_projection() -> None:
    """Require model errors to expose code/params/correlation instead of UI prose."""
    exception = build_http_exception(
        "MODEL_CONFIG_NOT_FOUND",
        params={"config_id": "model-1"},
        request_id="req-model",
        trace_id="trace-model",
    )

    assert exception.status_code == 404
    assert exception.detail["code"] == "MODEL_CONFIG_NOT_FOUND"
    assert exception.detail["message_key"] == "errors.model.configNotFound"
    assert exception.detail["params"] == {"config_id": "model-1"}
    assert exception.detail["retryable"] is False
    assert exception.detail["request_id"] == "req-model"
    assert exception.detail["trace_id"] == "trace-model"


def test_http_exception_keeps_raw_cause_private() -> None:
    """Ensure provider diagnostics never become the public HTTP detail or exception text."""
    exception = build_http_exception(
        "MODEL_UPSTREAM_ERROR",
        request_id="req-provider",
        trace_id="trace-provider",
        internal=InternalErrorContext(
            source="model_provider",
            exception_type="TimeoutError",
            raw_message="authorization=secret; /private/provider/path",
        ),
    )

    assert "authorization=secret" not in repr(exception.detail)
    assert "/private/provider/path" not in repr(exception.detail)
    assert str(exception.detail["code"]) == "MODEL_UPSTREAM_ERROR"
    assert exception.detail["retryable"] is True


def test_model_provider_serializer_removes_provider_prose() -> None:
    """Keep legacy provider fields readable in memory but omit them from public serialization."""
    detail = ModelProviderErrorDetail(
        code="MODEL_UPSTREAM_ERROR",
        message="provider rejected request",
        provider_code="invalid_model",
        provider_message="model does not exist",
        upstream_body="secret provider body",
    )

    payload = detail.model_dump(mode="json")

    assert payload["message"] == "MODEL_UPSTREAM_ERROR"
    assert "provider_code" not in payload
    assert "provider_message" not in payload
    assert "upstream_body" not in payload
