/**
 * Main-input router. One line from the user can be:
 *   /command args          → daemon command (spawn, kill, mode, …)
 *   @name [@name2] text    → straight to those agents (bypassing the orchestrator)
 *   @all text / @role:x    → broadcast
 *   !name                  → interrupt that agent (!all for everyone)
 *   anything else          → the orchestrator
 */
import { listRecipes, renderRecipe } from "./recipes.ts"
import type { Runtime } from "./runtime.ts"

export interface InputResult {
  routedTo: string[]
  command?: string
  output?: string
}

export const DAEMON_COMMANDS: Record<string, string> = {
  spawn: "/spawn <adapter|profile> [count] [label…] — start agents (e.g. /spawn codex 5 typo hunt)",
  kill: "/kill <name|all> — stop agents",
  interrupt: "/interrupt <name|all> — interrupt current turns",
  mode: "/mode <orchestrator|solo|…> — switch orchestrator playbook",
  model: "/model <name> <model> — switch an agent's model",
  label: "/label <name> <text> — set an agent's card label",
  rename: "/rename <name> <new-name>",
  agents: "/agents — list agents and installed adapters",
  merge: "/merge <agent|all> — merge worktree changes into the project",
  undo: "/undo [agent] — undo the last merge (three-way: later edits are kept)",
  sync: "/sync <agent> — bring the project's latest state into an agent's worktree",
  review: "/review <agent> [reviewer] — cross-vendor review of an agent's changes",
  diff: "/diff <agent> — show what an agent changed",
  plan: "/plan approve|reject [notes] — decide on the orchestrator's proposed plan",
  recipe: "/recipe <name> <task> — run a proven multi-agent workflow (best-of-3, plan-execute, …)",
  approve: "/approve [all] — approve the oldest (or all) pending requests",
  deny: "/deny [all] — deny the oldest (or all) pending requests",
}

export async function handleInput(rt: Runtime, raw: string): Promise<InputResult> {
  const text = raw.trim()
  if (!text) return { routedTo: [] }

  if (text.startsWith("/")) return await handleCommand(rt, text)

  if (text.startsWith("!")) {
    const target = text.slice(1).trim() || "all"
    const targets = target === "all" ? [...rt.agents.values()].filter((a) => a.busy) : [rt.findAgent(target)].filter(Boolean)
    for (const t of targets) await rt.interrupt(t!.info.agentId)
    return { routedTo: targets.map((t) => t!.info.name), command: "interrupt" }
  }

  // leading @mentions
  const mentions: string[] = []
  let rest = text
  while (true) {
    const m = /^@([\w.:*-]+)[,\s]*/.exec(rest)
    if (!m) break
    mentions.push(m[1] as string)
    rest = rest.slice(m[0].length)
  }
  if (mentions.length) {
    if (!rest.trim()) throw new Error("message is empty")
    const routed: string[] = []
    for (const mention of mentions) {
      const to = mention === "all" ? "*" : mention
      const recipients = rt.resolveRecipients(to)
      if (recipients.length === 0) throw new Error(`no agent matches @${mention}`)
      rt.send({ from: "user", to, body: rest, kind: "chat", delivery: "steer" })
      routed.push(...recipients.map((r) => r.info.name))
    }
    return { routedTo: [...new Set(routed)] }
  }

  const orch = await rt.ensureOrchestrator()
  await rt.promptAgent(orch.info.agentId, text, { from: "user", delivery: orch.busy && orch.caps.steer ? "steer" : "queue" })
  return { routedTo: [orch.info.name] }
}

async function handleCommand(rt: Runtime, text: string): Promise<InputResult> {
  const [cmdRaw, ...args] = text.slice(1).split(/\s+/)
  const cmd = (cmdRaw ?? "").toLowerCase()
  const byName = (n: string | undefined) => {
    if (!n) throw new Error("agent name required")
    const a = rt.findAgent(n)
    if (!a) throw new Error(`no agent "${n}"`)
    return a
  }
  switch (cmd) {
    case "spawn": {
      // `/spawn` alone (or `/spawn 3 label`) uses the configured default worker
      const adapter = !args[0] || /^\d+$/.test(args[0]) ? rt.config.defaults.worker : args[0]
      if (!args[0] || /^\d+$/.test(args[0])) args.unshift(adapter)
      let count = 1
      let labelParts = args.slice(1)
      if (args[1] && /^\d+$/.test(args[1])) {
        count = Math.min(16, Number(args[1]))
        labelParts = args.slice(2)
      }
      const label = labelParts.join(" ") || undefined
      const names: string[] = []
      for (let i = 0; i < count; i++) names.push((await rt.spawn({ adapter, label })).name)
      return { routedTo: names, command: cmd, output: `spawned ${names.join(", ")}` }
    }
    case "kill": {
      const targets = args[0] === "all" ? [...rt.agents.values()].filter((a) => !a.info.isOrchestrator && !a.closing) : [byName(args[0])]
      for (const t of targets) await rt.kill(t.info.agentId)
      return { routedTo: targets.map((t) => t.info.name), command: cmd, output: `killed ${targets.length}` }
    }
    case "interrupt": {
      const targets = !args[0] || args[0] === "all" ? [...rt.agents.values()].filter((a) => a.busy) : [byName(args[0])]
      for (const t of targets) await rt.interrupt(t.info.agentId)
      return { routedTo: targets.map((t) => t.info.name), command: cmd }
    }
    case "mode": {
      if (!args[0]) return { routedTo: [], command: cmd, output: `mode: ${rt.state.mode}` }
      rt.setMode(args[0])
      return { routedTo: [], command: cmd, output: `mode: ${args[0]}` }
    }
    case "model": {
      const a = byName(args[0])
      if (!args[1]) throw new Error("usage: /model <name> <model>")
      if (!a.session?.setModel) throw new Error(`${a.info.name} can't switch models at runtime`)
      await a.session.setModel(args[1])
      rt.emit({ type: "agent.updated", data: { model: args[1] } }, a.info.agentId)
      return { routedTo: [a.info.name], command: cmd }
    }
    case "label": {
      const a = byName(args[0])
      rt.rename(a.info.agentId, undefined, args.slice(1).join(" "))
      return { routedTo: [a.info.name], command: cmd }
    }
    case "rename": {
      const a = byName(args[0])
      rt.rename(a.info.agentId, args[1])
      return { routedTo: [a.info.name], command: cmd }
    }
    case "agents": {
      const detected = await rt.registry.detectAll()
      const lines = detected
        .sort((a, b) => Number(b.installed) - Number(a.installed))
        .map(
          (d) =>
            `${d.installed ? "●" : "○"} ${d.id.padEnd(14)} ${d.installed ? `v${d.version ?? "?"}` : "not installed"}${d.installed ? ` · auth ${d.auth}` : ""}`,
        )
      return { routedTo: [], command: cmd, output: lines.join("\n") }
    }
    case "merge": {
      const targets =
        args[0] === "all"
          ? [...rt.collab.workspaces.byAgent.values()]
              .filter((w) => w.mode === "worktree")
              .map((w) => rt.agents.get(w.agentId)!)
              .filter(Boolean)
          : [byName(args[0])]
      const lines: string[] = []
      for (const t of targets) {
        const r = await rt.collab.merge(t.info.agentId)
        lines.push(
          r.status === "merged"
            ? `✓ ${t.info.name}: ${r.files.length} file(s) merged`
            : r.status === "empty"
              ? `· ${t.info.name}: nothing to merge`
              : `✗ ${t.info.name}: ${r.status} — ${r.detail ?? ""}`,
        )
      }
      return { routedTo: targets.map((t) => t.info.name), command: cmd, output: lines.join("\n") || "no worktrees" }
    }
    case "undo": {
      const t = args[0] ? byName(args[0]) : undefined
      const r = await rt.collab.undoMerge(t?.info.agentId)
      if (!r.ok) throw new Error(`undo failed: ${r.detail ?? ""}`)
      return {
        routedTo: r.agentName ? [r.agentName] : [],
        command: cmd,
        output: `undid ${r.agentName}'s merge (${r.files.join(", ")}) — its changes are unmerged again`,
      }
    }
    case "sync": {
      const t = byName(args[0])
      const r = await rt.collab.sync(t.info.agentId)
      return {
        routedTo: [t.info.name],
        command: cmd,
        output: r.clean ? `${t.info.name} is up to date` : `${t.info.name}: conflicts in ${r.conflicts.join(", ")} — asked to resolve`,
      }
    }
    case "review": {
      const t = byName(args[0])
      const r = await rt.collab.requestReview(t.info.agentId, { reviewer: args[1] })
      return { routedTo: [t.info.name], command: cmd, output: `${r.reviewer} is reviewing ${t.info.name}` }
    }
    case "diff": {
      const t = byName(args[0])
      const ws = await rt.collab.refresh(t.info.agentId)
      const files = ws?.files ?? []
      return {
        routedTo: [t.info.name],
        command: cmd,
        output: files.length ? files.map((f) => `${f.path}  +${f.added} −${f.removed}`).join("\n") : `${t.info.name}: no unmerged changes`,
      }
    }
    case "recipe": {
      const recipes = listRecipes(rt.projectRoot)
      const name = args[0]
      const r = recipes.find((x) => x.name === name)
      if (!r) return { routedTo: [], command: cmd, output: recipes.map((x) => `${x.name.padEnd(20)} ${x.description}`).join("\n") }
      const task = args.slice(1).join(" ").trim()
      if (!task) throw new Error(`usage: /recipe ${r.name} <task>`)
      const orch = await rt.ensureOrchestrator()
      await rt.promptAgent(orch.info.agentId, renderRecipe(r, task), { from: "user" })
      return { routedTo: [orch.info.name], command: cmd, output: `${r.title}: started` }
    }
    case "plan": {
      const verdict = args[0]
      if (verdict !== "approve" && verdict !== "reject") throw new Error(DAEMON_COMMANDS.plan)
      const ok = rt.collab.decidePlan(verdict === "approve", args.slice(1).join(" ") || undefined)
      return { routedTo: [], command: cmd, output: ok ? `plan ${verdict === "approve" ? "approved" : "rejected"}` : "no plan is waiting for approval" }
    }
    case "approve":
    case "deny": {
      const pending = [...rt.state.approvals.values()].sort((a, b) => a.ts - b.ts)
      const targets = args[0] === "all" ? pending : pending.slice(0, 1)
      for (const p of targets) {
        const want = cmd === "approve" ? "allow_once" : "reject_once"
        const opt = p.options.find((o) => o.kind === want) ?? p.options.find((o) => o.kind.startsWith(cmd === "approve" ? "allow" : "reject"))
        await rt.resolvePermission(p.agentId, p.requestId, opt?.optionId ?? null)
      }
      return { routedTo: [], command: cmd, output: `${cmd === "approve" ? "approved" : "denied"} ${targets.length}` }
    }
    default:
      throw new Error(`unknown command /${cmd}`)
  }
}
