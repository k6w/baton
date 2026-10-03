import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BORDERS,
  BUILTIN_THEMES,
  COUNTERPARTS,
  contrastRatio,
  FRAME_STYLES,
  listThemes,
  loadTheme,
  matchStyle,
  parseBase16,
  resolveTheme,
  SPINNERS,
  STATUS_STYLES,
  STYLES,
  TOKENS,
} from "./index.ts"

describe("themes", () => {
  test("every builtin resolves every token to a color", () => {
    for (const name of Object.keys(BUILTIN_THEMES)) {
      const t = loadTheme(name, { appearance: BUILTIN_THEMES[name]!.appearance, dirs: { opencode: false } })
      for (const tok of TOKENS) expect(t[tok]).toMatch(/^(#[0-9a-f]{6}|transparent)$/)
    }
    expect(Object.keys(BUILTIN_THEMES).length).toBeGreaterThanOrEqual(25)
  })

  test("auto appearance swaps to the counterpart", () => {
    expect(loadTheme("catppuccin-mocha", { appearance: "auto", terminalBg: "#ffffff", dirs: { opencode: false } }).name).toBe("catppuccin-latte")
    expect(loadTheme("baton", { appearance: "auto", terminalBg: "#101010", dirs: { opencode: false } }).name).toBe("baton")
    expect(loadTheme("ayu-mirage", { appearance: "auto", terminalBg: "#ffffff", dirs: { opencode: false } }).name).toBe("ayu-light")
    expect(loadTheme("light-owl", { appearance: "auto", terminalBg: "#000000", dirs: { opencode: false } }).name).toBe("night-owl")
    expect(loadTheme("flexoki-dark", { appearance: "light", dirs: { opencode: false } }).name).toBe("flexoki-light")
  })

  test("counterparts exist and have the opposite appearance", () => {
    for (const [from, to] of Object.entries(COUNTERPARTS)) {
      expect(BUILTIN_THEMES[from], from).toBeDefined()
      expect(BUILTIN_THEMES[to], to).toBeDefined()
      expect(BUILTIN_THEMES[to]!.appearance, `${from} → ${to}`).not.toBe(BUILTIN_THEMES[from]!.appearance)
    }
  })

  test("every builtin meets WCAG contrast for text, muted, subtle and diffs", () => {
    const failures: string[] = []
    const check = (theme: string, what: string, fg: string, bg: string, min: number) => {
      const r = contrastRatio(fg, bg)
      if (r < min) failures.push(`${theme}: ${what} ${fg} on ${bg} = ${r.toFixed(2)} < ${min}`)
    }
    for (const name of Object.keys(BUILTIN_THEMES)) {
      const t = loadTheme(name, { appearance: BUILTIN_THEMES[name]!.appearance, dirs: { opencode: false } })
      check(name, "text", t.text, t.background, 7)
      check(name, "textMuted", t.textMuted, t.background, 4.5)
      check(name, "textSubtle", t.textSubtle, t.background, 3)
      check(name, "diffContext", t.diffContext, t.background, 4.5)
      check(name, "diffAdded", t.diffAdded, t.diffAddedBg, 4.5)
      check(name, "diffRemoved", t.diffRemoved, t.diffRemovedBg, 4.5)
    }
    expect(failures).toEqual([])
  })

  test("accessibility themes keep their intent", () => {
    // colorblind themes never signal added/removed with green vs red
    for (const name of ["colorblind", "colorblind-light"]) {
      const t = BUILTIN_THEMES[name]!.theme
      expect(["#56b4e9", "#0072b2"]).toContain(t.success as string) // Okabe–Ito blues
      expect(t.error).toBe("#d55e00") // Okabe–Ito vermillion
      expect(t.stateDone).toBe(t.success)
    }
    expect(contrastRatio(BUILTIN_THEMES["high-contrast"]!.theme.text as string, "#000000")).toBe(21)
  })

  test("OpenCode-format theme with defs, refs, dark/light and none", () => {
    const t = resolveTheme(
      {
        name: "x",
        source: "global",
        file: {
          defs: { bg: "#101010", fg: { dark: "#eeeeee", light: "#111111" } },
          theme: { background: "bg", text: "fg", primary: "text", backgroundPanel: "none", accent: 196 as never },
        },
      },
      "dark",
    )
    expect(t.background).toBe("#101010")
    expect(t.text).toBe("#eeeeee")
    expect(t.primary).toBe("#eeeeee")
    expect(t.backgroundPanel).toBe("transparent")
    expect(t.accent).toBe("#ff0000")
    expect(t.diffAddedBg).toMatch(/^#/) // filled from baton fallback
  })

  test("base16 import + user dirs override builtins", () => {
    const dir = mkdtempSync(join(tmpdir(), "baton-themes-"))
    writeFileSync(
      join(dir, "ocean.yaml"),
      `scheme: "Ocean"\nbase00: "2b303b"\nbase01: "343d46"\nbase02: "4f5b66"\nbase03: "65737e"\nbase04: "a7adba"\nbase05: "c0c5ce"\nbase06: "dfe1e8"\nbase07: "eff1f5"\nbase08: "bf616a"\nbase09: "d08770"\nbase0A: "ebcb8b"\nbase0B: "a3be8c"\nbase0C: "96b5b4"\nbase0D: "8fa1b3"\nbase0E: "b48ead"\nbase0F: "ab7967"\n`,
    )
    writeFileSync(join(dir, "nord.json"), JSON.stringify({ theme: { primary: "#123456" } }))
    const all = listThemes({ global: dir, opencode: false })
    expect(all.find((t) => t.name === "ocean")?.source).toBe("base16")
    expect(all.find((t) => t.name === "nord")?.source).toBe("global")
    const t = loadTheme("ocean", { dirs: { global: dir, opencode: false } })
    expect(t.background).toBe("#2b303b")
    expect(t.error).toBe("#bf616a")
    expect(parseBase16('base00: "ffffff"', "l").appearance).toBe("light")
  })
})

describe("styles", () => {
  test("classic is first and every preset is a unique, renderable combination", () => {
    expect(STYLES[0]!.name).toBe("classic")
    const seen = new Set<string>()
    for (const st of STYLES) {
      expect(FRAME_STYLES).toContain(st.prefs.frame)
      expect(STATUS_STYLES).toContain(st.prefs.status_style)
      expect(["theme", "terminal"]).toContain(st.prefs.background)
      expect(["comfy", "compact"]).toContain(st.prefs.density)
      expect(st.prefs.border === "none" || st.prefs.border in BORDERS).toBe(true)
      expect(SPINNERS[st.prefs.spinner], st.name).toBeDefined()
      const key = JSON.stringify(st.prefs)
      expect(seen.has(key), `${st.name} duplicates another style`).toBe(false)
      seen.add(key)
    }
    expect(new Set(STYLES.map((s) => s.name)).size).toBe(STYLES.length)
  })

  test("matchStyle finds each preset and reports custom otherwise", () => {
    for (const st of STYLES) expect(matchStyle({ ...st.prefs })).toBe(st.name)
    for (const name of ["paper", "glass", "brutalist"]) expect(STYLES.some((s) => s.name === name)).toBe(true)
    expect(matchStyle({ ...STYLES[0]!.prefs, spinner: "moon" })).toBe("custom")
  })
})
