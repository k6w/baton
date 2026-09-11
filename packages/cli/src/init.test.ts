import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonConfig } from "@batonsh/kernel"
import { parse } from "smol-toml"
import { chooseDefaults, configToml, type DetectedAgent, detectToolchain } from "./init.ts"

const A = (id: string, installed: boolean, auth: "ok" | "missing" | "unknown"): DetectedAgent => ({ id, displayName: id, installed, auth, protocols: [] })

describe("init", () => {
  test("prefers logged-in agents for orchestrator and workers", () => {
    expect(chooseDefaults([A("claude", true, "unknown"), A("codex", true, "ok"), A("opencode", true, "ok")])).toEqual({
      orchestrator: "codex",
      worker: "opencode",
    })
    expect(chooseDefaults([A("claude", true, "ok"), A("codex", true, "ok")])).toEqual({ orchestrator: "claude", worker: "codex" })
    expect(chooseDefaults([A("claude", false, "unknown")])).toEqual({ orchestrator: "mock", worker: "mock" })
  })

  test("detects node toolchains from package.json + lockfile", () => {
    const d = mkdtempSync(join(tmpdir(), "baton-tc-"))
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", build: "vite build" } }))
    writeFileSync(join(d, "pnpm-lock.yaml"), "")
    expect(detectToolchain(d)).toEqual({
      kind: "node",
      packageManager: "pnpm",
      commands: { test: "pnpm test", lint: "pnpm lint", build: "pnpm build", typecheck: undefined, dev: undefined },
    })
  })

  test("generated config.toml parses and validates", () => {
    const toml = configToml({
      name: "x",
      orchestrator: "claude",
      worker: "codex",
      agents: [A("claude", true, "ok")],
      toolchain: { kind: "go", commands: { test: "go test ./..." } },
    })
    const parsed = BatonConfig.parse(parse(toml))
    expect(parsed.orchestrator.agent).toBe("claude")
    expect(parsed.defaults.worker).toBe("codex")
    expect(parsed.ui.theme).toBe("baton")
  })
})
