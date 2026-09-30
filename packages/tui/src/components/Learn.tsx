/** Teaching surfaces: first-run Welcome, the Guide (short lessons), the Recipes gallery. */
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal } from "solid-js"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { clip, type Line, type Seg, wrap } from "../lines.ts"
import { suggestTasks } from "../onboarding.ts"
import { segs, toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { ListView, Modal } from "./Overlays.tsx"

// ───────────────────────────── Welcome ─────────────────────────────

export function WelcomeOverlay(props: { onClose: () => void; onTask: (text: string) => void; onGuide: () => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const W = () => Math.min(96, dims().width - 4)
  const [agents] = createResource(async () => (ui.client ? (await ui.client.call("agents.detect", {})).adapters : []))
  const tasks = suggestTasks(ui.run.projectRoot || process.cwd())
  const key = (id: string) => ui.keymap.keysFor(id)[0] ?? ""
  useKeyboard((k) => {
    const ks = keyString(k)
    if (k.name === "escape" || k.name === "return" || k.name === "enter") props.onClose()
    else if (/^[1-3]$/.test(ks) && tasks[Number(ks) - 1]) {
      props.onClose()
      props.onTask(tasks[Number(ks) - 1]!)
    } else if (ks === "g") props.onGuide()
  })
  const lines = createMemo<Line[]>(() => {
    const t = ui.theme()
    const w = W() - 4
    const out: Line[] = []
    const h = (text: string) => out.push({ segs: [{ text, fg: t.primary, bold: true }] })
    const p = (text: string, fg = t.textMuted) => {
      for (const l of wrap(text, w)) out.push({ segs: [{ text: l, fg }] })
    }
    const lead = ui.config.orchestrator.agent
    p(
      `One terminal for all your coding agents. Describe a task and the orchestrator (${lead}) plans it, starts agents — each in its own git worktree — and lets them talk to each other. You answer what needs you, review the diffs, and merge.`,
      t.text,
    )
    out.push({ segs: [] })
    h("Agents on this machine")
    const list = agents() ?? []
    if (agents.loading) p("detecting…")
    const installed = list.filter((a) => a.installed && a.id !== "mock" && a.id !== "acp")
    for (const a of installed.slice(0, 6)) {
      const auth: Seg =
        a.auth === "ok"
          ? { text: "logged in", fg: t.success }
          : a.auth === "missing"
            ? { text: `not logged in${a.authHint ? ` — ${a.authHint}` : ""}`, fg: t.warning }
            : { text: "auth unknown", fg: t.textSubtle }
      out.push({
        segs: [
          { text: " ● ", fg: t.success },
          { text: a.id.padEnd(14), fg: t.text },
          { text: `v${(a.version ?? "?").slice(0, 10)}`.padEnd(13), fg: t.textMuted },
          auth,
        ],
      })
    }
    const missing = list.filter((a) => !a.installed).map((a) => a.id)
    if (missing.length) out.push({ segs: [{ text: ` ○ not installed: ${clip(missing.join(", "), w - 20)}`, fg: t.textSubtle }] })
    if (!agents.loading && installed.length === 0)
      p("No agent CLIs found. Install Claude Code, Codex or OpenCode — or try `baton demo` to see Baton with simulated agents.", t.warning)
    out.push({ segs: [] })
    h("Try one of these")
    tasks.forEach((task, i) => {
      out.push({
        segs: [
          { text: ` ${i + 1}  `, fg: t.accent, bold: true },
          { text: clip(task, w - 5), fg: t.text },
        ],
      })
    })
    out.push({ segs: [{ text: "    or /recipe for proven workflows (best-of-3, plan → execute, test-first…)", fg: t.textSubtle }] })
    out.push({ segs: [] })
    h("The keys you need")
    const rows: [string, string, string, string][] = [
      ["@name", "talk to one agent directly", key("inbox.open"), "inbox — what needs you"],
      ["/", "commands (tab completes)", key("attention.next"), "jump to the next ⚑"],
      [key("focus.next"), "move to the agent cards", key("changes.open"), "changes, diffs & merge"],
      ["space", "peek at an agent & reply", key("settings.open"), "settings & appearance"],
    ]
    for (const [k1, d1, k2, d2] of rows)
      out.push({
        segs: [
          { text: ` ${k1.padEnd(8)}`, fg: t.text, bold: true },
          { text: d1.padEnd(30), fg: t.textMuted },
          { text: k2.padEnd(9), fg: t.text, bold: true },
          { text: d2, fg: t.textMuted },
        ],
      })
    out.push({ segs: [] })
    p(`? lists every key · /guide has short lessons · ${key("app.palette")} finds anything`, t.textSubtle)
    return out
  })
  return (
    <Modal
      title="Welcome to Baton"
      width={W()}
      height={Math.min(lines().length + 3, dims().height - 2)}
      hint="enter start · 1-3 use a suggestion · g guide · esc close"
    >
      <Txt value={toStyled(lines(), W() - 4)} />
    </Modal>
  )
}

// ───────────────────────────── Guide ─────────────────────────────

const LESSONS: { title: string; body: string }[] = [
  {
    title: "How Baton works",
    body: `Baton runs a small background daemon per project. It starts coding agents (Claude Code, Codex, OpenCode, Gemini, Cursor, any ACP agent…), records everything they do, and streams it to this screen. Quit with ctrl+c and the agents keep working; run baton again to re-attach.

The ORCHESTRATOR is an agent too (set it in settings). When you type a task without @, it goes to the orchestrator, which decides how many agents to use, gives each a clear task, waits for their results, reviews and merges.

Agents talk over the BUS: they can message each other, report progress and claim files. You see that traffic in the orchestrator thread and the bus pane.`,
  },
  {
    title: "Talking to agents",
    body: `• Plain text → the orchestrator.
• @codex-2 text → one agent directly (injected into its current turn when it supports that, otherwise queued).
• @all, @role:reviewer → broadcast.
• !codex-2 or !all → interrupt.
• /spawn codex 3 refactor → start three Codex agents labelled "refactor".
• tab moves to the agent cards; space peeks at one and lets you reply; m pre-fills @name; z zooms; x stops.
Results flow back automatically to whoever assigned the task.`,
  },
  {
    title: "Planning & recipes",
    body: `For bigger work the orchestrator records a plan (ctrl+g): tasks, the files each owns, acceptance checks, dependencies. Turn on "Approve plans" in settings to review it before anything runs (/plan approve or /plan reject <why>).

Recipes are proven workflows: /recipe best-of-3 <task> (three vendors compete, the best lands), plan-execute, research-implement, implement-review, debug-hypotheses, test-first, shard. Add your own as Markdown in .baton/recipes/.

Rule of thumb: one agent for small fixes, parallel agents only for independent pieces, and a reviewer from another vendor for anything that matters.`,
  },
  {
    title: "Worktrees, review & merge",
    body: `Every worker edits its own git worktree — a private copy of your project including uncommitted changes — so parallel agents never overwrite each other. Nothing touches your files until a merge.

ctrl+d shows every worker's changes: enter for the diff, m merge, s sync, r review. Merges are three-way against your project as it is now and land in your working tree only (never your index or branch — you commit). If two workers' edits conflict, both cards say so before anyone merges: merge one, /sync the other, and it resolves the markers itself.

Set a verify command (e.g. bun test) in settings → Workspaces and failing merges are blocked.`,
  },
  {
    title: "Approvals & safety",
    body: `When an agent wants to do something risky, it asks. The policy decides first: strict (only reads auto-approved), balanced (reads and edits ok, risky commands ask), or yolo. Anything left goes to your inbox (ctrl+a): a allow once, A always, d deny. ctrl+y approves the oldest.

Everything that needs you — approvals, failed or stuck agents, conflicts, finished work — shows as ⚑ in the status bar and the tab title; ctrl+n jumps to the next one. Notifications reach you when the window isn't focused.

Budgets (settings → Safety) interrupt agents at a $ limit; the watchdog flags agents that go silent or loop.`,
  },
  {
    title: "Make it yours",
    body: `ctrl+s opens settings: theme, layout, borders, icons, density, spinner, hints, notifications, the orchestrator, workspaces, safety. Changes apply live and are saved to the project (.baton/config.toml) or global (~/.config/baton/config.toml) file — tab switches which.

ctrl+t previews themes live (OpenCode and base16 themes import as-is; "system" follows your terminal). ctrl+l cycles layouts. Every key can be rebound in [keys]. Run baton config explain <key> to see where a value comes from.`,
  },
  {
    title: "More agents & providers",
    body: `Any ACP agent works with three lines of config:
  [agents.my-agent]
  adapter = "acp"
  command = "my-agent" ; args = ["--acp"]

Profiles wrap existing agents with a model, role, provider or autonomy level ([agents.reviewer] adapter = "codex" …). Providers ([providers.openrouter] kind = "openai-compatible" …) route agents to other model endpoints. Plugins add agents in TypeScript; project plugins only run after baton trust.`,
  },
  {
    title: "Troubleshooting",
    body: `• baton doctor — terminal features, which agents are installed and logged in, config layers, daemon status.
• An agent "not logged in": run its CLI once (claude → /login, codex login, opencode auth login).
• baton ps / baton stop — see or stop the background daemon.
• Daemon log: .baton/run/batond.log. BATON_DEBUG_KEYS=/tmp/keys.log logs every key press.
• Something looks off on screen? Try ui.icons = unicode, or a different theme; report it with your terminal name.`,
  },
]

export function GuideOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(0)
  const W = () => Math.min(110, dims().width - 4)
  const H = () => Math.min(32, dims().height - 2)
  useKeyboard((k) => {
    const n = LESSONS.length
    if (k.name === "escape" || k.name === "q") props.onClose()
    else if (k.name === "down" || k.name === "j" || k.name === "right") setSel((s) => (s + 1) % n)
    else if (k.name === "up" || k.name === "k" || k.name === "left") setSel((s) => (s - 1 + n) % n)
    else if (/^[1-8]$/.test(k.name)) setSel(Number(k.name) - 1)
  })
  const leftW = 26
  const body = createMemo<Line[]>(() => {
    const t = ui.theme()
    const l = LESSONS[sel()]!
    const out: Line[] = [{ segs: [{ text: l.title, fg: t.primary, bold: true }] }, { segs: [] }]
    for (const para of l.body.split("\n"))
      for (const line of para ? wrap(para, W() - leftW - 7) : [""]) out.push({ segs: [{ text: line, fg: line.startsWith("•") ? t.text : t.textMuted }] })
    return out
  })
  return (
    <Modal title="Guide" width={W()} height={H()} hint="↑↓ lesson · 1-8 jump · esc close">
      <box flexDirection="row" height={H() - 3}>
        <box width={leftW}>
          <ListView
            items={LESSONS.map((l, i) => ({ label: [{ text: `${i + 1}  ${l.title}`, fg: ui.theme().text }] }))}
            selected={sel()}
            width={leftW}
            height={LESSONS.length}
          />
        </box>
        <Txt value={segs({ text: "│ ", fg: ui.theme().borderSubtle })} />
        <box flexGrow={1}>
          <Txt value={toStyled(body(), W() - leftW - 7, H() - 3)} height={H() - 3} />
        </box>
      </box>
    </Modal>
  )
}

// ───────────────────────────── Recipes ─────────────────────────────

export function RecipesOverlay(props: { onClose: () => void; onPick: (name: string) => void }) {
  const ui = useUi()
  const [sel, setSel] = createSignal(0)
  const [recipes] = createResource(async () => (ui.client ? (await ui.client.call("recipes.list", {})).recipes : []))
  useKeyboard((k) => {
    const n = recipes()?.length ?? 0
    if (k.name === "escape") props.onClose()
    else if (k.name === "down" || k.name === "j") setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "up" || k.name === "k") setSel((s) => (n ? (s - 1 + n) % n : 0))
    else if (k.name === "return" || k.name === "enter") {
      const r = recipes()?.[sel()]
      if (r) props.onPick(r.name)
    }
  })
  const detail = createMemo<Line[]>(() => {
    const r = recipes()?.[sel()]
    const t = ui.theme()
    if (!r) return []
    return [
      {
        segs: [
          { text: r.title, fg: t.text, bold: true },
          { text: r.agents ? `   ${r.agents}` : "", fg: t.textSubtle },
        ],
      },
      ...wrap(r.description, 82).map((l) => ({ segs: [{ text: l, fg: t.textMuted }] })),
      { segs: [] },
      { segs: [{ text: `enter → /recipe ${r.name} <your task>`, fg: t.textSubtle }] },
    ]
  })
  return (
    <Modal title="Recipes" width={88} height={22} hint="↑↓ select · enter use · esc close">
      <ListView
        items={(recipes() ?? []).map((r) => ({
          label: [
            { text: r.name.padEnd(20), fg: ui.theme().accent },
            { text: clip(r.description, 50), fg: ui.theme().textMuted },
          ],
          right: r.source === "builtin" ? "" : r.source,
        }))}
        selected={sel()}
        width={84}
        height={Math.min(11, Math.max(1, recipes()?.length ?? 1))}
      />
      <Txt value={segs({ text: "─".repeat(84), fg: ui.theme().borderSubtle })} />
      <Txt value={toStyled(detail(), 84, 6)} height={6} />
    </Modal>
  )
}
