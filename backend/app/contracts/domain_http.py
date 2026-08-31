"""Domain HTTP error adapters with a private diagnostic cause boundary.

Product routes must expose only the stable error descriptor projection.  A caught
exception may still be attached to the raised exception for server-side logging,
but its text is intentionally never copied into descriptor params.
"""

from __future__ import annotations

from collections.abc import Mapping

from fastapi import HTTPException

from app.contracts.errors import InternalErrorContext, JsonValue
from app.contracts.http import build_http_exception


def domain_http_error(
    code: str,
    *,
    source: str,
    status_code: int | None = None,
    params: Mapping[str, JsonValue] | None = None,
    retryable: bool | None = None,
    cause: BaseException | None = None,
) -> HTTPException:
    """Build a canonical HTTP error while keeping exception prose private.

    ``params`` is intentionally supplied by the caller from bounded, named
    business metadata only.  ``cause`` is stored as private context and is never
    serialized into the response detail.
    """
    internal = None
    if cause is not None:
        internal = InternalErrorContext(
            source=source,
            exception_type=type(cause).__name__,
            raw_message=str(cause),
            upstream_code=code,
        )
    return build_http_exception(
        code,
        params=params,
        status_code=status_code,
        retryable=retryable,
        internal=internal,
    )


__all__ = ["domain_http_error"]
