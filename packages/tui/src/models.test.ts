import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemon } from "@batonsh/daemon"
import { BatonClient } from "@batonsh/sdk"
import { completions } from "./completion.ts"
import { modelsFor } from "./models.ts"

test("agents' model lists: the daemon reports them, /model <agent> suggests them, Worker model applies to the default worker", async () => {
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-models-"))
  const d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 }, defaults: { worker: "mock", model: "mock-smart" } },
  })
  const client = await BatonClient.open(d.socketPath)
  try {
    expect((await client.call("agents.models", { adapter: "mock" })).models).toEqual(["mock-fast", "mock-smart"])
    const live = await client.live()
    const config = (await client.call("config.get", {})).config as never
    const w = await client.spawn({ adapter: "mock", name: "w1" })
    // the default worker gets defaults.model; an explicit model still wins
    expect(w.model).toBe("mock-smart")
    expect((await client.spawn({ adapter: "mock", name: "w2", model: "mock-fast" })).model).toBe("mock-fast")
    for (let i = 0; i < 100 && !live.state.agents.get(w.agentId); i++) await Bun.sleep(20)
    // the list arrives asynchronously (reactive), then completion offers it
    modelsFor(client, "mock")
    for (let i = 0; i < 100 && modelsFor(client, "mock").length === 0; i++) await Bun.sleep(20)
    const c = completions("/model w1 ", live.state, config, client)
    expect(c.map((x) => x.label)).toEqual(["mock-fast", "mock-smart"])
    expect(c.find((x) => x.label === "mock-smart")?.detail).toBe("current")
    expect(completions("/model w1 fa", live.state, config, client).map((x) => x.replace)).toEqual(["/model w1 mock-fast"])
    await live.stop()
  } finally {
    client.close()
    await d.stop()
  }
}, 30000)
