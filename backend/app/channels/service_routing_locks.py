"""提供员工路由写入的进程内生命周期锁，串行化员工删除与渠道挂载变更。

全局锁序固定为：先取得按 binding ID 排序的全部 binding lifecycle locks，再取得按
agent ID 排序的全部 agent routing lifecycle locks。仅创建新 binding 的入口没有既存
binding ID，因此只取得 agent locks；任何入口都不得在持有 agent lock 后追加 binding lock。
"""

from __future__ import annotations

import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager


class _AgentRoutingLockEntry:
    """保存一个可重入员工路由锁及其已持有或正在等待的 context 引用数。"""

    __slots__ = ("lock", "refs")

    def __init__(self) -> None:
        """创建未被引用的新 entry；只分配进程内 RLock，不取得锁或产生持久化副作用。"""
        self.lock = threading.RLock()
        self.refs = 0


_agent_routing_locks: dict[str, _AgentRoutingLockEntry] = {}
_agent_routing_locks_guard = threading.Lock()


@contextmanager
def agent_routing_lifecycle_locks(agent_ids: Iterable[str]) -> Iterator[None]:
    """按 ID 串行取得员工路由锁，并在调用方退出时逆序释放。

    输入可包含重复或空 ID，空值会忽略且其余 ID 确定性排序。函数只改变进程内锁注册表和
    当前线程的锁持有状态，不写数据库；refs 同时覆盖持有者与等待者。等待可阻塞，调用方或
    acquire 异常会原样传播，并在清理引用前逆序释放所有已取得锁。
    """
    ordered_agent_ids = tuple(sorted({agent_id for agent_id in agent_ids if agent_id}))
    reserved_entries: list[tuple[str, _AgentRoutingLockEntry]] = []

    # 先在 registry guard 内固定全部 entry 并预留等待者引用，防止等待期间锁对象被替换。
    with _agent_routing_locks_guard:
        for agent_id in ordered_agent_ids:
            entry = _agent_routing_locks.get(agent_id)
            if entry is None:
                entry = _AgentRoutingLockEntry()
                _agent_routing_locks[agent_id] = entry
            entry.refs += 1
            reserved_entries.append((agent_id, entry))

    acquired_entries: list[_AgentRoutingLockEntry] = []
    try:
        # 再在 registry guard 外按 ID 顺序阻塞取锁，避免 registry 操作被慢等待串行化。
        for _agent_id, entry in reserved_entries:
            entry.lock.acquire()
            acquired_entries.append(entry)
        yield
    finally:
        # 先逆序释放实际取得的锁；即使后续 acquire 中断，也不会遗留此前已持有的锁。
        for entry in reversed(acquired_entries):
            entry.lock.release()

        # 最后归还全部预留引用；只有无人持有或等待且对象仍相同时才删除 registry entry。
        with _agent_routing_locks_guard:
            for agent_id, entry in reserved_entries:
                entry.refs -= 1
                if entry.refs == 0 and _agent_routing_locks.get(agent_id) is entry:
                    del _agent_routing_locks[agent_id]
