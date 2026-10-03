"""Project root and socket discovery (mirrors @batonsh/kernel findProjectRoot / projectPaths)."""

import os
from typing import Dict, Optional


def find_project_root(start: Optional[str] = None) -> str:
    """Walk up from ``start`` looking for ``.baton/config.toml``, then ``.git``; falls back to ``start``."""
    begin = os.path.abspath(start if start is not None else os.getcwd())
    d = begin
    git_root = None
    while True:
        if os.path.exists(os.path.join(d, ".baton", "config.toml")):
            return d
        if git_root is None and os.path.exists(os.path.join(d, ".git")):
            git_root = d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return git_root if git_root is not None else begin


def project_paths(root: str) -> Dict[str, str]:
    d = os.path.join(root, ".baton")
    run = os.path.join(d, "run")
    return {
        "dir": d,
        "config": os.path.join(d, "config.toml"),
        "state": os.path.join(d, "state.db"),
        "run": run,
        "socket": os.path.join(run, "baton.sock"),
        "pid_file": os.path.join(run, "batond.pid"),
        "log": os.path.join(run, "batond.log"),
        "worktrees": os.path.join(d, "worktrees"),
    }


def discover_socket(project_root: str) -> str:
    """The daemon's socket: ``.baton/run/socket-path`` (long project paths) or ``.baton/run/baton.sock``."""
    paths = project_paths(project_root)
    alt = os.path.join(paths["run"], "socket-path")
    try:
        with open(alt, "r", encoding="utf-8") as f:
            p = f.read().strip()
        if p:
            return p
    except OSError:
        pass
    return paths["socket"]
