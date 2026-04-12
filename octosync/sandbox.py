from __future__ import annotations

import os
import pathvalidate
from pathlib import Path


class Sandbox:
    """
    Strictly confined file read/write for OctoSync AI.
    Prevents path traversal outside the sandbox root.
    """

    def __init__(self, root_dir: str):
        self.root_dir = Path(root_dir).resolve()
        if not self.root_dir.exists():
            self.root_dir.mkdir(parents=True)

    def _is_within_root(self, resolved: Path) -> bool:
        root_s = str(self.root_dir.resolve())
        path_s = str(resolved)
        try:
            common = os.path.commonpath([path_s, root_s])
        except ValueError:
            return False
        return common == root_s

    def _validate_path(self, target_path: str) -> Path:
        try:
            pathvalidate.validate_filepath(target_path)
            requested_path = (self.root_dir / target_path).resolve()
        except Exception as e:
            raise PermissionError(f"Invalid path format: {e}") from e

        if not self._is_within_root(requested_path):
            raise PermissionError(
                f"Security Violation: Attempted access outside sandbox! "
                f"Target: {requested_path} is not in {self.root_dir}"
            )

        return requested_path

    def read_file(self, file_path: str) -> str:
        safe_path = self._validate_path(file_path)
        if not safe_path.is_file():
            raise FileNotFoundError(f"File not found: {file_path}")
        with open(safe_path, "r", encoding="utf-8") as f:
            return f.read()

    def write_file(self, file_path: str, content: str) -> None:
        safe_path = self._validate_path(file_path)
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        with open(safe_path, "w", encoding="utf-8") as f:
            f.write(content)

    def list_files(self, sub_dir: str = ".") -> list[str]:
        safe_path = self._validate_path(sub_dir)
        files: list[str] = []
        for root, _, filenames in os.walk(safe_path):
            for filename in filenames:
                rel_path = os.path.relpath(os.path.join(root, filename), self.root_dir)
                files.append(rel_path)
        return files
