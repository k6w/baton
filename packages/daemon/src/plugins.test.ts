import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, revokeTrust, trustEntries } from "@batonsh/kernel"
import { startDaemon } from "./daemon.ts"

const PLUGIN = `
import { mockAdapter } from "${join(import.meta.dir, "../../adapters/mock/src/index.ts")}"
export default { name: "echo", adapters: [{ ...mockAdapter, id: "echo", displayName: "Echo Agent" }] }
`

describe("plugins", () => {
  test("project plugins load only after `baton trust`, and trust breaks when the plugin file changes", async () => {
    process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
    process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
    const root = mkdtempSync(join(tmpdir(), "baton-plug-"))
    mkdirSync(join(root, ".baton", "plugins"), { recursive: true })
    writeFileSync(join(root, ".baton", "plugins", "echo.ts"), PLUGIN)
    writeFileSync(join(root, ".baton", "config.toml"), `plugins = ["./.baton/plugins/echo.ts"]\n[bus]\nheartbeat_s = 0\n`)

    let d = await startDaemon({ projectRoot: root, ephemeral: true, socketPath: join(root, "a.sock") })
    expect(d.runtime.registry.get("echo")).toBeUndefined()
    expect(d.runtime.state.lastSeq).toBeGreaterThan(0)
    await d.stop()

    const held = loadConfig({ projectRoot: root }).untrusted
    expect(held.map((e) => e.path)).toEqual(["plugins[0]"])
    trustEntries(root, held)
    d = await startDaemon({ projectRoot: root, ephemeral: true, socketPath: join(root, "b.sock") })
    expect(d.runtime.registry.get("echo")?.displayName).toBe("Echo Agent")
    const info = await d.runtime.spawn({ adapter: "echo", options: { speed: 0 } })
    expect(info.adapter).toBe("echo")
    await d.stop()

    // editing the trusted plugin file revokes it
    writeFileSync(join(root, ".baton", "plugins", "echo.ts"), `${PLUGIN}\n// changed\n`)
    expect(loadConfig({ projectRoot: root }).untrusted.length).toBe(1)
    trustEntries(root, loadConfig({ projectRoot: root }).untrusted)
    expect(loadConfig({ projectRoot: root }).untrusted.length).toBe(0)
    revokeTrust(root)
    expect(loadConfig({ projectRoot: root }).untrusted.length).toBe(1)
  })
})
