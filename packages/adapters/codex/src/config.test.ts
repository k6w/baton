import { describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionConfig } from "@batonsh/protocol"
import { tempWorkspace } from "../../testkit/src/index.ts"
import { approvalSettings, appServerArgs, mcpConfigArgs, promptText, providerSettings } from "./config.ts"
import { loadFixture } from "./fixtures/replay.ts"
import { GitSnapshotter, splitGitPatch } from "./snapshot.ts"

describe("approval mapping", () => {
  test.each([
    ["ask", "untrusted", "workspace-write"],
    ["auto-edit", "on-request", "workspace-write"],
    ["auto", "never", "workspace-write"],
    ["yolo", "never", "danger-full-access"],
  ] as const)("%s → %s + %s", (mode, approvalPolicy, sandbox) => {
    expect(approvalSettings(mode)).toEqual({ approvalPolicy, sandbox })
  })

  test("options override the mapping", () => {
    expect(approvalSettings("ask", { approvalPolicy: "on-request", sandbox: "read-only" })).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    })
    expect(approvalSettings("ask", { approvalPolicy: "bogus" }).approvalPolicy).toBe("untrusted")
  })
})

describe("MCP injection", () => {
  test("streamable HTTP servers become -c mcp_servers overrides", () => {
    expect(
      mcpConfigArgs([
        { name: "baton", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: 'Bearer t"k', "X-Agent": "a1" } },
        { name: "my server.v2", url: "https://x/mcp" },
      ]),
    ).toEqual([
      "-c",
      'mcp_servers.baton.url="http://127.0.0.1:4100/mcp"',
      "-c",
      'mcp_servers.baton.http_headers={"Authorization"="Bearer t\\"k","X-Agent"="a1"}',
      "-c",
      'mcp_servers.my_server_v2.url="https://x/mcp"',
    ])
  })

  test("appServerArgs puts app-server first and user args last", () => {
    const cfg: SessionConfig = {
      agentId: "a",
      name: "n",
      cwd: "/w",
      approval: "ask",
      mcpServers: [{ name: "baton", url: "http://h/mcp" }],
      args: ["--enable", "foo"],
    }
    expect(appServerArgs(cfg).args).toEqual(["app-server", "-c", 'mcp_servers.baton.url="http://h/mcp"', "--enable", "foo"])
  })
})

describe("providers", () => {
  test("custom base URL registers a model provider with the key in env", () => {
    const p = providerSettings({ id: "my-gw", kind: "openai-compatible", baseUrl: "https://gw/v1", apiKey: "sk-1" })
    expect(p.modelProvider).toBe("my-gw")
    expect(p.args).toContain('model_providers.my-gw.base_url="https://gw/v1"')
    expect(p.args).toContain('model_providers.my-gw.env_key="BATON_CODEX_PROVIDER_API_KEY"')
    expect(p.args.join(" ")).not.toContain("sk-1")
    expect(p.env).toEqual({ BATON_CODEX_PROVIDER_API_KEY: "sk-1" })
  })

  test("built-in providers", () => {
    expect(providerSettings({ id: "local", kind: "ollama" })).toEqual({ args: [], env: {}, modelProvider: "ollama" })
    expect(providerSettings(undefined)).toEqual({ args: [], env: {} })
  })
})

test("promptText attributes non-user senders", () => {
  expect(promptText({ text: "hi" })).toBe("hi")
  expect(promptText({ text: "hi", from: "user" })).toBe("hi")
  expect(promptText({ text: "hi", from: "reviewer" })).toBe("[message from reviewer]\nhi")
})

describe("git snapshots (shell edits)", () => {
  test("diffs modified, created and deleted files without touching the user's index", async () => {
    const cwd = tempWorkspace({ "a.txt": "teh fox\n", "b.txt": "gone\n" })
    const s = new GitSnapshotter(cwd)
    try {
      const before = await s.snapshot()
      expect(before).toBeString()
      writeFileSync(join(cwd, "a.txt"), "the fox\n")
      writeFileSync(join(cwd, "c.txt"), "new\n")
      rmSync(join(cwd, "b.txt"))
      const after = await s.snapshot()
      const files = await s.diff(before as string, after as string)
      expect(files.map((f) => [f.path, f.added, f.removed, f.created, f.deleted])).toEqual([
        [join(cwd, "a.txt"), 1, 1, false, false],
        [join(cwd, "b.txt"), 0, 1, false, true],
        [join(cwd, "c.txt"), 1, 0, true, false],
      ])
      // The real index is untouched: everything is still untracked.
      const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd }).stdout.toString()
      expect(
        status
          .split("\n")
          .filter(Boolean)
          .every((l) => l.startsWith("??")),
      ).toBe(true)
    } finally {
      s.dispose()
    }
  })

  test("non-git workspaces disable snapshots", async () => {
    const cwd = tempWorkspace()
    rmSync(join(cwd, ".git"), { recursive: true })
    expect(await new GitSnapshotter(cwd).snapshot()).toBeUndefined()
  })

  test("splitGitPatch parses codex's turn diff", () => {
    const diffMsg = loadFixture("apply-patch").find((m) => m.msg.method === "turn/diff/updated")
    const params = diffMsg?.msg.params as { diff: string }
    const files = splitGitPatch(params.diff, "/workspace")
    expect(files.map((f) => [f.path, f.added, f.removed, f.created])).toEqual([
      ["/workspace/hello.txt", 1, 0, true],
      ["/workspace/notes.txt", 1, 1, false],
    ])
  })
})
