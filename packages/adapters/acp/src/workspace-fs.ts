/**
 * Client-side `fs/read_text_file` / `fs/write_text_file`, confined to the session cwd.
 * Paths are checked both lexically and after resolving symlinks (so a link inside the
 * workspace can't be used to escape it, and macOS /var ↔ /private/var aliases work).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

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
    // resolve symlinks of the deepest existing ancestor
    let probe = abs
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
    const real = safeRealpath(probe)
    if (!inside(this.realRoot, real) && !inside(this.root, real))
      throw new Error(`path resolves outside the workspace (${this.root}): ${p}`)
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

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
