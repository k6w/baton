/**
 * Project bootstrap. Running `baton` in a folder that isn't set up (or `baton init`) will:
 *   1. offer `git init` (+ initial commit) when there's no repository
 *   2. detect installed agent CLIs, their versions and whether they're logged in
 *   3. detect the toolchain (package manager, test/lint/build commands)
 *   4. create AGENTS.md (canonical) and a CLAUDE.md that imports it — never overwriting
 *   5. write .baton/config.toml with sensible choices + .baton/.gitignore
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { createInterface } from "node:readline/promises"
import { AdapterRegistry } from "@batonsh/daemon"
import { gitInfo, projectPaths } from "@batonsh/kernel"
import { type DetectResult, runCapture } from "@batonsh/protocol"
import { c } from "./style.ts"

export interface Toolchain {
  kind: string
  packageManager?: string
  commands: { test?: string; lint?: string; build?: string; typecheck?: string; dev?: string }
}

export function detectToolchain(root: string): Toolchain | undefined {
  const has = (f: string) => existsSync(join(root, f))
  if (has("package.json")) {
    let scripts: Record<string, string> = {}
    try {
      scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {}
    } catch {}
    const pm = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm"
    const runner = pm === "npm" ? "npm run" : pm
    const pick = (...names: string[]) => names.find((n) => scripts[n])
    const cmd = (n?: string) => (n ? `${runner} ${n}` : undefined)
    return {
      kind: "node",
      packageManager: pm,
      commands: {
        test: cmd(pick("test", "test:unit")),
        lint: cmd(pick("lint", "check")),
        build: cmd(pick("build")),
        typecheck: cmd(pick("typecheck", "type-check", "tsc")),
        dev: cmd(pick("dev", "start")),
      },
    }
  }
  if (has("Cargo.toml")) return { kind: "rust", packageManager: "cargo", commands: { test: "cargo test", lint: "cargo clippy", build: "cargo build" } }
  if (has("go.mod")) return { kind: "go", packageManager: "go", commands: { test: "go test ./...", lint: "go vet ./...", build: "go build ./..." } }
  if (has("pyproject.toml") || has("requirements.txt")) {
    const uv = has("uv.lock")
    return {
      kind: "python",
      packageManager: uv ? "uv" : "pip",
      commands: { test: uv ? "uv run pytest" : "pytest", lint: uv ? "uv run ruff check" : "ruff check" },
    }
  }
  if (has("Makefile")) return { kind: "make", commands: { test: "make test", build: "make" } }
  return undefined
}

export interface DetectedAgent extends DetectResult {
  id: string
  displayName: string
}

/** Order of preference when choosing defaults. */
const ORCH_PREF = ["claude", "codex", "opencode", "gemini", "cursor", "copilot", "goose", "qwen"]
const WORKER_PREF = ["codex", "claude", "opencode", "gemini", "cursor", "copilot", "goose", "qwen"]

export async function detectAgents(): Promise<DetectedAgent[]> {
  const reg = new AdapterRegistry()
  await reg.loadBuiltins()
  const all = await reg.detectAll()
  return all.filter((a) => a.id !== "mock" && a.id !== "acp")
}

export function chooseDefaults(agents: DetectedAgent[]): { orchestrator: string; worker: string } {
  // tiers: confirmed logged in → auth unknown → installed at all
  const tier = (id: string) => {
    const a = agents.find((x) => x.id === id && x.installed)
    if (!a) return 0
    return a.auth === "ok" ? 3 : a.auth === "unknown" ? 2 : 1
  }
  const best = (pref: string[], exclude?: string) => {
    let pick: string | undefined
    let score = 0
    for (const id of pref) {
      const t = tier(id)
      if (id !== exclude && t > score) {
        pick = id
        score = t
      }
    }
    return pick
  }
  const orchestrator = best(ORCH_PREF) ?? "mock"
  const worker = best(WORKER_PREF, orchestrator) ?? orchestrator
  return { orchestrator, worker }
}

export function configToml(opts: { name: string; orchestrator: string; worker: string; agents: DetectedAgent[]; toolchain?: Toolchain }): string {
  const installed = opts.agents.filter((a) => a.installed).map((a) => `${a.id} ${a.version ?? ""}`.trim())
  const verify = Object.entries(opts.toolchain?.commands ?? {})
    .filter(([k, v]) => v && k !== "dev")
    .map(([k, v]) => `#   ${k} = "${v}"`)
  return `# Baton project config — https://github.com/batonsh/baton
# Layers: built-in defaults → ~/.config/baton/config.toml → this file → .baton/config.local.toml → env → flags.
# Installed agents found at setup: ${installed.join(", ") || "none"}

[project]
name = "${opts.name}"

[orchestrator]
agent = "${opts.orchestrator}"        # any adapter or profile below
# model = "sonnet"
approval = "auto-edit"               # ask | auto-edit | auto | yolo
mode = "orchestrator"                # playbook in .baton/playbooks/<mode>.md overrides the built-in one

[defaults]
worker = "${opts.worker}"
approval = "ask"

[budget]
# run_usd = 10
# per_agent_usd = 3
max_agents = 16

[policy]
preset = "balanced"                  # strict | balanced | yolo
# [[policy.rules]]
# kinds = ["execute"]
# match = "^Bash\\\\((bun|npm) test"
# action = "allow"

[ui]
theme = "baton"                      # ctrl+t to browse; "system" uses your terminal's colors
layout = "grid"                      # grid | focus | swarm | wide
icons = "auto"                       # auto (logos when the terminal supports images) | unicode | nerd | ascii
border = "rounded"

# Agent profiles: spawn with /spawn reviewer, or let the orchestrator use them.
# [agents.reviewer]
# adapter = "codex"
# role = "reviewer"
# approval = "auto-edit"

# [roles.reviewer]
# prompt = "Review diffs from other agents. Be specific; run the tests."

# Verification commands detected for this project:
${verify.join("\n") || "#   (none detected)"}
`
}

function agentsMd(name: string, tc?: Toolchain): string {
  const cmds = Object.entries(tc?.commands ?? {}).filter(([, v]) => v)
  return `# ${name}

Guidance for AI coding agents working in this repository (read by Codex, Cursor, Gemini, Copilot, Amp, … —
CLAUDE.md imports this file).

## Commands
${cmds.length ? cmds.map(([k, v]) => `- ${k}: \`${v}\``).join("\n") : "- (add your build / test / lint commands here)"}

## Conventions
- Keep changes focused; match the surrounding code style.
- Run the tests before reporting a task as done.
`
}

export interface InitOptions {
  root: string
  yes?: boolean
  quiet?: boolean
  /** Skip the confirmation prompt but still print a summary. */
  assumeYes?: boolean
}

async function ask(q: string, def = true): Promise<boolean> {
  if (!process.stdin.isTTY) return def
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const a = (await rl.question(`${q} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase()
  rl.close()
  if (!a) return def
  return a.startsWith("y")
}

export function isInitialized(root: string): boolean {
  return existsSync(projectPaths(root).config)
}

export async function initProject(opts: InitOptions): Promise<{ created: string[]; orchestrator: string; worker: string }> {
  const root = opts.root
  const say = (s: string) => {
    if (!opts.quiet) console.log(s)
  }
  const yes = opts.yes || opts.assumeYes
  const created: string[] = []
  const name = basename(root)
  say(`${c.bold("baton")} ${c.dim("setting up")} ${c.bold(name)} ${c.dim(root)}\n`)

  // 1. git
  const git = gitInfo(root)
  if (!git.isRepo) {
    if (yes || (await ask(`  No git repository here. Run ${c.bold("git init")}?`))) {
      await runCapture(["git", "init", "-q"], { cwd: root })
      created.push("git repository")
      say(`  ${c.green("✓")} git init`)
    }
  } else say(`  ${c.green("✓")} git repo on ${c.bold(git.branch ?? "?")}${git.dirty ? c.yellow(" (uncommitted changes)") : ""}`)

  // 2. agents
  say(`  ${c.dim("…")} detecting agents`)
  const agents = await detectAgents()
  for (const a of agents.filter((x) => x.installed)) {
    const auth =
      a.auth === "ok" ? c.green("logged in") : a.auth === "missing" ? c.red(`not logged in${a.authHint ? ` — ${a.authHint}` : ""}`) : c.dim("auth unknown")
    say(`  ${c.green("●")} ${a.id.padEnd(14)} ${c.dim(`v${a.version ?? "?"}`)}  ${auth}`)
  }
  const missing = agents.filter((a) => !a.installed).map((a) => a.id)
  if (missing.length) say(`  ${c.dim(`○ not installed: ${missing.join(", ")}`)}`)
  const { orchestrator, worker } = chooseDefaults(agents)
  if (orchestrator === "mock")
    say(`  ${c.yellow("!")} no agent CLI found — using the mock agent. Install claude / codex / opencode and run ${c.bold("baton init")} again.`)

  // 3. toolchain
  const tc = detectToolchain(root)
  if (tc) say(`  ${c.green("✓")} ${tc.kind} project${tc.packageManager ? ` (${tc.packageManager})` : ""}`)

  // 4. instruction files
  const agentsPath = join(root, "AGENTS.md")
  const claudePath = join(root, "CLAUDE.md")
  if (!existsSync(agentsPath) && !existsSync(claudePath)) {
    writeFileSync(agentsPath, agentsMd(name, tc))
    writeFileSync(claudePath, "@AGENTS.md\n")
    created.push("AGENTS.md", "CLAUDE.md")
    say(`  ${c.green("✓")} created AGENTS.md (+ CLAUDE.md importing it)`)
  } else if (existsSync(agentsPath) && !existsSync(claudePath)) {
    writeFileSync(claudePath, "@AGENTS.md\n")
    created.push("CLAUDE.md")
    say(`  ${c.green("✓")} created CLAUDE.md → @AGENTS.md`)
  } else say(`  ${c.green("✓")} agent instructions present`)

  // 5. config
  const paths = projectPaths(root)
  mkdirSync(paths.dir, { recursive: true })
  if (!existsSync(paths.config)) {
    writeFileSync(paths.config, configToml({ name, orchestrator, worker, agents, toolchain: tc }))
    created.push(".baton/config.toml")
  }
  const gi = join(paths.dir, ".gitignore")
  if (!existsSync(gi)) writeFileSync(gi, "run/\nstate.db*\nworktrees/\nconfig.local.toml\n")
  say(`  ${c.green("✓")} .baton/config.toml ${c.dim(`(orchestrator: ${orchestrator}, workers: ${worker})`)}\n`)
  return { created, orchestrator, worker }
}
