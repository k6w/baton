/**
 * Path confinement: every tool path resolves inside the session cwd. Symlinks are resolved
 * (for the deepest existing ancestor, so not-yet-created files work too) before the check.
 */
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export class PathEscapeError extends Error {
  constructor(p: string) {
    super(`path "${p}" is outside the workspace — only files under the working directory can be accessed`)
    this.name = "PathEscapeError"
  }
}

export class Workspace {
  readonly root: string

  constructor(cwd: string) {
    this.root = realpathSync(cwd)
  }

  /** Absolute, symlink-resolved path inside the workspace; throws PathEscapeError otherwise. */
  resolve(p: string | undefined): string {
    const input = p?.trim() || "."
    const abs = resolve(this.root, input.startsWith("~") ? `/${input}` : input)
    const real = realish(abs)
    if (!this.contains(real)) throw new PathEscapeError(input)
    return real
  }

  contains(abs: string): boolean {
    if (abs === this.root) return true
    const rel = relative(this.root, abs)
    return !!rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)
  }

  /** Workspace-relative display path ("." for the root). */
  rel(abs: string): string {
    return relative(this.root, abs) || "."
  }
}

/** realpath of the deepest existing ancestor + the remaining (non-existent) segments. */
function realish(abs: string, depth = 0): string {
  const tail: string[] = []
  let cur = abs
  for (;;) {
    if (existsSync(cur)) {
      try {
        return join(realpathSync(cur), ...tail.reverse())
      } catch {
        return abs
      }
    }
    // a dangling symlink: follow it by hand, otherwise a write would land wherever it points
    let link: string | undefined
    try {
      if (lstatSync(cur).isSymbolicLink()) link = readlinkSync(cur)
    } catch {}
    if (link !== undefined) {
      if (depth > 32) return abs
      return join(realish(resolve(dirname(cur), link), depth + 1), ...tail.reverse())
    }
    const parent = dirname(cur)
    if (parent === cur) return abs
    tail.push(basename(cur))
    cur = parent
  }
}
