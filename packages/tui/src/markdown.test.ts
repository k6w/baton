import { expect, test } from "bun:test"
import { loadTheme } from "@batonsh/themes"
import { renderMarkdown } from "./markdown.ts"

const t = loadTheme("github-dark")
const text = (md: string, w = 60) => renderMarkdown(md, w, t).map((l) => l.segs.map((s) => s.text).join(""))
const segs = (md: string) => renderMarkdown(md, 80, t).flatMap((l) => l.segs)

test("inline styles: markers become styles, never literal ** or `", () => {
  const s = segs("I added **rate limiting** to `POST /login` with *windows* and ~~old~~ [docs](https://x.dev)")
  expect(s.map((x) => x.text).join("")).toBe("I added rate limiting to POST /login with windows and old docs (https://x.dev)")
  expect(s.find((x) => x.text === "rate")?.bold).toBe(true)
  expect(s.find((x) => x.text === "POST")?.bg).toBe(t.backgroundElement)
  expect(s.find((x) => x.text === "windows")?.italic).toBe(true)
  expect(s.find((x) => x.text === "old")?.dim).toBe(true)
  expect(s.find((x) => x.text === "docs")?.underline).toBe(true)
})

test("lists, nesting, tasks and hanging indents", () => {
  expect(text("- one\n  - nested\n- [x] done\n- [ ] todo\n1. first")).toEqual(["• one", "  ◦ nested", "☑ done", "☐ todo", "1. first"])
  const wrapped = text("- a fairly long bullet that has to wrap onto a second line here", 30)
  expect(wrapped[0]?.startsWith("• ")).toBe(true)
  expect(wrapped[1]?.startsWith("  ")).toBe(true)
  expect(wrapped.every((l) => Bun.stringWidth(l) <= 30)).toBe(true)
})

test("headings, quotes, rules, code blocks and tables", () => {
  const out = renderMarkdown("## Done\n\n> careful\n\n---\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | **2** |", 40, t)
  const rows = out.map((l) => l.segs.map((s) => s.text).join(""))
  expect(rows[0]).toBe("Done")
  expect(out[0]?.segs[0]?.bold).toBe(true)
  expect(rows).toContain("▎ careful")
  expect(rows.some((r) => /^─+$/.test(r))).toBe(true)
  expect(out.find((l) => l.segs.some((s) => s.text === " const a = 1"))?.bg).toBe(t.backgroundElement)
  expect(rows.some((r) => r.startsWith("a") && r.includes("│"))).toBe(true)
  expect(rows.some((r) => r.includes("┼"))).toBe(true)
})

test("paragraph soft breaks join; escape codes are stripped", () => {
  expect(text("one\ntwo\n\nthree")).toEqual(["one two", "", "three"])
  expect(text("red \x1b[31mtext\x1b[0m")).toEqual(["red text"])
})
