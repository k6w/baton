#!/usr/bin/env python3
"""
Record `baton demo` into an asciinema v2 cast (then render it with agg → docs/assets/demo.gif).

  bun run build && python3 scripts/record-demo.py dist/demo.cast
  agg --theme github-dark --font-family "JetBrains Mono" --font-size 15 --idle-time-limit 2 dist/demo.cast docs/assets/demo.gif

Simulated agents only: no tokens, no network. The run uses a throwaway project and state folder,
so your own settings and history never show up in the recording.
"""
import codecs, fcntl, json, os, pty, re, select, shutil, signal, struct, sys, tempfile, termios, time

COLS, ROWS = 132, 38
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# the compiled binary (bun run build): running from source needs the repo's bunfig.toml in the cwd
BATON = [os.environ.get("BATON_BIN", os.path.join(ROOT, "dist", "baton"))]

ENTER, ESC, TAB, CTRL_A, SHIFT_TAB = "\r", "\x1b", "\t", "\x01", "\x1b[Z"

# (seconds after start, keys, type it character by character?)
SCRIPT = [
    (2.5, "fix the typo in the README and add a test", True),
    (5.2, ENTER, False),       # the lead plans and starts a team from four vendors
    (12.5, CTRL_A, False),     # the inbox: everything that needs you
    (15.0, "y", False),        # approve the waiting request
    (16.5, ESC, False),
    (18.0, TAB, False),        # focus the agents
    (19.5, "l", False),
    (21.0, "z", False),        # zoom into one
    (25.5, ESC, False),        # close the zoom
    (26.5, ESC, False),        # back to the input
    (28.0, SHIFT_TAB, False),  # the autonomy dial: normal → auto → yolo → ask
    (30.0, SHIFT_TAB, False),
    (32.0, SHIFT_TAB, False),
    (34.0, SHIFT_TAB, False),
]
END = 40.0


def main(out: str) -> None:
    work = tempfile.mkdtemp(prefix="baton-rec-")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("BATON_", "CLAUDE", "CODEX"))}
    env.update(
        TERM="xterm-256color",
        COLORTERM="truecolor",
        HOME=work,
        XDG_CONFIG_HOME=os.path.join(work, "config"),
        XDG_STATE_HOME=os.path.join(work, "state"),
        BATON_NO_WELCOME="1",
        BATON_NO_IMAGES="1",
        BATON_THEME=os.environ.get("DEMO_THEME", "github-dark"),
        BATON_ICONS="unicode",
        BATON_USER="you",
    )
    project = os.path.join(work, "my-app")
    os.makedirs(project)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(project)
        os.execvpe(BATON[0], BATON + ["demo", "--no-task", "--workers", "4", "--speed", "1"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    events, start, todo = [], time.time(), list(SCRIPT)
    # the script's clock starts when the app is on screen (startup time varies)
    ready, seen = None, ""
    # reads can split a multi-byte character: decode incrementally
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    while True:
        now = time.time() - start
        since = time.time() - ready if ready else -1
        if ready and since > END:
            break
        if now > 30 and not ready:
            sys.exit("baton never showed its input — is dist/baton built?")
        while ready and todo and todo[0][0] <= since:
            _, keys, typed = todo.pop(0)
            if typed:
                for ch in keys:
                    os.write(fd, ch.encode())
                    time.sleep(0.045)
            else:
                os.write(fd, keys.encode())
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            text = decoder.decode(data)
            if not ready:
                seen = (seen + re.sub(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]", "", text))[-8000:]
                if "@agent" in seen:
                    ready = time.time()
            if text:
                events.append([round(time.time() - start, 4), "o", text])
    os.kill(pid, signal.SIGTERM)
    time.sleep(0.5)
    with open(out, "w") as f:
        f.write(json.dumps({"version": 2, "width": COLS, "height": ROWS, "env": {"TERM": "xterm-256color"}}) + "\n")
        # start the recording at the first full frame (no blank terminal while the app boots)
        shift = (ready - start) if ready else 0
        for t, kind, text in events:
            f.write(json.dumps([round(max(0.0, t - shift), 4), kind, text]) + "\n")
    shutil.rmtree(work, ignore_errors=True)
    print(f"{out}: {len(events)} chunks, {events[-1][0] if events else 0:.1f}s")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "dist/demo.cast")
