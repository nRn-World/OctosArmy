from __future__ import annotations

from pathlib import Path

from octosync.config import Settings
from octosync.executor import run_terminal
from octosync.sandbox import Sandbox


class ToolRunner:
    """Tools that always use the sandbox for file I/O."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.sandbox = Sandbox(settings.sandbox_root)
        self._cwd = Path(settings.sandbox_root).resolve()

    def read_file(self, rel_path: str) -> str:
        return self.sandbox.read_file(rel_path)

    def list_dir(self, rel_path: str = ".") -> str:
        files = self.sandbox.list_files(rel_path)
        return "\n".join(sorted(files)) if files else "(no files)"

    def run_terminal(self, argv: list[str]) -> tuple[int, str, str]:
        return run_terminal(self.settings, self._cwd, argv)
