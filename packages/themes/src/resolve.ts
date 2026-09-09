import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, extname, join } from "node:path"
import { BUILTIN_THEMES, COUNTERPARTS, paletteTheme } from "./builtin.ts"
import { type ColorValue, type ResolvedTheme, TOKENS, type ThemeFile, type Token } from "./schema.ts"

export interface ThemeEntry {
  name: string
  source: "builtin" | "global" | "project" | "opencode" | "base16"
  path?: string
  file: ThemeFile
  appearance?: "dark" | "light"
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** OpenCode's token names that differ from ours. */
const OPENCODE_ALIASES: Record<string, Token> = {
  diffHighlightAdded: "diffAdded",
  diffHighlightRemoved: "diffRemoved",
  diffAddedLineNumberBg: "diffAddedLineNumberBg",
  diffRemovedLineNumberBg: "diffRemovedLineNumberBg",
}

function normalizeHex(h: string): string {
  if (h.length === 4) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`
  if (h.length === 9) return h.slice(0, 7)
  return h.toLowerCase()
}

/** ANSI 0–255 → hex (xterm defaults). */
export function ansiToHex(n: number): string {
  const base16 = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
  ]
  if (n < 16) return base16[n] as string
  if (n < 232) {
    const i = n - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(i / 36)] as number
    const g = steps[Math.floor(i / 6) % 6] as number
    const b = steps[i % 6] as number
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
  }
  const v = 8 + (n - 232) * 10
  return `#${[v, v, v].map((x) => x.toString(16).padStart(2, "0")).join("")}`
}

/**
 * Resolve a theme file into concrete colors. Missing tokens fall back to `base`
 * (Baton's default theme of the same appearance), so partial themes are fine.
 */
export function resolveTheme(entry: ThemeEntry, appearance: "dark" | "light", base?: ResolvedTheme): ResolvedTheme {
  const defs = entry.file.defs ?? {}
  const raw: Record<string, ColorValue> = {}
  for (const [k, v] of Object.entries(entry.file.theme ?? {})) raw[OPENCODE_ALIASES[k] ?? k] = v as ColorValue
  // OpenCode names the base background "background"; same as ours. Map a few legacy keys:
  if (raw.markdownText && !raw.text) raw.text = raw.markdownText

  const seen = new Set<string>()
  const resolveValue = (v: ColorValue | undefined, depth = 0): string | undefined => {
    if (v === undefined || depth > 16) return undefined
    if (typeof v === "object") return resolveValue(appearance === "dark" ? v.dark : v.light, depth + 1)
    if (typeof v === "number") return ansiToHex(v)
    const s = String(v).trim()
    if (s === "none" || s === "transparent") return "transparent"
    if (HEX.test(s)) return normalizeHex(s)
    if (/^\d+$/.test(s)) return ansiToHex(Number(s))
    if (s in defs) return resolveValue(defs[s], depth + 1)
    if (s in raw && !seen.has(s)) {
      seen.add(s)
      const r = resolveValue(raw[s], depth + 1)
      seen.delete(s)
      return r
    }
    return undefined
  }

  const fallback = base ?? (appearance === "dark" ? resolveBuiltin("baton", "dark") : resolveBuiltin("baton-light", "light"))
  const out = { name: entry.name, appearance } as ResolvedTheme
  for (const t of TOKENS) out[t] = resolveValue(raw[t]) ?? fallback[t]
  return out
}

function resolveBuiltin(name: string, appearance: "dark" | "light"): ResolvedTheme {
  const file = BUILTIN_THEMES[name] as ThemeFile
  const out = { name, appearance } as ResolvedTheme
  for (const t of TOKENS) {
    const v = file.theme[t]
    out[t] = typeof v === "string" ? normalizeHex(v) : "#ff00ff"
  }
  return out
}

/** Parse a base16/base24 YAML scheme (only the baseXX keys are needed). */
export function parseBase16(yaml: string, name: string): ThemeFile & { appearance: "dark" | "light" } {
  const colors: Record<string, string> = {}
  for (const line of yaml.split("\n")) {
    const m = /^\s*(?:palette:\s*)?(base[0-9A-Fa-f]{2})\s*:\s*["']?#?([0-9a-fA-F]{6})["']?/.exec(line)
    if (m) colors[(m[1] as string).toLowerCase()] = `#${(m[2] as string).toLowerCase()}`
  }
  const c = (k: string, f = "#ff00ff") => colors[k] ?? f
  const bg = c("base00")
  const lum = luminance(bg)
  const appearance = lum < 0.5 ? "dark" : "light"
  const file = paletteTheme({
    name,
    appearance,
    bg,
    panel: c("base00"),
    element: c("base01"),
    overlay: c("base02"),
    border: c("base02"),
    borderActive: c("base05"),
    text: c("base05"),
    muted: c("base04"),
    subtle: c("base03"),
    primary: c("base0d"),
    secondary: c("base0e"),
    accent: c("base0c"),
    red: c("base08"),
    orange: c("base09"),
    yellow: c("base0a"),
    green: c("base0b"),
    cyan: c("base0c"),
    blue: c("base0d"),
    magenta: c("base0e"),
  })
  return { ...file, appearance }
}

export function luminance(hex: string): number {
  const s = hex.replace("#", "")
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16) / 255) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function readThemeDir(dir: string, source: ThemeEntry["source"]): ThemeEntry[] {
  if (!existsSync(dir)) return []
  const out: ThemeEntry[] = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const ext = extname(f)
    const name = basename(f, ext)
    try {
      if (ext === ".json") {
        const file = JSON.parse(readFileSync(p, "utf8")) as ThemeFile
        if (file && typeof file.theme === "object") out.push({ name: file.name ?? name, source, path: p, file })
      } else if (ext === ".yaml" || ext === ".yml") {
        const file = parseBase16(readFileSync(p, "utf8"), name)
        out.push({ name, source: "base16", path: p, file, appearance: file.appearance })
      }
    } catch {
      // invalid theme files are skipped; `baton doctor` reports them
    }
  }
  return out
}

export interface ThemeDirs {
  global?: string
  project?: string
  /** Import OpenCode's user themes too (default true). */
  opencode?: boolean
}

/** All available themes; later sources override earlier ones with the same name. */
export function listThemes(dirs: ThemeDirs = {}): ThemeEntry[] {
  const map = new Map<string, ThemeEntry>()
  for (const [name, file] of Object.entries(BUILTIN_THEMES)) map.set(name, { name, source: "builtin", file, appearance: file.appearance })
  if (dirs.opencode !== false) {
    const oc = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "themes")
    for (const e of readThemeDir(oc, "opencode")) if (!map.has(e.name)) map.set(e.name, e)
  }
  if (dirs.global) for (const e of readThemeDir(dirs.global, "global")) map.set(e.name, e)
  if (dirs.project) for (const e of readThemeDir(dirs.project, "project")) map.set(e.name, e)
  return [...map.values()].sort((a, b) => (a.source === "builtin" ? 0 : 1) - (b.source === "builtin" ? 0 : 1) || a.name.localeCompare(b.name))
}

/**
 * Pick and resolve the theme to use. With appearance "auto", the terminal background
 * (if known) chooses between a theme and its light/dark counterpart.
 */
export function loadTheme(
  name: string,
  opts: { appearance?: "auto" | "dark" | "light"; terminalBg?: string; dirs?: ThemeDirs } = {},
): ResolvedTheme {
  const themes = listThemes(opts.dirs)
  let entry = themes.find((t) => t.name === name) ?? themes.find((t) => t.name === "baton")!
  let appearance: "dark" | "light" = entry.appearance ?? "dark"
  if (opts.appearance === "dark" || opts.appearance === "light") appearance = opts.appearance
  else if (opts.terminalBg && HEX.test(opts.terminalBg)) appearance = luminance(opts.terminalBg) < 0.5 ? "dark" : "light"
  if (entry.appearance && entry.appearance !== appearance && COUNTERPARTS[entry.name]) {
    const other = themes.find((t) => t.name === COUNTERPARTS[entry.name])
    if (other) entry = other
  }
  return resolveTheme(entry, entry.appearance ?? appearance)
}
