/**
 * Client-side `fs/read_text_file` / `fs/write_text_file`, confined to the session cwd.
 * Paths are checked both lexically and after resolving symlinks (so a link inside the
 * workspace can't be used to escape it, and macOS /var ↔ /private/var aliases work).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export class WorkspaceFs {
  readonly root: string
  private realRoot: string

  constructor(root: string) {
    this.root = resolve(root)
    this.realRoot = safeRealpath(this.root)
  }

  /** Absolute, validated path; throws if it escapes the workspace. */
  resolvePath(p: string): string {
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.root, p)
    const lexicallyInside = inside(this.root, abs) || inside(this.realRoot, abs)
    if (!lexicallyInside) throw new Error(`path is outside the workspace (${this.root}): ${p}`)
    // Where would an access actually land? Follows symlinks — including dangling ones, which
    // `existsSync`/`realpath` treat as missing but a write would happily follow out of the tree.
    const real = landingPath(abs)
    if (!inside(this.realRoot, real) && !inside(this.root, real)) throw new Error(`path resolves outside the workspace (${this.root}): ${p}`)
    return abs
  }

  /** Workspace-relative display path (falls back to the input). */
  display(p: string): string {
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.root, p)
    for (const r of [this.root, this.realRoot]) {
      if (inside(r, abs)) return relative(r, abs) || "."
    }
    return p
  }

  read(p: string, line?: number | null, limit?: number | null): string {
    const abs = this.resolvePath(p)
    if (!existsSync(abs)) throw Object.assign(new Error(`file not found: ${p}`), { code: "ENOENT" })
    const text = readFileSync(abs, "utf8")
    if (line == null && limit == null) return text
    const lines = text.split("\n")
    const start = Math.max(0, (line ?? 1) - 1)
    const end = limit != null ? start + Math.max(0, limit) : lines.length
    return lines.slice(start, end).join("\n")
  }

  /** Writes the file and returns the previous content (null if it didn't exist). */
  write(p: string, content: string): { path: string; oldText: string | null } {
    const abs = this.resolvePath(p)
    const oldText = existsSync(abs) ? readFileSync(abs, "utf8") : null
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    return { path: abs, oldText }
  }
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Real path a read/write of `p` would hit: realpath of the deepest entry that exists (lstat),
 * with dangling symlinks followed by hand (their target may not exist yet), plus the
 * not-yet-existing remainder.
 */
function landingPath(p: string, depth = 0): string {
  if (depth > 40) throw new Error(`too many levels of symbolic links: ${p}`)
  const rest: string[] = []
  let probe = p
  for (;;) {
    let isLink: boolean | undefined
    try {
      isLink = lstatSync(probe).isSymbolicLink()
    } catch {}
    if (isLink !== undefined) {
      let real: string | undefined
      try {
        real = realpathSync(probe)
      } catch {}
      if (real !== undefined) return join(real, ...rest)
      if (isLink) return landingPath(join(resolve(dirname(probe), readlinkSync(probe)), ...rest), depth + 1)
      return join(probe, ...rest)
    }
    const parent = dirname(probe)
    if (parent === probe) return p
    rest.unshift(basename(probe))
    probe = parent
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
