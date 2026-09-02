from __future__ import annotations

import threading
from contextlib import nullcontext

import pytest

from app import main
from app.channels.service_wechat_kf_recovery import (
    start_wechat_kf_account_recovery,
    stop_wechat_kf_account_recovery,
)


def test_wechat_kf_recovery_starter_is_non_blocking_and_single_flight() -> None:
    """后台恢复运行期间 starter 立即返回且拒绝同进程重复任务。"""
    started = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def blocking_reconcile(*, should_stop) -> None:
        started.set()
        while not should_stop() and not release.wait(timeout=0.01):
            pass
        finished.set()

    assert start_wechat_kf_account_recovery(blocking_reconcile)
    assert started.wait(timeout=1)
    assert not finished.is_set()
    assert not start_wechat_kf_account_recovery(lambda *, should_stop: None)
    assert stop_wechat_kf_account_recovery(timeout_seconds=1)
    assert finished.wait(timeout=1)
    assert start_wechat_kf_account_recovery(lambda *, should_stop: None)
    assert stop_wechat_kf_account_recovery(timeout_seconds=1)


def test_wechat_kf_recovery_defers_release_callback_until_blocked_thread_exits() -> None:
    """有界等待超时时不得提前释放 runtime lock，线程退出后才执行回调。"""
    started = threading.Event()
    release = threading.Event()
    released = threading.Event()

    def blocked_reconcile(*, should_stop) -> None:
        started.set()
        release.wait(timeout=2)

    assert start_wechat_kf_account_recovery(blocked_reconcile)
    assert started.wait(timeout=1)
    assert not stop_wechat_kf_account_recovery(
        timeout_seconds=0,
        on_stopped=released.set,
    )
    assert not released.is_set()
    release.set()
    assert released.wait(timeout=1)


def test_startup_schedules_wechat_kf_reconciliation_without_running_it_inline(
    monkeypatch,
) -> None:
    """Provider 恢复只能交给后台 starter，startup 本身不得执行网络工作。"""
    scheduled: list[object] = []
    provider_calls = 0

    def provider_reconcile(*, should_stop) -> None:
        nonlocal provider_calls
        provider_calls += 1

    starter = getattr(main, "start_wechat_kf_account_recovery", None)
    assert callable(starter), "WeChat KF background recovery starter is missing"

    monkeypatch.setattr(main, "acquire_runtime_instance_lock", lambda: None)
    monkeypatch.setattr(main, "release_runtime_instance_lock", lambda: None)
    monkeypatch.setattr(main, "start_async_jobs", lambda: None)
    monkeypatch.setattr(main, "init_db", lambda: None)
    monkeypatch.setattr(main, "Session", lambda _engine: nullcontext(object()))
    monkeypatch.setattr(main, "seed_demo_data", lambda _db: None)
    monkeypatch.setattr(main, "recover_orphan_harness_runs", lambda _db, startup: None)
    monkeypatch.setattr(main, "recover_codex_a2a_tasks", lambda: None)
    monkeypatch.setattr(main, "recover_a2a_client_tasks", lambda: None)
    monkeypatch.setattr(main, "start_background_worker", lambda: None)
    monkeypatch.setattr(main, "start_channel_services", lambda: None)
    monkeypatch.setattr(main, "start_timeout_sweeper", lambda: None)
    monkeypatch.setattr(main, "start_harness_recovery_sweeper", lambda: None)
    monkeypatch.setattr(main, "recover_public_jobs", lambda: None)
    monkeypatch.setattr(main.settings, "public_api_enabled", False)
    monkeypatch.setattr(main.channels, "reconcile_wechat_kf_account_operations", provider_reconcile)
    monkeypatch.setattr(
        main,
        "start_wechat_kf_account_recovery",
        lambda reconcile: scheduled.append(reconcile),
    )

    main.on_startup()

    assert scheduled == [provider_reconcile]
    assert provider_calls == 0


def test_startup_failure_stops_wechat_kf_recovery_before_releasing_lock(monkeypatch) -> None:
    """后续 startup 步骤失败时必须先停止恢复线程，再释放 runtime lock。"""
    events: list[str] = []

    monkeypatch.setattr(main, "acquire_runtime_instance_lock", lambda: None)
    monkeypatch.setattr(main, "release_runtime_instance_lock", lambda: events.append("release"))
    monkeypatch.setattr(main, "start_async_jobs", lambda: None)
    monkeypatch.setattr(main, "init_db", lambda: None)
    monkeypatch.setattr(main, "Session", lambda _engine: nullcontext(object()))
    monkeypatch.setattr(main, "seed_demo_data", lambda _db: None)
    monkeypatch.setattr(main, "recover_orphan_harness_runs", lambda _db, startup: None)
    monkeypatch.setattr(main, "recover_codex_a2a_tasks", lambda: None)
    monkeypatch.setattr(main, "recover_a2a_client_tasks", lambda: None)
    monkeypatch.setattr(main, "start_background_worker", lambda: None)
    monkeypatch.setattr(main, "start_channel_services", lambda: None)
    monkeypatch.setattr(main, "start_wechat_kf_account_recovery", lambda reconcile: True)
    monkeypatch.setattr(
        main,
        "stop_wechat_kf_account_recovery",
        lambda *, on_stopped=None: events.append("stop") or True,
    )
    monkeypatch.setattr(
        main,
        "start_timeout_sweeper",
        lambda: (_ for _ in ()).throw(RuntimeError("startup failed")),
    )

    with pytest.raises(RuntimeError, match="startup failed"):
        main.on_startup()

    assert events == ["stop", "release"]


def test_startup_failure_defers_runtime_lock_release_when_recovery_is_still_active(
    monkeypatch,
) -> None:
    """startup 失败但恢复未停稳时，runtime lock 必须由退出回调延迟释放。"""
    events: list[str] = []
    deferred: list[object] = []

    monkeypatch.setattr(main, "acquire_runtime_instance_lock", lambda: None)
    monkeypatch.setattr(main, "release_runtime_instance_lock", lambda: events.append("release"))
    monkeypatch.setattr(main, "start_async_jobs", lambda: None)
    monkeypatch.setattr(main, "init_db", lambda: None)
    monkeypatch.setattr(main, "Session", lambda _engine: nullcontext(object()))
    monkeypatch.setattr(main, "seed_demo_data", lambda _db: None)
    monkeypatch.setattr(main, "recover_orphan_harness_runs", lambda _db, startup: None)
    monkeypatch.setattr(main, "recover_codex_a2a_tasks", lambda: None)
    monkeypatch.setattr(main, "recover_a2a_client_tasks", lambda: None)
    monkeypatch.setattr(main, "start_background_worker", lambda: None)
    monkeypatch.setattr(main, "start_channel_services", lambda: None)
    monkeypatch.setattr(main, "start_wechat_kf_account_recovery", lambda reconcile: True)

    def blocked_stop(*, on_stopped=None):
        events.append("stop")
        deferred.append(on_stopped)
        return False

    monkeypatch.setattr(main, "stop_wechat_kf_account_recovery", blocked_stop)
    monkeypatch.setattr(
        main,
        "start_timeout_sweeper",
        lambda: (_ for _ in ()).throw(RuntimeError("startup failed")),
    )

    with pytest.raises(RuntimeError, match="startup failed"):
        main.on_startup()

    assert events == ["stop"]
    assert callable(deferred[0])
    deferred[0]()
    assert events == ["stop", "release"]


def test_shutdown_stops_wechat_kf_recovery_before_channel_services(monkeypatch) -> None:
    """shutdown 必须先停止账号恢复，避免渠道服务停后仍访问 provider 或数据库。"""
    events: list[str] = []
    for name in (
        "stop_codex_a2a_tasks",
        "stop_codex_subscription_service",
        "stop_public_api_maintenance",
        "stop_background_worker",
        "stop_timeout_sweeper",
        "stop_harness_recovery_sweeper",
        "shutdown_async_jobs",
    ):
        monkeypatch.setattr(main, name, lambda: None)
    monkeypatch.setattr(
        main,
        "stop_wechat_kf_account_recovery",
        lambda *, on_stopped=None: events.append("recovery") or True,
    )
    monkeypatch.setattr(main, "stop_channel_services", lambda: events.append("channels"))
    monkeypatch.setattr(main, "release_runtime_instance_lock", lambda: events.append("release"))

    main.on_shutdown()

    assert events == ["recovery", "channels", "release"]


def test_shutdown_defers_runtime_lock_release_when_recovery_is_still_active(
    monkeypatch,
) -> None:
    """shutdown 超时仍继续本地清理，但 runtime lock 必须等恢复线程退出后再释放。"""
    events: list[str] = []
    deferred: list[object] = []
    for name in (
        "stop_codex_a2a_tasks",
        "stop_codex_subscription_service",
        "stop_public_api_maintenance",
        "stop_background_worker",
        "stop_timeout_sweeper",
        "stop_harness_recovery_sweeper",
        "shutdown_async_jobs",
    ):
        monkeypatch.setattr(main, name, lambda: None)

    def blocked_stop(*, on_stopped=None):
        events.append("recovery")
        deferred.append(on_stopped)
        return False

    monkeypatch.setattr(main, "stop_wechat_kf_account_recovery", blocked_stop)
    monkeypatch.setattr(main, "stop_channel_services", lambda: events.append("channels"))
    monkeypatch.setattr(main, "release_runtime_instance_lock", lambda: events.append("release"))

    main.on_shutdown()

    assert events == ["recovery", "channels"]
    assert callable(deferred[0])
    deferred[0]()
    assert events == ["recovery", "channels", "release"]
