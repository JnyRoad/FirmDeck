"""Lock the internationalization quality workflow and its local package entry points."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
QUALITY_WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "quality.yml"
PACKAGE_JSON_PATH = REPOSITORY_ROOT / "frontend-enterprise" / "package.json"
REQUIRED_QUALITY_JOBS = {"static-i18n", "frontend", "backend-i18n", "browser"}


def _load_workflow(path: Path) -> dict[str, Any]:
    """Load workflow structure without coercing GitHub's ``on`` key to a boolean."""
    return yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def _run_commands(job: dict[str, Any]) -> str:
    """Combine one job's shell commands for stable contract assertions without executing CI."""
    return "\n".join(step.get("run", "") for step in job.get("steps", []))


def _artifact_step(job: dict[str, Any]) -> dict[str, Any]:
    """Return the diagnostic upload step, failing clearly when a job cannot preserve evidence."""
    return next(
        step
        for step in job.get("steps", [])
        if str(step.get("uses", "")).startswith("actions/upload-artifact@")
    )


def test_quality_workflow_exposes_every_required_gate() -> None:
    """Require reusable static, frontend, backend, and browser gates on pushes and pull requests."""
    workflow = _load_workflow(QUALITY_WORKFLOW_PATH)

    assert REQUIRED_QUALITY_JOBS <= workflow["jobs"].keys()
    assert {"push", "pull_request", "workflow_dispatch", "workflow_call"} <= workflow["on"].keys()


def test_quality_workflow_uses_lockfile_installs_and_expected_commands() -> None:
    """Keep frontend jobs deterministic and bind every gate to its supported repository command."""
    workflow = _load_workflow(QUALITY_WORKFLOW_PATH)
    jobs = workflow["jobs"]

    for job_name in ("static-i18n", "frontend", "browser"):
        commands = _run_commands(jobs[job_name])
        assert "npm --prefix frontend-enterprise ci" in commands
        assert "npm --prefix frontend-enterprise install" not in commands

    assert "npm --prefix frontend-enterprise run i18n:check:frontend" in _run_commands(
        jobs["static-i18n"]
    )
    assert "npm --prefix frontend-enterprise run i18n:check:pseudo" in _run_commands(
        jobs["static-i18n"]
    )
    assert "npm --prefix frontend-enterprise test" in _run_commands(jobs["frontend"])
    assert "npm --prefix frontend-enterprise run build" in _run_commands(jobs["frontend"])
    backend_commands = _run_commands(jobs["backend-i18n"])
    assert "python scripts/i18n/check_python.py" in backend_commands
    assert "python scripts/i18n/export_contract.py --check" in backend_commands
    assert "python -m pytest backend/tests" in backend_commands
    assert "python -m ruff check" in backend_commands
    assert "backend/app/contracts" in backend_commands
    assert "scripts/i18n" in backend_commands
    assert "npm --prefix frontend-enterprise run test:e2e:i18n" in _run_commands(
        jobs["browser"]
    )


def test_quality_workflow_preserves_i18n_and_browser_diagnostics() -> None:
    """Upload static, backend, and browser evidence even when the corresponding gate fails."""
    workflow = _load_workflow(QUALITY_WORKFLOW_PATH)
    expected_paths = {
        "static-i18n": "artifacts/i18n/frontend",
        "backend-i18n": "artifacts/i18n/backend",
        "browser": "frontend-enterprise/playwright-report",
    }

    for job_name, expected_path in expected_paths.items():
        upload_step = _artifact_step(workflow["jobs"][job_name])
        assert upload_step["if"] == "always()"
        assert expected_path in upload_step["with"]["path"]
        assert upload_step["with"]["if-no-files-found"] == "ignore"


def test_package_scripts_compose_frontend_and_backend_i18n_gates() -> None:
    """Expose one local gate composed from focused frontend, backend, and browser commands."""
    package = json.loads(PACKAGE_JSON_PATH.read_text(encoding="utf-8"))
    scripts = package["scripts"]

    assert scripts["i18n:check:frontend"] == "node scripts/check-i18n.cjs"
    assert "../scripts/i18n/check_python.py" in scripts["i18n:check:backend"]
    assert "npm run i18n:check:frontend" in scripts["i18n:check"]
    assert "npm run i18n:check:backend" in scripts["i18n:check"]
    assert "npm run i18n:check:pseudo" in scripts["i18n:check"]
    assert scripts["test:e2e:i18n"] == "playwright test tests/e2e/i18n-critical.spec.ts"
