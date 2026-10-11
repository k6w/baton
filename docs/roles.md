# Roles, skills and team notes

A worker only knows what it's told. These three features make every worker start with the right
instructions, the right know-how and what the team already learned.

| | What it is | Where it lives | See them |
|---|---|---|---|
| **Roles** | What a worker *is*: tester, reviewer, security auditor, your own "api owner" | built in, `.baton/roles/*.md` | `/roles` · `baton roles` |
| **Skills** | What a worker can *look up*: step-by-step know-how for one kind of work | `.baton/skills/<name>/SKILL.md`, `.claude/skills` | `/skills` · `baton skills` |
| **Team notes** | What the team *remembers*: facts about this project | `.baton/notes.md` | `/notes` · `baton notes` |

All three are on by default and cost nothing until used. The orchestrator knows about them and
uses them when it spawns workers; you can use them directly too.

## Roles

A role gives a worker:
- **instructions** for that kind of work;
- an **access level**: `read-only` workers can't edit files. Baton refuses their edits, even in YOLO mode;
- a **model size** (`tier`: small, medium, large, mapped to models by `[routing]`);
- optionally an **agent** (`adapter`), an **acceptance check** and **skills**.

### Built-in roles

| Role | For | Access | Size |
|---|---|---|---|
| `reviewer` | reviewing another agent's changes (Baton uses it for every review) | read-only | medium |
| `tester` | writing and fixing tests, without weakening them | write | medium |
| `debugger` | reproducing a bug, finding the root cause, a minimal fix with a regression test | write | large |
| `refactorer` | restructuring code without changing behaviour | write | large |
| `docs` | READMEs, guides, comments | write | small |
| `security` | auditing for vulnerabilities, with severity and fixes | read-only | large |
| `researcher` | answering a question about the code with evidence | read-only | small |
| `frontend` | UI components, styles, accessibility | write | medium |

### Using roles

- **In the app:** `/spawn tester` starts a tester (on the default worker agent). Other forms:
  - `/spawn tester codex` on Codex;
  - `/spawn tester codex 2 auth tests`: two of them, labelled.
- **The orchestrator** sees every role with its description (`list_roles`, and in the `spawn_agent`
  tool). `pick_agent` suggests one for a task: "add tests" → tester, "fix the crash" → debugger.
- **On the cards**, a worker's role shows next to its name, with `r/o` for read-only workers.

### Your own roles

```sh
baton role new api        # → .baton/roles/api.md
```

```markdown
---
description: Owns the HTTP API in src/api
adapter: codex             # optional: who plays it
tier: medium               # optional: small | medium | large
access: write              # optional: read-only | write
acceptance: bun test src/api   # optional: a command that must pass
skills: [rest-conventions] # optional: skills it starts with
---
You own src/api. Every endpoint has a handler in src/api/handlers, a zod schema in
src/api/schemas and a test in test/api. Never change the database layer; message the
"db" worker if you need something there.
```

Roles in `.baton/roles/` are shared with your team when you commit them. Personal roles go in
`~/.config/baton/roles/`. A role file with the same name as a built-in one changes only the fields it
sets: an empty `tester.md` with just `acceptance: bun test` keeps the built-in instructions.

Roles can also live in the config:

```toml
[roles.tester]
acceptance = "bun test"
adapter = "codex"
```

## Worker specs

The orchestrator (or a script, through the SDK) can give a worker more than a task:

| `spawn_agent` field | What happens |
|---|---|
| `role` | the role's instructions, access, size, agent, check and skills |
| `instructions` | extra guidance for this worker only ("the auth module uses argon2; keep it") |
| `skills` | skills it starts with |
| `files` | files / globs it owns, claimed for it: other workers are warned before they touch them |
| `acceptance` | a command that proves it is done (see below) |
| `access` | `read-only` to forbid edits |

The orchestrator's instructions include a brief template (objective, context, files, check,
report), so its workers get specific, verifiable tasks.

### Acceptance checks

When a worker with a check finishes, Baton runs the command in the worker's own copy of the
project. It shows up in the worker's feed as `Acceptance: bun test`.

- **Passes:** the result goes to the lead with `acceptance ✓`.
- **Fails:** the worker gets the output and fixes it, up to two more tries. After that, the lead
  hears the result failed, with the output.
- **Your rules apply:** the check goes through your approval rules like any command. One your
  rules would ask about lands in your inbox first.

## Skills

A skill is a folder with a `SKILL.md`: instructions for one kind of work, plus any examples,
templates or scripts next to it. It's the [Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills)
layout Claude Code uses, so your existing skills work as they are.

```sh
baton skill new deploy    # → .baton/skills/deploy/SKILL.md
```

```markdown
---
name: deploy
description: How to deploy this service to staging and production
---
# Deploying
1. `make build`, then `make deploy ENV=staging` …
```

**How agents use them:**
- Workers see each skill's name and one-line description. They load the full text with the
  `load_skill` tool when they reach the work it covers, which keeps their instructions short.
- This works with every agent (Claude, Codex, OpenCode, Gemini, …), not just Claude.
- Agents that can't use Baton's tools get the full text of their assigned skills up front.

**Where Baton looks:**

| Folder | When |
|---|---|
| `.baton/skills/` | always (commit them to share) |
| `~/.config/baton/skills/` | always (yours, every project) |
| `.claude/skills/` (the project's) | `skills.claude = true` (default) |
| `~/.claude/skills/` (yours) | `skills.claude_user = true` |
| any folder | `skills.dirs = ["tools/skills"]` |

## Team notes

When an agent learns something the next one should know, it calls `note`:
- "integration tests need DB_URL";
- "the API uses snake_case";
- "never run `make clean`, it wipes the fixtures".

Notes go into `.baton/notes.md`, and every new worker starts with the latest ones (`notes.max`,
default 30). Agents search all of them with `recall`.

- **Review findings** are saved too. When a reviewer asks for changes, the finding becomes a note,
  so the next worker doesn't repeat the mistake (`notes.reviews`).
- **Add your own:** `/notes add <text>` in the app or `baton notes add "…"`. Edit the file freely:
  it's plain Markdown, one bullet per note.
- **Turn it off:** `notes.enabled = false`.

## Saved teams

Start the same group of workers with one command:

```toml
[teams]
frontend = [{ role = "frontend", adapter = "claude" }, { role = "tester", adapter = "codex" }, { role = "reviewer" }]
audit = [{ role = "security", count = 2 }, { role = "researcher" }]
```

`/team frontend` starts them and tells the orchestrator they're ready.
`/team frontend "rebuild the settings page"` hands it the task too.
