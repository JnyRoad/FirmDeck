"""T095 regression tests for locale-independent general-skill trace payloads."""

from __future__ import annotations

from app.core.harness_capability_invoker import HarnessCapabilityInvoker
from app.general_skills.runner import _emit, canonical_general_skill_trace_payload


def test_general_skill_trace_emitter_projects_descriptor_and_explicit_raw_fields() -> None:
    """Expose stable trace metadata while retaining technical values only as raw fields."""
    trace: list[dict[str, object]] = []

    _emit(
        trace,
        {
            "phase": "code_finished",
            "message": "不要把产品自然语言写入 trace",
            "attempt": 2,
            "runtime": "python",
            "return_code": 1,
            "stdout_preview": "raw stdout",
            "stderr_preview": "raw stderr",
            "code": "print('raw code')",
            "error": "raw error",
            "error_code": "raw.error.code",
        },
    )

    assert trace == [
        {
            "phase": "code_finished",
            "code": "general_skill.trace.code_finished",
            "event_code": "run.skill.trace",
            "params": {"attempt": 2, "runtime": "python", "return_code": 1},
            "raw_stdout": "raw stdout",
            "raw_stderr": "raw stderr",
            "raw_code": "print('raw code')",
            "raw_error": "raw error",
            "raw_error_code": "raw.error.code",
        }
    ]
    assert "message" not in trace[0]


def test_harness_general_skill_trace_uses_the_same_canonical_projection() -> None:
    """Keep the instruction-package trace aligned with the generated-runner trace contract."""
    events: list[tuple[str, dict[str, object]]] = []
    invoker = object.__new__(HarnessCapabilityInvoker)
    invoker.trace_sink = lambda event_type, payload: events.append((event_type, payload))

    invoker._emit_trace(
        "general_skill_trace",
        {
            "skill_slug": "weather",
            "skill_name": "Weather",
            "operation": "read",
            "requested_operation": "execute",
            "phase": "instructions_loaded",
            "message": "不要把产品自然语言写入 trace",
        },
    )

    assert events == [
        (
            "general_skill_trace",
            {
                "phase": "instructions_loaded",
                "code": "general_skill.trace.instructions_loaded",
                "event_code": "run.skill.trace",
                "params": {
                    "skill_slug": "weather",
                    "skill_name": "Weather",
                    "operation": "read",
                    "requested_operation": "execute",
                },
            },
        )
    ]
    assert "message" not in events[0][1]


def test_general_skill_trace_unknown_phase_fails_closed_to_fixed_descriptor() -> None:
    """Do not turn an unreviewed phase name into a new dynamic event-code contract."""
    payload = canonical_general_skill_trace_payload(
        {
            "phase": "unreviewed_phase",
            "message": "不要公开",
            "params": {"unreviewed": "drop"},
            "code": "print('raw')",
        }
    )

    assert payload == {
        "phase": "unknown",
        "code": "general_skill.trace.unknown",
        "event_code": "run.skill.trace",
        "params": {},
        "raw_code": "print('raw')",
    }


def test_general_skill_trace_empty_phase_and_nonprimitive_params_fail_closed() -> None:
    """Reject malformed phase metadata without leaking nested values into descriptor params."""
    payload = canonical_general_skill_trace_payload(
        {
            "phase": "",
            "params": {"attempt": {"secret": "drop"}},
            "message": "不要公开",
        }
    )

    assert payload == {
        "phase": "unknown",
        "code": "general_skill.trace.unknown",
        "event_code": "run.skill.trace",
        "params": {},
    }


def test_general_skill_trace_param_types_are_exact() -> None:
    """Drop type-mismatched machine metadata instead of forwarding an ambiguous descriptor."""
    payload = canonical_general_skill_trace_payload(
        {
            "phase": "code_finished",
            "params": {
                "attempt": "2",
                "runtime": 7,
                "return_code": False,
            },
        }
    )

    assert payload["params"] == {}


def test_general_skill_trace_non_mapping_input_fails_closed() -> None:
    """Keep malformed producer input from creating an unstructured trace payload."""
    assert canonical_general_skill_trace_payload(None) == {
        "phase": "unknown",
        "code": "general_skill.trace.unknown",
        "event_code": "run.skill.trace",
        "params": {},
    }
