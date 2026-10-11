import "./testing/env.ts"
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, ApprovalMode } from "@batonsh/protocol"
import { tempWorkspace } from "../../testkit/src/index.ts"
import { nativeAdapter } from "./index.ts"
import { gitDirsFor, resetSandboxWarnings, resolveSandbox, sandboxSettings, seatbeltProfile } from "./sandbox.ts"
import { contentText, type FakeLLM, fakeLLM } from "./testing/fake-llm.ts"

const servers: { stop(): void }[] = []
const cleanup: string[] = []
afterAll(() => {
  for (const s of servers) s.stop()
  for (const p of cleanup) rmSync(p, { force: true, recursive: true })
})

describe("sandbox settings", () => {
  test("seatbelt profile: writes limited to the given paths; network denial optional", () => {
    const p = seatbeltProfile(["/work/a b", '/odd"quote'], true)
    expect(p).toContain("(deny file-write*)")
    expect(p).toContain('(subpath "/work/a b")')
    expect(p).toContain('(subpath "/odd\\"quote")')
    expect(p).not.toContain("deny network")
    expect(seatbeltProfile([], false)).toContain("(deny network*)")
  })

  // skipped on Windows: macOS/Linux sandboxes and paths
  test.skipIf(process.platform === "win32")("defaults: cwd, temp dirs, ~/.cache and extra writable paths; off under yolo or sandbox=off", () => {
    const cwd = tempWorkspace()
    const home = mkdtempSync(join(tmpdir(), "baton-home-"))
    const s = resolveSandbox({
      settings: sandboxSettings({ sandboxWritable: ["~/extra", "/opt/cache"] }),
      approval: "auto",
      cwd,
      env: { HOME: home },
      platform: "darwin",
      // CI runs this on Linux too
      which: (bin) => (bin === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null),
    })
    expect(s.kind).toBe("seatbelt")
    expect(s.writable).toContain(realpathSync(cwd))
    expect(s.writable).toContain("/private/tmp")
    expect(s.writable).toContain("/private/var/folders")
    expect(s.writable).toContain(join(realpathSync(home), ".cache"))
    expect(s.writable).toContain(join(realpathSync(home), "extra"))
    expect(s.writable).toContain("/opt/cache")
    expect(s.wrap(["bash", "-lc", "x"]).slice(-3)).toEqual(["bash", "-lc", "x"])
    expect(s.describe()).toContain("network: allowed")
    for (const approval of ["yolo"] as ApprovalMode[])
      expect(resolveSandbox({ settings: sandboxSettings({}), approval, cwd, platform: "darwin" }).kind).toBe("none")
    expect(resolveSandbox({ settings: sandboxSettings({ sandbox: "off" }), approval: "ask", cwd, platform: "darwin" }).kind).toBe("none")
  })

  test("linux: bwrap when installed (ro root, rw binds, --unshare-net), otherwise a one-time warning", () => {
    const cwd = tempWorkspace()
    const bw = resolveSandbox({
      settings: sandboxSettings({ sandboxNetwork: false }),
      approval: "ask",
      cwd,
      platform: "linux",
      which: () => "/usr/bin/bwrap",
    })
    const argv = bw.wrap(["bash", "-lc", "make"])
    expect(bw.kind).toBe("bwrap")
    expect(argv.slice(0, 5)).toEqual(["/usr/bin/bwrap", "--ro-bind", "/", "/", "--dev"])
    expect(argv.join(" ")).toContain(`--bind ${realpathSync(cwd)} ${realpathSync(cwd)}`)
    expect(argv).toContain("--unshare-net")
    expect(argv.slice(-4)).toEqual(["--", "bash", "-lc", "make"])

    resetSandboxWarnings()
    const warnings: string[] = []
    for (let i = 0; i < 3; i++) {
      const none = resolveSandbox({
        settings: sandboxSettings({}),
        approval: "ask",
        cwd,
        platform: "linux",
        which: () => null,
        log: (_l, m) => warnings.push(m),
      })
      expect(none.kind).toBe("none")
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("bwrap")
    expect(warnings[0]).toContain("landrun")
  })

  test("linux without bwrap: firejail, then landrun (Landlock)", () => {
    const cwd = tempWorkspace()
    const only = (bin: string) => (b: string) => (b === bin ? `/usr/bin/${bin}` : null)
    const fj = resolveSandbox({ settings: sandboxSettings({ sandboxNetwork: false }), approval: "ask", cwd, platform: "linux", which: only("firejail") })
    expect(fj.kind).toBe("firejail")
    const a = fj.wrap(["sh", "-c", "make"])
    expect(a).toContain("--read-only=/")
    expect(a).toContain(`--read-write=${realpathSync(cwd)}`)
    expect(a).toContain("--net=none")
    expect(a.slice(-4)).toEqual(["--", "sh", "-c", "make"])
    const lr = resolveSandbox({ settings: sandboxSettings({}), approval: "ask", cwd, platform: "linux", which: only("landrun") })
    expect(lr.kind).toBe("landrun")
    const b = lr.wrap(["make"])
    expect(b.slice(0, 3)).toEqual(["/usr/bin/landrun", "--rox", "/"])
    expect(b.join(" ")).toContain(`--rwx ${realpathSync(cwd)}`)
    expect(b).toContain("--unrestricted-network")
  })

  test("container tier: only the workspace is mounted, as the user's uid; never silently unconfined", () => {
    const cwd = tempWorkspace()
    const s = resolveSandbox({
      settings: sandboxSettings({ sandbox: "container", sandboxImage: "oven/bun:1", sandboxNetwork: false }),
      approval: "ask",
      cwd,
      platform: "darwin",
      which: (b) => (b === "podman" ? "/usr/bin/podman" : null),
    })
    expect(s.kind).toBe("container")
    const a = s.wrap(["sh", "-c", "bun test"])
    const w = realpathSync(cwd)
    expect(a.slice(0, 3)).toEqual(["/usr/bin/podman", "run", "--rm"])
    expect(a.join(" ")).toContain(`-v ${w}:${w} -w ${w}`)
    expect(a).toContain("--network")
    expect(a.slice(-4)).toEqual(["oven/bun:1", "sh", "-c", "bun test"])
    expect(() => resolveSandbox({ settings: sandboxSettings({ sandbox: "container" }), approval: "ask", cwd, platform: "linux", which: () => null })).toThrow(
      "docker or podman",
    )
  })

  // skipped on Windows: macOS/Linux sandboxes and paths
  test.skipIf(process.platform === "win32")("git worktrees: the main repository's git dir is writable too", () => {
    const main = tempWorkspace({ "a.txt": "a\n" })
    Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "init", "--allow-empty"], { cwd: main })
    Bun.spawnSync(["git", "add", "."], { cwd: main })
    Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "files"], { cwd: main })
    const wt = join(mkdtempSync(join(tmpdir(), "baton-wt-")), "wt")
    Bun.spawnSync(["git", "worktree", "add", "-q", wt], { cwd: main })
    const dirs = gitDirsFor(wt)
    expect(dirs.some((d) => d.startsWith(join(realpathSync(main), ".git", "worktrees")))).toBe(true)
    expect(dirs).toContain(join(realpathSync(main), ".git"))
  })
})

function llm(script: Parameters<typeof fakeLLM>[0]): FakeLLM {
  const s = fakeLLM(script)
  servers.push(s)
  return s
}

const toolText = (fake: FakeLLM, i: number) =>
  (fake.requests[i]?.body.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => contentText(m.content))
    .join("\n")

describe.if(process.platform === "darwin")("sandbox on macOS (seatbelt)", () => {
  async function run(approval: ApprovalMode, command: string, options: Record<string, unknown> = {}) {
    const fake = llm([{ toolCalls: [{ name: "run_command", args: { command } }] }, { text: "done" }])
    const cwd = tempWorkspace()
    const events: AgentEvent[] = []
    const logs: string[] = []
    const s = await nativeAdapter.start(
      {
        agentId: "a",
        name: "w",
        cwd,
        mcpServers: [],
        approval,
        model: "m",
        provider: { id: "fake", kind: "openai-compatible", baseUrl: fake.baseUrl },
        options,
      },
      { emit: (e) => events.push(e), log: (_l, m) => logs.push(m), signal: new AbortController().signal },
    )
    try {
      await s.prompt({ text: "go" })
      for (let i = 0; i < 250 && !events.some((e) => e.type === "turn.completed"); i++) await Bun.sleep(20)
      return { cwd, out: toolText(fake, 1), logs, system: contentText(fake.requests[0]?.body.messages[0]?.content) }
    } finally {
      await s.close()
    }
  }

  test("a command writing outside the workspace fails; inside (and temp) succeeds", async () => {
    const outside = join(homedir(), `.baton-sandbox-test-${process.pid}-${Date.now()}`)
    cleanup.push(outside)
    const r = await run("auto", `echo in > inside.txt && echo ok-inside; echo tmp > "$TMPDIR/baton-sbx-$$" && echo ok-tmp; echo out > ${outside}; echo "rc=$?"`)
    expect(readFileSync(join(r.cwd, "inside.txt"), "utf8")).toBe("in\n")
    expect(r.out).toContain("ok-inside")
    expect(r.out).toContain("ok-tmp")
    expect(r.out).toContain("Operation not permitted")
    expect(r.out).toContain("rc=1")
    expect(existsSync(outside)).toBe(false)
    expect(r.logs.some((l) => l.startsWith("run_command sandbox: seatbelt"))).toBe(true)
    expect(r.system).toContain("Commands may run in a sandbox")
  })

  test("extra writable paths; yolo and sandbox=off run unsandboxed", async () => {
    const extra = mkdtempSync(join(homedir(), ".baton-sbx-extra-"))
    cleanup.push(extra)
    const r1 = await run("auto", `echo x > ${extra}/f && echo wrote`, { sandboxWritable: [extra] })
    expect(r1.out).toContain("wrote")

    const outside = join(homedir(), `.baton-sandbox-yolo-${process.pid}-${Date.now()}`)
    cleanup.push(outside)
    const r2 = await run("yolo", `echo out > ${outside} && echo wrote`)
    expect(r2.out).toContain("wrote")
    expect(existsSync(outside)).toBe(true)
    expect(r2.logs.some((l) => l.includes("run_command sandbox: off (yolo approval)"))).toBe(true)

    const r3 = await run("auto", `echo out >> ${outside} && echo again`, { sandbox: "off" })
    expect(r3.out).toContain("again")
  })

  test("sandboxNetwork = false blocks network access", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("reachable") })
    servers.push({ stop: () => srv.stop(true) })
    const cmd = `curl -s -m 3 http://127.0.0.1:${srv.port}/ || echo "curl failed"`
    const blocked = await run("auto", cmd, { sandboxNetwork: false })
    expect(blocked.out).toContain("curl failed")
    const open = await run("auto", cmd)
    expect(open.out).toContain("reachable")
  })
})
