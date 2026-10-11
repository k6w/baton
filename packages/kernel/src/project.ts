import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

/** Walk up from `start` looking for .baton/ then .git/; falls back to `start`. */
export function findProjectRoot(start: string = process.cwd()): string {
  let dir = resolve(start)
  let gitRoot: string | undefined
  while (true) {
    if (existsSync(join(dir, ".baton", "config.toml"))) return dir
    if (!gitRoot && existsSync(join(dir, ".git"))) gitRoot = dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return gitRoot ?? resolve(start)
}

export interface GitInfo {
  isRepo: boolean
  branch?: string
  dirty?: boolean
  remote?: string
  head?: string
}

export function gitInfo(root: string): GitInfo {
  const run = (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" })
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined
  }
  if (run(["rev-parse", "--is-inside-work-tree"]) !== "true") return { isRepo: false }
  return {
    isRepo: true,
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) ?? run(["symbolic-ref", "--short", "HEAD"]),
    dirty: (run(["status", "--porcelain"]) ?? "").length > 0,
    remote: run(["remote", "get-url", "origin"]),
    head: run(["rev-parse", "--short", "HEAD"]),
  }
}

export function projectName(root: string): string {
  return basename(root)
}

export function projectPaths(root: string) {
  const dir = join(root, ".baton")
  return {
    dir,
    config: join(dir, "config.toml"),
    localConfig: join(dir, "config.local.toml"),
    state: join(dir, "state.db"),
    run: join(dir, "run"),
    // Windows has no socket files: a named pipe, unique per project
    socket:
      process.platform === "win32"
        ? `\\\\.\\pipe\\baton-${createHash("sha1").update(resolve(root).toLowerCase()).digest("hex").slice(0, 12)}`
        : join(dir, "run", "baton.sock"),
    pidFile: join(dir, "run", "batond.pid"),
    log: join(dir, "run", "batond.log"),
    playbooks: join(dir, "playbooks"),
    themes: join(dir, "themes"),
    worktrees: join(dir, "worktrees"),
  }
}

/** Who is at the keyboard: $BATON_USER, else git's user.name, else the OS user. */
export function defaultUser(): string {
  if (process.env.BATON_USER) return process.env.BATON_USER
  try {
    const r = Bun.spawnSync(["git", "config", "--get", "user.name"], { stdout: "pipe", stderr: "ignore" })
    const name = r.stdout.toString().trim()
    if (r.exitCode === 0 && name) return name
  } catch {}
  return process.env.USER || process.env.USERNAME || "someone"
}
