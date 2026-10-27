/**
 * Teaching surfaces: the first-run Welcome tour, the Guide (short illustrated lessons you can
 * try out on the spot), and the Recipes gallery.
 */
import { STYLES } from "@batonsh/themes"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { AUTONOMY_INFO, type Autonomy } from "../autonomy.ts"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { clip, type Line, type Seg, width as sw, wrap } from "../lines.ts"
import { loadOnboarding, saveOnboarding, suggestTasks } from "../onboarding.ts"
import { segs, toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { center, keycap, logo, markup, progress, stepDots, swatch } from "../ui/widgets.ts"
import { StylePreview } from "./Looks.tsx"
import { ListView, Modal } from "./Overlays.tsx"

// ───────────────────────────── Welcome ─────────────────────────────

const STEPS = ["Welcome", "Your look", "Autonomy", "Let's go"] as const
const LEVELS: Autonomy[] = ["normal", "ask", "auto", "yolo"]

export interface WelcomeProps {
  onClose: () => void
  onTask: (text: string) => void
  onGuide: () => void
  onStyle: (name: string) => void
  onTheme: (dir: 1 | -1) => void
  onAutonomy: (mode: Autonomy) => void
}

export function WelcomeOverlay(props: WelcomeProps) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const W = () => Math.min(104, dims().width - 4)
  const H = () => Math.min(32, dims().height - 2)
  const inner = () => W() - 4
  const bodyH = () => H() - 5
  const [step, setStep] = createSignal(0)
  const [styleSel, setStyleSel] = createSignal(
    Math.max(
      0,
      STYLES.findIndex((s) => s.name === ui.prefs.style),
    ),
  )
  const [level, setLevel] = createSignal(Math.max(0, LEVELS.indexOf(ui.run.autonomy)))
  const [agents] = createResource(async () => (ui.client ? (await ui.client.call("agents.detect", {}).catch(() => ({ adapters: [] }))).adapters : []))
  const tasks = suggestTasks(ui.run.projectRoot || process.cwd())
  const key = (id: string) => ui.keymap.keysFor(id)[0] ?? ""

  const go = (to: number) => {
    // leaving the autonomy step applies the choice to this run
    if (step() === 2 && to !== 2 && LEVELS[level()] !== ui.run.autonomy) props.onAutonomy(LEVELS[level()]!)
    setStep(Math.max(0, Math.min(STEPS.length - 1, to)))
  }
  const finish = () => {
    if (step() === 2 && LEVELS[level()] !== ui.run.autonomy) props.onAutonomy(LEVELS[level()]!)
    props.onClose()
  }

  useKeyboard((k) => {
    const ks = keyString(k)
    if (k.name === "escape") return finish()
    if (k.name === "right" || ks === "l" || k.name === "tab") return go(step() + 1)
    if (k.name === "left" || ks === "h" || ks === "shift+tab") return go(step() - 1)
    if (k.name === "return" || k.name === "enter") return step() === STEPS.length - 1 ? finish() : go(step() + 1)
    if (step() === 1) {
      const n = STYLES.length
      if (k.name === "down" || ks === "j" || k.name === "up" || ks === "k") {
        const i = (styleSel() + (k.name === "down" || ks === "j" ? 1 : -1) + n) % n
        setStyleSel(i)
        props.onStyle(STYLES[i]!.name)
      } else if (ks === "t") props.onTheme(1)
      else if (ks === "shift+t") props.onTheme(-1)
      return
    }
    if (step() === 2) {
      if (k.name === "down" || ks === "j") setLevel((l) => (l + 1) % LEVELS.length)
      else if (k.name === "up" || ks === "k") setLevel((l) => (l - 1 + LEVELS.length) % LEVELS.length)
      return
    }
    if (/^[1-3]$/.test(ks) && tasks[Number(ks) - 1] && step() === STEPS.length - 1) {
      finish()
      props.onTask(tasks[Number(ks) - 1]!)
    } else if (ks === "g") {
      finish()
      props.onGuide()
    }
  })

  const top = (): Line => {
    const t = ui.theme()
    const title = STEPS[step()]!
    const dots = stepDots(t, step(), STEPS.length)
    const dw = dots.reduce((n, s) => n + sw(s.text), 0)
    const label = `${step() + 1}/${STEPS.length}  ${title}`
    return { segs: [...dots, { text: " ".repeat(Math.max(1, inner() - dw - label.length)) }, { text: label, fg: t.textMuted }] }
  }

  // step 0: what Baton is, how it flows, which agents you have
  const welcome = createMemo<Line[]>(() => {
    const t = ui.theme()
    const w = inner()
    const out: Line[] = []
    const roomy = bodyH() >= 24
    out.push(...logo(t, w, !roomy))
    out.push(center([{ text: "one terminal for all your coding agents", fg: t.textMuted, italic: true }], w))
    out.push({ segs: [] })
    // the flow, drawn
    const lead = ui.config.orchestrator.agent
    const c = (text: string, fg = t.border): Seg => ({ text, fg })
    const a = (adapter: string) => agentLook(ui, { adapter, name: `${adapter}-1` })
    // agents column starts at col 36; names padded so the bracket lines up
    const agent = (adapter: string): Seg[] => {
      const look = a(adapter)
      const g = look.glyph.length >= 2 ? look.glyph.slice(0, 2) : `${look.glyph} `
      return [{ text: `${g} ${`${adapter}-1`.padEnd(10)}`, fg: look.color, bold: true }]
    }
    const diagram: Seg[][] = [
      [c("  ╭─────╮     ╭──────────────╮      "), ...agent("claude"), c("─╮")],
      [
        c("  │ "),
        { text: "you", fg: t.accent, bold: true },
        c(" │ ──► │ "),
        { text: "orchestrator", fg: t.primary, bold: true },
        c(" │ ──►  "),
        ...agent("codex"),
        c("─┼─ "),
        { text: "⇄ ", fg: t.accent, bold: true },
        { text: "they talk to each other", fg: t.textMuted },
      ],
      [c("  ╰─────╯     ╰──────────────╯      "), ...agent("gemini"), c("─╯")],
      [c(`     ▲${" ".repeat(34)}│ `), { text: "each in its own git worktree", fg: t.textMuted }],
      [c("     ╰──────"), { text: " you review & merge ", fg: t.success, bold: true }, c("◄───────╯")],
    ]
    const dw = Math.max(...diagram.map((r) => r.reduce((n, s) => n + sw(s.text), 0)))
    const pad = " ".repeat(Math.max(0, Math.floor((w - dw) / 2)))
    for (const r of diagram) out.push({ segs: [{ text: pad }, ...r] })
    out.push({ segs: [] })
    for (const l of wrap(
      `Describe a task; the orchestrator (${lead}) plans it and starts agents from different vendors. Talk to any of them with @name. Nothing touches your files until you merge.`,
      w,
    ))
      out.push({ segs: [{ text: l, fg: t.text }] })
    out.push({ segs: [] })
    const list = agents() ?? []
    const installed = list.filter((x) => x.installed && x.id !== "mock" && x.id !== "acp")
    out.push({ segs: [{ text: "On this machine  ", fg: t.textMuted }, ...(agents.loading ? [{ text: "detecting…", fg: t.textSubtle }] : [])] })
    const chips: Seg[] = []
    for (const x of installed.slice(0, 8)) {
      const look = agentLook(ui, { adapter: x.id, name: x.id })
      const ok = x.auth !== "missing"
      chips.push(
        { text: ` ${look.glyph} `, fg: look.color, bold: true },
        { text: x.id, fg: t.text },
        { text: ok ? " ●  " : " ○  ", fg: ok ? t.success : t.warning },
      )
    }
    if (chips.length) out.push({ segs: chips })
    const missing = installed.filter((x) => x.auth === "missing")
    if (missing.length)
      out.push({ segs: [{ text: clip(` ○ not logged in: ${missing.map((x) => `${x.id} (${x.authHint ?? "log in"})`).join(", ")}`, w), fg: t.warning }] })
    if (!agents.loading && installed.length === 0)
      for (const l of wrap("No agent CLIs found. Install Claude Code, Codex or OpenCode — or run `baton demo` to watch simulated agents.", w))
        out.push({ segs: [{ text: l, fg: t.warning }] })
    return out
  })

  // step 1: style gallery with a live preview (also applied to the app behind)
  const lookList = createMemo<Line[]>(() => {
    const t = ui.theme()
    return STYLES.map((s, i) => {
      const on = i === styleSel()
      const bg = on ? t.selection : undefined
      return {
        bg,
        segs: [
          { text: on ? "› " : "  ", fg: t.primary, bg },
          { text: s.title.padEnd(10), fg: on ? t.text : t.textMuted, bold: on, bg },
        ],
      }
    })
  })
  const lookInfo = createMemo<Line[]>(() => {
    const t = ui.theme()
    const st = STYLES[styleSel()]!
    return [
      {
        segs: [
          { text: st.title, fg: t.text, bold: true },
          { text: `  ${clip(st.description, inner() - st.title.length - 4)}`, fg: t.textMuted },
        ],
      },
      {
        segs: [
          { text: "theme ", fg: t.textMuted },
          { text: t.name, fg: t.accent, bold: true },
          { text: "  " },
          ...swatch(t),
          { text: "   " },
          keycap(t, "t"),
          { text: " next theme  ", fg: t.textMuted },
          keycap(t, "↑↓"),
          { text: " style  — change any of it later in settings", fg: t.textMuted },
        ],
      },
    ]
  })

  // step 2: autonomy
  const autonomyLines = createMemo<Line[]>(() => {
    const t = ui.theme()
    const w = inner()
    const out: Line[] = []
    for (const l of wrap(
      "How freely may agents act? This applies to every agent — the lead and all workers, even ones already running. You can switch any time with shift+tab.",
      w,
    ))
      out.push({ segs: [{ text: l, fg: t.text }] })
    out.push({ segs: [] })
    const extra: Record<Autonomy, string> = {
      normal:
        "Recommended. Workers edit freely in their own worktrees (nothing lands without a merge); risky commands like rm -rf or git push come to your inbox.",
      ask: "Maximum control: you approve every edit and command. Good for unfamiliar repos — expect many questions.",
      auto: "Agents run commands and edit on their own. Destructive commands still ask. Good when you trust the task and want speed.",
      yolo: "No prompts and no sandbox for anyone. Fastest, riskiest: only for throwaway repos or containers. Your deny rules still apply.",
    }
    LEVELS.forEach((lv, i) => {
      const info = AUTONOMY_INFO[lv]
      const on = i === level()
      const bg = on ? t.selection : undefined
      const color = lv === "normal" ? t.primary : t[info.token]
      out.push({
        bg,
        segs: [
          { text: on ? "› " : "  ", fg: t.primary, bg },
          { text: `${info.glyph} `, fg: color, bold: true, bg },
          { text: info.label.padEnd(10), fg: on ? color : t.text, bold: true, bg },
          { text: clip(info.blurb, w - 16), fg: on ? t.text : t.textMuted, bg },
        ],
      })
      for (const l of wrap(extra[lv], w - 16).slice(0, 2))
        out.push({
          bg,
          segs: [
            { text: " ".repeat(16), bg },
            { text: l, fg: t.textSubtle, bg },
          ],
        })
      out.push({ segs: [] })
    })
    return out
  })

  // step 3: first task + the keys that matter
  const startLines = createMemo<Line[]>(() => {
    const t = ui.theme()
    const w = inner()
    const out: Line[] = []
    out.push({
      segs: [
        { text: "Try one of these", fg: t.primary, bold: true },
        { text: "   (press the number)", fg: t.textSubtle },
      ],
    })
    tasks.forEach((task, i) => {
      out.push({ segs: [{ text: "  " }, keycap(t, String(i + 1)), { text: `  ${clip(task, w - 8)}`, fg: t.text }] })
    })
    out.push({
      segs: [
        { text: "     or ", fg: t.textSubtle },
        keycap(t, "/recipe"),
        { text: " for proven workflows: best-of-3, plan → execute, test-first…", fg: t.textSubtle },
      ],
    })
    out.push({ segs: [] })
    out.push({ segs: [{ text: "The keys you need", fg: t.primary, bold: true }] })
    const rows: [string, string, string, string][] = [
      ["@name", "talk to one agent", key("inbox.open"), "inbox: what needs you"],
      ["/", "commands (tab completes)", key("attention.next"), "jump to the next ⚑"],
      [key("focus.next"), "move to the agent cards", key("changes.open"), "changes, diffs & merge"],
      ["space", "peek at an agent & reply", "shift+tab", "autonomy level"],
      [key("settings.open"), "settings", key("theme.pick"), "themes"],
    ]
    const colW = Math.floor(w / 2)
    for (const [k1, d1, k2, d2] of rows) {
      const c1: Seg[] = [{ text: "  " }, keycap(t, k1), { text: ` ${d1}`, fg: t.textMuted }]
      const used = c1.reduce((n, s) => n + sw(s.text), 0)
      out.push({ segs: [...c1, { text: " ".repeat(Math.max(1, colW - used)) }, keycap(t, k2), { text: ` ${d2}`, fg: t.textMuted }] })
    }
    out.push({ segs: [] })
    out.push({
      segs: [
        { text: "  " },
        keycap(t, "g"),
        { text: " open the guide (short lessons)   ", fg: t.textMuted },
        keycap(t, "?"),
        { text: " every key   ", fg: t.textMuted },
        keycap(t, key("app.palette")),
        { text: " find anything", fg: t.textMuted },
      ],
    })
    return out
  })

  const hint = () =>
    step() === 1
      ? "↑↓ style · t theme · → next · esc close"
      : step() === 2
        ? "↑↓ choose · → next · esc close"
        : step() === STEPS.length - 1
          ? "1-3 start a task · g guide · enter close"
          : "→ / enter next · esc close"

  return (
    <Modal title="Welcome to Baton" width={W()} height={H()} hint={hint()}>
      <Txt height={1} value={toStyled([top()], inner())} />
      <Txt height={1} value={toStyled([{ segs: [{ text: "─".repeat(inner()), fg: ui.theme().borderSubtle }] }], inner())} />
      <Show when={step() === 0}>
        <Txt height={bodyH()} value={toStyled(welcome(), inner(), bodyH())} />
      </Show>
      <Show when={step() === 1}>
        <box flexDirection="row" height={bodyH() - 3}>
          <box width={14}>
            <Txt value={toStyled(lookList(), 14, bodyH() - 3)} />
          </box>
          <box width={2} />
          <StylePreview prefs={STYLES[styleSel()]!.prefs} width={inner() - 16} height={bodyH() - 3} />
        </box>
        <box height={1} />
        <Txt height={2} value={toStyled(lookInfo(), inner(), 2)} />
      </Show>
      <Show when={step() === 2}>
        <Txt height={bodyH()} value={toStyled(autonomyLines(), inner(), bodyH())} />
      </Show>
      <Show when={step() === 3}>
        <Txt height={bodyH()} value={toStyled(startLines(), inner(), bodyH())} />
      </Show>
    </Modal>
  )
}

// ───────────────────────────── Guide ─────────────────────────────

export interface Lesson {
  id: string
  icon: string
  title: string
  body: string
  /** A thing to try right now: label + an App command id. */
  try?: { label: string; action: string }
}

export const LESSONS: Lesson[] = [
  {
    id: "how",
    icon: "✱",
    title: "How Baton works",
    try: { label: "see the agents you have", action: "agents" },
    body: `## One lead, many agents
Baton runs a small background daemon per project. It starts coding agents — Claude Code, Codex, OpenCode, Gemini, Cursor, any ACP agent — records everything they do and streams it here.

\`\`\`
 you ──► orchestrator ──► claude-1 ┐
                       ├─► codex-1  ├─ ⇄ bus
                       └─► gemini-1 ┘
\`\`\`
- Type a task **without @** and it goes to the **orchestrator**, an agent too. It decides how many agents to use, gives each a clear task, waits for results, reviews and merges.
- Agents talk over the **bus**: they message each other, report progress and claim files.
- \`ctrl+c\` twice quits and stops every agent; \`/quit\` leaves them working, and \`baton\` re-attaches.`,
  },
  {
    id: "talk",
    icon: "@",
    title: "Talking to agents",
    try: { label: "start a message to an agent", action: "prefill:@" },
    body: `## Your input line does a lot
- Plain text → the orchestrator.
- \`@codex-2\` text → one agent directly. Injected into its current turn when it supports that, otherwise queued.
- \`@all\` or \`@role:reviewer\` → broadcast.
- \`!codex-2\` or \`!all\` → interrupt.
- \`/spawn codex 3 refactor\` → three Codex agents labelled "refactor".

## On the agent cards
\`tab\` moves to the cards. \`space\` peeks at one and lets you reply, \`m\` pre-fills @name, \`z\` zooms, \`x\` interrupts.
> Results flow back automatically to whoever assigned the task.`,
  },
  {
    id: "autonomy",
    icon: "↯",
    title: "Autonomy & YOLO",
    try: { label: "cycle the autonomy level", action: "autonomy.cycle" },
    body: `## One dial for every agent
Press \`shift+tab\` in the input to cycle:

- **◆ normal**: each agent uses its own setting. Edits in worktrees are fine, risky commands ask you.
- **↯ auto**: agents act on their own; destructive commands (rm -rf, git push…) still ask.
- **▲ YOLO**: no prompts and no sandbox, for **every** agent: the lead, all workers, even ones already running.
- **◇ ask**: everyone asks before any edit or command.

The level shows in the status bar and on the lead's frame (red in YOLO).
> Your **deny** rules ([[policy.rules]] action = "deny") still apply in YOLO. Make it permanent in settings → Autonomy & safety, or start with \`baton --yolo\`.`,
  },
  {
    id: "plans",
    icon: "▤",
    title: "Planning & recipes",
    try: { label: "browse recipes", action: "recipes.open" },
    body: `## Plans
For bigger work the orchestrator records a plan (\`ctrl+g\`): tasks, the files each owns, acceptance checks, dependencies. Turn on **Approve plans** in settings to review it before anything runs (/plan approve, /plan reject <why>).

## Recipes
Proven workflows: \`/recipe best-of-3 <task>\` (three vendors compete, the best lands), plan-execute, research-implement, implement-review, debug-hypotheses, test-first, shard. Add your own as Markdown in .baton/recipes/.
> Rule of thumb: one agent for small fixes, parallel agents only for independent pieces, and a reviewer from another vendor for anything that matters.`,
  },
  {
    id: "merge",
    icon: "⎇",
    title: "Worktrees, review & merge",
    try: { label: "open changes", action: "changes.open" },
    body: `## Nothing lands until you merge
Every worker edits its own **git worktree** — a private copy of your project including uncommitted changes — so parallel agents never overwrite each other.

\`\`\`
 project ─┬─ worktree: claude-1 ─┐
          ├─ worktree: codex-1  ─┼─► review ─► merge ─► project
          └─ worktree: gemini-1 ─┘
\`\`\`
\`ctrl+d\` shows every worker's changes: \`enter\` diff, \`m\` merge, \`s\` sync, \`r\` review. Merges are three-way against your project as it is now and land in your working tree only — you commit.
> Conflicts show on both cards before anyone merges: merge one, /sync the other, and it resolves the markers itself.`,
  },
  {
    id: "safety",
    icon: "⚑",
    title: "Approvals & attention",
    try: { label: "open the inbox", action: "inbox.open" },
    body: `## When something needs you
The policy decides first (strict, balanced or yolo); anything left goes to your **inbox** (\`ctrl+a\`): \`a\` allow once, \`A\` always (this exact command), \`d\` deny. \`ctrl+y\` approves the oldest.

Everything that needs you — approvals, failed or stuck agents, conflicts, finished work — shows as ⚑ in the status bar and tab title. \`ctrl+n\` jumps to the next one. Notifications reach you when the window isn't focused.
> Budgets (settings → Autonomy & safety) stop new work at a $ limit; the watchdog flags agents that go silent or loop.`,
  },
  {
    id: "roles",
    icon: "◎",
    title: "Roles, skills and notes",
    try: { label: "start a tester", action: "prefill:/spawn tester " },
    body: `## Give every worker what it needs
A worker only knows what it is told. Baton gives the lead three ways to make workers better, and you can use them too:
- **Roles**: tester, reviewer, debugger, refactorer, docs, security, researcher, frontend, plus your own (\`baton role new api\` → \`.baton/roles/api.md\`). A role brings instructions, a model size, an access level and a "done when" check. \`/roles\` lists them; \`/spawn tester\` starts one.
- **Skills**: folders with a \`SKILL.md\` (\`baton skill new deploy\`, or your \`.claude/skills\`). Workers see each skill's one-line description and load the full text when they need it. \`/skills\` lists them.
- **Team notes** (opt-in): facts agents learn ("tests need DB_URL") go into \`.baton/notes.md\`, and every new worker starts with them. \`/features notes on\` turns them on; \`/notes add …\` adds one yourself.

Each of these has its own switch: \`/features\` shows them, \`/features skills off\` turns one off, and \`/settings\` → Team features does the same. Switched off, the agents never hear of it.

## What the lead can ask for
\`spawn_agent\` takes a role, extra instructions, skills, the files the worker owns (claimed for it), and an **acceptance** command. Baton runs that command when the worker finishes: its work counts only when the check passes, and it gets two more tries if not. Read-only workers (reviewer, security, researcher) can't edit files, even in YOLO.`,
  },
  {
    id: "together",
    icon: "◎",
    title: "Teams, phones & GitHub",
    try: { label: "open the phone / web view", action: "web.open" },
    body: `## Beyond one terminal
- \`/web\` (or \`baton web --lan\`) shows a QR code: follow the run, approve, merge and send tasks from your phone.
- **Shared runs:** everyone who attaches (TUI or web) appears in the status bar (◎ dana). Messages and approvals show who did them.
- \`/issue 42\` hands a GitHub issue to the lead; \`/pr\` previews a pull request from what the run merged, \`/pr confirm\` opens it as a draft. Your working tree and branch stay as they are.
- \`baton mcp\` lets Claude Desktop, Cursor or another agent run your Baton team.

## Learning who's good at what
\`/scores\` shows each agent's track record in this project (merged, approved, setbacks, $ per success). The lead uses the same numbers (pick_agent) to choose who does what.
> \`/focus 25\` holds everything but approvals and errors for 25 minutes. History (\`ctrl+r\`) → \`p\` replays any past run.`,
  },
  {
    id: "looks",
    icon: "◐",
    title: "Styles & themes",
    try: { label: "open the style gallery", action: "style.pick" },
    body: `## Shapes and colors, separately
A **style** sets the shapes: frames (boxes, tabs, title bars, rules, accent stripes), the status bar (bar, chips, powerline, plain text) and the background. A **theme** sets the colors. Mix any style with any of ~30 themes.

- \`/style\` → gallery with a live preview: classic, modern, minimal, accent, tabs, neon, retro, zen, paper, glass, brutalist.
- \`ctrl+t\` → themes, previewed live. "system" uses your terminal's palette.
- Settings → Looks → **Background: terminal** keeps your terminal's own background (and transparency).
> Every part can be changed on its own afterwards; the style then shows as "custom".`,
  },
  {
    id: "yours",
    icon: "◍",
    title: "Make it yours",
    try: { label: "open settings", action: "settings.open" },
    body: `## Settings
\`ctrl+s\` opens settings: looks, layout, autonomy, the orchestrator, workspaces, notifications. Changes apply live and are saved to the project (.baton/config.toml) or global (~/.config/baton/config.toml) file — \`s\` switches which.

- \`ctrl+l\` cycles layouts: grid, list, focus, swarm, wide.
- Every key can be rebound in [keys].
- \`baton config explain ui.theme\` tells you where a value comes from.`,
  },
  {
    id: "more",
    icon: "◆",
    title: "More agents & providers",
    body: `## Any agent, any model
Any ACP agent works with three lines of config:
\`\`\`
[agents.my-agent]
adapter = "acp"
command = "my-agent" ; args = ["--acp"]
\`\`\`
Profiles wrap existing agents with a model, role, provider or autonomy level ([agents.reviewer] adapter = "codex" …). Providers ([providers.openrouter] kind = "openai-compatible" …) route agents to other model endpoints.
> Plugins and commands from a repository's config only run after \`baton trust\`.`,
  },
  {
    id: "trouble",
    icon: "?",
    title: "Troubleshooting",
    body: `## When something is off
- \`baton doctor\` — terminal features, installed agents and logins, config layers, daemon status.
- An agent "not logged in": run its CLI once (claude → /login, codex login, opencode auth login).
- \`baton ps\` / \`baton stop\` — see or stop the background daemon.
- Daemon log: .baton/run/batond.log. BATON_DEBUG_KEYS=/tmp/keys.log logs every key press.
- Odd characters on screen? Try icons = unicode, a different style, or a different theme — and report it with your terminal's name.`,
  },
]

export function GuideOverlay(props: { onClose: () => void; onTry?: (action: string) => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const initialRead = new Set(ui.persistent ? (loadOnboarding().lessons ?? []) : [])
  const firstUnread = LESSONS.findIndex((l) => !initialRead.has(l.id))
  const [sel, setSel] = createSignal(firstUnread >= 0 ? firstUnread : 0)
  const [read, setRead] = createSignal(initialRead)
  const markRead = (i: number) => {
    const id = LESSONS[i]!.id
    if (read().has(id)) return
    const next = new Set(read())
    next.add(id)
    setRead(next)
    if (ui.persistent) saveOnboarding({ ...loadOnboarding(), lessons: [...next] })
  }
  markRead(sel())
  const select = (i: number) => {
    setSel(i)
    markRead(i)
  }
  const W = () => Math.min(116, dims().width - 4)
  const H = () => Math.min(34, dims().height - 2)
  useKeyboard((k) => {
    const n = LESSONS.length
    const ks = keyString(k)
    if (k.name === "escape" || ks === "q") props.onClose()
    else if (k.name === "down" || ks === "j" || k.name === "right" || ks === "l" || k.name === "tab") select((sel() + 1) % n)
    else if (k.name === "up" || ks === "k" || k.name === "left" || ks === "h" || ks === "shift+tab") select((sel() - 1 + n) % n)
    else if (/^[1-9]$/.test(ks) && Number(ks) <= n) select(Number(ks) - 1)
    else if (ks === "0" && n >= 10) select(9)
    else if ((ks === "t" || k.name === "return" || k.name === "enter") && LESSONS[sel()]!.try && props.onTry) {
      props.onClose()
      props.onTry(LESSONS[sel()]!.try!.action)
    }
  })
  const leftW = 30
  const rightW = () => W() - leftW - 7
  const bodyH = () => H() - 3
  const list = createMemo<Line[]>(() => {
    const t = ui.theme()
    const out: Line[] = LESSONS.map((l, i) => {
      const on = i === sel()
      const done = read().has(l.id)
      const bg = on ? t.selection : undefined
      return {
        bg,
        segs: [
          { text: on ? "▌" : " ", fg: t.primary, bg },
          { text: ` ${l.icon} `, fg: on ? t.primary : t.textSubtle, bold: true, bg },
          { text: clip(l.title, leftW - 8).padEnd(leftW - 7), fg: on ? t.text : done ? t.textMuted : t.text, bold: on, bg },
          { text: done ? "✓" : "·", fg: done ? t.success : t.textSubtle, bg },
        ],
      }
    })
    out.push({ segs: [] })
    const n = LESSONS.filter((l) => read().has(l.id)).length
    out.push({ segs: [{ text: "  " }, ...progress(t, n, LESSONS.length, 14), { text: `  ${n}/${LESSONS.length}`, fg: t.textMuted }] })
    return out
  })
  const body = createMemo<Line[]>(() => {
    const t = ui.theme()
    const l = LESSONS[sel()]!
    const w = rightW()
    const out: Line[] = [
      {
        segs: [
          { text: `${l.icon}  `, fg: t.primary, bold: true },
          { text: l.title, fg: t.text, bold: true },
          { text: `   lesson ${sel() + 1} of ${LESSONS.length}`, fg: t.textSubtle },
        ],
      },
      { segs: [{ text: "─".repeat(w), fg: t.borderSubtle }] },
      ...markup(t, l.body, w),
    ]
    const footer: Line[] = [{ segs: [] }]
    if (l.try) footer.push({ segs: [keycap(t, "t"), { text: ` try it: ${l.try.label}`, fg: t.accent, bold: true }] })
    const room = bodyH() - footer.length
    return [...out.slice(0, room), ...Array.from({ length: Math.max(0, room - out.length) }, () => ({ segs: [] }) as Line), ...footer]
  })
  return (
    <Modal title="Guide" width={W()} height={H()} hint="↑↓ lesson · t try it · 1-9 jump · esc close">
      <box flexDirection="row" height={bodyH()}>
        <box width={leftW}>
          <Txt value={toStyled(list(), leftW, bodyH())} height={bodyH()} />
        </box>
        <Txt
          value={toStyled(
            Array.from({ length: bodyH() }, () => ({ segs: [{ text: "│ ", fg: ui.theme().borderSubtle }] })),
            2,
          )}
        />
        <box flexGrow={1} paddingLeft={1}>
          <Txt value={toStyled(body(), rightW(), bodyH())} height={bodyH()} />
        </box>
      </box>
    </Modal>
  )
}

// ───────────────────────────── Recipes ─────────────────────────────

const RECIPE_ICONS: Record<string, string> = {
  "best-of-3": "♛",
  "plan-execute": "▤",
  "research-implement": "⌕",
  "implement-review": "⟲",
  "debug-hypotheses": "∴",
  "test-first": "✓",
  shard: "⋔",
}

export function RecipesOverlay(props: { onClose: () => void; onPick: (name: string) => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(0)
  const [recipes] = createResource(async () => (ui.client ? (await ui.client.call("recipes.list", {}).catch(() => ({ recipes: [] }))).recipes : []))
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
  const W = () => Math.min(100, dims().width - 4)
  const H = () => Math.min(28, dims().height - 2)
  const detail = createMemo<Line[]>(() => {
    const r = recipes()?.[sel()]
    const t = ui.theme()
    if (!r) return []
    const steps = r.steps ?? []
    return [
      {
        segs: [
          { text: `${RECIPE_ICONS[r.name] ?? "◆"}  `, fg: t.primary, bold: true },
          { text: r.title, fg: t.text, bold: true },
          { text: r.agents ? `   ${r.agents}` : "", fg: t.textSubtle },
        ],
      },
      ...wrap(r.description, W() - 6).map((l) => ({ segs: [{ text: l, fg: t.textMuted }] })),
      { segs: [] },
      ...steps.slice(0, 5).flatMap((s) =>
        wrap(s, W() - 8).map((l, i) => ({
          segs: [
            { text: i ? "   " : "", fg: t.textSubtle },
            { text: l, fg: t.textSubtle },
          ],
        })),
      ),
      { segs: [] },
      { segs: [keycap(t, "enter"), { text: ` → /recipe ${r.name} <your task>`, fg: t.accent }] },
    ]
  })
  const listH = () => Math.min(9, Math.max(1, recipes()?.length ?? 1))
  return (
    <Modal title="Recipes — proven multi-agent workflows" width={W()} height={H()} hint="↑↓ select · enter use · esc close">
      <ListView
        items={(recipes() ?? []).map((r) => ({
          label: [
            { text: `${RECIPE_ICONS[r.name] ?? "◆"} `, fg: ui.theme().primary },
            { text: r.title.padEnd(26), fg: ui.theme().text },
            { text: clip(r.description, W() - 40), fg: ui.theme().textMuted },
          ],
          right: r.source === "builtin" ? "" : r.source,
        }))}
        selected={sel()}
        width={W() - 4}
        height={listH()}
      />
      <Txt value={segs({ text: "─".repeat(W() - 4), fg: ui.theme().borderSubtle })} />
      <Txt value={toStyled(detail(), W() - 4, H() - listH() - 4)} height={H() - listH() - 4} />
    </Modal>
  )
}
