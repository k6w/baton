import type { DiffHunkLine } from "../events.ts"

/**
 * Line diff (Myers O(ND)) producing unified-style lines with old/new line numbers.
 * `context` limits unchanged lines kept around changes (Infinity keeps all).
 */
export function diffLines(oldText: string | null | undefined, newText: string | null | undefined, context = 3): DiffHunkLine[] {
  const a = splitLines(oldText ?? "")
  const b = splitLines(newText ?? "")
  const ops = myers(a, b)
  const out: DiffHunkLine[] = []
  let i = 0
  let j = 0
  for (const op of ops) {
    if (op === "=") out.push({ kind: "ctx", text: a[i] ?? "", oldLine: ++i, newLine: ++j })
    else if (op === "-") out.push({ kind: "del", text: a[i] ?? "", oldLine: ++i })
    else out.push({ kind: "add", text: b[j] ?? "", newLine: ++j })
  }
  if (!Number.isFinite(context)) return out
  const keep = new Array<boolean>(out.length).fill(false)
  out.forEach((l, idx) => {
    if (l.kind === "ctx") return
    for (let k = Math.max(0, idx - context); k <= Math.min(out.length - 1, idx + context); k++) keep[k] = true
  })
  return out.filter((_, idx) => keep[idx])
}

export function diffStat(lines: DiffHunkLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === "add") added++
    else if (l.kind === "del") removed++
  }
  return { added, removed }
}

/** Parse a unified diff (git / apply_patch output) into lines. */
export function parseUnifiedDiff(patch: string): { path?: string; lines: DiffHunkLine[] }[] {
  const files: { path?: string; lines: DiffHunkLine[] }[] = []
  let cur: { path?: string; lines: DiffHunkLine[] } | undefined
  let oldLn = 0
  let newLn = 0
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git") || (raw.startsWith("--- ") && !cur)) {
      cur = { lines: [] }
      files.push(cur)
      continue
    }
    if (raw.startsWith("+++ ")) {
      if (!cur) {
        cur = { lines: [] }
        files.push(cur)
      }
      cur.path = raw.slice(4).replace(/^b\//, "").trim()
      continue
    }
    if (raw.startsWith("--- ") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file")) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (h) {
      oldLn = Number(h[1])
      newLn = Number(h[2])
      if (!cur) {
        cur = { lines: [] }
        files.push(cur)
      }
      continue
    }
    if (!cur) continue
    if (raw.startsWith("+")) cur.lines.push({ kind: "add", text: raw.slice(1), newLine: newLn++ })
    else if (raw.startsWith("-")) cur.lines.push({ kind: "del", text: raw.slice(1), oldLine: oldLn++ })
    else if (raw.startsWith(" ")) cur.lines.push({ kind: "ctx", text: raw.slice(1), oldLine: oldLn++, newLine: newLn++ })
  }
  return files
}

function splitLines(s: string): string[] {
  if (s === "") return []
  const lines = s.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

function myers(a: string[], b: string[]): ("=" | "-" | "+")[] {
  const n = a.length
  const m = b.length
  const max = n + m
  const v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      const idx = k + max
      let x: number
      if (k === -d || (k !== d && (v[idx - 1] ?? 0) < (v[idx + 1] ?? 0))) x = v[idx + 1] ?? 0
      else x = (v[idx - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[idx] = x
      if (x >= n && y >= m) break outer
    }
  }
  const ops: ("=" | "-" | "+")[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d] as Int32Array
    const k = x - y
    const idx = k + max
    let prevK: number
    if (k === -d || (k !== d && (vd[idx - 1] ?? 0) < (vd[idx + 1] ?? 0))) prevK = k + 1
    else prevK = k - 1
    const prevX = vd[prevK + max] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push("=")
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push("+")
      else ops.push("-")
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}
