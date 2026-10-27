# Remote access: phone, web, other agents

## The web view

```
baton web          # this machine only
baton web --lan    # reachable from your phone on the same network — scan the QR code
```

Or `/web` inside the TUI (press `l` there to allow your network, `c` to copy the link). You get one page
that works on a phone and on a big screen:

- **Inbox:** everything that needs you. Allow / Always allow / Deny for approvals (`Y` / `N` on a keyboard),
  Approve / Reject for plans, Merge for finished work. Problems (a crashed agent, a stuck one) can be dismissed
  one at a time or all at once; one that changes comes back.
- **Lead** and every **agent**: the conversation, readable. Tool calls are grouped ("3 commands · 1 edit"),
  each one says what it did (Run `npm test`, Edit `src/app.ts`) and opens to its output or diff. Thinking is
  folded, results agents send each other are cards (done or failed, lines changed, acceptance checks, work
  waiting to be merged), and Baton's own coordination calls are hidden until you ask for them. A line at the
  end shows what a working agent is doing right now.
- **Agents:** cards with status, current step, progress, changes and cost; filter by working / needs you /
  idle / stopped. An agent's page has Message, Interrupt, Merge and Stop.
- **Activity:** the plan with its progress, and what agents tell each other, newest first.
- **Changes:** every worktree with unmerged work, its files and a Merge button.
- **The autonomy switch** (normal · auto · YOLO · ask) and an input for tasks, `@agent` messages and `/commands`,
  with suggestions as you type (`@` for agents, `/` for commands, ↑ for earlier messages).
- **Ctrl K** opens a command menu (go to any view or agent, merge, interrupt, switch autonomy, show coordination
  calls). Single keys: `I` inbox, `L` lead, `A` agents, `T` activity, `C` changes, `/` to type.

On a desktop the run's details sit on the right (an agent's model, cost, files and conflicts; otherwise totals,
the plan and what's waiting to be merged). On a phone the views are tabs at the bottom.

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
