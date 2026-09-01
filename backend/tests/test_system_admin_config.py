from app.config import Settings


def test_system_admin_secret_is_absent_by_default(monkeypatch) -> None:
    """Keep system HTTP authentication unavailable when no dedicated secret is configured."""
    monkeypatch.delenv("SYSTEM_ADMIN_SECRET", raising=False)

    settings = Settings(_env_file=None)

    assert settings.system_admin_secret == ""


def test_system_admin_secret_loads_only_from_its_environment_setting(monkeypatch) -> None:
    """Load the dedicated system signing secret through its explicit environment field."""
    monkeypatch.setenv("SYSTEM_ADMIN_SECRET", "test-only-system-admin-secret")

    settings = Settings(_env_file=None)

    assert settings.system_admin_secret == "test-only-system-admin-secret"
    assert "test-only-system-admin-secret" not in repr(settings)
    assert "system_admin_secret" not in settings.model_dump()


def test_system_admin_secret_does_not_fallback_to_app_secret(monkeypatch) -> None:
    """Keep tenant application signing material outside the system-control token domain."""
    monkeypatch.delenv("SYSTEM_ADMIN_SECRET", raising=False)
    monkeypatch.setenv("APP_SECRET", "test-only-application-secret")

    settings = Settings(_env_file=None)

    assert settings.app_secret == "test-only-application-secret"
    assert settings.system_admin_secret == ""


def test_codex_a2a_token_is_not_exposed_by_settings_repr() -> None:
    """Keep the installation credential out of incidental settings diagnostics."""
    settings = Settings(_env_file=None, codex_a2a_token="test-only-codex-config-token")

    assert "test-only-codex-config-token" not in repr(settings)
    assert "codex_a2a_token" not in settings.model_dump()
