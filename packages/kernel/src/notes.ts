/**
 * Team notes: short facts agents learn and share ("tests need DB_URL", "the API uses snake_case").
 * Stored in .baton/notes.md, one Markdown bullet per note, so people can read and edit them too:
 *
 *   - 2026-10-11 codex-1: the API uses snake_case
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface Note {
  date: string
  author: string
  text: string
}

export const notesPath = (projectRoot: string) => join(projectRoot, ".baton", "notes.md")

const HEADER = "# Team notes\n\nFacts the agents learned about this project. Every new worker reads the latest ones. Edit freely.\n\n"
const LINE = /^-\s+(\d{4}-\d{2}-\d{2})\s+([^:]{1,64}):\s+(.*)$/

export function readNotes(projectRoot: string): Note[] {
  const p = notesPath(projectRoot)
  if (!existsSync(p)) return []
  const out: Note[] = []
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = LINE.exec(line.trim())
    if (m) out.push({ date: m[1] ?? "", author: (m[2] ?? "").trim(), text: (m[3] ?? "").trim() })
    // hand-written bullets count too
    else if (/^[-*]\s+\S/.test(line.trim())) out.push({ date: "", author: "", text: line.trim().replace(/^[-*]\s+/, "") })
  }
  return out
}

/** Append a note (one line; duplicates of an existing note are skipped). Returns false if skipped. */
export function addNote(projectRoot: string, author: string, text: string): boolean {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 500)
  if (!clean) return false
  if (readNotes(projectRoot).some((n) => n.text.toLowerCase() === clean.toLowerCase())) return false
  const p = notesPath(projectRoot)
  mkdirSync(join(projectRoot, ".baton"), { recursive: true })
  if (!existsSync(p)) writeFileSync(p, HEADER)
  const date = new Date().toISOString().slice(0, 10)
  appendFileSync(p, `- ${date} ${author.replace(/[:\n]/g, " ").slice(0, 64) || "agent"}: ${clean}\n`)
  return true
}

/** Notes matching any of the words in `query` (case-insensitive); all notes without a query. */
export function searchNotes(projectRoot: string, query?: string): Note[] {
  const all = readNotes(projectRoot)
  const words = (query ?? "")
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2)
  if (!words.length) return all
  return all.filter((n) => words.some((w) => n.text.toLowerCase().includes(w)))
}

/** The block new workers get in their instructions (the most recent `max` notes). */
export function notesBlock(projectRoot: string, max: number): string | undefined {
  if (max <= 0) return undefined
  const notes = readNotes(projectRoot).slice(-max)
  if (!notes.length) return undefined
  return `\n## Team notes (what earlier agents learned about this project)\n${notes.map((n) => `- ${n.text}`).join("\n")}\nAdd a note with the note tool when you learn something the next agent should know.`
}
