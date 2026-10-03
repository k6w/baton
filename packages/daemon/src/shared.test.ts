import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonClient } from "@batonsh/sdk"
import { type Daemon, startDaemon } from "./daemon.ts"
import { ensureRemote, remoteSecrets, stopRemote } from "./remote.ts"

let d: Daemon
const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout")
    await Bun.sleep(10)
  }
}

beforeAll(async () => {
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-shared-"))
  d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 }, workspace: { isolation: "shared" } },
  })
})
afterAll(async () => {
  stopRemote(d.runtime)
  await d.stop()
})

test("shared runs: who is watching, who said what, who answered", async () => {
  const ana = await BatonClient.open(d.socketPath, "tui", "ana")
  const ben = await BatonClient.open(d.socketPath, "tui", "ben")
  const script = await BatonClient.open(d.socketPath, "sdk") // no user: not a viewer
  await until(() => d.runtime.state.viewers.length === 2)
  expect(d.runtime.state.viewers.map((v) => v.name).sort()).toEqual(["ana", "ben"])

  // ben talks to the lead: its turn is attributed to him
  await ben.submit("check the build")
  const lead = d.runtime.state.orchestratorId!
  await until(() => d.runtime.state.feed(lead).items.some((i) => i.kind === "user" && i.text === "check the build"))
  const item = d.runtime.state.feed(lead).items.find((i) => i.kind === "user" && i.text === "check the build")
  expect(item && item.kind === "user" ? item.from : undefined).toBe("ben")

  // ana answers an approval: the resolution says so
  const w = await d.runtime.spawn({ adapter: "mock", name: "w", options: { speed: 0 } })
  d.runtime.emit(
    {
      type: "permission.requested",
      data: { requestId: "q1", title: "Bash(make)", kind: "execute", options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] },
    },
    w.agentId,
  )
  await ana.respond(w.agentId, "q1", "ok")
  const resolved = d.runtime.store.query({ runId: d.runtime.runId, types: ["permission.resolved"] }).at(-1)
  expect(resolved?.type === "permission.resolved" ? resolved.data.who : undefined).toBe("ana")

  // a phone joins through the web view, and leaves
  const web = ensureRemote(d.runtime)
  const ac = new AbortController()
  const res = await fetch(`http://127.0.0.1:${web.port}/api/stream`, {
    headers: { Authorization: `Bearer ${remoteSecrets(d.runtime.projectRoot).token}`, "X-Baton-User": "cy" },
    signal: ac.signal,
  })
  await res.body!.getReader().read()
  await until(() => d.runtime.state.viewers.some((v) => v.name === "cy" && v.via === "web"))
  ac.abort()
  await until(() => !d.runtime.state.viewers.some((v) => v.name === "cy"))

  ben.close()
  await until(() => d.runtime.state.viewers.map((v) => v.name).join() === "ana")
  ana.close()
  script.close()
})
