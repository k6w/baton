#!/usr/bin/env python3
"""Print a live, one-line-per-event feed of a Baton run.

    python3 examples/watch.py                 # follow the project in the current directory
    python3 examples/watch.py --replay        # replay the run so far, then follow
    python3 examples/watch.py --types 'tool.*' --types bus.message
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import baton  # noqa: E402

QUIET = {"message.delta", "usage.updated", "plan.updated", "bus.delivered"}


def describe(e, names):
    t, d = e["type"], e.get("data") or {}
    if t == "agent.spawned":
        return "spawned %s (%s)%s" % (d.get("name"), d.get("adapter"), " — " + d["label"] if d.get("label") else "")
    if t == "agent.status":
        return "status → %s%s" % (d.get("status"), " (%s)" % d["detail"] if d.get("detail") else "")
    if t == "turn.started":
        return "turn started: %s" % (d.get("prompt") or "").splitlines()[0][:100] if d.get("prompt") else "turn started"
    if t == "turn.completed":
        return "turn completed (%s)" % d.get("stopReason", "")
    if t == "message.completed":
        return "%s: %s" % (d.get("role"), d.get("text", "").strip().replace("\n", " ")[:160])
    if t == "tool.call":
        return "tool %s" % d.get("title")
    if t == "tool.update" and d.get("status") in ("completed", "failed"):
        return "  ↳ %s%s" % (d.get("status"), ": " + d["summary"] if d.get("summary") else "")
    if t == "tool.update":
        return None
    if t == "permission.requested":
        return "needs approval: %s" % d.get("title")
    if t == "permission.resolved":
        return "approval %s (by %s)" % (d.get("kind") or "cancelled", d.get("by"))
    if t == "bus.message":
        if d.get("kind") in ("heartbeat", "progress"):
            return None
        return "%s → %s: %s" % (names.get(d.get("from"), d.get("from")), names.get(d.get("to"), d.get("to")), d.get("body", "")[:160])
    if t == "workspace.changed":
        return "changed %d file(s) +%d −%d" % (len(d.get("files", [])), d.get("added", 0), d.get("removed", 0))
    if t in ("error", "orch.note", "log"):
        return "%s: %s" % (t, d.get("message") or d.get("text"))
    if t == "run.autonomy":
        return "autonomy → %s" % d.get("mode")
    return "%s %s" % (t, str(d)[:120])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cwd", default=None, help="directory inside the project")
    ap.add_argument("--replay", action="store_true", help="replay the run from the beginning first")
    ap.add_argument("--types", action="append", help="event type filter (repeatable, e.g. 'tool.*')")
    ap.add_argument("--agent", help="only this agent (id or name)")
    ap.add_argument("--all", action="store_true", help="also show streaming deltas / usage / plan events")
    args = ap.parse_args()

    with baton.connect(cwd=args.cwd, client_name="watch.py") as client:
        names = {a["agentId"]: a["name"] for a in client.snapshot()["agents"]}
        agent_id = None
        if args.agent:
            a = client.find_agent(args.agent)
            if not a:
                sys.exit("no agent %r" % args.agent)
            agent_id = a["agentId"]
        print("watching %s (run %s) — ctrl-c to stop" % (client.project_root, client.run_id), file=sys.stderr)
        try:
            for e in client.events(from_seq=0 if args.replay else None, types=args.types, agent_id=agent_id):
                if e["type"] == "agent.spawned":
                    names[e["data"]["agentId"]] = e["data"]["name"]
                if e["type"] in QUIET and not args.all:
                    continue
                line = describe(e, names)
                if line is None:
                    continue
                who = names.get(e.get("agentId"), "baton") if e.get("agentId") else "baton"
                print("%6d  %-14s %s" % (e["seq"], who[:14], line), flush=True)
        except KeyboardInterrupt:
            pass
        print("connection closed: %s" % client.close_reason if client.closed else "", file=sys.stderr)


if __name__ == "__main__":
    main()
