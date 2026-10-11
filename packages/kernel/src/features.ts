/**
 * Team features, each on its own switch ([features] in the config). Off means the agents never
 * hear of it: no tools, no prompt text, and the matching spawn fields are ignored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { BatonConfig } from "./config.ts"
import { projectPaths } from "./project.ts"
import { setTomlValue } from "./toml-edit.ts"

export type FeatureKey = keyof BatonConfig["features"]

export interface FeatureInfo {
  key: FeatureKey
  label: string
  /** One line: what turning it on does. */
  what: string
  default: boolean
}

export const FEATURES: FeatureInfo[] = [
  {
    key: "roles",
    label: "Roles",
    what: "workers can be a tester, reviewer, debugger, … or your own (.baton/roles), with instructions and an access level; reviews use the read-only reviewer",
    default: true,
  },
  {
    key: "skills",
    label: "Skills",
    what: "workers can load SKILL.md know-how from .baton/skills and .claude/skills (load_skill)",
    default: true,
  },
  {
    key: "acceptance",
    label: "Acceptance checks",
    what: "a worker given a check (e.g. bun test) only counts as done when Baton has run it and it passed",
    default: true,
  },
  {
    key: "notes",
    label: "Team notes",
    what: "agents record facts about the project in .baton/notes.md and every new worker starts with them",
    default: false,
  },
]

export const isFeature = (k: string): k is FeatureKey => FEATURES.some((f) => f.key === k)

/** Switch a feature in the project's .baton/config.toml (comments and layout are kept). Returns the file. */
export function setFeature(projectRoot: string, key: FeatureKey, on: boolean): string {
  const path = projectPaths(projectRoot).config
  mkdirSync(projectPaths(projectRoot).dir, { recursive: true })
  const text = existsSync(path) ? readFileSync(path, "utf8") : ""
  writeFileSync(path, setTomlValue(text, `features.${key}`, on))
  return path
}

/** "roles ✓ · skills ✓ · acceptance ✓ · notes ✗" */
export function featureSummary(features: BatonConfig["features"]): string {
  return FEATURES.map((f) => `${f.key} ${features[f.key] ? "✓" : "✗"}`).join(" · ")
}
