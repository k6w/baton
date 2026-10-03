"""Baton control-protocol client: newline-delimited JSON-RPC 2.0 over the daemon's Unix socket."""

import json
import logging
import os
import queue
import shlex
import shutil
import socket
import subprocess
import threading
import time
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterator, List, Optional, Sequence, Union

from ._discovery import discover_socket, find_project_root, project_paths

if TYPE_CHECKING:  # pragma: no cover
    from .run import RunState

__all__ = [
    "CONTROL_PROTOCOL_VERSION",
    "BatonError",
    "BatonTimeoutError",
    "ConnectionClosed",
    "Client",
    "Subscription",
    "connect",
]

#: Must match ``CONTROL_PROTOCOL_VERSION`` in packages/protocol/src/control.ts.
CONTROL_PROTOCOL_VERSION = 1

log = logging.getLogger("baton")

Event = Dict[str, Any]
DaemonCommand = Union[Sequence[str], Callable[[str], Sequence[str]]]

_CLOSED = object()  # queue sentinel


class BatonError(Exception):
    """A JSON-RPC error from the daemon (or a local transport failure)."""

    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def __repr__(self) -> str:
        return "BatonError(code=%r, message=%r)" % (self.code, self.message)


class BatonTimeoutError(BatonError, TimeoutError):
    """A request did not get a response in time."""


class ConnectionClosed(BatonError):
    """The connection to the daemon is closed."""


class InvalidParams(BatonError):
    """Missing or malformed parameters (code -32602)."""


class NotFound(BatonError):
    """No such agent / task / run / request (code -32004)."""


class Unavailable(BatonError):
    """It exists but can't do that now, e.g. the agent isn't running (code -32010)."""


class Conflict(BatonError):
    """Conflicts with the current state: limits, budget, a merge in progress (code -32009)."""


class VersionMismatch(BatonError):
    """This client speaks a newer protocol than the daemon (code -32011)."""


_ERRORS = {-32602: InvalidParams, -32004: NotFound, -32010: Unavailable, -32009: Conflict, -32011: VersionMismatch}


def _error(code: int, message: str, data: Any = None) -> BatonError:
    """The most specific error class for a daemon error code."""
    return _ERRORS.get(code, BatonError)(code, message, data)


class _Pending:
    __slots__ = ("done", "result", "error")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: Any = None
        self.error: Optional[BatonError] = None


def _strip_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


class Subscription:
    """An active ``events.subscribe``. Close it to unsubscribe."""

    def __init__(self, client: "Client", subscription_id: str, last_seq: int):
        self.client = client
        self.id = subscription_id
        #: The daemon's last event seq when the subscription was created.
        self.last_seq = last_seq
        self.closed = False

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.client._unsubscribe(self.id)

    unsubscribe = close

    def __enter__(self) -> "Subscription":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class Client:
    """A connection to a Baton daemon. Create one with :func:`connect` or :meth:`Client.open`.

    All public methods are thread-safe. Responses and events are read on a background thread;
    event callbacks registered with :meth:`on_event` run on their own worker thread, so they may
    call back into the client.
    """

    def __init__(self, sock: socket.socket, client_name: str = "python"):
        self._sock = sock
        self._client_name = client_name
        self._user: Optional[str] = None
        self._write_lock = threading.Lock()
        # guards pending/handlers/early/subscribing and serializes event dispatch
        self._lock = threading.RLock()
        self._pending: Dict[int, _Pending] = {}
        self._next_id = 1
        self._handlers: Dict[str, Callable[[Event], None]] = {}
        self._early: List[Dict[str, Any]] = []
        self._subscribing = 0
        self._close_handlers: List[Callable[[str], None]] = []
        self.closed = False
        self.close_reason: Optional[str] = None
        self.project_root = ""
        self.run_id = ""
        self.daemon_pid = 0
        self.daemon_version = ""
        self.protocol = 0
        self.hello_info: Dict[str, Any] = {}
        self._reader = threading.Thread(target=self._read_loop, name="baton-reader", daemon=True)
        self._reader.start()

    # ── construction ──

    @classmethod
    def open(cls, socket_path: str, client_name: str = "python", timeout: float = 10.0, user: Optional[str] = None) -> "Client":
        """Connect to a daemon socket and perform the ``hello`` handshake.

        ``user`` (optional) names the human behind this client for daemons that show who is watching."""
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(timeout)
            sock.connect(socket_path)
            sock.settimeout(None)
        except BaseException:
            sock.close()
            raise
        c = cls(sock, client_name)
        c._user = user
        try:
            hello = c.call("hello", c._hello_params(), timeout=timeout)
        except BaseException:
            c._shutdown("hello failed")
            raise
        c.hello_info = hello
        c.project_root = hello.get("projectRoot", "")
        c.run_id = hello.get("runId", "")
        c.daemon_pid = hello.get("pid", 0)
        c.daemon_version = hello.get("daemonVersion", "")
        c.protocol = hello.get("protocol", 0)
        return c

    # ── transport ──

    def _read_loop(self) -> None:
        buf = bytearray()
        reason = "socket closed"
        try:
            while True:
                try:
                    chunk = self._sock.recv(65536)
                except OSError:
                    reason = "socket closed" if self.closed else "socket error"
                    break
                if not chunk:
                    break
                buf += chunk
                # split on raw bytes so multibyte UTF-8 sequences split across reads stay intact
                start = 0
                while True:
                    nl = buf.find(b"\n", start)
                    if nl < 0:
                        break
                    line = bytes(buf[start:nl])
                    start = nl + 1
                    if line.strip():
                        try:
                            msg = json.loads(line.decode("utf-8"))
                        except ValueError:
                            log.debug("baton: dropping unparsable line %r", line[:200])
                            continue
                        try:
                            self._handle(msg)
                        except Exception:  # never let a bad message kill the reader
                            log.exception("baton: error handling message")
                if start:
                    del buf[:start]
        finally:
            self._shutdown(self.close_reason or reason)

    def _handle(self, msg: Any) -> None:
        if not isinstance(msg, dict):
            return
        method = msg.get("method")
        if method is not None:
            if msg.get("id") is not None:
                # daemon → client requests are not part of the protocol; reject politely
                self._send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "method not found: %s" % method}})
                return
            params = msg.get("params") or {}
            if method == "event":
                self._dispatch_event(params)
            elif method == "daemon.closing":
                self.close_reason = "daemon closing: %s" % params.get("reason", "")
                self._shutdown(self.close_reason)
            return
        mid = msg.get("id")
        if mid is None:
            return
        with self._lock:
            p = self._pending.pop(mid, None)
        if p is None:
            return
        err = msg.get("error")
        if err is not None:
            p.error = _error(err.get("code", -32603), err.get("message", "error"), err.get("data"))
        else:
            p.result = msg.get("result")
        p.done.set()

    def _dispatch_event(self, params: Dict[str, Any]) -> None:
        sid = params.get("subscriptionId")
        event = params.get("event")
        with self._lock:
            h = self._handlers.get(sid)
            if h is None:
                # raced ahead of events.subscribe's response; anything else is for a closed subscription
                if self._subscribing > 0 and len(self._early) < 100000:
                    self._early.append(params)
                return
            try:
                h(event)
            except Exception:
                log.exception("baton: event handler failed")

    def _send(self, msg: Dict[str, Any]) -> None:
        data = (json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        with self._write_lock:
            if self.closed:
                raise ConnectionClosed(-32099, self.close_reason or "connection closed")
            try:
                self._sock.sendall(data)
            except OSError as e:
                raise ConnectionClosed(-32099, "write failed: %s" % e)

    def _shutdown(self, reason: str) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
            if self.close_reason is None:
                self.close_reason = reason
            pending = list(self._pending.values())
            self._pending.clear()
            handlers = list(self._handlers.values())
            self._handlers.clear()
            close_handlers = list(self._close_handlers)
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass
        for p in pending:
            p.error = ConnectionClosed(-32099, reason)
            p.done.set()
        for h in handlers:
            closer = getattr(h, "_on_close", None)
            if closer:
                closer()
        for ch in close_handlers:
            try:
                ch(reason)
            except Exception:
                log.exception("baton: close handler failed")

    # ── requests ──

    def call(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Any:
        """Send a JSON-RPC request and wait for its result. Raises :class:`BatonError` on errors."""
        if threading.current_thread() is self._reader:
            raise BatonError(-32603, "baton: call() from the reader thread would deadlock; use on_event() callbacks instead")
        with self._lock:
            if self.closed:
                raise ConnectionClosed(-32099, self.close_reason or "connection closed")
            mid = self._next_id
            self._next_id += 1
            p = _Pending()
            self._pending[mid] = p
        try:
            self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params if params is not None else {}})
        except BatonError:
            with self._lock:
                self._pending.pop(mid, None)
            raise
        if not p.done.wait(timeout):
            with self._lock:
                self._pending.pop(mid, None)
            raise BatonTimeoutError(-32000, "timeout: %s" % method)
        if p.error is not None:
            raise p.error
        return p.result

    # ── events ──

    def subscribe(
        self,
        handler: Callable[[Event], None],
        from_seq: Optional[int] = None,
        types: Optional[Sequence[str]] = None,
        agent_id: Optional[str] = None,
    ) -> Subscription:
        """Low-level subscribe. ``handler`` runs on the reader thread: keep it fast and never call
        the client from it (use :meth:`on_event` or :meth:`events` for that).

        With ``from_seq`` the daemon first replays stored events with ``seq >= from_seq``.
        ``types`` accepts patterns such as ``"tool.*"``.
        """
        params = _strip_none({"fromSeq": from_seq, "types": list(types) if types else None, "agentId": agent_id})
        with self._lock:
            self._subscribing += 1
        try:
            res = self.call("events.subscribe", params)
        except BaseException:
            with self._lock:
                self._subscribing -= 1
            raise
        sid = res["subscriptionId"]
        with self._lock:
            self._subscribing -= 1
            if self.closed:
                closer = getattr(handler, "_on_close", None)
                if closer:
                    closer()
            else:
                self._handlers[sid] = handler
                mine = [p for p in self._early if p.get("subscriptionId") == sid]
                self._early = [p for p in self._early if p.get("subscriptionId") != sid]
                for p in mine:
                    try:
                        handler(p.get("event"))
                    except Exception:
                        log.exception("baton: event handler failed")
            if self._subscribing == 0:
                self._early.clear()
        return Subscription(self, sid, res.get("lastSeq", 0))

    def _unsubscribe(self, sid: str) -> None:
        with self._lock:
            h = self._handlers.pop(sid, None)
            closed = self.closed
        if h is not None:
            closer = getattr(h, "_on_close", None)
            if closer:
                closer()
        if not closed and threading.current_thread() is not self._reader:
            try:
                self.call("events.unsubscribe", {"subscriptionId": sid}, timeout=5)
            except BatonError:
                pass

    def events(
        self,
        from_seq: Optional[int] = None,
        types: Optional[Sequence[str]] = None,
        agent_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Iterator[Event]:
        """Iterate over events (dicts: ``id seq ts runId agentId? type data``).

        The subscription starts immediately (not on first ``next()``), so nothing that happens
        after this call is missed. The iterator ends when the connection closes; ``timeout`` raises
        :class:`TimeoutError` when no event arrives for that many seconds. Breaking out of the loop
        (or calling ``.close()`` on the iterator) unsubscribes.
        """
        q: "queue.Queue[Any]" = queue.Queue()

        def handler(e: Event) -> None:
            q.put(e)

        handler._on_close = lambda: q.put(_CLOSED)  # type: ignore[attr-defined]
        sub = self.subscribe(handler, from_seq=from_seq, types=types, agent_id=agent_id)
        return self._iter_queue(q, sub, timeout)

    def _iter_queue(self, q: "queue.Queue[Any]", sub: Subscription, timeout: Optional[float]) -> Iterator[Event]:
        try:
            while True:
                try:
                    item = q.get(timeout=timeout)
                except queue.Empty:
                    raise TimeoutError("no baton event within %ss" % timeout) from None
                if item is _CLOSED:
                    return
                yield item
        finally:
            sub.close()

    def on_event(
        self,
        callback: Callable[[Event], None],
        from_seq: Optional[int] = None,
        types: Optional[Sequence[str]] = None,
        agent_id: Optional[str] = None,
    ) -> Subscription:
        """Call ``callback(event)`` for each event on a dedicated worker thread (in order).

        The callback may call the client (e.g. ``respond`` to a permission request).
        Returns a :class:`Subscription`; close it to stop.
        """
        q: "queue.Queue[Any]" = queue.Queue()

        def handler(e: Event) -> None:
            q.put(e)

        handler._on_close = lambda: q.put(_CLOSED)  # type: ignore[attr-defined]

        def worker() -> None:
            while True:
                item = q.get()
                if item is _CLOSED:
                    return
                try:
                    callback(item)
                except Exception:
                    log.exception("baton: on_event callback failed")

        t = threading.Thread(target=worker, name="baton-events", daemon=True)
        t.start()
        sub = self.subscribe(handler, from_seq=from_seq, types=types, agent_id=agent_id)
        sub.thread = t  # type: ignore[attr-defined]
        return sub

    def on_close(self, handler: Callable[[str], None]) -> Callable[[], None]:
        """Register ``handler(reason)`` for when the connection closes. Returns a remover."""
        with self._lock:
            self._close_handlers.append(handler)

        def off() -> None:
            with self._lock:
                if handler in self._close_handlers:
                    self._close_handlers.remove(handler)

        return off

    def run_state(self) -> "RunState":
        """A :class:`baton.RunState` kept up to date from the event stream (full replay, then live)."""
        from .run import RunState

        return RunState.attach(self)

    # ── convenience wrappers (one per control method) ──

    def _hello_params(self) -> Dict[str, Any]:
        return _strip_none({"client": self._client_name, "version": CONTROL_PROTOCOL_VERSION, "user": self._user})

    def hello(self) -> Dict[str, Any]:
        return self.call("hello", self._hello_params())

    def snapshot(self) -> Dict[str, Any]:
        """``state.snapshot``: agents, tasks, approvals, bus (recent), totals, autonomy, lastSeq."""
        return self.call("state.snapshot", {})

    def query_events(
        self,
        from_seq: Optional[int] = None,
        to_seq: Optional[int] = None,
        types: Optional[Sequence[str]] = None,
        agent_id: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[Event]:
        """``events.query``: stored events of the current run."""
        p = _strip_none({"fromSeq": from_seq, "toSeq": to_seq, "types": list(types) if types else None, "agentId": agent_id, "limit": limit})
        return self.call("events.query", p)["events"]

    def submit(self, text: str) -> Dict[str, Any]:
        """Same as typing in the TUI's main input: ``@name …``, ``/command …``, or a task for the orchestrator."""
        return self.call("input.submit", {"text": text})

    def spawn(self, adapter: str, **kw: Any) -> Dict[str, Any]:
        """``agent.spawn``. Keyword args (snake_case or camelCase): name, model, role, label, prompt, cwd,
        parent_id, approval, options, isolation, task_id, tier. Returns the new agent's info (``agentId`` …)."""
        params = {"adapter": adapter}
        for k, v in kw.items():
            if v is not None:
                params[_camel(k)] = v
        return self.call("agent.spawn", params)

    def prompt(self, agent_id: str, text: str, delivery: Optional[str] = None, from_: Optional[str] = None) -> Dict[str, Any]:
        """``agent.prompt``. ``delivery``: "queue" | "steer" | "interrupt"."""
        return self.call("agent.prompt", _strip_none({"agentId": agent_id, "text": text, "delivery": delivery, "from": from_}))

    def interrupt(self, agent_id: str) -> Dict[str, Any]:
        return self.call("agent.interrupt", {"agentId": agent_id})

    def kill(self, agent_id: str) -> Dict[str, Any]:
        return self.call("agent.kill", {"agentId": agent_id})

    def rename(self, agent_id: str, name: Optional[str] = None, label: Optional[str] = None) -> Dict[str, Any]:
        return self.call("agent.rename", _strip_none({"agentId": agent_id, "name": name, "label": label}))

    def detect_agents(self, refresh: bool = False) -> List[Dict[str, Any]]:
        """``agents.detect``: installed adapters."""
        return self.call("agents.detect", {"refresh": refresh} if refresh else {})["adapters"]

    def respond(self, agent_id: str, request_id: str, option_id: Optional[str]) -> Dict[str, Any]:
        """Answer a ``permission.requested`` (``option_id=None`` cancels)."""
        return self.call("permission.respond", {"agentId": agent_id, "requestId": request_id, "optionId": option_id})

    def send(self, to: str, body: str, from_: Optional[str] = None, kind: Optional[str] = None, delivery: Optional[str] = None) -> Dict[str, Any]:
        """``bus.send``: ``to`` is an agentId/name, ``"*"``, ``"#topic"`` or ``"role:<name>"``."""
        return self.call("bus.send", _strip_none({"to": to, "body": body, "from": from_, "kind": kind, "delivery": delivery}))

    def set_mode(self, mode: str) -> Dict[str, Any]:
        return self.call("run.mode", {"mode": mode})

    def set_autonomy(self, mode: str) -> Dict[str, Any]:
        """``run.autonomy``: "normal" | "ask" | "auto" | "yolo". Returns ``{mode, live, pending}``."""
        return self.call("run.autonomy", {"mode": mode})

    def merge(self, agent_id: str) -> Dict[str, Any]:
        """``workspace.merge``: merge an agent's worktree into the project."""
        return self.call("workspace.merge", {"agentId": agent_id})

    def sync(self, agent_id: str) -> Dict[str, Any]:
        return self.call("workspace.sync", {"agentId": agent_id})

    def diff(self, agent_id: str, paths: Optional[Sequence[str]] = None) -> str:
        """``workspace.diff``: the agent's changes as a unified patch."""
        return self.call("workspace.diff", _strip_none({"agentId": agent_id, "paths": list(paths) if paths else None}))["patch"]

    def review(self, agent_id: str, reviewer: Optional[str] = None) -> Dict[str, Any]:
        return self.call("review.request", _strip_none({"agentId": agent_id, "reviewer": reviewer}))

    def decide_plan(self, approved: bool, notes: Optional[str] = None) -> Dict[str, Any]:
        return self.call("plan.decide", _strip_none({"approved": approved, "notes": notes}))

    def edit_task(self, task_id: str, title: Optional[str] = None, cancel: Optional[bool] = None, **kw: Any) -> Dict[str, Any]:
        """``task.edit``; extra keyword args (snake_case ok) are passed through for newer daemons."""
        params = _strip_none({"taskId": task_id, "title": title, "cancel": cancel})
        params.update({_camel(k): v for k, v in kw.items() if v is not None})
        return self.call("task.edit", params)

    def recipes(self) -> List[Dict[str, Any]]:
        return self.call("recipes.list", {})["recipes"]

    def runs(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        return self.call("runs.list", _strip_none({"limit": limit}))["runs"]

    def export_run(self, run_id: str, format: str = "md") -> str:
        return self.call("run.export", {"runId": run_id, "format": format})["text"]

    def resume_run(self, run_id: str) -> Dict[str, Any]:
        return self.call("run.resume", {"runId": run_id})

    def config(self, key: Optional[str] = None) -> Any:
        return self.call("config.get", _strip_none({"key": key}))["config"]

    def reload_config(self) -> List[str]:
        return self.call("config.reload", {})["errors"]

    def remote_start(self, lan: Optional[bool] = None, port: Optional[int] = None, rotate: Optional[bool] = None) -> Dict[str, Any]:
        return self.call("remote.start", _strip_none({"lan": lan, "port": port, "rotate": rotate}))

    def remote_stop(self) -> Dict[str, Any]:
        return self.call("remote.stop", {})

    def find_agent(self, ref: str) -> Optional[Dict[str, Any]]:
        """Look up an agent (from a fresh snapshot) by id or name (case-insensitive; live agents first)."""
        agents = self.snapshot()["agents"]
        for a in agents:
            if a["agentId"] == ref:
                return a
        low = ref.lower()
        named = [a for a in agents if a["name"].lower() == low]
        named.sort(key=lambda a: a.get("status") == "exited")
        return named[0] if named else None

    def shutdown(self, timeout: Optional[float] = 10.0) -> None:
        """Stop the daemon (``daemon.shutdown``); the connection closes as the daemon exits."""
        try:
            self.call("daemon.shutdown", {}, timeout=timeout)
        except ConnectionClosed:
            pass

    def close(self) -> None:
        """Close the connection (the daemon and its agents keep running)."""
        self._shutdown("client closed")
        if threading.current_thread() is not self._reader:
            self._reader.join(timeout=2)

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __repr__(self) -> str:
        return "<baton.Client root=%r run=%r%s>" % (self.project_root, self.run_id, " closed" if self.closed else "")


# ───────────────────────────── connect ─────────────────────────────


def _try_open(path: str, name: str, user: Optional[str] = None) -> Optional[Client]:
    if not os.path.exists(path):
        return None
    try:
        return Client.open(path, name, timeout=5.0, user=user)
    except (OSError, BatonError):
        return None


def _default_daemon_command(root: str) -> List[str]:
    env_bin = os.environ.get("BATON_BIN")
    if env_bin:
        return shlex.split(env_bin) + ["daemon", "--root", root]
    exe = shutil.which("baton")
    if exe:
        return [exe, "daemon", "--root", root]
    raise BatonError(
        -32001,
        "cannot find the `baton` executable to start a daemon; put it on PATH, set BATON_BIN, or pass daemon_command",
    )


def _daemon_command(spec: Optional[DaemonCommand], root: str) -> List[str]:
    if spec is None:
        return _default_daemon_command(root)
    if callable(spec):
        return list(spec(root))
    return [str(a).replace("{root}", root) for a in spec]


def connect(
    cwd: Optional[str] = None,
    socket_path: Optional[str] = None,
    autostart: bool = True,
    client_name: str = "python",
    daemon_command: Optional[DaemonCommand] = None,
    start_timeout: float = 15.0,
    env: Optional[Dict[str, str]] = None,
    user: Optional[str] = None,
) -> Client:
    """Connect to the project's daemon, starting one if needed.

    :param cwd: any directory inside the project (default: the current directory).
    :param socket_path: explicit socket path (skips discovery).
    :param autostart: launch ``baton daemon --root <root>`` (detached) when nothing answers.
    :param daemon_command: the launch command: a list (``"{root}"`` is substituted) or ``f(root) -> list``.
        Default: ``$BATON_BIN`` (shell-split) or ``baton`` on PATH, plus ``daemon --root <root>``.
    :param start_timeout: seconds to wait for a freshly started daemon.
    :param env: extra environment variables for the started daemon.
    :param user: optional name of the human behind this client (sent in ``hello``).
    """
    root = find_project_root(cwd)
    name = client_name
    existing = _try_open(socket_path or discover_socket(root), name, user)
    if existing:
        return existing
    if not autostart:
        raise BatonError(-32001, "no baton daemon running for %s" % root)
    cmd = _daemon_command(daemon_command, root)
    child_env = dict(os.environ)
    child_env["BATON_DAEMON"] = "1"
    if env:
        child_env.update(env)
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env=child_env,
        )
    except OSError as e:
        raise BatonError(-32001, "could not start the baton daemon (%s): %s" % (" ".join(cmd), e))
    deadline = time.monotonic() + start_timeout
    while time.monotonic() < deadline:
        time.sleep(0.08)
        c = _try_open(socket_path or discover_socket(root), name, user)
        if c:
            _detach(proc)
            return c
        code = proc.poll()
        if code is not None:
            # one last look: another daemon may have won the start race
            time.sleep(0.15)
            late = _try_open(socket_path or discover_socket(root), name, user)
            if late:
                return late
            how = "was killed (signal %d)" % -code if code < 0 else "exited with code %d" % code
            raise BatonError(-32001, "baton daemon %s (see %s)" % (how, project_paths(root)["log"]))
    _detach(proc)
    raise BatonTimeoutError(-32001, "timed out after %ss waiting for the baton daemon to start (see %s)" % (start_timeout, project_paths(root)["log"]))


def _detach(proc: "subprocess.Popen[bytes]") -> None:
    """Let a daemon outlive us without a ResourceWarning; reap it in the background if it exits."""
    threading.Thread(target=proc.wait, name="baton-daemon-reaper", daemon=True).start()

