"""提供员工路由写入的进程内生命周期锁，串行化员工删除与渠道挂载变更。

全局锁序固定为：先取得按 binding ID 排序的全部 binding lifecycle locks，再取得按
agent ID 排序的全部 agent routing lifecycle locks。仅创建新 binding 的入口没有既存
binding ID，因此只取得 agent locks；任何入口都不得在持有 agent lock 后追加 binding lock。
"""

from __future__ import annotations

import threading
from collections.abc import Iterable, Iterator
from contextlib import ExitStack, contextmanager

_agent_routing_locks: dict[str, threading.RLock] = {}
_agent_routing_locks_guard = threading.Lock()


@contextmanager
def agent_routing_lifecycle_locks(agent_ids: Iterable[str]) -> Iterator[None]:
    """按 ID 串行取得员工路由锁，并在调用方退出时逆序释放。

    输入可包含重复或空 ID，空值会忽略且其余 ID 确定性排序。函数只改变进程内锁注册表和
    当前线程的锁持有状态，不写数据库；等待可阻塞，调用方异常会原样传播并可靠释放已取得锁。
    """
    ordered_agent_ids = tuple(sorted({agent_id for agent_id in agent_ids if agent_id}))
    with _agent_routing_locks_guard:
        ordered_locks = [
            _agent_routing_locks.setdefault(agent_id, threading.RLock())
            for agent_id in ordered_agent_ids
        ]
    with ExitStack() as locks:
        for lock in ordered_locks:
            locks.enter_context(lock)
        yield
