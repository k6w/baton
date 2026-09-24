/**
 * Settings catalogue: every user-facing setting with label, help text and editor type.
 * Drives the TUI settings screen (and `baton config` docs). Keys are config paths.
 */
export type SettingType =
  | { kind: "enum"; options: readonly string[] }
  | { kind: "bool" }
  | { kind: "number"; min?: number; max?: number; step?: number; optional?: boolean }
  | { kind: "string"; optional?: boolean; placeholder?: string }
  | { kind: "theme" }
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

const e = (...options: string[]) => ({ kind: "enum" as const, options })

export const SETTINGS: SettingDef[] = [
  // Appearance
  {
    key: "ui.theme",
    section: "Appearance",
    label: "Theme",
    help: 'Color theme. ctrl+t previews them live. "system" uses your terminal\'s palette.',
    type: { kind: "theme" },
    ui: true,
  },
  {
    key: "ui.appearance",
    section: "Appearance",
    label: "Light / dark",
    help: "auto follows the terminal background and switches to a theme's light or dark twin.",
    type: e("auto", "dark", "light"),
    ui: true,
  },
  {
    key: "ui.layout",
    section: "Appearance",
    label: "Layout",
    help: "grid: lead on top, agent cards below · list: one row per agent (many agents) · focus: one agent zoomed · swarm: dense grid · wide: lead column on the left",
    type: e("grid", "list", "focus", "swarm", "wide"),
    ui: true,
  },
  {
    key: "ui.border",
    section: "Appearance",
    label: "Borders",
    help: "Pane border style.",
    type: e("rounded", "single", "heavy", "double", "ascii", "none"),
    ui: true,
  },
  {
    key: "ui.icons",
    section: "Appearance",
    label: "Agent icons",
    help: "auto shows real logos where the terminal supports images (Kitty/Sixel), otherwise glyphs.",
    type: e("auto", "unicode", "nerd", "ascii"),
    ui: true,
  },
  {
    key: "ui.render_style",
    section: "Appearance",
    label: "Look",
    help: "native: each agent looks like its own CLI (Claude ● ⎿, Codex • └) · unified: one look for all.",
    type: e("native", "unified"),
    ui: true,
  },
  {
    key: "ui.density",
    section: "Appearance",
    label: "Density",
    help: "compact shows fewer diff/output lines per card.",
    type: e("comfy", "compact"),
    ui: true,
  },
  {
    key: "ui.spinner",
    section: "Appearance",
    label: "Spinner",
    help: "Animation shown while agents work.",
    type: e("star", "dots", "circle", "moon", "arc", "pulse", "bounce", "line", "diamond"),
    ui: true,
  },
  {
    key: "ui.animations",
    section: "Appearance",
    label: "Animations",
    help: "Turn off for reduced motion or slow connections.",
    type: { kind: "bool" },
    ui: true,
  },
  {
    key: "ui.show_bus",
    section: "Appearance",
    label: "Bus pane",
    help: "Show the agent-to-agent message log as a grid cell.",
    type: { kind: "bool" },
    ui: true,
  },
  {
    key: "ui.show_thoughts",
    section: "Appearance",
    label: "Show reasoning",
    help: "Show agents' thinking text in their cards.",
    type: { kind: "bool" },
    ui: true,
  },
  {
    key: "ui.min_card_width",
    section: "Appearance",
    label: "Min card width",
    help: "Cards get at least this many columns; more agents than fit are paged.",
    type: { kind: "number", min: 24, max: 200, step: 4 },
    ui: true,
  },
  {
    key: "ui.max_columns",
    section: "Appearance",
    label: "Max columns",
    help: "Upper bound on grid columns.",
    type: { kind: "number", min: 1, max: 8 },
    ui: true,
  },
  { key: "ui.timestamp_format", section: "Appearance", label: "Timestamps", help: "Bus log time format.", type: e("ss.mmm", "hh:mm:ss", "relative"), ui: true },
  {
    key: "ui.fps",
    section: "Appearance",
    label: "Frame rate",
    help: "Max redraws per second (lower = less CPU, e.g. over SSH).",
    type: { kind: "number", min: 5, max: 120, step: 5 },
  },
  { key: "ui.mouse", section: "Appearance", label: "Mouse", help: "Click to focus, double-click to zoom. Restart to apply.", type: { kind: "bool" } },
  // Orchestrator
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
    key: "orchestrator.approval",
    section: "Orchestrator",
    label: "Lead autonomy",
    help: "ask: approve everything · auto-edit: edits ok · auto: commands ok · yolo: anything",
    type: e("ask", "auto-edit", "auto", "yolo"),
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
  // Agents
  { key: "defaults.worker", section: "Agents", label: "Default worker", help: "Adapter used by /spawn without arguments.", type: { kind: "adapter" } },
  {
    key: "defaults.approval",
    section: "Agents",
    label: "Worker autonomy",
    help: "How freely workers act on their own (Baton's policy still sees every request).",
    type: e("ask", "auto-edit", "auto", "yolo"),
  },
  // Workspaces
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
    help: "suggested: the lead gets cross-vendor reviews · required: merges need an approving review.",
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
  // Safety
  {
    key: "policy.preset",
    section: "Safety & budget",
    label: "Approval policy",
    help: "strict: only reads auto-approved · balanced: reads + edits; risky commands ask · yolo: everything.",
    type: e("strict", "balanced", "yolo"),
  },
  {
    key: "policy.timeout_s",
    section: "Safety & budget",
    label: "Auto-deny after",
    help: "Seconds before an unanswered approval is denied (0 = wait forever).",
    type: { kind: "number", min: 0, max: 3600, step: 30 },
  },
  {
    key: "budget.run_usd",
    section: "Safety & budget",
    label: "Run budget ($)",
    help: "Interrupt everything at this spend (empty = none).",
    type: { kind: "number", min: 0, step: 1, optional: true },
  },
  {
    key: "budget.per_agent_usd",
    section: "Safety & budget",
    label: "Per-agent budget ($)",
    help: "Interrupt an agent at this spend.",
    type: { kind: "number", min: 0, step: 0.5, optional: true },
  },
  {
    key: "budget.max_agents",
    section: "Safety & budget",
    label: "Max agents",
    help: "Upper bound on simultaneously running agents.",
    type: { kind: "number", min: 1, max: 64 },
  },
  {
    key: "budget.max_depth",
    section: "Safety & budget",
    label: "Spawn depth",
    help: "How deep agents may spawn agents (0 = only the lead spawns).",
    type: { kind: "number", min: 0, max: 5 },
  },
  // Notifications
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
    help: "Which events notify you.",
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
  // Bus
  {
    key: "bus.heartbeat_s",
    section: "Bus",
    label: "Heartbeat (s)",
    help: "Workers report liveness/progress to the lead this often (0 = off).",
    type: { kind: "number", min: 0, max: 600, step: 5 },
  },
  { key: "bus.contact", section: "Bus", label: "Who may message whom", help: "open: anyone · tree: only parent/children/siblings.", type: e("open", "tree") },
]

export const SETTING_SECTIONS = [...new Set(SETTINGS.map((s) => s.section))]
