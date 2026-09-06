"""Stable FirmDeck-owned wire contracts shared by backend product boundaries."""

from app.contracts.error_registry import (
    ERROR_REGISTRY,
    ErrorContractViolation,
    ErrorRegistry,
    ErrorRegistryEntry,
    ErrorVisibility,
)
from app.contracts.errors import ErrorDescriptor, ErrorOccurrence, InternalErrorContext
from app.contracts.http import build_http_exception

__all__ = [
    "ERROR_REGISTRY",
    "ErrorContractViolation",
    "ErrorDescriptor",
    "ErrorOccurrence",
    "ErrorRegistry",
    "ErrorRegistryEntry",
    "ErrorVisibility",
    "InternalErrorContext",
    "build_http_exception",
]
