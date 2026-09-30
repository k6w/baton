/**
 * Comment-preserving TOML editing for config files written by the settings screen.
 * Sets/removes `key = value` inside `[table]` / `[a."b.c"]` tables (or at top level), replacing
 * multi-line values (arrays, """strings""") whole and keeping the file's line endings.
 *
 * Every edit is verified: the edited text must parse to exactly the original document with
 * just that one value changed. Layouts the line editor can't handle safely (inline tables,
 * dotted keys, values defined inside [[array]] tables) fall back to re-serializing the
 * document — correct, but without comments. Values are serialized with smol-toml so quoting
 * is always right. Throws if the original text isn't valid TOML.
 */
import { parse, stringify } from "smol-toml"

function tomlValue(v: unknown): string {
  // stringify({x: v}) → "x = <value>\n"; take the right-hand side
  const s = stringify({ x: v as never }).trim()
  return s.slice(s.indexOf("=") + 1).trim()
}

function quoteKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)
}

/** Split a dotted key / table name, honoring "quoted" and 'literal' parts. */
function splitKey(name: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | undefined
  for (let i = 0; i < name.length; i++) {
    const ch = name[i] as string
    if (quote) {
      if (ch === "\\" && quote === '"') {
        cur += name[++i] ?? ""
        continue
      }
      if (ch === quote) quote = undefined
      else cur += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === ".") {
      out.push(cur.trim())
      cur = ""
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

const HEADER_RE = /^\s*\[(\[?)\s*((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')+?)\s*\]\]?\s*(#.*)?$/

function header(line: string): { name: string[]; array: boolean } | undefined {
  const m = HEADER_RE.exec(line)
  return m ? { name: splitKey(m[2] as string), array: m[1] === "[" } : undefined
}

/** The key on a `key = value` line (unquoted), or undefined. Dotted keys come back joined. */
function lineKey(line: string): { indent: string; key: string[]; rest: string } | undefined {
  const m = /^(\s*)((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=(.*)$/.exec(line)
  return m ? { indent: m[1] as string, key: splitKey(m[2] as string), rest: m[3] as string } : undefined
}

/** Index of the last line of the value that starts on `lines[i]` (multi-line arrays / strings). */
function valueEnd(lines: string[], i: number, rest: string): number {
  let depth = 0
  let j = i
  let text = rest
  let inMulti: string | undefined
  for (;;) {
    for (let k = 0; k < text.length; k++) {
      const ch = text[k] as string
      if (inMulti) {
        if (text.startsWith(inMulti, k)) {
          k += 2
          inMulti = undefined
        } else if (ch === "\\" && inMulti === '"""') k++
        continue
      }
      if (text.startsWith('"""', k) || text.startsWith("'''", k)) {
        inMulti = text.slice(k, k + 3)
        k += 2
        continue
      }
      if (ch === "#") break
      if (ch === '"') {
        for (k++; k < text.length && text[k] !== '"'; k++) if (text[k] === "\\") k++
        continue
      }
      if (ch === "'") {
        for (k++; k < text.length && text[k] !== "'"; k++);
        continue
      }
      if (ch === "[" || ch === "{") depth++
      else if (ch === "]" || ch === "}") depth--
    }
    if ((depth <= 0 && !inMulti) || j + 1 >= lines.length) return j
    j++
    text = lines[j] as string
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a, (_k, v) => (v instanceof Date ? v.toISOString() : v)) === JSON.stringify(b, (_k, v) => (v instanceof Date ? v.toISOString() : v))
}

function setIn(doc: Record<string, unknown>, parts: string[], value: unknown) {
  let cur = doc
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p])) cur[p] = {}
    cur = cur[p] as Record<string, unknown>
  }
  const last = parts[parts.length - 1] as string
  if (value === undefined) delete cur[last]
  else cur[last] = value
}

function lineEdit(text: string, parts: string[], value: unknown): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const key = parts[parts.length - 1] as string
  const table = parts.slice(0, -1)
  const lines = text.length ? text.replace(/\r?\n$/, "").split(/\r?\n/) : []
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

  // locate the table's line range ([[array]] tables are never the target)
  let start = -1
  let end = lines.length
  if (table.length === 0) {
    end = lines.findIndex((l) => header(l))
    if (end === -1) end = lines.length
  } else {
    for (let i = 0; i < lines.length; i++) {
      const h = header(lines[i] as string)
      if (h && !h.array && same(h.name, table)) {
        start = i
        end = lines.length
        for (let j = i + 1; j < lines.length; j++)
          if (header(lines[j] as string)) {
            end = j
            break
          }
        break
      }
    }
  }
  const from = table.length === 0 ? 0 : start + 1
  if (table.length === 0 || start >= 0) {
    for (let i = from; i < end; i++) {
      const k = lineKey(lines[i] as string)
      if (!k || !same(k.key, [key])) continue
      const last = valueEnd(lines, i, k.rest)
      if (value === undefined) lines.splice(i, last - i + 1)
      else {
        const comment = /\s(#[^"']*)$/.exec(lines[last] as string)?.[1]
        lines.splice(i, last - i + 1, `${k.indent}${quoteKey(key)} = ${tomlValue(value)}${comment ? `  ${comment}` : ""}`)
      }
      return `${lines.join(eol)}${eol}`
    }
    if (value === undefined) return text
    // insert after the last non-blank line of the table
    let at = end
    while (at > from && (lines[at - 1] as string).trim() === "") at--
    lines.splice(at, 0, `${quoteKey(key)} = ${tomlValue(value)}`)
    return `${lines.join(eol)}${eol}`
  }
  if (value === undefined) return text
  const block = [`[${table.map(quoteKey).join(".")}]`, `${quoteKey(key)} = ${tomlValue(value)}`]
  const out = lines.length ? [...lines, "", ...block] : block
  return `${out.join(eol)}${eol}`
}

/** Set `path` (e.g. "ui.theme", "agent_style.claude.color") to `value`, or remove it when value is undefined. */
export function setTomlValue(text: string, path: string, value: unknown): string {
  const parts = splitKey(path)
  const original = (text.trim() ? parse(text) : {}) as Record<string, unknown>
  const expected = structuredClone(original)
  setIn(expected, parts, value)
  let edited: string | undefined
  try {
    edited = lineEdit(text, parts, value)
    if (eq(parse(edited), expected)) return edited
  } catch {}
  // the line editor couldn't do it safely: rewrite the whole document (comments are lost)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  return stringify(expected).replace(/\n/g, eol)
}
