import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, SessionConfig } from "@batonsh/protocol"
import { contractSuite, LIVE, startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import { opencodeAdapter } from "./index.ts"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await Bun.sleep(50)
  }
  return cond()
}

/** A fake `opencode` that records its pid, ignores SIGTERM and never becomes ready. */
function stubbornServer(dir: string): { bin: string; pidFile: string } {
  const pidFile = join(dir, "server.pid")
  const bin = join(dir, "fake-opencode")
  writeFileSync(bin, `#!/bin/sh\ntrap "" TERM\necho $$ > ${JSON.stringify(pidFile)}\nwhile :; do sleep 0.2; done\n`)
  chmodSync(bin, 0o755)
  return { bin, pidFile }
}

async function readPid(pidFile: string): Promise<number> {
  expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 5_000)).toBe(true)
  return Number(readFileSync(pidFile, "utf8").trim())
}

function ctxFor(events: AgentEvent[]) {
  return { emit: (e: AgentEvent) => events.push(e), log: () => {}, signal: new AbortController().signal }
}

describe("opencode server process lifecycle", () => {
  // skipped on Windows: the /bin/sh watchdog and signals are POSIX-only
  test.skipIf(process.platform === "win32")(
    "server dies with a SIGKILLed host (stdin-EOF watchdog kills the process group)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "baton-oc-"))
      const { bin, pidFile } = stubbornServer(dir)
      const host = join(dir, "host.ts")
      writeFileSync(
        host,
        `import { spawnWatched } from ${JSON.stringify(join(import.meta.dir, "index.ts"))}\nspawnWatched([${JSON.stringify(bin)}], {})\nconsole.log("spawned")\nawait Bun.sleep(60_000)\n`,
      )
      const hostProc = Bun.spawn(["bun", host], { stdout: "pipe", stderr: "inherit" })
      const pid = await readPid(pidFile)
      expect(alive(pid)).toBe(true)
      hostProc.kill("SIGKILL")
      await hostProc.exited
      // TERM is ignored by the fake, so this also covers the KILL escalation
      expect(await waitFor(() => !alive(pid), 8_000)).toBe(true)
    },
    20_000,
  )

  // skipped on Windows: the /bin/sh watchdog and signals are POSIX-only
  test.skipIf(process.platform === "win32")("server that exits during start: start() rejects without agent.exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baton-oc-"))
    const bin = join(dir, "fake-opencode")
    writeFileSync(bin, "#!/bin/sh\necho boom >&2\nexit 3\n")
    chmodSync(bin, 0o755)
    const events: AgentEvent[] = []
    const cfg = { agentId: "a", name: "t", cwd: dir, mcpServers: [], approval: "ask", command: bin } as unknown as SessionConfig
    await expect(opencodeAdapter.start(cfg, ctxFor(events))).rejects.toThrow(/exited with code 3/)
    await Bun.sleep(200)
    expect(events.map((e) => e.type)).not.toContain("agent.exited")
  })

  // skipped on Windows: the /bin/sh watchdog and signals are POSIX-only
  test.skipIf(process.platform === "win32")(
    "ready-wait timeout SIGKILLs a server that ignores SIGTERM",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "baton-oc-"))
      const { bin, pidFile } = stubbornServer(dir)
      const events: AgentEvent[] = []
      const cfg = {
        agentId: "a",
        name: "t",
        cwd: dir,
        mcpServers: [],
        approval: "ask",
        command: bin,
        options: { readyTimeoutMs: 500 },
      } as unknown as SessionConfig
      const t0 = Date.now()
      await expect(opencodeAdapter.start(cfg, ctxFor(events))).rejects.toThrow(/not ready/)
      const pid = await readPid(pidFile)
      expect(await waitFor(() => !alive(pid), 1_000)).toBe(true)
      expect(Date.now() - t0).toBeLessThan(3_000)
      await Bun.sleep(100)
      expect(events.map((e) => e.type)).not.toContain("agent.exited")
    },
    10_000,
  )
})

/** Cheap model that reports cost; override with BATON_OPENCODE_MODEL. */
const MODEL = process.env.BATON_OPENCODE_MODEL ?? "deepinfra/deepseek-ai/DeepSeek-V4-Flash"
const live = LIVE ? test : test.skip

describe("opencode adapter contract", () => {
  contractSuite(opencodeAdapter, { test, expect }, { model: MODEL })

  test("capabilities", () => {
    const c = opencodeAdapter.capabilities()
    expect(c).toMatchObject({ steer: false, interrupt: true, resume: true, permissions: true, mcp: true, diff: true, cost: true })
  })

  live(
    "live: interrupt mid-turn, then resume the same session",
    async () => {
      const cwd = tempWorkspace({ "README.md": "# hi\n" })
      const h = await startHarness(opencodeAdapter, { cwd, model: MODEL })
      let sessionId: string | undefined
      try {
        sessionId = h.session.resumeId()
        expect(sessionId).toStartWith("ses_")
        await h.session.prompt({ text: "Count from 1 to 300, one number per line. Do not use tools." })
        await h.waitFor("message.delta", undefined, 120_000)
        await h.session.interrupt()
        await h.waitFor("turn.interrupted", undefined, 30_000)
      } finally {
        await h.close()
      }
      const h2 = await startHarness(opencodeAdapter, { cwd, model: MODEL, resumeId: sessionId })
      try {
        expect(h2.session.resumeId()).toBe(sessionId)
        await h2.session.prompt({ text: "Reply with exactly the word RESUMED and nothing else." })
        await h2.waitTurn(120_000)
        const text = h2
          .ofType("message.delta")
          .map((e) => e.data.text)
          .join("")
        expect(text).toContain("RESUMED")
        expect(h2.ofType("usage.updated").some((u) => (u.data.costUsd ?? 0) > 0)).toBe(true)
      } finally {
        await h2.close()
      }
    },
    300_000,
  )
})
