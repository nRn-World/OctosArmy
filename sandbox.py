import os
import pathvalidate
from pathlib import Path

class Sandbox:
    """
    Strictly confined File I/O sandbox for OctoSync AI agents.
    Prevents path traversal and system-wide changes.
    """
    def __init__(self, root_dir: str):
        self.root_dir = Path(root_dir).resolve()
        if not self.root_dir.exists():
            self.root_dir.mkdir(parents=True)
            
    def _validate_path(self, target_path: str) -> Path:
        """
        Validates that the target path is within the root directory.
        Raises PermissionError if a traversal attempt is detected.
        """
        # 1. Normalize and resolve the path
        try:
            # Check for invalid characters
            pathvalidate.validate_filepath(target_path)
            
            requested_path = (self.root_dir / target_path).resolve()
        except Exception as e:
            raise PermissionError(f"Invalid path format: {e}")

        # 2. Check if the resolved path starts with the root directory
        if not str(requested_path).startswith(str(self.root_dir)):
            raise PermissionError(
                f"Security Violation: Attempted access outside sandbox! "
                f"Target: {requested_path} is not in {self.root_dir}"
            )
            
        return requested_path

    def read_file(self, file_path: str) -> str:
        safe_path = self._validate_path(file_path)
        if not safe_path.is_file():
            raise FileNotFoundError(f"File not found: {file_path}")
        with open(safe_path, 'r', encoding='utf-8') as f:
            return f.read()

    def write_file(self, file_path: str, content: str):
        safe_path = self._validate_path(file_path)
        # Ensure parent directories exist within sandbox
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        with open(safe_path, 'w', encoding='utf-8') as f:
            f.write(content)

    def list_files(self, sub_dir: str = ".") -> list:
        safe_path = self._validate_path(sub_dir)
        files = []
        for root, _, filenames in os.walk(safe_path):
            for filename in filenames:
                rel_path = os.path.relpath(os.path.join(root, filename), self.root_dir)
                files.append(rel_path)
        return files

# Example Usage:
# sandbox = Sandbox("D://Spe/Snake")
# sandbox.write_file("test.py", "print('hello')")
# sandbox.read_file("../../etc/passwd") # Raises PermissionError
