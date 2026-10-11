/**
 * Roles and skills: what a worker can be told to be, and what it can know.
 *
 * Roles: built-in ones, then ~/.config/baton/roles/*.md, then .baton/roles/*.md, then [roles.*] in
 * the config. Later sources win field by field. A role file is Markdown with a small header:
 *
 *   ---
 *   description: Writes and fixes tests
 *   tier: medium
 *   access: write            # read-only | write
 *   acceptance: bun test
 *   skills: [testing-conventions]
 *   ---
 *   You are the team's tester. …
 *
 * Skills follow the Agent Skills layout: <dir>/<name>/SKILL.md with `name` and `description` in
 * its header, plus any files next to it. Workers see each skill's name and description and load
 * the full text with the load_skill tool when they need it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { Access, BatonConfig, RoleConfig } from "./config.ts"
import { configDir } from "./config.ts"

export interface Role extends RoleConfig {
  name: string
  prompt: string
  description: string
  /** Where it came from (later sources override earlier ones). */
  source: "builtin" | "user" | "project" | "config"
}

export interface Skill {
  name: string
  description: string
  /** Folder of the skill (SKILL.md plus any references and scripts). */
  dir: string
  source: "user" | "project" | "claude" | "claude-user" | "config"
}

// ───────────────────────────── built-in roles ─────────────────────────────

export const BUILTIN_ROLES: Record<string, Omit<Role, "name" | "source">> = {
  reviewer: {
    description: "Reviews another agent's changes for correctness, edge cases and tests (read-only)",
    tier: "medium",
    access: "read-only",
    prompt: `You are a code reviewer. You read and run things; you never edit files.
- Read the diff and the surrounding code. Run the project's tests and linters if it has them.
- Look for: wrong behaviour, unhandled edge cases (empty, null, unicode, large inputs, concurrency), missing or weak tests, security problems, and changes outside the task's scope.
- Be concrete: file:line, what is wrong, why, and the fix. Separate blocking issues from nits.
- Finish with submit_review: "approve" only if nothing blocking remains.`,
  },
  tester: {
    description: "Writes and fixes tests; makes the suite pass for real",
    tier: "medium",
    prompt: `You are the team's tester.
- Find how the project tests (package.json scripts, Makefile, pyproject, existing *_test / *.test files) and follow its conventions exactly.
- Cover the behaviour that matters: the happy path, edge cases, errors. Test behaviour, not implementation details.
- Never weaken or skip a test to make it pass; never change production code unless the task says so — report bugs you find instead.
- Run the full relevant suite before finishing and report the exact command and its result.`,
  },
  debugger: {
    description: "Finds the root cause of a bug and fixes it minimally, with a regression test",
    tier: "large",
    prompt: `You are a debugger.
- Reproduce first: get a failing command or test before changing anything.
- Form hypotheses and check them with evidence (logs, prints, a bisect); don't guess-and-patch.
- Fix the root cause with the smallest change, add a regression test that failed before the fix, and run it.
- Report: the cause in one or two sentences, the fix, and how you verified it.`,
  },
  refactorer: {
    description: "Restructures code without changing behaviour",
    tier: "large",
    prompt: `You are a refactorer. Behaviour must not change.
- Run the tests before you start and after every step; keep them green.
- Work in small, reviewable steps; don't mix refactoring with new features or formatting churn.
- Keep public APIs unless the task says otherwise; update every call site you touch.
- Report what moved where, and the test results.`,
  },
  docs: {
    description: "Writes and updates documentation, READMEs and comments",
    tier: "small",
    prompt: `You are the team's technical writer.
- Write for the reader who will use this: start with what it does and how to use it, then the details.
- Match the project's existing tone and format. Keep examples copy-pasteable and correct — run them if you can.
- Don't document what doesn't exist; check the code.
- Prefer short sentences, concrete examples and accurate commands over long explanations.`,
  },
  security: {
    description: "Audits code for vulnerabilities and unsafe patterns (read-only)",
    tier: "large",
    access: "read-only",
    prompt: `You are a security reviewer. You read and run things; you never edit files.
- Check: injection (SQL, shell, path traversal), authentication and authorization, secrets in code or logs, unsafe deserialization, SSRF, XSS, insecure defaults, dependency risks.
- For each finding: severity, location (file:line), how it could be exploited, and the fix.
- Don't report theoretical issues without a plausible path; say so when you found nothing serious.
- If you were asked to review someone's change, finish with submit_review.`,
  },
  researcher: {
    description: "Investigates a question in the codebase or docs and reports findings (read-only)",
    tier: "small",
    access: "read-only",
    prompt: `You are a researcher. You read, search and run read-only commands; you never edit files.
- Answer the question you were given with evidence: file paths with line numbers, command output, links to docs.
- Distinguish what you verified from what you infer.
- Finish with a short, structured report: the answer first, then the evidence, then open questions.`,
  },
  frontend: {
    description: "Builds and fixes UI: components, styles, accessibility",
    tier: "medium",
    prompt: `You are a frontend engineer.
- Follow the project's component patterns, styling approach and design tokens; don't introduce new UI libraries.
- Make it accessible: semantic elements, labels, keyboard navigation, focus states, contrast.
- Handle loading, empty and error states. Keep components small and typed.
- If the project can run (dev server on $PORT) or has UI tests, verify there and say how.`,
  },
}

// ───────────────────────────── frontmatter ─────────────────────────────

/** `---\nkey: value\n---\nbody` → { data, body }. Values are YAML. */
export function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { data: {}, body: text }
  let data: Record<string, unknown> = {}
  try {
    const parsed = Bun.YAML.parse(m[1] ?? "")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch {}
  return { data, body: m[2] ?? "" }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const strList = (v: unknown) =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim())
    : typeof v === "string"
      ? v
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined

function roleFromFile(path: string): RoleConfig & { name: string } {
  const { data, body } = frontmatter(readFileSync(path, "utf8"))
  const access = data.access === "read-only" || data.access === "write" ? (data.access as Access) : undefined
  const tier = data.tier === "small" || data.tier === "medium" || data.tier === "large" ? (data.tier as RoleConfig["tier"]) : undefined
  return {
    name: str(data.name) ?? basename(path).replace(/\.md$/i, ""),
    ...(body.trim() ? { prompt: body.trim() } : {}),
    ...(str(data.description) ? { description: str(data.description) } : {}),
    ...(str(data.adapter) ? { adapter: str(data.adapter) } : {}),
    ...(str(data.model) ? { model: str(data.model) } : {}),
    ...(tier ? { tier } : {}),
    ...(access ? { access } : {}),
    ...(str(data.acceptance) ? { acceptance: str(data.acceptance) } : {}),
    ...(strList(data.skills) ? { skills: strList(data.skills) } : {}),
  }
}

function mdFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort()
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

const isName = (n: string) => /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(n)

/** Every role available in this project, by name. */
export function loadRoles(projectRoot: string, config: Pick<BatonConfig, "roles">): Map<string, Role> {
  const roles = new Map<string, Role>()
  const merge = (name: string, patch: RoleConfig, source: Role["source"]) => {
    const key = name.toLowerCase()
    if (!isName(key)) return
    const prev = roles.get(key)
    const next: Role = { ...(prev ?? { name: key, prompt: "", description: "" }), ...stripUndefined(patch), name: key, source }
    next.prompt ??= ""
    next.description ??= ""
    roles.set(key, next)
  }
  for (const [name, r] of Object.entries(BUILTIN_ROLES)) merge(name, r, "builtin")
  for (const f of mdFiles(join(configDir(), "roles"))) {
    const r = roleFromFile(f)
    merge(r.name, r, "user")
  }
  for (const f of mdFiles(join(projectRoot, ".baton", "roles"))) {
    const r = roleFromFile(f)
    merge(r.name, r, "project")
  }
  for (const [name, r] of Object.entries(config.roles ?? {})) merge(name, r, "config")
  return roles
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

// ───────────────────────────── skills ─────────────────────────────

function skillsIn(dir: string, source: Skill["source"]): Skill[] {
  const out: Skill[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries.sort()) {
    const sdir = join(dir, e)
    const file = join(sdir, "SKILL.md")
    try {
      if (!statSync(sdir).isDirectory() || !existsSync(file)) continue
    } catch {
      continue
    }
    const { data, body } = frontmatter(readFileSync(file, "utf8"))
    const name = (str(data.name) ?? e).toLowerCase()
    if (!isName(name)) continue
    // no description: the first non-heading line of the body
    const description =
      str(data.description) ??
      body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#")) ??
      ""
    out.push({ name, description: description.slice(0, 300), dir: sdir, source })
  }
  return out
}

/** Every skill available in this project, by name (project skills win over personal ones). */
export function loadSkills(projectRoot: string, config: Pick<BatonConfig, "skills">): Map<string, Skill> {
  const skills = new Map<string, Skill>()
  const add = (list: Skill[]) => {
    for (const s of list) skills.set(s.name, s)
  }
  const cfg = config.skills ?? { dirs: [], claude: true, claude_user: false }
  if (cfg.claude_user) add(skillsIn(join(homedir(), ".claude", "skills"), "claude-user"))
  add(skillsIn(join(configDir(), "skills"), "user"))
  if (cfg.claude) add(skillsIn(join(projectRoot, ".claude", "skills"), "claude"))
  add(skillsIn(join(projectRoot, ".baton", "skills"), "project"))
  for (const d of cfg.dirs ?? []) {
    const dir = d.startsWith("~/") ? join(homedir(), d.slice(2)) : d.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d) ? d : join(projectRoot, d)
    add(skillsIn(dir, "config"))
  }
  return skills
}

/** A skill's full text for an agent: SKILL.md plus a list of the other files in its folder. */
export function readSkill(skill: Skill): string {
  const body = frontmatter(readFileSync(join(skill.dir, "SKILL.md"), "utf8")).body.trim()
  const files: string[] = []
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 3 || files.length > 50) return
    let list: string[] = []
    try {
      list = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const e of list) {
      const p = join(dir, e)
      const r = rel ? `${rel}/${e}` : e
      try {
        if (statSync(p).isDirectory()) walk(p, r, depth + 1)
        else if (r !== "SKILL.md") files.push(r)
      } catch {}
    }
  }
  walk(skill.dir, "", 0)
  return `# Skill: ${skill.name}\n\n${body}${files.length ? `\n\n---\nFiles in this skill (read them from ${skill.dir}):\n${files.map((f) => `- ${f}`).join("\n")}` : ""}`
}
