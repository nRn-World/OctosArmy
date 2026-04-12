from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

from octosync.config import Settings

_FORBIDDEN_ARG_SUBSTRINGS = re.compile(r"[`;&|\n\r<>$]")


def _argv_strings_clean(argv: list[str]) -> bool:
    if not argv:
        return False
    for a in argv:
        if not isinstance(a, str) or not a.strip():
            return False
        if _FORBIDDEN_ARG_SUBSTRINGS.search(a):
            return False
    return True


def _allowlisted_argv(argv: list[str]) -> bool:
    if len(argv) < 1:
        return False
    head = argv[0].lower()
    if head in ("python", "python3", "py"):
        if len(argv) == 2 and argv[1] == "--version":
            return True
        if len(argv) >= 3 and argv[1] == "-m":
            mod = argv[2]
            if mod in ("pytest", "compileall"):
                if any(x == "-c" for x in argv):
                    return False
                return True
        return False
    if head == "git" and len(argv) >= 2:
        sub = argv[1].lower()
        if sub in ("status", "diff", "log", "rev-parse"):
            blocked_tokens = {"fetch", "pull", "push", "remote", "clone"}
            lowered = {a.lower() for a in argv}
            if lowered & blocked_tokens:
                return False
            return True
    return False


def run_terminal(settings: Settings, cwd: Path, argv: list[str]) -> tuple[int, str, str]:
    """
    Run argv with shell=False; cwd is forced to the sandbox root.
    Returns (exit_code, stdout, stderr) truncated to max_terminal_output_chars.
    """
    if not _argv_strings_clean(argv):
        raise PermissionError(
            "Terminal: disallowed characters in arguments or empty arguments."
        )
    if not _allowlisted_argv(argv):
        raise PermissionError(
            "Terminal: command is not on the allowlist. "
            "Allowed: python --version; python -m pytest ...; python -m compileall ...; "
            "git status|diff|log|rev-parse."
        )
    resolved_cwd = cwd.resolve()
    if str(resolved_cwd) != str(Path(settings.sandbox_root).resolve()):
        raise PermissionError("Terminal: cwd must be the sandbox root.")

    exec_argv = list(argv)
    head_l = exec_argv[0].lower()
    if head_l in ("python", "python3", "py"):
        exec_argv = [sys.executable, *exec_argv[1:]]
    elif head_l == "git":
        git_bin = shutil.which("git")
        if not git_bin:
            raise FileNotFoundError("git was not found on PATH.")
        exec_argv = [git_bin, *exec_argv[1:]]

    max_chars = settings.max_terminal_output_chars
    try:
        proc = subprocess.run(
            exec_argv,
            cwd=str(resolved_cwd),
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=settings.terminal_timeout_sec,
        )
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or "")[:max_chars]
        err = (e.stderr or "")[:max_chars]
        err = err + "\n[timeout]"
        return 124, out, err

    out = (proc.stdout or "")[:max_chars]
    err = (proc.stderr or "")[:max_chars]
    return proc.returncode, out, err
