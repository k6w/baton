/**
 * Record a live Codex app-server session as a JSONL fixture (real tokens — keep prompts tiny).
 *
 *   BATON_LIVE=1 bun packages/adapters/codex/src/fixtures/record.ts [name]
 *
 * Every JSON-RPC message (both directions) is captured via BATON_CODEX_TAP, then home and
 * workspace paths are scrubbed so fixtures are machine-independent.
 */
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { startHarness, tempWorkspace } from "../../../testkit/src/index.ts"

interface Scenario {
  files: Record<string, string>
  approval: "ask" | "auto-edit" | "auto"
  prompts: string[]
  /** Interrupt the (last) turn once the first assistant delta arrives. */
  interrupt?: boolean
}

const SCENARIOS: Record<string, Scenario> = {
  // Command execution + approval-gated file edit + reasoning + usage in one short turn.
  "edit-with-approval": {
    files: { "notes.txt": "teh quick brown fox\n" },
    approval: "ask",
    prompts: [
      "Run `wc -l notes.txt` once, then fix the typo in notes.txt (teh -> the) by editing the file. Reply with one short sentence.",
    ],
  },
  // apply_patch edits (update + add) behind a fileChange approval.
  "apply-patch": {
    files: { "notes.txt": "teh quick brown fox\njumps\n" },
    approval: "ask",
    prompts: [
      "Using the apply_patch tool (not shell commands), change 'teh' to 'the' in notes.txt and create hello.txt containing the single line 'hi'. Then reply 'done'.",
    ],
  },
  // A turn interrupted mid-stream.
  interrupt: {
    files: {},
    approval: "auto",
    prompts: ["Without using any tools, write the numbers from 1 to 300 as words, one per line."],
    interrupt: true,
  },
}

if (process.env.BATON_LIVE !== "1") {
  console.error("refusing to spend tokens: set BATON_LIVE=1")
  process.exit(1)
}

const { codexAdapter } = await import("../index.ts")
const names = process.argv.slice(2)
if (!names.length) names.push("edit-with-approval")
for (const name of names) await record(name)

async function record(name: string): Promise<void> {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`unknown scenario ${name}; have ${Object.keys(SCENARIOS).join(", ")}`)

  const out = join(import.meta.dir, `${name}.jsonl`)
  const tap = `${out}.tmp`
  rmSync(tap, { force: true })
  process.env.BATON_CODEX_TAP = tap

  const cwd = tempWorkspace(scenario.files)
  const h = await startHarness(codexAdapter, {
    cwd,
    approval: scenario.approval,
  })
  try {
    for (const text of scenario.prompts) {
      const turn = h.waitTurn(300_000)
      await h.session.prompt({ text })
      if (scenario.interrupt) {
        await h.waitFor("message.delta", (e) => e.data.role === "assistant", 120_000)
        await h.session.interrupt()
      }
      await turn
    }
  } finally {
    await h.close()
  }

  // Scrub machine-specific paths (both the symlinked and the real tmp path).
  let data = readFileSync(tap, "utf8")
  for (const p of [realpathSync(cwd), cwd]) data = data.split(p).join("/workspace")
  data = data.split(homedir()).join("/home/user")
  data = data.split(hostname()).join("host.local")
  data = data.replace(/"installationId":"[^"]*"/g, '"installationId":"00000000-0000-0000-0000-000000000000"')
  writeFileSync(out, data)
  rmSync(tap, { force: true })
  console.log(`wrote ${out} (${data.split("\n").length - 1} messages); events:`)
  for (const e of h.events) console.log(`  ${e.type} ${JSON.stringify(e.data).slice(0, 160)}`)
}
