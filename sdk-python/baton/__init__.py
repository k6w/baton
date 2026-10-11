"""Python SDK for Baton — drive the multi-agent daemon (batond) from scripts.

    import baton

    with baton.connect() as client:          # starts the project daemon if needed
        run = client.run_state()
        seq = run.last_seq
        client.submit("fix the flaky test in tests/api")
        run.wait_idle(timeout=600, since_seq=seq)
        for a in run.agents.values():
            print(a.name, a.status, a.diff, "$%.2f" % a.cost)
"""

from ._discovery import discover_socket, find_project_root, project_paths
from .client import (
    CONTROL_PROTOCOL_VERSION,
    BatonError,
    BatonTimeoutError,
    Client,
    Conflict,
    ConnectionClosed,
    InvalidParams,
    NotFound,
    Subscription,
    Unavailable,
    VersionMismatch,
    connect,
)
from .run import BUSY_STATUSES, Agent, Approval, RunState, Workspace

__version__ = "0.3.6"

__all__ = [
    "CONTROL_PROTOCOL_VERSION",
    "BUSY_STATUSES",
    "Agent",
    "Approval",
    "BatonError",
    "BatonTimeoutError",
    "Client",
    "ConnectionClosed",
    "Conflict",
    "InvalidParams",
    "NotFound",
    "Unavailable",
    "VersionMismatch",
    "RunState",
    "Subscription",
    "Workspace",
    "connect",
    "discover_socket",
    "find_project_root",
    "project_paths",
]
