import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemon } from "./daemon.ts"
import { isTrusted, trustProject } from "./plugins.ts"

const PLUGIN = `
import { mockAdapter } from "${join(import.meta.dir, "../../adapters/mock/src/index.ts")}"
export default { name: "echo", adapters: [{ ...mockAdapter, id: "echo", displayName: "Echo Agent" }] }
`

describe("plugins", () => {
  test("project plugins load only after `baton trust`, and trust breaks when the list changes", async () => {
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

    trustProject(root, ["./.baton/plugins/echo.ts"])
    expect(isTrusted(root, ["./.baton/plugins/echo.ts"])).toBe(true)
    d = await startDaemon({ projectRoot: root, ephemeral: true, socketPath: join(root, "b.sock") })
    expect(d.runtime.registry.get("echo")?.displayName).toBe("Echo Agent")
    const info = await d.runtime.spawn({ adapter: "echo", options: { speed: 0 } })
    expect(info.adapter).toBe("echo")
    await d.stop()

    expect(isTrusted(root, ["./.baton/plugins/echo.ts", "./evil.ts"])).toBe(false)
    trustProject(root, [], true)
    expect(isTrusted(root, ["./.baton/plugins/echo.ts"])).toBe(false)
  })
})
