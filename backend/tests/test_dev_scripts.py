from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from typing import Self

ROOT_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))


def _load_script(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_supervisor_uses_platform_specific_executables() -> None:
    supervisor = _load_script("dev_supervisor")

    assert supervisor._backend_python("win32") == ROOT_DIR / "backend/.venv/Scripts/python.exe"
    assert supervisor._backend_python("linux") == ROOT_DIR / "backend/.venv/bin/python"
    assert supervisor._vite_executable("win32") == ROOT_DIR / "frontend-enterprise/node_modules/.bin/vite.cmd"
    assert supervisor._vite_executable("darwin") == ROOT_DIR / "frontend-enterprise/node_modules/.bin/vite"


def test_pid_alive_recognizes_current_process() -> None:
    process_utils = _load_script("process_utils")

    assert process_utils.pid_alive(os.getpid())


def test_dev_cli_uses_next_port_in_packaged_app_range(monkeypatch) -> None:
    """Verify packaged-app startup advances past an occupied default port."""
    dev = _load_script("dev")
    monkeypatch.delenv("ULTRARAG_PORT_RANGE_START", raising=False)
    monkeypatch.delenv("ULTRARAG_PORT_RANGE_END", raising=False)
    monkeypatch.setattr(dev, "_port_available", lambda _host, port: port != 5173)

    assert dev._select_available_port("127.0.0.1", 5173) == 5174


def test_url_ready_does_not_require_reading_response_body(monkeypatch) -> None:
    """Verify readiness succeeds without consuming a body that resets."""
    dev = _load_script("dev")

    class Response:
        """Model a successful response whose body cannot be consumed."""

        status = 200

        def __enter__(self) -> Self:
            """Return the fake response for context-manager compatibility."""
            return self

        def __exit__(self, *_args: object) -> bool:
            """Propagate exceptions raised while the fake response is in use."""
            return False

        def read(self) -> bytes:
            """Simulate a reset if readiness code consumes the response body."""
            raise ConnectionResetError("body connection closed")

    def open_response(*_args: object, **_kwargs: object) -> Response:
        """Return the controlled response without performing network I/O."""
        return Response()

    monkeypatch.setattr(dev.urllib.request, "urlopen", open_response)
    assert dev._url_ready("http://127.0.0.1:5173/api/health") is True


def test_url_ready_ignores_response_close_failure(monkeypatch) -> None:
    """Verify readiness stays successful when response cleanup resets."""
    dev = _load_script("dev")

    class Response:
        """Model a successful response that resets while being closed."""

        status = 200
        closed = False

        def close(self) -> None:
            """Simulate a connection reset while releasing the response."""
            self.closed = True
            raise ConnectionResetError("connection closed")

    response = Response()

    def open_response(*_args: object, **_kwargs: object) -> Response:
        """Return the tracked response without performing network I/O."""
        return response

    monkeypatch.setattr(dev.urllib.request, "urlopen", open_response)
    assert dev._url_ready("http://127.0.0.1:5173/api/health") is True
    assert response.closed is True


def test_supervisor_healthy_ignores_response_close_failure(monkeypatch) -> None:
    """Verify supervisor health stays true when response cleanup resets."""
    supervisor = _load_script("dev_supervisor")

    class Response:
        """Model a healthy supervisor response that resets while being closed."""

        status = 200
        closed = False

        def close(self) -> None:
            """Simulate a connection reset while releasing the response."""
            self.closed = True
            raise ConnectionResetError("connection closed")

    response = Response()

    def open_response(*_args: object, **_kwargs: object) -> Response:
        """Return the tracked response without performing network I/O."""
        return response

    monkeypatch.setattr(
        supervisor.urllib.request,
        "urlopen",
        open_response,
    )
    service = supervisor.Service(
        name="app",
        cwd=ROOT_DIR,
        command=["unused"],
        health_url="http://127.0.0.1:5173/api/health",
    )

    assert service.healthy() is True
    assert response.closed is True


def test_dev_cli_honors_packaged_app_port_range(monkeypatch) -> None:
    """Verify packaged-app startup stays within its configured port range."""
    dev = _load_script("dev")
    monkeypatch.setenv("ULTRARAG_PORT_RANGE_START", "6200")
    monkeypatch.setenv("ULTRARAG_PORT_RANGE_END", "6202")
    monkeypatch.setattr(dev, "_port_available", lambda _host, port: port == 6202)

    assert dev._select_available_port("127.0.0.1", 6200) == 6202


def test_dev_cli_keeps_complete_frontend_dependencies(monkeypatch) -> None:
    dev = _load_script("dev")
    calls: list[list[str]] = []
    monkeypatch.setattr(dev, "_npm_executable", lambda: "npm")

    def run(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(dev.subprocess, "run", run)

    dev._ensure_frontend_dependencies()

    assert len(calls) == 1
    assert calls[0][-3:] == ["ls", "--depth=0", "--json"]


def test_dev_cli_refreshes_incomplete_frontend_dependencies(monkeypatch) -> None:
    dev = _load_script("dev")
    calls: list[list[str]] = []
    monkeypatch.setattr(dev, "_npm_executable", lambda: "npm")

    def run(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 1 if "ls" in command else 0)

    monkeypatch.setattr(dev.subprocess, "run", run)

    dev._ensure_frontend_dependencies()

    assert len(calls) == 2
    assert calls[1][-3:] == ["ci", "--no-audit", "--no-fund"]


def test_dev_cli_detects_missing_backend_dependency(tmp_path, monkeypatch) -> None:
    """验证缺失的后端运行时依赖会使开发启动器请求刷新环境。"""
    dev = _load_script("dev")
    backend = tmp_path / "backend"
    backend.mkdir()
    (backend / "pyproject.toml").write_text(
        '[project]\ndependencies = ["present>=1", "missing>=1"]\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(dev, "ROOT_DIR", tmp_path)
    monkeypatch.setattr(
        dev,
        "_installed_distribution_version",
        lambda name: "1.2" if name == "present" else None,
    )

    assert dev._backend_dependencies_complete() is False


def test_dev_cli_refreshes_incomplete_backend_dependencies(monkeypatch) -> None:
    """验证依赖检查失败时以当前解释器刷新可编辑后端安装。"""
    dev = _load_script("dev")
    calls: list[list[str]] = []
    monkeypatch.setattr(dev, "_backend_dependencies_complete", lambda: False)

    def run(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(dev.subprocess, "run", run)

    dev._ensure_backend_dependencies()

    assert calls == [
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "-e",
            str(ROOT_DIR / "backend"),
        ]
    ]


def test_supervisor_does_not_restart_during_startup_grace(monkeypatch) -> None:
    supervisor = _load_script("dev_supervisor")

    class RunningProcess:
        def poll(self):
            return None

    service = supervisor.Service(name="app", cwd=ROOT_DIR, command=["unused"])
    service.health_url = "http://127.0.0.1:5173/api/health"
    service.process = RunningProcess()
    service.startup_deadline = 100.0
    monkeypatch.setattr(supervisor.time, "monotonic", lambda: 50.0)
    monkeypatch.setattr(service, "healthy", lambda: False)

    service.poll()

    assert service.unhealthy_count == 0
    assert service.restart_count == 0


def test_shell_wrappers_delegate_to_cross_platform_cli() -> None:
    for command in ("up", "down", "status"):
        script = (SCRIPTS_DIR / f"dev_{command}.sh").read_text(encoding="utf-8")
        assert '$ROOT_DIR/backend/.venv/bin/python' in script
        assert 'scripts/dev.py" ' + command in script


def test_powershell_wrappers_delegate_to_cross_platform_cli() -> None:
    for command in ("up", "down", "status"):
        script = (SCRIPTS_DIR / f"dev_{command}.ps1").read_text(encoding="utf-8")
        assert f'"$PSScriptRoot\\dev.ps1" {command}' in script


def test_powershell_launcher_accepts_newer_python_3_versions() -> None:
    script = (SCRIPTS_DIR / "dev.ps1").read_text(encoding="utf-8")

    assert 'Prefix = @("-3.11")' in script
    assert 'Prefix = @("-3")' in script
