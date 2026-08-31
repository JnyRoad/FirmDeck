"""Exercise the backend i18n governance fixture harness without checker rules."""

from __future__ import annotations

import runpy
import subprocess
import sys
from pathlib import Path

from scripts.i18n.check_python import check_python_files, format_diagnostics

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PYTHON_FIXTURE_ROOT = REPOSITORY_ROOT / "scripts" / "i18n" / "fixtures" / "python"
VALID_FIXTURE_ROOT = PYTHON_FIXTURE_ROOT / "valid"
INVALID_FIXTURE_ROOT = PYTHON_FIXTURE_ROOT / "invalid"
MINIMAL_POSITIVE_FIXTURE = VALID_FIXTURE_ROOT / "registered_error.py"


def test_python_fixture_directories_exist() -> None:
    """Require stable valid/invalid roots; this only reads repository paths and fails if absent."""
    assert VALID_FIXTURE_ROOT.is_dir()
    assert INVALID_FIXTURE_ROOT.is_dir()


def test_minimal_positive_fixture_is_executable() -> None:
    """Run the seed fixture and verify its safe descriptor; fixture exceptions propagate."""
    # Load the standalone fixture without adding its directory to the import path.
    namespace = runpy.run_path(str(MINIMAL_POSITIVE_FIXTURE))

    # Exercise the hand-authored positive example through its public fixture function.
    build_registered_error = namespace["build_registered_error"]
    assert build_registered_error() == {
        "code": "knowledge.document_not_found",
        "params": {"document_id": "doc_fixture"},
        "retryable": False,
        "request_id": "req_fixture",
        "trace_id": "trc_fixture",
    }


def _fixture(relative_path: str) -> Path:
    """Resolve one checked fixture path beneath the stable Python fixture root."""
    return PYTHON_FIXTURE_ROOT / relative_path


def test_python_checker_accepts_registered_contracts_and_explicit_exclusions() -> None:
    """Allow canonical descriptors plus technical logs/prompts/raw values that are not product UI."""
    diagnostics = check_python_files(
        [
            _fixture("valid/exception_scope_exclusions.py"),
            _fixture("valid/registered_error.py"),
            _fixture("valid/registered_code_constants.py"),
            _fixture("valid/safe_harness_projector.py"),
            _fixture("valid/safe_job_projector.py"),
            _fixture("valid/technical_exclusions.py"),
            _fixture("valid/guarded_dynamic_and_raw_sources.py"),
            _fixture("valid/localized_product_text_sinks.py"),
            _fixture("valid/raw_trace_line_projection.py"),
        ],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
        registered_error_params={"INTERNAL_ERROR": set(), "VALIDATION_ERROR": {"error_count"}},
    )

    assert diagnostics == []


def test_python_checker_detects_public_text_and_exception_leaks() -> None:
    """Detect natural HTTP/response/event text and str(exc) crossing a public boundary."""
    diagnostics = check_python_files(
        [_fixture("invalid/public_text_boundaries.fixture")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
    )
    rules = {diagnostic.rule for diagnostic in diagnostics}

    assert rules == {
        "python.eventNaturalText",
        "python.httpNaturalDetail",
        "python.publicExceptionLeak",
        "python.responseNaturalText",
        "python.unstructuredEventPayload",
    }


def test_python_checker_detects_typed_sse_and_persisted_exception_flows() -> None:
    """Catch eight public exception projections while retaining stable line and source evidence."""
    diagnostics = check_python_files(
        [_fixture("invalid/exception_alias_flows.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
    )

    assert [
        (diagnostic.rule, diagnostic.line, diagnostic.source)
        for diagnostic in diagnostics
        if diagnostic.rule == "python.publicExceptionLeak"
    ] == [
        ("python.publicExceptionLeak", 33, "str(exc)"),
        ("python.publicExceptionLeak", 41, "repr(exc)"),
        ("python.publicExceptionLeak", 49, 'f"{exc}"'),
        ("python.publicExceptionLeak", 59, '"{}".format(exc)'),
        ("python.publicExceptionLeak", 71, '"%s" % exc'),
        ("python.publicExceptionLeak", 81, "str(exc)"),
        ("python.publicExceptionLeak", 89, "repr(exc)"),
        ("python.publicExceptionLeak", 105, "message_text"),
    ]


def test_python_checker_detects_unregistered_descriptors_but_accepts_registered_codes() -> None:
    """Require every canonical descriptor code to exist in the error registry."""
    diagnostics = check_python_files(
        [_fixture("invalid/unregistered_descriptor.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
    )

    assert [diagnostic.rule for diagnostic in diagnostics] == ["python.unregisteredDescriptor"]
    assert diagnostics[0].code == "PROVIDER_UNKNOWN_FAILURE"


def test_python_checker_detects_constructor_wrappers_params_and_natural_detail() -> None:
    """Reject unregistered constructors, unsafe dynamic codes, bad params, and helper-owned prose."""
    diagnostics = check_python_files(
        [_fixture("invalid/error_constructor_blind_spots.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
        registered_error_params={"INTERNAL_ERROR": set(), "VALIDATION_ERROR": {"error_count"}},
    )

    assert [diagnostic.rule for diagnostic in diagnostics].count(
        "python.unregisteredDescriptor"
    ) == 5
    assert [diagnostic.rule for diagnostic in diagnostics].count("python.errorParamsMismatch") == 2
    assert [diagnostic.rule for diagnostic in diagnostics].count("python.dynamicErrorCode") == 1
    assert [diagnostic.rule for diagnostic in diagnostics].count("python.httpNaturalDetail") == 1
    assert {diagnostic.code for diagnostic in diagnostics if diagnostic.code} >= {
        "UNREGISTERED_HTTP_ERROR",
        "UNREGISTERED_DOMAIN_ERROR",
        "UNREGISTERED_WRAPPER_ERROR",
        "UNREGISTERED_PUBLIC_ERROR",
        "UNREGISTERED_LEGACY_ERROR",
        "VALIDATION_ERROR",
    }


def test_python_checker_models_public_error_detail_sinks_precisely() -> None:
    """Reject raw Public API detail sinks while allowing registered code compatibility fields."""
    invalid = check_python_files(
        [_fixture("invalid/public_error_detail_sink.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
        registered_error_params={"INTERNAL_ERROR": set(), "VALIDATION_ERROR": {"error_count"}},
    )
    detail_findings = [
        diagnostic for diagnostic in invalid if diagnostic.rule == "python.publicErrorDetail"
    ]

    assert [(diagnostic.line, diagnostic.source) for diagnostic in detail_findings] == [
        (19, "detail"),
        (30, "detail"),
        (41, "exc.detail"),
    ]

    valid = check_python_files(
        [_fixture("valid/public_error_detail_sink.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
        registered_error_params={"INTERNAL_ERROR": set(), "VALIDATION_ERROR": {"error_count"}},
    )
    assert valid == []


def test_python_checker_detects_indirect_public_exception_flows() -> None:
    """Reject exception prose relayed through queues, events, spans, warnings, and persisted fields."""
    diagnostics = check_python_files(
        [_fixture("invalid/indirect_public_exception_flows.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
    )

    assert [diagnostic.rule for diagnostic in diagnostics].count("python.publicExceptionLeak") == 6
    assert [diagnostic.rule for diagnostic in diagnostics].count(
        "python.unstructuredEventPayload"
    ) == 1


def test_python_checker_detects_agent_reply_diagnostics_and_fixed_locale() -> None:
    """Reject raw failure prose and fixed Chinese text only at explicit Agent reply sinks."""
    diagnostics = check_python_files(
        [_fixture("invalid/agent_reply_language_blind_spots.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
    )

    assert [diagnostic.rule for diagnostic in diagnostics].count("python.publicExceptionLeak") == 4
    assert [diagnostic.rule for diagnostic in diagnostics].count(
        "python.fixedAgentReplyLocale"
    ) == 2


def test_python_checker_detects_fixed_text_at_typed_projection_and_event_sinks() -> None:
    """Reject fixed prose only where typed task, projection, or stream contracts prove UI use."""
    diagnostics = check_python_files(
        [_fixture("invalid/product_text_sinks.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
    )

    product_text = [
        diagnostic for diagnostic in diagnostics if diagnostic.rule == "python.productNaturalText"
    ]
    assert len(product_text) == 7
    assert {diagnostic.source for diagnostic in product_text} == {
        '"Draft ready"',
        '"Running tool"',
        '"Task completed"',
        '"Waiting for approval"',
        'f"Completed {task_name}"',
        'f"Processing step {step}"',
        'f"Retry {attempt}"',
    }


def test_python_checker_detects_nested_and_indirect_trace_line_product_text() -> None:
    """Reject fixed trace-line prose while leaving event, provider, and user raw values legal."""
    diagnostics = check_python_files(
        [_fixture("invalid/trace_line_product_text.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
    )

    product_text = [
        diagnostic for diagnostic in diagnostics if diagnostic.rule == "python.productNaturalText"
    ]
    assert len(product_text) == 4
    assert {" ".join(diagnostic.source.split()) for diagnostic in product_text} == {
        '"Preparing response"',
        '"Retrying action" if event_data.get("retry") else "Waiting for action"',
        '" · ".join(status_parts)',
        'f"Calling {provider_output.name}"',
    }


def test_python_checker_detects_cross_file_nested_failure_projections() -> None:
    """Reject persisted errors, nested task failures, Skill strings, and remote error events."""
    diagnostics = check_python_files(
        [
            _fixture("invalid/persisted_failure_producer.py"),
            _fixture("invalid/nested_public_failure_consumers.py"),
        ],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
    )

    assert [diagnostic.rule for diagnostic in diagnostics].count("python.publicExceptionLeak") == 7
    assert [diagnostic.rule for diagnostic in diagnostics].count("python.dynamicErrorCode") == 1


def test_python_checker_rejects_forged_same_name_public_projector() -> None:
    """Reject a local projector lookalike that lacks canonical module provenance."""
    diagnostics = check_python_files(
        [_fixture("invalid/forged_public_projector.py")],
        registered_error_codes={"INTERNAL_ERROR", "VALIDATION_ERROR"},
    )

    assert [diagnostic.rule for diagnostic in diagnostics] == [
        "python.dynamicErrorCode",
        "python.publicExceptionLeak",
    ]


def test_python_checker_detects_descriptor_event_and_private_cause_bypasses() -> None:
    """Reject schema drift, unregistered Harness codes, arbitrary events, and lost root causes."""
    diagnostics = check_python_files(
        [_fixture("invalid/descriptor_event_blind_spots.py")],
        registered_error_codes={
            "AGENT_REPLY_LOCALE_CONFLICT",
            "INTERNAL_ERROR",
            "VALIDATION_ERROR",
        },
        registered_error_params={
            "AGENT_REPLY_LOCALE_CONFLICT": {"requested", "session"},
            "INTERNAL_ERROR": set(),
            "VALIDATION_ERROR": {"error_count"},
        },
    )

    assert [diagnostic.rule for diagnostic in diagnostics].count("python.errorParamsMismatch") == 3
    assert [diagnostic.rule for diagnostic in diagnostics].count(
        "python.unregisteredDescriptor"
    ) == 1
    assert [diagnostic.rule for diagnostic in diagnostics].count(
        "python.unstructuredEventPayload"
    ) == 1
    assert [diagnostic.rule for diagnostic in diagnostics].count("python.missingPrivateCause") == 1


def test_python_checker_supports_human_and_json_diagnostics() -> None:
    """Emit deterministic terminal and artifact formats for the same findings."""
    diagnostics = check_python_files(
        [_fixture("invalid/unregistered_descriptor.py")],
        registered_error_codes={"INTERNAL_ERROR"},
    )

    assert "python.unregisteredDescriptor" in format_diagnostics(diagnostics, "human")
    assert '"rule": "python.unregisteredDescriptor"' in format_diagnostics(diagnostics, "json")


def test_python_checker_accepts_llm_client_failed_spans_without_exception_alias_leaks() -> None:
    """Keep caught provider exceptions out of product-readable failed-span calls in the LLM client."""
    diagnostics = check_python_files(
        [REPOSITORY_ROOT / "backend" / "app" / "llm" / "client.py"],
        registered_error_codes={
            "INTERNAL_ERROR",
            "MODEL_CONNECTION_FAILED",
            "MODEL_PROTOCOL_UNSUPPORTED",
            "MODEL_UPSTREAM_ERROR",
        },
    )

    assert [diagnostic.rule for diagnostic in diagnostics] == []


def test_python_checker_cli_fails_for_invalid_fixture() -> None:
    """Keep the command-line gate fail-closed when a checked fixture violates the contract."""
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "scripts" / "i18n" / "check_python.py"),
            "--registered-code",
            "INTERNAL_ERROR",
            str(_fixture("invalid/unregistered_descriptor.py")),
        ],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 1
    assert "python.unregisteredDescriptor" in result.stderr
