"""Tests for the Baton Python SDK.

Most tests run against a real, throwaway daemon started with
``bun packages/cli/src/main.ts daemon --root <tmp>`` (mock agents, no network).

    python3 -m unittest discover -s sdk-python/tests -v
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SDK_ROOT = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(SDK_ROOT)
sys.path.insert(0, SDK_ROOT)

import baton  # noqa: E402
from baton import BatonError, ConnectionClosed  # noqa: E402

MAIN_TS = os.path.join(REPO_ROOT, "packages", "cli", "src", "main.ts")
BUN = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")

PROJECT_CONFIG = """[orchestrator]
agent = "mock"
[bus]
heartbeat_s = 0
[workspace]
isolation = "shared"
"""


def make_project(base: str, name: str) -> str:
    root = os.path.join(base, name)
    os.makedirs(os.path.join(root, ".baton"))
    subprocess.run(["git", "init", "-q", root], check=True)
    with open(os.path.join(root, ".baton", "config.toml"), "w") as f:
        f.write(PROJECT_CONFIG)
    return root


def daemon_env(base: str) -> dict:
    env = dict(os.environ)
    env["BATON_CONFIG_DIR"] = os.path.join(base, "config")
    env["BATON_STATE_DIR"] = os.path.join(base, "state")
    os.makedirs(env["BATON_CONFIG_DIR"], exist_ok=True)
    os.makedirs(env["BATON_STATE_DIR"], exist_ok=True)
    return env


def stop_process(proc: "subprocess.Popen", timeout: float = 10.0) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except OSError:
            pass
        try:
            proc.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            continue


def kill_pid(pid: int) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except OSError:
            return
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except OSError:
                return
            time.sleep(0.1)


def kill_from_pidfile(root: str) -> None:
    """Stop a daemon we may not have a handle for (e.g. autostart failed half-way)."""
    try:
        with open(baton.project_paths(root)["pid_file"]) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return
    kill_pid(pid)


def allow_once(event: dict):
    return next((o["optionId"] for o in event["data"]["options"] if o["kind"] == "allow_once"), None)


# ───────────────────────────── unit tests (no daemon) ─────────────────────────────


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="baton-py-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_project_root_prefers_baton_config_over_git(self):
        outer = os.path.join(self.tmp, "outer")
        inner = os.path.join(outer, "pkg", "src")
        os.makedirs(inner)
        os.makedirs(os.path.join(outer, ".git"))
        self.assertEqual(baton.find_project_root(inner), outer)
        os.makedirs(os.path.join(outer, "pkg", ".baton"))
        # a .baton dir without config.toml doesn't count
        self.assertEqual(baton.find_project_root(inner), outer)
        open(os.path.join(outer, "pkg", ".baton", "config.toml"), "w").close()
        self.assertEqual(baton.find_project_root(inner), os.path.join(outer, "pkg"))

    def test_project_root_falls_back_to_start(self):
        d = os.path.join(self.tmp, "loose")
        os.makedirs(d)
        root = baton.find_project_root(d)
        # unless some ancestor of the temp dir is itself a repo
        self.assertTrue(root == d or d.startswith(root))

    def test_socket_path_override(self):
        run = os.path.join(self.tmp, ".baton", "run")
        os.makedirs(run)
        self.assertEqual(baton.discover_socket(self.tmp), os.path.join(run, "baton.sock"))
        with open(os.path.join(run, "socket-path"), "w") as f:
            f.write("/tmp/baton-abc.sock\n")
        self.assertEqual(baton.discover_socket(self.tmp), "/tmp/baton-abc.sock")


class FakeDaemon:
    """A tiny scripted server to exercise framing without bun."""

    def __init__(self, path: str, script):
        self.path = path
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(path)
        self.srv.listen(1)
        self.received = []
        self.thread = threading.Thread(target=self._serve, args=(script,), daemon=True)
        self.thread.start()

    def _serve(self, script):
        conn, _ = self.srv.accept()
        f = conn.makefile("rb")
        try:
            script(conn, f, self.received)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def close(self):
        self.srv.close()


class FramingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bp-", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.sock_path = os.path.join(self.tmp, "s.sock")

    def test_split_utf8_and_coalesced_messages(self):
        text = "héllo ✓ 漢字 🎉"

        def script(conn, f, received):
            hello = json.loads(f.readline())
            received.append(hello)
            reply = {"jsonrpc": "2.0", "id": hello["id"], "result": {"daemonVersion": "x", "protocol": 1, "runId": "r", "projectRoot": "/p", "pid": 1}}
            data = (json.dumps(reply) + "\n").encode()
            for i in range(len(data)):  # one byte at a time
                conn.sendall(data[i : i + 1])
                if i % 7 == 0:
                    time.sleep(0.001)
            req = json.loads(f.readline())
            received.append(req)
            sub = {"jsonrpc": "2.0", "id": req["id"], "result": {"subscriptionId": "s1", "lastSeq": 0}}
            # replay events arrive *before* the subscribe response (as with the real daemon)
            evs = [
                {"jsonrpc": "2.0", "method": "event", "params": {"subscriptionId": "s1", "event": {"seq": i, "type": "log", "data": {"message": text}}}}
                for i in (1, 2)
            ]
            blob = b"".join((json.dumps(m, ensure_ascii=False) + "\n").encode("utf-8") for m in evs + [sub])
            blob += b"not json\n\n[1,2]\n"
            # split inside a multibyte character
            cut = blob.index("✓".encode()) + 1
            conn.sendall(blob[:cut])
            time.sleep(0.05)
            conn.sendall(blob[cut:])
            req = json.loads(f.readline())  # caller asks something that fails
            conn.sendall((json.dumps({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32000, "message": "nope ✗", "data": {"k": 1}}}) + "\n").encode())
            ev3 = {"jsonrpc": "2.0", "method": "event", "params": {"subscriptionId": "s1", "event": {"seq": 3, "type": "log", "data": {"message": "x"}}}}
            closing = {"jsonrpc": "2.0", "method": "daemon.closing", "params": {"reason": "shutdown"}}
            conn.sendall((json.dumps(ev3) + "\n" + json.dumps(closing) + "\n").encode())
            time.sleep(0.2)

        srv = FakeDaemon(self.sock_path, script)
        self.addCleanup(srv.close)
        c = baton.Client.open(self.sock_path, "test")
        self.addCleanup(c.close)
        self.assertEqual(c.run_id, "r")
        self.assertEqual(srv.received[0]["params"], {"client": "test", "version": baton.CONTROL_PROTOCOL_VERSION})
        it = c.events(from_seq=0, timeout=5)
        self.assertEqual(srv.received[1]["params"], {"fromSeq": 0})
        first = next(it)
        self.assertEqual((first["seq"], first["data"]["message"]), (1, text))
        self.assertEqual(next(it)["seq"], 2)
        with self.assertRaises(BatonError) as cm:
            c.call("boom", timeout=5)
        self.assertEqual((cm.exception.code, cm.exception.message, cm.exception.data), (-32000, "nope ✗", {"k": 1}))
        self.assertEqual(next(it)["seq"], 3)
        # daemon.closing ends the stream and closes the client
        self.assertEqual(list(it), [])
        self.assertTrue(c.closed)
        self.assertIn("shutdown", c.close_reason)
        with self.assertRaises(ConnectionClosed):
            c.snapshot()

    def test_call_timeout(self):
        def script(conn, f, received):
            hello = json.loads(f.readline())
            conn.sendall((json.dumps({"jsonrpc": "2.0", "id": hello["id"], "result": {"runId": "r"}}) + "\n").encode())
            f.readline()  # never answer
            time.sleep(1)

        srv = FakeDaemon(self.sock_path, script)
        self.addCleanup(srv.close)
        with baton.Client.open(self.sock_path) as c:
            with self.assertRaises(baton.BatonTimeoutError):
                c.call("state.snapshot", timeout=0.2)
            with self.assertRaises(TimeoutError):  # also a builtin TimeoutError
                c.call("state.snapshot", timeout=0.1)


class AutostartFailureTests(unittest.TestCase):
    def test_reports_daemon_exit(self):
        tmp = tempfile.mkdtemp(prefix="baton-py-")
        self.addCleanup(shutil.rmtree, tmp, True)
        root = make_project(tmp, "proj")
        with self.assertRaises(BatonError) as cm:
            baton.connect(cwd=root, daemon_command=[sys.executable, "-c", "import sys; sys.exit(3)"], start_timeout=10)
        self.assertIn("exited with code 3", str(cm.exception))
        with self.assertRaises(BatonError) as cm:
            baton.connect(cwd=root, autostart=False)
        self.assertIn("no baton daemon", str(cm.exception))


# ───────────────────────────── against a real daemon ─────────────────────────────


@unittest.skipUnless(BUN and os.path.exists(BUN), "bun is required for daemon tests")
class DaemonTests(unittest.TestCase):
    """Ordered integration tests sharing one ephemeral daemon (test_NN_ names run in order)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="baton-py-")
        cls.addClassCleanup(shutil.rmtree, cls.tmp, True)
        cls.root = make_project(cls.tmp, "proj")
        cls.env = daemon_env(cls.tmp)
        cls.log_path = os.path.join(cls.tmp, "daemon.out")
        cls.log = open(cls.log_path, "wb")
        cls.addClassCleanup(cls.log.close)
        cls.proc = subprocess.Popen(
            [BUN, MAIN_TS, "daemon", "--root", cls.root],
            cwd=cls.root,
            env=cls.env,
            stdin=subprocess.DEVNULL,
            stdout=cls.log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        # registered before anything can fail: the daemon is always stopped
        cls.addClassCleanup(stop_process, cls.proc, 0.5)
        deadline = time.monotonic() + 20
        cls.client = None
        while time.monotonic() < deadline:
            if cls.proc.poll() is not None:
                raise RuntimeError("daemon exited with %s:\n%s" % (cls.proc.returncode, cls._daemon_output()))
            try:
                cls.client = baton.connect(cwd=cls.root, autostart=False, client_name="py-test")
                break
            except BatonError:
                time.sleep(0.1)
        if cls.client is None:
            raise RuntimeError("daemon did not come up:\n%s" % cls._daemon_output())
        cls.addClassCleanup(cls.client.close)

    @classmethod
    def _daemon_output(cls) -> str:
        try:
            with open(cls.log_path, "rb") as f:
                return f.read().decode("utf-8", "replace")[-4000:]
        except OSError:
            return ""

    def spawn_mock(self, **kw):
        info = self.client.spawn("mock", options={"speed": 0}, **kw)
        self.assertTrue(info["agentId"])
        return info

    def test_01_hello_and_snapshot(self):
        c = self.client
        self.assertEqual(os.path.realpath(c.project_root), os.path.realpath(self.root))
        self.assertEqual(c.protocol, baton.CONTROL_PROTOCOL_VERSION)
        self.assertEqual(c.daemon_pid, self.proc.pid)
        self.assertTrue(c.run_id)
        hello = c.hello()
        self.assertEqual(hello["runId"], c.run_id)
        snap = c.snapshot()
        for key in ("runId", "agents", "approvals", "tasks", "totals", "lastSeq"):
            self.assertIn(key, snap)
        self.assertEqual(snap["runId"], c.run_id)

    def test_02_spawn_prompt_events(self):
        c = self.client
        info = self.spawn_mock(label="py test")
        self.assertEqual(info["adapter"], "mock")
        prompt = "hi there ✓ ünïcödé 漢字"
        stream = c.events(agent_id=info["agentId"], timeout=20)  # subscribed before prompting
        self.assertEqual(c.prompt(info["agentId"], prompt), {"ok": True})
        seen = []
        started_prompt = None
        try:
            for e in stream:
                seen.append(e["type"])
                self.assertEqual(e["agentId"], info["agentId"])
                if e["type"] == "turn.started":
                    started_prompt = e["data"].get("prompt")
                elif e["type"] == "permission.requested":
                    c.respond(info["agentId"], e["data"]["requestId"], allow_once(e))
                elif e["type"] == "turn.completed":
                    break
        finally:
            stream.close()
        self.assertEqual(started_prompt, prompt)
        for t in ("turn.started", "tool.call", "message.completed", "turn.completed"):
            self.assertIn(t, seen)
        # stored events can be queried too
        evs = c.query_events(agent_id=info["agentId"], types=["turn.*"])
        self.assertTrue(evs)
        self.assertTrue(all(e["type"].startswith("turn.") for e in evs))

    def test_03_submit_mention_with_threaded_approver(self):
        c = self.client
        info = self.spawn_mock()
        done = threading.Event()
        responded = []

        def on_event(e):
            # runs on the SDK's worker thread, so calling back into the client is fine
            if e["type"] == "permission.requested":
                c.respond(e["agentId"], e["data"]["requestId"], allow_once(e))
                responded.append(e["data"]["requestId"])
            elif e["type"] == "turn.completed":
                done.set()

        sub = c.on_event(on_event, agent_id=info["agentId"])
        try:
            res = c.submit("@%s hi" % info["name"])
            self.assertEqual(res["routedTo"], [info["name"]])
            self.assertTrue(done.wait(30), "agent never completed its turn")
        finally:
            sub.close()
        self.assertTrue(responded)
        with self.assertRaises(BatonError):
            c.submit("@no-such-agent hi")

    def test_04_set_autonomy_roundtrip(self):
        c = self.client
        run = c.run_state()
        self.addCleanup(run.close)
        res = c.set_autonomy("auto")
        self.assertEqual(res["mode"], "auto")
        self.assertIsInstance(res["live"], list)
        self.assertEqual(c.snapshot()["autonomy"], "auto")
        run.wait_for(lambda s: s.autonomy == "auto", timeout=5)
        self.assertEqual(c.set_autonomy("normal")["mode"], "normal")
        run.wait_for(lambda s: s.autonomy == "normal", timeout=5)
        self.assertEqual(c.snapshot()["autonomy"], "normal")

    def test_05_run_state_wait_idle(self):
        c = self.client
        with c.run_state() as run:
            # the replay already contains the agents from earlier tests
            self.assertGreaterEqual(len([a for a in run.agents.values() if a.adapter == "mock"]), 2)
            info = self.spawn_mock(label="idle check")
            agent = run.wait_for(lambda s: s.agents.get(info["agentId"]), timeout=10)
            self.assertEqual(agent.label, "idle check")
            sub = c.on_event(lambda e: c.respond(e["agentId"], e["data"]["requestId"], allow_once(e)), types=["permission.requested"])
            self.addCleanup(sub.close)
            seq = run.last_seq
            c.prompt(info["agentId"], "do the thing")
            run.wait_idle(timeout=30, since_seq=seq)
            self.assertTrue(run.is_idle())
            self.assertEqual(agent.status, "ready")
            self.assertGreaterEqual(agent.turns, 1)
            self.assertGreater(agent.tool_calls, 0)
            self.assertGreater(agent.cost, 0)
            self.assertTrue(agent.last_message)
            self.assertFalse(run.approvals)
            self.assertGreater(run.totals["toolCalls"], 0)
            self.assertAlmostEqual(run.totals["costUsd"], c.snapshot()["totals"]["costUsd"], places=6)
            # the fold agrees with the daemon's snapshot
            snap_agents = {a["agentId"]: a for a in c.snapshot()["agents"]}
            self.assertEqual(snap_agents[info["agentId"]]["toolCalls"], agent.tool_calls)
            self.assertEqual(run.find_agent(info["name"]), agent)
            with self.assertRaises(TimeoutError):
                run.wait_for(lambda s: False, timeout=0.2)

    def test_06_errors(self):
        c = self.client
        with self.assertRaises(BatonError) as cm:
            c.call("no.such.method")
        self.assertEqual(cm.exception.code, -32601)
        with self.assertRaises(baton.Unavailable) as cm:
            c.prompt("ag_does_not_exist", "hello")
        self.assertEqual(cm.exception.code, -32010)
        self.assertIn("not running", cm.exception.message)
        with self.assertRaises(baton.InvalidParams):
            c.call("agent.prompt", {"agentId": "x"})
        # kill / interrupt of an unknown agent are errors, not silent no-ops
        for fn in (c.kill, c.interrupt):
            with self.assertRaises(baton.NotFound) as cm:
                fn("ag_does_not_exist")
            self.assertIn("no agent", cm.exception.message)

    def test_07_close_cleanly(self):
        other = baton.connect(cwd=self.root, autostart=False, client_name="py-test-2")
        stream = other.events(timeout=10)
        closed_reasons = []
        other.on_close(closed_reasons.append)
        threading.Timer(0.2, other.close).start()
        self.assertEqual(list(stream), [])  # the stream ends instead of hanging
        self.assertTrue(other.closed)
        self.assertEqual(closed_reasons, ["client closed"])
        with self.assertRaises(ConnectionClosed):
            other.snapshot()
        other._reader.join(2)
        self.assertFalse(other._reader.is_alive())
        # the shared client is unaffected
        self.assertTrue(self.client.snapshot()["runId"])

    def test_99_shutdown(self):
        c = self.client
        c.shutdown()
        self.proc.wait(timeout=15)
        deadline = time.monotonic() + 5
        while not c.closed and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(c.closed)


@unittest.skipUnless(BUN and os.path.exists(BUN), "bun is required for daemon tests")
class AutostartTests(unittest.TestCase):
    def test_autostart_and_reconnect(self):
        tmp = tempfile.mkdtemp(prefix="baton-py-")
        self.addCleanup(shutil.rmtree, tmp, True)
        root = make_project(tmp, "proj")
        self.addCleanup(kill_from_pidfile, root)  # runs before rmtree: never leak the daemon
        env = daemon_env(tmp)
        sub = os.path.join(root, "src", "deep")
        os.makedirs(sub)
        c = baton.connect(cwd=sub, daemon_command=lambda r: [BUN, MAIN_TS, "daemon", "--root", r], env=env)
        pid = c.daemon_pid
        self.addCleanup(kill_pid, pid)  # always stop the daemon, even on failure
        self.addCleanup(c.close)
        self.assertEqual(os.path.realpath(c.project_root), os.path.realpath(root))
        # a second connect finds the running daemon instead of starting another
        with baton.connect(cwd=root, autostart=False) as c2:
            self.assertEqual(c2.daemon_pid, pid)
        c.shutdown()


if __name__ == "__main__":
    unittest.main()
