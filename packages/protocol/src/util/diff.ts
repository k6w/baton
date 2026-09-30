import type { DiffHunkLine } from "../events.ts"

/**
 * Line diff (Myers O(ND), bounded memory; huge/very different inputs degrade to prefix/suffix trim + replace) producing unified-style lines with old/new line numbers.
 * `context` limits unchanged lines kept around changes (Infinity keeps all).
 */
export function diffLines(oldText: string | null | undefined, newText: string | null | undefined, context = 3): DiffHunkLine[] {
  const a = splitLines(oldText ?? "")
  const b = splitLines(newText ?? "")
  const ops = diffOps(a, b)
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

/**
 * Parse a unified diff (git / apply_patch output) into per-file lines.
 * Hunk bodies are consumed using the `@@ -a,b +c,d @@` counts, so content lines that look like
 * headers (`--- x`, `+++ y`) are kept as content; `---`/`+++` pairs outside hunks start a new file.
 */
export function parseUnifiedDiff(patch: string): { path?: string; lines: DiffHunkLine[] }[] {
  type File = { path?: string; lines: DiffHunkLine[] }
  const files: File[] = []
  let cur: File | undefined
  // `fresh`: entry opened by `diff --git` that hasn't seen its `---` header yet.
  let fresh = false
  let oldLn = 0
  let newLn = 0
  let oldRem = 0
  let newRem = 0
  // `loose`: inside a hunk without counts (bare `@@`) — consume +/-/space lines until a header.
  let loose = false
  const open = (): File => {
    const f: File = { lines: [] }
    files.push(f)
    cur = f
    return f
  }
  const lines = patch.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).replace(/\r$/, "")
    if (oldRem > 0 || newRem > 0) {
      const f = cur as File
      const c = raw[0]
      if (c === "+" && newRem > 0) {
        f.lines.push({ kind: "add", text: raw.slice(1), newLine: newLn++ })
        newRem--
        continue
      }
      if (c === "-" && oldRem > 0) {
        f.lines.push({ kind: "del", text: raw.slice(1), oldLine: oldLn++ })
        oldRem--
        continue
      }
      if ((c === " " || raw === "") && oldRem > 0 && newRem > 0) {
        f.lines.push({ kind: "ctx", text: raw.slice(1), oldLine: oldLn++, newLine: newLn++ })
        oldRem--
        newRem--
        continue
      }
      if (c === "\\") continue
      // Malformed / truncated hunk: fall through to header handling.
      oldRem = 0
      newRem = 0
    }
    if (raw.startsWith("\\")) continue
    if (raw.startsWith("diff --git")) {
      open()
      fresh = true
      loose = false
      continue
    }
    if (raw.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      if (!cur || !fresh) open()
      fresh = false
      loose = false
      continue
    }
    if (raw.startsWith("+++ ") && (!loose || (lines[i - 1] ?? "").startsWith("--- "))) {
      const f = cur && (fresh || cur.lines.length === 0) ? cur : open()
      fresh = false
      loose = false
      f.path = raw.slice(4).replace(/\t.*$/, "").replace(/^b\//, "").trim()
      continue
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (h) {
      oldLn = Number(h[1])
      newLn = Number(h[3])
      oldRem = h[2] === undefined ? 1 : Number(h[2])
      newRem = h[4] === undefined ? 1 : Number(h[4])
      if (!cur) open()
      fresh = false
      loose = false
      continue
    }
    if (raw.startsWith("@@")) {
      if (!cur) open()
      fresh = false
      loose = true
      continue
    }
    if (!cur || !loose) continue
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

type Op = "=" | "-" | "+"

/** Inputs above this many lines (either side) skip whole-file Myers and diff only the trimmed middle. */
const MAX_FULL_LINES = 4000
/** Cap on stored Myers trace entries (~4 bytes each) before giving up on a minimal diff. */
const MAX_TRACE = 1 << 23

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0) return new Array<Op>(m).fill("+")
  if (m === 0) return new Array<Op>(n).fill("-")
  if (n <= MAX_FULL_LINES && m <= MAX_FULL_LINES) {
    const ops = myers(a, b, MAX_TRACE)
    if (ops) return ops
  }
  // Large or very different inputs: trim the common prefix/suffix, then diff the middle with a
  // bounded Myers, falling back to "delete old middle, add new middle".
  let pre = 0
  while (pre < n && pre < m && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++
  const am = a.slice(pre, n - suf)
  const bm = b.slice(pre, m - suf)
  let mid: Op[] | undefined
  if (am.length === 0 || bm.length === 0) mid = undefined
  else mid = myers(am, bm, MAX_TRACE)
  mid ??= [...new Array<Op>(am.length).fill("-"), ...new Array<Op>(bm.length).fill("+")]
  return [...new Array<Op>(pre).fill("="), ...mid, ...new Array<Op>(suf).fill("=")]
}

/**
 * Myers O(ND) diff. Stores only the live diagonals per step (O(D²) memory); returns undefined
 * when that would exceed `budget` entries.
 */
function myers(a: string[], b: string[], budget: number): Op[] | undefined {
  const n = a.length
  const m = b.length
  const max = n + m
  const v = new Int32Array(2 * max + 2)
  // trace[d] holds v[k] for k in [-d, d] (index k + d), as it was before step d.
  const trace: Int32Array[] = []
  let used = 0
  outer: for (let d = 0; d <= max; d++) {
    used += 2 * d + 1
    if (used > budget) return undefined
    trace.push(v.slice(max - d, max + d + 1))
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
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d] as Int32Array
    const at = (k: number) => (k < -d || k > d ? 0 : (vd[k + d] ?? 0))
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1
    else prevK = k - 1
    const prevX = at(prevK)
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
