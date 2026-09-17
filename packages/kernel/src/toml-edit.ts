/**
 * Minimal, comment-preserving TOML editing for config files written by the settings screen.
 * Supports setting/removing `key = value` inside `[table]` / `[a.b]` tables (or top level).
 * Values are serialized with smol-toml so quoting is always correct.
 */
import { stringify } from "smol-toml"

function tomlValue(v: unknown): string {
  // stringify({x: v}) → "x = <value>\n"; take the right-hand side
  const s = stringify({ x: v as never }).trim()
  return s.slice(s.indexOf("=") + 1).trim()
}

function quoteKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)
}

const TABLE_RE = /^\s*\[([^[\]]+)\]\s*(#.*)?$/

function normTable(name: string): string {
  return name
    .split(".")
    .map((p) => p.trim().replace(/^"(.*)"$/, "$1"))
    .join(".")
}

/** Set `path` (e.g. "ui.theme", "agent_style.claude.color") to `value`, or remove it when value is undefined. */
export function setTomlValue(text: string, path: string, value: unknown): string {
  const parts = path.split(".")
  const key = parts.pop() as string
  const table = parts.join(".")
  const lines = text.length ? text.replace(/\n$/, "").split("\n") : []

  // locate the table's line range
  let start = -1
  let end = lines.length
  if (table === "") {
    start = -1
    end = lines.findIndex((l) => TABLE_RE.test(l))
    if (end === -1) end = lines.length
  } else {
    for (let i = 0; i < lines.length; i++) {
      const m = TABLE_RE.exec(lines[i] as string)
      if (m && normTable(m[1] as string) === table) {
        start = i
        end = lines.length
        for (let j = i + 1; j < lines.length; j++) {
          if (TABLE_RE.test(lines[j] as string) || /^\s*\[\[/.test(lines[j] as string)) {
            end = j
            break
          }
        }
        break
      }
    }
  }

  const keyRe = new RegExp(`^(\\s*)(${escapeRe(key)}|"${escapeRe(key)}")\\s*=`)
  const from = table === "" ? 0 : start + 1
  if (table === "" || start >= 0) {
    for (let i = from; i < end; i++) {
      const m = keyRe.exec(lines[i] as string)
      if (!m) continue
      if (value === undefined) lines.splice(i, 1)
      else {
        const comment = /\s(#[^"']*)$/.exec(lines[i] as string)?.[1]
        lines[i] = `${m[1]}${quoteKey(key)} = ${tomlValue(value)}${comment ? `  ${comment}` : ""}`
      }
      return `${lines.join("\n")}\n`
    }
    if (value === undefined) return text
    // insert after the last non-blank line of the table
    let at = end
    while (at > from && (lines[at - 1] as string).trim() === "") at--
    lines.splice(at, 0, `${quoteKey(key)} = ${tomlValue(value)}`)
    return `${lines.join("\n")}\n`
  }
  if (value === undefined) return text
  const block = [`[${parts.map(quoteKey).join(".")}]`, `${quoteKey(key)} = ${tomlValue(value)}`]
  const out = lines.length ? [...lines, "", ...block] : block
  return `${out.join("\n")}\n`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
