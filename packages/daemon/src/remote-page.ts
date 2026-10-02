/**
 * The remote web app: one self-contained page (no external assets) — mobile first, dark/light
 * following the device. Talks to /api/* with the token from the URL fragment.
 * A plain template (not String.raw): Bun escapes non-ASCII characters in raw templates.
 */
export const REMOTE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0f1117">
<title>Baton</title>
<style>
:root {
  --bg: #0f1117; --panel: #171a22; --raised: #1f2330; --line: #2a2f3d; --text: #e6e8ee; --muted: #9aa3b2; --subtle: #6b7385;
  --primary: #e8774e; --accent: #7aa2f7; --ok: #8bd17c; --warn: #e6c15a; --err: #f07178; --info: #6fc3df;
  --radius: 12px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f6f7f9; --panel: #ffffff; --raised: #eef0f4; --line: #dfe3ea; --text: #1d2230; --muted: #5b6475; --subtle: #8a93a5;
    --primary: #c95a32; --accent: #3d6fd6; --ok: #2f8a3a; --warn: #a77b00; --err: #c8333d; --info: #1f7f9e; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
body { padding-bottom: calc(76px + env(safe-area-inset-bottom)); }
header { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--line); padding: 10px 14px 0; padding-top: calc(10px + env(safe-area-inset-top)); }
.top { display: flex; align-items: center; gap: 10px; }
.logo { font-weight: 800; letter-spacing: .5px; color: var(--primary); }
.proj { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--subtle); flex: none; }
.dot.on { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.auto { display: flex; gap: 4px; margin: 10px 0 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 3px; }
.auto button { flex: 1; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 13px; padding: 6px 0; border-radius: 999px; }
.auto button.sel { background: var(--raised); color: var(--text); font-weight: 600; }
.auto button.sel.yolo { background: var(--err); color: #fff; }
.auto button.sel.auto { background: color-mix(in srgb, var(--warn) 30%, var(--raised)); }
.tabs { display: flex; gap: 18px; }
.tabs button { border: 0; background: none; color: var(--muted); font: inherit; font-weight: 600; padding: 8px 0 10px; border-bottom: 2px solid transparent; }
.tabs button.sel { color: var(--text); border-color: var(--primary); }
.badge { display: inline-block; min-width: 18px; padding: 0 6px; margin-left: 4px; border-radius: 999px; background: var(--warn); color: #111; font-size: 12px; text-align: center; }
main { padding: 12px 12px 0; max-width: 820px; margin: 0 auto; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin-bottom: 10px; }
.card h3 { margin: 0 0 4px; font-size: 15px; }
.kind { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: var(--warn); }
.kind.failed, .kind.merge, .kind.budget { color: var(--err); } .kind.ready { color: var(--ok); }
.meta { color: var(--muted); font-size: 13px; }
pre { font: 12.5px/1.4 var(--mono); white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; color: var(--muted); max-height: 260px; overflow: auto; }
.row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.btn { border: 1px solid var(--line); background: var(--raised); color: var(--text); font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 10px; }
.btn.ok { background: var(--ok); border-color: var(--ok); color: #0b1a0b; } .btn.no { color: var(--err); } .btn.pri { background: var(--accent); border-color: var(--accent); color: #fff; }
.empty { text-align: center; color: var(--subtle); padding: 48px 12px; }
.feed .it { padding: 6px 0; border-bottom: 1px dashed color-mix(in srgb, var(--line) 60%, transparent); }
.feed .it:last-child { border-bottom: 0; }
.who { font-weight: 700; } .you { color: var(--accent); } .lead { color: var(--primary); }
.tool { font: 13px/1.4 var(--mono); color: var(--text); }
.tool .st { display: inline-block; width: 1.2em; } .st.completed { color: var(--ok); } .st.failed { color: var(--err); } .st.in_progress, .st.pending { color: var(--warn); }
.diff { font: 12px/1.35 var(--mono); margin-top: 4px; border-radius: 8px; overflow: hidden; }
.diff div { padding: 0 6px; white-space: pre-wrap; word-break: break-all; }
.diff .a { background: color-mix(in srgb, var(--ok) 18%, transparent); } .diff .d { background: color-mix(in srgb, var(--err) 18%, transparent); }
.bus { color: var(--muted); font-size: 13px; } .bus b { color: var(--info); font-weight: 600; }
.thought { color: var(--subtle); font-style: italic; }
.err { color: var(--err); } .note { color: var(--warn); font-size: 13px; }
.agents .card { cursor: pointer; }
.ahead { display: flex; align-items: center; gap: 8px; }
.ahead .name { font-weight: 700; } .ahead .ad { color: var(--subtle); font-size: 13px; }
.status { margin-left: auto; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--raised); color: var(--muted); }
.status.busy { color: var(--warn); } .status.awaiting_approval { background: var(--warn); color: #111; } .status.error { color: var(--err); } .status.ready { color: var(--ok); }
.bar { height: 4px; border-radius: 4px; background: var(--raised); margin-top: 8px; overflow: hidden; } .bar i { display: block; height: 100%; background: var(--accent); }
.composer { position: fixed; left: 0; right: 0; bottom: 0; background: var(--panel); border-top: 1px solid var(--line);
  padding: 10px 12px; padding-bottom: calc(10px + env(safe-area-inset-bottom)); display: flex; gap: 8px; z-index: 6; }
.composer textarea { flex: 1; resize: none; height: 44px; max-height: 140px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg);
  color: var(--text); font: inherit; padding: 10px 12px; }
.composer button { border: 0; border-radius: 12px; background: var(--primary); color: #fff; font-weight: 700; padding: 0 18px; }
.sheet-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.back { border: 0; background: none; color: var(--accent); font: inherit; font-weight: 600; padding: 4px 0; }
.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(86px + env(safe-area-inset-bottom)); background: var(--raised); color: var(--text);
  border: 1px solid var(--line); padding: 8px 14px; border-radius: 10px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 9; max-width: 90vw; }
.toast.show { opacity: 1; }
.login { max-width: 420px; margin: 18vh auto; text-align: center; color: var(--muted); padding: 0 20px; }
</style>
</head>
<body>
<header>
  <div class="top"><span class="logo">baton</span><span class="proj" id="proj">connecting…</span><span class="dot" id="dot"></span></div>
  <div class="auto" id="auto"></div>
  <nav class="tabs" id="tabs"></nav>
</header>
<main id="main"></main>
<form class="composer" id="composer">
  <textarea id="text" placeholder="Task, @agent or /command" rows="1"></textarea>
  <button type="submit">Send</button>
</form>
<div class="toast" id="toast"></div>
<script>
(function () {
  var KEY = "baton-token:" + location.host;
  var m = /[#&]t=([^&]+)/.exec(location.hash);
  if (m) { try { localStorage.setItem(KEY, m[1]); } catch (e) {} history.replaceState(null, "", location.pathname); }
  var token = m ? m[1] : (function () { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } })();
  var view = null, tab = "inbox", agent = null;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var money = function (n) { return n ? "$" + n.toFixed(2) : ""; };

  if (!token) {
    document.querySelector("header").style.display = "none"; $("composer").style.display = "none";
    $("main").innerHTML = '<div class="login"><h2>Baton</h2><p>Open the link printed by <b>baton web</b> (or scan its QR code) — it carries the access token.</p></div>';
    return;
  }

  function toast(t) { var el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove("show"); }, 2600); }
  function api(path, body) {
    return fetch(path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  function act(path, body, msg) { return api(path, body).then(function (r) { if (msg) toast(msg); return r; }, function (e) { toast("⚠ " + e.message); }); }

  var LEVELS = [["normal", "◆ normal"], ["auto", "⚡ auto"], ["yolo", "⚠ YOLO"], ["ask", "◇ ask"]];
  function renderAuto() {
    $("auto").innerHTML = LEVELS.map(function (l) {
      var sel = view && view.autonomy === l[0];
      return '<button data-mode="' + l[0] + '" class="' + (sel ? "sel " + l[0] : "") + '">' + l[1] + "</button>";
    }).join("");
  }
  $("auto").onclick = function (e) {
    var b = e.target.closest("button"); if (!b) return;
    var mode = b.getAttribute("data-mode");
    if (mode === "yolo" && !confirm("YOLO: every agent acts without asking and without a sandbox. Continue?")) return;
    act("/api/autonomy", { mode: mode }, "autonomy: " + mode);
  };

  function renderTabs() {
    var n = view ? view.attention.filter(function (a) { return a.kind !== "ready"; }).length : 0;
    var tabs = [["inbox", "Inbox" + (n ? '<span class="badge">' + n + "</span>" : "")], ["lead", "Lead"], ["agents", "Agents" + (view && view.agents.length ? " · " + view.agents.length : "")]];
    $("tabs").innerHTML = tabs.map(function (t) { return '<button data-tab="' + t[0] + '" class="' + (tab === t[0] && !agent ? "sel" : "") + '">' + t[1] + "</button>"; }).join("");
  }
  $("tabs").onclick = function (e) { var b = e.target.closest("button"); if (!b) return; tab = b.getAttribute("data-tab"); agent = null; render(); window.scrollTo(0, 0); };

  function itemHtml(it) {
    if (it.k === "user") return '<div class="it"><span class="who you">' + esc(it.from || "you") + "</span> " + esc(it.text) + "</div>";
    if (it.k === "text") return '<div class="it ' + (it.role === "thought" ? "thought" : "") + '">' + esc(it.text) + "</div>";
    if (it.k === "bus") return '<div class="it bus"><b>' + esc(it.from) + "</b> → <b>" + esc(it.to) + "</b> " + esc(it.body) + "</div>";
    if (it.k === "error") return '<div class="it err">✗ ' + esc(it.text) + "</div>";
    if (it.k === "note" || it.k === "ask") return '<div class="it note">' + (it.k === "ask" ? "? " : "") + esc(it.text) + "</div>";
    if (it.k === "tool") {
      var icon = it.status === "completed" ? "✓" : it.status === "failed" ? "✗" : "●";
      var h = '<div class="it tool"><span class="st ' + it.status + '">' + icon + "</span>" + esc(it.title) + (it.summary ? ' <span class="meta">' + esc(it.summary) + "</span>" : "");
      (it.diffs || []).forEach(function (d) {
        h += '<div class="meta">' + esc(d.path) + " +" + d.added + " −" + d.removed + '</div><div class="diff">' +
          d.lines.map(function (l) { return '<div class="' + (l[0] === "+" ? "a" : "d") + '">' + esc(l) + "</div>"; }).join("") + "</div>";
      });
      if (it.output && !(it.diffs || []).length) h += "<pre>" + esc(it.output) + "</pre>";
      return h + "</div>";
    }
    return "";
  }

  function inbox() {
    var items = view.attention;
    if (!items.length) return '<div class="empty">All clear — nothing needs you right now.</div>';
    return items.map(function (a, i) {
      var buttons = "";
      if (a.kind === "approval") buttons = '<button class="btn ok" data-i="' + i + '" data-do="allow">Allow</button>' +
        (a.options || []).filter(function (o) { return o.kind === "allow_always"; }).map(function (o) { return '<button class="btn" data-i="' + i + '" data-do="' + esc(o.optionId) + '">Always</button>'; }).join("") +
        '<button class="btn no" data-i="' + i + '" data-do="deny">Deny</button>';
      else if (a.kind === "plan") buttons = '<button class="btn ok" data-i="' + i + '" data-do="plan-ok">Approve plan</button><button class="btn no" data-i="' + i + '" data-do="plan-no">Reject</button>';
      else if (a.kind === "ready") buttons = '<button class="btn pri" data-i="' + i + '" data-do="merge">Merge</button><button class="btn" data-i="' + i + '" data-do="open">Open</button>';
      else if (a.agentId) buttons = '<button class="btn" data-i="' + i + '" data-do="open">Open agent</button>';
      return '<div class="card"><div class="kind ' + a.kind + '">' + esc(a.kind) + (a.agent ? " · " + esc(a.agent) : "") + "</div><h3>" + esc(a.title) + "</h3>" +
        (a.detail ? "<pre>" + esc(a.detail) + "</pre>" : "") + (buttons ? '<div class="row">' + buttons + "</div>" : "") + "</div>";
    }).join("");
  }

  function lead() {
    if (!view.thread.length) return '<div class="empty">No activity yet. Send the lead a task below.</div>';
    return '<div class="card feed">' + view.thread.map(itemHtml).join("") + "</div>";
  }

  function agentsList() {
    if (!view.agents.length) return '<div class="empty">No agents yet. Try <b>/spawn codex 2</b> or give the lead a task.</div>';
    return '<div class="agents">' + view.agents.map(function (a) {
      var ws = a.workspace && a.workspace.files ? " · ⎇ " + a.workspace.files + " files +" + a.workspace.added + " −" + a.workspace.removed : "";
      return '<div class="card" data-agent="' + a.id + '"><div class="ahead"><span class="name">' + esc(a.name) + '</span><span class="ad">' + esc(a.adapter) + (a.model ? " · " + esc(a.model) : "") +
        '</span><span class="status ' + a.status + '">' + esc(a.status.replace("_", " ")) + "</span></div>" +
        '<div class="meta">' + esc(a.label || "") + (a.cost ? " · " + money(a.cost) : "") + ws + "</div>" +
        (a.progress != null ? '<div class="bar"><i style="width:' + Math.round(a.progress * 100) + '%"></i></div>' : "") + "</div>";
    }).join("") + "</div>";
  }

  function agentSheet(a) {
    var buttons = '<button class="btn" data-do="msg">Message</button><button class="btn no" data-do="int">Interrupt</button>' +
      (a.workspace && a.workspace.files ? '<button class="btn pri" data-do="merge">Merge</button>' : "");
    return '<div class="sheet-head"><button class="back" data-do="back">‹ Agents</button></div><div class="card"><div class="ahead"><span class="name">' + esc(a.name) +
      '</span><span class="ad">' + esc(a.adapter) + '</span><span class="status ' + a.status + '">' + esc(a.status.replace("_", " ")) + "</span></div>" +
      '<div class="meta">' + esc(a.label || "") + (a.detail ? " · " + esc(a.detail) : "") + '</div><div class="row">' + buttons + "</div></div>" +
      '<div class="card feed">' + (a.feed.length ? a.feed.map(itemHtml).join("") : '<div class="meta">nothing yet</div>') + "</div>";
  }

  function render() {
    if (!view) return;
    $("proj").textContent = view.project + (view.branch ? " @ " + view.branch : "") + (view.totals.costUsd ? " · " + money(view.totals.costUsd) : "");
    renderAuto(); renderTabs();
    var nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    var a = agent && view.agents.find(function (x) { return x.id === agent; });
    if (agent && !a) agent = null;
    $("main").innerHTML = a ? agentSheet(a) : tab === "inbox" ? inbox() : tab === "lead" ? lead() : agentsList();
    if ((tab === "lead" || a) && nearBottom) window.scrollTo(0, document.body.scrollHeight);
  }

  $("main").onclick = function (e) {
    var card = e.target.closest("[data-agent]");
    var b = e.target.closest("button");
    if (!b && card) { agent = card.getAttribute("data-agent"); render(); window.scrollTo(0, document.body.scrollHeight); return; }
    if (!b) return;
    var what = b.getAttribute("data-do");
    var it = view.attention[Number(b.getAttribute("data-i"))];
    var cur = agent && view.agents.find(function (x) { return x.id === agent; });
    if (what === "back") { agent = null; tab = "agents"; render(); return; }
    if (what === "msg" && cur) { $("text").value = "@" + cur.name + " "; $("text").focus(); return; }
    if (what === "int" && cur) return act("/api/interrupt", { agentId: cur.id }, "interrupted " + cur.name);
    if (what === "merge") { var id = cur ? cur.id : it.agentId; return act("/api/merge", { agentId: id }).then(function (r) { if (r) toast("merge: " + r.status + (r.detail ? " — " + r.detail : "")); }); }
    if (what === "open" && it && it.agentId) { agent = it.agentId; tab = "agents"; render(); return; }
    if (what === "plan-ok") return act("/api/plan", { approve: true }, "plan approved");
    if (what === "plan-no") { var why = prompt("Why? (sent to the lead)"); return act("/api/plan", { approve: false, notes: why || undefined }, "plan rejected"); }
    if (it && it.kind === "approval") return act("/api/respond", { agentId: it.agentId, requestId: it.requestId, decision: what }, what === "deny" ? "denied" : "allowed");
  };

  $("composer").onsubmit = function (e) {
    e.preventDefault();
    var t = $("text").value.trim(); if (!t) return;
    $("text").value = "";
    act("/api/submit", { text: t }).then(function (r) { if (r) toast(r.output || ("sent → " + (r.routedTo && r.routedTo.length ? r.routedTo.join(", ") : "lead"))); });
  };
  $("text").onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); $("composer").requestSubmit(); } };

  var backoff = 500;
  function connect() {
    fetch("/api/stream", { headers: { Authorization: "Bearer " + token } }).then(function (res) {
      if (res.status === 401) { try { localStorage.removeItem(KEY); } catch (e) {} $("main").innerHTML = '<div class="login">This link is no longer valid. Run <b>baton web</b> again for a fresh one.</div>'; return; }
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      $("dot").classList.add("on"); backoff = 500;
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) throw new Error("closed");
          buf += dec.decode(r.value, { stream: true });
          var i;
          while ((i = buf.indexOf("\\n")) >= 0) {
            var line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (line.trim()) { view = JSON.parse(line); render(); }
          }
          return pump();
        });
      })();
    }).catch(function () {
      $("dot").classList.remove("on");
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 8000);
    });
  }
  connect();
})();
</script>
</body>
</html>`
