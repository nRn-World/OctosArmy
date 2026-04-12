"""Environment settings for Ollama and the sandbox.

A future desktop/Node client can call the same engine via subprocess or a small
HTTP wrapper; see server.ts for the current Vite/Gemini path.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    ollama_base_url: str
    ollama_model: str
    sandbox_root: str
    max_agent_steps: int
    terminal_timeout_sec: int
    max_terminal_output_chars: int


def load_settings(
    sandbox_root: str | None = None,
    ollama_base_url: str | None = None,
    ollama_model: str | None = None,
) -> Settings:
    root = sandbox_root or os.environ.get("SANDBOX_ROOT", "").strip()
    if not root:
        raise ValueError(
            "SANDBOX_ROOT is required. Set the environment variable or pass --sandbox to the CLI."
        )
    base = (ollama_base_url or os.environ.get("OLLAMA_BASE_URL", "")).strip().rstrip("/")
    if not base:
        base = "http://localhost:11434"
    model = (ollama_model or os.environ.get("OLLAMA_MODEL", "")).strip()
    if not model:
        model = "gemma2:9b"
    max_steps = int(os.environ.get("OCTOSYNC_MAX_STEPS", "24"))
    timeout = int(os.environ.get("OCTOSYNC_TERMINAL_TIMEOUT", "120"))
    max_out = int(os.environ.get("OCTOSYNC_MAX_TERMINAL_OUTPUT", "50000"))
    return Settings(
        ollama_base_url=base,
        ollama_model=model,
        sandbox_root=root,
        max_agent_steps=max_steps,
        terminal_timeout_sec=timeout,
        max_terminal_output_chars=max_out,
    )
