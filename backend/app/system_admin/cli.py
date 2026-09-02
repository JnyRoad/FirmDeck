"""No-echo local bootstrap and password-recovery commands for system administrators."""

from __future__ import annotations

import argparse
import getpass
import logging
import sys
from collections.abc import Sequence
from uuid import uuid4

from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session

from app.db import engine
from app.security.auth import hash_password
from app.security.password_policy import SYSTEM_POLICY_SCOPE, installation_policy, validate_password
from app.system_admin.service import (
    InvalidControlInputError,
    SystemAdminNotFoundError,
    bootstrap_system_admin,
    reset_system_admin_password,
)

logger = logging.getLogger(__name__)
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 20


class _CliInputError(ValueError):
    """Mark parser failures without retaining argparse's potentially secret-bearing message."""


class _SafeArgumentParser(argparse.ArgumentParser):
    """Suppress raw argument text so invalid command lines cannot echo password values."""

    def error(self, _message: str) -> None:
        """Raise a private input error instead of printing the parser's raw argv context."""
        raise _CliInputError


def _build_parser() -> argparse.ArgumentParser:
    """Build the two explicitly supported local commands and no password argv option."""
    parser = _SafeArgumentParser(prog="python -m app.system_admin.cli")
    commands = parser.add_subparsers(
        dest="command", required=True, parser_class=_SafeArgumentParser
    )

    commands.add_parser("bootstrap")

    reset = commands.add_parser("reset-password")
    reset.add_argument("--username", required=True)
    return parser


def _read_confirmed_password() -> str:
    """Read and confirm one operator password without echoing either prompt response."""
    password = getpass.getpass("System administrator password: ")
    confirmation = getpass.getpass("Confirm system administrator password: ")
    if (
        not isinstance(password, str)
        or not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH
        or password != confirmation
    ):
        raise InvalidControlInputError("password policy or confirmation failed")
    return password


def _safe_username(username: object) -> str:
    """Validate and normalize a command-line username without exposing invalid input."""
    if not isinstance(username, str):
        raise InvalidControlInputError("username is invalid")
    normalized = username.strip()
    if not normalized or len(normalized) > 120:
        raise InvalidControlInputError("username is invalid")
    return normalized


def _run_bootstrap(args: argparse.Namespace, correlation_id: str) -> int:
    """Create the fixed development administrator and print only stable, secret-free outcomes."""
    with Session(engine) as db:
        result = bootstrap_system_admin(
            db,
            correlation_id=correlation_id,
        )
    if result.created:
        print(
            "SYSTEM_BOOTSTRAP_SUCCEEDED "
            f"admin_id={result.admin_id} username={result.username} "
            f"correlation_id={correlation_id}"
        )
        return 0
    print(
        "SYSTEM_BOOTSTRAP_ALREADY_COMPLETE "
        f"admin_id={result.admin_id} username={result.username} "
        f"correlation_id={correlation_id}",
        file=sys.stderr,
    )
    return 2


def _run_reset_password(args: argparse.Namespace, correlation_id: str) -> int:
    """Prompt, hash, and rotate one existing administrator's password without minting a token."""
    username = _safe_username(args.username)
    password = _read_confirmed_password()
    with Session(engine) as db:
        if not validate_password(password, installation_policy(db, SYSTEM_POLICY_SCOPE)):
            raise InvalidControlInputError("password policy failed")
        password_digest = hash_password(password)
        result = reset_system_admin_password(
            db,
            username=username,
            password_hash=password_digest,
            correlation_id=correlation_id,
        )
    print(
        "SYSTEM_ADMIN_PASSWORD_RESET_SUCCEEDED "
        f"admin_id={result.admin_id} username={result.username} "
        f"correlation_id={correlation_id}"
    )
    return 0


def _report_input_failure(code: str, correlation_id: str) -> int:
    """Print one stable validation code and no user-controlled argument or secret."""
    print(f"{code} correlation_id={correlation_id}", file=sys.stderr)
    return 2


def _report_storage_failure(code: str, correlation_id: str, exc: Exception) -> int:
    """Log only the safe exception type and print the stable storage result."""
    logger.error(
        "system admin local operation storage failure exception_type=%s correlation_id=%s",
        type(exc).__name__,
        correlation_id,
    )
    print(f"{code} correlation_id={correlation_id}", file=sys.stderr)
    return 3


def _report_unexpected_failure(code: str, correlation_id: str, exc: Exception) -> int:
    """Log only exception type/correlation and expose a generic unexpected-operation code."""
    logger.error(
        "system admin local operation failed exception_type=%s correlation_id=%s",
        type(exc).__name__,
        correlation_id,
    )
    print(f"{code} correlation_id={correlation_id}", file=sys.stderr)
    return 4


def main(argv: Sequence[str] | None = None) -> int:
    """Run one local system-admin command and return its documented process exit code."""
    correlation_id = uuid4().hex
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except _CliInputError:
        return _report_input_failure("SYSTEM_BOOTSTRAP_INPUT_INVALID", correlation_id)
    except SystemExit as exc:
        # ``--help`` is the only normal argparse exit; all other parser exits are input failures.
        if exc.code == 0:
            return 0
        return _report_input_failure("SYSTEM_BOOTSTRAP_INPUT_INVALID", correlation_id)

    try:
        if args.command == "bootstrap":
            return _run_bootstrap(args, correlation_id)
        if args.command == "reset-password":
            return _run_reset_password(args, correlation_id)
        return _report_input_failure("SYSTEM_BOOTSTRAP_INPUT_INVALID", correlation_id)
    except InvalidControlInputError:
        code = (
            "SYSTEM_BOOTSTRAP_INPUT_INVALID"
            if args.command == "bootstrap"
            else "SYSTEM_ADMIN_PASSWORD_INVALID"
        )
        return _report_input_failure(code, correlation_id)
    except SystemAdminNotFoundError:
        return _report_input_failure("SYSTEM_ADMIN_NOT_FOUND", correlation_id)
    except SQLAlchemyError as exc:
        code = (
            "SYSTEM_BOOTSTRAP_STORAGE_UNAVAILABLE"
            if args.command == "bootstrap"
            else "SYSTEM_ADMIN_STORAGE_UNAVAILABLE"
        )
        return _report_storage_failure(code, correlation_id, exc)
    except Exception as exc:  # noqa: BLE001 - CLI must return a stable failure code.
        code = (
            "SYSTEM_BOOTSTRAP_FAILED"
            if args.command == "bootstrap"
            else "SYSTEM_ADMIN_PASSWORD_RESET_FAILED"
        )
        return _report_unexpected_failure(code, correlation_id, exc)


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = ["main"]
