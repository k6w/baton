import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import { cleanTerminal, createExecAdapter, execAdapters } from "./index.ts"

const script = join(import.meta.dir, "fixtures", "fake-cli.sh")

describe("exec adapter", () => {
  test("cleanTerminal strips escapes and applies carriage returns", () => {
    expect(cleanTerminal("\x1b[32mhello\x1b[0m\r\nworking 10%\rworking 100%\nab\bc")).toBe("hello\nworking 100%\nac")
  })

  test("runs a turn in a PTY: streamed text, diffs from git, turn lifecycle", async () => {
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

  test("presets are registered", () => {
    expect(execAdapters.map((a) => a.id)).toEqual(["aider", "crush", "agy", "exec"])
  })
})
