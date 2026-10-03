#!/usr/bin/env python3
"""Submit a task to the orchestrator, wait until every agent is idle, then report what changed.

    python3 examples/run_task.py "fix the flaky retry test" --approve reads --timeout 900

--approve: none (leave approvals to the TUI), reads (auto-allow read-only tools), all (allow everything).
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import baton  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("task")
    ap.add_argument("--cwd", default=None)
    ap.add_argument("--approve", choices=["none", "reads", "all"], default="none")
    ap.add_argument("--timeout", type=float, default=1800)
    ap.add_argument("--patch", action="store_true", help="print each agent's full patch")
    args = ap.parse_args()

    with baton.connect(cwd=args.cwd, client_name="run_task.py") as client:
        run = client.run_state()

        def approver(e):
            d = e["data"]
            if args.approve == "all" or (args.approve == "reads" and d.get("kind") in ("read", "search", "think", "fetch")):
                opt = next((o["optionId"] for o in d["options"] if o["kind"] == "allow_once"), None)
                if opt:
                    client.respond(e["agentId"], d["requestId"], opt)
                    return
            print("  ! approval needed: %s (answer it in the TUI)" % d.get("title"), file=sys.stderr)

        def progress(e):
            a = run.agents.get(e.get("agentId") or "")
            name = a.name if a else "baton"
            if e["type"] == "tool.call":
                print("  %-14s %s" % (name[:14], e["data"]["title"]), file=sys.stderr)
            elif e["type"] == "agent.spawned":
                print("  + %s (%s)" % (e["data"]["name"], e["data"]["adapter"]), file=sys.stderr)

        approvals = client.on_event(approver, types=["permission.requested"])
        feed = client.on_event(progress, types=["tool.call", "agent.spawned"])
        before = {aid: dict(a.diff) for aid, a in run.agents.items()}
        seq = run.last_seq
        res = client.submit(args.task)
        print("→ routed to %s" % ", ".join(res.get("routedTo") or ["(nobody)"]), file=sys.stderr)
        try:
            run.wait_idle(timeout=args.timeout, since_seq=seq, settle=2.0)
        except TimeoutError as e:
            print("timed out: %s" % e, file=sys.stderr)
        approvals.close()
        feed.close()

        snap = client.snapshot()
        print("\n== summary ==")
        print("cost $%.4f · %d tool calls · +%d −%d lines" % (snap["totals"]["costUsd"], snap["totals"]["toolCalls"], snap["totals"]["added"], snap["totals"]["removed"]))
        for a in snap["agents"]:
            prev = before.get(a["agentId"], {"added": 0, "removed": 0})
            da, dr = a["diff"]["added"] - prev["added"], a["diff"]["removed"] - prev["removed"]
            mine = run.agents.get(a["agentId"])
            print("- %s (%s) %s · $%.4f · +%d −%d this task" % (a["name"], a["adapter"], a["status"], a["usage"]["costUsd"], da, dr))
            if mine and mine.last_message:
                print("    says: %s" % mine.last_message.strip().splitlines()[0][:160])
            # state.snapshot doesn't carry workspaces; the RunState fold of workspace.* events does
            w = run.workspaces.get(a["agentId"])
            if w:
                for f in w.files:
                    print("    %s  +%d −%d" % (f["path"], f["added"], f["removed"]))
                if w.merge:
                    print("    merge: %s" % w.merge.get("status"))
            if args.patch and (da or dr):
                try:
                    print(client.diff(a["agentId"]))
                except baton.BatonError as e:
                    print("    (no patch: %s)" % e.message)
        if snap["approvals"]:
            print("%d approval(s) still pending" % len(snap["approvals"]))
        run.close()


if __name__ == "__main__":
    main()
