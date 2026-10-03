# Baton Python SDK

Drive [Baton](../README.md), the multi-agent coding daemon, from Python. It is a small,
standard-library-only client for the Baton control protocol (JSON-RPC 2.0 over the project's Unix socket),
the same API the TUI uses.

- Python 3.9 or newer, with no dependencies. Works on macOS and Linux (Unix sockets).
- Import name `baton`, distribution name `batonsh`.

```sh
pip install ./sdk-python        # or just put sdk-python/ on PYTHONPATH
```

## Quick start

```python
import baton

with baton.connect() as client:                 # finds the project, starts `baton daemon` if needed
    run = client.run_state()                    # self-updating view of the run
    seq = run.last_seq
    client.submit("migrate the tests to pytest")   # same as typing it in the TUI
    run.wait_idle(timeout=900, since_seq=seq)      # until every agent is idle again
    for a in run.agents.values():
        print(a.name, a.status, a.diff, "$%.3f" % a.cost, a.last_message)
```

## Connecting

```python
client = baton.connect(
    cwd=None,              # any directory inside the project (default: os.getcwd())
    socket_path=None,      # explicit socket (skips discovery)
    autostart=True,        # launch a detached daemon when nothing answers
    client_name="python",
    daemon_command=None,   # ["baton", "daemon", "--root", "{root}"] or lambda root: [...]
    start_timeout=15.0,
    env=None,              # extra env vars for a started daemon
)
```

`connect()` walks up from `cwd` to the project root (the first directory with `.baton/config.toml`,
otherwise the nearest `.git`). It connects to `.baton/run/baton.sock`, or to the path stored in
`.baton/run/socket-path` for deeply nested projects. Without a running daemon it starts
`baton daemon --root <root>` using `$BATON_BIN` (shell-split, e.g. `BATON_BIN="bun packages/cli/src/main.ts"`)
or `baton` on `PATH`, waits for the socket, and raises `BatonError` if the daemon exits first.
The `hello` handshake is done for you: `client.project_root`, `client.run_id`, `client.daemon_pid`.

## Calls

Each control method has a wrapper. Results are plain dicts with the protocol's camelCase keys.

```python
client.snapshot()                                  # agents, tasks, approvals, totals, autonomy, lastSeq
info = client.spawn("codex", label="review", approval="auto-edit", options={"speed": 0})
client.prompt(info["agentId"], "review the latest diff", delivery="steer")
client.submit("@codex-2 verify codex-1's fix")     # @mentions, /commands, or a task for the orchestrator
client.send("*", "freeze: release in 10 minutes", delivery="interrupt")
client.respond(agent_id, request_id, option_id)    # answer a permission request (None cancels)
client.interrupt(agent_id); client.kill(agent_id)
client.set_autonomy("auto")                        # normal | ask | auto | yolo
client.merge(agent_id); print(client.diff(agent_id))
client.query_events(types=["tool.*"], limit=50)
client.call("runs.list", {"limit": 5})             # anything else, by method name
client.shutdown()                                  # stop the daemon
```

Errors raise `baton.BatonError`, which carries `.code`, `.message` and `.data`. A closed connection
raises `baton.ConnectionClosed`, and a `timeout=` on `call()` raises `baton.BatonTimeoutError`, which
is also a `TimeoutError`.

## Events

Every event is a dict `{id, seq, ts, runId, agentId?, type, data}` (see the BEP table in
[docs/sdk.md](../docs/sdk.md)).

```python
# iterator: subscribes immediately; breaking out of the loop unsubscribes; ends when the connection closes
for e in client.events(types=["tool.*", "bus.message"], from_seq=0):
    print(e["seq"], e["type"], e["data"])

# callback on a worker thread (it may call the client)
def approve_reads(e):
    d = e["data"]
    if d.get("kind") == "read":
        allow = next(o["optionId"] for o in d["options"] if o["kind"] == "allow_once")
        client.respond(e["agentId"], d["requestId"], allow)

sub = client.on_event(approve_reads, types=["permission.requested"])
...
sub.close()
```

`events(timeout=…)` raises `TimeoutError` when nothing arrives for that long. `client.subscribe(handler)`
is the low-level form. Its handler runs on the socket reader thread, so it must be fast and must not
call the client.

## Run state

`client.run_state()` replays the whole run, then follows it live, and gives you:

- `agents`: `{agentId: Agent}`, where each `Agent` has `name adapter status label role model cost usage diff tool_calls turns last_message busy alive`
- `approvals`: `{requestId: Approval}`
- `tasks`, `workspaces`, `bus`, `autonomy`, `mode`, `totals`, `last_seq`
- `wait_for(predicate, timeout)`, `wait_idle(timeout, since_seq=None, settle=0.3)`, `is_idle()`, `find_agent(name_or_id)`

```python
run = client.run_state()
coder = run.wait_for(lambda s: s.find_agent("codex-1"), timeout=30)
run.wait_for(lambda s: not s.approvals and coder.status == "ready", timeout=600)
```

Pass `since_seq=run.last_seq` (captured before you submit work) to `wait_idle` so it does not return
before the work starts. `settle` requires the run to stay quiet for that long, which covers short idle
gaps when agents hand off to each other.

## Examples

- `examples/watch.py` prints a live one-line-per-event feed (`--replay`, `--types 'tool.*'`, `--agent NAME`).
- `examples/run_task.py "task" --approve reads` submits a task, waits until every agent is idle, and prints cost, per-agent changes and the files touched.

## Tests

```sh
python3 -m unittest discover -s sdk-python/tests -v
```

The integration tests start a throwaway daemon with `bun packages/cli/src/main.ts daemon` in a temporary
git repo, using mock agents and temporary `BATON_CONFIG_DIR`/`BATON_STATE_DIR`. They are skipped when `bun`
is not installed.
