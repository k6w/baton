/**
 * Git-backed workspace snapshots used to recover diffs for edits Codex makes through shell
 * commands (`sed -i`, `cat > file`, …). Those never show up as `fileChange` items or in
 * `turn/diff/updated`, so without this baton would see the command but not the change.
 *
 * Snapshots go through a private index file (GIT_INDEX_FILE) and `git write-tree`, so the
 * user's index, HEAD and working tree are never touched. Untracked files are included and
 * .gitignore is respected. Only the object database receives (gc-able) loose objects.
 */
import { realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DiffHunkLine } from "@batonsh/protocol"
import { newId, runCapture } from "@batonsh/protocol"

export interface FileDiff {
  /** Absolute path. */
  path: string
  lines: DiffHunkLine[]
  added: number
  removed: number
  created: boolean
  deleted: boolean
}

export class GitSnapshotter {
  private indexFile = join(tmpdir(), `baton-codex-${newId()}.index`)
  private root: string | undefined
  /** Repo root spelled the way the caller spells cwd (git reports the realpath). */
  private displayRoot: string | undefined
  private disabled = false

  constructor(
    private readonly cwd: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  private async git(args: string[], env: Record<string, string> = {}): Promise<string | undefined> {
    const r = await runCapture(["git", "-c", "core.quotepath=off", ...args], {
      cwd: this.root ?? this.cwd,
      env: { GIT_INDEX_FILE: this.indexFile, GIT_OPTIONAL_LOCKS: "0", ...env },
      timeoutMs: 30_000,
    })
    if (r.code !== 0) {
      this.log(`git ${args[0]} failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`)
      return undefined
    }
    return r.stdout
  }

  /** Tree id capturing the current working tree, or undefined when not a git repo. */
  async snapshot(): Promise<string | undefined> {
    if (this.disabled) return undefined
    if (!this.root) {
      const top = await runCapture(["git", "rev-parse", "--show-toplevel"], { cwd: this.cwd, timeoutMs: 10_000 }).catch(() => undefined)
      if (top?.code !== 0) {
        this.disabled = true
        this.log("workspace is not a git repository; shell-edit diffs disabled")
        return undefined
      }
      this.root = top.stdout.trim()
      this.displayRoot = displayRoot(this.cwd, this.root)
    }
    if ((await this.git(["add", "-A", "."])) === undefined) return undefined
    return (await this.git(["write-tree"]))?.trim() || undefined
  }

  /** Per-file diffs between two snapshots. */
  async diff(from: string, to: string): Promise<FileDiff[]> {
    if (from === to || !this.root) return []
    // NUL-separated names are unquoted and unambiguous (spaces, " b/", quotes, newlines).
    const names = await this.git(["diff", "--name-status", "-z", "--no-renames", from, to])
    if (!names) return []
    const root = this.displayRoot ?? this.root
    const out: FileDiff[] = []
    const parts = names.split("\0")
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i] as string
      const rel = parts[i + 1] as string
      if (!status || !rel) continue
      const patch = await this.git(["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-renames", from, to, "--", rel])
      const lines = patch ? parseHunks(patch) : []
      let added = 0
      let removed = 0
      for (const l of lines) {
        if (l.kind === "add") added++
        else if (l.kind === "del") removed++
      }
      out.push({ path: join(root, rel), lines, added, removed, created: status.startsWith("A"), deleted: status.startsWith("D") })
    }
    return out
  }

  dispose(): void {
    rmSync(this.indexFile, { force: true })
  }
}

/** Re-express `root` (a realpath) relative to how `cwd` is spelled, e.g. /var vs /private/var. */
function displayRoot(cwd: string, root: string): string {
  try {
    const real = realpathSync(cwd)
    if (real === root) return cwd
    if (real.startsWith(`${root}/`)) {
      const depth = real.slice(root.length + 1).split("/").length
      return join(cwd, ...Array<string>(depth).fill(".."))
    }
  } catch {}
  return root
}

/** Split `git diff` output into files (keeps paths for deletions, which parseUnifiedDiff can't). */
export function splitGitPatch(patch: string, root: string): FileDiff[] {
  const out: FileDiff[] = []
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk)
    if (!header) continue
    const rel = header[2] as string
    const lines = parseHunks(chunk)
    let added = 0
    let removed = 0
    for (const l of lines) {
      if (l.kind === "add") added++
      else if (l.kind === "del") removed++
    }
    out.push({
      path: join(root, rel),
      lines,
      added,
      removed,
      created: /^new file mode/m.test(chunk),
      deleted: /^deleted file mode/m.test(chunk),
    })
  }
  return out
}

/**
 * Parse the hunks of a single-file unified diff, counting lines from each `@@` header so content
 * lines that look like headers ("--- x", "+++ y") are never mistaken for them.
 */
export function parseHunks(patch: string): DiffHunkLine[] {
  const out: DiffHunkLine[] = []
  let oldLn = 0
  let newLn = 0
  let oldLeft = 0
  let newLeft = 0
  for (const raw of patch.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = raw[0]
      if (c === "+" && newLeft > 0) {
        out.push({ kind: "add", text: raw.slice(1), newLine: newLn++ })
        newLeft--
      } else if (c === "-" && oldLeft > 0) {
        out.push({ kind: "del", text: raw.slice(1), oldLine: oldLn++ })
        oldLeft--
      } else if ((c === " " || raw === "") && oldLeft > 0 && newLeft > 0) {
        out.push({ kind: "ctx", text: raw.slice(1), oldLine: oldLn++, newLine: newLn++ })
        oldLeft--
        newLeft--
      }
      // "\ No newline at end of file" and anything unexpected: skip.
      continue
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (!h) continue
    oldLn = Number(h[1])
    oldLeft = h[2] === undefined ? 1 : Number(h[2])
    newLn = Number(h[3])
    newLeft = h[4] === undefined ? 1 : Number(h[4])
  }
  return out
}
