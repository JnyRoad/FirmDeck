"""Contract tests for the Harness capability invoker's local failure sink."""

from __future__ import annotations

import ast
import json
from pathlib import Path

from scripts.i18n.check_python import check_python_files

from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.errors import ErrorDescriptor
from app.core.harness_capability_invoker import _failure

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
HARNESS_INVOKER_PATH = (
    REPOSITORY_ROOT / "backend" / "app" / "core" / "harness_capability_invoker.py"
)
HARNESS_MANIFEST_PATH = (
    REPOSITORY_ROOT / "docs" / "i18n" / "key-manifests" / "T091-harness-failure-contract.json"
)

EXPECTED_FAILURE_CONTRACT = {
    "TOOL_NOT_AVAILABLE": ("errors.tool.notAvailable", 404, False, {}),
    "CAPABILITY_NOT_ACTIVATED": ("errors.capability.notActivated", 409, False, {}),
    "CAPABILITY_AUTHORIZATION_REVOKED": (
        "errors.capability.authorizationRevoked",
        403,
        False,
        {},
    ),
    "UNSUPPORTED_CAPABILITY": ("errors.capability.unsupported", 400, False, {}),
    "HARNESS_TOOL_ERROR": ("errors.harness.toolError", 500, False, {}),
    "TOOL_CALL_OUTCOME_UNKNOWN": ("errors.tool.callOutcomeUnknown", 409, False, {}),
    "UNSUPPORTED_INTERNAL_CAPABILITY": (
        "errors.capability.unsupportedInternal",
        400,
        False,
        {},
    ),
    "INVALID_ARGUMENTS": ("errors.common.invalidArguments", 422, False, {}),
    "PUBLISHED_DELIVERABLE_NOT_FOUND": (
        "errors.harness.publishedDeliverableNotFound",
        404,
        False,
        {},
    ),
    "PUBLISHED_DELIVERABLE_CHANGED": (
        "errors.harness.publishedDeliverableChanged",
        409,
        False,
        {},
    ),
    "PUBLISHED_DELIVERABLE_LOCATION_CONFLICT": (
        "errors.harness.publishedDeliverableLocationConflict",
        409,
        False,
        {},
    ),
    "CAPABILITY_NOT_AVAILABLE": ("errors.capability.notAvailable", 404, False, {}),
    "SKILL_NOT_AVAILABLE": ("errors.skill.notAvailable", 404, False, {}),
    "CAPABILITY_SNAPSHOT_CHANGED": ("errors.capability.snapshotChanged", 409, False, {}),
    "KNOWLEDGE_NOT_AVAILABLE": ("errors.knowledge.notAvailable", 403, False, {}),
    "TOOL_RESULT_PERSIST_FAILED": (
        "errors.harness.toolResultPersistFailed",
        500,
        False,
        {},
    ),
}


def _literal_failure_codes() -> list[str]:
    """Read direct `_failure` code literals so every local public sink remains enumerated."""
    tree = ast.parse(HARNESS_INVOKER_PATH.read_text(encoding="utf-8"))
    return [
        call.args[0].value
        for call in ast.walk(tree)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Name)
        and call.func.id == "_failure"
        and call.args
        and isinstance(call.args[0], ast.Constant)
        and isinstance(call.args[0].value, str)
    ]


def test_every_harness_failure_literal_has_an_exact_registered_contract() -> None:
    """Require all literal Harness failure codes to be registered with exact safe params."""
    literal_codes = _literal_failure_codes()

    assert set(literal_codes) == set(EXPECTED_FAILURE_CONTRACT)
    for code, (message_key, status, retryable, params) in EXPECTED_FAILURE_CONTRACT.items():
        entry = ERROR_REGISTRY.require(code)
        assert entry.message_key == message_key
        assert entry.default_http_status == status
        assert entry.retryable_default is retryable
        assert entry.params_schema == params
        descriptor = ErrorDescriptor(
            code=code,
            params=params,
            retryable=retryable,
        )
        assert ERROR_REGISTRY.validate(descriptor) == descriptor


def test_harness_failure_fails_closed_on_param_drift() -> None:
    """Reject unknown public params while retaining only the registered fallback descriptor."""
    result = _failure(
        "CAPABILITY_AUTHORIZATION_REVOKED",
        "撤权原因不应进入公共错误。",
        params={"unexpected": "private"},
    )

    assert result["error"]["code"] == "INTERNAL_ERROR"
    assert result["error"]["params"] == {}


def test_harness_failure_keeps_nested_cause_private() -> None:
    """Keep persistence diagnostics private while preserving the stable failure code."""
    private_message = "provider token=do-not-publish"
    result = _failure(
        "TOOL_RESULT_PERSIST_FAILED",
        "结果无法安全持久化。",
        cause={"code": "FILE_TOOL_ERROR", "message": private_message},
    )

    assert result["error"]["code"] == "TOOL_RESULT_PERSIST_FAILED"
    assert result["error"]["params"] == {}
    assert private_message not in repr(result)


def test_harness_failure_manifest_covers_both_locked_catalogs_exactly() -> None:
    """Keep the pending en-US/zh-CN manifest synchronized with the registry contract."""
    manifest = json.loads(HARNESS_MANIFEST_PATH.read_text(encoding="utf-8"))

    assert manifest["catalogs"] == ["en-US", "zh-CN"]
    assert manifest["status"] == "pending-catalog-unlock"
    assert {
        entry["code"]: (entry["message_key"], entry["params"])
        for entry in manifest["entries"]
    } == {
        code: (contract[0], contract[3])
        for code, contract in EXPECTED_FAILURE_CONTRACT.items()
    }


def test_python_checker_recognizes_validated_failure_sink_and_checks_callers(
    tmp_path: Path,
) -> None:
    """Check `_failure` callers for literal, dynamic, and parameter-schema drift."""
    fixture = tmp_path / "harness_failure.py"
    fixture.write_text(
        """
from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.errors import ErrorDescriptor


def _failure(code, message, *, params=None):
    safe_params = dict(params or {})
    try:
        ERROR_REGISTRY.require(code)
        descriptor = ErrorDescriptor(code=code, params=safe_params, retryable=False)
        ERROR_REGISTRY.validate(descriptor)
    except ValueError:
        code = "INTERNAL_ERROR"
        safe_params = {}
    return {"error": {"code": code, "params": safe_params}}


def valid():
    return _failure("INTERNAL_ERROR", "private prose")


def unregistered():
    return _failure("UNREGISTERED_FAILURE", "private prose")


def dynamic(code):
    return _failure(code, "private prose")


def mismatched():
    return _failure("VALIDATION_ERROR", "private prose", params={"wrong": "x"})
""",
        encoding="utf-8",
    )

    diagnostics = check_python_files(
        [fixture],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
        registered_error_params={
            "INTERNAL_ERROR": set(),
            "VALIDATION_ERROR": {"error_count"},
        },
    )

    assert [
        (diagnostic.rule, diagnostic.code)
        for diagnostic in diagnostics
        if diagnostic.rule in {
            "python.dynamicErrorCode",
            "python.errorParamsMismatch",
            "python.unregisteredDescriptor",
        }
    ] == [
        ("python.unregisteredDescriptor", "UNREGISTERED_FAILURE"),
        ("python.dynamicErrorCode", None),
        ("python.errorParamsMismatch", "VALIDATION_ERROR"),
    ]
