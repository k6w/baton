"""A live, self-updating view of a run (a lighter Python take on the TS ``LiveRun`` / ``RunState``)."""

import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, TypeVar

if TYPE_CHECKING:  # pragma: no cover
    from .client import Client, Subscription

__all__ = ["Agent", "Approval", "Workspace", "RunState", "BUSY_STATUSES"]

#: Agent statuses that mean "still working".
BUSY_STATUSES = frozenset({"starting", "busy", "awaiting_approval"})

T = TypeVar("T")


@dataclass
class Agent:
    agent_id: str
    name: str
    adapter: str
    status: str = "starting"
    status_detail: Optional[str] = None
    label: Optional[str] = None
    role: Optional[str] = None
    model: Optional[str] = None
    cwd: Optional[str] = None
    parent_id: Optional[str] = None
    is_orchestrator: bool = False
    session_id: Optional[str] = None
    started_at: Optional[int] = None
    turn_started_at: Optional[int] = None
    turns: int = 0
    tool_calls: int = 0
    last_activity: Optional[str] = None
    #: Text of the last completed assistant message.
    last_message: Optional[str] = None
    progress: Optional[float] = None
    usage: Dict[str, float] = field(default_factory=lambda: {"input": 0, "cachedInput": 0, "output": 0, "reasoning": 0, "costUsd": 0})
    diff: Dict[str, int] = field(default_factory=lambda: {"added": 0, "removed": 0})
    #: The raw ``agent.spawned`` / ``agent.updated`` info, merged.
    info: Dict[str, Any] = field(default_factory=dict)

    @property
    def cost(self) -> float:
        return float(self.usage.get("costUsd", 0) or 0)

    @property
    def busy(self) -> bool:
        return self.status in BUSY_STATUSES

    @property
    def alive(self) -> bool:
        return self.status != "exited"


@dataclass
class Approval:
    agent_id: str
    request_id: str
    title: str
    options: List[Dict[str, Any]]
    kind: Optional[str] = None
    detail: Optional[str] = None
    ts: Optional[int] = None


@dataclass
class Workspace:
    mode: str
    path: str
    branch: Optional[str] = None
    files: List[Dict[str, Any]] = field(default_factory=list)
    added: int = 0
    removed: int = 0
    merge: Optional[Dict[str, Any]] = None


class RunState:
    """Folds the event stream into agents, approvals, tasks, workspaces, autonomy and totals.

    Create with ``client.run_state()``. Updated from the client's reader thread; read it freely
    (attribute reads are atomic) or hold ``state.lock`` for a consistent multi-field view.
    ``wait_for`` / ``wait_idle`` block until a condition holds.
    """

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self._cond = threading.Condition(self.lock)
        self.run_id = ""
        self.project_root = ""
        self.project_name = ""
        self.branch: Optional[str] = None
        self.mode = "orchestrator"
        self.autonomy = "normal"
        self.orchestrator_id: Optional[str] = None
        self.agents: Dict[str, Agent] = {}
        self.approvals: Dict[str, Approval] = {}
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.workspaces: Dict[str, Workspace] = {}
        self.bus: List[Dict[str, Any]] = []
        self.totals: Dict[str, float] = {"toolCalls": 0, "messages": 0, "added": 0, "removed": 0, "costUsd": 0, "input": 0, "output": 0}
        self.last_seq = 0
        #: seq of the most recent ``turn.started`` (any agent).
        self.last_turn_seq = 0
        #: monotonic time of the last applied event.
        self.last_event_at = 0.0
        self.closed = False
        self._tools: Dict[str, Dict[str, Any]] = {}  # (agent:toolCallId) → {path: (added, removed)}
        self._listeners: List[Callable[[Dict[str, Any]], None]] = []
        self._client: Optional["Client"] = None
        self._sub: Optional["Subscription"] = None
        self._off_close: Optional[Callable[[], None]] = None

    @classmethod
    def attach(cls, client: "Client") -> "RunState":
        """Snapshot metadata, then replay the whole run and follow it live."""
        s = cls()
        snap = client.snapshot()
        s.run_id = snap.get("runId", "")
        s.project_root = snap.get("projectRoot", "")
        s.project_name = snap.get("projectName", "")
        s.branch = snap.get("branch")
        s._client = client
        s._off_close = client.on_close(lambda _r: s._mark_closed())
        s._sub = client.subscribe(s.apply, from_seq=0)
        # replay notifications precede the subscribe response, so the state is caught up here
        with s.lock:
            s.project_name = snap.get("projectName", s.project_name)
            s.branch = snap.get("branch", s.branch)
            if snap.get("autonomy"):
                s.autonomy = snap["autonomy"]
        return s

    def close(self) -> None:
        """Stop following the run."""
        if self._sub:
            self._sub.close()
        if self._off_close:
            self._off_close()
        self._mark_closed()

    def __enter__(self) -> "RunState":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _mark_closed(self) -> None:
        with self._cond:
            self.closed = True
            self._cond.notify_all()

    def on_event(self, listener: Callable[[Dict[str, Any]], None]) -> Callable[[], None]:
        """``listener(event)`` after each applied event. Runs on the reader thread with the lock
        held: keep it fast and don't call the client from it. Returns a remover."""
        with self.lock:
            self._listeners.append(listener)

        def off() -> None:
            with self.lock:
                if listener in self._listeners:
                    self._listeners.remove(listener)

        return off

    # ── queries ──

    def find_agent(self, ref: str) -> Optional[Agent]:
        with self.lock:
            if ref in self.agents:
                return self.agents[ref]
            low = ref.lower()
            named = [a for a in self.agents.values() if a.name.lower() == low]
            named.sort(key=lambda a: not a.alive)
            return named[0] if named else None

    def busy_agents(self) -> List[Agent]:
        with self.lock:
            return [a for a in self.agents.values() if a.busy]

    def workers(self) -> List[Agent]:
        with self.lock:
            return [a for a in self.agents.values() if not a.is_orchestrator and a.alive]

    def is_idle(self) -> bool:
        """No agent is starting, busy or awaiting approval."""
        with self.lock:
            return not any(a.busy for a in self.agents.values())

    # ── waiting ──

    def wait_for(self, predicate: Callable[["RunState"], T], timeout: Optional[float] = None) -> T:
        """Block until ``predicate(state)`` is truthy (re-checked after every event); returns its value.

        Raises :class:`TimeoutError` on timeout and :class:`baton.ConnectionClosed` if the connection closes.
        """
        from .client import ConnectionClosed

        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            while True:
                v = predicate(self)
                if v:
                    return v
                if self.closed:
                    raise ConnectionClosed(-32099, "run state closed (connection lost)")
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise TimeoutError("baton: condition not met within %ss" % timeout)
                self._cond.wait(remaining if remaining is None else min(remaining, 1.0))

    def wait_idle(self, timeout: Optional[float] = None, since_seq: Optional[int] = None, settle: float = 0.3) -> "RunState":
        """Wait until every agent is idle (none starting / busy / awaiting approval).

        :param since_seq: also require that some turn started after this seq — pass ``state.last_seq``
            captured *before* submitting work so this doesn't return before the work begins.
        :param settle: the run must stay idle with no new events for this many seconds (agents often
            hand off to each other, leaving short idle gaps).
        """
        from .client import ConnectionClosed

        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            while True:
                ok = not any(a.busy for a in self.agents.values()) and (since_seq is None or self.last_turn_seq > since_seq)
                now = time.monotonic()
                quiet_for = now - self.last_event_at
                if ok and quiet_for >= settle:
                    return self
                if self.closed:
                    raise ConnectionClosed(-32099, "run state closed (connection lost)")
                remaining = None if deadline is None else deadline - now
                if remaining is not None and remaining <= 0:
                    raise TimeoutError("baton: agents still busy after %ss: %s" % (timeout, ", ".join(a.name for a in self.agents.values() if a.busy) or "(waiting for work to start)"))
                step = (settle - quiet_for) if ok else 1.0
                if remaining is not None:
                    step = min(step, remaining)
                self._cond.wait(max(step, 0.01))

    # ── the fold ──

    def apply(self, e: Dict[str, Any]) -> None:
        with self._cond:
            seq = e.get("seq", 0)
            if seq <= self.last_seq and self.last_seq != 0:
                return
            self.last_seq = seq
            self.last_event_at = time.monotonic()
            if not self.run_id:
                self.run_id = e.get("runId", "")
            try:
                self._apply(e)
            finally:
                for l in list(self._listeners):
                    try:
                        l(e)
                    except Exception:
                        import logging

                        logging.getLogger("baton").exception("baton: RunState listener failed")
                self._cond.notify_all()

    def _apply(self, e: Dict[str, Any]) -> None:
        t = e.get("type")
        d = e.get("data") or {}
        aid = e.get("agentId")
        a = self.agents.get(aid) if aid else None

        if t == "run.started":
            self.project_root = d.get("cwd", self.project_root)
            self.mode = d.get("mode", self.mode)
        elif t == "orch.mode":
            self.mode = d.get("mode", self.mode)
        elif t == "run.autonomy":
            self.autonomy = d.get("mode", self.autonomy)
        elif t == "agent.spawned":
            self.agents[d["agentId"]] = Agent(
                agent_id=d["agentId"],
                name=d.get("name", d["agentId"]),
                adapter=d.get("adapter", ""),
                label=d.get("label"),
                role=d.get("role"),
                model=d.get("model"),
                cwd=d.get("cwd"),
                parent_id=d.get("parentId"),
                is_orchestrator=bool(d.get("isOrchestrator")),
                started_at=e.get("ts"),
                info=dict(d),
            )
            if d.get("isOrchestrator"):
                self.orchestrator_id = d["agentId"]
        elif t == "agent.updated" and a:
            upd = {k: v for k, v in d.items() if v is not None}
            a.info.update(upd)
            for src, dst in (("name", "name"), ("label", "label"), ("role", "role"), ("model", "model"), ("cwd", "cwd"), ("adapter", "adapter")):
                if src in upd:
                    setattr(a, dst, upd[src])
        elif t == "agent.session" and a:
            a.session_id = d.get("sessionId")
        elif t == "agent.status" and a:
            a.status = d.get("status", a.status)
            a.status_detail = d.get("detail")
            if a.status not in ("busy", "awaiting_approval"):
                a.turn_started_at = None
        elif t == "agent.exited":
            if a:
                a.status = "exited"
                a.status_detail = d.get("reason")
                a.turn_started_at = None
            for k in [k for k, p in self.approvals.items() if p.agent_id == aid]:
                del self.approvals[k]
        elif t == "turn.started":
            self.last_turn_seq = e.get("seq", self.last_turn_seq)
            if a:
                a.turn_started_at = e.get("ts")
                a.status = "busy"
                a.turns += 1
        elif t in ("turn.completed", "turn.interrupted"):
            if a:
                a.turn_started_at = None
        elif t == "message.delta":
            if a and d.get("role") != "user":
                a.last_activity = "writing"
        elif t == "message.completed":
            if d.get("role") == "assistant":
                self.totals["messages"] += 1
                if a:
                    a.last_message = d.get("text")
        elif t == "tool.call":
            key = "%s:%s" % (aid, d.get("toolCallId"))
            if aid and key not in self._tools:
                self._tools[key] = {}
                self.totals["toolCalls"] += 1
                if a:
                    a.tool_calls += 1
                    a.last_activity = d.get("title")
        elif t == "tool.update":
            diffs = self._tools.get("%s:%s" % (aid, d.get("toolCallId")))
            if diffs is not None:
                for c in d.get("content") or []:
                    if c.get("type") != "diff":
                        continue
                    lines = c.get("lines") or []
                    added = c.get("added")
                    removed = c.get("removed")
                    if added is None:
                        added = sum(1 for l in lines if l.get("kind") == "add")
                    if removed is None:
                        removed = sum(1 for l in lines if l.get("kind") == "del")
                    old_a, old_r = diffs.get(c.get("path"), (0, 0))
                    diffs[c.get("path")] = (added, removed)
                    self.totals["added"] += added - old_a
                    self.totals["removed"] += removed - old_r
                    if a:
                        a.diff["added"] += added - old_a
                        a.diff["removed"] += removed - old_r
        elif t == "plan.updated" and a:
            entries = d.get("entries") or []
            done = sum(1 for x in entries if x.get("status") == "completed")
            a.progress = done / len(entries) if entries else None
        elif t == "usage.updated" and a:
            u = a.usage
            before = dict(u)
            if d.get("mode") == "delta":
                for k in ("input", "cachedInput", "output", "reasoning"):
                    u[k] = u.get(k, 0) + (d.get(k) or 0)
                u["costUsd"] = u.get("costUsd", 0) + (d.get("costUsd") or 0)
            else:
                for k in ("input", "cachedInput", "output", "reasoning"):
                    u[k] = d.get(k) or 0
                if d.get("costUsd") is not None:
                    u["costUsd"] = d["costUsd"]
            self.totals["input"] += u["input"] - before["input"]
            self.totals["output"] += u["output"] - before["output"]
            self.totals["costUsd"] += u["costUsd"] - before["costUsd"]
        elif t == "permission.requested" and aid:
            self.approvals[d["requestId"]] = Approval(
                agent_id=aid,
                request_id=d["requestId"],
                title=d.get("title", ""),
                options=d.get("options") or [],
                kind=d.get("kind"),
                detail=d.get("detail"),
                ts=e.get("ts"),
            )
        elif t == "permission.resolved":
            self.approvals.pop(d.get("requestId"), None)
        elif t == "bus.message":
            self.bus.append({"ts": e.get("ts"), **d})
            if len(self.bus) > 1000:
                del self.bus[: len(self.bus) - 1000]
        elif t == "task.created":
            self.tasks[d["taskId"]] = {
                "taskId": d["taskId"],
                "title": d.get("title", ""),
                "state": "submitted",
                "owner": d.get("owner"),
                "deps": d.get("deps") or [],
                "note": d.get("description"),
            }
        elif t == "task.state":
            task = self.tasks.get(d.get("taskId"))
            if task:
                task["state"] = d.get("state", task["state"])
                if d.get("owner"):
                    task["owner"] = d["owner"]
                if d.get("note"):
                    task["note"] = d["note"]
        elif t == "task.updated":
            task = self.tasks.get(d.get("taskId"))
            if task:
                if d.get("title"):
                    task["title"] = d["title"]
                if d.get("description"):
                    task["note"] = d["description"]
        elif t == "workspace.created" and aid:
            self.workspaces[aid] = Workspace(mode=d.get("mode", "shared"), path=d.get("path", ""), branch=d.get("branch"))
            if a:
                a.cwd = d.get("path", a.cwd)
        elif t == "workspace.changed" and aid in self.workspaces:
            w = self.workspaces[aid]
            w.files = d.get("files") or []
            w.added = d.get("added", 0)
            w.removed = d.get("removed", 0)
            if w.merge and w.merge.get("status") == "merged" and w.files:
                w.merge = None
        elif t == "workspace.merge" and aid in self.workspaces:
            self.workspaces[aid].merge = {"ts": e.get("ts"), **d}
        elif t == "workspace.removed" and aid:
            self.workspaces.pop(aid, None)

    def __repr__(self) -> str:
        with self.lock:
            agents = ", ".join("%s:%s" % (a.name, a.status) for a in self.agents.values())
        return "<baton.RunState seq=%d autonomy=%s agents=[%s]>" % (self.last_seq, self.autonomy, agents)
