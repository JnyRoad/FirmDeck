"""RED contracts for local system-administrator bootstrap and password recovery."""

from __future__ import annotations

import importlib
import importlib.util
import logging
import re
import threading
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import event
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, SQLModel, create_engine, func, select

from app.db.models import SystemAdmin, SystemControlAudit
from app.security import system_admin_auth
from app.security.auth import verify_password

_PASSWORD = "sysadmin"
_NEW_PASSWORD = "Replace-Secret-26"
_SYSTEM_SECRET = "t015-system-signing-secret"


def _cli_module() -> ModuleType:
    """Load the planned public module lazily so every test collects before T019 exists."""
    assert importlib.util.find_spec("app.system_admin.cli") is not None, (
        "T019 must implement app.system_admin.cli with a callable main entry point"
    )
    module = importlib.import_module("app.system_admin.cli")
    assert callable(getattr(module, "main", None)), "T019 must expose cli.main(argv, ...)"
    return module


def _engine(tmp_path, name: str = "system-admin-cli.db"):
    """Create a file-backed isolated database suitable for independent concurrent Sessions."""
    engine = create_engine(
        f"sqlite:///{tmp_path / name}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _password_reader(values: Sequence[str]) -> tuple[Callable[[str], str], list[str]]:
    """Return a deterministic no-echo reader and the prompts it observed."""
    remaining: Iterator[str] = iter(values)
    prompts: list[str] = []

    def read_password(prompt: str) -> str:
        prompts.append(prompt)
        return next(remaining)

    return read_password, prompts


def _run(
    module: ModuleType, engine, argv: list[str], passwords: Sequence[str]
) -> tuple[int, list[str]]:
    """Patch ordinary module dependencies while keeping the public CLI signature operator-safe."""
    assert getattr(module, "engine", None) is not None, "T019 CLI must use the application engine"
    assert getattr(module, "getpass", None) is not None, "T019 CLI must use getpass.getpass"
    reader, prompts = _password_reader(passwords)
    with (
        patch.object(module, "engine", engine),
        patch.object(module.getpass, "getpass", reader),
    ):
        code = module.main(argv)
    assert isinstance(code, int)
    return code, prompts


def _count(db: Session, model: type[SystemAdmin | SystemControlAudit]) -> int:
    return int(db.exec(select(func.count()).select_from(model)).one())


def test_bootstrap_uses_fixed_credential_without_prompt_and_rejects_password_argv(
    tmp_path,
    capsys,
) -> None:
    """Create the approved fixed development credential and never accept a secret in argv."""
    cli = _cli_module()
    engine = _engine(tmp_path)

    code, prompts = _run(
        cli,
        engine,
        ["bootstrap"],
        [],
    )
    captured = capsys.readouterr()
    assert code == 0
    assert prompts == []
    assert "password=" not in (captured.out + captured.err).lower()

    forbidden_code, forbidden_prompts = _run(
        cli,
        engine,
        ["bootstrap", "--password", _PASSWORD],
        [],
    )
    forbidden = capsys.readouterr()
    assert forbidden_code == 2
    assert forbidden_prompts == []
    assert "SYSTEM_BOOTSTRAP_INPUT_INVALID" in forbidden.err
    assert _PASSWORD not in forbidden.out + forbidden.err


def test_bootstrap_creates_one_active_admin_and_one_safe_audit(tmp_path, capsys, caplog) -> None:
    """Create the only initial system identity and audit it atomically without minting a token."""
    cli = _cli_module()
    engine = _engine(tmp_path)

    code, _ = _run(
        cli,
        engine,
        ["bootstrap"],
        [],
    )
    captured = capsys.readouterr()

    with Session(engine) as db:
        admins = db.exec(select(SystemAdmin)).all()
        audits = db.exec(select(SystemControlAudit)).all()
    assert code == 0
    assert len(admins) == 1
    assert admins[0].username == "sysadmin"
    assert admins[0].status == "active"
    assert admins[0].auth_version == 1
    assert admins[0].must_change_password is True
    assert verify_password(_PASSWORD, admins[0].password_hash)
    assert len(audits) == 1
    assert audits[0].action == "system_admin.bootstrap"
    assert audits[0].result == "succeeded"
    assert audits[0].actor_system_admin_id is None
    assert audits[0].actor_label == "local-operator"
    assert audits[0].target_id == admins[0].id
    assert audits[0].reason_code == "SYSTEM_BOOTSTRAP_SUCCEEDED"
    assert audits[0].request_id or audits[0].trace_id
    assert captured.err == ""
    assert "SYSTEM_BOOTSTRAP_SUCCEEDED" in captured.out
    assert admins[0].id in captured.out
    assert admins[0].username in captured.out
    # The approved username and initial password are both ``sysadmin``. The username is expected
    # in success output, so the redaction contract checks password-labelled output and hashes.
    assert "password=" not in captured.out.lower()
    assert admins[0].password_hash not in captured.out
    assert admins[0].password_hash not in captured.err + caplog.text
    assert "token" not in captured.out.lower()


def test_bootstrap_repeated_attempt_is_stable_and_creates_no_extra_rows(tmp_path, capsys) -> None:
    """Reject every later bootstrap with the documented code and preserve the original identity."""
    cli = _cli_module()
    engine = _engine(tmp_path)
    first, _ = _run(cli, engine, ["bootstrap"], [])
    capsys.readouterr()
    with Session(engine) as db:
        original = db.exec(select(SystemAdmin)).one()
        original_identity = (
            original.id,
            original.username,
            original.password_hash,
            original.auth_version,
            original.status,
        )
    second, _ = _run(
        cli,
        engine,
        ["bootstrap"],
        [],
    )
    captured = capsys.readouterr()

    with Session(engine) as db:
        assert _count(db, SystemAdmin) == 1
        audits = db.exec(
            select(SystemControlAudit).where(SystemControlAudit.action == "system_admin.bootstrap")
        ).all()
        preserved = db.exec(select(SystemAdmin)).one()
        assert (
            preserved.id,
            preserved.username,
            preserved.password_hash,
            preserved.auth_version,
            preserved.status,
        ) == original_identity
    assert len(audits) == 2
    assert sorted(audit.result for audit in audits) == ["rejected", "succeeded"]
    rejected = next(audit for audit in audits if audit.result == "rejected")
    assert rejected.target_id == original_identity[0]
    assert rejected.reason_code == "SYSTEM_BOOTSTRAP_ALREADY_COMPLETE"
    assert rejected.actor_system_admin_id is None
    assert rejected.actor_label == "local-operator"
    assert rejected.request_id or rejected.trace_id
    assert first == 0
    assert second == 2
    assert "SYSTEM_BOOTSTRAP_ALREADY_COMPLETE" in captured.err
    assert _NEW_PASSWORD not in captured.out + captured.err


def test_concurrent_bootstrap_has_exactly_one_winner(tmp_path) -> None:
    """Use the database transaction as the final bootstrap arbiter under a simultaneous start."""
    cli = _cli_module()
    engine = _engine(tmp_path)
    barrier = threading.Barrier(2)
    def attempt(_attempt_number: int) -> int:
        barrier.wait(timeout=10)
        return cli.main(["bootstrap"])

    with (
        patch.object(cli, "engine", engine),
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        results = sorted(pool.map(attempt, [1, 2]))

    assert results == [0, 2]
    with Session(engine) as db:
        admins = db.exec(select(SystemAdmin)).all()
        audits = db.exec(select(SystemControlAudit)).all()
    assert len(admins) == 1
    assert admins[0].username == "sysadmin"
    assert len(audits) == 2
    assert all(audit.action == "system_admin.bootstrap" for audit in audits)
    assert sorted(audit.result for audit in audits) == ["rejected", "succeeded"]
    assert all(audit.target_id == admins[0].id for audit in audits)
    assert {audit.reason_code for audit in audits} == {
        "SYSTEM_BOOTSTRAP_SUCCEEDED",
        "SYSTEM_BOOTSTRAP_ALREADY_COMPLETE",
    }
    assert all(audit.actor_system_admin_id is None for audit in audits)
    assert all(audit.actor_label == "local-operator" for audit in audits)
    assert all(audit.request_id or audit.trace_id for audit in audits)


def test_bootstrap_input_failure_has_no_partial_identity_or_audit(tmp_path, capsys) -> None:
    """Reject unsupported bootstrap arguments and keep both system tables empty."""
    cli = _cli_module()
    engine = _engine(tmp_path)
    code, _ = _run(
        cli,
        engine,
        ["bootstrap", "--username", "root"],
        [],
    )
    captured = capsys.readouterr()

    assert code == 2
    assert "SYSTEM_BOOTSTRAP_INPUT_INVALID" in captured.err
    assert "password=" not in (captured.out + captured.err).lower()
    with Session(engine) as db:
        assert _count(db, SystemAdmin) == 0
        assert _count(db, SystemControlAudit) == 0


def test_bootstrap_storage_failure_rolls_back_and_redacts_raw_exception(
    tmp_path,
    capsys,
    caplog,
) -> None:
    """Roll back the identity if the audit insert fails and expose only the stable storage code."""
    cli = _cli_module()
    engine = _engine(tmp_path)
    sentinel = "raw-db-password=never-print-this"
    generated_hash = "bootstrap-hash-must-never-leak"
    prior_admin_insert = False
    injected = False

    def fail_audit_insert(_conn, _cursor, statement, _parameters, _context, _many) -> None:
        nonlocal injected, prior_admin_insert
        if "INSERT INTO system_admins" in statement:
            prior_admin_insert = True
        if "INSERT INTO system_control_audits" in statement:
            assert prior_admin_insert
            injected = True
            raise OperationalError(statement, {}, RuntimeError(sentinel))

    event.listen(engine, "before_cursor_execute", fail_audit_insert)
    with (
        caplog.at_level(logging.ERROR),
        patch("app.system_admin.service.hash_password", return_value=generated_hash),
    ):
        code, _ = _run(cli, engine, ["bootstrap"], [])
    event.remove(engine, "before_cursor_execute", fail_audit_insert)
    captured = capsys.readouterr()

    assert prior_admin_insert is True
    assert injected is True
    assert code == 3
    assert "SYSTEM_BOOTSTRAP_STORAGE_UNAVAILABLE" in captured.err
    inspected = captured.out + captured.err + caplog.text
    assert _PASSWORD not in inspected
    assert generated_hash not in inspected
    assert sentinel not in inspected
    with Session(engine) as db:
        assert _count(db, SystemAdmin) == 0
        assert _count(db, SystemControlAudit) == 0


def test_reset_password_updates_hash_version_timestamp_and_audit(tmp_path, capsys, caplog) -> None:
    """Rotate a local system credential in one transaction without printing either credential."""
    cli = _cli_module()
    engine = _engine(tmp_path)
    assert _run(cli, engine, ["bootstrap"], [])[0] == 0
    capsys.readouterr()
    with Session(engine) as db:
        original = db.exec(select(SystemAdmin).where(SystemAdmin.username == "sysadmin")).one()
        original_hash = original.password_hash
        original_updated_at = original.updated_at

    code, prompts = _run(
        cli,
        engine,
        ["reset-password", "--username", "sysadmin"],
        [_NEW_PASSWORD, _NEW_PASSWORD],
    )
    captured = capsys.readouterr()

    with Session(engine) as db:
        admin = db.exec(select(SystemAdmin).where(SystemAdmin.username == "sysadmin")).one()
        reset_audits = db.exec(
            select(SystemControlAudit).where(
                SystemControlAudit.action == "system_admin.local_password_reset"
            )
        ).all()
    assert code == 0
    assert len(prompts) == 2
    assert admin.password_hash != original_hash
    assert verify_password(_NEW_PASSWORD, admin.password_hash)
    assert admin.auth_version == 2
    assert admin.updated_at > original_updated_at
    assert len(reset_audits) == 1
    assert reset_audits[0].actor_system_admin_id is None
    assert reset_audits[0].actor_label == "local-operator"
    assert reset_audits[0].target_id == admin.id
    assert reset_audits[0].result == "succeeded"
    assert reset_audits[0].reason_code == "SYSTEM_ADMIN_PASSWORD_RESET_SUCCEEDED"
    assert reset_audits[0].request_id or reset_audits[0].trace_id
    assert "SYSTEM_ADMIN_PASSWORD_RESET_SUCCEEDED" in captured.out
    assert "password=" not in (captured.out + captured.err).lower()
    assert _NEW_PASSWORD not in captured.out + captured.err
    assert original_hash not in captured.out + captured.err
    assert admin.password_hash not in captured.out + captured.err + caplog.text


def test_reset_password_invalidates_previously_issued_system_token(
    tmp_path,
    capsys,
    monkeypatch,
) -> None:
    """Increment auth_version so an old system token fails on its next authenticated request."""
    cli = _cli_module()
    engine = _engine(tmp_path)
    monkeypatch.setattr(
        system_admin_auth,
        "get_settings",
        lambda: SimpleNamespace(system_admin_secret=_SYSTEM_SECRET),
    )
    assert _run(cli, engine, ["bootstrap"], [])[0] == 0
    capsys.readouterr()
    with Session(engine) as db:
        admin = db.exec(select(SystemAdmin).where(SystemAdmin.username == "sysadmin")).one()
        old_token = system_admin_auth.create_system_access_token(admin)

    assert (
        _run(
            cli,
            engine,
            ["reset-password", "--username", "sysadmin"],
            [_NEW_PASSWORD, _NEW_PASSWORD],
        )[0]
        == 0
    )
    captured = capsys.readouterr()
    with Session(engine) as db, pytest.raises(HTTPException) as denied:
        system_admin_auth.get_current_system_admin(
            HTTPAuthorizationCredentials(scheme="Bearer", credentials=old_token),
            db,
        )
    assert denied.value.status_code == 401
    assert old_token not in captured.out + captured.err


@pytest.mark.parametrize(
    ("username", "passwords", "expected_code"),
    [
        ("missing", [_NEW_PASSWORD, _NEW_PASSWORD], "SYSTEM_ADMIN_NOT_FOUND"),
        ("sysadmin", [_NEW_PASSWORD, "mismatch"], "SYSTEM_ADMIN_PASSWORD_INVALID"),
    ],
)
def test_reset_password_not_found_and_invalid_input_are_stable(
    tmp_path,
    capsys,
    username: str,
    passwords: list[str],
    expected_code: str,
) -> None:
    """Return the documented exit-2 failures without changing the existing administrator."""
    cli = _cli_module()
    engine = _engine(tmp_path, f"reset-{username}.db")
    assert _run(cli, engine, ["bootstrap"], [])[0] == 0
    capsys.readouterr()
    with Session(engine) as db:
        before = db.exec(select(SystemAdmin).where(SystemAdmin.username == "sysadmin")).one()
        before_hash = before.password_hash

    code, _ = _run(
        cli,
        engine,
        ["reset-password", "--username", username],
        passwords,
    )
    captured = capsys.readouterr()

    assert code == 2
    assert expected_code in captured.err
    assert _NEW_PASSWORD not in captured.out + captured.err
    with Session(engine) as db:
        after = db.exec(select(SystemAdmin).where(SystemAdmin.username == "sysadmin")).one()
        assert after.password_hash == before_hash
        assert after.auth_version == 1
        assert _count(db, SystemControlAudit) == 1


def test_reset_storage_failure_rolls_back_hash_version_and_audit(tmp_path, capsys, caplog) -> None:
    """Keep the old credential/version when the reset audit cannot be committed."""
    cli = _cli_module()
    engine = _engine(tmp_path)
    assert _run(cli, engine, ["bootstrap"], [])[0] == 0
    capsys.readouterr()
    with Session(engine) as db:
        before = db.exec(select(SystemAdmin).where(SystemAdmin.username == "sysadmin")).one()
        before_hash = before.password_hash
    prior_admin_update = False
    injected = False
    replacement_hash = "replacement-hash-must-never-leak"

    def fail_reset_audit(_conn, _cursor, statement, parameters, _context, _many) -> None:
        nonlocal injected, prior_admin_update
        if "UPDATE system_admins" in statement:
            prior_admin_update = True
        if "INSERT INTO system_control_audits" in statement and "local_password_reset" in repr(
            parameters
        ):
            assert prior_admin_update
            injected = True
            raise OperationalError(statement, parameters, RuntimeError("reset-storage-sentinel"))

    event.listen(engine, "before_cursor_execute", fail_reset_audit)
    with (
        caplog.at_level(logging.ERROR),
        patch.object(cli, "hash_password", return_value=replacement_hash),
    ):
        code, _ = _run(
            cli,
            engine,
            ["reset-password", "--username", "sysadmin"],
            [_NEW_PASSWORD, _NEW_PASSWORD],
        )
    event.remove(engine, "before_cursor_execute", fail_reset_audit)
    captured = capsys.readouterr()

    assert prior_admin_update is True
    assert injected is True
    assert code == 3
    assert "SYSTEM_ADMIN_STORAGE_UNAVAILABLE" in captured.err
    inspected = captured.out + captured.err + caplog.text
    assert "reset-storage-sentinel" not in inspected
    assert replacement_hash not in inspected
    assert _NEW_PASSWORD not in inspected
    with Session(engine) as db:
        after = db.exec(select(SystemAdmin).where(SystemAdmin.username == "sysadmin")).one()
        assert after.password_hash == before_hash
        assert after.auth_version == 1
        assert _count(db, SystemControlAudit) == 1


def test_unexpected_bootstrap_failure_returns_exit_four_with_safe_correlation(
    tmp_path,
    capsys,
    caplog,
) -> None:
    """Project unexpected bootstrap faults through the documented safe code and correlation ID."""
    cli = _cli_module()
    engine = _engine(tmp_path)
    sentinel = "unexpected-bootstrap-secret"
    with (
        caplog.at_level(logging.ERROR),
        patch("app.system_admin.service.hash_password", side_effect=RuntimeError(sentinel)),
    ):
        code, _ = _run(
            cli,
            engine,
            ["bootstrap"],
            [],
        )
    captured = capsys.readouterr()

    assert code == 4
    assert "SYSTEM_BOOTSTRAP_FAILED" in captured.err
    assert re.search(r"correlation_id=[0-9a-f-]{16,}", captured.err)
    inspected = captured.out + captured.err + caplog.text
    assert sentinel not in inspected
    assert _PASSWORD not in inspected
    with Session(engine) as db:
        assert _count(db, SystemAdmin) == 0
        assert _count(db, SystemControlAudit) == 0


def test_unexpected_reset_failure_returns_exit_four_with_safe_correlation(
    tmp_path,
    capsys,
    caplog,
) -> None:
    """Project unexpected reset faults without changing credentials or exposing raw diagnostics."""
    cli = _cli_module()
    engine = _engine(tmp_path)
    assert _run(cli, engine, ["bootstrap"], [])[0] == 0
    capsys.readouterr()
    with Session(engine) as db:
        before = db.exec(select(SystemAdmin).where(SystemAdmin.username == "sysadmin")).one()
        before_hash = before.password_hash
    sentinel = "unexpected-reset-secret"
    assert getattr(cli, "hash_password", None) is not None

    with (
        caplog.at_level(logging.ERROR),
        patch.object(cli, "hash_password", side_effect=RuntimeError(sentinel)),
    ):
        code, _ = _run(
            cli,
            engine,
            ["reset-password", "--username", "sysadmin"],
            [_NEW_PASSWORD, _NEW_PASSWORD],
        )
    captured = capsys.readouterr()

    assert code == 4
    assert "SYSTEM_ADMIN_PASSWORD_RESET_FAILED" in captured.err
    assert re.search(r"correlation_id=[0-9a-f-]{16,}", captured.err)
    inspected = captured.out + captured.err + caplog.text
    assert sentinel not in inspected
    assert _NEW_PASSWORD not in inspected
    with Session(engine) as db:
        after = db.exec(select(SystemAdmin).where(SystemAdmin.username == "sysadmin")).one()
        assert after.password_hash == before_hash
        assert after.auth_version == 1
        assert _count(db, SystemControlAudit) == 1
