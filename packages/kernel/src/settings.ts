/**
 * Settings catalogue: every user-facing setting with label, help text and editor type, grouped
 * into sections. Drives the TUI settings screen (and `baton config` docs). Keys are config paths.
 */
export type SettingType =
  | { kind: "enum"; options: readonly string[]; labels?: Record<string, string> }
  | { kind: "bool" }
  | { kind: "number"; min?: number; max?: number; step?: number; optional?: boolean; unit?: string }
  | { kind: "string"; optional?: boolean; placeholder?: string }
  | { kind: "theme" }
  | { kind: "style" }
  | { kind: "adapter" }
  | { kind: "list"; options?: readonly string[] }

export interface SettingDef {
  key: string
  section: string
  label: string
  help: string
  type: SettingType
  /** Applies instantly in the UI (no daemon reload needed). */
  ui?: boolean
}

export interface SettingSection {
  name: string
  icon: string
  /** One line under the section title. */
  blurb: string
}

export const SECTIONS: SettingSection[] = [
  { name: "Looks", icon: "◐", blurb: "Style (shapes) and theme (colors). Everything previews live." },
  { name: "Layout", icon: "▦", blurb: "How panes are arranged and what they show." },
  { name: "Autonomy & safety", icon: "↯", blurb: "How freely agents act, what they may do without you, and what it may cost." },
  { name: "Orchestrator", icon: "✱", blurb: "The lead agent: who plans and coordinates the work." },
  { name: "Agents", icon: "◆", blurb: "Defaults for the workers the orchestrator (or you) starts." },
  { name: "Workspaces", icon: "⎇", blurb: "Worktrees, reviews and merges — how changes land in your project." },
  { name: "Notifications", icon: "⚑", blurb: "How Baton gets your attention when something needs you." },
  { name: "Advanced", icon: "⋯", blurb: "Performance, the message bus, input." },
]

const e = (...options: string[]) => ({ kind: "enum" as const, options })

export const SETTINGS: SettingDef[] = [
  // ── Looks
  {
    key: "ui.style",
    section: "Looks",
    label: "Style",
    help: "The shape of everything: frames, status bar, background. classic · modern · minimal · accent · tabs · neon · retro · zen · paper · glass · brutalist. Enter opens the gallery with a live preview.",
    type: { kind: "style" },
    ui: true,
  },
  {
    key: "ui.theme",
    section: "Looks",
    label: "Theme",
    help: 'Colors. Enter (or ctrl+t) previews them all live. "system" uses your terminal\'s palette.',
    type: { kind: "theme" },
    ui: true,
  },
  {
    key: "ui.appearance",
    section: "Looks",
    label: "Light / dark",
    help: "auto follows the terminal background and switches to a theme's light or dark twin.",
    type: e("auto", "dark", "light"),
    ui: true,
  },
  {
    key: "ui.background",
    section: "Looks",
    label: "Background",
    help: "theme: Baton paints the theme's background · terminal: no background — your terminal's own color, transparency and blur show through.",
    type: e("theme", "terminal"),
    ui: true,
  },
  {
    key: "ui.frame",
    section: "Looks",
    label: "Frames",
    help: "line: rounded boxes · tab: titles in filled tabs · bar: filled title bars · minimal: a title rule only · accent: a colored stripe per pane.",
    type: e("line", "tab", "bar", "minimal", "accent"),
    ui: true,
  },
  {
    key: "ui.border",
    section: "Looks",
    label: "Box lines",
    help: "Line style for line / tab frames.",
    type: e("rounded", "single", "heavy", "double", "ascii", "none"),
    ui: true,
  },
  {
    key: "ui.status_style",
    section: "Looks",
    label: "Status bar",
    help: "plain bar · blocks (chips) · powerline (needs a Nerd Font) · minimal (just text).",
    type: e("plain", "blocks", "powerline", "minimal"),
    ui: true,
  },
  {
    key: "ui.brand_borders",
    section: "Looks",
    label: "Agent colors on cards",
    help: "Tint each agent card's frame with its brand color (Claude orange, Gemini blue, …).",
    type: { kind: "bool" },
    ui: true,
  },
  {
    key: "ui.icons",
    section: "Looks",
    label: "Agent icons",
    help: "auto shows real logos where the terminal supports images (Kitty/Sixel), otherwise glyphs. nerd needs a Nerd Font.",
    type: e("auto", "unicode", "nerd", "ascii"),
    ui: true,
  },
  {
    key: "ui.render_style",
    section: "Looks",
    label: "Agent output",
    help: "native: each agent looks like its own CLI (Claude ● ⎿, Codex • └) · unified: one look for all.",
    type: e("native", "unified"),
    ui: true,
  },
  {
    key: "ui.spinner",
    section: "Looks",
    label: "Spinner",
    help: "Animation shown while agents work.",
    type: e("star", "dots", "circle", "moon", "arc", "pulse", "bounce", "line", "diamond"),
    ui: true,
  },
  {
    key: "ui.animations",
    section: "Looks",
    label: "Animations",
    help: "Turn off for reduced motion or slow connections.",
    type: { kind: "bool" },
    ui: true,
  },
  // ── Layout
  {
    key: "ui.layout",
    section: "Layout",
    label: "Layout",
    help: "grid: lead on top, cards below · list: one row per agent (many agents) · focus: one agent large · swarm: dense grid · wide: lead column on the left. ctrl+l cycles.",
    type: e("grid", "list", "focus", "swarm", "wide"),
    ui: true,
  },
  {
    key: "ui.density",
    section: "Layout",
    label: "Density",
    help: "compact shows fewer diff/output lines per card.",
    type: e("comfy", "compact"),
    ui: true,
  },
  {
    key: "ui.show_bus",
    section: "Layout",
    label: "Bus pane",
    help: "Show the agent-to-agent message log as a grid cell. ctrl+b toggles.",
    type: { kind: "bool" },
    ui: true,
  },
  {
    key: "ui.show_thoughts",
    section: "Layout",
    label: "Show reasoning",
    help: "Show agents' thinking text in their cards. ctrl+o toggles.",
    type: { kind: "bool" },
    ui: true,
  },
  { key: "ui.hints", section: "Layout", label: "Hint bar", help: "The one-line bar with the keys that matter right now.", type: { kind: "bool" }, ui: true },
  {
    key: "ui.min_card_width",
    section: "Layout",
    label: "Min card width",
    help: "Cards get at least this many columns; more agents than fit are paged.",
    type: { kind: "number", min: 24, max: 200, step: 4, unit: "cols" },
    ui: true,
  },
  {
    key: "ui.max_columns",
    section: "Layout",
    label: "Max columns",
    help: "Upper bound on grid columns.",
    type: { kind: "number", min: 1, max: 8 },
    ui: true,
  },
  {
    key: "ui.timestamp_format",
    section: "Layout",
    label: "Timestamps",
    help: "Bus log time format.",
    type: e("ss.mmm", "hh:mm:ss", "relative"),
    ui: true,
  },
  {
    key: "ui.tab_title",
    section: "Layout",
    label: "Tab title",
    help: 'Show "⚑ 2 baton · project" in the terminal tab title.',
    type: { kind: "bool" },
    ui: true,
  },
  // ── Autonomy & safety
  {
    key: "policy.autonomy",
    section: "Autonomy & safety",
    label: "Autonomy",
    help: "One dial for every agent, including running ones. normal: each agent's own setting · ask: everyone asks first · auto: agents act, destructive commands ask · yolo: no prompts, no sandbox. shift+tab switches it for this run.",
    type: { kind: "enum", options: ["normal", "ask", "auto", "yolo"], labels: { yolo: "YOLO" } },
  },
  {
    key: "policy.preset",
    section: "Autonomy & safety",
    label: "Approval policy",
    help: "Used at autonomy normal. strict: only reads auto-approved · balanced: reads + edits; risky commands ask · yolo: everything.",
    type: e("strict", "balanced", "yolo"),
  },
  {
    key: "orchestrator.approval",
    section: "Autonomy & safety",
    label: "Lead autonomy",
    help: "Used at autonomy normal. ask: approve everything · auto-edit: edits ok · auto: commands ok · yolo: anything.",
    type: e("ask", "auto-edit", "auto", "yolo"),
  },
  {
    key: "defaults.approval",
    section: "Autonomy & safety",
    label: "Worker autonomy",
    help: "Used at autonomy normal. How freely workers act on their own (Baton's policy still sees every request).",
    type: e("ask", "auto-edit", "auto", "yolo"),
  },
  {
    key: "policy.timeout_s",
    section: "Autonomy & safety",
    label: "Auto-deny after",
    help: "Seconds before an unanswered approval is denied (0 = wait forever).",
    type: { kind: "number", min: 0, max: 3600, step: 30, unit: "s" },
  },
  {
    key: "budget.run_usd",
    section: "Autonomy & safety",
    label: "Run budget",
    help: "Stop all new work at this spend (empty = none). Raising it lets work continue.",
    type: { kind: "number", min: 0, step: 1, optional: true, unit: "$" },
  },
  {
    key: "budget.per_agent_usd",
    section: "Autonomy & safety",
    label: "Per-agent budget",
    help: "Stop an agent at this spend.",
    type: { kind: "number", min: 0, step: 0.5, optional: true, unit: "$" },
  },
  {
    key: "budget.max_agents",
    section: "Autonomy & safety",
    label: "Max agents",
    help: "Upper bound on simultaneously running agents.",
    type: { kind: "number", min: 1, max: 64 },
  },
  {
    key: "budget.soft_max_agents",
    section: "Autonomy & safety",
    label: "Ask above",
    help: "Above this many workers the orchestrator needs your OK to start more (0 = never ask).",
    type: { kind: "number", min: 0, max: 64 },
  },
  {
    key: "budget.max_depth",
    section: "Autonomy & safety",
    label: "Spawn depth",
    help: "How deep agents may spawn agents (0 = only the lead spawns).",
    type: { kind: "number", min: 0, max: 5 },
  },
  {
    key: "watchdog.stall_s",
    section: "Autonomy & safety",
    label: "Stuck after",
    help: "Flag a busy agent with no activity for this long (0 = off). Long commands get 3× the time.",
    type: { kind: "number", min: 0, max: 3600, step: 60, unit: "s" },
  },
  // ── Orchestrator
  {
    key: "orchestrator.agent",
    section: "Orchestrator",
    label: "Lead agent",
    help: "Which agent plans and coordinates. Applies to the next orchestrator start (/kill orchestrator to restart).",
    type: { kind: "adapter" },
  },
  {
    key: "orchestrator.model",
    section: "Orchestrator",
    label: "Lead model",
    help: "Model for the lead (empty = the agent's default).",
    type: { kind: "string", optional: true, placeholder: "default" },
  },
  {
    key: "orchestrator.mode",
    section: "Orchestrator",
    label: "Playbook",
    help: "System prompt playbook (.baton/playbooks/<name>.md overrides the built-in).",
    type: { kind: "string" },
  },
  {
    key: "orchestrator.plan_approval",
    section: "Orchestrator",
    label: "Approve plans",
    help: "The lead waits for /plan approve before dispatching work.",
    type: { kind: "bool" },
  },
  // ── Agents
  { key: "defaults.worker", section: "Agents", label: "Default worker", help: "Adapter used by /spawn without arguments.", type: { kind: "adapter" } },
  // ── Workspaces
  {
    key: "workspace.isolation",
    section: "Workspaces",
    label: "Isolation",
    help: "worktree: each worker gets its own git worktree and changes are merged · shared: everyone edits the project.",
    type: e("worktree", "shared"),
  },
  {
    key: "workspace.review",
    section: "Workspaces",
    label: "Reviews",
    help: "suggested: the lead gets cross-vendor reviews · required: merges need an approving review of the exact changes.",
    type: e("off", "suggested", "required"),
  },
  {
    key: "workspace.reviewer",
    section: "Workspaces",
    label: "Reviewer",
    help: "Adapter used for reviews (empty = a different vendor than the author).",
    type: { kind: "string", optional: true, placeholder: "auto" },
  },
  {
    key: "workspace.verify",
    section: "Workspaces",
    label: "Verify command",
    help: "Must pass in the worktree before a merge lands (e.g. bun test).",
    type: { kind: "string", optional: true, placeholder: "none" },
  },
  {
    key: "workspace.setup",
    section: "Workspaces",
    label: "Setup command",
    help: "Runs once in each new worktree (e.g. bun install).",
    type: { kind: "string", optional: true, placeholder: "none" },
  },
  {
    key: "workspace.cleanup",
    section: "Workspaces",
    label: "Cleanup",
    help: "merged keeps worktrees that still hold unmerged work.",
    type: e("merged", "always", "never"),
  },
  {
    key: "workspace.conflict_check",
    section: "Workspaces",
    label: "Predict conflicts",
    help: "Check overlapping edits between workers while they work.",
    type: { kind: "bool" },
  },
  // ── Notifications
  {
    key: "notify.desktop",
    section: "Notifications",
    label: "Desktop notifications",
    help: "Via your terminal (OSC 9/777). Shown when Baton isn't focused.",
    type: { kind: "bool" },
    ui: true,
  },
  { key: "notify.bell", section: "Notifications", label: "Terminal bell", help: "Ring the bell for the same events.", type: { kind: "bool" }, ui: true },
  {
    key: "notify.sound",
    section: "Notifications",
    label: "Sounds",
    help: 'system: a different system sound for approvals, finished work, errors and merges (also while you\'re looking at Baton). Your own files: [notify.sounds] approval = "~/ding.wav".',
    type: { kind: "enum", options: ["off", "system"] },
    ui: true,
  },
  {
    key: "notify.when_focused",
    section: "Notifications",
    label: "Notify when focused",
    help: "Also notify while you're looking at Baton.",
    type: { kind: "bool" },
    ui: true,
  },
  {
    key: "notify.events",
    section: "Notifications",
    label: "Notify on",
    help: "Which events notify you: approval · done · error · merge.",
    type: { kind: "list", options: ["approval", "done", "error", "merge"] },
    ui: true,
  },
  {
    key: "notify.webhook",
    section: "Notifications",
    label: "Webhook URL",
    help: "POST every notification here, even with no TUI attached — e.g. https://ntfy.sh/<topic> for phone push, or a Slack webhook.",
    type: { kind: "string", optional: true, placeholder: "none" },
  },
  {
    key: "notify.webhook_format",
    section: "Notifications",
    label: "Webhook format",
    help: "json · ntfy (ntfy.sh push) · slack (incoming webhook).",
    type: e("json", "ntfy", "slack"),
  },
  {
    key: "notify.command",
    section: "Notifications",
    label: "Notify command",
    help: "Shell command per notification (JSON on stdin, $BATON_TITLE / $BATON_BODY).",
    type: { kind: "string", optional: true, placeholder: "none" },
  },
  // ── Advanced
  {
    key: "ui.fps",
    section: "Advanced",
    label: "Frame rate",
    help: "Max redraws per second (lower = less CPU, e.g. over SSH). Restart to apply.",
    type: { kind: "number", min: 5, max: 120, step: 5, unit: "fps" },
  },
  { key: "ui.mouse", section: "Advanced", label: "Mouse", help: "Click to focus, double-click to zoom. Restart to apply.", type: { kind: "bool" } },
  {
    key: "bus.heartbeat_s",
    section: "Advanced",
    label: "Heartbeat",
    help: "Workers report liveness/progress to the lead this often (0 = off).",
    type: { kind: "number", min: 0, max: 600, step: 5, unit: "s" },
  },
  {
    key: "bus.contact",
    section: "Advanced",
    label: "Who may message whom",
    help: "open: anyone · tree: only parent/children/siblings.",
    type: e("open", "tree"),
  },
]

export const SETTING_SECTIONS = SECTIONS.map((s) => s.name)
