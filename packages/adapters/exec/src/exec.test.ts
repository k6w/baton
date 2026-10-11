import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import { cleanTerminal, createExecAdapter, execAdapters } from "./index.ts"

const script = join(import.meta.dir, "fixtures", "fake-cli.sh")

describe("exec adapter", () => {
  test("cleanTerminal strips escapes and applies carriage returns", () => {
    expect(cleanTerminal("\x1b[32mhello\x1b[0m\r\nworking 10%\rworking 100%\nab\bc")).toBe("hello\nworking 100%\nac")
  })

  // skipped on Windows: Bun's pseudo-terminal is POSIX-only (Windows uses pipes)
  test.skipIf(process.platform === "win32")("runs a turn in a PTY: streamed text, diffs from git, turn lifecycle", async () => {
    const cwd = tempWorkspace({ "notes.txt": "teh quick fox\n" })
    Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qam", "init", "--allow-empty"], { cwd })
    Bun.spawnSync(["git", "add", "-A"], { cwd })
    Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init"], { cwd })
    const adapter = createExecAdapter({ id: "fake", displayName: "Fake", binaries: ["sh"], args: [script, "{prompt}"] })
    const h = await startHarness(adapter, { cwd })
    await h.session.prompt({ text: "fix the typo" })
    await h.waitTurn(20_000)
    const text = h
      .ofType("message.completed")
      .map((e) => e.data.text)
      .join("")
    expect(text).toContain("tty: yes")
    expect(text).toContain("task: fix the typo")
    expect(text).not.toContain("\x1b[")
    const diffs = h.ofType("tool.update").flatMap((e) => e.data.content ?? [])
    expect(diffs).toMatchObject([{ type: "diff", path: "notes.txt", added: 1, removed: 1 }])
    expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("end_turn")
    await h.close()
  })

  test("interrupt stops a long-running command", async () => {
    const cwd = tempWorkspace({})
    const adapter = createExecAdapter({ id: "slow", displayName: "Slow", binaries: ["sh"], args: ["-c", "echo started; sleep 30"] })
    const h = await startHarness(adapter, { cwd })
    await h.session.prompt({ text: "go" })
    await h.waitFor("message.delta", undefined, 10_000)
    await h.session.interrupt()
    await h.waitFor("turn.interrupted", undefined, 10_000)
    await h.close()
  })

  test("a failing turn setup still completes the turn with an error", async () => {
    const cwd = tempWorkspace({})
    const adapter = createExecAdapter({ id: "gone", displayName: "Gone", binaries: ["sh"], args: ["-c", "echo hi"] })
    const h = await startHarness(adapter, { cwd: join(cwd, "does-not-exist") })
    await h.session.prompt({ text: "go" })
    await h.waitFor("turn.completed", undefined, 10_000)
    expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("error")
    await h.close()
  })

  test("close mid-turn: turn ends before agent.exited, exited once, nothing after", async () => {
    const cwd = tempWorkspace({})
    const adapter = createExecAdapter({ id: "slow2", displayName: "Slow", binaries: ["sh"], args: ["-c", "trap '' INT; echo started; sleep 30"] })
    const h = await startHarness(adapter, { cwd })
    await h.session.prompt({ text: "go" })
    await h.waitFor("message.delta", undefined, 10_000)
    const t = performance.now()
    await h.close()
    await h.session.close()
    expect(performance.now() - t).toBeLessThan(5000)
    const n = h.events.length
    await Bun.sleep(300)
    expect(h.events.length).toBe(n)
    const types = h.events.map((e) => e.type)
    expect(types.filter((x) => x === "agent.exited")).toHaveLength(1)
    expect(types.at(-1)).toBe("agent.exited")
    expect(types).toContain("turn.interrupted")
    await expect(h.session.prompt({ text: "again" })).rejects.toThrow()
  })

  test("presets are registered", () => {
    expect(execAdapters.map((a) => a.id)).toEqual(["aider", "crush", "agy", "exec"])
  })
})
