# Remote access: phone, web, other agents

## The web view

```
baton web          # this machine only
baton web --lan    # reachable from your phone on the same network — scan the QR code
```

Or `/web` inside the TUI (press `l` there to allow your network, `c` to copy the link). You get a mobile-first page with:

- **Inbox:** everything that needs you, with Allow / Always / Deny for approvals, Approve / Reject for plans and
  Merge for finished work.
- **Lead:** the orchestrator's thread, including the agents' messages to each other.
- **Agents:** every worker with its status, cost and unmerged changes. Tap one for its activity, then
  Message / Interrupt / Merge.
- **The autonomy dial** (normal · auto · YOLO · ask) and an input for tasks, `@agent` messages and `/commands`.

It updates live and keeps running inside the daemon after the command exits; `baton web --stop` turns it off.
`[remote] autostart = true` starts it with the daemon, and `port = 4777` keeps the address stable for
bookmarks.

**Security.**
- Off by default and bound to 127.0.0.1 unless you ask for `--lan`.
- Every API call needs the project's access token. The printed link carries it in the URL *fragment*, which
  browsers never send to a server; the page then keeps it in local storage.
- `baton web --rotate` makes a new token and invalidates old links.
- Requests must address the server by IP, `localhost`, this machine's name, its Tailscale name or `remote.public_url`.
  Other host names get `421`, so a web page can't reach the server through DNS rebinding.
- Encryption: `--https` serves it with a certificate Baton creates for this machine (your phone asks you to trust it
  once; `baton web` prints its SHA-256 fingerprint to compare), and `--tailscale` publishes it with
  `tailscale serve` on your tailnet name with a real certificate, reachable wherever you're signed in to Tailscale
  (`[remote] tls = "self-signed"` / `tailscale = true` make either the default). Without them it's plain HTTP:
  fine on your own machine, use `--lan` only on networks you trust.
- A repository's config can't turn remote access on for you: `remote.lan`, `remote.autostart` and
  `remote.public_url` from project config need `baton trust`.

## Approve from a notification

With a webhook set to [ntfy](https://ntfy.sh) (`notify.webhook = "https://ntfy.sh/<topic>"`,
`notify.webhook_format = "ntfy"`), approval notifications get **Allow** and **Deny** buttons. Slack messages get
links. They work when your phone can reach the web view: either `baton web --lan` on the same network, or
`remote.public_url` set to how the phone reaches this machine (for example a Tailscale address).

Each button is a link signed for that one request. It carries no token, and the signature only allows that
answer to that question. Opening such a link in a browser (or a chat app's link preview) only shows a confirm
button: nothing is approved without a POST.

## Baton as an MCP server

`baton mcp` serves Baton over MCP (stdio), so another agent or app can hand work to your Baton team:

```
claude mcp add baton -- baton mcp --root /path/to/project
```

| Tool | |
|---|---|
| `run_task` | give the lead a task; waits until the team is done or needs a decision, then reports |
| `status` · `wait` | agents, unmerged changes, everything that needs a decision |
| `answer` | allow / always / deny a pending approval |
| `diff` · `merge` | review and land an agent's changes |
| `message` · `interrupt` · `set_autonomy` | steer the team |

## Sharing a run

`baton export <run> --format html` (or `h` in the history screen, `ctrl+r`) writes the whole run as one
self-contained page: a summary, then every agent's messages, tool calls (with diffs), bus traffic, reviews and
merges on one timeline. No scripts or external assets, so it can be attached or hosted anywhere.
