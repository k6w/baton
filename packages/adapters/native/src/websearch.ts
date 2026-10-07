/**
 * web_search: a few results (title, URL, snippet) for a query.
 *   BRAVE_API_KEY   → Brave Search API
 *   TAVILY_API_KEY  → Tavily
 *   neither         → DuckDuckGo's HTML endpoint (no key; may be rate limited)
 * Read the pages themselves with web_fetch.
 */
import { decodeEntities } from "./webfetch.ts"

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchOutcome {
  engine: "brave" | "tavily" | "duckduckgo"
  results: SearchResult[]
}

const TIMEOUT_MS = 15_000
const text = (s: string) =>
  decodeEntities(s.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim()

/** DuckDuckGo HTML results page → results (links come wrapped in /l/?uddg=<target>). */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = []
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1)
  for (const b of blocks) {
    const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b)
    if (!a?.[1]) continue
    let url = decodeEntities(a[1])
    const wrapped = /[?&]uddg=([^&]+)/.exec(url)
    if (wrapped?.[1]) url = decodeURIComponent(wrapped[1])
    else if (url.startsWith("//")) url = `https:${url}`
    // sponsored results go through an ad redirect
    if (/duckduckgo\.com\/y\.js|[?&]ad_domain=/.test(url)) continue
    const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b)
    out.push({ title: text(a[2] ?? ""), url, snippet: text(snip?.[1] ?? "") })
  }
  return out
}

export async function webSearch(
  query: string,
  opts: { count?: number; env?: Record<string, string | undefined>; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<SearchOutcome> {
  const env = opts.env ?? process.env
  const n = Math.min(Math.max(opts.count ?? 6, 1), 15)
  const doFetch = opts.fetch ?? fetch
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
  const fail = async (engine: string, res: Response) => {
    throw new Error(`${engine} search failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`)
  }

  if (env.BRAVE_API_KEY) {
    const res = await doFetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, {
      headers: { accept: "application/json", "x-subscription-token": env.BRAVE_API_KEY },
      signal,
    })
    if (!res.ok) await fail("Brave", res)
    const j = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } }
    return {
      engine: "brave",
      results: (j.web?.results ?? []).slice(0, n).map((r) => ({ title: text(r.title ?? ""), url: r.url ?? "", snippet: text(r.description ?? "") })),
    }
  }
  if (env.TAVILY_API_KEY) {
    const res = await doFetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: n }),
      signal,
    })
    if (!res.ok) await fail("Tavily", res)
    const j = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] }
    return {
      engine: "tavily",
      results: (j.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: text(r.content ?? "").slice(0, 400) })),
    }
  }
  const res = await doFetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0 (compatible; BatonAgent/0.1)" },
    body: `q=${encodeURIComponent(query)}`,
    signal,
  })
  if (!res.ok) await fail("DuckDuckGo", res)
  return { engine: "duckduckgo", results: parseDuckDuckGo(await res.text()).slice(0, n) }
}

export function formatResults(query: string, r: SearchOutcome): string {
  if (!r.results.length) return `No results for "${query}" (${r.engine}).`
  return `Results for "${query}" (${r.engine}):\n\n${r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ""}`).join("\n\n")}\n\nRead a page with web_fetch.`
}
