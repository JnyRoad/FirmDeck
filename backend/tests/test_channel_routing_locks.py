"""验证员工路由锁 registry 的串行语义、等待者引用与确定性清理。"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Self

import app.channels.service_routing_locks as routing_locks


def _registry_size() -> int:
    """在 registry guard 内返回当前 entry 数量；只读进程内测试状态。"""
    with routing_locks._agent_routing_locks_guard:
        return len(routing_locks._agent_routing_locks)


class _ObservedRLock:
    """包装真实 RLock，并在第二次 acquire 尝试时通知测试线程。"""

    def __init__(
        self,
        lock_factory: Callable[[], object],
        second_acquire_attempted: threading.Event,
    ) -> None:
        """创建观察锁；只持有测试事件和真实锁，不启动线程或改变 registry。"""
        self._lock = lock_factory()
        self._attempts = 0
        self._attempts_guard = threading.Lock()
        self._second_acquire_attempted = second_acquire_attempted

    def acquire(self, *args, **kwargs) -> bool:
        """记录 acquire 次数后阻塞取得真实锁；第二个调用者到达时设置事件。"""
        with self._attempts_guard:
            self._attempts += 1
            if self._attempts == 2:
                self._second_acquire_attempted.set()
        return self._lock.acquire(*args, **kwargs)

    def release(self) -> None:
        """释放当前线程持有的真实锁；未持有时由底层 RLock 抛错。"""
        self._lock.release()

    def __enter__(self) -> Self:
        """取得真实锁并返回观察对象，供旧实现的 context-manager 路径使用。"""
        self.acquire()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        """退出 context 时释放真实锁；不吞掉调用方异常。"""
        self.release()


def test_agent_routing_lock_registry_returns_to_baseline_after_unique_and_nested_ids() -> None:
    """大量唯一、空集合及同线程嵌套使用后，registry 必须确定性回到初始大小。"""
    baseline = _registry_size()

    with routing_locks.agent_routing_lifecycle_locks([]):
        pass
    with routing_locks.agent_routing_lifecycle_locks(["", ""]):
        pass
    for index in range(256):
        with routing_locks.agent_routing_lifecycle_locks([f"agent_registry_{index}"]):
            pass
    with (
        routing_locks.agent_routing_lifecycle_locks(["agent_registry_nested"]),
        routing_locks.agent_routing_lifecycle_locks(["agent_registry_nested"]),
    ):
        pass

    assert _registry_size() == baseline


def test_waiting_agent_routing_lock_keeps_same_entry_until_all_threads_exit(monkeypatch) -> None:
    """等待者登记后首个持有者释放时，不得替换锁并允许第三线程并发进入。"""
    baseline = _registry_size()
    first_entered = threading.Event()
    release_first = threading.Event()
    second_acquire_attempted = threading.Event()
    second_entered = threading.Event()
    release_second = threading.Event()
    third_entered = threading.Event()
    real_lock_factory = threading.RLock

    def observed_lock_factory() -> _ObservedRLock:
        """为目标 registry entry 创建带第二 acquire 到达信号的真实可重入锁。"""
        return _ObservedRLock(real_lock_factory, second_acquire_attempted)

    def first_request() -> None:
        """持有共享 agent lock，直到主线程确认第二线程已登记并等待。"""
        with routing_locks.agent_routing_lifecycle_locks(["agent_registry_shared"]):
            first_entered.set()
            assert release_first.wait(timeout=5.0)

    def second_request() -> None:
        """等待同一 agent lock，进入后继续持有以检测 registry 是否被过早替换。"""
        with routing_locks.agent_routing_lifecycle_locks(["agent_registry_shared"]):
            second_entered.set()
            assert release_second.wait(timeout=5.0)

    def third_request() -> None:
        """第二线程持锁期间再次取得同一 ID；若 entry 被替换会错误并发进入。"""
        with routing_locks.agent_routing_lifecycle_locks(["agent_registry_shared"]):
            third_entered.set()

    monkeypatch.setattr(routing_locks.threading, "RLock", observed_lock_factory)
    first = threading.Thread(target=first_request)
    second = threading.Thread(target=second_request)
    third = threading.Thread(target=third_request)

    first.start()
    assert first_entered.wait(timeout=5.0)
    second.start()
    assert second_acquire_attempted.wait(timeout=5.0)
    assert not second_entered.is_set()
    release_first.set()
    assert second_entered.wait(timeout=5.0)

    third.start()
    assert not third_entered.wait(timeout=0.1)
    release_second.set()
    assert third_entered.wait(timeout=5.0)
    first.join(timeout=5.0)
    second.join(timeout=5.0)
    third.join(timeout=5.0)

    assert not first.is_alive()
    assert not second.is_alive()
    assert not third.is_alive()
    assert _registry_size() == baseline


def test_agent_routing_multi_id_reverse_inputs_are_sorted_and_cleaned() -> None:
    """反向多 ID 输入必须按统一顺序串行、无死锁，并在两线程退出后清理 entries。"""
    baseline = _registry_size()
    first_entered = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()
    second_entered = threading.Event()

    def first_request() -> None:
        """以反向输入取得两把锁并暂停，形成确定的首个持有者。"""
        with routing_locks.agent_routing_lifecycle_locks(
            ["agent_registry_multi_b", "agent_registry_multi_a"]
        ):
            first_entered.set()
            assert release_first.wait(timeout=5.0)

    def second_request() -> None:
        """以正向输入请求相同锁集；排序一致时只等待而不会形成锁环。"""
        assert first_entered.wait(timeout=5.0)
        second_started.set()
        with routing_locks.agent_routing_lifecycle_locks(
            ["agent_registry_multi_a", "agent_registry_multi_b"]
        ):
            second_entered.set()

    first = threading.Thread(target=first_request)
    second = threading.Thread(target=second_request)
    first.start()
    second.start()
    assert second_started.wait(timeout=5.0)
    assert not second_entered.wait(timeout=0.1)
    release_first.set()
    first.join(timeout=5.0)
    second.join(timeout=5.0)

    assert not first.is_alive()
    assert not second.is_alive()
    assert second_entered.is_set()
    assert _registry_size() == baseline
