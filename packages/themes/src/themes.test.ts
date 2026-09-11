import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILTIN_THEMES, listThemes, loadTheme, parseBase16, resolveTheme, TOKENS } from "./index.ts"

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
