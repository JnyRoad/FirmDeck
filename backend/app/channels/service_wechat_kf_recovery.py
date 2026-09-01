from __future__ import annotations

import logging
import threading
from collections.abc import Callable

logger = logging.getLogger(__name__)

_recovery_lock = threading.Lock()
_recovery_thread: threading.Thread | None = None
_recovery_stop_event: threading.Event | None = None


def start_wechat_kf_account_recovery(reconcile: Callable[..., object]) -> bool:
    """非阻塞启动一次有界恢复；同一进程内已有任务运行时不重复启动。"""
    global _recovery_stop_event, _recovery_thread
    with _recovery_lock:
        if _recovery_thread is not None and _recovery_thread.is_alive():
            return False
        stop_event = threading.Event()
        thread = threading.Thread(
            target=_run_wechat_kf_account_recovery,
            args=(reconcile, stop_event),
            name="wechat-kf-account-recovery",
            daemon=True,
        )
        _recovery_stop_event = stop_event
        _recovery_thread = thread
        thread.start()
        return True


def stop_wechat_kf_account_recovery(
    *,
    timeout_seconds: float = 25.0,
    on_stopped: Callable[[], object] | None = None,
) -> bool:
    """请求停止恢复并有界等待；超时时在线程退出后执行延迟清理。"""
    with _recovery_lock:
        thread = _recovery_thread
        stop_event = _recovery_stop_event
        if thread is None:
            return True
        if stop_event is not None:
            stop_event.set()
    if thread is threading.current_thread():
        return False
    thread.join(timeout=max(0.0, timeout_seconds))
    if not thread.is_alive():
        return True
    if on_stopped is not None:
        threading.Thread(
            target=_run_after_wechat_kf_recovery_stops,
            args=(thread, on_stopped),
            name="wechat-kf-account-recovery-cleanup",
            daemon=True,
        ).start()
    return False


def _run_after_wechat_kf_recovery_stops(
    thread: threading.Thread,
    callback: Callable[[], object],
) -> None:
    """Wait outside the shutdown hook, then release resources retained for recovery safety."""
    thread.join()
    try:
        callback()
    except Exception:  # noqa: BLE001 - deferred shutdown cleanup must not crash the process
        logger.exception("微信客服账号恢复延迟清理失败")


def _run_wechat_kf_account_recovery(
    reconcile: Callable[..., object],
    stop_event: threading.Event,
) -> None:
    global _recovery_stop_event, _recovery_thread
    try:
        reconcile(should_stop=stop_event.is_set)
    except Exception:  # noqa: BLE001 - background boundary must not crash the service
        # Reconciler already persists stable operation errors; keep provider details out of logs.
        logger.warning("微信客服账号后台恢复未完成")
    finally:
        with _recovery_lock:
            if _recovery_thread is threading.current_thread():
                _recovery_thread = None
                _recovery_stop_event = None
