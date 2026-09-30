#!/usr/bin/env bun
/**
 * baton — multi-agent orchestration TUI.
 *
 *   baton                  start (or attach to) Baton in this project; sets the project up on first run
 *   baton demo [task]      try it with simulated agents (no tokens spent)
 *   baton run "<task>"     headless run, streams progress (--json for raw events)
 *   baton init             (re)run project setup
 *   baton doctor           check terminal, agents, auth and config
 *   baton agents           list installed agent CLIs
 *   baton ps | stop        daemon status / stop the daemon (and all agents)
 *   baton config …         get <key> | explain <key> | path | schema
 *   baton theme …          list | set <name>
 *   baton trust            review + allow this project's commands/plugins (--revoke to undo)
 *   baton history          past runs of this project (resume them from the TUI: ctrl+r)
 *   baton export <run>     a run as Markdown (--format jsonl for raw events)
 *   baton daemon           run the daemon in the foreground (normally started automatically)
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runDaemonProcess, socketPathFor, startDaemon } from "@batonsh/daemon"
import { BatonConfig, configDir, configJsonSchema, findProjectRoot, getPath, loadConfig, projectPaths, revokeTrust, trustEntries } from "@batonsh/kernel"
import { BatonClient, connect, discoverSocket } from "@batonsh/sdk"
import { listThemes, loadTheme } from "@batonsh/themes"
import { runHeadless } from "./headless.ts"
import { detectAgents, initProject, isInitialized } from "./init.ts"
import { c } from "./style.ts"

const c_ = c

const VERSION = "0.1.0"

interface Args {
  _: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === "--") {
      out._.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined]
      if (v !== undefined) out.flags[k] = v
      else if (
        argv[i + 1] &&
        !argv[i + 1]!.startsWith("-") &&
        ["root", "theme", "layout", "timeout", "approve", "workers", "speed", "orchestrator", "format"].includes(k)
      )
        out.flags[k] = argv[++i] as string
      else out.flags[k] = true
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) out.flags[{ y: "yes", h: "help", v: "version", j: "json" }[ch] ?? ch] = true
    } else out._.push(a)
  }
  return out
}

/** How to re-launch ourselves as a detached daemon (works from source and compiled). */
function selfCommand(): string[] {
  const main = Bun.main
  const compiled = main.startsWith("/$bunfs/") || main.startsWith("B:\\~BUN")
  return compiled ? [process.execPath] : [process.execPath, main]
}

function overridesFrom(flags: Args["flags"]): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  const ui: Record<string, unknown> = {}
  if (typeof flags.theme === "string") ui.theme = flags.theme
  if (typeof flags.layout === "string") ui.layout = flags.layout
  if (Object.keys(ui).length) o.ui = ui
  if (typeof flags.orchestrator === "string") o.orchestrator = { agent: flags.orchestrator }
  return o
}

async function startTui(client: BatonClient, root: string, flags: Args["flags"]): Promise<void> {
  // The daemon's resolved config is authoritative (it may run with different overrides, e.g. demo);
  // UI-only flags from this invocation are layered on top.
  const local = loadConfig({ projectRoot: root, overrides: overridesFrom(flags) }).config
  const remote = await client
    .call("config.get", {})
    .then((r) => BatonConfig.safeParse(r.config))
    .catch(() => undefined)
  const config = remote?.success ? { ...remote.data, ui: { ...remote.data.ui, ...(flags.theme || flags.layout ? local.ui : {}) }, keys: local.keys } : local
  const live = await client.live()
  const { runTui } = await import("@batonsh/tui")
  const res = await runTui({ client, live, config })
  if (res.shutdown) await client.shutdown().catch(() => {})
  await live.stop().catch(() => {})
  client.close()
}

async function cmdStart(args: Args) {
  const root = resolve(typeof args.flags.root === "string" ? args.flags.root : findProjectRoot(process.cwd()))
  if (!isInitialized(root)) {
    await initProject({ root, yes: !!args.flags.yes })
  }
  const client = await connect({ cwd: root, daemonCommand: (r) => [...selfCommand(), "daemon", "--root", r], clientName: "tui" })
  const task = args._.slice(0).join(" ").trim()
  let submitError: unknown
  if (task) client.submit(task).catch((e) => (submitError = e))
  await startTui(client, root, args.flags)
  if (submitError) console.error(c.red(`baton: the task wasn't sent: ${submitError instanceof Error ? submitError.message : submitError}`))
  process.exit(submitError ? 1 : 0)
}

async function cmdDemo(args: Args) {
  const root = mkdtempSync(join(tmpdir(), "baton-demo-"))
  Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  const socketPath = join(root, "baton.sock")
  const daemon = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath,
    demo: { workers: Number(args.flags.workers) || 5, speed: Number(args.flags.speed) || 1 },
    overrides: { project: { name: "portfolio" }, ...overridesFrom(args.flags) },
  })
  const client = await BatonClient.open(socketPath, "tui")
  const task = args._.join(" ").trim() || "fix the typo in the README"
  setTimeout(() => void client.submit(task).catch(() => {}), 600)
  await startTui(client, root, args.flags)
  await daemon.stop()
  process.exit(0)
}

async function cmdDaemon(args: Args) {
  const root = resolve(typeof args.flags.root === "string" ? args.flags.root : findProjectRoot(process.cwd()))
  const paths = projectPaths(root)
  mkdirSync(paths.run, { recursive: true })
  const log = (msg: string) => {
    try {
      appendFileSync(paths.log, `${new Date().toISOString()} ${msg}\n`)
    } catch {}
  }
  process.on("uncaughtException", (e) => log(`uncaught: ${e.stack ?? e}`))
  process.on("unhandledRejection", (e) => log(`unhandled: ${e instanceof Error ? e.stack : e}`))
  log(`daemon starting pid=${process.pid} root=${root}`)
  await runDaemonProcess(root, { overrides: overridesFrom(args.flags), demo: !!args.flags.demo })
  log(`daemon ready socket=${socketPathFor(root)}`)
}

async function cmdRun(args: Args) {
  const task = args._.join(" ").trim()
  if (!task) {
    console.error('usage: baton run "<task>" [--json] [--approve all|none] [--timeout 3600]')
    process.exit(2)
  }
  const approve = args.flags.approve ?? "ask"
  if (approve !== "ask" && approve !== "all" && approve !== "none") {
    console.error(`baton run: --approve must be ask, all or none (got ${JSON.stringify(approve)})`)
    process.exit(2)
  }
  const root = findProjectRoot(process.cwd())
  // headless never creates a git repo on its own — that needs -y
  if (!isInitialized(root)) await initProject({ root, yes: true, gitInit: !!args.flags.yes, quiet: !!args.flags.json })
  const client = await connect({ cwd: root, daemonCommand: (r) => [...selfCommand(), "daemon", "--root", r], clientName: "cli" })
  const code = await runHeadless(client, task, {
    json: !!args.flags.json,
    timeoutS: Number(args.flags.timeout) || undefined,
    approve,
  })
  client.close()
  process.exit(code)
}

async function cmdDoctor() {
  const root = findProjectRoot(process.cwd())
  const ok = (s: string) => console.log(`  ${c.green("✓")} ${s}`)
  const warn = (s: string) => console.log(`  ${c.yellow("!")} ${s}`)
  const bad = (s: string) => console.log(`  ${c.red("✗")} ${s}`)
  console.log(c.bold(`baton ${VERSION} doctor`))
  console.log(c.dim(`  project ${root}`))
  console.log(c.bold("\nRuntime"))
  ok(`bun ${Bun.version} · ${process.platform}/${process.arch}`)
  console.log(c.bold("\nTerminal"))
  const term = process.env.TERM_PROGRAM ?? process.env.TERM ?? "unknown"
  ok(`${term}${process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""} · TERM=${process.env.TERM ?? "?"}`)
  if (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit") ok("truecolor")
  else warn("COLORTERM is not truecolor — colors may be approximated (export COLORTERM=truecolor)")
  if (process.env.TMUX) warn("inside tmux — enable `set -g allow-passthrough on` for logos")
  if (/kitty|ghostty|wezterm|iterm|konsole|warp/i.test(term)) ok("likely supports inline images (logos)")
  else warn("terminal may not support Kitty/Sixel images — logos fall back to glyphs (ui.icons)")
  console.log(c.bold("\nAgents"))
  for (const a of await detectAgents()) {
    if (!a.installed) {
      console.log(`  ${c.dim(`○ ${a.id}`)}`)
      continue
    }
    const auth =
      a.auth === "ok" ? c.green("logged in") : a.auth === "missing" ? c.red(`not logged in${a.authHint ? ` — ${a.authHint}` : ""}`) : c.yellow("auth unknown")
    console.log(`  ${c.green("●")} ${a.id.padEnd(14)} ${c.dim(`v${a.version ?? "?"} · ${a.protocols.join(", ")}`)}  ${auth}`)
  }
  console.log(c.bold("\nConfig"))
  const loaded = loadConfig({ projectRoot: root })
  for (const l of loaded.layers) ok(`${l.name}${l.path ? ` ${c.dim(l.path)}` : ""}`)
  if (!isInitialized(root)) warn("project not set up yet — run `baton` or `baton init`")
  for (const e of loaded.errors) bad(e)
  if (loaded.untrusted.length)
    warn(`${loaded.untrusted.length} project setting(s) held back until trusted: ${loaded.untrusted.map((e) => e.path).join(", ")} — run \`baton trust\``)
  console.log(c.bold("\nDaemon"))
  const sock = discoverSocket(root)
  if (existsSync(sock)) {
    try {
      const cl = await BatonClient.open(sock, "doctor")
      const snap = await cl.call("state.snapshot", {})
      ok(`running · pid ${cl.daemonPid} · ${snap.agents.filter((a) => a.status !== "exited").length} agents`)
      cl.close()
    } catch {
      warn(`stale socket at ${sock}`)
    }
  } else ok("not running (starts automatically)")
}

async function cmdAgents() {
  for (const a of await detectAgents()) {
    const status = a.installed ? c.green("●") : c.dim("○")
    const detail = a.installed
      ? `${c.dim(`v${a.version ?? "?"}`)} ${a.auth === "ok" ? c.green("logged in") : a.auth === "missing" ? c.red("not logged in") : c.dim("auth ?")}`
      : c.dim("not installed")
    console.log(`${status} ${a.id.padEnd(14)} ${a.displayName.padEnd(18)} ${detail}`)
  }
}

async function cmdPs() {
  const root = findProjectRoot(process.cwd())
  const sock = discoverSocket(root)
  if (!existsSync(sock)) return console.log(c.dim("no daemon running for this project"))
  const cl = await BatonClient.open(sock, "cli")
  const snap = await cl.call("state.snapshot", {})
  console.log(`${c.bold("batond")} pid ${cl.daemonPid} · run ${snap.runId} · mode ${snap.mode}`)
  for (const a of snap.agents.filter((x) => x.status !== "exited")) {
    console.log(
      `  ${a.status === "busy" ? c.yellow("●") : c.green("●")} ${a.name.padEnd(14)} ${c.dim(`${a.adapter}${a.model ? `/${a.model}` : ""}`)} ${a.status}${a.label ? c.dim(` · ${a.label}`) : ""}`,
    )
  }
  cl.close()
}

async function cmdStop() {
  const root = findProjectRoot(process.cwd())
  const sock = discoverSocket(root)
  if (!existsSync(sock)) return console.log(c.dim("no daemon running"))
  const cl = await BatonClient.open(sock, "cli")
  await cl.shutdown()
  cl.close()
  console.log("stopped")
}

async function cmdConfig(args: Args) {
  const root = findProjectRoot(process.cwd())
  const sub = args._[0] ?? "path"
  const loaded = loadConfig({ projectRoot: root })
  if (sub === "path") {
    console.log(`global   ${join(configDir(), "config.toml")}`)
    console.log(`project  ${projectPaths(root).config}`)
  } else if (sub === "get") {
    const v = args._[1] ? getPath(loaded.config, args._[1]) : loaded.config
    console.log(typeof v === "object" ? JSON.stringify(v, null, 2) : String(v))
  } else if (sub === "explain") {
    const key = args._[1]
    if (!key) throw new Error("usage: baton config explain <key>")
    const v = getPath(loaded.config, key)
    const src = Object.entries(loaded.provenance).filter(([k]) => k === key || k.startsWith(`${key}.`))
    console.log(`${c.bold(key)} = ${JSON.stringify(v)}`)
    for (const e of loaded.untrusted.filter((u) => u.path === key || u.path.startsWith(`${key}.`) || key.startsWith(`${u.path}.`)))
      console.log(c.yellow(`  ${e.path} = ${JSON.stringify(e.value)} is held back until \`baton trust\``))
    if (src.length === 0) console.log(c.dim("  (built-in default)"))
    for (const [k, layer] of src) {
      const l = loaded.layers.find((x) => x.name === layer)
      console.log(`  ${k} ← ${c.bold(layer)}${l?.path ? c.dim(` ${l.path}`) : ""}`)
    }
  } else if (sub === "reload") {
    const sock = discoverSocket(root)
    if (!existsSync(sock)) return console.log(c.dim("no daemon running — the config applies when it starts"))
    const cl = await BatonClient.open(sock, "cli")
    const { errors } = await cl.call("config.reload", {})
    cl.close()
    for (const e of errors) console.log(c.yellow(e))
    if (!errors.length) console.log(c.green("reloaded"))
  } else if (sub === "schema") {
    console.log(JSON.stringify(configJsonSchema(), null, 2))
  } else if (sub === "defaults") {
    console.log(JSON.stringify(BatonConfig.parse({}), null, 2))
  } else throw new Error(`unknown: baton config ${sub}`)
}

async function cmdTheme(args: Args) {
  const root = findProjectRoot(process.cwd())
  const dirs = { global: join(configDir(), "themes"), project: join(projectPaths(root).dir, "themes") }
  const sub = args._[0] ?? "list"
  if (sub === "list") {
    for (const t of listThemes(dirs)) {
      const th = loadTheme(t.name, { appearance: t.appearance, dirs })
      const sw = ["primary", "accent", "success", "warning", "error", "agentClaude"]
        .map((k) => c.hex((th as unknown as Record<string, string>)[k]!)("■"))
        .join("")
      console.log(`${sw}  ${t.name.padEnd(24)} ${c.dim(t.source === "builtin" ? (t.appearance ?? "") : `${t.source} ${t.path ?? ""}`)}`)
    }
  } else if (sub === "set") {
    const name = args._[1]
    if (!name) throw new Error("usage: baton theme set <name>")
    if (!listThemes(dirs).some((t) => t.name === name) && name !== "system") throw new Error(`unknown theme "${name}" (baton theme list)`)
    const { savePrefs, loadPrefs } = await import("@batonsh/tui")
    savePrefs({ ...loadPrefs(), theme: name })
    console.log(`theme → ${name}`)
  } else throw new Error(`unknown: baton theme ${sub}`)
}

async function cmdTrust(args: Args) {
  const root = findProjectRoot(process.cwd())
  if (args.flags.revoke) {
    revokeTrust(root)
    return console.log(`revoked trust for ${root} — commands, plugins and widened permissions from its config are held back again`)
  }
  const { untrusted } = loadConfig({ projectRoot: root })
  if (untrusted.length === 0) return console.log(c.green("nothing to trust — every project setting already applies"))
  console.log(`${c.bold("This project's config wants to")} ${c.dim(root)}`)
  for (const e of untrusted) {
    const v = typeof e.value === "string" ? e.value : JSON.stringify(e.value)
    console.log(`  ${c.yellow("•")} ${e.path.padEnd(28)} ${v.length > 90 ? `${v.slice(0, 89)}…` : v}`)
  }
  console.log(c.dim("These run commands, load code or widen agent permissions. Only trust repositories you'd run `make` in."))
  if (!args.flags.yes && process.stdin.isTTY) {
    process.stdout.write("Trust these settings? [y/N] ")
    const answer = await new Promise<string>((res) => process.stdin.once("data", (d) => res(String(d).trim().toLowerCase())))
    process.stdin.pause()
    if (answer !== "y" && answer !== "yes") return console.log("not trusted")
  }
  trustEntries(root, untrusted)
  console.log(c.green("trusted — run `baton config reload` (or restart: baton stop && baton) to apply; plugins load on the next daemon start"))
}

async function daemonClient(): Promise<BatonClient> {
  const root = findProjectRoot(process.cwd())
  return connect({ cwd: root, daemonCommand: (r) => [...selfCommand(), "daemon", "--root", r], clientName: "cli" })
}

async function cmdHistory() {
  const c = await daemonClient()
  const { runs } = await c.call("runs.list", { limit: 50 })
  for (const r of runs)
    console.log(
      `${r.current ? c_.green("●") : " "} ${c_.dim(r.runId)}  ${new Date(r.startedAt).toLocaleString().padEnd(22)} ${String(r.agents).padStart(2)} agents  ${`+${r.added} −${r.removed}`.padEnd(12)} ${r.title}`,
    )
  if (!runs.length) console.log(c_.dim("no runs yet"))
  c.close()
}

async function cmdExport(args: Args) {
  const runId = args._[0]
  if (!runId) throw new Error("usage: baton export <run-id> [--format md|jsonl]   (ids: baton history)")
  const c = await daemonClient()
  const format = args.flags.format === "jsonl" ? "jsonl" : "md"
  process.stdout.write((await c.call("run.export", { runId, format })).text)
  c.close()
}

function help() {
  const b = (x: string) => c.bold(x)
  const d = (x: string) => c.dim(x)
  console.log(`${b("baton")} ${d(VERSION)} — one terminal for all your coding agents

${b("Examples")}
  baton                                   ${d("start (or re-attach) in this project; sets it up on first run")}
  baton "add tests for src/auth.ts"       ${d("start with a task for the orchestrator")}
  baton demo                              ${d("see it work with simulated agents (no tokens)")}
  baton run "update the changelog" --approve all --json   ${d("headless, for scripts/CI")}

${b("Commands")}
  baton [task]          start or attach                    baton doctor          check terminal, agents, auth
  baton demo [task]     simulated agents                   baton agents          installed agent CLIs
  baton run "<task>"    headless run (--json)              baton history         past runs (resume: ctrl+r)
  baton init            re-run project setup               baton export <run>    run as Markdown (--format jsonl)
  baton ps | stop       daemon status / stop everything    baton trust           allow project commands
  baton config get|explain|path|schema|defaults            baton theme list|set <name>

${b("Flags")}
  --theme <name>  --layout <grid|list|focus|swarm|wide>  --orchestrator <adapter>  -y/--yes  --help  --version

${b("In the app")}
  @name talk to an agent · / commands · ctrl+a inbox · ctrl+d changes · ctrl+s settings · ? all keys · /guide lessons

Docs: README.md and docs/ in the Baton repository.`)
}

/** A next step for common failures. */
function hintFor(msg: string): string {
  if (/no baton daemon|daemon/i.test(msg)) return "run `baton` in the project to start it, or `baton doctor` to see what's wrong"
  if (/unknown adapter/i.test(msg)) return "`baton agents` lists what's installed; custom agents go in [agents.<name>] (docs/agents.md)"
  if (/not logged in|auth/i.test(msg)) return "log in with the agent's own CLI (claude → /login, codex login, opencode auth login)"
  if (/config/i.test(msg)) return "`baton config explain <key>` shows where a value comes from"
  if (/usage:/i.test(msg)) return "`baton --help` has examples"
  return "`baton doctor` checks your setup"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.version) return console.log(VERSION)
  if (args.flags.help) return help()
  const [cmd, ...rest] = args._
  const sub: Args = { _: rest, flags: args.flags }
  switch (cmd) {
    case undefined:
      return cmdStart(sub)
    case "demo":
      return cmdDemo(sub)
    case "daemon":
      return cmdDaemon(sub)
    case "run":
      return cmdRun(sub)
    case "init":
      await initProject({ root: findProjectRoot(process.cwd()), yes: !!args.flags.yes })
      return
    case "doctor":
      return cmdDoctor()
    case "agents":
      return cmdAgents()
    case "ps":
      return cmdPs()
    case "stop":
      return cmdStop()
    case "config":
      return cmdConfig(sub)
    case "theme":
      return cmdTheme(sub)
    case "trust":
      return cmdTrust(sub)
    case "history":
      return cmdHistory()
    case "watch": {
      const { runWatch } = await import("./watch.ts")
      const client = await daemonClient()
      await runWatch(client)
      client.close()
      return
    }
    case "export":
      return cmdExport(sub)
    case "attach":
      return cmdStart(sub)
    case "help":
      return help()
    default:
      // `baton fix the login bug` → start with that task
      return cmdStart(args)
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(c.red(`baton: ${msg}`))
  console.error(c.dim(`hint: ${hintFor(msg)}`))
  process.exit(1)
})
