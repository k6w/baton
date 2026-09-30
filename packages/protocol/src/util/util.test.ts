import { describe, expect, test } from "bun:test"
import { diffLines, diffStat, parseUnifiedDiff } from "./diff.ts"
import { type JsonRpcMessage, JsonRpcPeer } from "./jsonrpc.ts"
import { runCapture } from "./proc.ts"

describe("diffLines", () => {
  test("small edits keep minimal Myers output", () => {
    const l = diffLines("a\nb\nc\n", "a\nB\nc\nd\n", Number.POSITIVE_INFINITY)
    expect(l.map((x) => `${x.kind}:${x.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c", "add:d"])
  })

  test("empty side emits all-add / all-del", () => {
    expect(diffStat(diffLines("", "x\ny\n"))).toEqual({ added: 2, removed: 0 })
    expect(diffStat(diffLines("x\ny\n", null))).toEqual({ added: 0, removed: 2 })
  })

  test("huge full rewrite stays bounded in time/memory", () => {
    const n = 20_000
    const a = Array.from({ length: n }, (_, i) => `old ${i}`).join("\n")
    const b = Array.from({ length: n }, (_, i) => `new ${i}`).join("\n")
    const t = performance.now()
    const l = diffLines(a, b)
    expect(performance.now() - t).toBeLessThan(3000)
    expect(diffStat(l)).toEqual({ added: n, removed: n })
  })

  test("5k-line rewrite under the full-diff cap does not blow up", () => {
    const n = 3_900
    const a = Array.from({ length: n }, (_, i) => `old ${i}`).join("\n")
    const b = Array.from({ length: n }, (_, i) => `new ${i}`).join("\n")
    const before = process.memoryUsage().rss
    const l = diffLines(a, b)
    expect(diffStat(l)).toEqual({ added: n, removed: n })
    expect(process.memoryUsage().rss - before).toBeLessThan(200e6)
  })

  test("large file with a small edit keeps exact line numbers", () => {
    const n = 10_000
    const a = Array.from({ length: n }, (_, i) => `line ${i}`)
    const b = [...a]
    b[5000] = "changed"
    const l = diffLines(a.join("\n"), b.join("\n"), 0)
    expect(l).toEqual([
      { kind: "del", text: "line 5000", oldLine: 5001 },
      { kind: "add", text: "changed", newLine: 5001 },
    ])
  })
})

describe("parseUnifiedDiff", () => {
  test("content lines that look like headers stay content", () => {
    const patch = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "--- old dashes", "+++ new plusses", " ctx"].join("\n")
    const f = parseUnifiedDiff(patch)
    expect(f).toHaveLength(1)
    expect(f[0]?.path).toBe("x")
    expect(f[0]?.lines).toEqual([
      { kind: "del", text: "-- old dashes", oldLine: 1 },
      { kind: "add", text: "++ new plusses", newLine: 1 },
      { kind: "ctx", text: "ctx", oldLine: 2, newLine: 2 },
    ])
  })

  test("multi-file diffs without diff --git split per file", () => {
    const patch = ["--- a/one", "+++ b/one", "@@ -1 +1 @@", "-a", "+b", "--- a/two", "+++ b/two", "@@ -3,1 +3,1 @@", "-c", "+d", ""].join("\n")
    const f = parseUnifiedDiff(patch)
    expect(f.map((x) => x.path)).toEqual(["one", "two"])
    expect(f[1]?.lines).toEqual([
      { kind: "del", text: "c", oldLine: 3 },
      { kind: "add", text: "d", newLine: 3 },
    ])
  })

  test("git diffs with headers still parse", () => {
    const f = parseUnifiedDiff("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -14,1 +14,1 @@\n-teh\n+the\n\\ No newline at end of file\n")
    expect(f).toHaveLength(1)
    expect(f[0]?.path).toBe("x")
    expect(f[0]?.lines).toEqual([
      { kind: "del", text: "teh", oldLine: 14 },
      { kind: "add", text: "the", newLine: 14 },
    ])
  })

  test("headerless hunks (codex fileChange) parse", () => {
    const f = parseUnifiedDiff("@@ -1,2 +1,2 @@\n a\n-b\n+c\n")
    expect(f[0]?.lines.map((l) => l.kind)).toEqual(["ctx", "del", "add"])
  })
})

describe("JsonRpcPeer", () => {
  test("request after close rejects immediately", async () => {
    const peer = new JsonRpcPeer(() => {})
    peer.close("gone")
    await expect(peer.request("x")).rejects.toThrow("gone")
  })

  test("handle ignores null and non-object messages", async () => {
    const sent: JsonRpcMessage[] = []
    const peer = new JsonRpcPeer((m) => sent.push(m))
    for (const bad of [null, 42, "str", [1, 2], { method: 5 }]) await peer.handle(bad as unknown as JsonRpcMessage)
    expect(sent).toEqual([])
  })
})

describe("runCapture", () => {
  test("does not hang when a grandchild keeps stdout open", async () => {
    const t = performance.now()
    const r = await runCapture(["sh", "-c", "sleep 5 & echo hi"], { timeoutMs: 5000, pipeGraceMs: 200 })
    expect(performance.now() - t).toBeLessThan(3000)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("hi")
  })

  test("timeout kills the whole process group", async () => {
    const marker = `baton-rc-${process.pid}-${Date.now()}`
    const t = performance.now()
    await runCapture(["sh", "-c", `sh -c 'sleep 30; echo ${marker}' & wait`], { timeoutMs: 300 })
    expect(performance.now() - t).toBeLessThan(3000)
    await Bun.sleep(100)
    const ps = await runCapture(["ps", "-axo", "command"])
    expect(ps.stdout).not.toContain(marker)
  })
})
