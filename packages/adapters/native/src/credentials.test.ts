import "./testing/env.ts"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempWorkspace } from "../../testkit/src/index.ts"
import { detectCredentials, detectCredentialsSync, pickLocalModel } from "./credentials.ts"
import { nativeAdapter, resolveModel } from "./index.ts"
import { ENV_ORDER } from "./providers.ts"
import { fakeLLM } from "./testing/fake-llm.ts"

const servers: { stop(): void }[] = []
afterAll(() => {
  for (const s of servers) s.stop()
})

/** A closed local port: nothing listens there. */
const CLOSED = "http://127.0.0.1:9"

/** Env with every provider key blanked, a fake HOME and no local servers. */
function cleanEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { HOME: home, XDG_DATA_HOME: "", CODEX_HOME: "", OLLAMA_HOST: CLOSED, LMSTUDIO_BASE_URL: `${CLOSED}/v1` }
  for (const e of ENV_ORDER) env[e.env] = ""
  return { ...env, ...extra }
}

function fakeHome(files: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "baton-home-"))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(home, rel)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content))
  }
  return home
}

/** Subscription credentials that must never be picked up. */
const SUBSCRIPTION_FILES = {
  ".claude/.credentials.json": { claudeAiOauth: { accessToken: "sk-ant-oat01-SUBSCRIPTION", refreshToken: "r", expiresAt: 9e12 } },
  ".codex/auth.json": {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "x", access_token: "CHATGPT-TOKEN", refresh_token: "y", account_id: "z" },
  },
  ".local/share/opencode/auth.json": { anthropic: { type: "oauth", refresh: "r", access: "OPENCODE-OAUTH", expires: 9e12 } },
}

describe("credential detection", () => {
  test("environment order: Anthropic → OpenAI → OpenRouter → Gemini → Groq …", async () => {
    const home = fakeHome()
    const d = (extra: Record<string, string>) => detectCredentialsSync(cleanEnv(home, extra))
    expect(d({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toMatchObject({ kind: "anthropic", source: "env ANTHROPIC_API_KEY" })
    expect(d({ OPENAI_API_KEY: "o", OPENROUTER_API_KEY: "r" })?.kind).toBe("openai")
    expect(d({ OPENROUTER_API_KEY: "r", GEMINI_API_KEY: "g" })?.kind).toBe("openrouter")
    expect(d({ GOOGLE_GENERATIVE_AI_API_KEY: "g", GROQ_API_KEY: "q" })).toMatchObject({ kind: "gemini", apiKey: "g" })
    expect(d({ GROQ_API_KEY: "q", XAI_API_KEY: "x" })?.kind).toBe("groq")
    expect(d({ XAI_API_KEY: "x" })?.kind).toBe("xai")
    expect(d({})).toBeUndefined()
    // Gemini goes through its OpenAI-compatible endpoint
    const r = resolveModel(undefined, undefined, cleanEnv(home, { GEMINI_API_KEY: "g" }))
    expect(r).toMatchObject({ kind: "gemini", providerId: "gemini" })
    const cfg = (r.model as unknown as { config: { url(o: { path: string; modelId: string }): string } }).config
    expect(cfg.url({ path: "/chat/completions", modelId: r.modelId })).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
  })

  test("subscription logins are never used (Claude credentials, Codex ChatGPT tokens, OpenCode oauth)", async () => {
    const home = fakeHome(SUBSCRIPTION_FILES)
    const env = cleanEnv(home, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-ENV" })
    expect(detectCredentialsSync(env)).toBeUndefined()
    expect(await detectCredentials({ env, timeoutMs: 200 })).toBeUndefined()
  })

  test("Codex: only its OPENAI_API_KEY field; OpenCode: only type=api entries, mapped to kinds", () => {
    const codex = fakeHome({ ".codex/auth.json": { OPENAI_API_KEY: "sk-codex-key", tokens: { access_token: "t" } } })
    expect(detectCredentialsSync(cleanEnv(codex))).toMatchObject({ kind: "openai", apiKey: "sk-codex-key", source: "~/.codex/auth.json (OPENAI_API_KEY)" })

    const oc = fakeHome({
      ".local/share/opencode/auth.json": {
        anthropic: { type: "oauth", access: "nope", refresh: "r", expires: 1 },
        "zai-coding-plan": { type: "api", key: "unknown-provider" },
        openrouter: { type: "api", key: "sk-or-oc" },
        google: { type: "api", key: "g-oc" },
      },
    })
    expect(detectCredentialsSync(cleanEnv(oc))).toMatchObject({ kind: "openrouter", apiKey: "sk-or-oc" })
    // env keys win over files
    expect(detectCredentialsSync(cleanEnv(oc, { MISTRAL_API_KEY: "m" }))?.kind).toBe("mistral")
    // XDG_DATA_HOME is honoured
    const xdg = fakeHome({ "data/opencode/auth.json": { google: { type: "api", key: "g" } } })
    expect(detectCredentialsSync(cleanEnv(fakeHome(), { XDG_DATA_HOME: join(xdg, "data") }))).toMatchObject({ kind: "gemini", apiKey: "g" })
  })

  test("local Ollama (coder model preferred) and LM Studio", async () => {
    const ollama = fakeLLM([], { ollamaTags: ["nomic-embed-text:latest", "llama3.2:3b", "qwen2.5-coder:7b"] })
    servers.push(ollama)
    const port = new URL(ollama.baseUrl).port
    const home = fakeHome()
    const found = await detectCredentials({ env: cleanEnv(home, { OLLAMA_HOST: `127.0.0.1:${port}` }) })
    expect(found).toMatchObject({ kind: "ollama", model: "qwen2.5-coder:7b", baseUrl: `http://127.0.0.1:${port}/v1` })

    const lms = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ id: "text-embedding-nomic" }, { id: "devstral-small" }] }) })
    servers.push({ stop: () => lms.stop(true) })
    const viaLms = await detectCredentials({ env: cleanEnv(home, { LMSTUDIO_BASE_URL: `http://127.0.0.1:${lms.port}/v1` }) })
    expect(viaLms).toMatchObject({ kind: "lmstudio", model: "devstral-small" })
    expect(pickLocalModel(["a", "b-embed"])).toBe("a")
  })

  test("start() without any credential explains the options and the Claude subscription policy", async () => {
    const env = cleanEnv(fakeHome(SUBSCRIPTION_FILES))
    await expect(
      nativeAdapter.start(
        { agentId: "a", name: "w", cwd: tempWorkspace(), mcpServers: [], approval: "ask", env },
        { emit: () => {}, log: () => {}, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/use the `claude` agent, which runs Claude Code with your own login/)
  })

  test("start() uses a detected local Ollama when nothing is configured", async () => {
    const fake = fakeLLM([{ text: "hi from ollama" }], { ollamaTags: ["qwen2.5-coder:7b"] })
    servers.push(fake)
    const logs: string[] = []
    const events: { type: string; data: unknown }[] = []
    const env = cleanEnv(fakeHome(), { OLLAMA_HOST: `http://localhost:${new URL(fake.baseUrl).port}` })
    const s = await nativeAdapter.start(
      { agentId: "a", name: "w", cwd: tempWorkspace(), mcpServers: [], approval: "yolo", env },
      { emit: (e) => events.push(e), log: (_l, m) => logs.push(m), signal: new AbortController().signal },
    )
    try {
      await s.prompt({ text: "hello" })
      for (let i = 0; i < 100 && !events.some((e) => e.type === "turn.completed"); i++) await Bun.sleep(20)
      expect(fake.requests[0]?.body.model).toBe("qwen2.5-coder:7b")
      expect(logs.some((l) => l.includes("using ollama from local Ollama"))).toBe(true)
    } finally {
      await s.close()
    }
  })

  test("detect(): auth ok + source note when a key exists, missing + hint otherwise; secrets never in notes", async () => {
    const saved = { ...process.env }
    try {
      for (const [k, v] of Object.entries(cleanEnv(fakeHome()))) process.env[k] = v
      process.env.OPENROUTER_API_KEY = "sk-or-SECRET-VALUE"
      const ok = await nativeAdapter.detect()
      expect(ok.auth).toBe("ok")
      expect(ok.notes?.join(" ")).toContain("openrouter (from env OPENROUTER_API_KEY)")
      expect(JSON.stringify(ok)).not.toContain("SECRET-VALUE")
      expect(nativeAdapter.capabilities(ok).fork).toBe(true)

      process.env.OPENROUTER_API_KEY = ""
      const missing = await nativeAdapter.detect()
      expect(missing.auth).toBe("missing")
      expect(missing.authHint).toContain("ANTHROPIC_API_KEY")
      expect(missing.authHint).toContain("`claude` agent")
      expect(missing.notes?.join(" ")).toContain("third-party apps")
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
})
