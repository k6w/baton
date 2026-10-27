// @ts-nocheck — browser code: embedded in the page with toString(), so it runs in the browser
// and must not reference anything outside itself (the page passes in the Markdown renderer).
/**
 * The web view's behaviour. Plain DOM, no framework: a render function builds HTML strings,
 * and a keyed patch only replaces what changed, so live updates (a few a second) never reset
 * scrolling, text selection or what you've expanded.
 */
export function webClient(mdToHtml) {
  const doc = document
  const $ = (id) => doc.getElementById(id)
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
  const icon = (name, cls) => `<svg class="i${cls ? ` ${cls}` : ""}"><use href="#i-${name}"/></svg>`
  const store = {
    get: (k) => {
      try {
        return JSON.parse(localStorage.getItem(`baton:${k}`))
      } catch (_e) {
        return null
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(`baton:${k}`, JSON.stringify(v))
      } catch (_e) {}
    },
  }
  window.addEventListener("error", (e) => {
    doc.documentElement.setAttribute("data-error", String(e.message))
  })
  /** A drawing bug must not look like a lost connection (and retry forever): show it, keep going. */
  function safeRender() {
    try {
      render()
    } catch (e) {
      doc.documentElement.setAttribute("data-error", String(e?.stack ? e.stack : e))
      const c = doc.getElementById("content")
      if (c && !c.firstElementChild) c.innerHTML = `<div class="alert err">Couldn't show this view: ${esc(e?.message)}</div>`
    }
  }

  // ── access ──
  const TOKEN_KEY = `baton-token:${location.host}`
  const tm = /[#&]t=([^&]+)/.exec(location.hash)
  if (tm) {
    try {
      localStorage.setItem(TOKEN_KEY, tm[1])
    } catch (_e) {}
    history.replaceState(null, "", `${location.pathname}#/`)
  }
  const token = tm
    ? tm[1]
    : (() => {
        try {
          return localStorage.getItem(TOKEN_KEY) || ""
        } catch (_e) {
          return ""
        }
      })()
  if (!token)
    return gate(
      "Open the link from Baton",
      "Run <b>baton web</b> (or <b>/web</b> in the app) and open the link it shows, or scan its QR code. The link carries the access key.",
    )

  function gate(title, body) {
    doc.body.innerHTML = `<div class="gate"><div class="card"><div class="mark">b</div><h3 style="margin:0 0 6px">${title}</h3><p class="dim" style="margin:0">${body}</p></div></div>`
  }

  // ── state ──
  const S = {
    view: null,
    feeds: {},
    skew: 0,
    conn: "connecting",
    route: parseRoute(),
    open: new Set(store.get("open") || []),
    shut: new Set(),
    coord: store.get("coord") === true,
    filter: store.get("filter") || "all",
    dismissed: new Set(store.get("dismissed") || []),
    details: false,
    me:
      store.get("name") ||
      (() => {
        // the name the previous page kept
        try {
          return localStorage.getItem("baton-name") || ""
        } catch (_e) {
          return ""
        }
      })(),
    sent: store.get("sent") || [],
    hist: -1,
    sugg: null,
    menu: false,
  }
  const COLORS = {
    claude: "#e08a63",
    codex: "#e6e6e6",
    opencode: "#f5b14a",
    gemini: "#6aa0ff",
    cursor: "#b39dfa",
    copilot: "#7bd88f",
    goose: "#ff8a7a",
    qwen: "#9a83ff",
    amp: "#f7b84b",
    kimi: "#7ad7f0",
    baton: "#ff7b3a",
    mock: "#9a9a9a",
  }
  const color = (adapter) => {
    const k = Object.keys(COLORS).find((c) => String(adapter || "").indexOf(c) === 0)
    return COLORS[k] || "#8fa3bf"
  }
  const face = (a, lead) => {
    const n = lead ? "L" : (a?.name ? a.name[0] : "?").toUpperCase()
    return `<span class="face" style="background:${lead ? "linear-gradient(180deg,#ff9a5c,#ff6f2a)" : color(a?.adapter)}">${esc(n)}</span>`
  }

  // ── time ──
  const now = () => Date.now() + S.skew
  function ago(ts) {
    const s = Math.max(0, Math.round((now() - ts) / 1000))
    if (s < 45) return "now"
    if (s < 3600) return `${Math.round(s / 60)}m`
    if (s < 86400) return `${Math.round(s / 3600)}h`
    return `${Math.round(s / 86400)}d`
  }
  function dur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${s % 60 < 10 ? "0" : ""}${s % 60}s`
    return `${Math.floor(m / 60)}h ${m % 60}m`
  }
  const _clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const stamp = (ts) => `<time data-ago="${ts}" title="${esc(new Date(ts).toLocaleString())}">${ago(ts)}</time>`
  const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? "<$0.01" : "$0")
  const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0))
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`

  // ── routes: #/inbox · #/lead · #/agents · #/agent/<id> · #/activity · #/changes ──
  function parseRoute() {
    const m = /^#\/(\w+)(?:\/([\w-]+))?/.exec(location.hash)
    if (!m) return { name: "", id: "" }
    return { name: m[1], id: m[2] || "" }
  }
  function go(name, id) {
    const h = `#/${name}${id ? `/${id}` : ""}`
    if (location.hash !== h) history.pushState(null, "", h)
    S.route = { name: name, id: id || "" }
    S.details = false
    S.menu = false
    render(true)
    $("scroll").scrollTop = name === "lead" || name === "agent" ? 1e9 : 0
  }
  window.addEventListener("popstate", () => {
    S.route = parseRoute()
    render(true)
  })

  // ── network ──
  function api(path, body) {
    return fetch(path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "X-Baton-User": S.me || "web" },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) =>
      r.json().then((j) => {
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
        return j
      }),
    )
  }
  function act(path, body, ok) {
    return api(path, body).then(
      (r) => {
        if (ok) toast(typeof ok === "function" ? ok(r) : ok)
        return r
      },
      (e) => {
        toast(e.message, "err")
      },
    )
  }
  let backoff = 600
  function connect() {
    fetch("/api/stream", { headers: { Authorization: `Bearer ${token}`, "X-Baton-User": S.me || "web" } })
      .then((res) => {
        if (res.status === 401) {
          try {
            localStorage.removeItem(TOKEN_KEY)
          } catch (_e) {}
          gate("This link has expired", "Its access key was replaced. Run <b>baton web</b> again for a fresh link.")
          return
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        S.conn = "live"
        backoff = 600
        // a fresh connection sends every feed again
        S.feeds = {}
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ""
        const pump = () =>
          reader.read().then((r) => {
            if (r.done) throw new Error("closed")
            buf += dec.decode(r.value, { stream: true })
            let i = buf.indexOf("\n")
            let got = false
            while (i >= 0) {
              const line = buf.slice(0, i)
              buf = buf.slice(i + 1)
              if (line.trim()) {
                const v = JSON.parse(line)
                for (const k in v.feeds) S.feeds[k] = v.feeds[k]
                S.view = v
                S.skew = v.now - Date.now()
                got = true
              }
              i = buf.indexOf("\n")
            }
            if (got) safeRender()
            return pump()
          })
        render()
        return pump()
      })
      .catch(() => {
        if (S.conn !== "connecting") {
          S.conn = "offline"
          render()
        }
        setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 8000)
      })
  }

  // ── DOM patching ──
  function setHTML(el, html) {
    if (el._h !== html) {
      el.innerHTML = html
      el._h = html
    }
  }
  function make(it) {
    const t = doc.createElement("template")
    t.innerHTML = it.h.trim()
    const el = t.content.firstElementChild || doc.createElement("div")
    el.setAttribute("data-k", it.k)
    el._h = it.h
    return el
  }
  function patch(box, items) {
    const old = new Map()
    for (let c = box.firstElementChild; c; c = c.nextElementSibling) old.set(c.getAttribute("data-k"), c)
    let prev = null
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      let el = old.get(it.k)
      if (el) {
        old.delete(it.k)
        if (el._h !== it.h) {
          const n = make(it)
          el.replaceWith(n)
          el = n
        }
      } else el = make(it)
      const want = prev ? prev.nextElementSibling : box.firstElementChild
      if (el !== want) box.insertBefore(el, want)
      prev = el
    }
    old.forEach((el) => {
      el.remove()
    })
  }

  // ── what's what ──
  const agentsAll = () => {
    const v = S.view
    if (!v) return []
    return (v.lead ? [v.lead] : []).concat(v.agents)
  }
  const agentById = (id) => agentsAll().find((a) => a.id === id)
  const STATUS = { starting: "starting", ready: "idle", busy: "working", awaiting_approval: "needs approval", error: "error", exited: "stopped" }
  const statusText = (a) => STATUS[a.status] || a.status
  const needs = () => (S.view ? S.view.attention.filter((a) => a.kind !== "ready" && !S.dismissed.has(dkey(a))).length : 0)
  const withChanges = () => (S.view ? S.view.agents.filter((a) => a.workspace?.files.length) : [])
  function defaultRoute() {
    if (!S.view) return "lead"
    if (needs()) return "inbox"
    return S.view.lead ? "lead" : "agents"
  }

  // ── conversation ──
  const TK = { read: "read", edit: "edit", delete: "delete", move: "edit", search: "search", execute: "run", think: "think", fetch: "fetch", other: "tool" }
  function toolIcon(t) {
    if (t.coord)
      return t.verb === "Message" ? "msg" : t.verb === "Wait for results" || t.verb === "Check inbox" ? "wait" : t.verb === "Merge" ? "merge" : "agents"
    const byVerb = {
      Run: "run",
      Read: "read",
      Edit: "edit",
      Write: "write",
      Delete: "delete",
      Search: "search",
      "Find files": "search",
      "Search the web": "web",
      Fetch: "fetch",
      Check: "check",
    }
    return byVerb[t.verb] || TK[t.tk] || "tool"
  }
  function md(text) {
    return mdToHtml(text).replace(
      /<\/code><\/pre>/g,
      `</code><button class="btn sm icon copy" data-copy-pre title="Copy" type="button">${icon("copy", "xs")}</button></pre>`,
    )
  }
  function isOpen(key, dflt) {
    if (S.open.has(key)) return true
    if (S.shut.has(key)) return false
    return !!dflt
  }
  function toolBody(t) {
    let h = ""
    ;(t.diffs || []).forEach((d) => {
      h +=
        '<div class="diff"><div class="diff-h">' +
        icon("edit", "xs") +
        '<span class="path">' +
        esc(d.path) +
        '</span><span class="plus num">+' +
        d.added +
        '</span><span class="minus num">−' +
        d.removed +
        '</span></div><div class="diff-l">' +
        d.lines.map((l) => `<div class="${l[0]}" data-s="${l[0] === "a" ? "+" : l[0] === "d" ? "−" : ""}">${esc(l[1]) || " "}</div>`).join("") +
        "</div>" +
        (d.more ? `<div class="diff-more">${plural(d.more, "more line")}</div>` : "") +
        "</div>"
    })
    if (t.output) {
      const lines = t.output.split("\n")
      const full = isOpen(`full:${t.id}`)
      const shown = full || lines.length <= 60 ? t.output : lines.slice(-60).join("\n")
      h +=
        '<div class="term"><pre>' +
        esc(shown) +
        '</pre><div class="tf">' +
        (t.exit != null ? `<span class="chip ${t.exit === 0 ? "ok" : "err"}">exit ${esc(t.exit)}</span>` : "") +
        (lines.length > 60 && !full ? `<button class="btn sm ghost" data-toggle="full:${t.id}">Show all ${lines.length} lines</button>` : "<span></span>") +
        '<button class="btn sm ghost" data-copy="' +
        esc(t.id) +
        '" type="button">' +
        icon("copy", "xs") +
        " Copy</button></div></div>"
    } else if (!(t.diffs || []).length && t.summary) h += `<div class="dim" style="font-size:12.5px">${esc(t.summary)}</div>`
    if (!h) h = `<div class="faint" style="font-size:12.5px">${t.status === "in_progress" || t.status === "pending" ? "running…" : "no output"}</div>`
    return h
  }
  function toolRow(t) {
    const st = t.status === "completed" ? icon("ok", "sm") : t.status === "failed" ? icon("x", "sm") : '<span class="spin"></span>'
    const diff = (t.diffs || []).reduce((s, d) => [s[0] + d.added, s[1] + d.removed], [0, 0])
    const sum = diff[0] || diff[1] ? `<span class="plus num">+${diff[0]}</span> <span class="minus num">−${diff[1]}</span>` : t.summary ? esc(t.summary) : ""
    const open = isOpen(`t:${t.id}`)
    const expandable = !t.coord || t.output
    return (
      '<div class="tl ' +
      esc(t.status) +
      (t.coord ? " coord" : "") +
      '"><button class="tl-h" ' +
      (expandable ? `data-toggle="t:${t.id}"` : "") +
      ' type="button" title="' +
      esc(t.verb + (t.target ? ` ${t.target}` : "")) +
      '"><span class="ico">' +
      icon(toolIcon(t), "sm") +
      '</span><span class="tl-verb">' +
      esc(t.verb) +
      "</span>" +
      (t.target ? `<span class="tl-tgt">${esc(t.target)}</span>` : '<span class="tl-tgt"></span>') +
      (sum ? `<span class="tl-sum">${sum}</span>` : "") +
      '<span class="tl-st ' +
      esc(t.status) +
      '">' +
      st +
      "</span></button>" +
      (open ? `<div class="tl-b">${toolBody(t)}</div>` : "") +
      "</div>"
    )
  }
  function toolGroup(run, live) {
    const shown = S.coord ? run : run.filter((t) => !t.coord)
    const coord = run.length - shown.length
    if (!shown.length)
      return `<div class="note"><span>${icon("agents", "xs")} ${plural(coord, "coordination call")} · <a href="#" data-coord>show</a></span></div>`
    if (shown.length === 1 && !coord) return `<div class="tools">${toolRow(shown[0])}</div>`
    const key = `g:${run[0].id}`
    const failed = shown.filter((t) => t.status === "failed").length
    const running = shown.some((t) => t.status === "in_progress" || t.status === "pending")
    const by = {}
    shown.forEach((t) => {
      const v = t.coord
        ? "coordination"
        : t.verb === "Run" || t.verb === "Check"
          ? "command"
          : t.verb === "Read"
            ? "read"
            : t.verb === "Edit" || t.verb === "Write"
              ? "edit"
              : /search/i.test(t.verb)
                ? "search"
                : t.verb === "Fetch"
                  ? "fetch"
                  : "step"
      by[v] = (by[v] || 0) + 1
    })
    const words = Object.keys(by)
      .map((k) => plural(by[k], k === "search" ? "search" : k).replace("searchs", "searches"))
      .join(" · ")
    const open = isOpen(key, live && running)
    return (
      '<div class="tools' +
      (open ? " open" : "") +
      '"><button class="tools-h" data-toggle="' +
      key +
      '" type="button">' +
      icon("chev", "xs chev") +
      (running ? '<span class="spin"></span>' : "") +
      "<span>" +
      esc(words) +
      "</span>" +
      '<span class="tsum">' +
      (failed ? `<span class="chip err">${failed} failed</span>` : "") +
      (coord && !S.coord ? `<span class="chip">+${coord} coordination</span>` : "") +
      "</span></button>" +
      (open ? `<div class="tools-b">${shown.map(toolRow).join("")}</div>` : "") +
      "</div>"
    )
  }
  function handoff(it, to) {
    const h = it.h
    const kinds = { result: "Result", message: "Message", chat: "Message", request: "Request", reply: "Reply", system: "Baton" }
    let chips = ""
    if (h.outcome)
      chips += `<span class="chip ${h.outcome === "ok" ? "ok" : h.outcome === "failed" ? "err" : "warn"}">${h.outcome === "ok" ? `${icon("ok", "xs")} Done` : h.outcome === "failed" ? `${icon("x", "xs")} Failed` : "Interrupted"}</span>`
    if (h.diff) chips += `<span class="chip num"><span class="plus">+${h.diff.added}</span> <span class="minus">−${h.diff.removed}</span></span>`
    if (h.unmerged) chips += `<span class="chip acc">${icon("merge", "xs")} to merge</span>`
    const key = `h:${it.id}`
    const long = h.text.length > 1400 || h.text.split("\n").length > 22
    const open = isOpen(key)
    const checks = (h.checks || [])
      .map(
        (c) =>
          '<div class="check ' +
          (c.ok ? "ok" : "bad") +
          '">' +
          icon(c.ok ? "ok" : "x", "sm") +
          "<code>" +
          esc(c.command) +
          "</code>" +
          (c.ok ? "" : `<span class="dim" style="margin-left:auto;white-space:nowrap">${esc((c.detail || "").split("\n")[0])}</span>`) +
          "</div>",
      )
      .join("")
    return (
      '<div class="ho ' +
      esc(h.kind) +
      " " +
      esc(h.outcome || "") +
      '"><div class="ho-h">' +
      icon(h.kind === "result" ? "check" : h.kind === "system" ? "info" : "msg", "sm") +
      "<b>" +
      esc(h.from) +
      "</b>" +
      (to ? `<span class="arrow">→</span><b>${esc(to)}</b>` : "") +
      '<span class="dim">' +
      esc(kinds[h.kind] || h.kind) +
      "</span>" +
      '<span class="chips">' +
      chips +
      stamp(it.ts) +
      "</span></div>" +
      (h.text
        ? `<div class="ho-b"><div class="msg md${long && !open ? " clamp" : ""}">${md(h.text)}</div>${long ? `<button class="btn sm ghost more" data-toggle="${key}">${open ? "Show less" : "Show all"}</button>` : ""}</div>`
        : "") +
      (checks ? `<div class="checks">${checks}</div>` : "") +
      "</div>"
    )
  }
  function conversation(items, owner, live) {
    const out = []
    let run = []
    let head = true
    let last = 0
    const who = (ts) => {
      if (!head) return ""
      head = false
      return `<div class="who">${face(owner, owner?.lead)}<b>${esc(owner ? (owner.lead ? "Lead" : owner.name) : "agent")}</b>${owner?.model ? `<span>${esc(owner.model)}</span>` : ""}${stamp(ts)}</div>`
    }
    const flush = (isLast) => {
      if (!run.length) return
      const h = who(run[0].ts) + toolGroup(run, live && isLast)
      out.push({ k: `r:${run[0].id}`, h: `<div class="blk">${h}</div>` })
      run = []
    }
    items.forEach((it, i) => {
      if (last && it.ts - last > 15 * 60 * 1000) {
        flush()
        out.push({
          k: `s:${it.id}`,
          h: `<div class="sep">${esc(new Date(it.ts).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}</div>`,
        })
        head = true
      }
      last = it.ts
      if (it.k === "tool") {
        run.push(it)
        return
      }
      flush()
      let h = ""
      if (it.k === "text") {
        if (it.role === "thought") {
          const tk = `th:${it.id}`
          const to = isOpen(tk)
          h =
            '<div class="thought"><button data-toggle="' +
            tk +
            '" type="button">' +
            icon("think", "xs") +
            " Thinking" +
            (to ? "" : ` <span class="pv">${esc(it.text.split("\n")[0].slice(0, 140))}</span>`) +
            "</button>" +
            (to ? `<div class="tb md">${md(it.text)}</div>` : "") +
            "</div>"
        } else {
          const mk = `m:${it.id}`
          const long = it.text.length > 2600 || it.text.split("\n").length > 34
          const mo = isOpen(mk)
          h = `${who(it.ts)}<div class="msg md${long && !mo ? " clamp" : ""}">${md(it.text)}</div>${long ? `<button class="btn sm ghost more" data-toggle="${mk}">${mo ? "Show less" : "Show all"}</button>` : ""}`
        }
      } else if (it.k === "prompt") {
        h = `<div class="prompt"><div class="ph"><b>${esc(it.from || "You")}</b>${owner && !owner.lead ? `→ ${esc(owner.name)}` : ""}${stamp(it.ts)}</div><div class="pt">${esc(it.text)}</div></div>`
        head = true
      } else if (it.k === "handoff") {
        h = handoff(it, it.to)
        head = true
      } else if (it.k === "ask") {
        h = `<div class="alert warn">${icon("alert", "sm")}<div><b>Asked:</b> ${esc(it.text)}${it.resolved ? ` <span class="dim">— ${esc(it.resolved)}</span>` : ""}</div></div>`
      } else if (it.k === "error") h = `<div class="alert err">${icon("alert", "sm")}<div>${esc(it.text)}</div></div>`
      else if (it.k === "note") h = `<div class="note"><span>${esc(it.text)}</span></div>`
      if (h) out.push({ k: `${it.k}:${it.id}`, h: `<div class="blk">${h}</div>` })
      if (i === items.length - 1) head = head || false
    })
    flush(true)
    return out
  }

  // ── views ──
  const EMPTY = (ic, title, body) => [{ k: "empty", h: `<div class="empty"><div class="ei">${icon(ic)}</div><b>${title}</b>${body}</div>` }]
  const KIND = {
    approval: "Approval",
    plan: "Plan",
    failed: "Failed",
    conflict: "Conflict",
    merge: "Merge failed",
    budget: "Budget",
    stalled: "Stalled",
    looping: "Looping",
    scope: "Out of scope",
    ready: "Ready to merge",
  }
  /** Problems can be put away; approvals and plans can't. A problem that changes comes back. */
  const DISMISSABLE = { failed: 1, stalled: 1, looping: 1, scope: 1, merge: 1, conflict: 1, budget: 1 }
  const dkey = (a) => `${a.kind}:${a.agentId || ""}:${a.ts}`
  const inbox = () => (S.view ? S.view.attention.map((a, i) => ({ a, i })).filter((x) => !S.dismissed.has(dkey(x.a))) : [])
  function dismiss(list) {
    list.forEach((a) => {
      S.dismissed.add(dkey(a))
    })
    store.set("dismissed", Array.from(S.dismissed).slice(-500))
    render()
  }
  function inboxView() {
    const items = inbox()
    const hidden = S.view.attention.length - items.length
    const restore = hidden ? `<button class="btn sm ghost" data-restore>${plural(hidden, "dismissed item")} · show</button>` : ""
    if (!items.length)
      return EMPTY(
        "inbox",
        "Nothing needs you",
        `Approvals, finished work and problems show up here.${restore ? `<div style="margin-top:12px">${restore}</div>` : ""}`,
      )
    const firstApproval = items.findIndex((x) => x.a.kind === "approval")
    const problems = items.filter((x) => DISMISSABLE[x.a.kind])
    const head =
      `<div class="h2"><h2>${plural(items.length, "item")}</h2><span class="line"></span>` +
      (problems.length > 1 ? `<button class="btn sm ghost" data-dismiss-all>Dismiss ${plural(problems.length, "problem")}</button>` : "") +
      restore +
      "</div>"
    return [{ k: "h", h: head }].concat(
      items.map((x, n) => {
        const a = x.a
        const i = x.i
        let acts = ""
        if (a.kind === "approval") {
          acts =
            `<button class="btn go" data-a="allow" data-i="${i}">${icon("ok", "sm")} Allow</button>` +
            (a.options || [])
              .filter((o) => o.kind === "allow_always")
              .map((o) => `<button class="btn" data-a="${esc(o.optionId)}" data-i="${i}">Always allow</button>`)
              .join("") +
            `<button class="btn bad" data-a="deny" data-i="${i}">${icon("x", "sm")} Deny</button>` +
            (n === firstApproval ? '<span class="hint"><kbd>Y</kbd> allow <kbd>N</kbd> deny</span>' : "")
        } else if (a.kind === "plan")
          acts = `<button class="btn go" data-a="plan-ok" data-i="${i}">Approve plan</button><button class="btn bad" data-a="plan-no" data-i="${i}">Reject…</button>`
        else if (a.kind === "ready")
          acts = `<button class="btn pri" data-a="merge" data-i="${i}">${icon("merge", "sm")} Merge</button><button class="btn" data-a="open" data-i="${i}">Review</button>`
        else if (a.agentId) acts = `<button class="btn" data-a="open" data-i="${i}">Open ${esc(a.agent || "agent")}</button>`
        if (DISMISSABLE[a.kind]) acts += `<button class="btn ghost" data-a="dismiss" data-i="${i}">Dismiss</button>`
        const tasks =
          a.kind === "plan" && S.view.tasks.length
            ? `<div class="well">${S.view.tasks.map((t, k) => `${k + 1}. ${esc(t.title)}${t.owner ? `  → ${esc(t.owner)}` : ""}`).join("\n")}</div>`
            : ""
        const led =
          a.kind === "ready"
            ? "ok"
            : a.kind === "plan"
              ? ""
              : DISMISSABLE[a.kind] && a.kind !== "failed" && a.kind !== "merge" && a.kind !== "conflict"
                ? "warn"
                : a.kind === "approval"
                  ? "warn"
                  : "err"
        // approvals read "claude-1: Bash(…)": the agent is shown next to the time already
        const title = a.kind === "approval" ? a.title.replace(/^[^:]+:\s*/, "") : a.title
        return {
          k: `a:${a.requestId || dkey(a)}`,
          h:
            `<div class="card${n === firstApproval ? " sel" : ""}"><div class="card-k k-${esc(a.kind)}"><span class="led ${led}"></span>${esc(KIND[a.kind] || a.kind)}` +
            (a.toolKind ? ` <span class="chip">${esc(a.toolKind)}</span>` : "") +
            `<span class="ago">${a.agent ? `${esc(a.agent)} · ` : ""}${stamp(a.ts)}</span></div><h3>${esc(title)}</h3>` +
            (a.detail ? `<div class="well">${esc(a.detail)}</div>` : "") +
            tasks +
            (acts ? `<div class="acts">${acts}</div>` : "") +
            "</div>",
        }
      }),
    )
  }
  function feedView(a) {
    const items = S.feeds[a.id] || []
    if (!items.length)
      return EMPTY(
        a.lead ? "lead" : "agents",
        a.lead ? "The lead is ready" : `${esc(a.name)} hasn't done anything yet`,
        a.lead ? "Give it a task below — it plans, starts agents and merges their work." : "Send it a message below.",
      )
    const live = a.status === "busy" || a.status === "starting" || a.status === "awaiting_approval"
    const out = conversation(items, a, live)
    // what it's doing right now, at the end of the conversation
    if (live)
      out.push({
        k: "live",
        h:
          `<div class="live">${a.status === "awaiting_approval" ? icon("alert", "sm") : '<span class="spin"></span>'}` +
          `<span>${esc(a.status === "awaiting_approval" ? "Waiting for your approval" : a.activity || statusText(a))}</span>` +
          (a.turnStartedAt ? `<span class="faint num" data-since="${a.turnStartedAt}">${dur(now() - a.turnStartedAt)}</span>` : "") +
          (a.status === "awaiting_approval" ? '<button class="btn sm" data-go="inbox">Open inbox</button>' : "") +
          "</div>",
      })
    return out
  }
  const ORDER = { awaiting_approval: 0, error: 1, busy: 2, starting: 3, ready: 4, exited: 5 }
  function agentsView() {
    const list = S.view.agents.slice().sort((x, y) => (ORDER[x.status] ?? 9) - (ORDER[y.status] ?? 9) || (y.lastEventAt || 0) - (x.lastEventAt || 0))
    const F = { all: "All", busy: "Working", waiting: "Needs you", idle: "Idle", stopped: "Stopped" }
    const keep = (a) =>
      S.filter === "all" ||
      (S.filter === "busy" && (a.status === "busy" || a.status === "starting")) ||
      (S.filter === "waiting" && (a.status === "awaiting_approval" || a.status === "error")) ||
      (S.filter === "idle" && a.status === "ready") ||
      (S.filter === "stopped" && a.status === "exited")
    const head = {
      k: "f",
      h:
        '<div class="h2" style="flex-wrap:wrap">' +
        Object.keys(F)
          .map((f) => {
            const n =
              f === "all"
                ? list.length
                : list.filter((a) => {
                    const s = S.filter
                    S.filter = f
                    const r = keep(a)
                    S.filter = s
                    return r
                  }).length
            return `<button class="btn sm${S.filter === f ? "" : " ghost"}" data-filter="${f}">${F[f]} <span class="dim num">${n}</span></button>`
          })
          .join("") +
        '<span class="line"></span></div>',
    }
    if (!list.length) return EMPTY("agents", "No agents yet", "Give the lead a task, or type <b>/spawn codex 2</b> below.")
    const shown = list.filter(keep)
    return [
      head,
      {
        k: `g:${S.filter}`,
        h: `<div class="agrid">${shown.length ? shown.map(agentCard).join("") : '<div class="dim" style="padding:20px 4px">None right now.</div>'}</div>`,
      },
    ]
  }
  function agentCard(a) {
    const ws = a.workspace
    return (
      '<div class="card click" data-agent="' +
      esc(a.id) +
      '"><div class="ac-top">' +
      face(a) +
      "<b>" +
      esc(a.name) +
      '</b><span class="st"><span class="led ' +
      esc(a.status) +
      '"></span> ' +
      esc(statusText(a)) +
      (a.turnStartedAt && a.status === "busy" ? ` · <span data-since="${a.turnStartedAt}">${dur(now() - a.turnStartedAt)}</span>` : "") +
      '</span></div><div class="ac-meta">' +
      esc([a.adapter, a.model, a.role].filter(Boolean).join(" · ")) +
      (a.label ? ` — ${esc(a.label)}` : "") +
      "</div>" +
      (a.activity || a.detail ? `<div class="ac-now">${esc(a.status === "busy" ? a.activity || a.detail : a.detail || a.activity)}</div>` : "") +
      (a.progress != null ? `<div class="meter"><i style="width:${Math.round(a.progress * 100)}%"></i></div>` : "") +
      '<div class="ac-stats num"><span>' +
      count(a.toolCalls) +
      " tools</span>" +
      (ws?.files.length
        ? `<span><span class="plus">+${ws.added}</span> <span class="minus">−${ws.removed}</span> · ${plural(ws.files.length, "file")}</span>`
        : "") +
      (a.cost ? `<span>${money(a.cost)}</span>` : "") +
      "</div></div>"
    )
  }
  function activityView() {
    const v = S.view
    const out = []
    if (v.tasks.length) {
      const done = v.tasks.filter((t) => t.state === "completed").length
      out.push({
        k: "tasks",
        h:
          '<div class="card"><div class="card-k">' +
          icon("plan", "sm") +
          " Plan" +
          (v.plan
            ? ` <span class="chip ${v.plan.status === "approved" ? "ok" : v.plan.status === "rejected" ? "err" : "warn"}">${esc(v.plan.status)}</span>`
            : "") +
          '<span class="ago num">' +
          done +
          "/" +
          v.tasks.length +
          " done</span></div>" +
          '<div class="meter"><i style="width:' +
          Math.round((done / v.tasks.length) * 100) +
          '%"></i></div><div class="tasks" style="margin-top:10px">' +
          v.tasks.map(taskRow).join("") +
          "</div></div>",
      })
    }
    if (!v.bus.length)
      return out.length ? out : EMPTY("activity", "No messages between agents yet", "When the lead hands out work and agents report back, it shows up here.")
    out.push({ k: "bh", h: '<div class="h2" style="margin-top:18px"><h2>Between agents · newest first</h2><span class="line"></span></div>' })
    let last = 0
    v.bus
      .slice()
      .reverse()
      .forEach((m) => {
        if (last && last - m.ts > 15 * 60 * 1000)
          out.push({
            k: `s:${m.id}`,
            h: `<div class="sep">${esc(new Date(m.ts).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}</div>`,
          })
        last = m.ts
        out.push({ k: `b:${m.id}`, h: `<div>${handoff({ id: m.id, h: m.h, ts: m.ts }, m.to)}</div>` })
      })
    return out
  }
  function taskRow(t) {
    const cls = t.state === "completed" ? "done" : t.state === "working" ? "running" : t.state === "failed" || t.state === "rejected" ? "failed" : ""
    return `<div class="task ${cls}"><span class="tick2">${cls === "done" ? icon("ok", "xs") : cls === "failed" ? icon("x", "xs") : ""}</span><div class="tb2">${esc(t.title)}${t.owner ? `<small>${esc(t.owner)} · ${esc(t.state)}</small>` : `<small>${esc(t.state)}</small>`}</div></div>`
  }
  function changesView() {
    const list = withChanges()
    if (!list.length) return EMPTY("changes", "No unmerged changes", "Work agents do in their own worktrees waits here until you merge it.")
    const tot = list.reduce((s, a) => [s[0] + a.workspace.added, s[1] + a.workspace.removed, s[2] + a.workspace.files.length], [0, 0, 0])
    return [
      {
        k: "h",
        h: `<div class="h2"><h2>${plural(list.length, "agent")} · ${plural(tot[2], "file")} · <span class="plus">+${tot[0]}</span> <span class="minus">−${tot[1]}</span></h2><span class="line"></span></div>`,
      },
    ].concat(list.map((a) => ({ k: `c:${a.id}`, h: `<div class="card">${workspaceBlock(a, true)}</div>` })))
  }
  /** A path as its folder (dim) and its name. */
  function filePath(p) {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
    return i < 0 ? esc(p) : `<i>${esc(p.slice(0, i + 1))}</i>${esc(p.slice(i + 1))}`
  }
  function workspaceBlock(a, title) {
    const ws = a.workspace
    const merge = ws.merge
    const state = merge
      ? `<span class="chip ${merge.status === "merged" ? "ok" : merge.status === "failed" || merge.status === "conflict" ? "err" : "warn"}">${esc(merge.status)}</span>`
      : ""
    const review = ws.review
      ? `<span class="chip ${ws.review.status === "approve" ? "ok" : ws.review.status === "changes_requested" ? "err" : "info"}">review: ${esc(ws.review.status.replace("_", " "))}</span>`
      : ""
    return (
      (title
        ? `<div class="ac-top">${face(a)}<b>${esc(a.name)}</b><span class="st">${state}${review}</span></div>`
        : `<div class="card-k">${icon("changes", "sm")} ${esc(ws.mode === "worktree" ? "worktree" : "shared")} ${state}${review}</div>`) +
      '<div class="ac-meta">' +
      (ws.branch ? `${icon("changes", "xs")} ${esc(ws.branch)} · ` : "") +
      plural(ws.files.length, "file") +
      ' · <span class="plus">+' +
      ws.added +
      '</span> <span class="minus">−' +
      ws.removed +
      "</span></div>" +
      (ws.files.length
        ? '<div class="files">' +
          ws.files
            .slice(0, 40)
            .map(
              (f) =>
                `<div class="file" title="${esc(f.path)}"><span class="p">${filePath(f.path)}</span><span class="plus num">+${f.added}</span><span class="minus num">−${f.removed}</span></div>`,
            )
            .join("") +
          (ws.files.length > 40 ? `<div class="file dim">${plural(ws.files.length - 40, "more file")}</div>` : "") +
          "</div>"
        : "") +
      (ws.conflicts.length
        ? '<div class="alert err" style="margin-top:10px">' +
          icon("alert", "sm") +
          "<div>Conflicts with " +
          ws.conflicts.map((c) => `<b>${esc(c.with)}</b> (${esc(c.files.slice(0, 3).join(", "))})`).join(", ") +
          "</div></div>"
        : "") +
      (merge?.detail ? `<div class="well">${esc(merge.detail)}</div>` : "") +
      (ws.files.length && ws.mode === "worktree"
        ? '<div class="acts"><button class="btn pri" data-merge="' +
          esc(a.id) +
          '">' +
          icon("merge", "sm") +
          " Merge</button>" +
          (title ? `<button class="btn" data-agent="${esc(a.id)}">Open ${esc(a.name)}</button>` : "") +
          '<button class="btn ghost" data-cmd="/review ' +
          esc(a.name) +
          '">Ask for review</button></div>'
        : "")
    )
  }

  // ── inspector ──
  function inspector() {
    const r = S.route
    const a = r.name === "agent" ? agentById(r.id) : r.name === "lead" ? S.view.lead : null
    if (a) return agentDetails(a)
    const v = S.view
    const t = v.totals
    const live = agentsAll().filter((x) => x.status !== "exited").length
    return (
      '<div class="insp-s"><h4>' +
      icon("activity", "xs") +
      ' Run</h4><dl class="kv num"><dt>Agents running</dt><dd>' +
      live +
      "</dd><dt>Cost</dt><dd>" +
      money(t.costUsd) +
      "</dd><dt>Tokens</dt><dd>" +
      count(t.input + t.output) +
      "</dd><dt>Tool calls</dt><dd>" +
      count(t.toolCalls) +
      '</dd><dt>Lines</dt><dd><span class="plus">+' +
      count(t.added) +
      '</span> <span class="minus">−' +
      count(t.removed) +
      "</span></dd><dt>Autonomy</dt><dd>" +
      esc(v.autonomy) +
      "</dd></dl></div>" +
      (v.tasks.length ? `<div class="insp-s"><h4>${icon("plan", "xs")} Plan</h4><div class="tasks">${v.tasks.map(taskRow).join("")}</div></div>` : "") +
      (withChanges().length
        ? '<div class="insp-s"><h4>' +
          icon("changes", "xs") +
          " To merge</h4>" +
          withChanges()
            .map(
              (x) =>
                '<div class="task" style="cursor:pointer" data-agent="' +
                esc(x.id) +
                '"><span class="led ' +
                esc(x.status) +
                '" style="margin-top:6px"></span><div class="tb2">' +
                esc(x.name) +
                '<small class="num">' +
                plural(x.workspace.files.length, "file") +
                " · +" +
                x.workspace.added +
                " −" +
                x.workspace.removed +
                "</small></div></div>",
            )
            .join("") +
          "</div>"
        : "")
    )
  }
  function agentDetails(a) {
    const row = (k, v) => (v == null || v === "" ? "" : `<dt>${k}</dt><dd title="${esc(v)}">${esc(v)}</dd>`)
    return (
      '<div class="insp-s"><h4><span class="led ' +
      esc(a.status) +
      '"></span> ' +
      esc(statusText(a)) +
      (a.turnStartedAt && a.status === "busy" ? ` · <span data-since="${a.turnStartedAt}">${dur(now() - a.turnStartedAt)}</span>` : "") +
      "</h4>" +
      (a.detail ? `<div class="dim" style="font-size:12.5px;margin-bottom:10px;overflow-wrap:anywhere">${esc(a.detail)}</div>` : "") +
      '<dl class="kv num">' +
      row("Agent", a.adapter) +
      row("Model", a.model) +
      row("Role", a.role) +
      row("Task", a.label && a.label !== a.name && a.label !== "orchestrator" ? a.label : "") +
      row("Approval", a.approval) +
      row("Access", a.access) +
      row("Running for", a.startedAt ? dur(now() - a.startedAt) : "") +
      row("Tool calls", count(a.toolCalls)) +
      row("Tokens", a.tokens ? count(a.tokens) : "") +
      row("Cost", a.cost ? money(a.cost) : "") +
      "</dl>" +
      (a.progress != null ? `<div class="meter"><i style="width:${Math.round(a.progress * 100)}%"></i></div>` : "") +
      '<div class="acts" style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">' +
      (a.status === "busy" || a.status === "awaiting_approval"
        ? `<button class="btn sm" data-int="${esc(a.id)}">${icon("stop", "xs")} Interrupt</button>`
        : "") +
      (a.lead ? "" : `<button class="btn sm bad" data-kill="${esc(a.id)}">Stop agent</button>`) +
      "</div></div>" +
      (a.workspace && (a.workspace.files.length || a.workspace.mode === "worktree")
        ? `<div class="insp-s"><h4>${icon("changes", "xs")} Changes</h4>${workspaceBlock(a, false)}</div>`
        : "")
    )
  }

  // ── chrome: sidebar, bar, tabs ──
  const LEVELS = [
    ["normal", "Normal", "Agents ask for anything risky"],
    ["auto", "Auto", "Agents edit and run commands without asking"],
    ["yolo", "YOLO", "Nothing is asked, nothing is sandboxed"],
    ["ask", "Ask", "Agents ask before every action"],
  ]
  function sidebar() {
    const v = S.view
    const r = S.route.name
    const others = (v.viewers || []).filter((n) => n !== S.me)
    setHTML($("conn"), "")
    $("conn").className = `led ${S.conn === "live" ? "ok" : S.conn === "offline" ? "err" : "warn"}`
    $("conn").title = S.conn === "live" ? "Connected" : S.conn === "offline" ? "Reconnecting…" : "Connecting…"
    setHTML(
      $("proj"),
      `<div class="pn">${esc(v.project || "project")}</div><div class="pb">${icon("changes", "xs")}<span>${esc(v.branch || "no branch")}</span></div>`,
    )
    setHTML(
      $("auto"),
      LEVELS.map(
        (l) => `<button type="button" data-mode="${l[0]}" title="${esc(l[2])}" class="${v.autonomy === l[0] ? `on ${l[0]}` : ""}">${l[1]}</button>`,
      ).join(""),
    )
    const n = needs()
    const lead = v.lead
    const nav = [
      ["inbox", "inbox", "Inbox", n ? `<span class="count hot num">${n}</span>` : `<span class="count num">${inbox().length || ""}</span>`],
      ["lead", "lead", "Lead", lead ? `<span class="count"><span class="led ${esc(lead.status)}"></span></span>` : ""],
      ["agents", "agents", "Agents", `<span class="count num">${v.agents.length || ""}</span>`],
      ["activity", "activity", "Activity", ""],
      ["changes", "changes", "Changes", withChanges().length ? `<span class="count num">${withChanges().length}</span>` : ""],
    ]
    setHTML(
      $("nav"),
      nav.map((x) => `<button type="button" data-go="${x[0]}" class="${r === x[0] ? "on" : ""}">${icon(x[1])}<span>${x[2]}</span>${x[3]}</button>`).join(""),
    )
    const list = v.agents.slice().sort((x, y) => (ORDER[x.status] ?? 9) - (ORDER[y.status] ?? 9) || x.name.localeCompare(y.name))
    setHTML(
      $("agentsNav"),
      list.length
        ? list
            .map((a) => {
              const line =
                a.status === "busy" ? a.activity || a.detail || "working" : a.status === "awaiting_approval" ? "needs approval" : a.detail || statusText(a)
              return (
                '<button type="button" class="agent-link' +
                (S.route.name === "agent" && S.route.id === a.id ? " on" : "") +
                '" data-agent="' +
                esc(a.id) +
                '"><span class="led ' +
                esc(a.status) +
                '"></span><span class="al"><span class="an"><b>' +
                esc(a.name) +
                "</b><small>" +
                esc(a.model || a.adapter) +
                '</small></span><span class="ad">' +
                esc(line) +
                "</span></span>" +
                (a.turnStartedAt && a.status === "busy"
                  ? `<span class="tick num" data-since="${a.turnStartedAt}">${dur(now() - a.turnStartedAt)}</span>`
                  : "") +
                "</button>"
              )
            })
            .join("")
        : '<div class="faint" style="padding:6px 12px;font-size:12.5px">No agents yet</div>',
    )
    const t = v.totals
    setHTML(
      $("foot"),
      '<div class="stats num"><div class="stat"><b>' +
        money(t.costUsd) +
        '</b><span>cost</span></div><div class="stat"><b>' +
        count(t.input + t.output) +
        '</b><span>tokens</span></div><div class="stat"><b>' +
        count(t.toolCalls) +
        '</b><span>tools</span></div><div class="stat"><b><span class="plus">+' +
        count(t.added) +
        '</span> <span class="minus">−' +
        count(t.removed) +
        '</span></b><span>lines</span></div></div><div class="viewers">' +
        '<span class="avatar" title="you">' +
        esc((S.me || "w")[0].toUpperCase()) +
        "</span>" +
        others
          .slice(0, 4)
          .map((o) => `<span class="avatar" title="${esc(o)}">${esc(o[0].toUpperCase())}</span>`)
          .join("") +
        "<span>" +
        (others.length ? `${esc(others.slice(0, 2).join(", ")) + (others.length > 2 ? ` +${others.length - 2}` : "")} watching` : "Only you") +
        '</span><button class="btn sm ghost icon" style="margin-left:auto" data-palette title="Commands (Ctrl+K)">' +
        icon("cmd", "xs") +
        "</button></div>",
    )
  }
  function bar() {
    const r = S.route
    const v = S.view
    const menu = `<button class="btn ghost icon back" data-menu type="button" title="Menu">${icon("menu")}</button>`
    const back = (to) => `<button class="btn ghost icon back" data-go="${to}" type="button" title="Back">${icon("back")}</button>`
    const a = r.name === "agent" ? agentById(r.id) : r.name === "lead" ? v.lead : null
    if (a) {
      const acts =
        (a.status === "busy" || a.status === "awaiting_approval"
          ? `<button class="btn sm" data-int="${esc(a.id)}" type="button">${icon("stop", "xs")} Interrupt</button>`
          : "") +
        (a.workspace?.files.length && a.workspace.mode === "worktree"
          ? `<button class="btn sm pri" data-merge="${esc(a.id)}" type="button">${icon("merge", "xs")} Merge</button>`
          : "") +
        '<button class="btn sm ghost details-btn" data-details type="button">' +
        icon("info", "xs") +
        "</button>"
      return (
        (r.name === "agent" ? back("agents") : menu) +
        "<h1>" +
        face(a, a.lead) +
        "<span>" +
        esc(a.lead ? "Lead" : a.name) +
        '</span><span class="led ' +
        esc(a.status) +
        '"></span></h1><span class="sub">' +
        esc(statusText(a)) +
        (a.turnStartedAt && a.status === "busy" ? ` · <span data-since="${a.turnStartedAt}">${dur(now() - a.turnStartedAt)}</span>` : "") +
        " · " +
        esc([a.adapter, a.model].filter(Boolean).join(" · ")) +
        '</span><div class="acts">' +
        acts +
        "</div>"
      )
    }
    const T = {
      inbox: ["Inbox", needs() ? `${plural(needs(), "thing")} need${needs() === 1 ? "s" : ""} you` : "All clear"],
      agents: ["Agents", plural(v.agents.length, "agent")],
      activity: ["Activity", "The plan and what agents tell each other"],
      changes: ["Changes", "Work waiting in worktrees"],
    }
    const t = T[r.name] || ["", ""]
    return `${menu}<h1><span>${t[0]}</span></h1><span class="sub">${esc(t[1])}</span><div class="acts"><button class="btn sm ghost" data-palette type="button">${icon("cmd", "xs")} <kbd>Ctrl K</kbd></button></div>`
  }
  function tabbar() {
    const r = S.route.name
    const n = needs()
    return [
      ["inbox", "inbox", "Inbox", n],
      ["lead", "lead", "Lead", 0],
      ["agents", "agents", "Agents", 0],
      ["activity", "activity", "Activity", 0],
    ]
      .map((x) => {
        const on = r === x[0] || (x[0] === "agents" && (r === "agent" || r === "changes"))
        return `<button type="button" data-go="${x[0]}" class="${on ? "on" : ""}">${icon(x[1])}<span>${x[2]}</span>${x[3] ? `<span class="dot num">${x[3]}</span>` : ""}</button>`
      })
      .join("")
  }

  // ── render ──
  function render(routeChanged) {
    if (!S.view) {
      setHTML($("content"), '<div class="empty"><div class="ei"><span class="spin"></span></div><b>Connecting to Baton…</b></div>')
      return
    }
    if (!S.route.name) S.route = { name: defaultRoute(), id: "" }
    // the tab says when something needs you
    const n = needs()
    doc.title = `${n ? `(${n}) ` : ""}${S.view.project ? `${S.view.project} · ` : ""}baton`
    let r = S.route
    if (r.name === "agent" && !agentById(r.id)) S.route = r = { name: "agents", id: "" }
    const sc = $("scroll")
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120
    sidebar()
    setHTML($("bar"), bar())
    setHTML($("tabbar"), tabbar())
    setHTML($("banner"), S.conn === "offline" ? '<div class="banner"><span class="spin"></span> Lost the connection to Baton — reconnecting…</div>' : "")
    const a = r.name === "agent" ? agentById(r.id) : r.name === "lead" ? S.view.lead : null
    let items = []
    if (a && S.details) items = [{ k: "details", h: `<div class="card" style="padding:0">${agentDetails(a)}</div>` }]
    else if (a) items = feedView(a)
    else if (r.name === "lead") items = EMPTY("lead", "No lead in this run", "Start Baton with an orchestrator to have one plan and hand out work.")
    else if (r.name === "inbox") items = inboxView()
    else if (r.name === "agents") items = agentsView()
    else if (r.name === "activity") items = activityView()
    else if (r.name === "changes") items = changesView()
    else items = inboxView()
    const content = $("content")
    if (content.getAttribute("data-route") !== r.name + r.id) {
      content.innerHTML = ""
      content.setAttribute("data-route", r.name + r.id)
    }
    content.className = `content${a && !S.details ? " conv" : ""}`
    patch(content, items)
    setHTML($("insp"), inspector())
    $("app").classList.toggle("menu", S.menu)
    target()
    const small = window.innerWidth < 820
    $("text").placeholder =
      a && !a.lead
        ? `Message ${a.name}…`
        : S.view.lead
          ? small
            ? "Task for the lead…"
            : "Give the lead a task, @agent a message, or /command…"
          : small
            ? "@agent or /command…"
            : "@agent a message, or /command…"
    const conv = !!a && !S.details
    if (conv && (routeChanged || nearBottom)) sc.scrollTop = sc.scrollHeight
    $("jump").hidden = !conv || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 200
  }

  /** Who what you're typing goes to: an @mention, a /command, or this page's agent. */
  function target() {
    if (!S.view) return
    const v = $("text").value.trim()
    const r = S.route
    const a = r.name === "agent" ? agentById(r.id) : null
    const at = /^@([\w.-]+)/.exec(v)
    const to = v[0] === "/" ? "" : at ? at[1] : a ? a.name : S.view.lead ? "lead" : ""
    setHTML(
      $("to"),
      v[0] === "/" ? `${icon("cmd", "xs")} <b>command</b>` : to ? `${icon("send", "xs")} to <b>${esc(to)}</b>` : `${icon("send", "xs")} <b>command</b>`,
    )
  }

  // live clocks without re-rendering
  setInterval(() => {
    doc.querySelectorAll("[data-since]").forEach((el) => {
      el.textContent = dur(now() - Number(el.getAttribute("data-since")))
    })
    doc.querySelectorAll("time[data-ago]").forEach((el) => {
      el.textContent = ago(Number(el.getAttribute("data-ago")))
    })
  }, 1000)

  // ── actions ──
  function toast(text, kind) {
    const el = doc.createElement("div")
    el.className = `toast${kind ? ` ${kind}` : ""}`
    el.innerHTML = `${kind === "err" ? icon("alert", "sm") : icon("ok", "sm")}<span>${esc(text)}</span>`
    $("toasts").appendChild(el)
    setTimeout(
      () => {
        el.remove()
      },
      kind === "err" ? 6000 : 3200,
    )
  }
  function copy(text) {
    const done = () => {
      toast("Copied")
    }
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done, fallback)
    fallback()
    function fallback() {
      const ta = doc.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      doc.body.appendChild(ta)
      ta.select()
      try {
        doc.execCommand("copy")
        done()
      } catch (_e) {
        toast("Couldn't copy", "err")
      }
      ta.remove()
    }
  }
  function toggle(key) {
    const open =
      S.open.has(key) || (!S.shut.has(key) && key.indexOf("g:") === 0 && doc.querySelector(`[data-toggle="${key}"]`)?.parentElement?.classList.contains("open"))
    if (open) {
      S.open.delete(key)
      S.shut.add(key)
    } else {
      S.shut.delete(key)
      S.open.add(key)
    }
    store.set("open", Array.from(S.open).slice(-300))
    render()
  }
  function respond(item, decision) {
    act("/api/respond", { agentId: item.agentId, requestId: item.requestId, decision: decision }, decision === "deny" ? "Denied" : "Allowed")
  }
  function merge(id) {
    const a = agentById(id)
    act("/api/merge", { agentId: id }).then((r) => {
      if (r) toast(`${a ? `${a.name}: ` : ""}merge ${r.status}${r.detail ? ` — ${r.detail}` : ""}`, r.status === "merged" || r.status === "queued" ? "" : "err")
    })
  }
  function submit(text) {
    return act("/api/submit", { text: text }, (r) => r.output || `Sent to ${r.routedTo?.length ? r.routedTo.join(", ") : "the lead"}`)
  }
  function dialog(opts) {
    const layer = $("layer")
    layer.innerHTML =
      '<div class="scrim"><form class="dlg"><h3>' +
      opts.title +
      "</h3><p>" +
      (opts.body || "") +
      "</p>" +
      (opts.input != null ? `<input class="field" name="v" autocomplete="off" placeholder="${esc(opts.placeholder || "")}" value="${esc(opts.input)}">` : "") +
      '<div class="acts">' +
      (opts.cancel === false ? "" : `<button class="btn ghost" type="button" data-x>${esc(opts.cancel || "Cancel")}</button>`) +
      '<button class="btn ' +
      (opts.danger ? "bad" : "pri") +
      '" type="submit">' +
      esc(opts.ok || "OK") +
      "</button></div></form></div>"
    const f = layer.querySelector("form")
    const close = () => {
      layer.innerHTML = ""
    }
    f.onsubmit = (e) => {
      e.preventDefault()
      const v = f.v ? f.v.value.trim() : ""
      close()
      opts.done(v)
    }
    layer.querySelector(".scrim").onclick = (e) => {
      if (e.target === e.currentTarget && opts.cancel !== false) close()
    }
    const x = layer.querySelector("[data-x]")
    if (x) x.onclick = close
    setTimeout(() => {
      ;(f.v || f.querySelector("[type=submit]")).focus()
    }, 20)
  }
  function setAutonomy(mode) {
    const run = () => {
      act("/api/autonomy", { mode: mode }, `Autonomy: ${mode}`)
    }
    if (mode === "yolo")
      dialog({
        title: "Switch to YOLO?",
        body: "Every agent acts without asking and without a sandbox until you switch back.",
        ok: "Switch to YOLO",
        danger: true,
        done: run,
      })
    else run()
  }
  function stopAgent(id) {
    const a = agentById(id)
    if (!a) return
    dialog({
      title: `Stop ${esc(a.name)}?`,
      body: "It stops working. Unmerged changes stay in its worktree.",
      ok: "Stop agent",
      danger: true,
      done: () => {
        submit(`/kill ${a.name}`)
      },
    })
  }

  doc.addEventListener("click", (e) => {
    const t = e.target.closest("button, a, [data-agent], [data-go]")
    if (!t) return
    const d = t.dataset
    if (d.toggle) return toggle(d.toggle)
    if (t.hasAttribute("data-coord")) {
      e.preventDefault()
      S.coord = true
      store.set("coord", true)
      toast("Showing coordination calls · hide them from the command menu")
      return render()
    }
    if (d.copyPre !== undefined) return copy(t.closest("pre").querySelector("code").textContent)
    if (d.copy) {
      const tool = Object.values(S.feeds)
        .flat()
        .find((x) => x.id === d.copy)
      return tool && copy(tool.output || "")
    }
    if (d.go) return go(d.go)
    if (d.mode) return setAutonomy(d.mode)
    if (d.filter) {
      S.filter = d.filter
      store.set("filter", d.filter)
      return render()
    }
    if (d.merge) return merge(d.merge)
    if (d.int) return act("/api/interrupt", { agentId: d.int }, "Interrupted")
    if (d.kill) return stopAgent(d.kill)
    if (d.cmd) {
      $("text").value = d.cmd
      return $("text").focus()
    }
    if (t.hasAttribute("data-palette")) return palette()
    if (t.hasAttribute("data-dismiss-all"))
      return dismiss(
        inbox()
          .map((x) => x.a)
          .filter((a) => DISMISSABLE[a.kind]),
      )
    if (t.hasAttribute("data-restore")) {
      S.dismissed.clear()
      store.set("dismissed", [])
      return render()
    }
    if (t.hasAttribute("data-menu")) {
      S.menu = !S.menu
      return render()
    }
    if (t.hasAttribute("data-details")) {
      S.details = !S.details
      return render()
    }
    if (d.a) {
      const item = S.view.attention[Number(d.i)]
      if (!item) return
      if (d.a === "open") return go("agent", item.agentId)
      if (d.a === "dismiss") return dismiss([item])
      if (d.a === "merge") return merge(item.agentId)
      if (d.a === "plan-ok") return act("/api/plan", { approve: true }, "Plan approved")
      if (d.a === "plan-no")
        return dialog({
          title: "Reject the plan",
          body: "Tell the lead what to change (optional).",
          input: "",
          placeholder: "e.g. split the API work into two tasks",
          ok: "Reject plan",
          danger: true,
          done: (why) => {
            act("/api/plan", { approve: false, notes: why || undefined }, "Plan rejected")
          },
        })
      return respond(item, d.a)
    }
    if (d.agent) return go(d.agent === S.view.lead?.id ? "lead" : "agent", d.agent === S.view.lead?.id ? "" : d.agent)
  })
  $("scroll").addEventListener("scroll", () => {
    const sc = $("scroll")
    const a = S.route.name === "agent" || S.route.name === "lead"
    $("jump").hidden = !a || S.details || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 200
  })
  $("jump").onclick = () => {
    $("scroll").scrollTop = 1e9
  }

  // ── composer ──
  const COMMANDS = [
    ["/spawn", "start agents — /spawn codex 2"],
    ["/kill", "stop an agent"],
    ["/interrupt", "interrupt an agent (or all)"],
    ["/merge", "merge an agent's work"],
    ["/review", "ask another agent to review"],
    ["/diff", "show an agent's changes"],
    ["/undo", "undo the last merge"],
    ["/sync", "bring an agent up to date with the project"],
    ["/plan", "show the plan"],
    ["/approve", "approve the plan"],
    ["/deny", "reject the plan"],
    ["/autonomy", "normal · auto · yolo · ask"],
    ["/model", "set an agent's model"],
    ["/rename", "rename an agent"],
    ["/label", "label an agent"],
    ["/team", "start a team"],
    ["/recipe", "run a recipe"],
    ["/issue", "work on a GitHub issue"],
    ["/pr", "open a pull request from what was merged"],
    ["/notes", "team notes"],
    ["/agents", "list agents"],
  ]
  const text = $("text")
  function grow() {
    text.style.height = "auto"
    text.style.height = `${Math.min(text.scrollHeight, 220)}px`
  }
  function suggestions() {
    const v = text.value.slice(0, text.selectionStart)
    const at = /(^|\s)@([\w.-]*)$/.exec(v)
    if (at && S.view) {
      const q = at[2].toLowerCase()
      return {
        from: v.length - at[2].length - 1,
        list: ["all"]
          .concat(agentsAll().map((a) => (a.lead ? "lead" : a.name)))
          .filter((n) => n.toLowerCase().indexOf(q) === 0)
          .slice(0, 8)
          .map((n) => {
            const a = agentsAll().find((x) => x.name === n || (n === "lead" && x.lead))
            return [`@${n}`, n === "all" ? "everyone working" : a ? `${statusText(a)} · ${a.model || a.adapter}` : ""]
          }),
      }
    }
    const sl = /^\/([\w-]*)$/.exec(v)
    if (sl) {
      return {
        from: 0,
        list: COMMANDS.filter((c) => c[0].indexOf(`/${sl[1]}`) === 0).slice(0, 10),
      }
    }
    return null
  }
  function showSuggest() {
    const s = suggestions()
    S.sugg = s?.list.length ? { from: s.from, list: s.list, i: 0 } : null
    drawSuggest()
  }
  function drawSuggest() {
    const box = $("suggest")
    if (!S.sugg) {
      box.hidden = true
      return
    }
    box.hidden = false
    box.innerHTML = S.sugg.list
      .map((x, i) => `<div class="sg${i === S.sugg.i ? " on" : ""}" data-sg="${i}"><b>${esc(x[0])}</b><span>${esc(x[1])}</span></div>`)
      .join("")
  }
  function accept(i) {
    const s = S.sugg
    if (!s) return
    const pick = s.list[i][0]
    const before = text.value.slice(0, s.from)
    const after = text.value.slice(text.selectionStart)
    text.value = `${before + pick} ${after.replace(/^\S*/, "")}`
    const pos = `${before + pick} `.length
    text.setSelectionRange(pos, pos)
    S.sugg = null
    drawSuggest()
    text.focus()
  }
  $("suggest").addEventListener("mousedown", (e) => {
    const el = e.target.closest("[data-sg]")
    if (!el) return
    e.preventDefault()
    accept(Number(el.getAttribute("data-sg")))
  })
  text.addEventListener("input", () => {
    grow()
    showSuggest()
    target()
    S.hist = -1
  })
  text.addEventListener("keydown", (e) => {
    if (S.sugg) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        S.sugg.i = (S.sugg.i + (e.key === "ArrowDown" ? 1 : S.sugg.list.length - 1)) % S.sugg.list.length
        return drawSuggest()
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault()
        return accept(S.sugg.i)
      }
      if (e.key === "Escape") {
        S.sugg = null
        return drawSuggest()
      }
    }
    // earlier messages, like a shell
    if (e.key === "ArrowUp" && !text.value.slice(0, text.selectionStart).includes("\n") && (S.hist >= 0 || !text.value)) {
      if (S.hist + 1 < S.sent.length) {
        e.preventDefault()
        S.hist++
        text.value = S.sent[S.sent.length - 1 - S.hist]
        grow()
      }
      return
    }
    if (e.key === "ArrowDown" && S.hist >= 0) {
      e.preventDefault()
      S.hist--
      text.value = S.hist >= 0 ? S.sent[S.sent.length - 1 - S.hist] : ""
      grow()
      return
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !("ontouchstart" in window && window.innerWidth < 820)) {
      e.preventDefault()
      $("composer").requestSubmit()
    }
    if (e.key === "Escape") text.blur()
  })
  text.addEventListener("blur", () => {
    setTimeout(() => {
      S.sugg = null
      drawSuggest()
    }, 120)
  })
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault()
    const t = text.value.trim()
    if (!t) return
    const a = S.route.name === "agent" ? agentById(S.route.id) : null
    // on an agent's page, plain text goes to that agent
    const send = a && t[0] !== "@" && t[0] !== "/" ? `@${a.name} ${t}` : t
    S.sent = S.sent
      .filter((x) => x !== t)
      .concat([t])
      .slice(-50)
    store.set("sent", S.sent)
    S.hist = -1
    text.value = ""
    grow()
    submit(send)
    $("scroll").scrollTop = 1e9
  })

  // ── command palette ──
  function paletteItems() {
    const v = S.view
    const items = [
      [
        "Go to",
        "Inbox",
        "inbox",
        () => {
          go("inbox")
        },
        "I",
      ],
      [
        "Go to",
        "Lead",
        "lead",
        () => {
          go("lead")
        },
        "L",
      ],
      [
        "Go to",
        "Agents",
        "agents",
        () => {
          go("agents")
        },
        "A",
      ],
      [
        "Go to",
        "Activity",
        "activity",
        () => {
          go("activity")
        },
        "T",
      ],
      [
        "Go to",
        "Changes",
        "changes",
        () => {
          go("changes")
        },
        "C",
      ],
    ]
    if (v)
      v.agents.forEach((a) => {
        items.push([
          "Agents",
          `${a.name} — ${statusText(a)}`,
          "agents",
          () => {
            go("agent", a.id)
          },
          a.model || a.adapter,
        ])
        if (a.workspace?.files.length && a.workspace.mode === "worktree")
          items.push([
            "Actions",
            `Merge ${a.name}`,
            "merge",
            () => {
              merge(a.id)
            },
            `+${a.workspace.added} −${a.workspace.removed}`,
          ])
        if (a.status === "busy")
          items.push([
            "Actions",
            `Interrupt ${a.name}`,
            "stop",
            () => {
              act("/api/interrupt", { agentId: a.id }, `Interrupted ${a.name}`)
            },
            "",
          ])
      })
    LEVELS.forEach((l) => {
      items.push([
        "Autonomy",
        `Autonomy: ${l[1]}`,
        "bolt",
        () => {
          setAutonomy(l[0])
        },
        l[2],
      ])
    })
    items.push([
      "View",
      `${S.coord ? "Hide" : "Show"} coordination calls`,
      "eye",
      () => {
        S.coord = !S.coord
        store.set("coord", S.coord)
        render()
      },
      "messages, waits and merges between agents",
    ])
    items.push([
      "View",
      "Expand everything here",
      "chev",
      () => {
        doc.querySelectorAll("#content [data-toggle]").forEach((b) => {
          S.open.add(b.dataset.toggle)
          S.shut.delete(b.dataset.toggle)
        })
        render()
      },
      "",
    ])
    items.push([
      "View",
      "Collapse everything",
      "chev",
      () => {
        S.open.clear()
        store.set("open", [])
        render()
      },
      "",
    ])
    items.push(["You", `Change your name (${S.me || "web"})`, "agents", askName, "shown to others watching"])
    items.push([
      "You",
      "Copy this page's link",
      "link",
      () => {
        copy(`${location.origin}/#t=${token}`)
      },
      "it carries the access key",
    ])
    return items
  }
  function palette() {
    const layer = $("layer")
    const all = paletteItems()
    let sel = 0
    let shown = all
    layer.innerHTML =
      '<div class="scrim"><div class="pal"><input placeholder="Type a command, an agent, a view…" autocomplete="off"><div class="pal-l"></div></div></div>'
    const input = layer.querySelector("input")
    const list = layer.querySelector(".pal-l")
    const close = () => {
      layer.innerHTML = ""
    }
    const draw = () => {
      const q = input.value.toLowerCase().trim()
      shown = all.filter((x) => {
        const hay = `${x[0]} ${x[1]} ${x[4]}`.toLowerCase()
        return q.split(/\s+/).every((w) => hay.indexOf(w) >= 0)
      })
      sel = Math.min(sel, Math.max(0, shown.length - 1))
      let g = ""
      list.innerHTML = shown.length
        ? shown
            .map((x, i) => {
              const head = x[0] !== g ? `<div class="pal-g">${esc(x[0])}</div>` : ""
              g = x[0]
              return `${head}<div class="pal-i${i === sel ? " on" : ""}" data-pi="${i}">${icon(x[2], "sm")}<span>${esc(x[1])}</span><small>${esc(x[4] || "")}</small></div>`
            })
            .join("")
        : '<div class="pal-g">Nothing matches</div>'
      const on = list.querySelector(".pal-i.on")
      if (on) on.scrollIntoView({ block: "nearest" })
    }
    const run = (i) => {
      const x = shown[i]
      close()
      if (x) x[3]()
    }
    input.addEventListener("input", () => {
      sel = 0
      draw()
    })
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        sel = (sel + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % Math.max(1, shown.length)
        draw()
      } else if (e.key === "Enter") {
        e.preventDefault()
        run(sel)
      } else if (e.key === "Escape") close()
    })
    list.addEventListener("click", (e) => {
      const el = e.target.closest("[data-pi]")
      if (el) run(Number(el.getAttribute("data-pi")))
    })
    layer.querySelector(".scrim").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) close()
    })
    draw()
    input.focus()
  }

  // ── keyboard ──
  doc.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault()
      if ($("layer").innerHTML) $("layer").innerHTML = ""
      else palette()
      return
    }
    if (e.key === "Escape" && $("layer").innerHTML) {
      $("layer").innerHTML = ""
      return
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(doc.activeElement?.tagName)
    if (typing || e.ctrlKey || e.metaKey || e.altKey || $("layer").innerHTML || !S.view) return
    const k = e.key.toLowerCase()
    const nav = { i: "inbox", l: "lead", a: "agents", t: "activity", c: "changes" }
    if (nav[k]) return go(nav[k])
    if (k === "/" || k === "m") {
      e.preventDefault()
      return text.focus()
    }
    if (S.route.name === "inbox" && (k === "y" || k === "n")) {
      const item = S.view.attention.find((a) => a.kind === "approval")
      if (item) respond(item, k === "y" ? "allow" : "deny")
    }
  })

  // ── who's watching ──
  function askName(then) {
    dialog({
      title: "What's your name?",
      body: "Others watching this run see it next to what you send and approve.",
      input: S.me || "",
      placeholder: "e.g. Sam",
      ok: "Continue",
      cancel: S.me ? "Cancel" : false,
      done: (v) => {
        S.me = (v || S.me || "web").slice(0, 40)
        store.set("name", S.me)
        if (typeof then === "function") then()
        else render()
      },
    })
  }

  // ── start ──
  render()
  if (S.me) connect()
  else askName(connect)
}
