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
 *   baton web [--lan]      web view for your phone: follow the run, approve, send tasks (QR code)
 *   baton mcp              Baton as an MCP server (stdio) for other agents and apps
 *   baton export <run>     a run as Markdown (--format html for a shareable page, jsonl for raw events)
 *   baton daemon           run the daemon in the foreground (normally started automatically)
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { runDaemonProcess, socketPathFor, startDaemon } from "@batonsh/daemon"
import {
  addNote,
  BatonConfig,
  configDir,
  configJsonSchema,
  defaultUser,
  EventStore,
  FEATURES,
  type FeatureKey,
  findProjectRoot,
  getPath,
  isFeature,
  knownUpdate,
  loadConfig,
  loadRoles,
  loadSkills,
  notesPath,
  projectPaths,
  readNotes,
  revokeTrust,
  setFeature,
  trustEntries,
  updateCommand,
} from "@batonsh/kernel"
import { BATON_VERSION, CONTROL_PROTOCOL_VERSION, ControlErrorCode, REQUIRED_PARAMS } from "@batonsh/protocol"
import { BatonClient, connect, daemonListening, discoverSocket } from "@batonsh/sdk"
import { listThemes, loadTheme } from "@batonsh/themes"
import { runHeadless } from "./headless.ts"
import { ask, detectAgents, initProject, isInitialized } from "./init.ts"
import { c } from "./style.ts"
import { update } from "./update.ts"

const c_ = c

const VERSION = BATON_VERSION

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
        [
          "root",
          "theme",
          "layout",
          "timeout",
          "approve",
          "workers",
          "speed",
          "orchestrator",
          "format",
          "autonomy",
          "port",
          "title",
          "host",
          "public-url",
          "resume",
        ].includes(k)
      )
        out.flags[k] = argv[++i] as string
      else out.flags[k] = true
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) out.flags[{ y: "yes", h: "help", v: "version", j: "json", c: "continue" }[ch] ?? ch] = true
    } else out._.push(a)
  }
  return out
}

/** How to re-launch ourselves as a detached daemon (works from source and compiled). */
function selfCommand(): string[] {
  const main = Bun.main
  // compiled: scripts/build.ts stamps BATON_TARGET; the embedded entry lives in Bun's virtual
  // filesystem (/$bunfs/… on POSIX, B:\~BUN\… or B:/~BUN/… on Windows)
  const compiled = !!process.env.BATON_TARGET || /\$bunfs|~BUN/.test(main)
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

/** --yolo / --autonomy <level>: applied to the running daemon (it may already be up). */
async function applyAutonomyFlag(client: BatonClient, flags: Args["flags"]) {
  const want = flags.yolo ? "yolo" : typeof flags.autonomy === "string" ? flags.autonomy : undefined
  if (!want) return
  if (!["normal", "ask", "auto", "yolo"].includes(want)) throw new Error(`--autonomy must be normal, ask, auto or yolo (got ${want})`)
  await client.call("run.autonomy", { mode: want as "normal" | "ask" | "auto" | "yolo" })
}

async function tuiConfig(client: BatonClient, root: string, flags: Args["flags"]) {
  // The daemon's resolved config is authoritative (it may run with different overrides, e.g. demo);
  // UI-only flags from this invocation are layered on top.
  const local = loadConfig({ projectRoot: root, overrides: overridesFrom(flags) }).config
  const remote = await client
    .call("config.get", {})
    .then((r) => BatonConfig.safeParse(r.config))
    .catch(() => undefined)
  return remote?.success ? { ...remote.data, ui: { ...remote.data.ui, ...(flags.theme || flags.layout ? local.ui : {}) }, keys: local.keys } : local
}

/** Play back a past run in the TUI (read-only). */
async function replayRun(client: BatonClient, config: BatonConfig, runId: string): Promise<void> {
  const { runTui } = await import("@batonsh/tui")
  const { events } = await client.call("events.query", { runId })
  if (!events.length) throw new Error(`no events for run ${runId} (baton history lists runs)`)
  const runs = (await client.call("runs.list", { limit: 200 })).runs
  const title = runs.find((r) => r.runId === runId)?.title ?? runId
  await runTui({ client, config, replay: { events, title: `${title} · ${new Date(events[0]!.ts).toLocaleString()}` } })
}

async function startTui(client: BatonClient, root: string, flags: Args["flags"], first?: { overlay?: "history" }): Promise<void> {
  const config = await tuiConfig(client, root, flags)
  const { runTui } = await import("@batonsh/tui")
  let overlay = first?.overlay
  for (;;) {
    const live = await client.live()
    const res = await runTui({ client, live, config, overlay })
    overlay = undefined
    await live.stop().catch(() => {})
    // history → replay: show it, then come back to the live run
    if (res.replay && !client.closed) {
      await replayRun(client, config, res.replay).catch((e) => console.error(e instanceof Error ? e.message : e))
      continue
    }
    if (res.shutdown) await client.shutdown().catch(() => {})
    break
  }
  client.close()
}

async function cmdReplay(args: Args) {
  const root = findProjectRoot(process.cwd())
  const client = await connect({ cwd: root, daemonCommand: (r) => [...selfCommand(), "daemon", "--root", r], clientName: "cli" })
  const runs = (await client.call("runs.list", { limit: 200 })).runs
  const want = args._[0]
  const run = !want || want === "last" ? runs.find((r) => !r.current) : runs.find((r) => r.runId === want || r.runId.endsWith(want))
  if (!run) throw new Error(want ? `no run ${want} (baton history)` : "no past runs yet")
  await replayRun(client, await tuiConfig(client, root, args.flags), run.runId)
  client.close()
  process.exit(0)
}

async function cmdStart(args: Args) {
  const root = resolve(typeof args.flags.root === "string" ? args.flags.root : findProjectRoot(process.cwd()))
  if (!isInitialized(root)) {
    await initProject({ root, yes: !!args.flags.yes })
  }
  const upgraded = await upgradeDaemon(root, !!args.flags.yes)
  await compactLog(root)
  const client = await connect({ cwd: root, daemonCommand: (r) => [...selfCommand(), "daemon", "--root", r], clientName: "tui", user: defaultUser() })
  await applyAutonomyFlag(client, args.flags)
  // --continue: the last run · --resume <run>: that one · --resume alone: pick from the list
  // (after an upgrade restart, the run that was just stopped)
  const resume = args.flags.continue || (upgraded && args.flags.resume === undefined) ? "last" : args.flags.resume
  let runError: unknown
  if (typeof resume === "string") {
    const run = await findRun(client, resume)
    // agents come back while the screen is up (each shows up as it starts)
    client.call("run.resume", { runId: run.runId }).catch((e) => (runError = e))
  }
  const task = args._.slice(0).join(" ").trim()
  if (task) client.submit(task).catch((e) => (runError = e))
  await startTui(client, root, args.flags, { overlay: resume === true ? "history" : undefined })
  if (runError) console.error(c.red(`baton: ${runError instanceof Error ? runError.message : runError}`))
  // what the daemon's daily check found (no network here)
  const fresh = knownUpdate()
  if (fresh) console.log(`${c.yellow("↑")} Baton ${c.bold(fresh)} is available (you have ${VERSION}) — ${c.bold(updateCommand())}`)
  process.exit(runError ? 1 : 0)
}

/**
 * A daemon left running by an older Baton keeps behaving like it (and keeps the event log
 * open). Offer to restart it on this version: its agents come back with --continue.
 * True when it was stopped.
 */
async function upgradeDaemon(root: string, yes: boolean): Promise<boolean> {
  const sock = discoverSocket(root)
  if (!daemonListening(sock, root)) return false
  const old = await BatonClient.open(sock, "cli").catch(() => undefined)
  if (!old) return false
  if (!old.daemonVersion || old.daemonVersion === VERSION) {
    old.close()
    return false
  }
  // never stops running agents unasked: a script needs --yes
  const restart =
    yes ||
    (process.stdin.isTTY &&
      (await ask(`  Baton ${old.daemonVersion} is still running here (this is ${VERSION}). Restart it on ${VERSION}? Its agents stop and come right back.`)))
  if (!restart) {
    old.close()
    console.log(c.dim(`  staying on Baton ${old.daemonVersion} for now — \`baton stop\` then \`baton --continue\` switches`))
    return false
  }
  await old.shutdown().catch(() => {})
  old.close()
  const lock = join(projectPaths(root).run, "daemon.lock")
  for (let i = 0; i < 150 && (existsSync(lock) || daemonListening(sock, root)); i++) await Bun.sleep(100)
  return true
}

/** A past run by id (or the end of one), or the most recent one for "last". */
async function findRun(client: BatonClient, want: string) {
  const runs = (await client.call("runs.list", { limit: 200 })).runs
  const run = want === "last" ? runs.find((r) => !r.current) : runs.find((r) => r.runId === want || r.runId.endsWith(want))
  if (!run) throw new Error(want === "last" ? "no past runs to continue yet" : `no run ${want} (baton history lists them)`)
  return run
}

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`)

/**
 * Event logs written before 0.3.7 stored every chunk of command output with all the output
 * so far, and grew to gigabytes. Shrink one once, before the daemon opens it.
 */
async function compactLog(root: string, opts: { force?: boolean } = {}) {
  const path = projectPaths(root).state
  if (!existsSync(path)) return opts.force ? console.log(c.dim("no event log yet")) : undefined
  // the daemon has it open (a stale socket only postpones this to a later start)
  if (daemonListening(discoverSocket(root), root)) {
    if (opts.force) throw new Error("the daemon has the log open: run `baton stop` first")
    return
  }
  const store = new EventStore(path)
  try {
    if (!opts.force && !store.needsCompact()) return
    const size = store.sizeBytes()
    const say = opts.force || size > 64e6
    if (say) console.log(`  ${c.dim("…")} compacting the event log (${mb(size)}${opts.force ? "" : ", once"})`)
    const r = store.compact()
    if (say) console.log(`  ${c.green("✓")} event log ${mb(r.before)} → ${mb(r.after)}`)
  } catch (e) {
    console.error(c.yellow(`  event log not compacted: ${e instanceof Error ? e.message : e}`))
  } finally {
    store.close()
  }
}

async function cmdDemo(args: Args) {
  const root = mkdtempSync(join(tmpdir(), "baton-demo-"))
  Bun.spawnSync(["git", "init", "-q"], { windowsHide: true, cwd: root })
  const socketPath = join(root, "baton.sock")
  const daemon = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath,
    demo: { workers: Number(args.flags.workers) || 5, speed: Number(args.flags.speed) || 1 },
    overrides: { project: { name: "portfolio" }, orchestrator: { model: "simulated" }, ...overridesFrom(args.flags) },
  })
  const client = await BatonClient.open(socketPath, "tui", defaultUser())
  // --no-task: wait for you to type one
  const task = args.flags["no-task"] ? "" : args._.join(" ").trim() || "fix the typo in the README"
  if (task) setTimeout(() => void client.submit(task).catch(() => {}), 600)
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
  try {
    await runDaemonProcess(root, { overrides: overridesFrom(args.flags), demo: !!args.flags.demo })
  } catch (e) {
    // stderr goes nowhere for a detached daemon: the log is the only place this shows up
    log(`daemon failed to start: ${e instanceof Error ? e.message : e}`)
    throw e
  }
  log(`daemon ready socket=${socketPathFor(root)}`)
}

async function cmdRun(args: Args) {
  const task = args._.join(" ").trim()
  if (!task) {
    console.error('usage: baton run "<task>" [--json] [--approve all|none] [--yolo] [--timeout 3600]')
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
  const client = await connect({ cwd: root, daemonCommand: (r) => [...selfCommand(), "daemon", "--root", r], clientName: "cli", user: defaultUser() })
  await applyAutonomyFlag(client, args.flags)
  const code = await runHeadless(client, task, {
    json: !!args.flags.json,
    timeoutS: Number(args.flags.timeout) || undefined,
    approve,
  })
  client.close()
  process.exit(code)
}

/** A Nerd Font file in the usual font folders (or fc-list), by name. */
function nerdFontInstalled(): string | undefined {
  const dirs = [
    join(homedir(), "Library", "Fonts"),
    "/Library/Fonts",
    join(homedir(), ".local", "share", "fonts"),
    join(homedir(), ".fonts"),
    "/usr/share/fonts",
  ]
  for (const dir of dirs) {
    try {
      const hit = readdirSync(dir, { recursive: true })
        .map(String)
        .find((f) => /nerd ?font|NerdFont|\bNF\b|-NF[-.]/i.test(f))
      if (hit) return basename(hit).replace(/\.(ttf|otf|ttc)$/i, "")
    } catch {}
  }
  if (Bun.which("fc-list")) {
    const r = Bun.spawnSync(["fc-list", ":", "family"], { windowsHide: true, stdout: "pipe", stderr: "ignore" })
    const hit = r.stdout
      .toString()
      .split("\n")
      .find((l) => /nerd font/i.test(l))
    if (hit) return hit.split(",")[0]
  }
  return undefined
}

/** `baton protocol`: the control protocol as data (methods, required params, error codes) for SDK authors. */
function cmdProtocol() {
  console.log(
    JSON.stringify(
      {
        version: CONTROL_PROTOCOL_VERSION,
        transport: "newline-delimited JSON-RPC 2.0 over a Unix socket (<project>/.baton/run/baton.sock, or the path in .baton/run/socket-path)",
        handshake: "hello { client, version, user? } first",
        notifications: { event: "{ subscriptionId, event }", "daemon.closing": "{ reason }" },
        requiredParams: REQUIRED_PARAMS,
        errorCodes: ControlErrorCode,
        types: "packages/protocol/src/control.ts (ControlMethods) and packages/protocol/src/events.ts (BEP events)",
      },
      null,
      2,
    ),
  )
}

/** tmux options Baton relies on: [ok?, message]. */
function tmuxChecks(): [boolean, string][] {
  const opt = (name: string) => {
    const p = Bun.spawnSync(["tmux", "show-options", "-gv", name], { windowsHide: true, stdout: "pipe", stderr: "ignore" })
    return p.exitCode === 0 ? p.stdout.toString().trim() : undefined
  }
  const out: [boolean, string][] = []
  const ext = opt("extended-keys")
  out.push(
    ext === "on" || ext === "always"
      ? [true, "tmux: extended-keys on (shift+tab, ctrl+ combinations reach Baton)"]
      : [false, "tmux: `set -g extended-keys on` and `set -as terminal-features 'xterm*:extkeys'` so shift+tab and ctrl+keys work"],
  )
  const pass = opt("allow-passthrough")
  out.push(
    pass === "on" || pass === "all"
      ? [true, "tmux: allow-passthrough on (notifications, logos)"]
      : [false, "tmux: `set -g allow-passthrough on` for desktop notifications and logos"],
  )
  const clip = opt("set-clipboard")
  if (clip === "off") out.push([false, "tmux: `set -g set-clipboard on` so copying from Baton reaches your clipboard"])
  const focus = opt("focus-events")
  if (focus === "off") out.push([false, "tmux: `set -g focus-events on` so Baton knows when to notify you"])
  return out
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
  if (process.env.TMUX) for (const [good, msg] of tmuxChecks()) (good ? ok : warn)(msg)
  if (process.env.WT_SESSION) ok("Windows Terminal (truecolor, good key support)")
  if (process.platform === "win32" && !Bun.which("git"))
    bad("git is not on PATH — install Git for Windows (https://git-scm.com/download/win); Baton needs it for worktrees")
  else if (process.platform === "win32" && !Bun.which("bash"))
    warn("no bash found — the Baton agent's commands will run in PowerShell (Git for Windows adds bash)")
  if (process.env.TERM_PROGRAM === "Apple_Terminal") warn("Terminal.app has no truecolor or inline images — iTerm2, Ghostty, WezTerm or Kitty look much better")
  if (/kitty|ghostty|wezterm|iterm|konsole|warp/i.test(term)) ok("likely supports inline images (logos)")
  else warn("terminal may not support Kitty/Sixel images — logos fall back to glyphs (ui.icons)")
  const nerd = nerdFontInstalled()
  if (nerd) ok(`Nerd Font installed (${nerd}) — if your terminal uses it, try ui.icons = "nerd" and status_style = "powerline"`)
  else warn("no Nerd Font found — the powerline status bar and nerd icons need one (https://www.nerdfonts.com)")
  console.log(c.bold("\nAgents"))
  for (const a of await detectAgents()) {
    if (!a.installed) {
      console.log(`  ${c.dim(`○ ${a.id}`)}`)
      continue
    }
    const auth =
      a.auth === "ok"
        ? c.green(`logged in${a.authMethod ? ` · ${a.authMethod}` : ""}`)
        : a.auth === "missing"
          ? c.red(`not logged in${a.authHint ? ` — ${a.authHint}` : ""}`)
          : c.yellow("auth unknown")
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
  if (daemonListening(sock, root)) {
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
      ? `${c.dim(`v${a.version ?? "?"}`)} ${a.auth === "ok" ? c.green(`logged in${a.authMethod ? ` · ${a.authMethod}` : ""}`) : a.auth === "missing" ? c.red("not logged in") : c.dim("auth ?")}`
      : c.dim("not installed")
    console.log(`${status} ${a.id.padEnd(14)} ${a.displayName.padEnd(18)} ${detail}`)
  }
}

/** The agent's own sign-in command: from detect, else the command named in its hint ("run `cursor-agent login`"). */
function loginCommand(a: { login?: string[]; authHint?: string; path?: string }): string[] | undefined {
  if (a.login?.length) return a.login
  const m = /`([^`]+)`/.exec(a.authHint ?? "")
  if (!m || /^baton\b/.test(m[1]!)) return undefined
  return m[1]!.split(/\s+/)
}

/**
 * `baton login [agent]`: run that agent's own interactive sign-in (Claude Code's, Codex's, …).
 * Baton never sees the credentials — each CLI stores its own login, and Baton runs the CLI.
 */
async function cmdRoles(args: Args) {
  const root = findProjectRoot(process.cwd())
  if (args._[0] === "new") {
    const name = (args._[1] ?? "").toLowerCase()
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) throw new Error("usage: baton role new <name>   (letters, digits, - _ .)")
    const dir = join(root, ".baton", "roles")
    const file = join(dir, `${name}.md`)
    if (existsSync(file)) throw new Error(`${file} already exists`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      file,
      `---
description: What this role is for, in one line (the lead sees it)
# adapter: codex          # which agent plays it (default: the lead decides)
# tier: medium            # small | medium | large: model size via [routing]
# access: write           # read-only: may not edit files
# acceptance: bun test    # a command that must pass before its work counts
# skills: [my-skill]      # skills it starts with (.baton/skills/<name>/SKILL.md)
---
You are the team's ${name}.

- What you own and what you don't touch.
- How this project does things (conventions, commands, where things live).
- What "done" means, and what to report back.
`,
    )
    console.log(`${c.green("✓")} ${file}\n${c.dim(`edit it, then: /spawn ${name} in the app (or the lead picks it)`)}`)
    return
  }
  const loaded = loadConfig({ projectRoot: root })
  offHint(loaded.config, "roles")
  const roles = [...loadRoles(root, loaded.config).values()]
  for (const r of roles)
    console.log(
      `  ${c.bold(r.name.padEnd(13))} ${r.description}${r.access === "read-only" ? c.dim(" · read-only") : ""}${r.tier ? c.dim(` · ${r.tier}`) : ""}${r.adapter ? c.dim(` · ${r.adapter}`) : ""}${r.source !== "builtin" ? c.dim(` · ${r.source}`) : ""}`,
    )
  console.log(c.dim("\n  /spawn <role> in the app · baton role new <name> adds one (.baton/roles/<name>.md)"))
}

async function cmdSkills(args: Args) {
  const root = findProjectRoot(process.cwd())
  if (args._[0] === "new") {
    const name = (args._[1] ?? "").toLowerCase()
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) throw new Error("usage: baton skill new <name>   (letters, digits, - _ .)")
    const dir = join(root, ".baton", "skills", name)
    if (existsSync(join(dir, "SKILL.md"))) throw new Error(`${join(dir, "SKILL.md")} already exists`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      `---
name: ${name}
description: When to use this skill, in one line (agents decide from this whether to load it)
---
# ${name}

Step-by-step instructions an agent follows for this kind of work:

1. …
2. …

Put examples, templates or scripts next to this file; the agent sees the list and can read them.
`,
    )
    console.log(`${c.green("✓")} ${join(dir, "SKILL.md")}\n${c.dim("workers load it with load_skill; the lead can hand it out with spawn_agent(skills)")}`)
    return
  }
  const loaded = loadConfig({ projectRoot: root })
  offHint(loaded.config, "skills")
  const skills = [...loadSkills(root, loaded.config).values()]
  if (!skills.length) return console.log(c.dim("no skills yet: baton skill new <name> (or add folders with a SKILL.md to .baton/skills/)"))
  for (const sk of skills) console.log(`  ${c.bold(sk.name.padEnd(18))} ${sk.description}${c.dim(` · ${sk.source}`)}`)
}

/** Listing a switched-off feature still works, with a line saying agents don't get it. */
function offHint(config: BatonConfig, key: FeatureKey) {
  if (!config.features[key]) console.log(c.yellow(`  ${key} are off: agents don't get them. Turn on with ${c.bold(`baton features ${key} on`)}\n`))
}

async function cmdFeatures(args: Args) {
  const root = findProjectRoot(process.cwd())
  const [key, val] = [args._[0]?.toLowerCase(), args._[1]?.toLowerCase()]
  if (key) {
    if (!isFeature(key)) throw new Error(`no feature "${key}". These exist: ${FEATURES.map((f) => f.key).join(", ")}`)
    if (!val || !["on", "off", "true", "false"].includes(val)) throw new Error(`usage: baton features ${key} on|off`)
    const on = val === "on" || val === "true"
    const file = setFeature(root, key, on)
    console.log(`${c.green("✓")} ${FEATURES.find((f) => f.key === key)?.label}: ${on ? c.green("on") : c.dim("off")} ${c.dim(`(${file})`)}`)
    // a running Baton picks it up now; agents started from here on get the change
    const sock = discoverSocket(root)
    if (daemonListening(sock, root)) {
      const cl = await BatonClient.open(sock, "cli")
      const { errors } = await cl.call("config.reload", {}).finally(() => cl.close())
      for (const e of errors) console.log(c.yellow(e))
    }
    console.log(c.dim("  applies to agents started from now on"))
    return
  }
  const { config } = loadConfig({ projectRoot: root })
  for (const f of FEATURES) console.log(`  ${config.features[f.key] ? c.green("✓ on ") : c.dim("✗ off")}  ${c.bold(f.key.padEnd(11))} ${f.what}`)
  console.log(c.dim("\n  baton features <name> on|off · or /features and /settings → Team features in the app"))
}

async function cmdNotes(args: Args) {
  const root = findProjectRoot(process.cwd())
  offHint(loadConfig({ projectRoot: root }).config, "notes")
  if (args._[0] === "add") {
    const text = args._.slice(1).join(" ").trim()
    if (!text) throw new Error('usage: baton notes add "<fact the next agent should know>"')
    console.log(addNote(root, defaultUser(), text) ? `${c.green("✓")} noted` : c.dim("already noted"))
    return
  }
  const notes = readNotes(root)
  if (!notes.length) return console.log(c.dim('no team notes yet: baton notes add "…" (agents add them with the note tool)'))
  for (const n of notes) console.log(`  • ${n.text}${n.author ? c.dim(`  (${n.author}${n.date ? `, ${n.date}` : ""})`) : ""}`)
  console.log(c.dim(`\n  ${notesPath(root)}`))
}

async function cmdUpdate(args: Args) {
  const check = !!args.flags.check
  const version = typeof args._[0] === "string" ? args._[0] : undefined
  const r = await update({ check, version, log: (s) => console.log(c.dim(s)) })
  if (r.updated) {
    console.log(`${c.green("✓")} baton ${r.from} → ${c.bold(r.to)}`)
    console.log(
      c.dim(
        "Baton windows already open keep running the old version. Start `baton` in a project again and it offers to switch that project's daemon over (its agents come back).",
      ),
    )
  } else if (r.to === r.from) console.log(`${c.green("✓")} baton ${r.from} is the latest`)
  else if (r.how) console.log(`baton ${c.bold(r.to)} is available (you have ${r.from}). Update with:\n  ${r.how}`)
  else console.log(`baton ${c.bold(r.to)} is available (you have ${r.from}) — run ${c.bold("baton update")}`)
}

async function cmdLogin(args: Args) {
  const agents = (await detectAgents()).filter((a) => a.installed)
  let pick = args._[0] ? agents.find((a) => a.id === args._[0]) : undefined
  if (args._[0] && !pick) throw new Error(`"${args._[0]}" isn't installed (baton agents lists them)`)
  if (!pick) {
    const choices = agents.filter((a) => loginCommand(a))
    if (!choices.length) return console.log("none of your installed agents has a sign-in command Baton knows")
    console.log(c.bold("Sign in to an agent") + c.dim(" — each runs its own login; Baton never sees your credentials\n"))
    for (const [i, a] of choices.entries())
      console.log(
        `  ${c.bold(String(i + 1))}  ${a.id.padEnd(14)} ${a.auth === "ok" ? c.green(`logged in${a.authMethod ? ` · ${a.authMethod}` : ""}`) : a.auth === "missing" ? c.red("not logged in") : c.dim("unknown")}`,
      )
    if (!process.stdin.isTTY) return
    process.stdout.write("\nwhich one? ")
    const answer = await new Promise<string>((res) => process.stdin.once("data", (d) => res(String(d).trim())))
    process.stdin.pause()
    pick = choices[Number(answer) - 1] ?? choices.find((a) => a.id === answer)
    if (!pick) return
  }
  const cmd = loginCommand(pick)
  if (!cmd) throw new Error(`don't know how to sign in to ${pick.id}${pick.authHint ? ` — ${pick.authHint}` : ""}`)
  console.log(c.dim(`→ ${cmd.join(" ")}`))
  const p = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  await p.exited
  const after = (await detectAgents()).find((a) => a.id === pick!.id)
  console.log(
    after?.auth === "ok"
      ? c.green(`✓ ${pick.id} is signed in${after.authMethod ? ` (${after.authMethod})` : ""}`)
      : c.yellow(`${pick.id}: still not signed in`),
  )
}

async function cmdPs() {
  const root = findProjectRoot(process.cwd())
  const sock = discoverSocket(root)
  if (!daemonListening(sock, root)) return console.log(c.dim("no daemon running for this project"))
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
  if (!daemonListening(sock, root)) return console.log(c.dim("no daemon running"))
  const cl = await BatonClient.open(sock, "cli")
  await cl.shutdown()
  cl.close()
  // return only once it's gone, so `baton stop && baton …` starts a fresh daemon cleanly
  const lock = join(projectPaths(root).run, "daemon.lock")
  for (let i = 0; i < 100 && existsSync(lock); i++) await Bun.sleep(100)
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
    if (!daemonListening(sock, root)) return console.log(c.dim("no daemon running — the config applies when it starts"))
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

/** `baton mcp`: Baton as an MCP server on stdio. Nothing but protocol may reach stdout. */
async function cmdMcp(args: Args) {
  const root = resolve(typeof args.flags.root === "string" ? args.flags.root : findProjectRoot(process.cwd()))
  console.log = console.error
  if (!isInitialized(root)) await initProject({ root, yes: true, gitInit: false, quiet: true })
  const client = await connect({ cwd: root, daemonCommand: (r) => [...selfCommand(), "daemon", "--root", r], clientName: "mcp" })
  const { runMcp } = await import("./mcp.ts")
  await runMcp(client)
  client.close()
  process.exit(0)
}

async function cmdA2A(args: Args) {
  const cl = await daemonClient()
  if (args.flags.stop) {
    await cl.call("a2a.stop", {})
    cl.close()
    return console.log("A2A endpoint stopped")
  }
  const r = await cl.call("a2a.start", {
    port: typeof args.flags.port === "string" ? Number(args.flags.port) : undefined,
    host: typeof args.flags.host === "string" ? args.flags.host : undefined,
    publicUrl: typeof args.flags["public-url"] === "string" ? (args.flags["public-url"] as string) : undefined,
    noToken: args.flags["no-token"] ? true : undefined,
    rotate: !!args.flags.rotate,
    allowPrivatePush: args.flags["allow-private-push"] ? true : undefined,
  })
  cl.close()
  console.log(`${c.bold("Baton as an A2A agent")} ${c.dim("— other agents can hand this team tasks")}\n`)
  console.log(`  agent card  ${c.cyan(`${r.url}/.well-known/agent-card.json`)}`)
  console.log(`  endpoint    ${c.cyan(r.url)}`)
  if (r.token) console.log(`  token       ${r.token}  ${c.dim("(Authorization: Bearer …)")}`)
  console.log(
    c.dim('\n  Runs in the daemon; `baton a2a --stop` turns it off. Add another A2A agent to your team: [agents.x] adapter = "a2a", options = { url = "…" }'),
  )
}

async function cmdWeb(args: Args) {
  const cl = await daemonClient()
  if (args.flags.stop) {
    await cl.call("remote.stop", {})
    cl.close()
    return console.log("web view stopped")
  }
  const r = await cl.call("remote.start", {
    lan: args.flags.lan ? true : undefined,
    port: typeof args.flags.port === "string" ? Number(args.flags.port) : undefined,
    rotate: !!args.flags.rotate,
    tls: args.flags.https ? true : undefined,
    tailscale: args.flags.tailscale ? true : undefined,
  })
  cl.close()
  console.log(`${c.bold("Baton web view")} ${c.dim(r.lan ? "· reachable from your network" : "· this machine only (add --lan for your phone)")}\n`)
  // always light-on-dark, whatever the terminal's colors: scanners need the contrast the right way round
  for (const l of r.qr) console.log(`  \x1b[97;40m${l}\x1b[0m`)
  console.log(`\n  ${c.cyan(r.openUrl)}`)
  for (const u of r.lanUrls.slice(1)) console.log(`  ${c.dim(u)}`)
  console.log(
    c.dim(`
  The link carries an access token — treat it like a password (\`baton web --rotate\` makes a new one).
  It keeps running in the daemon; \`baton web --stop\` turns it off.${r.lan && !r.tls && !r.publicUrl ? "\n  Plain HTTP on your network: use it on networks you trust, or add --https (self-signed) or --tailscale." : ""}${r.fingerprint ? `\n  HTTPS with Baton's own certificate: your browser asks to trust it once. SHA-256 fingerprint:\n  ${r.fingerprint}` : ""}${r.publicUrl ? "\n  Published on your tailnet with a real certificate: reachable wherever you're signed in to Tailscale." : ""}`),
  )
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
  if (!runId) throw new Error("usage: baton export <run-id> [--format md|html|jsonl]   (ids: baton history)")
  const c = await daemonClient()
  const format = args.flags.format === "jsonl" ? "jsonl" : args.flags.format === "html" ? "html" : "md"
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
  baton --continue                        ${d("bring back the agents that were running when you left")}
  baton demo                              ${d("see it work with simulated agents (no tokens)")}
  baton --yolo                            ${d("every agent acts without asking (no sandbox) — shift+tab in the app cycles")}
  baton run "update the changelog" --approve all --json   ${d("headless, for scripts/CI")}

${b("Commands")}
  baton [task]          start or attach                    baton doctor          check terminal, agents, auth
  baton resume [run]    bring a past run's agents back     baton compact         shrink this project's event log
  baton demo [task]     simulated agents                   baton agents          installed agent CLIs
  baton run "<task>"    headless run (--json)              baton history         past runs (resume: ctrl+r)
  baton init            re-run project setup               baton export <run>    run as Markdown / --format html
  baton ps | stop       daemon status / stop everything    baton trust           allow project commands
  baton web [--lan]     follow & approve from your phone (QR code)
  baton mcp             Baton as an MCP server: let Claude Desktop / Cursor / any agent run your team
  baton a2a [--stop]    serve this team as an A2A agent (other agents send it tasks)
  baton login [agent]   sign in to an agent with its own login (Claude Code, Codex, OpenCode, …)
  baton update [--check]  update Baton to the latest release (verified download)
  baton roles | skills | notes   what workers can be, know and remember (role new · skill new · notes add)
  baton features [name on|off]  switch roles, skills, acceptance checks, team notes
  baton issue <n>       start with a GitHub issue        baton pr [-y]         PR from what the run merged
  baton replay [run]    watch a past run play back (space pause · , . moments · - + speed)
  baton config get|explain|path|schema|defaults            baton theme list|set <name>

${b("Flags")}
  -c/--continue  resume the last run's agents     --resume [run]  pick a past run to resume (or give its id)
  --theme <name>  --layout <grid|list|focus|swarm|wide>  --orchestrator <adapter>  --autonomy <normal|ask|auto|yolo>  --yolo
  -y/--yes  --help  --version

${b("In the app")}
  ctrl+c twice: quit and stop all agents (/quit leaves them running) · select text with the mouse to copy it
  @name talk to an agent · / commands · shift+tab autonomy · ctrl+a inbox · ctrl+d changes · ctrl+s settings
  ctrl+t themes · /style looks · ? all keys · /guide lessons

Docs: README.md and docs/ in the Baton repository.`)
}

/** A next step for common failures. */
function hintFor(msg: string): string {
  if (/no baton daemon|daemon/i.test(msg)) return "run `baton` in the project to start it, or `baton doctor` to see what's wrong"
  if (/unknown adapter/i.test(msg)) return "`baton agents` lists what's installed; custom agents go in [agents.<name>] (docs/agents.md)"
  if (/not logged in|auth/i.test(msg)) return "`baton login <agent>` runs the agent's own sign-in (claude, codex, opencode…)"
  if (/config/i.test(msg)) return "`baton config explain <key>` shows where a value comes from"
  if (/usage:|unknown command/i.test(msg)) return "`baton --help` lists commands, with examples"
  return "`baton doctor` checks your setup"
}

const COMMANDS = [
  "demo",
  "run",
  "init",
  "doctor",
  "agents",
  "ps",
  "stop",
  "config",
  "theme",
  "trust",
  "history",
  "resume",
  "compact",
  "export",
  "web",
  "mcp",
  "a2a",
  "login",
  "update",
  "issue",
  "pr",
  "replay",
  "watch",
  "protocol",
  "roles",
  "skills",
  "notes",
  "features",
  "attach",
  "help",
]

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      (d[i] as number[])[j] = Math.min(
        (d[i - 1] as number[])[j]! + 1,
        (d[i] as number[])[j - 1]! + 1,
        (d[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
  return (d[a.length] as number[])[b.length]!
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
    case "resume":
      return cmdStart({ _: sub._.slice(1), flags: { ...sub.flags, resume: sub._[0] ?? "last" } })
    case "compact":
      return compactLog(findProjectRoot(process.cwd()), { force: true })
    case "web":
      return cmdWeb(sub)
    case "mcp":
      return cmdMcp(sub)
    case "login":
      return cmdLogin(sub)
    case "update":
    case "upgrade":
      return cmdUpdate(sub)
    case "roles":
    case "role":
      return cmdRoles(sub)
    case "skills":
    case "skill":
      return cmdSkills(sub)
    case "notes":
      return cmdNotes(sub)
    case "features":
    case "feature":
      return cmdFeatures(sub)
    case "protocol":
      return cmdProtocol()
    case "a2a":
      return cmdA2A(sub)
    case "issue":
      // start (or attach) with the issue as the orchestrator's task
      if (!sub._[0]) throw new Error("usage: baton issue <number|url>")
      return cmdStart({ _: ["/issue", ...sub._], flags: sub.flags })
    case "replay":
      return cmdReplay(sub)
    case "pr": {
      const cl = await daemonClient()
      const title = typeof sub.flags.title === "string" ? ` ${sub.flags.title}` : ""
      const r = await cl.submit(`/pr${sub.flags.yes ? " confirm" : ""}${title}`)
      cl.close()
      console.log(r.output ?? "")
      return
    }
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
      // a lone word is far more likely a mistyped command than a task
      if (args._.length === 1 && /^[a-z][a-z0-9-]{0,19}$/.test(cmd)) {
        const near = COMMANDS.filter((x) => editDistance(x, cmd) <= 2)
        throw new Error(
          `unknown command "${cmd}"${near.length ? ` — did you mean ${near.map((x) => `baton ${x}`).join(" or ")}?` : "."} To start with a task, describe it: baton "${cmd} the …"`,
        )
      }
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
