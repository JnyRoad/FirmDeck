"""Canonical cross-function job error projection accepted by the checker."""

from __future__ import annotations

from app.contracts.error_registry import ERROR_REGISTRY
from app.contracts.projections import project_public_error


class JobResponse:
    """Stand in for a public job result response."""


def _safe_public_descriptor(error: object) -> object:
    """Validate or replace one descriptor before public projection."""
    return ERROR_REGISTRY.validate(error)


def _project_job_error(error: object) -> object:
    """Project a validated descriptor through the canonical public boundary."""
    return project_public_error(_safe_public_descriptor(error))


def _project_stored_job_error(row: object) -> object:
    """Forward persisted error data only through the verified canonical projector."""
    return _project_job_error(row.error_json)


def public_job_result(row: object) -> JobResponse:
    """Expose only the output of the structurally verified projector chain."""
    return JobResponse(error=_project_stored_job_error(row))
